# ElasticPro health and performance (0.3.54)

Developer contract for showing ElasticPro's **own** health and performance in the UI: is the
core well, is the report worker well, is anything queueing, and is a report pushing too hard.
Asked for by the user 2026-11-04. Opening it never sends a cluster anything: every figure is
the core's (and the worker's) own state.

## Where

Request Centre (page 10) gains a second tab: **Requests · ElasticPro health**
(`#/requests/health`). Administrators only, like the request log; an operator sees the
emergency stop as today and not this tab. While open it reads `SYSTEM_HEALTH` every 5 s (a core
round trip) and stops when left. Compact density, ElasticPro tokens, no new colours. A small
dot in the Request Centre nav entry turns amber/red when any check below is amber/red
(from `PING`, which gains `health: "ok"|"warn"|"bad"` for administrators).

## What it shows

1. **Status strip** — one chip each: Core (version, uptime), Report worker (up / heartbeat age
   / version match, or *not deployed — role all* per docs/WORKER.md), Redis, Database, Zabbix
   sync (last result), Mail (last send result), History store (armed / last write). A part
   that cannot report says *not known*, never green.
2. **Memory** — core and worker: resident memory against the container limit (bar with %),
   peak in the last 24 h, OOM kills since the container started (cgroup `memory.events`), and
   the core's budget split from `memory.rs` (cache, in flight, read cache, reports share: used
   of budget). No limit → *no limit*.
3. **CPU** — core and worker: CPU % over the last minute (cgroup `cpu.stat` usage), and time
   throttled by the CPU limit (`nr_throttled`, `throttled_usec`) — throttling is what makes a
   capped container slow.
4. **Response time** — the core's handling time per message type, last 5 min and 1 h: p50,
   p95, p99, count, errors; the five slowest types; open sessions and event streams.
5. **Request gate** — per class (Interactive, Prompted, Background): slots in use of cap,
   waiting, wait p95, `overloaded` and `queue_timeout` counts (5 min / 1 h); per cluster: in
   use, waiting, upstream p95, timeouts, 429s. The worker's gate the same, labelled *worker*.
6. **Fleet poller** — datasets due, late (and by how much), cycle time, clusters down.
7. **Reports and collection** — running jobs with progress (cluster, day, partitions, pages,
   rows, **current concurrency**, halvings and the last reason — docs/REPORT-TYPES.md
   "Concurrency"), queued jobs, next scheduled run per kind, last run result per kind.
8. **Disk** — the data volume: used / free, and the size of each area (volume record, host
   files, report files, fleet cache, logs); last prune.
9. **Trends** — 24 h sparklines (one sample a minute, kept in a ring in memory and written to
   `<data>/health/<role>.json` every 10 min so a restart keeps the day): resident memory, p95
   response time, gate waiting, worker concurrency.

## Checks (amber / red)

| Check | Amber | Red |
|---|---|---|
| Resident memory of limit (core, worker) | ≥ 80% | ≥ 90%, or an OOM kill in 24 h |
| CPU throttled (last 5 min) | ≥ 10% of periods | ≥ 30% |
| Message p95 (5 min, all types) | ≥ 1 s | ≥ 3 s |
| Gate `overloaded` + `queue_timeout` (5 min) | ≥ 1 | ≥ 20 |
| Poller late datasets | ≥ 5% | ≥ 20% |
| Worker heartbeat age | ≥ 30 s | ≥ 90 s, or version mismatch |
| Data volume free | ≤ 15% | ≤ 5% |

Each amber/red line says what it means and the setting or action that would fix it (for
example "raise ELASTICPRO_MEM_LIMIT in deploy/.env" or "UI_REPORT_CONCURRENCY_MAX"). Thresholds
are constants in one place (`health.rs`), shown in the tab.

## Core

- `health.rs`: samplers (cgroup v2 `memory.current`, `memory.max`, `memory.events`,
  `cpu.stat`; `/proc/self/status` VmRSS/VmHWM when cgroup files are absent; `statvfs` for the
  volume), the per-minute ring, and the checks — pure functions with tests; I/O at the edges.
- Message timing recorded once in the bridge dispatch (one histogram per type, fixed buckets,
  bounded memory). Gate counters exposed from `GateState` (no new locking on the hot path:
  counters, not logs).
- `SYSTEM_HEALTH` (administrators; audited like REQUEST_LOG reads are not — it is a read)
  returns the snapshot plus the worker's (from `<data>/worker/status.json`, which the worker
  extends with its own samplers and gate counters).
- Cheap: sampling once a minute plus counters; the tab's 5-s reads only serialise what is held.

## Later (not in 0.3.54 unless asked)

- The same checks as Zabbix items for the ElasticPro host (zbx_push), so Zabbix alerts on them.

## Tests

- Unit: each sampler against fixture cgroup files (v2, absent, no limit); histogram
  percentiles; check thresholds; ring persistence across a restart.
- render-check / behaviour-check: the tab renders with a fixture snapshot, amber/red lines
  carry their fix text, *not known* for a missing part, operator does not see the tab.
- On the VM: the tab during the 06:00 run and while the worker is killed (worker chip red,
  everything else green).

## As built (0.3.54)

Where the code is: `crates/elasticpro-core/src/health.rs` (samplers, ring, histograms, checks,
`WorkerStatus` — pure, tested against fixture cgroup files), `src/bridge/system_health.rs` (what
the core gathers, the minute task `start_health`, `SYSTEM_HEALTH`), `ui/js/core/system-health.js`
(pure) and `ui/js/pages/requests-health.js` (the tab).

Decisions made while building, within the contract:

- **Resident memory** is cgroup `memory.current` less `inactive_file` from `memory.stat` — what
  `docker stats` shows, and close to what the OOM killer weighs; `/proc/self/status` `VmRSS` when
  there is no cgroup; *not known* when neither (macOS). The limit is `memory::read_cgroup_limit`,
  the same function the budget split uses.
- **CPU %** is of one CPU, between two minute samples (`cpu.stat usage_usec`); against the limit
  when `cpu.max` sets one. No `cpu.stat` → *not known*; `cpu.stat` without throttling counters →
  *no CPU limit*.
- **The message p95 check** reads "own" messages: every type less those whose time is somebody
  else's by definition (`WAITS_ELSEWHERE`: ES, CLUSTER_DATASET, REFRESH, Zabbix, mail, history
  store tests and queries, password hashing …). A slow cluster shows under *Request gate*
  (upstream p95, timeouts, 429s), not as a slow core. The tab shows both figures. Percentiles are
  bucket upper bounds (1 ms … 60 s, then the slowest seen).
- **Gate refusals over 1 h** come from the ring: each minute's sample keeps that minute's
  `overloaded` and `queue_timeout` (`Gate::window(60 s)`), so `gate.rs` is unchanged. Only
  Interactive requests are ever refused, so the counts sit on that row.
- **A late dataset** is a scheduled (Background under the mode) dataset more than 30 s past its
  due time, on a cluster that answers, is not held back (budget/back-off) and while the poller is
  not idle; one being fetched counts as not due. Late % is of those tracked. The emergency stop
  makes the check *off*, not red. Cycle time is how long a poller pass (`fleet_tick`) took.
- **Database** is always *not known*: the core does not connect to it (the db container has its
  own healthcheck). **Redis** is the write-through store's last success / last failure, no extra
  round trip.
- **Reports share** of the memory budget is `null` ("not known — this core has no reports share")
  until `memory.rs` gains it; then `budget.reports = {budgetBytes, usedBytes}`.
- **Report jobs**: in role `all` the queue the core holds; in role `core` `reports/jobs.json`; when
  the worker's status file lists running jobs, those (they carry the concurrency). A job's
  `day`, `partitions` (`{done,total}`), `pages`, `rows`, `concurrency`, `halvings`, `lastReason`
  are read from the job or from its `progress`, by those camelCase names, when present; a job
  without them shows *not reported*. `reportKind` (`indices`, `hosts`) names the kind; absent is
  `volume`.
- **Role** is `ELASTICPRO_ROLE` (`core`, `worker`, else `all`). In `all` there is no worker: its
  chip is *not deployed — role all* (off, not a fault) and no worker check is made. In `core` a
  missing status file is red.
- The ring is `<data>/health/<role>.json`, written every 10 samples; a file that does not parse
  starts an empty day. Disk areas are walked every 10 minutes (at most 200 000 entries a walk,
  then *at least*); free space is one `statvfs` a minute.
- `SYSTEM_HEALTH` is in the activity log's poll list (a read, every 5 s while open).

### `SYSTEM_HEALTH` (administrators)

```
{ ok, at, role: "all"|"core"|"worker", level: "ok"|"warn"|"bad",
  thresholds: [{id, check, amber, red}],
  checks: [{id, threshold, label, level: "ok"|"warn"|"bad"|"unknown"|"off", value, text, fix|null}],
  parts:  [{id: core|worker|redis|database|zabbix|mail|history, label, level, text, at|null}],
  core: { version, startedAt, uptimeSec,
          memory: MemoryFigures, cpu: CpuFigures,
          budget: {limitSource, warning, cache, inflight, readCache: {budgetBytes, usedBytes}, reports: null},
          messages: {w5m: TimingWindow, w1h: TimingWindow, slowest: [TypeStats ×5], sessions, eventStreams},
          gate: GateFigures, poller: PollerFigures, disk: DiskFigures|null, lastPrune: housekeeping lastRun|null },
  worker: {state: not_deployed|missing|unreadable|up|late|down|version, level, text, heartbeatAgeSecs, versionMatch, status: WorkerStatus|null},
  reports: {source: core|jobs.json|worker, running: [JobLine], queued, queuedJobs: [JobLine ≤10], collection: [CollectionLine],
            schedules: [{kind, enabled, cadence, at, recipients, nextAt, lastSent}], lastJob: {kind: {id, status, endedAt, error, cluster}}},
  trends: {fields: ["t","rss","p95Ms","waiting","workerRss","workerConcurrency"], points: [[…], …]} }
TimingWindow = {minutes, all: TypeStats, own: TypeStats, byType: [TypeStats]}
TypeStats    = {type, count, errors, p50Ms, p95Ms, p99Ms, maxMs}
```

Per-cluster gate rows are narrowed to the clusters the caller may see. `PING` carries
`health: "ok"|"warn"|"bad"` for an administrator (the level the minute task last worked out).

### The worker's status file

`<data>/worker/status.json`, written by the worker every 10 s (temp file + rename, 0600) with
`health::WorkerStatus::write`; read by the core with `WorkerStatus::read`. camelCase; every field
optional on read, so a worker and core a release apart agree as far as they can.

```
WorkerStatus = { schema: 1, role: "worker", version, pid, startedAt, heartbeatAt,   // ms
                 memory: MemoryFigures, cpu: CpuFigures, gate: GateFigures|null,
                 jobs: [JobLine], queued, collection: [CollectionLine] }
MemoryFigures = { rssBytes, rssSource, limitBytes, limitSource, usedPct, peakBytes24h, hwmBytes, oomKills, oomKills24h }
CpuFigures    = { readable, pct1m, limitCpus, pctOfLimit, throttledPct5m, nrPeriods, nrThrottled, throttledUsec }
GateFigures   = { label: "worker", slotsInUse, slots, perCluster, perJump, backgroundReserve,
                  classes: [{class, running, waiting, granted5m, waitP95Ms, overloaded5m, queueTimeout5m, overloaded1h, queueTimeout1h}],
                  clusters: [{cluster, running, waiting, sent5m, upstreamP95Ms, timeouts5m, rejected5m}] }
JobLine       = { id, kind, clusterId, clusterName, by, status, createdAt, startedAt, progress: {done, total},
                  day, partitions: {done, total}, pages, rows, concurrency, halvings, lastReason }
CollectionLine = { clusterId, kind: "volume"|"hosts", progress: {done, total}, concurrency }
```

How the worker fills it, with the core's own functions so a figure means the same on both sides:
a `health::SelfMonitor` read once a minute (`read`, `sample`, `push`, persisted with
`Ring::save(data, "worker")`) gives `memory`/`cpu` through `figures()`; `health::gate_figures("worker",
&gate, &records, ring.refusals_within(now, 3_600_000), None)` gives `gate`; `health::job_line` of each
running job gives `jobs`. A heartbeat 30 s old is amber, 90 s red; a `version` other than the core's
is red.
