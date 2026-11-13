# ElasticPro — operator handbook

> **Deprecated as of 0.3.52: the Windows / desktop builds.** Only the hosted Docker build and the
> Zabbix modules are maintained. The desktop sections below (steps to build, the Windows
> cross-build, portable mode) describe 0.3.51 and are kept for reference only: `src-tauri/`,
> `tools/build-windows-cross.sh` and the portable-mode files were removed from the tree in 0.3.54.
> Check out the [v0.3.51](https://github.com/karthick-dkk/elasticpro/releases/tag/v0.3.51) tag to see or rebuild them.

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
├── src-tauri/               (removed in 0.3.54) Tauri 2 shell: one `bridge` command, dialogs, icons, tauri.conf.json, capabilities
├── ui/                      the app UI (vanilla ES modules — the extension's pages, transport swapped)
├── lab/                     example clusters.yaml files used by the tests
└── .github/workflows/       CI: core tests on Linux, portable .exe + NSIS installer on Windows
```

Pages and features carried over: Clusters overview (disk, repo, ILM/SLM, last snapshot,
alerts), Indices with source/date picker, Live logs by day, Snapshots (from/to
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
`system` (OS store only, strict), `insecure` (lab only).

`defaults: { tls: insecure }` (Config → Defaults → Certificates) is one switch for everything:
every cluster whatever its own `tls:`, every jump host's SSH key, and the Zabbix API certificate
are accepted without checking. Nothing is pinned by it, so setting it back to `auto` brings the
checks back. What it let through that would otherwise have stopped is listed in one notification
and on Config → Jump hosts & trust. On the hosted build the core reads the switch from its own
config file, never from a page. Names of `via:` clusters are resolved
**on the jump host** (`socks5h` semantics), so use the address the jump host knows.

The app remembers the file's *path* (and `--config <path>` / `ELASTICPRO_CONFIG` pre-provisions
one, e.g. on the jump server). Contents are re-read on every start and on window focus when
the file changed.

## Steps to build (deprecated: desktop, last released in 0.3.51)

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

## Portable mode (no install at all) — deprecated, desktop ended with 0.3.51

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

The core fetches from the clusters itself (`crates/elasticpro-core/src/fleet/`) — on a schedule, or
only when a page asks, as the request policy says (the shipped one, Client basis, is the latter) —
and pages read what it last found. One poller per core; every fetch is an ordinary `es_req`, so it takes the same
jump hosts, pins, credentials and read-only guard as a page, and shows up in
`REQUEST_STATS`. It only ever sends GETs. Started by `elasticpro-bridge` and the desktop shell;
`PING` says `fleetCache: true` when it is running — a UI that sees `false` (an older core)
asks the clusters directly, as before.

**Datasets** (`FLEET_STATE.catalogue` lists them with interval, class and the guest flag):
`health` (`/`, `/_cluster/health`, 180 s), `nodes` (300 s), `ilm_errors` (900 s), `policies`
(snapshot repos, SLM, ILM status and policies, `path.repo`, watermarks — 3600 s),
`ilm_assign` (the cluster's `logIndexPattern`, 3600 s), `snapshots` (`_cat/snapshots/<repo>`
per repo, 1800 s), `snapshot_status` (`/_snapshot/_status` with a `filter_path`, one request,
only the snapshots in progress, 300 s — see "Snapshot running" below) — the background set,
kept for every cluster; and `snapshots_full`
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
(unset: the request policy decides, 4 fetches at once and 1 per cluster under the shipped Client basis, 16 and 2 under Automatic/Background; 6 per jump host; set, it wins over every preset), `ELASTICPRO_CACHE_MB` (unset: a
quarter of the container's memory limit, or 256 without one; every cached body counts, on-demand
ones evicted first, health never — see `memory.rs`), `ELASTICPRO_ES_CONCURRENCY` (24 ES requests open at once from any source; 4 per cluster, 8
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
A Zabbix cluster edited in ElasticPro is polled as edited — name, route, certificate setting,
switched off, its own credential (*Zabbix clusters edited in ElasticPro*, below).

## Request management — the message contract

Everything the core sends to a cluster goes through one path (`es_req`), so one record, one
policy and one cap cover the poller and the pages alike. `docs/` for the plan; `fleet/policy.rs`,
`fleet/scheduler.rs` and `bridge.rs` for the code.

**The request log.** Every request is recorded — id, cluster, origin, who asked, method, path,
started, ms, ok, status, via — in flight in a map (at most 1,000) and the last 2,000 finished in a
ring. Each carries `X-Opaque-Id: elasticpro/<install>/<origin>/<cluster>/<n>` (under 256 bytes),
so a query of ours can be found in a cluster's `_tasks` and told from everyone else's. Origins:
`page:<id>`, `console`, `poller:<key>`, `delay-sink`, `core`.

**The policy** lives in `<data dir>/policy.json`, read once at start. With no file the core runs the
shipped policy, **Client basis**: mode `on-demand`, `perCluster: 1`, `global: 4`, the intervals
below. `ELASTICPRO_POLL_HEALTH_SECS` and `ELASTICPRO_POLL_CONCURRENCY` still win where they name a
value. A file somebody saved is read as it is and never rewritten, and a field it leaves out takes
the classic value (`mode: auto`, `perCluster: 2`, `global: 16`) — so a policy written before Client
basis became the default means what it meant. A file that does not parse is logged and ignored.
It is written whole and 0600 by `POLICY_SET`, applied to the scheduler on its next tick. The
classic policy, which is what Config → Requests → Automatic saves:

```json
{ "mode": "auto",
  "intervalsSec": { "health": 180, "nodes": 300, "ilm_errors": 900, "policies": 3600, "ilm_assign": 3600,
                    "snapshots": 1800, "snapshots_full": 1800, "indices": 600, "shards": 300 },
  "watchMinutes": 15,
  "concurrency": { "global": 16, "perCluster": 2, "tunnel": 6 },
  "timeoutMs": 30000, "tunnelTimeoutMs": 60000,
  "budgetPerClusterPerMin": 30,
  "paused": { "all": false },
  "minGapSec": 60,
  "play": { "healthSec": 300, "nodesSec": 300, "lifecycleSec": 14400, "snapshotsSec": 7200,
            "indicesSec": 3600, "delayFullSec": 7200, "delayLateSec": 900 } }
```

**Duplicate requests** (`minGapSec`, Config › Requests › Duplicate requests; 30–600 s, shipped
60). A request ElasticPro sends by itself — a page loading, Play, Retry or Refresh, the poller, a
dataset ask — is not sent again while the same request was answered by the cluster less than the
gap ago: the asker gets that reading, with its age, and the next request goes once the gap has
passed (an ask waiting meanwhile goes then). "The same request" is the same cluster and dataset
for the fleet cache (`scheduler::State::gap_until`: the planner, `CLUSTER_DATASET` and `REFRESH`
all ask it — a `REFRESH` inside the gap is skipped with `reason: "recent"` and `nextAt`), and for a
page's own read the same cluster, address, method, path, body and credential (the read cache,
`Core::es_req`; GET and HEAD, as the read cache keeps, and an answer it can keep — at most 4 MB).
What a write changed is re-read at once, never held. Askers for a request already on its way
share it — always on (`inflight::Flights` for a page's reads, one fetch per dataset in the
scheduler). The gap is a floor for every automatic read: `ES_READ_CACHE_SECONDS=0` turns off the
read cache's own few seconds, not the gap, so a page's repeat read inside the gap is still that
reading; only a failed answer (anything but `ok`) is never held. Never held, sent at once and
never shared, by the `purpose` the page names on its `ES` message (`fleet::policy::GAP_EXEMPT`,
never guessed from a path): the REST console (`console`; also by its origin). That is the only
request a person types that goes to a cluster as typed — the Indices and Snapshots page searches
match their term in the browser, over listings read like any page's (held and shared like
them). A display link's `purpose` is ignored and an origin of its own other than `page:…` is
read as `page:play`, so a TV is never taken for a person typing. The clock is the wall's: a
reading stamped later than now (the clock stepped back) holds nothing. Pages stamp a reading
with the cluster's time, not the time it was handed over (`EsClient.readingSince`), so a held
reading never reads as fresh.

**While Play runs** (`play`, Config › Requests › While Play runs): what Play keeps going for every
display — health 5 min, nodes 5 min, SLM/ILM 4 h, snapshots 2 h, the index list 1 h, the log
delay's full check 2 h and its late devices 15 min (docs/PLAY.md). Play says what it shows with
`REFRESH {…, watcher: "play"}`; the scheduler keeps watchers per dataset and the effective interval
is the soonest of them — the schedule (background), a page watching (the watch window, the
policy's `intervalsSec`), a Play display (`play`) — floored by the gap. Bounds: health and nodes
60–3600 s, SLM/ILM 900 s–1 day, snapshots 600 s–1 day, index list 300 s–1 day, full check
1800 s–1 day, late devices 300–7200 s and never slower than the full check.

**config.txt locks them**: `POLL_MIN_GAP_SECONDS`, `POLL_PLAY_HEALTH_SECONDS`,
`POLL_PLAY_NODES_SECONDS`, `POLL_PLAY_LIFECYCLE_SECONDS`, `POLL_PLAY_SNAPSHOTS_SECONDS`,
`POLL_PLAY_INDICES_SECONDS`, `POLL_PLAY_DELAY_FULL_SECONDS`, `POLL_PLAY_DELAY_LATE_SECONDS` (same
bounds). A key with a value wins over policy.json, the field reads "managed by config.txt (KEY)"
on Config › Requests, and `POLICY_SET` refuses another value for it (`kind: "managed"`); sent with
config.txt's value, or left out, it is accepted. policy.json keeps its own value, which comes back
when the key is taken out.

Modes: `on-demand` is the shipped default (Client basis, below). `auto` is `background` while the core knows 25 clusters or fewer
and `hybrid` above — measured at 120 clusters, background sent ~397 requests/min and auto ~80;
`FLEET_STATE.policy` and `POLICY_*` report `mode` and `resolvedMode`. `background` keeps the fleet fresh on the core's schedule; `hybrid` polls health only and
fetches everything else while a page looks at it (the watch window); `on-demand` fetches nothing
on its own — a page's `CLUSTER_DATASET` or `REFRESH` is what sends a request, for that cluster
only, and with `perCluster: 1` one request at a time; a `REFRESH` also keeps what it named fresh for
the watch window. The pages that show a fleet (Clusters, Alerts, Nodes & shards, Snapshots) send
that `REFRESH` when they open. To go back to keeping the fleet fresh in the background: Config →
Requests → Automatic or Background. Emergency stop (`paused: {all: true, minutes: 15|30|60}`,
Request Centre): nothing new starts (a person's ask stays pending and runs when it ends); in flight
finishes. An operator begins and ends it as an admin does — `POLICY_PAUSE` / `POLICY_RESUME`,
which change the stop and nothing else; the rest of the policy stays `POLICY_SET`'s, an admin's,
and `POLICY_SET` ignores `paused` (it never begins, changes or lifts a stop).
The stop holds every cluster (there is no per-cluster stop), so an operator limited to some
clusters by Zabbix host groups is refused it, as Play refuses its fleet-wide messages to a limited
caller; an admin is not, since the rest of the policy, which reaches every cluster too, is theirs anyway. A display link never gets it. The server stamps `since`, `until` and `by`, and lifts the stop itself at `until`; a stop
with no `until` (a pause from before 0.3.44) is dropped when the file is read, and asking for a stop
while one holds keeps the one in force. Slow and busy clusters
need no stop: a request over 8 s, a timeout or a 429 marks a cluster slowed (one request at a time,
intervals ×2 per occurrence up to 10 min, pages handed the held copy; three quick answers end it),
and while the gate's queue is half full or a request has waited 5 s the poller's own work holds so
people go first. A page is never held more than 10 s (`CLUSTER_DATASET` `wait`). Bounds: health ≥ 60 s, other
intervals ≥ 30 s, ≤ 1 day; watch 1–240 min; global 1–256; perCluster 1–8; tunnel 1–32; timeouts
1–600 s; budget ≤ 10,000 (0 = none). The budget is soft: beyond it the cluster's due fetches wait
for the minute to pass, a person's ask still goes. A 429 or a timeout backs a cluster off for a
minute, doubling to ten, until it answers. `FLEET_STATE` reports `policy: {mode, pausedAll,
pausedSince, pausedUntil, pausedBy}`, `automation: {busySince, slowed: {cluster: {since, reason,
level, quick}}}`, each catalogue entry's `effectiveClass` under the mode, and per cluster a
`throttle: {kind: budget|backoff, until, reason, level}` and `slowed` while one is in force.
`REQUEST_LOG` carries `throttled`, `slowed` and `busySince` for the Request Centre, and `asks`:
what the gap saved over the last hour (rolling, by the minute) — `{windowMinutes: 60, gapSec,
since, byDataset: {<dataset>|direct: {asked, sent, recent, shared, held}}}`, where every ask is
exactly one of sent (a request went), recent (a reading inside the gap), shared (one already on its
way) or held (fresh enough for the asker anyway, or the cluster is down); `direct` is the pages'
own reads. The Request Centre's **Duplicate requests** card reads it: "health: asked 42 this hour,
sent 12, 30 answered from a reading under a minute old".

| Message | Role | Answer |
|---|---|---|
| `REQUEST_STATS` | user | `{ok, requests: {cluster: {last5m, perMinute, …}}}` — the strip's "Requests N in 5m". |
| `REQUEST_LOG {cluster?, limit?}` | admin | `{ok, inflight: [record…], recent: [record…], keep, throttled: {cluster: throttle}}` — every user's requests on the clusters the caller may see, newest first, `limit` ≤ 2,000 (default 200). `gate` carries the request gate's figures (running and queued per class, waits, `refused`, `tooLarge`: answers over the response cap in the window, not counted as refused) and `zabbixPush`: `{enabled, host, idle, intervalSecs, credential: "link"\|"metrics", lastOkAt, lastAttemptAt, pushes, failures, consecutiveFailures, lastError, nextAt}` (`lastError` only for an admin who sees every cluster; never a token). |
| `SYSTEM_HEALTH` | admin | ElasticPro's own health (docs/HEALTH.md, "As built" has the full shape): `{ok, at, role, level: ok\|warn\|bad, thresholds, checks: [{id, label, level, value, text, fix}], parts: [{id, label, level, text, at}], core: {memory, cpu, budget, messages, gate, poller, disk, lastPrune}, worker: {state, level, text, status}, reports, trends}`. Every figure is the core's own state, the worker's `worker/status.json` or the data volume — never a cluster request. A figure that cannot be read is `null` / *not known*. Per-cluster gate rows only for the caller's clusters. `PING` carries `health` (`ok`/`warn`/`bad`) for an administrator. |
| `POLICY_GET` | user | `{ok, policy, defaults, effective: {dataset: background|onDemand}, resolvedMode, stored, warning?, running, gate, pollConcurrencyEnv, managed, gapExempt, gapBounds, playBounds}` — `pollConcurrencyEnv` is `ELASTICPRO_POLL_CONCURRENCY` as read, or null when unset; `policy` as it runs (config.txt's values in); `managed` `{field: config.txt key}` for `minGapSec` and `play.<field>` |
| `POLICY_SET {policy}` | admin | the same, plus `saved`; `bad_request` when it does not parse (an unknown `mode`, a non-object); `managed` when it names a field config.txt locks with another value. Values out of bounds are bounded, not refused. `paused` is ignored: the stop in force is kept as it is (only `POLICY_PAUSE` / `POLICY_RESUME` change it), so a form opened before a stop began never lifts it. Audited. |
| `POLICY_PAUSE {minutes}` | operator | the emergency stop begun for 15, 30 or 60 minutes and nothing else changed; answered like `POLICY_SET`. A stop asked for while one holds keeps the one in force (not lengthened). `bad_request` for any other length or for a message carrying a `policy`; `forbidden` for an operator limited to some clusters. Audited (activity `policy_pause`, category configuration; `audit` line with the user). |
| `POLICY_RESUME` | operator | the stop ended (harmless when none holds), nothing else changed; the same refusals and audit (`policy_resume`). |
| `ABORT_REQUESTS {origin}` | user | `{ok, aborted: n}` — the caller's own in-flight requests from a `page:<id>` or `console` origin stop waiting and answer `kind: aborted` (recorded so); keyed by person + origin, so nobody reaches another's; the poller's and the schedules' are refused (`bad_request`). Nothing is sent to the cluster: a search already running there is what `_tasks` and its `_cancel` are for. |

**Cancelling a task** is `ES POST /_tasks/<node:id>/_cancel` with `allowWrites`: a write under
both gates (`Writes::decide` — the config must permit writes or the session be unlocked, *and*
the operator asked by hand), audited by the hosted bridge like every write, carrying the page's
opaque id. `GET _tasks` needs the `monitor` privilege and `_cancel` the `manage` one; a credential
without it gets the cluster's 403 and the page says so instead of failing on the click.

## Alerts — tuning and silences

`alerts()` (`ui/js/core/state.js`) raises what every rule sees; `tuneAlerts()`
(`ui/js/core/alert-tuning.js`) decides what is shown and counted, only by removing a row that
repeats another or by saying more about one:

| Situation | Before | Now |
|---|---|---|
| A node at the flood stage / high watermark | node-level balance row + cluster-average disk row | one row, the average folded in |
| Health yellow with unassigned shards | health row + balance row "N shards unassigned" | the health row |
| A failing or stale repository | repo row + one row per SLM policy writing to it | the repo row |
| SLM stopped | slm-mode row + "no recent success" per policy | the slm-mode row |
| Many field-volume spikes on a cluster | one row per field/term | one row with the count |
| A reading older than its dataset allows | shown as current | same level, detail says how old |

Rules: disk has hysteresis (raised at the threshold, cleared 2 points below); a snapshot
repository is critical when two or more runs in a row failed with at least one `FAILED`
(one bad night or `PARTIAL`-only runs are a warning); a master re-election is critical
only while the cluster is not green.

### Alert levels

Three levels, worst first — one definition, `core/alert-levels.js`; everything that sorts,
counts, filters or colours by level reads it there:

| Level | Colour | Rules |
|---|---|---|
| **Critical** | red | cluster not answering; health red; disk over the critical threshold / a node past its high watermark (and the flood-stage balance row); disk capacity fell; no master; master moved while not green; a repository whose runs keep failing |
| **High** | orange (`--high`, Play `--tv-orange` #ff8c42) | log delay over 60 min (a device past its critical delay, `classify` CRITICAL); JVM heap over 85 % on any node (`heap`, new) — raised after two node readings in a row over 85 %, cleared only below 80 % (`HEAP_HIGH_PERCENT` / `HEAP_RAISE_READINGS` / `HEAP_CLEAR_PERCENT` in `alert-rules.js`, `heapStep` in `alert-tuning.js`, the disk rule's kind of hysteresis); the node tables colour a heap over 85 % orange, the alert's colour, and say the line in the column's tooltip; an SLM policy whose last run failed (`slm-fail`) |
| **Warning** | yellow | everything else: health yellow, disk over the warning threshold, disk balance, disk not accounted for, capacity grew, master moved on a green cluster, ILM errors, SLM stopped, no recent snapshot, repository warnings, log delay 30–60 min, field-volume spikes, automations |

Changed in this release: `slm-fail` critical → High; `log-delay` past the red line critical →
High; `heap` is new, High. An automation rule can be set to raise at any of the three. The
`log-delay` alert's words say "over 60 min late", not "critical".

- **Counts.** High is an open alert like any other: the Alerts summary reads "N critical · N
  high · N warning", its Severity filter has a High button, the CSV's `level` column says
  `high`. The Alerts tab badge is red when anything critical is open, **orange** when the worst
  open is High, otherwise yellow — and says the worst level in words on hover and to a screen
  reader, not by colour alone; the browser-extension badge likewise. Acknowledged, silenced
  and held alerts are counted nowhere, whatever their level.
- **Notifications.** A new High is announced like a warning (a yellow bell entry and toast).
  What is critical-only stays so: an error-coloured notification, Play's takeover and chime,
  the spotlight's "critical alert" reason. The bell's own count is of unread notices and keeps
  its colour.
- **Zabbix.** The ElasticPro alerts template (modules 2.1.16) has two triggers per rule,
  `^critical: ` at priority HIGH and `^warning: ` at WARNING, and no High one. A High alert is
  sent to the critical trigger — item value 2, detail `critical: [High] …` — so it raises a
  Zabbix problem at the severity Zabbix itself calls High, where failed snapshots and late logs
  were raised before. The JVM heap rule is not sent: the ElasticPro cluster health template
  has its own per-node heap triggers. *Follow-up for the modules repository:* add a third
  trigger per rule, `find(…detail[rule],,"regexp","^high: ")=1` at priority HIGH, move the
  `^critical: ` trigger to DISASTER, and add `3 → high` to the "ElasticPro alert level"
  valuemap; once that template is pinned, `ZABBIX_LEVEL.high` in `core/zabbix-alerts.js`
  becomes `{ value: 3, word: 'high' }` and the generator (`tools/zabbix-alert-template.mjs`)
  writes the new trigger.
- **Play.** A High cluster's tile is orange, says "High" and blinks orange every 2.4 s; the
  Alerts slide shows HIGH rows between CRIT and WARN and counts High under Open now (see
  docs/PLAY.md, "Blinks"). A failed SLM run and logs over 60 min late are High, so they no
  longer take over the Play screen: only critical does.

**Open** means neither acknowledged nor silenced, and every count uses that one definition
(`openAlertsNow()` / `openAlertCounts()`): the Clusters summary, the nav badge, the top bar,
the per-cluster column, the extension badge. What is counted is the **merged alert**: every
alert with the same cluster and the same rule (`<cluster>:<rule>`, `core/alert-groups.js`) is
one, listing its items. Its level is the worst item's and its age the oldest's. Acknowledging
it covers the items it had when you did; an item that appears later (a node, a repository)
opens it again as "N new since acknowledged". Acknowledgements written before merging keep
covering what they covered.

**Unreachable clusters and held alerts.** A cluster that does not answer is one line at the top
of the Alerts page and one critical alert in every count. Its other rules are not dropped: they
are evaluated against its newest **cached** data (`heldAlerts()` in `core/state.js`, the rules
and limits in `core/alert-held.js`) — with the fleet cache, the core's last good answer per
dataset, which it keeps with its `fetchedAt` when a fetch fails (health included); without it,
a copy of the last data the page read while the cluster answered (its own repository objects
and listings, so a failing refresh cannot write the outage into it). Nothing is fetched from the
cluster, and the page keeps one cached copy per cluster that is down now — dropped as soon as it
answers, by whichever path. What they raise is **held** under the cluster's line, dimmed and
labelled "not current", each **as of** the time of the data it rests on, and the line says
"N older alerts held, not current · as of HH:MM" (the oldest of them). Rules run as of the
newest reading, so "no recent snapshot" is about the cluster as it was, not about how long it
has been down.

- **As of = the oldest thing the rule reads** (`RULE_READS`, `core/alert-tuning.js`): disk
  balance reads nodes and the watermarks (policies); disk not accounted for reads nodes and the
  index list (`indices`, on demand, dated by its own read — never read means the rule shows
  nothing); master moved reads nodes and health; ILM errors read `ilm_errors` and ILM's mode
  (policies); a repository reads snapshots and the repository list (policies).
- **Unknown is not zero.** A rule whose data was never read, or was read more than **24 hours**
  before now (`HELD_MAX_AGE_HOURS`), shows nothing — the fleet cache keeps its last answers
  indefinitely, so the limit is ours. A field-volume spike has no reading time this page can
  vouch for and is not evaluated for a down cluster.
- **Counted nowhere:** not the bell or its notifications, the tab title, the top bar, the
  Alerts summary or footer counts, the Clusters column, Play's counts, takeover or spotlight.
- **Acknowledging** a held alert is allowed (Ack on its row). The record is the alert's own
  `<cluster>:<rule>` key — shared on the server when hosted — so it covers the alert when the
  cluster answers and it is current again; it changes no count while the cluster is down.
- **When the cluster answers**, the live rules run as usual: an alert still true is current
  again — the same alert, no duplicate; one that no longer applies is gone. Whether it is
  announced (the bell) or takes Play's screen depends on whether anybody was shown it: one
  already seen open before the outage is remembered while held and **not announced again**;
  one nobody was shown — the page or the TV was opened during the outage, or it appeared only
  while held because a threshold moved — **is** announced when it becomes current. Held keys
  are kept in what was seen, never added to it.
- **History:** the alert log (`core/alert-history.js`) records held alerts like any other, so an
  episode that was open when the cluster went down **stays open through the outage**, and its
  age runs on from before it. An alert first seen held starts its episode then — when this
  browser first saw it held, not when the data it rests on was read.
- **Zabbix:** held alerts are never sent. For a cluster that did not answer the scraper sends
  no `elasticpro.alert[*]` values at all (`zabbixAlertsToSend`) — every rule, **automation and
  log delay included** — so each ElasticPro problem on its host stays as it was: neither
  resolved when the cluster goes down nor raised again as a new event when it comes back; the
  outage is Zabbix's own "Service is down". The next run after it answers sends every rule:
  still true stays the same problem, cleared resolves. A cluster that is removed or switched
  off (no longer in the scraper's clusters) after it was sent rule values is sent **every rule
  clear once** and then forgotten (`alertHostsToClear`), so its problems do not stay open for
  ever. That needs `--memory` (the hosts are remembered there, under `zabbixSent`, until the
  clear is delivered); without it nothing is remembered between runs.
- The CSV export lists held alerts marked `held_not_current: yes`, with `held_as_of`.

**History** on an alert (Related → past occurrences) comes from ElasticPro's own alert log
(`core/alert-history.js`, kept in this browser for 30 days) and from the notes in the
acknowledgement store. It records what this browser saw while the app was open, says how far
back it goes, and says "No history yet" rather than a count of zero. "Probably caused by this"
is shown only for a documented cause on the same cluster that started later within an hour
(`core/alert-related.js` CAUSES), and never between alerts first seen together at page open.

**The bell** carries one notification per cluster per burst: alerts raised for a cluster within
two minutes of its first are one entry, "<cluster>: N new alerts", with links to that cluster's
alerts and to the page for its worst one.

**Silences** silence a whole cluster (maintenance) or one alert for 1 h, 8 h, 24 h, 7 days, or
until removed, with a reason. They are the team's, kept on the server in
`<data dir>/silences.json` (0600) and audited; silenced alerts stay listed under *Silenced*.

| Message | Role | Answer |
|---|---|---|
| `SILENCE_LIST` | user | `{ok, silences: [{id, scope: cluster\|alert, target, reason, by, at, until\|null}]}` — live ones, only for clusters the caller may see |
| `SILENCE_SET {scope, target, minutes?, reason?}` | operator | `{ok, silence, silences}`; no `minutes` = until removed; at most 7 days timed; one silence per target (a new one replaces it); `forbidden` for a cluster the caller cannot see (an alert key's cluster is the longest known cluster id it starts with) |
| `SILENCE_CLEAR {id}` | operator | `{ok, silences}`; `forbidden` / `not_found` |

## REST console — tabs and saved queries

Up to ten tabs, each with its own request and its last response; the tabs are remembered in
this browser (IndexedDB) with secrets redacted (`ui/js/lib/redact.js`: passwords, tokens,
keys, cloud credentials and pasted Authorization values, in the body — parsed as JSON, line by
line for `_bulk`/`_msearch` — and in the path). Responses are never stored.

**Saved queries** are kept on the server (`<data dir>/saved-queries.json`, 0600), private or
shared with everyone signed in; the page redacts secrets before saving.

| Message | Role | Answer |
|---|---|---|
| `QUERY_LIST` | user | `{ok, queries: [{id, owner, name, method, path, body, shared, note, at, updated}], user}` — the caller's own and every shared one, newest first |
| `QUERY_SAVE {id?, name, method, path, body?, shared?, note?}` | user | `{ok, query, queries}`; without `id` creates, with `id` updates — only the owner or an unscoped administrator (`forbidden` otherwise); 500 per person, 256 KB body |
| `QUERY_DELETE {id}` | user | `{ok, query, queries}`; same ownership rule |

## Index templates

The Indices page's **Templates** view lists, edits, simulates and compares index, component and
legacy templates (`ui/js/core/templates.js`, `ui/js/ui/templates-view.js`). Writes (PUT/DELETE)
go through the write guard and a confirmation; Simulate
(`POST _index_template/_simulate_index/<name>`, `_index_template/_simulate`) is a read and is
on the core's read-only allow-list. Compare reads clusters one at a time; Apply uses the
multi-cluster task runner.

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
answer `unauthenticated`, like every other message; an account marked as having to change
its password gets `must_change_password`.

| Message | Role | Answer |
|---|---|---|
| `NOTIFY_PUT {id?, message, kind, detail?: [string], meta?, cluster?, at?}` | guest | `{ok, id}`. Upserts by (caller, `id`), so a task's `run` then `ok`/`err` under one key stays one record; no `id` ⇒ one is generated. `kind` ∈ `ok\|err\|warn\|run`; `message` 1–2000 chars; `detail` ≤ 40 lines (each cut at 1000); `meta` cut at 500; `cluster` is a cluster id (cut at 200); `id` ≤ 128 of `[A-Za-z0-9._:-]`; `at` ms, clamped to now (defaults to now). Anything else ⇒ `{ok: false, kind: "bad_message", message}`. |
| `NOTIFY_LIST {since?, before?, limit?}` | guest | `{ok, items: [{id, message, kind, detail, meta, cluster?, at, updatedAt}], more, days}` — the caller's own, newest `at` first. `since`: only records changed (`updatedAt`) after it; `before`: only records with `at` before it (the "Load more" cursor); `limit` default 100, max 500; `more` says the page was cut. A scoped caller (Zabbix group scope) gets only records whose `cluster` is one they can see now — the same check `FLEET_STATE` uses — and every record with no cluster. |
| `NOTIFY_CLEAR` | guest | `{ok, removed}` — every record of the caller's, nobody else's. |

The UI sends `NOTIFY_PUT` fire-and-forget for every notice it shows (a task's silent progress
ticks only when their kind changes), merges `NOTIFY_LIST` with its local copy when the bell
opens (same key/id ⇒ the server's record wins), and sends `NOTIFY_CLEAR` with "Clear all".
An older core, a snapshot file or a `file://` render has no store and the bell stays local.

## Your settings — the message contract

Where the page menu sits, the theme and what the app opens on are kept with the account
(`crates/elasticpro-core/src/user_prefs.rs`): `<data dir>/user-prefs.json`, 0600, written by
tmp + rename; no data dir ⇒ in memory for the life of the process. `PING` says `userPrefs: true`
when the core keeps them. The owner is always the caller — a session's user, a proxy user, an
API token's `token:…` name, or `local` on the edition without accounts — and is never read from
the message, so nobody reads or sets anyone else's. A display link can send neither (not in
`PLAY_READS`). These are not writes to a cluster: no `WRITE_UNLOCK`, no read-only guard.
Without a session on an edition with accounts they answer `unauthenticated`.

| Message | Role | Answer |
|---|---|---|
| `PREFS_GET` | guest | `{ok, user, prefs: {menu, theme, opensOn}, updatedAt, choices}`. Each value is a string from `choices`, or `null` when this person never set it — the UI then keeps what the browser had, then the shipped default; a store that was never asked does not answer "system". `choices` = `{menu: ["top","left"], theme: ["system","light","dark","dark-blue","warm"], opensOn: ["last","all"]}`; `updatedAt` ms, 0 = never. |
| `PREFS_SET {prefs: {menu?, theme?, opensOn?}}` | guest | The same answer, after the patch. Each key given replaces that value; `null` unsets it; keys left out are kept. An unknown key, a value outside `choices`, a non-string, or an empty or missing `prefs` ⇒ `{ok: false, kind: "bad_message", message}` and **nothing is saved** (the valid half of a refused patch is not kept). The store holds at most 5000 accounts. |

Both answer `{ok: false, kind: "forbidden"}` to an API token (`token:…` is not a person, and its
name is a prefix of the secret, which is never written to a file) and to a display link. Saves
are serialised under one lock (mutate, serialise, rename), so two people saving at once cannot
collide on the tmp file. A `user-prefs.json` that does not parse is moved aside as
`user-prefs.json.corrupt-<unix>` and logged (target `audit`), and the store starts empty, rather
than being overwritten by the next save.

The UI side (`ui/js/core/prefs.js`, rules in `core/prefs-rules.js`): on start `loadPrefs()` sends
`PREFS_GET`; each `null` falls back to the browser's IndexedDB copy (`theme` is the key that
existed before 0.3.55; `menu` and `opensOn` are new), then to the default (`top`, `system`,
`last`). When the account has no value and the browser has one, the browser's goes to the
account once, as the first `PREFS_SET` (`migrationPatch`) — never over a choice the account
already made. `savePref(key, value)` sends `PREFS_SET` and also writes the browser copy, which
is what an older core (no `userPrefs` flag), a snapshot file or a `file://` render reads.

## Config versions — who saved, what changed

Each time the config is saved from the app — `CONFIG_WRITE`, `CLUSTER_SAVE`, `AUTOMATIONS_SAVE`,
`ZABBIX_ROLEMAP_SET` — the core keeps the file as it was (`<data dir>/config-history/<unix>-<file>`,
0600, newest 20; `vault_files::ConfigHistory`) and records, from the two texts, **who** saved
and **what changed** (`config_diff.rs`): `<id>.meta.json` beside each version, and
`current-<file>.meta.json` for the file on disk now. The summary is machine-made and never taken
from the browser. It never holds a credential: any key that looks like one (password, passphrase,
token, apiKey, secret, authorization, auth, headers, credentials, privateKey, sshKey, anything
ending in `-key`/`_key` such as `x-api-key`, …) reads "credential changed"; a string carrying
`user:password@` under any key is "changed", never shown, and a cluster named only by such a URL
is named by its address with the login removed (`config_diff::redact_url`). A value is shown only
when it is a short scalar — "Defaults · watchMinutes 15 → 20"; a list entry by its name or id —
"Clusters · client-f-stage added", "Clusters · client-b changed (url, tags)"; a mapping's child by
its key — "Jump hosts · jumpwin changed (host)". At most four changes are named, then "+N more",
240 characters at most. A text that does not parse reads "config text changed"; two texts with the
same values "no change in values". The record of a save is written only after the config file
itself was written (`keep_before` / `record`): a save that failed is not in the history as a save.

`CONFIG_HISTORY` (admin) → `{ok, versions: [{id, saved_at, saved_by, summary, bytes, source}], current}`,
newest first. `saved_by` is the account name, or `system` (the core wrote without a person;
hosted) / `local` (the edition without accounts). `saved_by` and `summary` are `null` for a
version kept before this was recorded — the UI shows "—", never a made-up name. `saved_at` is
the save that produced the version when recorded, else when it was set aside. `current` =
`{saved_at, saved_by, summary, source}` for the live file, or `null` when it was last written
by hand or by an older core. `CONFIG_RESTORE {id}` is unchanged: it hands the text back, and
loading it saves through `CONFIG_WRITE`, so a restore is recorded like any save (the summary
is then the diff against what it replaced).

## Snapshot running — the message contract

The fleet cache has a tenth dataset, `snapshot_status`: `/_snapshot/_status` with no
repository (so only the snapshots in progress) and a `filter_path` that keeps the per-index,
per-shard detail out — one small request per cluster, 300 s shipped, Background class.
`SNAPSHOT_RUNNING` reads what the cache holds and **never fetches**; `PING` says
`snapshotRunning: true`. One definition of "running" and of "fresh enough":
`fleet/snapshot_running.rs`.

| Message | Role | Answer |
|---|---|---|
| `SNAPSHOT_RUNNING {clusterId?}` | user | `{ok, now, poller, intervalSec, effectiveClass, clusters: {<id>: {known, why, fetchedAt, staleAfterMs, running: [{repository, snapshot, state, started, elapsedMs, shards}]}}, running: [{cluster, repository, snapshot, state, started, elapsedMs, shards}], unknown: [<id>]}` for the caller's clusters (Zabbix group scope applies), or the one named — an id the caller cannot see ⇒ `not_found`. `known: false` (and the id in `unknown`) when there is no fresh successful reading: not fetched yet, the last fetch failed, read back from disk and not re-fetched, or older than `staleAfterMs` (two intervals) — `why` says which. A fresh reading with nothing running is `known: true, running: []`. `state` is Elasticsearch's (`STARTED`, `INIT`, …); a snapshot is running unless its state is `SUCCESS`, `FAILED`, `ABORTED`, `PARTIAL` or `MISSING`. `effectiveClass` is `background` or `onDemand`, as the running policy makes of the dataset. |

How the dot on the page menu's Snapshots entry behaves (`ui/js/core/snapshot-running.js`:
`snapshotDot(reply, selection)` is green only while a known running snapshot is on the chosen
cluster, or on any visible cluster under "All"; `unknown` draws nothing — never "none"):

- **Background** (and Automatic with ≤ 25 clusters): the dataset is polled for every cluster
  every `intervalSec`, so the dot is right on every page, within one interval.
- **Hybrid** and **Client basis** (`effectiveClass: onDemand`): nothing is fetched until a page
  asks. The Snapshots page asks (`state.js` `moduleDatasets('snapshots')`), so the reading is
  fresh while that page is open and for the watch window (15 min shipped) after; on other pages
  the dot shows only while that reading is still fresh, and goes away — as *unknown*, not as "no
  snapshot" — once it is stale or was never made. The shell never asks on its own: that would be
  the shell polling every cluster under a policy whose promise is that nothing is polled unasked.
  `snapshotNote()` says so in the tooltip ("…read only while the Snapshots page is open").
- A plain refresh — the button, `r`, Retry, a trust action, i.e. `REFRESH` with no `datasets` —
  asks for the background set **less `snapshot_status`** unless the running policy polls it on
  its own (`effectiveClass: background`): `refresh_msg` in fleet/mod.rs and `backgroundNames()` in
  state.js (`POLICY_ONLY`) agree. Only the Snapshots page (`moduleDatasets`) and the Background-mode
  poller ask for it; named explicitly in `REFRESH.datasets` it is always honoured.
- A write to `/_snapshot/…` or `/_slm/…/_execute` through the REST console marks the dataset due
  at once (`datasets_for_write`), so a snapshot an operator starts shows on the next poll.
- **Emergency stop**: nothing is fetched; readings go stale and the dot goes away.
- A cluster that does not answer gets no `snapshot_status` probe (health only), so it is
  `unknown`, with the last error as `why`.

## Housekeeping — the message contract

One timer in the core (`housekeeping.rs`) cleans what ElasticPro itself leaves behind. It runs
every `HOUSEKEEPING_MINUTES` (default 60; 0 = off), the first time five minutes after start, and
is started by the bridge binary and the desktop shell, never by `Core::new`. Every deletion is a
log line on the `audit` target (`housekeeping: removed …`, with the path or key, the reason and
the bytes), so it survives `LOG_LEVEL=error`; `HOUSEKEEPING_DRY_RUN=true` logs `would remove`
instead and deletes nothing. Each run writes one `housekeeping_run` event to the activity log
(user `system`, or the administrator who pressed Run now; counts under `elasticpro.detail`).

| Job | Removes | Only ever |
|---|---|---|
| Fleet disk cache | `cache/<cluster>/` of clusters no longer configured; on-demand dataset files (`indices`, `shards`, `snapshots_full`) untouched for `HOUSEKEEPING_CACHE_DAYS` (default 2); background dataset files untouched for 7 days; `*.tmp` older than an hour | files named exactly `<dataset>.json[.gz]` / `<dataset>.tmp` / `<dataset>.json.tmp` under `<data dir>/cache/<escaped cluster id>/`; never a symlink or its target; a folder with anything else in it stays |
| Redis | `elasticpro:ds:<cluster>:<dataset>` keys of clusters no longer configured | keys with that prefix and a dataset name this build writes (SCAN + STRLEN + DEL) |
| Sessions | a Zabbix-frame session unused 24 h (the frame orphans one per reload); an ordinary session only if `SESSION_IDLE_DAYS` is set (default 0 = never; **setting it signs people out**). No cap on how many sessions an account holds; sessions from before the `frame` flag existed count as ordinary | a session used in the last 10 minutes, or the caller's own, is never ended |
| API tokens | tokens that expired more than 30 days ago | tokens with no expiry are never touched |
| In-memory maps | request counters, limiters, cached connections, poller marks, tickets and Zabbix budgets of removed clusters or past their time | |
| Notifications, silences | the existing 30-day / 2000-per-person retention and ended silences, once a day | |
| Activity log | rotated files `<log>.<n>` last written more than `ACTIVITY_LOG_KEEP_DAYS` ago (default 0 = off) | the live file is never touched |

Nothing is removed by cluster while the cluster list is not known (nothing primed yet, or Zabbix
configured but not yet read): an empty list must not read as "every cluster was removed". Config
history, uploaded keys, saved queries, users and the config files are **reported** (count, size,
oldest) and never deleted.

| Message | Role | Answer |
|---|---|---|
| `HOUSEKEEPING_GET` | admin | `{ok, enabled, minutes, dryRun, cacheDays, backgroundCacheDays, sessionIdleDays, activityKeepDays, running, nextRunAt, lastRun, recent}`. `lastRun` is `{startedAt, finishedAt, trigger: "schedule"\|"manual", by, dryRun, items, bytes, errors, jobs: [{id, label, ok, skipped, items, bytes, error, notes}], reportOnly: [{id, label, files, bytes, oldestAgeDays, note}]}`; `null` until a run since start. |
| `HOUSEKEEPING_RUN {dryRun?}` | admin | Runs every job now and answers like `HOUSEKEEPING_GET` plus `run` (that report) and `message`. `dryRun: true` lists what would go and removes nothing; the configured `HOUSEKEEPING_DRY_RUN` can force a dry run, never lift one. A run already going ⇒ `{ok: false, kind: "already_running", runId}` (`busy` before the run log; docs/JOBS.md). Does not move the schedule. |

The Request Centre shows both as the **Housekeeping** card (last run, what each job cleaned, next
run, **Dry run**, **Run now** — which asks first).

## History store — the message contract

A **dedicated** Elasticsearch endpoint (its own URL and credential; not a monitored cluster, not
in the fleet, Play, alerts or the cluster list) that mirrors the daily volume record, a daily
capacity record and, optionally, the scheduled log-delay measurement, with a long history.
**docs/HISTORY.md is the contract.** Hosted only; the desktop editions answer
`{ok: false, supported: false}`.

Writes are gated twice, both by people: `HISTORY_STORE_WRITES=true` in config.txt, and an admin
arming *Write history* after a passing *Test connection* on the settings as they are now
(changing the URL, route, TLS, prefix or credential turns the switch off). The global `readOnly`
is never used; a start without the key disarms. The store's requests take their own guard
(`guard::history_guard`): `GET /`, `POST /_security/user/_has_privileges`,
`GET /_index_template/<prefix>-template`, `POST /<prefix>-…/_search`, and — only with both gates
open, checked again right before each request leaves — `PUT /_index_template/<prefix>-template?create=true`
(mappings only; never an overwrite) and `POST /_bulk` of strict action/document pairs whose every
action is `index`/`create` into `<prefix>-…`. Nothing else. The store is never a monitored
cluster's address, takes a credential only over `https://`, follows no redirect, ignores the
global insecure TLS default, and its prefix may not name another family's indices (`logs`,
`metrics`, `logstash`, `filebeat…`, … — docs/HISTORY.md). The Request Centre lists its requests
under origin `history-store`.

| Message | Role | Answer |
|---|---|---|
| `HISTORY_STORE_GET` | admin | `{ok, supported, settings: {url, auth: "basic"\|"apiKey"\|"none", user, passwordSet, passwordStale, tls: "auto"\|"system"\|"insecure", via, prefix, streams: {volume, capacity, delay}}, armed, armedBy, armedAt, permitted, permitHint, test: null\|{at, by, ok, current, version, clusterName, securityEnabled, privileges: {create_doc, create_index, read, manage_index_templates}, message}, armBlocked, writing, status: {lastSuccessAt, lastError, lastErrorAt, docsWritten, queue, dropped, refused, rejected, lastSkipped, templateAt, backfill}, jumpHosts}`. Never a password or API key. `passwordStale`: the address, route, TLS or kind of credential changed since it was typed (it is sealed to them) — type it again. A limited admin may read it. |
| `HISTORY_STORE_SET {settings: {url, auth, user, password?, apiKey?, tls, via, prefix, streams}}` | admin; a limited admin is refused (fleet-wide) | As GET. An empty or `*` password/API key keeps the one held. The URL is scheme, host and port only, no credential in it, `https://` when a credential is set, and not a configured cluster's `host:port`; the prefix is lower case `[a-z0-9._-]` and not a reserved family's. Changed settings disarm; a stream turned off drops what waits for it. |
| `HISTORY_STORE_TEST` | admin; not a limited admin | As GET, `ok` = the test passed: `GET /` (version, cluster name) and `_has_privileges` for `create_doc`, `create_index`, `read` on `<prefix>-*` and the cluster privilege `manage_index_templates`, each `true`/`false`/`null` (not checked: security is off on the store, which passes). A connection failure carries the transport's `kind`, `cert`, `help`. Reads only. |
| `HISTORY_STORE_ARM {on}` | admin; not a limited admin | As GET. `on: true` is refused (`kind: "refused"`, naming `HISTORY_STORE_WRITES=true` or the test) unless config.txt permits and the last test passed on the current settings. `on: false` always works; the next tick writes nothing. |
| `HISTORY_STORE_BACKFILL` | admin; not a limited admin | As GET with `status.backfill.running`. *Copy existing history*: every local month file of every cluster, in bulks of at most 500, with progress (`done`/`total` files, `docs`). Refused unless both gates are open and the volume stream is on, or while one runs. |
| `HISTORY_QUERY {stream: "volume"\|"capacity"\|"delay", clusterId, from?, to?}` | user; a scoped caller or a limited admin only on clusters they see; the cluster must exist | `{ok, stream, clusterId, from, to, total, truncated, docs}` — the store's documents, oldest first, at most 5000, one search (interactive class). Unreachable: `{ok: false, kind: "unreachable", message: "in the history store · not reachable: …"}`. |

`DELAY_SINK_SET` takes `destination: "cluster"` (default; a file without it is unchanged) or
`"history"` (to `<prefix>-delay-YYYY.MM` under the store's gates, every primed cluster measured);
`DELAY_SINK_GET` adds `historyStore: {configured, armed, permitted, streamOn, prefix}`; a limited
admin cannot `DELAY_SINK_SET` (fleet-wide).
`VOLUME_DAILY`, `VOLUME_MONTHLY` and `VOLUME_MONTHLY_ALL` read days the local record does not hold
from the store (docs/VOLUME.md "History store: write and read-back"; never for a display link):
rows marked `source: "history"` (a month partly from it: `historyDays`; past a bounded read:
`incomplete`), and a `history` object `{asked, from, to, reachable, days, truncated,
truncatedBefore, templateMissing, message}`. Reports › Daily & monthly shows its message once,
in amber, when the store is not reachable, the read stopped at its bound, or nothing was ever
written there.

## Backend — the message contract

Data › Backend (docs/HISTORY.md "Backend routing"): **where ElasticPro keeps what it records.**
Three kinds — `history` (volume, capacity, log-delay records), `reports` (generated files and
job history), `alerts` (acknowledged, silenced, and what the pages saw raised and cleared) —
each `builtin` (the data directory, the default), `copy` (built-in and the history store) or
`es` (the history store is where it is kept for good). The Elasticsearch side is always the
dedicated history store above, under its two gates and its guard; never a monitored cluster.
In `es`, while the store is not connected and writing, the record is queued (the store's
bounded on-disk queue) and the built-in store keeps writing, so nothing is lost; in `copy` a
closed gate is not a backlog. Nothing is ever deleted by this feature. Hosted only; the
desktop answers `{ok: false, supported: false}`; PING carries `dataRouting: {supported}`.

| Message | Role | Answer |
|---|---|---|
| `DATA_ROUTING_GET` | admin (a limited admin may read) | `{ok, supported, routing: {history, reports, alerts, reportFiles, changedBy, changedAt}, modes: [{id, label}], store: {configured, url, prefix, permitted, armed, testOk, writing: null\|"<why not>", lastSuccessAt, lastError, lastErrorAt, queue, dropped}}`. Until an admin has saved a routing (`changedBy` null) history follows the store: `copy` while it is armed, else `builtin`. Never a secret. |
| `DATA_ROUTING_SET {routing: {history?, reports?, alerts?, reportFiles?}}` | admin; a limited admin is refused (fleet-wide) | As GET. A field left out keeps its value; a mode that is not `builtin`, `copy` or `es`, or a field that is not one of the four, is refused by name (`kind: "bad_request"`). `reportFiles: true` carries each report file (≤ 2 MiB) inside its record — **anyone who can read `<prefix>-reports-*` on the store then sees every cluster's report content** (never a credential); the page says so beside the switch. A kind routed back to `builtin` lets go of what was queued for it (counted in `store.dropped`, audited); `reportFiles` turned off takes the file references out of the queued report records. Audited. |
| `DATA_ROUTING_STATUS` | admin (a limited admin may read) | `{ok, supported, routing, builtin: {dir, size: {bytes, files, truncated}, diskTotal, diskFree}, store (as GET), kinds: {<kind>: {mode, label, state: "writing"\|"queued"\|"paused"\|"builtin", line, keptFor: {builtin, store}, builtin: {size: {bytes, files, truncated}}, store: {docs, docsNote, queued, dropped, writing, why}}}}`. Nothing is asserted about the built-in record's own writes (unknown is not ok). `store.writing` is false, with `why`, when a gate is closed or that kind's stream last failed (its template, mostly) — one stream's trouble never stops the others. `bytes` is a floor when `truncated`, `null` when there is no such place; `docs` is `null` with `docsNote` when the kind is kept built-in, no store is configured, or the store did not answer (asked again after a minute). Reads only: one bounded `_search` per pattern, interactive class. |
| `ALERT_EVENTS_PUT {events: [{event: "raised"\|"cleared", key, rule?, level?, at?, approx?}]}` | user; a scoped caller only on clusters they see | `{ok, supported, accepted, dropped, unknown, routed}`. At most 200 events in one message and **200 per account per 15 minutes over every message, counted as sent** — past that `kind: "too_many"` and nothing is queued. A key must be `<clusterId>:<rule>[:<instance>]` with `rule` one of the pages' alert rules (`ui/js/core/alert-rules.js`, plus Play's `node-left`): anything else is `bad_request` by name. A key naming no cluster counts as `unknown` and is never written; one naming a cluster the caller cannot see makes the whole message `forbidden` (nothing queued). The same event for the same key from the same person within 15 minutes is `dropped`. `at` is believed within 48 h back and 5 min ahead, else now. `routed: false` says alerts are kept built-in (the events were taken and go nowhere). The core evaluates no alert itself: this is how the alerts record learns what the pages saw. |

The records: `<prefix>-reports-YYYY` (`_id` the job id: kind, report, status, clusters, period,
format, by, times, file name and size, error, warning, failed clusters, the job's own figures —
`rows` is `null` for a volume report — and optionally the file) and `<prefix>-alerts-YYYY`
(`_id` `<event>|<key>|<at>`: acknowledged / unacknowledged / ack_cleared / silenced / unsilenced
from the core's own messages, raised / cleared from `ALERT_EVENTS_PUT` with `reportedBy`). Each
under its own index template (`<prefix>-reports-template`, `<prefix>-alerts-template`:
`create=true`, mappings only, `dynamic: false`, priority 300), written by the history store's
tick with the volume and capacity bulks — bulks taken in turns across the streams, so a long
alerts queue never keeps history waiting. A report that ended in the worker process reaches the
tick through `<data>/history-store-spool/` (32 MiB at most; a spool file goes only once the
queue that took its record is on disk). A queued report record holds a *reference* to its file
(name, size, sha256): the file is read when the record is sent and carried as `fileContent`
with its digest, or, when it is gone or changed by then, named in `fileNote`. The alerts
stream has its own share of the queue (2 000 of 20 000) and is evicted first when the queue
is full: no other stream is ever pushed out for an alert.

## Volume record — the message contract

Index volume per day and per month, by field, for every cluster: the core collects it and keeps
it, the pages show its answers. **docs/VOLUME.md is the contract** — what counts, the settings
and their precedence, the store layout, every derived figure, and the message table; this is the
short version.

- **When**: hosted only, once a day at `collectAt` (server local time, `TZ` of the core; 06:00
  by default), from a 60 s tick started by the bridge binary (`volume daily: timer started`, an
  audit line with no user). A restart neither repeats today's run nor skips a missed one: the
  local date of the last scheduled run is kept in each cluster's `state.json`. **Refresh now**
  (`VOLUME_RUN`) runs at once, at most once a minute per cluster (`tooSoon`). Desktop has no
  timer; Indices › Summary asks for a run.
- **What counts** (0.3.53): `indexPattern` (default `logstash-*`, comma-separated, no date part
  needed). An index whose name carries `YYYY.MM.DD` counts on that day in full; one without is
  split into UTC days by `timeField` (default `@timestamp`), its documents and event bytes
  measured, its size per day not (`null`, `unmeasuredSizeIndices`). `dayFrom: time` splits
  every index. The legacy `indexFormat` keeps its old behaviour when it is the one in force
  (docs/VOLUME.md "What counts").
- **What it sends**: `_cat/indices/<pattern>`, `_field_caps`, one `date_histogram` search when
  some index is split by time, then one aggregation `_search` per day that is not final (and
  today, every run) — reads only, so it works under read-only.
  Background class, origin `volume-daily`, 60 s per request (capped by `ES_MAX_TIMEOUT_MS`), at
  most 2 clusters at once and one request at a time per cluster. The emergency stop holds it
  (the timer tries again next tick); an unreachable cluster is skipped.
- **Where it lives**: `<data>/volume/<escaped id>/YYYY-MM.json.gz` + `state.json` (0600, tmp +
  rename), `<data>/volume/layouts.json` for the shared column layouts. Nothing is held in memory
  between requests; `VOLUME_MONTHLY_ALL` reads only the `state.json` files. Months older than
  `keepMonths` are removed after each run.
- **Settings**: built-in < `defaults.volume` < cluster override (`defaults.volume.overrides[id]`
  or `clusters[].volume`) < config.txt `UI_VOLUME_*`. Hosted reads its own config file; the
  desktop editions take `volume: {defaults, cluster}` from the message. Legacy `volumeFields`
  is read only where no `volume` is set.

| Message | Role | Answer |
|---|---|---|
| `VOLUME_SETTINGS {clusterId?}` | user | `{settings, patternSource, managed, source, overrides}`; `patternSource` is `"pattern"`, `"format"` (the legacy `indexFormat` is in force) or `"default"` |
| `VOLUME_FIELDS_CHECK {clusterId}` | user | `{glob, patternSource, dayFrom, indices: {match, days, skipped, skippedCount, dated, timeSplit}, timeField: {field, used, resolved, type, note}, rows: [{key, tried, resolved, type, note}]}` (asks the cluster now) |
| `VOLUME_PATTERN_CHECK {clusterId, indexPattern, dayFrom?}` | admin (a limited admin only on clusters they see) | `{matched, dated, undated, datedExample, undatedExample, clusterId, indexPattern, dayFrom}` — the Config card's preview before a save: one `_cat/indices/<pattern>?format=json&h=index` through the gate as the caller (class `interactive`, origin `volume-pattern-check`). `matched: 0` is an answer; an unknown cluster or an Elasticsearch error is `ok: false` with `message` |
| `VOLUME_DAILY {clusterId, days?, avgDays?, source?}` | user | `{settings, status, cards, days, sources, source, topAvailable, skipped, skippedCount, matched, timeSplit, window}`; a row whose size is not measured (split by time) has `priBytes`/`totalBytes` `null` and `unmeasuredSizeIndices` > 0 |
| `VOLUME_MONTHLY {clusterId, months?}` | user | `{status, months}` |
| `VOLUME_BREAKDOWN {clusterId, field, from?, to?, top?}` | user | `{field, resolved, resolvedAll, rows, totals, period}`; `error` when the field never resolved |
| `VOLUME_MONTHLY_ALL {months?}` | user | `{clusters: [{clusterId, name, basis, months}]}` |
| `VOLUME_RUN {clusterIds?}` | user | `{started, already, tooSoon, skipped: [{clusterId, reason}], stopped}` |
| `VOLUME_LAYOUT_GET` | guest | `{layouts: {daily, monthly, capacity, overview}}`, each `{order, hidden, labels}` |
| `VOLUME_LAYOUT_SET {table, layout}` | operator | `{layouts}`; audited. `table` is one of `daily`, `monthly`, `capacity`, `overview` (Reports; `cluster` first and never hidden); column keys in docs/VOLUME.md |

`status = {lastRunAt, nextRunAt, running, progress: {done, total} | null, lastError, collectAt}`;
`nextRunAt` is `null` where nothing schedules. Without a data directory every record message
answers `{ok: false, kind: "no_store"}`.

## Volume reports and mail — the message contract

The short version of docs/VOLUME.md "Reports and mail". Code: `crates/elasticpro-core/src/report/`.

- **Jobs**: `REPORT_RUN` queues one job per cluster. A job collects the period's missing days
  through the volume collector (same rules: Background class, origin `volume-report`, one
  collection per cluster at a time and two clusters at once, the daily run included), builds
  the file from `volume::derive` (no figure computed twice), keeps it in `<data>/reports/`
  (0600, pruned after 7 days) and mails it when `mail` is set. 3..5 jobs at once (default 3,
  `REPORT_CONCURRENCY_SET`), the rest FIFO; the queue is `<data>/reports/jobs.json`, and a job
  running at a restart is marked `failed: "the server restarted"`. One person may have 15
  jobs waiting or running (`too_many_jobs`) and ask for 10 mailed ones an hour
  (`too_many_mails`).
- **Stops**: `REPORT_STOP` (admin) ends a queued job at once and a running one between days.
  **The emergency stop fails a job** that would have to collect, saying so — run it again
  when the stop is over. A period whose every day the record has settled (final, gone, or
  never there) asks the cluster nothing and is built under the stop too. An unreachable
  cluster is not asked: the file holds what the record has, and the job carries a `warning`.
- **Mail**: `<data>/mail.json`, the password sealed under the cluster-secrets key (hosted
  only — the desktop editions have no kept key and refuse to store one: `cannot_store_password`).
  config.txt `UI_SMTP_*` locks fields; `UI_SMTP_PASSWORD_FILE` is read at send time. The stored
  password is sealed for its server (host, port, security, user): changing any of them without
  typing it again leaves it unused (`passwordStale`). `UI_SMTP_PASSWORD_FILE` needs
  `UI_SMTP_HOST` and locks port, security and user too. "none"
  security only with auth "none". Recipients of every report mail — a job's with `mail: true`
  and the mailed report — are the mailed report's `to/cc/bcc`, which only an admin sets: a user
  cannot send cluster figures to an address of their choosing.
- **Mailed report**: `<data>/report-schedule.json`; monthly (previous month, on the 1st), weekly
  (previous Mon..Sun, on Monday), daily (yesterday, after that day's scheduled collection), or
  manual. Periods are UTC dates, like the index names; only the send time `at` is server local
  (the first `at` after the period's last UTC day has ended). The last period sent is kept, so a
  restart neither resends nor skips one; saving a schedule — or a config.txt change of cadence or
  time, at the next start — counts the period whose moment has passed as handled. Every end is
  `lastSent`; one the emergency stop (or a restart, once) cut short is tried again. One
  .xlsx with a sheet set per cluster. Hosted timer (`volume report: timer started`, no user).
- **Audit**: one line per mail (`volume report mailed` / `mail server test`: user, recipient
  count, ok), per settings change, stop and concurrency change. Never an address, never a
  password, never file contents.

| Message | Role | Answer |
|---|---|---|
| `REPORT_RUN {clusterIds, period, format?, mail?}` | user | `{jobs: [Job], refused: [{clusterId, reason}], joined?}`; `period` = `{from, to}`, `"month:YYYY-MM"`, `"yesterday"`, `"last7"`; `kind: too_many_jobs` / `too_many_mails` refuses the whole request. The same report already queued or running is joined, not queued again (`joined: ["report-<id>"]`; docs/JOBS.md "Duplicates") |
| `REPORT_JOBS` | user | `{jobs, concurrency, running, queued}` — jobs of the clusters the caller sees, newest first |
| `REPORT_STOP {id}` / `{all: true}` | admin | `{stopped: [ids ended now], stopping: [ids asked]}`; audited |
| `REPORT_CLEAR` | user | `{removed}` — the caller's finished jobs (admin: all) and their files |
| `REPORT_DOWNLOAD {id}` | user (starter or admin) | `{name, mime, bytes, base64}` |
| `REPORT_CONCURRENCY_SET {n}` | admin | `{concurrency}`, 3..5 |
| `MAIL_SETTINGS_GET` | admin | `{host, port, security, auth, user, from, passwordSet, passwordStale, passwordFrom, managed, configured, problem, canStorePassword, passwordStoreProblem}` |
| `MAIL_SETTINGS_SET {…, password?, clearPassword?}` | admin | as GET; a managed field may be sent unchanged, not changed (`managed`) |
| `MAIL_TEST {to}` | admin | `{ok, steps: [{step: connect\|tls\|auth\|send, ok, detail}]}`, `kind: smtp_failed` and `message` when a step failed |
| `REPORT_SCHEDULE_GET` | admin | `{enabled, to, cc, bcc, schedule, at, clusters, subject, sheets, lastSent, managed, timer, nextSendAt, mailConfigured, nextPeriod: {from, to, label}}` — `nextPeriod` is what the next send covers (manual: `REPORT_SEND_NOW`'s default) |
| `REPORT_SCHEDULE_SET {…}` | admin | as GET |
| `REPORT_SEND_NOW {period?}` | admin | `{job, runId}` — the schedule's period, or the current month so far for a manual one |

Schedules of their own beside the built-in one of each kind, run now, cancel, retry and pause:
the job controls, docs/JOBS.md "Controls" (`JOB_*`).

`Job = {id, kind: cluster|mailed, clusterId ("*" for mailed), clusterName, clusterIds, period: {from, to, label}, format, mail, by, createdAt, startedAt, endedAt, status, progress: {done, total}, file: {name, bytes} | null, error, mailError, stoppedBy, warning, sheets?, stopping}`.

**With the report worker (role `core`, docs/WORKER.md).** `REPORT_RUN`, `REPORT_SEND_NOW`,
`REPORT_STOP`, `REPORT_CLEAR`, `REPORT_CONCURRENCY_SET` and `VOLUME_RUN` are forwarded to the
worker after the core's own checks (role, the caller's clusters, `too_many_clusters`, the
per-person and mail limits against `jobs.json`, recipients and mail for a send) and answer what
the worker answers — or `{ok: false, kind: "worker_unavailable", message, lastHeartbeatAt}`
(EP-218) when it cannot be reached, or `kind: "worker_version"` (EP-219). `REPORT_JOBS`,
`REPORT_DOWNLOAD`, `REPORT_SCHEDULE_GET/SET`, `MAIL_*` and `HOSTS_QUERY` are the core's, from the
files: `REPORT_JOBS` and `REPORT_SCHEDULE_GET` then also carry `worker: {state, heartbeatAt,
text, level}` (`up`, `late`, `down`, `missing`, `unreadable`, `version`). `REQUEST_LOG`'s `recent`
includes the worker's finished requests with `process: "worker"`. Role `all` forwards nothing.

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

## Credentials kept on the server — the message contract

Hosted only (0.3.42; the default credential's own rules since 0.3.46). The core keeps every
cluster credential in `<data>/cluster-secrets.json` (AES-256-GCM under
`ELASTICPRO_CLUSTER_SECRET_KEY_FILE`, 0600): a config cluster's own as `cfg:<id>`, bound to its
address, route and certificate setting; a password the Zabbix module handed over under the
cluster host's name; and **the default** as `*`, unbound, which every cluster without its own
uses — config clusters, and Zabbix clusters whose password macro is not on their host. Nothing
is ever read back: answers carry usernames, who set what and when.

**A new cluster that uses the default credential never asks for a password.** With a default
kept, a cluster added in the Add cluster dialog (its **Credential** choice starts on *Default
credential (user …)*), by an operator's `CLUSTER_SAVE`, from the config file or from Zabbix
signs in with it at once: PRIME lists it in `held` and answers `defaultCredential: true`, so the
page shows no *Sign in (N clusters)*, no startup prompt and no form. With no default yet, the
Add dialog offers to set it once there (typed) or to use a credential the server already keeps
(`promotable`); Config → Credentials offers the same as one button. A cluster that rejects the
default (401/403) is named — *The default credential was rejected by …* — with **Set its own
credential…** (for a Zabbix cluster it opens the cluster's Edit dialog; Cluster Management's
*Change password* still works too). The sign-in dialog
never replaces an existing default unless **Replace the default credential** is ticked; unticked,
what is typed is kept as the own credential of exactly the clusters it lists. On hosted the page
never holds what was typed: the server keeps it and the page reconnects. A cluster connected
without a credential on purpose opens on *No credential (connected anonymously)*; choosing the
default or its own withdraws that (`dropAnonymous`). The Add dialog sets the default with
`onlyIfAbsent` and only once per dialog, so a retry after a failed save, or a default somebody set
meanwhile, never replaces one.

| Message | Role | Answer |
|---|---|---|
| `CREDENTIAL_STATUS` | admin | `{ok, default: {id: "*", user, kind: "basic"\|"header", setBy, setAt, moved}\|null, clusters: [same, per config cluster id — and per Zabbix cluster id (`zbx-…`) with an own credential set in ElasticPro], promotable: [{id, cluster, source: "config"\|"zabbix", user, kind, setBy, setAt}], problem}`. `promotable` lists, while there is no default, every kept entry the server's key opens; `id` is the entry's name in the store (`cfg:<id>` or the Zabbix host). Empty once a default exists. |
| `CREDENTIAL_SET {cluster, username+password \| apiKey \| bearer \| rebind, onlyIfAbsent?}` | admin | `{ok, cluster, setAt}`. `cluster: "*"` sets the default. With `onlyIfAbsent: true` (the Add dialog's) an existing default is not replaced: `{ok: false, kind: "exists", user, setBy, message}`. |
| `CREDENTIAL_CLEAR {cluster}` | admin | `{ok, cluster, cleared}` — the cluster then uses the default. Clearing `"*"` also marks the default as forgotten (who, when; kept in `cluster-secrets.json`): until CREDENTIAL_SET or CREDENTIAL_PROMOTE of `"*"`, no PRIME's `sharedAuthHeader` is kept as the default or used in its place. |
| `CREDENTIAL_PROMOTE {from, replace?}` | admin | Copies a kept entry to the default without the password being typed: `{ok, cluster: "*", from, user, kind, replaced, setAt}`. `from` is a `promotable` id (a config cluster's bare id is accepted). An existing default is refused — `{ok: false, kind: "exists", message}` naming its user — unless `replace: true`. `not_found` for an unknown entry, `unreadable` for one the key does not open. Audit line `kept credential made the default` with `user`, `from`, `replaced`; never the secret. |
| `PRIME` (credential fields) | admin | Message: `dropAnonymous: [id]` — clusters connected without a credential on purpose that an admin has just given one (the default or their own); the core stops keeping "none, on purpose" for them. On hosted the page sends no `sharedAuthHeader` except a `credentials:` block still in the config file (its one-time move to the server), never one typed. Reply: `held: [id]` (clusters the core signs in to), `anonymous: [id]` (none on purpose), `defaultCredential: bool` — hosted, whether a cluster with nothing of its own is covered (the kept default, or the message's shared credential where nothing can be kept and the default was not forgotten). A cluster with no own entry and no default falls back to that shared credential, as `CLUSTER_SAVE` does. A header held from before carries on only while address, route and certificate setting are all unchanged. |
| `CLUSTER_SAVE` (reply field) | operator | `credential: "kept"\|"shared"\|"admin"\|"none"`. On `none` the page says *No default credential is set; an admin sets it in Config → Credentials* — no form. |

Setting, promoting or clearing the default starts a Zabbix sync, so a Zabbix cluster held back
as *password not set* is polled with the new default within seconds rather than at the next
interval.

## Cluster type and ULM — the message contract

0.3.47. Every cluster is **CI**, **DI** or **On-Prem**, with ULM (log archive to S3) on or off and
SLM snapshots expected or not. Defaults by type: CI / DI → ULM on, SLM none; On-Prem → ULM off,
SLM expected; a cluster with no type takes On-Prem's. With ULM on and SLM none
(`slmExempt`, `ui/js/core/cluster-kind.js` — the one definition), the rules *SLM not running*,
*no recent successful snapshot*, a repository's *no snapshots* and *newest snapshot is not recent*
do not raise for that cluster; a policy that exists and fails (`slm-fail`) and a repository whose
snapshots fail still do. The Clusters page shows a CI / DI / On-Prem badge beside each name and a
Type filter; its snapshot cell and the Snapshots page say *ULM · s3 \<bucket\>* instead of *none*,
and the SLM pill reads *Not used* (grey) instead of red. Only the bucket's name is kept: whether the
archive is complete is checked by the Zabbix log archive (S3) template. ElasticPro never reads S3.

Hosted: one store for every cluster, Zabbix ones too, `<data>/cluster-meta.json` (0600, tmp +
rename). A Zabbix cluster with no entry takes its type from the host tag `elasticpro:type`
(`CI`, `DI`, `On-Prem`), read on the sync's existing `host.get` (`selectTags`). Desktop: the
cluster's own keys in the config file — `type: ci|di|onprem`, `ulm: true|false` or
`ulm: {enabled, bucket}`, `slm: expected|none`; an older `logBucket` is still read as the bucket.
Set in the Edit cluster dialog (*Cluster type*); a Zabbix cluster's name menu opens the same part
alone. ULM and SLM follow the type until an admin changes them.

| Message | Role | Answer |
|---|---|---|
| `CLUSTER_META_GET` | user | `{ok, clusters: {<id>: {type, ulm: {enabled?, bucket}, slm?, source: "set"\|"zabbix-tag", setBy?, setAt?}}}` — the clusters the caller sees that have an entry or a tag; `enabled` / `slm` absent = follow the type. Desktop: `{ok: false, kind: "not_available"}`. |
| `CLUSTER_META_SET {clusterId, meta: {type, ulm: {enabled: bool\|null, bucket}, slm: "expected"\|"none"\|null} \| null}` | admin | The same answer, after the change. `type` is required (`ci`, `di`, `onprem`; `CI`, `On-Prem` accepted); `bucket` empty or an S3 name (3–63 of `a-z 0-9 . -`, letter or digit at both ends, no `..`, not an IP). `meta: null` forgets the entry (back to the tag or the defaults). `forbidden` for a cluster the caller does not see, `bad_request` for a bad value. Audit line `cluster type set` (or `cleared`) with `cluster`, `kind`, `ulm`, `bucket`, `slm`. |

## Zabbix sync — hosts held for review (the message contract)

Hosted only. Code: `crates/elasticpro-core/src/zbx_conflicts.rs`, the build in `bridge.rs`
(`zabbix_assemble`). A sync (timer, *Sync now*, a link change) reads the hosts on the cluster template
and builds a cluster from each. **A Zabbix host never takes over a cluster ElasticPro already has on
its own.** Until 0.3.59 the pages did exactly that: `mergeZabbixClusters` (ui/js/core/config.js)
compared each Zabbix host's address with every config-file cluster's (`urlKey`: trailing slash and
case only) and set the config cluster aside — its name, route, tags, retention and credential no
longer used — with nobody asked and only a fold on the Zabbix tab saying so. And because the
comparison ignored default ports, `https://es` and `https://es:443` were two clusters, polled twice.

**Identity is the address**, defined once (`zbx_conflicts::url_identity`) and parsed by the HTTP
client's own parser (`reqwest::Url`): `scheme://host:port[/path]`, scheme and host lower-case, the
scheme's default port written out (http 80, https 443), the path as written without a trailing slash.
`https://ES.example/` = `https://es.example:443`; `http://es:9200` ≠ `https://es:9200`; `/ES1` ≠ `/es1`.
**A Zabbix address that is not plain has no identity and matches nothing**: one with `user:password@`, a
backslash, whitespace or a control character, a query or a fragment — texts a hand-written splitter
and the HTTP client could read as different hosts. A Zabbix host whose macros make one is not a
cluster (listed under *Hosts not counted as clusters* with why). The pages keep no copy: every Zabbix
row and every held entry carries `identity`, and the pages decide nothing by address. **The identity
is also the one key for *Use ElasticPro credentials***, which lends a config cluster's credential to a
Zabbix host **only when an administrator let that host take the cluster over (Update)** and both are at
one identity (`zbx_conflicts::lent_credential`) — never because two addresses compare equal, never to a
host held, skipped or kept beside the cluster (*Keep both*: the Zabbix one signs in with its own or the
shared credential), never to an address with no identity. A config cluster's address is read the same
way without the `user:password@`, query or fragment it may carry (`trusted_identity`), so a credential
in the file's URL never hides a conflict from the review. A cluster's own kept credential stays bound
to its destination string (`destination_of`), unchanged.

**When a host is held.** Its identity is that of a cluster that exists already:

- a **config-file cluster** — the server's config file, and any primed cluster it does not name; or
- **another Zabbix host already in use** — the one a kept entry names, else the one the last build
  used, else the oldest (lowest host id). A host that gains the template later never pushes the one
  in use out.

Then **nothing about that cluster changes**: the host is not built, not polled, not in
`ZABBIX_CLUSTERS.clusters`, and is recorded as **pending** with both sides' values. Every host that
does not conflict keeps syncing as before. The audit line `zabbix sync: a host at an existing
cluster's address is held for review` names the host, the cluster and the address once.

**The review** — Config-Management › Zabbix › *Held for review* (administrators of every cluster):
each held host, waiting ones first, with *Review…*. The dialog shows the existing cluster and the
Zabbix host side by side (name, address, route, tags, user, certificates, polled, and the address
macros as Zabbix holds them; what differs in bold) and three answers; **nothing is sent until Confirm**:

| Decision | What happens |
|---|---|
| **Skip** | The host stays out. The existing cluster stays exactly as it is. |
| **Update** | The host takes the cluster over. A config-file cluster is set aside — kept in the file, no longer used by the pages (*Config-file clusters set aside* in Sync options); the core still holds it primed, so with *Use ElasticPro credentials* its credential is the one the Zabbix host uses. A Zabbix host in use is no longer built. Neither Zabbix nor the file is changed. One Update per cluster (`already_updated`). As before, a host that cannot sign in yet does not set a working config cluster aside until it can. |
| **Keep both** | Both are clusters, each with its own id (the same Elasticsearch, polled twice). |

**A decision persists** in `<data>/zabbix-conflicts.json` (0600, tmp + rename; the report worker
reads it again when it changes and never writes it), keyed by Zabbix host id, with the Zabbix values
it was made on (`fingerprint`: name, address, technical name, route, user, client — Zabbix's own,
not what ElasticPro laid over them). A later sync with the same values applies it without asking.
When Zabbix's values change the decision **keeps applying** and the entry is asked again
(`state: "changed"`, with `decidedValues` beside the new ones) until an administrator confirms. A
conflict that goes away (the host moved, the cluster was removed) forgets an undecided entry and
keeps a decided one, which applies again if the same conflict returns. An edit in ElasticPro
(`ZABBIX_CLUSTER_SAVE`, the overlay) is not Zabbix changing: it does not ask again.

**Upgrading.** The first build with no `zabbix-conflicts.json` records what the pages did until
then, so the upgrade changes nothing: a config-file cluster the earlier rule set aside (same address
but for a trailing slash and case) is recorded as **Update**; any other conflict — a default port
only, or two Zabbix hosts at one address, all of which were in use — as **Keep both**. Each is listed
as decided by `as before review existed` and can be changed. This **fails closed**: a build is the
first only while no record was ever kept and none was tried in this process; when its record cannot be
written, nothing it would have recorded applies and every conflicting host is held — and the next
build is no first run either. An unreadable file is never a first run. The report worker never runs
one: with no record it holds every conflict until the core has written it. A host `createHosts` makes from a config-file cluster is
recorded as **Update** by `createHosts` when it is made — that is what the option asks for.

**Preview sync** (button on the Zabbix tab, administrators): what a sync would do now — clusters it
would add, change (field by field) and remove, hosts it would hold, and the hosts `createHosts`
would make — read from Zabbix (and Vault) now. **A dry run writes nothing**: not the cluster list,
not `zabbix-conflicts.json`, not an overlay, not Zabbix, and no run is recorded in the jobs log.

| Message | Role | Answer |
|---|---|---|
| `ZABBIX_CLUSTERS` (fields) | guest | Each row: `identity`, and for a host let in by a decision `review` (`update` \| `keepBoth`) and, for an Update, `replaces: {kind: "config"\|"zabbix", id, hostId, name, url}` — the pages set a config-file cluster aside by this id and nothing else. An administrator of every cluster also gets `held: [entry]` and `reviewNeeded` (pending + changed); anyone else `held: []`, `reviewNeeded: 0`. An entry: `{hostId, host, clusterId, identity, state: "pending"\|"decided"\|"changed", decision, decidedBy, decidedAt, firstSeen, fingerprint, existing: {kind, id, hostId, values}, zabbix: <values>, decidedValues}`; `values`: `{name, url, via, tags, username, tls, enabled}` (Zabbix's also `host`, `client`); not set is `null`. |
| `ZABBIX_CONFLICT_DECIDE {hostId, decision: "skip"\|"update"\|"keepBoth", fingerprint}` | admin | `{ok, hostId, decision, entry}` — kept, then applied at once from the last sync's reading without asking Zabbix. `fingerprint` is the entry's as the review showed it. Refusals: `forbidden` (below admin; an admin limited to some clusters), `bad_message`, `not_found` (the last sync holds no such host), `changed_since_review` (Zabbix's values moved since the review was opened), `already_updated` (another host already took that cluster over), `io_error`, `not_available` (not hosted). Audit line `zabbix conflict decided` with `user`, `host_id`, `host`, `decision`, `previous`, `against`, `address`; a refusal `zabbix conflict decision refused`. |
| `ZABBIX_SYNC_PREVIEW` | admin | `{ok, dryRun: true, at, lastSync, add: [{hostId, id, name, url, host}], change: [{hostId, id, name, fields: [{field, from, to}]}], remove: [...], hold: [entry], wouldCreate: [{id, name, url}], skipped: [text], unchanged, clusters, inUse}` — `change` compares `name`, `url`, `via`, `tls`, `enabled`, `client`, `credential`, `credentialOk`, `zabbixGroups`, `replaces` with the last sync's rows; `hold` is every entry pending, skipped or changed. `forbidden` below admin or for an admin limited to some clusters; `not_configured`; `zabbix_error`. |

## Zabbix clusters edited in ElasticPro — the message contract

Hosted only. A cluster that comes from Zabbix (a host on the cluster template) is built
from the host at every sync. Config-Management › Clusters › **Edit** (and the Clusters page's name
menu) now opens the same dialog a config-file cluster has, for a Zabbix cluster too — with the
**URL read-only, "From Zabbix"**: the address is never set in ElasticPro. It always comes from the
host's `{$ELASTICSEARCH.HOST}`, `PORT`, `SCHEME`, so whether it is at the address of another cluster
is decided once, by the review (*Zabbix sync — hosts held for review*, above), and a credential bound
to the old address is not sent to a new one.

**Zabbix is never written to.** What is changed is kept by the core as an **overlay**, keyed by
the Zabbix **host id** (stable when the host's name or technical name changes), in
`<data>/zabbix-overrides.json` (0600, tmp + rename) beside `cluster-meta.json`, and in the backup's
*Clusters* section (items `zabbix:<host id>`). At every sync the overlay is laid over what Zabbix
says, and **the overlay wins**: when Zabbix changes a field the overlay also sets, the overlay's
value is used. The dialog marks each such field **Set in ElasticPro**, with Zabbix's value and a
**Use Zabbix's value** button that removes just that override.

| Field | Applied by |
|---|---|
| `name`, `via` (a jump host id, `""` = direct), `tls` (`auto`, `system`, `insecure`), `enabled` | the core: what is polled, and how (`enabled: false` — listed, not polled) |
| `liveRetention`, `snapshotRetention`, `backupCapacity` | the core's capacity document (history store) and the pages' volume report |
| `tags` (the client tag is Zabbix's value; `zabbix` is always added), `note`, `volumeWindowDays` (1–90), `volumeTopDays` (1–90), `volumeHeadroomPercent` (0–200) | the pages, from the `ZABBIX_CLUSTERS` row |

The cluster type, ULM and SLM stay `CLUSTER_META_SET` (an admin's, part of the same dialog).

**Its own credential.** An admin may type a credential for a Zabbix cluster in the dialog (*Its
own credential, set here*). It goes to the same encrypted store as a config cluster's own
(`cluster-secrets.json`, `cfg:<cluster id>`, `CREDENTIAL_SET`), bound to the cluster's destination —
the address from Zabbix, the route and the certificate setting — and is never sent back. While it
is kept for the current destination it wins over Zabbix's (Vault, a macro, one Cluster Management
handed over, or the default); the row says `credential: "elasticpro-own"`. When Zabbix moves the
cluster, or the route changes, it is not sent (`ownCredentialMoved: true`, and Zabbix's is used); an
admin re-binds it (`CREDENTIAL_SET {rebind: true}`, asked in the dialog) or types it again. *Zabbix's
credential* in the dialog forgets it (`CREDENTIAL_CLEAR`). A rename of the host's technical name
(a new cluster id) moves the kept credential with it.

**Who.** The same as a config cluster: an operator or an admin, on a cluster they see — through
the role gate (`auth::required_role`), as `CLUSTER_SAVE`. (`Writes::decide` gates writes *to a
cluster*; neither save writes to one.) Below admin, two things are refused: **certificates off**
(`tls: insecure`, kind `tls_insecure`) on any cluster — the same now holds for a config cluster's
`CLUSTER_SAVE`, where an operator can no longer newly make a cluster insecure (one already insecure
stays so); and the **route or certificate setting** (set or reset) of a cluster that signs in with a
credential of its own (`credential_destination`): a password from Vault, a password macro, one Cluster
Management handed over for the host, one kept in ElasticPro (even for another destination), or — with
ElasticPro's credentials in use — a config cluster's own at the address. One on the default or on
ElasticPro's shared credential, or with none, an operator may route. A credential is an admin's.

**A host that disappears** from Zabbix keeps its overlay (an orphan), shown nowhere; when the host
returns — under any name, the host id is the key — the overlay applies again. A *Replace* restore of
the *Clusters* section removes overlays the backup does not hold, like everything else in it.

| Message | Role | Answer |
|---|---|---|
| `ZABBIX_CLUSTER_SAVE {hostId, set?: {field: value}, reset?: [field]}` | operator | `{ok, clusterId, hostId, overridden: [field], cluster: <the ZABBIX_CLUSTERS row after the change>}` — applied at once from the last sync's reading, without asking Zabbix. Refusals: `url_from_zabbix` (`url`, `host`, `port`, `scheme`…), `credential` (`username`, `password`, `apiKey`, `bearer`…: `CREDENTIAL_SET`), `cluster_type` (`type`, `ulm`, `slm`: `CLUSTER_META_SET`), `unknown_field`, `bad_request` (a value out of range; an empty value — reset instead), `unknown_jump`, `name_taken`, `credential_destination` and `tls_insecure` (below admin), `forbidden`, `not_found` (no such host in the last sync), `bad_message`. Audit line `zabbix cluster edited in ElasticPro` with `user`, `cluster`, `host`, `set` (field names), `reset`. |
| `ZABBIX_CLUSTERS` (row fields) | guest | Effective `name`, `via`, `tls`, `enabled`, `tags`, `note`, `liveRetention`, `snapshotRetention`, `backupCapacity`, `volume*` (null when not set — never a guess); `overridden: [field]`, `zabbixValues: {name, via, tags}`, `overriddenBy`, `overriddenAt`, `ownCredential`, `ownCredentialMoved`, `credentialIsOwn` (its credential is its own — Zabbix's per-cluster or ElasticPro's — so its route is an admin's). |

## Plan templates — the message contract

0.3.53. Reports › Planning sizes a new or existing cluster from a **plan template**
(`docs/REPORTS.md`, "Planning (board 8) and Plan templates (board 10)"). Templates are shared
settings: admins edit them (Config › Reports › Plan templates), everyone plans with them. Hosted:
`<data>/plan-templates.json` (0600, tmp + rename); a missing file reads as the two seeded templates,
**Standard** and **Small / lab**. Desktop: the page keeps the list in the browser
(`localStorage`, `elasticpro.planTemplates`); the core answers from memory and holds nothing.

A template is `{name, backup: "disk"|"s3"|"ulm", roles: [role]}`. A role is
`{on, name, rule, cpu, ram, root, notes, ...}` with `rule` one of `volume` (`cap`: GB per day per
server), `fixed` (`count`), `tier` (`tier`: `hot`|`warm`, `nodeTB`), `whenData` (`count` from `from`
data nodes), `follows` (`of`: another role's name, `per`: one per N of it) or `target` (`target`:
`s3`|`ulm`, `cap` for `ulm`). `cpu`, `ram` (GB), `root` (GB) and every rule number are a number
>= 0 or `null`; `null` is "[set]" in the page and is never taken as 0.

| Message | Role | Answer |
|---|---|---|
| `PLAN_TEMPLATES_GET` | user | `{ok, templates: [...], custom, updatedBy?, updatedAt?}`; `custom: false` = the seeds. A display link is refused. |
| `PLAN_TEMPLATES_SET {templates}` | admin, no cluster limit | The whole list replaces the stored one; answers as GET. `bad_request` for a duplicate template name (case-insensitive) or role name, an unknown `rule`, `backup`, `tier` or `target`, a negative or non-numeric value, a `follows` that names no role or loops, an empty list, more than 50 templates or 60 roles, a body over 256 KB. `forbidden` for an administrator limited to some clusters (the templates serve every cluster, like Play's fleet-wide settings). Audit line `plan templates changed` (`templates`, `changed`); activity action `plan_templates_set`, category `configuration`. |

## Play (NOC wall display) — the message contract

0.3.47; docs/PLAY.md is the design. The wall runs the same UI code as every page; the core adds
only display links, the Play settings, node-name history, shared acknowledgements and a shared
measurement cache. Times are ms since the epoch. Every reply that names clusters is cut to the
clusters the caller sees: Zabbix group scope, and a display link's own cluster list.

**Display links** (hosted only; `UI_PLAY_ENABLED=false` turns them off and ends every TV on one).
A link is a secret this core issued: only its SHA-256 is kept (`<data>/play-links.json`, 0600),
and the secret is shown once, in `PLAY_LINK_CREATE`'s reply. The TV opens
`https://<host>/#/play?display=<secret>`; the page sends `PLAY_EXCHANGE`, and the bridge turns
the session into the same HttpOnly / Secure / SameSite=Strict cookie a sign-in gets (and takes it
out of the reply). That session's caller is `display:<name>`, role user, **`play_only`**: it may
send only `PLAY_READS` (`auth.rs`) — FLEET_STATE, CLUSTER_DATASET, EVENTS_TICKET, REFRESH,
VOLUME_DAILY / MONTHLY / MONTHLY_ALL, SILENCE_LIST, ACK_LIST, PLAY_STATE, PLAY_ZOOM_SET,
PLAY_SHARE_GET / PUT (`delay` only), PING, CONFIG_VIEW, ZABBIX_CLUSTERS, CLUSTER_META_GET (type and ULM), WHOAMI, LOGOUT, the
shell's startup no-ops, and `ES` only as the log-delay measurement itself (`auth::play_es_shape`):
the cluster's own `logIndexPattern` (a cluster with none: one plain pattern, no comma, nothing
starting with `.`), no query parameter but `ignore_unavailable`, `allow_no_indices` and (for
`_field_caps`) `fields`, `_field_caps` as a GET without a body, and `_search` with exactly the body
`buildSearchBody` makes (`size: 0`, one time range, a terms aggregation of at most 500 devices with
one newest document each). Anything else: `{ok: false, kind: "forbidden", playOnly: true, message:
"a display link only shows Play…"}`. It never writes (`allowWrites` is dropped before
`Writes::decide`). The caller is rebuilt from the link at every request, so revoking it, its
expiry, or switching links off ends every TV on it at once; `allowFrom` is checked on every
request against the address `source_of` decides (X-Real-IP only from `ELASTICPRO_TRUSTED_PROXIES`).
A link keeps its five newest sessions (a TV that reloads makes a new one); a display-link session
unused for a day is ended by housekeeping, like a Zabbix frame's.

| Message | Role | Answer |
|---|---|---|
| `PLAY_LINK_CREATE {name, clusters: "all"\|{group}\|[ids], allowFrom?: [cidr], expires?: "permanent"\|days, settings?}` | admin | `{ok, link: {id, name, url, clusters, allowFrom, expires, expiresAt, createdAt, createdBy, …}, secret}` — `url` is `<ELASTICPRO_PUBLIC_URL or the browser's origin>/#/play?display=<secret>`, shown once. Default expiry: permanent. |
| `PLAY_LINK_LIST` | admin | `{ok, enabled, links: [{id, name, clusters, allowFrom, expires: "permanent"\|{at}, expiresAt, expired, createdAt, createdBy, lastSeen: {at, from}\|null, sessions, settings}]}` — never a secret or a usable URL. |
| `PLAY_LINK_REVOKE {id}` | admin | `{ok, id, sessionsEnded}`; its sessions end at once. |
| `PLAY_LINK_SET {id, settings}` | admin | The display's settings, merged: `{slides: [{id, show, dwellSec}] (ordered; fleet, alerts, spotlight, delay, backups, volume), criticalTakesScreen, spotlightAll, theme: dark\|light, sound: off\|chime, zoom: null\|0.8…1.5, fleetOrder: 1–3 of critical, logDelay, volume, disk, alerts, name}` (`zoom: null`: the TV keeps its own). → `{ok, id, settings}`. |
| `PLAY_EXCHANGE {secret}` | none | `{ok, caller, display: {id, name}, cookie: true}`; `bad_credentials` for an unknown, revoked or expired link, `forbidden` from an address `allowFrom` does not name, `disabled` / `unsupported`. |
| `PLAY_CONFIG_GET` | user | `{ok, watch, exclude: [{clusterId, reason, by, at, managed?}], defaultDisplay, managed: [UI_PLAY_* keys], managedFields: {"watch.x": key}, linksEnabled, options}`; an admin also gets `displays`, `links`, `groups` (the Zabbix user groups the clusters carry). |
| `PLAY_CONFIG_SET {settings}` | admin | One of `{watch: {...}}` (merged; a locked field with another value: `kind: "managed"`), `{exclude: {add: {clusterId, reason}}}` / `{exclude: {remove: clusterId}}` (a reason is required; `by`/`at` stamped by the server), `{defaultDisplay}`, `{displays: {<linkId>: {...}}}`. Answers as `PLAY_CONFIG_GET`. Audited. |
| `PLAY_STATE {open?: [alertKey]}` | user, play_only | `{ok, settings: {watch, display}, zoom, excluded: [ids], nodes: {clusterId: {expected, present, left: [{node, since}], asOf, answering}}, openSince: {alertKey: at}, now}`. `open` is this display's open alerts; each keeps its first time per display (`<data>/play/open-since.json`). |
| `PLAY_ZOOM_SET {zoom}` | play_only | A display link's TV saving its − / +: `{ok, zoom, fixed}`. A fixed `zoom` in the display's settings wins. |
| `PLAY_NODE_FORGET {clusterId, node}` | operator | `{ok}`; the node is no longer expected (and unpinned). Audited. |
| `PLAY_SHARE_PUT {kind: "delay"\|"repoSize", clusterId, measuredAt, data}` | user (play_only: `delay`) | `{ok, kept}` — `kept: false` when a newer one is held. Delay data is a list of device records or `{devices: [...]}`, at most 2,000 and 1 MB; a repository size an object up to 64 KB. Kept 48 h on disk (`<data>/play/share/<kind>/`). |
| `PLAY_SHARE_GET {kind, clusterIds?}` | user, play_only | `{ok, kind, records: {clusterId: {measuredAt, putAt, by, data}}, keepHours}`. |
| `ACK_LIST` | user, play_only | `{ok, acks: {key: {by, at, note?, record?}}}` (`<data>/acks.json`, hosted; desktop keeps IndexedDB). |
| `ACK_SET {key, note?, record?}` | user | `{ok, key, ack}`. `record` is acks.js's own record; the server stamps `ackedBy`/`ackedAt` when this change acknowledges, and the author of each new note. Audit line `alert acknowledgement set` (user, key, note length — never the note). |
| `ACK_CLEAR {key}` | user | `{ok, key}`. Audited. |

**Node-name history** (`<data>/play/nodes.json`) is fed from every `nodes` entry the fleet poller
completes — the names it already fetched, never a request of its own. A name not seen for 24 h is
no longer expected (or, with `nodeExpected: "pinned"`, the pinned list is). "Left" holds while the
cluster answers.

**config.txt** (`UI_PLAY_*`, see `deploy/config.txt.example`): each key locks its `watch` field;
`UI_PLAY_EXCLUDE` adds exclusions (reason *set in config.txt*, `managed: true`) the page cannot
remove; `UI_PLAY_ENABLED=false` turns display links off.

## Backup and restore — the message contract

0.3.55. System › Backup & restore puts everything ElasticPro knows about the clusters into one
file, `.epbak`, to keep, to carry to a new server, or to load back. Elasticsearch data is not in
it — snapshots cover that. Administrators only, and not one limited to some clusters: a backup
holds every cluster and the server's own settings. A display link reaches none of it. `PING`
says `backup: {supported: true, scheduled}` (`scheduled`: kept backups and the timer exist on
this edition — hosted).

**Sections** (tick what to include; `sections` absent = all). Each section is a map of named
items, so a preview can say per item what a restore would do and the same rules merge and
replace every section.

| Section id | Label | Read from / written back through |
|---|---|---|
| `clusters` | Clusters and their settings | config `clusters` (by `name`) with each cluster's type and ULM bucket (`cluster_meta`), the shared `credentials`; hosted: the credentials kept on the server (`cluster-secrets.json`) and the edits made in ElasticPro to Zabbix clusters (`zabbix:<host id>`, `zabbix-overrides.json`). Written through the config write path and `ClusterSecrets::set_bound`. |
| `trust` | Jump hosts, pinned host keys and certificates | config `jump_hosts` (map or list), `pins.json` (`cert:`/`hostkey:` items), uploaded jump-host keys (`key:` items; the key text is a credential). |
| `alerts` | Alert triggers and Automation rules | config `alerts` (or `alertRules`/`alert_rules`, the key is remembered in `meta.triggersKey`) as `trigger:` items, `automations` as `rule:` items (validated by `cluster_save::apply_automations`). |
| `requests` | Request policy and Defaults | the request policy (`policy.json`, without the emergency stop; applied through `policy_apply`, so a managed field is still refused), config `defaults` without `volume`. |
| `zabbix` | Zabbix connection, role mapping, roles set by hand | hosted: `zabbix-link.json` as `link` (URL, API URL, TLS, sources, sync period — **never the API token, the pairing secret or the pairing record**), config `zabbix` as `options` and `roleMap`, and `role:<name>` for every account whose role was set by hand (`USER_SET_ROLE` / No access). |
| `reports` | Reports: indices, volume fields, mail, plan templates | `mail` (SMTP settings; the password is a credential, bound to its server), `schedules` (report schedules), `template:` items (plan templates, only when custom ones are kept), `volume` (config `defaults.volume`). |
| `play` | Play: displays, watch rules, exclusions | `play-settings.json`: `watch`, `exclude`, `defaultDisplay`, `display:<id>` — never the display links or their secrets. Written through `play::settings::apply_change`. |
| `data` | History store and scheduled log delay settings | `historyStore` (URL, auth kind, user, TLS, via, prefix, streams; the secret is a credential) and `logDelay` (the sink config without `enabled`). **Both restore disarmed**: the two gates are taken again by hand. |
| `versions` | Earlier config versions | `config-history/`, each version redacted the same way as the live config, with its who/what record. Only ever added by a restore, never overwritten or trimmed. |

**The file.** JSON: `{format: "elasticpro-backup", formatVersion: 1, coreVersion, takenAt,
takenBy, kind: manual|scheduled|before-restore, sections: {id: {items, meta?}}, credentials?,
digest}`. `digest` is `sha256:` over the canonical `sections`; a file whose digest does not match
is refused unread (`corrupt`), a `formatVersion` above the server's is refused (`newer_format`:
upgrade first, a restore never guesses), a section id the server does not know is left alone and
named in `unknownSections`. Over 16 MB: `too_large`.

**Credentials never travel in the clear.** Every secret in the sections — cluster passwords and
API keys (a `password`, `apiKey`, `token`, `secret`… field or a URL's `user:pass@`), the shared
credential, the server-kept credentials, the SMTP password, the history store's secret, uploaded
jump-host keys — is pulled out into one `credentials` blob, `{count, scheme, sealed}`, which is
either **left out** (no password typed: the file has no `credentials` key, a preview of it shows
`backup.credentials: null`, and the `BACKUP_CREATE` reply says `credentials: "none"` and how many
were `leftOut`) or **sealed**: `scheme: "password"` with the backup password the admin typed
(at least 12 characters, `weak_password` otherwise; `crypto::seal` — PBKDF2-HMAC-SHA512, 600 000
rounds, AES-256-GCM, the same sealing as the config master password) or `scheme: "server"` under
this server's own key (`cluster-secrets.key`, AES-256-GCM) for a copy that stays on this server.
The sealed text carries the digest of the sections it belongs to, so a blob spliced onto another
backup is refused (`tampered`). **Never in a backup**, whatever is ticked: the Zabbix API token,
the Zabbix pairing secret, display-link secrets, accounts, sessions, API tokens — a restored
server pairs and issues again. The backup password is never stored, logged or echoed; the
schedule holds none (`BACKUP_SCHEDULE_SET` refuses a `password` key).

**Kept backups** (hosted): `<data>/backups/elasticpro-backup-YYYYMMDD-HHMMSS-<kind>.epbak`, 0600
in a 0700 directory, credentials sealed under the server's key — the download of a manual backup
carries the password-sealed text the admin asked for, the kept copy is the server's. The name
sorts by local time; a second in the same second gets `-2`. **Schedule** (`backups/schedule.json`,
shipped on): every `day` at `02:00` server time (`TZ`), the last `14` kept (1–90), every section;
checked once a minute, runs once per local day (or once per seven days for `week`) — a server
that was down at 02:00 runs it at the next tick. Rotation removes the oldest beyond `keep` and is
audited (`backup rotated out`). **Every restore first keeps the current state** as a
`before-restore` backup (every section, server-sealed), so it can be undone by restoring that; if
that copy cannot be written — or this server has no key to seal its credentials with
(`no_server_key`) — nothing is restored. The same refusal stops a scheduled or `keep: true`
backup: a kept copy is never silently written without its credentials.

| Message | Role | Answer |
|---|---|---|
| `BACKUP_STATUS` | admin | `{ok, supported, keeps, dir, serverSealing, minPassword, sections: [{id, label}], schedule: {enabled, every, at, keep, keepMax, sections, last: {at, ok, name?, bytes, message?, localDay}?, next}, kept: [{name, bytes, takenAt, takenBy, kind, kindLabel, sections, credentials: password\|server\|none, credentialsCount, coreVersion, readable, problem?}]}`. `keeps: false` (desktop, or no data directory): download only, `kept` is empty. A damaged kept file stays in the list as `readable: false`. |
| `BACKUP_CREATE {sections?, password?, keep?}` | admin | → `{ok, name, bytes, file, credentials: password\|none, secrets, leftOut, kept, notes, sections}`. `file` is the backup's text (the browser saves it as `name`). `password` (≥ 12 characters) seals the credentials; none leaves them out. `keep: true` also keeps a server-sealed copy and rotates (`unsupported` where nothing is kept). `notes` say what could not be included (a jump-host key that could not be read, a stored password the server key does not open) — said, never guessed. Audit line `backup created` (`user`, `kind`, `sections`, `credentials`, `secrets`, `bytes`, `kept`). |
| `BACKUP_DOWNLOAD {name}` | admin | A kept backup's text: `{ok, name, bytes, file}`. `bad_request` for a name that is not one of ours, `not_found` when it is gone. Audit line `backup downloaded`. |
| `BACKUP_DELETE {name}` | admin | Removes a kept backup; answers as `BACKUP_STATUS`. Audit line `backup deleted`. |
| `BACKUP_SCHEDULE_SET {schedule: {enabled?, every?: day\|week, at?: "HH:MM", keep?, sections?}}` | admin | Absent keeps a field; any other key (`last`, `password`) is `bad_request`. Saves, rotates to the new `keep`, answers as `BACKUP_STATUS`. `unsupported` off hosted. Audit line `backup schedule changed`. |
| `BACKUP_PREVIEW {file \| name, password?, skipCredentials?, sections?}` | admin | **Writes nothing.** `file` is uploaded text, `name` a kept backup. → `{ok, name, backup: {formatVersion, coreVersion, takenAt, takenBy, kind, kindLabel, sections, unknownSections, credentials: {count, scheme} | null, bytes}, credentials: {state}, preview: [{id, label, present, add: [item], change: [item], same, onlyHere: [item], keptAnyway: [item]}], formatVersion}`. `backup.says` = `{takenBy, takenAt, coreVersion, verified: false}`: the file's own account of itself. `credentials.state`: `none` (the file has none), `skipped`, `opened` (+ `count`: the password or the server key opened them — they are dropped again, a preview never says what they are), `locked` (+ `kind`: `password_needed` or `server_key`, + `message`). A wrong password is `bad_password` and the preview is refused; `present: false` is a section the file lacks. |
| `BACKUP_RESTORE {file \| name, mode: merge\|replace, sections?, password?, skipCredentials?}` | admin, no cluster limit | First the `before-restore` backup, then the sections (only those the file holds; `bad_request` when it holds none asked for). **Merge** adds and updates and keeps what is only here now — including a credential the backup did not bring (a file made without a password, or an older one): what this server holds is filled back in, so a merge never costs a cluster its live password; **Replace** makes each ticked section the backup's, so what is only here now is removed — exactly the items the preview listed under `onlyHere` (`Section::replace_removes`: records in lists, the shared credential, Zabbix options and role map, `defaults.volume`, Play's exclusions); the preview's `keptAnyway` (the request policy, Defaults, the Zabbix link, mail, report schedules, watch rules, history store, delay sink, versions) survives a Replace that brings none, and `removed` counts only the former. A trust pin whose `sha256` is not a SHA-256 certificate digest (64 hex characters) or an OpenSSH `SHA256:` host-key fingerprint is skipped and named. Roles set by hand go through the same rule as `USER_SET_ROLE` (never the restorer's own administrator role, No access only for an account another system signs in, open sessions refreshed or ended). The config is changed in memory and written once through the config write path (a version kept, `saved_by` the restorer, the record says what changed); the stores with setters of their own go through them (policy, Play, delay sink, history store, mail, plan templates, pins, keys, roles). Opened credentials are re-sealed under this server's key; `skipCredentials: true` or a file without any restores the settings alone and the clusters ask again. A mail or history-store secret typed for another server is not restored and said so. The Zabbix link comes back **without its token** (pair again); roles set by hand apply to accounts that exist here, the rest are named. → `{ok, mode, name, beforeRestore, credentials, backup, applied: [{id, label, added, changed, removed, notes}]}`. A refusal mid-way answers with `beforeRestore` set, so the kept copy is known. Audit lines `backup restored` (`user`, `mode`, `from`, `taken_at`, `taken_by`, `credentials`, `sections`, `before` — left out where the edition keeps no backups, so there is no before-restore copy) and `backup restore refused`. |

Refusal kinds, with their codes in `docs/ERROR-CODES.md`: `weak_password` (EP-308),
`bad_password` (EP-309), `password_needed` (EP-310), `server_key` / `no_server_key` (EP-311),
`not_a_backup` (EP-312), `newer_format` (EP-313), `corrupt` / `tampered` (EP-314), `too_large`
(EP-315); `forbidden` for anybody below admin or an admin limited to some clusters; `unsupported`
where nothing is kept. Activity actions `backup_*`, category `configuration`. One backup-and-keep
or restore runs at a time (two restores interleaved would each keep the other's half-written state
as "before"). Proved by `tests/backup.rs` (in-process: sections, merge and replace, the format
checks, the timer and rotation) and `tools/hosted-check.sh` (over HTTP: admin only, no secret
without a password, the wrong password refused, a preview writes nothing, the before-restore copy
with its modes, the Zabbix token never in a file, the password never in the log). The page's pure
helpers are `ui/js/core/backup-rules.js` (`tools/unit/backup-rules.test.mjs` reads the section
table back out of the core so the two cannot drift).

## Security model

| | |
|---|---|
| Elasticsearch writes | while `readOnly: true` (default) the core refuses anything but GET/HEAD and `_search`-family POSTs, before opening a socket. Two deliberate acts lift it: `readOnly: false` in the config (everywhere), or ticking *Allow writes* — a session-only unlock, held in memory, that applies **only** to actions the operator takes by hand (a console request, a snapshot, an index action). Background refreshes stay read-only either way |
| Credential | in the app process; optionally in the OS vault (opt-in). Never in `pins.json`, never in logs. The YAML is the only file that may hold it |
| Jump host | your SSH key (OpenSSH format, optional passphrase — asked in the app) or a session password; host key TOFU + pin; a key restricted to `restrict,port-forwarding,permitopen="<cluster>:9200"` is enough — the app only forwards to the cluster ports |
| TLS | rustls; OS trust store + Mozilla roots; per-address SHA-256 pin on explicit consent; pin mismatch → credential not sent |
| SOCKS listener | loopback only, ephemeral port, accepts loopback peers only, CONNECT only — nothing else on the machine is told about it |
| Data written by the app | `pins.json`, the remembered config path, theme, console history |
| Backups | `<data>/backups/*.epbak` (0600): the sections an admin ticked, credentials only sealed (backup password: PBKDF2-HMAC-SHA512 + AES-256-GCM; kept copies: the server's own key) or left out; never the Zabbix API token, the pairing secret, display-link secrets, accounts or sessions. A restore keeps the current state first and goes through the config write path. See "Backup and restore" |
| Backup with a password | **By design**: `BACKUP_CREATE {password}` exports every credential this server keeps — cluster passwords and API keys, the shared and the server-kept credentials, the SMTP and history-store secrets, **uploaded jump-host private keys** — in a form the backup password opens (the same KDF and cipher as the config master password, ≥ 12 characters). Administrators only, refused for one limited to some clusters, audited (`backup created` with `credentials=password`, `secrets=N`). The file's `takenBy`/`takenAt` are what the file says (`says.verified: false`): the digest proves the sections were not edited, not who wrote them. A sealed value with more KDF rounds than this project uses is refused unread (no round count typed into a file can set how long a preview keeps a core busy) |

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
- backup and restore (`tests/backup.rs`, `tools/hosted-check.sh`): an operator and a display
  link refused; a backup made without a password holds not one secret and names what it left
  out; a sealed one has none in the clear; the wrong password refused; a preview writes no file
  and no config; a merge keeps what is only here, a replace removes it, each after a
  `before-restore` copy (0600, server-sealed) that this server opens again; the config written
  through the history path with the restorer's name; the Zabbix token neither in the file nor
  cleared by a restore; the timer once a local day, rotating to `keep`
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
