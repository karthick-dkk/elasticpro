# Error codes

Every failure ElasticPro shows ends with a code in brackets, for example
`that username and password do not match an account (EP-102)`. Quote the code when you
report a problem: it names the failure exactly, whatever the wording around it.

| Range | Raised by | Defined in |
|---|---|---|
| EP-1xx to EP-5xx | the ElasticPro server (core) | `crates/elasticpro-core/src/errors.rs` |
| EP-6xx | the ElasticPro page in the browser | `ui/js/core/error-codes.js` |
| EP-7xx | the ElasticPro module inside Zabbix | `deploy/zabbix/module/elasticpro/views/elasticpro.embed.php` |
| EP-999 | anything not given a code yet | |

A code keeps its meaning once it is given out. A new kind of failure gets a new code.

## Signing in and sessions (1xx)

| Code | Kind | What it means | What to do |
|---|---|---|---|
| EP-101 | `unauthenticated` | No session, or it ended. | Sign in again. |
| EP-102 | `bad_credentials` | The name and password do not match an account. | Check both. After 5 wrong passwords in a row the account locks for 15 minutes (the last admin is slowed instead, see EP-107). |
| EP-103 | `must_change_password` | The account still has its shipped password. | Set a new one. |
| EP-104 | `needs_bootstrap` | No account exists yet. | Create the first administrator. |
| EP-105 | `disabled` | The account is blocked. | An administrator unblocks it on the Accounts page. |
| EP-106 | `locked` | The account is locked, by an administrator or after too many wrong passwords. | An administrator unlocks it on the Accounts page; a self-lock also clears after 15 minutes. |
| EP-107 | `rate_limited` | Too many sign-in requests, or the last admin after 5 wrong passwords (one try per 30 seconds). | Wait, then try again. |
| EP-110 | `forbidden` | Your role may not do this, or the cluster is not one you may see. | Ask an administrator for the access. |
| EP-111 | `no_token` | An API call without a token. | Send the token. |
| EP-112 | `session_expired` | The session timed out. | Sign in again. |

## The request (2xx)

| Code | Kind | What it means |
|---|---|---|
| EP-201 | `bad_request` | Something in the request is missing or not allowed; the message says what. |
| EP-202 | `bad_message` | The server does not know this request. Usually a page newer or older than the server. |
| EP-203 | `malformed` | The request could not be read. |
| EP-204 | `bad_method` | Not an HTTP method the server sends. |
| EP-205 | `unsupported`, `not_supported` | This build does not do that (for example accounts in the portable build). |
| EP-206 | `not_found` | No such cluster, account or file. |
| EP-207 | `name_taken` | That name is already used. |
| EP-208 | `aborted` | The request was cancelled. |
| EP-209 | `blocked_readonly` | A write while the cluster is read-only or the write guard is locked. |
| EP-214 | `overloaded` | ElasticPro already holds as many requests waiting for a cluster as it allows (`ES_QUEUE_MAX`, or `ES_QUEUE_PER_USER` for one person). Nothing was sent. The reply carries `retryAfterMs`, and the page asks once more by itself after that long. |
| EP-215 | `queue_timeout` | The request waited `ES_QUEUE_WAIT_MS` (or its own timeout, if shorter) for a free connection and got none. Nothing was sent. The Request Centre shows what holds the connections. |
| EP-216 | `response_too_large` | The cluster's answer is larger than `ES_MAX_RESPONSE_MB` (a page's request) or `ES_MAX_FLEET_RESPONSE_MB` (the poller's), or than the memory the core may spend on answers at once. It was not read, and nothing of it is shown. Narrow the request (`filter_path`, a smaller `size`, fewer indices) or raise the limit. |

## Config, storage and secrets (3xx)

| Code | Kind | What it means |
|---|---|---|
| EP-301 | `no_config` | The server was started without a config file (`ELASTICPRO_CONFIG`). |
| EP-302 | `parse_error` | The config file does not parse. |
| EP-303 | `io_error`, `io` | A file could not be read or written on the server. |
| EP-304 | `bad_master` | The master password is wrong. |
| EP-305 | `no_creds` | No credential for this cluster. |
| EP-306 | `not_configured` | A feature that needs setting up first (Zabbix sign-in, Vault). |
| EP-307 | `fleet_off` | The fleet cache is turned off. |

## Reaching a cluster (4xx)

| Code | Kind | What it means |
|---|---|---|
| EP-401 | `timeout` | No answer in time. |
| EP-402 | `tls_untrusted` | The certificate is not trusted and not pinned yet. |
| EP-403 | `tls_pin_mismatch` | The certificate changed since it was pinned. The credential was not sent. |
| EP-404 | `tls_error` | The TLS handshake failed. |
| EP-405 | `connection_refused` | Nothing listens on that port. |
| EP-406 | `dns` | The host name does not resolve. |
| EP-407 | `unreachable` | No route to the address. |
| EP-408 | `connection_reset` | The connection closed before an answer; often HTTP sent to an HTTPS port. |
| EP-409 | `network` | Could not connect for another reason. |
| EP-410 | `tunnel_error` | The jump host tunnel is down. |
| EP-411 | `hostkey_unknown` | The jump host's SSH key is not trusted yet. |
| EP-412 | `hostkey_mismatch` | The jump host's SSH key changed. |
| EP-413 | `http_error` | Elasticsearch answered with an error status. |
| EP-414 | `client_error` | The request could not be sent. |

## Zabbix (5xx)

| Code | Kind | What it means |
|---|---|---|
| EP-501 | `zabbix_error` | The Zabbix API refused or failed. |
| EP-502 | `not_zabbix` | The address does not answer as Zabbix. |
| EP-510 | `bad_signature` | Zabbix sign-in: the two sides' pairing secrets differ. Re-pair under Administration → ElasticPro. |
| EP-511 | `stale` | Zabbix sign-in: the request is too old; the two hosts' clocks disagree. |
| EP-512 | `replayed` | Zabbix sign-in: that request was already used. |
| EP-513 | `no_role` | Zabbix sign-in: a Zabbix guest has no ElasticPro role. |

## In the browser (6xx)

| Code | Kind | What it means |
|---|---|---|
| EP-601 | `worker_error` | The page could not reach the ElasticPro server, or got no JSON back. |
| EP-602 | `no_answer` | The server answered with nothing usable. |
| EP-603 | `no_clusters` | You are signed in and no cluster is visible to your account. |
| EP-604 | `sso_failed` | A Zabbix sign-in code could not be traded for a session. |
| EP-605 | `parse_error` | The cluster list arrived but does not parse. |
| EP-606 | `proxy_rate_limited` | nginx refused: this browser sent more requests per second than allowed. The page retries by itself; it shows only if that keeps happening. |
| EP-607 | `core_unavailable` | nginx could not reach the ElasticPro core (restarting or stopped). |
| EP-608 | `core_timeout` | The core did not answer within nginx's 120 s. |

## Inside Zabbix (7xx)

| Code | What it means |
|---|---|
| EP-701 | The ElasticPro module is not paired with ElasticPro yet. |
| EP-702 | ElasticPro refused to sign this Zabbix user in. Its own code follows the reason. |
| EP-703 | ElasticPro lost the session three times in a minute and stopped retrying; usually the pairing secret differs. |
