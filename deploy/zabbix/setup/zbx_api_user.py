"""A Zabbix API identity for ElasticPro's sync: its own role, its own token. Idempotent."""
import json, os, secrets, ssl, urllib.request

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

# Reading who may see which host group needs the Super admin type; what keeps it narrow is
# the API allow-list — read methods only — and no frontend at all.
# item.get: the Clusters page reads what Zabbix already measured (ZABBIX_METRICS).
# The names and the allow-list live in ONE place, module/elasticpro/sync-role.json, which
# the module's "Pair with ElasticPro" (Administration → ElasticPro) reads too.
SPEC = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "module", "elasticpro", "sync-role.json")))
METHODS = SPEC["methods"]
rules = {"ui.default_access": 0, "modules.default_access": 0, "actions.default_access": 0,
         "api.access": 1, "api.mode": 1, "api": METHODS}
r = call("role.get", {"filter": {"name": SPEC["roleName"]}, "output": ["roleid"]})
if r:
    roleid = r[0]["roleid"]; call("role.update", {"roleid": roleid, "rules": rules})
else:
    roleid = call("role.create", {"name": SPEC["roleName"], "type": SPEC["roleType"], "rules": rules})["roleids"][0]
print(f"role: {SPEC['roleName']}, API allow-list:", ", ".join(METHODS))

nofront = call("usergroup.get", {"filter": {"name": SPEC["noFrontendGroup"]}, "output": ["usrgrpid"]})[0]["usrgrpid"]
u = call("user.get", {"filter": {"username": SPEC["userName"]}, "output": ["userid"]})
if u:
    uid = u[0]["userid"]; call("user.update", {"userid": uid, "roleid": roleid, "usrgrps": [{"usrgrpid": nofront}]})
else:
    uid = call("user.create", {"username": SPEC["userName"], "passwd": secrets.token_urlsafe(24),   # never used: token only
                               "roleid": roleid, "usrgrps": [{"usrgrpid": nofront}]})["userids"][0]
print(f"user: {SPEC['userName']} (no frontend access)")

path = os.path.join(_common.secrets_dir(), "zabbix_api_token")
if not os.path.exists(path) or not open(path).read().strip():
    for t in call("token.get", {"userids": [uid], "filter": {"name": SPEC["scriptTokenName"]}, "output": ["tokenid"]}):
        call("token.delete", [t["tokenid"]])
    tid = call("token.create", {"name": SPEC["scriptTokenName"], "userid": uid, "description": "ElasticPro cluster sync"})["tokenids"][0]
    tok = call("token.generate", [tid])[0]["token"]
    old = os.umask(0o027)
    with open(path, "w") as f: f.write(tok + "\n")
    os.umask(old)
    os.chmod(path, 0o640)
    print("token written to deploy/secrets/zabbix_api_token (0640)")
else:
    print("token already present")
