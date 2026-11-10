# Log delay report (0.3.57)

Developer contract for the log delay report: the one definition of "late", the scheduled
measurement with silent devices and delay periods, the stored records, the recommended fixes,
the `LOGDELAY_*` messages, and the `log_delay` report kind with its HTML mail. The UI is built
from this file alone; where it and the code disagree, one of them has a bug. Decisions are
the owner's (canvas boards Main, Cluster, Device, Mail, Storage, Plan, Fix; 2026-11-05/07).
The figures on the boards are example data; the behaviour is the spec.

Code: `crates/elasticpro-core/src/logdelay/` (`levels`, `measure`, `state`, `store`, `docs`,
`fixes`, `summary`, `report`, `time`, `mod`), `report/logdelay_job.rs`, and the run in
`bridge.rs` `run_delay_sink`. Tests: each module's own, `tests/logdelay.rs`,
`tests/delay_sink.rs`.

```text
  delay sink tick (every_hours, hosted, armed)
    └── per cluster: one search ──▶ readings (device, docs, arrival, event, extras)
          └── tracker.apply: states, periods open/solve, silences
                ├── built-in store  <data>/logdelay/…          always (the pages read it)
                └── documents ──▶ history store | sink cluster   by destination, gated as before
    └── fixes over every cluster's stored periods + fleet-cache facts ──▶ findings.json
  LOGDELAY_* ──▶ summary over the built-in store ──▶ pages
  report kind log_delay ──▶ .xlsx (one sheet per section + Fixes), .csv, HTML + text mail
```

## Levels — one definition (`logdelay/levels.rs`)

| state | rule (minutes `m` = arrival − event) | label |
|---|---|---|
| `no_delay` | `m < noDelayUnder` (15) | on time |
| `little` | `noDelayUnder ≤ m < delayFrom` (15–<30) | little delay |
| `delay` | `delayFrom ≤ m ≤ criticalOver` (30–60, 60 inclusive) | delayed |
| `critical` | `m > criticalOver` (>60) | critical |
| `clock_ahead` | `m ≤ −delayFrom` (tested first) | clock ahead |
| `silent` | seen recently, no document for `silentAfterHours` (2) | silent — never on time, never 0 min |
| `unmeasured` | arrival or event time unreadable | can't measure — never 0 min |

* **Late** = `delay` or `critical`. **On time** (in totals and percentages) = `no_delay`,
  `little`, `clock_ahead`. Silent and unmeasured are neither.
* **A delay period** starts at the first measurement ≥ `delayFrom` and is solved at the first
  measurement back under it. Silent or unmeasured measurements change nothing about an open
  period (unknown solves nothing). Start/solve times are the run's time: as exact as the
  interval.
* **Resolution per cluster** (`logdelay::levels_for`): `logdelay.json` `clusters.<id>.levels`
  → the clusters file's `delayThresholds` on that cluster (`delayMinutes` → `delayFrom`,
  `criticalMinutes` → `criticalOver`; today's override, kept) → `logdelay.json` `levels` →
  shipped 15/30/60. `LOGDELAY_SETTINGS_GET` says which (`levelsFrom`).
* **UI copy to remove**: `ui/js/core/log-delay.js` `DEFAULT_THRESHOLDS`, `thresholds(cluster)`
  and `classify()`; the per-cluster `delayThresholds` reading in `ui/js/core/config.js`
  normalisation stays only as the config field. Read `levels` from `LOGDELAY_SETTINGS_GET`
  (`resolved[].levels`) and classify with the table above. `STATUS` names map: OK→`no_delay`
  (+`little`), DELAYED→`delay`, CRITICAL→`critical`, CLOCK_AHEAD→`clock_ahead`,
  NO_DATA→`silent`, ERROR→`unmeasured`.

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
* One search per cluster per run: `size 0`, last `everyHours`, `terms` on the device field
  (≤ `maxDevices`, default 2000), `top_hits 1` with arrival + event-time + extras in
  `_source`. Every bucket is a reading; unreadable times give `delay_minutes: null`.
* **Silent**: a device in the tracker not in this run's buckets, whose last arrival is
  ≥ `silentAfterHours` ago → `silent`; a silence record opens (`from` = last arrival). The
  first arrival after ends it with what came back (`burstDocs`, `burstMinutes`). A device not
  seen for 7 days is forgotten (its open period is kept unsolved).

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
| `elasticsearch` | ≥ `max(5, 20 % of devices)` late in the same `everyHours` window(s), spanning ≥ 2 `fwd_tag`s (or no `fwd_tag` at all — then named as missing); evidence: devices, windows, days, forwarders, `writeRejected`, `nodesOverWatermark`, snapshots overlapping the windows (named in the fix) |
| `forwarder` | late devices share one `fwd_tag` (else `Zone` when no `fwd_tag` exists): ≥ 2 late, ≥ half of that tag's devices, other tags ≤ 20 % late |
| `parser` | same by `parser_tag`, and the late devices span ≥ 2 forwarders |
| `device_clock` | ≥ 80 % of a device's late measurements within 3 min of a multiple of 30 min (60, 120, 330 …), or clock-ahead readings |
| `device_link` | a silence followed by a first reading ≥ 30 min late |
| `unknown` | the rest: "not enough evidence", with `missing` (`fwd_tag`/`parser_tag` on these devices, more measurements) |

Each finding: `{cluster, step, stepLabel, devices[], group: [field, value] | null, why, fix,
evidence{…numbers}, missing[]}`. Group findings claim their devices in the order above; the
per-device view (`fixes::per_device`) is each device's first group. No model, no guess.

## Messages (`logdelay/mod.rs`)

Roles (`auth::required_role`): `LOGDELAY_SUMMARY|CLUSTER|DEVICE|SEARCH|FIXES` → **User**, on
the clusters the caller sees (`visible_ids`); `LOGDELAY_SETTINGS_GET|SET` → **Admin**;
`SET` is refused `forbidden` for a limited admin. Unauthenticated → `unauthenticated`
(`tools/hosted-check.sh`). No data directory → `kind: no_store`.

Common inputs: `from`/`to` `YYYY-MM-DD` local days (default: last `days`, 30; ≤ 1200),
`clusterIds[]` (optional narrowing). Every answer carries `from`, `to`, `now` (ms).

### `LOGDELAY_SUMMARY {from?, to?, days?, clusterIds?, maxDevices?}` — Main board

```json
{ "ok": true, "from": "2026-10-06", "to": "2026-11-04", "label": "6 Oct – 4 Nov", "now": 1762250000000, "everyHours": 2,
  "clusters": 32, "measuredClusters": 32,
  "totals": { "devices": 1284, "measured": 1270, "onTime": 1238, "noDelay": 1200, "little": 38, "delay": 25, "critical": 12,
              "clockAhead": 0, "silent": 9, "unmeasured": 5, "late": 37, "pctOnTime": 96.4, "pctLate": 2.9, "pctSilent": 0.7, "pctUnmeasured": 0.4 },
  "reduced": [ { "hours": 2, "n": 4 }, { "hours": 4, "n": 7 }, { "hours": 6, "n": 9 }, { "hours": 12, "n": 15 }, { "hours": 24, "n": 23 } ],
  "newlyLateToday": 6, "solvedToday": 4,
  "yesterday": { "newlyLate": 19, "solved": 23, "averageLastedMs": 6600000 },
  "windows": [ { "from": 0, "to": 0, "label": "00:00–02:00", "newlyLate": 2, "solved": 1, "stillLate": 30, "complete": true } ],
  "days": [ { "day": "2026-11-04", "devices": 1284, "onTime": 1200, "little": 38, "delayed": 25, "critical": 12, "clockAhead": 0, "silent": 9,
              "unmeasured": 5, "started": 19, "solved": 23, "lateHours": 41.5, "medianMinutes": 4.1, "measured": 1270, "complete": true,
              "onTimeAll": 1238, "late": 37 } ],
  "byCluster": [ { "id": "client-a-prod", "name": "client-a-prod", "devices": 412, "measured": 410, "lateNow": 14, "delay": 9, "critical": 5, "silent": 1,
                   "unmeasured": 1, "below": 396, "belowPct": 96.1, "latePct": 3.4, "belowPctPrevious": 95.2, "newToday": 3,
                   "sparkline": [12, 9, null, 14], "sparklineDays": ["2026-10-06", "…"], "worst": { "device": "fw-dc1-07", "minutes": 94.0, "state": "critical" },
                   "levels": { "noDelayUnder": 15.0, "delayFrom": 30.0, "criticalOver": 60.0 }, "lastRunAt": 1762249000000 } ],
  "devices": [ "<DeviceRow>" ], "devicesTotal": 1284, "devicesTruncated": false,
  "schedule": { "supported": true, "enabled": true, "everyHours": 2, "destination": "builtin", "lastRunAt": 1762249000000, "state": { "…DELAY_SINK state" } } }
```

Board figures: tiles = `totals` (`devices`, `late`/`delay`/`critical`, `onTime`,
`pctOnTime`/`pctLate`/`pctSilent`); *Delay reduced* = `reduced`; *Day by day* = `days`
(`onTimeAll`, `delayed`, `critical`); *Delayed devices by cluster* = `byCluster` sorted by
`latePct` (`latePct`, `lateNow` of `devices`); *By cluster* table = `byCluster` (`below` +
`belowPct`, `delay`, `critical`, `belowPctPrevious` = previous equal-length range, `sparkline`
over `sparklineDays`, `worst`); *Devices* = `devices` sorted by time late until a column heading
is pressed (every Log delay table sorts by any column, remembered in the browser; a state sorts
worst first, "can't measure" last). `sparkline` entries
are `null` for a day without totals — draw a gap, not zero. `byCluster[].lastRunAt: null` =
never measured — say so.

`DeviceRow` (every device table, every message):

```json
{ "device": "fw-dc1-07", "cluster": "client-a-prod", "clusterName": "client-a-prod", "state": "critical", "nowMinutes": 94.0,
  "medianMinutes": 6.0, "maxMinutes": 212.0, "episodes": 5, "solved": 4, "lateMs": 67200000, "lastStarted": 1762240500000, "lastSolved": null,
  "lateSince": 1762240500000, "docsPerDay": 41000, "lastArrival": 1762250400000, "lastEvent": 1762244760000, "silentSince": null,
  "extras": { "Zone": "dc1", "tag1": "firewall", "fwd_tag": "syslog-dc1-02", "parser_tag": "fortigate-grok" } }
```

`nowMinutes: null` with `state: silent|unmeasured` — show "—" / "can't measure". *Last delay:
started → solved* = `lastStarted` → `lastSolved` (`lateSince` set = "still late"; `silentSince`
= "no logs since"). *Time late* = `lateMs`. *Logs a day* = `docsPerDay` (`null` = unknown).

### `LOGDELAY_CLUSTER {clusterId, from?, to?}` — Cluster board

`{ ok, cluster, name, from, to, label, now, everyHours, levels, fields {pattern, device, arrival, eventTime[], extras[]},
lastRunAt, totals{…as above}, started, solved, medianNow, medianPrevious, windows[], days[], devices[DeviceRow] }`.
Tiles: `totals.devices`, `totals.late` (`delay`/`critical`), `pctOnTime`, `started`/`solved`,
`medianNow` vs `medianPrevious` (null = not measured). Footer: `fields` names.

### `LOGDELAY_DEVICE {clusterId, device, from?, to?}` — Device board

```json
{ "ok": true, "device": "fw-dc1-07", "cluster": "client-a-prod", "clusterName": "…", "from": "…", "to": "…", "label": "…", "now": 0, "everyHours": 2, "levels": {…},
  "state": "critical", "nowMinutes": 94.0, "lateSince": 1762240500000, "silentSince": null, "medianMinutes": 6.0,
  "worst": { "minutes": 212.0, "at": 1760891400000 }, "episodes": 5, "solved": 4, "lateMs": 67200000, "latePct": 2.6, "docsPerDay": 41000,
  "lastSilence": 1761720000000, "extras": {…}, "lastArrival": 0, "lastEvent": 0, "firstSeen": 0,
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
devices: [ { device, cluster, clusterName, state, nowMinutes, step, stepLabel, why, fix, group } ] (worst first),
rules: [ { pattern, step, readFrom, recommendation } ×6 ] }`.

### `LOGDELAY_SETTINGS_GET` / `LOGDELAY_SETTINGS_SET {settings}` — Storage board (Admin)

```json
{ "ok": true, "supported": true,
  "settings": { "levels": { "noDelayUnder": 15.0, "delayFrom": 30.0, "criticalOver": 60.0 }, "silentAfterHours": 2,
                "fields": { "device": "src_hostname", "arrival": "@timestamp", "eventTime": ["event_created"], "extras": ["tag1", "fwd_tag", "parser_tag", "Zone"] },
                "clusters": { "client-a-prod": { "levels": {…}, "fields": {…} } }, "setBy": "Admin", "setAt": 0 },
  "resolved": [ { "id": "…", "name": "…", "levels": {…}, "levelsFrom": "settings|configFile|default", "fields": { "pattern": "logstash-*", "device": "src_hostname.keyword", "arrival": "@timestamp", "eventTime": [..], "extras": [..] } } ],
  "schedule": { "enabled": true, "everyHours": 2, "destination": "builtin|history|cluster", "clusters": [], "maxDevices": 2000, "state": {…}, "blocked": null },
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
* **Attachments**: `elasticpro-log-delay-<from>_<to>.xlsx` — sheets *Summary*, *Devices*
  (chosen columns, group column first when not cluster, + Step/Likely why/Fix), *Every N
  hours*, *Day by day*, *Top delayed*, *Fixes* — and `…-devices.csv` (the Devices sheet).
  **PDF: not built** — there is no PDF writer in the tree; `pdf: true` round-trips and the
  job's `warning` says so.
* **Mail**: `multipart/alternative` text + HTML inside `multipart/mixed` with the files
  (`mail::message_parts`; the volume kinds still send plain text). HTML sections follow the
  Mail board: Summary tiles, *Late devices every N hours* (bar per window: pink late, green
  under), *Every N hours* table, *Day by day · last 7 days*, *Top delayed*, *Recommended fixes*
  (top 3 that are not "unknown"), *Open the full report* when `UI_PUBLIC_URL` is set in
  config.txt (`<url>/#/reports/log-delay`). Tables and inline styles only; colours light
  green `#DDF3E4`, blue `#DCEBFA`, pink `#FBDCE6`, orange `#FDE4CC`.
* Period days are local days; `yesterday`/`last7`/`previousWeek`/`previousMonth`/`{from,to}`
  as every report.

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
* One run at a time (docs/JOBS.md): `DELAY_SINK_RUN` while a run goes — the timer's or another
  person's — answers `{ok: false, kind: "already_running", runId}` and measures nothing. Every
  run, the timer's and the pressed ones, is in the run log (`JOBS_LIST`, job `logdelay.measure`).
