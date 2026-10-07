# Changelog

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
