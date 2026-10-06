"""Troubleshoot links from Zabbix into ElasticPro. Idempotent; prints no secrets.

Two URL scripts under an "ElasticPro" menu:

* on a problem — opens ElasticPro at the cluster the problem is about, on the page that
  answers it (the trigger's `rule` tag when ElasticPro raised it, its name otherwise);
* on a host — opens ElasticPro at that host's cluster.

Both go through the module's `elasticpro.troubleshoot` action, so the person is signed
in as themselves and sees only the clusters their Zabbix groups allow. Run from deploy/zabbix.
"""
import json, ssl, urllib.request

import _common
URL = _common.api_url(); CTX = ssl._create_unverified_context()
creds = _common.read_accounts()
auth = None
def call(m, p):
    h = {"Content-Type": "application/json-rpc"}
    if auth: h["Authorization"] = "Bearer " + auth
    r = json.load(urllib.request.urlopen(urllib.request.Request(URL, json.dumps({"jsonrpc": "2.0", "method": m, "params": p, "id": 1}).encode(), h), context=CTX))
    if "error" in r: raise RuntimeError(f"{m}: {r['error'].get('data')}")
    return r["result"]
auth = call("user.login", {"username": "Admin", "password": creds["Admin"]})

BASE = "zabbix.php?action=elasticpro.troubleshoot&zbx_host={HOST.HOST}&client={$GRP.CLIENT}"
SCRIPTS = [
    {"name": "Troubleshoot in ElasticPro", "scope": 4,
     "url": BASE + "&rule={EVENT.TAGS.rule}&problem={EVENT.NAME}",
     "description": "Opens ElasticPro at this problem's cluster, on the page that answers it."},
    {"name": "Open in ElasticPro", "scope": 2, "url": BASE,
     "description": "Opens ElasticPro at this host's cluster."},
]
for s in SCRIPTS:
    body = {"type": 6, "scope": s["scope"], "url": s["url"], "new_window": 0, "menu_path": "ElasticPro",
            "host_access": 2, "groupid": 0, "usrgrpid": 0, "description": s["description"]}
    have = call("script.get", {"filter": {"name": s["name"]}, "output": ["scriptid"]})
    if have: call("script.update", {"scriptid": have[0]["scriptid"], **body})
    else: call("script.create", {"name": s["name"], **body})
    print(f"{s['name']}: {'updated' if have else 'created'}")
