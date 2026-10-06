"""Configure the fresh Zabbix 7.0: module on, groups, test users, Admin password replaced.
Idempotent. Passwords are generated here and written to secrets/zabbix-accounts.txt (0600).

Needs the VM's own address, for the comment written into that file: --host <address> or
$EP_HOST (see _common.py)."""
import json, os, secrets, ssl, urllib.request

import _common

HOST = _common.require_host()
URL = _common.api_url()
CTX = ssl._create_unverified_context()   # its own self-signed cert, on loopback
auth = None


def call(method, params):
    h = {"Content-Type": "application/json-rpc"}
    if auth:
        h["Authorization"] = "Bearer " + auth
    body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode()
    r = json.load(urllib.request.urlopen(urllib.request.Request(URL, body, h), context=CTX))
    if "error" in r:
        raise RuntimeError(f"{method}: {r['error'].get('data')}")
    return r["result"]


# The same file every other script here reads as stack/secrets/zabbix-accounts.txt from
# deploy/zabbix/ — resolved from this file, so it does not depend on the working directory.
store = _common.accounts_file()
creds = {}
if os.path.exists(store):
    for line in open(store):
        if ":" in line and not line.startswith("#"):
            k, v = line.rstrip("\n").split(":", 1)
            creds[k.strip()] = v.strip()

admin_pw = creds.get("Admin")
try:
    auth = call("user.login", {"username": "Admin", "password": admin_pw or "zabbix"})
except RuntimeError:
    auth = call("user.login", {"username": "Admin", "password": "zabbix"})
    admin_pw = None
print("logged in to Zabbix", call("apiinfo.version", {}) if False else "")

mods = call("module.get", {"filter": {"id": "elasticpro"}, "output": ["moduleid", "status"]})
if not mods:
    call("module.create", {"id": "elasticpro", "relative_path": "modules/elasticpro", "status": 1})
    print("module: registered and enabled")
elif mods[0]["status"] != "1":
    call("module.update", {"moduleid": mods[0]["moduleid"], "status": 1})
    print("module: enabled")
else:
    print("module: already enabled")


def group(name):
    g = call("usergroup.get", {"filter": {"name": name}, "output": ["usrgrpid"]})
    return g[0]["usrgrpid"] if g else call("usergroup.create", {"name": name})["usrgrpids"][0]


es_vm1 = group("ES vm-1")
unmapped = group("No ElasticPro clusters")
zadmins = call("usergroup.get", {"filter": {"name": "Zabbix administrators"}, "output": ["usrgrpid"]})[0]["usrgrpid"]
print("groups: ES vm-1, No ElasticPro clusters")

# Roles shipped with 7.0: 1 User, 2 Admin, 3 Super admin.
for name, roleid, grp, what in [
    ("ep-user", "1", es_vm1, "Zabbix User in ES vm-1 -> ElasticPro user, sees vm-1 only"),
    ("ep-unmapped", "1", unmapped, "Zabbix User in no mapped group -> sees no clusters"),
    ("ep-admin", "2", zadmins, "Zabbix Admin -> ElasticPro operator, every cluster, may write"),
]:
    if call("user.get", {"filter": {"username": name}, "output": ["userid"]}):
        print(f"user {name}: exists")
        continue
    pw = creds.get(name) or secrets.token_urlsafe(15)
    call("user.create", {"username": name, "passwd": pw, "roleid": roleid, "usrgrps": [{"usrgrpid": grp}]})
    creds[name] = pw
    print(f"user {name}: created ({what})")

if not admin_pw:
    admin_pw = secrets.token_urlsafe(15)
    call("user.update", {"userid": "1", "current_passwd": "zabbix", "passwd": admin_pw})
    print("Admin: default password replaced")
creds["Admin"] = admin_pw

old = os.umask(0o077)
with open(store, "w") as f:
    f.write(f"# Zabbix 7.0 on {HOST} - {_common.zabbix_url()}\n# username: password\n")
    for k in ["Admin", "ep-user", "ep-unmapped", "ep-admin"]:
        f.write(f"{k}: {creds[k]}\n")
os.umask(old)
os.chmod(store, 0o600)
print("passwords written to", os.path.abspath(store), "(0600)")
