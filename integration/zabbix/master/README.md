# ElasticPro client master

One **master host per client**, made and kept by the **Clients page** (ElasticPro → Clients,
`../clients-module/`). The page creates the client's hosts — or reuses the ones already there —
and writes the client's settings as macros on this host. This template turns them into figures.

## Figures (items on the master host)

Per role — ES Data Hot / Warm, Coordination, Master; Parser, S3 Parser; Forwarder; UEBA, AIML; and any role added on the Roles page: servers, CPU, memory and root disk, each
**requested** (from the Clients page), **allocated** (summed over the role's hosts in the client's
host group) and **used** (average %, or used / allocated for disk). ES storage: purchased,
allocated, used, usage — from `<client> cluster`.

**Log delay**, from ElasticPro (measured every 15 minutes; only a measurement from the last
hour counts): devices late, measured, critical, median and worst delay; hourly and daily average
and peak; change on the previous hour and day.

A requested value of 0 means *not set*: shown as "not set", never alarmed.

## Alerts

| Problem | Severity |
|---|---|
| `<client>: <role> <resource> allocated X is below requested Y` — every role × servers / CPU / memory / disk | Average |
| `<client>: ES storage allocated X is below purchased Y` | Average |

## Dashboard

Every master host gets **Client capacity and log delay** (Monitoring → Hosts → the host →
Dashboards): *Capacity* (usage tiles yellow ≥ 80 %, red ≥ 90 %), *Storage*, *Log delay*. The tables
across all clients are the widgets in `../capacity-widget/` and `../resources-widget/`.

## Files

The template is written by the Clients page (`../clients-module/lib/MasterTemplate.php`) from the
roles configured there — "Write master template" on the page, and again by itself whenever a role
is added, renamed or removed. `import.py` does the rest of the set-up: checks the templates the
clients' hosts use, creates missing host groups, enables the Clients page and the widgets, and
creates their dashboards once — never changing them after.
