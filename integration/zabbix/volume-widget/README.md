# Volume report widget (Zabbix 7.0 module)

The Volume report's **client plan**, one row per cluster host, laid out as ElasticPro lays
it out: Client · Volume · Live storage · Backup storage, each section over its columns, every
value centred.

- **Columns** are the "ElasticPro client plan" template's items — label, section (tag
  `plan`) and place (tag `column`) — which ElasticPro generates from the list the Volume
  report page draws. The widget keeps no column list: add a column to the report, regenerate
  and import the template, and the widget shows it.
- **Colours** only where the template's triggers alarm, at their thresholds: Live Used above
  `{$ELASTICPRO.PLAN.LIVE_USED.WARN}` (85 %) yellow, Store Upto under `{$ELASTICPRO.PLAN.LIVE_DAYS.MIN}`
  (14 days) red. An unreachable cluster's row is dimmed; the cluster cell says when it was updated.
- **Export CSV / Export Excel**: one row per cluster, numbers in the item's units (GB, %, days),
  unknowns as empty cells, never 0.

## Install

1. Copy this folder to Zabbix's modules directory as `modules/ep_volume` (Docker: mount it at
   `/usr/share/zabbix/modules/ep_volume`).
2. `ZABBIX_URL=… ZABBIX_TOKEN=… python3 import.py` — enables the module and creates the dashboard
   **ElasticPro — Volume report** (group: Elasticsearch clusters). Or add *Volume report* to any
   dashboard by hand.

`assets/js/ep-xlsx.js` and `ep-export.js` are copies of `../shared/` (`node ../sync-assets.mjs`).

**Columns** (Super admins) renames, hides and reorders the template's columns; the **Type**
filter shows clusters of DI or On-Prem clients (from each client's master host). The export
follows both. Needs the data folder described in `../clients-module/README.md`.
