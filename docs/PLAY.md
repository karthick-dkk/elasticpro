# Play: the NOC wall display (0.3.47)

Developer contract. The approved design is the canvas "ElasticPro Play" (boards 1 to 9).
This file says what each part does and where each figure comes from; the build follows it.

## Principle

**The TV runs the same UI code as everyone else.** Every figure on a slide comes from the
function the normal pages already use (`alerts()`, `mergedAlerts()`, `healthState()`,
`diskBalance()`, `measureDelay()`/`summarise()`, `volumeDaily()`, the snapshot rows …).
Nothing is computed a second way for Play. The core adds only what does not exist yet:
display links, Play settings, node-name history, shared acknowledgements and a shared
measurement cache (below). "Unknown is not zero" holds on every slide: a figure that cannot
be read says "no data" / "not measured", never 0.

## The page

- Route `#/play` (`ui/js/pages/play.js`), one module per slide under `ui/js/play/`.
  Full screen: no app chrome (no top bar, nav, strip, toasts or bell); `html.play` class like
  `.embedded`. Dark TV theme (`.tv` tokens), text in `rem` scaled from the viewport so 1080p
  and 4K look the same; never a scroll bar.
- Who opens it: any signed-in user (a "▶ Play" button in the top bar), or a TV through a
  **display link** (below). Inside Zabbix (modules 2.1.15): the **ElasticPro › Play** menu entry
  and the **ElasticPro Play** dashboard widget (`ep_play`) open the same page as the signed-in
  Zabbix user, through the embed's one-use sign-in.
- Data: the existing fleet engine (`startAutoRefresh`, SSE). Play marks the datasets its
  slides need as watched (`askForPage`) so a hybrid-mode fleet (>25 clusters) has them.
  Toasts/notifications are off on this page.

### Slide engine

- Slides in the display's order; each stays `dwellSec` (default 20). Cluster spotlight stays
  `perClusterSec × clusters in it` (default 13 s each). A thin bar shows time left; dots show
  position. A slide with nothing to show is skipped, except Alerts ("All clear").
- Keys / TV remote: ← → change slide, Space pauses, + / − zoom. A mouse move shows the
  controls for 5 s.
- **Zoom** − / + in the top bar, 80 %…150 % in steps (0.8, 0.9, 1, 1.1, 1.25, 1.5). Everything
  below the bar is laid out again at that size (no scroll bar). Remembered per display:
  saved with the display's settings on the server (display link) or in localStorage (a person).
  Config can fix it per display.
- **Critical takeover** (default on): a newly opened critical alert jumps to Alerts with a red
  top bar and holds it until that alert is acknowledged (shared acks, below) or 5 min pass.
- Burn-in: the picture shifts a few px every 10 min. Stale: a figure older than 2× its
  refresh turns its "as of" amber; no answer at all = "no data".
- Header right side: "last fetched HH:MM:SS" (oldest of the slide's sources) and the IST
  clock (server TZ). No explanatory grey lines.
- **Excluded clusters** (Config › Play, with a reason) are left out of every slide, count and
  total on every display. The rest of ElasticPro still shows them.

### Slides (canvas boards 2 to 7)

1. **Fleet wall**: a tile per visible cluster, worst first — by tone first (red: anything
   critical, red health, not answering > orange: High > yellow > no data > green), then health
   and how much is open within a tone (`status.js` `rank`, which the spotlight's order reads too): name, status line, nodes x/y, fullest
   disk %, cluster log delay, open alerts, and **delayed devices** as three counts
   (green < 30 min, yellow 30–60 min inclusive, red > 60 min). A cluster with a node that left
   **blinks every 3 s** until the node is back (or is forgotten). A tile is red (critical),
   orange (High: its worst open alert is High — the status word reads "High"), yellow or green,
   and red and orange tiles blink (see Blinks below). Top strip: clusters by status (red, not
   answering, high, yellow, green, no data — the tiles' own colours), open alerts
   (critical/high/warning), node left (count + newest), delayed devices
   (30–60 / > 60), fullest disk. Status line = health word + worst reason + where, e.g.
   "Red · disk 91 % on es-hot-03" — composed once in `ui/js/play/status.js` from existing
   pieces (`healthState`, `diskBalance().fullest`, the open alert of highest severity).
   A cluster that is not answering has one dimmed line under its tile for the alerts **held**
   behind it (worked out from its last cached data, see HANDBOOK "Unreachable clusters and
   held alerts"): "2 older alerts held, not current · as of 14:02" — the same words as the
   Alerts page (`heldLine`, `core/alert-groups.js`). Never in the tile's alert count or the strip.
2. **Alerts**: `mergedAlerts()` open alerts, critical first, then high, then warning, then
   newest; severity (CRIT red, HIGH orange, WARN yellow), title, cluster · detail, open for,
   acknowledged by. Side: open now (critical, high, warning, acknowledged), last 24 h (raised, resolved, longest open). "All clear" when none. Held
   alerts are not rows: the unreachable row carries the same dimmed held line as the tile.
   They are never counted and never take the screen. When the cluster answers again, one that
   this display already showed open before the outage does not take the screen a second time;
   one it was never shown (the TV was switched on during the outage, or the alert appeared only
   while held) takes it as any new critical alert does (a High alert never takes the screen) — held keys are kept in what the display
   has seen, never added to it. "Open for" runs on from before the outage (held keys go with
   `PLAY_STATE.open`).
3. **Cluster spotlight**: clusters with a **critical problem** join automatically and leave
   10 min after their last one clears (per display). Critical problem (Config tick boxes,
   defaults on): red health, a node left, SLM failed or no good snapshot in 26 h (not for
   ULM clusters with SLM not used), a node past the high watermark (90 %), not answering, an
   open critical alert. Off by default: ILM step error, yellow health. Worst first;
   "In the spotlight" chips (name, why, since). Per cluster: total events, disk used, heap,
   open alerts, volume 7-day avg; nodes table (disk bar, heap, CPU); **volume per day chart
   cycling 7 d (3 s) → 15 d (5 s) → 30 d (5 s)** with a dashed average; Lifecycle (ILM / SLM
   Running pills); last good snapshot; backup size; delayed devices (> 30 min, > 60 min,
   worst); volume yesterday vs 7-day avg; indices per day (yesterday's count and size).
   Empty spotlight: the slide is skipped.
4. **Log delay**: devices sending logs, < 30, 30–60, > 60 min, worst device; "Top 10 devices
   by delay" (device, cluster, delay, last event, peak 24 h, status); "Top 10 clusters by
   delay" (delay, devices > 30 min).
5. **Backups**: backed up in 26 h (x of y), older than 26 h, **snapshot failures · 24 h**
   (each FAILED / PARTIAL snapshot: cluster, time, what), and per cluster: last good snapshot,
   holds data up to, backup size. ULM clusters with SLM not used read "ULM · s3 <bucket>".
6. **Volume and capacity**: yesterday (all clusters) vs 7-day avg, average per day, month so
   far, shortest disk runway; per cluster yesterday / 7-day avg / change; days of disk left
   (total size). From the 0.3.45 record (`VOLUME_MONTHLY_ALL` / `VOLUME_DAILY`).

### Blinks

Play only, by a CSS class on the element (`ui/css/app.css`, "Blinks"), never a timer; only
the background changes, in two steps a cycle, so nothing moves and the CPU barely notices.
Under `prefers-reduced-motion: reduce` every blink is a steady highlight in the same colour.

| Where | When | Class | Rate |
|---|---|---|---|
| Fleet wall tile | a node left (Config › Play › node blink) — **wins over the others** | `pl-blink` | 3 s |
| Fleet wall tile | critical: tone red (red health, not answering, a critical alert, a node past its high watermark) | `blink-crit` (red) | 1.2 s |
| Fleet wall tile | High: tone orange (worst open alert High, nothing critical) | `blink-high` (orange) | 2.4 s |
| Spotlight nodes table | a node whose disk is at or past the high watermark (`nodeDiskCritical`, the same test as the tile's red): red bar at the left of the row, the row blinks; every other row keeps a transparent bar of the same width | `tr.blink-crit` | 1.2 s |
| Log delay, Top 10 clusters | the cluster's median delay is red — `classify` CRITICAL, over the red line (60 min) | `tr.blink-crit` | 1.2 s |
| Volume, Days of disk left | the runway is red — under 7 days (`RUNWAY_RED_DAYS`, the slide's own red line) | `td.blink-crit` | 1.2 s |

`play/status.js tileBlink` picks a tile's one class; `spotlight.js nodeRowBlink`,
`logdelay.js delayRowBlink` and `volume.js runwayBlink` the others — each from the definition
the slide already colours by, so a blink never disagrees with the colour under it.

### Where each figure comes from (all existing unless marked NEW)

| Figure | Source |
|---|---|
| health, nodes, unassigned | `health` dataset → `healthState()` |
| disk per node, fullest | `nodes` dataset → `diskBalance()` |
| heap / CPU per node | `nodes` dataset raw columns (colours as overview.js) |
| open alerts, severity, merged | `alerts()` → `mergedAlerts()` |
| acknowledged by / since | NEW shared acks (core) |
| open since | `alert-history.js`, plus NEW: kept on the server per display so a reload keeps it |
| cluster log delay, delayed devices, top devices | `measureDelay()` + `summarise()` + `classify()` (thresholds from Play watch rules, default 30/60), in two tiers per cluster — a full check every 2 h, the late devices every 15 min (below) — **shared through the core cache** so N TVs measure once |
| node left | NEW core node-name history (24 h) |
| last good snapshot, failures in 24 h | snapshot rows (`d.snapshots`): NEW small helpers in `ui/js/play/snapshots.js` (filter by status / end time) |
| backup size | `measureRepoBytes()` result **shared through the core cache** (written by whoever measured it: Volume page, scraper); "not measured" when none |
| total events, indices per day, volume, 7-day avg, month | volume record (`VOLUME_DAILY` cards and rows; total events = Σ docs of the record's live days) |
| days of disk left | `volumeReport()` (`liveSufficientDays`), as the Volume page shows it |
| ILM / SLM Running | `policies` dataset (as the Overview pills) |

**The one new cluster load:** device-delay measurement (the Logs page's query, 24 h window,
terms on the device field) runs per cluster **only while a Play display is open**, in two
tiers, and at most once per tier per cluster across all displays (shared cache). Everything
else is what the fleet poller already fetches, at Play's own pace (next section).

### What Play keeps going (the request policy's "While Play runs", 2026-11-01)

Play tells the core what it shows once a minute — `REFRESH {clusterIds, datasets, watcher:
"play"}` (state.js `watchForPlay`) — and the core keeps each dataset coming at the policy's
Play interval for as long as a display keeps saying so (three minutes after the last one). It
fetches at once only what it never had. Nothing on the wall decides an age itself.

| What | Every (shipped) | config.txt |
|---|---|---|
| health | 5 min | `POLL_PLAY_HEALTH_SECONDS` |
| nodes (node-left blink, disk) | 5 min | `POLL_PLAY_NODES_SECONDS` |
| SLM / ILM (`policies`, `ilm_errors`, `ilm_assign`) | 4 h | `POLL_PLAY_LIFECYCLE_SECONDS` |
| snapshots (`snapshots`, `snapshots_full`) | 2 h | `POLL_PLAY_SNAPSHOTS_SECONDS` |
| index list (`indices`) | 1 h | `POLL_PLAY_INDICES_SECONDS` |
| log delay, full check | 2 h | `POLL_PLAY_DELAY_FULL_SECONDS` |
| log delay, late devices | 15 min | `POLL_PLAY_DELAY_LATE_SECONDS` |

Each is editable in Config › Requests › While Play runs (an admin's `POLICY_SET`), and locked
there — "managed by config.txt" — when its key is set. The watchers are kept per dataset: a
person's page that watches the same dataset at the same time (the existing watch window, at
the policy's own interval) wins while it is open — the faster of the two — and the
duplicate-request gap (Config › Requests › Duplicate requests, 60 s) floors both. Under the
Background mode (and Automatic with a small fleet) the schedule already keeps everything at
the policy's intervals, and Play does not slow it.

**Per cluster per hour with a wall open (2 repositories, Client basis):** health 2 requests
every 5 min (24), nodes 2 every 5 min (24), SLM/ILM 9 every 4 h (2.25), snapshots 2 listings of
2 repositories every 2 h (2), index list 1 every hour (1), log delay 1–4.5 (a full check —
`_field_caps` and the search — every 2 h, and one request every 15 min while any device is
late; none when none is) — about 54–58, from about 95.

### Log delay in two tiers

- A **full check** — preflight (`_field_caps`) and the measurement (every device, today's
  query, up to 500) — every 2 h per cluster.
- Devices at or past the yellow line (`classify` on Play's watch rules: 30 min by default, the
  one definition) go on the **late list**, re-checked every 15 min with **one** request naming
  only them: the measurement's body with one more filter, `{"terms": {<device field>: [names]}}`
  (`log-delay.js` `buildLateSearchBody`). A device that has caught up leaves the list.
- A device that goes quiet between full checks shows up at the next full check (up to 2 h;
  accepted). So the slide says when each tier last ran: "last full check 14:00 · late devices
  re-checked 14:45" — the oldest of each across its clusters — and the header's "last fetched"
  is the full check's time.
- The shared record carries both: `data.fullAt` (the last full check) and `data.lateAt` (the
  late list's last re-check), with `data.late` (the names); the record's `measuredAt` is the
  newer. The core checks them (no later than `measuredAt`, a re-check not before its full
  check, ≤ 500 names) and hands them back as `fullAt` / `lateAt`. One display measures; every
  display reads the same times.

## Core (Rust)

### Display links

- `PLAY_LINK_CREATE {name, clusters: "all"|{group}|[ids], allowFrom: [cidr]?, expires:
  "permanent"|days}` (Admin) → `{link: {id, name, url, …}, secret}` (secret shown once).
  `PLAY_LINK_LIST` (Admin) → links with `lastSeen {at, from}`; `PLAY_LINK_REVOKE {id}` (Admin);
  `PLAY_LINK_SET {id, settings}` (Admin). Default expiry: **permanent** (until revoked).
- The TV opens `https://<host>/#/play?display=<secret>`; the UI exchanges it
  (`PLAY_EXCHANGE {secret}`, no session needed) for a session cookie whose caller is
  `display:<name>` with role User for reads, **scope `play_only`** and the link's cluster
  scope. A `play_only` caller may send only `PLAY_READS` (FLEET_STATE, CLUSTER_DATASET,
  EVENTS_TICKET, REFRESH of watched datasets, VOLUME_DAILY/MONTHLY/MONTHLY_ALL,
  SILENCE_LIST, ACK_LIST, PLAY_STATE, PLAY_SHARE_GET/PUT, PING, CONFIG_VIEW, ES only for the
  delay-measurement `_search` and `_field_caps`) — everything else is refused
  (`forbidden`, "a display link only shows Play"). Read-only always (`Writes::decide` never
  unlocks for it).
- The `ES` gate (`auth::play_es_shape`): the target is the cluster's own `logIndexPattern`, the
  query string only `ignore_unavailable` / `allow_no_indices` (and `fields` for `_field_caps`),
  and the `_search` body exactly `buildSearchBody`'s — `size: 0`, `query.bool.filter` holding one
  `range`, the `devices` terms aggregation (≤ 500, one newest document each). Since 2026-11-01
  one more shape, the late list's re-check: that same body with a **second** filter element
  after the range, `{"terms": {"<the aggregation's terms.field>": ["name", …]}}` — the same
  field, 1–500 values, each a string of at most 256 characters with no `*`, `?` or control
  character, and nothing else in it. A different field, more than 500 values, a number, a
  wildcard, extra keys (a `boost`, a terms lookup), two terms filters, `terms.include` or a
  script are refused. A display link's request is never treated as typed by a person: the
  duplicate-request gap holds it like any page's, whatever `purpose` or origin it names.
- Every field the body names is the cluster's own delay configuration (`auth::DelayShape`):
  the terms field is its device field as aggregated (`aggregatableName`), the range and the
  sort are on its arrival timestamp (`timeField`, else config.txt's `UI_TIME_FIELD`, else
  `@timestamp`), and `_source` holds only that, its event-time and its metadata fields —
  resolved as the UI resolves them (`auth::DelayShape::resolve`, config.js `normalize`): the
  cluster's own (`timeField`, `delayFields`, which the admin's `PRIME` carries), else the
  clusters file's `defaults:` with config.txt's `UI_TIME_FIELD` over it, else the shipped
  values. A Zabbix host names none of its own, so the clusters file's defaults decide it. The window is
  `now-<N>h` (N ≤ 24) to `now`. What reaches the cluster is the body the gate checked, written
  out again, so a key given twice cannot say one thing to the gate and another to the cluster.
- `allowFrom`: the session is refused from any other address (`source_of` / trusted proxies).
  Revoke ends its sessions at once. Hosted only; `UI_PLAY_ENABLED=false` turns links off.
- Stored in `<data>/play-links.json` (secret hashed like API tokens).

### Play settings

- `<data>/play.json` `{watch: {delayYellowFromMin: 30, delayRedAboveMin: 60, nodeExpected:
  "seen24h"|"pinned", nodeBlink: "untilBack"|"untilAck"|"off", nodeCheckSec: 60, spotlight:
  {when: [red, nodeLeft, slmFailed, storage, unreachable, criticalAlert], perClusterSec: 13,
  leaveAfterMin: 10, whenEmpty: "skip"|"allHealthy"|"everyCluster"}}, exclude: [{clusterId,
  reason, by, at}], displays: {<linkId>: {slides, dwellSec, criticalTakesScreen, theme, sound,
  zoom}}, defaultDisplay: {…}}`.
- `PLAY_CONFIG_GET` (User: reads; Admin sees links) / `PLAY_CONFIG_SET` (Admin). Exclude needs
  a non-empty reason. config.txt keys lock fields ("managed by config.txt"):
  `UI_PLAY_ENABLED`, `UI_PLAY_DELAY_YELLOW_MIN`, `UI_PLAY_DELAY_RED_MIN`,
  `UI_PLAY_NODE_EXPECTED`, `UI_PLAY_NODE_BLINK`, `UI_PLAY_NODE_CHECK_SECONDS`,
  `UI_PLAY_SPOTLIGHT_WHEN`, `UI_PLAY_SPOTLIGHT_LEAVE_MIN`, `UI_PLAY_SPOTLIGHT_SECONDS`,
  `UI_PLAY_EXCLUDE` (comma list of cluster ids; reason "set in config.txt").

### Node-name history

- From every `nodes` dataset entry the poller completes, the core records node names per
  cluster with last-seen time; kept 24 h (or the pinned list), persisted
  `<data>/play/nodes.json`. "Left" = expected name absent from the current list while the
  cluster answers. `PLAY_NODE_FORGET {clusterId, node}` (Operator) for a node removed on
  purpose. No new requests to the clusters.

### Shared acknowledgements (hosted)

- `ACK_LIST` (User) / `ACK_SET {key, note?}` (User) / `ACK_CLEAR {key}` (User):
  `<data>/acks.json` `{key → {by, at, note}}`, keyed exactly as `acks.js` keys today.
  Hosted UI reads and writes acks through the core; desktop keeps IndexedDB. Existing
  browser acks are not migrated (they were per person). Audit line per set/clear.

### Shared measurement cache

- `PLAY_SHARE_PUT {kind: "delay"|"repoSize", clusterId, measuredAt, data}` (User, play_only
  allowed for "delay") / `PLAY_SHARE_GET {kind, clusterIds?}` → newest per cluster.
  Size-capped (delay records ≤ 2,000 per cluster), kept 48 h, memory-light (on disk,
  `<data>/play/share/`). Cluster visibility applies.

### PLAY_STATE

`PLAY_STATE {}` (User / play_only) → `{settings (watch + this display's), excluded:[ids],
nodes: {clusterId: {expected:[…], present:[…], left:[{node, since}]}}, openSince:{alertKey:
at}, now}` — one small call per minute.

## Cluster type and ULM (its own PR)

- Per cluster: `type` CI | DI | On-Prem, `ulm {enabled, bucket}`, `slm` expected | none.
  Defaults: CI / DI → ULM on, SLM none; On-Prem → ULM off, SLM expected.
- Hosted: one core store `<data>/cluster-meta.json` for every cluster (Zabbix ones too),
  `CLUSTER_META_GET` (User) / `CLUSTER_META_SET` (Admin). Seed for a Zabbix cluster with no
  entry: host tag `elasticpro:type`. Desktop: the clusters file keys `type`, `ulm`, `slm`.
- Effect: with ULM on and SLM none, the rules `slm-*` and snapshot "none / stale" do not raise
  for that cluster (Overview, Alerts, Play); a failing SLM policy that exists still raises.
  Backups shows "ULM · s3 <bucket>". Only the bucket name is kept; the archive is checked by
  the Zabbix log archive (S3) template. Badges CI / DI / On-Prem on the Clusters page and Fleet
  tiles; filter by type.
- UI helper (one definition): `ui/js/core/cluster-kind.js` →
  `clusterKind(cluster) = {type, ulm: {enabled, bucket}, slmExpected}` and
  `slmExempt(cluster)`.

## Checks

render-check and behaviour-check for `#/play` (each slide, engine keys, zoom, takeover,
exclusion, display-link session refused outside PLAY_READS); fit-check at 1920×1080 and
3840×2160 (no scroll bar); hosted-check lines for every new message; Rust tests for links
(scope, allowFrom, revoke, expiry), node history, acks, share cache, settings locks; a 24 h
run on the test VM watching core memory.
