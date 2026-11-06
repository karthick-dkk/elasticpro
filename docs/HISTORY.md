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
messages), `guard.rs` (`history_guard`, `history_prefix_reserved`, `Writes::HistoryRead` /
`Writes::HistoryWrite`), `bridge.rs` (`es_req` routing, the re-check after the gate, the delay
sink's destination), `http.rs` / `tls.rs` (the store's client: no redirects, its own TLS setting
only), `volume/run.rs` (changed days, capacity hook, read-back). UI: `ui/js/ui/history-store.js`,
`ui/js/core/history-store.js`, the marker and the amber line in `ui/js/reports/daily.js`.
Tests: `tests/history_store.rs` (config.txt permits), `tests/history_store_gate.rs` (it does
not), unit tests in `history_store.rs` and `guard.rs`.

**Routing.** A store request is an `EsRequest` with `history_prefix` set — a field only the core
sets (`#[serde(skip)]`, never read from the wire). `Core::es_req` then sends it to the store's own
URL, route (`via`, a jump host from `jump_hosts`, as for clusters) and TLS setting with the
store's own credential, whatever `cluster_id` the request carries, recorded under the id
`@history-store` (an id `config_ids` cannot produce) and origin `history-store`. It is not counted
among the clusters' request rates and is in no cluster list. The store's HTTP client follows no
redirect (a redirect would resend the credential and body elsewhere; clusters keep following up
to three, unchanged) and decides certificates by the store's own `tls` setting only: the config's
global `defaults.tls: insecure` does not reach it (`PinningVerifier::own_mode`).

**Dedicated, really.** `HISTORY_STORE_SET` refuses, and every request refuses, a store URL whose
`host:port` is a configured or Zabbix cluster's. A password or API key is accepted only for an
`https://` URL. A prefix is refused when it names or starts another family's indices: `logs`,
`metrics`, `traces`, `synthetics`, `profiling`, `apm`, `logstash`, `elastic`, `kibana`,
`ilm-history`, `slm-history`, `security`, `fleet`, `ml` (the word, or the word followed by `-`, `_`
or `.`) and anything starting `filebeat`, `metricbeat`, `heartbeat`, `auditbeat`, `packetbeat`,
`winlogbeat`, `functionbeat`, `journalbeat`; names starting `.` were already refused.
`elasticpro-…` is not `elastic`.

**Guard, exactly.** `Writes::HistoryWrite` only while both gates stand, else
`Writes::HistoryRead`; decided in `es_req` and **decided again after the request was admitted by
the gate, right before it is sent** (`Core::history_recheck`): if the store's address, route,
TLS, credential or prefix changed while it waited, or a write's gates closed, it is not sent
(`kind: history_store_changed`) and what it carried stays queued. Neither permission is ever
produced by `Writes::decide`, and the ordinary `write_guard` refuses both outright.
`history_guard` allows:

| Request | Read | Write |
|---|---|---|
| `GET /` | yes | yes |
| `POST /_security/user/_has_privileges` (no parameters) | yes | yes |
| `GET /_index_template/<prefix>-<[a-z0-9._-]+>` (no parameters) | yes | yes |
| `POST /<prefix>-<[a-z0-9._*-]+>/_search`, parameters only `ignore_unavailable`, `allow_no_indices`, `filter_path`, `size`, `track_total_hits` | yes | yes |
| `PUT /_index_template/<prefix>-<[a-z0-9._-]+>?create=true` (that parameter exactly), body keys only `index_patterns` (each `<prefix>-…`), `template` (only `mappings`), `priority`, `_meta` | no | yes |
| `POST /_bulk` (no parameters): strict pairs — no blank line anywhere (Elasticsearch reads the line after an action as its document even when blank, so a blank "document" would smuggle the next line in as an action), no `\r`, exactly one trailing `\n`; every action `index` or `create`, keys only `_index` (`<prefix>-…`, no `*` or `,`) and `_id`, each followed by a JSON object | no | yes |
| anything else (delete, update, `_delete_by_query`, ILM, `_cat`, `_doc`, a path with `%`, `\`, `#`, `.`/`..` segments, a list of indices) | no | no |

A prefix that is not lower case `[a-z0-9._-]` (not starting with `-`, `_`, `+`, `.`) or that is
reserved (above) refuses everything.

**The template.** `<prefix>-template`, `create=true`: an existing template of that name is never
replaced. "Already exists" is accepted only when `GET` shows it is ElasticPro's
(`_meta.managedBy: ElasticPro` and `index_patterns: [<prefix>-*]`); otherwise nothing is written
and the status says "already exists on the store and is not ElasticPro's". Verified once per
process **per store and prefix** (`Stored::template_key`: destination + prefix), so a new store
with the same prefix gets its own, and a restart checks again.

**Gates.** (1) `HISTORY_STORE_WRITES=true` (settings.rs, `To::Direct`; deploy.sh validates it as a
bool). A start that finds it absent disarms (2), so putting the key back needs a new decision.
(2) `armed`, which `HISTORY_STORE_ARM {on: true}` sets only when the last test passed with a
fingerprint (SHA-256 of URL, route, TLS, prefix, auth kind, user and the sealed secret) equal to
the settings now — the check and the switch happen together inside the settings lock.
`HISTORY_STORE_SET` that changes any of them disarms. A test is kept only if the settings are
still the ones it started on when it ends ("the settings changed while the test ran: test again").

**Credential.** Sealed with `ClusterSecrets::seal_own` (the cluster-secrets key, the mail
password's pattern) with associated data `history-store|<kind>|<destination>` (`destination_of`:
URL, route, TLS), in `history-store.json`; never returned (`passwordSet` / `passwordStale`). A new
address, route, TLS setting **or kind of credential** (basic ↔ API key) means it does not open:
type it again.

**Writer.** A 60 s tick (hosted, started by the bridge binary). Documents are queued only while
both gates are open — a closed gate is not a backlog (*Copy existing history* sends the past).
The queue is keyed `(stream, cluster, _id)` and holds the **day**, not the index: the index is
worked out from the prefix in force when the document is sent, so a prefix change never strands
it. At most 20 000 documents; past that the oldest **days** go (counted, `dropped`). Turning a
stream off drops what waits for it. The queue file (`history-store-queue.json`) is written by the
tick, off the async runtime (`spawn_blocking`), when it changed — not on every enqueue; a crash
loses at most a minute of queued days, which the next collection or a copy sends again. A tick
sends at most 20 bulks of at most 500 documents and 4 MiB: one per cluster for `volume`, one per
stream otherwise. Per bulk: a store that does not answer keeps everything for the next tick and
ends the tick; a bulk the guard refuses is dropped and counted (`refused`) and the tick goes on;
per item, a taken document leaves the queue, a transient refusal (429, 5xx) stays, and a document
refused as malformed (`mapper_parsing_exception`, `document_parsing_exception`,
`illegal_argument_exception`, … or status 400) is offered 3 times, then given up and counted
(`rejected`). Disarming stops at the next bulk.

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

**Reading back.** One definition of where the store's days stop being needed:
`history_store::oldest_local_day` (the first day of the cluster's oldest month file), used by the
Daily and the Monthly views alike. The Monthly views merge **per day** before summing: the
store's days of a month are laid under the local record's days of that month (a local day wins)
and summarised by the same `derive`, so the month the local record starts in counts the store's
earlier days and Monthly agrees with Daily; such a row carries `historyDays: n`, a month with no
local day `source: "history"`. Reads are pages of 10 000 days (`search_after` on
`day desc, clusterId asc`), at most 5 pages; past the bound the reply says
`truncated: true, truncatedBefore: <day>` and month rows starting on or before that day are
`incomplete: true` (the page marks them "history (incomplete)"). The month views leave `sources`
out of the read. The reads are the **interactive** class (a person is waiting: a bounded queue
wait, an 8 s timeout); a store that did not answer is not asked again by a page for 60 s ("asked
again after N s"); a display link (Play) never reads the store back. A store that answers with no
day and has no ElasticPro template says `templateMissing: true`, "nothing has been written to this
store yet" — not the same as "no days". `HISTORY_QUERY` requires the cluster to exist; a limited
admin, like a scoped user, is held to the clusters they see (and so for the volume record's
per-cluster reads, a gap that existed before this feature, closed in the same line of
`gate_cluster`).

**Fleet-wide settings.** A limited admin cannot change the store (`SET`, `TEST`, `ARM`,
`BACKFILL`) nor the scheduled log delay (`DELAY_SINK_SET`); they may read the store's settings.

**Deviations from the contract above, and why.** The privilege check also asks the cluster
privilege `manage_index_templates` (the template cannot be created without it), and the test
passes only when all four are granted, or when security is off on the store (every privilege then
`null`, "not checked"). `perDayEventBytes7d` holds the seven days rather than an average, and
`repositoryBytes` is always `null` (both: one definition / unknown is not zero). Days are
read back only before the local record's first day, never for gaps inside it (a day without a
record there had no indices). A store that cannot be reached adds no rows: the reply's
`history.reachable` is `false` and the page says "in the history store · not reachable" once, in
amber, rather than one row per day it cannot know existed. The template is created with
`create=true` and checked with a `GET` (not a `HEAD`: the `_meta` marker is in the body).

## Backend routing (0.3.55)

Data › Backend (board 10 of the Config-Management redesign, approved 2026-11-05): **where
ElasticPro keeps what it records.** Three kinds of data, each kept in one of three places. The
Elasticsearch side is **always the history store above** — the dedicated endpoint, its own
credential, its guard and its two gates — never a monitored cluster (`history_store_is_a_cluster`
still refuses one). Code: `crates/elasticpro-core/src/data_routing.rs`; settings in
`<data>/data-routing.json`; UI helpers `ui/js/core/data-routing.js`.

| Kind | What | Built-in record (as today, unchanged) | On the store |
|---|---|---|---|
| **history** | volume, capacity, log-delay records | the volume record's month files (`keepMonths`, default 13); the delay measurement is written to a cluster or the store, never kept locally | `<prefix>-volume-YYYY.MM`, `-capacity-YYYY.MM`, `-delay-YYYY.MM`, as above |
| **reports** | generated report files and the job history | `<data>/reports/` (`KEEP_FILE_DAYS` 7 for files, `KEEP_FINISHED` 200 jobs in `jobs.json`) | `<prefix>-reports-YYYY`, `_id` = the job id, one document per job that ended |
| **alerts** | acknowledged, silenced, and what the pages saw raised and cleared | `acks.json`, `silences.json` (the live state) | `<prefix>-alerts-YYYY`, `_id` = `<event>\|<key>\|<at>` |

| Mode | Meaning |
|---|---|
| `builtin` (**default for every kind**) | nothing of this kind goes to the store. For history that also refuses the delay sink's `destination: "history"` ("history is kept in ElasticPro's built-in store only"). |
| `copy` | built-in **and** the store. Queued for the store only while both gates are open — a closed gate is not a backlog (the 0.3.53 rule; *Copy existing history* sends the past). **Until an admin has saved a routing, history follows the store**: `copy` while *Write history* is armed (what arming meant before this feature, so nothing an admin set up stops), `builtin` otherwise; a saved choice then holds. |
| `es` | the store is where the record is kept for good. While the store is not connected and writing (a gate closed, the test failed, the store unreachable), the record is queued **anyway** — the history store's bounded on-disk queue (`QUEUE_MAX` 20 000, the oldest days out first and counted `dropped`) — and the **built-in store keeps writing**, so nothing is lost; the status says so. When the store is back, the next tick sends the queue. History with no store configured at all is not queued — its month files are the record and *Copy existing history* sends them once a store is set up; reports and alerts queue from their first record. The delay measurement is written to its destination or not taken (it is never kept locally), so a closed gate skips it, as before. |

**One definition.** `data_routing::admits(mode, gates_open)` decides, for every kind alike,
whether a record is queued now; `status_line(mode, not_writing, queued)` says for every kind
alike what its status is: `writing` · `queued` (es, the store cannot be written now) · `paused`
(copy, the same) · `builtin`. The built-in store's retention is unchanged in every mode: this
feature deletes nothing, on the server or on the store (the store's retention is its owner's ILM;
the templates hold mappings only, no settings, no lifecycle).

**Documents and templates.** Two more index templates on the store, each `create=true` (never
an overwrite; an existing one is accepted only when it is ElasticPro's for that very pattern),
`priority: 300` (above the history template's 200), `dynamic: false` with every field listed,
`_meta.managedBy: ElasticPro`, verified once per process per store, prefix and template:

- `<prefix>-reports-template` for `<prefix>-reports-*`: `jobId, kind (cluster|mailed), report
  (volume|indices|hosts), status, clusterIds, clusterName, period{from, to, label}, format,
  mail, by, createdAt, startedAt, endedAt, day, durationMs, file{name, bytes}, fileContent{name,
  base64} (binary; only when *Carry the file* is on and the file is ≤ 2 MiB), error, mailError,
  warning, stoppedBy, sheets, failedClusters[{clusterId, reason}], figures{daysDone, daysTotal,
  rows, clustersDone, clustersFailed}, writtenAt`. Figures are the job's own counts — `rows` is
  `null` for a volume report, which counts days, not rows.
- `<prefix>-alerts-template` for `<prefix>-alerts-*`: `event, key, clusterId, scope, target,
  rule, level, by, at, day, reason, note, until, approx, reportedBy, writtenAt`. Events the core
  witnesses: `acknowledged` / `unacknowledged` / `ack_cleared` (`ACK_SET`, `ACK_CLEAR`,
  `PLAY_NODE_FORGET`), `silenced` / `unsilenced` (`SILENCE_SET`, `SILENCE_CLEAR`; the key is the
  alert's for an alert silence, the cluster id for a cluster-wide one). The core evaluates no
  alert itself, so `raised` and `cleared` come from the page that saw them (`ALERT_EVENTS_PUT`,
  below): `reportedBy` names whose page, `approx` says the start may have been missed, and the
  same event for the same key from another page within 15 minutes is dropped as a duplicate.

**The report worker.** A report may end in another process (docs/WORKER.md). Its record is
written to `<data>/history-store-spool/` (one file per record) and the core's history-store tick
drains the spool first — queuing or dropping each record by the routing in force **then** — so
the worker needs neither the queue nor the store. Alerts are the core's own and go straight to
the queue.

**Capacity and abuse.** The queue is the history store's (`QUEUE_MAX` 20 000). Alerts have
their own share of it (`ALERTS_QUEUE_MAX` 2 000, the oldest alerts out first) and when the
whole queue is full alerts go first — history and reports are never evicted to make room for
an alert; what went is counted per stream (`dropped_by_stream`, `store.dropped` per kind in the
status). A document over 1 MiB is never queued (counted). Bulks are cut in turns across the
streams (`cut_bulks`: one each, round after round, up to `BULKS_PER_TICK`), so a stream with a
long queue cannot starve the others; a stream whose template cannot be verified is passed over
for that tick with its error kept by stream (`stream_errors`), and the rest is sent.
`ALERT_EVENTS_PUT` is bounded per account — 200 events per 15 minutes over every message,
counted as sent, then `too_many` — and takes only keys whose rule family is one the pages raise
(`ALERT_RULE_IDS`, held equal to `ui/js/core/alert-rules.js` by a unit test, plus Play's
`node-left`); duplicates are per (reporter, event, key) within 15 minutes, remembered up to
50 000 with the oldest forgotten first; a page's `at` is believed within 48 h back and 5 min
ahead. A queued report record carries a reference to its file (name, size, sha256), never the
content: the file is read when the bulk is cut, checked against the digest and carried as
`fileContent{name, base64, sha256}`, or named in `fileNote` when it is gone (`KEEP_FILE_DAYS`)
or changed. The spool holds 32 MiB at most, and a spool file is removed only after the queue
that took its record was written to disk. **Opting out** takes effect at once: a kind routed
back to `builtin` lets go of what was queued for it (audited), the tick lets go of records
whose kind no longer sends (`unrouted`), and `reportFiles` turned off takes the references out
of the queued report records. With the file carried, anyone who can read `<prefix>-reports-*`
on the store sees every cluster's report content (never a credential); the page says so beside
the switch.

**Status (`DATA_ROUTING_STATUS`).** Per kind: the mode, *kept for* (built-in as above; store:
"the store owner's ILM"), *size now* (built-in bytes from a bounded walk of the kind's files — a
floor when cut short, `null` when there is no such place; store document count via one
`_search?size=0&track_total_hits=true` per pattern, cached a minute, `null` with the reason when
not asked or not answered), the status line, and `store.{queued, dropped, writing, why}` — `why`
names the closed gate or that stream's last error. Nothing is asserted about the built-in
record's own writes (unknown is not ok). Plus the built-in store's own size and the free space
on its disk (`statvfs`). Never a secret.

**Messages** (docs/HANDBOOK.md "Backend — the message contract"): `DATA_ROUTING_GET` /
`DATA_ROUTING_SET {routing}` / `DATA_ROUTING_STATUS` (admin; SET refused for a limited admin,
fleet-wide), `ALERT_EVENTS_PUT {events}` (user, on the clusters they see), and PING's
`dataRouting: {supported}`. All audited (`backend routing set`, `alert events reported by a
page`).

**Tests.** `tests/data_routing.rs` (permit on: ES-only queues with the gates closed and the
built-in record still written; the queue goes out after arming, each stream after its own
template; acks, silences, a page's events and a report's end are the records; a copy does not
queue while the gates are closed; roles; the desktop has none of it); unit tests in
`data_routing.rs` (admits, status lines, document ↔ template field coverage, the guard accepts
the templates and the count); `tools/hosted-check.sh` (admin-only, ES-only with gates closed
keeps the built-in record and says so, nothing written to a monitored cluster);
`tools/unit/data-routing.test.mjs` (the page's formatting never shows an unknown as 0).
