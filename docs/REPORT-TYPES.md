# Indices report and Volume by host (0.3.54)

Developer contract for the two report types that replace the operator's own cron scripts
(`es-indice-report.sh` and `es-volume-report.py` v1.2). The build follows this file; where it
and the code disagree, one of them has a bug. Decisions are the user's (2026-11-04).

The existing mailed report (Reports › Exports, `REPORT_*`, docs/VOLUME.md "Reports and mail")
is now the **Volume report** kind. These two are new kinds beside it:

| Kind | What | Sizes | Default schedule |
|---|---|---|---|
| `volume` | the existing workbook (daily, monthly, breakdown) | event_logsize | as today (`UI_REPORT_*`) |
| `indices` | one row per index per day, the script's `_cat/indices` listing | **index store size only** (`pri.store.size`) — the one export that is not event_logsize (user decision) | daily at **08:00**, month so far |
| `hosts` | one row per day × index × source host, with metadata | event_logsize, forwarded size | collection daily at **06:00**; mail daily at 06:00, month so far |

Nothing here writes to a cluster. Every request is a read, under the daily volume run's rules
(Background class, the emergency stop, one collection per cluster at a time) — and, since the
user's change of 2026-11-04, more than one request per cluster under an adaptive controller
and up to `UI_REPORT_CLUSTERS_AT_ONCE` clusters at once ("Concurrency", below).

## Periods

- **Month so far** (`monthSoFar`, new): the 1st of the current UTC month to yesterday (UTC). On
  the 1st it is the **whole previous month** — exactly what both scripts send. Defined once in
  `report/period.rs` and used by both new schedules and by *Run now*.
- The existing periods (yesterday, last 7 days, previous week, previous month, a month, a
  range) are offered for both kinds as well.
- Days are UTC dates, as everywhere: the send time is server local (IST on our stacks), so
  06:00 IST is 00:30 UTC and yesterday is already over — no partial day (the scripts' I1/
  partial-day problem cannot happen).

## Indices report (`indices`)

**Source:** at build time, per cluster, one fresh
`_cat/indices/<indexPattern>?format=json&bytes=b&h=index,status,health,docs.count,pri.store.size,creation.date`.
Fresh every run: a re-run replaces, it never keeps the first figures it saw (the script's
`awk '!seen[$1]++'` over an appended file did).

- An index counts on the day in its name (the cluster's `indexPattern` naming, docs/VOLUME.md
  "Which indices count"). Rollover/ILM and data-stream backing indices count by the date in
  their name when they have one.
- **No date in the name**: listed in their own block *No date in the name* with their creation
  date (UTC), docs and size; not in the day totals, and the block says why.
- **Days in the period whose indices are gone** (deleted by retention): one row
  *indices deleted — from the daily record* with the record's docs and primary size for that
  day (`Day::sizes()`), so the month total is still the month. A day the record does not hold
  either says *not measured*.
- A closed index: its row says *closed* and has no figures (not 0).
- A failed request (timeout, 401/403): the cluster's sheet says so in its first row and the
  mail summary names the cluster; the error body never lands in the file as data.

**Workbook:** sheet *Totals* first — one block per cluster: Day, Indices, Documents, Primary
size (bytes), Primary size (GB), then a **Month total** row. Then one sheet per cluster (name ≤
31 chars, unique): Index, Day, Status, Documents, Primary size (bytes), Primary size (GB),
sorted by day then index. CSV zip: `totals.csv` + one CSV per cluster. GB = 1024³.

## Volume by host (`hosts`)

### Collection

- Runs **every day at 06:00** server local time (`UI_REPORT_HOSTS_AT`, default `06:00`) for
  **every cluster** (user decision: all clusters, not opt-in), for each day of the month so far
  that is not yet held (normally just yesterday; a cluster added mid-month gets its month).
- A day is collected once, after it is over (UTC), and kept: never asked again unless someone
  presses *Run now* with *Collect again*.
- **The day** follows the Daily record's rule (`collect::day_query`: dated indices by name
  day, time-split ones by their time field's UTC day), so a host table's totals for a day equal
  Reports › Daily & monthly for that day — one definition. (The script bucketed by
  `@timestamp`; per-day figures can differ from it by late events, per-index month totals do
  not.)
- **Query:** per cluster per day a `composite` aggregation, sources
  `[ _index (terms), host (terms on the resolved sourceHost field, missing_bucket: true) ]`,
  `size` 1000, paged with `after_key`. Sub-aggs: `ev` sum of the resolved `eventSize` field,
  `sub` sum of the resolved `subSize` field, `m_ev` missing on the eventSize field, and per
  metadata field `terms size 1` (the value most of the host's documents carry). Composite is
  exact and never meets `search.max_buckets` (the script's single query failed whole once it
  grew past it, and its `terms` sizes truncated silently).
- **Bounded:** at most `UI_REPORT_HOSTS_MAX_PAGES` pages per cluster-day (default 2000 =
  2,000,000 rows). Reaching it marks the day `incomplete: true` with the row count; the sheet
  says *incomplete* on that day's rows. Never silent.
- Field names come from the volume field rows (`sourceHost`, `eventSize`, `subSize`, resolved by
  `_field_caps` as today). Built-in candidates gain the script's names:
  `eventSize: [event_logsize, event_log_size]`, `subSize: [sub_size, fwd_log_size]`.
- **Metadata fields:** `UI_REPORT_HOSTS_FIELDS`, comma-separated, default the script's list:
  `parser_tag, fwdtag, fwd_tag, src_ip, tag1, zone, ClientID, ClientName, branch, logtag,
  log_type, observer_hostname`. Each resolves like a field row (`.keyword` when text); one that
  resolves to nothing is a column of *not in the mapping*, named once in the sheet header note.
- **Stored** per cluster per day: `<data>/volume/<cluster>/hosts/<YYYY-MM-DD>.json.gz`, rows
  streamed to the file page by page (production runs under a 1 GB limit — nothing holds a
  cluster-day in memory). Kept `UI_REPORT_HOSTS_KEEP_MONTHS` months (default 3, 1–13), pruned
  with the volume prune. *As built:* gzip with one member per page, one JSON object per line —
  `{"header":{v, day, fields, resolved, startedAt}}`, the rows `{i, h, d, e, s, me, m}`
  (index, host, docs, event bytes, forwarded bytes, docs missing event size, metadata in the
  header's field order), then `{"end":{rows, pages, incomplete, notes, collectedAt}}`. Pruned
  after each cluster's hosts collection (which runs every day for every cluster) rather than
  inside the volume run, which has its own keep.

### ClientID and branch (user decision: same as the script)

- `UI_REPORT_CLIENT_ID_FIELD` (default `ClientID`), `UI_REPORT_BRANCH_FIELD` (default
  `branch`), `UI_REPORT_BRANCH_DEFAULT` (default `DC`).
- In a report, per cluster: a row whose ClientID is missing (`__missing__`, empty, `None`,
  `nan`) takes the **first** non-missing ClientID of that cluster's rows in the period (rows in
  day, index order); a missing branch becomes `DC`. If no row has a ClientID, the Summary uses
  the cluster's name. One function (`fill_client_branch`) used by the workbook, the CSV and the
  view; the stored rows keep what Elasticsearch said.

### Workbook

- Sheet *Summary* first (the script's Monthly_Summary): Cluster, Client ID, Branch, Month, Day,
  Documents, Event size (GB), Forwarded size (GB), and per cluster an **Actual total** row.
- One sheet per cluster: Day, Index, Source, Host, Documents, Event size (GB), Forwarded size
  (GB), then the metadata columns in configured order. `Source` is the index name less its
  date (docs/VOLUME.md), correct for hyphenated names (the script's `parts[-2]` was not). A
  sheet past 1,000,000 rows continues in `<cluster> (2)`, … .
- **No `sub_sizeInGB`**: it was an estimate (host docs × index size per doc), not a measurement;
  event size is the measured figure (user asked which is accurate).
- The xlsx is written **streaming to a file** (rows go to the deflate stream as they are read
  from the day files), not built in memory: `report/xlsx.rs` gains a streaming sheet writer.
- CSV zip: `summary.csv` + one CSV per cluster.

### Run now

- Reports › Exports › *Volume by host* › **Run now**: pick clusters — **at most 5 at a time**
  (`too_many_clusters` refused whole, nothing queued) — and a period (default month so far);
  options *Collect again* (re-ask days already held) and *Mail it*. Missing days are collected
  first, then the file is built. Same queue, per-person and mail limits as `REPORT_RUN`.

### View in ElasticPro (optional, built last)

- Reports › **Volume by host** section (`#/reports/hosts`): cluster (one), day or month,
  search box (host, index, ClientID), sortable columns as the sheet, totals row, server-side
  paging of 200 rows (`HOSTS_QUERY {clusterId, period, q, sort, offset, limit}`), reading the
  day files without holding them. ClientID/branch filled as in the workbook.

## Schedules

- `report-schedule.json` holds one schedule **per kind**: `{volume: {...}, indices: {...},
  hosts: {...}}`; the old single object reads as `volume`. Each has its own enabled, to/cc/bcc,
  cadence, `at`, `period` (`yesterday` | `monthSoFar` | the cadence's own), clusters, subject,
  last sent. Defaults: `indices` daily 08:00 month so far; `hosts` daily 06:00 month so far;
  both **disabled until an admin turns them on with recipients** (a mail is a person's
  decision). The 06:00 host collection runs whether or not its mail is on.
- config.txt: `UI_REPORT_INDICES_TO`, `UI_REPORT_INDICES_AT`, `UI_REPORT_INDICES_SCHEDULE`,
  `UI_REPORT_HOSTS_TO`, `UI_REPORT_HOSTS_AT`, `UI_REPORT_HOSTS_SCHEDULE`, plus the
  `UI_REPORT_HOSTS_*`/`UI_REPORT_CLIENT_ID_FIELD`/`UI_REPORT_BRANCH_*` keys above; each locks
  its setting ("managed by config.txt") like `UI_REPORT_*` today.
- Messages: `REPORT_SCHEDULE_GET/SET` take `kind` (default `volume`); `REPORT_RUN` takes `kind`
  (default `volume`); `REPORT_SEND_NOW` takes `kind`. Audited like today.
- **Mail size:** an attachment over `UI_REPORT_MAIL_MAX_MB` (default 20) is not attached; the
  mail carries the Summary/Totals as text and says the file is in Reports › Exports (kept 7
  days, `REPORT_DOWNLOAD`). The script's 30-cluster workbook would not have fitted a mailbox.

## Isolation and failure

Reports must never slow ElasticPro down or fail half-way.

- **CPU off the request threads.** Page rows, day-file writes and reads, and every report
  file (xlsx, CSV zip — the volume report's too) are made in `spawn_blocking` behind a
  dedicated semaphore (`REPORT_CPU_SLOTS`, default 1, at most 2): a build never occupies
  more than one or two blocking threads and never a worker of the runtime that serves the
  pages (`Core::report_cpu`).
- **Memory ceiling.** `memory.rs` gives reports a share: L/8 of the container's limit, at
  least 64 MiB (128 MiB without a limit). One composite page may answer at most an eighth of
  it; a larger answer halves the next page's size (1000 → 500 → … → 100), and an answer the
  gate refuses as too large is asked again at half the size. Day files are appended a page
  at a time; workbooks stream to `<data>/reports/<job>-<name>.tmp` and are renamed when
  complete. Nothing holds a cluster-day or a workbook.
- **Outbound.** Every hosts and indices request is `Class::Background` through the gate,
  with a per-request timeout (`UI_REPORT_HOSTS_REQUEST_TIMEOUT_S`, default 120) and a pause
  between one partition's pages (`UI_REPORT_HOSTS_PAGE_PAUSE_MS`, default 200). How many are
  in flight per cluster is the controller's (below, "Concurrency").
- **Resume, never restart.** A cluster-day is collected into one `.part` file per partition
  (`<day>.p<k>.json.gz.part`, a gzip member per page) and a checkpoint
  `<day>.partial.json` holding each partition's `after_key`, rows, pages, page size and file
  length, written after every page. A failed page is asked again three times (2 s, 10 s,
  30 s); a restart or a failure resumes each partition from its checkpoint (a page written
  but not checkpointed is cut off). The day file is assembled and renamed into place only
  when every partition's last page is in. A day that still fails is marked failed with the
  reason; the timer takes it up again after 15 minutes, on at most 3 ticks, then it waits
  for a person (*Run now* always tries).
- **A job never fails whole for one cluster.** A cluster that cannot be read is tried once
  more at the end of the job; the file and the mail are still made for the others, the
  cluster's sheet says why in its first row, the Summary/Totals and the mail name it, and the
  job carries `failedClusters: [{clusterId, reason}]` and `warning`. A hosts job running
  longer than `UI_REPORT_HOSTS_MAX_MINUTES` (default 120) stops between pages with that
  reason, keeping its checkpoints; the file is built from what is held and the next run
  resumes.
- **The emergency stop and restarts** apply as for the volume report: a job that meets the
  stop fails (`held`, the schedule gives its period back); a job running at a restart is
  failed by `jobs.json` and a scheduled one is retried once; a collection cut short keeps its
  checkpoints, marked `interrupted`.
- **Progress** for the UI is in the job's `progress`: `{done, total, state, cluster, day,
  pages, rows, retries, clusters: {<id>: {state, day, pages, rows, retries, concurrency,
  partitions: {done, total}, halvings, lastReason, days: {done, total}}}, partitions,
  concurrency, halvings, lastReason}` — the top-level fields are the cluster under way's; every
  job also carries `reportKind` (`volume`, `indices`, `hosts`).

## Concurrency

A report may push more than one request per cluster at a time, under control:

- **Work units.** A cluster-day is split into partitions by index: the day's indices (and
  the open indices split by time) in name order, cut into up to `N` runs balanced by
  `docs.count` from `_cat/indices` (`control::partitions`; `N` is the concurrency ceiling).
  Each partition is its own composite stream with its own checkpoint; partitions of several
  missing days of one cluster run side by side. Runs of names keep the day file in index
  order, which the ClientID fill reads. The indices report stays one `_cat/indices` per
  cluster.
- **The controller** (`control::Controller`, per cluster, pure — it takes `now`): starts at
  `UI_REPORT_CONCURRENCY_START` (default 2), ceiling `UI_REPORT_CONCURRENCY_MAX` (default 4,
  1–8), floor 1. The baseline is the median latency of the cluster's first 5 pages. +1 after
  20 good pages in a row (latency ≤ 1.5× baseline and ≤ `UI_REPORT_PAGE_TARGET_MS`, default
  5000). Halved on HTTP 429/503, `es_rejected_execution_exception`,
  `circuit_breaking_exception` (which also halves that partition's page size), a time-out,
  or a page slower than 3× baseline; `Retry-After` holds every request until it has passed;
  no increase for 60 s after a halve.
- **Cluster pressure.** Before a cluster starts and every 50 pages, one
  `_cat/thread_pool/search?format=json&h=node_name,active,queue,queue_size,rejected`
  (Background): any node's queue over half its size, or `rejected` grown since the last
  look, halves. A cluster red by the fleet poller's cached health (no request of its own) is
  put to the end of the job and tried up to 3 times; still red, it is named as not collected.
  The timer skips a red cluster until a later tick.
- **Clusters at once:** `UI_REPORT_CLUSTERS_AT_ONCE` (default 4, 1–8) for the indices and
  hosts collections; the daily volume run keeps its two. One collection per cluster at a
  time still holds (the volume run's flag is shared).
- **The gate keeps priority.** All of it is `Class::Background`: people's requests and the
  health poll come first, and `ES_BACKGROUND_RESERVE` still holds. The controller's ceiling is
  kept one under the gate's per-cluster cap (`ES_PER_CLUSTER`, default 4 → at most 3 report
  requests per cluster), so a cluster always has a slot for the poller and for people; raise
  `ES_PER_CLUSTER` to let the ceiling reach 8. Background requests are never answered from the
  read cache or joined to another's (0.3.52's duplicate-request rule covers people's reads),
  and every composite page has a body of its own (`after_key`), so neither pages nor the
  thread-pool checks are held back.

## Messages (as built)

- `REPORT_RUN {kind?: "volume"|"indices"|"hosts", clusterIds, period?, format?, mail?,
  collectAgain?}`. `volume` is unchanged (one job per cluster). `indices` and `hosts` queue
  **one** job for the clusters (one workbook); `period` defaults to `"monthSoFar"`; hosts
  refuses more than 5 clusters whole (`too_many_clusters`, EP-217). Reply `{ok, jobs:[Job],
  refused:[{clusterId, reason}]}`. Presets: `"yesterday"`, `"last7"`, `"monthSoFar"`,
  `"previousWeek"`, `"previousMonth"`, `"month:YYYY-MM"`, or `{from, to}`.
- `Job` gains `report: "indices"|"hosts"` (absent for volume), `collectAgain`,
  `failedClusters`, and the `progress` above. Files: `indices-<cluster|N-clusters>-<from>_<to>.xlsx|zip`,
  `hosts-…`.
- `REPORT_SCHEDULE_GET {kind?}` → `{ok, kind, enabled, to, cc, bcc, schedule, at, period:
  "cadence"|"yesterday"|"monthSoFar", clusters, subject, lastSent, managed, timer,
  nextSendAt, mailConfigured, nextPeriod}`, plus `sheets` for volume and, for hosts,
  `collection: {at, fields, keepMonths, maxPages, clientIdField, branchField, branchDefault}`.
  `REPORT_SCHEDULE_SET {kind?, …, period?}` answers the same. `REPORT_SEND_NOW {kind?, period?}`.
- `HOSTS_QUERY {clusterId, period?, q?, sort?, offset?, limit?}` (User; held to the caller's
  clusters, limited admins too) → `{ok, clusterId, period, fields, fill: {clientId,
  branchDefault}, rows: [{day, index, source, host, docs, eventBytes, subBytes,
  eventMissingDocs, clientId, branch, meta: {<field>: value}, incomplete}], total, offset,
  limit, totals: {docs, eventBytes, subBytes}, days: [{day, held, incomplete, rows, notes,
  failed, collecting?}]}`. `sort` is a column (`day`, `index`, `source`, `host`, `docs`,
  `eventBytes`, `subBytes`, `clientId`, `branch`), `-` first for descending; `limit` 1–200; a
  sorted view pages at most 100,000 rows deep.
- The hosts collection's time is the hosts schedule's `at` (locked by `UI_REPORT_HOSTS_AT`).

## What the scripts did that is not carried over

- **Output Elasticsearch copy** — replaced by the history store (fixed ids; the script indexed
  the whole month again every day without ids, so totals multiplied).
- **zabbix_sender** — off in the script's config, and every cluster overwrote the same keys;
  Zabbix reads ElasticPro's figures through the modules.
- **TLS off, passwords in files** — clusters use Cluster Management credentials, TLS checked.

## Acceptance (on the test VM)

Run both scripts and ElasticPro against the same cluster for the same month:
- Indices: every live dated index, its docs and `pri.store.size` match the script's listing
  taken at the same time.
- Volume by host: per index per host, docs and event size summed over the month match the
  script's; per day they match except where documents arrived in an index of another day
  (named, with counts).
- Memory of the core during the 06:00 collection and the hosts build stays within its limit on
  the VM's cluster; the figure goes in the PR.

## Tests

- `period.rs`: monthSoFar on the 1st, mid-month, January.
- Composite paging: after_key loop, missing host bucket, page bound → `incomplete`.
- ClientID/branch fill: first valid by day/index order, `DC`, cluster name fallback.
- Indices: dated, undated, closed, deleted day from the record, request failure.
- Streaming xlsx opens (zip + sheet XML well formed), sheet split at the row limit.
- Schedules: old single-object file reads as `volume`; per-kind due logic; the 5-cluster limit.
- `tools/mock-es.mjs`: hosts data with metadata fields and a composite endpoint; render and
  behaviour checks for Exports and the hosts view.
