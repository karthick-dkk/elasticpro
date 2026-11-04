# History store (0.3.53)

Developer contract. ElasticPro keeps its daily and historical figures in an Elasticsearch
**history store** as well as in its data directory. Decided by the owner 2026-11-04: a
**separate, dedicated Elasticsearch endpoint** (its own URL and credentials, not one of the
monitored clusters), used as a **mirror with long history** (the local files stay the working
store; the history store keeps everything, and pages read it for what the local files no
longer hold).

## What is stored

Three streams, one monthly index each, `<prefix>-<stream>-YYYY.MM` (prefix default
`elasticpro-history`). Every document has a deterministic `_id`, so a repeated write
overwrites itself instead of adding a duplicate (the rule `delay_sink.rs` already follows).

| Stream | One document per | `_id` | Fields |
|---|---|---|---|
| `volume` | cluster × day of the daily record | `cluster|day` | clusterId, clusterName, day, final, live, indices, docs, eventBytes, subBytes, priBytes, totalBytes (null = not measured), unmeasuredSizeIndices, sources (per source: same figures), error, writtenAt |
| `delay` | cluster × device × hour (the scheduled log-delay measurement) | `cluster|device|hour` (as today) | the fields `delay_sink.rs` writes today |
| `capacity` | cluster × day (written once a day, after the daily collection) | `cluster|day` | measurements only, never verdicts: dataNodeDiskTotal/Used/Free (data roles only), dataNodes, liveRetentionHeldDays, liveRetentionPolicy (as typed), snapshotRetention, backupCapacity, repositoryBytes (null when not measured), clusterType (CI/DI/On-Prem), ulmBucket, perDayEventBytes7d |

**Measures, not judgements.** Required disk, buffer and shortfall are presentation and stay in
the UI (one definition). The store holds the inputs, so a past day's shortfall can be worked
out again under today's rule.

## Gates (CLAUDE.md "Writes are gated twice")

The global `readOnly` switch is **not** used: opening it would allow writes to every monitored
cluster. The history store has its own two gates, both decisions made by people:

1. **Config permits it**: `HISTORY_STORE_WRITES=true` in config.txt (hosted). Without it the
   store can be configured and tested (reads only) but never written.
2. **An admin armed it**: Config › History store › *Write history* switch, which can be turned
   on only after a successful *Test connection*. Disarming stops writes at the next tick.

The guard allows, for the history store's endpoint only: `PUT _index_template/<prefix>-*`
(created once, mappings only), `POST _bulk` whose every action targets `<prefix>-*`, and
searches on `<prefix>-*`. Nothing else, no deletes, no ILM changes (retention of the store's
indices is the store owner's: say so on the Config card). A monitored cluster is never written
by this feature.

## Credentials

URL, user and password (or API key) typed once in Config › History store and kept encrypted
server-side like cluster credentials (credentials-kept-on-server pattern, never returned to
the page, `*` shown when set). TLS verify on by default, CA/pin as for clusters; jump host
optional, same as clusters.

## Writing

- Hosted only, on the core's timer. **volume**: after each daily-collection run, the days it
  changed are bulk-written (one bulk per cluster, size-capped, retried next tick on failure).
  **delay**: Config › Scheduled log delay gains a destination choice *a monitored cluster (as
  today)* | *the history store*; existing setups are unchanged. **capacity**: once a day after
  the volume run, one bulk for every cluster whose figures were read.
- **Backfill**: arming offers *Copy existing history* (a one-off bulk of every local month
  file, in pages, with progress), off by default.
- Failures never block the local record. The card shows last success, last error, documents
  written and a queue count; the Request Centre counts history writes as their own origin
  (`history-store`).

## Reading back

`VOLUME_DAILY` / `VOLUME_MONTHLY` / `VOLUME_MONTHLY_ALL` (and the Reports Overview) read the
local record first. For a range the local files do not cover (older than `keepMonths`, or a
server whose data directory is new), the core reads the missing days from the store
(`<prefix>-volume-*`, one search per request, bounded) and marks them `source: "history"`. If
the store is unreachable those days say *in the history store · not reachable*, never 0.
Log delay history and capacity history get a *History* range selector on their pages later;
this release writes them and exposes `HISTORY_QUERY {stream, clusterId, from, to}` for them.

## Messages

`HISTORY_STORE_GET` (admin) → settings without secrets + status; `HISTORY_STORE_SET` (admin,
fleet-wide: a limited admin is refused) → URL, auth, TLS, prefix, streams on/off; 
`HISTORY_STORE_TEST` (admin) → one `GET /` and a privilege check (`_security/user/_has_privileges`
for `create_doc` / `create_index` / `read` on `<prefix>-*`) with the result per privilege;
`HISTORY_STORE_ARM {on}` (admin) → refused unless config permits and the last test passed;
`HISTORY_STORE_BACKFILL` (admin); `HISTORY_QUERY` (user, scoped to clusters the caller sees).
All audited (activity `history_store_*`, category configuration), secrets never logged.

## Tests

Guard (only template/bulk/search on the prefix; everything else refused, monitored clusters
never written), gates (no write without both), deterministic ids, bulk building, read-back
merge (local + history, overlap, unreachable), credentials never echoed, auth matrix, desktop
(no store), hosted-check additions, a behaviour-check of the Config card.

## Implementation notes (0.3.53, as built)

Code: `crates/elasticpro-core/src/history_store.rs` (settings, documents, writer, read-back,
messages), `guard.rs` (`history_guard`, `Writes::HistoryRead` / `Writes::HistoryWrite`),
`bridge.rs` (`es_req` routing, the delay sink's destination), `volume/run.rs` (changed days,
capacity hook, read-back). UI: `ui/js/ui/history-store.js`, `ui/js/core/history-store.js`.
Tests: `tests/history_store.rs` (config.txt permits), `tests/history_store_gate.rs` (it does
not), unit tests in `history_store.rs` and `guard.rs`.

**Routing.** A store request is an `EsRequest` with `history_prefix` set — a field only the core
sets (`#[serde(skip)]`, never read from the wire). `Core::es_req` then sends it to the store's own
URL, route (`via`, a jump host from `jump_hosts`, as for clusters) and TLS setting with the
store's own credential, whatever `cluster_id` the request carries, recorded under the id
`@history-store` (an id `config_ids` cannot produce) and origin `history-store`. It is not counted
among the clusters' request rates and is in no cluster list.

**Guard, exactly.** `Writes::HistoryWrite` only while both gates stand (checked in `es_req`, at
the chokepoint, on every request), else `Writes::HistoryRead`. Neither is ever produced by
`Writes::decide`, and the ordinary `write_guard` refuses both outright. `history_guard` allows:

| Request | Read | Write |
|---|---|---|
| `GET /` | yes | yes |
| `POST /_security/user/_has_privileges` (no parameters) | yes | yes |
| `POST /<prefix>-<[a-z0-9._*-]+>/_search`, parameters only `ignore_unavailable`, `allow_no_indices`, `filter_path`, `size`, `track_total_hits` | yes | yes |
| `PUT /_index_template/<prefix>-<[a-z0-9._-]+>` (no parameters), body keys only `index_patterns` (each `<prefix>-…`), `template` (only `mappings`), `priority`, `_meta` | no | yes |
| `POST /_bulk` (no parameters), every action `index` or `create`, keys only `_index` (`<prefix>-…`, no `*` or `,`) and `_id`, each followed by a JSON object | no | yes |
| anything else (delete, update, `_delete_by_query`, ILM, `_cat`, `_doc`, a path with `%`, `\`, `#`, `.`/`..` segments, a list of indices) | no | no |

A prefix that is not lower case `[a-z0-9._-]` (not starting with `-`, `_`, `+`, `.`) refuses
everything. The template's name is `<prefix>-template`, created once per prefix before the first
write (`templateAt`).

**Gates.** (1) `HISTORY_STORE_WRITES=true` (settings.rs, `To::Direct`; deploy.sh validates it as a
bool). (2) `armed`, which `HISTORY_STORE_ARM {on: true}` sets only when the last test passed with
a fingerprint (SHA-256 of URL, route, TLS, prefix, auth kind, user and the sealed secret) equal to
the settings now; `HISTORY_STORE_SET` that changes any of them disarms. Enforced in
`history_writes_open` before anything is queued or sent and again in `es_req`.

**Credential.** Sealed with `ClusterSecrets::seal_own` (the cluster-secrets key, the mail
password's pattern) with associated data `history-store|<destination>` (`destination_of`: URL,
route, TLS), in `history-store.json`; never returned (`passwordSet` / `passwordStale`). A new
address, route or TLS setting means it does not open: type it again.

**Writer.** A 60 s tick (hosted, started by the bridge binary). Documents are queued only while
both gates are open — a closed gate is not a backlog (*Copy existing history* sends the past) —
in `history-store-queue.json`, keyed `(stream, cluster, _id)` so a rewrite replaces, at most
20 000 (the oldest dropped and counted). A tick sends at most 20 bulks of at most 500 documents
and 4 MiB: one per cluster for `volume`, one per stream otherwise; a taken item leaves the
queue, a rejected item or a failed bulk stays for the next tick. Disarming stops at the next bulk.

**Documents as built.**

- `volume` (`<prefix>-volume-YYYY.MM`, `_id` `cluster|day`): `clusterId, clusterName, day, final,
  live, indices, docs, eventBytes, subBytes, priBytes, totalBytes, unmeasuredSizeIndices,
  sources{<name>: {indices, priBytes, totalBytes, docs, eventBytes, subBytes,
  unmeasuredSizeIndices}}, error, aggregatedAt, totalsAt, writtenAt`. Sizes are `Day::sizes`
  (`null` while not measured) so a direct reader never takes the dated part for the day.
- `capacity` (`<prefix>-capacity-YYYY.MM`, `_id` `cluster|day`, day = UTC day of the cluster's
  scheduled daily run, written after that run only): `dataNodeDiskTotal/Used/Free, dataNodes,
  dataNodeDiskAt` (fleet cache `nodes` dataset: rows whose `node.role` has `d s h w c f`, each
  figure from `_cat/allocation` for the node else `_cat/nodes`; any unreadable data node makes
  that sum `null`), `liveRetentionHeldDays` (days from the record's oldest `live` day to the
  document's day) and `liveRetentionOldestDay`, `liveRetentionPolicy`, `snapshotRetention`,
  `backupCapacity` (the cluster's config entry, as typed, else `null`), `repositoryBytes` (always
  `null`: the core does not measure a repository), `clusterType`, `ulmBucket` (Config ›
  cluster type), `perDayEventBytes7d` (the record's last seven finished days as
  `[{day, eventBytes}]`: the inputs, so the rate is worked out by its one definition in the UI),
  `writtenAt`.
- `delay` (`<prefix>-delay-YYYY.MM`, `_id` `cluster|device|hour`): exactly what `delay_sink.rs`
  writes, when the sink's `destination` is `history`.

**Deviations from the contract above, and why.** The privilege check also asks the cluster
privilege `manage_index_templates` (the template cannot be created without it), and the test
passes only when all four are granted, or when security is off on the store (every privilege then
`null`, "not checked"). `perDayEventBytes7d` holds the seven days rather than an average, and
`repositoryBytes` is always `null` (both: one definition / unknown is not zero). Days are
read back only before the local record's first day, never for gaps inside it (a day without a
record there had no indices). A store that cannot be reached adds no rows: the reply's
`history.reachable` is `false` and the page says "in the history store · not reachable" once,
rather than one row per day it cannot know existed.
