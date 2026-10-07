# Deploying to production — Cluster Management, jump hosts, DL alerts and reports

For the people rolling ElasticPro's Zabbix side out to production: the Zabbix admin, and
whoever holds Docker and Vault access on the ElasticPro host. Zabbix 7.0 is assumed.

What this deploys (commit `0d0ecd8` and later on `main`):

- **Cluster Management** page: client status (active, maintenance, disabled, decommissioned),
  setup checks, Test connection, clone, hosts removed or changed outside Zabbix, over-purchase and
  proxy-down flags, read-only view for Zabbix Admins.
- **Windows jump host (SSH), no proxy**: Elasticsearch asked with `curl.exe` on a Windows jump
  host by the Zabbix server, and the log archive check through it.
- **Problems by email to the cluster DL** and a **weekly PDF report** per client.
- **Client capacity** widget: *ES Full In* column.
- **ElasticPro core**: finds clusters behind a Windows jump host from Zabbix.

Not for production: `deploy/zabbix/jump-sim/` (a simulated jump host, a fixture cluster and a mail
catcher) is for testing only.

---

## 0. Before you start

1. Plan a short window: the Zabbix frontend and the ElasticPro core container each restart once.
2. Back up:
   - the Zabbix database (`pg_dump`, or your usual backup);
   - the Cluster Management data folder, if it already runs: `$EP_DATA_DIR`, by default
     `/var/lib/elasticpro-zabbix` (Docker stack: the `ep-data` volume);
   - ElasticPro's `deploy/.env` — note the `ELASTICPRO_IMAGE` it names.
3. These templates must already be in Zabbix (step 4 names any that are missing):
   `Elasticsearch Cluster by HTTP EP`, `Linux by Zabbix agent -EP`,
   `ElasticPro client plan`, `ElasticPro alerts`, `ElasticPro log delay`.
   The first two are only defaults — if yours carry other names, set
   `ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` / `ELASTICPRO_ZABBIX_LINUX_TEMPLATE` to them instead of
   renaming anything in Zabbix (`deploy/zabbix/setup/README.md`, "Which templates").

## 1. Build and check

On a build machine:

```bash
git clone <repo> && cd ElasticPro-portable-win64
git checkout main && git log -1 --oneline          # 0d0ecd8 or later
npm i jsdom
node tools/check-ui.mjs && node tools/unit-check.mjs
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
cd integration/zabbix
node --test $(git ls-files '*.test.mjs')
docker run --rm -v "$PWD":/m -w /m/clients-module php:8.4-cli-alpine php test/spec.test.php
```

All must pass (the PHP spec prints `… passed, 0 failed`). Do not continue on a failure.

## 2. ElasticPro core — `deploy/deploy.sh`

On the ElasticPro host, one command:

```bash
deploy/deploy.sh --pull                      # git pull, build, switch, wait for healthy
deploy/deploy.sh --image <registry>/elasticpro-core:0.1.0   # or run an image built elsewhere
```

It backs up `.env`, builds `elasticpro-core:<version>-<commit>`, points `ELASTICPRO_IMAGE` at it,
restarts only the core and waits for its health check. If the core is not healthy in time it
switches back to the image that ran before, by itself, and exits with an error. `--dry-run` shows
what it would do; `--all` restarts the whole stack; `--timeout` (default 180 s).

The Rust build is long on a small server; build the image on a build machine and use `--image`.

**First sign-in on a new host:** the account is `elasticpro`, with a password generated for
this install — `docker compose exec core cat /app/data/initial-admin-password` (or
`docker compose logs core | grep "created the first one"`). Sign in and set a real password at
once; the file is deleted when you do. `ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE` (a mounted file, 10+
characters) sets it instead — see `deploy/README.md`, "First sign-in". Redeploying an existing
host changes nothing: its accounts are kept.

**Rollback later:** `deploy/deploy.sh --rollback` — back to the image before the last deploy
(`ELASTICPRO_IMAGE_PREVIOUS` in `.env`).

A cluster behind a Windows jump host now appears in ElasticPro's Zabbix listing. ElasticPro
reaches it through its own jump host with the same address and port (`jump_hosts` in the config);
until one is configured, the listing says which to add.

**Rolling this out against 100-300 clusters:** the core polls in the background now rather
than only while a page is open, and nginx got a keepalive pool to the core, gzip and two
request limits sized for that traffic — see `deploy/README.md` ("Scaling to a large
fleet") for the `ELASTICPRO_POLL_*` / `ELASTICPRO_CACHE_MB` knobs and the optional Redis cache layer.
Nothing here needs it: the core works, and stays warm across a restart, with only the disk
cache under `$ELASTICPRO_DATA_DIR/cache`.

## 3. Zabbix server prerequisites

Only for the features you use.

### 3a. SSH key — clients behind a Windows jump host

The Zabbix server signs in to jump hosts with its own key pair.

Docker stack (`deploy/zabbix/stack`): the compose file mounts an `ssh-keys` volume read-only at
`/var/lib/zabbix/ssh_keys`. Create the key once, owned by the zabbix user (uid 1997):

```bash
docker compose up -d server          # creates the volume
docker run --rm -v zabbix_ssh-keys:/k alpine:3.22 sh -c '
  apk add --no-cache openssh-keygen >/dev/null
  [ -f /k/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C zabbix-server -f /k/id_ed25519
  chown -R 1997:1995 /k && chmod 700 /k && chmod 600 /k/id_ed25519 && chmod 644 /k/id_ed25519.pub
  cat /k/id_ed25519.pub'             # the public key, for step 7
```

Package install:

```bash
sudo -u zabbix mkdir -p /var/lib/zabbix/ssh_keys
sudo -u zabbix ssh-keygen -t ed25519 -N "" -f /var/lib/zabbix/ssh_keys/id_ed25519
# zabbix_server.conf:  SSHKeyLocation=/var/lib/zabbix/ssh_keys
systemctl restart zabbix-server
```

### 3b. Weekly PDF reports

**If the Zabbix web service (`zabbix_web_service`, port 10053) already runs, use it — do not
install another.** Make sure `zabbix_server.conf` has `WebServiceURL=http://<its host>:10053/report`
and `StartReportWriters=1` or more, and that the web service's `AllowedIP` includes the Zabbix
server. Otherwise:

Docker stack: the compose file has a `web-service` container and sets `ZBX_STARTREPORTWRITERS=1`
and `ZBX_WEBSERVICEURL` on the server.

```bash
docker compose up -d web-service server
```

Package install: install `zabbix-web-service`, then in `zabbix_server.conf`:

```
StartReportWriters=1
WebServiceURL=http://localhost:10053/report
```

and restart zabbix-server.

Either way, set **Administration → General → Other → Frontend URL** to an address the web service
can open — production's real Zabbix URL.

### 3c. Email

**Alerts → Media types**: configure and enable a real **Email** media type. DL alerts and weekly
reports use the first active one; without it, saving a client with those options says so.

## 4. Zabbix modules — `deploy/zabbix/install-modules.sh`

One command, on the Zabbix frontend host, from a checkout of this repo:

```bash
# Zabbix from packages:
ZABBIX_URL=https://zabbix.example.com ZABBIX_TOKEN=<super admin API token> \
  sudo deploy/zabbix/install-modules.sh

# The Docker stack in deploy/zabbix/stack:
ZABBIX_URL=https://zabbix.example.com ZABBIX_TOKEN=<token> deploy/zabbix/install-modules.sh --docker
```

It:

1. copies the five modules — `elasticpro`, `ep_clients`, `ep_capacity`, `ep_resources`,
   `ep_volume` — into Zabbix's modules folder (`/usr/share/zabbix/modules`), without tests and
   tool scripts. What was there first goes to `/var/backups/elasticpro-zabbix/<date>/`. Each
   module's folder is refilled, never replaced, so Docker's bind mounts keep working;
2. makes the page's writable data folder, `/var/lib/elasticpro-zabbix`, owned by the user PHP
   runs as (found from php-fpm, else nginx / www-data / apache; `--web-user` to say it).
   Not with `--docker`: the stack's `ep-data` volume is that folder;
3. with `ZABBIX_URL` and `ZABBIX_TOKEN` (or `ZABBIX_USER` + `ZABBIX_PASSWORD`): registers and
   enables the modules and creates the host groups and report dashboards
   (`integration/zabbix/master/import.py`). Without them: **Administration → General → Modules
   → Scan directory**, then enable the five.

Options: `--modules-dir`, `--data-dir` (then set `EP_DATA_DIR` for PHP), `--web-user`,
`--backup-dir`, `--insecure` (self-signed `ZABBIX_URL`), `--dry-run`.

Then reload PHP so its opcode cache drops the old code: `systemctl reload php-fpm` (or
`php8.x-fpm`). It changes no Zabbix configuration file.

**Rollback:** copy the folders from `/var/backups/elasticpro-zabbix/<date>/` back into the modules
folder.

## 5. Templates

1. **Log archive template** (`ElasticPro log archive S3`). It is kept outside this repo, in
   the `elasticpro-zabbix/ulm` folder. Import the current version:
   ```bash
   cd elasticpro-zabbix/ulm
   ZABBIX_URL=https://zabbix.example.com ZABBIX_TOKEN=<token> python3 import.py
   ```
2. In Zabbix: **ElasticPro → Cluster Management → Write master template**. This writes the
   client master, *Elasticsearch via SSH jump host*, *log archive ES via SSH jump host* and
   *cluster devices* templates. The banner asking for it disappears.

## 6. Secrets and macros

### Elasticsearch API key — per client behind a jump host

A read-only key, created on the cluster:

```json
POST /_security/api_key
{
  "name": "zabbix-monitor",
  "role_descriptors": {
    "monitor": {
      "cluster": ["monitor", "read_ilm", "read_slm"],
      "indices": [
        { "names": ["*"],          "privileges": ["monitor", "view_index_metadata"] },
        { "names": ["logstash-*"], "privileges": ["read"] }
      ]
    }
  }
}
```

Store the answer's `encoded` value in Vault; the client form takes the `path:key`:

```bash
vault kv put secret/elasticpro/<client> apikey=<encoded>
# form: ES API key = secret/elasticpro/<client>:apikey
```

(`logstash-*` stands for the log indices: `{$EP.DEVICE.INDEX}` / `{$ULM.ES.INDEX}`.)

### Log archive check through a jump host

Only for clients behind a jump host that have an archive bucket. The check reads Elasticsearch's
answers from the Zabbix API, so:

1. Create a Zabbix user with **read** on the clients' ULM hosts (e.g. the *Log archive* host
   group), and an API token for it.
2. **Administration → Macros**, two **global** macros (not template macros — a template default
   would hide them):
   - `{$ULM.ZABBIX.API.URL}` — the API as the Zabbix server reaches it,
     e.g. `https://zabbix.example.com/api_jsonrpc.php`;
   - `{$ULM.ZABBIX.API.TOKEN}` — the token, type **Secret text**.
3. The branch field (`{$ULM.ES.BRANCH.FIELD}`, default `branch.keyword`) must be set.

## 7. Each Windows jump host

PowerShell, as administrator:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
curl.exe --version            # Windows 10 1803+ / Server 2019+
```

1. Create the user Zabbix signs in as, e.g. `elasticpro`.
2. Put the Zabbix server's public key (step 3a) in `C:\Users\elasticpro\.ssh\authorized_keys` — for
   an administrator account, in `C:\ProgramData\ssh\administrators_authorized_keys` instead.
3. Allow TCP 22 from the Zabbix server only.
4. If the cluster's certificate comes from a private CA, copy the CA file there (e.g.
   `C:\certs\es-ca.pem`) and choose *Check it against a CA file on the jump host* on the client
   form. *Do not check* is for self-signed clusters only: the API key then goes to whatever
   answers at the ES URL.

On the client form: **Monitored by** = *Windows jump host (SSH), no proxy*; jump host, port, SSH
user, key file (`id_ed25519`), ES API key (Vault `path:key`), ES certificate. The ES URL is the
address **as the jump host sees it**.

## 8. Verify

1. **Cluster Management** opens; existing clients show their Setup checks.
2. On a client page, **Test connection**: every line ✓, or it names what fails.
3. Add or edit one jump-host client. Within a few minutes Setup shows *SSH to the jump host* ✓
   and *Elasticsearch answers* ✓; the ES figures and the Client capacity row fill in.
4. A client with **Alerts** ticked: a warning reaches its cluster DL (**Reports → Action log**
   shows it sent).
5. A client with **Weekly report** ticked: **Reports → Scheduled reports → ElasticPro: <client>
   weekly → Test** — the PDF arrives.
6. Signed in as a Zabbix **Admin** (not Super admin): the page is read-only, with only the clients
   whose hosts that user may read.
7. No PHP warnings in the frontend log (`docker logs zabbix-web-1 | grep -i "php "`, or php-fpm's
   log).

## Rollback

| What | How |
|---|---|
| Modules | copy the folders from `/var/backups/elasticpro-zabbix/<date>/` back, or disable them in **Administration → General → Modules** |
| Templates | re-import the previous versions, or restore the Zabbix DB backup |
| Data folder | restore it from the backup |
| ElasticPro core | `deploy/deploy.sh --rollback` |

Existing clients need nothing undone: the new macros and Zabbix objects (DL user group, user,
action, report dashboard, scheduled report) appear only for clients where the new options were
chosen, and the page removes them when those options are unticked.

## More detail

- `integration/zabbix/clients-module/README.md` — the page, statuses, jump host, alerts and reports
- `deploy/zabbix/README.md` — the Zabbix stack and the ElasticPro side
- `integration/zabbix/README.md` — every module and how they are installed
