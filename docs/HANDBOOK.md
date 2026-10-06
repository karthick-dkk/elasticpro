# ElasticPro — Windows desktop app

| | |
|---|---|
| **Title** | ElasticPro desktop (Tauri) — multi-cluster Elasticsearch dashboard with jump-host support |
| **Description** | A browser-extension Elasticsearch dashboard rebuilt as a portable Windows application. Same pages and features; plus its own SSH client for clusters behind a jump host, certificate trust decisions made in the app, and an OS-vault option for the credential. Read-only towards Elasticsearch. |
| **Date Published** | 2026-09-08 |
| **Tags** | elasticsearch, tauri, rust, windows, jump-host, ssh, tls-pinning, read-only |

## Summary

Everything the extension needed a browser for is now done by a small Rust core inside the
app, and the three things a browser could never do are the reason for the rewrite:

1. **Jump hosts.** A cluster marked `via: <jump>` in `clusters.yaml` is reached through an
   SSH connection the app opens itself with your key file — what `ssh -D` does, without
   ssh.exe, PuTTY or a SOCKS proxy to set up. Host keys are confirmed once and pinned.
   The connection reconnects by itself when the jump host drops it.
2. **Certificates you decide about.** A self-signed or internal-CA certificate the OS does
   not trust is shown to you once (subject, issuer, validity, SHA-256) with a *Trust* button.
   Accepting pins that exact certificate for that address; a different one later is refused
   and reported. No CA import, no browser policy, no click-through that does not apply.
3. **Exact errors.** Connection refused, DNS, timeout, TLS untrusted, pin mismatch, jump
   host down — each is named, with a one-line next step, instead of "Failed to fetch".

The read-only guard moved with it: the core sends GET/HEAD and search-family POSTs only,
whatever any page asks for, unless `readOnly: false` is set in the file.

Runs on the analyst workstation (tunnels to the jump host) **and** on the Windows jump
server itself (clusters direct, `via:` omitted) — same build, same YAML format.

## What is in the box

```
elasticpro-desktop/
├── crates/elasticpro-core/  Rust core: read-only guard, TLS pinning, SSH tunnels + SOCKS, HTTP, vault, message bridge
│   └── src/bin/bridge.rs    dev bridge: serves ui/ over HTTP and exposes the core — run the app in a browser for tests
├── src-tauri/               Tauri 2 shell: one `bridge` command, dialogs, icons, tauri.conf.json, capabilities
├── ui/                      the app UI (vanilla ES modules — the extension's pages, transport swapped)
├── lab/                     example clusters.yaml files used by the tests
└── .github/workflows/       CI: core tests on Linux, portable .exe + NSIS installer on Windows
```

Pages and features carried over: Clusters overview (disk, repo, ILM/SLM, last snapshot,
alerts), Indices with source/date picker, Live logs by day, Snapshots & SLM (from/to
availability), Nodes & shards, Config; auto-refresh off by default; one credential for all
URLs with a first-start prompt; snapshot-file mode. Clusters, jump hosts, credentials and
defaults are created and edited in the UI and saved as JSON with encrypted secrets; the
REST console is a request bar with **Query | Results** side by side and the history table
below (click a row to load, *Run* to re-run).

## Configuration — from the UI, or a file

Everything can be created and changed **in the app** (Config page: *+ Add cluster*, *+ Add
jump host*, *Store in config file (encrypted)…*, *Edit defaults…*; setup screen: *+ Create
new config*). The app writes `config_cluster.json` — in portable mode next to the exe under
`data\`, otherwise under `%APPDATA%`. A YAML file from the extension still opens unchanged;
the first edit from the UI is saved as `config_cluster.json` beside it.

**Secrets in the file are encrypted, not hashed.** A hash (SHA-512 or any other) cannot be
used to log in — Elasticsearch needs the real password on every request — so the file holds
`enc:v1:pbkdf2-sha512:…`: the password sealed with AES-256-GCM under a key derived from a
master password with PBKDF2-HMAC-SHA512 (600 000 rounds, random salt and nonce). The master
password is asked for on start (once per session) and never written anywhere; a wrong one is
rejected cleanly. Tick *Remember on this machine* in the sign-in dialog to skip the prompt
(the credential then lives in the Windows Credential Manager).

```json
{
  "version": 2,
  "credentials": { "username": "elastic", "password": "enc:v1:pbkdf2-sha512:600000:<salt>:<nonce>:<ciphertext>" },
  "defaults": { "readOnly": true, "autoRefresh": false, "logIndexPattern": "logstash-*", "tls": "auto" },
  "jump_hosts": { "jumpwin": { "host": "jump-windows.internal", "port": 22, "user": "elasticpro", "keyFile": "C:\\Users\\me\\.ssh\\id_ed25519" } },
  "clusters": [
    { "name": "acme-onprem", "url": "https://203.0.113.50:9200", "via": "jumpwin" },
    { "name": "prod-elk", "url": "https://es-prod-01.internal:9200" }
  ]
}
```

The same keys in YAML (the extension's format) are accepted as input:

```yaml
credentials: { username: elastic, password: "…" }     # or omit → the app asks once

jump_hosts:
  jumpwin:
    host: jump-windows.internal
    port: 22
    user: jump-user
    keyFile: C:\Users\me\.ssh\id_ed25519       # OpenSSH format; passphrase is asked for, never stored here

clusters:
  - { name: acme-onprem, url: "https://203.0.113.50:9200", via: jumpwin }   # through the jump host
  - { name: prod-elk,    url: "https://es-prod-01.internal:9200" }           # direct
  - { name: lab,         url: "http://192.168.10.25:9200", tls: insecure }
```

`tls:` per cluster (or under `defaults:`): `auto` (default — OS store, else ask once and pin),
`system` (OS store only, strict), `insecure` (lab only). Names of `via:` clusters are resolved
**on the jump host** (`socks5h` semantics), so use the address the jump host knows.

The app remembers the file's *path* (and `--config <path>` / `ELASTICPRO_CONFIG` pre-provisions
one, e.g. on the jump server). Contents are re-read on every start and on window focus when
the file changed.

## Steps to build

No Node.js is involved. Rust + the Tauri CLI, on Windows:

```powershell
# 1. Rust (MSVC toolchain) — https://rustup.rs ; and "Desktop development with C++" from
#    Visual Studio Build Tools (the linker). WebView2 Runtime is part of Windows 10/11 and
#    Server 2019+; on Windows Server 2016 install it once (Evergreen bootstrapper).
cargo install tauri-cli --version "^2" --locked
# 2. Build
cargo tauri build
#    portable:  target\release\elasticpro.exe          (single file; needs the WebView2 Runtime on the box)
#               packaged as elasticpro-<version>.exe by tools/build-windows-cross.sh
#    installer: target\release\bundle\nsis\ElasticPro_<ver>_x64-setup.exe  (per-user, embeds the WebView2 bootstrapper)
```

Or push to GitHub: `.github/workflows/build.yml` produces both as artifacts and
attaches them to `v*` tag releases.

**Or cross-compile from Linux with no Microsoft toolchain** — `tools/build-windows-cross.sh`
(Ubuntu 24.04: mingw-w64 linker, `x86_64-pc-windows-gnu` target, std built from source with
`-Zbuild-std`, idempotent). Output: `dist/ElasticPro-<ver>-portable-win64.zip` containing
`elasticpro-<version>.exe` + `WebView2Loader.dll` (this build loads the WebView2 loader dynamically,
so the DLL must stay next to the exe) + the example YAML. This is how the shipped portable
zip was produced; its core binary was exercised under Wine (SSH tunnel, TLS pinning, guard,
Credential Manager) — the WebView2 UI itself needs real Windows.

Linux/macOS builds work the same (`cargo tauri build`) with the platform's WebKit
dependencies; the Linux build was used to run the full app under Xvfb in the tests below.

## Portable mode (no install at all)

The portable zip carries a `portable` marker file: with it present, everything the app
stores — `pins.json`, the WebView profile, the remembered config path — lives in `data\`
next to the exe, and the only external need, the WebView2 runtime, can be satisfied by
unpacking Microsoft's **Fixed Version Runtime** (a plain folder, no installer, no admin)
into `WebView2Runtime\` beside the exe. The app sets `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`
and `WEBVIEW2_USER_DATA_FOLDER` itself before the WebView is created. Windows 10/11 and
Server 2019+ have WebView2 system-wide already; Windows Server 2016 needs the folder.
Delete the marker to go back to per-user storage under `%APPDATA%`.

## Steps to deploy

1. Put `elasticpro-<version>.exe` anywhere (no admin rights needed) — or run the installer.
2. Create `clusters.yaml` (Config page → *Save example YAML…*), keep it readable only by you.
3. Start the app, *Open clusters.yaml…*. For each jump host: confirm the host-key fingerprint
   once (compare with `ssh-keygen -lf` on the jump host). For each cluster with an untrusted
   certificate: *Trust this certificate* once. Both decisions land in
   `%APPDATA%\io.elasticpro.desktop\pins.json` — fingerprints only.
4. Optional: tick *Remember on this machine* in the sign-in dialog to keep the credential in
   the Windows Credential Manager (your account only) instead of typing it each start.

On the jump server itself: same exe, `clusters.yaml` without `via:`, optionally started as
`elasticpro-<version>.exe --config C:\elasticpro\clusters.yaml`.

## Fleet cache — the message contract

The core polls every cluster itself (`crates/elasticpro-core/src/fleet/`) and pages read what it
last found. One poller per core; every fetch is an ordinary `es_req`, so it takes the same
jump hosts, pins, credentials and read-only guard as a page, and shows up in
`REQUEST_STATS`. It only ever sends GETs. Started by `elasticpro-bridge` and the desktop shell;
`PING` says `fleetCache: true` when it is running — a UI that sees `false` (an older core)
asks the clusters directly, as before.

**Datasets** (`FLEET_STATE.catalogue` lists them with interval, class and the guest flag):
`health` (`/`, `/_cluster/health`, 180 s), `nodes` (300 s), `ilm_errors` (900 s), `policies`
(snapshot repos, SLM, ILM status and policies, `path.repo`, watermarks — 3600 s),
`ilm_assign` (the cluster's `logIndexPattern`, 3600 s), `snapshots` (`_cat/snapshots/<repo>`
per repo, 1800 s) — the background set, kept for every cluster; and `snapshots_full`
(verbose `_snapshot/<repo>/_all`, `_cat` fallback), `indices`, `shards` (+ tasks, thread
pools, pending tasks) — on demand, polled only while somebody asked in the last 15 minutes.
The request paths are the ones `ui/js/core/es.js` built, so the bodies are the same.

**Entry** (one dataset of one cluster):

```json
{ "status": "ok|error|never|restored", "fetchedAt": 1759150000000, "attemptedAt": 1759150000000,
  "nextDue": 1759150180000, "tookMs": 42, "staleAfterMs": 360000, "seq": 17,
  "error": null | { "kind": "tls_untrusted", "message": "…", "query": "health", "help": "…", "cert": {…}, "pinned": "…" },
  "data": null | { "<key>": { "ok": true, "status": 200, "kind": "ok", "message": "", "json": <raw ES body>, "tookMs": 12 } } }
```

`data` keys are the names `buildClusterData` uses (`root`, `health`, `nodes`, `alloc`, `ilmErr`,
`repos`, `slm`, `slmStatus`, `ilm`, `ilmPolicies`, `repoPaths`, `clusterSettings`, `ilmOfIndices`,
`indices`, `shards`, `tasks`, `threadPools`, `pendingTasks`); the snapshot datasets hold
`{"byRepo": {"<repo>": <answer + "source": "cat"|"verbose">}}`. One request answering with an
HTTP error is recorded in its own answer and the entry is still `ok`; a request that never
reached the cluster makes the entry `error`, and `data`/`fetchedAt` stay the **last good**
ones. `never` has `data: null` — unknown, not empty. `restored` came from the disk cache at
start-up and is being re-fetched. A failed request keeps what the direct passthrough says
about it — `help`, `detail`, `cert`, `pinned`, `tunnelKind`, `tunnel`, `hostKey` — in the
answer, in `error` and in `reach.lastError`, so the trust buttons work from the cache.

**Reach** per cluster, from `health` transport failures only:
`{ "state": "reachable|unreachable|unknown", "since", "lastError", "nextProbeAt", "failures", "seq" }`.
An unreachable cluster gets a health probe every 120 s ± 10 % and nothing else.

| Message | Role | Answer |
|---|---|---|
| `FLEET_STATE {since?, include?: [dataset…]}` | guest | `{ok, epoch, seq, now, running, full, catalogue, clusterIds: [visible ids], clusters: {id: {reach, datasets: {name: entry}}}}` — only clusters the caller may see; `include` defaults to the background set; with `since` only entries/reach whose `seq` is newer (a visible id with nothing listed has not changed). `epoch` names this run of the core: `seq` restarts from zero, so a stored epoch that differs means ask again without `since`. A full answer lists `never` for background datasets only. A guest gets `health` and `nodes` only — the datasets whose every request a guest's `ES` read would be allowed, so the two cannot disagree. |
| `CLUSTER_DATASET {clusterId, dataset, maxAgeSec?, wait?: true\|seconds}` | guest (gated per cluster like `ES`) | `{ok, clusterId, dataset, entry, reach, waited, timedOut}`. Fresh (`ok` and younger than `maxAgeSec`, default the interval) answers at once; otherwise fetched at priority 0, and `wait` holds up to 20 s. Concurrent askers share one fetch. Unreachable cluster: answers at once with what it has. `kind: "fleet_off"` when the poller is not running. |
| `REFRESH {clusterIds?: [..]\|"all", datasets?: [..]}` | user (each named cluster gated) | `{ok, queued, skipped: [{clusterId, dataset, reason: "rate_limited"\|"unreachable"}], running}`. Once per 10 s per person, cluster and dataset. |
| `EVENTS_TICKET` | guest | `{ok, ticket, expiresInSec: 60, path: "/events?ticket=…"}` — single use. |

`GET /events?ticket=…` (hosted bridge): server-sent events `dataset`
`{clusterId, dataset, seq, status, fetchedAt}` and `reach` `{clusterId, seq, reach}`, filtered
to the caller's clusters (guests: health/nodes only); first `hello` `{epoch, seq}`; `resync` `{epoch, seq}` when the stream fell behind
(fetch `FLEET_STATE` in full); `expired` then close when the session behind the ticket ended
(re-checked every 60 s). Keep-alive comment every 20 s; `X-Accel-Buffering: no`. The desktop
app has no socket and polls `FLEET_STATE {since}` instead.

A write that went through (`ES`, non-read, ok) queues the datasets it changes at priority 0,
3 s later: `_snapshot` → snapshots, snapshots_full, policies; `_slm`/`_ilm` → policies,
ilm_errors (an SLM `_execute` also snapshots, snapshots_full); `_cluster/settings` → policies; `_cluster/reroute` → shards, nodes; an index →
indices, shards, health (+ ilm_assign for `_settings`).

**Environment:** `ELASTICPRO_POLL_HEALTH_SECS` (180, clamped 180–300), `ELASTICPRO_POLL_CONCURRENCY`
(16 fetches at once; 2 per cluster, 6 per jump host), `ELASTICPRO_CACHE_MB` (256, on-demand bodies,
LRU), `ELASTICPRO_ES_CONCURRENCY` (32 ES requests open at once from any source; 8 per cluster, 16
per jump host), `ELASTICPRO_REDIS_URL` (hosted only, optional: write-through to
`elasticpro:ds:{cluster}:{dataset}` with `EX` 3× interval and a note on `elasticpro:updates`; down ⇒ one
log line a minute and nothing else). The disk copy is `<data dir>/cache/<cluster>/<dataset>.json`
(`.json.gz` over 64 KB), 0600, good entries only, and follows the configured clusters.
Idle rule: nothing asked `FLEET_STATE`/`CLUSTER_DATASET`/events for 10 minutes ⇒ only health is polled.

**Zabbix clusters** are in the poller like any other: `all_specs()` is the Zabbix sync's
clusters first, then the primed ones, so a host added in Zabbix is polled from the sync that
finds it. A page follows: when `clusterIds` names a cluster it does not have, or stops naming a
Zabbix one it shows, it re-reads `ZABBIX_CLUSTERS` once per difference (`zabbixDrift`,
`ui/js/core/config.js`). Inside the Zabbix frame the session is the `SSO_EXCHANGE` one, so
`FLEET_STATE`, `EVENTS_TICKET` and the stream are scoped by the person's Zabbix user groups;
`/events` goes from the frame to ElasticPro's nginx, not through Zabbix
(`deploy/zabbix/README.md`, "the fleet cache, live updates, task cards").

## Notification history — the message contract

The bell keeps every notice in the browser (`localStorage`, last 50), and — when `PING` says
`notifyStore: true` — also on the core, per person, for `notifyDays` days (`ELASTICPRO_NOTIFY_DAYS`,
default 30, 1–3650). File: `<data dir>/notifications.json`, 0600, written by tmp + rename at
most once every 750 ms; no data dir ⇒ kept in memory for the life of the process. Older than
the retention is dropped on load, on every write and from every answer; past 2000 per person
the oldest go. The owner is always the caller — a signed-in session's user, a proxy user, an
API token's `token:…` name, or `local` on the portable build — and is never read from the
message, so nobody sees or clears anyone else's. These are not writes to a cluster: no
`WRITE_UNLOCK`, no read-only guard. Without a session on an edition with accounts they
answer `unauthenticated`, like every other message; an account still on its first
(per-install, `<data dir>/initial-admin-password`) password gets `must_change_password`.

| Message | Role | Answer |
|---|---|---|
| `NOTIFY_PUT {id?, message, kind, detail?: [string], meta?, cluster?, at?}` | guest | `{ok, id}`. Upserts by (caller, `id`), so a task's `run` then `ok`/`err` under one key stays one record; no `id` ⇒ one is generated. `kind` ∈ `ok\|err\|warn\|run`; `message` 1–2000 chars; `detail` ≤ 40 lines (each cut at 1000); `meta` cut at 500; `cluster` is a cluster id (cut at 200); `id` ≤ 128 of `[A-Za-z0-9._:-]`; `at` ms, clamped to now (defaults to now). Anything else ⇒ `{ok: false, kind: "bad_message", message}`. |
| `NOTIFY_LIST {since?, before?, limit?}` | guest | `{ok, items: [{id, message, kind, detail, meta, cluster?, at, updatedAt}], more, days}` — the caller's own, newest `at` first. `since`: only records changed (`updatedAt`) after it; `before`: only records with `at` before it (the "Load more" cursor); `limit` default 100, max 500; `more` says the page was cut. A scoped caller (Zabbix group scope) gets only records whose `cluster` is one they can see now — the same check `FLEET_STATE` uses — and every record with no cluster. |
| `NOTIFY_CLEAR` | guest | `{ok, removed}` — every record of the caller's, nobody else's. |

The UI sends `NOTIFY_PUT` fire-and-forget for every notice it shows (a task's silent progress
ticks only when their kind changes), merges `NOTIFY_LIST` with its local copy when the bell
opens (same key/id ⇒ the server's record wins), and sends `NOTIFY_CLEAR` with "Clear all".
An older core, a snapshot file or a `file://` render has no store and the bell stays local.

## Zabbix connection — the message contract

Hosted edition only (every other edition answers `{ok: false, kind: "not_supported", supported: false}`
and `POST /zabbix/pair` is 404). The ElasticPro side of the Zabbix integration — Zabbix URL,
API URL, API token, TLS verification, allowed sources, sync interval, and the sign-in secret the
module signs with — is set from **Config → Zabbix** and kept in `<data dir>/zabbix-link.json`
(mode 0600 from creation, written tmp + fsync + rename). Code: `crates/elasticpro-core/src/zbx_link.rs`.

**Precedence.** The server's own settings win field by field, through one resolution function
(`zbx_link::resolve`); the UI shows those fields read-only as *managed by server config*, and
`ZABBIX_LINK_SET` refuses them.

| Field | Server setting (wins) | Default |
|---|---|---|
| `zabbixUrl` | `ELASTICPRO_ZABBIX_URL` | — |
| `apiUrl` | `ELASTICPRO_ZABBIX_API_URL` | `zabbixUrl` + `/api_jsonrpc.php` |
| `apiToken` | `ELASTICPRO_ZABBIX_API_TOKEN_FILE` | — |
| `ssoSecret` | `ELASTICPRO_ZABBIX_SSO_SECRET`, `ELASTICPRO_ZABBIX_SSO_SECRET_FILE` | — (only a pairing sets it) |
| `verifyTls` | `ELASTICPRO_ZABBIX_API_INSECURE=1` ⇒ false | true |
| `allowedSources` | `ELASTICPRO_ZABBIX_ALLOWED_SOURCES` (comma/space list) | empty = any source |
| `syncSecs` | `ELASTICPRO_ZABBIX_SYNC_SECS` | 300 (30–86400) |
| CSP `frame-ancestors` | `ELASTICPRO_FRAME_ANCESTORS` (the source list, verbatim) | the `zabbixUrl` origin while a sign-in secret is set, else `'none'` |
| pairing callback address | `ELASTICPRO_PUBLIC_URL` | the admin's browser address (`epUrl`) |
| trusted proxies for `X-Real-IP` | `ELASTICPRO_TRUSTED_PROXIES` (IPs/CIDRs) | unset = believe any peer's header (the `X-Auth-User` trust model) |

`ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` (default `Elasticsearch Cluster by HTTP EP`) and the write
token (`ELASTICPRO_ZABBIX_API_WRITE_TOKEN_FILE`) stay server-only. The template name is a setting
so that a Zabbix which already carries the template under another name is pointed at, rather
than renamed to suit us. TLS to Zabbix uses the same trust as clusters: the OS store plus a SHA-256 pin made
with `TRUST_CERT` (Config → Zabbix → Test connection shows the certificate); `verifyTls: false`
accepts anything and is for a lab.

**Messages** — all admin only; without a session `unauthenticated`, below admin `forbidden`.
No answer ever contains the API token or the sign-in secret: the status carries presence flags.
`ZABBIX_LINK_SET`, `ZABBIX_PAIR_BEGIN` and `ZABBIX_UNPAIR` are audit-logged with the user (bridge
audit line), and every change, refusal and pairing attempt is also an `events` entry (last 30
kept in the file, last 10 in the status) and a `target: "audit"` line `zabbix link`.

| Message | Answer |
|---|---|
| `ZABBIX_LINK_GET` | `{ok, supported, zabbixUrl, apiUrl, apiUrlIsDefault, verifyTls, allowHttp, allowedSources, syncSecs, managed: {<field>: bool}, apiToken: {set, source: "server"\|"ui"\|"", at, by}, ssoSecret: {set, source}, paired, pairedAt, pairedBy, zabbixVersion, pending: {exp, zabbixUrl, by}\|null, frameAncestors, publicUrl, signIn, sync: {configured, lastOk, error, clusters, skipped}, events: [{at, by, action, ok, detail, source?}]}` (times in unix seconds) |
| `ZABBIX_LINK_SET {zabbixUrl?, apiUrl?, apiToken?, verifyTls?, allowedSources?, syncSecs?, allowHttp?}` | the status plus `changed: [field]`. Absent keeps a field; `null`/`""` clears it. URLs: absolute https (http only with `allowHttp: true` — shown as a warning), no credentials, no query/fragment. Token: 16–512 of `[A-Za-z0-9-._~+/=]`. Sources: IPv4/IPv6 or CIDR, ≤ 64. Any other key (e.g. `ssoSecret`) or a server-managed field ⇒ `{ok: false, kind: "bad_request", message}`. A change to the API side rebuilds the client and starts a sync. |
| `ZABBIX_LINK_TEST` | `apiinfo.version` without a token, then `template.get` for the cluster template with it: `{ok: true, version, authOk, template: {name, found}, message, apiUrl}` or `{ok: false, kind, message, version?, cert?, pinned?}` with `kind` ∈ `dns, timeout, connection_refused, tls_untrusted, tls_pin_mismatch, tls_error, network, http_error, not_zabbix, auth, no_token, zabbix_error, not_configured`. For `tls_*`, `cert` is the certificate seen (`{host, sha256, subject, issuer, not_before, not_after, self_signed, sans}`) — trust it with `TRUST_CERT {host, sha256}`. |
| `ZABBIX_PAIR_BEGIN {zabbixUrl, epUrl}` | `{ok, code, exp, ttlSecs: 900, zabbixUrl, epUrl, pasteAt}` — the pairing code, shown once. A new BEGIN replaces an unfinished pairing. Refused while the sign-in secret is server-managed (pairing would be overridden by it). |
| `ZABBIX_UNPAIR` | the status. Wipes the stored API token and sign-in secret (and any pending pairing); server-managed ones stay in force. Sign-in stops at once when no secret remains, and Zabbix clusters are dropped when no API is left. |

**The pairing code** is `base64url(JSON)` — URL-safe alphabet, **unpadded** (decoders should
accept padding too) — of:

```json
{"v":1,"ep":"https://ep.example.com","secret":"<43 chars>","nonce":"<32 hex>","exp":1790000900}
```

`ep` is where the module calls back (it appends `/zabbix/pair`, as it appends `/sso/zabbix` for
sign-in); `secret` is 32 random bytes as base64url (43 characters); `nonce` is single-use;
`exp` is unix seconds, 15 minutes after BEGIN. The HMAC key is the `secret` **string exactly as
it appears in the code** (its ASCII bytes — not base64-decoded), the same way the module's
`module_secret` has always been used for `/sso/zabbix`. After a successful pairing that same
string is the sign-in secret.

**`POST /zabbix/pair`** (module → core, over nginx or directly on `ep_sso`):

- Header `X-Zabbix-Module-Signature: <lowercase hex HMAC-SHA256(secret, raw body bytes)>` — the
  exact scheme and the same helper (`ZabbixSso::sign` / `ZabbixSso::signature_ok`) as `/sso/zabbix`.
  The signature covers the bytes sent; the core never re-serialises before checking.
- Body (JSON, `Content-Type: application/json`, ≤ 64 KiB; unknown fields are ignored):

  ```json
  {"nonce":"<nonce from the code>","zabbixUrl":"https://zbx.example.com","apiUrl":"https://zbx.example.com/api_jsonrpc.php",
   "apiToken":"<64 hex>","zabbixVersion":"7.0.5","ts":1790000123}
  ```

  `ts` is unix seconds (integer). `zabbixVersion` may be empty.
- Computing it (PHP, as the module does for sign-in):
  `$body = json_encode($payload); $sig = hash_hmac('sha256', $body, $code['secret']);` then post
  `$body` with `X-Zabbix-Module-Signature: $sig`. Shell: `printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1`.
- Checks, in order: source in `allowedSources` (if set) → per-source rate (10/min in the core,
  plus nginx) → a pairing is pending → signature (before the body is parsed) → `ts` within 60 s →
  not replayed (signature seen in the last ~2 min) → `nonce` matches → not expired → `zabbixUrl`
  has the same origin (scheme, host, port) as the BEGIN `zabbixUrl` → `apiUrl` is https (http only
  when the pairing was for an http Zabbix or `allowHttp` is on) → `apiToken` well-formed.
- Answers: `200 {ok: true, epVersion}`. `403 {ok:false, kind:"forbidden"}` (source),
  `429 {kind:"rate_limited"}`, and `401` for everything else: `kind: "unauthorized"`, message
  `pairing refused`, whenever the signature has not been verified (no pairing, expired-and-gone,
  bad or missing signature) — nothing about why; after a verified signature the `kind` says why:
  `stale`, `replayed`, `nonce_mismatch`, `expired`, `origin_mismatch`, `bad_request`. Every
  failure is audited with the source address.
- On success: the token and API URL are stored, the pending secret becomes the sign-in secret,
  `pairedAt`/`pairedBy` (the admin who began it) and `zabbixVersion` are recorded, the nonce is
  spent, and a sync starts. **Until that moment the previous secret keeps verifying `/sso/zabbix`**,
  so re-pairing causes no sign-in outage; afterwards the old secret stops working.

`/sso/zabbix` itself is unchanged on the wire; its secret now comes from the resolution function,
and it also honours `allowedSources` (403) and a per-source budget of 120/min (429). The source is
`X-Real-IP` (set by our nginx) — believed from any peer unless `ELASTICPRO_TRUSTED_PROXIES` names the
proxies — else the TCP peer.

**Framing.** The core sets `Content-Security-Policy: frame-ancestors …` on every response;
nginx no longer sets one (a second CSP header would be enforced too and override the pairing).
nginx forwards exactly `location = /sso/zabbix` and `location = /zabbix/pair` to the core, with
`X-Real-IP`, a 64 KiB body cap and `limit_req` (60 r/m burst 30 and 10 r/m burst 5); every other
path under `/sso/` is still 404.

## Security model

| | |
|---|---|
| Elasticsearch writes | while `readOnly: true` (default) the core refuses anything but GET/HEAD and `_search`-family POSTs, before opening a socket. Two deliberate acts lift it: `readOnly: false` in the config (everywhere), or ticking *Allow writes* — a session-only unlock, held in memory, that applies **only** to actions the operator takes by hand (a console request, a snapshot, an index action). Background refreshes stay read-only either way |
| Credential | in the app process; optionally in the OS vault (opt-in). Never in `pins.json`, never in logs. The YAML is the only file that may hold it |
| Jump host | your SSH key (OpenSSH format, optional passphrase — asked in the app) or a session password; host key TOFU + pin; a key restricted to `restrict,port-forwarding,permitopen="<cluster>:9200"` is enough — the app only forwards to the cluster ports |
| TLS | rustls; OS trust store + Mozilla roots; per-address SHA-256 pin on explicit consent; pin mismatch → credential not sent |
| SOCKS listener | loopback only, ephemeral port, accepts loopback peers only, CONNECT only — nothing else on the machine is told about it |
| Data written by the app | `pins.json`, the remembered config path, theme, console history |

## Verified (what the tests actually exercised)

Against a local restricted `sshd` (`restrict,port-forwarding,permitopen="*:9470"`) and an
80-cluster mock Elasticsearch fixture on `https://127.0.0.1:9470/c<N>` — a multi-cluster TLS
endpoint that is not part of this repository, so these figures cannot be reproduced from a
clone alone (see `lab/README.md`):

- unknown host key → prompt → trust → tunnel up; key mismatch refused; ed25519 and RSA keys
  (RSA signed with SHA-512, as OpenSSH 8.8+ requires); encrypted key → passphrase prompt →
  wrong passphrase reported as such → right one connects
- SSH session killed server-side → next request reconnects transparently (~100 ms);
  sshd stopped → clear "cannot reach jump host … connection refused" → recovers when back
- `permitopen` refusal reported as a forward error, other clusters unaffected
- certificate untrusted → prompt → trust → OK; server certificate rotated → pin mismatch,
  credential not sent; untrust + trust new → OK; `tls: system` strict fails, `insecure` passes
- read-only guard: DELETE/PUT/other POST blocked, `_search` POST allowed; 20 concurrent
  requests through one tunnel in 0.36 s
- the write unlock: a write is refused with the unlock off, accepted with it on, and still
  refused for a request the operator did not ask for — checked against a server that counts
  TCP accepts, so "refused before a socket is opened" is measured, not asserted. The same
  test covers every snapshot, repository, SLM and index-management call the UI makes
- every page rendered against the real core in jsdom (`tools/render-check.mjs`), and the
  config reload path driven end to end with a sealed credential
- the full UI (all 7 pages) in a browser through the dev bridge, and the real Tauri app on
  Linux under Xvfb: config → tunnel → trust prompts → 3/3 clusters online
- the Windows (mingw) build of the core under Wine: same tunnel / pin / guard flow, plus
  VAULT_SET/GET/DEL against the Windows Credential Manager API. The WebView2 window cannot
  run under Wine, so the GUI on real Windows is the one step not exercised here.

## Recommendation

- Use `tls: system` for clusters whose CA you did install; `auto` for the self-signed ones.
- One `jump_hosts:` entry per jump host, not per cluster — the SSH session is shared.
- Keep the jump-host key restricted (`restrict,port-forwarding,permitopen`) — `lab/README.md`
  has the exact `authorized_keys` line the tests run against; the app needs nothing more.
- Leave `readOnly: true`. When you do need to write, tick *Allow writes* on the page you are
  working from rather than flipping the file: the unlock covers only the actions you take by
  hand, is forgotten when the app closes, and leaves every automatic refresh read-only.
  Reserve `readOnly: false` for a machine whose whole purpose is administration.

## Reference links and other docs

- `lab/README.md` — the restricted jump-host account, its `permitopen` key, and the single-cluster
  mock the repository does ship.
- Tauri 2: https://tauri.app — WebView2 on Windows Server 2016 needs the Evergreen runtime.
- russh (SSH client), rustls (TLS), reqwest (HTTP), keyring (Windows Credential Manager).
