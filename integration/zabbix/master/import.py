#!/usr/bin/env python3
"""Set Zabbix 7.0 up for the ElasticPro Clients page and its report widgets.

  ZABBIX_URL=https://zabbix.example.com ZABBIX_TOKEN=… python3 import.py
  ZABBIX_URL=… ZABBIX_USER=Admin ZABBIX_PASSWORD=… python3 import.py [--insecure]

The Elasticsearch cluster template and the Linux agent template are expected under the names
"Elasticsearch Cluster by HTTP EP" and "Linux by Zabbix agent -EP". A Zabbix that calls them
something else is pointed at them in templates.json in the Clients page's data folder, or with
EP_CLUSTER_TEMPLATE / EP_AGENT_TEMPLATE for a run from another machine.

It checks the templates the clients' hosts are linked to (a missing one is named, not worked
around: import it first), creates the host groups that are missing, enables the Clients page
and the widget modules, and creates the widgets' dashboards ("ElasticPro — Client
capacity", "— Client resources") when they do not exist yet. An existing dashboard is never
changed: widgets people added there stay.

The master template itself is not imported here. It follows the roles set on the Clients page,
so the page writes it: ElasticPro → Clients → "Write master template" (and again, by
itself, whenever a role changes).
"""
import json, os, ssl, sys, urllib.request

url = os.environ.get("ZABBIX_URL", "").rstrip("/")
if not url: sys.exit("set ZABBIX_URL (and ZABBIX_TOKEN, or ZABBIX_USER + ZABBIX_PASSWORD)")
ctx = ssl._create_unverified_context() if "--insecure" in sys.argv else None
auth = os.environ.get("ZABBIX_TOKEN")

def call(method, params):
    h = {"Content-Type": "application/json-rpc"}
    if auth: h["Authorization"] = "Bearer " + auth
    req = urllib.request.Request(url + "/api_jsonrpc.php", json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(), h)
    r = json.load(urllib.request.urlopen(req, context=ctx))
    if "error" in r: sys.exit(f"{method}: {r['error'].get('data')}")
    return r["result"]

if not auth:
    auth = call("user.login", {"username": os.environ["ZABBIX_USER"], "password": os.environ["ZABBIX_PASSWORD"]})

# The two templates a site may have under its own names. One definition, shared with the Clients
# page: it keeps them in templates.json in its data folder, so read that where it is reachable,
# and fall back to the environment for a run from another machine.
TEMPLATE_DEFAULTS = {"cluster": "Elasticsearch Cluster by HTTP EP", "agent": "Linux by Zabbix agent -EP"}
try:
    with open(os.path.join(os.environ.get("EP_DATA_DIR", "/var/lib/elasticpro-zabbix"), "templates.json")) as fh:
        saved = json.load(fh)
except (OSError, ValueError):
    saved = {}
if not isinstance(saved, dict): saved = {}
TEMPLATES = {k: (str(saved.get(k) or "").strip() or os.environ.get("EP_" + k.upper() + "_TEMPLATE", "").strip() or d)
             for k, d in TEMPLATE_DEFAULTS.items()}

# Required: the clients page and its report widgets cannot work without these.
NEEDS_TEMPLATES = [TEMPLATES["cluster"], TEMPLATES["agent"], "ElasticPro client plan",
                   "ElasticPro alerts", "ElasticPro log delay"]
# Optional: the S3 log-archive check. It was removed from ElasticPro and lives in its own
# Zabbix template now, imported separately (see deploy/PRODUCTION.md) — a Zabbix with no
# client using the archive check may never have it, and that is not a reason to refuse
# everything else here.
OPTIONAL_TEMPLATES = ["ElasticPro log archive S3"]
# The groups discovered hosts are linked to, and the one master hosts go in. "Log archive" is
# only used by clients with the S3 template above; creating it early costs nothing and a host
# using it later finds it already there.
NEEDS_GROUPS = ["Elasticsearch clusters", "Log archive", "ESNodes", "Parsers", "Forwarders", "Engines", "ElasticPro clients"]

have = {t["host"] for t in call("template.get", {"filter": {"host": NEEDS_TEMPLATES + OPTIONAL_TEMPLATES}, "output": ["host"]})}
missing = [t for t in NEEDS_TEMPLATES if t not in have]
if missing:
    sys.exit("import these templates first: " + ", ".join(missing))
missing_optional = [t for t in OPTIONAL_TEMPLATES if t not in have]
if missing_optional:
    print("note: " + ", ".join(missing_optional) + " not found — skipping the S3/log-archive "
          "parts. Import it separately (see deploy/PRODUCTION.md, \"Log archive template\") if "
          "this Zabbix will monitor a client with an archive bucket; everything else here "
          "(host groups, the client-capacity and client-resources dashboards) is unaffected.")

groups = {g["name"] for g in call("hostgroup.get", {"filter": {"name": NEEDS_GROUPS}, "output": ["name"]})}
for g in NEEDS_GROUPS:
    if g not in groups:
        call("hostgroup.create", {"name": g})
        print("created host group", g)

t = call("template.get", {"filter": {"host": "ElasticPro client master"}, "output": ["templateid"], "selectHosts": ["host"]})
print("master template:", ("written; master hosts: " + (", ".join(h["host"] for h in t[0]["hosts"]) or "none yet")) if t
      else "not written yet — ElasticPro → Clients → Write master template")

# The cross-client tables. Their modules have to be in Zabbix's modules directory already
# (see ../capacity-widget/README.md); registering and enabling them is what "Scan directory"
# and the Enable link would do.
def soft(method, params):
    h = {"Content-Type": "application/json-rpc", "Authorization": "Bearer " + auth}
    req = urllib.request.Request(url + "/api_jsonrpc.php", json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(), h)
    return json.load(urllib.request.urlopen(req, context=ctx))

# The Cluster Management page: a module with no dashboard of its own.
for page in ["ep_clients"]:
    found = call("module.get", {"filter": {"id": page}, "output": ["moduleid", "status"]})
    if not found:
        r = soft("module.create", {"id": page, "relative_path": f"modules/{page}", "status": 1})
        print(f"{page}:", "not in Zabbix's modules directory — " + str(r["error"].get("data")) if "error" in r else "registered and enabled")
    elif found[0]["status"] != "1":
        call("module.update", {"moduleid": found[0]["moduleid"], "status": 1})
        print(f"{page}: enabled")

WIDGETS = [("ep_capacity", "ElasticPro — Client capacity", "Client capacity"),
           ("ep_resources", "ElasticPro — Client resources", "Client resources")]
gid = call("hostgroup.get", {"filter": {"name": "ElasticPro clients"}, "output": ["groupid"]})[0]["groupid"]
for module_id, dashboard, widget in WIDGETS:
    modules = call("module.get", {"filter": {"id": module_id}, "output": ["moduleid", "status"]})
    if not modules:
        r = soft("module.create", {"id": module_id, "relative_path": f"modules/{module_id}", "status": 1})
        if "error" in r:
            print(f"{module_id}: not in Zabbix's modules directory — {dashboard} not created:", r["error"].get("data"))
            continue
        print(f"{module_id}: registered and enabled")
    elif modules[0]["status"] != "1":
        call("module.update", {"moduleid": modules[0]["moduleid"], "status": 1})
        print(f"{module_id}: enabled")
    # Created once. After that it is the users' dashboard: widgets added, moved or resized
    # there are kept — an import never deletes or rebuilds it.
    if call("dashboard.get", {"filter": {"name": dashboard}, "output": ["dashboardid"]}):
        print("dashboard kept as it is:", dashboard)
        continue
    did = call("dashboard.create", {"name": dashboard, "display_period": 60, "auto_start": 0, "pages": [{"widgets": [{
        "type": module_id, "name": widget, "x": 0, "y": 0, "width": 72, "height": 10, "view_mode": 0,
        "fields": [{"type": 2, "name": "groupids.0", "value": gid}]}]}]})["dashboardids"][0]
    print("dashboard", did, "created:", dashboard)
