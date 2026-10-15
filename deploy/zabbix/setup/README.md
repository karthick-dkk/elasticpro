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
| `zbx_rename.py` | upgrades only: migrates a Zabbix set up under the previous product name — macros, Vault paths, host tags, the masters host group, the per-client alert objects, blank dashboard widgets, a live maintenance, and linking the current master template. Dry run unless `--apply`, and every phase is named separately — see "Upgrading from the previous name" and "Migrating off the previous names" |

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
python3 setup/zbx_rename.py --apply    # rename the macros (all but the ones a formula names —
                                       # see "Macros in formulas" below)
```

It needs no `--host`: nothing it writes contains an address. `--zabbix-url`/`$ZBX_URL` and
`--accounts`/`$ZBX_ACCOUNTS` behave as in every other script here. Run it as often as you
like — the second run finds nothing to rename.

It now also *migrates* the rest, one phase at a time. With no phase flag it reports on
everything, and `--apply` renames the macros and nothing else. Name a phase and only that
phase may write — including `--rewrite-vault-path`, which used to be a special case that
reset the phase set and so renamed every macro on the install as well, unannounced. It now
means the Vault phase and only the Vault phase.

One class of macro the macro phase deliberately does **not** rename, and which phases `--client`
scopes, are below the table.

| flag | phase | what it changes |
|---|---|---|
| *(none)* | — | report on everything; `--apply` does the macro phase only, as before (the Vault-path phase has always needed `--rewrite-vault-path` of its own) |
| `--apply` | — | the only thing that writes. Necessary for every phase, sufficient for none of the new ones |
| `--macros` | macros | `{$EVP.` → `{$EP.`, `{$ESPRO.` → `{$ELASTICPRO.` on hosts, templates and globally — **except** a macro that an enabled calculated item's formula or an enabled trigger's expression still names. See "Macros in formulas" below |
| `--vault`, `--rewrite-vault-path` | vault | `<mount>/elasticvue/…` → `<mount>/elasticpro/…`. Needs `--rewrite-vault-path` to write, whichever way the phase was named. On its own it now means **this phase only** |
| `--groups` | groups | host group `ElasticVue clients` → `ElasticPro clients` |
| `--tags` | tags | `managed-by: elasticvue-clients` → `elasticpro-clients`, and every `evp-*` tag → `ep-*`, in one `host.update` per host |
| `--alerts` | alerts | per client: user group, `evp-dl-<client>` account, trigger action, weekly report and report dashboard, all `ElasticVue: ` → `ElasticPro: ` |
| `--dashboards`, `--widgets` | widgets | dashboard widgets of type `evp_resources` / `evp_capacity` / `evp_volume` → `ep_*`. Gated on the three new modules being registered **and** enabled |
| `--maintenance` | maintenance | a live Zabbix maintenance `ElasticVue: <client>` → `ElasticPro: <client>` |
| `--templates`, `--relink` | relink | links `ElasticPro client master` to each master host. Unlinks nothing. Also needs `--accept-history-restart` |
| `--disable-legacy-items` | (relink) | with the relink phase: sets to Disabled the items and triggers the host **inherits from the legacy template this phase just relinked**, matched by each object's parent id and never by its key prefix. Status only — nothing is deleted and re-enabling undoes it. It is also what releases the macro phase's formula lock |
| `--accept-history-restart` | (relink) | the second hand-made decision the relink needs: the `ep.*` series starts empty |
| `--datadir` | datadir | prints the filesystem move. Never writes, with or without `--apply` |
| `--all` | all of them | every phase. Still needs `--apply` to write, and the relink still needs its own two flags |
| `--phase <name>` | one | the same, by name, repeatable: `--phase alerts --phase widgets`, or `--phase all` |
| `--client <name>` | — | repeatable; scopes the **tags, alerts, widgets, maintenance and relink** phases to one client. The macros, vault, groups, modules and datadir phases are install-wide and say so on every run: a global or template macro belongs to no single client, the Vault phase walks every host's macro values, and the host group and the data folder are one object each |

`--client` scoped four phases and silently ignored the fifth: an operator proving `--tags` on
one client of seven had the tags of all forty-two hosts rewritten. It scopes the tags phase
now, by the host's `ep-client` / `evp-client` tag. A host that carries neither cannot be
attributed to a client, so a scoped run leaves it alone and names it in the summary — run the
phase without `--client` to migrate those.

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

#### Macros in formulas — what this phase will not rename, and why

A Zabbix **calculated** item's formula is text, and the master template's "requested" items are
calculated items whose entire formula is a macro: `ep.devices.purchased` is
`{$EP.DEVICES.PURCHASED}`, and each role's figures are `{$EP.<ROLE>.CPU.REQUESTED}` and its kind
(`MasterTemplate::baseItems()`, `roleItems()`). On the legacy generation of those items the
formula names `{$EVP.…}`. Rename the macro and the formula names a macro that no longer exists:
Zabbix makes the item **unsupported**, and every capacity and shortfall figure on every client
stops being collected — not stale, not wrong, simply never recorded — for as long as the rest of
the migration takes. There is no backfill for a value that was never collected. Trigger
expressions carry macros too: the legacy client-plan template's `nodata()` trigger names
`{$ESPRO.PLAN.STALE}`.

So the phase refuses exactly one class of macro: **one whose name appears in the formula of an
enabled calculated item, or in the expression of an enabled trigger, on any host.** It renames
everything else, which is most of them — `{$EVP.DL}`, `{$EVP.LEAD}`, `{$EVP.CONTRACT.END}`,
`{$EVP.CLIENT.STATUS}`, the jump-host set — so Cluster Management's empty fields are fixed on the
first run. Each refused macro is printed with the items and triggers holding it.

Leaving the *template's* macros alone and renaming only the host's would not have worked: the
host macro is the one carrying the client's real purchased figure and the template's is the
`0 = not set` default underneath it, so the formula would go on resolving and start reporting
**zero**. A guess rendered as a measurement is worse than a refusal.

The way through is to stop those objects first, which is why the runbook below puts the relink
before the second macro run:

```bash
python3 setup/zbx_rename.py --apply --macros     # everything but the formula macros
python3 setup/zbx_rename.py --apply --templates --accept-history-restart --disable-legacy-items
python3 setup/zbx_rename.py --apply --macros     # now the formula macros too
```

A disabled object holds no lock. If the list names an object that is **not** one of the master
template's — a trigger of your own, or a legacy template this script never relinks — nothing here
will disable it: turn it off yourself, or leave that macro on its old name. Both generations are
read by the code either way.

The check fails closed. If the calculated items and triggers cannot be read at all, the phase
renames **nothing** and says so, because an empty scan and a scan this user was not allowed look
exactly alike.

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

`--rewrite-vault-path` on its own now runs the Vault phase and nothing else. It used to reset
the phase set, so this command — documented here, in a section about secret paths — also renamed
every `{$EVP.*}` and `{$ESPRO.*}` macro on the install, which is not what anyone reading this
page had asked for. Run `--apply --macros` when you want the macros.

### Names that are not the script's to change

The module and these scripts create objects named after the product — the `ElasticPro client
master`, `ElasticPro cluster devices` and jump-host templates, the `elasticpro-sync` and
`elasticpro-provision` API users, an `ep-dl-<client>` user and an `ElasticPro: <client>` action per
client that wants its problems mailed. After the upgrade the code looks for the new names,
does not find them, and makes a second set beside the old one. Two alert actions mean two
mails, so look at the list `zbx_rename.py` prints and delete the old half once you are
satisfied the new half is live.

`--apply --alerts` does the five per-client objects for every client at once, instead of
waiting for seven saves — see "Migrating off the previous names" below.

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

## Migrating off the previous names

The modules recognise both generations, so an un-migrated Zabbix works and nothing here is
urgent. This is for retiring the old names once and for all. `zbx_rename.py` does it in
phases; run one, look at it, come back for the next.

Read a plan first, always. Every phase prints, per object, what it is, its current value, its
new value, and whether it is skipped as already migrated. Nothing is written without `--apply`.

```bash
python3 setup/zbx_rename.py --all                   # the whole plan, writes nothing
```

### The order, and why it is this order

```bash
# 0. always runs: the client census, and a twin report (see below)
# 1. the modules, by hand — Administration → General → Modules. Nothing below needs it
#    except the widgets phase, which refuses to run until the three new modules are
#    registered AND enabled.
python3 setup/zbx_rename.py --apply --macros        # 2. the macros — all but the ones a
                                                    #    formula names; step 10 finishes them
python3 setup/zbx_rename.py --apply --rewrite-vault-path   # 3. the Vault paths — read the
                                                    #    order warning above first
python3 setup/zbx_rename.py --apply --groups        # 4. the masters host group
python3 setup/zbx_rename.py --apply --tags          # 5. host tags
python3 setup/zbx_rename.py --apply --alerts        # 6. the per-client alert objects
python3 setup/zbx_rename.py --apply --dashboards    # 7. the blank report widgets
python3 setup/zbx_rename.py --apply --maintenance   # 8. a live maintenance
python3 setup/zbx_rename.py --apply --templates --accept-history-restart --disable-legacy-items
                                                    # 9. the master template — maintenance window
python3 setup/zbx_rename.py --apply --macros        # 10. the formula macros, now that step 9
                                                    #     has turned their items off
python3 setup/zbx_rename.py --datadir               # 11. the data folder, by hand, last
```

**Steps 2 and 10 are the same command, and step 2 does not finish the job.** It renames every
macro the pages read for a *value* and leaves the ones a calculated item's formula or a trigger's
expression still names, because renaming one of those stops the client's capacity collection
dead. Step 9 disables those items and triggers, which releases them; step 10 is the same command
run again, and this time there is nothing left for it to refuse. It is safe to run step 2 as
often as you like in between. See "Macros in formulas" above.

**The refusal is in the script, not in this file** — it is checked against the live install on
every run, so following these steps in the wrong order gets you a refusal rather than a broken
item. What it rests on is the scan being complete: the script locks a macro when any *enabled*
item, discovery rule, item prototype or trigger on a host names it, reading every field of each
rather than a list of field names, so a Zabbix field that expands macros cannot be missed by
going out of date. Two things are outside it by construction — an object that is disabled when
the scan runs and enabled afterwards, and anything outside Zabbix that reads these macros through
the API. Neither is reachable by following these steps, but neither is the script's to promise.

**Step 5 (`--tags`) has no deadline**, and an older version of this file said it did. The claim
was that `Lifecycle::WAS_OFF` had no legacy spelling, so **Clients → Enable** could not see an
`evp-was-off` and would switch back on a host that had been Not monitored before its client was
disabled. `Lifecycle::enable()` tests `ep-was-off` and `evp-was-off` both, and `ownTags()` strips
all four spellings before writing one set back, so Enable turns back on only what Disable turned
off. The phase lists the hosts carrying `evp-was-off`, and nothing about them is urgent. Use
Enable whenever you like.

**Step 5 writes each host's whole tag set in one call**, on purpose. Zabbix replaces a tag set
wholesale; adding the `ep-*` tags and then removing the `evp-*` ones leaves a window where an
interrupted run has a host with *neither* `managed-by` value, `Reconciler::isManaged()` says no,
and the next save un-manages that host for good. Prove it on one client first with
`--client <name>`.

**Step 9 (`--templates`) is the only one that wants a maintenance window**, and only because
of what you do by hand afterwards (unlinking). The phase itself is additive.

### What needs a human, and what the script refuses

* **The five frontend modules.** No API renames a registered module — Zabbix keys it on the id
  in its `manifest.json`. Four steps, printed on every run.
* **The data folder** `/var/lib/elasticvue-zabbix` → `/var/lib/elasticpro-zabbix`. There is no
  API method that moves a file, and the script may be running on a different machine from the
  frontend. `--datadir` prints the exact steps. Do it **last**, with the frontend stopped, with
  `mv` and never `cp`: a partial copy leaves one `.json` in the new folder, `Store::holds_data()`
  then prefers the new folder over the real one, `read()` hands back default roles, and
  `Roles::hash()` no longer matches the live master template — every client then reads as
  "outdated" and a save would rewrite the roles.
* **Taking the legacy master template off a host.** Data collection → Hosts → the host →
  Templates → **Unlink**, never "Unlink and clear". The script prints the line per host and
  refuses the call shape entirely.
* **Twins.** A release before the compatibility layer saw nothing under the current names and
  built a second object beside the live one. Host group, user group, user, action, report and
  maintenance names are unique in Zabbix, so a rename onto a name that already exists fails
  outright: the pair is reported and refused, and the script deletes neither half. If you clear
  a stale twin by hand, the order is **trigger action, then the user, then the user group** —
  Zabbix refuses to delete a user group an action still sends to, and a user an action names.
* **A legacy-named template the uuid says is not ours.** `MasterTemplate::uuid()` hashes the
  product name, so a uuid is the only honest way to tell a template this module wrote from one
  of the site's own that merely shares the name. One that does not match is reported and never
  touched.
* **Anything that could delete item history** is refused structurally, not warned about, and
  there is no flag that turns the refusal off: `host.massremove` in any form, any payload
  carrying `templateids_clear` or `templates_clear`, `host.update` with a `templates` array
  (it *replaces* the link list, so one template missed is silently unlinked and its items are
  stranded at host level), `template.update` renaming a legacy template to a current name,
  `template.delete`, `item.delete`, `trigger.delete`, `configuration.import`, `history.clear`,
  `trend.clear`, `housekeeping.update`, and every other delete.

### Item history: what survives, what does not

**No path carries history across the rename.** The rename changed every item key the master
template generates — `evp.es.storage.used` became `ep.es.storage.used`, and so on for all of
them — and in Zabbix an item is identified by `(hostid, key_)` with history and trends keyed on
`itemid`. A new key on the same host is a new item with empty history. The two generations'
key sets have no member in common; the script checks that before it links anything and aborts
if it is ever untrue.

So the relink is honest about the cost, and asks twice for it: `--apply --templates` is not
enough on its own, it also needs `--accept-history-restart`.

* The `ep.*` series **begins at the instant of linking**. Graphs, the template dashboard, the
  Client capacity report and the shortfall triggers see nothing before that moment.
* The `evp.*` values **are not deleted**. They stay under their own keys, reachable on the
  master host's *Latest data* and through the legacy template's graphs, until the Zabbix
  server's own housekeeping retention expires them. They are not reachable anywhere in the
  ElasticPro UI — the compatibility layer recognises names, groups, tags, macros and widget
  ids, not old item keys. **If months of capacity or log-delay values matter, export them
  before retention takes them.** The script prints the number of items on an old key in its
  preflight, before anything is applied, so the figure is on screen first.
* The relink **unlinks nothing**, so both generations sit on the master host. Their trigger
  *names* are identical and their expressions differ, so every shortfall trigger fires twice,
  to the client's DL. `--disable-legacy-items` sets the legacy inherited items and triggers to
  Disabled — status is the one field editable on an inherited object, it deletes nothing, and
  re-enabling undoes it. That is the only part of the migration that fixes the operational
  harm rather than a name.
* **The legacy "requested" figures keep collecting until you stop them.** Their formulas name
  `{$EVP.<ROLE>.…}`, and the macro phase refuses to rename a macro a formula still names, so
  phase 2 does not make them unsupported — an earlier version of this script did exactly that,
  silently, and froze every client's capacity figures for the length of the migration. They stop
  when `--disable-legacy-items` turns them off, in a window you picked, which is also what frees
  the macro phase to finish (step 10 above).
* **The relink does not light up log delay.** `ep.delay.*` reads `elasticpro.delay[…]` and
  production cluster hosts still push `espro.delay[…]`: those items stay empty until the new
  delay template is imported and the scraper pushes the new key.

### What is irreversible

| | |
|---|---|
| **Item history and trends** | Only ever lost by "Unlink and clear", by deleting an item or a template, or by a `configuration.import` aimed at the old generation. The script refuses all of them, with no override. Nothing in `Store`'s backups holds item values |
| **Collection that stopped** | A value that was never collected cannot be backfilled from anything, which is why the macro phase will not rename a macro an enabled calculated item's formula or an enabled trigger's expression still names, and why `--disable-legacy-items` is scoped to the objects inherited from the template it relinked rather than to a key prefix |
| **`evp-was-off`** | Reversible, and an earlier version of this file said otherwise. `Lifecycle::enable()` reads `ep-was-off` and `evp-was-off` both, so **Clients → Enable** turns back on only what Disable turned off, migrated or not |
| **Everything else** | Reversible. Every write the script makes is a rename, a tag set, a widget type, a template link or a status — all of them undone by making the opposite change |

A rename is also cheap to re-run: every phase compares what is there with what it wants, so a
second run reports "already migrated — skipped" and sends nothing.
