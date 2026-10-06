# ElasticPro — Zabbix modules

The Zabbix frontend side of ElasticPro: the Cluster Management page, the client master template it
writes, and the report widgets. The templates ElasticPro itself feeds (client plan, alerts,
log delay) are in `../../deploy/zabbix/`.

| Folder | What | Import |
|---|---|---|
| `clients-module/` | **Cluster Management** page: add, edit clients (DI / On-Prem) and their hosts; status (active, maintenance through Zabbix maintenance, disabled, decommissioned), setup checks, Test connection, hosts removed in Zabbix shown with Re-create; CSV bulk import with confirmation, three backups with restore, configurable roles; writes the master template and the Windows jump host (SSH) template | copy into `modules/` as `ep_clients`, data folder (see its README), then `master/import.py` |
| `master/` | **ElasticPro client master** — one host per client (made by the Clients page): requested / allocated / used per role and family, shortfall alerts, one dashboard per client. The template is written by the Clients page from its roles | `master/import.py` (set-up), then *Write master template* |
| `capacity-widget/` | **Client capacity** dashboard widget — every client in one table, coloured, with CSV / Excel export | copy into Zabbix's `modules/`, then `master/import.py` enables it and builds the dashboard |
| `resources-widget/` | **Client resources** dashboard widget — Requested / Allocated / Used per family or role, plus ES storage and log delay; expand a client into its servers; Type filter, Columns dialog, CSV / Excel export | copy into `modules/` as `ep_resources`, then `master/import.py` |
| `volume-widget/` | **Volume report** dashboard widget — the client plan per cluster, laid out as in ElasticPro (sections over columns), with CSV / Excel export. Columns come from the ElasticPro client plan template itself | copy into Zabbix's `modules/` as `ep_volume`, then `volume-widget/import.py` |
| `shared/` | the widgets' export, Columns dialog and styles, and the PHP they share with the Clients page (data folder, roles, column settings); `node sync-assets.mjs` copies them into each module | — |

Order on a fresh Zabbix: the cluster and Linux templates, then the ElasticPro repository's templates
(`deploy/zabbix/setup/zbx_phase34.py`: client plan, alerts, log delay), then
`master/import.py`, then *Write master template* on the Clients page.

The cluster and Linux templates are expected as **Elasticsearch Cluster by HTTP EP** and
**Linux by Zabbix agent -EP**. A Zabbix that has them under other names (its own, or the ones
an earlier release shipped) is pointed at them on *Clients → Roles → Template names*, which
writes `templates.json` in the data folder — `{ "cluster": "…", "agent": "…" }`. Nothing in PHP
needs editing, and `master/import.py` reads the same file (or `EP_CLUSTER_TEMPLATE` /
`EP_AGENT_TEMPLATE` when it runs from another machine).

Tests (from this folder): `node --test clients-module/test/*.test.mjs shared/test/*.test.mjs capacity-widget/test/*.test.mjs volume-widget/test/*.test.mjs resources-widget/test/*.test.mjs`
