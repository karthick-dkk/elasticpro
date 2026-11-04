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
