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
cp config.txt.example config.txt           # the settings file (see "Settings: config.txt");
                                           # it must exist before `docker compose up`

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

**First sign-in.** A fresh install has one account, **`Admin`**, password **`elastic`** — the
same on every install, like Zabbix's own `Admin`/`zabbix`. Change it on the Accounts page
whenever you choose (at least 10 characters); until you do, anyone who reaches the sign-in page
has the account, and the core says so in its log on every start. To start with a password of
your own instead, put it in a file, mount it into the core and point
`ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE` at it before the first start — a file, never the password
in an environment variable; the 10-character minimum applies, and a file that is too short is
refused (the shipped password is used instead and the log says why). An install that already
has accounts is not changed by any of this: it keeps the accounts it has, whatever they are
called. To go back to `Admin`/`elastic` on such an install, stop the core, remove `users.json`
from the `core-data` volume and start it again — every account goes with it.
Jump-host key paths in the config should be `/app/ssh/<file>`.

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

To a published release (no build on this host):

```bash
deploy/deploy.sh --upgrade            # the latest release
deploy/deploy.sh --upgrade=0.3.16     # one particular release (v0.3.16 works too)
deploy/deploy.sh --rollback           # back to the images that ran before
```

`--upgrade` moves all four images together (core, nginx, PostgreSQL, and Redis when the cache
profile is on) by setting `ELASTICPRO_IMAGE`, `ELASTICPRO_NGINX_IMAGE`, `ELASTICPRO_DB_IMAGE` and
`ELASTICPRO_REDIS_IMAGE` in `.env`. It pulls everything first, so a version that is not published
changes nothing. If the core is not healthy in time it puts the previous `.env` back and restarts
on it. Going to an older version needs `--force`. `--dry-run` shows the plan. The images come from
`karthickdk02/` unless `ELASTICPRO_REGISTRY` names another namespace.

From this checkout instead (builds the core here):

```bash
git pull && docker compose up -d --build
```

Trust decisions (`pins.json`) live in the `core-data` volume and survive rebuilds.

## Settings: config.txt

One file holds the settings of a hosted install: `deploy/config.txt` (on a server,
`/opt/elasticpro/deploy/config.txt`). `config.txt.example` is the template and the list of
every key, with what it means; `deploy.sh` and `install.sh` copy it to `config.txt` when it is
missing, so a new install starts with every key empty.

The rules:

- `KEY=VALUE`, one per line; lines starting with `#` are comments; no quotes. Lists are
  comma-separated (`10.0.0.0/8,192.168.1.5`).
- **Empty (or commented out) = not managed**: the default, or the Config page, decides.
- **A value = managed, and it wins.** The Config page shows the setting as "managed by
  config.txt" and cannot change it.
- **No secrets and no clusters.** Passwords, tokens and the Zabbix sign-in secret stay in
  `deploy/secrets/` or on the Config page (encrypted); clusters and their credentials stay on
  the Config page.

The keys cover the port (`LISTEN_PORT`), who may open ElasticPro (`ALLOWED_UI_IPS`,
`ALLOWED_DOMAINS`), rate limits (`RATE_EXEMPT_IPS`, `ZABBIX_ALLOWED_SOURCES`,
`TRUSTED_PROXIES`), the Zabbix link, logging, performance (`CORE_MEM_LIMIT`, `POLL_*`,
`CACHE_MB`) and the `UI_*` defaults every cluster starts from.

After editing it:

```bash
deploy/deploy.sh --apply-config            # --dry-run shows what it would do
```

It checks the file first and prints **every** problem it finds (unknown keys are warned about
and ignored); with any error nothing is changed. Then:

| Key | Where it goes |
|---|---|
| `LISTEN_PORT` | `.env` `LISTEN`; a changed port recreates nginx |
| `CORE_MEM_LIMIT` | `.env` `ELASTICPRO_MEM_LIMIT` (removed when empty: back to 1g) |
| `ALLOWED_UI_IPS` | `nginx/allow-ui/config-txt.conf`; everyone else gets 403 |
| `ALLOWED_DOMAINS` | `nginx/allow-host/config-txt.conf`; any other name gets 421 |
| `RATE_EXEMPT_IPS` | `nginx/rate-exempt/config-txt.conf` |
| everything else | read by the core itself from `config.txt`, mounted at `/app/config.txt` |

An empty list removes its generated file. nginx is checked (`nginx -t`, in the running
container) and reloaded; a list nginx rejects puts the previous files back and stops. Then the
core is recreated, because it reads `config.txt` at start, and `--apply-config` waits for its
health check. Sessions survive restarts: nobody is signed out. The Zabbix sign-in and pairing
routes are never subject to `ALLOWED_UI_IPS` or `ALLOWED_DOMAINS` (`ZABBIX_ALLOWED_SOURCES`
guards those).

A normal `deploy.sh` and `deploy.sh --upgrade` apply the file too, at their start, so it is
always in force; they restart the core anyway. `config.txt` is also created from the example
on a host that has none yet, with the port and memory limit already in `.env` copied in, so
adopting it changes nothing until you edit it.

Notes:

- **`config.txt` must exist before any `docker compose up`.** It is bind-mounted into the core;
  Docker answers a missing source by creating a *directory* there. `deploy.sh`, `install.sh`
  and `trial-setup.sh` always create it first (and clear away an empty directory Docker left);
  if you run compose by hand on a fresh checkout, `cp config.txt.example config.txt` first. The
  core treats a missing file or a directory as "no settings".
- The generated files start with `# generated from config.txt by deploy.sh — edit config.txt,
  not this`. Other files in `nginx/rate-exempt/` are yours and stay.
- A file mount follows the inode. An editor that replaces `config.txt` is only seen by the
  core after it is recreated, which is what `--apply-config` does.

## Rate limits and the whitelist

The limits are flood guards only, set far above what people use:

| Route | Limit (per client address) |
|---|---|
| `/bridge` (every page) | 500 requests/s, burst 2000 |
| `/events` (live updates) | 200 open streams |
| `/sso/zabbix` (sign-in from Zabbix) | 600/min in nginx, 600/min in the core |
| `/zabbix/pair` (pairing, once) | 10/min |

To take an address out of every nginx limit, for example the Zabbix server, or your office
or VPN range that people open the UI from, list it in `config.txt` and apply it:

```
RATE_EXEMPT_IPS=192.0.2.10,10.20.0.0/16   # the Zabbix frontend, the office / VPN range
ZABBIX_ALLOWED_SOURCES=192.0.2.10         # who may sign people in; never rate limited either
TRUSTED_PROXIES=172.19.0.0/16             # the nginx container's network
```

then `deploy/deploy.sh --apply-config`. `RATE_EXEMPT_IPS` is rendered into
`nginx/rate-exempt/config-txt.conf`. Files you wrote by hand in `nginx/rate-exempt/` (one
`<address or CIDR> 1;` per line) still work; both are read.

The core's own sign-in budget skips every address named in the Zabbix link's
**allowedSources** (Administration → ElasticPro in Zabbix, Config → Zabbix here, or
`ZABBIX_ALLOWED_SOURCES`). Listing the Zabbix frontend there both restricts who may sign
people in and removes its budget.

`TRUSTED_PROXIES` is the address of nginx, so the core believes nginx's `X-Real-IP`, and
nobody else's: that is the address both checks above see. Set it; without it the source
addresses in the activity log can be forged by anyone who reaches the core directly.

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
