import html, http.cookiejar, json, re, ssl, sys, urllib.parse, urllib.request

import _common
CTX = ssl._create_unverified_context(); ZBX = _common.zabbix_url(); EP = _common.ep_url()
creds = _common.read_accounts()
def bridge(msg, s):
    r = urllib.request.Request(EP + "/bridge", json.dumps({**msg, "session": s}).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, context=CTX))
for user in [a for a in sys.argv[1:] if not a.startswith("--") and a not in (_common.flag_value("--zabbix-url"), _common.flag_value("--accounts"), _common.flag_value("--ep-url"))]:
    o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), urllib.request.HTTPSHandler(context=CTX))
    o.open(ZBX + "/index.php", urllib.parse.urlencode({"name": user, "password": creds[user], "enter": "Sign in"}).encode()).read()
    page = o.open(ZBX + "/zabbix.php?action=elasticpro.overview").read().decode()
    code = urllib.parse.parse_qs(urllib.parse.urlparse(html.unescape(re.search(r'<iframe[^>]*src="([^"]+)"', page).group(1))).query)["sso_code"][0]
    s = json.load(urllib.request.urlopen(urllib.request.Request(EP + "/bridge", json.dumps({"type": "SSO_EXCHANGE", "code": code}).encode(), {"Content-Type": "application/json"}), context=CTX))["session"]
    z = bridge({"type": "ZABBIX_CLUSTERS"}, s)
    print(f"== {user}: configured={z.get('configured')} vault={z.get('vault')} lastSync={'yes' if z.get('lastSync') else 'no'}")
    for c in z["clusters"]:
        print(f"   {c['_id']}: {c['url']} credential={c['credential']} ok={c['credentialOk']} groups={c.get('zabbixGroups','(hidden)')} notes={c.get('notes','(hidden)')}")
    if not z["clusters"]: print("   (none visible)")
