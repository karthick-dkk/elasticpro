# ElasticPro

## What is ElasticPro? What problem does it solve?

ElasticPro is a monitoring and operations console for fleets of Elasticsearch clusters. It runs
as a portable Windows desktop app and as a hosted web app on a Linux server, with the same
Rust core and the same UI in both.

It exists because browser tools cannot do three things an operator behind a jump host needs:

| Problem | What ElasticPro does |
|---|---|
| The cluster is only reachable through a jump host | Opens its own SSH connection with your key file; host keys are confirmed once and pinned; the tunnel reconnects by itself. No ssh.exe, PuTTY or SOCKS setup. |
| Self-signed or internal-CA certificates | Shows the certificate once with a **Trust** button, then pins it. A different certificate at the same address is refused. No CA import, no browser policy. |
| "Failed to fetch" | Every failure is named — refused, DNS, timeout, TLS untrusted, pin mismatch, jump host down — with the next step and, where a decision is needed, the button to take it. |

And because a fleet of thirty-odd clusters needs one poller, not one browser tab each: the
hosted core keeps a fleet cache, every page reads from it, and the operator decides when, how
hard and whether the core goes to the clusters at all.

## One-click installation

Hosted, on a Linux server with Docker (three containers behind nginx on port 443, an
authentication gate in front, a throwaway certificate and a starter config generated for you):

```bash
curl -fsSL https://github.com/karthick-dkk/elasticpro/releases/latest/download/install.sh \
  | bash -s -- --hosted --yes            # --listen 9443 if something already holds 443
```

Then open `https://<server>/` and sign in as `Admin` / `elastic` — change the password on first
use. Add `--cache` for the Redis-backed fleet cache. The installer pulls the published image
for the release and compiles only when there is none.

Desktop, on Windows: download `ElasticPro-<ver>-portable-win64.zip` from the
[latest release](https://github.com/karthick-dkk/elasticpro/releases/latest), unzip, run. One
folder, no installer, no admin rights. macOS (`.dmg`) and Linux (`.AppImage`, `.deb`, `.rpm`)
packages are on the same page; none are code-signed.

Zabbix: the frontend modules and templates are in
[integration-zabbix-elasticpro](https://github.com/karthick-dkk/integration-zabbix-elasticpro);
pair the two UIs with a one-time code from Config → Zabbix.

## Features

- **Clusters** — health, nodes, disk, ILM/SLM, repositories, last snapshot across the fleet; search and sort by anything on the row.
- **Alerts** — every problem on one page, acknowledged and annotated against the problem, not its current value.
- **Indices, Nodes & shards, Snapshots & SLM** — daily indices with maintenance, shard moves and replicas; heap, CPU and disk per node with disk balance; snapshots by the days of data they hold, restore with renaming, repositories.
- **Volume report and analysis** — per-day ingest, what retention costs, whether storage matches the promised policy; daily volume by an ECS field with spike detection; CSV and Excel export.
- **REST console and Live logs** — every method, history with favourites, sixty ready-made requests; tail a day's index with a histogram.
- **Request management** — a Request Centre listing every request the core sends (who asked, how long, how it ended); a request policy (background, hybrid or on-demand, intervals, concurrency, pause per cluster, a per-minute budget, backoff on 429 or timeout); a Tasks panel that tells our searches from anyone else's by `X-Opaque-Id` and cancels under the write guard; a quiet UI that holds updates behind "N updates — Apply" instead of repainting under you.
- **Jump hosts and certificates** — own SSH tunnels with host-key pinning; TLS pinning; every failure named.
- **Security** — a read-only guard in the core: a write needs both an unlocked session and a request the operator asked for by hand; secrets encrypted on disk (AES-256-GCM, PBKDF2-SHA512); every write audited with the user's name.
- **Accounts and roles** — admin, operator, user and guest; Zabbix single sign-on and per-group cluster scope when embedded.
- **Zabbix integration** — five frontend modules (Cluster Management, capacity, resources and volume widgets, the embedded dashboard) and four templates (automation, alerts, client plan, log delay).
- **Snapshot mode** — render every page from a JSON snapshot collected out of band, with no network access at all.

## Server spec requirement to run

Hosted (the stack: core, nginx, Redis, PostgreSQL):

| | Minimum | Notes |
|---|---|---|
| OS | Linux x86_64 with Docker Engine and Docker Compose v2 | Ubuntu 22.04 / 24.04 and Debian 12 are what the installer is exercised on |
| CPU | 2 vCPU | the poller's concurrency (16 requests at once by default) is the only CPU load; lower it on a small host |
| Memory | 4 GB | the shipped container caps are core 1 GB, Redis 512 MB, plus PostgreSQL and nginx; typical use is well under 3 GB. On a host shared with Zabbix or Elasticsearch, plan 8 GB |
| Disk | 10 GB free | images, the fleet cache on disk, PostgreSQL, logs |
| Network | port 443 (or `--listen`) inbound; outbound to each cluster, directly or through its jump host over SSH | the core is never reachable except through nginx |

Desktop: Windows 10/11 x64 with WebView2 (Edge); macOS 10.15 or later; Linux with
`libwebkit2gtk-4.1`. Nothing to install on the clusters: ElasticPro only speaks the
Elasticsearch REST API, read-only unless an operator unlocks writes.

## Author / Contribution

Written and maintained by **Karthick Dkk** ([karthick-dkk](https://github.com/karthick-dkk)).

Issues and pull requests are welcome. Keep the invariants: no network access from `ui/`, no new
HTTP call site outside `http.rs`, no write that skips `guard.rs`, no secret written to disk
unencrypted. Before opening a pull request run what CI runs:

```bash
cargo test -p elasticpro-core --features bridge
cargo clippy -p elasticpro-core --features bridge --all-targets -- -D warnings
node tools/check-ui.mjs && node tools/unit-check.mjs
```

The full reference — configuration, building, each page in depth, the hosted deployment and the
message contracts — is in [docs/REFERENCE.md](docs/REFERENCE.md) and
[docs/HANDBOOK.md](docs/HANDBOOK.md). The per-user activity log for a SIEM is
described in [docs/ACTIVITY-LOG.md](docs/ACTIVITY-LOG.md). A hosted install's one settings file (`deploy/config.txt`) and what the
core does with each key is in [docs/SETTINGS.md](docs/SETTINGS.md). Licensed under [MIT](LICENSE).
