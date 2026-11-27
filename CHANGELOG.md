# Changelog

## 0.3.101

- **The theme switch is Light and Dark only.** The footer button switches between Light (sun) and Dark (moon); System, its third step, is gone, and Your settings no longer lists it (Light, Dark, Dark blue and Warm remain). Someone who never chose a theme, or chose System before, sees the computer's light or dark as it is when the page loads, shown on the button as that theme; nothing is saved for them until they press one. Inside Zabbix the theme still follows the Zabbix user's.

## 0.3.100

- **Indices › Documents opens on Custom, with no dates: every document in the indices, newest first.** It opened on the last 24 hours (or the range last picked, kept in the browser), so a daily index from an earlier day showed "No documents match". 15m, 1h, 24h and 7d are still there; one picked holds for that view only and is not carried to the next index.
- When nothing matches, the note says what narrowed the search: a custom range is named with its dates ("between … and …"). It said "The indices matched hold no documents" whenever no query was typed, also when custom dates had left everything out. With no time range (Custom without dates) it says only "clear the query", and a field's values say "No values", not "No values in this range". Pressing Custom with no dates searches at once, so a preset's result is never left on screen under it.

## 0.3.99

- **Dialogs fit a phone.** Every dialog was 96 % of the screen wide inside a 20 px margin, so on a phone its right edge ran about 20 px past the screen (seen on the log availability map at 390 px). A dialog now takes the space inside the margin, up to its usual width. Measured in Chromium and WebKit: every dialog width the app uses fits at 390 px, and from 1040 px wide every dialog is exactly as wide as before; in a narrower window a dialog wider than the window keeps its 20 px margin (at 1024 px with a classic scrollbar the widest, 980 px, is 969 px). `tools/fit-check.mjs --sizes 390 --only dialogs` measures every dialog at phone width.

## 0.3.98

- **Log availability map.** A small ▦ button on the Clusters page's expanded row (Snapshot repositories), the Overview (SLM card) and Reports › Capacity & retention (beside the cluster name) opens a map with one cell per day, from the oldest day any index or snapshot names to today: **green** a live index carries the day (also when a snapshot holds it), **blue** only in successful snapshots, **red** only in partial snapshots, **grey** neither live nor backed up. Hover or tap a day for what is there; the hover names both live and backup. Where not every snapshot could be read (a cut listing, the light listing, a repository not read, snapshots switched off, ULM on: its S3 archive is not seen here), days with no live index are hatched *not known*, never grey, and the reason is listed. Long empty stretches fold into one line ("2025-06 → 2026-09 · no live index and no backup · 487 days"). Live retention and the backed-up range above the map are the Capacity figures.
- **A long gap at the new end is flagged.** The map says how many days since the newest live index ("No live index for 24 days (newest 2026-11-02)"); past 7 days the button turns amber with that text, wherever it is shown. Live retention still counts to today, as before.

## 0.3.97

- **Retention counts from when the logs are really there.** Five stray indices dated 2025-05-03, then nothing until 2026-10-01, made Capacity say live logs "from 2025-05-03 to today". Now a range starts at the run of days that reaches the newest: going back from the newest day, a gap of more than 7 days with no index ends it. Live retention (Capacity), the Volume sheet's oldest index day and days held, each snapshot's *Data inside covers*, the repository span and the oldest index day backed up all start there. Older days are named, never dropped: "+1 older day left out", and "5 indices on 1 older day (2025-05-03) left out: 515 days with no index before 2026-10-01" in the tooltip and the snapshot evidence. New Volume sheet rows *Older index days left out* and *Older backed-up days left out*; snapshot CSV columns `data_left_out_days`, `data_left_out`. A snapshot still holds the older days and can restore them.
- The walk back starts at the newest day **up to today**: one index dated ahead (a device with a wrong clock) no longer becomes the run and pushes the real days out. Days ahead still stretch a snapshot's range forward, as before; they are not live retention.
- The Storage plan CSV gets *Live retention from* and *Live retention older days left out* beside *Live retention (days)*, in the same words as the cell. When the current run is only today (not a whole day yet), the Volume sheet still names the left-out days instead of saying "no dated indices".
- **History store, `capacity`:** `liveRetentionOldestDay` follows the same rule, and `liveRetentionHeldDays` counts both ends as the Capacity page does (it was one day fewer).
- The Repositories view and the Volume sheet now take the backup range from one function (`restorableRange`); they had separate copies of it.

## 0.3.96

- **Disk alerts: High at 80 %, Critical at 90 %, no Warning line** (the fullest data node, as before; alerts, mail and Play). Shipped in 0.3.94: Warning 85, High 90, Critical 95. A Warning line can still be set (`UI_DISK_WARN_PERCENT`, Config › Defaults, Alert triggers); its field may now be left empty for none. Levels already saved stay as they are: a config that saved Warning 80 / Critical 90 (the defaults before 0.3.94) now reads High 80 / Critical 90, since High is checked before a Warning at the same line. Play's Fleet lists disks from 80 %; Volume's white line is the lowest line set.

## 0.3.95

- **Play, Fleet: a card no longer says "delay not read" beside an open log delay alert.** Where the scheduled log delay measurement does not cover a cluster, its card shows the devices from the reading the alert rests on, with when it was checked ("34 on time · 4 late · checked 23:26"); a run of the server's counts only the late devices, and then the card says so ("4 late of 40 · checked 23:26"), with no on-time figure.
- **Play, since when: a log delay problem's time is known only while its measurement is current.** A measurement that had stopped (failed, or not run for hours) still counted as watched, so a problem found by the next one could say "1 min" though it may have opened during the gap. Now a reading out of date is a break, as for every other dataset. A break of up to 3 minutes is not one (the server's own rule): a measurement due at the end of its interval no longer makes every problem it finds "not known".
- **Play, Log delay: "Other time zone, not late"** takes a second line instead of being cut, and is grey as on Fleet; the device donuts of both pages have one definition.

## 0.3.94

- **Play, drawn again: four pages** (Fleet, Log delay, Backups, Volume and capacity), light colours only, nothing blinks. The pages Alerts and Cluster spotlight are gone; the main menu's Alerts page is unchanged. docs/PLAY.md.
  - *Fleet*: clusters with a Critical or High problem, open Critical and High alerts, devices by log delay and the five fullest disks; then each problem with what it is, why it matters and since when. One layout for any number of clusters. A new Critical brings Fleet to the screen.
  - *Log delay*: one graph, the devices still late in each 12 hours of the last 7 days; devices now; the most delayed clusters of each period; every cluster. From the scheduled measurement's record (`LOGDELAY_BOARD`). Part delayed devices count as on time on this page only.
  - *Backups*: a donut of the clusters by backup state, 14 days, age of the last good backup. *Volume and capacity*: logs per day with the 7-day average, the change per day, the biggest changes per cluster, who sends most, the fullest clusters. "Days until full" is gone.
  - What is not read, not measured, not final or not known says so.
- **Since when a problem is open** is kept on the server, one time for every display and browser, at its level (a High that becomes Critical opens again); a time nobody saw start is "not known". A problem that clears is closed by itself; acknowledging or silencing one does not restart its time.
- **Disk levels are one rule everywhere** (alerts, mail, Play): Warning 85 %, **High 90 %**, Critical 95 % of the fullest data node. Shipped until now: Warning 80, Critical 90, against the cluster's average in the alert. New `UI_DISK_HIGH_PERCENT` / `diskHighPercent`. Levels set in config.txt or the clusters file stay as they are. A Warning kept above the new High, or a Critical below it, leaves no High level.
- **Retired settings**: `UI_PLAY_NODE_BLINK`, `UI_PLAY_SPOTLIGHT_WHEN`, `UI_PLAY_SPOTLIGHT_LEAVE_MIN`, `UI_PLAY_SPOTLIGHT_SECONDS`. A config.txt that still has them loads, with a warning; saved displays load without the two pages.

## 0.3.93

- **Zabbix gets the figures of the release that runs.** `deploy.sh --upgrade` moved the images and left the code the Zabbix scrapers run (`ui/`, `tools/`) at the release the install was first made from: alerts, client plan and log delay in Zabbix kept that release's definitions, and items added since (part delayed) never arrived. The core image now carries that code; an upgrade with a scraper in the stack puts it in `deploy/scraper/<version>/` and points `ELASTICPRO_UI_DIR` and `ELASTICPRO_TOOLS_DIR` there, also when the images are already current; `--rollback` goes back. A folder named in those keys by hand is left alone, with a note. `deploy/zabbix/README.md`, *Upgrading*.
- **Zabbix modules 2.1.21**: templates, master template, menu and widgets brought up to 0.3.92 (part delayed, log types late; Log Delay, Reports and Jobs in the Zabbix menu). After the upgrade: import the three templates again (log delay, alerts, client plan) and press **Write master template** once.

## 0.3.92

- **Log Delay: one log type's delay graph, per device.** A log type in *By log type* opens its own board: delay over time with a line per device (worst six, the rest to choose from the worst 40), every device that sends it (state, delay now, event and arrival time, delays, time late, last delay) and a CSV. The figures are the device page's own. A log type's measurements are kept 8 days; what is older is not drawn and it says so. `LOGDELAY_LOGTYPE`.
- **Log Delay: the device list beside a device's board fits its panel**: *Delay now* was cut off by the row's buttons, which the board itself has.
- **Reports: Collect now pressed right after a run finished** says it was collected less than a minute ago; the finished run's note hid that.
- Releases: the core image is built while CI tests the same source, and the tag publishes that image (docker.yml compiles it only when there is none for exactly that source). No change to what is in it.

## 0.3.91

- **Log delay: time late is only the time it was measured.** Between two late measurements with nothing measured between them (no run, the device silent) the hours were counted as late: lists, the log types, the day by day totals and the files. Now only the stretches measured count, as the percentage beside it already did. The red shading and the graph's lines stop where nothing was measured. A delay older than the measurements kept in memory (31 days, 8 for one log type) is counted from start to end and says "about". Late hours of days stored before the upgrade keep their figures. A delay still lasts from its start to its end, with how much of that was measured beside it ("10 h 17 min · 2 h 48 min measured").
- **Log delay: a window in which no device sent logs is not measured**, not "0 late".
- **Log delay: "Longest delay" of a delay that ended unsolved** gives its end and why, not "still late".
- *Every delay* and the devices list fit without a sideways scroll ("Looks like" only where a delay has a pattern).

## 0.3.90

- **Log delay per log type.** Each device's log types (`log_type`, the same field on every cluster; no setting) are measured on their own in the same query as the device: own delay, level, delay periods. A device with only some log types late is **part delayed**, not delayed: its own count and percentage beside No delay, 30–60, above 60 and other time zone (they add up to 100). A device is delayed only when every log type measured in the run is late. A cluster without `log_type` in its mapping works as before and says so.
  - *Device page*: one line per log type in the graph (worst six, the rest to choose), every type's delay in the tooltip, and a table of the device's log types (now, delay, event time, arrived, logs, delays, time late, last delay started → solved). The headline says it: "1 of 3 log types late: threat". Delays from before the upgrade are labelled "before log types were measured".
  - *Lists, cluster page, Summary, Dashboard, Live*: state "part delayed", column LOG TYPES, filter chip, search by log type, the card *By log type*, the tile PART DELAYED.
  - *Files and mail*: a Log types sheet, part delayed in totals and day by day, a `log_type` column. *Alerts*: part delayed is a warning. *Zabbix*: new items `elasticpro.delay[part_delayed]`, `[log_types_late]`, `[worst_log_type]`; `late`, `delayed` and `critical` now count fully late devices only. Import the regenerated log delay template.
  - Limits, always said where they apply: 20 log types read per device, 150,000 per cluster and run (a device past it keeps its last read state, marked, and the next run starts there); a type name over 256 bytes is cut and marked. Points per log type are kept 8 days in memory, the rest in the day files.
  - A cluster that maps `log_type` differently across its indices, or refuses the search by log types, is measured without them and says why. Play measures without log types, so it no longer replaces the server's reading in Alerts where the server has them.
  - On an installation with a history store, the new fields are stored from this release on but are searchable only after the delay index template is replaced by hand (ElasticPro never replaces a template that exists).
- **Going back to 0.3.89**: it cannot read the log delay record of a cluster with a part delayed device. It shows that cluster as never measured and starts a new record at its next run: its earlier delay periods and device graphs are gone from the pages (the daily totals and the day files stay). `deploy.sh` backs up the compose file, not the data: to be able to go back, copy the `core-data` volume before the upgrade.
- **Alerts: log delay from the scheduled measurement.** The alert existed only in a browser that had opened *Live* or Play; the page and its CSV could say nothing while devices were late. It now comes from the server's last run too ("as of last run 21:50"); the newer of the two counts.
- **Reports › Monthly and Breakdown: finished days only.** The Monthly table, its CSV and the current month's breakdown still counted today's part of a day, against Overview, Daily and the files. One rule now; the current month is not offered for a breakdown on the 1st.
- **A size in GB is never 0 when there is one.** The Storage plan, Every parameter, Client plan, Overview and Measure size files rounded to 0.1 or 0.01 GB: 13.4 MB a day read 0. Below 1 GB they now carry three significant digits.
- **Play** says "median delay" on a cluster's tile; **Clusters › Overview** says what ILM counted ("0 of 9 open log indices managed"); a snapshot alert's time names its zone.
- The history store takes documents with names longer than Elasticsearch's 512-byte id, and one rejected document no longer stops the others.

## 0.3.89

Every page and file was compared with raw Elasticsearch, because they are given to auditors. What was not known, not read, partial or not current now says so, on screen and in every file. Rule: the true figure; else "not measured" or "not read" with the reason; a partial figure says "N of M"; an old one says when it was read.

- **Colours: critical red, delayed yellow, on time green** everywhere (pages, charts, Play, mail, reports). Another time zone stays violet; silent and can't measure stay grey. The word is always written beside the colour.
- **Log delay: No delay = on time + silent + can't measure**, one definition, always with its split ("No delay 95 % · on time 89 % · silent 6 %"), and how many of the silent devices were late before they went silent. Percentages add up to 100; a cluster never measured, or whose last run failed, has none.
- **Log delay: a late device is never called another time zone.** A device's zone is kept once confirmed. A device in another zone that becomes late, or is exactly 30 or 60 minutes late, was counted on time or "other time zone"; it is now late. A steady new offset becomes the device's zone after 12 runs, and its delay ends as "time zone changed", never "solved". A clock ahead is can't measure, not on time.
- **Log delay: a delay is only as long as it was measured.** An open delay counts to the last measurement ("late when last measured 14:00, not measured since"). Each event time names the field it came from. A cluster never measured draws no zero line. *Live* past its device cap, or with failed shards, calls no device silent.
- **Snapshots: only what can be restored counts as backed up.** Data span, "Data inside covers", availability and the evidence files leave out FAILED and IN PROGRESS snapshots and the failed indices of PARTIAL ones, and say the days missing inside a span ("15 → 22 Nov · 4 of 8 days"; CSV `data_missing_days`, `data_note`). A repository that could not be read says so, never 0 snapshots. A list cut at 500 says "newest 500 of N".
- **Backups (SLM): green only when every policy that takes log indices succeeded last**; a policy that takes part of the log pattern says "part of".
- **Indices: a red or closed index has no document count or size**, not 0; totals say how many are not counted, and that hidden indices are left out. A cluster that cannot be reached says "not read".
- **Reports: a day is final 24 hours after it ended** (was: minutes after UTC midnight), and is read again once it is. A month, a breakdown and "month so far" are the finished days of the period everywhere (page, mail, files), never today, and say how many were measured and how many are not final. Days already final before the upgrade keep their figures, with a note when they were read too soon; a held host day is never replaced by a shorter read. Closed, unreadable and deleted indices, documents without an event size, and filled ClientID/branch values are marked. A size is never rounded to 0 GB. Counts from a cut list are "approximate ±N".
- **Reports: every file has an About sheet** (about.csv in a zip): cluster, period, when it was read and built, by which version, and what is missing. The log delay report lists, per cluster, its last run, levels and devices read.
- **Reports: Overview and Planning** say "N of M clusters measured" where they said 0, use 1 GB = 1024³, and drop the 1 GB a day floor.
- **Percentages are never rounded to all or none** ("> 99.9 %" with one missing).
- **Query pressure after a node restart, Clusters CSV of an unreachable cluster, REST and Indices answers of another cluster, alert times**: not measured, left blank, dropped, and in one named zone.
- **The disk alert** says what was measured (shard data not in the index list) and claims no cause.
- **Fleet: the repository list is read for every snapshot fetch** (one light request more); a 502–504 from a proxy is not a reachable cluster. A backup without a readable configuration is failed and rotates nothing out.

CSV columns were added at the end of several files (docs/VOLUME.md, docs/REPORT-TYPES.md, docs/LOGDELAY.md); none was renamed or removed. The alerts and client-plan Zabbix templates were regenerated.

## 0.3.88

- **Clusters: a row opens again.** ▸, a click on the row, or its ILM or SLM button opens the cluster's details, as before 0.3.64: cluster health (with the red or yellow indices on hover), endpoint, jump host and log bucket; the Shard allocation, ILM, Backups and Activity cards; the snapshot repositories; the nodes. Columns ▾ again chooses the tiles, sections and columns of an open row and *Expand details by default*. *Overview →* on the name stays. A repository whose snapshots are switched off (Edit cluster › Collection) or not read yet says so instead of 0.
- **Clusters › List shows every cluster when it is opened**, whichever one is chosen for the other pages; that choice is back on the next page. A cluster picked in the top bar on the List narrows it, and is the choice from then on. A link to one cluster (Alerts, a Zabbix problem) lists them all with that row open and in view.

## 0.3.87

- **Nodes & shards: disk and dangling indices.** A new card shows the cluster's disk as one ring (index data, in use but **not** index data, free) and whether it has dangling indices: none, or each one's name, UUID, creation date and node, with the import and the delete prepared in REST. What Elasticsearch does not report reads "–" or "not known" with the reason (an account without the cluster privilege `manage`, a cluster before 7.9), never 0. Dangling indices are read when the page opens on one or two clusters, kept 10 minutes, and on the page's Refresh; with All clusters only on that cluster's Refresh. The disk alert "not accounted for by any index" sends here again: since 0.3.63 it named a check that no longer existed.

## 0.3.86

- **Log delay: the first run after a restart waits for the cluster list.** The timer ran within seconds of a start, before the clusters from Zabbix were read; it measured none of them, reported success, and the next run was an interval away, so every restart or upgrade lost one. The first run now waits until the list has been read (at most 10 minutes, then it measures what is known). docs/LOGDELAY.md.
- **Measure again: the period on every board.** On a never-measured cluster's own board the hover read "period not known yet" when no fleet summary had been read in the same visit; it now takes the interval from the answer on screen.

## 0.3.85

- **Log delay: clusters are measured together.** A run read its clusters one after another, so a slow one held up every cluster after it. It now reads several at once (the job's requests at once, 4 by default); a slow or failed cluster holds up no other, one cluster's read ends after 20 minutes with what it has, and every cluster still reads the same window. Results are kept one cluster at a time, as before. A disarm or the emergency stop during a scheduled run now also keeps out what was read but not yet kept.
- **Log delay: a cluster that could not be read is tried again 5 minutes after the run**, once, instead of at the next interval.
- **Log Delay: Measure again.** Where a cluster or a device is not measured, a ↻ button measures it now (the same job as *Fetch now*); its hover names the period it reads, "Measure now · last 1 h (20:24–21:24)".
- **Log Delay: never measured is not 0.** A cluster that was never measured shows "—, not measured yet" in its state tiles.
- **Log Delay: a device east of its cluster's time zone is another time zone.** A device in India (+05:30) or Nepal (+05:45) that writes its local time as UTC has its events ahead of their arrival; it was called "clock ahead" and counted as on time. It is now counted under *Other time zone* with its own zone (+05:30), after two runs in a row, as devices west of the cluster already were. An east device whose offset also exists in the west (+02:00) is now named east.
- **Reports › Daily & monthly: say what is counted.** The *Month so far* card and the Monthly table name how many days of the month are measured.

## 0.3.84

- **Log delay: clusters that come from Zabbix are measured.** The scheduled measurement (and *Run now*, and *Fetch now*) chose its clusters from those an administrator primed in ElasticPro and left out every cluster that comes from Zabbix, so those clusters were never measured, their Log Delay boards said "never measured", and the run still reported success with 0 measured. It now measures every cluster the server can reach, Zabbix hosts included, the same set the rest of the server works with; a sink cluster may be a Zabbix host too. One definition, `SinkConfig::targets` (docs/LOGDELAY.md).

## 0.3.83

- **▶ Play is back in the top bar.** Anyone who may open Play (every signed-in role but a guest) presses **▶ Play** in the top bar to open the wall display full screen, as before 0.3.63. Since then it opened only from Config-Management › Play, which only an administrator reaches. It is left off evidence pages (Snapshots, REST, Indices), which show one cluster, not the fleet. Config-Management › Play › **▶ Open Play** and display links are unchanged.
- **Reports › Daily & monthly and Volume by host: one cluster choice, the top bar's.** The second *Cluster* list inside these sections is gone. They show the cluster chosen in the top bar, and the top bar names it: on these sections it offers no "All clusters" and opens on the cluster last chosen (else the first). Before, with "All clusters" in the top bar, the section showed whichever cluster its own list held, often a different one from the top bar's, so the daily and monthly figures looked like the wrong cluster's. Overview's *Daily ›* on a row now chooses that cluster in the top bar.
- **Security: the `url` library moves to 2.5.9** (RUSTSEC-2026-0592, a stack overflow on nested `blob:` addresses).

## 0.3.82

- **Security: a fresh install no longer opens with a public password.** `deploy/deploy.sh` and `tools/install.sh` give a fresh install (no core container, no `core-data` volume, no password file) a random password for the first account, `Admin`, in `deploy/secrets/admin/initial_admin_password` — private from its first byte (0600 owned by the core when run as root, else 0640 with the install's group, which the core is given) — and print it once at the end, on the terminal only, never into captured output. Sign in, set your own on the Accounts page, delete the file. An install that has run before is never given one and an existing file is never replaced; `deploy.sh` removes a password the core did not use (it already had accounts), and `install.sh` shows the password only once the core says it used it, else names the file and what to do. On an upgrade nothing in this step can stop the upgrade (a `secrets/` owned by root, run as a normal user, used to); a fresh install whose `.env` has no `ELASTICPRO_GID` gets the installing user's group written there, as `install.sh` does, so the core can read the file, and a group the user is not in is a clear error instead of a core that exits 78. The compose file mounts `secrets/admin` read-only and points the core at the file when it exists. A core started with nothing configured (a plain `docker compose up`, the dev bridge) still makes `Admin`/`elastic` and warns on every start. deploy/README.md "First sign-in"; `tools/compose-upgrade-check.sh` section 9.
- **Security: an initial-password file that cannot be used stops the core.** When `ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE` is set and the core has no accounts yet, a file it cannot read, an empty one or one shorter than 10 characters makes no account and the core exits (code 78) with a message naming the setting and the fix — it no longer falls back to the shipped password the operator set the file to avoid. An install that already has accounts never reads the file.
- **Security: `X-Real-IP` is believed only from a trusted proxy.** The trusted proxies are the compose service `nginx`, looked up by name (again every 30 s and on a header from an address it does not know, since compose gives nginx a new address when it recreates it — no fixed network or address, so upgrades start as before), plus anything in `TRUSTED_PROXIES`. From anyone else the header is ignored and the connection's own address is the source: in the activity log, for `allowedSources`, a display link's `allowFrom` and the per-source rate limits. Before, an empty `TRUSTED_PROXIES` believed the header from any peer. The Zabbix frontend's calls are unaffected (it sends no `X-Real-IP`, and its requests are signed). **Upgrade note:** the shipped stack needs nothing; a proxy of your own that talks to the core directly instead of through nginx must be listed in `TRUSTED_PROXIES`, or every request looks like it came from that proxy. Existing `TRUSTED_PROXIES` values keep working. `X-Auth-User` is still believed only from `TRUSTED_PROXIES`. A lookup of `nginx` that times out or fails keeps the addresses last confirmed for at most 90 s (three refreshes; after that nobody is trusted by name until a lookup answers again, so an address nginx gave up is never trusted for ever), only the resolver's own "no such name" code clears them at once, and a request that arrives while a lookup runs waits for its answer, so users are not shown as nginx meanwhile.
- **Security: account, token and config files are written private from the first byte.** The accounts and API-token files, the applied cluster setup and the sessions file go through the one private writer the credential store already used (a temp file of its own, created 0600 before anything is written, synced, renamed; nothing left behind when a write fails). Saving the cluster config keeps the file's own mode (the hosted config is shared with the host user's group), set before the text goes in, and a failure to set it now fails the save instead of being ignored.
- **A session's "last seen" is not marked saved when the write failed.** On a disk error the in-memory mark is rolled back, so the next use tries again and idle expiry after a restart is not based on a file older than the core believed.
- **An alert acknowledgement or note the server did not take no longer looks saved.** Hosted, a refused or unanswered save marks the alert "not saved" with a Retry button (on the row, the held row and in the notes panel), keeps it shown even with acknowledged alerts hidden, and keeps it across a reload of the list until it is retried; "Note added" is shown only when the note was saved. Retry re-reads the server's copy and sends that with your unsaved note added (never twice) instead of the stale whole record, so acknowledgements and notes others made meanwhile are kept; when someone acknowledged it after your attempt, theirs stands and Retry says yours was dropped.
- **Sign-out that failed says so.** "Not signed out — try again", and the page is not reloaded as if it had worked.
- **A server that does not answer at start is shown as such.** "Server not answering · Retry" instead of opening the app as if no sign-in were needed.
- **Messages ending in `_PUT` count as changes** (`ALERT_EVENTS_PUT`, `NOTIFY_PUT`, `PLAY_SHARE_PUT`): after a 502/503 they are no longer sent again as if they were reads.
- **The UI checks fail instead of skipping without jsdom** when `CI` is set or `--require-jsdom` is passed (`render-check`, `behaviour-check`; `unit-check` stops early, naming the files that need it).
- **Log Delay: "Late devices over the day" replaces the Hourly Delay Status heat map.** One row per cluster — the name kept in view while the grid scrolls — with *Late now*, *vs yesterday* (▲ n / ▼ n / =, against yesterday's measurement of the same window), then one cell per measurement window of today (12 at the 2-hour interval) showing how many devices were late at that window's own measurement, and *Measured k/n* (of the windows that ended so far). A window that ended with no measurement is hatched "not measured": the heat map carried the previous reading into it, which is why whole rows looked the same. The window in progress with no reading yet is *pending* (light dots, with when the next measurement is due) and is not counted; from midnight until the first run, *Late now* is yesterday's last measurement, marked "yday". *Late (30+ min)* or *Above 60 min*; *Worst 10* or *All N*, worst first; each row shaded in one blue on its own scale (its worst window darkest), in light and dark themes. A cell opens that cluster with a line naming the window and its count. The core's windows now say whether they were measured and the late counts at that measurement (`measured`, `lateAt`, `criticalAt`), and each cluster carries yesterday's same window. docs/LOGDELAY.md "Late devices over the day".
- **Log Delay: the "How the last run read each cluster" card is gone.** In its place, only when the last run did not fully measure every cluster, one line: "4 of 71 clusters not measured in the last run", each with why (no index matches logstash-* · timed out (30 s) · part read (2 shards failed) · …), the fix where there is one ("set log index" opens the cluster's settings), and *Run details in Jobs ›*. It reads the same per-cluster results Jobs › run details keep, so the two never disagree, and names only the clusters you can see. An administrator limited to some clusters does not see the line at all: the run is fleet-wide and its details are not theirs to read. Nothing is shown when every cluster was read.
- **Jobs › Requests › Cost** (docs/JOBS.md "Query cost"): what ElasticPro's requests cost each cluster over the last 24 hours, per kind of work — each poller dataset, each job, pages and the REST console: requests per hour, average and p95 time, bytes, timeouts and deferrals, sortable, and the 10 most expensive recent requests (kind, cluster, path without its query values, time, bytes). Counted in memory from every request sent (the report worker's too); a cache hit or a shared answer costs the cluster nothing and is not counted; nothing is kept on disk. New `REQUEST_COST` (administrators; a limited administrator sees only their clusters). Read-only. On a busy day the report worker's ring (its last 5,000 requests) does not reach back 24 hours: the kinds it counts are then marked "partial — worker kept requests since HH:MM" rather than presented as the whole day. The book's 4,096-cell bound per hour is now hard across clusters too (one shared *Other kinds* overflow, read only by an administrator who sees every cluster), and the answer is built without copying the whole book.
- **Per-cluster switches: Edit cluster › Collection.** An administrator can turn off, for one cluster, the ILM checks, snapshots, the log delay measurement or the hosts collection, and set "heavy jobs only between HH and HH" (server time, the stack's TZ; a window may cross midnight, 22–06). A switched-off dataset or job never asks that cluster anything: the poller does not fetch it (a page's request for it is answered "switched off" at once), the jobs skip it, and Jobs shows "skipped — … switched off for this cluster (Edit cluster › Collection)" in amber, once a day — never as a failure. The hours are a hard rule for the heavy jobs (daily volume with its backfill, hosts collection): outside them nothing is sent, by the timer or by Run now; Jobs says "waits for 22:00: heavy jobs only 22:00–06:00 …", and a window that leaves out a job's usual time (00–06 or 22–06 with collection at 06:00) runs it once per window session, no sooner after UTC midnight than its usual time would — so a UTC day is never made final sooner after it ended than before (a run that cannot wait that long leaves that day not final for the next run). The scheduled log delay measurement keeps its interval. Pages say it is switched off and where: the Clusters page's ILM pill and snapshot cell read "Off", the Snapshots page's cluster block, the Log Delay page and Reports › Volume by host say so. Kept with the cluster's own config (the config file's `collection:`; for a cluster from Zabbix, the ElasticPro overlay), so it goes with an export, an import and a backup. docs/JOBS.md "Per-cluster switches".
- **Each cluster's quiet hours.** ElasticPro learns, per cluster, how quickly it answers the poller's light requests and how often it is busy, hour by hour of the day (a small 24-hour profile from successful answers only, kept in `<data>/job-runs/quiet.json` so a restart keeps it; a cluster missing from the list is forgotten only after a day). When the hosts collection finds a cluster busy for the second time in a day, it no longer tries again at a busy hour: it waits for that cluster's quietest hour, and Jobs says so ("waits for 03:00, this cluster's quietest hour"). A volume backfill paused for query pressure is tried again at the quietest hour instead of on the next day's run. Only hours the cluster's heavy-job window allows are chosen. Until a cluster's profile is known (about a day), everything behaves as before. docs/JOBS.md "Quiet hours".
- **The hosts collection no longer asks again what the daily volume run just read.** When both run for a cluster in the same morning (by default both from 06:00), the hosts collection uses the index list and field mapping the daily volume run read (within two hours, the same UTC day, and only when no index is split by time) instead of sending `_cat/indices` and `_field_caps` again; the daily volume run asks the hosts collection's wider field list so one answer serves both. Every figure and file is the same as before. The two heavy searches stay separate: the daily volume search and the hosts pages ask different questions (a top-N terms count and an exact per-host composite) and neither can be computed from the other without changing a figure. docs/VOLUME.md "Shared reads".

## 0.3.81

- **The daily jobs no longer start every cluster in the same minute.** The hosts collection started all clusters at `UI_REPORT_HOSTS_AT` (06:00) and retried them together, and the daily volume all of them at `collectAt`: production saw twelve clusters deferred or timed out between 08:03 and 08:11 UTC, many behind the same jump hosts. Now each cluster has a fixed place in its job's window — the hosts collection across 06:00–08:00 (its retries follow from each cluster's own start), the daily volume in the 30 minutes after each cluster's `collectAt` (never before it: with `collectAt` just after UTC midnight an earlier start would close the day before too soon for its late logs), and the timer's log delay measurement reads its clusters one after another over the first quarter of its interval (at most 10 minutes, so a run still ends well inside it; disarming it or the emergency stop ends the run before its next cluster, and a Fetch now refused meanwhile says how long the run has left to start its clusters). Volume and Jobs show each cluster's own start as its next run. The place comes from a stable hash of the cluster's id, the same every day and after a restart, and two clusters behind the same jump host are never next to each other where the mix allows it. One definition, `jobs::spread`, unit-tested. Run now, Refresh now and Fetch now still start at once. docs/JOBS.md "Spread".
- **A search ElasticPro gives up on now stops on the cluster too.** The background jobs' searches — the log delay pages, the volume day searches and histogram, the hosts collection pages — carry Elasticsearch's own `timeout`, five sixths of the time ElasticPro waits for that request (25 s under 30 s; derived from the same constant, never a second number). Before, a search we had given up on kept running on the cluster for nobody, and the retry piled a second one on top. A search the cluster cuts short answers `timed_out: true` and is treated as every partial answer already was: its figures kept but not final, asked again on the next run (the log delay and hosts pages: asked again, never taken for the end of the list). No `terminate_after`: counts stay exact.
- **Days that are over are asked through the request cache.** A volume search (and histogram) over days before today (UTC, the day the index names are written in) and a hosts collection page of such a day go with `request_cache=true`: their answer cannot change, so a backfill, a Collect again or a second report of the same day costs the cluster nothing. Today is never cached. Every one of these searches is `size: 0`, which is what the cache keeps.
- **The ILM error check asks less, half as often.** It asked `/*/_ilm/explain?only_errors=true&only_managed=true` every 15 minutes: every managed index in error on the cluster, with each one's whole explain. Now it asks only the cluster's log index pattern (the same one the ILM pill's `ilm_assign` reads; `*` when it has none) — the pages counted no other index's error anyway — with a `filter_path` keeping just what they read (policy, phase, step, failed step, the step's reason), and every **30 minutes** by default (`ilm_errors` 1800 s; a policy can still set it). docs/HANDBOOK.md "Datasets".
- **Log Delay › By cluster: the States bar is drawn again, and a Change column says what moved.** The bar shared a class with the old per-cluster cards and drew as an empty box; it has its own now. *Change* reads "+12 −5": devices that became late and devices that came back below the line in the last run's window today, sortable by the net; "—" when the last run was not today (unknown, never "no change").
- **Log Delay: the time-zone history note is gone from the boards** ("Delays are shown after each cluster's log time zone is taken out… Measurements from before…"). The cluster board's chip still says whether a zone is taken out; the mailed report keeps the note.
- **Jobs › All jobs: a job opens on its last run** (docs/JOBS.md "Run details"). ▸ reads the run's details with the new `JOB_RUN_DETAIL {runId}` (user and up, like `JOBS_LIST`; a caller limited to some clusters reads only their clusters' parts and lines, totals counted from those) and shows *Summary* (run id, trigger, start → end, duration, query window, clusters = succeeded + partial + failed, records collected, success rate), *Exceptions (n)* (cluster, result, error code and message, records, elapsed, retry, and a link to the setting that fixes it), *All clusters (n)*, *Log* (Copy, Download .txt) and *Run history*. Each run of the log delay measurement, the daily volume and the hosts collection now keeps a part per cluster — succeeded, partial, failed, deferred or skipped, with an error code from one fixed set (`INDEX_NOT_FOUND`, `TIMEOUT`, `SHARD_FAILURE`, `BUSY`, `AUTH`, `UNREACHABLE`, `OTHER`; "no device aggregation" is `INDEX_NOT_FOUND`, "set the cluster's log index (Config › Clusters)") — and its own log: the run's start, one line per cluster outcome, a cancel asked, and its end (500 lines a run at most), kept in the process by run id, credentials redacted — never read from a container log, and no other log line is taken. Kept beside the run log (`job-runs/detail/`) as long as it keeps the run, at most 7 days; successes past 300 counted, every exception kept. `JOBS_LIST` runs gain `parts` (the counts).
- **Jobs › All jobs reads exactly.** Last run and Next run are exact times ("19 Nov 22:26:03", "20 Nov 00:26"), a Duration column, and Result says the last run's outcome of how many clusters — "Partial · 4 of 71 clusters", "Deferred · 1 cluster". A deferral (a busy cluster) is amber words under the row — "ussc deferred — …; retried automatically when it eases (a warning, not a failure)" — never a red "Error:".
- **Jobs › Slow searches now** (docs/JOBS.md "Slow searches"): a card under Now with the searches running longer than 10 s · 30 s · 1 min · 5 min on the clusters you see, longest first — cluster, running time, node, index and the query in two lines; Open shows all of it with the task id, the `X-Opaque-Id` and Copy; ElasticPro's own searches are labelled. New `SLOW_SEARCHES {minMs}` (user and up): one `GET _tasks?actions=*search*&detailed` per cluster (`tasks::SEARCH_TASKS_PATH`), through the gate, at most once in 25 s a cluster however many people ask (a cluster being read is shared, not read again), answered within 4 s with clusters still being read listed and picked up 5 s later, and only while the Jobs page is open; a busy, unreachable or unprimed cluster is "not read", never "none". Read-only: no cancel.
- **The Jobs menu dot says what it is about** (docs/HEALTH.md). `PING` carries `healthReason` (administrators) — the first red, else amber, check: "ElasticPro health amber: Data volume free: 12% · 5.7 GiB free — watch at ≤ 15%". It was only "something is amber".

## 0.3.80

- **A cluster switched off is not polled any more — not even its health.** A cluster from ElasticPro's own config set to disabled was still handed to the core (PRIME), and the core polls what it is given: its health kept being read. Now only enabled clusters are primed; switching one back on primes it again, and a credential kept on the server is not forgotten meanwhile. (Zabbix clusters switched off in ElasticPro were already listed and not polled.)
- **The Clusters page no longer opens on hour-old figures.** With more than 25 clusters the core runs hybrid or Client basis, where node figures (disk, heap, CPU) were fetched only while a page asked, and nothing but health after 10 idle minutes — production (71 clusters) showed figures over an hour old on arrival. Now health and node figures, once read for a cluster, are kept at most **5 min** old by the core even when nobody is looking, in every mode, and the Clusters list asks for them again once they are **2 min** old while it is open. A cluster never looked at is still not fetched (Client basis's "nothing until a page asks" holds for a fresh core); a slowed, throttled or stopped cluster is held as before. docs/HANDBOOK.md "Keep-fresh floor".
- **Nodes & shards › slow work is compact.** A long-running search's detail is its whole query, and one filled eight screens with Action, Node and Running out of view. Now the five longest tasks are listed ("Show all" for up to ten), each detail is cut to five lines (its tooltip has all of it, a click opens it in a scrolling box and keeps it open across refreshes), and the cells sit at the top of the row.
- **Log delay measurement: one unreadable cluster no longer turns the 2-hour schedule into a daily one.** Any cluster that failed made the whole run "failed", and a failed run backs off — doubling, up to a day — so a cluster whose log index matches nothing (seen in production: `demo`, every run) stretched every cluster's measurement from every 2 h to once a day (runs at 16:56 → 00:57 → 16:57). Now only a run that wrote nothing it read (the store or the sink refused), or read nothing at all, backs off; a run that measured the rest goes on at the normal interval. On Jobs such a run is **Completed** with a note counting the clusters it could not measure ("4 of 71 cluster(s) not measured — the rest were"), not Failed; the first reason stays the run's error. The audit line `delay sink run` names every such cluster (`failed_clusters`); DELAY_SINK_RUN's answer carries them as `failedClusters`, narrowed to the clusters the caller may see, plus `writeFailed`.

## 0.3.79

- **`deploy.sh --upgrade` brings its own script up to date.** It first fetches the target release's `deploy.sh` (from `ELASTICPRO_RELEASE_URL`, like the compose file), checks it parses, puts it in place — the old one kept as `deploy/deploy.sh.previous` — and runs it with the same options. A release's changes to the upgrade itself now apply on the way to it: 0.3.77's dropped Postgres image needed the new script fetched by hand. Not on `--dry-run` (it says it would), not to an older version, never twice (`ELASTICPRO_SELF_UPDATED`); when the script cannot be fetched or does not parse, the installed one goes on and says so. `ELASTICPRO_NO_SELF_UPDATE=1` keeps the installed script. A server without a route to GitHub can serve `v<version>/deploy/deploy.sh` and `docker-compose.yml` from disk with `ELASTICPRO_RELEASE_URL=file:///…`. **An installed script from before 0.3.79 still has to be replaced by hand once** (deploy/README.md).
- **Security: `lettre` 0.11.23 → 0.11.24** (with `email-encoding` 0.4.3), the mail library behind the report mails and alerts. Six RustSec advisories published 2026-11-18 (RUSTSEC-2026-0560/0561/0563/0565 and two more): STARTTLS reply injection, mail for an address with a quoted local part sent to a different address, unbounded buffering of an SMTP reply. No code change.
- `tools/compose-upgrade-check.sh` section 8 covers it against the stand-in `docker`: the dry run keeps the script, `ELASTICPRO_NO_SELF_UPDATE=1` keeps it, a fetched script that does not parse is refused, the real upgrade puts the target's script in place (executable, old one kept), runs it once with the same options, and the upgrade goes on.

## 0.3.78

- **Log Delay: the time range and Fetch now are one row.** The range toggle ("⏱ 1h ▾") and its button group moved from the row under the tabs to the title bar's right end, just before Fetch now. The row under the bar is drawn only when it has something to say: the time-zone chip (when a zone is set or detected) or, on Live, the zone's name — so on most clusters the page is one row shorter.
- **Log Delay: no Build report, Report covers or Devices › on the boards.** Building a report by hand is Config › Reports' *Download now*, which already picks its clusters and period; *Report covers* only mattered to Build report (the board's time range is the period). The cluster board's *Devices ›* button repeated the Devices tab right above it. The fleet board keeps *Send now…* (it covers the period shown); Devices keeps *Export CSV* (the rows as filtered).

## 0.3.77

- **Log Delay › By cluster fits without sideways scroll.** Late now and its share share one cell ("12 · 3 %"); the Time zone column stays (it says why: "not detected · 40 % agree"), cut to fit with the whole text in its title, and Other time zone shows only when some cluster has a zone set or detected; a long worst-device name is cut with the whole name in its title. 13 columns → 11 (12 with a zone).
- **Log Delay: no more row of "documents have no device name" notes.** Dashboard and Summary with All clusters drew a note per cluster above the figures ("3,183 documents have no device name and are in no device's figures", again and again). Now one quiet line, summed, under the figures — "12,404 documents in 9 clusters have no device name and are in no device's figures" — with each cluster's count where it already was, in the Dashboard's *How the last run read each cluster*; a cluster's own board keeps its single "Last run read" line. Not reported is left out of the sum, never counted as 0. One definition, `noDeviceTotal` / `noDeviceLine` in `core/logdelay-report.js` (unit-tested). The warning for a run that stopped at the device cap or did not read every device is unchanged.
- **Log Delay › Summary: a ring above 2 % delayed is red.** A cluster with more than 2 % of its devices delayed draws its delayed arcs in the theme's critical red (the delay band a lighter red) and its share in red ink; at or below 2 % the ring keeps the level colours. All clusters follows the same rule. 2 % is one named constant, `LD_RING_RED_PCT` with `ringAlert` (2.0 % is not red, 2.1 % is; unknown is not red); the legend names it.
- **Log Delay: the time range sits at the right end of the tools row and can be folded away.** A toggle — a clock and the range chosen, "1h ▾" — folds the range group (30m … 12h · More ▾ · Custom on the boards, 5m … 12h · Custom on Live) to that one chip and shows it again (`aria-expanded`, keyboard as any button). The choice is the same on every tab and kept per browser; the range group is shown until folded.
- **Log Delay › Live: the live tail stops by itself** when the Live tab or the page is left, and after 3 minutes with no mouse, key, wheel or touch anywhere in the app — then the card says "Live tail stopped after 3 min without activity · Start again". The idle time is one definition, `core/activity.js` `IDLE_MS`, shared with the menu rail's idle fold (one set of listeners for both); browser checks shorten it with `window.__EP_TAIL_IDLE_MS` as the rail's `__EP_RAIL_IDLE_MS`.
- **Log Delay: the "Time zone · not detected" chip is gone when it has nothing to say.** Why it read "not detected" on every cluster: working as designed — a cluster's log time zone is detected only when one real UTC offset (UTC itself included) holds at least 60 % of the measured devices, within 3 min, for 3 complete runs in a row. Logs stamped correctly in UTC whose newest documents arrive more than 3 min after their event, or devices that disagree (the test VM's seeded devices sit at 2, 41, 95, −37, 300 and 330 min: one device per offset, 17 %), give no zone (and a run stopped at the device cap or by a failed page is not one a zone is detected from at all), and then nothing is corrected — so the chip said "not detected" everywhere and meant "nothing to do". The UI read the right fields (`clusterTzOffset` on every row, which the core sends). The chip is now drawn only when a device in view has a set or detected zone, or the zone filter is on (`zoneChipShown`); By cluster's *Time zone* column still says each cluster's state ("not detected · 41 % agree"), and Config-Management › Clusters › Edit cluster › Log time zone still sets one.
- **The PostgreSQL container (`db`) leaves the hosted stack.** Nothing in ElasticPro ever connected to it: accounts are files in the data directory, shared state is in Redis, and the "reporting copy" `deploy/db/init.sql` described was never wired up. The compose file no longer has the `db` service, its `db_password` secret or the `db-data` volume; `deploy/db/` and `deploy/images/postgres.Dockerfile` are gone, and `karthickdk02/elasticpro-postgres` is no longer built or published (its earlier tags stay on Docker Hub). A new install needs no `secrets/db_password`.
- **Operator note — fetch the 0.3.77 `deploy.sh` before upgrading.** `--upgrade` runs the installed script, and the one from 0.3.76 or older still pulls `elasticpro-postgres:0.3.77`, which is no longer published: it stops with "is not published — nothing changed". Fetch `https://raw.githubusercontent.com/karthick-dkk/elasticpro/v0.3.77/deploy/deploy.sh` over `deploy/deploy.sh` first (deploy/README.md shows the commands).
- **Operator note — what `deploy.sh --upgrade` does on an install that still has the db.** When `docker-compose.yml` still has the `db` service and is exactly as a release shipped it (or with `--replace-compose`), the upgrade brings in the release's file (the old one kept as `docker-compose.yml.bak-<time>`, named in `.compose-previous`) and restarts with `docker compose up -d --remove-orphans`: the db container stops and is removed. **The `db-data` volume is kept** — never `down -v`, never `docker volume rm` — and the upgrade prints its name and the command to delete it by hand once you no longer want to roll back: `docker volume rm <project>_db-data` (`deploy_db-data` for an install in `deploy/`); `secrets/db_password` and `deploy/db/init.sql` stay too. `elasticpro-postgres` is never pulled; `ELASTICPRO_DB_IMAGE` leaves `.env` and is kept as `ELASTICPRO_DB_IMAGE_PREVIOUS`. `--rollback` puts the old compose file and that image back, and the db starts again on its kept volume. A compose file **edited by hand** is left as it is: the upgrade goes on, the db keeps running, and a note says the service can be removed (delete the `db` service, the `db_password` secret and the `db-data` volume line, then `docker compose up -d --remove-orphans`). A db container whose compose file lost the service some other way (git, rsync) is removed by the next `--upgrade`; a plain `deploy.sh` says how. `--dry-run` shows all of it. deploy/README.md, "Upgrading from a release with the PostgreSQL container".
- `tools/compose-upgrade-check.sh` covers it: an upgrade from a file that still has the db (dry run and for real, against a stand-in `docker`) removes the db, keeps the volume and never pulls `elasticpro-postgres`; an edited file is left alone; `--rollback` restores the file and the image, and a second `--rollback` goes forward again. `deploy/trial.sh` no longer expects a db.
- **Indices: the bulk "⋮ Actions" opens on hover.** With indices ticked, resting the pointer on Actions shows every action; moving into the menu keeps it, leaving closes it; a click still opens it and pins it, and the keyboard works as before. One option on the shared menu (`rowMenu` `hover: true`).
- **Jobs › All jobs fits the page — no sideways scroll** at 1440 px with the menu on the left or folded, and at 1280 px. Fourteen columns are eight: Name · Type · Status (a *paused* chip beside a running job's status; a paused job reads Paused) · Progress · **Ran** (when the open run, else the last, started and how long it took: "12m ago · 3 s") · **Next run** and **Last run** as short relative times ("in 5m", the last result's pill and "2h ago"), the full time on hover · **Priority · requests** ("Medium · 2 of 1–4 · auto"). Records and the last error are a line under the row, only when there is one (the error cut short, the whole of it on hover and in the opened row). Rows stay 32 px.
- **Jobs › Running now: why it was always empty.** Nothing was filtered out: the core lists every open run (`jobs::job_states`, `run_view`) and the page shows every one (`core/jobs.js openRuns`). The runs are simply short — measured on the hosted bridge: housekeeping 4 ms, a settings backup 4–23 ms, a volume collection 183–202 ms, a hosts collection 417 ms, a report run 551 ms — while the page read every 15 s when nothing ran, so a read landed inside a run 0.03–4 % of the time. The Jobs tab now reads every 5 s when nothing runs (3 s while a run is open or queued; History and Settings stay at 15 s), reads at once when the tab is opened again, and shows the newest finished runs (*Just ran*, below).
- **Jobs › Jobs: the graphical view (approved canvas).** Above the tables, four cards. **Now** — tiles for Running, Queued, Slots in use (the governor's in use of its total, with a bar) and Last 24 hours (the success rate of the runs that ended in the day, ok / with warnings / failed with a bar; "kept" when a job ran more often than the 50 runs the log keeps of it); one row per open run (clusters, progress bar, how long it has run and — once the core's percent makes it meaningful — about how long is left; Stop) and per queued run (why it waits; Run now where the job runs on demand); *Just ran* chips (✓ / ⚠ / ✗, job, time, short note). **Health** — Worker CPU, Core CPU, Memory, Requests/s, Busy clusters: the value now and a line over 1h · 6h · 24h · 7d. **ElasticPro health** (administrators) — the service pills and one tile per health check (core and worker memory, message p95, requests turned away, poller late datasets, data volume free) with its value, its limits, ok / watch / over and its line, the same switch; Jobs › Requests › ElasticPro health keeps the full table. **Runs, last 24h** (6h · 24h · 7d) — one lane per job, a bar per run coloured by its result (green, orange, red, blue for running; never red and yellow together), the next run dashed, a "now" line, the job, clusters, start, duration and result on hover; from the run log the core already keeps. On the Jobs tab the strip gives way to these cards (History and Settings keep it). Up next moved under All jobs.
- **Core: health history kept 7 days on the server** (`health_history.rs`, docs/HEALTH.md "History"). The minute task keeps the Health and ElasticPro health figures — one point a minute for 24 h, one every 10 minutes (the mean of its minutes) back to 7 days, about 2,450 rows — in `<data>/health/history-<role>.json`, written atomically every 10 minutes and read back at start, so a restart keeps the week. New read-only `HEALTH_HISTORY {range: 1h|6h|24h|7d}`, a user's like `JOBS_LIST`: the ElasticPro health figures to administrators only (as `SYSTEM_HEALTH`), the fleet-wide counts (requests/s, busy clusters) not to a caller limited to some clusters. A figure not known in a minute is null, left out of the 10-minute mean, never 0.
- **No "Database" health line any more.** ElasticPro does not use the Postgres container (nothing in the core connects to it, nothing depends on it), so its always-"not known" chip was noise: it is gone from `SYSTEM_HEALTH` `parts`, Jobs › Requests › ElasticPro health, the new card and docs/HEALTH.md. The db container itself leaves the stack in this release too (see the operator notes).
- **Clusters › Overview: the Nodes card is more compact** — 28 px rows (were 36), a smaller head, narrower bars (92 px columns, 56 px bars), a smaller master badge; every column kept (name, master, IP, CPU, heap, disk). The Indices card beside it is unchanged.
## 0.3.76

- **Log Delay › Live: Live Watch and Live logs are one tab** (Dashboard · Summary · Devices · Live), as approved on the plan canvas. **Nothing runs until you press it**: arriving, changing tab or range sends no measurement, search or tail, and the cards say "Nothing fetched yet" / "Nothing searched yet". *Delayed now* has **Fetch**, a split button — *Fetch delayed devices* (default), *Fetch all devices*, *Fetch all devices in cluster* (also the devices silent in the range, from the 7 days before it) — that measures only the cluster chosen in the top bar; with All clusters it warns first (every cluster searched from the browser, while the server already measures them all on its schedule, its interval and last run as the core says them) and offers Open Dashboard · Pick one cluster · Fetch N clusters anyway. Rows show the delay as a bar with its minutes and the level, delayed first. **Watch** on a row shows the device's delay now, since when it is late (the core's store) and when it was measured, with Re-measure, Device details and Stop watching, and puts the device in the Logs filters. *Logs* filters by Source, src_hostname, src_ip, tag1 and a query (field names from the cluster's configured log fields; an unmapped field is said, not searched), searches only on **Search**, and has Start live tail and Export CSV; the table is Arrived · Event time · src_hostname · src_ip · tag1 · Delay · Message. `#/log-delay/watch` and `#/log-delay/live/<cluster>/<device>` open Live (the second with the device ready to search). The core's Fetch now is not in the title bar on Live.
- **Log Delay: longer ranges on the boards, the live tabs keep theirs.** Dashboard, Summary and Devices (and the cluster and device views) offer 30m · 1h · 2h · 4h · 8h · 12h, then **More ▾** with 1d · 3d · 7d · 15d · 30d · 60d — whole local days ending today, as the store keeps them (the button reads the one chosen, "7d ▾") — then Custom; no 5m or 10m there. Live keeps 5m · 10m · 30m · 1h · 3h · 12h · Custom, since it measures from the browser. The two choices are kept apart, so a 30-day board is never a 30-day live measurement; a range remembered from before seeds both, each read in its own set (a 5m board opens on 30m, a 7d live tab on 12h). Summary's Day by day is the chosen days from 7d up. One definition of every range in `core/log-range.js` (`BOARD_RANGES`, `LIVE_RANGES`), unit-tested; a custom board range over the core's 1200 days is refused at Apply instead of sent.

## 0.3.75

- **The cluster chosen stays chosen on every page.** Picking a cluster on Log Delay and moving to another page no longer puts "All clusters" back: a fleet page reset the chooser whenever the session had opened on the fleet, and Reports › Overview put "All clusters" back on arrival (the 2026-11-10 rule, withdrawn by the owner). Only a page that cannot show every cluster (an evidence page, Clusters › Overview, Indices, REST) picks one when "All clusters" is chosen, as before; Nodes & shards still opens on one unless "All clusters" was asked for there. That cluster is only borrowed: the next page that can show every cluster gives "All clusters" back, unless the person picked a cluster in between. A chosen cluster that a reloaded config no longer names falls back to "All clusters".
- **Reports › Exports & schedules › Generated reports: the report files as a full-width table**, always shown and newest first — Cluster(s) · Report kind · Period · Format · Size · Created · Status (done, running with its progress, queued, failed with the reason) · Download. The full file name is the row's title, and a long name or cluster list wraps in its cell instead of being cut off. The Generate report form opens above the table only when its button is pressed (Close hides it), and running jobs appear in the same table. Nothing built yet: "No report built in the last 7 days · Generate report". The Reports pill now lands on the table with the form closed. Same REPORT_JOBS data; no core change.
- **Log Delay › Summary: the old Reports › Log delay fleet view is back, as the second tab** (Dashboard · Summary · Devices · Live Watch · Live logs; `#/log-delay/summary[/<cluster>]`). Four tiles — total devices; with delay now (30–60 min and above 60 min); with no delay and the on-time share; the shares without delay, delayed, silent and can't measure — *Delay reduced* (devices back under the delay level in the last 2 / 4 / 6 / 12 / 24 h), *Day by day* (stacked by level) and *Delayed devices by cluster* (All clusters first, then a ring per cluster worst first; a ring opens the cluster). It reads the page's time range and the top-bar cluster chooser like Dashboard (one cluster: its tiles, its days, its own ring); the old Period and Clusters selects are not back. Every figure is the core's `LOGDELAY_SUMMARY`, the same answer the Dashboard reads; the core is unchanged.
- **Day by day writes each day's own date.** The old chart wrote five ticks picked by rounding, so a short period read "10 Nov" five times; each bar now has its own slot and label (the month once, then where it changes), and Day by day always covers at least the last 7 days ("Last 7 days · 11 Nov – 17 Nov" in its header): with a shorter page range (5m–12h, or a Custom range under 7 days) it asks the core for those 7 days with one extra `LOGDELAY_SUMMARY`; a Custom range of 7 days or more shows exactly its days. Only this card widens — the tiles, Delay reduced and the rings stay on the page's range. The days are one definition, `dayChartDays` in `core/logdelay-report.js`. A day without totals is a hatched gap, a cluster never measured an empty ring that says so — never 0 %.
- Summary uses today's definitions: the configured levels (no "little" band, no median), the page's colours (`LD_COLOURS`), and `sharedLevels` now lives once in `core/logdelay-report.js` with the ring order, ring arcs, day bars and ticks beside it (unit-tested).
- **Device lists show the delayed devices first.** Devices and a cluster's *Devices in this cluster* open on the devices at the delay level or above (30–60 min and above 60 min); **Show all devices** lists every device and then reads **Show delayed only**. The choice is not remembered: each visit starts on the delayed ones. The *All* chip is gone (the button replaces it); the level chips keep their counts over every device, a chip pressed again lets go, and a level that is not delayed (a Below 30 tile, Silent, Other time zone) shows those devices. A list with nothing delayed says "No delayed devices · Show all devices". A device opened by a link that is not delayed is still listed beside its board, with a line saying why. Live Watch already listed the delayed devices by default and is unchanged.
- **Volume: missing days are filled again, a few a run, while the cluster is calm (backfill).** Reports › Daily & monthly showed whole weeks without a point although the cluster still held those days' indices: a day the timer did not collect stayed a gap. Now every daily run (and Collect now), after its own days (today and yesterday), fills days of the last `backfillDays` (default 30) that the record does not hold as final and measured — never searched, the search failed, "N of M shards failed", final without a count — when the cluster still has an open index on that day (the collector's own index→day mapping). Oldest first, at most `backfillPerRun` (default 7) per cluster per run, so a long gap fills over a few runs instead of in one burst. Before each such day the core reads the cluster's search thread pool (`_cat/thread_pool/search`): a queue over half full, new rejections, or a 429 / pressed pool in the busy-cluster signals pauses the backfill for that cluster until the next run (the run's own days are still collected, and the run is not a failure). A slow answer does not count: a big day's aggregation is slow by itself. A day whose indices are gone is not asked again and is counted ("no index left on the cluster"), never shown as 0. `backfillDays: 0` turns it off (every unfinished day asked every run, as before). docs/VOLUME.md "Backfill".
- New settings `backfillDays` (0–366) and `backfillPerRun` (1–31) in `defaults.volume`, per-cluster overrides and config.txt (`UI_VOLUME_BACKFILL_DAYS`, `UI_VOLUME_BACKFILL_PER_RUN`, locking their rows), and on Config-Management › Reports › Volume fields.
- `status.backfill` in `VOLUME_DAILY` / `VOLUME_MONTHLY` (`{from, to, missing, fillable, searched, filled, queued, gone, noIndex, waiting, paused}`): Reports › Daily & monthly and Indices › Summary say in one line why a gap remains ("Backfill: 7 days queued · 12 days with no index left on the cluster (cannot be filled) · paused: cluster under query pressure"). The Jobs page's run note says what the backfill did ("backfilled 3 of 10 missing days"; a run over several clusters adds "12 days backfilled, 1 backfills paused for query pressure").

## 0.3.74

- **Inside Zabbix the menu stays across the top.** 0.3.72 made the left menu the default, which inside Zabbix's frame drew a second sidebar beside Zabbix's own menu. With `?embed=1` the menu is always across the top (as before 0.3.72) and Your settings offers no menu position there. Found while checking the Zabbix modules against 0.3.68–0.3.73: every page the modules open still lands (`#/volume` → Reports, `#/logs` → Log Delay › Live logs); no module or template change is needed, and the core is unchanged since 0.3.67.
- **The left menu really is the default for a new person.** The shell defaulted to left, but the settings rules (`core/prefs-rules.js` DEFAULTS, the one definition) still said top and won, so only someone who had chosen left saw it. The default is now left in that one place.

## 0.3.73

- **Indices › Summary: a range with no recorded day says so.** When none of the days shown (15d by default) is in the daily record, the chart drew an empty axis whose labels read "3 undefined" (the scale stepped in fractions of a byte, which have no name). It now says "No day in the last 15 days is recorded" and names the newest recorded day, so a longer range can be chosen; the scale never steps below one byte.
- The Log Delay device-page check no longer fails between 00:00 and 03:00: the fixture's open delay started 3 h before now, i.e. on yesterday while the page shows today; it now starts within today at any hour.

## 0.3.72

- **REST: the Query and Results boxes reach the footer.** Their height is the window's less where they start (measured, so it holds with the menu on top or at the left and with one to ten tabs) and the footer; a long answer scrolls inside Results, and the request body fills Query.
- **Snapshots › Policies (SLM): Edit… and Delete… on each policy** (⋯ row menu, admins only, through the write gate). Edit reads the policy fresh and changes the name pattern, schedule (cron, 6–7 fields), repository (one that exists), indices and retention; every other key of the policy (global state, partial, feature states, metadata…) is kept exactly as read, and the `PUT _slm/policy/<id>` body is shown before Save. Delete wants the policy id typed and says the snapshots it took are kept.
- **Snapshots, inside a repository: tick snapshots and delete them together.** A tick per row and a head tick that takes every snapshot the search matches, on every page (as on Indices); a bar "N selected · Delete… · Clear". Delete… lists every name, wants `delete` (or the number) typed, and sends `DELETE /_snapshot/<repo>/<a>,<b>,…` in batches of at most 3000 characters, reporting each batch. A snapshot still being taken cannot be ticked. Admins only; nobody else sees the ticks.
- The request shapes and checks are in `ui/js/core/snapshot-admin.js` (unit tests in `tools/unit/snapshot-admin.test.mjs`). The mock cluster now holds SLM policies in memory (GET/PUT/DELETE `_slm/policy/<id>`) and honours several snapshots in one DELETE, in the `_cat` listing as well.
- **The alerts bell is on Clusters and Clusters › Overview only.** Other pages no longer draw it; notices raised there are still kept and are in the bell the next time it is opened.
- **No "1 green · 1 yellow" health pill in the top bar on any page.** The dot on the cluster chooser still shows health (the worst of the fleet when several clusters are chosen).
- **Documents can no longer be edited or deleted** (the owner, 2026-11-17: "completely remove this feature"). The documents view inside Indices is read-only for every role: the row's ⋯ menu has Copy JSON and Open in REST only. The JSON editor, the Review and save dialog with its diff, the Delete dialog and the conditional `PUT`/`DELETE <index>/_doc/<id>` they sent are gone, and so are their helpers (`docPath`, `editStatus`, `lineDiff`, `writeOutcome`) and CSS. The search no longer asks Elasticsearch for `_seq_no` / `_primary_term`. Changing a document is still possible through the REST console, behind the same write gate as before.
- **Nodes & shards: the Allocation switch shows what it was switched to.** After a switch the page reads the setting again, but that read could be answered from the core's short read cache (up to a minute) and show the old value. The read after a switch now always asks the cluster. (On the test VM's `vm-mock`, the fixture also ignored the write; `tools/mock-es.mjs` now remembers `cluster.routing.allocation.enable`.)
- **Menu: Clusters › Overview marks only "└ Overview".** Both it and Clusters were highlighted; the page's own button now steps back while its sub-item is on screen (with the menu folded to icons the Clusters icon stays marked, as the sub-item is hidden).
- **Left menu: « at the top too, and it folds itself after 3 idle minutes.** A second « sits beside the brand at the top of the menu (the one at its foot stays). With no mouse, key, wheel or touch anywhere in the app for 3 minutes the menu folds to icons by itself; while the mouse is on it the full menu shows over the page, and » keeps it open. Folded by hand it stays icons only and never opens on hover, remembered per browser as before.
- **The left menu is the default.** A person who chose the top menu keeps it (with their account, else in this browser); a choice never made, or one not understood, means the left menu.
- **Your settings: icons only.** The menu position is two pictures (left bar, top bar) and the theme five symbols, each name in its tooltip and label; Opens on has short choices; the explanation lines are gone (where the settings are kept is the panel's tooltip). Sign out stays.
- **The top menu fits on one row:** the cluster chooser comes first, right after the brand; Jobs and Config-Management are icons (names in the tooltip); the account button shows the initials only. "└ Overview" is not in the top menu: the Clusters page's List · Overview tabs reach it, and Clusters stays marked there.
- Two Log Delay behaviour checks no longer fail in the first hour after midnight: the default 1 h window then rightly covers two local days, and the "last run" note rightly names yesterday's date.

## 0.3.71

- **Clusters › Overview: the top-bar chooser switches the board.** Picking another cluster used to snap back to the one the address named; now the board shows the cluster picked and the address follows (`#/clusters/overview/<id>`).
- **No more "🔒 read-only / ✎ writes allowed" toggle on any page** (Snapshots, Indices, Nodes & shards, Jobs). The write gate is unchanged: an admin's write action asks "Allow writes to this cluster?" when it is pressed, and the core still refuses without the unlock and `allowWrites`. The shard-allocation switch, which was disabled while writes were locked, is live for an admin and asks the same way.
- **Nodes & shards: the node table fits without a sideways scroll** at 1440 and 1280 px with the menu on the left — tighter cells, narrower bars, the disk cell reads "91% · 8.38 GB free" (the sizes are in its tooltip), and the shard count has its own short **Shards** column.
- **Nodes & shards: Shard allocation and Query pressure are compact** — a 120 px half-gauge (was 200), 18–20 px figures, the tiles side by side, about a third shorter (202 → 140 px). Every figure and label is still there.
- **The Request Centre is Jobs › Requests** (`#/jobs/requests`, with its ElasticPro health tab at `#/jobs/requests/health`), a tab beside Jobs · History · Settings for operators and admins. Config-Management › Requests is now just the Policy. The old addresses (`#/requests`, `#/settings/requests/centre`) still open it. The ElasticPro health dot moved to the Jobs menu item.
- **The left menu folds to an icon rail.** « at the foot of the menu, above your name, folds it to 56 px of icons (each with its page name as tooltip and label, the open-alert count as a badge on Alerts, the current page still highlighted); » opens it again. The page uses the width it frees. Remembered per browser; the top menu is unchanged.
- **Indices › Summary** (the owner's design, approved 2026-11-17): a third tab, Indices | Templates | Summary, at `#/indices/summary`, on the cluster in the top bar. Day buttons **15d** (default) · 30d · 60d · 90d, always ending today; Export CSV; icon-only refresh.
- Five tiles: **Yesterday** (size, indices, docs), **Avg 7 / 30 / 60 days** per day, **Today so far** ("as of HH:MM · not final"). A day missing from the record is never counted as 0: the tile says "59 of 60 days recorded".
- **Index size per day** as **Columns** (a bar per day, the 7-day average as an orange line, today lighter, dates "03 Nov" thinned at 60/90 days, the month once under the axis, a tooltip per bar) or **Rows** (newest at the bottom, sizes in one right-aligned column). Two icon buttons switch it; the choice is remembered per browser.
- **Per day by tag1**: a table with the top 6 tag1 values and "other", and a day's status (final / today so far / not measured). The **tag1 chips** (All, the top values, "+ N more") filter both the chart and the table. A value's size is its share of the day's documents × the day's size; the "i" beside the title says so, and no "est." label is shown.
- Nothing new is searched. Everything comes from the daily volume record the core already keeps (VOLUME_DAILY, and VOLUME_BREAKDOWN for the tag1 values), on the configured size basis (primary by default). The core is unchanged. A record that was never collected says why and offers Collect now. A cluster with no tag field says so and names the setting.
- The Indices tab no longer has the line "Daily and monthly summary is now in Reports › Daily & monthly ›".
- One average (`avgPerDay` in `ui/js/core/indices-summary.js`) feeds the tiles, the line, the tooltip and the CSV. Unit tests are in `tools/unit/indices-summary.test.mjs`. `tools/lib/volume-fixture.mjs` gives render-check and behaviour-check a 100-day record with nine tag1 values.

## 0.3.70

From a full UI review: every page, tab and section, signed in on the test VM and locally, with the menu on the left (light and dark) and on top.
- **Key/value cards no longer split words in the middle.** The value column used `word-break: break-all`, so in a narrow card ordinary words broke at any letter ("3 m ag o", "auto-refr esh", "GET/HEA D"), for example in Config-Management › System › Config file › Diagnostics. It now wraps at spaces, and only a token longer than the line (a path, an address) is split.
- **Config-Management shows its name once**, in the menu, per the UI rules. The side panel kept its own "Config-Management" title; it now shows only the signed-in role.

## 0.3.69

- **Menu on the left: the cluster chooser has its own row at the left, and every page uses its full width.** The chooser used to float over the top-right corner of the page, with a 330 px invisible strip reserved for it. A panel laid out as a flex or grid box can't flow around such a strip, so it lost 330 px from top to bottom. On REST, Nodes & shards and most other pages that showed as an empty column on the right. The chooser now starts a thin row of its own at the left of the content, with the pills and the alert bell at the right end of the same row, and nothing is reserved. With the menu on top nothing changes: the chooser stays at the end of the menu row.

## 0.3.68

- **Documents inside Indices** (the owner's design, 2026-11-16; no new page, no menu item). An open index's name in the Indices table is a link that opens its documents in the same page (`#/indices/docs/<target>`; a closed index stays text, the tooltip says to open it first), and a **Documents** button beside the search browses every index the search matches — a plain pattern list goes to Elasticsearch as typed, anything else (plain text, *Not matching*, a narrowed table) sends the matched open names, and a names list past ~3,000 characters disables the button with the reason. **‹ Indices** goes back with the search, filters and page kept. The view: a query-string box (empty = everything), **15m · 1h · 24h · 7d · Custom** when the indices map a date field (`@timestamp`, else the first date field), an icon reload; a **Fields** panel from `_mapping` merged across the indices — an aggregatable field (keyword, number, date, boolean, ip, or a text field's `.keyword`) shows its top 10 values with counts, and a value adds `field:"value"` to the search; the table (time, `_index`, `_id`, a one-line summary; 32 px rows) pages on the server, newest first, with the total counted up to 10,000 (**10,000+** past that — counting every match of a large log pattern is work the cluster need not do, and no page past 10,000 could be shown anyway) and no page past 10,000 ("narrow the search to see further"); a row opens the document on the right (pretty JSON, Copy, Open in REST). **Edit and Delete are an admin's, from the row's ⋯ menu** (everyone else sees Copy JSON and Open in REST only), through the same write gate as every page: Edit validates as you type ("✓ Valid JSON · N changes"), **Review and save…** shows a line diff and the exact request, and Save sends `PUT <index>/_doc/<id>?if_seq_no=…&if_primary_term=…` (plus `routing` when the hit has one) — a 409 says "Someone changed this document since you opened it — nothing was overwritten. Reload it." and keeps the text; Delete needs the whole id typed and sends the same conditional `DELETE`. Both re-run the search when they succeed. The arithmetic and the request shapes are one module, `ui/js/core/documents.js` (unit-tested); the view is `ui/js/ui/documents-view.js`.
- **Rows per page are the viewer's** (the owner, 2026-11-16): the Indices list opens at **10** rows and offers 10 / 25 / 50 / 100; the documents table opens at **5** and offers 5 / 10 / 25 / 50. Each choice is remembered per browser. The config's `tableRowsPerPage` no longer sets the Indices list.
- `tools/mock-es.mjs` answers `<target>/_mapping`, the documents searches (hits with `_seq_no` / `_primary_term`, from/size/sort and a `track_total_hits` cap, the `top_values` terms agg) and `GET`/`PUT`/`DELETE <index>/_doc/<id>` with a 409 on a stale version; `render-check`, `fit-check` and `behaviour-check` cover the view.

## 0.3.67

- **Log Delay: the "Today by window" check no longer depends on the clock.** The behaviour check used a "Last 12 h" or "Last 3 h" button, which crosses midnight early in the day and made the check fail between 00:00 and 03:00. It now sets a Custom range from that day's midnight to now, which stays inside one day at any hour.
- **Log Delay: dead fallback removed.** The boards no longer look up the old period list (Today, Last 7 days, …) for a label the core always sends; the list itself is gone (`periodQuery` stays for Clusters › Overview).

## 0.3.66

- **No empty header band** (the owner, 2026-11-16). The cluster chooser and the bell sit at the right end of the page's first row on every page, with the menu on top (the end of the menu row) or on the left (over the page's first row); the product name moved to the head of the menu. Clusters › Overview shows its chooser too.
- **One red for every level above 90 %** — a single token, `--level-crit`, in every theme; bars and fills that passed 90 % share it.
- **REST: the request card** — row 1 is the method and the full-width path; row 2 is Run, Common requests, Saved queries, History, and the HTTP status at the right end. The keyboard hint is in Run's title.

## 0.3.65

- **The footer is at the bottom of every page, full width** (the owner, 2026-11-15). It is the last row of the app column, after the page menu and the page: a short page has it at the bottom edge of the window, a long one reaches it by scrolling; never fixed. With the menu on the left it runs under the menu as well (the menu ends above it). Clusters › Overview keeps its one screen with the footer as the last row. The theme button now draws a white sun (Light), moon (Dark) or half-filled circle (System) as inline SVG, 28 px hit area, its title naming the current theme and the next.

- **Indices: one search box** (the owner, 2026-11-15). The "Search index" field in the top toolbar is gone; the box above the table (wildcards, Not matching, Live / Snapshot / Live + Snapshot) is the only one. From day, To day and Status stay.
- **Log Delay: one time-range button group on every tab** (the owner, 2026-11-15). Dashboard, Devices, Live Watch and Live logs share `5m · 10m · 30m · 1h · 3h · 12h · Custom` (`core/log-range.js RANGES`; default 1h, remembered per browser; Custom opens From, To and Apply). The Dashboard and Devices ask the store for the local days the window touches, and where the window is after the last scheduled run they say so ("No scheduled measurement in the last 30 minutes — last run 11:40"); *Report covers › Period shown* follows the window. The Period list is gone.
- **Log Delay: the tools row is one aligned line** — the range group and the Time zone chip are both 30 px, centred, no labels above.
- **Log Delay: Fetch now is an icon** (refresh arrow, name and progress in its title and aria-label); the ▾ menu is unchanged.
- **Log Delay: fewer descriptions** — the Dashboard subtitle, the counts line under the state bar, the By cluster and "How the last run read each cluster" subtitles are removed.

## 0.3.64

- **Indices: select all means all** (the owner, 2026-11-15). The head tick selects every index the filters and the search match, on every page, and says "N selected" beside it; the bulk actions (Open, Close, Settings, maintenance, "Delete N indices…") act on all N. Ticking or unticking one row now keeps the head's tick, half-tick and count in step without redrawing the rows, and the head reads the matching set when pressed, not when it was drawn.
- **Indices: wildcard and not-matching search** (the owner, 2026-11-15). The search box takes `*` and `?` as wildcards (case-insensitive, over the whole name); plain text without them is still "contains"; several patterns separated by commas match any of them. A **Not matching** toggle beside the box, or a leading `!`, shows the indices the search does not match, and the count says so ("12 of 95 indices · not matching logstash-*"). One definition, `ui/js/core/index-match.js`, read by the table, the head tick and the Live + Snapshot search.
- **Clusters: an Overview button on the name; the expanded row is gone** (the owner, 2026-11-15). Each row's name cell carries **Overview →**, shown while the pointer is on the name or the keyboard is in it (it keeps its place, so nothing moves), which opens Clusters › Overview on that cluster (`#/clusters/overview/<id>`); the ILM and SLM buttons open it too. The chevron, the click-to-expand row, its details (strip, cards, repositories, nodes), its live task/rate readings, the "Expand details by default" and details groups of the Columns panel, and the code, CSS and checks only they used are removed. A stored `details`/`expand` layout preference is ignored and dropped on the next save.
- **Elasticsearch roles view (read-only)**: Accounts › On the clusters gains a **Cluster roles** card for the selected cluster — `GET _security/role` as one sortable table (role, cluster privileges, "indices → privileges" per block, run as, note; built-ins marked), with a *find a role* box that filters in place. No edit buttons. Security switched off, no security API or a caller without the privilege is said in words with Elasticsearch's own reason — never an empty list. `core/security-roles.js` (pure); `esReason` is now shared with the users read. `tools/mock-es.mjs` answers `_security/role` with three roles.
- **`?` opens the keyboard shortcut sheet** (outside a text field): a small dialog drawn from one table, `core/shortcuts.js`, listing the shortcuts that exist (Esc, `r`, Ctrl/⌘+Enter in REST, Alt+T, `/` in Config-Management, arrows in Alerts, the Play keys). Esc or × closes it.

## 0.3.63

- **Nodes & shards is nodes and shards only** (the owner's cut after 0.3.62). *Cluster at a glance* — storage accounting, dangling indices, indices past retention — leaves this page for the Clusters overview (`shardSplit` stays shared; `figure` and `splitDonut`, left without a caller, are removed). **Nodes & resource usage** (was Nodes & cluster load): one 32 px line per node, **Node ID** (the short id, the whole id in the tooltip) and **IP** as columns of their own, the heap / RAM / CPU / load bars of 0.3.62, disk on the same line (`91.0% · 8.4 GB free · 38 shards`); the tasks and thread-pool lines stay. A new row under it: **Shard allocation** — a half-circle gauge (`splitGauge` with `half`, 200 wide, stroke 20: assigned green from the left, moving blue, unassigned pink at the right end; the assigned share and "N of M shards assigned" under the arc), the three counts stacked beside it as edge tiles (assigned · moving · unassigned, the last naming the `unassigned.reason` counts with *show*, which narrows the table to the unassigned shards), and in the header **Allocation: on ▾** = `cluster.routing.allocation.enable` read with `include_defaults` (transient over persistent over default, the source in the tooltip; "not known" when unreadable — never a guess); choosing *all · primaries · new_primaries · none* is a **write** (`PUT _cluster/settings {persistent: …}`, clearing a transient value in the same call — it would outrank the new one) through the same gate as *Move…*, with the consequence in words ("none: no shard will be placed or moved until it is switched back"); while writes are locked the switch is disabled and its tooltip says why. **Query pressure** — a pill *No pressure* / *Under pressure* (one rule, `core/node-rates.js pressureState`: anything rejected or any breaker trip between the last two polls, or a search/write queue above zero in both), four tiles (rejected, breaker trips, search queue, write queue; the breakdowns search · write · bulk, parent · request · fielddata, pool size · nodes in each tile's tooltip), from two `_nodes/stats` readings ten seconds apart, then every thirty seconds while the page is open; before two readings it says *measuring · next poll* — unknown is not zero. `nodeRates(clusterId)` also carries the search/indexing rates and latency for the Clusters overview. **Shards**: the filters row is one line — Index, Node, State with their labels inline, *Show hidden (.) indices*, then the freshness text, *Retry failed allocations* and the reload, every control 30 px on one centre line; *Reload shards* is an icon (↻, named for the reader; the freshness bar's own Refresh is gone — one reload); the head tick selects **every started shard the filters match on every page**, half-ticked while only some are, and reads "N selected" — the Indices page's head tick does the same for every index the filters match. **Every unassigned shard row ends in an "i"**: it asks `_cluster/allocation/explain` for that shard (a POST the read-only guard now counts as a read — the shard travels in the body), shows the reason code in words, Elasticsearch's own sentence, the node deciders that said NO, and the recommended fix (`core/shard-fixes.js`: every `unassigned_info.reason` code plus the decider-driven cases — disk watermark, awareness, filtering, same shard, max retries, allocation switched off), with *Retry failed allocations* and *Open the explain answer in REST*; a refused explain is shown as what the cluster said. The "i" popover is one component for every page (`ui/ui/fix-popover.js`; Log Delay's findings sit on top of it). The **read-only (role) pill is gone** from every page; writes stay gated exactly as before. `tools/mock-es.mjs`: `_nodes/stats` gains search time, deletes and breakers (node-3's write queue stands at 5 — the fixture is under pressure), `_nodes/_all/os,thread_pool` the pool queue sizes, and `POST _cluster/allocation/explain` is routed like a read.
- **Clusters › Overview** (the owner, 2026-11-14: "single page view, no need to scroll anywhere"): one cluster's dashboard on one screen, a section of the Clusters page at `#/clusters/overview` — a sub-item **└ Overview** under Clusters in the page menu, and a **List · Overview** tab row on the page with, at its right, **↻** (refresh now; "refreshed N s ago" on hover) joined to the interval **10s / 30s / 1m / 5m** (30s by default, remembered per browser; it runs only while the board is on screen and the tab visible, refreshes this cluster alone, and skips a tick while one is in flight). The top bar's chooser is the one cluster choice (with *All clusters* chosen it opens on the cluster last chosen, as the evidence pages do; the address carries the cluster, `#/clusters/overview/<id>`, so a bookmark opens on it). Top to bottom: the cluster (name, type · tags, Elasticsearch version, its URL, uuid; in the corner the open-alerts badge — amber, red when any is critical, the titles on hover, a click opens Alerts for this cluster — the health pill, "68 of 69 shards placed" and the unassigned reason when the shard table was read), Nodes (count, data, master-eligible, master, uptime) and Indices (count, documents, size on disk, red/yellow counts); four gauges — **CPU · Disk · JVM heap · Shards** — each naming the node that is highest with a ring at the right (`lib/charts.js ringGauge`, the one ring; heap 75/85 and disk/CPU 80/90 as Nodes & shards colours its bars; Disk's caption is the cluster's own watermarks, "not known" until its settings are read); **Search · Devices & log delay · Latency and pressure** — Search and Latency from two readings of `_nodes/stats` an interval apart (`core/node-rates.js`; "measuring · next poll" until two exist, a counter no node reported stays "–"), Search carrying the searches running over a minute (count pill, each one's description · node · running time, a *Tasks* link; "tasks not readable" when the task list cannot be read); Devices & log delay (in Indexing's place; docs/s stays in `nodeRates()`) from the Log Delay Dashboard's own answer for this cluster (`LOGDELAY_SUMMARY`, today, once per refresh): the devices in the last scheduled run, "N delayed over 30 min · a 30–60 min · b above 60 min" by the configured levels in the Log Delay colours, "last measured · next", and the boards' own words for a cluster never measured or a switched-off schedule, with a *Log Delay* link to the cluster's board; **SLM** and **ILM**, a heading line (operation pill, the policy / "N indices managed", a link) and one status line each (the last run's result · time · duration · indices; "N past <retention> retention (X GB) · M in error"), from what the Clusters page's expanded row already holds (`cluster-boxes.js slmCard/ilmCard`, `nodes-shards.js staleIndices`) — "no policy" and "not readable" said as such; and **Nodes** (busiest first: name, IP, CPU, heap and disk bars) beside **Indices** (unhealthy first, then by size: health, docs, size, shards), which take the rest of the height and scroll inside themselves — the page never scrolls at 1280×720 and above; below 1280 px it stacks. Every piece is kept between redraws. The Clusters list is unchanged; `#/overview` still opens it, at `#/clusters`.
- **The top bar shows nothing in a normal state** (the owner, 2026-11-14: "remove this completely; make it default settings as configured"): the Refresh button with its minutes badge and ▾ menu, the Auto toggle, the live / quiet / manual pill, "Reports · idle" and the ▶ Play button are gone. Refreshing runs on the configured defaults (Config-Management › System › Defaults: Auto-refresh, Refresh every; the fleet cache's own schedule) — `r` still refreshes the selection, and Clusters › Overview has its own interval. Play opens from Config-Management › Play (**▶ Open Play**) and from a display link. The bar still speaks up in an abnormal state alone: the emergency stop (with Resume for those who may) and a failed report run ("Reports · 1 failed", red). Brand, cluster chooser, credential prompt, bell and the person's name stay.
- **A footer at the end of every page** (the owner, 2026-11-15): three columns — a theme button (one icon, cycling Light → Dark → System, the same setting Your settings keeps), "ElasticPro <version>" (the core's version, from PING) and the repository link (`ui/js/ui/about.js` REPO, a new tab) — grey (#4b5563) with white text in every theme, 30 px, in the flow after the page's content (never fixed; a long page reaches it by scrolling, a short page has it at the foot of the window). Not on Play's display. The Overview's one-screen board shrinks by its height.
- **A page's name is shown once** (the owner, 2026-11-14: "why shows the page name again?"): in the page menu, where the current item is highlighted. The top bar no longer draws the page title (an `h1` kept for screen readers alone), and the in-page headings that repeated it are gone — Log Delay's, Reports' (its subtitle stays), Config-Management's page name and "Config-Management" crumb (the page's line and the tab's status pill stay).
- **Nodes & shards, after the owner's review of 0.3.62.** *Cluster at a glance* is one band one row tall instead of a 250 px card: the shard split is a small donut of 44 px with its total and counts beside it (assigned · moving · unassigned, each with its count — the zeroes too) and the six figures (Nodes, Indices, Indices hold, Elasticsearch holds, Disk used, Unaccounted) sit inline, caption · value · at most a short grey suffix, the rest in each figure's tooltip; it wraps at narrow widths rather than squeezing. *Nodes & cluster load*: **Heap, RAM and CPU are bars** of the kind the Disk column draws — a thin track, the filled part coloured by the same thresholds the page has always used (heap amber from 75 %, red from 85 %; RAM and CPU by the disk shape, 80 / 90), the number beside it in the level's ink. **Load 1m/5m is a bar too**, over the node's processor count (`GET _nodes/_all/os` `allocated_processors`, read once per cluster per visit, kept ten minutes), capped at 100 %, with the raw "3.55 / 2.10" beside it and the tooltip saying "load 1 m over N cores"; a node that reports no processor count gets the figures alone, no bar — unknown is not zero; the fleet view does not make the extra call per cluster and shows the figures alone. **Every shard column sorts**, the Unassigned reason too (shared lib/table-sort.js, a second click reverses, remembered per browser; a head says ↕ under the pointer until a press gives it a direction), with the tick boxes and *Move…* working on the sorted rows. **Hidden (".") indices are left out of the shard table by default**: a *Show hidden (.) indices* box in the filters row (remembered under `elasticpro.shards.showHidden`), the head counts what was kept out ("3 of 3 shards · 1 hidden"), and a name filter starting with "." finds them regardless. `tools/mock-es.mjs` gains a `.kibana_1` shard, 5-minute loads and the `_nodes/_all/os` answer (node-3 reports no processors).
- **REST console** (owner's review of 0.3.62): the request tabs read **Page 1, Page 2 …** by position (renumbered when one closes; the request is the tab's tooltip and the echo line). **A request typed or pasted whole is recognised** (`core/console-paste.js`): `post _snapshot/es_9/execute` in the path box sets the method and keeps the path; a Kibana Dev Tools request (`POST _x` then the body on the next lines) pasted into the path box or the Query editor splits into method, path and body (formatted when it is JSON); a `curl -X… 'http://host:9200/…' -d '…'` line likewise (host dropped — the console sends to the chosen cluster); a plain JSON body stays a body. The page says what it recognised in a brief line above the results. The **Saved queries** and **History** cards are gone from the page: both are panels behind two buttons on the request line (find box / only mine; filter / favourites / Export / Clear), each row with **Open** or **Load** and **Run** (a write still asks first); Escape, × and a click outside close them. The history still shows this cluster alone and names no cluster. **The result code is beside Run**, out of the output box: a status pill (green 2xx · amber 3xx/4xx and the read-only refusal · red 5xx and no answer · a grey dash before any run) with the time and size, `role="status"`; while the request is in flight the same pill shows a spinner and **Running… 1.2 s** counting, with Run disabled; the Results header keeps only its tools; the history rows use the same definition (`core/response-status.js`). **Both request echo lines are gone** — the "cluster GET /path" line above the inputs and the "GET /path" line above the answer: the method and path are shown once, in the inputs, the cluster in the top bar's chooser. **The "read-only (operator)" / "🔒 read-only" pill is gone from the console** (banned by the owner): a write request on Run goes through the write guard like every other page — a read-only role is refused with the reason, a locked session is asked to allow writes by hand, then the request is confirmed; Run's tooltip says which beforehand. Nothing is sent before both.

## 0.3.62

- **Log Delay page redesigned** (the approved prototype, docs/LOGDELAY.md "The Log Delay page"). Tabs **Dashboard · Devices · Live Watch · Live logs**; the Recommended fixes tab is gone — every device row (Devices, Live Watch) and every cluster row (By cluster) ends in an **"i"** that opens the core's recommended fix for it (cause · fix · where, a cluster's grouped by finding with counts, its time-zone finding among them; `LOGDELAY_SUMMARY`/`CLUSTER` now carry `devices[].fix` and `byCluster[].fixes`), beside *Open in logs* (and *Details* on Live Watch, whose row click does nothing). **Only the three configured levels**: Below 30 min · 30–60 min · Above 60 min (the names from each cluster's `levels`), plus Other time zone and Silent — the 15-minute **little-delay band is removed** everywhere (core `State::of`, the UI, the report's Day by day sheet, the settings' three bands); `noDelayUnder` stays in the levels JSON equal to `delayFrom` for compatibility, `State::Little` and the `little` counts stay so stored data still reads. **No median, percentile or average anywhere.** Dashboard: five count tiles (each opens Devices filtered), three chart panels on one y scale — **30–60 min behind** (light blue), **Above 60 min behind** (blue) and **Resolved log delays** (green: devices back below the line) — by day over the period or by measurement window for *Today* (each window now carries its `delay`/`critical` split from the stored states), a bar opens Devices on its level, a bucket without a figure is a hatched gap; then *By cluster* with a states bar — every column sorts, the most delayed clusters first, the 5 most delayed by default (*Show all N* → 30 a page), then the **Hourly Delay Status** heat map (pale → deep blue; a cell opens the cluster). **Devices** tab: search, level chips with counts, zone and tag1 filters, CSV; one device opens beside the short list. **Fetch now** is a split button at the top right of the title bar: the main click re-measures the picked cluster's late devices (30+ min), ▾ offers *Late devices* / *Whole cluster* and ends in the automatic schedule's note; progress shows on the button ("3 of 8…" and a thin fill), the outcome is a toast, nothing beside it; with All clusters it asks to pick one. The time zone is plain text, never a chooser: the chip shows the zone alone ("Time zone +05:30", the majority zone of the devices in view, or "not detected"); the chip itself opens (▾) every zone with its device count, majority first ("+08:00 · 16 devices", "not detected · 6 devices · under 60 % agree, no correction"); a zone is a **filter on every view**, kept in the address (`?tz=480`): tiles, By cluster, Devices and Live Watch show those devices, the chip reads "· only these devices", the panel offers "Show all time zones" (a device's zone is its own steady offset, else its cluster's detected one). By cluster's Time zone column carries the device counts, and the core's *Cluster* fix no longer sends anyone to Edit cluster: "only x % of its devices agree on one offset … check the devices' clocks and the parser's date filter; the zone is taken from the majority once 60 % agree" (the config's `logTimeZone` stays an admin override). Live Watch's banner is one plain line with an "i" about the view (seconds fresh, the real 500-devices-per-cluster browser limit); its one-device close-up is gone (Details opens the device on Devices). Colours (the owner's "cool blue"): green #8fd19e below the line, light blue #a9cbee for the delay band, blue #5b8fd1 above the critical line, violet for another time zone, grey for silent — the same fills in every theme, each theme mixing its own pill inks for AA; never red with yellow. The chart's hover is CSS only, so a parked pointer replaces nothing (flicker STRICT).
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
