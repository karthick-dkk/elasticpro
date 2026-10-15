# ElasticPro

**Multi-cluster Elasticsearch dashboard for Windows — reaches clusters behind an SSH jump host, decides certificate trust itself, and never writes to a cluster.**

[![build](https://github.com/karthick-dkk/elasticpro/actions/workflows/build.yml/badge.svg)](https://github.com/karthick-dkk/elasticpro/actions/workflows/build.yml)
[![ci](https://github.com/karthick-dkk/elasticpro/actions/workflows/ci.yml/badge.svg)](https://github.com/karthick-dkk/elasticpro/actions/workflows/ci.yml)
[![docker](https://github.com/karthick-dkk/elasticpro/actions/workflows/docker.yml/badge.svg)](https://github.com/karthick-dkk/elasticpro/actions/workflows/docker.yml)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust)
![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows)
![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20x64-000000?logo=apple)
![Linux](https://img.shields.io/badge/Linux-x64-FCC624?logo=linux&logoColor=black)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A portable desktop app (Tauri 2 + a small Rust core, vanilla-JS UI, no Node.js) that shows
the health, disk, repositories, ILM/SLM state, last snapshot and daily indices of many
Elasticsearch clusters on one screen — including clusters that are only reachable through a
jump host. Read-only towards Elasticsearch by design.

## Why this exists

Browser tools cannot do three things an operator behind a jump host needs:

| Problem | What ElasticPro does |
|---|---|
| The cluster is only reachable via a jump host | Opens its **own SSH connection** with your key file (`via: jumpwin`) — no ssh.exe, PuTTY or SOCKS setup. Host keys are confirmed once and pinned; the tunnel reconnects by itself. |
| Self-signed / internal-CA certificates | Shows the certificate once (subject, issuer, validity, SHA-256) with a **Trust** button, then pins it. A different certificate at the same address is refused. No CA import, no browser policy. |
| "Failed to fetch" | Every failure is named — refused, DNS, timeout, TLS untrusted, pin mismatch, jump host down — with a one-line next step and, where a decision is needed, the button to take it. |

## Features

- **Clusters** — health, nodes, disk usage, ILM/SLM status, repositories, last snapshot; search by name, URL, tag, jump host, version or repository, and sort by health, disk, shards, version, last snapshot or open alerts
- **Alerts** — every problem across the fleet on one page, filtered by level and cluster, each row linking to the page that answers it; the count sits on the nav tab. Alerts can be **acknowledged** and **annotated** — who saw it, what was found, which ticket — kept against the problem rather than its current value, so a note written at 86% disk is still there at 91%
- **Volume report** — per-day ingest, what retention costs, and whether each cluster's storage matches the policy it promises; exportable for the whole fleet as CSV
- **Volume analysis** — daily volume broken down by an ECS field (`tag1`, `src_hostname`), with a spike raised when a value goes more than 40% above its own 7-day average
- **Indices** — daily `logstash-<source>-YYYY.MM.DD` indices with a source / date picker, sizes, health; open, close, delete, move a shard between nodes, change replicas and run maintenance, one index or a ticked selection at a time
- **REST console** — every method (GET/HEAD/POST/PUT/PATCH/DELETE), request bar, **Query | Results** side by side, history with favourites, and ~60 grouped ready-made requests (ILM policies, disk watermarks, replica and shard counts, snapshots, diagnostics)
- **Live logs** — tail a day's index with a time histogram
- **Snapshots & SLM** — the latest 5 snapshots per repository (widened on demand), which days of logs each one actually holds (not just when it ran), a searchable list of the indices inside any snapshot, availability of logstash days, policies and last run; create and delete snapshots, restore with index selection and renaming, free the live indices a snapshot already holds, and add, verify, clean up or remove repositories
- **Nodes & shards** — heap, CPU, disk per node; unassigned / initializing shards; **disk balance** across data nodes, whether shard reallocation would actually help, and the requests to run if it would
- **Config in the UI** — add clusters, jump hosts, the shared credential and defaults; saved as `config_cluster.json`
- **Security** — read-only guard in the core: a write needs both a session unlock *and* a request the operator asked for by hand, so nothing that refreshes on a timer can write; secrets in the file encrypted (AES-256-GCM, PBKDF2-SHA512 master password); optional Windows Credential Manager; TLS pinning; SSH host-key pinning
- **Portable** — one folder, no installer, no admin rights; runs on the analyst PC and on the jump server itself
- **Zabbix integration** — pair the two web UIs with a one-time code, and Zabbix gets the fleet: five
  frontend modules (Cluster Management plus capacity, resources and volume widgets, and one that embeds
  the dashboard itself), four templates in [deploy/zabbix/](deploy/zabbix/), and
  `tools/elasticpro-scrape.mjs`, which evaluates the same automation rules the Automation page does so
  an alert fires whether or not anyone has the page open
- **Navigation across the top** — the pages are one row of tabs, so wide tables get the whole window
- **Snapshot mode** — render every page from a JSON snapshot file (`schema: "elasticpro/snapshot"`)
  collected out of band, with no network access at all, so no certificate is ever involved. The file is
  validated before it is trusted and one containing a credential is refused. Whatever collects it is not
  part of this repository; the schema the app accepts is in `ui/js/core/snapshot.js`

## Quick start (Windows, portable)

1. Download `ElasticPro-0.1.0-portable-win64.zip` from [Releases](../../releases) and unzip it anywhere
   (e.g. `C:\Tools\ElasticPro\`). The zip is the whole app: `elasticpro-0.1.0.exe`, the
   `WebView2Loader.dll` it needs beside it, the `portable` marker, an empty `data\`, an example config
   and `SHA256SUMS.txt` over the pair. Keep the folder together — no file in it is optional.
   No binary is committed to this repository; every build is a release asset.
2. **Windows Server 2016 only:** the app needs the Microsoft WebView2 runtime, which Server 2016 does not ship. No install is required — unpack Microsoft's *Fixed Version Runtime* into the `WebView2Runtime\` folder next to the exe (see [docs/HANDBOOK.md → Portable mode](docs/HANDBOOK.md#portable-mode-no-install-at-all)). Windows 10/11 and Server 2019+ already have it.
3. Run `elasticpro-0.1.0.exe`. The binaries are not code-signed: on first run SmartScreen may ask — *More info → Run anyway*.
4. **+ Create new config**, add your first cluster, and (for on-prem clusters) a jump host with your SSH key. Confirm the jump host's key fingerprint once, trust each self-signed certificate once.

Everything the app stores stays in `data\` next to the exe (`portable` marker file): `config_cluster.json`, `pins.json` (fingerprints only), the WebView profile.

### Other platforms

The macOS and Linux desktop packages are release assets too — see [Downloads](#downloads) for which
one to take. On Linux the installer script picks it for you:

```bash
curl -fsSL https://github.com/karthick-dkk/elasticpro/releases/latest/download/install.sh | bash
curl -fsSL https://github.com/karthick-dkk/elasticpro/releases/latest/download/install.sh | bash -s -- --portable
```

The `-s --` matters: `curl … | bash --portable` passes the flag to bash, which rejects it. The script
refuses to install something that cannot run — the desktop app is a windowed x86_64 application, so on
an arm64 box or a machine with no display it stops and points at `--hosted` instead of leaving a
package behind that will never open.

## Configuration

Created and edited in the app (Config page), or hand-written. JSON is what the app writes; YAML from the browser-extension era is accepted as input.

```json
{
  "version": 2,
  "credentials": { "username": "elastic", "password": "enc:v1:pbkdf2-sha512:600000:<salt>:<nonce>:<ciphertext>" },
  "defaults": { "readOnly": true, "autoRefresh": false, "logIndexPattern": "logstash-*", "tls": "auto" },
  "jump_hosts": {
    "jumpwin": { "host": "jump-windows.internal", "port": 22, "user": "elasticpro", "keyFile": "C:\\Users\\me\\.ssh\\id_ed25519" }
  },
  "clusters": [
    { "name": "acme-onprem", "url": "https://203.0.113.50:9200", "via": "jumpwin", "tags": ["onprem"] },
    { "name": "prod-elk",    "url": "https://es-prod-01.internal:9200" },
    { "name": "lab",         "url": "http://192.168.10.25:9200", "tls": "insecure" }
  ]
}
```

| Key | Meaning |
|---|---|
| `credentials` | one credential for every cluster; omit it and the app asks once on start. Per-cluster `username`/`password` override it |
| `password` / `apiKey` / `bearer` | plain, or `enc:v1:…` as written by the app (encrypted with your master password — a hash could not log in) |
| `jump_hosts.<id>` | SSH host, port, user, `keyFile` (OpenSSH format; passphrase is asked in the app, never stored) |
| `clusters[].via` | route through that jump host; the hostname is resolved **on the jump host** |
| `clusters[].tls` / `defaults.tls` | `auto` (OS store, else ask & pin — default), `system` (strict), `insecure` (lab only) |
| `clusters[].indexNameRegex` | named groups `<source>` and `<date>` drive the source picker on the Indices and Live logs pages. A **source** is the tenant inside an index name; a **client** is a whole cluster with its own URL, so one client holds many sources. `<client>` is still honoured for configs written before the rename |
| `clusters[].volumeFields` | ECS fields the Indices page breaks daily volume down by and watches for spikes. Default `tag1, src_hostname`. Each must be aggregatable; a `.keyword` sub-field is tried automatically |
| `clusters[].liveRetention` | how long logs stay on the cluster — `30d`, `90 days`, `3M`, `6 months`, `1y`. Drives the Volume report; omit it and the report says "not set" rather than assuming |
| `clusters[].snapshotRetention` | how long snapshots are kept in the repository. Falls back to the SLM policy's `expire_after` |
| `clusters[].backupCapacity` | total size of the snapshot repository — `2TB`, `500GB`, or a bare number of GB. Elasticsearch has no API for this (a repository is a mount point or a bucket), so without it the Volume report shows backup space used and required but leaves *available*, *free* and *Enough backup space?* unset rather than guessing |
| `defaults.readOnly` | `true` (default) — the core sends only GET/HEAD and `_search`-family POSTs. A write still gets out if you tick *Allow writes* for the session *and* it is an action you took by hand; `false` allows writes from anywhere |

Command line: `elasticpro-<version>.exe --config C:\path\config_cluster.json` (or `ELASTICPRO_CONFIG`) pre-provisions the file, handy on a jump server.

## Building

No Node.js anywhere: the UI is plain ES modules, the CLI is Rust.

**On Windows** — Rust (MSVC) + Visual Studio Build Tools (C++ workload):

```powershell
cargo install tauri-cli --version "^2" --locked
cargo tauri build
# target\release\elasticpro.exe                          portable
# target\release\bundle\nsis\ElasticPro_<ver>_x64-setup.exe   per-user installer
```

**From Linux, without any Microsoft toolchain** — this is how the release zips are made:

```bash
tools/build-windows-cross.sh            # mingw-w64, x86_64-pc-windows-gnu, std from source; idempotent
# dist/ElasticPro-<ver>-portable-win64.zip

tools/build-windows-cross.sh --install  # …and drop the exe at the repo root for a quick local run
```

Runs on Linux (apt) and macOS (brew). The exe carries its version in the name
(`elasticpro-0.1.0.exe`), so which build a machine runs is answerable by looking at it rather
than by starting it. Built binaries are not tracked here — `/*.exe`, `/WebView2Loader.dll` and
`/SHA256SUMS.txt` are gitignored, and the packages that people install come from the release
that CI builds on each platform.

**Run the UI in a browser** (development, tests):

```bash
cargo run -p elasticpro-core --features bridge --bin elasticpro-bridge -- ui 8765   # http://127.0.0.1:8765/
cargo test -p elasticpro-core --features bridge     # unit + integration (real sockets, real TLS)
cargo clippy -p elasticpro-core --features bridge --all-targets
node tools/check-ui.mjs                        # the UI has no bundler: parse + resolve imports
npm i jsdom && node tools/render-check.mjs     # render every page against a running bridge
```

This works on macOS and Linux as well as Windows — the core, its tests and the whole UI run
anywhere; only the Tauri shell and the packaging are Windows-specific.

`lab/README.md` shows how to stand up a mock 80-cluster fleet and a restricted local `sshd`
to exercise the jump-host path end to end.

## How it is built

```
crates/elasticpro-core/   Rust core — everything with a security consequence
  guard.rs           read-only guard: GET/HEAD + search-family POST, checked before any socket;
                     writes need both the session unlock and a per-request flag
ui/js/core/writes.js the UI's single copy of that unlock, shared by every acting page
  tls.rs             OS trust store → trust-on-first-use pin (SHA-256 per host:port); SSH host-key pins
  ssh.rs             SSH client (russh): key/passphrase/password auth, TOFU host keys, reconnect with back-off
  socks.rs           in-process SOCKS5 on 127.0.0.1 → direct-tcpip channels on the jump host
  http.rs            one HTTP client per cluster (reqwest/rustls), exact error classification
  crypto.rs          AES-256-GCM + PBKDF2-HMAC-SHA512 for secrets in the config file
  vault.rs           OS credential store (Windows Credential Manager) — opt-in
  bridge.rs          the JSON message API the UI talks to
src-tauri/           Tauri 2 shell: one `bridge` command, native dialogs, portable-mode setup
ui/                  the app UI: vanilla ES modules, no bundler
tools/               cross-build script, portable README
docs/                HANDBOOK.md (full operator manual), screenshots
```

The UI never talks to the network. Every request goes through the core, which owns the
read-only guard, the TLS decisions and the tunnels — so no page, console or future code path
can route around them. The write unlock is no exception: it lives in the core, is never
written to disk, and grants nothing on its own — a request must *also* be marked as one the
operator asked for, which only a click does. An automatic refresh cannot write even while
the session is unlocked.

## Security

See [SECURITY.md](SECURITY.md). Short version: read-only towards Elasticsearch, credentials
never in plain text on disk, TLS and SSH host keys pinned on explicit consent, loopback-only
listeners, unsigned binaries (verify the `SHA256SUMS.txt` inside the portable zip, or build from
source).

## Volume report

Sizing a cluster needs one number — how much it ingests per day — and that number is easy to
get wrong. A plain seven-day mean under-provisions whenever the window catches a quiet weekend
or a collector outage.

So the per-day figure is the **mean of the three heaviest of the last seven complete days**.
Taking the busiest three sizes against days that actually happen, and the report names the
days it used. Today's index is excluded throughout — it is still being written to, and
counting it drags every average down.

From that it derives, per cluster: the daily figure and a +30% planning buffer, live storage
and how long the free space lasts at the current rate, what the stated retention actually
costs and whether the disk can hold it, the 30/90/365-day requirements, the window of days
actually present on the cluster and in the repositories, and the same for the snapshot
repository once its size has been measured.

Repository size is not a number Elasticsearch reports cheaply, so it stays behind a
*Measure* button — one `_status` call per snapshot — and reads "not measured" until asked.
Rows that cannot be known say so rather than showing a confident zero.

The page reads as a spreadsheet: **one row per cluster**, every parameter a column, grouped
by what it is about, with the cluster column and the header pinned so a wide row stays
identifiable while scrolling. Any column sorts, YES/NO is coloured, and the CSV export uses
the same column definitions so the file and the screen cannot diverge. A per-parameter
summary view is available too.

It also reports what the cluster **actually enforces**, next to what the config says it
should: the **Applied ILM policy** (read from `_ilm/policy`, resolved to the policy the log
indices are really attached to, with the age its delete phase removes them at) and the
**Applied SLM policy** (its `expire_after`, schedule and counts). Where the two disagree the
report says so, which is how retention drift gets noticed.

The headline figures — per-day size, both retention policies, what the storage must hold and
how long the free space lasts — also appear on the **Nodes & shards** page, computed by the
same code so the two cannot disagree.

## Deleting an index safely

Before a live index is deleted, every snapshot repository is checked for it, and **only a
snapshot in state `SUCCESS` with no recorded failure on that index counts** — a `PARTIAL`
snapshot may hold a broken copy, and one still `IN_PROGRESS` has not finished writing it.
The confirmation shows the verdict per index with the newest good copy and where it is.

Indices with no good copy are **unticked by default** and have to be ticked back in on
purpose. "Delete it, it's in a snapshot" is the single most common way to lose log data
when the snapshot turns out to be partial, so the default is the safe one.

The check is one listing per repository, not one call per snapshot, so it is quick even
for many indices. If a repository cannot be read, the dialog says so and treats "not in any
snapshot" as "unknown" for that repository rather than as fact.

The same lookup powers **also search snapshots** on the Indices page: tick it and a name is
looked for both live and inside every snapshot, answering "was it deleted, and can it come
back" without opening two pages.

## Our own load on each cluster

The status strip shows how many requests **this app** sent to the whole fleet in the last
five minutes, and the Clusters page shows the figure per cluster with the rate it implies.
The core counts every request the moment it goes out; a request the read-only guard refused
never reached a socket and is not counted. It exists so "are we stressing Elasticsearch" is
a number rather than a worry.

For reference, measured with `tools/request-meter.mjs`: **one full refresh costs a cluster
14 requests** — the `_cat` and `_cluster` GETs behind the Clusters, Alerts, Nodes, Snapshots
and Volume pages, plus one snapshot listing per repository — and opening the Indices page
adds one more. All of them are cheap metadata reads. Auto-refresh is **off by default**; if
you turn it on at the default 30 s that is about 28 requests a minute per cluster. Re-run
the meter after adding a fetch to any page, so the number stays true.

## Disk balance

With more than one data node, the Nodes page says whether the data is spread evenly and —
the part that matters — whether **moving shards would actually fix it**.

Two different problems get confused here. A cluster can be *skewed*, one node heavy while
others idle, which relocation fixes. Or it can simply be *full*, every node near the
watermark, which relocation cannot fix at all. Telling someone to rebalance a full cluster
sends them down the wrong path for an afternoon, so the verdict distinguishes them and says
`would NOT help — add capacity` when that is the honest answer.

Thresholds come from the cluster's **own** watermark settings rather than assuming
Elasticsearch's defaults, which are routinely changed; when the cluster does not report
them the page says the numbers are assumed.

Alongside the verdict is a list of **suggested requests** — allocation explain, retry failed
allocations, confirm rebalancing is enabled, move a named shard between the two nodes it
identified, clear a flood-stage read-only block, find the oldest indices to delete. Each is
contextual: a flood-stage block is only offered when a node is actually at flood stage. They
open in the REST console prefilled rather than running from the page, because most of them
change cluster settings and should be read first. Anything that writes is labelled.

The verdict also becomes an alert, so it reaches the Alerts page and the nav badge.

## Volume analysis

The index list answers *how much did this cluster take yesterday*. Volume analysis answers
*which device or tag was responsible* — the question asked as soon as the first number moves.

Pick a field (`tag1`, `src_hostname`, or anything else in `volumeFields`) and it aggregates
the last 7–60 days into a daily series per value, with a chart, a sortable table, and CSV
export. Click a value to isolate its trend.

**A value is flagged when its latest complete day exceeds the mean of the previous seven by
more than 40%.** Today is excluded from both sides — it is partial, and counting it would
make every value look like it had collapsed. A value with no history, or a zero baseline, is
never a spike however large it looks. Spikes appear on the page and also become alerts, so
they reach the Alerts page and the nav badge.

One honest limitation: **the size figures are estimates.** Elasticsearch reports store size
per index, never per field value, so a value's share of the day's documents is applied to
that day's index size. The document counts beside them are exact, and the distinction is
stated on screen.

## Hosted on a server

The same core and UI can run on a Linux server and be used from a browser — three
containers, one exposed port, an authentication gate in front:

```bash
curl -fsSL https://github.com/karthick-dkk/elasticpro/releases/latest/download/install.sh \
  | bash -s -- --hosted                      # add --listen 9443 if something already holds 443
```

It pulls the published core image (`karthickdk02/elasticpro-core`) when the release has one and
compiles only when it does not — a cold build of the core is about twenty minutes. It also generates a
throwaway certificate, valid 30 days, and a starter config, and starts the stack. See
[deploy/README.md](deploy/README.md) for the install by hand and
[docs/HOSTED-DEPLOYMENT-PLAN.md](docs/HOSTED-DEPLOYMENT-PLAN.md) for the plan, the phases and
the decisions behind them.

The one thing to know before anything else: the core's HTTP mode trusts an identity header
that the reverse proxy sets *after* authenticating, so the core must never be reachable
except through that proxy. The compose file publishes nginx alone — on 443, or whatever `--listen`
chose; do not add a port for the core. Every write is audited as a JSON line on stdout with the user's name — the
record that answers "who deleted that index".

## Downloads

Every [release](../../releases) carries a package per platform, built by CI on that platform.

| Platform | Package | Notes |
|---|---|---|
| **Windows** x64 | `ElasticPro-<ver>-portable-win64.zip` | **Recommended.** One folder, no installer, no admin rights. Unzip and run. |
| **Windows** x64 | `ElasticPro_<ver>_x64-setup.exe` | NSIS installer, per-user; embeds the WebView2 bootstrapper. |
| **macOS** Apple Silicon | `ElasticPro_<ver>_aarch64.dmg` | macOS 10.15+. Unsigned — see below. |
| **macOS** Intel | `ElasticPro_<ver>_x64.dmg` | macOS 10.15+. Unsigned — see below. |
| **Linux** x64 | `elasticpro_<ver>_amd64.AppImage` | Self-contained; `chmod +x` and run. |
| **Linux** x64 | `elasticpro_<ver>_amd64.deb` | Debian/Ubuntu. Needs `libwebkit2gtk-4.1-0`, `libgtk-3-0`. |
| **Linux** x64 | `elasticpro-<ver>-1.x86_64.rpm` | Fedora/RHEL. |

No binary is committed to this repository. A build is a release asset, which means rolling a machine
back is a matter of taking the package from an older release's page rather than hoping the right file
is still in the tree. A binary tracked beside its own source drifts behind it, and then ships to
whoever clones the repository.

**None of the binaries are code-signed.** Windows SmartScreen: *More info → Run anyway*.
macOS Gatekeeper refuses an unsigned, un-notarised app outright — right-click → *Open*, or
`xattr -dr com.apple.quarantine "/Applications/ElasticPro.app"`. Verify checksums or build
from source if that matters to you.

### What differs by platform

The Rust core, the read-only guard, the TLS and SSH host-key pinning and the whole UI are the
same everywhere. Three things are not:

| | Windows | macOS | Linux |
|---|---|---|---|
| Web view | WebView2 (Edge) | WKWebView | WebKitGTK |
| Portable mode (`portable` marker, `data\` beside the exe) | yes | no — use the app bundle | no — use the AppImage |
| Optional OS credential store | Credential Manager | Keychain | kernel keyring — **login session only** |

Windows is the platform the app is deployed and documented for; macOS and Linux builds exist
so the app can be run and developed anywhere, and are less exercised in the field.

## Documentation

- [docs/HANDBOOK.md](docs/HANDBOOK.md) — full operator manual: portable mode, configuration reference, build routes, deployment, what was verified
- [lab/README.md](lab/README.md) — local test bench (mock fleet + restricted sshd)
- [CHANGELOG.md](CHANGELOG.md)

`ES_delay_finder.py` at the repository root is a standalone operator script, not part of the
application: it reports log-delivery delay straight from Elasticsearch and mails a summary. It
shares its definition of a delayed device with the Live logs page (see the comment at
`ui/js/core/log-delay.js:485`), which is why it is kept alongside. It has its own configuration
block at the top of the file, is not covered by the test suite and is unsupported.

## Contributing

Issues and pull requests are welcome. Keep the invariants: no network access from `ui/`, no
new HTTP call site outside `http.rs`, no write that skips `guard.rs`, no secret written to disk
unencrypted, scripts idempotent. Before opening a PR run what CI runs:

```bash
cargo test -p elasticpro-core --features bridge
cargo clippy -p elasticpro-core --features bridge --all-targets
node tools/check-ui.mjs
```

`tools/render-check.mjs` (needs `npm i jsdom` and a running `elasticpro-bridge`) draws every page
and fails on the first exception — the static check cannot see a call to something that was
never imported, and a blank page is the usual symptom.

## License

[MIT](LICENSE)
