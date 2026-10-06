# Client capacity widget (Zabbix 7.0 module)

A dashboard widget: one row per **client master host**, the columns

Cluster Name · ES URL · Cust.Purchased Storage · Logdelay Devices Count · ES Allocated / Used
Storage · ES Used % · ES Full In · ES CPU and Mem Requested / Allocated / Usage · Parser CPU and Mem
Requested / Allocated / Usage · Forwarder Mem and CPU Requested / Allocated / Usage · Forwarder
Requested / Allocated / Curr.Used Storage

- **ES Full In**: when ES storage fills at the last week's growth, read exactly as Cluster Management
  reads it (`shared/php/Forecast.php`): red under 7 days, yellow under 30, *not growing* when it
  never fills. The export gives days.
- **Usage** cells: yellow at 80 %, red at 90 % (a client's `{$EP.USAGE.WARN}` / `{$EP.USAGE.HIGH}`
  override). Forwarder used storage is coloured by its share of allocated.
- **Allocated below requested** (or ES storage below purchased): dashed red outline and ▼,
  the request in the tooltip. Unset requests read "not set".
- **Export CSV / Export Excel**: numbers as numbers, bytes as GB, unknowns as empty cells.

The columns come from `columns.json` (family-level keys of the master template). **Columns**
(Super admins) renames, hides and reorders them; the **Type** filter shows DI or On-Prem clients;
the export follows both.

## Install

1. Copy this folder to Zabbix's modules directory as `modules/ep_capacity` (Docker: mount it
   at `/usr/share/zabbix/modules/ep_capacity`).
2. Run `../master/import.py` — it registers and enables the module and creates the dashboard
   **ElasticPro — Client capacity** (group filter: ElasticPro clients). Or add the widget to
   any dashboard by hand: *Client capacity*.

`assets/js/ep-*.js`, `assets/css/ep-widget.css`, `lib/` and `actions/ColumnsSave.php` are copies from `../shared/` (`node ../sync-assets.mjs`).
