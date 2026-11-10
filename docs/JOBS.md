# Jobs — the registry, the run log and the message contract

Everything ElasticPro runs by itself or when a person asks for it is a **job**, listed once in
one table (`crates/elasticpro-core/src/jobs/mod.rs`, `REGISTRY`). Every run of every job is
recorded: who or what started it, when, how far it got, how it ended. The health poll and
request handling are monitoring, not jobs: they are not in the table and cannot be paused.

Built in stages: the registry, the run log and `JOBS_LIST` (this release); the controls (run
now, pause, resume, cancel, retry, create, several schedules per report kind, joining a
duplicate, deferring for a busy cluster); the adaptive concurrency governor; the Jobs page.
The messages of the later stages are below, marked **planned**: the contract is fixed now so
the stages build on it.

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
runs everything. A manual report run is stopped with `JOB_CANCEL` (planned), not paused.

**What counts as a run.** A tick that does nothing is not a run: the history store's minute when
nothing is queued or a switch is off, the push when no host is named, the Zabbix sync while the
API is not configured. A scheduled measurement refused before it started (not primed, read-only,
no destination) *is* a run, `skipped`, because it was due. The two collections start one cluster
at a time: the clusters a tick starts — and any a later tick starts while some still collect —
are **one run**, its progress the clusters ended of those begun. A *Refresh now* of one cluster
(`VOLUME_RUN`) and a hosts *Collect again* job are not runs of the daily jobs.

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
twice), `ZABBIX_SYNC` while a sync runs, and `HOUSEKEEPING_RUN` while housekeeping runs (which
answered `kind: "busy"` before). A timer tick that meets an open run leaves it be. The Zabbix
sync after a link change waits for an open sync to end (at most two minutes), then syncs.

The hosts collection's tries per cluster (three a day, 15 minutes apart) are kept in
`<data>/job-runs/hosts-tries.json`: a restart no longer hands every cluster three more.

## Statuses

| status | meaning | set now |
|---|---|---|
| `pending` | asked for, not yet eligible (a paused job's run, a deferred run's wait) | planned |
| `queued` | waiting for a slot | report jobs |
| `running` | under way | yes |
| `completed` | ended, and did what it set out to | yes |
| `failed` | ended with an error (`error` says what) | yes |
| `paused` | held by `JOB_PAUSE` | planned |
| `cancelled` | stopped by a person (`REPORT_STOP`; `JOB_CANCEL`) | report jobs |
| `deferred` | ended early for a reason that passes — the emergency stop, a busy cluster — and tried again by the job's own rules | the collections at the emergency stop |
| `skipped` | nothing was attempted: something stood in the way (`error` names it and the setting that changes it) | the log delay measurement |

A run of a collection with several clusters ends `failed` if any cluster failed, else `deferred`
if any was, else `cancelled`, else `completed`; its `note` counts each.

## A run record

| field | |
|---|---|
| `id` | the run's id (16 hex), or `report-<job id>` |
| `jobId` | the job's id |
| `owner` | `core` or `worker`: whose run file holds it |
| `trigger` | `timer` (the product on its own: its timer, the start, a follow-up to a setting changed), `manual:<user>`, or `retry` (planned, `JOB_RETRY`) |
| `status` | above |
| `createdAt`, `startedAt`, `endedAt` | unix ms; `createdAt` is when it was asked for (= `startedAt` unless it queued) |
| `progress` | percent, from `done` of `total` when the job counts them — **null when the total is not known**, never a guess |
| `done`, `total` | the counts behind it (clusters of a collection, days of a report), or null |
| `records` | what it processed: days collected, documents written, items removed, devices measured; null when the job does not count them |
| `error` | why it failed, deferred or was skipped |
| `clusters` | the clusters it read from or wrote to |
| `note` | anything else (a backup's file and size, housekeeping's bytes, a report's warning) |
| `partial` | true when some of `clusters` are outside the caller's view (below) |

**Kept:** the last 50 finished runs per job, 2000 per file; an open run is never dropped. A run
open when its process stopped ends `failed`, "the server restarted while this ran", at the next
start. A run whose code ended without saying how ends `failed` too.

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
      "report": null, "detailsFor": "user",
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
      "note": null, "clusters": ["prod", "dr", "logs-a", "logs-b", "siem"], "partial": false }
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
  "problems": []
}
```

- `state.enabled` and `state.paused` are `true` and `false` for every job until `JOB_PAUSE` /
  `JOB_SETTINGS_SET` exist; they are in the answer now so the page need not change then.
- `state.current`: the open run (running before queued), `activeRuns` how many are open (the
  report queue runs several). `state.lastRun`: the newest finished run.
- `state.nextRunAt` (unix ms) is null whenever the job does not know a time, and `nextRunNote`
  then says why, naming the setting: not armed, off, not configured, "runs when a person asks",
  "within a minute whenever something is queued". Never a guessed time.
- `process`: what is already sampled (docs/HEALTH.md), never sampled for this answer. A figure
  not read yet is null. `worker` in role `all` is `{state: "not_deployed"}`; in role core it is
  the worker's last heartbeat (`state` `up`, `late`, `down`, `missing`, `version`, `unreadable`).
- `problems`: a run file that could not be read (its runs are missing from the list, not none).

**Who reads what** — through the one per-caller view of the scheduled work (`Core::sink_view`,
as every `DELAY_SINK_*` and `LOGDELAY_*` answer):

- A run about no cluster (housekeeping, the history store, a backup, Zabbix) is listed to all.
- A run about clusters the caller does not see at all is not listed.
- A run about some of theirs and some not is listed with only theirs in `clusters`, `partial:
  true`, and its `error` (which may be about the others) replaced by "about a cluster outside
  your view…", its `records` and `note` null.
- Jobs with `detailsFor: "admin"` (history store, housekeeping, settings backup, Zabbix sync and
  push) give their runs' `error` and `note` to administrators only, as their own status messages
  do; anybody else reads "an administrator can read why".

## Planned messages

Not built yet; the names and shapes are fixed here. Every one that changes something is an
**administrator's** (one limited to some clusters is refused: the jobs are fleet-wide), and any
that writes to a cluster goes through `Writes::decide(read_only, unlocked, requested)` like every
other write — the run log itself writes only under `<data>/job-runs/`.

| message | does |
|---|---|
| `JOB_RUN {jobId, clusterIds?}` | run now (`manual:<user>`); `already_running` with the open run's id, or joins it where the job joins duplicates |
| `JOB_PAUSE {jobId}` / `JOB_RESUME {jobId}` | stop / restart a pausable job's timer; a running run finishes (or is `paused` where the job can hold) |
| `JOB_CANCEL {runId}` | stop an open run: `cancelled` |
| `JOB_RETRY {runId}` | run a failed, deferred or cancelled run again: a new run, `trigger: "retry"` |
| `JOB_CREATE {kind, schedule, …}` | another schedule of a report kind (several mailed schedules per kind) |
| `JOB_SETTINGS_GET` / `JOB_SETTINGS_SET {jobId?, …}` | the settings below |

`JOB_SETTINGS_*` — per job and overall, defaults in brackets:

- per job: automatic on/off [on], requests min [1] / max [4; hosts 2, housekeeping 1, history
  store and Zabbix 2], priority [log delay High; housekeeping, history store and Zabbix Low;
  every other Medium] — the defaults are the registry's;
- overall: most jobs at once [4], the worker's total requests [16], hold new runs above CPU [85%]
  or memory [85%] (deferring them, `deferred`, until the process is back under).
