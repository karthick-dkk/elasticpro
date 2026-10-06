# Hosted deployment — plan

ElasticPro today is a desktop app: the Rust core runs on the operator's machine, holds
the credentials, opens the SSH tunnels, and enforces the read-only guard. A hosted version
puts that same core on a Linux server and serves the UI to browsers.

This document is the plan for doing that. It is written before the work, so the decisions
that need making are made on purpose rather than by default.

## The one fact that shapes everything

The core's HTTP mode (`elasticpro-bridge`) has **no authentication of any kind**. Its single
endpoint, `POST /bridge`, is the entire message API: it reads the config file, uses the
credentials the process holds, flips the write unlock, and deletes indices. It binds to
loopback only, and its own header says *not for production use* — both deliberately.

Hosting it means putting an Elasticsearch administration tool, with stored cluster
credentials, on a network. **Authentication is therefore not a phase-2 feature; it is the
precondition for phase 1.** Nothing below is deployed without it.

## Architecture

```
browser ──TLS──▶ nginx ──▶ elasticpro-bridge (Rust core) ──▶ Elasticsearch clusters
                  │             │                          └─ via SSH jump hosts, as today
                  │             └──▶ PostgreSQL: users, roles, acks & notes, audit log
                  └── auth gate (see decision 1)
```

Three containers, one compose file, one exposed port (443).

| Container | Role | Exposed |
|---|---|---|
| `nginx` | TLS termination, static UI, reverse proxy to the core, the auth gate | 443 |
| `core` | `elasticpro-bridge` — the existing Rust core with a `--bind` flag and an auth header check | compose network only |
| `db` | PostgreSQL 16 | compose network only |

Logs: every container writes to stdout, so `docker compose logs -f` and any collector
(Filebeat, Promtail, Fluent Bit) sees them. The core additionally emits an **audit line
for every write** — who, when, which cluster, which request — as structured JSON, because
that is the record that answers "who deleted that index".

## What has to change in the code

Small, contained, and each with a test:

1. **`--bind` flag on `elasticpro-bridge`.** Today it binds `127.0.0.1` unconditionally. In a
   container it must bind the compose network. Default stays loopback; the flag is explicit.
2. **An identity on every request.** nginx authenticates and forwards a trusted header
   (`X-Auth-User`); the core refuses any request without it and records it on every audit
   line. The core never sees a password.
3. **Acknowledgements and notes move from IndexedDB to PostgreSQL.** In the desktop app
   they are per-browser, which is fine for one operator. Hosted, two people must see the
   same notes.
4. **Audit log.** One structured line per write, to stdout and to the `audit` table.
5. **Config from the environment.** The cluster config is mounted read-only; secrets stay
   sealed with the master password, which is supplied once at container start.

Everything else — the guard, the pinning, the tunnels, every page — is unchanged. That is
the point of the core owning all of it: the UI does not know or care where the core runs.

## Decisions needed before deploying

### 1. How do people log in? *(blocking)*

| Option | Phase 1 effort | Fits the roadmap |
|---|---|---|
| **a. nginx basic auth** (htpasswd file) | hours | Adequate to start; replaced later, not built on |
| **b. OIDC via nginx** (`oauth2-proxy` against an IdP) | a day | Gives SSO now and a clean seam for RBAC |
| **c. JumpServer / PAM** in front | depends on the PAM product | A common end state, but the integration path has to be confirmed per product |

**Recommendation: (b), with (a) as the fallback where there is no IdP to point at yet.** Both
put identity in a header the core trusts; moving from one to the other later does not touch
the core. (c) can sit *behind* (b) rather than replace it.

### 2. Who can reach it?

The compose file exposes 443 only. Whether that is on a management VLAN, behind a VPN, or
on the jump server itself is a network decision, not a container one — but it changes how
much (1) has to carry.

### 3. Where does the master password come from?

The config file's secrets are sealed. The container needs the master password once at
start: a Docker secret, an environment variable, or an interactive prompt on
`docker compose up`. A secret file is the recommended default.

## Phases

**Phase 1 — hosted, single role.** Everything in *what has to change*, decision 1 in place,
compose file, nginx with TLS, Postgres. Every authenticated user has the same rights the
desktop operator has today. **This is what "deploy it" means at first.**

**Phase 2 — RBAC.** Roles in Postgres (`viewer`, `operator`, `admin`), the write unlock
becomes a permission rather than a toggle, and the guard consults the role. This is where
"user only can do actions" becomes "these users can do these actions".

It also closes the one real gap in phase 1: the write unlock is a single switch in the core
process, shared by every signed-in user. Audit already records *who* sent each write, so
the trail is correct; what is missing is refusing the write for a user who should not be
allowed it. In phase 2 the guard takes the identity from the request and the role from
Postgres, and the switch goes away.

**Phase 3 — the roadmap items**, each of which has a natural home:

| Item | Where it lands |
|---|---|
| **Log delay per device** | The `src_hostname` aggregation already exists; add "latest `@timestamp` per value" and alert when it lags `now` by more than a threshold. Small. |
| **Zabbix dashboard** | Expose the alerts and the volume report as a JSON endpoint on the core (`GET /api/alerts`, `GET /api/volume`); Zabbix polls it with an HTTP agent item. No push agent needed. |
| **PAM authentication** | Replaces the auth gate in nginx (decision 1). The core does not change. |
| **JumpServer for credentials** | The core fetches cluster credentials from JumpServer at prime time instead of the sealed config. A new credential source alongside file and OS vault. |
| **RBAC** | Phase 2. |

## What stays the same everywhere

The desktop builds keep working exactly as they do. The hosted core is the same crate with
two flags; the UI is the same files. A feature added to one is in the other. The only thing
that differs is where the credentials and the audit trail live — on the operator's disk for
the desktop, in Postgres for the server — and the UI already asks the core rather than
assuming.

## Not in scope, and why

- **Running the core on every jump server as a web service.** It can, but each instance
  would need its own auth and TLS; one hosted instance reaching jump hosts over SSH, as the
  desktop already does, is the same reach with one front door.
- **Multi-tenancy.** One instance, one fleet, one set of users. Separate fleets get separate
  instances.

---

## Decided: metrics storage is hosted-only

Users will be able to choose where each metric type is stored, with the destination
set per metric type (log delay, volume, ULM, capacity).

The destination that exists today is the **Elasticsearch sink** `delay_sink.rs`
already writes to. A second destination is not decided, and nothing here depends
on adding a database engine to the core.

**This is offered on the Linux/hosted deployment only. Portable does not show it at
all.** Not disabled, not greyed out with an explanation: absent. A control that
cannot work is worse than a missing one, because it invites the operator to
configure something and then quietly does nothing with it.

### Why hosted only

It follows what already holds for the closest existing feature. `delay_sink.rs` is
hosted-only because a timer in a page ticks only while somebody has a tab open,
which on a server is nobody — so "every two hours" would be a promise the
implementation could not keep. Stored metrics have the same shape: a store that is
only written while a window happens to be open is a store nobody can trust to be
complete, and an incomplete metrics history is worse than none, because it looks
like an answer.

Hosted is also the edition that already has somewhere to put it, a scheduler to
fill it, and accounts to say who asked.

### How it is hidden

The same way API tokens already are (`accounts.js`): the core answers `WHOAMI`
with a capability flag, and the page renders the section only when the flag is
set. The UI does not infer the edition for itself — inferring it means two places
deciding what edition this is, and they drift.

`Edition::Portable` and `Edition::Installed` therefore report the capability as
false, and the core refuses the configure/write messages regardless of what any
client sends. The hidden UI is the courtesy; the refusal in the core is the
control.

### Still open

- What the second destination is, if there is one. The hosted deployment already
  runs postgres for `users`/`acks`/`notes`/`audit`, so it is the candidate that
  costs no new dependency — but that is an option, not a decision.
- Whether a write to a destination inside this process needs the double write-gate
  in `guard.rs`. That gate exists because writes leave the process and land on
  someone's cluster. Writing to the Elasticsearch sink plainly does; a local store
  would not, and applying the cluster gate to it would mean a read-only config
  cannot record its own measurements. Only relevant once a non-cluster destination
  exists.
- Retention, for whatever holds the data. It shares the problem with the Tier 2
  result cache, and one cap-and-prune policy should serve both rather than each
  inventing one.
