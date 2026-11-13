# Reports (0.3.53)

Developer contract for the page that replaces **Volume report**. The approved design is the
canvas "ElasticPro Reports" (boards 1 to 10, approved 2026-11-04). This file says what each part
does and where each figure comes from; the build follows it. Where this file and the canvas
disagree, this file wins and the difference is a bug in one of them: fix it.

## Principles

- **One size: `event_logsize`.** Every size on Reports — tiles, tables, charts, per-day rate,
  planning input — and every export (CSV, XLSX, report layout, mailed and generated reports) is
  the sum of the `eventSize` field (`event_logsize` by default) from the daily record. Index
  store size appears in one place only: the Measure size comparison. The per-day rate is
  defined once (`core/volume-daily.js`, `perDayEventBytes(record, days)`) and every caller uses
  it; the old index-list rate (`dailyVolume()` in `core/volume.js`) is no longer shown.
- **Disk means data nodes.** Every disk total, used and free on Reports counts only nodes
  whose `roles` include a data role (`data`, `data_content`, `data_hot`, `data_warm`,
  `data_cold`, `data_frozen`), filtered explicitly by role from the node list joined to
  `_cat/allocation`. One function (`dataNodeDisk(data)` in `core/volume.js`); the Clusters page
  and Play keep their current figures unless they already mean data nodes.
- **Unknown is not zero.** A figure that cannot be read says *not measured* / *not set* /
  *needs a policy* in amber and, where a setting would fix it, names it. A planning value not
  set in a template says `[set]` and totals leave it out and say how many they left out.
- **Compact density**, 32 px rows, ElasticPro tokens (`ui/css/app.css`). No new colours.

## The page

- Tab label **Reports** (was *Volume report*). Route `#/reports`, sections
  `#/reports/overview` (default), `/daily`, `/capacity`, `/measure`, `/planning`, `/exports`.
  `#/volume` and `#/volume/...` keep working (alias to `#/reports`), so the Zabbix menu entry
  `elasticpro.volume` and saved links still open the page.
- Header: title *Reports*, subtitle "What each cluster takes in, what it keeps, and whether its
  storage holds it." Section nav in this order: **Overview · Daily & monthly · Capacity &
  retention · Measure size · Planning · Exports & schedules**.
- Reports is an evidence page like Indices/Snapshots: the cluster chooser shows; Overview,
  Capacity and Measure are fleet-wide (one row per cluster), Daily & monthly is one cluster.

### Overview (board 1)

- Five tiles: *Ingested yesterday* (event_logsize, all clusters, with ▲/▼ % against the 7-day
  average), *7-day daily average*, *Month so far* (days counted), *Disk runs out within 6
  weeks* (clusters, "data-node disk · N within 2 weeks"), *Backups that do not fit* (with
  "N not measured · set backupCapacity").
- Two cards: *Daily volume* (stacked bars, 30 days, top 5 clusters + the rest) and *How long
  the free disk lasts* (data nodes only, at each cluster's 7-day rate; red < 2 weeks, amber < 6
  weeks, green, grey = not measured).
- *By cluster* table: Cluster, Type (CI/DI/On-Prem), Yesterday, 7-day avg, vs avg, Month so
  far, Data-node disk used, Disk lasts, Live retention (fits / short by / not set), Backups,
  link to Daily. Columns menu (below) and Export CSV.
- No freshness strip, no "today not final" pill, no Read-all button on this section.

### Daily & monthly (boards 2, 3) — moved from Indices › Summary

- The Indices page loses its *Summary* tab (Indices | Templates remain) and shows one line:
  "Daily and monthly summary is now in Reports › Daily & monthly ›" (board 7).
  `ui/js/ui/volume-summary.js` moves under the Reports page; its state, polling and collection
  rules are unchanged (docs/VOLUME.md).
- Controls: Daily | Monthly, Source, Average over, Collect now, Export CSV. No source line
  (no "Indices logstash-* · day from…"), no table captions.
- **Collect now** (`ui/js/reports/collect.js`, the one definition, also behind Measure size):
  `VOLUME_RUN` answers at once and the collection runs on the server. The page says what the
  answer was — collecting (with the run id), already collecting (that run is followed), collected
  less than a minute ago, unreachable, the emergency stop, not one of your clusters — and follows
  the run in `JOBS_LIST {jobId: "volume.daily"}` every 3 s for as long as it runs (at most two
  hours), whatever page is open; the toolbar shows the cluster's days done of total. When it
  ends: *Collection finished · N days searched*, or failed / deferred / cancelled with the run
  log's error and *Try again*. A run the caller may not read in the run log (it also covers a
  cluster they do not see) is followed through the cluster's own status. A run already going
  when the section opens (the timer's, another person's) is followed too.
- **An empty record says why** (`core/volume-daily.js recordEmptyWhy`, the one definition for
  Daily and Overview): a collection running (days done of total), no index of the chosen source
  in these days, never collected (and when the timer runs), the last collection did not finish
  (its error, and where the record ends), no index matches the pattern (with skipped names), or
  every matching index older than the window ("the record ends on …"); on Overview also
  "event_logsize is not measured on this cluster". Never only "nothing recorded".
- **A source chosen on another cluster** (or another visit) that the cluster shown has no index
  of in these days is not kept as a filter that empties the page: Daily shows all sources and
  says "Source X has no index on <cluster> in these days: showing all sources".
- Daily: four tiles (Yesterday, 7-day average, Peak day, Month so far — all event_logsize,
  docs in the detail line), *Log size per day* line chart with 7-day average, *Day by day*
  table: Day, Indices, Documents, event_logsize, vs 7-day avg, Status (final / today so far /
  "N of M shards failed · asked again" / not measured).
- Monthly: *Month by month* (Month, Days, Documents, event_logsize with a mini bar, Peak day,
  vs previous) beside *Breakdown* (By field, Period, Top N, Export CSV; horizontal bars with
  share %, "N other hosts", "no <field>"). No explanatory note under the breakdown.

### Capacity & retention (board 4)

One table, *Storage plan*, one row per cluster, a grey group band (**Live** / **Archival /
snapshot / backup**) over the headers, hidden when a reorder mixes the two groups.

| Column | Definition |
|---|---|
| Cluster | always first, cannot be hidden |
| Per day | event_logsize per day, 7-day average |
| 30% buffer | per day × (1 + `volumeHeadroomPercent`/100), default 30 |
| Live retention | days of live indices held now (oldest live index, or ILM delete age) |
| Live retention policy | `liveRetention` set on the cluster by a person, shown as typed; *not set* in amber |
| Live disk (data nodes) | horizontal bar used/total, **bold %** next to the bar, label "4.75 TB of 5.20 TB, 0.45 TB avail"; red > 90 %, amber > 80 %, blue |
| Required live disk | per day × policy days × buffer; *needs a policy* when no policy |
| Live disk shortfall | required − total; amount in red, *none* in green |
| Backup policy | `snapshotRetention` (and ULM bucket for CI/DI: "ULM · S3 · 90 days"), as typed |
| Backup disk (repository) | bar: repository size against `backupCapacity`; ULM → *in S3*; no capacity → *not measured · set backupCapacity* |
| Required backup disk | per day × backup days × buffer |
| Backup disk shortfall | required − total; *none* / amount / *ULM · S3* / *not set* |

- The *Plan / Every parameter / Client plan* switch stays above the table.
- **Columns menu** (also on Overview's By-cluster table): tick to show/hide, drag handle and
  ▲/▼ buttons to reorder, Cluster locked first, *Reset to default*, *Save for everyone*
  (shared layout through the existing `VOLUME_LAYOUT_GET/SET`, new tables `capacity` and
  `overview`; an operator arranges once for everybody, as for the daily/monthly tables).
  CSV follows the columns on screen.
- No "Will the indices fit?" / "Will the backups fit?" cards, no per-cluster detail row.

### Measure size (board 9)

- Period (Last 7 days | Last 30 days | Yesterday), *measured N ago*, legend, **↻ Measure
  size** (sends `VOLUME_RUN` for the clusters shown, the same as Collect now; it never sends a
  new kind of request).
- *Per cluster*: Cluster, Index size per day (`priBytes` of the record's days, averaged),
  event_logsize per day (`eventBytes`, averaged), Difference (index − event_logsize, signed),
  Ratio (index ÷ event_logsize, 2 decimals), two thin bars (blue index, orange
  event_logsize). A cluster without the field: *not measured · field not in mapping*.
- *<cluster> · day by day* for the selected row: Day, Indices, Index size, event_logsize,
  Difference, Ratio, bars.

### Planning (board 8) and Plan templates (board 10)

Planning sizes a new or existing cluster from a **plan template**. Templates are shared
server-side settings (admins edit, everyone plans).

- Inputs: Template, Based on (a new cluster | an existing cluster, which fills daily volume
  from its 7-day event_logsize and the policy from its settings), Daily volume (GB), Live
  retention policy **hot days + warm days**, Backups go to (**/backup disk | S3 | ULM → S3**),
  Backup retention (days), Buffer (%), Replicas.
- Output: tiles (Servers, CPU, RAM, /live disk, backup) and a bill of materials: Role, Sizing
  rule, Count, CPU each, RAM each, / disk each, /live disk each, /backup disk (only when backups
  go to disk), CPU total, RAM total, plus a Total row. Export CSV. No explanatory note.
- Disk sizes (/live disk each, /backup disk, the S3 / ULM size, the tiles, the CSV) are shown
  as they are bought: **rounded up** to a whole TB from 1 TB, a whole GB below (2.79 TB → 3 TB,
  19.5 TB → 20 TB), never down. The /live disk tile and Total are the rows' sum, count × each
  node's rounded disk (7 × 3 TB = 21 TB), so the tile never disagrees with the table.
- Template = name + backup target + roles. A role: on/off, name, sizing rule, per-server
  capacity or count, CPU, RAM (GB), / disk (GB), notes. Sizing rules:
  1. **Scales with daily volume** — count = ⌈volume ÷ GB/day per server⌉, at least 1.
  2. **Fixed count**.
  3. **Live retention policy (hot / warm)** — nodes in a tier = ⌈volume × tier days × (1 +
     buffer) × (1 + replicas) ÷ tier node size⌉; 0 days → no nodes; one data node in total
     holds every role.
  4. **Added when data nodes reach N** — count C once hot + warm data nodes ≥ N, else 0 and
     the row says the data nodes keep the role.
  5. **Follows another role** — ⌈that role's count ÷ N⌉.
  6. **Backup target** — used only when backups go to it: S3 bucket / ULM archive = volume ×
     backup days; /backup disk = volume × backup days × (1 + buffer) (primaries only, shared
     repository, carried on the hot row).
- Built-in template **Standard** (seeded, editable, from the owner's rules): Forwarder and
  Parser (150 GB/day each, 8 CPU, 16 GB), Elasticsearch hot (8 TB/node, editable stand-in),
  Elasticsearch warm ([set] TB/node), Elasticsearch master (3 from 3 data nodes), Elasticsearch
  coordinating (2 from [set] data nodes), Engine, AI/ML (1), ULM (backup target), S3 backup
  (backup target, a bucket), Other servers. Every CPU/RAM/disk the owner has not given is
  `[set]`. A second seeded template **Small / lab**: Forwarder ×1, Elasticsearch hot, S3 backup.
- Core: `PLAN_TEMPLATES_GET` (any signed-in user) → `{ok, templates:[…], managed?}`;
  `PLAN_TEMPLATES_SET {templates}` (admin, limited admins refused like other fleet-wide
  settings, audited `plan_templates`) validates names unique, numbers ≥ 0 or null, rule kinds
  known. Stored in the data directory (`plan-templates.json`); a missing file reads as the two
  seeded templates. Desktop: kept in the browser like other desktop-only settings.
- Config › **Reports** (was *Volume fields*): the index pattern card (below), the existing
  volume fields, mail schedule, and **Plan templates** (list: New, Duplicate, Delete, Save;
  role table as above with amber `[set]` inputs; *+ Add server role*; the rules legend).

## Which indices count (board 6)

- New setting `indexPattern` (`UI_VOLUME_INDEX_PATTERN`), default **`logstash-*`**, one or
  more comma-separated patterns, no date part needed. The day rule: an index whose name carries
  `YYYY.MM.DD` counts on that day in full (as today); an index without a date in its name is
  split into days by its documents' time field (`timeField`, default `@timestamp`; a
  `date_histogram` with `calendar_interval: 1d` in the collector's time zone, UTC as today,
  inside the same per-day search). Optional *Always from the time field* switch
  (`dayFrom: "name" | "time"`, default `name`).
- For a day built from the time field: documents and event_logsize are measured; disk size per
  day is **not measured** (Elasticsearch reports size per index) and the record says so
  (`priBytes`/`totalBytes` null for those indices, Measure size shows *not measured* for them).
- `UI_VOLUME_INDEX_FORMAT` keeps working: when set (and `UI_VOLUME_INDEX_PATTERN` is not), it
  is read as before; the settings page shows which one is in force. Existing records are not
  rewritten.
- The Config card shows a live preview: indices matched, dated by name (with an example),
  split by time (with an example), and says so when the pattern matches nothing.

## Zabbix modules

The menu entry `elasticpro.volume` is labelled **Reports** (embed module `Module::PAGES`),
modules patch release after 2.1.18. The action name stays, so links keep working.

## Tests

- check-ui, unit-check (new: per-day rate, data-node disk, planning rules, column layout),
  render-check (Reports with every section, Indices without Summary), behaviour-check
  (section nav, Columns menu, Measure size button sends VOLUME_RUN, Planning recalculates,
  backup target hides the /backup column), fit-check (no sideways scroll at 1920 and 3840).
- Rust: index pattern parsing, the dated/undated split, `dayFrom`, legacy format, plan
  template validation and storage, auth for the new messages.
- docs/VOLUME.md updated for the pattern and day rule; HANDBOOK for the new messages.
