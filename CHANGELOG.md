# Changelog

## 0.3.37

**Clusters: the band above the table is gone.** The status strip under the tabs (config name, cluster count, fleet health, request rate) and the "Showing cached data … Read all" line no longer show on the Clusters page: the table is the dashboard, and both were in the way of it. The strip stays on Alerts, Automation and the admin pages; the coverage line and Read all stay on Alerts. The Clusters page still asks for what it is missing when it opens, and Refresh reads every cluster on screen again. Nothing in the core changed.

## 0.3.36

**Clusters: an open row lines up with the board.** The summary table centres its figures under their heads; the row that opens under it had inherited that centring, so its tiles, the Repository/Snapshot table and the Nodes table drifted off their heads. An open row now reads left to right as a form: the tiles pack at their own widths across the top (the URL on one line, shortened with the whole address on hover), both tables keep text left and bare figures right, the CPU, Heap and Disk heads sit over their bars, and an SLM policy's name pattern stacks under its name. The summary row's two-line cells (last snapshot, SLM, ILM) sit under their heads as one block. Nothing in the core changed.

## 0.3.35

**Three follow-ups from the Clusters board.**

- **The Clusters page opens worst first.** The default order is now health — unreachable, red, yellow, then green — and within one state the fullest disk first, so the rows to look at are at the top. A–Z by name is one click on the Cluster head away, and the direction button reads "worst first / best first" while health is the sort. Unreachable clusters have no disk figure now, so among themselves they stay A–Z.
- **The "name · yellow" pill is gone from the top bar.** The cluster picker carries a health dot in front of the name instead — green, yellow or red, grey while loading, the state in words on hover. On "All clusters" the dot is the worst state in the picker and the counts pill beside it stays.

Nothing in the core changed.

## 0.3.34

**The Clusters page, as approved on the design board of 2026-10-25.** Seventy comments on the board, every one of them applied; nothing in the core changed.

The list:

- **Search, sort and the health filter sit behind a 🔍 beside the title.** The filter bar above the table is gone. Pressing the icon opens the search box with the caret in it, the Sort by select (every column, both directions), and a Health filter with counts (All, Green, Yellow, Red, and Unreachable when any is). A filter that is set keeps the box open and the icon lit, so a shortened list never looks like the whole fleet. The "N clusters · A–Z by name · updated just now" line under the title is gone; the count is on the end line and in the search box.
- **Columns, Export CSV and Refresh stay out of sight** until the pointer is over the right end of the header or the keyboard reaches them. Their space stays reserved, so nothing moves.
- **Compact, centred rows.** Header and cells are 6 and 5 px tall at the padding, every figure sits under its head, and the cluster name reads left. A click anywhere on a row opens or closes it; the chevron keeps the keyboard.
- **Health is a pill in its own colour** (green, yellow, red; grey while loading) reading the word alone. The reason — unassigned shards, why a cluster cannot be reached — is on hover and read out, no longer in the cell.
- **Disk usage says it counts data nodes** ("56 % · 156 of 279 GB · 3 data nodes": `_cat/allocation` lists the nodes that hold shards, so master-only and coordinating-only nodes were never in the figure, and now the cell says so). The bar is green until the low watermark, amber from there, red from the high one; a cluster whose watermarks have not been read yet is drawn against Elasticsearch's defaults and says so.
- **ILM shows the mode** (running, stopped) with the error count under it in red; hovering the count lists each index with its policy, phase, step and reason. SLM and Last snapshot stack the same way.
- **The top bar lost the "N alerts" button** (the Alerts tab carries the count) and the "updated just now" text. **Every Refresh button now carries a minutes badge** — "0m", "19m", "1h 5m" since the last refresh, the exact time on hover, a spinner while one runs — on the top bar and on the Clusters toolbar alike.
- **The tab row is one line at any width.** Automation, Requests, Accounts and Config sit behind a ☰ at its end, which names the page when you are on one of them.

An open row:

- **Tiles across the top:** Cluster URL (a link, the UUID on hover, a copy button), Jump host (the name; the SSH host, port and user on hover; "direct" when there is none), ILM and SLM, a **shard allocation gauge** (the active share as a half ring, a stacked bar and an inline legend for active, relocating, initializing and unassigned), **ES tasks** ("7 running · 1 > 60s", from `_tasks`), **Search / index rate** (searches and documents per second from two readings of `_nodes/stats` ten seconds apart, shard-level as the hover says), and the **S3 log bucket** named on the cluster (a new optional `logBucket:` on the cluster in the config file and on the cluster form; "not set" until it is). The UUID, Lucene, Credential, path.repo, Active shards, Relocating / initializing, JDK and Our requests tiles are gone — JDK and the request count are still columns (hidden by default) and the nodes table names each node's JDK.
- **Repository/Snapshot** (renamed; the "expensive call" subtitle is gone): Repository, Type (fs grey, s3 orange), Location / bucket, **SLM policy** (which policy writes here, its name pattern and the snapshot it last produced), Snapshots (the names on hover), Oldest, Newest, **Last snapshot status** (Success, Partial, Failed, In progress), Size, and **Manage** (opens the Snapshots page on this cluster) and **Restore…** (the restore dialog for the newest snapshot, for a role that may write). Settings (compress=…) and Measure size are gone; Size reads the Volume report's measurement when every snapshot in the repository has one, and "not measured yet" otherwise — a partial sum is not a size.
- **Nodes** is a table: Node (★ on the elected master), IP, Node ID (hidden by default), **Tier** (Hot, Warm, Cold, Frozen from the node's `data_*` roles, as ILM allocates), **Roles** as coloured chips in Elasticsearch's own names (master purple, data_hot red, data_warm amber, data_cold and data_frozen blue, ingest teal; a `node.roles: []` node reads "coordinating"), Version and JDK apart, CPU, Heap and Disk as a figure with a small bar (the bytes on hover), Load 1m, Shards (from `_cat/allocation`) and Uptime, with a role legend under the table.
- **Show / hide, one panel for every cluster row.** Columns ▾ opens four groups — the cluster table (still reorderable and renamable), the tiles and sections of an open row, the Repository/Snapshot columns, the Nodes columns — plus "Expand details by default". Saved per signed-in person, as the columns already were; Reset to default clears all of it.

Two readings an open row makes for itself (`_tasks`, `_nodes/stats`) are made for that row only, again every 30 s while it stays open, and stop when it closes or the page is left. The disk figure, the shard counts, the nodes and the repositories come from the refresh as before.

Deviations from the board, deliberately: ILM, SLM and Last snapshot stay sortable (the board marked only seven columns, but a sort that worked was not asked to go); the Alerts cell keeps its dash for "none" rather than a 0; the Show / hide panel applies each tick at once instead of waiting for an Apply button.

## 0.3.33

**Ships Zabbix modules 2.1.12.** Nothing in the core or the UI changed.

2.1.11 corrected the master template's empty-role rule but left the template's generation number alone, so Cluster Management told every site the template was current and the correction reached no host. 2.1.12 moves the generation to 6: after this upgrade Cluster Management shows "written for an older version" until **Write master template** is pressed once, which is when the 2.1.10/2.1.11 rules (sums read 0 for a role with no servers; usage items say "No server in this role yet") land on the master hosts.

## 0.3.32

**Ships Zabbix modules 2.1.11.** Nothing in the core or the UI changed.

A correction to 2.1.10's empty-role rule, found on the test Zabbix: the "discard value" handler on the master template's usage items (CPU, memory, disk usage of a role or family) did not heal an item that was already unsupported, and a role that later lost all its servers would have kept its last usage standing as if current. Those items now go unsupported with the reason in plain words: "No server in this role yet: a usage of nothing is not a figure. It reads again when one is added." The sums (allocated, used, requested) keep reading 0. Press **Write master template** once after the upgrade; Cluster Management asks.

## 0.3.31

**Snapshots: the column chooser moved behind a ⋮.** The "Columns · 7 of 9" button on the Snapshots toolbar is gone; a three-dot button in its place opens the same Show columns menu, with the count ("7 of 9 shown · Export CSV keeps every column") in the menu and on the button's label, as the row menus and the Zabbix widgets' toolbars already do. Nothing else on the page changed; sort and the chooser still remember their state for the tab.

**Ships Zabbix modules 2.1.10.** A client whose roles are not all in use no longer carries 60–150 unsupported items on its master host: every role and family aggregate the Clients page writes gets Zabbix's "check for not supported value" step on the empty-set errors only — sums (allocated, used, requested) read 0, the true figure for no machines; averages and ratios (usage) keep no value instead of going unsupported. Cluster-wide figures keep no rule: a client with no cluster host is unknown, not 0. The master template carries `{$EP.MASTER.VERSION}` (5); after the upgrade Cluster Management says it is outdated until **Write master template** is pressed once.

Checked on the test VM this release: the Zabbix → ElasticPro sign-in hand-off, every module page, widget and link (modules 2.1.9 and 2.1.10), the six templates through the live harness, the client-plan scraper feeding plan and alert items to a Zabbix-sourced cluster through the core with an API token, and a cluster password handed over once through Cluster Management reaching both Zabbix and the core.

## 0.3.30

**Ships Zabbix modules 2.1.9.** Nothing in the core or the UI changed.

Modules 2.1.9 is the outcome of a QA pass over every ElasticPro module, template and macro on a live Zabbix 7.0.31: every page, widget, dashboard and link, the Zabbix → ElasticPro sign-in hand-off, and the six templates imported, re-imported and fed with payloads (124 checks, 0 failed). Three fixes:

- **`ElasticPro cluster health`: the two "not enough space for resharding" triggers no longer go unknown on a cluster with one data node.** The stock expression divided by (data nodes − 1), a division by zero with one data node, and Zabbix held the trigger in the unknown state. They now multiply and evaluate only with two or more data nodes.
- **`ElasticPro cluster health`: the daily indices-size check never reports 0 B for an answer it could not read.** An authentication error, a proxy page or a changed listing used to come out as "yesterday's indices are below the daily minimum". The step now fails with the reason, and the item goes unsupported; 0 is returned only when the listing parsed and no index carries yesterday's date.
- **Cluster Management: the client page no longer warns `Undefined array key "full_in"`** when rendered without the storage forecast.

To take the template fix on an existing Zabbix, import `templates/template-elasticpro-cluster-health.yaml` from the modules (Data collection → Templates → Import, update existing); hosts keep their items and history. The automation template a Zabbix set up before 0.3.11 still holds is the old `espro.*` generation: import `deploy/zabbix/template-elasticpro.yaml` the same way (or run `deploy/zabbix/setup/zbx_phase34.py`) so the scraper's `elasticpro.*` keys land.

## 0.3.29

**Snapshot evidence shows snapshot data only, and both the evidence table and the Snapshots list can be sorted.**

- **The evidence panel (Indices in …, and Details) no longer carries the cluster's name card, its address, or the "Evidence generated … by <user>" stamp** — on screen, in Export CSV and in Copy as text alike (`evidenceHeader` is the one definition all three read). Evidence is handed to clients and pasted into tickets; an internal address and an operator's account do not belong in it. The cluster is still named once, in the panel's subtitle and the export's file name.
- **The snapshot facts (taken → ended, duration, shards, indices, data inside) fold behind a thin bar** at the top of the panel, closed by default, a chevron at its left; click to open. The Details view opens with them shown, since they are its point.
- **The evidence table sorts**: click Index, Data date or Shards; click again to flip. It opens on data date, newest first; undated indices stay last either way. The `#` column, Export CSV and Copy as text follow the order shown.
- **The Snapshots list has a Sort select** — Taken, Snapshot name, Status (failures first), Indices, Duration, Data inside, each both ways — and the column headers are the same control: a click on a header moves the select, and the caption says the order ("23 total · sorted by taken, newest first"). Export CSV follows it. The order is remembered per cluster for the tab.
- **A Columns chooser on the Snapshots toolbar** shows or hides any column but Snapshot. Export CSV keeps every column, so hiding one loses nothing from the file. The choice is kept for the tab.

Nothing in the core or the Zabbix modules changed (modules stay at 2.1.8).

## 0.3.28

Zabbix modules 2.1.8 ship with this release. **A new template, `ElasticPro cluster health`, takes over the cluster-health alerts from the old customer-era cluster template**, so that template can be unlinked without losing a value or an alert.

- The template carries the stock Elasticsearch checks under the same item keys: cluster status RED/UNKNOWN/YELLOW, service down and response time, node count up/down, cluster restarted, unassigned and initializing shards, resharding space, the node discovery with its per-node JVM heap, latency, thread-pool and restart triggers, and the daily index-size triggers (`{$INDICES.MAX.SIZE}` / `{$INDICES.MIN.SIZE}`). Connection macros stay with `Elasticsearch Cluster by HTTP EP`; the template declares no credential macro, so the default credential set in Cluster Management keeps applying.
- `zabbix/tools/migrate-templates.py` (modules project) now adopts a same-key discovery rule when the new template is linked, the way it adopts items: same rule id, the rule and its prototypes templated again, the discovered items untouched. It still refuses a host where a prototype would change value type under the same key. Proven on the test cluster: 210/210 item ids unchanged, 46/46 node items, 15 triggers kept their ids, 0 values lost; the old template is unlinked, not deleted, and the journal allows rollback.
- The Roles page, the master import and Cluster Management's Discover know the new slot and link it with the other ElasticPro templates.

Nothing in the core or the UI changed. The template file is `zabbix/templates/template-elasticpro-cluster-health.yaml` in the modules project; the migration map for existing clusters sets `unlink_old: true` and adds the template to `new_templates` (its `docs/MIGRATION.md`).

## 0.3.27

Zabbix modules 2.1.7 ship with this release: the Cluster Management client form (Add client and Edit client) is compact again, with 32 px rows, 8 px gaps and packed columns (Client + Capacity beside Connection + Log archive, Servers full width), so Add client fits one 1440x900 screen with no inner scroll. The page drops Zabbix's 1200 px minimum width for itself only, so a 1280 px window has no sideways scroll. Nothing in the core or the UI changed.

## 0.3.26

Zabbix modules 2.1.6 ship with this release: on Cluster Management's Discover page, a cluster host that has no Elasticsearch URL macros can now be adopted once its URL is typed (the connection macros are set from it before the templates are linked). Nothing in the core or the UI changed.

## 0.3.25

**A trial install's certificate can be verified, and the Docker-path installer ships current modules.**

- **The trial certificate now has a subjectAltName.** It carried only CN `elasticpro.trial`, so any
  client that verifies TLS (curl, PHP, a browser, and since 0.3.24 the Zabbix module's "Verify TLS"
  rule for Cluster Management edit rights) failed with a hostname mismatch, and Verify TLS could never
  pass on a trial install. `deploy/trial-cert.sh` (called by `trial-setup.sh`) now issues it for
  `elasticpro.trial`, this host's name, every non-loopback IPv4 of the host and `127.0.0.1`, with
  basic constraints `CA:TRUE` and a lifetime of 825 days (was 30). `deploy/README.md` says how to
  trust it on the Zabbix host. An existing `tls/` is left as it is; delete it to get the new one.
- **`deploy/zabbix/install-modules.sh` takes all seven modules from `--modules-src`.** It used to
  take four from `integration/zabbix` in this repository, which was stale (so the Docker stack got
  old Cluster Management and widgets next to a current menu module). Without `--modules-src` it
  stops with the clone and checkout commands. It installs `ep_tophosts` and `ep_overview` too, writes
  a `BUILD` file (modules version and commit) into each, and runs `master/import.py` from the modules
  project. The `BUILD` code is shared with the release archive builder (`deploy/zabbix/modules-build.sh`).
- `integration/zabbix` is deleted from this repository; docs and checks point at the modules project.

**Passwords Zabbix keeps as Secret macros now reach the core.**
- New signed `POST /sso/zabbix/cluster-secret`: Cluster Management (Zabbix modules, next release)
  hands over an Elasticsearch password an admin types — a cluster's own, keyed by its cluster host,
  or the default every cluster shares (`"*"`). Signed and replay-proof like the role lookup, answered
  signed, never echoing the password. Kept AES-256-GCM encrypted in `cluster-secrets.json` in the
  data directory, under `ELASTICPRO_CLUSTER_SECRET_KEY_FILE` (set it outside the data directory; a key
  is made beside the file with a warning when it is not). See deploy/zabbix/INTEGRATION.md.
- The Zabbix sync uses it: a Secret macro on the cluster host → that cluster's held password, an
  inherited (global) one → the held default. A cluster whose Secret macro the core was never given
  is "password not set" and is not polled — the 401-every-interval stream is gone for good, and the
  default never stands in for an override. Config → Zabbix names the source ("own, from Cluster
  Management", "default, from Cluster Management", "password not set").
- nginx forwards the new route (POST only, 16 kB); `tools/hosted-check.sh` checks the contract.

## 0.3.24

**The request figures reach Zabbix, a role an admin sets on a Zabbix account stays set, and the
Zabbix menu module comes from one place.**

**Request figures in Zabbix.**
- The core can push what the Request Centre shows to Zabbix once a minute: requests in flight
  and queued per class, how long people wait for a slot (p95), requests turned away by reason,
  answers shared, cached or over the response cap, requests per minute, the poller's mode and
  pause, the memory budgets in use, and the version. It sends one JSON value to the trapper item
  `elasticpro.gate.raw` by `history.push` (Zabbix 7.0+), over the Zabbix API connection the core
  already has. There is no new endpoint and no `zabbix_sender`.
- **Off by default.** Set `ZABBIX_METRICS_HOST` in `config.txt` to the Zabbix host that carries
  the new template *ElasticPro request gate by Zabbix trapper* (Zabbix modules repository). Empty
  means no push and no timer.
- **Aggregates only**: no cluster name, address or URL is ever sent.
- Each push is limited to 20 s. A failure is logged at warn with Zabbix's own reason, and the next
  try waits twice as long, up to 10 minutes. The push runs in a task of its own and never holds
  up a request.
- Signed with the paired token. From Zabbix modules 2.1.2 the pairing role *ElasticPro sync*
  allows `history.push`; an install paired earlier re-pairs once, which updates the role, or
  adds the method by hand. This means the paired token can write to any trapper item in Zabbix,
  since the role is of the Super admin type, though it still cannot change configuration. The
  hardening option is `ELASTICPRO_ZABBIX_METRICS_TOKEN_FILE`: a push-only token, used instead,
  for a user with read-write on the metrics host's group only.
- This writes to Zabbix, not to Elasticsearch, so the two-gate write rule does not apply. Naming
  the host is the opt-in.
- The Request Centre has a *Zabbix* line under the limits, shown only when a host is set: when the
  last push landed, how many were sent and failed, or why nothing is being pushed.
- Answers over the response cap (`response_too_large`) are now counted by the gate (`tooLarge` in
  the Request Centre's data), separately from requests turned away. The Request Centre's figures
  and the pushed ones come from the same functions, so they cannot drift.

**One copy of the ElasticPro menu module in Zabbix.**
- The release's `elasticpro-zabbix-modules-<ver>.tar.gz` takes all seven modules from the modules
  project at the commit in `deploy/zabbix/MODULES_REF`, the `elasticpro` menu module included (the
  project's `embed-module`). ElasticPro's own copy, `deploy/zabbix/module/elasticpro/`, is gone. It
  had drifted: its menu said "Snapshots & SLM" and its manifest 2.1.1, so a normal install showed
  "mixed" module versions in ElasticPro → Settings. Now every module and every `BUILD` file carries
  one version, and Settings shows one "Zabbix modules X.Y.Z · build …" line.
- Modules pin moved to 2.1.2 (`a92188c`). The menu now reads "Snapshots".
- The EP-701, EP-702 and EP-703 codes that only the old copy showed are ported to the modules
  project and arrive with the next modules version after 2.1.2. Until then the ElasticPro page in
  Zabbix shows the same messages without the code (`docs/ERROR-CODES.md` says so).
- `deploy/zabbix/install-modules.sh` (the Docker stack in `deploy/zabbix/stack`, and the older
  package path) needs `--modules-src <modules checkout>` for the menu module, and keeps a
  `config.php` already in the module's folder. `setup/zbx_api_user.py` reads `sync-role.json` from
  the installed module (or `EP_SYNC_ROLE`).

**Pinned roles: an ElasticPro admin's role change on a Zabbix account sticks.**
- Changing the role of an account that signs in through Zabbix pins it. Later Zabbix sign-ins
  keep the admin's choice; scope still follows Zabbix. Before, a Zabbix Admin made Admin here went
  back to Operator at the next sign-in.
- Accounts page: the role editor says which applies. Not pinned: "Follows Zabbix at each sign-in
  (Zabbix Admin → Operator, Super admin → Admin). Changing it here pins it." Pinned: "Pinned here.
  Zabbix sign-ins no longer change it." with **Follow Zabbix again**. The Origin column shows a
  "pinned" pill.
- `USER_UNPIN_ROLE` (admin only) clears the pin; Zabbix's role applies from that person's next
  sign-in. The only working admin cannot be unpinned. Both changes are in the activity log as
  account (iam) events.

**Cluster Management asks ElasticPro who may edit: the role lookup.**
- `GET /sso/zabbix/role`: a read-only, signed question from the Zabbix module, answering an
  account's role, whether it is pinned, and its source (`role: null` for someone ElasticPro has
  never seen). Same secret, HMAC scheme, ±60 s window and once-only nonce as `/sso/zabbix`; the
  answer is signed back over the request's ts and nonce. Rate-limited like the sign-in, logged at
  debug only. No account, session or code is created. nginx forwards it (GET only). See
  deploy/zabbix/INTEGRATION.md, Step 10.

**Zabbix templates: the same in both repositories.**
- The alerts, log-delay and client-plan templates are generated here (`tools/zabbix-*-template.mjs`
  writes `deploy/zabbix/template-elasticpro-*.yaml`) and the modules repository ships copies. The
  automation template (`template-elasticpro.yaml`) is kept by hand in both. Two fixes from the
  modules repository's template audit (2.1.3) are now here as well, so the next regeneration does
  not undo them:
  - The automation template's "scrape has stopped running" trigger is now
    `fuzzytime(...)=0 or nodata(...)=1`. It now also fires when the document cannot be fetched
    at all; before, the trigger only went to UNKNOWN and raised nothing. Its UUID is unchanged,
    so it keeps its events.
  - The log-delay template declares its template group, as the others do. Before, an import on a
    Zabbix whose Templates/Applications group was missing or renamed failed.
- A new unit test checks that every template is byte-identical to the modules repository's copy
  when `ELASTICPRO_MODULES_REPO` points at a checkout of it. When the variable is not set, the
  test is skipped.

**The scraper's push format works.**
- `elasticpro-scrape.mjs --format sender` used to send one key per figure (`elasticpro.scrape.ok`,
  `elasticpro.freed.bytes`, …). The automation template has no items with those keys, and its
  other items are dependent items, which do not take pushed values, so Zabbix rejected every
  value. The format now sends the whole document to the template's master item
  `elasticpro.state`. That item now accepts pushed values (HTTP agent with trapping enabled,
  UUID unchanged), so every dependent and both discovery rules fill as they do when it polls.
  The new macro `{$ELASTICPRO.POLL}` (default `5m`) set to `0` stops polling on a host that is
  only pushed to. A unit test checks every key the format emits against the template.

**Also.**
- TLS libraries updated: rustls-webpki 0.103.16 and webpki-roots 1.0.10 (RUSTSEC-2026-0381 and
  RUSTSEC-2026-0382).

## 0.3.23

**Calmer pages: problems stand out, normal states stay quiet, and the evidence pages show one
cluster and nothing else.**

**Clusters page.**
- Normal is quiet. ILM running, SLM running and a snapshot that succeeded are plain text. Only a
  problem is coloured and has a dot: an ILM error, a failed or overdue snapshot, yellow or red
  health with its unassigned shard count.
- Disk is shown against the cluster's own watermarks: one figure ("56 % · 156 of 279 GB") over a
  bar with a mark at the high watermark. It turns amber past the low watermark and red past the
  high one, and the text says so too. If the watermarks have not been read, or are set as free
  space ("50gb"), the page says they are unknown instead of guessing. The bar, its tooltip and the
  CSV use the same figures.
- Each row has a ▸ at its start that opens the cluster's details. The Alerts cell is a link that
  opens the Alerts page for that cluster only.
- Unreachable clusters are no longer cards above the table. They are rows in their A–Z place,
  tinted red, saying "unreachable · see Alerts", and one line above the table points to Alerts,
  where Retry and Diagnose now are.
- The opened details no longer overlap ("JDK" ran into "SLM" at 1280 px), and the repositories
  table inside them no longer pushes the page sideways. The repositories table also shows its
  column headings again.
- Under Client basis the summary says how many clusters have not been read yet.

**Alerts page.**
- One summary line replaces the four tiles. The critical, warning and acknowledged counts in it are
  filters.
- Unreachable clusters come first, in every grouping, one line each: the full name, why, how long it
  has been down, Retry, Diagnose and Acknowledge, with Retry all and Acknowledge all for the group.
  They appear nowhere else on the page.
- Alerts raised on a cluster before it went down are held under its line, dimmed and marked "not
  current". They are not counted in the bell, the tab, the top bar or the summary.
- A cluster with one alert is one line, with no group header.
- Go to is a plain link, and buttons that were only icons now say Note and More. For an
  unreachable cluster, "Its row on Clusters" in How to fix opens the Clusters page at that
  cluster's row.

**Config → Requests.**
- Each preset says what it sends to your clusters, when nobody is looking and when a page is
  open, worked out from its own intervals and your number of clusters. For example, with 24
  clusters: Client basis sends nothing while nobody is looking; Hybrid at least 8 requests a
  minute (health every 3 minutes for each cluster); Background at least 16 a minute while pages
  are in use, and at least 8 once no page has asked for 10 minutes. These are lower bounds,
  because one check can take more than one request.
- The intervals and the number fields (watch window, how many at once, timeout) are folded under
  **Fine-tune**, with a one-line summary when folded. It stays open or folded the way you left
  it. Under Client basis each interval says it is not on a schedule.
- If `ELASTICPRO_POLL_CONCURRENCY` is set on the server, the page says whether it is what decides
  the number of requests at once, or whether a saved policy sets its own.

**Request Centre.**
- It opens with one line that answers "is everything all right?": quiet, working normally, busy,
  holding back, paused or not known. The limits are shown as labels.
- The request table is easier to scan: times of day, one-line paths you can copy, a tag for each
  kind of request, and a dot and code for the result. Housekeeping is folded to one line.
- **Pause all requests** moved into its own "Stop all traffic" card. What it does is unchanged.

**Evidence pages: Snapshots, REST console and Indices.** These pages are screenshotted as a
client's evidence, so they now show one cluster and nothing about any other:
- No fleet status, alert count, bell, cluster picker or status strip. With "All clusters"
  selected, the page asks which cluster to show.
- A footer names the cluster and says when its data was read and when the page was captured.
  It names the cluster, never its address, and addresses are removed from error messages and the
  console's address line too.
- The console's history lists only that cluster's requests.
- The Snapshots repositories table no longer shows the repository location (bucket or NFS path).
- Notices about other clusters wait until you leave the page.

**Fixed.**
- Disk watermarks are read in Elasticsearch's own order, transient settings first, then
  persistent, then defaults. Persistent was read first before. A watermark set as free space no
  longer falls back to a weaker setting's percentage.

## 0.3.22

**Steady under load: memory that stays inside its limit, one queue for every request to
Elasticsearch, automatic housekeeping, a new Clusters page and Alerts grouped by cluster.**

**Memory.** With many large clusters, 0.3.21 could use more memory than its container allowed
and restart over and over, worst of all just after a restart. The cache now counts what it
really holds, fills itself back after a restart newest first and only up to its budget, and
makes room by dropping the oldest data first (cluster health is never dropped). Its size comes
from the container's memory limit: a quarter of `CORE_MEM_LIMIT`, unless `CACHE_MB` says
otherwise. `CORE_MEM_LIMIT` now defaults to 2g. The core logs its memory budget at start and
warns when `CACHE_MB` cannot fit the limit. With 32 large clusters, the peak after a restart
went from about 1.1 GB to 0.2 GB.

**One queue for every request to Elasticsearch.** Pages, the REST console, the background poller
and the log-delay measurement now all wait in one queue before anything is sent to a cluster:
- Page requests go first, so a busy poller never slows the page you are looking at, and a burst of
  page requests can never stop the health checks.
- At most 24 requests at once in total, 4 to one cluster and 8 through one SSH jump host
  (`ES_CONCURRENCY`, `ES_PER_CLUSTER`, `ES_PER_JUMP_HOST`).
- When too many page requests are already waiting, a new one is refused at once with **EP-214**
  and the page tries again by itself. One that waits too long gets **EP-215**. An answer too big to
  read safely is refused with **EP-216** instead of filling the memory.
- Two people asking the same thing at the same moment share one request, and the same read
  within 5 seconds is answered from memory (`ES_READ_CACHE_SECONDS`). Refresh always asks the
  cluster, and any change to a cluster clears what was kept for it.
- A search nobody is waiting for any more (you left the page, it timed out) is cancelled on the
  cluster. Only ElasticPro's own read searches, never a write and never anyone else's.
- The Request Centre shows what is queued, how long requests wait, what was refused and what was
  shared or answered from memory, and no longer shows requests as still running after they ended.
- Config → Requests shows these limits next to the poller's own settings and will not save more
  than they allow.

**New installs use Client basis.** With no saved request policy, ElasticPro now goes to a cluster only when a page asks (Clusters, Alerts, Nodes, Indices and Snapshots ask for what they show when they open), one request per cluster at a time and four in all; a policy you already saved is untouched, and Config → Requests → Automatic or Background goes back to keeping the fleet fresh in the background.

**Housekeeping.** Once an hour the core cleans up what ElasticPro itself leaves behind: cached
data for clusters that were removed or not looked at for days, their Redis keys, expired API
tokens, old notifications and silences, and (if you ask for it) old rotated activity logs. It never
touches your configuration, saved queries, uploaded keys or accounts. **Nobody is signed out**
unless an administrator sets `SESSION_IDLE_DAYS`. The Request Centre has a Housekeeping card with
the last run, what each job cleaned, a Dry run and Run now. Settings: `HOUSEKEEPING_MINUTES`,
`HOUSEKEEPING_CACHE_DAYS`, `HOUSEKEEPING_DRY_RUN`, `SESSION_IDLE_DAYS`, `ACTIVITY_LOG_KEEP_DAYS`.

**No more "N updates — Apply".** The blinking button in the top bar is gone. New data now appears
by itself 3 seconds after you stop clicking or typing, never in the middle of what you are doing,
and at once when you change page or press Refresh.

**Clusters page.**
- Every cluster list in the app is A–Z, ignoring capitals, with numbers in order (es-node-2
  before es-node-10).
- Unreachable clusters come first as small cards: why, since when, the error, Retry and Diagnose,
  and ▾ for the address, jump host, last answer and next try. **Hide** folds them to one line until
  another cluster goes down.
- The whole list is part of the page, with its column headings pinned under the top bar.
- Every column sorts both ways. **Columns** shows, hides, reorders and renames columns, remembered
  for you in this browser, and Export CSV follows them.
- A cluster's name opens a menu: Edit, Nodes, Repo and Live log for that cluster.

**"Snapshots & SLM" is now "Snapshots".** Same page, shorter name.

**Alerts.**
- Grouped by cluster (or by alert type, or one list). The same alert on many nodes, indices or
  repositories is one alert that lists them.
- **Go to** opens the page that answers each alert with the problem in view. For an unreachable
  cluster, that is its card on the Clusters page.
- **How to fix** gives a likely cause, steps and REST console requests ready to run (never sent
  for you). **Related** shows what else started around the same time and when it happened before.
- The bell shows one entry per cluster when many alerts arrive at once, with a link to that
  cluster's alerts.

## 0.3.21

**Zabbix modules 2.1.1: every ElasticPro widget is fully customizable, with one colour palette.**

No change to ElasticPro itself; this release ships Zabbix modules 2.1.1 and versions them properly.

**Modules are versioned.** All seven Zabbix modules carry one version (now 2.1.1), with tags,
releases and a changelog in the modules repository. ElasticPro pins the exact modules version and
commit, the build checks they match, and ElasticPro → Settings in Zabbix shows the installed
build ("Zabbix modules 2.1.1 · build aec612d"). The modules installer prints the version and
build in its summary.

**Customize every widget.** Client resources, Client capacity, Volume and Top hosts share one
column editor:
- Any built-in figure, any Zabbix item key, or a figure calculated from two items, as a column.
- Now, average, minimum, maximum or change over N days.
- Show it as a value, bar, coloured cell, coloured text, indicators, sparkline or badge.
- Colours from the palette or your own, and thresholds where higher or lower is worse.
- Columns belong to each widget. A new widget starts from the report defaults a Super admin sets.

**Per widget:**
- **Client resources** adds a **Pie chart** view: one donut per client for storage, CPU and
  memory, showing used, free and short against allocated and requested.
- **Volume** reads both generations of the client plan template, so unreachable clusters are
  dimmed and "Updated … ago" works again.
- **Top hosts** is listed as "ElasticPro top hosts". It ranks by CPU, memory, disk, JVM heap or any
  item, by its current value or its 7-day average or maximum, and shows as a list, a table or a
  bar chart.
- **Client overview's Summary view** gains a usage chart, one line per client with Warn and High
  lines.

**One colour palette.** ElasticPro → Settings → Colours sets OK, Warn, High and the other colours
for the Blue and Dark themes, used by every widget. In the Blue theme, Client resources and Client
capacity now use the same colours as the other widgets.

Widgets you already have keep their look. Upgrade the modules with
`zabbix-modules-install.sh --upgrade`.

## 0.3.20

**Zabbix modules: Excel import, and a fully customizable Client overview.**

No change to ElasticPro itself; this release ships the new Zabbix modules.

**Cluster Management → Import is one Excel workbook.** `clients.xlsx` has three sheets: Clients
(with requested capacity), Servers, and a Sample sheet with filled-in examples that the import
ignores. Client type, roles, proxies and the other choices are dropdowns filled from this Zabbix,
and every column header carries a note. Export gives your current clients in the same workbook to
edit and import back. Every row is checked first, and one error means nothing is applied. The old
CSV files are still accepted. No PHP zip extension is needed.

**Client overview widget 2.1:**
- **View: Cards or Summary.** Summary is the overview as it was before. Widgets you already have
  open in Summary, so they look the same after the upgrade; new widgets start in Cards.
- **Cards:** one card per client with its type and contract end, problems by severity (linked to
  Problems), your own metric rows with now and N-day avg, min and max, used of allocated with a
  disk-full forecast, servers by role (down in red), and warnings for stale data, unreachable
  agents and metrics that are not collected.
- **Metrics are yours to choose:** any built-in or any Zabbix item key, which servers and roles to
  read, how to combine them, units, display (as is, bar, indicators, sparkline), thresholds where
  higher or lower is worse, and where a click goes. Up to 20 per widget, in the order you drag them.
- **Layout:** sections on or off and in any order, columns, compact and table density, how servers
  and roles show, which severities count, sort by any metric, top N, and only clients over a
  threshold or with problems.
- **Fixed:** Warn and High no longer show 0. Empty means ElasticPro → Settings, and the form says so.

Upgrade the modules with `zabbix-modules-install.sh --upgrade`.

## 0.3.19

**Dialogs fit, and the Zabbix pages are compact.**

The Defaults dialog, and Add and Edit cluster, no longer need a sideways scrollbar: long choices
pushed their columns past the dialog edge. Every dialog grid now shrinks with the window, fields
fill their column, and Defaults is wide enough to show its choices in full.
`tools/fit-check.mjs` opens every page, about 120 dialogs and the panels in Safari's engine
(WebKit) and Chrome at four sizes, and checks none needs a sideways scrollbar. It passed 1968
checks with none failing. It also found a crash in the Indices volume analysis, now fixed.

**Zabbix pages (modules):**
- **ElasticPro → Settings** is one compact page of cards: each setting on one row with its default,
  explanations behind an ⓘ hint, and one Save bar.
- **Cluster Management** shows one edit icon per client instead of a row of links.
- **The client page** shows the status (Enabled, In maintenance, Disabled, Decommissioned) and the
  actions at the top. Its form uses the full width, without cutting names short.
- **New, "Remove only in ElasticPro":** takes a client out of Cluster Management without touching
  Zabbix. The master host is unlinked from the ElasticPro template (it keeps its data) and loses
  its ElasticPro macros. No host is disabled or deleted, and Zabbix keeps monitoring everything.

## 0.3.18

**Scrolling fixed: lists in panels scroll instead of closing.**

Scrolling inside the bell's notification list or an alert's notes closed the panel on the first
wheel tick, so those lists could not be scrolled at all. Panels now scroll under the wheel and
trackpad. They still close when the page behind them scrolls, but no longer by themselves when a
refresh changes the page height. At the end of a dialog or on its backdrop, the wheel no longer
scrolls the page behind.

`tools/scroll-check.mjs` scrolls every page, list, panel and dialog the way a Mac does, in Safari's
engine (WebKit) and Chrome. It passed 471 checks with none failing.

## 0.3.17

**Security fix: a made-up sign-in name was trusted. Upgrade now.**

nginx passed the name from any `Authorization: Basic` header to the core as a trusted identity,
without checking a password, so anyone who could reach the page could act as any account,
Admin included. nginx now never passes that header on, and the core believes it only when
`PROXY_AUTH_HEADER=true` in config.txt and the request comes from an address in
`TRUSTED_PROXIES` (for an authenticating proxy in front). Until you upgrade, the one-line nginx
change in the release notes closes it.

The "Unexpected token '<' … is not valid JSON" errors that came and went on many pages are gone.
They were nginx's rate limit answering in HTML. The limits are now flood guards only, nginx answers
`/bridge` errors in JSON, the page retries a refused request quietly, and anything that remains
says what it is (EP-606 too many requests, EP-607 core not reachable, EP-608 core too slow).
Addresses in `RATE_EXEMPT_IPS` and the Zabbix `allowedSources` are not counted.

**One settings file: `deploy/config.txt`.** Allowed domains, allowed UI addresses, the listen port,
trusted proxies, Zabbix, logging, performance and the UI defaults, in one KEY=VALUE file.
`deploy.sh --apply-config` checks it and applies it; a normal deploy and `--upgrade` do too. A key
with a value wins, and the Config page shows it as "managed by config.txt". New:
`ALLOWED_UI_IPS` (anyone else gets 403) and `ALLOWED_DOMAINS` (any other host name gets 421).
Secrets and clusters stay out of it. See `deploy/README.md` and `docs/SETTINGS.md`.

`deploy.sh --upgrade` moves a hosted install to the latest release, and `--upgrade=X.Y.Z` to one
release: core, nginx, PostgreSQL and Redis together, pulled before anything changes, put back if
the core is not healthy. `--rollback` undoes all four.

**Zabbix modules:** the release now carries all seven modules from the modules project
(Cluster Management, Capacity, Resources, Volume, Top hosts, Client overview and ElasticPro).
Before, it carried an outdated copy of five. The installer gains `--upgrade` (with an old → new
table), `--remove` (to the backup folder) and `--delete` (for good, after confirming), and says so
plainly when a download turns out to be a web page instead of the script.

Fixes: users' log searches across several indices were refused as writes; inside Zabbix, a
re-sign-in now returns to the page you were on instead of Clusters; "Accepted without checking"
is not shown when certificates are set to insecure on purpose, and every other notice shows once
per change rather than every minute.

## 0.3.16

**Only admins change clusters, every user action in a JSON log, and every error with a code.**

Roles, from Zabbix: Super admin is an ElasticPro admin, Admin is an operator, every other user
is a user. Only an admin writes to a cluster (PUT, POST, DELETE) or unlocks writes. Operators and
users read: GET, HEAD and searches sent as POST, which read-only users could not run in the REST
console before. Users no longer see Automation or Config. Every Zabbix sign-in reads all clusters
by default; `zabbix.scopeUsersByGroup: true` limits Zabbix Users to their groups again.

Security fix: a POST counted as a read when `_search` appeared anywhere in its path, and the URL
parser disagreed about what the path was, so `/_search/../_bulk` reached Elasticsearch as
`POST /_bulk`. A read POST must now end at its read endpoint with only index names before it;
dot segments, backslashes, fragments, percent-encoding and control characters are refused.

Operators saw no clusters when the admin had created the config from the setup screen: it was
written to the data directory while everyone else was served `ELASTICPRO_CONFIG`. New configs go
to `ELASTICPRO_CONFIG`, and an install made before reads the stray copy.

Accounts: admins lock (no new sign-in; also after five wrong passwords, for 15 minutes; the only
admin is slowed to one try per 30 seconds instead) and block (every request refused, nobody signed
out) any account, Zabbix ones included. Access shows as view, operate, manage; each account shows
its last sign-in and failures; Sign-in activity lists every attempt. A role change applies to open
sessions without signing anyone out.

User activity log: every action, reads included, as one JSON line with ECS field names in
`<data dir>/activity.jsonl` (0600, rotated by size) with user, role, source IP, cluster, method,
path, outcome and error code — never bodies, passwords or tokens. Admins see it on Accounts → User
activity; `docs/ACTIVITY-LOG.md` covers forwarding to a SIEM. Set `ELASTICPRO_TRUSTED_PROXIES` so
the source IP cannot be forged; the core warns at startup when it is unset.

Error codes: every failure ends with one, for example `(EP-102)`. The core uses EP-1xx to EP-5xx,
the page EP-6xx, the Zabbix module EP-7xx ("could not keep you signed in" is EP-703). All are listed
in `docs/ERROR-CODES.md`.

Pages: the Clusters page loses the fleet summary box and the two charts at the bottom; alert details
and notices are clamped, and the Zabbix sync notice is one line; Unaccounted on Nodes & shards is red
when the gap is worth a look. The module installer knows the Client overview widget (`ep_overview`).

## 0.3.15

**One switch to accept every certificate, and one notification for what it accepted.**

Certificate checking stays on by default. Config → Defaults → Certificates = insecure
(`defaults.tls: insecure`) turns it off for everything at once: every cluster whatever its own
`tls:` says, every jump host's SSH key, and the Zabbix API. Setting it back to auto brings every
check back, because the switch never pins anything on its own.

While it is on, what it let through that would otherwise have stopped (a certificate the OS store
rejects and nobody pinned, a jump-host key nobody trusted) is listed in a single notification, not
one per cluster, and on Config → Jump hosts & trust with the clusters each one serves. On the hosted
build the core reads the switch from its own config file, never from a page; a file that is missing
or does not parse turns checking back on.

The module installer knows the new Top hosts widget (`ep_tophosts`), which lives in the Zabbix
modules project.

rustls is updated to 0.23.46 for RUSTSEC-2026-0346, -0347, -0348 and -0349.

## 0.3.14

**Fixes from QA on 0.3.13.**

A Zabbix cluster whose credential cannot be read, such as a password in a Secret macro, is no
longer polled. Before, the core asked it for data every interval and got a 401 each time, which is
a failed sign-in against that cluster's account. It stays on Config → Zabbix with the reason and
how to fix it, and the core talks to it once the credential is readable.

The Alerts page and the Clusters summary no longer say every cluster is healthy before any of
them has been read. They say nothing has been read yet, or name how many clusters were read. A
cluster with no data yet is shown as unknown, not as "Cluster unreachable".

The Accounts page says plainly when a cluster's answer is not a list of users, instead of showing
a JavaScript error.

## 0.3.13

**Index template management; saved queries in the REST console.**

The Indices page has a **Templates** view: index, component and legacy templates on the selected
cluster, with their patterns, priority, components and how many existing indices each matches.
Edit them in a JSON editor that checks the required fields, warns about a missing priority or a
pattern that would shadow the built-in data-stream templates, and refuses a same-priority overlap
before Elasticsearch does; create, duplicate and delete them (built-in ones are not offered for
deletion). Every change goes through the write guard and a confirmation. **Simulate** shows what
an index name would get — the winning template, the resolved settings, mappings and aliases —
and is treated as a read. **Compare across clusters** reads the clusters you pick one at a time
and shows each template as the same, different, missing or unreadable per cluster; **Apply**
copies one cluster's version to others, with a result per cluster.

The REST console can **save a query** by name, with a note — on the server, not in the browser,
private or shared with the team. Passwords, tokens and keys are redacted before it is saved, so a
shared query never hands anyone a secret. The Saved queries panel finds, opens (in a tab of its
own), shares and deletes them; only the owner or an administrator of the whole install changes
one.

## 0.3.12

**REST console tabs; the version lives on the Config page.**

The REST console opens up to ten tabs, each with its own request and its last response,
and remembers them across reloads — with every password, token, key and pasted
Authorization value redacted first, in the body and in the path, so no secret is kept in the
browser (the redaction reads keys the way a JSON parser does, line by line for `_bulk` and
`_msearch` bodies). `+` or Alt+T opens a tab, double-click renames one, and a request handed
over from another page opens in a tab of its own instead of overwriting what was being typed.
Console history is redacted the same way.

The app's version is shown in one place: Config → Diagnostics → App version. The status strip
and the About dialog no longer carry it.

## 0.3.11

**Built for 100+ clusters; alerts tuned; nobody is signed out on their own.**

**Sessions never end by themselves.** Every restart of the core used to sign everyone out
(sessions lived only in memory), and an 8-hour idle timeout signed out the rest. Sessions
now live on the server (`sessions.json`, 0600, token hashes only) with no idle timeout; a
session ends when the person signs out, or when an administrator removes, disables or
demotes the account or changes its password. And no secret is kept in the browser: the
session travels only as an `HttpOnly; Secure; SameSite=Strict` cookie no script can read —
nothing is written to localStorage or sessionStorage (inside Zabbix's frame the token stays
in page memory, as Zabbix signs the frame in on every load). The REST console's history no
longer keeps a request body's password, token or key.

**Calm at 100+ clusters.** Measured with 120 clusters: the core sent ~397 requests a minute
in background mode; the new shipped request mode `auto` — background up to 25 clusters,
hybrid above — sends ~75. An existing policy that names a mode keeps it. The Automation page
no longer reads the fleet when it opens (it sent 225 reads); the coverage bar's "Read all
(one at a time)" does. On "All clusters" above 20 clusters, each cluster's snapshot section
starts folded. Above 30 clusters the top bar has a find-as-you-type box beside the picker.
Every page fits a phone (375 px) with no sideways scroll.

**The Clusters page summarises the fleet in one box**: health counts with unreachable and
red clusters named, open alerts by level, the three problems that recur most (grouped by
rule, not by title), and how fresh the data is, with Read all.

**Alerts, tuned.** One fault no longer raises two or three rows: a node at the flood stage is
one row with the cluster average folded in; unassigned shards are said once; a failing or
stale repository is raised once, not again per SLM policy; many field-volume spikes on a
cluster are one row with the count; a reading older than its dataset allows says how old
it is. The disk rule has hysteresis (cleared two points below its threshold), a snapshot
repository is critical only when runs keep failing, and a master re-election on a green
cluster is a warning. "Open" now means neither acknowledged nor silenced in every count.
**Silences**: silence a cluster for maintenance, or one alert, for 1 h to 7 days or until
removed, with a reason — shared by the team, kept on the server, audited, and limited to
the clusters each person may see.

**Zabbix**: the sync finds cluster hosts on any template of the "Elasticsearch Cluster by
HTTP" family (an earlier-generation template read "0 cluster hosts" before), reports the
templates it read, and names the hosts it left out and why. Inside Zabbix's frame the tab
row wraps instead of hiding its first tabs.

## 0.3.10

**Request management: a quiet UI, a request policy, a Tasks panel, and a cap on the poller's appetite.**

The felt problem — the page repainting under whoever was reading it, all day, on a large
fleet — is gone by default. A redraw gate holds what the core pushes behind an
"N updates — Apply" pill and applies it by itself once the page has gone a minute untouched
(`defaults.liveRedraw`: `pending`, `live`, `manual`); Live logs, the REST console and the
Request Centre, which are the stream, pass through. The app opens on the cluster last
chosen in this browser rather than on "All clusters" (`defaults.defaultScope`).

**The request policy** (`<data dir>/policy.json`, Config → Requests, `POLICY_GET` /
`POLICY_SET`) decides when the poller goes to the clusters and how hard: mode
`background` (the shipped default — an untouched install behaves as before), `hybrid`
(health in the background, the rest only while a page looks) or `on-demand` (nothing on its
own; a page's ask sends exactly what it shows, for that cluster — with one request per
cluster at a time under the "Client basis" preset); per-dataset intervals; concurrency
global / per cluster / per tunnel; the watch window; the poller's timeouts (longer through a
jump host); a soft budget of requests per cluster per minute; and pause — all clusters or
one — from the Request Centre. Applied without a restart. A 429 or a timeout backs a
cluster off for a minute, doubling to ten, until it answers; the Request Centre says
"throttled: budget" or "backing off" and why.

**Fleet pages state their cost up front.** Clusters, Alerts and the Volume report open on
what the cache holds and say so — how many clusters, the oldest age, how many never read,
stale or unreachable — with "Read all (one at a time)": cluster by cluster, one request in
flight, cancellable, visible as it goes. Opening a page reads nothing. Alerts says
"current for N of M clusters".

**Tasks.** The Request Centre reads the chosen cluster's running searches on a button and
tells ours (by the `X-Opaque-Id`, naming the page that asked) from everyone else's; Cancel
is `POST _tasks/<id>/_cancel` under both gates — the write guard, then a confirmation that
names the task — audited like every write. A 403 is explained in the privilege's name.
Leaving a page lets go of its requests still waiting on a slow cluster (`ABORT_REQUESTS`):
they answer "aborted" instead of running to their timeout; the poller's never do.

Also: the request log records who asked; the CSV export writes any cell a spreadsheet would
run as a formula as text; `REQUEST_LOG` and the Requests page are administrators'.
See docs/HANDBOOK.md, "Request management — the message contract".

## 0.3.9

**A Request Centre: every request the core sends, who asked, how it went.**

The core keeps a record of each request to a cluster — the poller's and the pages' alike —
with its origin, timing and outcome: what is in flight now and the last 2,000 finished. The
new Requests page (users and up) shows them, in flight first with elapsed time, then newest
first, with cluster / origin / outcome / slower-than filters, per-cluster totals and a CSV
export; it reads the core's log and nothing else. Each request also carries an
`X-Opaque-Id` (`elasticpro/<install>/<origin>/<cluster>/<n>`), so a query of ours can be found
in a cluster's task list and told from anyone else's. The "Requests N in 5m" figure in the
status strip links to the page.

Pages are now told when they are left: Live logs stops its tail on the way out, as it had
asked to and never was.

## 0.3.8

**The Config page stays still.**

It redrew itself on every fleet event and re-ran the open tab's loader each time. With
thirty-odd clusters that is every couple of seconds: the Jump hosts & trust tab asked the
core for its tunnels and pins again and again, the Zabbix tab never finished loading, and
a URL being typed into a form was wiped mid-word. A tab now loads once per visit, and a
fleet event changes only what fleet data changes on that page — the cluster-state pills,
updated in place.

## 0.3.7

**Two pages stop contradicting themselves.**

Snapshots: before the repositories had been read, or when the cluster could not be reached,
the page was headed "Snapshots in —" over "No snapshots in this repository" — an unknown drawn
as an empty result. The title names a repository only when there is one, and an empty listing
says what is actually known: a search that matched nothing, a cluster that could not be read
and why, repositories not read yet, a cluster with no repository, or a repository that is
genuinely empty.

Live logs: when a search found documents but the cluster sent no time buckets, the chart said
"No documents in this range" above the list of those documents. It now says the histogram
could not be drawn and that the list below is complete; "No documents in this range" is kept
for a search that found none. The fixture cluster, which answered every log search with hits
and an empty histogram, buckets them now.

## 0.3.6

**"Continue without credentials" is remembered, and the credential dialog is readable in the dark theme.**

A cluster connected without a credential on purpose asked for one again on every page load.
The page re-reads a config file that never records that choice, and the core — which did keep
it, as an empty header — never said so. The PRIME reply now lists those clusters (`anonymous`)
beside the ones it holds a credential for (`held`), and the page stops asking.

The dialog's type selector (Username & password / API key / Bearer token) marked the chosen
tab with a bare class the stylesheet does not dress, which on the dark theme left its label
as dark text on a dark background. It is `aria-pressed` now, like every other segmented
control. The dialog also names the config file actually loaded instead of `clusters.yaml`.

## 0.3.5

**Notifications sit at the bottom right.**

Toasts used to stack under the header at the top right, where they covered the page's
own title row and the first line of whatever was being read. They now rise from the
bottom-right corner, newest nearest the corner, and nothing is measured to place them:
the stylesheet pins the corner, so a header that wraps to two rows no longer moves them.

## 0.3.4

**A fresh install signs in as `Admin` / `elastic`.**

The first account used to get a password made for that install alone, left in a file inside
the volume and forced to change at first sign-in. It is now the same on every install — `Admin`,
password `elastic`, like Zabbix's own `Admin`/`zabbix` — and usable at once: change it on the
Accounts page whenever you choose. Until it is changed, anyone who reaches the sign-in page has
the account, and the core warns on every start it still opens with the shipped password. The
shipped password is below the 10-character minimum on purpose, so once replaced it cannot be
chosen again. `ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE` still starts the account with a password of
your own; the `initial-admin-password` file is gone. Installs that already have accounts are not
touched — they keep the accounts they have, under whatever name.

A refused sign-in no longer empties the user-name field.

## 0.3.3

**Templates are mapped on the Roles page, and chosen rather than typed.**

Cluster Management named ten Zabbix templates. Two of them — the Elasticsearch cluster
template and the Linux agent one — could be pointed somewhere else from the Roles page; the
other eight were spelled out in PHP, so a Zabbix that called any of them something else could
not be made to work without editing the source. All ten are now slots in one table
(`Roles::TEMPLATE_SLOTS`), and the table is what the store, the save path and the page all
read, so a slot added there needs no second list kept in step.

Each row is picked from this Zabbix's own templates, never typed: a searchable select for the
slot, and Zabbix's template picker for a role's templates and for the extra names a slot
should also answer to. Nothing is spelled by hand, so a name cannot be a space out of place
and silently match nothing.

Each row also says what was found: how many hosts carry that template, whether this page
wrote it, or that no template answers to the name. One case is refused outright — mapping a
template this page *writes* onto a name another template already owns. `configuration.import`
matches by uuid and will not take a name belonging to another object, so that mapping fails
permanently; it used to fail at install time, long after the operator had left the page,
naming a template they had never touched.

A slot may also be given extra names, recognised and never written. That is the half a single
name cannot express: pointing a slot at an older spelling would make everything created from
then on carry the older spelling too, where naming it here leaves the mapped name
authoritative and still finds the hosts that predate it.

Two slots this page writes may not share a name, because Zabbix keeps hosts and templates in
one namespace where a name is unique. Slots it only looks for may share one, and so may any
number of roles: a server in two roles that name the same template is linked to it once.

A stored template name that this Zabbix no longer has is kept and shown beside the picker
rather than dropped. The picker works in template ids and cannot hold such a name, so without
this, opening a role and pressing Save would have quietly discarded a template that had merely
been renamed elsewhere.

**Bars on the numbers.**

Client capacity and Client resources draw a bar beside any figure that has a usage percentage
behind it, under a new Display setting: bar under the value (the default), bar in the cell,
segments, or numbers only. The bar is CSS — one element per cell, no chart library, no SVG, no
canvas, no per-cell JavaScript — so a table costs very nearly what it cost before.

The bar is drawn from the same figure the cell's colour was chosen from, and the thresholds
stay the per-client `{$EP.USAGE.WARN}` and `{$EP.USAGE.HIGH}` macros, so the colour and the bar
cannot tell different stories. A figure Elasticsearch did not report draws no bar at all: a bar
of zero length reads as nought per cent, which is a measurement nobody made.

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
