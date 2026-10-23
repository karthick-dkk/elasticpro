# Settings file (config.txt)

A hosted install keeps its server settings in one file, `deploy/config.txt`, mounted into
the core at `/app/config.txt` with `ELASTICPRO_SETTINGS=/app/config.txt`. The keys and their
ranges are documented in `deploy/config.txt.example`; this page is what the **core** does
with them. (`deploy.sh` handles `LISTEN_PORT`, `ALLOWED_DOMAINS`, `ALLOWED_UI_IPS`,
`RATE_EXEMPT_IPS` and `CORE_MEM_LIMIT` itself; the core knows them and ignores them.)

## Precedence

```
config.txt  >  environment variable  >  config_cluster.json / Config page  >  built-in default
```

A key with a value is **managed** and wins. A key that is empty or absent is not managed:
whatever sits below it decides. The UI shows a managed setting as it is in force, locked,
with the note "managed by config.txt" (Config → Defaults, the Zabbix options, the alert
thresholds, the Zabbix connection card) and never writes it to the config file.

## File rules

`KEY=VALUE` per line; `#` starts a comment line; whitespace around key and value is trimmed;
one pair of surrounding quotes is tolerated; the last line for a key counts. Nothing wrong
with the file stops the core from starting:

* missing file, a directory in its place (Docker makes one for a bind mount whose host file
  does not exist), unreadable or not UTF-8: no settings, one warning;
* an unknown key: one warning for that key, ignored;
* a value outside its range or of the wrong type: a warning, and the key is **not managed**
  (the setting falls back as if left empty).

Warnings are in the core log (`docker compose logs core`), target `elasticpro_core::settings`.
Changes are read at start: `deploy/deploy.sh --apply-config` restarts the core.

## What the core does with each key

| config.txt | Applied as |
| --- | --- |
| `TRUSTED_PROXIES` | env `ELASTICPRO_TRUSTED_PROXIES` |
| `PUBLIC_URL` | env `ELASTICPRO_PUBLIC_URL` |
| `FRAME_ANCESTORS` | env `ELASTICPRO_FRAME_ANCESTORS` |
| `ZABBIX_URL`, `ZABBIX_API_URL` | env `ELASTICPRO_ZABBIX_URL`, `ELASTICPRO_ZABBIX_API_URL` |
| `ZABBIX_ALLOWED_SOURCES` | env `ELASTICPRO_ZABBIX_ALLOWED_SOURCES` |
| `ZABBIX_SYNC_SECONDS` (30-86400) | env `ELASTICPRO_ZABBIX_SYNC_SECS` |
| `ZABBIX_VERIFY_TLS` | env `ELASTICPRO_ZABBIX_API_INSECURE` = `1` for false, `0` for true |
| `ZABBIX_CLUSTER_TEMPLATE` | env `ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` |
| `ZABBIX_SCOPE_USERS_BY_GROUP`, `ZABBIX_USE_ELASTICPRO_CREDENTIALS`, `ZABBIX_CREATE_HOSTS`, `ZABBIX_HOST_GROUP` | the config file's `zabbix:` options, overridden in `ZbxOptions::from_config` (every caller, including the Zabbix sign-in scope) |
| `ZABBIX_METRICS_HOST` | env `ELASTICPRO_ZABBIX_METRICS_HOST`: the Zabbix host the request figures are pushed to every 60 s by `history.push` (`zbx_push.rs`). Empty: no push, and no timer. Signed with the Zabbix link's (paired) token, whose role allows `history.push` from Zabbix modules 2.1.2 on, which means it can write to any trapper item in Zabbix. `ELASTICPRO_ZABBIX_METRICS_TOKEN_FILE` (server-only, never in `config.txt`) overrides it with a push-only token, the hardening option |
| `ACTIVITY_LOG`, `ACTIVITY_LOG_MAX_MB`, `ACTIVITY_LOG_KEEP` | env `ELASTICPRO_ACTIVITY_LOG`, `..._MAX_MB`, `..._KEEP` |
| `ACTIVITY_LOG_STDOUT` | env `ELASTICPRO_ACTIVITY_STDOUT` = `1` / `0` |
| `NOTIFY_DAYS` (1-3650) | env `ELASTICPRO_NOTIFY_DAYS` |
| `LOG_LEVEL` | env `RUST_LOG` = `<level>,audit=info` (the audit lines are warnings and stay on at `error`) |
| `POLL_HEALTH_SECONDS` (180-300) | env `ELASTICPRO_POLL_HEALTH_SECS` |
| `POLL_CONCURRENCY` (1-256) | env `ELASTICPRO_POLL_CONCURRENCY` |
| `ES_CONCURRENCY` (1-1024) | env `ELASTICPRO_ES_CONCURRENCY` |
| `CACHE_MB` | env `ELASTICPRO_CACHE_MB` (empty: a quarter of the container's memory limit) |
| `HOUSEKEEPING_MINUTES` (0-10080), `HOUSEKEEPING_CACHE_DAYS` (1-3650), `SESSION_IDLE_DAYS` (0-3650), `ACTIVITY_LOG_KEEP_DAYS` (0-3650) | env `ELASTICPRO_HOUSEKEEPING_MINUTES`, `..._CACHE_DAYS`, `ELASTICPRO_SESSION_IDLE_DAYS`, `ELASTICPRO_ACTIVITY_LOG_KEEP_DAYS` (`housekeeping.rs`) |
| `SESSION_IDLE_DAYS` (warning) | 0 (default) never signs anyone out; any other value signs people out after that many idle days |
| `HOUSEKEEPING_DRY_RUN` | env `ELASTICPRO_HOUSEKEEPING_DRY_RUN` = `1` / `0` |
| `UI_TLS` | the certificate switch (`insecure` = accept every certificate), instead of `defaults.tls` |
| `UI_READ_ONLY` | the core's read-only guard, instead of what a browser sends in PRIME |
| `UI_*` (the rest) | `managedDefaults` in the PING reply, below |

The environment variables are set once, at the top of `main` in the bridge binary, before the
async runtime starts and before anything reads the environment (`std::env::set_var` is only
sound while the process is single-threaded). The desktop app has no settings file.

## What the UI is told

PING (every signed-in caller; nothing in it is secret) carries two objects holding only the
managed keys, under the names of `DEFAULTS` in `ui/js/core/config.js`:

```json
"managedDefaults": { "readOnly": false, "autoRefresh": true, "refreshIntervalSec": 60,
  "requestTimeoutMs": 15000, "diskWarnPercent": 80, "diskCritPercent": 90, "snapshotStaleHours": 26,
  "logIndexPattern": "logstash-*", "timeField": "@timestamp", "tls": "auto",
  "liveRedraw": "pending", "defaultScope": "all", "tableRowsPerPage": 50, "maxLogRows": 200 },
"managedZabbixOptions": { "useElasticProCredentials": true, "createHosts": false,
  "scopeUsersByGroup": true, "hostGroup": "Elasticsearch clusters" }
```

`liveRedraw` (`UI_LIVE_REDRAW`) is how data the core pushes reaches the open page: `pending`
(the default) leaves the page alone while it is being used and draws what landed a few seconds
after the person pauses, with nothing on screen to say it was held; `live` repaints as it
lands; `manual` draws only on Refresh or when another page is opened.

`ui/js/core/managed.js` holds the last set; `effectiveDefaults` (alert-rules.js) and the config
normaliser apply it last, so it wins over the file and over thresholds retuned on the Config
page. The Zabbix connection status adds `managedBy: { field: "config.txt" }` for the link
fields the file sets.
