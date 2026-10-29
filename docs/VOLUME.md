# Index volume: per day, per month, by field

Developer contract for the daily volume record (0.3.45). The plan was approved on the
design canvas "Index volume plan". This file is the one place that says what each figure
means; the core implements it, and the UI, the CSV, the .xlsx and the mails show the
core's answers. None of them works a figure out again.

## What counts

- **Only indices whose name fits `indexFormat`** (default `logstash-*-YYYY.MM.DD`, for
  example `logstash-linux-2026.10.20`). `*` is the source (one or more characters, may
  contain `-`). `YYYY.MM.DD` is the day. Anything else is not counted and is listed by
  name as "skipped".
- **A day is the date in the index name.** No time zone, no timestamp field. A breakdown
  asks that day's indices by name (`logstash-*-2026.10.20`), so it adds up to that day.
- **A day is finished** when its date is before today's UTC date. Today is collected too
  but stays `final: false` and is shown "as of HH:MM".

| Figure | Source | When it cannot be read | Kind |
|---|---|---|---|
| Primary size per day | `_cat/indices` `pri.store.size` of the day's indices, summed | — | measured |
| Total size per day | `_cat/indices` `store.size` (with replicas) | — | measured |
| Indices per day | count of the day's indices | — | measured |
| Documents per day | `hits.total` of the day's `_search` (`track_total_hits`) | day not aggregated yet → `null` | measured |
| Event bytes | `sum` of the Event size field (default `event_logsize`) | no numeric field in the mapping → `null`, shown "not measured" | measured |
| Sub size | `sum` of the Sub size field (default `sub_size`) | as above | measured |
| Documents per value | `terms` on the resolved field within the day's indices | field not found → `error`, never 0 | measured |
| Primary size per value | Σ over days of (value docs ÷ day docs) × day primary size | — | **estimate**, always labelled "est." |

`null` is "not measured". It is never rendered as 0.

## Settings (`defaults.volume` in the clusters file)

```yaml
defaults:
  volume:
    indexFormat: logstash-*-YYYY.MM.DD
    tag:         [ tag1, labels.tag1, tags ]
    forwarder:   [ fwd_tag, fwdtag, observer.name ]
    sourceHost:  [ src_hostname, host.name ]
    sourceIp:    [ src_ip, source.ip, host.ip ]
    eventSize:   [ event_logsize ]
    subSize:     [ sub_size ]
    extra:       { name: Dataset, fields: [ event.dataset, log_type ] }
    sizeBasis:   primary        # primary | total | eventSize: what the graph and cards plot
    topValues:   25             # 5..100, values kept per field per day
    keepMonths:  13             # 1..36
    collectAt:   "06:00"        # HH:MM, server local time (TZ of the core process)
    overrides:                  # per cluster, by cluster id; any subset of the keys above
      prod-eu: { forwarder: [ fwdtag ] }
```

- Each field row is tried left to right; the first name `_field_caps` knows on the
  day-index glob wins. A `text` field uses `<name>.keyword` when that is a keyword.
  Sum fields must be numeric.
- A cluster entry may also carry `volume: {…}` in `clusters[]`; it counts like an override.
- **Legacy** `volumeFields` (defaults or cluster): read only when no `volume` is set.
  `tag1`→tag, `fwd_tag`/`fwdtag`→forwarder, `src_hostname`→sourceHost, `src_ip`→sourceIp,
  the rest→extra fields. The editor writes `volume` on its first save.
- **Precedence**: built-in < `defaults.volume` < cluster override < config.txt. A config.txt
  key locks its row everywhere ("managed by config.txt").
- **Where the core reads them**: hosted, its own config file (ELASTICPRO_CONFIG). Without a
  config file (desktop), from the `volume` object the UI sends with each `VOLUME_*` message
  (`{defaults: <defaults.volume>, cluster: <that cluster's override>}`).

### config.txt keys (hosted)

| Key | Kind | Managed name (PING `managedDefaults`) |
|---|---|---|
| `UI_VOLUME_INDEX_FORMAT` | text, must contain `*` and `YYYY.MM.DD` | `volumeIndexFormat` |
| `UI_VOLUME_TAG_FIELDS` | text, comma list | `volumeTag` |
| `UI_VOLUME_FORWARDER_FIELDS` | text, comma list | `volumeForwarder` |
| `UI_VOLUME_HOST_FIELDS` | text, comma list | `volumeSourceHost` |
| `UI_VOLUME_IP_FIELDS` | text, comma list | `volumeSourceIp` |
| `UI_VOLUME_EVENT_SIZE_FIELD` | text, comma list | `volumeEventSize` |
| `UI_VOLUME_SUB_SIZE_FIELD` | text, comma list | `volumeSubSize` |
| `UI_VOLUME_EXTRA_NAME` | text | `volumeExtraName` |
| `UI_VOLUME_EXTRA_FIELDS` | text, comma list | `volumeExtraFields` |
| `UI_VOLUME_SIZE_BASIS` | enum primary,total,eventSize | `volumeSizeBasis` |
| `UI_VOLUME_TOP_VALUES` | int 5..100 | `volumeTopValues` |
| `UI_VOLUME_KEEP_MONTHS` | int 1..36 | `volumeKeepMonths` |
| `UI_VOLUME_COLLECT_AT` | text HH:MM | `volumeCollectAt` |

## Collection (core, `volume_daily`)

- **When**: hosted only, once a day at `collectAt` server local time. A tick every 60 s
  runs it when local time is past `collectAt` and today's scheduled run has not happened
  (persisted, so a restart neither repeats it nor skips a missed one). **Refresh now**
  (`VOLUME_RUN`) runs it at once for whoever asks, at most once per 60 s per cluster. On
  desktop there is no timer: opening Indices › Summary asks for a run when the last one
  is older than today's `collectAt`.
- **Respects** the emergency stop (skipped, retried next tick) and unreachable clusters.
  At most 2 clusters at once, one request at a time per cluster, 60 s per request,
  `gate::Class::Background`, origin `volume-daily` in the request log. Searches only:
  works under read-only.
- **Each run, per cluster**:
  1. `GET /_cat/indices/<glob>?format=json&bytes=b&h=index,status,docs.count,pri.store.size,store.size`
     where `<glob>` is `indexFormat` with `YYYY.MM.DD` → `*`. Group by name day; refresh
     `indices`, `priBytes`, `totalBytes`, `sources` and `live: true` for every day that
     still has indices; days no longer present become `live: false` and are never changed
     again.
  2. `GET /<glob>/_field_caps?fields=…&ignore_unavailable=true` to resolve each row.
  3. For each day within `keepMonths` that has live open indices and is not yet
     aggregated as final (plus today, every run), one search:
     `POST /<indexFormat with the date>/_search?ignore_unavailable=true&allow_no_indices=true`
     ```json
     { "size": 0, "track_total_hits": true,
       "aggs": {
         "ev":  { "sum": { "field": "<eventSize>" } },
         "sub": { "sum": { "field": "<subSize>" } },
         "by_index": { "terms": { "field": "_index", "size": 1000 },
                       "aggs": { "ev": {"sum":…}, "sub": {"sum":…} } },
         "f_tag":   { "terms": { "field": "<resolved>", "size": <topValues> },
                      "aggs": { "ev": {"sum":…}, "sub": {"sum":…} } },
         "m_tag":   { "missing": { "field": "<resolved>" },
                      "aggs": { "ev": {"sum":…}, "sub": {"sum":…} } },
         "…": "f_/m_ for forwarder, sourceHost, sourceIp, extra"
       } }
     ```
     `ev`/`sub` aggs are left out when that field is not resolved (the figure is `null`).
     Terms aggs are left out for unresolved rows (the row carries `error`).
  4. Prune month files older than `keepMonths`.

### Store

`<data>/volume/<escaped cluster id>/YYYY-MM.json.gz`: `{version:1, days:{"2026-10-20": Day}}`,
plus `<data>/volume/<escaped cluster id>/state.json`: run status and month summaries, so
the all-cluster Monthly view reads one small file per cluster. Written tmp + rename,
0600. Nothing is held in memory between requests.

```text
Day = { day, final, live, aggregatedAt|null, totalsAt,
        indices, priBytes, totalBytes, docs|null, eventBytes|null, subBytes|null,
        sources: { "<source>": { indices, priBytes, totalBytes, docs|null, eventBytes|null, subBytes|null } },
        fields:  { tag|forwarder|sourceHost|sourceIp|extra:
                   { field|null, error|null,
                     top: [ { value, docs, eventBytes|null, subBytes|null } ],
                     otherDocs, missingDocs, otherEventBytes|null, missingEventBytes|null,
                     otherSubBytes|null, missingSubBytes|null } },
        error|null }
```

## Derived figures (core, one definition each)

- **basis(d)**: `priBytes` | `totalBytes` | `eventBytes` per `sizeBasis`.
- **Average over N days for day d**: mean of basis over the N calendar days before d that
  have a record (d itself excluded). `changeVsAvgPct = (basis(d) − avg) / avg × 100`,
  `null` when there is no earlier day.
- **Cards**: yesterday's basis; "Average per day · N days" = mean of the last N finished
  days (yesterday included); "This month so far" = Σ basis of the current month's days
  (today as of the last run); "Event bytes · 30 days" = Σ eventBytes over the last 30
  finished days (`null` if none measured).
- **Top value** of a field on a day: the first `top` entry, with share = docs ÷ day docs.
- **Month row**: month, daysWithData, partial (current month), Σ priBytes/totalBytes/docs/
  eventBytes/subBytes, avg per day (Σ basis ÷ daysWithData), peak day (max basis),
  liveDays/keptDays, top value per field over the month (by summed docs).
- **Breakdown** (field, from, to, top): per value Σ docs, Σ eventBytes (measured),
  Σ estimated primary (rule above), share % of the estimated total, days seen. Rows
  "(not set)" (missing) and "all others" (other) are listed and counted.
- **Source filter**: totals per source come from `_cat` and `by_index`. Top values are kept
  for all sources together; under a source filter they are not available (shown "—").

## Messages

All return `{ok, …}`; failures carry `kind` and `message`. Cluster-scoped ones obey the
caller's cluster visibility. `volume` (desktop only, see above) is accepted on each.

| Type | Role | Request | Reply |
|---|---|---|---|
| `VOLUME_SETTINGS` | User | `{clusterId?}` | `{settings, managed:[names], source:"file"\|"message"\|"builtin", overrides:[clusterIds]}` |
| `VOLUME_FIELDS_CHECK` | User | `{clusterId}` | `{indices:{match, skipped:[names]}, rows:[{key, tried:[..], resolved\|null, type\|null, note}]}` |
| `VOLUME_DAILY` | User | `{clusterId, days?:14..400, avgDays?:3..180, source?}` | `{settings, status, cards, days:[DailyRow], sources:[names], skipped:[names]}` |
| `VOLUME_MONTHLY` | User | `{clusterId, months?:1..36}` | `{status, months:[MonthRow]}` |
| `VOLUME_BREAKDOWN` | User | `{clusterId, field, from, to, top?}` | `{field, resolved, rows:[..], totals}` |
| `VOLUME_MONTHLY_ALL` | User | `{months?}` | `{clusters:[{clusterId, name, months:[MonthRow]}]}` |
| `VOLUME_RUN` | User | `{clusterIds?}` (absent = every cluster the caller sees) | `{started:[ids], already:[ids], tooSoon:[ids]}` |
| `VOLUME_LAYOUT_GET` | Guest | `{}` | `{layouts:{daily, monthly}}` |
| `VOLUME_LAYOUT_SET` | Operator | `{table, layout:{order:[keys], hidden:[keys], labels:{key:label}}}` | `{layouts}` |

`status = {lastRunAt|null, nextRunAt|null, running, progress:{done,total}|null, lastError|null, collectAt}`

`DailyRow = Day totals + {basis, avg, changeVsAvgPct, top:{tag,forwarder,sourceHost,sourceIp,extra: {value, share}|null}}`

Columns (keys) of the Daily table: `day, indices, docs, priBytes, topExtra, eventBytes,
subBytes, changeVsAvg, topSourceHost, topForwarder` (also available, hidden by default:
`totalBytes, topTag, topSourceIp`). Monthly: `month, daysWithData, priBytes, topExtra,
avgPerDay, peakDay, docs, eventBytes, subBytes, topSourceHost, topForwarder, from`.

## CSV columns

- daily: `cluster, day, indices, docs, primary_bytes, total_bytes, event_bytes, event_bytes_measured, sub_bytes, change_vs_avg_pct, avg_days`
- monthly: `cluster, month, days_with_data, primary_bytes, avg_primary_bytes_per_day, peak_day, peak_primary_bytes, docs, event_bytes, from_kept_record_days`
- breakdown: `cluster, field, field_resolved, value, period_from, period_to, docs, event_bytes, primary_bytes_estimated, share_pct, days_seen`

## Reports and mail

### Report jobs (Indices › Summary › Monthly › Generate report)

- `REPORT_RUN` (User) `{clusterIds:[..], period, format:"xlsx"|"csvzip", mail:bool}` queues
  **one job per cluster** (a client is a cluster). `period` is `{from:"YYYY-MM-DD", to}` or a
  preset: `"month:2026-10"` (a current month means "so far"), `"yesterday"`, `"last7"`.
  Reply `{jobs:[Job]}`.
- A job: (1) collects the days of its period that the record is missing (same collector,
  same rules, stoppable between days), (2) builds the file, (3) mails it when `mail` is set
  and SMTP is configured (else the job ends `done` with `mailError`). Progress
  `{done,total}` counts days collected plus one for the file.
- At most `concurrency` jobs run at once (3..5, default 3, admin `REPORT_CONCURRENCY_SET {n}`);
  the rest wait in FIFO order and start as slots free. Persisted in `<data>/reports/jobs.json`
  (a job running at restart is marked `failed: "the server restarted"`).
- `REPORT_JOBS` (User) `{}` → `{jobs:[Job], concurrency, running, queued}`: every job the
  caller's visible clusters cover (status is shown to everyone, "for the tool").
- `REPORT_STOP` (**Admin only**) `{id}` or `{all:true}` → stopped jobs end `stopped`.
- `REPORT_CLEAR` (User) `{}` removes finished/stopped/failed jobs **the caller started**
  (admin: all). `REPORT_DOWNLOAD` (User; the starter or an admin) `{id}` →
  `{name, mime, base64}`. Files kept in `<data>/reports/` for 7 days, then pruned.
- `Job = {id, clusterId, clusterName, period:{from,to,label}, format, mail, by, createdAt,
  startedAt|null, endedAt|null, status:"queued"|"running"|"done"|"stopped"|"failed",
  progress:{done,total}, file:{name,bytes}|null, error|null, mailError|null, stoppedBy|null}`

### The file

- `.xlsx`, sheets **Daily**, **Monthly**, **Breakdown** (one block per field: tag,
  forwarder, sourceHost, sourceIp, extra). Daily and Monthly use the shared column layout
  (`VOLUME_LAYOUT_*`: order, names, hidden). Byte columns are numbers (bytes) with a GB
  column beside primary size; `null` cells read "not measured". Breakdown estimate column
  header says "est.". Written by the core (zip + SpreadsheetML), no external tool.
- `.zip` of `daily.csv`, `monthly.csv`, `breakdown.csv` with the CSV columns above.
- Name: `volume-<cluster>-<from>_<to>.xlsx`.

### Mail server (Config › Volume fields › Mail server (SMTP))

- `<data>/mail.json` `{host, port, security:"starttls"|"tls"|"none", auth:"password"|"none",
  user, from, password (encrypted at rest with the same key as cluster secrets)}`.
- config.txt (lock the field): `UI_SMTP_HOST` text, `UI_SMTP_PORT` int 1..65535,
  `UI_SMTP_SECURITY` enum starttls,tls,none, `UI_SMTP_USER` text,
  `UI_SMTP_PASSWORD_FILE` text (path read at send time, never echoed), `UI_SMTP_FROM` text.
- `MAIL_SETTINGS_GET` (Admin) → settings without the password, `passwordSet:bool`,
  `managed:[keys]`. `MAIL_SETTINGS_SET` (Admin) (password only when typed; empty keeps it).
  `MAIL_TEST` (Admin) `{to}` → `{ok, steps:[{step:"connect"|"tls"|"auth"|"send", ok, detail}]}`.
- "none" security is allowed only with `auth:"none"` (no password over plain text).

### Mailed report (Config › Volume fields › Volume report by mail)

- `<data>/report-schedule.json` `{enabled, to:[..], cc:[..], bcc:[..], schedule:"monthly"|
  "weekly"|"daily"|"manual", at:"07:00", clusters:"all"|[ids], subject:"ElasticPro volume
  report · {period}", sheets:["daily","monthly","breakdown"], lastSent:{at, to, ok, error}|null}`.
- Periods: monthly → previous calendar month (sent on the 1st); weekly → previous Mon..Sun
  (sent Monday); daily → yesterday, sent after that day's scheduled collection finishes.
  Server local time for `at`, hosted only, persisted so a restart does not resend.
- One mail, one attachment: an .xlsx with one sheet set per cluster (sheet names prefixed by
  cluster name, ≤31 chars). Body: per cluster yesterday, average per day (7), month so far.
- config.txt: `UI_REPORT_TO` text (comma list), `UI_REPORT_SCHEDULE` enum
  monthly,weekly,daily,manual, `UI_REPORT_AT` text HH:MM, `UI_REPORT_SHEETS` text.
- `REPORT_SCHEDULE_GET` / `REPORT_SCHEDULE_SET` (Admin), `REPORT_SEND_NOW` (Admin) → runs the
  mailed report for the current settings at once (as a background job).
- Every mail send is an audit line (who, to-count, ok), never the addresses' contents of the
  attachment, never the password.
