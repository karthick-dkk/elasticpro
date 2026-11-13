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
| `note` | anything else (a backup's file and size, housekeeping's bytes, a report's warning) |
| `cancelAsked` | `JOB_CANCEL` asked it to stop (it stops at its next safe point) |
| `retryOf`, `attempt` | the run this one tries again, and which try (1 = the first retry); null / 0 otherwise |
| `deferred` | a busy cluster's wait: `{cluster, signal, reason, since}`; null otherwise |
| `scope` | what a person narrowed the run to (the log delay measurement's *Fetch now*: `{clusterIds, device}`); absent otherwise. `JOB_RETRY` runs the same scope again |
| `stale` | role core: a worker run still open while the worker's heartbeat is late or never came — it may have ended with the worker. Never ended by the core, only marked |

**Kept:** the last 50 finished runs per job, 2000 per file; an open run is never dropped. A run
open when its process stopped ends `failed`, "the server restarted while this ran", at the next
start — unless a person had asked it to stop (`cancelAsked`): then it ends `cancelled`. A run
whose code ended without saying how ends `failed` too.

**One writer per file** (docs/WORKER.md): `<data>/job-runs/core.json` is written by the process
that runs the core's jobs, `<data>/job-runs/worker.json` by the one that runs the worker's (role
`all` writes both). The core reads the worker's file, as the worker last wrote it — a running run
there is as running as the worker's last write says. The worker's own read-only Zabbix sync is
held one at a time but not recorded: the job is the core's.

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
      "schedule": "every everyHours while armed (…, DELAY_SINK_SET); a failing run backs off",
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
| `JOB_RUN {jobId, clusterIds?, device?}` | run now, `manual:<user>` → `{ok, jobId, runId}`; a run already open answers `already_running` with its id (two presses are one run). `device` is the log delay measurement's alone (*Fetch now*, below) |
| `JOB_PAUSE {jobId}` / `JOB_RESUME {jobId}` | hold / release a pausable job's timer → `{ok, jobId, paused, settings}` |
| `JOB_CANCEL {runId}` | stop an open run → `{ok, runId, status: "cancelled"}` (it was queued) or `{ok, runId, cancelAsked: true}` |
| `JOB_RETRY {runId}` | a failed, deferred or cancelled run again, same parameters, `trigger: retry` → `{ok, runId, retryOf}` |
| `JOB_CREATE {report, once: true, …}` | one report run now (as `REPORT_RUN`) → `{ok, jobs, runIds, joined?}` |
| `JOB_CREATE {report, name, clusters, schedule, at, to, …}` | a schedule of its own → `{ok, jobId, job}` |
| `JOB_DELETE {jobId}` | a created schedule goes (a built-in job cannot: pause it, or switch its automatic runs off) |
| `JOB_SETTINGS_GET` / `JOB_SETTINGS_SET {jobId?, …, overall?}` | the settings below |

### Run now

`JOB_RUN` runs every job that can run on demand: the log delay measurement (hosted; `clusterIds`
and/or `device` narrow it — *Fetch now*, docs/LOGDELAY.md "Fetch now"), the daily
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

`JOB_RUN {jobId: "logdelay.measure", clusterIds?: [ids], device?: "<device>"}` is the Log Delay
page's *Fetch now*: the scheduled measurement's own code and query (composite pages,
docs/LOGDELAY.md "Measurement"), narrowed to those clusters (1–200, `not_found` for an unknown
id) or that one device (`bad_request` for a name with `*`/`?`, a control character or over 256
characters). Without either it is the whole measurement, as `DELAY_SINK_RUN`.

- Single flight with the timer and `DELAY_SINK_RUN`: `already_running` with the open run's id.
- While it goes, its run in `JOBS_LIST` shows `done`/`total` (clusters read of the run's
  clusters, `progress` in percent) and `records` (devices read so far, after every page of 1000);
  ended, `records` is the rows written, `note` says the scope and any cluster cut at *Max devices
  per run*, `scope` is kept for `JOB_RETRY`.
- A narrowed run turns nobody silent (it did not read the whole list) and leaves the schedule's
  last run, next due and back-off as they were.
- `JOB_CANCEL` stops it between pages and between clusters; what was read is kept.

```json
{ "type": "JOB_RUN", "jobId": "logdelay.measure", "clusterIds": ["client-a-prod"] }
→ { "ok": true, "jobId": "logdelay.measure", "runId": "4f1c2a9b0e7d6c53", "started": true }
JOBS_LIST {jobId: "logdelay.measure"} → runs[0]:
{ "id": "4f1c2a9b0e7d6c53", "trigger": "manual:Admin", "status": "running", "done": 0, "total": 1, "progress": 0,
  "records": 12000, "clusters": ["client-a-prod"], "scope": { "clusterIds": ["client-a-prod"], "device": null } }
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

- **The strip**: worker and core CPU and memory (`process`; a worker not deployed says it runs in
  the core), requests per second to the clusters (`REQUEST_STATS`, as the Clusters page), jobs
  running and queued, busy clusters with their reason and since when (`busy`), and the governor's
  "in use of total" when `governor` is present — nothing for it when it is not (`null`: before the
  governor, or the worker's heartbeat late). Its hover has jobs at once, the last change with its
  reason in words (`people_waiting` is "people waiting") and the signals, each "not known" when
  `null`, never 0. A job's `state.allocation` reason is put in words the same way.
- **Jobs** (`#/jobs`): *Running now* — every open run (the page's open runs and each job's
  `state.current`), the clusters it is on, a bar and percent from `progress` ("counting…" and no
  bar when it is null), records, start, live duration, the job's requests (`state.allocation` once
  the governor reports it, else the registry's range) and Stop (`JOB_CANCEL`, asked first); a
  `stale` run is marked. *Up next* — the automatic jobs by `nextRunAt`, then the paused or off
  ones with their note; Run now and Pause / Resume. *All jobs* — one table, every column sorted by
  core/sort.js (unknown last both ways), the error cut short and whole when the row is opened, a
  row menu of Run now, Pause / Resume, Stop, Retry (the last run, when failed, deferred or
  cancelled), Settings and, for a created schedule, Delete (`JOB_DELETE`, asked first). *Created
  schedules* lists those alone.
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
- **Reads**: every 2 s while a run is open or queued, every 15 s otherwise; none while the browser
  tab is hidden; none once the page is left. Rows, cells, bars and buttons are kept between reads
  (lib/keyed.js): the Stop under a pointer is the same button while its run moves
  (`tools/flicker-check.mjs`, strict).
