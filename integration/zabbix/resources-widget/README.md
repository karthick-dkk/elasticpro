# Client resources widget (Zabbix 7.0 module)

Requested · Allocated · Used for every client, in sections like the Volume report widget — one
row per **client master host**: Client (name, type, ES URL) · Log delay · ES storage · then per
family (ES, Parser, Forwarder, Engine, and any family added on the Clients page's Roles): servers,
CPU (cores), memory, disk.

- **Expand** a client (▸, or *Expand all*) for its servers: roles (a server with several reads
  "ES Data + Parser + Engine", marked shared or single node), extra services, host, IP, agent
  status, CPU cores and use, memory and use, disk (on its first role's mount) and use.
- **Type** filter: DI / On-Prem — the table, the count and the export follow it.
- **Columns** (Super admins): rename, show / hide, reorder; show a family's roles as their own
  sections (ES Data Hot, ES Master …). One setting for everyone; the export follows it.
- **Used**: CPU and memory as the average % across the hosts; disks as the size with its share
  of allocated. Yellow at 80 %, red at 90 % (a client's `{$EP.USAGE.WARN}` / `{$EP.USAGE.HIGH}`).
- **Allocated below requested** (ES storage: below purchased): dashed red outline, the request in
  the tooltip. A request nobody entered reads "not set"; a figure not measured "—".
- **Export CSV / Export servers CSV / Export Excel** (sheets *Clients* and *Servers*): numbers as
  numbers, bytes as GB, unknowns as empty cells.

The columns are built from the roles each time, so a role added on the Clients page appears here
with no change to this widget.

## Install

Copy this folder to Zabbix's modules directory as `modules/ep_resources`, then run
`../master/import.py`: it enables the module and creates **ElasticPro — Client resources**.
Needs the data folder described in `../clients-module/README.md` (roles, column settings).
Tests: `php test/view.test.php` — the controller against a fake Zabbix API.
