# Standalone Zabbix modules — what it would take to cut the ElasticPro core

**Status:** plan only. Nothing in this document has been built.
**Audience:** whoever decides whether to fund the work.
**Asked for, verbatim:** *"i want same elasticpro zabbix modules (client resources, capacity,
ULM, Device count, count of delay devices, etc). Complete standalone, (No connection to
elasticpro UI). want in next phase. Please plan that."*

## The short answer

Four of the five modules already need no ElasticPro core. They talk to the Zabbix API and to
one folder on disk, and nothing else. What needs the core is **two families of figures**, both
of which arrive as Zabbix *trapper* items pushed from outside:

| Family | Items | Who fills them today |
|---|---|---|
| Log delay (incl. "count of delay devices") | `elasticpro.delay[*]` — 8 items | `tools/elasticpro-scrape.mjs --send` ([`:441`](../tools/elasticpro-scrape.mjs)) |
| Volume report / client plan | `elasticpro.plan[*]` + 2 — 19 items | the same scraper ([`:432-438`](../tools/elasticpro-scrape.mjs)) |
| (also) ElasticPro alert rules | `elasticpro.alert[*]` — 22 items | the same scraper |

That is the whole dependency. Everything else — client resources, capacity, device count, ULM —
is already collected by Zabbix templates this repo writes or that the site imports.

And there is a seam already in the right place: **the item key**. The master template and the
widgets read `elasticpro.delay[late]`; they do not care whether that key is a `TRAP` item fed by
the scraper or an `HTTP_AGENT` item that asks Elasticsearch itself. Swapping one template for
another on a cluster host changes the source without touching a line of widget code. That makes
standalone a *mode*, not a fork. See [§7](#7-replacement-mode-or-fork).

---

## 1. Where each module's data actually comes from

Source classes used below:
**(i)** Zabbix items from templates in this repo · **(ii)** the Zabbix API ·
**(iii)** the module's own files in `EP_DATA_DIR` · **(iv)** the ElasticPro core over HTTP/SSO ·
**(v)** Zabbix items from templates the *site* imports (stock Elasticsearch / Linux agent) ·
**(vi)** Zabbix trapper items pushed by the ElasticPro scraper.

### 1.1 `capacity-widget` — "Client capacity"

The controller touches nothing but Zabbix and one settings file:

| Step | Where | Source |
|---|---|---|
| Column list | `columns.json` in the module folder | static |
| Rename/hide/reorder | `ColumnSettings::load('capacity')` → `Store::path('columns-capacity.json')` ([`shared/php/Store.php:50`](../integration/zabbix/shared/php/Store.php)) | (iii) |
| Which hosts are clients | `API::Template()->get(['host' => 'ElasticPro client master'])` then `API::Host()->get(templateids:…)` ([`actions/WidgetView.php:53-71`](../integration/zabbix/capacity-widget/actions/WidgetView.php)) | (ii) |
| Every numeric cell | `API::Item()->get(['lastvalue','lastclock','units','state'])` ([`:85-89`](../integration/zabbix/capacity-widget/actions/WidgetView.php)) | (ii) |
| Client name, ES URL, thresholds, type, status | `API::UserMacro()->get(... {$GRP.CLIENT}, {$ES.URL}, {$EP.USAGE.WARN/HIGH}, {$EP.CLIENT.TYPE/STATUS})` ([`:97-101`](../integration/zabbix/capacity-widget/actions/WidgetView.php)) | (ii) |
| "ES Full In" text | `Forecast::fullIn()` over `ep.es.storage.full_in` ([`shared/php/Forecast.php:15`](../integration/zabbix/shared/php/Forecast.php)) | (ii) |

**No HTTP call to the core anywhere in the module.** Confirmed by grep across
`integration/zabbix/**/*.php`: the only `http` strings are a form placeholder and a URL
validator in `ClientSpec.php:287,563`.

Now trace the item values one level down. Every key in `columns.json` is a **`CALCULATED`** item
on the master host — `MasterTemplate::itemExport()` hard-codes `'type' => 'CALCULATED'`
([`MasterTemplate.php:202`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) — so
each one is an aggregation over *other* hosts' items:

| Column (`columns.json`) | Key | Calculated from | Ultimate source |
|---|---|---|---|
| Cust.Purchased Storage | `ep.es.storage.purchased` | `{$ES.VOLUME.CUS.PURCHASED}*GB` ([`:224`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | (i) macro set by Cluster Management |
| ES Allocated Storage | `ep.es.storage.allocated` | `max(last_foreach(/*/es.nodes.fs.total_in_bytes?[group="{$GRP.CLIENT}"]))` ([`:226`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | (v) `Elasticsearch Cluster by HTTP EP`, **or** (i) [`JumpTemplate.php:241`](../integration/zabbix/clients-module/lib/JumpTemplate.php) |
| ES Used Storage | `ep.es.storage.used` | `es.nodes.fs.used_in_bytes` ([`:228`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | same |
| ES Used % | `ep.es.storage.usage` | `100*used/allocated` ([`:230`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | derived |
| ES Full In | `ep.es.storage.full_in` | `timeleft(//ep.es.storage.usage,7d,100)` ([`:237`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | derived, Zabbix's own forecast function |
| Cust.Purchased Devices | `ep.devices.purchased` | `{$EP.DEVICES.PURCHASED}` ([`:239`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | (i) macro |
| Devices Seen | `ep.devices.seen` | `sum(last_foreach(/*/ep.es.devices.seen?[…]))` ([`:241`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | (i) `DevicesTemplate` `HTTP_AGENT` item ([`DevicesTemplate.php:50-71`](../integration/zabbix/clients-module/lib/DevicesTemplate.php)) or the SSH variant ([`JumpTemplate.php:303`](../integration/zabbix/clients-module/lib/JumpTemplate.php)) |
| **Logdelay Devices Count** | **`ep.delay.late`** | **`max(last_foreach(/*/elasticpro.delay[late]?[…],1h))`** ([`:248`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | **(vi) `TRAP`, scraper only** ([`template-elasticpro-log-delay.yaml:26-28`](../deploy/zabbix/template-elasticpro-log-delay.yaml)) |
| ES/Parser/Forwarder CPU+Mem+Disk requested | `ep.<family>.<res>.requested` | sum of `ep.role.*` role items, which read `{$EP.<ROLE>.*.REQUESTED}` macros ([`:283-294`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | (i) macros |
| … allocated / usage | `ep.<family>.<res>.allocated/usage` | `system.cpu.num`, `system.cpu.util`, `vm.memory.size[total]`, `vm.memory.utilization`, `vfs.fs.dependent.size[*,total/used]` ([`:264-317`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | (v) `Linux by Zabbix agent -EP` |

**Verdict:** 30 of 31 columns are already core-free. One column — *Logdelay Devices Count* — is not.

### 1.2 `resources-widget` — "Client resources"

Identical shape, plus a per-server expansion:

| Step | Where | Source |
|---|---|---|
| Columns derive from the *roles* | `Roles::load()` → `roles.json` in `EP_DATA_DIR` ([`actions/WidgetView.php:31`](../integration/zabbix/resources-widget/actions/WidgetView.php)) | (iii) |
| Client rows | `Template.get` + `Host.get` + `Item.get` + `UserMacro.get` ([`:56-88`](../integration/zabbix/resources-widget/actions/WidgetView.php)) | (ii) |
| Each client's machines | `HostGroup.get` by client name, `Host.get` with `selectInterfaces`/`selectTags` ([`:237-242`](../integration/zabbix/resources-widget/actions/WidgetView.php)) | (ii) |
| Per-server CPU/mem/disk | `Item.get` on `system.cpu.num`, `system.cpu.util`, `vm.memory.size[total]`, `vm.memory.utilization`, `vfs.fs.dependent.size[<mount>,total/pused]` ([`:292-302`](../integration/zabbix/resources-widget/actions/WidgetView.php)) | (v) |
| Up/down | interface `available` ([`:273-278`](../integration/zabbix/resources-widget/actions/WidgetView.php)) | (ii) |
| **"Devices late" column** | **`ep.delay.late`** ([`:163`](../integration/zabbix/resources-widget/actions/WidgetView.php)) | **(vi)** |

**Verdict:** one column core-dependent; the rest already standalone.

### 1.3 `volume-widget` — "Volume report"

This one is different in kind. It keeps **no column list of its own** — the columns *are* the
items of the `ElasticPro client plan` template, discovered at render time from the item name,
units and the `plan`/`column` tags ([`actions/WidgetView.php:44-77`](../integration/zabbix/volume-widget/actions/WidgetView.php)).

Every one of those items is `type: TRAP`
([`template-elasticpro-client-plan.yaml:19-260`](../deploy/zabbix/template-elasticpro-client-plan.yaml)),
and the only thing that sends them is the scraper
([`elasticpro-scrape.mjs:432-438`](../tools/elasticpro-scrape.mjs)). The 17 columns, with the
calculation behind each, are declared in `CLIENT_VIEW`
([`ui/js/core/volume.js:544-566`](../ui/js/core/volume.js)) and computed by `volumeReport()`
([`volume.js:182`](../ui/js/core/volume.js)).

| Also read | Where | Source |
|---|---|---|
| `elasticpro.plan.epoch` → "Updated N ago" / "Never updated" | [`:145,155`](../integration/zabbix/volume-widget/actions/WidgetView.php) | (vi) |
| `elasticpro.plan.reachable` → the unreachable badge | [`:156`](../integration/zabbix/volume-widget/actions/WidgetView.php) | (vi) |
| Thresholds `{$ELASTICPRO.PLAN.LIVE_USED.WARN}` / `LIVE_DAYS.MIN` | [`:109-113`](../integration/zabbix/volume-widget/actions/WidgetView.php) | (ii) |
| DI / On-Prem badge | master-host macros ([`:195-216`](../integration/zabbix/volume-widget/actions/WidgetView.php)) | (ii) |
| Column settings | `columns-volume.json` | (iii) |

**Verdict: 100 % core-dependent.** With the scraper stopped, this widget renders its headings
(the template still exists) and every cell as `—`, with "Never updated" in the row hint. That is
honest behaviour, and it is also an empty report.

### 1.4 `clients-module` — "Cluster Management"

| Step | Where | Source |
|---|---|---|
| Client registry, roles, column settings, backups, pending import | `Store::read/write` under `EP_DATA_DIR` ([`Store.php:50-99`](../integration/zabbix/shared/php/Store.php)), `Registry::all()` | (iii) |
| What exists in Zabbix now | `Reconciler::current()` — hosts, groups, templates, macros, interfaces | (ii) |
| Setup health per client | `SetupChecks::forClients()` — `Item.get` state/error/lastvalue on `es.cluster.get_health`, `JumpTemplate::FAST`, `ep.wj.problem[fast]`, `ep.es.devices.seen`, `ulm.check`, `ulm.error`; `Proxy.get`, `ProxyGroup.get` ([`SetupChecks.php:19-46`](../integration/zabbix/clients-module/lib/SetupChecks.php)) | (ii) |
| "Test connection" | `API::Task()->create(ZBX_TM_TASK_CHECK_NOW)` then re-read item state ([`TestConnection.php:38-60`](../integration/zabbix/clients-module/actions/TestConnection.php)) | (ii) |
| Open problems per client | `API::Trigger()->get(value: TRUE, groupids:…)` ([`ClientList.php:63-66`](../integration/zabbix/clients-module/actions/ClientList.php)) | (ii) |
| Storage forecast + over-purchase columns | `Item.get` on `ep.es.storage.full_in`, `ep.es.storage.purchased.usage`, `ep.devices.usage` ([`ClientList.php:54-57`](../integration/zabbix/clients-module/actions/ClientList.php)) | (ii), all calculated |
| Template writing | `configuration.import` of `MasterTemplate`, `DevicesTemplate`, `JumpTemplate`, `ClusterTemplate` via `TemplateInstaller` | (ii) |
| Alert routing, weekly report | Zabbix actions + a Zabbix scheduled report on a Zabbix dashboard ([`AlertRouting.php:34,117`](../integration/zabbix/clients-module/lib/AlertRouting.php)) | (ii) |

**Verdict: already fully standalone.** It never calls the core. Note the interesting inversion
in `ClusterTemplate.php:17-22`: that template exists *for the core's benefit* — it is how the
core finds clusters — and it "deliberately collects nothing". In a standalone world it keeps
being useful only as the place the connection macros live.

### 1.5 `deploy/zabbix/module/elasticpro` — the embed module

This module has exactly three jobs, and none of them is a figure:

1. Put "ElasticPro" in the Zabbix main menu — nine app pages plus two Super-admin pages
   ([`Module.php:28-47`](../deploy/zabbix/module/elasticpro/Module.php)).
2. Mint a single-use SSO code per page load and iframe the app with it
   ([`actions/View.php:19-30`](../deploy/zabbix/module/elasticpro/actions/View.php),
   [`lib/SsoClient.php`](../deploy/zabbix/module/elasticpro/lib/SsoClient.php),
   signed and verified by [`crates/elasticpro-core/src/zbx_sso.rs:1-33`](../crates/elasticpro-core/src/zbx_sso.rs)).
3. Pair Zabbix with the core: create the read-only sync role/user, mint an API token, POST it to
   `<ep>/zabbix/pair` ([`lib/Pairing.php:14-30`](../deploy/zabbix/module/elasticpro/lib/Pairing.php)),
   and keep the URL + HMAC secret ([`lib/Settings.php:9-26`](../deploy/zabbix/module/elasticpro/lib/Settings.php)).

**Verdict: it is 100 % the dependency.** It is the only module whose reason to exist is the core.

### 1.6 ULM — the log archive check

**Already standalone, and already not in the app.** Two confirmations in the tree:

- The `ElasticPro log archive S3` template "was removed from ElasticPro and lives in its own
  Zabbix template now", imported separately from `elasticpro-zabbix/ulm`
  ([`integration/zabbix/master/import.py:57-60`](../integration/zabbix/master/import.py),
  [`deploy/PRODUCTION.md:190-194`](../deploy/PRODUCTION.md)). `import.py` treats it as
  **optional** and continues without it.
- For jump-host clients the Elasticsearch half runs as two `ssh.run` items the Clients module
  writes — `ep.ulm.days` and `ep.ulm.tags`
  ([`JumpTemplate.php:127-191`](../integration/zabbix/clients-module/lib/JumpTemplate.php)) — and
  the S3 template reads their answers back **through the Zabbix API**
  (`{$ULM.ES.VIA}=zabbix`, `{$ULM.ZABBIX.API.URL/TOKEN}` as global macros,
  [`deploy/PRODUCTION.md:231-242`](../deploy/PRODUCTION.md)).

Nothing in that path goes anywhere near the core. ULM is the proof that this kind of work is
possible: it was once in the app and is now a pure Zabbix template.

---

## 2. What genuinely cannot be produced without the core

| Named figure | Today's producer | Core-only? | Why |
|---|---|---|---|
| **Client resources** (servers / CPU / memory / disk, requested-allocated-used, per role and per family, plus the per-server expansion) | `Linux by Zabbix agent -EP` items, aggregated by `MasterTemplate::roleItems/familyItems` ([`:264-317`](../integration/zabbix/clients-module/lib/MasterTemplate.php)) | **No** | Already pure Zabbix |
| **Capacity** (ES storage purchased/allocated/used/%, full-in, CPU & memory per family) | cluster-host ES items + master-host macros + Zabbix `CALCULATED` + `timeleft()` | **No** | Already pure Zabbix |
| **ULM / log archive** | `ElasticPro log archive S3` + `ep.ulm.days` / `ep.ulm.tags` | **No** | Already pure Zabbix (and already out of the app) |
| **Device count** | `ep.es.devices.seen` — one `HTTP_AGENT` POST with a `cardinality` agg ([`DevicesTemplate.php:32-34,50-71`](../integration/zabbix/clients-module/lib/DevicesTemplate.php)), or the same body over SSH | **No** | Already pure Zabbix |
| **Count of delayed devices** | `elasticpro.delay[late]` `TRAP` ← scraper ← `summarise()`/`DELAY_ITEMS` ([`log-delay.js:355-375`](../ui/js/core/log-delay.js)) | **Yes, today** | Needs a terms+top_hits aggregation, a per-device `arrival − event` subtraction, `classify()` against four thresholds, and a median. Portable to Zabbix — see [§3.1](#31-log-delay) |
| **Volume report — all 17 plan columns** | `elasticpro.plan[*]` `TRAP` ← `volumeReport()` ([`volume.js:182-290`](../ui/js/core/volume.js)) | **Yes, today** | Needs the dated index listing, snapshot listing, ILM/SLM policies, optionally per-snapshot `_status`, and ~40 lines of arithmetic. Mostly portable — see [§3.3](#33-snapshot--volume-analysis) |
| ElasticPro alert rules (22 trapper items) | `elasticpro.alert[*]` ← `ui/js/core/automation.js` | **Yes, today** | Partly portable as triggers; the "proposal" half is not a measurement at all |
| Automation proposals ("what is safe to delete, what was held back and why") | `elasticpro.state` `HTTP_AGENT` against the core's own JSON document ([`template-elasticpro.yaml:43-168`](../deploy/zabbix/template-elasticpro.yaml)) | **Yes, permanently** | The rules live in the core and operate on its cached fleet. A Zabbix trigger states a condition; it cannot propose an action for a person to confirm |
| Live logs, REST console, index browser, per-device delay drill-down | the app's pages | **Yes, permanently** | Interactive query tools. Zabbix has no page for them and should not grow one |

---

## 3. What the core does that Zabbix cannot — honestly assessed

### 3.1 The log-delay measurement

Two separate things share the name. **Do not confuse them.**

**(a) `crates/elasticpro-core/src/delay_sink.rs` — the scheduled measurement.** Read in full.
What it computes and writes:

- Runs on a 60-second tick; acts only when due. Hosted edition only
  (`Edition::schedules()`, [`auth.rs:92`](../crates/elasticpro-core/src/auth.rs)), disarmed by
  default (`SinkConfig::enabled = false`, [`delay_sink.rs:58-59`](../crates/elasticpro-core/src/delay_sink.rs)),
  and refuses to run while the config is read-only — the two human decisions CLAUDE.md names.
- Per measured cluster, **one** search: `terms(device_field, size=max_devices)` with a nested
  `top_hits(size=1)` sorted by arrival descending, over `now-<every_hours>h`
  ([`search_body`, `:186-207`](../crates/elasticpro-core/src/delay_sink.rs)).
- Per bucket it reads the latest document's arrival timestamp and the first of
  `["ingested_time","event_created","event.created"]` that parses, and computes
  `delay_minutes = (arrival − event) / 60000`
  ([`measurements`, `:224-248`](../crates/elasticpro-core/src/delay_sink.rs)). A device missing
  either timestamp is **skipped**, not recorded as zero.
- It **writes per-device rows into an Elasticsearch sink cluster**, not into Zabbix:
  `_bulk` into `<prefix>-YYYY.MM` with `_id = cluster|device|hour` so a repeated run overwrites
  itself ([`bulk_body`, `:282-305`](../crates/elasticpro-core/src/delay_sink.rs);
  [`index_name`, `:338`](../crates/elasticpro-core/src/delay_sink.rs)).
- It carries **no status and no threshold** on purpose. `classify()` lives once, in
  `ui/js/core/log-delay.js:183`, and is applied on read ([`delay_sink.rs:18-22`](../crates/elasticpro-core/src/delay_sink.rs)).
- Failure handling: exponential backoff doubling to a day (`next_due`, `:179-183`), and a
  `SinkState` an admin can read (`:141-175`).

**(b) The Zabbix delay items** come from somewhere else entirely: the scraper calls
`measureDelay()` + `summarise()` + `delayItemValues()` and sends 7–8 numbers per cluster
([`log-delay.js:355-375`](../ui/js/core/log-delay.js),
[`elasticpro-scrape.mjs:441`](../tools/elasticpro-scrape.mjs)).

**Could a Zabbix template collect (b) directly?** Yes.

| Approach | Verdict |
|---|---|
| `HTTP_AGENT` master item posting the same `terms`+`top_hits` body, then dependent items with a `JAVASCRIPT` preprocessing step per figure | **The right shape.** It is exactly the pattern `DevicesTemplate::master()/figure()` already uses ([`DevicesTemplate.php:110-160`](../integration/zabbix/clients-module/lib/DevicesTemplate.php)), and `cluster-steps.json` already proves non-trivial ES5 steps are maintainable and unit-tested |
| `SSH` `ssh.run` master item for jump-host clients | **Already proven** — `JumpTemplate` runs multi-request `curl.exe` sessions and splits the answers ([`JumpTemplate.php:206-209`](../integration/zabbix/clients-module/lib/JumpTemplate.php)) |
| Calculated item | **No.** There is no per-device series in Zabbix to aggregate over |

**Cost in cluster load:** identical to today, because it is the same single aggregation. At
`size=500` (the UI's figure, [`log-delay.js:322`](../ui/js/core/log-delay.js)) or the sink's
`max_devices=2000`, every 15 minutes, per cluster: 96–4 requests/day/cluster, each a terms agg
with a 1-hit `top_hits` per bucket. For seven clients that is negligible against the cluster.

**Cost in Zabbix load — the real risk.** The master item's *value* is the whole aggregation
response: 500 buckets × one source document each. With half a dozen `_source` fields that is
comfortably past a megabyte, and Zabbix must carry it through preprocessing for every dependent
item. Mitigations, in order of preference:

1. Shrink the response at the source: `filter_path` or a tighter `_source` so each bucket carries
   only arrival + the one event-time field — roughly 120 bytes per device instead of 2 KB.
2. Compute all 8 figures in **one** JavaScript preprocessing step on a single item that emits
   JSON, then make the 8 figures `DEPENDENT` on *that* with cheap `JSONPATH` steps. One parse,
   not eight.
3. Keep `history: 1h, trends: 0` on the raw master item, as `DevicesTemplate::master()` already does.

**What would be lost:** the per-device rows. `delay_sink.rs` writes one document per device per
hour into Elasticsearch, which is what makes "which device, and since when" answerable. Zabbix
would hold only the 8 per-cluster aggregates. Also lost: the `_field_caps` preflight
([`log-delay.js:94-130`](../ui/js/core/log-delay.js)) that today says *"this cluster cannot be
analysed: `src_hostname.keyword` is missing"* and resolves which of the three candidate
event-time fields exists. In Zabbix that becomes either a second probe item plus a macro the
operator sets by hand, or an unsupported item whose error text is Elasticsearch's rather than
ours. The honest refusal — "unknown, and here is the field name to fix" — gets weaker.

### 3.2 The fleet poller

`crates/elasticpro-core/src/fleet/` keeps nine datasets per cluster
([`catalogue.rs:21-35`](../crates/elasticpro-core/src/fleet/catalogue.rs)), split into
`Background` and `OnDemand` classes, with a boot spread so a restart with a hundred clusters is
not a hundred simultaneous health checks (`BOOT_SPREAD_MS`), a 120 s probe interval for
unreachable clusters, a 15-minute watch window for on-demand datasets, a disk cache, and an
`Entry` model where "never fetched" and "last fetch failed, here is the previous good body and
*its* timestamp" are distinct states ([`entry.rs:1-30`](../crates/elasticpro-core/src/fleet/entry.rs)).

**Zabbix equivalent:** this *is* what a Zabbix template is. Per-item `delay`, master/dependent
items, `ITEM_STATE_NOTSUPPORTED` with the reason, `lastclock` for freshness, history and trends
for the cache. `DevicesTemplate::extras()` already collects eight of the nine datasets'
interesting figures this way ([`DevicesTemplate.php:175-231`](../integration/zabbix/clients-module/lib/DevicesTemplate.php)).

**What would be lost:** the *raw bodies*. The poller hands the UI the same JSON the pages used to
fetch themselves, "character for character" ([`catalogue.rs:3-6`](../crates/elasticpro-core/src/fleet/catalogue.rs)),
so arbitrary new figures can be computed without touching a cluster. Zabbix keeps numbers, not
documents — a new figure means a new item and a wait for history to accumulate.

### 3.3 Snapshot / volume analysis

Three distinct computations:

| Computation | Code | Inputs | Zabbix feasibility |
|---|---|---|---|
| Daily ingest rate | `dailyVolume()` ([`volume.js:111-148`](../ui/js/core/volume.js)) — group dated indices by day, drop today's partial, take the mean of the `topDays` heaviest of the last `windowDays` | the full index listing with per-index store size and a date parsed from the index name | **Feasible** as an `HTTP_AGENT` item on `/_cat/indices?format=json&bytes=b&h=index,store.size&expand_wildcards=open` plus a JS step. **Watch the payload**: ~90 bytes/index, so 10 000 indices ≈ 1 MB. Restrict with the client's own index pattern and `h=` to the two columns |
| The plan arithmetic | `volumeReport()` ([`volume.js:182-290`](../ui/js/core/volume.js)) — buffered daily rate, required live storage for the policy / 30 / 90 / 365 days, days the free space buys, days the backup buys, policy-met booleans | the above, plus `_nodes/stats/fs` (already a Zabbix item), ILM/SLM applied policies (already items), **plus operator-stated facts from `clusters.yaml`: `liveRetention`, `snapshotRetention`, `backupCapacity`, `volumeWindowDays`, `volumeTopDays`, `volumeHeadroomPercent`** | **Feasible.** The arithmetic is pure. The config facts become `ClusterTemplate` macros — which is the one place `ClusterTemplate` would stop "collecting nothing" and start carrying plan inputs |
| Repository size | `measureRepoBytes()` ([`volume.js:601-621`](../ui/js/core/volume.js)) — Elasticsearch does not report a repository's size, so it sums each snapshot's `stats.incremental.size_in_bytes` from **one `_status` call per snapshot**, capped at 60 per repo, with a cross-run cache keyed `repo/snapshot` | one request per snapshot | **Marginal.** A Zabbix `SCRIPT` item can loop with `HttpRequest`, and Zabbix 7.0 allows per-item timeouts beyond the old 60 s ceiling. But there is **no cross-run cache**: today `--repo-cache` means a later run asks only about new snapshots; a script item re-asks about all 60 every time. Either the cap drops hard (10–20), or the interval goes to daily, or the figure stays unknown |
| Snapshot *data* coverage (`backup.from` / `backup.to`) | `snapshotWindow()` ([`volume.js:304-326`](../ui/js/core/volume.js)) — the oldest and newest *log day* inside the snapshots, read from the dates in their index names, deliberately distinct from when the snapshot ran | index names per snapshot, which `_cat/snapshots` does not give; needs `/_snapshot/<repo>/_all` | **Expensive and partial.** CLAUDE.md already names this as a standing "unknown is not zero" case. A verbose listing of a large repository is a heavy call and gets heavier as the repository grows. Likely answer: collect it daily, or leave it unknown and say so |

**Cost in cluster load, totalled for the volume family:** per cluster per interval — one
`_cat/indices`, one `_snapshot/_all`, one `/_slm/policy` (already collected), one `_ilm/status`
(already collected), and optionally N snapshot `_status` calls. The index listing is the same
call the app's Indices page makes, which is why the scraper rate-limits it to once per 30 minutes
by default (`--indices-every`, [`elasticpro-scrape.mjs:51-58`](../tools/elasticpro-scrape.mjs)).
A Zabbix template must carry the same restraint as an item `delay` of `30m` or `1h` — not `1m`.

---

## 4. Pairing, SSO and accounts without an ElasticPro UI

With no app there is no second sign-in, and the whole of `zbx_sso.rs` and `Pairing.php` becomes
dead weight. **Zabbix's own permissions do the job**, and they do it better in one respect: they
are the permissions the operator already administers.

What exists today, and what happens to it:

| Today | Where | Standalone |
|---|---|---|
| `Edition::{Portable,Installed,Hosted}` decides whether accounts exist at all | [`auth.rs:67-95`](../crates/elasticpro-core/src/auth.rs) | Irrelevant. No core, no editions |
| Four roles `Guest / User / Operator / Admin`, with `may_write()` on Operator+ | [`auth.rs:101-138`](../crates/elasticpro-core/src/auth.rs) | Collapses to Zabbix's three user types. The modules already read `USER_TYPE_SUPER_ADMIN` directly for "may edit columns" ([`capacity WidgetView.php:46`](../integration/zabbix/capacity-widget/actions/WidgetView.php)) and `canWrite()` in the clients module |
| **Scoped accounts**: `scope_allows(scope, cluster_groups)` — `None` sees everything, `Some(groups)` sees a cluster only when it names one of the account's Zabbix user groups; "the default for someone Zabbix has not placed is no clusters, not all of them" | [`auth.rs:140-161`](../crates/elasticpro-core/src/auth.rs) | **Replaced by Zabbix host-group permissions, and strictly improved.** Today the scope is a *mirror* of Zabbix groups, re-written on every SSO sign-in ([`auth.rs:364-369`](../crates/elasticpro-core/src/auth.rs)); the mapping is `User → user/scoped`, `Admin → operator/all`, `Super admin → admin/all` ([`zbx_sso.rs:27-32`](../crates/elasticpro-core/src/zbx_sso.rs)). A mirror can be stale. Zabbix's own read permission on a client's host group cannot be — `API::Host()->get()` returns only what the caller may see, so the widgets already filter correctly for free |
| `guest_may_read()` allowlist of ES paths | [`auth.rs:162-201`](../crates/elasticpro-core/src/auth.rs) | Gone with the REST console. Nothing in the modules proxies an arbitrary ES path |
| `Writes::decide(read_only, unlocked, requested)` — the two-gate write guard | `guard.rs` | Gone from the data path. The modules' only writes are Zabbix configuration changes, which Zabbix permission-checks and audit-logs itself — the same property `Pairing.php:17-19` already relies on |
| HMAC pairing secret, sealed in `module.config` with a key derived from Zabbix's session key | [`Settings.php:19-26`](../deploy/zabbix/module/elasticpro/lib/Settings.php) | Deleted. One fewer secret to hold, rotate and explain |
| The read-only sync role + API token the pairing creates | [`Pairing.php:19-24`](../deploy/zabbix/module/elasticpro/lib/Pairing.php), `sync-role.json` | Deleted — **except** the ULM check's separate Zabbix API token (`{$ULM.ZABBIX.API.TOKEN}`, [`PRODUCTION.md:235-241`](../deploy/PRODUCTION.md)), which is a different token for a different purpose and stays |

**One thing gets worse.** Today a cell in a report can be clicked through to a live view of the
cluster that produced it, and a Zabbix problem carries a "Troubleshoot in ElasticPro" link
([`View.php:33-44`](../deploy/zabbix/module/elasticpro/actions/View.php)). Standalone, the deepest
link available is Zabbix's own *Latest data* for that item. For a capacity review that is enough.
For diagnosing *why* a client's logs are 90 minutes late it is not.

**One credential question has no good standalone answer.** Elasticsearch passwords. The core
reads a Vault reference; a Zabbix item can use a Vault macro, but `ClusterTemplate.php:54-57`
already records the trap: a Zabbix **Secret text** macro cannot be read back through the API by
anyone, so it works for an item and not for anything that must fetch it. Standalone only ever
needs the item case, which makes this *simpler*, not harder — but it must be stated in the
migration note, because operators who filled in a Vault reference for the core's benefit will
need a Vault *macro* instead.

---

## 5. The staged path

Each stage ships something usable on its own and is reversible. The ordering principle: do the
cheap high-value swap first, defer the expensive one, and never remove a working data source
before its replacement has produced history.

### Stage 0 — Prove and label what is already standalone · **S** · 1 week

Build nothing new. Establish the baseline so the later stages can be measured.

- Stop the scraper in a lab fleet and record, cell by cell, which figures survive. Expected:
  clients-module intact, capacity 30/31 columns, resources all but one column, volume report
  entirely empty, device count intact, ULM intact.
- Make the two "fed from outside" columns *say so*. Today `ep.delay.late` with no data renders
  `—`, indistinguishable from an item that is merely new. Add a hint naming the item and the
  reason, in the same spirit as the volume widget's "Never updated".
- Write the one-page operator note: which templates must be linked for which figure.

**Still needs the core afterwards:** log delay, volume report, alert rules, automation document.

### Stage 1 — Log delay as a Zabbix template · **M** · 2–3 weeks

A new `ElasticPro log delay (direct)` template, written by the Clients module beside the existing
ones, that produces **the same item keys** `elasticpro.delay[*]`.

- One `HTTP_AGENT` master item (and an `ssh.run` twin for jump-host clients, exactly as
  `JumpTemplate` already pairs with `DevicesTemplate`) posting the `buildSearchBody` aggregation
  with a trimmed `_source`.
- One JavaScript preprocessing step computing all of `DELAY_ITEMS` into a small JSON object;
  8 `DEPENDENT` items reading it by `JSONPATH`.
- Thresholds as template macros, defaulted from `DEFAULT_THRESHOLDS` (30 / 60 / 3 / 1440 min,
  [`log-delay.js:148-153`](../ui/js/core/log-delay.js)).
- Generated by a tool from `DELAY_ITEMS`, the way `tools/zabbix-delay-template.mjs` generates the
  trapper template today — so there is still one list of what is measured.
- The JS step runs under `tools/unit-check.mjs` against fixture aggregation responses, as
  `cluster-steps.json` already does.

**Zabbix refuses two items with the same key on one host, which is the safety property you
want:** a cluster host is linked to the trapper template *or* the direct one, never both. Cutover
is per client, and reversible by relinking.

**Ships:** "count of delay devices" and the master template's whole Log delay dashboard page
without the core. **Still needs the core:** volume report, alerts, automation.

### Stage 2 — Client plan as a Zabbix template · **L** · 5–7 weeks

The expensive stage, and the one with real unknowns.

- `ClusterTemplate` grows the plan inputs as macros: `{$EP.PLAN.LIVE.RETENTION}`,
  `{$EP.PLAN.SNAPSHOT.RETENTION}`, `{$EP.PLAN.BACKUP.CAPACITY}`, `{$EP.PLAN.WINDOW.DAYS}`,
  `{$EP.PLAN.TOP.DAYS}`, `{$EP.PLAN.HEADROOM.PCT}`. Each present-but-empty, as that file's
  comment already argues for ([`ClusterTemplate.php:40-48`](../integration/zabbix/clients-module/lib/ClusterTemplate.php)).
  Cluster Management's client form gains the fields; CSV import/export follow.
- Two `SCRIPT` or `HTTP_AGENT` master items at `30m`/`1h`: the dated index listing, and the
  snapshot + policy listing. Reuse `es.nodes.fs.*` for live storage rather than re-asking.
- One JavaScript step per section computing the 17 plan values, **generated from
  `CLIENT_COLUMNS`** — same source of truth, same `key` strings, so item history survives a
  heading rewording ([`volume.js:545-547`](../ui/js/core/volume.js)).
- Repository size and snapshot data coverage: decide per [§6 Q3](#6-decisions-you-have-to-make)
  before building. Do not ship a guess.

**Risks to price in:** the index-listing payload on a large fleet; script-item timeouts; the loss
of the cross-run snapshot cache; and the fact that the volume widget discovers its columns from
the template's items, so getting the tags wrong silently drops a column.

**Ships:** the volume report without the core. **Still needs the core:** alert rules, automation.

### Stage 3 — Alert rules, triaged · **M** · 2–3 weeks

The 22 `elasticpro.alert[*]` trapper items are a mixed bag. Sort them, then act:

- Rules that are a condition over figures Zabbix now has (disk, capacity, ILM, SLM failed/stale,
  repository, log delay) → **Zabbix triggers** on the items from Stages 1–2. Several already
  exist in `DevicesTemplate`/`JumpTemplate` and only need not to be duplicated.
- Rules that need history Zabbix now has (master changed, disk balance) → triggers with
  `change()`/`last(…,#2)`, replacing the scraper's `--memory` file.
- Rules that are a *proposal* rather than a condition → **drop them.** A trigger cannot offer
  work for a person to confirm, and inventing a Zabbix-side approximation would be the "render a
  guess as a measurement" failure.

**Ships:** alerting without the core. **Still needs the core:** nothing, for the reports.

### Stage 4 — Retire the bridge · **S** · 1 week

- Remove `Pairing`, the sync role and the pairing-made API token from the install path.
- Keep the embed module as an **optional** package, see [§6 Q1](#6-decisions-you-have-to-make).
- Delete the `ElasticPro automation` template from the required set; it is a core-only document.
- Rewrite `deploy/PRODUCTION.md` §5–6 and `INTEGRATION.md` steps 7–8 for an install with no core.

### Stage 5 (parallel, not optional) — Test the thing the user actually asked about · **M** · 2–3 weeks

The same request asked for end-to-end testing of Zabbix connections, imports, exports, stale
data, odd and duplicate hostnames and client names, and disabled hosts. That work is independent
of standalone and should run alongside: `zbx_e2e.py`, `zbx_hosts_check.py` and the module test
suites are the place for it. It is scoped separately and not costed here.

### Totals

| Stage | Size | Weeks (one engineer) |
|---|---|---|
| 0 — baseline and labelling | S | 1 |
| 1 — log delay direct | M | 2–3 |
| 2 — client plan direct | L | 5–7 |
| 3 — alerts triaged | M | 2–3 |
| 4 — retire the bridge | S | 1 |
| **Standalone total** | | **11–15 weeks** |
| 5 — e2e test suite (separate request) | M | 2–3 |

Stages 0, 1 and 4 alone — **4–5 weeks** — get you a product where only the volume report and the
alert rules still want the core. If the volume report matters less than the capacity reports to
the buyer, that is the cheap answer, and it should be considered on its own.

---

## 6. Decisions you have to make

**Q1. Does the embed module survive?**
- (a) Delete it. Zabbix never links to the app; the core becomes a separate product.
- (b) Keep it as an optional package — installed only where a core exists, carrying the pairing
  and SSO as they are today.
- (c) Keep the menu, drop SSO: links open the app with no sign-in pass-through.
- **Recommendation: (b).** It is already a separate folder (`deploy/zabbix/module/elasticpro`) with
  its own manifest and no coupling to the four `integration/zabbix` modules — grep confirms no
  cross-references. It costs nothing to leave in place and unshipped, and (c) is the worst of
  both: it keeps the menu while making every click a second login.

**Q2. Log delay — direct template, or keep the push?**
- (a) Direct template (Stage 1), one key set, trapper template retired.
- (b) Keep the push; standalone installs simply have no delay figures.
- (c) Ship both templates; per-client choice, permanently.
- **Recommendation: (a), with (c) as the migration mechanism.** The item keys are identical, so a
  site can move one client at a time and relink on failure. Retire the trapper template only once
  every client has produced a week of direct history — Zabbix item history is unrecoverable, and
  so is data an item stopped collecting.

**Q3. Repository size and snapshot data coverage — what do we promise?**
- (a) Collect it: a script item looping `_status` with a hard cap of 10–20 snapshots, daily.
- (b) Collect the repository *size* only (a), and leave snapshot data coverage unknown with the
  setting named — the "unknown is not zero" rule, applied.
- (c) Make both operator-stated macros and stop measuring.
- **Recommendation: (b).** Repository size at a daily cadence with a low cap is an honest, if
  coarse, measurement. Snapshot data coverage needs a verbose listing of the whole repository and
  gets worse every month the repository grows — that is the one figure where standalone should
  say *unknown*, and name `/_snapshot/<repo>/_all` as what would answer it.

**Q4. Where do the plan's operator-stated facts live?**
- (a) `ClusterTemplate` macros, edited through Cluster Management's client form.
- (b) `roles.json`-style files in `EP_DATA_DIR`.
- (c) Global Zabbix macros with per-host overrides.
- **Recommendation: (a).** It puts the fact on the host it describes, it is visible in Zabbix's own
  macro list the moment the template is linked, it survives a lost data folder, and the client
  form plus CSV import already own every other per-client fact.

**Q5. Who owns the plan arithmetic once it is JavaScript inside a template?**
- (a) Generated from `ui/js/core/volume.js`'s `CLIENT_COLUMNS` by a build tool; the JS steps are
  generated artifacts, never hand-edited.
- (b) Hand-written ES5 in `cluster-steps.json`, with `volume.js` as documentation.
- **Recommendation: (a), firmly.** CLAUDE.md names drifting duplicate definitions as this
  codebase's recurring failure, and names `volume.js` vs `snapshots.js` as one of the three times
  it happened. `tools/zabbix-plan-template.mjs` already generates the trapper template from the
  same list; generate the direct one the same way, and keep the unit tests on the generated steps.

**Q6. What is the standalone product's name and install story?**
- (a) Same name, "ElasticPro for Zabbix", one tarball of five modules plus templates.
- (b) Two SKUs: "ElasticPro" (app + modules) and "ElasticPro for Zabbix" (modules only).
- **Recommendation: (b).** The install paths genuinely differ — no core URL, no HMAC secret, no
  pairing, no Docker stack — and `deploy/PRODUCTION.md` would otherwise need an "if you have the
  core" branch on nearly every step.

---

## 7. Replacement, mode, or fork

**Recommendation: a mode, selected per cluster host by which template is linked.**

The reason is structural, not a preference. Every figure in every widget is addressed by a Zabbix
**item key**. `MasterTemplate` aggregates `elasticpro.delay[late]` and
`es.nodes.fs.total_in_bytes` by key; the volume widget discovers its columns from the item names
and tags of whatever template is called `ElasticPro client plan`. None of that code knows or
cares whether the key is filled by a trapper, an HTTP agent, an SSH session, or a calculated
expression. **The seam already exists, and standalone is a different template on the same key.**

Zabbix enforces the rest: two items with the same key cannot coexist on one host, so a cluster
host is on the pushed template or the direct one, never ambiguously both. Cutover is per client,
observable in *Latest data*, and reversible by relinking.

| Option | What it means | Maintenance cost |
|---|---|---|
| **Replacement** — delete the scraper and the trapper templates | One code path, smallest surface | **High, once.** The production Zabbix with seven clients and ~42 hosts cuts over in a single step. If the direct items turn out to be wrong, the data they should have collected is gone and unrecoverable. Also forfeits the automation document, which has no Zabbix equivalent at all |
| **Mode** *(recommended)* — both templates ship, same keys, per-client choice | Standalone is the default for new installs; existing installs migrate client by client | **Moderate, ongoing.** Two templates per data family must stay key-compatible, which a generator and a key-comparison test enforce cheaply (`tools/check-zabbix-templates.py` is the obvious home). The honest extra cost is documentation: every figure gains a "collected by which template" line |
| **Fork** — a separate repo of Zabbix-only modules | Clean standalone product, no conditionals | **Highest, forever.** The shared PHP in `integration/zabbix/shared/php` is already copied into each module by `sync-assets.mjs`; a fork makes that a cross-repo sync. Worse, `MasterTemplate`, `DevicesTemplate`, `JumpTemplate` and `ClusterTemplate` would exist in two places, and the dual-name compatibility layer and `zbx_rename.py` would have to be maintained twice. Reject |

The one argument for replacement is that a mode means two ways for a figure to be wrong. The
counter-argument is the unrecoverable-history rule, and it wins.

---

## 8. What standalone loses — plainly

| Lost | Why it cannot come back |
|---|---|
| Live logs, REST console, index browser | Interactive query tools against Elasticsearch. Zabbix has no page for these and should not grow one |
| Per-device delay drill-down — which device, which documents, what the trend is (`buildDeviceQuery`, `documentDelays`, `deviceSnapshot`, [`log-delay.js:507-575`](../ui/js/core/log-delay.js)) | Zabbix would hold 8 numbers per cluster. The per-device rows `delay_sink.rs` writes to Elasticsearch would stop being written unless something else writes them |
| The `_field_caps` preflight's honest refusal — *"this cluster cannot be analysed; `src_hostname.keyword` is missing"* ([`log-delay.js:94-130`](../ui/js/core/log-delay.js)) | Becomes an unsupported item carrying Elasticsearch's error instead of ours, or a macro the operator must get right by hand |
| Automation proposals: what is safe to delete, what was held back and why | The rules run in the core over its cached fleet, and a proposal is work for a person to confirm. A trigger states a condition; it cannot propose |
| Snapshot data coverage (`Snapshot Indices From/To`) at useful cost | Needs index names inside snapshots. `_cat/snapshots` does not give them; a verbose repository listing gets more expensive every month |
| Repository size at today's fidelity | No cross-run snapshot cache, so either the cap drops or the cadence does |
| "Troubleshoot in ElasticPro" deep links from a Zabbix problem | Nothing to link to. Zabbix's *Latest data* is the replacement |
| Raw ES bodies for figures nobody has thought of yet ([`fleet/catalogue.rs:3-6`](../crates/elasticpro-core/src/fleet/catalogue.rs)) | Zabbix stores numbers, not documents. Every new figure is a new item and a wait for history |

**Not lost, despite appearances:** the weekly client report. It is already a Zabbix scheduled
report over a Zabbix dashboard, driven by `{$EP.REPORT.WEEKLY}` and the client DL
([`AlertRouting.php:34,117`](../integration/zabbix/clients-module/lib/AlertRouting.php)). The
master template's three-page dashboard ([`MasterTemplate.php:403-444`](../integration/zabbix/clients-module/lib/MasterTemplate.php))
is likewise pure Zabbix — once Stage 1 lands, its Log delay page works standalone too.

---

## 9. Notes for whoever picks this up

- **Edit the shared PHP once.** `integration/zabbix/shared/php` is copied into each module by
  `integration/zabbix/sync-assets.mjs`. Never edit a module's copy.
- **Item history is unrecoverable, and so is data an item stopped collecting.** Every cutover in
  this plan is additive first and subtractive only after the replacement has history. Note the
  warning already written into `Store::holds_data()`
  ([`Store.php:63-88`](../integration/zabbix/shared/php/Store.php)): picking the wrong data folder
  once caused `deleteMissing` to delete every per-role item on every master host. The same class
  of mistake is available to anyone rewriting templates.
- **No PHP binary on this machine**, so `php -l` could not be run against anything here. The PHP
  in this plan was read, not syntax-checked.
- **Figures to confirm against the live production Zabbix before Stage 2 is costed:** how many
  indices the largest client has (the `_cat/indices` payload), and how many snapshots per
  repository (the `_status` loop). Both numbers change Stage 2's size, and neither is in this repo.
