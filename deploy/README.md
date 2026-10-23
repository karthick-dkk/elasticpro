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
# (A trial install's certificate is made by trial-cert.sh with a subjectAltName for this host's names and
#  addresses. To make clients such as the Zabbix host trust it, copy tls/fullchain.pem there as
#  /usr/local/share/ca-certificates/elasticpro-trial.crt and run `sudo update-ca-certificates`.)

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

The Zabbix modules are not part of these images. They have their own version (shared by all the
modules, separate from ElasticPro's), pinned with the commit in `deploy/zabbix/MODULES_REF` and
shipped in the release as `elasticpro-zabbix-modules-<ver>.tar.gz`; see "Modules versioning" in
`deploy/zabbix/README.md`.

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
| `CORE_MEM_LIMIT` | `.env` `ELASTICPRO_MEM_LIMIT` (removed when empty: back to 2g) |
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

## Performance: how the core goes to Elasticsearch

Every request to a cluster — a page's, the console's, the poller's, the delay sink's —
waits at one gate before a socket is opened. The `performance` keys in `config.txt` set it
(each is documented in `config.txt.example`; the defaults suit 100-300 clusters):

| Key | Default | What it does |
|---|---|---|
| `ES_CONCURRENCY` | 24 | Requests open at once, every cluster and source together. |
| `ES_PER_CLUSTER` / `ES_PER_JUMP_HOST` | 4 / 8 | …to one cluster, and through one SSH jump host. |
| `ES_BACKGROUND_RESERVE` | 2 | Of those, connections only background work may use, so a burst of page requests never stops the health poll. |
| `ES_QUEUE_MAX` / `ES_QUEUE_PER_USER` | 256 / 64 | Page requests that may wait for a connection, everybody / one person. Past either: refused at once, `EP-214`, with a time to retry (the page retries a read once by itself). The poller and the core's own jobs are never refused. |
| `ES_QUEUE_WAIT_MS` | 20000 | The longest a page request waits for a connection: `EP-215` after it. |
| `ES_MAX_TIMEOUT_MS` | 115000 | No request is given longer than this, whatever it asks for (nginx gives up at 120 s). |
| `ES_READ_CACHE_SECONDS` / `ES_READ_CACHE_MB` | 5 / 64 | A page read answered from memory when somebody asked the same moments ago; Refresh always asks the cluster, and any write empties what is kept for that cluster. |
| `ES_MAX_RESPONSE_MB` / `ES_MAX_FLEET_RESPONSE_MB` | 64 / 256 | The largest answer a page's request / the poller's dataset may bring back: `EP-216` past it, read no further. |
| `ES_TASK_REAPER` / `ES_TASK_MAX_SECONDS` | `orphans` / 300 | Cancel our own searches nobody waits for any more (a page left, a timeout) — only read tasks carrying ElasticPro's `X-Opaque-Id`, never a write, never anyone else's. `overdue` also cancels ours running past the limit; `off` turns it off. |
| `ZABBIX_CONCURRENCY` | 4 | Zabbix API calls open at once. |

Priority is strict: a person's request goes before the poller's work somebody is waiting
for, which goes before everything else; within each, clusters take turns. Anything that
waited long enough moves up, so nothing is starved. Requests that ask the same thing at the
same moment share one trip to the cluster. The poller's own share (Config → Requests) can
never exceed the gate's numbers.

The Request Centre shows the gate: what is queued, the 95th-percentile wait of people's
requests, what was refused in the last five minutes and what was answered without going to
the cluster; each request row says its class, how long it queued, and whether it was shared
or cached. `tools/load-check.mjs` runs the gate against a mock fleet under load and checks
every one of these limits held.

## The request figures in Zabbix (`ZABBIX_METRICS_HOST`)

The core can push what the Request Centre shows to Zabbix once a minute, so the gate is
alerted on like everything else. The figures are the gate's in-flight and queued requests per
class, the 95th-percentile wait, requests turned away by reason, answers shared, cached or over
the response cap, requests per minute, the poller's mode and pause, the memory budgets in use,
and the version. It is **off** until you name a host.

What is sent: one JSON value a minute, to the trapper item `elasticpro.gate.raw` on the host
you name. Every count covers that minute alone. **Aggregates only**: no cluster name, address
or URL is ever in it, because the people who can read that Zabbix host need not be the people
who may see every cluster. The template **ElasticPro request gate by Zabbix trapper** (in the
Zabbix modules repository, `zabbix/templates/template-elasticpro-request-gate.yaml`) splits the
value into items. It alerts when the figures stop arriving, on sustained queueing, on refusals,
on long waits, on a pause left on and on in-flight memory, with every threshold in a macro.

How: `history.push` (Zabbix 7.0 or later) over the Zabbix API connection the core already has,
whether paired from Config → Zabbix or set by `ZABBIX_API_URL` and a token file. It is signed
with that connection's token too. It uses that
connection's address and TLS trust, so there is no new endpoint and no `zabbix_sender`. Each push
is limited to 20 s and shares `ZABBIX_CONCURRENCY` with the sync. A failure is logged at warn
("zabbix push failed", with Zabbix's reason) and the next try waits twice as long, up to
10 minutes. The push runs in a task of its own, reads the gate's figures the way the Request
Centre does, and never holds anything a request is waiting for.

This writes to **Zabbix**, never to Elasticsearch, so the "writes are gated twice" rule (which is
about clusters) does not apply. Naming the host is the opt-in.

### Setting it up

1. **Import the template** in Zabbix: *Data collection → Templates → Import*,
   `template-elasticpro-request-gate.yaml`.
2. **Create the host** the figures go to, for example `ElasticPro`, in a host group of its own
   (for example `ElasticPro self`). It needs no interface and no agent. Link the template.
3. **Let the paired token push.** `history.push` needs the token's user role to allow that API
   method, and the user to see the host.
   - **Normal path: the identity pairing made** (user `elasticpro-sync`, role *ElasticPro sync*).
     From Zabbix modules 2.1.2 on, the role allows `history.push` (`embed-module/sync-role.json`).
     An install paired earlier needs one of two things done once: re-pair (Config → Zabbix → Pair
     with Zabbix; pairing updates a role whose methods differ from the file), or add `history.push`
     to *Users → User roles → ElasticPro sync → API methods* by hand. Until then the push is refused
     with `No permissions to call "history.push"`, and the Request Centre's Zabbix line says so.

     **What this implies:** the role is of the Super admin type, so it sees every host. With
     `history.push`, ElasticPro's paired token can write a value into **any trapper item** in this
     Zabbix, not only this host's. It still cannot create, change or delete any configuration.
   - **Hardening option: a token of its own.** To keep the paired identity read-only, remove
     `history.push` from the *ElasticPro sync* role. Then create a user role of type *User* that
     allows only `history.push` and no frontend. Create a user with that role, in a user group with
     read-write on the `ElasticPro self` host group and nothing else, make an API token for it, and
     give its file to the core as `ELASTICPRO_ZABBIX_METRICS_TOKEN_FILE`, a server-only file like
     the other Zabbix tokens. For example, in a compose override:

     ```yaml
     services:
       core:
         environment:
           ELASTICPRO_ZABBIX_METRICS_TOKEN_FILE: /run/secrets/zabbix_metrics_token
         secrets: [zabbix_metrics_token]
     secrets:
       zabbix_metrics_token:
         file: ./secrets/zabbix_metrics_token
     ```

     When that is set, the core signs the pushes with this token instead of the paired one. It
     still uses the link's address and TLS trust, and reads the file before every push, so a
     rotated file is picked up without a restart. A named file that is empty or unreadable stops
     the push and says why; it never falls back to the paired token.
   - Leave the item's *Allowed hosts* empty. If you fill it, it must list the ElasticPro
     core's address as the Zabbix frontend sees it, because `history.push` is checked against
     the API caller's address.
4. **Name the host** in `config.txt` (its technical name, exactly) and apply:

   ```
   ZABBIX_METRICS_HOST=ElasticPro
   ```

   ```bash
   deploy/deploy.sh --apply-config
   ```

5. **Check it.** The Request Centre shows a *Zabbix* line under the limits: when the last push
   landed, how many were sent and failed, or why nothing is being pushed. Within a minute or
   two the host's *Latest data* fills in. In the core log, `zabbix push: request figures go to
   Zabbix` means the push started, and `zabbix push failed` gives Zabbix's own reason when one
   fails.

Template macros worth setting per site (host-level overrides): `{$ELASTICPRO.GATE.NODATA}`
(5m), `{$ELASTICPRO.GATE.WINDOW}` (10m), `{$ELASTICPRO.GATE.QUEUED.WARN/CRIT}` (1 / 20),
`{$ELASTICPRO.GATE.REFUSED.WARN/CRIT}` (5 / 50 in the window), `{$ELASTICPRO.GATE.WAIT.P95.WARN/CRIT}`
(5 / 15 s; `ES_QUEUE_WAIT_MS` is 20 s by default), `{$ELASTICPRO.GATE.PAUSED.MAX}` (30m).

## Scaling to a large fleet (100-300 clusters)

A new install runs the **Client basis** request policy: the core goes to a cluster only when a page
asks (one request per cluster at a time, four in all), so nothing is fetched while nobody looks.
To keep the fleet fresh in the background instead — rather than only when a page is open — choose
Config → Requests → Automatic or Background (a policy saved there is kept across upgrades).
In the background modes the core's own knobs apply —
`ELASTICPRO_POLL_HEALTH_SECS` (default 180), `ELASTICPRO_POLL_CONCURRENCY` (default 16 for the
Automatic and Background presets, 4 under Client basis; global across every cluster, and it wins
over either default when set) and `ELASTICPRO_CACHE_MB` (default: a quarter of the core's memory limit — 512 at the shipped
2g — the budget every cached body counts against) in `.env` control how hard that runs. The defaults are sized for 100-300 clusters
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
