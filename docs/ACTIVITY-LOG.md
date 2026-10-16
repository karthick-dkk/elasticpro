# Activity log

ElasticPro records what people do, reads included, as JSON lines in ECS field names, so a
SIEM can ingest the file as it is. Administrators see the latest of it on the Accounts
page under "User activity".

This is separate from the `audit` log lines on stdout (writes only, kept short on purpose).

## What is recorded

Every message a person sends to the server except background polling (PING, WHOAMI,
FLEET_STATE, EVENTS_TICKET, REQUEST_STATS, NOTIFY_LIST/PUT, POLICY_GET, TUNNELS,
ZABBIX_METRICS, SILENCE_LIST, CLUSTER_DATASET, PINS, ABORT_REQUESTS, BADGE, ACTIVITY_LIST).
That includes every Elasticsearch request, GET and search included, sign-ins and sign-outs
(password, API token, Zabbix sign-in), account and token changes, configuration changes,
and requests the server refused (wrong role, locked guard, unknown cluster).

Never recorded: request bodies, passwords, API tokens, session ids, or the `text`,
`password` and `secret` fields of any message. For a failed sign-in the name that was typed
is recorded (first 64 characters), because a run of them against one name is the signal.

## Fields

| Field | Meaning |
|---|---|
| `@timestamp` | RFC 3339, UTC, milliseconds |
| `event.kind` | always `event` |
| `event.category` | `authentication`, `iam` (USER_*, TOKEN_*), `configuration`, `database` (ES), or `process` |
| `event.action` | the message type, lowercase: `es`, `login`, `user_add`, `sso_zabbix` ... |
| `event.outcome` | `success` or `failure` |
| `event.reason` | why it failed (failures only) |
| `error.code` | the `EP-nnn` code (failures only, see ERROR-CODES.md) |
| `user.name`, `user.roles` | who, and their role |
| `user.target.name` | the account an administrator acted on (USER_* only) |
| `source.ip` | the client address, honouring `X-Real-IP` from trusted proxies |
| `elasticpro.cluster` | cluster id |
| `elasticpro.via` | how the caller proved who they are: `session`, `token`, `proxy`, `sso`, `none` |
| `elasticpro.edition` | `hosted`, `installed` or `portable` |
| `http.request.method`, `url.path`, `url.query` | the Elasticsearch request (ES only) |
| `service.name`, `service.version` | `elasticpro` and the server version |

Absent fields are left out, not null. Example (one line in the file):

```json
{"@timestamp":"2026-10-16T09:14:03.512Z","event":{"kind":"event","category":["database"],"action":"es","outcome":"failure","reason":"this role may only read (EP-110)"},"error":{"code":"EP-110"},"user":{"name":"asha","roles":["user"]},"source":{"ip":"10.20.0.7"},"http":{"request":{"method":"PUT"}},"url":{"path":"/orders"},"elasticpro":{"cluster":"prod","via":"session","edition":"hosted"},"service":{"name":"elasticpro","version":"0.3.16"}}
```

## File, rotation, settings

The file is `activity.jsonl` in the data directory (mode 0600). At the size limit it is
renamed to `activity.jsonl.1`, older ones shift up (`.2` ... `.5`), and the oldest is
deleted. A write error is warned about once and never fails the request.

| Variable | Default | |
|---|---|---|
| `ELASTICPRO_ACTIVITY_LOG` | `$ELASTICPRO_DATA_DIR/activity.jsonl` | a file path, or `off`. The portable build has it off unless a path is set |
| `ELASTICPRO_ACTIVITY_LOG_MAX_MB` | `50` | size at which the file rotates |
| `ELASTICPRO_ACTIVITY_LOG_KEEP` | `5` | rotated files kept |
| `ELASTICPRO_ACTIVITY_STDOUT` | unset | `1` also emits each event on stdout as a tracing event with target `activity` (for Docker log drivers) |

The Accounts page reads the last 1000 events, held in memory since the server started;
the file is the complete record.

## Forwarding

In `deploy/docker-compose.yml` the data directory is the `core-data` volume at
`/app/data`, so the file is `/app/data/activity.jsonl` in the core container. Give the
forwarder read-only access to that volume, for example by adding
`core-data:/var/log/elasticpro:ro` to a Filebeat or Fluent Bit service in the same
compose project (declare `core-data` as the existing volume). Alternatively set
`ELASTICPRO_ACTIVITY_LOG` to a path on a bind mount.

Filebeat:

```yaml
filebeat.inputs:
  - type: filestream
    id: elasticpro-activity
    paths: [/var/log/elasticpro/activity.jsonl]
    parsers:
      - ndjson:
          target: ""
          add_error_key: true
```

Fluent Bit:

```ini
[INPUT]
    Name   tail
    Path   /var/log/elasticpro/activity.jsonl
    Parser json
    Tag    elasticpro.activity
```

rsyslog:

```
module(load="imfile")
input(type="imfile" File="/var/log/elasticpro/activity.jsonl" Tag="elasticpro-activity:" Severity="info")
action(type="omfwd" Target="siem.example.com" Port="514" Protocol="tcp")
```

Rotation renames the file; filestream, tail and imfile follow that.
