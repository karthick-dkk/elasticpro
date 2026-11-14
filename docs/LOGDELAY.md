# Log delay report (0.3.57; composite pages, Fetch now, hourly report: 0.3.61; three levels, fixes on every row: 0.3.62)

Developer contract for the log delay report: the one definition of "late", the scheduled
measurement with silent devices and delay periods, the stored records, the recommended fixes,
the `LOGDELAY_*` messages, and the `log_delay` report kind with its HTML mail. The UI is built
from this file alone; where it and the code disagree, one of them has a bug. Decisions are
the owner's (canvas boards Main, Cluster, Device, Mail, Storage, Plan, Fix; 2026-11-05/07).
The figures on the boards are example data; the behaviour is the spec.

Code: `crates/elasticpro-core/src/logdelay/` (`levels`, `tz`, `measure`, `collect`, `state`, `store`,
`docs`, `fixes`, `summary`, `report`, `time`, `mod`), `report/logdelay_job.rs`, and the run in
`bridge.rs` `run_delay_sink`. Tests: each module's own, `tests/logdelay.rs`,
`tests/logdelay_scale.rs` (25 000 devices), `tests/delay_sink.rs`.

```text
  delay sink tick (every_hours, hosted, armed) · DELAY_SINK_RUN · Fetch now (JOB_RUN)
    └── per cluster: composite pages of ≤ 1000 devices (after_key) ──▶ readings (device, docs, arrival, event, extras)
          └── tracker.apply: the cluster's log time zone detected and taken out (tz), states, periods open/solve, silences
                ├── built-in store  <data>/logdelay/…          always (the pages read it)
                └── documents ──▶ history store | sink cluster   by destination, gated as before
    └── fixes over every cluster's stored periods + fleet-cache facts ──▶ findings.json
  LOGDELAY_* ──▶ summary over the built-in store ──▶ pages
  report kind log_delay ──▶ .xlsx (one sheet per section + Fixes), .csv, HTML + text mail
```

## Levels — one definition (`logdelay/levels.rs`)

| state | rule (minutes `m` = arrival − event) | label |
|---|---|---|
| `no_delay` | `m < delayFrom` (30) | on time ("Below 30 min") |
| `delay` | `delayFrom ≤ m ≤ criticalOver` (30–60, 60 inclusive) | delayed ("30–60 min") |
| `critical` | `m > criticalOver` (>60) | critical ("Above 60 min") |
| `little` | **not produced since 0.3.62** (there is no little-delay band — the owner's rule); kept so points and daily totals stored before it still read; everywhere counted and shown as `no_delay` | on time |
| `clock_ahead` | `m ≤ −delayFrom` (tested first) | clock ahead |
| `other_tz` | the raw gap sits at a real UTC offset other than the cluster's, two runs in a row ("Time zones" below) | other time zone — not late, counted apart |
| `silent` | seen recently, no document for `silentAfterHours` (2) | silent — never on time, never 0 min |
| `unmeasured` | arrival or event time unreadable | can't measure — never 0 min |

* `m` is the **corrected** delay: the raw gap (arrival − event) with the cluster's log time zone
  taken out ("Time zones" below). Without a zone the raw gap is the delay, as before 0.3.62.
* **Late** = `delay` or `critical`. **On time** (in totals and percentages) = `no_delay`,
  `clock_ahead` (and an old `little`). Silent, unmeasured and other-time-zone are neither.
* **`noDelayUnder` stays in the `levels` JSON for compatibility** (the settings file, the Zabbix
  modules and older clients send it) and is always equal to `delayFrom`: whatever is sent is
  ignored, the two lines `delayFrom` / `criticalOver` are the levels. The `little` counts in
  `totals`, `days[]` and the history store's daily mapping stay (always 0 now); the report's
  *Day by day* sheet has no Little delay column; a schedule's `devices: "little"` reads as
  `delayed`.
* **A delay period** starts at the first measurement ≥ `delayFrom` and is solved at the first
  measurement back under it. Silent or unmeasured measurements change nothing about an open
  period (unknown solves nothing). Start/solve times are the run's time: as exact as the
  interval.
* **Resolution per cluster** (`logdelay::levels_for`): `logdelay.json` `clusters.<id>.levels`
  → the clusters file's `delayThresholds` on that cluster (`delayMinutes` → `delayFrom`,
  `criticalMinutes` → `criticalOver`; today's override, kept) → `logdelay.json` `levels` →
  shipped 30/60. `LOGDELAY_SETTINGS_GET` says which (`levelsFrom`).
* **UI copy to remove**: `ui/js/core/log-delay.js` `DEFAULT_THRESHOLDS`, `thresholds(cluster)`
  and `classify()`; the per-cluster `delayThresholds` reading in `ui/js/core/config.js`
  normalisation stays only as the config field. Read `levels` from `LOGDELAY_SETTINGS_GET`
  (`resolved[].levels`) and classify with the table above. `STATUS` names map: OK→`no_delay`
  (+`little`), DELAYED→`delay`, CRITICAL→`critical`, CLOCK_AHEAD→`clock_ahead`,
  NO_DATA→`silent`, ERROR→`unmeasured`.

## Time zones (`logdelay/tz.rs`; applied in `state.rs` `Tracker::apply_run`)

**The problem (owner, 2026-11-14).** A device's raw message carries local time; the parser turns
it into `event_created` in UTC correctly; but `@timestamp` is stamped in the cluster's local time
and stored as if it were UTC. Arrival − event is then the zone's offset: 330 minutes, "critical",
on every device of an IST cluster whose logs are on time. Root cause in ElasticPro: delay was
arrival − event with no zone step, and the one check that called a steady delay "a time-zone
offset, not a queue" matched whole hours alone, so +05:30 and +05:45 never matched.

**The rule.**

1. **The cluster's log time zone** is, in this order: the zone set in its config (`logTimeZone`:
   `UTC`, or an IANA name such as `Asia/Kolkata`; a Zabbix cluster's in its overlay); otherwise
   the zone **detected** from its devices; otherwise none (no correction).
2. **Detection** (every complete run of a cluster): each device's raw gap is matched against every
   real UTC offset in use (the IANA database compiled in — `chrono-tz` — so half- and quarter-hour
   zones are in it: +05:30, +05:45, −03:30), within `TOLERANCE_MINUTES` = **3** (the figure the
   clusters file's `delayThresholds.tzToleranceMinutes` and the browser's `PATTERN.tzToleranceMinutes`
   have always named; one definition, tools/unit holds them equal). The cluster's zone is the offset
   most measured devices fall in when at least **60 %** agree (`MAJORITY_PERCENT`) **and** the same
   offset wins the last **3** complete runs (`STEADY_RUNS`). A queue drifts from run to run; an
   offset does not. It is let go the same way: three runs in a row without that majority — one odd
   run neither sets nor unsets a zone. UTC itself can be detected (most devices within 3 min of
   their arrival); nothing is corrected by it, but devices at another offset are then named.
3. **Corrected delay** = raw gap − the cluster's offset **at the event's own time**: DST-aware
   through the zone's rules when a name is known (set, or detected and named), the fixed offset
   when only an offset was detected. Every board, report, mail, Zabbix value and `LOGDELAY_*`
   answer uses the corrected figure; the raw gap is kept beside it (`rawGapMinutes`) and so is
   what was taken out (`tzOffsetMinutes`).
4. **Another time zone** (`other_tz`): a device whose raw gap sits at a real offset other than the
   cluster's, `DEVICE_STEADY_RUNS` = **2** runs in a row, is in another zone — its clock, or the
   parser's date filter for it. Not late, counted apart (`totals.otherTz`), its delay shown against
   its own offset, with its own offset (`+08:00`) in the *Device time zone* column. One run at
   another offset could still be a backlog, so the first one is levelled as measured. A device in
   another zone solves any open delay period of its own (it is not late).
5. **Unknown is not zero.** Under the majority, or not yet steady, the cluster says
   `timeZone.mode: "none"` — "not detected (41 % agree)" — nothing is corrected, delays are as
   measured, and no device is called "other time zone" (there is nothing to compare against). A
   named zone that is not in the database is refused at save time (`bad_request`, by name), never
   kept as "no correction".
6. **History is not rewritten.** Corrected figures apply from the next measurement; stored points,
   periods and day files stay as they were measured. The boards and the mail carry the note, with
   the instant detection began (`timeZone.since`).

**Naming a detected offset.** A detected zone is an offset. It is given a name only when one is
unambiguous — the server's own zone (`volume::schedule::server_zone`) or a zone set by name on
another cluster sits at that offset now; otherwise the pages show the offset (`+05:30`) and never
invent a name. The fix texts quote an *example* zone at an offset (`tz::example_zone`), as such.

**Partial runs** (one device, the late devices — "Fetch now") are not runs the zone is detected
from; they are corrected by the zone in force.

**`timeZone`** — on every `byCluster[]` row, `LOGDELAY_CLUSTER`, `LOGDELAY_DEVICE` and
`LOGDELAY_SETTINGS_GET` `resolved[]` (with `logTimeZone`, the setting: `detect` | `UTC` | name):

```json
{ "setting": "detect", "mode": "detected", "zone": "Asia/Kolkata", "offsetMinutes": 330, "offset": "+05:30",
  "agree": 1112, "of": 1240, "pct": 89.7, "pluralityOffset": 330, "pluralityOffsetText": "+05:30",
  "since": 1763000000000, "steadyRuns": 3, "runsNeeded": 3, "majorityPercent": 60, "toleranceMinutes": 3.0 }
```

`mode` is `set` (offset now, `zone` the setting), `detected` (`zone` null when no name is
unambiguous) or `none` (`offsetMinutes` null; `pct` says how many agree on `pluralityOffset`).
`agree`/`of`/`pct` are the last complete run's; null before any. `since` is the first of the runs
that agreed (detected only).

**Rows.** `DeviceRow` carries `rawGapMinutes`, `tzOffsetMinutes` (what was taken out: the
cluster's offset, or the device's own for `other_tz`; null = nothing, the cluster has no zone),
`deviceTzOffset` (the real offset the gap sits at, if any) and `clusterTzOffset` (the cluster's
offset now, null = none). The Delay cell's title spells the sum out: *arrival 10:42 − event 04:30
− time zone 5 h 30 = 42 min*. *Device time zone* reads `same as cluster`, the device's offset for
`other_tz`, `—` when the cluster has no zone. The measurement documents carry `raw_gap_minutes`,
`tz_offset_minutes`, `device_tz_offset`; the day's totals `otherTz`.

**Setting it.** Config-Management › Clusters › Edit cluster › **Log time zone**: *Detect from
devices (now: Asia/Kolkata, +05:30)* (default), *UTC (no correction)*, then every IANA zone with
its offset now. A config-file cluster writes `logTimeZone` on its entry (`CLUSTER_SAVE` checks the
name and keeps the canonical spelling; `detect` is not written); a Zabbix cluster keeps it in
ElasticPro's overlay (`ZABBIX_CLUSTER_SAVE {set: {logTimeZone}}`, reset = detect). Write-gated as
every cluster edit. The core reads it off the cluster's spec (`ClusterSpec.logTimeZone`, carried
on `PRIME` by the UI).

**Recommended fixes.** Two rules read from this (table under "Recommended fixes"): `device_time_zone`
(*Device clock / parser*: devices in another zone, one finding per offset, the Logstash
`date { timezone => "…" }` hint with an example zone) and `cluster` (*Cluster*: the setting is
`detect` and over half the measured devices sit at one offset — "set it" while it is not detected,
naming the devices that show the offset as delay; "confirm it" once it is). UTC as the plurality
raises no Cluster finding: nothing would change.

**Browser.** `ui/js/core/log-tz.js` is the same rule for what the browser measures itself (Live
Watch, Live logs, Play, the Zabbix scraper): the cluster's `timeZone` as the core said it
(`delay-levels.js zoneOf`, remembered from `byCluster`/`resolved`/a cluster answer), a named zone
applied at the event's time through Intl, a detected offset fixed, `none` corrects nothing. A live
row cannot know steadiness, so it says *looks like +08:00* for a gap at another offset and levels
the corrected delay. Live logs write `@timestamp` and the event time in the same (cluster) zone,
the offset in each head, so the difference seen is the delay.

## Measurement (`logdelay/measure.rs`, `bridge.rs` `run_delay_sink`)

* The schedule is `delay_sink.rs`'s: hosted only, armed by an admin (`DELAY_SINK_SET`),
  `everyHours` 1–24, default **2**, 60 s tick, back-off on failure. Unchanged.
* **Destination** (`DELAY_SINK_SET config.destination`): `cluster` (a sink cluster, as before
  0.3.53; needs the config's `readOnly=false`), `history` (the history store, under its two
  gates — `HISTORY_STORE_WRITES=true` and *Write history* armed after a passing test — and the
  routing's history kind not `builtin`), or **`builtin`** (new): the server's own files only,
  nothing written to any cluster; needs only arming and a primed cluster. The built-in store
  is written in every mode; the destination gets a mirror.
* **Fields per cluster** (`Core::logdelay_fields`): `auth::DelayShape` (the cluster's own
  `delayFields`/`timeField`/`logIndexPattern`, the clusters file's `defaults:`, config.txt
  `UI_TIME_FIELD`/`UI_LOG_INDEX_PATTERN`, the shipped names) with `logdelay.json` `fields`
  (defaults for every cluster) and `clusters.<id>.fields` over it. Device field is aggregated
  (`src_hostname.keyword`); arrival `@timestamp`; event-time fields tried in order
  (`event_created`, `ingested_time`, `event.created` by default); extras default
  `tag1, fwd_tag, parser_tag, Zone` (≤ 12 names).
* **Pages, nothing cut** (`measure::page_body`, `collect.rs`): per cluster, a composite
  aggregation on the device field, read `after_key` by `after_key`, at most 1000 devices a page
  (halved, down to 100, when a page's answer is over `memory::report_page_bytes`, or when it is
  over the response cap — `response_too_large` is asked again smaller, not a failure). Each
  bucket's `top_hits 1` (newest by arrival) brings the arrival, **every** event-time candidate
  and the extras in `_source`; a document is read by the first candidate it carries, as text or
  epoch milliseconds. Every bucket is a reading; unreadable times give `delay_minutes: null`.
  One page's answer is held at a time and dropped once read; the run keeps the readings
  (a few hundred bytes a device: 25 000 devices ≈ 10 MB), never the answers.
* **The window** is absolute: `[now − everyHours, now]` in epoch ms, fixed when the run starts,
  so every page reads the same documents however long the run takes.
* **Max devices per run** (`DELAY_SINK_SET config.maxDevices`, *Max devices per run*): 1–100 000,
  default 20 000 for a new config (a saved one keeps its value). It bounds a run's length and
  what it keeps, not a request. Reaching it is said: the run's note names the clusters, the
  cluster's `lastRead.truncated` is true with `maxDevices`, and the devices after the cap (by
  name) are **not** turned silent — the list was not complete, so nobody it did not read is.
* **A page that fails** (shards failed or timed out in a 200: asked again twice; an HTTP error,
  refusal or unreachable cluster: not asked again) ends the cluster's read: what was read is
  kept and applied as an incomplete list (nobody else turned silent), the run is `failed` and
  says how many devices were read.
* **No device name**: the first page also counts the window's documents without one
  (`lastRead.noDevice`) — they are in no bucket, so they are said, not dropped. A device name
  longer than the keyword's `ignore_above` (256 by default) is not indexed as a keyword and
  cannot be in any aggregation: those documents count here too.
* Per cluster, how the last run read it is kept with the tracker as `lastRead`:
  `{at, from, to, devices, pages, complete, truncated, maxDevices?, noDevice?, error?}`.
* **Silent**: a device in the tracker not in this run's buckets, whose last arrival is
  ≥ `silentAfterHours` ago → `silent`; a silence record opens (`from` = last arrival). The
  first arrival after ends it with what came back (`burstDocs`, `burstMinutes`). A device not
  seen for 7 days is forgotten (its open period is kept unsolved).

## Which devices — live, now, in the range (one definition)

The one query above is every measurement's: the timer's, `DELAY_SINK_RUN` and *Fetch now*. The
pages count devices three ways, side by side, from the store (`summary::device_counts`,
`byCluster[].counts`, `LOGDELAY_CLUSTER.counts`):

| count | which devices | what shows it |
|---|---|---|
| `inLastRun` | sent at least one document in the last run's window (`everyHours`) — what a live check sees | "live", after *Fetch now*; `DeviceRow.inLastRun` |
| `now` | every device the tracker holds: those plus the silent ones (seen in the last 7 days) | `totals.devices`, the tiles |
| `inRange` | measured at any time in the range (a measurement in it, silent included, or a delay period overlapping it) | the device list, the report |

So for one cluster a live check over the last 2 hours and the 30-day report can name different
numbers of devices, and both are right: a device that was late on Tuesday and has sent nothing
since is in the report's range and not in the live window. The device list (`device_rows`) is
filtered to the range: a report for yesterday lists yesterday's devices, not every device the
tracker remembers (it used to list all of them — devices silent or last seen before the
range were in it). `devicesInRange` and `devicesInLastRun` sit beside `devicesTotal` in
`LOGDELAY_SUMMARY`.

**The browser's live check** (`ui/js/core/log-delay.js` `measureDelay`: the Logs & Delay page's
*Fetch*, Play's wall, the headless scrape) is a different query: one `terms` aggregation of at most
500 devices (the display link's gate, `auth.rs` `delay_search_body`, allows no more), over 24 h by
default. Its "Devices across the fleet: 500 device(s)" was that cap; the devices past it are in
`sum_other_doc_count`, not in the list. It also read each cluster's devices by **one** event-time
field — the first candidate the index pattern's mapping has anywhere — so every device whose
logs carry another candidate (or epoch-millisecond numbers) was "error": in a fleet where some
log types carry `ingested_time` and others `event_created`, about half the devices. It now reads
every candidate per document, as the core does. The cap stays the browser's; the Log Delay page
reads the store (*Fetch now* below), which has none.

## Fetch now — `JOB_RUN {jobId: "logdelay.measure", clusterIds: [one], devices?: "late"|"all", device?}`

The page's *Fetch now*: the scheduled measurement, now, by the same code and query
(`run_delay_sink` → `logdelay_collect`), into the same store and destination — for **one cluster**.

* `clusterIds` names **exactly one** cluster (owner's rule: a person never runs every cluster by
  hand; the automatic run reads every device of every cluster every 2 hours). Missing, empty or
  more than one: `bad_request` with the reason in plain words; an unknown id `not_found`.
* `devices: "late"` (the default) re-measures only that cluster's devices whose stored state at
  the run's start is **late** — `delay` (30–60) or `critical` (above 60), by the cluster's own
  levels (the one definition, "Levels") on the time-zone-corrected delay; never a figure of its
  own — in one `terms` filter on the device field (above `LATE_FILTER_MAX` = 10 000
  late devices the whole cluster is read instead, and the note says so). None late at the start:
  nothing is read, the run completes with 0 and the note says why. **Silent devices are covered
  only by `all` and by the automatic run**: a late-devices run cannot hear from them.
* `devices: "all"` re-measures every device of the cluster, as the automatic run does (it is a
  complete run of that cluster: silences, forgetting and the zone's detection apply).
* `device` (one device name as the measurement lists it: no `*`/`?`, ≤ 256 characters,
  `bad_request` otherwise) re-measures that device alone, by a `term` filter; `devices` is then moot.
* A narrowed run (late devices, one device) reads part of the list, so it turns nobody silent and
  leaves the cluster's `lastRunAt`/`lastRead` as the whole run's. Every person's run leaves the
  schedule's own state (`lastRunAt`, `nextDueAt`, back-off) alone. Its periods, points and daily
  totals are written as any run's; the destination gets the same mirror, under the same gates (a
  sink cluster while the config is read-only: `blocked_readonly`).
* Administrator who sees every cluster (docs/JOBS.md "Controls"); hosted only (`unsupported`).
* One run at a time with the timer and `DELAY_SINK_RUN`: a second press answers
  `already_running` with the open run's id.
* Answer `{ok, jobId, runId, started}` at once; the run goes on in the background. In
  `JOBS_LIST` (`jobId: "logdelay.measure"`) it is `manual:<user>`, `done`/`total` = **devices**
  read of the devices set out for (the late list, or the cluster's devices as last known; ended,
  both are the devices that answered), `progress` the percent, `records` = devices read so far
  (updated after every page) and, once ended, the rows written; `note` names the cluster and the
  scope — `fetch now: prod-logs-eu, late devices (18 of 1 240 at the start)`, `…, whole cluster`,
  `…, device fw-7` — and any cut at *Max devices per run*; `scope` keeps
  `{clusterIds, device, devices}` so `JOB_RETRY` runs the same scope again.
* Refused before it starts (nothing primed, no destination, the history store closed): the run
  is `skipped` with the reason, as the timer's.

## Where it is kept

### Built-in store (always; `logdelay/store.rs`)

```text
<data>/logdelay.json                          settings
<data>/logdelay/clusters.json                 directory name → cluster id (a directory name is a file-safe rendering of the id)
<data>/logdelay/<cluster>/tracker.json        per-device state, open period, open silence, 31 days of points as [t, m, s]; solved periods and silences (90 days)
<data>/logdelay/<cluster>/daily.json          day → totals (90 days)
<data>/logdelay/<cluster>/m/YYYY-MM-DD.ndjson one measurement document per device per run (90 days)
<data>/logdelay/findings.json                 the fixes as last matched (last 7 days)
```

Kept **90 days** (Storage board); pruned after every run. A tracker is parsed once and held
in memory, replaced when the run writes it; the pages never re-read the file. Days are **server-local** days
(`TZ`, IST on our stacks): daily totals, windows, "today", "14:00–18:00".

### Elasticsearch (history store or sink cluster; `logdelay/docs.rs`)

`<prefix>` = `<history prefix>-delay` (store; default `elasticpro-history-delay`) or the sink's
`indexPrefix` (`elasticpro-log-delay`). Every document carries `record`.

| record | index | `_id` | fields |
|---|---|---|---|
| `measurement` | `<prefix>-YYYY.MM` (as before) | `cluster\|device\|hour` — a rerun in the hour overwrites | `@timestamp` (hour bucket), `measured_at`, `cluster`, `device`, `docs`, `arrival_time`, `event_time`, `delay_minutes` (null = can't measure), `state`, `extras.{…}` |
| `period` | `<prefix>-episodes-YYYY` | `cluster\|device\|started` — solving overwrites the open one | `@timestamp` (started), `cluster`, `device`, `started`, `solved` (null while open), `open`, `lasted_minutes`, `worst_minutes`, `worst_state`, `last_minutes`, `last_state`, `measurements`, `pattern`, `extras` |
| `daily` | `<prefix>-daily-YYYY` | `cluster\|day` — every run rewrites today; the first run of a new day rewrites yesterday complete | `@timestamp` (day), `day`, `cluster`, `clusterName`, `devices`, `measured`, `onTime`, `little`, `delayed`, `critical`, `clockAhead`, `silent`, `unmeasured`, `startedCount`, `solvedCount`, `lateHours`, `medianMinutes`, `p95Minutes`, `complete`, `writtenAt` |

* Store template `<history prefix>-delay-template` on `<history prefix>-delay-*`, priority 210
  (above the general 200), mappings only, extras as keywords by dynamic template; created
  `create=true`, verified once per process (`history_ensure_template_for("logdelay")`).
* **Retention on Elasticsearch is not built**: the templates hold mappings only (no ILM —
  `guard.rs` refuses settings), as for every history index; the store owner's ILM applies.
  The Storage board's 13 months / 3 years are documented targets for that policy.
* `HISTORY_QUERY stream:delay` returns measurements only (`must_not record: period|daily`).
* Mirror only: the pages never read Elasticsearch for this report.

## Delay periods, silences, daily totals (`logdelay/state.rs`)

`Tracker::apply(run_ms, readings, levels, silent_after_ms)` is the pure transition; the
tests in `state.rs` are the spec. `state::daily(tracker, day, from, to, now)` makes a day's
totals: each device once by its **last state of the day**; `started`/`solved` by instant;
`lateHours` = overlap of periods with the day; `medianMinutes`/`p95Minutes` of devices'
last measured delay (`null` when nothing measured); `complete` when the day had ended.

## Recommended fixes (`logdelay/fixes.rs`)

Deterministic rules over the stored periods of a range (default last 7 days) and
`ClusterFacts` from the fleet cache (`Shards.threadPools` write `rejected`,
`Policies.slm` last snapshot start/end, `Policies.clusterSettings` high watermark against
`Nodes.alloc disk.percent`). Unknown facts stay unknown and are named in `missing`.

| step | rule |
|---|---|
| `device_time_zone` | devices in `other_tz` now, one finding per offset (*Device clock / parser*): the gap sits at a real offset other than the cluster's two runs running; fix names the parser's `date { timezone => "…" }` with an example zone ("Time zones") |
| `cluster` | the setting is `detect`, over half the measured devices sit at one non-UTC offset (*Cluster*): under the majority, "only x % of its devices agree on one offset … so no correction is applied — check the devices' clocks and the parser's date filter; the zone is taken from the majority once 60 % agree" (devices named); once detected, "nothing to set" (0.3.62: the page offers no chooser; the config's `logTimeZone` stays an admin override) |
| `elasticsearch` | ≥ `max(5, 20 % of devices)` late in the same `everyHours` window(s), spanning ≥ 2 `fwd_tag`s (or no `fwd_tag` at all — then named as missing); evidence: devices, windows, days, forwarders, `writeRejected`, `nodesOverWatermark`, snapshots overlapping the windows (named in the fix) |
| `forwarder` | late devices share one `fwd_tag` (else `Zone` when no `fwd_tag` exists): ≥ 2 late, ≥ half of that tag's devices, other tags ≤ 20 % late |
| `parser` | same by `parser_tag`, and the late devices span ≥ 2 forwarders |
| `device_clock` | ≥ 80 % of a device's late measurements (after the cluster's zone is taken out) within 3 min of a real UTC offset (60, 120, 330, 345 …), or clock-ahead readings |
| `device_link` | a silence followed by a first reading ≥ 30 min late |
| `unknown` | the rest: "not enough evidence", with `missing` (`fwd_tag`/`parser_tag` on these devices, more measurements) |

Each finding: `{cluster, step, stepLabel, devices[], group: [field, value] | null, why, fix,
evidence{…numbers}, missing[]}`. Group findings claim their devices in the order above (a device
with a time-zone finding is claimed first); the per-device view (`fixes::per_device`) is each
device's first group. No model, no guess. `LOGDELAY_FIXES` `rules` lists eight rows.

**On every board (0.3.62, `mod.rs` `attach_fixes`)**: `LOGDELAY_SUMMARY` and `LOGDELAY_CLUSTER`
carry the kept findings (`findings.json`, the last 7 days as the last run matched them; matched
now when nothing is kept): every `devices[]` row has `fix` — its own finding (`devices: [itself]`),
`null` when no rule matched it — and every `byCluster[]` entry (a cluster answer: top level) has
`fixes`, that cluster's findings most devices first, the cluster's own time-zone finding among
them. This is the one source of every "i" on the page; the UI writes no cause or fix of its own.

## Messages (`logdelay/mod.rs`)

Roles (`auth::required_role`): `LOGDELAY_SUMMARY|CLUSTER|DEVICE|SEARCH|FIXES` → **User**, on
the clusters the caller sees (`visible_ids`); `LOGDELAY_SETTINGS_GET|SET` → **Admin**;
`SET` is refused `forbidden` for a limited admin. Unauthenticated → `unauthenticated`
(`tools/hosted-check.sh`). No data directory → `kind: no_store`.

Common inputs: `from`/`to` `YYYY-MM-DD` local days (default: last `days`, 30; ≤ 1200),
`clusterIds[]` (optional narrowing). Every answer carries `from`, `to`, `now` (ms).

Every row of every `LOGDELAY_*` answer that names a device — `DeviceRow`, `LOGDELAY_FIXES`
`devices[]`, `LOGDELAY_DEVICE` — carries `zone` and `tag1` (the extra columns `Zone` and `tag1`,
read whatever their case; `null` = the device's logs do not say). Both are always among the
extras measured (`Settings::extras_for` adds them to a list that leaves them out).

### `LOGDELAY_SUMMARY {from?, to?, days?, clusterIds?, maxDevices?}` — Main board

```json
{ "ok": true, "from": "2026-10-06", "to": "2026-11-04", "label": "6 Oct – 4 Nov", "now": 1762250000000, "everyHours": 2,
  "clusters": 32, "measuredClusters": 32,
  "totals": { "devices": 1284, "measured": 1270, "onTime": 1238, "noDelay": 1200, "little": 38, "delay": 25, "critical": 12,
              "clockAhead": 0, "otherTz": 2, "silent": 9, "unmeasured": 5, "late": 37, "pctOnTime": 96.4, "pctLate": 2.9, "pctSilent": 0.7, "pctUnmeasured": 0.4 },
  "reduced": [ { "hours": 2, "n": 4 }, { "hours": 4, "n": 7 }, { "hours": 6, "n": 9 }, { "hours": 12, "n": 15 }, { "hours": 24, "n": 23 } ],
  "newlyLateToday": 6, "solvedToday": 4,
  "yesterday": { "newlyLate": 19, "solved": 23, "averageLastedMs": 6600000 },
  "windows": [ { "from": 0, "to": 0, "label": "00:00–02:00", "newlyLate": 2, "solved": 1, "stillLate": 30, "delay": 21, "critical": 9, "complete": true } ],
  "days": [ { "day": "2026-11-04", "devices": 1284, "onTime": 1200, "little": 38, "delayed": 25, "critical": 12, "clockAhead": 0, "silent": 9,
              "unmeasured": 5, "started": 19, "solved": 23, "lateHours": 41.5, "medianMinutes": 4.1, "measured": 1270, "complete": true,
              "onTimeAll": 1238, "late": 37 } ],
  "byCluster": [ { "id": "client-a-prod", "name": "client-a-prod", "devices": 412, "measured": 410, "lateNow": 14, "delay": 9, "critical": 5, "silent": 1,
                   "unmeasured": 1, "otherTz": 2, "timeZone": { "…": "Time zones" }, "below": 396, "belowPct": 96.1, "latePct": 3.4, "belowPctPrevious": 95.2, "newToday": 3,
                   "windows": [ { "…": "today's windows, this cluster alone (the heat map's Today)" } ], "fixes": [ { "…": "Finding + stepLabel, most devices first" } ],
                   "sparkline": [12, 9, null, 14], "sparklineDays": ["2026-10-06", "…"], "worst": { "device": "fw-dc1-07", "minutes": 94.0, "state": "critical" },
                   "levels": { "noDelayUnder": 15.0, "delayFrom": 30.0, "criticalOver": 60.0 }, "lastRunAt": 1762249000000,
                   "counts": { "inLastRun": 401, "now": 412, "inRange": 418, "lastRead": { "…": "as lastRead" } }, "lastRead": { "at": 0, "devices": 401, "pages": 1, "complete": true, "truncated": false } } ],
  "devices": [ "<DeviceRow>" ], "devicesTotal": 1284, "devicesInRange": 1290, "devicesInLastRun": 1270, "devicesTruncated": false,
  "schedule": { "supported": true, "enabled": true, "everyHours": 2, "destination": "builtin", "lastRunAt": 1762249000000, "state": { "…DELAY_SINK state" } } }
```

Board figures (0.3.62): the five tiles = `totals` (`onTime` = below the delay line, `delay`,
`critical`, `otherTz`, `silent` with `unmeasured` named under it); *Devices behind* = `days[]`
(`delayed`, `critical`, `solved`) or, for Today, `windows[]` (`stillLate`, `solved`); the heat map
= `byCluster[].sparkline` over `sparklineDays` (days) or `byCluster[].windows` (Today); *By
cluster* = `byCluster` (`timeZone`, a states bar from `below`/`delay`/`critical`/`otherTz`/`silent`/
`unmeasured`, `lateNow` ("30+ min"), `latePct` ("Late share"), `critical`, `otherTz`, `devices`,
`counts.inLastRun`, `worst`, the "i" from `fixes`; every column sorts, most delayed first by default,
the 5 most delayed shown until *Show all N* — then 30 a page with Previous / Next); *Devices* (its own tab) = `devices` sorted by time late until a column heading
is pressed (every Log delay table sorts by any column, remembered in the browser; a state sorts
worst first, "can't measure" last). `sparkline` entries are `null` for a day without totals —
draw a gap, not zero. `byCluster[].lastRunAt: null` = never measured — say so. `reduced`,
`yesterday`, `medianMinutes` and the percentages are still answered; the page draws no median,
percentile or average.

`DeviceRow` (every device table, every message):

```json
{ "device": "fw-dc1-07", "cluster": "client-a-prod", "clusterName": "client-a-prod", "state": "critical", "nowMinutes": 94.0,
  "medianMinutes": 6.0, "maxMinutes": 212.0, "episodes": 5, "solved": 4, "lateMs": 67200000, "lastStarted": 1762240500000, "lastSolved": null,
  "lateSince": 1762240500000, "docsPerDay": 41000, "lastArrival": 1762250400000, "lastEvent": 1762244760000, "silentSince": null,
  "zone": "dc1", "tag1": "firewall", "inLastRun": true,
  "rawGapMinutes": 424.0, "tzOffsetMinutes": 330, "deviceTzOffset": null, "clusterTzOffset": 330,
  "fix": { "step": "forwarder", "stepLabel": "Forwarder", "why": "…", "fix": "…", "group": ["fwd_tag", "syslog-dc1-02"], "devices": ["fw-dc1-07"], "missing": [] },
  "extras": { "Zone": "dc1", "tag1": "firewall", "fwd_tag": "syslog-dc1-02", "parser_tag": "fortigate-grok" } }
```

`nowMinutes` is the corrected delay; `rawGapMinutes` − `tzOffsetMinutes` = `nowMinutes`
("Time zones"). A `by cluster` row's `otherTz` and `timeZone` are the cluster's.

`nowMinutes: null` with `state: silent|unmeasured` — show "—" / "can't measure". *Last delay:
started → solved* = `lastStarted` → `lastSolved` (`lateSince` set = "still late"; `silentSince`
= "no logs since"). *Time late* = `lateMs`. *Logs a day* = `docsPerDay` (`null` = unknown).

### `LOGDELAY_CLUSTER {clusterId, from?, to?}` — Cluster board

`{ ok, cluster, name, from, to, label, now, everyHours, levels, fields {pattern, device, arrival, eventTime[], extras[]}, timeZone,
lastRunAt, counts {inLastRun, now, inRange, lastRead}, lastRead, totals{…as above}, started, solved, medianNow, medianPrevious, windows[], days[], devices[DeviceRow] }`.
Tiles (0.3.62): the same five counts as the fleet's; `started`/`solved` in the counts line;
`medianNow`/`medianPrevious` are still answered and not drawn. `fixes` = the cluster's findings
(the head's "i"). Footer: `fields` names.

### `LOGDELAY_DEVICE {clusterId, device, from?, to?}` — Device board

```json
{ "ok": true, "device": "fw-dc1-07", "cluster": "client-a-prod", "clusterName": "…", "from": "…", "to": "…", "label": "…", "now": 0, "everyHours": 2, "levels": {…},
  "state": "critical", "nowMinutes": 94.0, "lateSince": 1762240500000, "silentSince": null, "medianMinutes": 6.0,
  "worst": { "minutes": 212.0, "at": 1760891400000 }, "episodes": 5, "solved": 4, "lateMs": 67200000, "latePct": 2.6, "docsPerDay": 41000,
  "lastSilence": 1761720000000, "extras": {…}, "zone": "dc1", "tag1": "firewall", "inLastRun": true, "lastArrival": 0, "lastEvent": 0, "firstSeen": 0,
  "points": [ { "t": 1762250400000, "m": 94.0, "s": "critical" }, { "t": 0, "m": null, "s": "silent" } ],
  "periods": [ { "started": 0, "solved": null, "ended": null, "lastedMs": 9900000, "worstMinutes": 94.0, "worstState": "critical", "lastMinutes": 94.0, "lastState": "critical",
                 "measurements": 11, "pattern": null, "extras": {…} } ],
  "silences": [ { "from": 0, "to": 0, "burstDocs": 6800, "burstMinutes": 90.0 } ],
  "insights": { "peak": { "minutes": 212.0, "at": 0 }, "average": { "minutes": 9.0, "measurements": 360 },
                "longest": { "lastedMs": 37800000, "started": 0, "solved": 0 }, "solvedIn": { "averageMs": 14400000, "solved": 4 },
                "lateMostOften": { "label": "14:00–18:00", "count": 3, "of": 5 } },
  "finding": { "step": "forwarder", "why": "…", "fix": "…", "evidence": {…}, "group": ["fwd_tag", "syslog-dc1-02"], "devices": ["fw-dc1-07"], "missing": [] } | null,
  "clusters": [ { "id": "…", "name": "…", "lateNow": 14, "sparkline": [..], "days": [..], "peak": 23, "peakDay": "2026-10-19" } ],
  "olderMeasurements": [ { "t": 0, "m": 5.0, "s": "no_delay" } ], "olderTruncated": false }
```

`points` is the graph (one per run, 31 days held in the tracker; `m: null` = silent/can't
measure, draw no dot); `periods` are the shaded bands and the *Every delay* table (`pattern`
= "Looks like": `"a whole hour off: time zone"`, `"clock ahead"` or null = "—"); `insights.*`
null = not known (no solved period → no "Solved in"). A period with `solved: null` and
`ended` set ended unsolved when its device was forgotten: not open, not "still late", and it
lasted until `ended`. `olderMeasurements` appears only when
the range reaches past the tracker's 31 days (read from the day files, ≤ 20 000).
`not_found` when the device is not in the tracker (forgotten after 7 days unseen).

### `LOGDELAY_SEARCH {name?, field?, value?, clusterIds?, from?, to?, max?}`

`name` = device name contains (case-insensitive); `field` + `value` = `device`/`src_*` (the
device name) or an extra column, `value` with `*`/`?` wildcards, whole value, case-insensitive;
both apply when both given. `{ ok, matches, truncated, clusters[], devices[DeviceRow], from, to }`.

### `LOGDELAY_FIXES {clusterIds?, from?, to?}` (default last 7 days) — Fix board

Without `from`/`to`/`days`, served from `findings.json` (what the last run matched over its
last 7 days, narrowed to the caller's clusters); with them, matched now. `matchedAt` = when.

`{ ok, from, to, now, matchedAt, findings[Finding + stepLabel + clusterName] (most devices first),
devices: [ { device, cluster, clusterName, state, nowMinutes, zone, tag1, step, stepLabel, why, fix, group } ] (worst first),
rules: [ { pattern, step, readFrom, recommendation } ×6 ] }`.

### `LOGDELAY_SETTINGS_GET` / `LOGDELAY_SETTINGS_SET {settings}` — Storage board (Admin)

```json
{ "ok": true, "supported": true,
  "settings": { "levels": { "noDelayUnder": 15.0, "delayFrom": 30.0, "criticalOver": 60.0 }, "silentAfterHours": 2,
                "fields": { "device": "src_hostname", "arrival": "@timestamp", "eventTime": ["event_created"], "extras": ["tag1", "fwd_tag", "parser_tag", "Zone"] },
                "clusters": { "client-a-prod": { "levels": {…}, "fields": {…} } }, "setBy": "Admin", "setAt": 0 },
  "resolved": [ { "id": "…", "name": "…", "levels": {…}, "levelsFrom": "settings|configFile|default", "fields": { "pattern": "logstash-*", "device": "src_hostname.keyword", "arrival": "@timestamp", "eventTime": [..], "extras": [..] },
                  "logTimeZone": "detect|UTC|Asia/Kolkata", "timeZone": { "…": "Time zones" } } ],
  "timeZones": { "toleranceMinutes": 3.0, "majorityPercent": 60, "steadyRuns": 3, "server": "Asia/Kolkata" },
  "schedule": { "enabled": true, "everyHours": 2, "destination": "builtin|history|cluster", "clusters": [], "maxDevices": 20000, "state": {…}, "blocked": null },
  "builtinStore": { "keepDays": 90, "bytes": 123456, "recentDays": 31, "dir": "logdelay",
                    "sizes": { "bytes": 123456, "trackersBytes": 0, "dailyBytes": 0, "dayFilesBytes": 0, "dayFiles": 0, "clusters": 0 } },
  "extrasDefault": [..], "uiCopy": "…" }
```

A limited admin (Zabbix-group scope) gets `settings.clusters`, `resolved` and
`schedule.clusters` narrowed to the clusters they see; `SET` stays full-admin only.

`SET` takes a partial `settings` object (top-level keys replace: `levels`, `silentAfterHours`
1–168, `fields`, `clusters`); refused `bad_request` naming a bad field name or unknown cluster.
The schedule itself (every N hours, destination, clusters) stays `DELAY_SINK_SET` (Admin).

## Report kind `log_delay` (`report/logdelay_job.rs`, `logdelay/report.rs`)

* `REPORT_RUN {kind: "log_delay", clusterIds, period?, mail?, options?}` → one job for all
  the clusters (like `indices`); reads the built-in store only, so it builds under the
  emergency stop. `REPORT_SCHEDULE_GET|SET {kind: "log_delay", …, options?}`: default daily
  07:00 over **yesterday**, subject `Log delay · {period}` (+ ` · N devices late, M critical`
  on the mail), managed keys `UI_REPORT_LOGDELAY_TO|SCHEDULE|AT`. `REPORT_SEND_NOW {kind}` as
  for the other kinds. `GET` adds `options` (in force) and `optionsChoices`.
* **Options** `{ devices: "delayed"|"little"|"all", groupBy: "cluster"|<extra column>,
  columns: [..], sections: [..], xlsx: bool, csv: bool, pdf: bool, top: 1–100 }`. Columns:
  `device, cluster, nowMinutes, level, startedSolved, median, max, episodes, lateTime, docsPerDay,
  arrival, eventTime, lateSince` and any extra column. Sections: `summary, lateEvery2h,
  windows, dayByDay, topDelayed, fixes`. Unknown names are refused by name.
* **Attachments**: `elasticpro-log-delay-<from>_<to>.xlsx` (`elasticpro-log-delay-<YYYY-MM-DDTHH00>.xlsx`
  for an hour) — sheets *Summary* (with a *Zone · tag1* table: devices, late now, above 60 min,
  silent per pair, the most late first; "—" where the logs do not say), *Devices* (chosen
  columns, group column first when not cluster, + Step/Likely why/Fix), *Every N hours*, *Day by
  day*, *Top delayed*, *Fixes* — and `…-devices.csv` (the Devices sheet).
* **Zone and tag1 everywhere**: the Devices sheet and the CSV always carry `Zone` and `tag1`
  (added after the cluster when the chosen columns leave them out); *Top delayed* has both
  columns; *Fixes* names the zones and tag1s of each finding's devices; the mail's *Top delayed*
  has both and its Summary a *By zone and tag1* table (12 pairs, the rest named as in the
  attachment). *Every N hours* and *Day by day* are counts per time window over all devices
  (no device rows): they are not split by zone.
* **No measurement in the period** (an hour between two-hourly runs, a range before the first
  run): the mail and the text say so at the top; the figures shown are the devices' states now.
  **PDF: not built** — there is no PDF writer in the tree; `pdf: true` round-trips and the
  job's `warning` says so.
* **Mail**: `multipart/alternative` text + HTML inside `multipart/mixed` with the files
  (`mail::message_parts`; the volume kinds still send plain text). HTML sections follow the
  Mail board: Summary tiles, *Late devices every N hours* (bar per window: pink late, green
  under), *Every N hours* table, *Day by day · last 7 days*, *Top delayed*, *Recommended fixes*
  (top 3 that are not "unknown"), *Open the full report* when `UI_PUBLIC_URL` is set in
  config.txt (`<url>/#/reports/log-delay`, which opens the Log Delay page since 0.3.60). Tables and inline styles only; colours light
  green `#DDF3E4`, blue `#DCEBFA`, pink `#FBDCE6`, orange `#FDE4CC`.
* Period days are local days; `yesterday`/`last7`/`previousWeek`/`previousMonth`/`{from,to}`
  as every report, and **`lastHour`** (this kind only): the whole server-local hour before now.
* **Hourly** (this kind only; `REPORT_SCHEDULE_SET {kind: "log_delay", schedule: "hourly", at}`,
  `JOB_CREATE {report: "log_delay", schedule: "hourly", …}`, `UI_REPORT_LOGDELAY_SCHEDULE=hourly`):
  every hour, at `at`'s minute past it (`00:10` = ten past), over the whole local hour before —
  next to the daily and monthly schedules (a created schedule each). The period carries `hour`
  (its start, epoch ms) beside `from` = `to` = its local day; its key `<from>..<to>@<hour>` is
  remembered so an hour is sent once, restart or not. *Collect now* for it is *Fetch now* (the
  measurement), then *Send now* (`REPORT_SEND_NOW {kind: "log_delay"}` sends the hour before
  now). The device rows, periods and time late are measured over the hour; with the
  measurement every 2 hours (the default) every other hour has no measurement and says so — set
  *Every (hours)* to 1 for an hourly report with a measurement in every hour. The other report
  kinds refuse `hourly` and `lastHour` (`bad_request`).

## Not built / notes for the UI agent

* Elasticsearch-side retention (ILM) — the store owner's; documented above.
* PDF attachment — no writer in the tree.
* "Each cluster's own index" (Storage board, second option) is the existing `cluster`
  destination: one sink cluster receives every measured cluster's records. Per-client
  splitting is not built; the recommended destination is the dedicated store, the default
  for a fresh config stays `cluster` (an existing file keeps working).
* `HISTORY_QUERY stream:delay` and `DELAY_SINK_GET` are unchanged in shape; `DELAY_SINK_RUN`
  answers `opened`, `solved`, `destination` as well.
* The measurement now writes **every** device of a run (silent and can't-measure included);
  `measured` in `DELAY_SINK_RUN` counts rows written.
* `DELAY_SINK_RUN` answers `read` (devices read), `pages`, `window {from, to}`, `maxDevices`,
  `truncated` (cluster ids cut at the cap), `scope` and `note` beside `measured`.
* **Hard limits** (Elasticsearch's, not ours): `search.max_buckets` (65 536 by default) is per
  answer, and a page is at most 1000 device buckets with one `top_hits` each — far under it;
  `index.max_result_window` and `max_inner_result_window` do not apply (`size 0`, `top_hits 1`);
  a device name longer than the keyword's `ignore_above` is in no aggregation (counted in
  `noDevice`, never listed); a page is asked within 120 s (`collect::PAGE_TIMEOUT_MS`). The
  ceiling is ours: 100 000 devices per cluster per run, said when reached. The tracker keeps 31
  days of points per device in memory: 25 000 devices at a 2-hour interval is about 9 million
  points (some 300 MB) — the next thing to make smaller if fleets that size are measured.
* One run at a time (docs/JOBS.md): `DELAY_SINK_RUN` while a run goes — the timer's or another
  person's — answers `{ok: false, kind: "already_running", runId}` and measures nothing. Every
  run, the timer's and the pressed ones, is in the run log (`JOBS_LIST`, job `logdelay.measure`).

## The Log Delay page (UI, 0.3.60; redesigned 0.3.62)

The boards moved from Reports › Log delay to a top-level page of their own, **Log Delay** (it was
*Logs & Delay*, the live tail and the in-browser delay view). Reports › Log delay is a link there.
In 0.3.62 the page took the approved redesign: four tabs, the three configured levels and nothing
else (no little-delay band, no median, percentile or average anywhere), an "i" on every row.

| route | view | |
|---|---|---|
| `#/log-delay` | **Dashboard**: the fleet (Main board) — five count tiles (Below N, N–M, Above M, Other time zone, Silent; each opens Devices on that level), *Devices behind* over the period, the cluster × time heat map, *By cluster* with a states bar and an "i" per cluster, how the last run read each cluster | `ui/js/logdelay/boards.js` |
| `#/log-delay/cluster/<id>` | one cluster (Cluster board), under the Dashboard tab: the same tiles and chart, its devices | |
| `#/log-delay/devices[/<cluster>]` | **Devices**: every device of the period, a search box, level chips with counts, zone and tag1 selects, CSV; each row ends in "i" and *Open in logs* | |
| `#/log-delay/device/<cluster>/<device>` | one device (Device board) beside the short list of its cluster's devices: facts (no median), the Recommendation (the core's finding — the same words as the row's "i"), the graph, every delay | |
| `#/log-delay/watch` | **Live Watch**: every cluster measured now from the browser over the time range; one plain line ("N devices 30 min or more behind · live, seconds fresh") with an "i" about the view (the 500-devices-per-cluster limit); rows end in "i", *Details* (the device on Devices) and *Open in logs*; a row click does nothing | `ui/js/logdelay/watch.js` |
| `#/log-delay/live[/<cluster>[/<device>]]` | **Live logs**: the documents over the time range, narrowed to one device by *Open in logs* | `ui/js/logdelay/live-logs.js` |

The old addresses open the matching view (`ui/js/reports/route.js` `movedPath`):
`#/reports/log-delay[/…]` (the mail's link), `#/logs` (Live logs) and `#/log-delay/fixes[/<cluster>]`
(the Recommended fixes tab, gone in 0.3.62: Devices).

* **The title bar** carries the name, the tabs and, at the right end, **Fetch now**
  (`ui/js/logdelay/fetch-now.js`): a split button. The main click re-measures the late devices
  (`devices: "late"`, named with the configured level: "30 min or more behind") of the cluster on
  screen; ▾ offers *Late devices* / *Whole cluster* (`devices: "all"`, silent devices too) and ends
  in a non-clickable note "Automatic · every 2 h, all devices / last … · next …". Progress shows on
  the button ("3 of 8…" and a thin fill); what finished or was refused is a toast — nothing sits
  beside the button. With All clusters it asks to pick one (`fetchNowAllowed`). The device board's
  *Fetch this device* uses the same path (`fetchNowPress`).
* **One tools row** under the bar: the cluster, the period (*Today* = the measurement windows,
  then Last 7 / 30 days, This / Last month) and the **time zone** — plain text, never a chooser
  (the owner's rule; Edit cluster › Log time zone stays an admin override in the config), and no
  counts in the chip: "Time zone +05:30" is the majority zone of the devices in view
  (`timeZoneChipText`), "Time zone not detected" when no zone has a majority. **The chip is the
  button** ("Time zone +05:30 ▾", `aria-expanded`): it opens the zones with their device counts, majority first — "+05:30 · 24 devices · majority",
  "+08:00 · 16 devices", "not detected · 6 devices · under 60 % agree, no correction"
  (`devicesByZone`; a device's zone is its own steady offset when it sits in another zone, else
  its cluster's detected offset, `zoneOfRow`). Esc and a click outside close it. **A zone is a
  filter**, kept in the address like the other filters (`?tz=480`, `?tz=none`; `tzOfHash`,
  `ldHash(view, cluster, device, {tz})`): every view follows it — the tiles and By cluster are
  counted from the devices in that zone (`tileCounts`, `matchesZone`), Devices and Live Watch list
  them, the chip reads "Time zone +08:00 · only these devices" and the panel gains "Show all time
  zones". Devices behind and the heat map are the core's day totals for every zone; a note says
  so while the filter is on. By cluster's *Time zone* column reads "+05:30 · 12 of 13 devices" or
  "not detected · 41 % agree" (`timeZoneCell`). Live Watch and Live logs show the time range (Last
  1 min … 12 h, or a custom from/to) and the zone every time is written in — the server's (PING
  `tz`), else the browser's.
* **Levels from the config, never a figure of the page's own**: the tile names, the chips, the
  chart legend and the Fetch now menu read `levels` (`delayFrom`, `criticalOver`) from the
  answers; levels the core has not said read as words ("Below the delay line").
* **Three chart panels** (`behindSeries`; the owner's rule, prototype v25), one row, one shared y
  scale: *30–60 min behind* (light blue), *Above 60 min behind* (blue) and *Resolved log delays*
  (green: devices that came back below the delay line in the bucket) — one bucket per day of the
  period (`days[]` `delayed`, `critical`, `solved`) or per measurement window for Today
  (`windows[]` `delay`, `critical`, `solved`; the split is each device's last stored state at the
  window's end, added in 0.3.62, `summary::windows`). No stacking, no overlay line; a bar's title is
  the bucket and its one value, a click opens Devices on that level. A bucket without a figure is
  a hatched gap, never zero. Order: tiles, the state bar, the charts, By cluster, then the heat map
  **Hourly Delay Status** (`heatRows`: one row per cluster from `byCluster[].sparkline` (days) or
  `byCluster[].windows` (Today); a cell the core has no total for is hatched, a cluster never
  measured says so).
* **The "i"** (`ui/js/logdelay/fix-popover.js` `fixButton`, `fixesFor`): one popover for every
  button, the core's own words (`DeviceRow.fix`, `byCluster[].fixes`, a device board's `finding`,
  Live Watch's `LOGDELAY_FIXES` `devices[]` joined by cluster and device): title = `stepLabel`,
  cause = `why`, fix, where = the step, a cluster's grouped by finding with the device count. A
  device the core has no finding for says exactly that. Clicking "i" never triggers the row; Esc,
  × or a click outside closes it and Esc gives the focus back.
* **Colours** (the owner's "cool blue", prototype v17; theme tokens `--ld-ok --ld-delay --ld-crit
  --ld-tz --ld-silent`, with `-ink` and `-bg`): green #8fd19e below the line, light blue #a9cbee
  for the delay band, blue #5b8fd1 above the critical line, violet #a77fd6 (dark #b994ec) for
  another time zone, grey for silent; the same fills in every theme, each theme mixing its pill
  fill (28 % of the fill with the surface) and ink (35 % with the text colour) so the pill text
  keeps AA. Never red with yellow. The heat ramp is one blue (#3f78c0) at 7 / 24 / 45 / 70 /
  100 % over the surface. The "back below the line" line stays green.
* **One device row** (`ui/js/logdelay/rows.js`) for every device table — Devices, a cluster's
  devices, Live Watch. A device Live Watch measured is turned into a board row (`liveDeviceRow`);
  what one measurement cannot know reads unknown. The row's actions are buttons at its right end.
* **zone and tag1** are columns of every device and log table (`extraOf`: the row's extras or
  meta, any case). Live Watch asks for them in the measurement's `_source`.
* **Drawing**: each card is kept until what it shows changed (`lib/keyed.js`); each view's
  requests carry an AbortController that leaving the view aborts; an answer for a view no longer
  shown redraws nothing. The chart's hover is CSS only (`<title>` per bar), so a parked pointer
  replaces nothing. `tools/flicker-check.mjs` holds every view to zero replacements under a parked
  pointer, with the LOGDELAY_* answers slowed or failing (`--ld-delay`); `tools/fit-check.mjs`
  measures the Devices tab with an "i" popover open (`log-delay/devices/popover`).
