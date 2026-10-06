# Zabbix setup scripts

Run on the Zabbix host from `deploy/zabbix/`, in this order. Each is idempotent. They read
the Zabbix Admin password from `stack/secrets/zabbix-accounts.txt` and write every secret
they create to a 0600/0640 file — none is ever printed.

## Tell them which VM they are configuring

`zbx_setup.py`, `zbx_templates.py` and `zbx_phase34.py` need this VM's own address — for the ES
host macro, the Linux host's agent interface, and the note in `zabbix-accounts.txt`. There is
no default baked in (an earlier VM's address used to be hardcoded here, which broke the first
time these scripts ran anywhere else). Give it either way:

```bash
python3 setup/zbx_templates.py --host 203.0.113.10
EP_HOST=203.0.113.10 python3 setup/zbx_setup.py
```

A script that needs it and gets neither exits with an error naming both options, rather than
silently reusing someone else's VM.

| script | does |
|---|---|
| `zbx_setup.py` | replaces the default Admin password, enables the ElasticPro module, creates test users |
| `zbx_templates.py` | imports the cluster and Linux templates, creates the `vm-1 cluster` host with a Vault password macro (or a plain one — see below) |
| `zbx_api_user.py` | `elasticpro-sync`: read-only API role (6 methods), token → `../secrets/zabbix_api_token` |
| `zbx_phase34.py` | `elasticpro-provision` (host creation only), client-plan template linked to cluster hosts, the scraper's ElasticPro token → `../secrets/scraper_token` (a Docker secret for `compose.plan.yml`; an older `scraper.env` is carried over), this VM as a Linux host |
| `zbx_dashboard.py` | the "ElasticPro — Fleet" dashboard |
| `zbx_hosts_check.py`, `zbx_e2e.py` | end-to-end checks: sign in as a Zabbix user, open the module, see what that user gets |
| `zbx_rename.py` | upgrades only: renames the macros a Zabbix set up under the previous product name still carries, and reports everything a script must not rename. Dry run unless `--apply` — see "Upgrading from the previous name" |

Vault comes first: `../../vault/setup.sh`, then `stack/setup.sh` (secrets, TLS, networks,
`up -d`). Run `stack/setup.sh` as root (or with sudo) — the Zabbix images run as uid 1997 /
gid 1995, and it needs to `chown` `secrets/db_password`, `tls/ssl.key` and
`module/elasticpro/config.php` to that user; run any other way, it tells you the exact
`sudo chown`/`chmod` to run by hand instead. See `../README.md`.

## Which Zabbix, which ElasticPro

By default the scripts talk to the Docker stack in `../stack` (`https://127.0.0.1:9443`, Admin's
password from `stack/secrets/zabbix-accounts.txt`) and write ElasticPro-side tokens to
`deploy/secrets/`. To point them at another Zabbix on the same host — a package install, say —
give all of them:

```bash
export ZBX_URL=https://127.0.0.1:8444            # or --zabbix-url
export ZBX_ACCOUNTS=~/zbx-bm/secrets/zabbix-accounts.txt   # or --accounts ("Admin: <pw>" lines, 0600)
export EP_SECRETS_DIR=~/zbx-bm/ep/secrets      # or --secrets-dir (zbx_api_user.py, zbx_phase34.py)
export EP_URL=https://127.0.0.1:18443           # or --ep-url (zbx_e2e.py, zbx_hosts_check.py)
```

`zbx_phase34.py` calls the ElasticPro the module's frame opens, so it needs no `EP_URL`.

## Which templates

`zbx_templates.py` and `zbx_phase34.py` look the base templates up by name. The defaults are
the names in this repo's own export; a Zabbix whose templates are named differently is pointed
at them rather than edited into the scripts:

```bash
export ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE="Elasticsearch Cluster by HTTP EP"   # or --cluster-template
export ELASTICPRO_ZABBIX_ES_TEMPLATE="Elasticsearch by EP"                     # or --es-template
export ELASTICPRO_ZABBIX_LINUX_TEMPLATE="Linux by Zabbix agent -EP"            # or --linux-template
```

`ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` is the same variable the core reads (`compose.hosts.yml`), so
one value keeps the scripts and the running core looking for the same template — give both the
same name or the core syncs nothing.

## No Vault on this box? `--plain-secret`

`zbx_templates.py` sets `{$ELASTICSEARCH.PASSWORD}` as a **Vault** macro by default — that's the
project's decision for real clients (Zabbix's own Secret-text macros are unreadable through
the API, so ElasticPro couldn't read them back). A test box with no Vault fails on that
step. Opt into a plain Secret-text macro instead:

```bash
printf '%s' 'the-es-password' > /tmp/es-password && chmod 600 /tmp/es-password
python3 setup/zbx_templates.py --host 203.0.113.10 --plain-secret /tmp/es-password
```

`--plain-secret` takes a **file path**, never the password itself — it never appears in argv
or an environment variable. The script prints a warning that this is for test installs only;
prefer Vault for anything real.

## `zbx_export_templates_ES_Linux.yaml`

`zbx_templates.py` looks for it in `deploy/zabbix/` first, then the repo root (where it actually
lives — it is not moved for this), and prints which one it used. If neither has it, the
error says so.

## After `zbx_templates.py`: let the core see the new cluster host

Creating the `vm-1 cluster` host in Zabbix does not make it appear in ElasticPro by
itself — the core only picks up Zabbix hosts on its own sync, every five minutes
(`ELASTICPRO_ZABBIX_SYNC_SECS`). Before `zbx_hosts_check.py` / `zbx_e2e.py` (or the app's Clusters
page) can show it, either wait five minutes or, in ElasticPro, go to
**Config → Zabbix → Sync now**.

## Upgrading from the previous name

ElasticPro was called ElasticVue Pro, and the rename moved identifiers that live in your
Zabbix's database, not only in this repository: macro names, the frontend modules' ids, the
action names in URLs, and the Vault path a new cluster host is given. Nothing about the
upgrade is loud — a Zabbix that is half renamed shows empty pages and blank values rather
than errors — so walk the five sections below once per install.

`setup/zbx_rename.py` does the first of them and reports the rest. It is a dry run on its own:

```bash
python3 setup/zbx_rename.py            # what it would change, and what is left for a person
python3 setup/zbx_rename.py --apply    # rename the macros
```

It needs no `--host`: nothing it writes contains an address. `--zabbix-url`/`$ZBX_URL` and
`--accounts`/`$ZBX_ACCOUNTS` behave as in every other script here. Run it as often as you
like — the second run finds nothing to rename.

### Macros — required

The code reads `{$EP.*}` and `{$ELASTICPRO.*}`. Every host and template created before the
upgrade still carries `{$EVP.*}` and `{$ESPRO.*}`, and the macros it asks for are simply not
there: Cluster Management shows a client with no plan, no DL and no contract end, because
"unknown" is what these pages are built to say when a value is missing. `--apply` renames
them on hosts, on templates and globally; values, types and descriptions are untouched, a
Secret-text value included — only the name is sent, so Zabbix keeps a value the API would
never give back.

Two cases it reports and refuses to settle: a new name that already exists with a *different*
value (both macros are left alone — say which one is current and delete the other), and a
pair where either side is Secret text (the API will not return the value, so nothing can
compare them). A macro that names the old product but is none of ours — your own
`{$EVPFOO}` — is listed and left exactly as it is.

### The frontend modules — required

Zabbix keys a module on the id in its `manifest.json` and remembers that id in the database,
so the renamed folders are new modules to it, disabled until someone enables them, while the
old rows stay until their folder is gone:
`elasticvuepro`→`elasticpro`, `evp_clients`→`ep_clients`, `evp_capacity`→`ep_capacity`,
`evp_resources`→`ep_resources`, `evp_volume`→`ep_volume`. No script can rename a registered
module, so this part is done by hand, in this order:

1. **Administration → General → Modules**: disable the five old entries. A module whose
   folder disappears while it is still enabled leaves menu items pointing nowhere.
2. Install the new folders — `sudo bash zabbix-modules-install.sh` for a package install
   or a `zabbix-web-*` container, `install-modules.sh` for the stack in `stack/`. Each
   registers and enables `modules/<new id>`.
3. Delete the old folders from the same modules folder (`/usr/share/zabbix/modules` for a
   package install, whatever is mounted there for the container), then **Modules → Scan
   directory**: Zabbix drops the rows whose folder is gone.
4. Move the Cluster Management data folder: `/var/lib/elasticvue-zabbix` →
   `/var/lib/elasticpro-zabbix`, same owner, same `0770`. It holds the clients, the roles and
   the backups, it lives outside the module folder on purpose (module folders are mounted
   read-only), and it was renamed with everything else — leave it behind and the page opens
   with no clients in it. If PHP names the folder explicitly, the variable is now
   `EP_DATA_DIR` (php-fpm pool: `env[EP_DATA_DIR] = …`), not `EVP_DATA_DIR`.

### Action names in URLs — fix the links you kept

`elasticvuepro.<page>` → `elasticpro.<page>`, `evp.clients.<what>` → `ep.clients.<what>`,
`widget.evp_<name>.<what>` → `widget.ep_<name>.<what>`. A bookmark, a dashboard URL widget or
a saved favourite pointing at an old action opens a page Zabbix no longer has. `zbx_rename.py`
lists the scripts and dashboards that still name one; a favourite lives in its owner's own
profile and is not reachable through the API, so it is re-saved by opening the page once and
starring it again. Re-running `setup/zbx_troubleshoot.py` writes the two host/problem scripts
with the new action — it looks them up by their new names, so delete the old pair yourself.

### The Vault path — optional, and the order matters

A new cluster host is given `secret/elasticpro/<name>:password`
(`crates/elasticpro-core/src/bridge.rs`; the Clients page builds `{$ES.APIKEY}` and the log
archive's S3 key the same way). **Existing hosts need no migration**: the whole path is the
value of `{$ELASTICSEARCH.PASSWORD}`, and nothing reads a prefix out of it — `hcvault.rs`
parses whatever mount, path and key the value names — so a host still pointing at
`secret/elasticvue/<name>` keeps working.

What does not survive on its own is the *policy*. `../../vault/setup.sh` now writes
`zabbix-read`, `elasticpro-read` and `elasticpro-write` over `secret/data/elasticpro/*` only;
before the rename the same policies covered `secret/data/elasticvue/*`. Re-run it against a
Vault whose secrets are still under the old path and the Zabbix server's token loses its
read. So either leave the secrets and the macros alone and keep a policy granting read on
`secret/data/elasticvue/*`, or move them:

```bash
# in Vault, per cluster: copy the secret's keys to the new path, then read them back there
vault kv get -format=json secret/elasticvue/vm-1 | jq '.data.data' \
  | vault kv put secret/elasticpro/vm-1 -
vault kv get secret/elasticpro/vm-1
# only then point the macros at it
python3 setup/zbx_rename.py --apply --rewrite-vault-path
```

That order is the whole point of the separate flag: Zabbix reads the path the macro names, so
a macro moved before its secret is a macro pointing at nothing.

### Names that are not the script's to change

The module and these scripts create objects named after the product — the `ElasticPro client
master`, `ElasticPro cluster devices` and jump-host templates, the `elasticpro-sync` and
`elasticpro-provision` API users, an `ep-dl-<client>` user and an `ElasticPro: <client>` action per
client that wants its problems mailed. After the upgrade the code looks for the new names,
does not find them, and makes a second set beside the old one. Two alert actions mean two
mails, so look at the list `zbx_rename.py` prints and delete the old half once you are
satisfied the new half is live.

The four generated templates are the awkward ones: their uuids come from a hash of the product
name, so **Cluster Management → Write master template** creates new templates rather than
updating the old ones, and the old ones keep the master hosts, the `evp.*` item keys and all of
the history. Which way each client goes — relink to the new template and start the history
again, or keep the old template — is a decision, and the script makes none of it. Of the four templates
this repository ships as YAML (`template-elasticpro*.yaml`, in `deploy/zabbix/`), only
`template-elasticpro.yaml` kept its uuids — re-importing that one renames its items in place
and keeps their history. The other three are generated by `tools/zabbix-{alert,plan,delay}-template.mjs`,
which hash the product name into every uuid, so all of theirs changed: re-importing
`-alerts`, `-client-plan` or `-log-delay` creates a **new** template beside the old one, and the
old one keeps the hosts and the history. That is the same decision as above — relink and start
the history again, or keep the old template — and the script makes none of it.

Last, the settings: `EVP_HOST`, `EVP_SECRETS_DIR`, `EVP_URL` and `EVP_DATA_DIR` are now
`EP_HOST`, `EP_SECRETS_DIR`, `EP_URL` and `EP_DATA_DIR`, and `ESPRO_ZABBIX_*_TEMPLATE` is
`ELASTICPRO_ZABBIX_*_TEMPLATE`. An old name left in a shell profile, a systemd unit or a
php-fpm pool is not an error — it is ignored, and the default is used instead. The template
names themselves carry the marker too (`Elasticsearch Cluster by HTTP EP` and friends): if
your Zabbix still calls them by the old names, point the scripts and the core at them with
`ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` rather than renaming anything, and give the core the same
value or it syncs nothing.
