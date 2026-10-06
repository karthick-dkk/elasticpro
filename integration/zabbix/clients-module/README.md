# Cluster Management (Zabbix 7.0 module)

**Cluster Management** (Super admins; Zabbix Admins read-only): every client, its status, whether
its monitoring is set up and working, open problems, when its storage fills, and the last change —
add, edit, clone, disable, maintenance, decommission, bulk import, backups, roles.

## Clients

The form is five cards: **Client** (name, type, purchased by storage or devices; SOC/Manager lead,
cluster DL and contract end date), **Elasticsearch** (URL, user, password, monitored by), **Log archive (S3)**, **Servers** and **Requested capacity**.

| Action | What happens |
|---|---|
| **Add client** | Creates (or reuses) the host group named after the client, then `<client>-Master` (figures, alerts, dashboard), `<client>-ES-Cluster` when an ES URL is given, `<client>-ULM` when a bucket is given, and one Linux host per server. |
| **Type** | **DI**: log archive (S3 bucket, region) and ES URL required. **On-Prem**: optional. tag1 values are not typed in: the archive check finds them in the cluster once a day. |
| **Servers** | Added one at a time: an IP (or several pasted), one or more roles, optional extra services and notes. The host name follows the roles: `karthi-AIML-1`, `karthi-ES-Data-Parser-Engine-1`, `karthi-ES-Data-Hot-Coord-1`; **Single node** (`karthi-Single-Node-1`) stands for ES + Parser + Forwarder + Engine. The page previews each name before it is added. |
| **Password** | **Vault** (a `path:key`) or **Zabbix secret** (typed once, kept as a secret macro on the cluster and archive hosts, never shown again). |
| **Monitored by** | The Zabbix server, a proxy or a proxy group — every host of the client except the master is monitored through it. Or **Windows jump host (SSH), no proxy**: see below. |
| **Requested capacity** | Per role; rows appear for the roles the servers have ("+ Request another role" for capacity not built yet). A family's total adds up the roles that count in it. |
| **Set up as client** | For a cluster made by hand before this page. Its hosts are **kept** — history, passwords — renamed to the pattern, and only what is missing is added. |
| **Edit** | Change anything. Changing a server's roles renames it and moves it between role and family groups; removing a server deletes its host **only if this page made it**. |
| **Clone** | A new client started from an existing one: roles, requested capacity, purchase and settings (monitored by, jump host, region) copied; name, ES URL, password, API key, contacts, archive bucket and servers left empty. |
| **Alerts** | "Email this client's problems to the cluster DL": see below. |
| **Weekly report** | "Mail a PDF … to the cluster DL every Monday": see below. |
| **Test connection** | On a saved client: asks Zabbix to run the cluster check (HTTP, or SSH through the jump host) and each server's agent check now, and shows what they found. |
| **Delete for good** | Only for a decommissioned client, and only after its name is typed. Deletes the hosts this page made, with their history. Hosts made by hand and host groups stay. |

A server joins the group of each of its roles and of each family they count in (a Single node
joins ESNodes, Parsers, Forwarders and Engines), so a shared server counts once per family and in
full for each role. Hosts the page makes carry `managed-by: elasticpro-clients`; nothing without
it is ever deleted. Several hosts on one IP (made before servers could hold several roles) are
shown on the edit page with a **merge** box: ticked, the first host is kept with its history and
the others deleted, after a backup. Nothing is merged without it.

**Host inventory.** `inv:` tags also belong to the separate Host Inventory module
(github.com/karthick-dkk/zabbix-host-inventory): this page writes the server attributes it is given
and never removes an `inv:` tag it does not set, so the two can run on one Zabbix. Every host the page keeps carries `ep-client` and `ep-kind`
(master, cluster, archive, server) tags; a server also one `ep-role` per role, one `ep-service`
per role or extra service, and `inv:<name>` tags for extra CSV columns. Servers the page creates
use automatic inventory mode; notes go to the inventory's Notes.

## Bulk import (CSV)

Two files, uploaded together or alone (**Import / export CSV**):

- **clients.csv** — one row per client: settings and requested capacity per role.
- **servers.csv** — one row per server: `client, ip, roles, services, notes` (`roles` like
  `es_data_hot;es_coord`, or by name). Any other column becomes an attribute of the server.
  `name` is exported for reading and ignored on import. A client in servers.csv gets exactly the
  servers listed for it.

Every row is checked first; one error — a bad field, a client twice, an IP under two clients — and
nothing is applied. New clients are added straight away, after a backup. Changes to existing
clients are listed field by field and server by server (roles before → after) and wait for a
tick; a change that deletes a host is never ticked for you. Overlaps (an IP another host already
has, an ES URL two clients share) are warnings; a new client with one waits for a tick too. After
applying, each client is read back from Zabbix and compared with the files.

## Backups

Taken before every change — save, removal, import, role change, restore — and the newest **three**
kept. **Restore** brings back roles, settings and servers; a client that is as it was is left
alone, clients added since are removed (their page-made hosts), and the present is backed up
first, so a restore can be undone. Backups from before servers could hold several roles still
restore. Each backup downloads as clients.csv and servers.csv.

## Status

| Status | Hosts | Set by |
|---|---|---|
| **Active** | monitored | a new client; **Enable** |
| **Maintenance** | monitored, inside a Zabbix maintenance named `ElasticPro: <client>` (keep collecting or not; from now or later, for 1–24 h). Extending replaces it; **End maintenance** deletes it. The status is read from Zabbix, so a maintenance deleted there ends here too. | **Maintenance…** |
| **Disabled** | not monitored. A host that was already off is tagged `ep-was-off` and **Enable** leaves it off. | **Disable** |
| **Decommissioned** | not monitored, kept with their history; hidden from the report widgets. **Restore** takes it back to Disabled. | **Decommission**, only from Disabled |

The status lives in Zabbix: `{$EP.CLIENT.STATUS}` on the master host and an `ep-status` tag on
every host. The report widgets badge disabled clients and clients in maintenance. Tick several
rows for **Maintenance… / Disable / Enable** on all of them at once.

## The list

Tabs by status, and a search that also matches host names and IPs. **Setup** is the checks that
say the monitoring works: Elasticsearch answers (or SSH to the jump host does), devices are
counted, agents answer, the log archive check ran and found tag1, the proxy answers. The first
failing check is named. **Problems** links to Zabbix Problems filtered by the client's
`ep-client` tag. **Disk full in** is `timeleft()` over 7 days of storage usage ("not growing"
when it never reaches 100 %). Every change is recorded with who and when; the edit page shows the
client's activity.

**Other flags on a row.** *storage / devices over purchase* — the master host's share of what was
bought (`ep.es.storage.purchased.usage`, `ep.devices.usage`) above 100 %; the master template
raises a WARNING for storage too. *proxy down* — the client's proxy has not been seen for 5
minutes, or its proxy group is offline or degrading, which explains every host looking broken at
once. *N hosts changed outside* — a host renamed, or moved out of the client's group, in Zabbix
(see below).

**Removed from Zabbix.** The page records each client's form and hosts (`registry.json` in the
data folder). A host deleted in Zabbix behind its back shows as removed, with **Re-create** (as
it was, new history, after a backup) or **Accept removal**. A client whose master host was
deleted stays listed, with **Re-create** or **Forget**. Nothing is re-created by itself. A host
that still exists but was renamed or moved out of the client's group is **changed outside**, never
"removed" (re-creating it would put a second host on its IP): **Put back** renames it and adds the
group again.

**Read-only for Zabbix Admins.** Admins see the list and client pages for the clients whose hosts
they may read — no buttons, the form disabled, nothing from the page's own records (removed or
changed hosts), which know about hosts beyond their permissions. Every change stays Super admin.

## Alerts and the weekly report to the cluster DL

Two ticks on the client card, each needing the cluster DL:

- **Alerts** — the client's problems (warning and above), and their recovery, by email to the DL;
  only this client's, and none while it is in maintenance (the action pauses suppressed problems;
  problems still open when it ends are sent then).
- **Weekly report** — a PDF of the dashboard **ElasticPro: <client>** (Client resources, Client
  capacity and Volume report for the client's group) mailed to the DL each Monday at 08:00, for
  the week before.

The page keeps, per client: a user group **ElasticPro: <client>** (read on the client's group, no
frontend access), a user **ep-dl-<client>** whose one Email media is the DL (a password nobody
knows), a trigger action **ElasticPro: <client>**, and for the report the dashboard and a Zabbix
scheduled report **ElasticPro: <client> weekly**. They follow every change — made, updated, and
removed when unticked, decommissioned or deleted (the dashboard only while it holds nothing but
the page's widgets).

Zabbix needs an active **Email** media type (Alerts → Media types); without one the save says so.
The weekly report also needs Zabbix's web service and report writers
(`deploy/zabbix/stack` runs both) and **Administration → General → Other → Frontend URL** set to an
address the web service can open (`http://web:8080/` in the stack).

## Windows jump host (SSH), no proxy

For clusters reachable only from a Windows jump host. The Zabbix server opens an SSH session to
the jump host (`ssh.run` items, signed in with its own key) and runs `curl.exe` there against
the cluster; the answers come back as text and the same figures as the HTTP templates are read
from them (`es.cluster.status`, `es.nodes.fs.*`, `ep.es.devices.seen`, …), so the master
template, the widgets and the alerts work unchanged.

- **Jump host**: OpenSSH Server, and `curl.exe` (in Windows 10 1803+ and Server 2019+). A user
  whose `authorized_keys` holds the Zabbix server's public key.
- **Zabbix server**: the key pair in its `SSHKeyLocation` (`/var/lib/zabbix/ssh_keys` in the
  Docker image), readable by the zabbix user. `deploy/zabbix/jump-sim/setup.sh` makes it in
  the stack's `ssh-keys` volume.
- **Elasticsearch**: a read-only API key in Vault (the form takes its `path:key`): cluster
  privileges `monitor`, `read_ilm`, `read_slm`; `monitor` and `view_index_metadata` on `*`,
  and `read` on the log indices (`{$EP.DEVICE.INDEX}`, `{$ULM.ES.INDEX}`) for the device count
  and the log archive check.
- **Form**: jump host, port (22), user, key file name (`id_ed25519`), the API key's Vault path and
  the **ES certificate** check: Windows trust store (default), a CA file on the jump host
  (`--cacert`), or not checked (`-k`, for a self-signed cluster; the API key then goes to whatever
  answers at the ES URL).

Three sessions: every minute (health, stats, nodes), every 10 minutes (shards, indices, ILM, SLM,
tasks, aliases, dangling) and every 6 hours (device count). A rejected key or an unreachable
cluster is a HIGH problem naming each endpoint and its HTTP code; no answer at all for 5 minutes
is another.

**Log archive check through a jump host.** The check itself runs on the Zabbix server as a script,
which cannot use SSH. So the ULM host also gets **ElasticPro log archive ES via SSH jump host**:
two SSH items asking Elasticsearch the check's two searches (which tag x branch x day has logs,
hourly; which tag1 values, daily), and `{$ULM.ES.VIA}` = zabbix tells the check to read their
answers from the Zabbix API, then ask S3 as always. That needs two **global** macros —
`{$ULM.ZABBIX.API.URL}` (this Zabbix's API as the server reaches it, e.g.
`http://web:8080/api_jsonrpc.php`) and `{$ULM.ZABBIX.API.TOKEN}` (a secret: an API token that may
read the ULM hosts' items) — and the branch field (`{$ULM.ES.BRANCH.FIELD}`) set. A stale answer,
a refused key or a failed SSH session is a failed check, never a missing day.
`deploy/zabbix/jump-sim/` is a stand-in jump host (OpenSSH + curl answering as `curl.exe`) with
the fixture cluster behind it, for testing without Windows.

## Roles

Families and their roles: ES (ES Data, ES Data Hot, ES Data Warm, ES Coordination, ES Master),
Parser (Parser, S3 Parser), Forwarder, Engine (Engine, UEBA, AIML) and Single node. Add a family
or role, rename, reorder, remove (refused while machines use it). Each change rewrites the master
template. Roles saved by an older version gain the new ones on the next **Write master template**.

## Templates it writes

**Write master template** writes four: **ElasticPro client master** (from the roles),
**ElasticPro Elasticsearch via SSH jump host** (linked instead of the HTTP templates when a
client is monitored through a jump host), **ElasticPro log archive ES via SSH jump host** (on
such a client's ULM host) and **ElasticPro cluster devices**, linked to each cluster host: distinct `src_hostname` values with
logs in the last 24 hours, every 6 hours, with alerts when more devices send logs than were
purchased and when the count halves in a day. Field, window and index are its macros
(`{$EP.DEVICE.FIELD}` must name a keyword field).

## Install

1. Copy this folder to Zabbix's modules directory as `modules/ep_clients` (Docker: mount it at
   `/usr/share/zabbix/modules/ep_clients`).
2. Give zabbix-web a writable data folder for roles, column settings and backups, and point
   `EP_DATA_DIR` at it. With Docker, a named volume over `/var/lib/zabbix` (empty and owned by
   zabbix in the image, so the volume starts owned by zabbix):
   ```yaml
   environment:
     EP_DATA_DIR: /var/lib/zabbix/elasticpro
   volumes:
     - ep-data:/var/lib/zabbix
   ```
   Without it the page shows a red banner and refuses every change (no backup, no change).
3. `../master/import.py` checks the templates, creates groups and enables the modules; then
   **Write master template** on the page (it writes the jump host and cluster devices templates too).

The widget modules keep copies of `lib/Store.php`, `Roles.php`, `ColumnSettings.php` from
`../shared/php/` (`node ../sync-assets.mjs`). Tests: `php test/spec.test.php` (or
`node --test test/spec.test.mjs`, which uses a PHP container), and `test/form.test.mjs` — the form's
name preview against the same table (`test/names.json`) the PHP naming is held to.
