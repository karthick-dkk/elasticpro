"""Phase 3/4 Zabbix setup. Idempotent; secrets are written to files and never printed.

Needs the VM's own address, for the Linux host's agent interface: --host <address> or
$EP_HOST. The base template names come from --cluster-template / --linux-template or their
environment variables, so a Zabbix that names them differently needs no edit here (see
_common.py)."""
import html, http.cookiejar, json, os, re, secrets, ssl, urllib.parse, urllib.request

import _common

HOST = _common.require_host()
CLUSTER_TEMPLATE = _common.cluster_template()
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
def secret_file(path, text):
    old = os.umask(0o027)
    with open(path, "w") as f: f.write(text)
    os.umask(old); os.chmod(path, 0o640)
auth = call("user.login", {"username": "Admin", "password": creds["Admin"]})
nofront = call("usergroup.get", {"filter": {"name": "No access to the frontend"}, "output": ["usrgrpid"]})[0]["usrgrpid"]

# 1. Provisioning identity: exactly what creating a cluster host needs.
METHODS = ["host.get", "host.create", "hostgroup.get", "hostgroup.create", "template.get", "usergroup.get", "usergroup.update"]
rules = {"ui.default_access": 0, "modules.default_access": 0, "actions.default_access": 0, "api.access": 1, "api.mode": 1, "api": METHODS}
r = call("role.get", {"filter": {"name": "ElasticPro provisioning"}, "output": ["roleid"]})
roleid = r[0]["roleid"] if r else call("role.create", {"name": "ElasticPro provisioning", "type": 3, "rules": rules})["roleids"][0]
call("role.update", {"roleid": roleid, "rules": rules})
u = call("user.get", {"filter": {"username": "elasticpro-provision"}, "output": ["userid"]})
uid = u[0]["userid"] if u else call("user.create", {"username": "elasticpro-provision", "passwd": secrets.token_urlsafe(24),
                                                    "roleid": roleid, "usrgrps": [{"usrgrpid": nofront}]})["userids"][0]
path = os.path.join(_common.secrets_dir(), "zabbix_api_write_token")
if not os.path.exists(path) or not open(path).read().strip():
    for t in call("token.get", {"userids": [uid], "output": ["tokenid"]}): call("token.delete", [t["tokenid"]])
    tid = call("token.create", {"name": "elasticpro-provision", "userid": uid, "description": "ElasticPro zabbix.createHosts"})["tokenids"][0]
    secret_file(path, call("token.generate", [tid])[0]["token"] + "\n")
print("1. provisioning user elasticpro-provision, API:", ", ".join(METHODS))

# 2. Client-plan template, linked to every cluster host.
rules_imp = {k: {"createMissing": True, "updateExisting": True, **({"deleteMissing": True} if k in ("items", "triggers", "graphs", "discoveryRules") else {})}
             for k in ["template_groups", "templates", "items", "triggers", "graphs", "discoveryRules"]}
for f in ["template-elasticpro-client-plan.yaml", "template-elasticpro-alerts.yaml", "template-elasticpro-log-delay.yaml"]:
    call("configuration.import", {"format": "yaml", "source": open(f).read(), "rules": {**rules_imp, "valueMaps": {"createMissing": True, "updateExisting": True}}})
own = [t["templateid"] for t in call("template.get", {"filter": {"host": ["ElasticPro client plan", "ElasticPro alerts", "ElasticPro log delay"]}, "output": ["templateid"]})]
ctpl = call("template.get", {"filter": {"host": CLUSTER_TEMPLATE}, "output": ["templateid"]})[0]["templateid"]
hosts = call("host.get", {"templateids": [ctpl], "output": ["hostid", "host"]})
if hosts:
    call("host.massadd", {"hosts": [{"hostid": h["hostid"]} for h in hosts], "templates": [{"templateid": t} for t in own]})
print("2. client-plan, alerts and log-delay templates linked to:", ", ".join(h["host"] for h in hosts))

# 3. An ElasticPro API token for the scraper: read-only "user" role, minted through an
#    admin session the Zabbix module signs in — no ElasticPro password involved.
o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), urllib.request.HTTPSHandler(context=CTX))
o.open(_common.zabbix_url() + "/index.php", urllib.parse.urlencode({"name": "Admin", "password": creds["Admin"], "enter": "Sign in"}).encode()).read()
page = o.open(_common.zabbix_url() + "/zabbix.php?action=elasticpro.overview").read().decode()
src = urllib.parse.urlparse(html.unescape(re.search(r'<iframe[^>]*src="([^"]+)"', page).group(1)))
code = urllib.parse.parse_qs(src.query)["sso_code"][0]
# The ElasticPro this Zabbix is paired with — the one whose page the frame opens.
BRIDGE = f"{src.scheme}://{src.netloc}/bridge"
def ep(msg):
    return json.load(urllib.request.urlopen(urllib.request.Request(BRIDGE, json.dumps(msg).encode(), {"Content-Type": "application/json"}), context=CTX))
sess = ep({"type": "SSO_EXCHANGE", "code": code})["session"]
# The token as a file on its own (a Docker secret for compose.plan.yml: never an environment
# value, so not in `docker inspect`). A scraper.env from before is carried over, not re-minted.
tokf = os.path.join(_common.secrets_dir(), "scraper_token")
envf = os.path.join(_common.secrets_dir(), "scraper.env")
if not os.path.exists(tokf) or not open(tokf).read().strip():
    old = open(envf).read() if os.path.exists(envf) else ""
    m = re.search(r"^ELASTICPRO_TOKEN=(\S+)", old, re.M)
    if m:
        secret_file(tokf, m.group(1) + "\n")
    else:
        t = ep({"type": "TOKEN_CREATE", "session": sess, "name": "client-plan scraper", "role": "user"})
        if not t.get("ok"): raise SystemExit(f"TOKEN_CREATE: {t.get('message')}")
        secret_file(tokf, t["secret"] + "\n")
print("3. ElasticPro API token for the scraper (role user) written to", tokf)

# 4. This VM as a Linux host, so the fleet view has one real node to show.
g = {n: call("hostgroup.get", {"filter": {"name": n}, "output": ["groupid"]})[0]["groupid"] for n in ["vm-1", "ESNodes"]}
lin = call("template.get", {"filter": {"host": LINUX_TEMPLATE}, "output": ["templateid"]})[0]["templateid"]
name = "vm-1 es-node"
spec = {"groups": [{"groupid": g["vm-1"]}, {"groupid": g["ESNodes"]}], "templates": [{"templateid": lin}],
        "macros": [{"macro": "{$CLIENT}", "value": "vm-1"}, {"macro": "{$ROLE}", "value": "esnode"}],
        "tags": [{"tag": "client", "value": "vm-1"}, {"tag": "role", "value": "esnode"}]}
h = call("host.get", {"filter": {"host": name}, "output": ["hostid"]})
if h:
    call("host.update", {"hostid": h[0]["hostid"], **spec})
else:
    call("host.create", {"host": name, **spec, "interfaces": [{"type": 1, "main": 1, "useip": 1, "ip": HOST, "dns": "", "port": "10050"}]})
print("4. host", name, "in vm-1 + ESNodes with the", LINUX_TEMPLATE, "template")
