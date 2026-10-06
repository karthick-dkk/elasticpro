# Hosted ElasticPro — phase 1

The same Rust core and the same UI as the desktop app, on a Linux server, in three
containers, with **one exposed port (443)** and an authentication gate in front. The plan
and the decisions behind it are in [docs/HOSTED-DEPLOYMENT-PLAN.md](../docs/HOSTED-DEPLOYMENT-PLAN.md).
Rolling out the Zabbix side (Cluster Management, jump hosts, DL alerts and reports) to
production: [PRODUCTION.md](PRODUCTION.md).

```
browser ──TLS──▶ nginx (auth gate) ──▶ core (elasticpro-bridge) ──▶ your clusters / jump hosts
                                        └──▶ postgres
```

## Before you start — read this

The core trusts an `X-Auth-User` header that nginx sets **after** authenticating. That is
what makes the whole thing safe, and it only holds while the core is reachable through
nginx and nothing else. Two consequences:

- **Never publish port 8765.** The compose file does not. Do not add it.
- **Do not run the core with `ELASTICPRO_BIND=0.0.0.0` outside this compose setup.** Without the
  proxy it is an open Elasticsearch console holding your credentials.

## Install (Linux, Docker Compose v2)

```bash
cd deploy

# 1. Settings
cp .env.example .env                       # LISTEN port, where the SSH keys are

# 2. TLS — a real certificate, or a self-signed one to start:
mkdir -p tls && openssl req -x509 -newkey rsa:4096 -nodes -days 825 \
  -keyout tls/privkey.pem -out tls/fullchain.pem -subj "/CN=elasticpro.internal"

# 3. Who may log in (phase-1 gate: HTTP basic). One line per person.
./make-htpasswd.sh alice
./make-htpasswd.sh bob

# 4. Database password
mkdir -p secrets && openssl rand -base64 32 > secrets/db_password

# 5. The cluster config — the same config_cluster.json the desktop app writes,
#    secrets sealed with the master password. Copy it in, and the SSH keys it names.
mkdir -p config ssh
cp /path/to/config_cluster.json config/
cp ~/.ssh/id_ed25519 ssh/                  # any keyFile the config refers to

# 6. Up
docker compose up -d --build
docker compose logs -f
```

Open `https://<server>/`, sign in, and pick `/app/config/config_cluster.json` when the app
asks for a config.

**First sign-in.** A fresh install has one account, `elasticpro`, with a password generated
for this install alone. Read it with either of:

```bash
docker compose exec core cat /app/data/initial-admin-password   # 0600, in the core-data volume
docker compose logs core | grep "created the first one"          # the same password, logged once
```

The app then makes you set a real password (at least 10 characters) before anything else
works, and deletes `initial-admin-password` as soon as you have. To choose the first password
yourself instead, put it in a file, mount it into the core and point
`ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE` at it before the first start — a file, never the password in
an environment variable; the same 10-character minimum applies, and a file that is too short is
refused (a random password is generated instead and the log says why). An install that already
has accounts is not changed by any of this. Jump-host key paths in the config should be `/app/ssh/<file>`.

## Logs — everything, in one place

Every container logs to stdout, so `docker compose logs -f [core|nginx|db]` shows it all
and any collector that reads Docker logs (Filebeat, Promtail, Fluent Bit) picks it up.

| Stream | What | Shape |
|---|---|---|
| `nginx` access | every request: user, IP, method, URI, status, timing | one JSON object per line |
| `core` | the core's own log — connections, tunnels, trust decisions | JSON (`RUST_LOG` controls level) |
| `core` **audit** | **every write, by whom**: user, message type, cluster, method, path, whether it succeeded | JSON, `target: "audit"` |

The audit stream is the one that answers "who deleted that index":

```bash
docker compose logs core | grep '"target":"audit"' | jq .
```

Reads are not audited — they are the overwhelming majority of traffic and carry nothing
worth recording. Anything that changes a cluster, a pin, the write unlock or the config is.

## Rotating the gate later

nginx's `auth_basic` block is the only part that knows how people log in. Replacing it
with `oauth2-proxy` for SSO, or with a PAM module, changes nothing in the core: it only
needs `X-Auth-User` to arrive from something it can trust.

## What phase 1 does not do yet

- **Roles.** Every authenticated user has the same rights as the desktop operator. RBAC is
  phase 2 and uses the `users.role` column the schema already has.
- **A per-user write unlock.** *Allow writes* is a switch inside the core process, and in
  phase 1 there is one core process for everyone — so once any signed-in user turns it on,
  writes are permitted for every user until it is turned off or the container restarts.
  Every write is still audited under the name of whoever sent it, so the record is right;
  the *permission* is just shared. Phase 2 makes the unlock a per-user, per-role decision.
  Until then, treat "who may sign in" as "who may write".
- **Notes in Postgres.** The `acks` and `notes` tables exist; the UI still keeps them in the
  browser. Wiring the UI to the database is next, and until then two people do not see each
  other's notes.
- **Zabbix.** A polling endpoint for alerts and the volume report is planned; see the plan.

## Trying it on one machine first

```bash
deploy/trial.sh          # nothing to set up first
```

It builds the image, makes throwaway credentials for anything missing (`trial-setup.sh`:
a self-signed certificate, one user `alice` / `test-password-1`, a random database
password — it never overwrites a file that is already there), brings the stack up and
proves the four things the deployment exists for: no credentials → 401 at nginx; valid
credentials → the UI and the bridge over TLS; a write appears in the core's audit log
under the signed-in user's name; and the core has no host port binding and is unreachable
from a container outside the compose network.

It aborts if any container failed to start — a port already taken is the usual reason.
Without that check the trial would test whatever else answers on that port, and an
unrelated web server returning 200 would be reported as "UI served over TLS".

This runs in CI on every push, so a broken Dockerfile or a hole in the auth gate is found
here rather than by whoever deploys next. Run it locally after any change to the compose
file or the nginx config.

Note that `docker compose ps` shows `8765/tcp` against the core. That is the image's
`EXPOSE` metadata — the port is open *inside* the compose network — not a host mapping;
a mapping would read `0.0.0.0:8765->8765/tcp`, as it does for nginx on 443.

## Updating

```bash
git pull && docker compose up -d --build
```

Trust decisions (`pins.json`) live in the `core-data` volume and survive rebuilds.

## Scaling to a large fleet (100-300 clusters)

The core polls every cluster in the background rather than only when a page is open —
`ELASTICPRO_POLL_HEALTH_SECS` (default 180), `ELASTICPRO_POLL_CONCURRENCY` (default 16, global across
every cluster) and `ELASTICPRO_CACHE_MB` (default 256, the in-memory on-demand cache's size
budget) in `.env` control how hard that runs. The defaults are sized for 100-300 clusters
on a small server; raise `ELASTICPRO_POLL_CONCURRENCY` if clusters sit behind slow links and
polls are falling behind, lower it if the host is CPU- or socket-constrained.

Every dataset the poller fetches is also written to disk at `$ELASTICPRO_DATA_DIR/cache/` (the
`core-data` volume), so a core restart comes back warm instead of re-polling the whole
fleet cold. **The core works fully with nothing else running** — Redis is an optional
second cache layer (`ELASTICPRO_REDIS_URL`, built by the `core` entrypoint from
`secrets/redis/redis_password` when that file exists), useful mainly if you ever run more
than the one supported core replica and want them to share a cache, or want the warm-up
after a restart to be instant rather than "as fast as the disk cache re-reads." It is off
by default. To turn it on:

```bash
mkdir -p secrets/redis
openssl rand -hex 32 > secrets/redis/redis_password   # hex: it goes into a redis:// URL
docker compose --profile cache up -d
```

`redis` runs on the internal network only, with no published port, `--maxmemory 512mb
--maxmemory-policy noeviction` (it is a cache, not a store of record — nothing is meant to
survive being evicted or lost) and no persistence (`--save "" --appendonly no`: the disk
cache is already the thing that survives a restart). If Redis is down or was never
started, the core logs it once a minute and carries on using the disk cache alone —
nothing in the app depends on it being up.
