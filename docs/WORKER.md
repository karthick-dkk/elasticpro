# The report worker (0.3.54)

Developer contract for running ElasticPro's batch work in its own container, so that a report
— however large, however it fails — can never slow down or take down monitoring. Decided by
the user 2026-11-04 ("In 0.3.54 now"). Read with docs/REPORT-TYPES.md ("Isolation and
failure": the in-process protections the worker also runs under).

## One image, two roles

`ELASTICPRO_ROLE` picks what the bridge binary starts:

| Role | Starts | HTTP |
|---|---|---|
| `core` | UI and message API, fleet poller, alerts, Play, delay sink, history store, housekeeping, the daily settings backup (`start_backup_timer`), Zabbix sync/push, request reaper | public (behind nginx), as today |
| `worker` | daily volume collection (`start_volume_daily`), the report timer and queue (`start_report_timer`: volume, indices, hosts schedules and jobs), the 06:00 host collection, report builds and mail | internal only, port 8766, not routed by nginx |
| `all` (default when unset) | everything, as before 0.3.54 | public |

`all` keeps a stack without the new service working exactly as today. The shipped compose
file runs `core` + `worker`.

## Who owns what (one writer per file)

| File under `<data>/` | Writer | Reader |
|---|---|---|
| `volume/<cluster>/…` month files, `state.json`, `hosts/<day>.json.gz` | worker | core (pages, `HOSTS_QUERY`, history store) |
| `reports/jobs.json`, `reports/<file>` | worker | core (`REPORT_LIST`, `REPORT_DOWNLOAD`) |
| `report-schedule.json` (settings) | core (`REPORT_SCHEDULE_SET`) | worker, reloaded when its mtime changes |
| `report-schedule-state.json` (last sent, last period, retries — moved out of the settings file; the old fields are read once and migrated) | worker | core (shown in Exports) |
| `mail.json` | core | worker |
| `policy.json` (emergency stop) | core | worker, checked before every request and every page |
| `worker/status.json` (role, version, started, current jobs, last heartbeat) | worker, every 10 s | core |
| `worker/requests.jsonl` (bounded ring, 5000 lines) | worker | core (Request Centre merges it, labelled *worker*) |
| `job-runs/worker.json` (the worker's jobs' runs), `job-runs/hosts-tries.json` (the hosts collection's tries today) | worker | core (`JOBS_LIST`, docs/JOBS.md) |
| `job-runs/core.json` (the core's jobs' runs) | core | — (role `all` writes both run files) |

All writes are atomic (temp + rename), as `volume::store::write_atomic`. Readers tolerate a
file that is mid-rename by retrying once.

## Core → worker

- Actions go over internal HTTP to `http://worker:8766`, authenticated with a shared secret
  the first container to start writes to `<data>/worker/token` (0600, random 32 bytes; the
  other reads it). Endpoints: `POST /run` (REPORT_RUN, VOLUME_RUN, hosts Run now — the core
  checks permissions, visibility and the per-person/mail/5-cluster limits first and passes
  `by`), `POST /send-now`, `POST /stop` (a job), `GET /health`.
- Reads never go to the worker: the core reads the files above.
- **Worker down or unreachable**: the core answers `worker_unavailable` ("the report worker is
  not running — reports and collection resume when it is back"); Exports and Reports show it in
  amber with the last heartbeat. Monitoring is untouched. Scheduled work is not lost: the
  worker's existing restart rules (jobs.json, a period given back, checkpoints) pick it up.
- **Version check**: a worker whose version differs from the core's refuses `/run`
  (`worker_version`), and both show it, so a half-upgraded stack never mixes record formats.

## Requests to Elasticsearch from the worker

- Its own gate instance, every request `Background`, caps: overall 16, per cluster 4, per
  jump host 4 (`ELASTICPRO_WORKER_GATE_*`). How many of a cluster's 4 slots a report really
  uses is decided by the adaptive controller (docs/REPORT-TYPES.md, "Concurrency"): it starts
  at 2, grows while the cluster answers quickly and halves the moment it pushes back. The
  core's own gate, and so every person's click and the health poll, is not shared with it.
- Clusters, credentials (cluster-secrets, vault) and SSH keys come from the same mounts as the
  core, read-only except the data volume. The worker opens its own SSH tunnels.
- The emergency stop holds it like the core's own jobs (read from `policy.json`).

## Deploy

- `deploy/docker-compose.yml`: service `worker`, same image, `ELASTICPRO_ROLE=worker`,
  `mem_limit: ${ELASTICPRO_WORKER_MEM_LIMIT:-1g}`, `cpus: ${ELASTICPRO_WORKER_CPUS:-1.0}`,
  `restart: unless-stopped`, same `core-data`, `config`, `config.txt`, `ssh`, secrets mounts,
  `TZ`, network `internal`, healthcheck on `/health`. Core gets `ELASTICPRO_ROLE=core`.
- `.env.example` and deploy/README.md document the two limits and the role; `deploy.sh
  --upgrade` brings a stack whose compose file predates the worker to the new file (it runs `all`
  until the new compose file is in place — "As built", Deploy).
- The VM is upgraded without asking after release; production (0.3.21) needs an ask, and its
  `.env` must keep `TZ=Asia/Kolkata`.

## Tests

- Unit: role parsing and what each role starts; schedule-state migration; token creation race
  (both start at once); status heartbeat staleness; `worker_unavailable` and `worker_version`
  replies.
- `deploy/trial.sh` (on the VM): worker up and healthy; core never starts the report timer in
  role `core`; **kill the worker during a hosts collection → the UI's PING and an ES read keep
  answering within their normal time, the job resumes from its checkpoint when the worker is
  back, and the file names any cluster that failed**; the worker cannot be reached through
  nginx; the four existing security properties still hold.
- Measure on the VM during the 06:00 run: core RSS and p95 message latency with and without the
  run, worker RSS peak; figures in the PR.

## As built (0.3.54)

Where the code is: `crates/elasticpro-core/src/worker.rs` (the role and what it starts, the
token, the worker's gate caps, the wire types, the replies, the requests ring — pure, tested),
`src/bridge/worker_api.rs` (forwarding, the worker's API, its heartbeat and reloads),
`src/bin/bridge.rs` (which timers and which listener a role starts), `src/report/schedule.rs`
(`ScheduleState`, `merge`), `tests/worker.rs` and `tools/hosted-check.sh` ("the report worker").

Decisions made while building, within the contract:

- **What each role starts** is one table, `worker::starts(role)`, read by the bridge binary and
  tested. Beyond the contract's table: the worker also restores the cluster setup
  (`primed.json`) and runs the Zabbix sync on its interval — read-only (`createHosts` is forced
  off in the worker) — because it needs the clusters and their credentials; it never writes
  `primed.json` or `cluster-secrets.json`. It starts no poller, no health minute task, no
  reaper, no delay sink, no history store, no Zabbix push and no UI.
- **The worker keeps no accounts**: no `users.json`, sessions or tokens, no activity log, and it
  never seeds the first account; its own instance file is `instance-worker.json`.
- **Endpoints**: `POST /run` (`REPORT_RUN`, `VOLUME_RUN`), `/send-now` (`REPORT_SEND_NOW`),
  `/stop` (`REPORT_STOP`) and, beyond the contract, `/queue` (`REPORT_CLEAR`,
  `REPORT_CONCURRENCY_SET` — they write `jobs.json`, which is the worker's alone); `GET /health`
  (`{ok, role, version, startedAt, running, queued}`, no token, for the compose healthcheck). A
  body is `{type, msg, caller: {name, role, scope}}`; headers `x-elasticpro-worker-token` and
  `x-elasticpro-version`. Wrong token → 401; another version → 409 `worker_version` (EP-219).
  The worker then handles the message exactly as role `all` would, as the caller the core
  vouched for (its name on the job, its clusters).
- **The core's own checks before forwarding** (`report_precheck`): `REPORT_RUN` — kind, cluster
  list, the 5-cluster limit, the per-person and mail limits against the `jobs.json` snapshot;
  `REPORT_STOP` — the job exists; `REPORT_CONCURRENCY_SET` — 3..5; `REPORT_SEND_NOW` —
  recipients and mail configured. The gate's role and cluster checks run first, as always. The
  worker checks all of it again against the live queue.
- **Unreachable** (connection refused, timeout of 15 s, a 401 because the two do not share the
  volume): `worker_unavailable` (EP-218) with `lastHeartbeatAt` from `worker/status.json`.
- **Down, answered at once** (0.3.54 VM findings): with the worker container stopped, each
  forwarded action took about 3 s — Docker's DNS is slow to fail a stopped container's name — and
  those times turned the Core chip red in health with a fix about ES_CONCURRENCY. Now:
  - a worker whose heartbeat is late (`health::heartbeat_late`: `HEARTBEAT_AMBER_SECS`, 30 s, the
    line the health check turns amber at — one constant for both) is not asked: `worker_unavailable`
    comes back at once, `detail` "no heartbeat for …: the worker was not asked". A missing status
    file (never started) is still tried;
  - the forward's connect, name lookup included, gives up after `worker::CONNECT_TIMEOUT_MS`
    (1 s), so the first 30 s after a kill cost a second an action at most;
  - every forwarded type (`worker::endpoint`) waits elsewhere (`health::waits_elsewhere`): its time
    is in the per-type table but never in the core's own message p95. During a worker kill only
    the worker's check turns red (docs/HEALTH.md).
- **The token** is made with `worker::create_once`: written to a temporary file of the process's
  own (0600, synced) and hard-linked into place, so of two containers starting at once one wins
  and both read it. The cluster-secrets key file beside it is now made the same way.
- **Schedule state**: `report-schedule-state.json` = `{volume, indices, hosts}` each `{lastSent,
  lastPeriod, retriedPeriod, retried, seenSchedule, seenAt, appliedSetAt}`. Every decision reads
  `schedule::merge(settings, state)`. A save (`REPORT_SCHEDULE_SET`, the core) no longer writes
  `lastPeriod`: it writes its decision as `markPassed` with `setAt`, and the state takes it in
  once (`appliedSetAt`). Migration: while no state file exists the settings' old fields are the
  state; the worker's first tick writes the state file; the core strips the old fields from the
  settings on its next save, and only once the state file exists (so a save made before the
  worker ever ran loses nothing).
- **Reloads**: the schedules, `mail.json`, config.txt-driven settings and the cluster config are
  read from disk wherever they are used, so they are always current. `primed.json`, `pins.json`,
  `cluster-secrets.json` and the Zabbix link are checked every 30 s by modification time and
  reloaded (re-prime, re-sync). `policy.json` is checked (one `stat`) inside `volume_stopped`,
  i.e. before every collection request and page.
- **Reads in role core**: `REPORT_JOBS`, `REPORT_DOWNLOAD`, the health tab and the volume
  pages' "running" read `jobs.json` / `worker/status.json` (`Reports::snapshot`, read again once
  if mid-rename). `Reports::open` in role core marks nothing and never writes `jobs.json`. While a
  job runs, the worker writes `jobs.json` every 2 s (otherwise only when a job starts or ends), so
  the progress Exports reads from it is at most 2 s old — found on the first local Docker trial,
  where the core showed a running job with no pages until it ended.
- **Gate**: the worker's `Gate` is built from `worker::worker_limits` (16 / 4 / 4, reserve 0) over
  the core's other limits. The report controller's ceiling is `concurrency_for(per_cluster,
  role)`: the whole per-cluster cap in role `worker`, one under in role `all`.
- **Heartbeat** (every 10 s, `worker_heartbeat`): `WorkerStatus` with memory/CPU from the
  worker's `SelfMonitor` (read once a minute, ring `health/worker.json` every 10 samples), the
  worker's `gate_figures("worker", …)`, `job_line` of each running job, the queued count and the
  collections (daily volume runs with their progress; hosts collections by cluster — their
  concurrency is in the job lines). `worker/requests.jsonl` is rewritten (temp + rename) when it
  changed: the newest 5000 finished requests, each with `process: "worker"`; the core merges
  them into `REQUEST_LOG`'s `recent` by start time, held to the caller's clusters.
- **What the worker does not know**: it runs no poller, so it does not see a cluster as down or
  red from the poller's cache — the daily volume run does not skip an unreachable cluster up
  front (the collector fails it and says so), and the "red goes to the end of the job" rule of
  REPORT-TYPES.md does not fire in the worker. Everything else of "Isolation and failure"
  applies unchanged.
- **Deploy**: compose service `worker` as the contract says, plus the same `build:` as the core
  (one tag, so `up --build` never tries to pull a locally built image) and a healthcheck on
  `:8766/health` (the image's own checks the core's port). `deploy.sh` restarts and rolls back
  `core worker` together wherever it moved only the core (`app_services`), and reports the
  worker's health after the core's without rolling back for it. A compose file without the
  worker leaves the core in role `all`.
- **Upgrade to the core + worker layout** (0.3.54 VM findings: `--upgrade` used to move only the
  images, so an install upgraded that way stayed in role `all` for good): when the installed
  `docker-compose.yml` has no `worker` service and the target release's has one, `deploy.sh
  --upgrade` fetches that release's file (`ELASTICPRO_RELEASE_URL`, default the repository's raw
  files) and puts it in place — only when the installed file is byte for byte what the running
  release, the one before it, or the release its own image pins name (a `deploy.sh` from
  before 0.3.54 left the installed file behind across upgrades) shipped; otherwise it stops, nothing changed, and says how to
  carry the edits over (`docker-compose.override.yml`, then `--replace-compose`). The old file is
  kept as `docker-compose.yml.bak-<time>`, named in `.compose-previous`; `--rollback` and a failed
  upgrade put it back (`up -d --remove-orphans`); `--dry-run` prints the diff; `.env` and override
  files are never touched. deploy/README.md, "Upgrading to 0.3.54 or later: the compose file".
- **Measured locally** (Docker Desktop, arm64, image from this branch, `deploy/trial.sh` against
  `tools/mock-es.mjs` with `MOCK_LATENCY_MS=2000`; a hosts run over 7 days with collect-again, an
  indices run and a volume run at once): core RSS 10.5 MiB (`VmHWM`; cgroup figure 3.0 → 3.4 MiB
  during the run), client-side p95 through nginx 17.4 ms without a run and 22.7 ms during it (p50
  12.0 → 12.4 ms; the core's own message p95 stayed 1 ms); worker RSS peak 10.5 MiB (`VmHWM`). The
  mock is small: the figures that decide the limits are the test VM's against a real cluster
  during the 06:00 run (Tests, above).
