# Changelog

## 0.3.1

The migration's dashboard phase could never run. `dashboard.get` on Zabbix 7.0 rejects
`sortorder` as a `selectPages` field — "value must be one of dashboard_pageid, name,
display_period, widgets" — so the call raised, the phase refused itself, and it reported that
the dashboards could not be read. Page order is the order of the array, which is what
`dashboard.update` reads back, so nothing is lost by not asking for it.

Found by running the migration against a real Zabbix rather than the stub the phase was built
against; the stub accepted the field. With it fixed, the phase correctly identifies the widgets
whose module ids no longer exist and would otherwise render blank.


## 0.3.0

**An install that still carries the pre-rename identifiers now works, and can be migrated.**

The rename in 0.2.0 changed the Zabbix module ids, host tags, template names and macros. An
install created before it keeps the old ones, and until this release the modules could not see
them: Cluster Management listed no clients at all, and the paths that could see a client would
have overwritten it. Two things ship together.

*Recognition.* The modules read both generations and write only the current one — client
discovery, the managed-by tag, host tags, the master and log-archive templates, the cluster and
jump-host templates, the lifecycle status, maintenance windows and the alert routing. Every old
value sits behind a named `LEGACY_*` constant so it can be audited; nothing writes one.

*Refusal.* A client's real settings — requested CPU, memory and disk per role, client type,
jump-host fields, the lead, the cluster DL — live in macros on its master host. Saving a client
whose macros are still of the old generation would have written shipped defaults over them,
recorded the destroyed version as the backup, and had the alert routing conclude the client no
longer wanted alerts and delete its action, DL group, DL account and weekly report. The form now
reads both generations, and the save is refused outright until the macros are migrated, naming
them and the command to run. The jump-host guard that warns about the two incompatible templates
now decides from the template on the host rather than from a macro it cannot read.

*Migration.* `deploy/zabbix/setup/zbx_rename.py` grew from the macro-and-Vault pass into a full
migration: host groups, host tags, alert objects, dashboard widget types, maintenance windows and
the master-template relink, each behind its own flag, dry-run by default, idempotent, and
scopeable to one client where that is meaningful. Every destructive API method is denied
structurally rather than by convention — `templateids_clear`, `configuration.import`,
`item.delete`, `template.delete`, `host.delete`, `history.clear` and the rest are on a deny list,
payloads are scanned recursively before the method is dispatched, and any write not on the
allow-list raises.

Item history is never deleted. Nor is data that was never collected: before renaming anything the
script scans every field of every enabled item, discovery rule, item prototype and trigger, and
refuses to rename a macro that any of them names. That matters more than it sounds — the
device-count item carries macros in its URL and POST body, not in a calculated-item formula, so a
scan that looked only at formulas would have stopped it collecting and said nothing. The relink
is additive (`host.massadd` only); unlinking the old template is left to a person, in a window,
with "Unlink, never Unlink and clear" printed per host.

**Real-world end-to-end tests.** A new `e2e.test.php` — 198 assertions covering read-only tokens,
a Zabbix Admin who cannot read templates (which must not be read as "no templates exist"),
refusals part-way through a save, hostnames that differ from technical names and names at the
length cap, client names where one is a prefix of another, hosts sharing an IP with and without
the merge tick, objects existing under both generations at once, disabled hosts and the
was-off marker, CSV round-trips, short imports that must not delete, and master hosts still on
the old macros.

**Fixes.** Picking an option in a segmented control no longer scrolls the page to the top — a
visually hidden radio still takes focus, and it was positioned at the container origin rather
than under its label. The host picker's row cap applied before filtering, which made search
close to useless on a large install; it is raised, and hosts that are not monitored are marked
rather than hidden, because hiding one made the form promise a new host and then adopt that very
host on save. The volume report no longer writes "+30%" when the configured headroom is
something else, and the window, top-days and headroom settings are editable in the cluster
editor.

**Plan.** `docs/STANDALONE-ZABBIX-PLAN.md` traces every figure in the five modules to its real
source and sets out what standalone operation would cost.


## 0.2.3

**The Zabbix modules now create the cluster template themselves.** Until this release nothing
did. The core finds clusters by template name — a Zabbix host linked to that template *is* a
cluster, and its macros say where it is — but the template itself came from an export each
site happened to have. A fresh install could pair correctly and then fail every sync with
`no template named "Elasticsearch Cluster by HTTP EP" in Zabbix`, pointing at a file the
operator did not have and this repository never shipped.

The Clients module writes it now, through the same Zabbix API it already uses for the master,
devices and jump-host templates, so there is no YAML to import by hand. Its name comes from
the same setting the core searches on, so the two cannot drift apart. It carries every macro
the core reads, each present but empty with a description, so they appear in the host's macro
list as soon as it is linked — empty rather than guessed, because a default of `localhost:9200`
would let a half-configured host point confidently at the wrong cluster instead of failing
visibly. It collects nothing on purpose: ElasticPro polls the cluster directly, so items here
would ask the same questions twice and bill the cluster twice for the answer.

A missing cluster template now reads as `missing` on the Clients page, and the sync error names
the way out instead of only stating the absence.

**The credentials dialog.** Four fixes, all of which showed up on an eleven-cluster fleet:

- With eleven clusters the list pushed **Connect off the bottom of the screen** — the primary
  action could only be reached by scrolling past the whole list. The head and footer are pinned
  now and the list scrolls inside itself.
- It auto-closed only when *every* cluster succeeded, so one cluster needing a different
  credential left it open with no sign anything had worked — and the only way out said
  **Cancel**, implying the credential had been discarded when it had already been applied. It
  now says how many accepted it, and the button reads **Done** once results are in.
- On the hosted edition it offered to store the credential in "the Windows Credential Manager",
  directly above a note saying it is kept on the server. The OS-vault option is desktop-only.
- Four type scales in one dialog (12.5px rows, 11.5px note, 11px inline URLs, under a 13.5px
  body) are now two.

**`tools/mock-es.mjs`** takes `MOCK_CLUSTER_NAME` and `MOCK_CLUSTER_UUID`, so several instances
can stand in for a fleet. Without it every instance called itself `mock` with uuid `mock-uuid`,
and anything keying clusters by uuid — the fleet cache does — treated ten of them as one.


## 0.2.2

Fixes silent data loss when upgrading to 0.2.x. **Anyone who has already deployed 0.2.0 or
0.2.1 over an earlier install should go straight to this one.**

Moving the core onto Alpine in 0.2.0 changed the uid it runs as. Every release before it ran
as uid 999; `adduser -S` without an explicit id picks the first free system id, which on this
base is 100. `/app/data` is a volume that survives an upgrade and its files are mode 0600
owned by 999, so the new core could not read any of them. It found no accounts, no
notification store and no fleet cache, and seeded a fresh admin as though it were a new
install — while the real data sat intact in the volume, unreadable.

Nothing was destroyed by this: the directory is not group- or world-writable either, so the
affected versions could not overwrite what they could not read. Upgrading to 0.2.2 restores
access to the original files, accounts included.

The uid alone is pinned, not a matching gid. 0600 grants nothing to the group, so only the
owner id decides readability, and gid 999 is already `ping` on Alpine — trying to claim it
fails the build outright.


## 0.2.1

Fixes the hosted install, which 0.2.0 broke on any host that cannot reach Alpine's package
CDN from inside a build container.

0.2.0 had `docker compose` build nginx, PostgreSQL and Redis from the one-line hardening
layers in `deploy/images/`. That works on a developer machine and fails on a server: the
first host it was tried on could not resolve DNS from the Docker bridge, `apk upgrade`
exited 99, and the install stopped there with no stack running. Pulling a finished image
has no such dependency, so the three are now built and published by CI alongside the core:

```
karthickdk02/elasticpro-nginx:0.2.1
karthickdk02/elasticpro-postgres:0.2.1
karthickdk02/elasticpro-redis:0.2.1
```

all three linux/amd64 and linux/arm64, and all three still scanning clean at every
severity. The Dockerfiles stay in `deploy/images/` so the images can be reproduced, and
each service takes an override (`ELASTICPRO_NGINX_IMAGE`, `ELASTICPRO_DB_IMAGE`,
`ELASTICPRO_REDIS_IMAGE`) for anyone who would rather build or mirror them.


## 0.2.0

No known vulnerabilities. Every image the hosted stack runs now scans clean with Trivy at
every severity, against a cold cache — core, nginx, PostgreSQL and Redis alike. For
comparison, 0.1.0's core image scanned at one CRITICAL and sixty-one HIGH.

Getting there was not a matter of bumping tags, so the reasoning is written down in
[SECURITY.md](SECURITY.md) rather than only in commit messages:

- **The core runs on Alpine and musl instead of Debian.** The Debian base still carried one
  CRITICAL and sixty-one HIGH *after* `apt-get upgrade`, none of them with a fix available —
  advisories Debian has not patched, which no amount of care in a Dockerfile removes. The
  crypto is `ring` throughout, so there is no OpenSSL to link and the change is a recompile
  rather than a port. The image fell from 191 MB to 38 MB. `curl` is gone, because it drags
  libcurl and OpenSSL back in; the healthcheck posts the same probe with busybox `wget`.
- **PostgreSQL ships as a flattened image.** Every advisory against `postgres:16-alpine` was
  in the bundled `gosu`, a static Go binary no package manager can patch — and 17-alpine and
  18-alpine carry the identical set, so a database major would not have helped. `gosu` is
  replaced by `su-exec`, and the result is flattened into one layer, because deleting a file
  leaves it in the layer below where a scanner still finds it. PostgreSQL itself is untouched
  and still 16.15.
- **nginx, PostgreSQL and Redis are built from one-line layers over the official images**
  (`deploy/images/`), because upstream rebuilds lag the fixes their own distributions have
  already published. nginx moves from 1.27-alpine, which carried two CRITICAL OpenSSL
  advisories, to 1.30-alpine; Redis from 7-alpine to 8-alpine.
- `deploy/vault/` moves from `hashicorp/vault:1.18` (4 CRITICAL / 80 HIGH) to 2.1. Upgrading
  a Vault that already holds data is a migration, not a tag swap — see the note in the file.

`cargo audit` was already clean, and its one documented suppression was re-checked against
upstream rather than taken on trust.


## 0.1.0

First public release. ElasticPro is a multi-cluster Elasticsearch dashboard — a portable
Windows desktop app (Tauri 2 around a small Rust core, with a vanilla-JS UI and no Node.js
anywhere), and the same core and the same UI served over HTTPS on a Linux server. The
application was developed privately before this release; the public version numbering
starts here rather than continuing that history, so 0.1.0 is the first version anyone
outside the original deployment can run.

### The fleet on one screen

- **Clusters** — health, nodes, disk usage, ILM/SLM status, repositories, last snapshot and
  daily indices for every cluster in one table, searchable by name, URL, tag, jump host,
  version or repository, and sortable by any of health, disk, shards, version, last snapshot
  or open alerts.
- **Alerts** — every problem across the fleet on one page, filtered by level and cluster,
  each row linking to the page that answers it, with the open count on the nav tab. An alert
  can be acknowledged and annotated, and the note is kept against the problem rather than
  its current value, so a note written at 86% disk is still there at 91%.
- **Nodes & shards** — heap, CPU and disk per node, unassigned and initializing shards, and
  a **disk balance** verdict that distinguishes a *skewed* cluster, which moving shards
  fixes, from a *full* one, which it cannot — with the requests to run when relocation would
  actually help. Thresholds come from the cluster's own watermark settings rather than from
  Elasticsearch's defaults, which are routinely changed.
- **Live logs** — tail a day's index with a time histogram — and a **log delay** report
  across the selected clusters, which names the clusters it could not measure instead of
  leaving them out of the total.

### Clusters you cannot reach from a browser

- **Its own SSH client.** A cluster marked `via: <jump host>` is reached through an SSH
  connection the core opens itself with your key file, over an in-process SOCKS5 listener on
  loopback — no ssh.exe, PuTTY or external tunnel to set up, and the cluster's hostname is
  resolved on the jump host. Host keys are confirmed once and pinned, and the tunnel
  reconnects by itself.
- **Certificate trust decided in the app.** A self-signed or internal-CA certificate is
  shown once — subject, issuer, validity, SHA-256 — with a Trust button, and then pinned. A
  different certificate at the same address is refused. No CA import and no browser policy.
- **Every failure is named.** Refused, DNS, timeout, TLS untrusted, pin mismatch, jump host
  down — each with a one-line next step and, where a decision is needed, the button that
  takes it. "Failed to fetch" appears nowhere.

### Capacity, retention and backups

- **Volume report** — per-day ingest, what the stated retention actually costs, and whether
  each cluster's storage matches the policy it promises, as one row per cluster with every
  parameter a column. The per-day figure is the mean of the three heaviest of the last seven
  complete days, because a plain seven-day mean under-provisions whenever the window catches
  a quiet weekend or a collector outage; today's index is excluded throughout, since it is
  still being written to. The CSV export is generated from the same column definitions the
  screen uses, so the file and the page cannot drift apart.
- **What the cluster enforces, beside what the config claims.** The applied ILM policy, with
  the age its delete phase removes indices at, and the applied SLM policy, with its
  `expire_after`, schedule and counts. Where the two disagree the report says so — which is
  how retention drift gets noticed.
- **Snapshots & SLM** — the latest snapshots per repository, **which days of data each one
  actually holds** rather than only when it ran, a searchable list of the indices inside any
  snapshot, SLM policies and their last run, and a snapshot-evidence panel built for audits
  (CSV and copy-as-text, with the covered range and its missing days stated).
- **Volume analysis** — daily volume broken down by an ECS field (`tag1`, `src_hostname`, or
  anything named in `volumeFields`), with a value flagged when its latest complete day
  exceeds the mean of the previous seven by more than 40%. A value with no history or a zero
  baseline is never a spike, however large it looks.
- **Unknown is never zero.** Elasticsearch has no API for a repository's total size, because
  a repository is a mount point or a bucket; without `backupCapacity` the report leaves
  *available*, *free* and *Enough backup space?* unset and names the setting that would fill
  them. Where a `_cat` repository listing does not name the indices inside a snapshot, the
  coverage reads "unknown".

### Acting on a cluster, when you mean to

- **Writes are gated twice.** The read-only guard lives in the Rust core and is checked
  before any socket is opened: by default only GET/HEAD and `_search`-family POSTs go out. A
  write needs both a session unlock — never written to disk, gone on restart — *and* a
  request marked as one the operator asked for by hand. Nothing that refreshes on a timer
  can write, even while the session is unlocked.
- **Indices** can be opened, closed, deleted, moved between nodes, given a different replica
  count and put through refresh, flush, clear-cache or force-merge; **snapshots** can be
  created, deleted and restored with index selection and renaming; **repositories** can be
  added, verified, cleaned up and removed.
- **Deleting an index checks the snapshots first.** Only a snapshot in state `SUCCESS` with
  no recorded failure on that index counts as a copy — a `PARTIAL` snapshot may hold a broken
  one, and an `IN_PROGRESS` snapshot has not finished writing it. Indices with no good copy
  are unticked by default. A repository that cannot be read is reported as unknown rather
  than as "not in any snapshot".
- **REST console** — every method, request bar, Query and Results side by side, history with
  favourites, and around 60 grouped ready-made requests. Destructive ones are confirmed by
  name, and the suggestions other pages raise open here prefilled rather than running from
  the page, because most of them change cluster settings and should be read first.
- **Our own load is a number, not a worry.** The core counts every request it sends, per
  cluster, over a five-minute window; a request the guard refused never reached a socket and
  is not counted.

### Running at fleet scale

- **The fleet cache.** The core keeps the fleet's state in a cache and polls it on a
  schedule — health every 3 minutes, nodes every 5, ILM errors every 15, policies hourly, the
  light snapshot listing every 30 minutes — while the browser reads the cache and follows it
  over server-sent events. Each figure carries when it was fetched, and a cluster that cannot
  be read shows its last good value marked stale rather than an empty one. A shared queue
  caps work per cluster, per jump host and overall, and what you open goes ahead of
  background work.
- The cache is held in memory, on disk so it survives a restart, and optionally in Redis
  (the `cache` compose profile) so a second core can share it.
- **The notification store.** A long job — a restore, a snapshot, an SLM run, a shard move,
  an allocation retry — reports as one record from start to finish, and the bell keeps it.
  Hosted, notices are stored per user in the core's data directory, so they survive a reload,
  another browser or a restart; retention is `ELASTICPRO_NOTIFY_DAYS`, default 30 days.

### Where it runs

- **Portable Windows build** — one folder, no installer, no admin rights, nothing written
  outside it. It runs on the analyst PC and on the jump server itself. A `portable` marker
  keeps `config_cluster.json`, `pins.json` and the WebView profile in `data\` beside the exe.
- **macOS and Linux packages** — `.dmg` for Apple Silicon and Intel, and `.AppImage`, `.deb`
  and `.rpm` for Linux x64, each built by CI on that platform. The core, the guard, the
  pinning and the whole UI are identical everywhere; the web view differs, and portable mode
  is Windows-only.
- **Hosted on Linux** — the same core and UI behind nginx in Docker Compose, with one
  published port and an authentication gate in front. The core trusts an `X-Auth-User` header
  that the proxy sets after authenticating, so it must never be reachable except through that
  proxy; the compose file publishes nginx only. Every write is audited as a JSON line on
  stdout with the user's name, and reads are not. A fresh install creates one `elasticpro`
  admin with a password generated for that install alone, written once to
  `initial-admin-password` and deleted after the forced change at first sign-in — there is no
  known first password. Accounts, roles and API tokens are managed in the UI.
- **Snapshot mode** — render every page from a JSON file collected elsewhere, with the
  browser making no network requests at all, so the whole certificate-trust problem does not
  arise. The file is validated before it is trusted, and one containing a credential is
  refused outright. The trade is that it is a point-in-time record: log search, live tail and
  the REST console need a live connection and are disabled.
- **Secrets.** Credentials in the config file are encrypted with AES-256-GCM under a master
  password (PBKDF2-HMAC-SHA512); the Windows Credential Manager, the macOS Keychain and the
  Linux kernel keyring are each optional and opt-in. An SSH key passphrase is asked for in
  the app and never stored.

### Zabbix integration

- **Pair from the two web pages.** After the one-time server steps, ElasticPro issues a
  one-time code and Zabbix redeems it: Zabbix creates the read-only sync user and its token
  and hands the token over in a signed request, ElasticPro allows itself to be framed by that
  Zabbix, and syncing starts. The code works once, expires after 15 minutes, and only for the
  Zabbix address it was made for; signatures are HMAC inside a 60-second window with no
  replays; every change and every refused pairing is audited; and re-pairing rotates the
  token without breaking sign-in.
- **Five frontend modules** — `ep_clients` (Cluster Management: client hosts, their roles and
  the master template), `ep_capacity`, `ep_resources`, `ep_volume`, and `elasticpro`, which
  embeds the dashboard itself. Each release carries them as one archive with its SHA-256 and
  an installer that finds the frontend, whether it is a package install or a `zabbix-web-*`
  container, and keeps a dated backup of whatever it replaces.
- **Templates and a headless scrape.** Four templates sit in `deploy/zabbix/` — the cluster
  template, its alerts, log delay and the client plan — and the master template every client
  host links to is written by the Cluster Management page, on a button press, never on its
  own. `tools/elasticpro-scrape.mjs` evaluates the same automation rules the Automation page
  evaluates — importing that module rather than restating any rule — and prints a document a
  Zabbix HTTP agent item can poll, or lines for `zabbix_sender`. Alert rules therefore fire
  whether or not anyone has the page open.
- **One line installs either side**, from the release rather than from whatever happens to be
  on `main` at the time.

### Interface

- The pages are one row of tabs across the top rather than a column down the left, so a wide
  table gets the whole window. Four themes, including a dark blue one for long sessions.
- No browser dialogs anywhere: every alert, confirmation and question uses the app's own
  dialog or a notice card. A browser pop-up is unstyled, titled with the server's address,
  and blocked inside the Zabbix frame; a test fails if one comes back.
- Destructive actions sit behind a `⋮` menu rather than in the row beside Open and Close,
  confirmations name the action in the button and list what will be affected, and the worst
  cases ask for the count or the repository name to be typed back.
- Every column on the volume report explains itself: where the figure comes from, and whether
  it was measured by Elasticsearch, stated in your config, or arrived at by arithmetic.
- Reports export as CSV, and log delay also as `.xlsx` — written by the app rather than
  fetched, since the UI ships unbundled with no npm and no CDN. Numbers stay numbers so a
  column can be summed, and an unmeasurable delay is an empty cell, never a zero.

### Known limitations

- **The size figures in volume analysis are estimates.** Elasticsearch reports store size per
  index, never per field value, so a value's share of the day's documents is applied to that
  day's index size. The document counts beside them are exact, and the distinction is stated
  on screen.
- **A repository's size has to be asked for.** It is not a number Elasticsearch reports
  cheaply, so it stays behind a *Measure* button — one `_status` call per snapshot — and reads
  "not measured" until asked.
- **None of the binaries are code-signed.** Windows SmartScreen asks on first run, and macOS
  Gatekeeper refuses an unsigned, un-notarised app outright. Checksums ship with the portable
  build, and the whole thing builds from source.
- **One dependency advisory is accepted rather than fixed**: RUSTSEC-2023-0071, the Marvin
  Attack timing sidechannel in `rsa`, which has no patched release upstream. It arrives
  through russh's `rsa` feature — what authenticates to a jump host with an `id_rsa` key. The
  reasoning is in `.cargo/audit.toml` and disclosed in [SECURITY.md](SECURITY.md).
- **Windows is the platform this is deployed and documented for.** The macOS and Linux
  desktop builds exist so the app can be run and developed anywhere, and are less exercised
  in the field.
