"""Import the cluster and Linux templates and make vm-1 a cluster host the way they expect.
Idempotent.

  python3 setup/zbx_templates.py --host 203.0.113.10
  EP_HOST=203.0.113.10 python3 setup/zbx_templates.py

The template names default to the ones this repo's export uses. A Zabbix whose templates are
named differently is pointed at them without editing anything here:

  python3 setup/zbx_templates.py --host 203.0.113.10 --cluster-template "<its name>"

(also --es-template / --linux-template, or $ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE /
$ELASTICPRO_ZABBIX_ES_TEMPLATE / $ELASTICPRO_ZABBIX_LINUX_TEMPLATE — see _common.py.)

The ES password is a Vault macro by default (the project's decision — Zabbix SECRET_TEXT
macros are unreadable through the API, so ElasticPro cannot read them back). For a test
box with no Vault:

  python3 setup/zbx_templates.py --host 203.0.113.10 --plain-secret /path/to/password-file

--plain-secret takes a FILE to read the password from, never the password itself — it never
appears in argv or an environment variable. It sets a Secret-text macro instead of a Vault
one. Test installs only: prefer Vault for anything real.
"""
import json, ssl, sys, urllib.request

import _common

HOST = _common.require_host()
PLAIN_SECRET_FILE = _common.flag_value("--plain-secret")
CLUSTER_TEMPLATE = _common.cluster_template()
ES_TEMPLATE = _common.es_template()
LINUX_TEMPLATE = _common.linux_template()

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

if not PLAIN_SECRET_FILE:
    # Vault provider in the frontend: macros of type "Vault secret" are validated against it.
    # Not needed for a plain-secret macro, and would fail if this box has no Vault at all.
    call("settings.update", {"vault_provider": 0})   # 0 = HashiCorp

rules = {k: {"createMissing": True, "updateExisting": True} for k in
         ["template_groups", "templates", "items", "triggers", "graphs", "discoveryRules", "valueMaps", "templateDashboards", "httptests"]}
rules["templateLinkage"] = {"createMissing": True}
call("configuration.import", {"format": "yaml", "source": open(_common.find_templates_yaml()).read(), "rules": rules})
tpl = {t["host"]: t["templateid"] for t in call("template.get", {"output": ["host"], "filter": {"host": [
    CLUSTER_TEMPLATE, ES_TEMPLATE, LINUX_TEMPLATE]}})}
print("templates:", sorted(tpl))

def group(name):
    g = call("hostgroup.get", {"filter": {"name": name}, "output": ["groupid"]})
    return g[0]["groupid"] if g else call("hostgroup.create", {"name": name})["groupids"][0]
client = "vm-1"
gids = {n: group(n) for n in [client, "Forwarders", "Parsers", "ESNodes", "Engines", "Elasticsearch clusters"]}
print("host groups:", sorted(gids))

# "ES vm-1" (zbx_setup.py) is the user group ep-user is in. ElasticPro scopes a Zabbix User
# to the clusters whose host groups their user groups can read — without this grant ep-user
# sees nothing, not "vm-1 only". Merged into whatever rights the group already has.
ug = call("usergroup.get", {"filter": {"name": "ES vm-1"}, "output": ["usrgrpid"], "selectHostGroupRights": "extend"})
if ug:
    rights = {r["id"]: r["permission"] for r in ug[0]["hostgroup_rights"]}
    if rights.get(gids[client]) != "2":
        rights[gids[client]] = "2"
        call("usergroup.update", {"usrgrpid": ug[0]["usrgrpid"],
                                  "hostgroup_rights": [{"id": k, "permission": v} for k, v in rights.items()]})
        print(f"user group ES vm-1: read on host group {client}")

if PLAIN_SECRET_FILE:
    password = open(PLAIN_SECRET_FILE).read().strip()
    if not password:
        sys.exit(f"{PLAIN_SECRET_FILE} is empty")
    print("WARNING: --plain-secret sets {$ELASTICSEARCH.PASSWORD} as a Secret-text macro, "
          "not Vault. For test installs only — never for a real client.", file=sys.stderr)
    password_macro = {"macro": "{$ELASTICSEARCH.PASSWORD}", "value": password, "type": 1,  # 1 = Secret text
                       "description": "Plain Secret-text macro (--plain-secret, test install). "
                                       "Prefer Vault for anything real."}
else:
    # type 2 = Vault secret: "<path>:<key>"; Zabbix adds /data/ after the KV v2 mount.
    password_macro = {"macro": "{$ELASTICSEARCH.PASSWORD}", "value": "secret/elasticpro/vm-1:password", "type": 2,
                       "description": "Read from Vault by the Zabbix server and by ElasticPro. Never stored in Zabbix."}

macros = [
    {"macro": "{$ELASTICSEARCH.SCHEME}", "value": "http"},
    {"macro": "{$ELASTICSEARCH.HOST}", "value": HOST},
    {"macro": "{$ELASTICSEARCH.PORT}", "value": "9200"},
    {"macro": "{$ELASTICSEARCH.USERNAME}", "value": "elastic"},
    password_macro,
    {"macro": "{$GRP.CLIENT}", "value": client},
    {"macro": "{$ELASTICSEARCH.JUMPHOST}", "value": "",
     "description": "ElasticPro jump host name (as in its config's jump_hosts); empty = direct."},
]
name = "vm-1 cluster"
h = call("host.get", {"filter": {"host": name}, "output": ["hostid"]})
spec = {"groups": [{"groupid": gids[client]}, {"groupid": gids["Elasticsearch clusters"]}],
        "templates": [{"templateid": tpl[CLUSTER_TEMPLATE]}], "macros": macros,
        "tags": [{"tag": "client", "value": client}, {"tag": "role", "value": "cluster"}],
        "description": "Elasticsearch cluster vm-1. ElasticPro discovers this host by its template."}
if h:
    call("host.update", {"hostid": h[0]["hostid"], **spec}); print("host updated:", name)
else:
    call("host.create", {"host": name, **spec}); print("host created:", name)
