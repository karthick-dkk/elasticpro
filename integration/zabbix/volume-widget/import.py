#!/usr/bin/env python3
"""Enable the Volume report widget, and create its dashboard if there is none, in Zabbix 7.0.

  ZABBIX_URL=https://zabbix.example.com ZABBIX_TOKEN=… python3 import.py
  ZABBIX_URL=… ZABBIX_USER=Admin ZABBIX_PASSWORD=… python3 import.py [--insecure]

The module must already be in Zabbix's modules directory as modules/ep_volume. Registering
and enabling it is what "Scan directory" and the Enable link would do. The widget reads the
"ElasticPro client plan" template, which ElasticPro's deploy/zabbix/setup imports.
"""
import json, os, ssl, sys, urllib.request

url = os.environ.get("ZABBIX_URL", "").rstrip("/")
if not url: sys.exit("set ZABBIX_URL (and ZABBIX_TOKEN, or ZABBIX_USER + ZABBIX_PASSWORD)")
ctx = ssl._create_unverified_context() if "--insecure" in sys.argv else None
auth = os.environ.get("ZABBIX_TOKEN")

def raw(method, params):
    h = {"Content-Type": "application/json-rpc"}
    if auth: h["Authorization"] = "Bearer " + auth
    req = urllib.request.Request(url + "/api_jsonrpc.php", json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(), h)
    return json.load(urllib.request.urlopen(req, context=ctx))

def call(method, params):
    r = raw(method, params)
    if "error" in r: sys.exit(f"{method}: {r['error'].get('data')}")
    return r["result"]

if not auth:
    auth = call("user.login", {"username": os.environ["ZABBIX_USER"], "password": os.environ["ZABBIX_PASSWORD"]})

if not call("template.get", {"filter": {"host": "ElasticPro client plan"}, "output": ["templateid"]}):
    sys.exit('import "ElasticPro client plan" first (ElasticPro deploy/zabbix/setup/zbx_phase34.py)')

modules = call("module.get", {"filter": {"id": "ep_volume"}, "output": ["moduleid", "status"]})
if not modules:
    r = raw("module.create", {"id": "ep_volume", "relative_path": "modules/ep_volume", "status": 1})
    if "error" in r: sys.exit("the module is not in Zabbix's modules directory: " + str(r["error"].get("data")))
    print("volume report widget registered and enabled")
elif modules[0]["status"] != "1":
    call("module.update", {"moduleid": modules[0]["moduleid"], "status": 1})
    print("volume report widget enabled")

name = "ElasticPro — Volume report"
# Created once. After that it is the users' dashboard: an import never deletes or rebuilds it.
if call("dashboard.get", {"filter": {"name": name}, "output": ["dashboardid"]}):
    sys.exit(f"dashboard kept as it is: {name}")
fields = [{"type": 2, "name": "groupids.0", "value": g["groupid"]}
          for g in call("hostgroup.get", {"filter": {"name": "Elasticsearch clusters"}, "output": ["groupid"]})]
did = call("dashboard.create", {"name": name, "display_period": 60, "auto_start": 0, "pages": [{"widgets": [{
    "type": "ep_volume", "name": "Volume report — client plan", "x": 0, "y": 0, "width": 72, "height": 10, "view_mode": 0,
    "fields": fields}]}]})["dashboardids"][0]
print("dashboard", did, "created:", name)
