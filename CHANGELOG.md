# Changelog

## 0.3.62

- **Log Delay page redesigned** (the approved prototype, docs/LOGDELAY.md "The Log Delay page"). Tabs **Dashboard · Devices · Live Watch · Live logs**; the Recommended fixes tab is gone — every device row (Devices, Live Watch) and every cluster row (By cluster) ends in an **"i"** that opens the core's recommended fix for it (cause · fix · where, a cluster's grouped by finding with counts, its time-zone finding among them; `LOGDELAY_SUMMARY`/`CLUSTER` now carry `devices[].fix` and `byCluster[].fixes`), beside *Open in logs* (and *Details* on Live Watch, whose row click does nothing). **Only the three configured levels**: Below 30 min · 30–60 min · Above 60 min (the names from each cluster's `levels`), plus Other time zone and Silent — the 15-minute **little-delay band is removed** everywhere (core `State::of`, the UI, the report's Day by day sheet, the settings' three bands); `noDelayUnder` stays in the levels JSON equal to `delayFrom` for compatibility, `State::Little` and the `little` counts stay so stored data still reads. **No median, percentile or average anywhere.** Dashboard: five count tiles (each opens Devices filtered), one full-width **Devices behind** chart (the delay band light blue + above critical blue stacked, a green "back below 30" line; by day over the period, by measurement window for *Today*; a day without totals is a hatched gap), the **cluster × time heat map** (pale → deep blue; a cell opens the cluster), *By cluster* with a states bar — every column sorts, the most delayed clusters first, the 5 most delayed by default (*Show all N* → 30 a page). **Devices** tab: search, level chips with counts, zone and tag1 filters, CSV; one device opens beside the short list. **Fetch now** is a split button at the top right of the title bar: the main click re-measures the picked cluster's late devices (30+ min), ▾ offers *Late devices* / *Whole cluster* and ends in the automatic schedule's note; progress shows on the button ("3 of 8…" and a thin fill), the outcome is a toast, nothing beside it; with All clusters it asks to pick one. The time zone is plain text, never a chooser: the chip shows the zone alone ("Time zone +05:30", the majority zone of the devices in view, or "not detected"); the chip itself opens (▾) every zone with its device count, majority first ("+08:00 · 16 devices", "not detected · 6 devices · under 60 % agree, no correction"); a zone is a **filter on every view**, kept in the address (`?tz=480`): tiles, By cluster, Devices and Live Watch show those devices, the chip reads "· only these devices", the panel offers "Show all time zones" (a device's zone is its own steady offset, else its cluster's detected one). By cluster's Time zone column carries the device counts, and the core's *Cluster* fix no longer sends anyone to Edit cluster: "only x % of its devices agree on one offset … check the devices' clocks and the parser's date filter; the zone is taken from the majority once 60 % agree" (the config's `logTimeZone` stays an admin override). Live Watch's banner is one plain line with an "i" about the view (seconds fresh, the real 500-devices-per-cluster browser limit); its one-device close-up is gone (Details opens the device on Devices). Colours (the owner's "cool blue"): green #8fd19e below the line, light blue #a9cbee for the delay band, blue #5b8fd1 above the critical line, violet for another time zone, grey for silent — the same fills in every theme, each theme mixing its own pill inks for AA; never red with yellow. The chart's hover is CSS only, so a parked pointer replaces nothing (flicker STRICT).
- **Log Delay: time zones** (docs/LOGDELAY.md "Time zones"). A cluster whose `@timestamp` is stamped in local time and stored as UTC showed every on-time device as critical by its zone's offset (330 min on an IST cluster); the only check that called a steady delay a time-zone offset matched whole hours alone, so +05:30 never matched. Every cluster now has a **log time zone**: set in its config (Edit cluster › **Log time zone**: Detect / UTC / every IANA zone with its offset; `logTimeZone` on a config-file cluster, in ElasticPro's overlay for a Zabbix cluster; an unknown zone is refused), or detected from its devices (each raw gap matched against every real UTC offset from the IANA database within 3 min; the offset at least 60 % of measured devices fall in, steady over 3 runs; let go the same way). Delay = arrival − event − the cluster's offset at the event's own time (DST-aware for a named zone) — on the boards, in reports, mail, Zabbix values, `LOGDELAY_*` answers, Live Watch and Live logs; the raw gap is kept beside it. A device steady at another real offset is a new state, **other time zone** (blue pill): not late, counted apart, shown with its own offset; Recommended fixes gain *Device clock / parser* (with the Logstash `date { timezone => … }` hint) and *Cluster* (most devices share an offset and no zone is set: set it, or confirm it once detected). Under the majority the cluster says *not detected (x % agree)* and nothing is corrected — unknown is not zero. History is not rewritten: corrected figures apply from the next measurement, the boards and the mail say so. Dashboard: a *Time zone* chip on the cluster board, *Time zone* and *Other time zone* columns on By cluster, *Raw gap* and *Device time zone* on every device table, the Delay cell's title spells the sum out; Live logs writes `@timestamp` and the event time in the cluster's zone with the offset in each head. `tools/mock-es.mjs` gains `MOCK_LD_TZ_OFFSET_MIN=330` (an IST-skewed cluster).
- **Fetch now is one cluster at a time** (docs/LOGDELAY.md "Fetch now", docs/JOBS.md): `JOB_RUN {jobId: "logdelay.measure", clusterIds: [one], devices: "late"|"all", device?}`. `late` (the default) re-measures only the devices delayed or critical at the run's start (by the cluster's own levels, on the corrected delay), in one `terms` filter; `all` the whole cluster — silent devices are covered only by `all` and the automatic every-2-hours run. A missing, empty or multi-cluster `clusterIds` is refused in plain words. Progress in `JOBS_LIST` counts devices (done of total, devices measured), the note names the cluster and *late devices (N of M)* / *whole cluster* / the device. The fleet board's Fetch now button says *Pick a cluster*.

## 0.3.61

- **Log Delay page shows what the core now counts:** per cluster, devices in the last run, now and in range (with a one-line hint what each means), how the last run read it (pages, complete, stopped at the device cap with the setting named, documents with no device name), Fetch Now progress as clusters done of total and devices read so far, *Hourly* in the log delay schedule pickers, and *Last hour* for Build report and Send now. Live Watch is labelled as the live check with its 500-device limit.

## 0.3.60

- **Security updates:** `russh` 0.63.2 → 0.65.1 (RUSTSEC-2026-0495, the SSH agent server's confirm constraint — ElasticPro only runs the SSH client, so the path was never reachable here; the upgrade also brings the client-side host-key and EXT_INFO fixes of 0.65.x), `quinn-udp` 0.5.15 → 0.5.16 (RUSTSEC-2026-0538), `tokio` 1.53.1 → 1.53.3 (RUSTSEC-2026-0386) and `crypto-bigint` 0.7.6 → 0.7.11 (0.7.6 was yanked). `cargo audit` is clean apart from the unmaintained `unsafe-libyaml` under `serde_yaml`, which has no drop-in replacement. No jump-host behaviour changes; russh 0.64 dropped the `legacy-ed25519-pkcs8-parser` feature, which only read Ed25519 PKCS#8 keys written in a non-compliant form by russh itself before 0.43 — ElasticPro never writes keys, and OpenSSH `id_ed25519` files were never that.

- **Log Delay is one page** (was *Logs & Delay*; docs/LOGDELAY.md "The Log Delay page"): the fleet, cluster and device boards, Recommended fixes, *Build report* and *Send now* moved here from Reports › Log delay, beside **Live Watch** (every cluster measured now from the browser) and **Live logs** (tabs: Dashboard · Recommended fixes · Live Watch · Live logs). Reports › Log delay is a link to it; the old addresses open the matching view (`#/reports/log-delay/…`, the log delay mail's link, and `#/logs`). One definition of each view: the code moved, nothing was copied.
- **Live Watch no longer fails when the top bar changes cluster:** the close-up of one device looked its cluster up in the current selection (and in the fleet check a re-check had just emptied), so picking another cluster — the VM opens on one — turned every poll into "The last poll failed: This cluster is no longer available". The watch now keeps its own cluster and field check. Its search is also bounded by the time range (it read every index of the pattern and counted every hit, which on a real cluster runs past the request timeout).
- **Live Watch lists every delayed device** with the boards' own device row (one row component: device, cluster, zone, tag1, now, delay, …, *Open in logs*), *Every device* on request; selecting one device shows only that device — the other devices and the per-cluster coverage are hidden until *Every device ›* (the device board likewise drops the per-cluster panel).
- **Time range for Live Watch and Live logs:** last 1, 5 or 30 minutes, 1, 2, 3, 6, 8 or 12 hours, or a custom from/to entered in the server's time zone. Times on the page are in the server's zone (PING `tz` when the core says it, else the browser's, and the page says which).
- **Live logs columns:** @timestamp (with its UTC offset in the head), device / src_hostname, ClientID, zone, tag1, parser_tag, fwd_tag, log_type, delay (min) and message, every one sortable with the shared column sort; *Open in logs* on any device row opens it narrowed to that device over the time range.
- **Log Delay – Fetch Now** on the boards: runs the log delay measurement for the cluster or device on screen (`JOB_RUN {jobId: logdelay.measure, clusterIds, device}`), follows its run in `JOBS_LIST` every 2 s (progress, done of total, devices measured), says `already_running` (and follows that run) and `blocked_readonly` plainly, and reads the boards again when it completes.
- **zone and tag1 in every Log Delay table** (devices, cluster devices, fixes, Live Watch, the close-up, Every delay, Live logs; By cluster lists each cluster's zones and tag1), and in Live Watch's .xlsx and CSV.
- **No flicker while the log delay boards load:** each card is kept until what it shows changed, each view's requests are let go of when the view is left (an AbortController per view, through `bridge(msg, {signal})`), a late answer for a view no longer shown redraws nothing, and a spinner says it is loading; tabs and links work while answers are out. `tools/flicker-check.mjs` holds every Log Delay view and Live logs to zero replacements under a parked pointer (`--ld-delay 4000|15000|fail` slows or fails the store's answers).

- **Collect now no longer times out on a slow cluster:** each day's search may take 110 s (it had 60 s, and a big day behind a jump host failed on every run, "asked again on the next run"), and a request that timed out or that a proxy or jump host turned away (502/503/504) is asked again in the same run, 3 s and 10 s later (three tries; the stop and a cancel are asked before each; a 429 is still deferred, not pressed). Reports › Daily & monthly (and Measure size) follow the run in the run log for as long as it runs — no more five-minute limit after which the progress quietly disappeared — show days done of total, say how it ended (finished with N days searched, or failed / deferred / cancelled with the error and *Try again*), and say plainly when it was already collecting, collected less than a minute ago, unreachable or held by the emergency stop. `VOLUME_RUN` still answers at once, so nginx's timeout never applies; leaving the page and coming back shows where the run is. `tools/mock-es.mjs` gains `MOCK_SEARCH_DELAY_MS` (e.g. `30000-90000`) and `MOCK_VOLUME_DAYS`.
- **Reports › Daily no longer goes blank for one source:** a Source chosen on one cluster (or a previous visit) was kept as the filter on a cluster that has no index of it, so every row was filtered away while the list read "All sources"; Daily now shows all sources and says so. An empty Daily or Overview says why — never collected, the last collection's error, no index matches the pattern, every matching index older than the window ("the record ends on …", from the new `VOLUME_DAILY.newestDay`), no index of the chosen source, or event_logsize not measured — instead of "Nothing recorded yet".
- **PING says the server's zone:** `tz` (IANA name, `null` when unknown) and `tzOffsetMinutes`, the zone the schedules and local days use, so pages can show times in it.
- **Log delay reads every device, page by page:** the measurement (the 2-hourly run, *Run now* and the new *Fetch now*) reads each cluster's devices as a composite aggregation in pages of up to 1000 (`after_key`), over a window fixed when the run starts, instead of one `terms` aggregation capped at *Max devices per run*: nothing is cut by the query. One page's answer is held at a time (halved when it is over the memory budget or the response cap), so 25 000 devices are 25 small answers, not one large one. *Max devices per run* takes 1 to 100 000 (it stopped at 10 000; default 20 000 for a new setting); a cluster with more is measured up to it, the run log and the page say so, and the devices past it are not turned silent. A page that fails keeps what was read and says how far it got. Documents without a device name are counted and said. Each document is read by the first event-time field it carries, as text or epoch milliseconds.
- **Fetch now** (docs/LOGDELAY.md, docs/JOBS.md): `JOB_RUN {jobId: "logdelay.measure", clusterIds?, device?}` measures now, by the scheduled run's own code, those clusters or that one device; it is in the run log with its progress (clusters done of the run's, devices read so far) and its scope (a retry runs the same scope), keeps the one-run-at-a-time rule, and a narrowed run turns nobody silent and leaves the schedule's timing alone.
- **Live and report device counts explained, and the report lists the range's devices:** the device list of every Log delay answer and report is now the devices measured in the range (the report for yesterday lists yesterday's devices; it listed every device remembered for the last 7 days, silent ones included, which is why a report could show 10 devices where a live check of the last hours showed 5). Each cluster says its devices three ways — sent logs in the last run, held now, measured in the range — with how its last run read the list (pages, complete, cut at the cap).
- **The live check's "error" devices:** the Logs & Delay page's *Fetch* (and Play's wall, the headless scrape) read each cluster by one event-time field, the first its mapping had anywhere, so every device whose logs carry another one was "error" (about half a fleet that mixes `ingested_time` and `event_created`); it now reads every candidate per document, and epoch-millisecond numbers. That check still lists at most 500 devices (its display-link limit) — the Log Delay page's numbers come from the measurement, which has no such cap.
- **Zone and tag1 in every log delay row, sheet and mail:** every device row of the LOGDELAY_* answers carries `zone` and `tag1`; the report's Devices sheet and CSV always have both columns, Top delayed and Fixes name them, the Summary sheet and the mail have a by-zone-and-tag1 table, and both fields are always read by the measurement.
- **Hourly log delay report:** the log delay report can be mailed every hour (at a chosen minute past, over the whole hour before), beside the daily and monthly ones — built-in schedule, created schedules and `UI_REPORT_LOGDELAY_SCHEDULE=hourly`; `REPORT_RUN`/*Send now* take `period: "lastHour"`; same workbook, CSV and HTML mail; an hour without a measurement says so. `UI_REPORT_LOGDELAY_TO/SCHEDULE/AT` are now read from config.txt (they were listed as managed but ignored as unknown keys).

- **Reports › Overview opens on All clusters:** arriving there, or switching to it from another section, shows the whole fleet even when another page had one cluster chosen; a link that names a cluster, or a cluster picked while on Overview, is kept.
- **Jobs: one registry and a run log** (docs/JOBS.md): every job ElasticPro runs — log delay measurement, daily volume and hosts collections, report runs and the mailed schedules, history store mirror, housekeeping, settings backup, Zabbix sync and push — is listed once with its owner, schedule, next run and priority, and every run is recorded (trigger, start, end, status, progress where it is counted — null where it is not — records, error, clusters), kept across restarts (50 per job) and read with `JOBS_LIST` (users and up; a caller limited to some clusters reads a run only when they see every cluster it touched, the REPORT_JOBS rule). One run per job at a time: a log delay *Run now* or housekeeping asked for while one goes answers `already_running` (EP-220) with that run's id, a Zabbix sync waits for the one going — the manual log delay run no longer overlaps the timer's — and the hosts collection's three tries a day survive a restart.
- **Zabbix clusters can be edited in ElasticPro:** Config-Management › Clusters › Edit now opens for a cluster that comes from Zabbix, with everything a config-file cluster has (name, route, certificates, enabled, tags, retention, backup capacity, note, volume window, type) except the URL, which is shown read-only and always comes from Zabbix. Edits are kept in ElasticPro by Zabbix host id (`zabbix-overrides.json`, in the backup), survive every sync and win over Zabbix's values; each field set here says so and has *Use Zabbix's value*. The core polls with them. An admin can set the cluster's own credential here too (kept encrypted on the server, bound to the address Zabbix gives; Zabbix's is used when none is). Zabbix is never written to. New message `ZABBIX_CLUSTER_SAVE` (operator; docs/HANDBOOK.md "Zabbix clusters edited in ElasticPro").
- **Certificates off is an administrator's:** below admin, `CLUSTER_SAVE` no longer lets a cluster be newly set to `tls: insecure` (`tls_insecure`; one already insecure stays so), and the same holds for a Zabbix cluster. An operator also may not change the route or certificates of a Zabbix cluster whose credential is its own (Vault, a password macro, one handed over, or one kept in ElasticPro).
- **Every table sorts the same way:** click a column heading to sort, click again to reverse (Enter/Space with the keyboard); an arrow and aria-sort mark the column, and each table remembers its order in this browser. Sizes, percentages, durations and dates sort by their value, text in natural order (node2 before node10), and an unknown ("not measured", "—", "[set]") always sorts last, never as zero. New on the Reports tables (By cluster, Storage plan, Day by day, Month by month, Measure size, Planning bill of materials, Mailed reports, every Log delay table), Requests and Requests › Health, Accounts and Shards; the tables that already sorted (Clusters, Indices, Snapshots, snapshot evidence, the Capacity sheets, Volume by host — still sorted on the server) now use the same heading. A table with an order of its own (the request log's "in flight first, then newest", Log delay's "time spent late") gets it back on a third click.
- **Jobs: the controls** (docs/JOBS.md "Controls"; administrators of every cluster): `JOB_RUN` runs any job that can run on demand now and answers its run id — two presses are one run, and *Refresh now*, *Run now*, a manual backup and *Send now* are recorded the same way (`manual:<user>`); `JOB_PAUSE` / `JOB_RESUME` hold a job's timer (a run going finishes; kept in `job-runs/controls.json`, so it survives a restart); `JOB_CANCEL` ends a queued report at once and stops a running run at its next safe point (between days, pages or clusters), the ask surviving a restart (`cancelled`, not `failed`); `JOB_RETRY` runs a failed, deferred or cancelled run again with the same parameters (`trigger: retry`), at most 3 times, 5 minutes apart (EP-221, EP-222); `JOB_CREATE` runs a report once or makes a mailed schedule of its own — several per report kind, each its own job, the built-in schedule and its config.txt keys untouched (`JOB_DELETE` removes one); `JOB_SETTINGS_GET/SET` keep per-job automatic on/off, request limits, priority and the overall limits for the coming governor. The same report asked for while it is queued or running joins it; identical background reads in flight share one answer (never across credentials or people). A cluster that is busy — search queue over half full or rejecting, answers over 8 s, or 429 — has its background collection deferred (one `deferred` run per wait) until it eases, while the other clusters carry on; `JOBS_LIST` lists the busy clusters, marks a worker's run `stale` while the worker's heartbeat is late, and the Zabbix sync has a real next run after a restart. The log delay measurement's `JOB_RUN` is refused while the config is read-only (`Writes::decide`; the session's write unlock does not reach background work).
- **Jobs: the governor** (docs/JOBS.md "Governor"): the worker sizes its own parallelism every 10 s from what it measures — one more request at Elasticsearch when CPU is under 60 %, memory under 70 % and nobody waits at the core's gate; half as many when people wait there (the core publishes it every 5 s, `job-runs/core-load.json`), CPU is throttled or over `cpuPct`, memory over `memoryPct`, or most clusters in work reject — never below the running jobs' minimums nor above `workerTotal`. Running jobs share it by priority (High, Medium, Low), each keeping its minimum and none above its maximum (`auto` off: its maximum), each held to its share in a lane where its requests take their gate slot; the worker's gate follows the total. A busy cluster still shrinks only its own work (its controller's ceiling is now the smaller of its own and the job's share). `mostAtOnce` (default 4) is the one setting for jobs at once — `REPORT_CONCURRENCY_SET` writes it (handled by the core; reports now run 4 at once by default, less running collections, at least one) and a collection's timer waits while it is reached. The core's gate limits (`ES_CONCURRENCY`, `ES_PER_CLUSTER`, `ES_PER_JUMP_HOST`, `ES_BACKGROUND_RESERVE`) change without a restart through `JOB_SETTINGS_SET overall` unless config.txt sets them. The log delay measurement and the history store run at their fixed maximum. `JOBS_LIST` gains `governor` (total, in use, jobs running, the last change and why, the signals — null where not known) and each running job's `state.allocation`.

- **Jobs page** (docs/JOBS.md "Jobs page"; user and up read it, an administrator presses things): a new page, *Jobs*, beside Reports. A strip with worker and core CPU, memory, requests per second, jobs running and queued, busy clusters with why and since when, and the adaptive governor once the core reports it. *Running now*: each open run with the clusters it is on, a progress bar and percent (or "counting…" when the core does not know — never a bar at 0 %), records, start, live duration, requests and Stop; a stale worker run is marked. *Up next*: the scheduled jobs by their next run, in server time when the core names its zone (else said to be your time), with Run now and Pause/Resume. *All jobs*: one sortable table (unknown values last both ways) with status, progress, times, last result, a cut-short error opened in full, priority, requests and a menu of Run now, Pause/Resume, Stop, Retry, Settings and Delete. *History*: every run, 50 a page from the server, by job and result, with Retry. *Settings*: the overall limits and each job's automatic runs, auto, requests and priority (read-only below admin). *Create job*: a report once now, or a mailed schedule of its own. Every press goes through the write unlock and says a refusal (`already_running`, `joined`, `blocked_readonly`, `retry_limit`, `retry_wait`, `forbidden`) as a sentence. Read every 2 s while a run is open, every 15 s otherwise, not while the tab is hidden; rows, bars and buttons stay the same elements while runs move. Reports › Exports & schedules links to it (*All jobs →*).

- **Zabbix sync never takes over an existing cluster silently** (docs/HANDBOOK.md "Zabbix sync — hosts held for review"): a Zabbix host at the address of a cluster ElasticPro already has — a config-file cluster, or another Zabbix host in use — is held: not polled, not listed, and nothing about that cluster changes. Until now the pages set the config cluster aside the moment the addresses matched, with nobody asked. An administrator reviews it in Config-Management › Zabbix › *Held for review*: the two side by side, then *Skip*, *Update* (the host takes the cluster over) or *Keep both*, applied only on Confirm and audited (`ZABBIX_CONFLICT_DECIDE`, admin). The decision is kept (`zabbix-conflicts.json`) across syncs and restarts, and asked again only when Zabbix's values for the host change. Hosts that do not conflict sync as before. **Addresses are compared as one identity**, defined once in the core and parsed by the HTTP client's own parser: scheme, host and port, with the default port written out (`https://es` = `https://es:443`, which used to be two clusters); an address with a credential, a backslash, a query or a fragment matches nothing, and a Zabbix host whose macros make one is not a cluster. *Use ElasticPro credentials* lends a config cluster's credential to a Zabbix host only after an administrator chose Update for it (no longer whenever the addresses matched), and a credential in a config cluster's address never hides it from the review. **Preview sync** shows what a sync would add, change, remove or hold, and writes nothing (`ZABBIX_SYNC_PREVIEW`, admin). Upgrading changes nothing: the first sync records the takeovers already in place as decisions (Update where a config cluster was set aside, Keep both otherwise), listed and changeable — and if that record cannot be written, every conflicting host is held instead; a host `createHosts` makes is recorded as Update.

- **Every theme reads at WCAG AA:** Dark blue's log delay pills (critical, delayed, little delay) were drawn in the light theme's inks — dark pink on a pink-tinted navy, 1.4:1 — because those inks were set for Light and Dark only; they are now theme tokens (`--ld-*-ink`, `--ld-*-bg`) in all five. Every toned pill and badge has an edge in its own ink, so a grey "silent" pill no longer disappears into the surface. Muted text, column heads and the values in fields are darker in Light (4.25:1 → 5.9:1 on a card) and lighter in the dark themes, so they pass on a hovered and a chosen row too; text fields and selects have a 3:1 edge (`--field-border`); danger buttons, alert figures and the inline warning/critical text use the status inks rather than the fill colours; Overview's master/ingest role badges are themed; the Capacity table's band head is opaque, so rows no longer show through it when it sticks.
- **Chart colours follow the owner rule in every theme:** no chart, bar or meter shows red and yellow together; status in a chart is light green, blue, pink and orange (`--chart-good/-info/-bad/-warn`: disk and heap meters, the shards and Overview donuts, the snapshot coverage strip, the runway and capacity bars), and the categorical series drop red and yellow.
- **`tools/contrast-check.mjs`:** a Chromium check of every theme on 27 pages — text, muted text, links, buttons, headers, field text and edges, pill text and edges, sticky heads, hovered and chosen rows, focus rings — measured from the computed colours against the background actually under them, with a per-theme table; it also records console errors on every page in every theme. Exits 1 below AA. `tools/fit-check.mjs --theme <name>` runs the fit check in one theme (`tools/lib/theme.mjs`).

## 0.3.59

- **Planning shows disk as it is bought:** /live disk each, /backup disk, the S3 / ULM size, the tiles and the CSV round up to a whole TB (2.79 TB → 3 TB, 19.5 TB → 20 TB), never down; the /live disk tile is the rows' sum (7 × 3 TB = 21 TB).
- **The Planning bill of materials fits in one view:** no sideways scrollbar from 1024 px up (Chromium and WebKit); headers wrap to two lines, number columns take only their width, and below 1180 px the results move under the inputs.

## 0.3.58

- **Log delay, re-checked:** the worker no longer builds reports from a days-old tracker (the cached tracker is checked against the file on every read); the Forwarder/Parser fix rule counts only devices measured while the group was late, and claims "the others were on time" only when at least one of them was; an admin limited to some clusters no longer reads a run error, skip reason or sink cluster about a cluster outside their view (run notes are recorded with the cluster they are about, and every DELAY_SINK_* and LOGDELAY_* answer goes through one per-caller view); the device page's "Delay by cluster" panel reads each cluster's daily totals instead of every tracker.

## 0.3.57

**Upgrade notes**
- **Log delay is measured every 2 hours by default** and kept in a built-in store under `<data>/logdelay/` (90 days). The Elasticsearch copy goes to the history store only under its two switches (or to the sink cluster as before). Settings: Config-Management › Data › Scheduled log delay.
- **Delay levels** now come from the core: no delay under 15 min, little delay 15–30, delay 30–60, critical over 60. A cluster's own thresholds still override.
- **Check the event-time field per cluster** (`event_created` or `ingested_time`) in the new Fields card; a field that can't be read shows "can't measure", never 0.

**Log delay report, core** (docs/LOGDELAY.md, #129): delay periods with start and solve, silent devices, daily totals, the extra ECS fields (tag1, fwd_tag, parser_tag, Zone), recommended fixes as plain rules with their evidence, LOGDELAY_* messages limited to each caller's clusters, and the `log_delay` report kind with an .xlsx (Fixes sheet), a .csv and a multipart HTML + text mail. No PDF yet.

**Reports › Log delay** (docs/LOGDELAY.md, the owner-approved Main, Cluster, Device and Fix boards): the fleet (totals, the without-delay share, delay reduced over 2/4/6/12/24 h, day by day, delayed devices by cluster, the By cluster table and every device), one cluster with its ECS columns, one device (find by name, src_hostname/src_device or an extra column with wildcards, cluster and dates; insights, start/solve markers, delay by cluster, the recommendation) and the recommended fixes, at `#/reports/log-delay/…`. Silent, can't-measure and days without totals are shown as such, never as 0 or on time. **Config-Management › Data › Scheduled log delay** gains the delay levels, the fields and the log delay report generator (xlsx/csv; no PDF, which the core does not build), and the *ElasticPro built-in only* destination. The UI no longer keeps its own delay thresholds: the Logs & Delay page, Play's cluster alerts and the headless scrape classify on the core's levels, and a cluster whose levels the core has not said reads "levels unknown".

- The bottom status strip (config, clusters, health, request rate, polling mode, tunnels, credits) is removed from every page. Its signals live elsewhere: the top bar keeps the emergency stop with its Resume control and the snapshot pill; Config-Management shows the polling mode, request load, jump-host tunnels, the config path ("loaded once — not remembered") and the About card with the GitHub and Support links.

## 0.3.56

**Backup fixes from the 0.3.55 test-VM run.**
- Every kept backup that rotation removes is audited (`backup rotated out`, with the file's `name` and the `user` who caused it, or `system` for the timer). A schedule change lowering *keep* and a manual *keep* used to remove files without a line; all four paths now go through one prune. A second backup in the same second is now the newer one: it was sorted as the older and could be rotated out the moment it was kept.
- Audit lines give an optional field's plain value, or leave the field out when there is none, instead of Rust's `Some("…")`: `before` on `backup restored` and `backup restore refused`, `via` and `zabbix_role` on `zabbix sign-in code issued`, `source` on the display-link and sign-in refusals, `until`, `was`, `slm`, `ulm` and `expires_at`. The field names are unchanged.
- docs/HANDBOOK.md said a backup made without a password has `credentials: null` in the file. The file has no `credentials` key; a preview shows `backup.credentials: null` and the `BACKUP_CREATE` reply says `credentials: "none"`, which is what the page and `tools/hosted-check.sh` read. The handbook now says so.

**Clusters, the open row (owner-approved revision).** The strip is one thin row: each box (Cluster health, Endpoint, Jump host, Log bucket) shows its label and value side by side, and the Report button is gone from its end. Tighter spacing: 6 px inside the panel, 4 px between strip, cards and tables, 4 px between cards. Backups (SLM) says only *No policy for logstash-\** (the wildcard matching is unchanged). Nodes: a data node shows one plain `data` chip, its tiers in the chip's tooltip, and the *Data node* legend is gone. ILM: *No policy* (red, with *Indices without a policy ›*) only when Elasticsearch confirms no log index has one; when which policy each index has could not be read, a grey *Not known*, with the permission it needs in the tooltip. The card and the summary's ILM cell read one definition of the two (`ilmPolicyState`).

**Tests.** `tools/hosted-check.sh` no longer fails after "ok": its exit traps ran under `set -e`, so a `kill` of a server that had already stopped failed the run.

## 0.3.55

**Upgrade notes**
- **Re-pair the Zabbix modules once.** The ElasticPro sync role gains `user.get`, which roles from Zabbix user groups need. A site paired before modules 2.1.20 gets it by pairing again (the pairing updates the role), or by adding `user.get` to the role's API methods by hand. Until then the tables show each person's groups as their last sign-in said (docs/ROLES.md).
- **Zabbix modules 2.1.20 come with this release** (`deploy/zabbix/MODULES_REF`). Zabbix sends group ids, which roles from user groups use.
- **The daily backup is on by default in hosted mode:** 02:00 server time, the last 14 kept, every section, under `<data>/backups/` (docs/HANDBOOK.md). Change or turn it off under Config-Management › System › Backup & restore.
- **The menu has new names.** **Config** is now **Config-Management**, **Live logs & Log delay** is **Logs & Delay**, and **REST console** is **REST**. **Accounts, Automation and Requests** no longer have their own menu entries; they are tabs inside Config-Management, and every old link and deep link still lands on them. Operators see Clusters, Alerts › Automation and Requests › Request Centre there; users and guests see nothing.

**Config-Management.** The thirteen Config tabs become nine pages with tabs (Clusters, Accounts, Zabbix, Alerts, Requests, Reports, Data, Play, System), in a menu on the left with a state on the right. Every form takes part in one save bar that names each change and runs the section's own save; leaving with unsaved changes asks first. **Find a setting** searches every label. Defaults are edited in place. Hints elsewhere in the app now name the page and tab a setting lives on.

**Your settings.** The person's name opens Your settings: page menu Top or Left, theme and opening page, kept with the account (the browser's copy is carried over once per browser).

**Roles from Zabbix user groups.** Each ElasticPro role holds any number of Zabbix user groups; a person in several gets the highest, and a person in none gets the *In none of these* rule (the Zabbix-role map, or no access). Preview shows who would change. A role set by hand wins over the map, including the new per-person **No access**. Each Zabbix sync re-checks roles and lowers them, never raises them; users deleted in Zabbix lose their sessions. Nothing can leave zero administrators able to sign in (EP-108 `no_access`, EP-109 `last_admin`). Config-Management › Zabbix has the group table and the Zabbix users table (docs/ROLES.md).

**Backup & restore** (admin only). One `.epbak` file of ticked sections. Credentials are left out or sealed with a backup password (12 characters or more); a kept copy is sealed under the server's key. Download now, scheduled backups, restore from a file or a kept backup with a preview, then Merge or Replace. Every restore keeps a before-restore backup first. The Zabbix API token, pairing secret and display-link secrets are never included. New error codes EP-308 to EP-315.

**Backend routing.** Config-Management › Data › Backend sets, for history, reports and alerts separately, whether each is kept built-in, copied to the history store, or kept on the store only. The store keeps its own two gates (config and admin arm), and nothing is deleted on either side. Alerts raised and cleared are reported from the page that saw them, once per browser. A size or state that cannot be read says *unknown*, never 0 (docs/HISTORY.md).

**Clusters.** The expanded row is rebuilt to the approved design.

**Settings and config history.** Settings go with your account; config versions record who changed what and when; a running snapshot is read as running.

**deploy.sh** recognises a compose file an older release shipped, by its own image pins, so `--upgrade` no longer treats it as edited.

**Config-Management fixes from the release's browser pass** (#123). The save bar's Discard and Save now work in a real browser (a field's change on blur used to rebuild the bar under the mouse, so the click never landed). A reload or bookmark of a tab that depends on the server's answer (System › Backup & restore, Data › Backend) now opens that tab instead of the first one, and a tab picked while that answer is awaited is kept.

**Tests.** Three flakes fixed (the plan-templates audit capture, the health-list hover, and the hosted "a backup preview writes nothing" check, which counted the minute timers' own files).

## 0.3.54

**Upgrading: fetch the new `deploy.sh` first.** 0.3.54 adds a second container, the report worker, so the compose file changes. `deploy.sh --upgrade` runs the installed release's script, and one from before 0.3.54 cannot bring in the new compose file. Download the 0.3.54 `deploy.sh` into `deploy/`, then run `deploy/deploy.sh --upgrade=0.3.54 --dry-run` and `deploy/deploy.sh --upgrade=0.3.54` (deploy/README.md, "Upgrading to 0.3.54 or later"). The script shows the compose change before writing it and keeps the current file as `.compose-previous`. `--rollback` puts the file back along with the images. A compose file you edited yourself is left alone unless you pass `--replace-compose`. `ELASTICPRO_RELEASE_URL` points it at a mirror, or at a `file:///` folder for hosts with no internet access.

**Indices report and Volume by host.** Two new report kinds in Reports › Exports replace the operator's own cron scripts (docs/REPORT-TYPES.md):
- **Indices report:** one row per index per day from `_cat/indices`, with documents and the index store size (`pri.store.size`). It is the one export that is not event_logsize. It is mailed daily at 08:00 with the month so far.
- **Volume by host:** one row per day × index × source host, with event_logsize and forwarded size. It is collected daily at 06:00 for every cluster and mailed at 06:00 with the month so far. A missing ClientID is filled the way the script filled it (`UI_REPORT_CLIENT_ID_FIELD`, `UI_REPORT_BRANCH_FIELD` / `_DEFAULT`).
- Reports › **Volume by host** shows the collected rows, with filter, sort, a day picker, paging and an xlsx download.
- **Run now** takes at most 5 clusters at a time. A larger request is refused whole (EP-217, `too_many_clusters`), and nothing is queued.
- The new period **Month so far** runs from the 1st to yesterday; on the 1st it is the whole previous month.
- Settings:
  - `UI_REPORT_INDICES_*` and `UI_REPORT_HOSTS_*`: time, recipients, schedule, page and time limits, months kept, fields, request timeout, pause between pages;
  - `UI_REPORT_MAIL_MAX_MB`.

**Reports collect faster without pressing a cluster.** A collection now sends more than one request per cluster at a time. It starts at `UI_REPORT_CONCURRENCY_START` (2), rises to `UI_REPORT_CONCURRENCY_MAX` (4) while pages come back within `UI_REPORT_PAGE_TARGET_MS`, and backs off as soon as they slow down or fail. Up to `UI_REPORT_CLUSTERS_AT_ONCE` clusters run at once. A collection keeps checkpoints as it goes, so a stopped or failed run resumes where it ended. Everything is still a read under the daily volume run's rules: Background class, the emergency stop, and one collection per cluster.

**The report worker.** Report collections, builds and mail now run in their own container (`worker`, same image, `ELASTICPRO_ROLE=worker`), so a large or failing report cannot slow down monitoring. The core keeps the UI, polling, alerts, Play and Zabbix. The worker listens only inside the stack (port 8766, never routed by nginx) and takes work only with the shared token in the data volume (mode 0600). It accepts at most 16 requests in flight overall, 4 per cluster and 4 per jump host (`ELASTICPRO_WORKER_GATE_*`). Its memory and CPU are capped (`ELASTICPRO_WORKER_MEM_LIMIT`, `ELASTICPRO_WORKER_CPUS`). `ELASTICPRO_ROLE` unset (`all`) runs everything in one process as before, so a stack without the new service keeps working.
- New error codes:
  - **EP-218** `worker_unavailable`: the worker cannot be reached, or its heartbeat is 30 s old or more. Nothing is queued and monitoring is unaffected.
  - **EP-219** `worker_version`: the core and worker versions differ, and the worker refuses work until both match.

**ElasticPro's own health.** Request Centre has a second tab, **ElasticPro health** (`#/requests/health`), for admins only. It shows:
- a status chip each for the core, the report worker, Redis, the database, Zabbix sync, mail and the history store;
- memory against the container limit, with the 24 h peak and OOM kills;
- what is queueing;
- whether a report is pushing too hard.

A worker heartbeat that is late turns amber. A part that cannot report says *not known*, never green. Opening the tab sends no cluster anything. A dot on the Request Centre entry turns amber or red when a check does.

**Pages no longer flicker while they refresh.** Pages that redraw on a timer now keep every part that did not change, instead of rebuilding it on each poll:
- the Index filter on Nodes & shards and the Clusters search no longer lose the keyboard after one character;
- Request Centre's filters no longer jump back to their first option every 2 s;
- on Exports, the Stop button of a running job stays under the mouse and answers a slow click;
- the health tab's open sections stay open;
- Alerts' Export, Acknowledge all and Retry all act on the data on screen when pressed.

**The desktop app is removed from the tree.** `src-tauri/`, the Windows cross-build and the portable-mode files are gone; the v0.3.51 tag still has them.

**Also fixed (from the test-VM run):**
- The Volume by host collector asks again for a page that timed out or had failed shards. A cluster that answers with something that is not an aggregation at all fails once with that reason, and the job moves on instead of retrying forever.
- Leftover checkpoint and part files from a crashed or stopped collection are removed before the next one starts.
- The core gives up on an unreachable worker after 1 s instead of hanging.
- `deploy/trial.sh` takes `TRIAL_PERIOD`, so a real cluster with no data in the last seven days can still be tested.

## 0.3.53

**Reports replaces Volume report.** The tab is now **Reports** (`#/reports`; `#/volume` and Zabbix's `elasticpro.volume` still open it), redesigned from the approved design in six sections: **Overview** (yesterday, 7-day average, month so far, clusters whose disk runs out within 6 weeks, backups that do not fit; daily volume for the top 5 clusters; how long the free disk lasts; one row per cluster), **Daily & monthly** (moved here from Indices › Summary, which now points to it), **Capacity & retention** (the storage plan: per day, 30% buffer, live retention held and policy, data-node disk as a bar with its % and "used of total, avail", required disk and **Live disk shortfall**, backup policy, repository disk, required backup disk and **Backup disk shortfall**), **Measure size** (index size per day against event_logsize, per cluster and day by day; *Measure size* runs a collection), **Planning** and **Exports & schedules**. Every size on Reports and in every export (CSV, XLSX, report layout, mailed and generated reports) is **event_logsize**; index size appears only on Measure size. Disk means **data nodes only**, filtered by node role. Columns on Overview and Capacity can be shown, hidden and reordered (drag or ▲/▼), and *Save for everyone* keeps the layout on the server. A figure that cannot be read says *not measured* / *not set* in amber, never 0.

**Which indices count.** The default is now the pattern **`logstash-*`** (`UI_VOLUME_INDEX_PATTERN`, one or more comma-separated patterns). An index with a date in its name counts on that day in full, as before; one without a date is split into days by its documents' time field (`UI_VOLUME_TIME_FIELD`, default `@timestamp`), or every index can be split by time (`UI_VOLUME_DAY_FROM=time`). For a time-split day, documents and event_logsize are measured and the disk size is *not measured* (Elasticsearch reports size per index). Config › **Reports** (was *Volume fields*) shows the pattern with a live preview of what it matches. `UI_VOLUME_INDEX_FORMAT` still works when set and the pattern is not; old records read unchanged.

**Planning and plan templates.** Reports › Planning sizes a new or existing cluster from a **plan template**: daily volume, live retention policy as hot + warm days, backups to /backup disk, S3 or ULM → S3, backup retention, buffer and replicas give a bill of materials (forwarders and parsers per 150 GB/day, Elasticsearch hot and warm data nodes by node size, dedicated masters from 3 data nodes, coordinating nodes, Engine, AI/ML, ULM, S3, other servers) with CPU, RAM, / disk, /live and /backup disk. Templates are kept on the server and edited by admins in Config › Reports › Plan templates (sizing rules: scales with daily volume, fixed count, live retention policy hot/warm, added when data nodes reach N, follows another role, backup target). A value not set yet shows `[set]` and is left out of totals, which say so. New messages `PLAN_TEMPLATES_GET` / `PLAN_TEMPLATES_SET` (audited).

**History store (hosted).** ElasticPro can mirror its daily and historical figures to a **dedicated Elasticsearch endpoint** (Config › History store: its own https URL and credential, kept encrypted, never shown again): the daily volume record, a daily capacity snapshot per cluster (measurements only) and, if chosen as the Scheduled log delay's destination, the log-delay measurements, into monthly `elasticpro-history-<stream>-YYYY.MM` indices with fixed ids (a repeated write replaces itself). Reports › Daily & monthly read days the server no longer keeps from the store, marked *history*; an unreachable store is said once, in amber, never shown as 0. **Writing needs two decisions**: `HISTORY_STORE_WRITES=true` in config.txt, and an admin switching *Write history* on after a passing *Test connection*; any settings change switches it off. The store may only receive its own index template, bulk writes to its own indices and searches; it may not be a monitored cluster or use a reserved prefix (logs, metrics, logstash, …); monitored clusters are never written. Retention of the store's indices is the store owner's.

**Zabbix modules 2.1.18 and 2.1.19.** ElasticPro pages in Zabbix now reach the bottom of the window (no grey band, nothing cut off), and the page is titled **Reports**.

**Also:** a limited admin can no longer change the Scheduled log delay (it reaches every cluster), and is held to their clusters for the per-cluster volume reads.

## 0.3.52

**Desktop builds are deprecated.** The Windows portable zip and installer, macOS and Linux builds are no longer built or released; 0.3.51 is the last release that carries them. The hosted Docker images and the Zabbix modules are the maintained builds. `install.sh` installs the Docker stack by default and `--portable` exits with a deprecation message. The `src-tauri` shell is no longer a workspace member. Releases are now created by the Zabbix modules job.

**High, a third alert level.** Between critical and warning, in orange: a failed SLM run and logs more than 60 minutes late are now High rather than critical, and a new rule raises High when any node's JVM heap is over 85 %. The Alerts page counts and filters High on its own, the Alerts tab turns orange when the worst open alert is High, and Zabbix still raises these at its High severity through the existing critical trigger (the detail says `[High]`). Failed snapshots and late logs no longer take over the Play screen — only critical alerts do. JVM heap is raised after two readings in a row over 85 % and cleared below 80 %, so a node hovering at the line does not flap. On Play a High cluster is orange, says "High" and sorts above yellow tiles, the Alerts slide shows HIGH rows, and critical tiles blink red every 1.2 s, High tiles orange every 2.4 s; a full node's row in the spotlight, a cluster's red log delay and a disk runway under 7 days blink too — held still for anyone who asks their system for reduced motion.

**Fewer requests while Play runs.** A request ElasticPro sends by itself is no longer sent again while the same one was answered less than a minute ago — the asker gets that reading, with its age — and askers for a request already on its way share it; the REST console is never held. While a wall display is open, Play keeps its data coming at its own pace (health and nodes every 5 min, the index list hourly, snapshots every 2 h, SLM/ILM every 4 h) unless a person's page wants it sooner, and the log delay is checked in full every 2 h with the late devices re-checked every 15 min in one request; the Log delay slide says when each last ran. About 55 requests per cluster per hour instead of 95. Both are set in Config › Requests ("Duplicate requests", "While Play runs") and can be locked in config.txt (`POLL_MIN_GAP_SECONDS`, `POLL_PLAY_*_SECONDS`); the Request Centre shows what the gap saved per dataset.

**Play opens in the browser's full screen.** Pressing **▶ Play** asks the browser for full screen, then opens Play; if the browser refuses, Play opens in the window as before. Press F or use the full-screen button on the Play controls to toggle it; Esc leaves full screen without leaving Play, and leaving Play leaves full screen only if Play entered it. On a TV opened from a display link, a one-time hint explains F and kiosk mode.

**Play: the Fleet wall order per display.** Config › Play › Edit display has a "Fleet wall order" row: up to three of critical problems, log delay, volume used yesterday, disk used, open alerts and name, each largest first, the cluster name breaking a tie. The default is critical problems, then log delay, then volume, and the slide header shows the order. A cluster whose figure is unknown for a key goes after those that have one.

**Zabbix modules 2.1.17: Play fills the whole screen in Zabbix too.** ElasticPro › Play gets a **Full screen** button, and the Play dashboard widget's **Full screen** fills the screen with the widget's own frame (same session, no new tab, no reload); *Open in new tab* stays. Esc returns. `fullscreen=1` still never writes the user's saved layout. Every ElasticPro frame in Zabbix now allows full screen, so ElasticPro's own Play button works inside Zabbix.

## 0.3.51

**The Apple-silicon macOS build is back.** GitHub retires its macOS 14 runner image on 2 November 2026, and a scheduled brownout cancelled 0.3.50's arm64 job, so the 0.3.50 release has no macOS arm64 build and no checksums file. The arm64 build now runs on macOS 15, and the Rust target is chosen by the build's label rather than the runner's name. Nothing else changes: 0.3.50's Docker images and other builds are the same code.

**Play: the time-left line is a hairline.** The bar under Play's top bar that shows how long the slide has left is now a thin line (1 px at 1080p, 2 px at 4K) instead of a 3–4 px bar. On the Alerts slide a warning sits in a yellow bar and a critical alert in a red one, as in the design; before, only the stripe at the left edge was coloured.

## 0.3.50

**Alerts — held alerts now show what was wrong.** When a cluster cannot be reached, ElasticPro evaluates its alert rules against its last cached data — nothing is asked of the cluster — and lists what they raise under its Unreachable line, dimmed and marked "not current", each "as of" the time of the data it came from ("2 older alerts held, not current · as of 14:02"). A rule whose data is missing or more than 24 hours old shows nothing. Held alerts are still counted nowhere — not the bell, the tab, the top bar, the summary or Play — and can be acknowledged; the acknowledgement carries over when the cluster answers. When it does, an alert that was announced before the outage and is still true is current again without being announced a second time; one nobody was shown (a page or TV opened during the outage) is announced then; one that cleared is gone. Play shows the same dimmed line under a down cluster's tile. For Zabbix, a cluster that does not answer no longer sends "clear" for every rule: its ElasticPro problems stay as they were through the outage instead of resolving and reopening as new events; a cluster removed from the configuration has its alert values cleared once. Automation and log-delay values are not sent for a cluster that does not answer.

**Operators may pause and resume polling.** An operator now begins and ends the emergency stop exactly as an admin does: Request Centre → *Stop for 15 / 30 / 60 min*, asking first, and the **Resume** button in the top bar. The Request Centre opens for an operator with the stop alone; the request log and housekeeping stay an admin's. The core gets two narrow messages, `POLICY_PAUSE {minutes}` and `POLICY_RESUME`. They change the stop and nothing else, and both are audited under the caller's name: activity `policy_pause` / `policy_resume`, category configuration. The rest of the request policy (`POLICY_SET`: mode, budgets, intervals) stays an admin's. Because the stop holds every cluster, an operator limited to some clusters by Zabbix host groups is refused it and is told why. A user and a display link are refused. The admin's own stop and the top-bar resume use the same messages now, so resuming no longer reads and rewrites the whole policy. Saving the request policy (Config › Requests) now leaves the emergency stop alone: it never begins, changes or lifts one, so a form opened before somebody stopped the fleet cannot undo the stop. Also fixed: Config › Volume fields no longer writes a config.txt-managed value into the clusters file when config.txt stops managing that key between opening the page and pressing Save.

**Zabbix modules 2.1.16: Discover can ask TypeSafe Jev (opt-in).** ElasticPro → Settings in Zabbix has a new card, *Discover with TypeSafe Jev*, off by default; a Super admin turns it on and gives an API key, which is stored encrypted like the pairing secret and never shown again. When it is on, one request per Discover scan asks which known client each unattached role server belongs to, whether a server is Kafka, and whether a host group holds Elasticsearch cluster hosts. Only host, visible, host-group and template names and the candidate client names are sent; any IP address in them is replaced first, and no item value, macro value or log content is sent. A sure answer is proposed ticked; an unsure one is shown with *Jev: check* and an unticked box; nothing is written until an admin applies it, and applying asks nothing again. When Jev is off, has no key, or does not answer properly, Discover uses its name rules unchanged and says so on the page.

## 0.3.49

**Play inside Zabbix (modules 2.1.15).** The Zabbix modules pinned by this release add Play to Zabbix:

- **ElasticPro › Play** in the Zabbix menu opens the wall display as the signed-in Zabbix user, through the same sign-in the other ElasticPro pages use, so it shows the clusters that user sees. `&fullscreen=1` hides Zabbix's menu for that page only, with an *Exit full screen* link; it never changes the user's saved layout (Zabbix's own `kiosk=1` would).
- **ElasticPro Play** dashboard widget (`ep_play`, the eighth module) shows Play sized to the widget, with an *Open full screen* link. The widget stores no address, sign-in code or secret: each time the frame loads it asks Zabbix for a fresh one-use sign-in, guarded by Zabbix's CSRF check. It goes blank while its dashboard page is out of view and signs in again when it comes back. There is no display-link field: a widget's fields are readable by anyone who can view the dashboard.
- Guests are refused, and a user who is not a Super admin is told the error code but never the internal core address.

`install-modules.sh`, `zabbix-modules-install.sh` (`KNOWN_IDS`), the release archive and its check now carry eight modules. The Zabbix test stack's compose file also mounts `ep_tophosts` and `ep_overview`, which it had left out.

## 0.3.48

**The Windows portable build is back.** The 0.3.45, 0.3.46 and 0.3.47 releases have no Windows portable folder and no checksums file: a report test kept a variable it used only on Linux and macOS, and on Windows clippy (`-D warnings`) refused it as unused. Each release's Docker images and the other desktop builds are unaffected. The variable now lives inside the Unix-only check.

**Pull requests run the Windows clippy.** It ran only when a release was tagged, so every pull request was green while three releases failed. A `windows — clippy` job in CI runs the same command on every change.

## 0.3.47

**Play: the NOC wall display.** A full-screen page for the TV on the wall, `#/play`, opened with the **▶ Play** button in the top bar or, on a TV nobody signs in on, through a display link. It runs the same code as every other page, so each figure on it is the one the Overview, Alerts, Logs, Snapshots and Volume pages show. A figure that cannot be read says *no data* or *not measured*, never 0.

- **Six slides.** Fleet wall (a tile per cluster, worst first: status line, nodes, fullest disk, log delay, open alerts and delayed devices as under 30 / 30 to 60 / over 60 minutes), Alerts (open alerts, critical first, with who acknowledged them; *All clear* when none), Cluster spotlight (clusters with a critical problem join by themselves and leave 10 minutes after it clears; nodes, heap, disk, lifecycle and the volume chart cycling 7, 15 and 30 days), Log delay (top 10 devices and top 10 clusters), Backups (backed up in 26 h, snapshot failures in 24 h, last good snapshot and backup size per cluster) and Volume and capacity (yesterday against the 7-day average, month so far, days of disk left). A slide with nothing to show is skipped.
- **On the wall.** Arrow keys or a TV remote change slide, Space pauses, + and - zoom from 80 % to 150 %. A newly opened critical alert takes the screen with a red bar until it is acknowledged or 5 minutes pass. The picture shifts a few pixels every 10 minutes against burn-in, and a figure older than twice its refresh turns its time amber. No scroll bar at 1080p or 4K.
- **Display links (hosted).** Config › Play › **New display link** makes one link per TV: a name, all clusters, a Zabbix host group or chosen clusters, the addresses it may be used from, and an expiry (permanent until revoked by default). The link is shown once; the server keeps only its hash. Opening it on the TV turns it into a session cookie the page cannot read, which may show Play and nothing else: every other message, any write and any Elasticsearch request other than the log-delay measurement itself is refused. **Replace link…** revokes a link and makes a new one with the same settings, the new address shown once. **Revoke** ends the TV's session at once, and the TV then says its link was not accepted. A display link keeps its five newest sessions, and one unused for a day ends. `UI_PLAY_ENABLED=false` turns display links off.
- **Config › Play.** Per display: slides and their order, how long each stays, whether a critical alert takes the screen, theme, sound and a fixed zoom (or the one the TV last set). For every display: the delay colours (green below 30 min, yellow up to 60, red over), how a node that left is shown, who joins the spotlight, and clusters left out of Play with a reason that is required. Each watch rule can be locked in config.txt (`UI_PLAY_*`) and then reads *managed by config.txt*.
- **Node-left tracking.** The server remembers the node names each cluster had in the last 24 hours (or a pinned list), from the node lists the fleet poller already fetches. A cluster with a node that left blinks on the Fleet wall every 3 seconds until the node is back or is forgotten on purpose (`PLAY_NODE_FORGET`). No new request is sent to a cluster.
- **One measurement for every TV.** The device-delay measurement runs only while a Play display is open, every 15 minutes per cluster, and is shared through the server so ten TVs measure once. A measurement the server refuses is kept on that screen, and the header says so.
- **Inside Zabbix.** The Zabbix modules get Play as a menu entry and dashboard widget in a separate modules patch release.

**Shared acknowledgements (hosted).** An acknowledgement and its notes are kept on the server (`ACK_LIST`, `ACK_SET`, `ACK_CLEAR`), so the person at the desk acknowledges and the wall lets go. The server records who acknowledged and when, and audits every change. Acknowledgements a browser kept before are not moved. Clearing old ones never rewrites a shared record and never acknowledges in another person's name: a record is removed only when its cluster has left the fleet, once every cluster has answered. The desktop app keeps them in the browser, as before.

**Cluster type: CI, DI or On-Prem, and ULM.** Every cluster is CI, DI or On-Prem, set in the Edit cluster dialog (hosted: one store on the server for every cluster, Zabbix ones too, seeded from the host tag `elasticpro:type`). CI and DI archive their logs to S3 through ULM and take no snapshots, so for them *SLM not running*, *no recent successful snapshot* and *newest snapshot is not recent* do not raise; a policy that exists and fails still does. The snapshot cell, the Snapshots page and the Play Backups slide read *ULM · s3 <bucket>*. A CI / DI / On-Prem badge sits beside each name on the Clusters page, with a Type filter. Only the bucket's name is kept; the archive itself is checked by the Zabbix log archive (S3) template.

**Log delay: exactly 60 minutes is yellow.** One rule for the Logs page and Play: green below 30 minutes, yellow from 30 up to and including 60, red only over 60. A device at exactly 60 minutes was red on one and yellow on the other.

**Security fix: display links need an administrator who sees every cluster.** A link can reach every cluster and a watch rule applies on every display, so creating, listing, changing or revoking display links, and changing Play settings, are refused to an administrator limited to some Zabbix host groups. `PLAY_CONFIG_GET` shows displays, links and host groups only to an administrator with no such limit, and the pinned node lists only of the clusters the caller sees.

## 0.3.46

**A new cluster that uses the default credential never asks for a password.** Hosted. The password was set for every cluster, yet each cluster added afterwards asked for one: the server kept a password for one cluster (handed over from Zabbix) but no default, so a new cluster had nothing to fall back to.

- **Make a kept credential the default.** Config → Credentials says *No default credential* and offers *Use Local-ES-Cluster's credential (user zabbix) as the default for every cluster without its own* — one button per kept entry, or a choice when there are several. The server copies it; nobody types the password again. New admin-only message `CREDENTIAL_PROMOTE {from, replace?}`; `CREDENTIAL_STATUS` lists the candidates as `promotable` while there is no default. An existing default is never replaced without `replace`. Audited (who, from which entry; never the secret).
- **Add/Edit cluster: one Credential choice.** *Default credential (user …)* is preselected for a new cluster and asks for nothing; *Its own credential* has the username and password fields. With no default yet the Default choice reads *none set yet* and sets it there once (typed, or from a kept entry). Switching an existing cluster from its own credential to the default asks first, then forgets its own. The portable build has the same choice: *Default* is the config file's `credentials:` block (or the one typed this session) and asks for no password and no master password.
- **No sign-in prompt for a covered cluster.** PRIME answers `defaultCredential: true|false`; the page takes every cluster the default covers off its list, so no *Sign in (N clusters)* button and no startup prompt. With a default kept, the sign-in dialog shows no form for such clusters and says it is using the default. PRIME also falls back to the message's shared credential for a config cluster with nothing kept, as `CLUSTER_SAVE` already did.
- **The default is never replaced by accident.** The sign-in dialog replaced the default every time it was used on the hosted build. It now does so only with **Replace the default credential** ticked (off by default); unticked, what is typed becomes the listed clusters' own.
- **Rejected by one cluster.** A cluster that answers 401/403 to the default is named — *The default credential was rejected by …* — with **Set its own credential…** (a Zabbix cluster: Cluster Management → Change password), in the dialog and on Config → Credentials, rather than a generic sign-in form.
- **Operators.** A cluster an operator adds with no default set saves, and the page says *No default credential is set; an admin sets it in Config → Credentials*.
- **Zabbix clusters.** Unchanged rule: the default applies unless the host carries its own password macro. Setting, promoting or clearing the default now starts a Zabbix sync, so a Zabbix cluster held back as *password not set* is polled with it within seconds.
- **Nothing typed becomes the default by the back door.** On the hosted build the page no longer holds a typed credential, and a PRIME carries no typed one as the shared credential (only a `credentials:` block still in the config file, for its one-time move to the server); the sign-in dialog keeps what it is given on the server and reconnects. The core makes a default only on CREDENTIAL_SET or CREDENTIAL_PROMOTE once an admin has forgotten one: **Forget** leaves a mark (who, when; kept on disk, lifted by the next explicit default) that stops a page's shared credential from being kept or used as the default again.
- **The Add dialog sets the default once.** It sends CREDENTIAL_SET `*` with the new `onlyIfAbsent` (the core answers `exists` and replaces nothing) and treats PROMOTE's `exists` as "already set, continue" — a default somebody set while the dialog was open is used, not overwritten. A config save that fails after the default was set says the default **was** set, and pressing again saves the cluster without setting it twice (the failed entry is no longer left in the list, which made the retry fail with "another cluster already has that name"). Switching a cluster to the default asks for confirmation only once the rest of the form is valid.
- **The sign-in dialog lists what it acts on.** With a default kept and not being replaced, it lists — and counts on its button — exactly the clusters the typed credential is kept for.
- **Anonymous clusters.** A cluster connected with *Continue without credentials* opens on a third choice, *No credential (connected anonymously)*. Choosing the default or its own credential withdraws that decision: the next PRIME carries `dropAnonymous: [id]` and the core stops keeping "none, on purpose" for it.
- **Covered, then not.** When the core stops covering clusters (the default forgotten), the page puts back "needs a credential" for the clusters it had marked as signed in by the server and the core no longer holds.
- **A held credential follows only its own destination** (since 0.3.42). A PRIME that kept a cluster's address but changed its route or certificate setting reused the header held before, so a cluster's own credential — bound to address, route and certificate setting — went to a destination nobody gave it to. The held header now carries on only when all three are unchanged; otherwise the credential is resolved again (its own at the new destination, then the default).

## 0.3.45

**Index volume is kept per day and per month for 13 months; reports run as jobs and can be mailed.** Hosted ElasticPro now measures each cluster's log indices once a day and keeps the figures, so the Summary page can show how much arrives each day and each month, and a volume report can be generated or mailed without asking the clusters again. A figure the cluster could not give is shown as *not measured*, never as 0.

- **A daily record per cluster.** Hosted, once a day at 06:00 server time (`UI_VOLUME_COLLECT_AT`), and at once when someone presses **Refresh now** (at most once a minute per cluster). The indices counted are those whose name fits `logstash-*-YYYY.MM.DD` (`UI_VOLUME_INDEX_FORMAT`). A day is the date in the index name, so no time zone or timestamp is involved; today is collected too and shown "as of HH:MM" until it is over. Per day: primary and total size, indices, documents, event bytes, sub size, and the top values of each field. Kept 13 months (`UI_VOLUME_KEEP_MONTHS`). A size the cluster cannot report is *not measured*; a size per value is an estimate and always labelled **est.**
- **Config › Volume fields.** Sets which fields the record reads: tag, forwarder, source host, source IP, event size, sub size and an extra name. Each row is a list tried left to right with ECS fallbacks (`host.name`, `source.ip`, `observer.name` and so on), and **Check against a cluster** shows which field each row resolved to and which indices were skipped. Per-cluster overrides sit beside the defaults. A row set in config.txt is locked and says "managed by config.txt". Older `volumeFields` settings are still read and converted on the first save.
- **Indices › Summary, Daily.** Line graph with cards (yesterday, average per day over a window of 3 to 180 days, this month so far, 30-day event bytes), a totals row, and each day's change against the average. Columns can be reordered, hidden and renamed; the layout is kept on the server, so everyone sees the same one (set by an operator or admin). Everything exports as CSV.
- **Indices › Summary, Monthly.** Line graph with a dashed average-per-month line, the month table with its own columns, and a breakdown by field: documents, event bytes and estimated primary size per value over a period, with "(not set)" and "all others" rows. The Volume report's Monthly view shows every cluster by month on one page.
- **Report jobs.** Generate report queues one job per cluster as an .xlsx or a .csv zip, with a preset period (this month so far, an earlier month, yesterday, last 7 days). 3 to 5 jobs run at once (default 3, set by an admin); the rest wait in order. Stop and Stop all are an admin's. A pill in the top bar shows running and queued jobs, and finished files download from the list.
- **Mail.** Config › Volume fields gets a mail server (SMTP) and a volume report by mail: monthly, weekly, daily or manual, to the schedule's addresses, with one .xlsx holding a set of sheets per cluster and a short body (yesterday, the 7-day average, the month so far). The SMTP password is encrypted at rest and goes only to the server it was typed for; changing the host, port, security or user without typing it again stops mail until it is typed. Settings come from `UI_SMTP_HOST`, `UI_SMTP_PORT`, `UI_SMTP_SECURITY`, `UI_SMTP_USER`, `UI_SMTP_PASSWORD_FILE` (read at send time, never shown) and `UI_SMTP_FROM`; the schedule from `UI_REPORT_TO`, `UI_REPORT_SCHEDULE`, `UI_REPORT_AT` and `UI_REPORT_SHEETS`.
- **Review fixes worth naming.** A config file that cannot be read collects nothing and fails the report job with its error; it never falls back to built-in fields. The emergency stop fails a report job that would have to collect, and the daily run gives its day back so the first tick after the stop runs it. Every mailed send is recorded as the schedule's last send, failed and restart-cut ones included. Mailed periods are UTC dates, so a report never goes out before its last day is over.
- **Deploy.** The image carries tzdata and the compose file passes `TZ` (default `UTC`), so the 06:00 collection runs on the server's clock. Set `TZ` in `.env`, for example `Asia/Kolkata`.

## 0.3.44

**Requests are handled on their own; nobody waits more than 10 seconds; the pause is gone.** 0.3.43 made a pause visible, but a pause is still something a person has to remember to start and to lift. Now ElasticPro takes care of slow and busy clusters by itself, and the only manual control left is an emergency stop that always ends:

- **10 seconds at most.** The server holds a page's request open for 10 s, no longer (it was 20), and pages ask for 10 s. Past that the page shows what the cache holds, with its age, and says the answer "did not arrive within 10 s — ElasticPro keeps asking"; the fetch carries on and lands by itself.
- **A slow cluster is slowed down automatically.** One request over 8 s, a timeout or a 429 marks the cluster *slowed*: one request to it at a time, its background intervals doubled per occurrence (2×, 4×, … up to 10 minutes), and a page that already has a copy gets it at once instead of waiting. Three quick answers in a row put it back to normal. Logged when it starts and ends.
- **A busy server puts people first.** When the request queue is half full or somebody has waited 5 s for a slot, background polling holds and only what a person asked for goes out; it starts again by itself once the queue has drained.
- **Request Centre shows it.** The Per cluster table has an **Automation** column: normal, *slowed since 14:02* (why, in the tooltip), *held: backing off*, *held: budget* or *held: server busy*. `REQUEST_LOG` carries `slowed` and `busySince`; `FLEET_STATE` carries `automation` and a per-cluster `slowed`; `CLUSTER_DATASET` says `slowed` when it gave the held copy.
- **Emergency stop instead of pause.** Request Centre offers *Stop for 15 / 30 / 60 min*, each asking first; it lifts itself at the end (the server clears it from `policy.json`), and an admin can end it sooner from the card or the top bar, which says "Emergency stop until 14:30". The per-cluster pause and the pause boxes in Config → Requests are gone; that page now says what happens on its own. A pause with no end — what 0.3.43 and earlier wrote, like the one that held the test site since 25 Oct — is dropped when the server reads the file. A form saved after a stop ended does not start it again (the page sends back the `since` of the stop it was shown). The Zabbix push's `paused_clusters` is now always 0, and `paused_all` is 1 only while a stop holds.

**ILM and SLM say "Running" in green only when they look after the log indices.** Everywhere the status shows — the Clusters columns and tiles, the Snapshots page, the CSV — the pill reads **Running** or **Stopped** (capitalised) and is:

- green when ILM runs and *every open* index matching the cluster's log pattern (`logstash-*` unless set) has an ILM policy; for SLM, when it runs and at least one scheduled policy takes those indices (none named, `*`, or a matching pattern);
- red when it is stopped, or runs without covering them — the tooltip names the indices with no policy ("2 of 3 open logstash-* indices have no ILM policy: …") or the SLM policies that take other indices;
- grey "Running ?" when what it covers could not be read, naming the privilege that would fix it (`view_index_metadata`, or `manage_slm` / `read_slm`). Unknown is not shown as good.

The CSV gains *covers log indices* (yes / no / empty when not known) for ILM and SLM. The ILM settings read now asks for each index's uuid too (`filter_path=*.settings.index.lifecycle.name,*.settings.index.uuid`), so an index with no policy is listed instead of filtered away; on a core older than this the ILM pill stays grey. Closed indices are not counted.

**Clusters: the opened row stands apart.** The row you open is tinted with a blue edge, and its details sit on their own background with boxed tiles and flat cards under a dividing line, so they no longer read as more cluster rows.

## 0.3.43

**A pause says so, on every page, and asks before it starts.** "Pause all requests" stops the server fetching anything new, and a pause nobody remembered held the test site still for three days: every page kept its old data and looked normal, and Indices sat on "Fetching…" with no rows, because the server held a page's request open until the pause was lifted and the only sign of a pause was a pill in the status strip, which the Clusters page and the evidence pages hide. Now:

- The top bar shows **Requests paused** on every page while everything (or the cluster on screen) is paused. An admin's is a button that resumes after one confirmation; anybody else's tooltip says who can.
- The server answers a page's request for a paused cluster at once, with since when and by whom, instead of holding it open. The ask is kept and runs when the pause is lifted. Indices and Nodes & shards show "Requests are paused since 25 Oct 2026, 06:38, by Admin@zabbix…" instead of "Fetching…" or an error, and ask again by themselves once resumed.
- The server records who began a pause and when (`paused.since`, `paused.by` in `policy.json`; `pausedSince`, `pausedBy` in FLEET_STATE). A pause from before 0.3.43 has no stamp and is shown without one.
- "Pause all requests", in the Request Centre or in Config → Requests, asks first. Pausing one cluster and resuming do not.

## 0.3.42

**Credentials are typed once and kept encrypted on the server; nobody is asked on a page load.** Hosted build. Every cluster's credential is now the server's to keep: its own, typed in the cluster's Edit dialog when it is added or its credential changes, else the **default credential** an admin sets once (Config → Credentials → Set default credential…), which every cluster without its own uses — the same default Zabbix hands over for clusters whose password is not on their host. They are kept in `cluster-secrets.json` (AES-256-GCM under the server's key, 0600), never in the config file, never in `primed.json` (which held them in the clear until now), and never sent back to a browser; the core resolves every cluster's credential itself, so no page load, no other user and no restart needs one typed again. A credential an admin's browser still carries — from the config file, plain or sealed with a master password and unlocked once, or typed this session — is moved to the server the first time the core sees it, and a `primed.json` from an earlier release is converted at start. New admin-only messages `CREDENTIAL_STATUS`, `CREDENTIAL_SET` and `CREDENTIAL_CLEAR`; the Config page's Credentials card says which username is kept for the default and for which clusters, by whom and when. A cluster's own credential is bound to its destination (address, route, certificate setting) and used only there: an entry left behind by a removed cluster cannot follow its name to another address, and an operator cannot move a cluster whose own credential the server keeps (as with one in the file). An admin who moves a cluster deliberately keeps its credential with one confirmation; renaming moves it with the cluster. The portable build is unchanged: its credentials stay in the config file, sealed with the master password.

**The cluster chooser is on Snapshots, REST console and Indices, and picks a cluster for you.** These evidence pages hid the chooser behind the cluster's health pill and, from "All clusters", asked you to choose; now the chooser is there (single clusters only, no "All clusters", no find box) and arriving picks the cluster last chosen in this browser, else the first. Going back to a fleet page restores "All clusters". The chooser's list highlights the cluster under the pointer or keyboard in blue and marks the selected one (Chromium-based browsers; others keep their native list).

**Snapshots opens on its repositories and policies.** The page now starts with a Repositories table — type, snapshot count, newest snapshot, the data span it holds and the SLM policies writing to it — and the Policies (SLM) table; opening a repository shows its snapshots, with every action the list had and a way back. No repository location is shown (the evidence rule of 0.3.23).

**ILM and SLM on the Clusters page are buttons again, with a red dot for errors.** As in 0.3.2: a pill with the operation mode, green when running; a red dot beside it when something is in error, the names in its tooltip, no count. Errors now count only what matters for logs: indices matching the cluster's log index pattern (`logstash-*` unless set) in the ILM ERROR step while ILM runs, and scheduled SLM policies covering those indices whose last run failed while SLM runs. The CSV export and the ILM alert use the same definition.

## 0.3.41

**Ships Zabbix modules 2.1.14: the role map can list the site's Zabbix roles; an operator is offered no removal in Cluster Management.** The Accounts page's role map (0.3.40) lists Zabbix's roles by name by asking Zabbix `role.get` with the token the pairing made — a method the modules' `sync-role.json` never allowed, so every paired site saw *"Zabbix role.get: No permissions to call role.get"* beside the map and could map by user type only. Modules 2.1.14 put `role.get` in the allow-list; a site paired before it gets the method by pairing again (the pairing updates an existing role) or by adding `role.get` to the **ElasticPro sync** role's API methods by hand — the card's note now says so when that is the error. In Cluster Management an ElasticPro operator was still offered **Remove only in ElasticPro…**, which the server refused them; the button, the Delete for good and Remove dialogs, and the links to Discover are an admin's alone on the page too. Found on the test VM while verifying 0.3.40; nothing in the core changed.

## 0.3.40

**Operators run the fleet: add, change and switch off clusters; a role map decides what a Zabbix sign-in becomes.** Core (this change): a new message, `CLUSTER_SAVE`, open to the operator role, adds one cluster to the server's config file, changes one, or switches one off — and nothing else. It refuses a removal (there is none), any credential (a username, password, API key, token, sealed value or `user:pass@` in the URL is refused outright, never dropped), a jump host the file does not have, and anything outside the one entry; the credential already on an entry stays exactly as it was, since the operator never saw it. The saved cluster is polled right away: with the credential the core already held for it at the same address, or with the shared credential when it has none of its own — the one an admin set for every cluster, which operators use and cannot see or change; the reply says which. A cluster that signs in with a credential of its own keeps its address: an operator changes everything else about it, an administrator moves it (the next admin sign-in would otherwise send that credential wherever the entry pointed). A name that is another cluster's id in a different spelling ("alpha" beside "Alpha") is refused, so no add can take over another cluster's polled entry. The version before each save is kept in the config history. `AUTOMATIONS_SAVE` is the same door for the automations list, so an operator's rules save instead of being refused. Zabbix sign-ins now go through a role map (`zabbix.roleMap` in the server's config, `ZABBIX_ROLEMAP_GET`/`SET`, admin only): by the Zabbix role's name when the embed module sends it (modules 2.1.13), else by user type, with the shipped mapping (User → user, Admin → operator, Super admin → admin) as the default; a role mapped to none is not signed in, and an account an admin pinned keeps its pin. The role lookup Cluster Management asks answers with the mapped role. UI: on the Clusters page an operator gets Edit in a cluster's name menu and "+ Add cluster" among the table's tools; the dialog is the admin's without Remove and without the credential block, which it replaces with "Credential: managed by an administrator", and saves through the core. The Automation page's New, Edit and × save for an operator instead of being refused. The Accounts page (admin) gains the Zabbix role map: the three Zabbix user types and every Zabbix role by name (listed from Zabbix when its API is paired, typed otherwise), each with what it becomes here, with the shipped mapping shown beside; a Zabbix account's role note now points at it. The Config page is unchanged and stays an admin's: removing a cluster, its credential, jump hosts, defaults. Ships Zabbix modules **2.1.13**: in Cluster Management an ElasticPro operator adds, edits, clones, disables, enables and sets maintenance on clients (Decommission, Restore, Delete for good, Discover, Import, Roles, Settings and the master template stay an admin's), and both the sign-in and the role question name the Zabbix role, so the role map can map a site's own Zabbix role. Note for the people who grant the operator role: an operator who can add a cluster can point the shared credential at an address of their choosing; that is what the role is for, and the audit log records every save.

## 0.3.39

**Snapshots, REST console and Indices lose the evidence stamp.** The amber "Data from … (35 h old). Refresh before capturing." banner above the page and the footer "Cluster: … · Snapshot data read … · Captured … · ElasticPro … · Signed in as …" under it are gone, at the user's request. The rest of the single-client layout stays as it was: these pages still show one cluster and nothing about the rest of the fleet, no address, and fleet notices wait in the bell until you leave. How old the data is remains on the Refresh button's minutes badge and on each list's own freshness line. Nothing in the core changed.

## 0.3.38

**Clusters: the disk cell no longer runs into ILM and SLM.** From the low watermark on, the cell adds "above low watermark" or "above high watermark" to the figure, and with the data-node count that line was wider than the column: on a full cluster the words ran over the two columns beside it. The figure ("91 % · 339 of 373 GB") now stands alone on the first line and the watermark note with the node count sits under it in smaller type, so the cell grows down, never sideways; whatever is still too long is cut with an ellipsis inside the cell. The same text as before, the same colours, the whole explanation still on hover. Nothing in the core changed.

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
