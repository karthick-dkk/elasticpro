# The report worker (0.3.54)

Developer contract for running ElasticPro's batch work in its own container, so that a report
— however large, however it fails — can never slow down or take down monitoring. Decided by
the user 2026-11-04 ("In 0.3.54 now"). Read with docs/REPORT-TYPES.md ("Isolation and
failure": the in-process protections the worker also runs under).

## One image, two roles

`ELASTICPRO_ROLE` picks what the bridge binary starts:

| Role | Starts | HTTP |
|---|---|---|
| `core` | UI and message API, fleet poller, alerts, Play, delay sink, history store, housekeeping, Zabbix sync/push, request reaper | public (behind nginx), as today |
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
- `.env.example` and deploy/README.md document the two limits and the role; `deploy/upgrade`
  paths handle a stack whose compose file predates the worker (it runs `all` until the new
  compose file is in place).
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
