# Jobs — the registry, the run log and the message contract

Everything ElasticPro runs by itself or when a person asks for it is a **job**, listed once in
one table (`crates/elasticpro-core/src/jobs/mod.rs`, `REGISTRY`). Every run of every job is
recorded: who or what started it, when, how far it got, how it ended. The health poll and
request handling are monitoring, not jobs: they are not in the table and cannot be paused.

Built in stages: the registry, the run log and `JOBS_LIST`; the controls (run now, pause,
resume, cancel, retry, create, several schedules per report kind, joining a duplicate,
deferring for a busy cluster — "Controls" below); the governor, which sizes the worker's jobs
every 10 s from what it measures within the settings the controls keep ("Governor" below); the
Jobs page.

## The jobs

| id | name | kind | runs in | priority | requests min–max | pausable | next run from |
|---|---|---|---|---|---|---|---|
| `logdelay.measure` | Log delay measurement | automatic | core | High | 1–4 | yes | `delay_sink` — the measurement's `nextDueAt` while armed |
| `volume.daily` | Daily volume collection | automatic | worker | Medium | 1–4 | yes | `volume_daily` — the earliest cluster's next `collectAt` |
| `hosts.collect` | Hosts collection | automatic | worker | Medium | 1–2 | yes | `hosts_daily` — `UI_REPORT_HOSTS_AT` (06:00), today or tomorrow |
| `report.run` | Report runs | manual | worker | Medium | 1–4 | no | `on_request` |
| `report.mailed.volume` | Mailed volume report | automatic | worker | Medium | 1–4 | yes | `mailed_schedule` — the schedule's next send |
| `report.mailed.indices` | Mailed indices report | automatic | worker | Medium | 1–4 | yes | `mailed_schedule` |
| `report.mailed.hosts` | Mailed volume by host report | automatic | worker | Medium | 1–4 | yes | `mailed_schedule` |
| `report.mailed.log_delay` | Mailed log delay report | automatic | worker | Medium | 1–4 | yes | `mailed_schedule` |
| `history.mirror` | History store mirror | automatic | core | Low | 1–2 | yes | `every_minute` — no fixed time |
| `housekeeping` | Housekeeping | automatic | core | Low | 1–1 | yes | `housekeeping` — the timer's `nextRunAt` |
| `settings.backup` | Settings backup | automatic | core | Medium | 1–4 | yes | `backup` — the backup schedule |
| `zabbix.sync` | Zabbix sync | automatic | core | Low | 1–2 | yes | `zabbix_sync` — the interval after the timer's last run |
| `zabbix.push` | Zabbix push | automatic | core | Low | 1–2 | yes | `zabbix_push` — the push timer's `nextAt` |

"Runs in" is the process that runs the job in a split deployment (docs/WORKER.md); role `all`
runs everything. A manual report run is stopped with `JOB_CANCEL`, not paused. A report
schedule created with `JOB_CREATE` is a job of its own, `report.schedule.<id>` (worker, Medium,
1–4, pausable, next run from its own schedule), listed after these.

**What counts as a run.** A tick that does nothing is not a run: the history store's minute when
nothing is queued or a switch is off, the push when no host is named, the Zabbix sync while the
API is not configured — nor the rebuild of the Zabbix cluster list after an edit made in
ElasticPro (`ZABBIX_CLUSTER_SAVE`, `zabbix_rebuild`), which asks Zabbix nothing. A sync (the
fetch from Zabbix and the build over it) is a run, by the timer, the start, a link change or a
person. A scheduled measurement refused before it started (not primed, read-only,
no destination) *is* a run, `skipped`, because it was due. The two collections start one cluster
at a time: the clusters a tick starts — and any a later tick starts while some still collect —
are **one run**, its progress the clusters ended of those begun. A *Refresh now* (`VOLUME_RUN`)
is a run of `volume.daily` by its person (`manual:<user>`): the clusters it starts join the run
already open, or begin one. A hosts *Collect again* is a report job (`REPORT_RUN … collectAgain`)
and so a run of `report.run`, by its person. A manual backup (`BACKUP_CREATE`) is a run of
`settings.backup`, by its person.

**Report jobs** are recorded where they always were, the worker's `reports/jobs.json`, and mapped
into the run list (`report-<job id>`), never copied: `report.run` for a cluster's report (any
kind), `report.mailed.<kind>` for the mailed one. The schedule's jobs are `timer`, `REPORT_SEND_NOW`
and `REPORT_RUN` are `manual:<user>`; `done` → `completed`, `stopped` → `cancelled`.

## One run per job at a time

Each process holds one run per job open at most. Asked for a second, it answers

```json
{ "ok": false, "kind": "already_running", "runId": "9f2c51ab03de4e17",
  "message": "the scheduled log delay measurement is already running (run 9f2c51ab03de4e17): wait for it to end" }
```

`DELAY_SINK_RUN` while the timer's run goes (before, both ran at once and wrote the same hour
twice) and `HOUSEKEEPING_RUN` while housekeeping runs (which answered `kind: "busy"` before). A
timer tick that meets an open run leaves it be. A Zabbix sync must see what is configured now,
so `ZABBIX_SYNC` waits for a sync already going (at most a minute) and then runs its own,
answering `already_running` only if that one is still going; the sync after a link change does
the same with two minutes. They no longer run side by side.

The hosts collection's tries per cluster (three a day, 15 minutes apart) are kept in
`<data>/job-runs/hosts-tries.json`: a restart no longer hands every cluster three more.

## Statuses

| status | meaning | set now |
|---|---|---|
| `pending` | asked for, not yet eligible | not set: a paused job's timer starts nothing, a busy cluster's wait is a `deferred` record |
| `queued` | waiting for a slot | report jobs |
| `running` | under way | yes |
| `completed` | ended, and did what it set out to | yes |
| `failed` | ended with an error (`error` says what) | yes |
| `paused` | held by `JOB_PAUSE` | not set: pausing holds the timer, never a run (below) |
| `cancelled` | stopped by a person (`REPORT_STOP`; `JOB_CANCEL`) | yes |
| `deferred` | ended early for a reason that passes — the emergency stop, a busy cluster — and tried again by the job's own rules | the collections |
| `skipped` | nothing was attempted: something stood in the way (`error` names it and the setting that changes it) | the log delay measurement; a person's run that found nothing to do |

A run of a collection with several clusters ends `failed` if any cluster failed, else `deferred`
if any was, else `cancelled`, else `completed`; its `note` counts each.

## A run record

| field | |
|---|---|
| `id` | the run's id (16 hex), or `report-<job id>` |
| `jobId` | the job's id |
| `owner` | `core` or `worker`: whose run file holds it |
| `trigger` | `timer` (the product on its own: its timer, the start, a follow-up to a setting changed), `manual:<user>`, or `retry` (`JOB_RETRY`, and a mailed schedule giving a period another try) |
| `status` | above |
| `createdAt`, `startedAt`, `endedAt` | unix ms; `createdAt` is when it was asked for (= `startedAt` unless it queued) |
| `progress` | percent, from `done` of `total` when the job counts them — **null when the total is not known**, never a guess |
| `done`, `total` | the counts behind it (clusters of a collection, days of a report), or null |
| `records` | what it processed: days collected, documents written, items removed, devices measured; null when the job does not count them |
| `error` | why it failed, deferred or was skipped |
| `clusters` | the clusters it read from or wrote to |
| `note` | anything else (a backup's file and size, housekeeping's bytes, a report's warning, what the volume backfill did — "Volume backfill" below) |
| `cancelAsked` | `JOB_CANCEL` asked it to stop (it stops at its next safe point) |
| `retryOf`, `attempt` | the run this one tries again, and which try (1 = the first retry); null / 0 otherwise |
| `deferred` | a busy cluster's wait: `{cluster, signal, reason, since}` — `signal` `hours` for a wait for the cluster's heavy-job hours ("Per-cluster switches"); null otherwise |
| `scope` | what a person narrowed the run to (the log delay measurement's *Fetch now*: `{clusterIds: [one], devices: "late"\|"all", device}`); absent otherwise. `JOB_RETRY` runs the same scope again |
| `stale` | role core: a worker run still open while the worker's heartbeat is late or never came — it may have ended with the worker. Never ended by the core, only marked |
| `parts` | 0.3.81: how its clusters' parts ended, when the run reported parts — `{succeeded, partial, failed, deferred, skipped}`, which always add up to the clusters it worked on; absent otherwise. The parts themselves and the run's lines are its detail ("Run details" below) |

**Kept:** the last 50 finished runs per job, 2000 per file; an open run is never dropped. A run
open when its process stopped ends `failed`, "the server restarted while this ran", at the next
start — unless a person had asked it to stop (`cancelAsked`): then it ends `cancelled`. A run
whose code ended without saying how ends `failed` too.

**One writer per file** (docs/WORKER.md): `<data>/job-runs/core.json` is written by the process
that runs the core's jobs, `<data>/job-runs/worker.json` by the one that runs the worker's (role
`all` writes both). The core reads the worker's file, as the worker last wrote it — a running run
there is as running as the worker's last write says. The worker's own read-only Zabbix sync is
held one at a time but not recorded: the job is the core's.

## Run details (0.3.81)

A run of a job that works on many clusters keeps, besides its record, **what happened on each
cluster** and **the lines it wrote** — read with `JOB_RUN_DETAIL` when a row of All jobs is
opened, never before. Code: `jobs/detail.rs` (pure: the codes, the bounds, who reads what),
`jobs/capture.rs` (the in-process capture).

**Parts** — one per cluster: `cluster`, `status` (`succeeded` · `partial` · `failed` · `deferred`
· `skipped`), `code`, `message`, `records`, `elapsedMs`, `retry` (in words) and `todo` (what a
person can do, where ElasticPro knows: `{label, text, page}`).

- The log delay measurement reports one part per cluster it measures (`bridge.rs
  measure_delay_sink`): measured in full, partly (some pages read — `partial`, its records kept),
  or not at all; a write that failed is that cluster's `failed`.
- The daily volume and hosts collections are one run of one part per cluster already: each
  part's outcome becomes its cluster's part (`completed` → succeeded, `failed` with records →
  partial, else failed, `deferred` → deferred, cancelled or skipped → skipped).
- A busy cluster's deferral (`Jobs::defer`) is a run of one `deferred` part, code `BUSY`, and one
  `WARN` line: a warning, never shown as an error.

**Error codes** — one definition, `detail::ErrorCode::of(text)`, the first that matches:

| code | the error says | retry | what to do |
|---|---|---|---|
| `AUTH` | 401, 403, unauthorized, forbidden, security_exception, not primed | None — config issue | check the cluster's user and password (Config › Clusters) |
| `BUSY` | 429, too many requests, rejected execution, circuit breaking, "is busy" | When the cluster eases (automatic) | — (tried again by itself) |
| `INDEX_NOT_FOUND` | index_not_found, no such index, no device aggregation, no index matches | None — config issue | log delay: set the cluster's log index (Config › Clusters); volume and hosts: set the cluster's volume index pattern (Reports › Settings) |
| `SHARD_FAILURE` | shard(s) failed, search_phase_execution, a partial answer | the job's own | look at shard allocation (Nodes & shards) |
| `TIMEOUT` | timed out, timeout, deadline | the job's own | look at the cluster's health and load (Clusters) |
| `UNREACHABLE` | connection refused, unreachable, DNS, tunnel, jump host, SSH | the job's own | check the cluster's address or jump host (Config › Clusters) |
| `OTHER` | anything else | the job's own | — |

The job's own retry: log delay "Next run", hosts "Next tick, up to 3 tries a day", daily volume
"Next scheduled run". A deferred part is `BUSY` unless its text says otherwise.

**Lines** — opt-in only. The run's own structured lines are added as it goes, and the binary's
`jobs::capture::Layer` (beside the JSON log) adds an event only when it is explicitly a job line
— target `jobline` or a field `job_line = true` — and belongs to an open run (its own `run` field,
or the `run = <id>` span `governed()` wraps each job's work in). Every other event, inside a run
or not, is never captured: free text can carry cluster URLs, request paths and bodies, error
bodies and header values. No container log is read.

**Redacted on capture, in one place** (`detail::redact`): every kept line and every part's
message loses a URL's userinfo (`https://user:pass@host` → `https://***@host`), the value after
`Basic` / `Bearer` / `ApiKey`, and the value of an `Authorization`, API-key, password, secret or
token field, and is cut to 300 characters.

**What ships in 0.3.81** — the run's own lines only: `run.start job=… trigger=…`, one line per
part (`ERROR` failed, `WARN` partial / deferred / skipped, `INFO` succeeded), `run.cancel asked
by …` (a job line written by `Jobs::cancel`) and `run.end status=… ok= partial= failed= deferred=
skipped= records= took=`. No other code writes target `jobline` yet; a later job line is one
`tracing::…!(target: "jobline", …)` at a point worth reading. The capture layer has its own filter
(`capture::wanted`), outside `RUST_LOG`: `RUST_LOG=warn` does not drop job lines, and an event that
is not a job line is never read. Each line: `at` (ms), `level`, `cluster` (when the line names
one), `run` (true for the run's own start and end lines, which name no cluster), `text` (at most
300 characters). **Narrowed on read**: a line naming a cluster the caller may not see is dropped
for them, and a line naming no cluster is shown to a limited caller only when it is one of the
run's own start/end lines (which carry no cluster names).

**Bounds** — successes listed by name up to 300 (`partsNotListed` counts the rest); every
exception kept (a hard bound of 2,000 only so a record can never grow without end); lines: the
first 100 and the last 400 (500 a run; `linesDropped` counts those between). The counts in
`parts` and `detail.counts` count every part, listed or not.

**Kept** — written once, when the run's last part ends, beside the run log:
`<data>/job-runs/detail/<owner>/<run id>.json` (one writer per owner, as the run files), and
removed when the run log no longer keeps the run (50 a job, 2000 a file), or after 7 days,
whichever is first. Without a data directory: the newest 200, in memory. Report runs
(`report-…`) keep none — `jobs.json` is their record.

### `JOB_RUN_DETAIL {runId}`

User and up, like `JOBS_LIST`; read-only, not in the activity log. The run is found where
`JOBS_LIST` finds it; who may read it is `JOBS_LIST`'s rule (`run_view`): a run a caller may not
list is `not_found`, as one that is not there.

```json
{ "ok": true, "run": { …a run record, as in runs[]… },
  "detail": { "counts": {"succeeded": 67, "partial": 1, "failed": 3, "deferred": 0, "skipped": 0},
              "parts": [ {"cluster": "demo", "status": "failed", "code": "INDEX_NOT_FOUND",
                          "message": "the answer has no device aggregation", "records": 0, "elapsedMs": 400,
                          "retry": "None — config issue",
                          "todo": {"label": "Set log index", "text": "set the cluster's log index (Config › Clusters)", "page": "settings"}} ],
              "partsNotListed": 0, "lines": [ {"at": 1763591163112, "level": "INFO", "run": true, "text": "run.start job=logdelay.measure trigger=timer"} ],
              "linesDropped": 0, "window": [from, to], "narrowed": false },
  "why": null }
```

- `detail` is null, with `why`, for a run still open, one from before 0.3.81, a report run, or a
  job that reports nothing; the record's own fields are still in `run`.
- `parts` are worst first (failed, partial, deferred, then by cluster), then the clusters that
  succeeded. `window` is the time window the run read (the log delay measurement's), or null.
- **A caller limited to some clusters** (the one per-caller view, `sink_view` / `visible_ids`)
  reads only their clusters' parts, the lines about their clusters and the run's own start and
  end lines; `counts` are counted from the parts they read and `narrowed` is true — the totals
  still add up and say nothing of anybody else's.
- An admin-only job's (`detailsFor: admin`) messages, actions and lines go to administrators
  only; others read `linesNote: "an administrator can read why"`.
- `bad_request` for a `runId` that is not one (`[A-Za-z0-9-]`, at most 64); `io_error` when the
  file cannot be read (where, to an administrator).

## Slow searches (0.3.81)

`SLOW_SEARCHES {minMs}` — the searches running longer than `minMs` (10000 · 30000 · 60000 ·
300000; default 30000) on every cluster the caller sees, for the *Slow searches now* card. User
and up; read-only, not in the activity log (a poll).

- Per cluster, one `GET /_tasks?actions=*search*&detailed` (`tasks::SEARCH_TASKS_PATH`, beside
  `TASKS_PATH`; one definition each), background class through the core's gate like every
  background read, at most 4 clusters at a time, 10 s each. A cluster is read **at most once in
  25 s** however many people ask (its answer is kept that long): it is marked in flight under
  the lock before its read goes out, so a second caller meanwhile shares that read. The answer
  comes within 4 s from what is read by then; clusters still being read are in `reading`
  (`[{cluster, name}]`) and the page asks again 5 s later. The page asks every 30 s and only
  while Jobs › Jobs is open.
- A cluster the governor's signals call busy, or the poller cannot reach, is **not read**, and so
  is one with no credential here: each is in `notRead` with why ("not read: busy: …"). Unknown is
  not zero — such a cluster is never counted as having no slow search.
- Only top-level searches (a shard's phase is its parent's), longest first:

```json
{ "ok": true, "minMs": 30000, "at": 1763591163112, "readEveryMs": 25000, "count": 7,
  "searches": [ {"cluster": "mh", "name": "mswipe-ho", "taskId": "n1:4711", "node": "es-data-3",
                 "action": "indices:data/read/search", "runningMs": 372000, "startedAt": …,
                 "indices": "logstash-2026.11.*", "query": "{\"size\":0,…}", "description": "…",
                 "opaqueId": "elasticpro/…", "by": "ElasticPro", "readAt": …} ],
  "clustersRead": 4, "clustersSeen": 5, "notRead": [ {"cluster": "ussc", "name": "ussc", "why": "not read: busy: …"} ] }
```

- `indices` and `query` come from the task's description (`indices[…]`, `source[…]`); null when
  the cluster does not say — never an empty query. `node` is the node's name when the answer
  gives it. `by` is `"ElasticPro"` for ElasticPro's own searches (opaque id `elasticpro/…`),
  else null; `opaqueId` is the `X-Opaque-Id` as the cluster has it.
- Nothing is cancelled from here: cancelling is a write, and would sit behind the write guard and
  a person's confirmation (ask if one is wanted). The task reaper's own rule is unchanged.
- `bad_request` for a `minMs` not offered. At most 200 searches are listed; `count` says how many
  there were.

## Query cost (0.3.82)

`REQUEST_COST` — what ElasticPro's requests cost each cluster, per kind of work, over the last
24 clock hours, and the slowest of them: **Jobs › Requests › Cost** (`#/jobs/requests/cost`,
`ui/js/pages/requests-cost.js`, pure half `ui/js/core/request-cost.js`). An administrator's,
like `REQUEST_LOG` (a limited administrator reads only their clusters, `sink_view`); read-only,
not in the activity log (a poll: the tab asks every 30 s while it is open, and nothing else
does). Nothing is sent to a cluster.

- **Where the figures come from** (`crates/elasticpro-core/src/request_cost.rs`): every request
  the core finishes in its request log also goes into a cost book in memory — one bucket per clock
  hour for 24 hours, per (cluster, kind) the requests sent, their total time, a latency histogram,
  the bytes read, the timeouts and the deferrals; and per cluster its 10 slowest requests. Bounded
  (24 buckets, at most 4,096 cells a bucket overflow included — past it every further cluster ×
  kind shares one *Other kinds* cell of no cluster (`"cluster": ""`, "several clusters", read only
  by a caller who sees every cluster) — and 10 requests a cluster for at most 1,024 clusters),
  never written to disk: a restart starts again, and the answer's `since` / `hours` say how much it
  covers. The report worker's requests come from its finished-request ring (`worker/requests.jsonl`,
  the one the Request Centre merges), and a job's deferrals from the run log (each deferred run
  holds one cluster back). The ring keeps the worker's last 5,000 requests: on a busy day it does
  not reach back 24 hours, and then the rows the worker's requests add to carry `partialSince`
  (the ring's oldest request) and the tab says "partial — worker kept requests since HH:MM" in the
  row and its tooltip — those counts are fewer than the window's, never presented as the whole day.
- **Kind**: the job a request belongs to (`job:logdelay.measure`, `job:hosts.collect`,
  `job:volume.daily`, `job:report.run`, `job:history.mirror`, labelled with the job's name), a
  poller dataset (`poller:health` → "Poller · health"), a page (`page:<page>`), the REST console,
  or the origin itself (`request_cost::kind_of`, one definition).
- **What counts**: a request that reached the cluster. One answered from the read cache, or by
  somebody else's request already on its way, cost the cluster nothing and is not counted. A
  *timeout* is ElasticPro giving up (`timeout`) or closing a request past its deadline (`reaped`).
  A *deferral* is a request the gate held back before sending it (`overloaded`, `queue_timeout`)
  or a job's cluster held back because it was busy (a deferred run).
- **Figures**: requests per hour over the hours covered (at least one); average time; **p95** — the
  first histogram step (25 ms, 50, 100, 200, 300, 500, 750 ms, 1 s, 1.5, 2, 3, 5, 7.5, 10, 15, 20,
  30, 45 s, 1, 2, 5 min) at or above the 95th request, never above the slowest; bytes over the
  requests whose answer size was reported (`bytesKnown` of them; `null`, "not reported", when
  none was — never 0 B). A kind with deferrals and no request has no time (`null`, "—").
- **Top 10**: the slowest requests in the window on the clusters the caller sees — time, kind,
  cluster, method and path, time taken, bytes. The path keeps the query string's names and leaves
  out their values (`clean_path`; a value can carry a secret or a whole query), then goes through
  the run details' redaction.

```json
{ "ok": true, "keepHours": 24, "since": 1763591163112, "hours": 24.0, "now": 1763677563112,
  "rows": [ { "cluster": "mh", "kind": "job:logdelay.measure", "label": "Log delay measurement", "requests": 24, "perHour": 1.0,
              "avgMs": 8200, "p95Ms": 30000, "maxMs": 30000, "bytes": 9000000, "bytesKnown": 24, "timeouts": 2, "deferrals": 0, "partialSince": null } ],
  "top": [ { "at": 1763676963112, "cluster": "mh", "kind": "job:logdelay.measure", "label": "Log delay measurement",
             "method": "POST", "path": "/logstash-*/_search?filter_path", "ms": 30000, "bytes": null, "status": "timeout" } ] }
```

- **The tab**: one line (requests, clusters, the window, timeouts, deferrals), then *By cluster
  and kind* (Cluster, Kind, Requests / h, Average, p95, Bytes, Timeouts, Deferrals; most requests
  first, every column sorts like the other Jobs tables), then *Most expensive recent requests*.
  Compact rows; an operator is not offered the tab (the Request Centre is the stop alone for them).

## `JOBS_LIST`

`JOBS_LIST {before?, limit?, jobId?}` — any signed-in user from **user** up (not guest: runs
name clusters and carry their errors). Read-only; not in the activity log (a poll).

- `limit`: runs per page, default 50, at most 200.
- `before`: the previous answer's `next` — runs strictly older. `next` is null on the last page.
- `jobId`: one job's runs only (an unknown id is `bad_request`).

```json
{
  "ok": true, "role": "core",
  "jobs": [
    { "id": "logdelay.measure", "name": "Log delay measurement", "kind": "automatic", "owner": "core",
      "schedule": "every everyHours while armed (…, DELAY_SINK_SET); a run that wrote nothing, or read nothing at all, backs off (doubling, capped at a day); clusters that could not be read are named in the run's note and failedClusters, and do not back the schedule off (0.3.80)",
      "nextRun": "delay_sink", "priority": "high", "pausable": true, "requests": { "min": 1, "max": 4 },
      "report": null, "detailsFor": "user", "clusterScoped": false,
      "state": { "enabled": true, "paused": false,
                 "current": null, "activeRuns": 0,
                 "lastRun": { "id": "9f2c51ab03de4e17", "jobId": "logdelay.measure", "status": "completed", "…": "…" },
                 "nextRunAt": 1793952000000, "nextRunNote": null } },
    { "id": "report.run", "…": "…",
      "state": { "enabled": true, "paused": false, "current": null, "activeRuns": 0, "lastRun": null,
                 "nextRunAt": null, "nextRunNote": "runs when a person asks" } }
  ],
  "runs": [
    { "id": "4b0e…", "jobId": "volume.daily", "owner": "worker", "trigger": "timer", "status": "running",
      "createdAt": 1793944800000, "startedAt": 1793944800000, "endedAt": null,
      "progress": 40, "done": 2, "total": 5, "records": null, "error": null,
      "note": null, "clusters": ["prod", "dr", "logs-a", "logs-b", "siem"] }
  ],
  "next": "1793944800000:4b0e…",
  "process": {
    "core":   { "role": "core", "cpuPct": 3.1, "cpuOfLimitPct": 1.6, "memoryBytes": 212000000,
                "memoryLimitBytes": 1073741824, "memoryPct": 19.7,
                "gate": { "running": 2, "queued": 0, "oldestWaitMs": 0 } },
    "worker": { "state": "up", "text": "…", "heartbeatAt": 1793944810000, "cpuPct": 41.0, "cpuOfLimitPct": 20.5,
                "memoryBytes": 512000000, "memoryLimitBytes": 2147483648, "memoryPct": 23.8,
                "gate": { "running": 6, "queued": 3 } }
  },
  "governor": { "auto": true, "inUse": 5, "total": 8, "mostAtOnce": 4, "jobsRunning": 2,
                "lastChange": { "at": 1793944800000, "from": 16, "to": 8, "reason": "people_waiting" },
                "signals": { "cpuPct": 41.2, "memoryPct": 23.8, "peopleWaiting": 2, "queue": 1, "avgPageMs": 840 } },
  "problems": []
}
```

A running job's `state` also has `allocation` (`null` while it does not run):
`{ "requests": 4, "min": 1, "max": 4, "auto": true, "reason": "share" }` — "Governor" below.

- `state.enabled` (automatic runs on, `JOB_SETTINGS_SET`), `state.paused`, `state.pausedBy`,
  `state.pausedAt` (`JOB_PAUSE`), from `controls.json`. A paused job, or one whose automatic runs
  are off, has `nextRunAt: null` and a `nextRunNote` that says so and who paused it.
- `state.current`: the open run (running before queued), `activeRuns` how many are open (the
  report queue runs several). `state.lastRun`: the newest finished run.
- `state.nextRunAt` (unix ms) is null whenever the job does not know a time, and `nextRunNote`
  then says why, naming the setting: not armed, off, not configured, "runs when a person asks",
  "within a minute whenever something is queued". Never a guessed time.
- `process`: what is already sampled (docs/HEALTH.md), never sampled for this answer. A figure
  not read yet is null. `worker` in role `all` is `{state: "not_deployed"}`; in role core it is
  the worker's last heartbeat (`state` `up`, `late`, `down`, `missing`, `version`, `unreadable`).
- `problems`: a run file that could not be read (its runs are missing from the list, not none).
- `busy`: the busy clusters the caller sees (below), `[{cluster, signal, reason, since}]`.
- `governor` and each job's `state.allocation`: "Governor" below. `governor` is `null` in role
  core while the worker's heartbeat is missing or late — never a stale figure shown as now.
- The Zabbix sync's `nextRunAt` is the timer's own: it says when it wakes next each time it goes
  to sleep, from the start of the process — so a restart has a time at once.

**Who reads what** — one rule, the one `REPORT_JOBS` uses (`report::jobs::sees_every`), with
the clusters a caller sees from the one per-caller view of the scheduled work (`Core::sink_view`,
as every `DELAY_SINK_*` and `LOGDELAY_*` answer):

- A run is listed only to a caller who sees **every** cluster in its `clusters`. A run about
  some of theirs and some not is not listed at all — there is no partial view of a run.
- A run of a job about no cluster (`clusterScoped: false`: the log delay measurement's
  refusals, housekeeping, the history store, a backup, Zabbix) that names none is listed to
  everybody who may send `JOBS_LIST`.
- **Not known fails closed.** A run whose clusters are not known — a cluster-scoped job's run
  that names none, or one that names `*` — is listed only to an administrator who sees every
  cluster. A report job covers its `clusterIds`, or, written before that list existed, its one
  `clusterId` (`Job::covered`, the same for `REPORT_JOBS`); a report job naming neither is `*`.
- The same holds for a job's `state.current`, `activeRuns` and `state.lastRun`: they are the
  newest runs the caller may read, so a limited caller may see an older last run, or none.
- Jobs with `detailsFor: "admin"` (history store, housekeeping, settings backup, Zabbix sync and
  push) give their runs' `error` and `note` to administrators only, as their own status messages
  do; anybody else reads "an administrator can read why".

## Controls

Every message here is an **administrator's** who sees every cluster: guest, user and operator
are refused by the role check (`forbidden`), and an administrator limited to some clusters is
refused by the handler — the jobs are fleet-wide (only `JOB_SETTINGS_GET` is open to them). The
run log itself writes only under `<data>/job-runs/`. A run that writes to a monitored cluster
goes through `Writes::decide(read_only, unlocked, requested)` like every other write: the one
such job is the log delay measurement to a sink cluster, and its `JOB_RUN` / `JOB_RETRY` is
refused (`blocked_readonly`, EP-209) while the config is read-only — decided with the request
made by hand and the unlock **not** counted, since a run is background work and no background
work holds a session's unlock (guard.rs). Every change is an audit line naming the person.

In role core, `JOB_RUN`, `JOB_CANCEL` and `JOB_RETRY` of the worker's jobs and runs are handed
to the worker over its internal port (`POST /job`, the shared token and the version, as `/run`
— docs/WORKER.md); the worker starts, asks or queues them and writes its own files. The
settings (`controls.json`) and the created schedules are the core's files, read by the worker.

| message | does |
|---|---|
| `JOB_RUN {jobId, clusterIds?, devices?, device?}` | run now, `manual:<user>` → `{ok, jobId, runId}`; a run already open answers `already_running` with its id (two presses are one run). `devices` and `device` are the log delay measurement's alone, whose `clusterIds` is exactly one cluster (*Fetch now*, below) |
| `JOB_PAUSE {jobId}` / `JOB_RESUME {jobId}` | hold / release a pausable job's timer → `{ok, jobId, paused, settings}` |
| `JOB_CANCEL {runId}` | stop an open run → `{ok, runId, status: "cancelled"}` (it was queued) or `{ok, runId, cancelAsked: true}` |
| `JOB_RETRY {runId}` | a failed, deferred or cancelled run again, same parameters, `trigger: retry` → `{ok, runId, retryOf}` |
| `JOB_CREATE {report, once: true, …}` | one report run now (as `REPORT_RUN`) → `{ok, jobs, runIds, joined?}` |
| `JOB_CREATE {report, name, clusters, schedule, at, to, …}` | a schedule of its own → `{ok, jobId, job}` |
| `JOB_DELETE {jobId}` | a created schedule goes (a built-in job cannot: pause it, or switch its automatic runs off) |
| `JOB_SETTINGS_GET` / `JOB_SETTINGS_SET {jobId?, …, overall?}` | the settings below |

### Run now

`JOB_RUN` runs every job that can run on demand: the log delay measurement (hosted; one cluster's
late devices, whole cluster or one device — *Fetch now*, docs/LOGDELAY.md "Fetch now"), the daily
volume collection (`clusterIds`, default every cluster the caller sees — what *Refresh now* does,
once a minute per cluster), the hosts collection (the month's missing days of each cluster,
without spending the timer's three tries a day), a mailed report (what `REPORT_SEND_NOW` does; a
created schedule's for its own clusters and recipients), the history store mirror (while both its
gates are open), housekeeping (`dryRun?`), the settings backup (the schedule's sections, kept on
the server) and the Zabbix sync (while the API is configured). Not the report runs, which name
their clusters and dates (`JOB_CREATE {once: true}`), nor the Zabbix push, which runs every minute
anyway (`bad_request`).

The run is begun before the answer (`runId`) and the job's own code adopts it; a timer's tick
never does, so the timer and a person do not share a run. Nothing waits for the work: the
answer comes back at once and the run is followed in `JOBS_LIST` — what Reports' *Collect now*
does with the `runId` `VOLUME_RUN` answers (docs/REPORTS.md), polling `JOBS_LIST {jobId:
"volume.daily"}` every 3 s until the run ends. Code that found nothing to do ends the
run `skipped`. The old buttons — `DELAY_SINK_RUN`, `HOUSEKEEPING_RUN`, `BACKUP_CREATE`,
`VOLUME_RUN`, `REPORT_SEND_NOW`, a hosts *Collect again* — keep working and are recorded the same
way, `manual:<user>`, through the same one-run-per-job guard.

### Fetch now (the log delay measurement)

`JOB_RUN {jobId: "logdelay.measure", clusterIds: [one], devices?: "late"|"all", device?: "<device>"}`
is the Log Delay page's *Fetch now*: the scheduled measurement's own code and query (composite
pages, docs/LOGDELAY.md "Measurement"), for **one cluster at a time** — a missing, empty or
multi-cluster `clusterIds` is `bad_request` (the automatic run is what measures every cluster);
an unknown id `not_found`. `devices: "late"` (the default) re-measures only the devices late at the run's
start — delayed (30–60) or critical (above 60) by the cluster's own levels, on the time-zone-corrected delay;
`"all"` the whole cluster, silent devices included; `device` one device (`bad_request` for a name
with `*`/`?`, a control character or over 256 characters).

- Single flight with the timer and `DELAY_SINK_RUN`: `already_running` with the open run's id.
- While it goes, its run in `JOBS_LIST` shows `done`/`total` (devices read of the devices set
  out for, `progress` in percent) and `records` (devices read so far, after every page of 1000);
  ended, `records` is the rows written, `note` names the cluster and the scope (`fetch now:
  prod-logs-eu, late devices (18 of 1 240 at the start)` / `…, whole cluster` / `…, device fw-7`)
  and any cut at *Max devices per run*, `scope` is kept for `JOB_RETRY`.
- A late-devices or one-device run turns nobody silent (it did not read the whole list) and
  leaves the cluster's last run as the whole run's; every person's run leaves the schedule's last
  run, next due and back-off as they were.
- `JOB_CANCEL` stops it between pages; what was read is kept.

```json
{ "type": "JOB_RUN", "jobId": "logdelay.measure", "clusterIds": ["client-a-prod"] }
→ { "ok": true, "jobId": "logdelay.measure", "runId": "4f1c2a9b0e7d6c53", "started": true }
JOBS_LIST {jobId: "logdelay.measure"} → runs[0]:
{ "id": "4f1c2a9b0e7d6c53", "trigger": "manual:Admin", "status": "running", "done": 12, "total": 18, "progress": 67,
  "records": 12, "clusters": ["client-a-prod"], "scope": { "clusterIds": ["client-a-prod"], "device": null, "devices": "late" } }
```

### Pause and resume

`JOB_PAUSE` writes `<data>/job-runs/controls.json` (the core's file; every timer, the worker's
included, reads it before every run, again whenever it changed). A paused job's timer **does not
start a run, and records nothing** — no run-log note per tick; `JOBS_LIST` says it is paused, by
whom and since when. A run already going finishes. A person's `JOB_RUN` still runs it. A pause
survives a restart (it is in the file). On `JOB_RESUME` the job runs by its own rules: a daily
collection whose day passed while paused runs on the first tick, a mailed schedule sends a period
that is still current. Not pausable: the health poll and request handling (not jobs), and
`report.run` — cancel its runs instead (`bad_request`). `JOB_SETTINGS_SET {jobId, enabled: false}`
switches a job's automatic runs off the same way, for good.

### Cancel

Cooperative. A queued run (a report job waiting for a slot) ends `cancelled` at once; a running
one is asked and stops at its next safe point: a report job between days; the volume collection
between requests and days; the hosts collection between days and pages; the log delay
measurement between clusters. The ask is written to the run's file at once — `jobs.json`
(`stopAsked`) for a report job, `job-runs/<owner>.json` (`cancelAsked`) for the rest — so a restart
ends the run `cancelled`, not `failed`. A cancelled scheduled collection leaves its day marked:
the timer does not run it again that day. A job with no safe point left (housekeeping, a
backup, a Zabbix sync or push, which are short) ends as it ends, its note saying the ask came too
late. A run that has ended is `bad_request`; an unknown id `not_found`.

### Retry

`JOB_RETRY` takes a `failed`, `deferred` or `cancelled` run and runs it again with the same
parameters — a collection its clusters, a report job its clusters, dates, format, mail and
options — as a new run, `trigger: retry`, `retryOf` the run it tries again, `attempt` one more than
that run's. The policy (`JOB_SETTINGS_SET overall`): at most `retryLimit` [3] retries of one run
(`retry_limit`, EP-221), and `retryWaitMinutes` [5] after its end before it may be tried again
(`retry_wait`, EP-222, with `retryAt`). Nothing retries by itself except what already did: a
mailed schedule whose job the emergency stop or a restart cut short gives the period back and the
next tick queues it again — that job is now recorded as a retry of the one before (`trigger:
retry`, `retryOf`), its behaviour unchanged.

### Create a job

`JOB_CREATE {report, once: true, clusterIds, period, format?, mail?, collectAgain?}`: one report
run now, exactly `REPORT_RUN` (its limits, its checks; a duplicate joins).

`JOB_CREATE {report, name, clusters, schedule, at, to, cc?, bcc?, period?, subject?, sheets?,
enabled?}`: a mailed schedule of its own (hosted). `report` volume, indices, hosts or log_delay;
`clusters` `"all"` or a list; `schedule` daily, weekly or monthly; `at` HH:MM, server local time;
`to` at least one address. Several per kind; each a job of its own, `report.schedule.<12 hex>`
(stable), in `JOBS_LIST` with its settings (`created`; recipients to administrators only) and its
runs. Kept in `<data>/report-schedules-created.json` (the core's), their state in
`<data>/report-schedules-created-state.json` (the worker's), beside the built-in schedules' files. The period whose moment has already
passed when it is made counts as handled, as a save of the built-in schedule does. The built-in
schedule of each kind (`report-schedule.json`, `UI_REPORT_*` in config.txt) is untouched: a key
in config.txt still locks the built-in one, and only it. A created log delay schedule uses the
report's default options. At most 50; names are unique (`name_taken`).

### Duplicates

A report job asked for by the **same person** with the same report, kind, clusters and dates as
one of theirs queued or running — and the same file format, mail, sheets, options and collection
choice, since joining must give the asker what they asked for — is not queued again: the answer
names the job it joined (`joined`, `runId(s)`), for `REPORT_RUN` and `JOB_CREATE {once}` alike.
Never another person's job: a job's file, download, mail and stop are its requester's, so a second
person asking for the same report gets a job of their own, and joining grants nothing over anybody
else's. A schedule's jobs join only the same schedule's (its recipients). Stopping or retrying a
run is an administrator's (`REPORT_STOP`, `JOB_CANCEL`, `JOB_RETRY`). The Zabbix sync keeps its
wait-then-run (above).

Background reads: two identical background reads to the same cluster in flight at the same moment
share one answer — the same method, path, body, cluster, address and credential, done for the
same person (a report job's starter) or for nobody. Only reads (GET, HEAD, a search); never a
write, a request with a credential of its own, another address or the history store; never with a
person's request (their own keys: a person never waits behind the background class), and never
cached — in flight only (`inflight::background_key`).

### Volume backfill

The daily volume run (and Collect now) fills days of the last `backfillDays` that the record does
not hold as final and measured, a few a run, oldest first, and only while the cluster is not under
query pressure (docs/VOLUME.md "Backfill"). Its run record says what it did: a one-cluster run's
`note` is that cluster's ("backfilled 3 of 10 missing days", "backfill paused: cluster under query
pressure (…); tried again on the next run"); a run over several clusters adds the sums to its
counts ("5 clusters: 5 completed; 12 days backfilled, 1 backfills paused for query pressure").
Pressure pauses the backfill only — the run's own days are collected — and is not a failure.

### Spread

Since 0.3.81 the timers no longer start every cluster in the same minute. Each cluster has a
fixed place in its job's window, worked out in one place (`jobs::spread`):

- **Order.** The clusters are sorted by a stable hash of their id (FNV-1a: the same on every
  build and every restart), then rearranged so two clusters behind the same jump host (`via`)
  never follow each other wherever the mix allows it; the jump host with the most clusters goes
  first. A cluster reached directly shares a jump host with nobody.
- **Place.** The cluster at position *i* of *n* starts *i*/*n* of the way through the window, or,
  for a window centred on a time, at the middle of its slice. One cluster alone keeps its time.
  Adding or removing a cluster moves the others a little; nothing is stored.

| job | window |
|---|---|
| `hosts.collect` | the two hours from `UI_REPORT_HOSTS_AT` (06:00–08:00 by default). Its retries (15 min after a failed try, three tries a day) follow from each cluster's own start, so they are spread too |
| `volume.daily` | the 30 minutes from each cluster's `collectAt`, never before it (with `collectAt` just after UTC midnight an earlier start would close the day before too soon for its late logs) and never into the next day. *Refresh now* starts at once |
| `logdelay.measure` | the timer's own run reads its clusters one after another in the spread's order, each started no sooner than its place in the first quarter of the interval, at most 10 minutes, so a run still ends well inside `everyHours`. A cluster that took longer than its slot is followed at once. *Run now* and *Fetch now* read at once |

Why: production saw twelve clusters deferred or timed out between 08:03 and 08:11 UTC, the
hosts collection having started all of them at 06:00 and retried them together. The places only
decide when a cluster may start; the governor, the busy rule and the request gate still decide
how much it asks.

### Busy clusters

One definition (`jobs::load::busy`), from the signals the product already has. A cluster is busy
when:

- `pool` — its search thread pool queue is over half full, or it rejected more searches since the
  last reading (`report::control::pool_pressure` on `_cat/thread_pool/search`; a reading older
  than 5 minutes says nothing, a calm one ends it);
- `429` — it answered 429 Too Many Requests: the poller's backoff, or an answer of this process's
  own, held for its `Retry-After` or a minute;
- `slow` — its answers take longer than 8 s: the poller's *slowed*, or an answer of this
  process's own; three quick answers end it.

The core publishes its busy clusters to `<data>/job-runs/busy.json` each minute for the worker,
which has no poller; the worker's own come back to the core in its heartbeat (`busy` in
`worker/status.json`). Background collection for a busy cluster waits: the daily volume and hosts
collections do not start it (and spend none of its tries), and record **one** `deferred` run for
the wait (`deferred: {cluster, signal, reason, since}`), however many ticks it lasts; one that
failed because its cluster turned busy ends `deferred` and gives its day back. The first tick
after it eases collects it. Other clusters carry on. A run already going is not cut short by a
busy signal (the hosts collection slows itself, the volume collection asks one thing at a time).
People's own requests are never held back by any of this. `JOBS_LIST {busy}` lists them, to whoever
sees the cluster.

### Per-cluster switches (0.3.82)

Config › Clusters › **Edit cluster › Collection** (an administrator's; others see it read-only):
what ElasticPro may ask one cluster for, and when its heavy jobs may run. One definition,
`collection.rs`, read from the cluster's `ClusterSpec` by the poller, the jobs and the worker alike.

| switch | holds back | where it shows |
|---|---|---|
| ILM checks | the poller's `ilm_errors` and `ilm_assign` | the Clusters page's ILM pill reads *Off* (its tooltip: where to turn it on); the Overview's ILM card *Off* |
| Snapshots | the poller's `snapshots`, `snapshots_full`, `snapshot_status` | the Clusters page's snapshot cell *Off*; the Snapshots page's block for the cluster says so |
| Log delay | the measurement, scheduled and *Fetch now* | a `skipped` part of each scheduled run; *Fetch now* is refused (`switched_off`); the Log Delay page says so |
| Hosts collection | the hosts collection (volume by host), by the timer, *Run now* and a report | one `skipped` run a day; *Run now* skips it with the reason; Reports › Volume by host says so (days already held stay readable) |
| Heavy jobs only between HH and HH | the daily volume collection (with its backfill) and the hosts collection | one `deferred` run per wait: "\<cluster\> waits for 22:00: heavy jobs only 22:00–06:00 for this cluster (Edit cluster › Collection)" |

- **Never asked.** A switched-off dataset is never planned and a page's `CLUSTER_DATASET` for it is
  answered at once with `switchedOff: "<switch>"` and the sentence (no request, no wait). A
  switched-off job never sends the cluster anything. Jobs shows it as **skipped — … switched off for
  this cluster (Edit cluster › Collection)**, in amber, with *When it is switched on again* as its
  retry and a link to Config — never as a failure. A timer that looks every minute records one
  skipped run per cluster and job a day (in memory: a restart may add one).
- **The hours are a hard rule** (owner's decision): whole hours of the server's time zone (the
  stack's `TZ`); `from` is the first hour in, `to` the first hour out, so `22–06` runs 22:00–05:59 and
  crosses midnight. Outside them the heavy jobs send nothing — by the timer, by a person's *Run now*
  (skipped with "not now — heavy jobs only …") or for a volume or hosts report (the file has what the
  record already held, and says why). A timer waits: when the window holds the job's usual place
  (the daily volume run's `collectAt` and spread, the hosts collection's place in 06:00–08:00) it
  runs there, and a run that comes due outside the window waits for it to open; when the window
  leaves that place out (00–06 with `collectAt` 06:00), the job is due whenever the window is open
  and it has not run that local day — so it runs as the window opens, once a day. Note that a window
  ending at 06:00 IST can start a run at 05:30 IST, which is 00:00 UTC: right at the close of the UTC
  day, so that run may count the day just ended while its last logs still arrive (the hosts
  collection reads only closed days; the daily volume run reads the day again next time). The hosts mail does not wait for such a cluster. The scheduled
  log delay measurement is not a heavy job and keeps its interval.
- **Stored with the cluster.** A config-file cluster: its entry's `collection:` —
  `{ilm: false, snapshots: false, logDelay: false, hosts: false, heavyHours: {from: 22, to: 6}}`, only
  what is off written; nothing off is no key. A cluster from Zabbix: the ElasticPro overlay's
  `collection` field (`ZABBIX_CLUSTER_SAVE`; everything on is a reset). Below admin a change is refused
  (`collection_admin`) by `CLUSTER_SAVE` and `ZABBIX_CLUSTER_SAVE`; other edits keep the switches as
  they are. It travels with the config file (export, import) and the backup's *Clusters* section.

### Quiet hours (0.3.82)

Each cluster's quietest hour of the day, learned from what the core already sees (`jobs::quiet`):

- **From**: the poller's own light requests (`poller:*` — health every interval and the small
  datasets), which go to every cluster round the clock, so their answer time is the cluster's load;
  and, once a minute, whether the cluster is busy (`jobs::load::busy`, above). A job's heavy searches
  are left out (they would teach that whatever hour the job runs in is busy).
- **Kept**: per cluster, per hour of the day (server time), a running mean of the answer time and of
  the busy minutes, each over at most 600 samples so the last few days count. Score = mean answer
  ms + busy share × 10 s. An hour counts after 20 samples; the profile names a quiet hour only once 20
  of the 24 hours count, and only among the hours the cluster's heavy-job window allows. Only 2xx
  answers teach it (a cluster refusing fast in maintenance is not quiet). The core writes it to
  `<data>/job-runs/quiet.json` every 10 minutes (beside `busy.json`) — so a restart keeps it, and the
  worker, which has no poller, reads it there. A file a week old says nothing, to the worker and to
  the core at start. A cluster missing from the configured list is forgotten only after 24 hours (a
  Zabbix sync that failed at start does not wipe its clusters' profiles).
- **Used** — rule (owner's decision): a cluster that defers twice in a day waits for its quiet hour
  rather than a third try at a busy hour.
  - The hosts collection: its first busy wait of the day is as before ("tried again when it eases");
    the second (at the tick, or a collection that failed because the cluster turned busy) moves the
    cluster to the next start of its quietest hour — the deferred run says "\<cluster\> is busy: …;
    waits for 03:00, this cluster's quietest hour", and Jobs shows those words. The tick leaves the
    cluster alone until then, and may start it then even before `UI_REPORT_HOSTS_AT`. Busy at the quiet
    hour too: it waits for it to ease, as before. The waits and moves are in memory.
  - The volume backfill: a timer run whose backfill paused for query pressure is run again at the
    cluster's quietest hour (once a day; the run's note says "backfill tried again at 03:00, this
    cluster's quietest hour"), instead of waiting for the next day's run.
  - The log delay measurement has no catch-up run: it measures its own window each interval and is
    not moved.
- **Unknown** (a new cluster, the first day): no quiet hour, and every job behaves as before.

### `JOB_SETTINGS_*`

`<data>/job-runs/controls.json`, per job and overall, defaults in brackets:

- per job: `enabled` — automatic runs on/off [on; a manual job has none]; `auto` — the adaptive
  governor moves its requests [on]; `requests.min` [1] / `requests.max` [4; hosts 2, housekeeping
  1, history store and Zabbix 2] (1–64, min ≤ max); `priority` [log delay High; housekeeping,
  history store and Zabbix Low; every other Medium] — the defaults are the registry's;
- overall: `mostAtOnce` — most jobs at once [4]; `workerTotal` — the worker's total requests [16];
  `cpuPct` / `memoryPct` — hold new runs above them [85 / 85]; `retryLimit` [3]; `retryWaitMinutes` [5].

- overall, the governor: `auto` — the governor moves the worker's total [on; off, the total is
  `workerTotal`];
- overall, the core's gate (`gate::Limits`), changed without a restart: `esConcurrency`
  (`ES_CONCURRENCY`, 1–1024), `esPerCluster` (`ES_PER_CLUSTER`), `esPerJumpHost`
  (`ES_PER_JUMP_HOST`), `esBackgroundReserve` (`ES_BACKGROUND_RESERVE`, 0–1023); `null` puts one
  back to config.txt's value or the default. **A key set in config.txt (or its
  `ELASTICPRO_ES_*` variable) locks the field**: setting it is refused, naming the key.

`JOB_SETTINGS_GET` answers every job's settings with the defaults filled in, and `coreGate`:
each gate field in force, `{value, lockedBy, min, max}` (`lockedBy` names the config.txt key, or
null). `JOB_SETTINGS_SET` checks every field before applying any (a refusal changes nothing).
Pause, `enabled`, the retry policy and the core's gate fields act at once; the governor reads the
rest at its next tick (10 s).

`REPORT_CONCURRENCY_SET {n}` (3..5, as before) is the older name of `overall.mostAtOnce`: it
writes it — one setting, kept in the core's `controls.json`, so the message is handled by the core
and no longer forwarded to the worker. `REPORT_JOBS.concurrency` reads `mostAtOnce`.

## Governor

The worker sizes its own parallelism every 10 s from what it measures, never above the limits an
administrator sets, and people's requests come first. In ElasticPro **threads** are the requests
a job has in flight at Elasticsearch at once, and **processes** are the jobs running at once. The
rule, the sharing and the lanes are `jobs/governor.rs` (pure, tested); the tick, the signals and
the publication are `bridge/governor_api.rs`.

### The rule (AIMD)

One total, decided every `TICK_SECS` (10 s) by role `worker` (and role `all`):

| when | the total |
|---|---|
| calm: CPU < 60 % of what the process may use, memory < 70 % of its limit, **nobody waiting at the core's gate (known)**, CPU not throttled, no fleet-wide pushback | one more |
| any signal over its threshold, first of: people waiting → `people_waiting`; ≥ 10 % of the tick's CPU periods throttled → `cpu_throttled`; CPU over `cpuPct` → `cpu`; memory over `memoryPct` → `memory`; more than half of the clusters the jobs sent to this tick rejecting (`pool` or `429`) → `cluster_rejecting` | half |
| between the two | unchanged |
| outside its bounds (an administrator changed them, a job's minimum came in), or `overall.auto` off | put back → `limit` |

**Bounds**: never below the sum of the running jobs' minimums, never above `workerTotal` (when
the minimums add up to more, `workerTotal` wins). It starts at half of `workerTotal`.

**Not known is not zero.** CPU and memory that cannot be read (no cgroup, no memory limit) are
shown `null` and move the rule neither way. People waiting that is not known (role worker, the
core's publication missing or older than 30 s) is shown `null` and **holds** the total: the
worker never pushes harder on a guess.

### The signals

| signal | from | |
|---|---|---|
| `cpuPct` | the process's cgroup `cpu.stat`, read at each tick (`health::Sampler`) | percent of its CPU limit (`cpu.max`), else of every CPU of the host; over the last tick |
| throttling | `cpu.stat` `nr_throttled` / `nr_periods`, over the last tick | not shown; `cpu_throttled` |
| `memoryPct` | `memory.current` less `inactive_file`, against the cgroup limit | `null` without a limit |
| `peopleWaiting` | the core's gate: people's requests (interactive, prompted) waiting now, plus those granted within 10 s after waiting ≥ 250 ms | role all: this process's gate; role worker: `<data>/job-runs/core-load.json` |
| `queue` | report jobs waiting in the queue | |
| `avgPageMs` | the jobs' requests answered over the last tick, mean | `null` when none |
| rejecting | the busy clusters (`jobs::load::busy`) among the clusters the jobs sent to this tick | `cluster_rejecting` |

**`core-load.json`** (`<data>/job-runs/`): `{at, waiting, waited}`, written by the core alone
(role core) every 5 s and read by the worker at its tick — what the worker reads is at most 5 s
old, and its next tick (at most 10 s on) halves. The worker's own gate is never where
people wait: it carries only background work.

### Sharing

Among the running jobs of the worker, in this order:

1. every running job keeps its `requests.min` — slowed, never starved;
2. a job whose `auto` is off gets its `requests.max`, by priority, within `workerTotal`;
3. what is left of the total goes by priority — High, then Medium, then Low — one request at a
   time round the jobs of a tier, oldest first; no job above its `requests.max`.

A run's allocation is its **lane**: every request the run sends (any cluster, any partition)
waits in the lane for room before it asks the gate for a slot, and holds its place until the
cluster has answered. The lane is the run's: the clusters of a collection run share one, a report
job has one. `allocation.reason`: `share`, `min` (held at its minimum), `max`, `auto_off`,
`limit` (auto off, short of its maximum: `workerTotal` is spent), `fixed` (a job of the core).
Per job id the allocations of its running runs are added up (`requests`); `min` and `max` are each
run's.

**A busy cluster shrinks only its own work**: the per-cluster controller
(`report::control::Controller`, docs/REPORT-TYPES.md "Concurrency") halves on that cluster's
pushback, and its ceiling is the smaller of its own and the job's allocation. One cluster of two
answering 429 halves that cluster's controller and leaves the total alone; most clusters in work
rejecting halve the total.

**Applied to**: report runs (every kind, their collections included), the daily volume
collection, the hosts collection, and the worker's gate: in role `worker` the gate's overall slots
are the total (or the minimums, never above `workerTotal`, nor `ELASTICPRO_WORKER_GATE_CONCURRENCY`
when that is set), changed live. In role `all` the gate is the one people use, so it is left alone
and the lanes hold the jobs back. CPU-heavy work — building the .xlsx, the day files — stays on the
report's blocking slots (`REPORT_CPU_SLOTS`, at most 2).

**The core's jobs** — the log delay measurement and the history store mirror — run in lanes fixed
at their `requests.max`: no AIMD in the core, where people's requests already come first at the
gate. The Zabbix sync and push send nothing to Elasticsearch (their calls go to Zabbix, bounded by
`ZABBIX_CONCURRENCY`), so they have no lane. Housekeeping and the settings backup send nothing to
a cluster.

### Jobs at once

`mostAtOnce` [4] counts the worker's jobs: report jobs running and the two collections' open runs
(`jobsRunning`). The report queue runs `mostAtOnce` less the collections open, **at least one** —
a person's report always has a slot. A collection's timer does not begin a new run while
`jobsRunning` is at `mostAtOnce` (nothing is marked: the next minute's tick tries again); a run
already open takes more clusters in, and a person's `JOB_RUN` / *Refresh now* is never held.

### `JOBS_LIST.governor`

| field | |
|---|---|
| `auto` | `overall.auto` |
| `inUse` | requests the worker's jobs have in flight now |
| `total` | the rule's total |
| `mostAtOnce`, `jobsRunning` | above |
| `lastChange` | `{at, from, to, reason}` of the last change, reason one of `calm`, `cpu`, `cpu_throttled`, `memory`, `people_waiting`, `cluster_rejecting`, `limit`; null before the first |
| `signals` | `{cpuPct, memoryPct, peopleWaiting, queue, avgPageMs}`, null where not known |

Role core reads it from the worker's heartbeat (`worker/status.json` `governor`, every 10 s);
`null` while there is no heartbeat or it is late. Role all reads its own.

`JOB_SETTINGS_GET` answers every job's settings with the defaults filled in. `JOB_SETTINGS_SET`
checks every field before applying any (a refusal changes nothing). Pause, `enabled` and the retry
policy act now; `requests`, `priority`, `auto` and the thresholds are kept for the adaptive
governor, which reads them.

## Jobs page

`#/jobs` (`ui/js/pages/jobs.js`; words and arithmetic in `ui/js/core/jobs.js`, tested in
`tools/unit/jobs.test.mjs`). In the page menu after Reports, for **user** and up (a guest has no
tab: runs name clusters and carry their errors). Everybody reads; only an administrator presses,
and every press goes through the write unlock the other admin pages use (`ensureWrites`, read-only
by default) before its `JOB_*` message.

- **The strip** (History and Settings; on the Jobs tab the Now and Health cards say it): worker
  and core CPU and memory (`process`; a worker not deployed says it runs in the core), requests
  per second to the clusters (`REQUEST_STATS`, as the Clusters page), jobs running and queued,
  busy clusters with their reason and since when (`busy`), and the governor's "in use of total"
  when `governor` is present — nothing for it when it is not (`null`: before the governor, or the
  worker's heartbeat late). Its hover has jobs at once, the last change with its reason in words
  (`people_waiting` is "people waiting") and the signals, each "not known" when `null`, never 0. A
  job's `state.allocation` reason is put in words the same way.
- **Jobs** (`#/jobs`) — the approved graphical view (0.3.77, `pages/jobs-graph.js`, pure half
  `core/jobs-graph.js`), then the tables:
  - *Now*: four tiles — Running, Queued, Slots in use (the governor's in use of its total, with a
    bar; "not reporting" when `governor` is null), Last 24 hours (the success rate of the runs
    that ended in the last 24 h: ok = completed, with warnings = deferred / skipped / cancelled,
    failed; from the runs paged below; "kept" and a hover naming the job when one ran more than
    the 50 runs a job keeps). Then every open run (the page's open runs and each job's
    `state.current`): its clusters, a bar and percent from `progress` ("counting…" and no bar when
    it is null), records, how long it has run and, once it is 5 % in and 10 s old, *about* how
    long is left (linear from `progress`; never without it), the job's requests and Stop
    (`JOB_CANCEL`, asked first); a queued run says why it waits (a free slot, the governor's
    figures, its priority) and offers Run now when the job runs on demand; a `stale` run is
    marked. Then *Just ran*: the six newest finished runs as chips (✓ / ⚠ / ✗, the job, the
    time, a short note; the rest on hover) — most runs last well under a second (a backup or
    housekeeping a few ms, a collection or a report run a few hundred), far inside a read's
    interval, so this is where they are seen.
  - *Health*: Worker CPU, Core CPU, Memory, Requests/s, Busy clusters — the value now (the
    strip's) and a line over 1h · 6h · 24h · 7d (24h by default, remembered in the browser) from
    `HEALTH_HISTORY` (docs/HEALTH.md "History", kept 7 days on the server). A caller limited to
    some clusters gets no line for the fleet-wide counts, and is told why.
  - *ElasticPro health* (administrators: `SYSTEM_HEALTH` is theirs): the service pills (Core,
    Report worker, Redis, Zabbix sync, Mail, History store) and a tile per check (core and worker
    memory, message p95, requests turned away, poller late datasets, data volume free): the
    value, the limits (`thresholds`), ok / watch / over (the check's own level) and its line over
    the same switch. Jobs › Requests › ElasticPro health keeps the full table.
  - *Runs, last 24h* (6h · 24h · 7d): one lane per job, a bar per run coloured by its result
    (green ok, orange with warnings, red failed, blue running — never red and yellow together),
    the next run dashed at the right edge, a "now" line; a bar's hover has the job, its clusters,
    start, duration, result and error. From `JOBS_LIST` paged 200 at a time (at most six pages)
    back to the window's start — the run log the core already keeps; nothing new is recorded.
  - *Slow searches now* (0.3.81, under Now; "Slow searches" above): three tiles — how many
    searches run long and on how many clusters (and how many were not read), the longest (cluster
    · node), the cluster slowest now (most long searches) — then the searches, longest first:
    cluster (an *ElasticPro* chip on our own), running time (amber from 1 min, red from 5 min),
    node, index and the query cut to two lines; three rows, then "Show all". *Open* shows the
    whole query, the task id, the `X-Opaque-Id` and Copy. The switch 10 s · 30 s · 1 min · 5 min
    (30 s first) asks again at once; otherwise `SLOW_SEARCHES` every 30 s while the tab is open.
    Clusters not read are named under the table. Read-only: no cancel.
  - *All jobs* — one table that fits the page at 1280 px with the menu on the left: Name · Type ·
    Status (a *paused* chip beside a running job's status, its progress beside a running one) ·
    Last run (the exact time the open run, else the last, started: "19 Nov 22:26:03") · Duration ·
    Next run (exact: "20 Nov 00:26"; relative on hover) · Result (the last run's: "Partial · 4 of
    71 clusters", "Succeeded · 71 clusters", "Deferred · 1 cluster" — from its `parts`, else its
    status) · Priority · requests; records and the last run's trouble a line under the row only
    when there is one: an error in red ("Error: …", cut short, whole on hover and in the opened
    row), a deferral in amber ("ussc deferred — response time 15.7 s exceeded the 8 s threshold;
    retried automatically when it eases (a warning, not a failure)"). ▸ opens the row on its last
    run, read then with `JOB_RUN_DETAIL` (once a visit): *Summary* (the run summary grid — run id,
    trigger, start → end, duration, query window, clusters = succeeded + partial + failed (+
    deferred + skipped), records collected, success rate — and the job's schedule, next run,
    error, note), *Exceptions (n)* (cluster, result, code and message, records, elapsed, retry,
    the action as a link to the page with the setting), *All clusters (n)*, *Log* (the run's
    lines, errors red and warnings amber, Copy and Download .txt) and *Run history* (the job's
    last 15 runs; Open shows one of them).
    Every column sorts by core/sort.js (unknown last both ways). A row menu of Run now, Pause /
    Resume, Stop, Retry (the last run, when failed, deferred or cancelled), Settings and, for a
    created schedule, Delete (`JOB_DELETE`, asked first). *Up next* — the automatic jobs by
    `nextRunAt`, then the paused or off ones with their note; Run now and Pause / Resume.
    *Created schedules* lists those alone.
- **History** (`#/jobs/history`): `JOBS_LIST {limit: 50, before, jobId}` a page at a time (Older /
  Newer walk `next`), by job; the result filter applies to the page on screen. Retry on a failed,
  deferred or cancelled run.
- **Settings** (`#/jobs/settings`): `JOB_SETTINGS_GET` / `JOB_SETTINGS_SET` — the overall limits
  and, per job, automatic runs, auto, requests at least / at most and priority; checked as the core
  checks them before anything is sent, only what changed is sent. A field `managed` in the answer
  is locked with "managed by config.txt" (the core sends none today). Below admin: what
  `JOBS_LIST` says, read-only.
- **Create job**: a report once now (`JOB_CREATE {once: true}`; the report run's periods, format,
  mail and the hosts cap of 5) or a recurring mailed schedule (name, report, clusters or all,
  daily / weekly / monthly at HH:MM server time, period, To / Cc / Bcc, subject).
- **Refusals** are sentences: `already_running` (with the run), `joined`, `blocked_readonly`,
  `retry_limit` (tries and the limit), `retry_wait` (when it may be tried again), `forbidden`,
  `name_taken`, the worker's own; anything else is the core's message.
- **Times**: absolute in the server's zone when `JOBS_LIST` names one (`tz`), else said to be the
  reader's own; relative beside it.
- **Reads**: `JOBS_LIST` every 3 s while a run is open or queued; otherwise every 5 s on the Jobs
  tab and every 15 s on History and Settings (`core/jobs.js pollDelay`); at once when the Jobs tab
  is opened again. On the Jobs tab also `HEALTH_HISTORY` every minute (or on a new range),
  `SYSTEM_HEALTH` every 30 s (administrators) and the runs for the lanes every minute. None while
  the browser tab is hidden; none once the page is left. Rows, cells, bars and buttons are kept between reads
  (lib/keyed.js): the Stop under a pointer is the same button while its run moves
  (`tools/flicker-check.mjs`, strict).
