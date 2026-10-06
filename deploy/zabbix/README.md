# Automation monitoring via Zabbix

New to this integration? [INTEGRATION.md](INTEGRATION.md) is the ordered, first-install
walk-through (architecture, sizing, every step in sequence); this file is the reference it
links into.

The automation rules only ever ran while someone had the Automation page open. That makes
a notification close to useless — it arrives when you have already found the problem
yourself. This wires the same rules to a schedule, and lets Zabbix pull the answer.

Two things made a push webhook the wrong tool here:

- **The UI cannot make outbound requests.** The desktop WebView's content policy is
  `connect-src ipc: http://ipc.localhost`, so `fetch()` to a webhook is blocked by policy,
  not by a bug. In hosted mode CORS blocks it anyway, since Slack, Teams and most
  receivers send no `Access-Control-Allow-Origin`.
- **Nothing was evaluating the rules unattended.** Even with delivery solved, a webhook
  would only have fired while you were watching the screen.

Pulling fixes both, and reuses alerting you already run.

## What produces the data

`tools/elasticpro-scrape.mjs` imports `ui/js/core/automation.js` directly rather than restating
any rules, so there is one definition of "safe to delete" and the scrape cannot drift from
what the page shows. It needs no browser: the core modules touch no DOM, so the only shim
is a base URL for the relative `/bridge` path the UI's transport posts to.

```bash
node tools/elasticpro-scrape.mjs --config clusters.yaml            # JSON on stdout
node tools/elasticpro-scrape.mjs --config clusters.yaml --out /var/lib/elasticpro/automation.json
node tools/elasticpro-scrape.mjs --config clusters.yaml --format sender | zabbix_sender -z zbx -i -
```

It reads. It never writes to Elasticsearch — a rule returns a description of work, and
running that work still needs a person in the app, behind its own confirmation and the
two-gate write guard. Exit status is 0 whenever a document was produced, even if clusters
were unreachable; an unreachable cluster is a fact to report, not a reason to report
nothing. Only failing to produce a document at all exits non-zero.

### Two things it will tell you rather than hide

- **`generatedEpoch`** — a scraper that has died looks exactly like a healthy fleet. The
  template's staleness trigger is the one to fix first if it fires; until it clears, every
  other item is reporting the last thing it saw.
- **`problems`** — a config holding sealed `enc:v1:` secrets cannot be unlocked by a
  headless run. It says so, instead of reporting every cluster as unreachable and looking
  like an outage.

## Running it on a schedule

### Hosted stack (Docker)

```bash
docker compose -f docker-compose.yml -f zabbix/compose.scraper.yml up -d
```

The scraper reaches the core over the internal network — the core stays unpublished — and
writes one JSON file to a volume nginx serves. It needs an API token in
`deploy/secrets/scraper_token` first — see "2. The scraper to the core" below.

**One change this does not make for you.** Serving the file needs a location in
`deploy/nginx/nginx.conf`, and that file is your TLS front door, so add it yourself:

```nginx
    # Before `location / { proxy_pass ... }`. Exact match, so it wins over the proxy.
    # Its own auth_basic: the server block has none any more (the app signs people in
    # itself), so a location without one is public.
    location = /automation.json {
      auth_basic           "ElasticPro scrape";
      auth_basic_user_file /etc/nginx/htpasswd;
      alias /usr/share/nginx/state/automation.json;
      default_type application/json;
      add_header Cache-Control "no-store" always;
    }
```

Then `docker compose restart nginx`.

### Bare metal (systemd)

```bash
install -m644 elasticpro-scrape.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now elasticpro-scrape.timer
systemctl list-timers elasticpro-scrape.timer
```

Adjust the paths in the unit — it assumes the repo at `/opt/elasticpro`, the config at
`/etc/elasticpro/clusters.yaml`, and an `elasticpro` user that can read both.

### Push instead of pull

If you would rather not serve a file, `--format sender` emits `zabbix_sender` lines for
trapper items. Same data, same keys; you lose the low-level discovery unless you send the
two `elasticpro.discovery.*` items too, which that format includes.

**Five minutes is a sensible floor either way.** Proving an index is safe to delete means
listing every snapshot in every repository, which is the expensive half of the work, and
indices are dated by day — polling harder buys nothing.

A run tighter than that (the client-plan scraper runs every minute, for alert states) keeps the
expensive calls on their own clocks: `--indices-every 30` re-lists a cluster's indices at most
every half hour and `--delay-every 15` measures log delay every quarter hour, both carried
between runs in the `--memory` file. Without `--memory` there is nowhere to remember them, and
every run fetches both afresh.

## Zabbix

Import `template-elasticpro.yaml` (Data collection → Templates → Import), link it to a
host, and set four macros:

| Macro | Meaning |
| --- | --- |
| `{$ELASTICPRO.URL}` | where the document is served, e.g. `https://elasticpro.internal/automation.json` |
| `{$ELASTICPRO.USER}` | HTTP basic user — the hosted stack is behind an auth gate |
| `{$ELASTICPRO.PASSWORD}` | that user's password (secret text) |
| `{$ELASTICPRO.STALE}` | how long without a scrape before it alerts (default `30m`) |

The host needs no Zabbix agent. One HTTP request fetches the whole document and every
other item derives from it, so polling cost does not grow with clusters or rules. Two
discovery rules build per-cluster and per-rule items automatically from the
`{#CLUSTER.ID}` / `{#RULE.ID}` arrays the scrape emits.

### What the triggers mean

| Trigger | Severity | Why it matters |
| --- | --- | --- |
| the scrape has stopped running | High | Fix before trusting anything else on this template |
| a cluster could not be reached | Average | Its rules were not evaluated at all |
| a rule failed to evaluate | Average | Usually a malformed automation in `clusters.yaml` |
| automation held work back | Warning | A rule matched indices it then refused to propose — most often past retention with no proved snapshot. The case most worth a human looking at it |
| work waiting for review | Information | Proposals are waiting in the app. Nothing runs until a person runs it |

"Held back" alerting louder than "proposals waiting" is deliberate. A proposal is routine
housekeeping; a refusal means the rule found something it could not make safe.

## Authentication

Three separate boundaries. Only the first involves Zabbix credentials.

### 1. Zabbix to the scrape document

HTTP basic, on that one location. Add a user:

```bash
./make-htpasswd.sh zabbix          # bcrypt, prompts for the password
```

Then set `{$ELASTICPRO.USER}` and `{$ELASTICPRO.PASSWORD}` on the host. The template's master item
is `authtype: BASIC` and every other item derives from it, so this is the only credential
Zabbix needs.

The `auth_basic` lines **inside** `location = /automation.json` are the only reason the
document is protected. The hosted `server` block used to carry an `auth_basic` gate that
this location inherited; it does not any more (the app has its own accounts), so a copy of
the location without its own two lines publishes your fleet's index names to anyone who
can reach the port. Check after a reload: `curl -sk -o /dev/null -w '%{http_code}\n'
https://<host>/automation.json` must say `401`.

If the stack uses a self-signed or internal-CA certificate, either add that CA to the
Zabbix server's trust store or clear "SSL verify peer" and "SSL verify host" on the master
item. Prefer the CA — clearing both turns off the only check that the host answering is
the one you meant.

### 2. The scraper to the core — use an API token

Mint one on the **Accounts** page (hosted builds only) with the **user** role: the scrape
reads indices and snapshots, so `guest` is not enough. The secret is shown once, is stored
only as a SHA-256 hash, and can be revoked from the same page.

Put it in a file of its own — `deploy/secrets/` is gitignored:

```bash
umask 027; printf '%s\n' 'elasticpro_…' > deploy/secrets/scraper_token
```

`compose.scraper.yml` and `compose.plan.yml` both mount that file as a Docker secret and
point `ELASTICPRO_TOKEN_FILE` at it; `setup/zbx_phase34.py` writes it for the test stack. The
scraper reads `$ELASTICPRO_TOKEN_FILE` (or `--token-file`) first and sends the token as
`Authorization: Bearer`; a named file that is missing or empty stops the run rather than
scraping as nobody. `$ELASTICPRO_TOKEN` and `--token` still work, but an environment value shows
in `docker inspect` and a command-line one in `ps`.

Upgrading: a deployment that had `ELASTICPRO_TOKEN=` in `deploy/.env` (automation scrape) or
`deploy/secrets/scraper.env` (client plan) moves the value into `secrets/scraper_token` —
`sed -n 's/^ELASTICPRO_TOKEN=//p' deploy/secrets/scraper.env > deploy/secrets/scraper_token` —
and removes it from the old place. Compose refuses to start the scraper until the file
exists.

**Why a token rather than the user header.** When `ELASTICPRO_BIND` is non-loopback the bridge
requires `X-Auth-User` to be present and non-empty, and checks it no further: the header
is trusted because nginx sets it, and the security comes from the core being unreachable
except through the proxy. Sent directly, `X-Auth-User: root` is accepted as readily as any
other name. So `--auth-user` **names** the scrape in the audit log; it does not
authenticate it. A token is different — the core issued it, bound a role to it, and can
revoke it — which is what makes the audit line worth reading.

The bridge prefers a token over the header when both are present, so adding one to an
existing deployment needs no other change.

`--auth-user` remains worth passing on a bridge with no token: the bridge decides whether
to demand the header from its own bind address, not the client's, so a bridge on `0.0.0.0`
rejects even a loopback request that has neither.

### 3. The scraper to Zabbix, if you push instead of pull

`--format sender` has no shared secret of its own. A trapper item accepts a value when the
host name and item key match, so restrict it:

- set **Allowed hosts** on the trapper items to the scraper's address, and
- encrypt with PSK — `zabbix_sender --tls-connect psk --tls-psk-identity <id>
  --tls-psk-file <file>` against a host configured for PSK.

Without both, anything that can reach port 10051 can write these values.

### What never gets a Zabbix credential

Elasticsearch. Zabbix reads one JSON file; it never talks to a cluster, and the cluster
credentials stay where they were — sealed in the config the core reads. Nothing in this
directory widens what the core can reach.

## ElasticPro inside Zabbix

`module/elasticpro/` is a Zabbix 7.0 frontend module. It adds **ElasticPro** to the
Zabbix main menu, after Monitoring, and opens the whole app inside Zabbix already signed
in as the Zabbix user — no second password.

| Zabbix user type | ElasticPro role | Clusters | Can write |
|------------------|---------------------|----------|-----------|
| User             | `user`              | only those mapped to their Zabbix user groups | no |
| Admin            | `operator`          | all | yes, behind the write unlock |
| Super admin      | `admin`             | all | yes, and administers the app |
| Guest            | —                   | not signed in | — |

Accounts are created on first sign-in as `<zabbix name>@zabbix`, so a Zabbix user called
`admin` can never become the local `admin`. Their role and groups are rewritten from
Zabbix at every sign-in: move someone between Zabbix groups and it applies the next time
they open the page. They have no password in ElasticPro; an admin can still disable
one there, and a disabled account stays out whatever Zabbix says.

**Which clusters a Zabbix User sees** is set on the cluster, in the ElasticPro config:

```yaml
clusters:
  - name: prod-elk
    url: https://es-prod-01.internal:9200
    zabbixGroups: [ES prod team, NOC]
```

A User in no listed group sees no clusters, and is told so. The core enforces this on
every request — cluster list, Elasticsearch calls, request counts, jump
hosts and trust decisions — not just in what the pages draw.

### How the sign-in works

1. The module posts `{username, zabbix_user_type, groups, ts, nonce}` to the core's
   `/sso/zabbix`, signed with HMAC-SHA256 under a secret both sides hold.
2. The core checks the signature, the clock (±60 s) and the nonce (once only), creates or
   refreshes the account, and answers with a code valid once, for 60 seconds.
3. The page loads ElasticPro in a frame with that code; the app trades it for a
   session and removes it from the address bar.

nginx forwards exactly `/sso/zabbix` and `/zabbix/pair` to the core (rate-limited, with
`X-Real-IP`, so the core can apply **Allowed sources** from Config → Zabbix); everything
else under `/sso/` is 404. On one machine the Zabbix frontend can also reach the core over
`ep_sso`, a Docker network whose only other member is the core. The core itself sends
`Content-Security-Policy: frame-ancestors <paired Zabbix origin>` (or `'none'`); nginx no
longer sets it — `ELASTICPRO_FRAME_ANCESTORS` on the core pins it by hand. People without an ElasticPro
admin role never receive a credential: their browser loads a cluster list with every
secret removed, and the core uses the credentials an admin last applied — kept in
`primed.json` (0600) in the data volume so a restart does not need an admin first. A
config with sealed secrets is never written there.

### Installing the modules on an existing Zabbix

On the Zabbix web host:

```bash
curl -fsSL https://github.com/karthick-dkk/elasticpro/releases/latest/download/zabbix-modules-install.sh | sudo bash
# or: download it, read it, then `sudo bash zabbix-modules-install.sh --dry-run`, then without --dry-run
```

[`zabbix-modules-install.sh`](zabbix-modules-install.sh) takes
`elasticpro-zabbix-modules-<ver>.tar.gz` from the release, checks its `.sha256` before
extracting, and finds the frontend: a package install (`modules/` beside `zabbix.php`,
owner `root:<PHP's group>`, plus the Cluster Management data folder
`/var/lib/elasticpro-zabbix`), or a running `zabbix-web-*` container (the host folder
mounted at `/usr/share/zabbix/modules` or at `…/modules/<id>`, owner `1997:1995`; with
no mount it installs to `/opt/elasticpro/zabbix-modules` and prints the `volumes:`
lines to add). Each module is staged beside the modules folder and renamed in; the
previous one goes to `/var/backups/elasticpro-zabbix/<stamp>/`, `config.php` is carried
over untouched, and a module already at this version is left alone, so re-running it is
the upgrade. A module that is bind-mounted into the container on its own is updated in
place instead, since a folder renamed under a running container vanishes from it.

| Option | Does |
| --- | --- |
| `--dry-run` | every step, nothing changed |
| `--version vX.Y.Z` | that release instead of the latest |
| `--from-dir <path>` / `--tarball <file>` | no download: a checkout (the archive is built from it with `tools/zabbix-modules-tarball.sh`, as the release is) or an unpacked archive; a downloaded archive, checked against `<file>.sha256` beside it |
| `--modules-dir <dir> --owner uid:gid`, `--container <name>`, `--package` | override detection (a package frontend and a Zabbix web container on one host: `--zabbix-url` picks the one publishing its port; without it the installer asks) |
| `--zabbix-url <url> --token-file <file>` | register and enable the modules through `module.get` / `module.create` / `module.update` — a newly copied module can be registered this way, no Scan directory needed. The token is a Super admin's, alone in a `chmod 600` file; a group- or world-readable file is refused |
| `--write-master-template --password-file <file> [--user <name>]` | press Cluster Management → **Write master template**, the page's own action. It is not an API method, and API tokens cannot open a frontend session, so this signs in with a Super admin's password (from a `chmod 600` file) and signs out afterwards. Not with MFA or SSO on that user — press the button instead |
| `--uninstall` | move the five module folders to the backup folder; with `--zabbix-url`/`--token-file` it disables them first, otherwise disable them in the UI before running it |

Secrets go to `curl` in config files, never on a command line, and are never printed.

The archive is built by `tools/zabbix-modules-tarball.sh` (GNU tar; sorted, owner 0, fixed
mtime, `gzip -n`), which the release job in `.github/workflows/build.yml` runs on every
`v*` tag; the same sources give the same bytes. It holds the five module folders without
tests, tool scripts, READMEs or any `config.php`. `install-modules.sh` (below, and in
`PRODUCTION.md`) stays for the stack in `stack/`, where the modules are mounted from the
repository.

### Setting it up from the Zabbix UI (pairing)

Install the modules (above) — or copy `module/elasticpro/` into the frontend's
`modules/` directory — and enable it (Administration → General → Modules → Scan
directory). Then, as a Super admin:

1. ElasticPro → Config → Zabbix → **Pair with Zabbix** shows a one-time pairing code
   (valid 15 minutes).
2. Zabbix → **Administration → ElasticPro** → paste it → **Pair**.

The module, acting as you through Zabbix's own API (audited), creates or reuses the role
and user named in `module/elasticpro/sync-role.json` — the one list of API methods the
sync may call, also read by `setup/zbx_api_user.py` — makes a new API token for that user
and posts it to ElasticPro's `/zabbix/pair`, HMAC-signed with the secret from the code
exactly as the sign-in is. Only when ElasticPro accepts does it store
`{epUrl, secret, verifyTls, pairedAt, pairedBy, tokenId}` in the module's config in the
Zabbix database (`module.config`); on failure the new token is deleted. A re-pair makes the
new token first and deletes the previous pairing's token only after success; tokens it did
not make (the setup script's `elasticpro`) are never touched. **Unpair** removes the
stored secret and the pairing's token — unpair in ElasticPro too.

The secret is sealed (AES-256-GCM, key derived from Zabbix's `config.session_key`) before it
is stored, because `module.get` returns the config to any Super admin with API access and
`module.update` writes it into the audit log; both see only ciphertext. The page shows
"set · paired <date> by <user>", never the value. **Test connection** loads ElasticPro
and sends a signed probe that the core accepts the signature of, then refuses as a body —
nobody is signed in. A manual mode (URL, verify TLS, secret) is on the same page for a
secret managed on the server.

`config.php` (below) still works and **wins key by key** over the stored settings; the page
shows those fields read-only. You can pair while `config.php` is in place and remove it
afterwards — sign-in keeps working throughout.

### Setting it up by hand (server-managed)

```bash
# ElasticPro side, from deploy/
docker network create ep_sso
openssl rand -hex 32 > secrets/zabbix_sso_secret && chmod 640 secrets/zabbix_sso_secret
docker compose -f docker-compose.yml -f zabbix/compose.sso.yml up -d core
#   allow the Zabbix origin to frame the app — on the core, not in nginx.conf: either
#   Config → Zabbix → Zabbix URL (the frame follows it while a sign-in secret is set), or
#   ELASTICPRO_ZABBIX_URL=https://zabbix.example.com:9443 (or ELASTICPRO_FRAME_ANCESTORS) on the core

# Zabbix side — an existing Zabbix 7.0, or stack/ for a small one (stack/setup.sh, then up)
cp module/elasticpro/config.php.example module/elasticpro/config.php   # fill it in
#   Administration → General → Modules → Scan directory → enable "ElasticPro"
```

`config.php` needs `core_url` (where the Zabbix server reaches the core: `http://ep-core:8765`
on `ep_sso`), `public_url` (where browsers reach ElasticPro) and `module_secret` (the
same value as `secrets/zabbix_sso_secret`). If the page shows an error instead of the app,
it names the cause — wrong secret, clock skew, core unreachable — as the core reported it.

## Clusters from Zabbix hosts

Any Zabbix host carrying the cluster template (`Elasticsearch Cluster by HTTP EP`, or
`ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE`) is a cluster in ElasticPro. The core asks Zabbix every
five minutes (Config → Zabbix → **Sync now** for immediately):

| macro | meaning |
|---|---|
| `{$ELASTICSEARCH.SCHEME}` / `.HOST` / `.PORT` | where it is |
| `{$ELASTICSEARCH.USERNAME}` | user |
| `{$ELASTICSEARCH.PASSWORD}` | a **Vault** macro, `secret/elasticpro/<name>:password` |
| `{$ELASTICSEARCH.JUMPHOST}` | an ElasticPro jump host id; empty = direct |
| `{$GRP.CLIENT}` | the client |

- **Who sees it** is Zabbix's answer: a user group that can read the host (and is denied none
  of its groups) sees the cluster in ElasticPro too. Set it once, in Zabbix.
- **Zabbix wins**: a config-file cluster at the same address is set aside — but only once
  the Zabbix one can actually sign in, so a working cluster is never swapped for a broken one.
- A **Secret** macro is reported as unreadable: Zabbix never returns those through its API.

### Passwords: Vault, or ElasticPro's own

`../vault/` runs HashiCorp Vault (community edition; OpenBao works unchanged). The core
signs in with a read-only AppRole; the Zabbix server with a read-only token. Put a password:

```bash
cd ../vault && ROOT=$(python3 -c 'import json;print(json.load(open("secrets/vault-init.json"))["root_token"])')
docker compose exec -it -e VAULT_TOKEN="$ROOT" vault sh -c \
  'printf "ES password: "; stty -echo; read P; stty echo; echo; printf %s "$P" | vault kv put secret/elasticpro/vm-1 username=elastic password=-'
```

Or switch on **Use ElasticPro credentials** (Config → Zabbix, stored in the config file):

```yaml
zabbix:
  useElasticProCredentials: true   # connect Zabbix clusters with ElasticPro's credential:
                                   # the one held for a config cluster at the same address,
                                   # else the config's shared `credentials:`
  createHosts: false               # see below
  hostGroup: Elasticsearch clusters
```

Zabbix's own checks still need the password in Vault; this option only changes how
ElasticPro connects.

### Config clusters → Zabbix hosts (`createHosts`)

With `createHosts: true`, every config cluster Zabbix does not have becomes a host: the
cluster template (and the client-plan template), `{$ELASTICSEARCH.*}` macros, its password
stored in Vault and referenced — never written into Zabbix — and read access for the
cluster's `zabbixGroups` on its client group. From the next sync, Zabbix wins. This uses
separate, write-only credentials (`zabbix_api_write_token`, the `elasticpro-provision`
AppRole); the five-minute sync can only read.

### Client plan and the fleet dashboard

`compose.plan.yml` runs the scraper: each cluster's Volume-report client plan goes to its own
Zabbix host (template `ElasticPro client plan`, generated from the same column
definitions the page uses — `node tools/zabbix-plan-template.mjs`). Values ElasticPro
cannot measure are not sent: a gap, never a zero.

`setup/zbx_dashboard.py` builds "ElasticPro — Fleet": Top hosts for forwarders,
parsers and ES nodes (CPU, memory, disk, load from the Linux template, grouped by the
`Forwarders` / `Parsers` / `ESNodes` host groups), every cluster's health and client plan,
and trends.

### Clusters behind a Windows jump host, without a proxy

The Cluster Management page can monitor a cluster through a Windows jump host over SSH: the
Zabbix server runs `curl.exe` there (see `integration/zabbix/clients-module/README.md`). The
stack mounts an `ssh-keys` volume read-only at the server's `SSHKeyLocation`;
`jump-sim/setup.sh` makes the key pair in it (owned by zabbix) and prints the public half, which
goes in the jump user's `authorized_keys`. `jump-sim/` is also a stand-in jump host with the
fixture cluster behind it (`docker compose up -d --build`), for testing without Windows, and a
mail catcher (`mail`, web view on the VM's `127.0.0.1:8025`) for the DL alerts and weekly reports.

### Weekly client reports

Cluster Management's weekly report is a Zabbix scheduled report. The stack runs what that needs:
`web-service` (renders a dashboard to PDF; only the server may ask it) and one report writer on
the server (`ZBX_STARTREPORTWRITERS`, `ZBX_WEBSERVICEURL`). Set **Administration → General →
Other → Frontend URL** to an address the web service can open — `http://web:8080/` inside the
stack — and give Zabbix an active Email media type.

### Troubleshooting from a Zabbix problem

`setup/zbx_troubleshoot.py` adds an **ElasticPro** entry to the problem and host menus:

* **Troubleshoot in ElasticPro** (on a problem) opens the app at the cluster the problem
  is about, on the page that answers it. ElasticPro's own problems carry a `rule` tag,
  which decides the page (the same mapping the app's Alerts page uses); problems from the
  Elasticsearch or Linux templates are placed by their name. A problem on a forwarder or
  parser finds its cluster through `{$GRP.CLIENT}` when that client has exactly one.
* **Open in ElasticPro** (on a host) opens the app at that host's cluster.

Both go through the module, so the person is signed in as themselves and a cluster their
Zabbix groups do not allow is simply not selected.

### Every ElasticPro alert is a Zabbix problem

Real-time metrics come from Zabbix alone. What ElasticPro adds is its alert rules, sent
every minute by the scraper (template `ElasticPro alerts`,
`node tools/zabbix-alert-template.mjs`): disk, disk balance, unaccounted disk, capacity
change, master moved, ILM errors, SLM failures and staleness, repository problems, devices
shipping logs late, and automation rules with work waiting. Health, reachability, masters,
SLM mode and index-size spikes are left to the Elasticsearch template, which already raises
them — one condition, one alarm.

The scraper's `--memory` file carries master, disk capacity and the last log-delay reading
from one run to the next; log delay is measured every 15 minutes (`--delay-every`).

## Inside Zabbix — the fleet cache, live updates, task cards

Nothing on the Zabbix side changed for these; what follows is where each one travels, so a
problem can be placed.

**Every request from the frame goes to ElasticPro's own nginx, never through Zabbix.**
The frame is `public_url`, so `/bridge` (FLEET_STATE, CLUSTER_DATASET, REFRESH,
EVENTS_TICKET) and the live-update stream `GET /events?ticket=…` are same-origin requests
from the frame to that nginx. Zabbix's own nginx, PHP and headers are not in the path, and
Zabbix sends no `Content-Security-Policy` that could block them. What ElasticPro's nginx
needs is what it already has: `location = /events` (buffering off, one-hour timeouts), and
`frame-ancestors` naming the Zabbix origin — scheme, host **and port**
(`https://zabbix.example.com:9443`). It sends no `connect-src`, so nothing else to add.

**The Zabbix sign-in session is an ordinary session.** `SSO_EXCHANGE` returns the same kind
of session `LOGIN` does, so EVENTS_TICKET, FLEET_STATE and the stream work for it unchanged,
and the Zabbix user groups decide what they carry: a Zabbix User's FLEET_STATE lists, and
the stream announces, only the clusters their groups may read. Moving someone between groups
in Zabbix reaches an open stream within a minute of their next Zabbix page load (the stream
re-checks its session every 60 s). When the session ends, the stream says `expired`, the next
ticket is refused, and the frame asks the Zabbix page to sign in again — the same
`elasticpro:reauth` message as before, with the same three-a-minute limit.

**Limits are per address.** nginx allows 8 open streams and 20 `/bridge` requests a second
(burst 40) per client address. If people reach ElasticPro through a proxy or NAT that
gives them all one address, the whole team shares those — set `set_real_ip_from` /
`real_ip_header` for that proxy in `nginx.conf`, or raise both limits.

**Clusters added in Zabbix appear by themselves.** A host that gets the cluster template (or
Cluster Management's jump-host template) is picked up at the core's next Zabbix sync
(`ELASTICPRO_ZABBIX_SYNC_SECS`, 300 s; **Config → Zabbix → Sync now** for at once) and polled by
the fleet cache within a second of that. An open page notices FLEET_STATE naming a cluster it
does not have — or no longer naming a Zabbix cluster it shows — and re-reads the Zabbix list
the way Sync now does (`zabbixDrift` in `ui/js/core/config.js`), once per difference.

**Task cards, the bell, dialogs.** Toasts and task cards are fixed to the top right of the
frame, just under the app's own pinned header; they are inside the frame, so Zabbix's menu and
header cannot cover them and need no z-index. The bell's history is per ElasticPro account
— `<zabbix name>@zabbix` — so it follows the person, not the browser tab. The app no longer
calls the browser's `alert` / `confirm` / `prompt` anywhere; those are the calls browsers
suppress or restrict in a cross-origin frame, so every question (delete, restore, rename) now
appears as the app's own dialog inside the frame. (The Cluster Management pages are Zabbix's
own pages, not the frame, and keep Zabbix's native confirmations.)

**The Clusters page is a health summary; Zabbix still raises the alarms.** Its four tiles —
cluster health, red clusters, unreachable, top errors — are what the **ElasticPro core**
last found, from where the core sits. They are not Zabbix's triggers and can disagree with
them honestly:

| Tile | ElasticPro means | Nearest Zabbix problem | Why they can differ |
|---|---|---|---|
| Red clusters | `_cluster/health` said `red` at the core's last poll (every 180 s) | the Elasticsearch template's cluster-health trigger | different poll times; Zabbix holds a trigger through its own recovery expression |
| Unreachable | the core's health request never arrived (reach, re-probed every 120 s) | the template's service-down / no-data triggers | different network paths: a cluster Zabbix reaches over SSH through a Windows jump host is unreachable **for ElasticPro** until `jump_hosts` has that host — Config → Zabbix names the one to add |
| Top errors | ElasticPro's alert rules, grouped | "ElasticPro alerts" template problems, one per rule | the scraper sends each rule once a minute; the tile updates as data arrives |
| Cluster health `online / total` | clusters whose health has been read, green+yellow+red | — | "loading" is counted apart, never as green |

Inside Zabbix the "N open alerts" banner is hidden (Monitoring → Problems is the list to
work from), but the tiles stay: they are a snapshot of the fleet, not a problem list.

**Zabbix clusters are polled by the fleet cache too.** With the cache running, the pages read
the core's own polls for every cluster, Zabbix hosts included; the "via Zabbix" figures
(`ZABBIX_METRICS`) are only used when a page talks to clusters directly (a core without the
cache). A Zabbix cluster is therefore asked by Zabbix's template *and* by the core's poller
(health every 180 s, nodes every 300 s, the rest less often) — bounded, one poller per core,
but not zero.

## One host, both stacks

The hosted ElasticPro stack (`deploy/docker-compose.yml`) and the Zabbix stack
(`stack/`) run side by side on one machine:

| Port | Who | Published as |
|---|---|---|
| 443 | ElasticPro nginx | `${LISTEN:-443}` |
| 9443 | Zabbix frontend | `${ZBX_HTTPS_PORT:-9443}` |
| 10051 | Zabbix server (trapper, agents) | all interfaces |
| 10050 | Zabbix agent 2 | host network |
| 8200 | Vault | `127.0.0.1` only |
| 8025 | jump-sim mail catcher (tests) | `127.0.0.1` only |

Nothing else is published — the core, both Postgres instances, Redis and the web service
stay on their compose networks. The networks: `deploy_internal` (the hosted stack),
`zabbix_zbx` (the Zabbix stack; the plan scraper and jump-sim join it), `ep_sso` (Zabbix
frontend ↔ core), `vault_net` (Vault ↔ core ↔ Zabbix server). `stack/setup.sh` creates the
two external ones. The agent accepts passive checks from `172.16.0.0/12`, Docker's default
pool; a Docker daemon configured with other address pools needs `ZBX_SERVER_HOST` changed.

**Memory on a 4 GB machine that also runs a 1.6 GB Elasticsearch.** The caps add up to more
than the machine has at the defaults (ES 1.6 + core 1.0 + Zabbix 1.4 + Vault 0.3 + scrapers
0.2 ≈ 4.5 GB, before the OS), and a cap is the point where the kernel kills that container —
so size them to fit:

| Container | Default cap | On the shared 4 GB host |
|---|---|---|
| ElasticPro core | 1g | `ELASTICPRO_MEM_LIMIT=512m` with `ELASTICPRO_CACHE_MB=64` in `deploy/.env` |
| Redis (`--profile cache`) | 640m | leave the profile off — the disk cache is enough for one core |
| Zabbix db / server / web / web-service / agent | 320m / 384m / 256m / 384m / 64m | as they are (already sized for this host) |
| Vault + agent | 256m + 64m | as they are |
| plan scraper, automation scraper | 192m each | as they are; run one of them if memory is tight |
| jump-sim | ~256m | tests only — stop it on a real deployment |

That is ≈ 1.6 + 0.5 + 1.4 + 0.3 + 0.4 ≈ 4.2 GB of caps against typical use well under 3 GB;
the web service only renders when a scheduled report runs. Watch `docker stats` for a week
before trusting it, and give Elasticsearch's heap priority — it is the one that loses data
when killed.

## What this does not do

Arming — letting a rule act unattended — is still off, and not because of anything here.
The hosted write unlock is a single switch shared by every signed-in user until RBAC
lands, so an armed rule would run under whoever unlocked writes last. See `canArm()` in
`ui/js/core/automation.js`.
