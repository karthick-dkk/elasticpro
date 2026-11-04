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
