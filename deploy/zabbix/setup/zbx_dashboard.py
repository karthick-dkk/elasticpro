"""The ElasticPro dashboard: forwarders, parsers and ES nodes in one view, then every
cluster with its health and client plan, then trends. Idempotent: replaces its own."""
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
gid = lambda n: call("hostgroup.get", {"filter": {"name": n}, "output": ["groupid"]})[0]["groupid"]

def f(t, name, value): return {"type": t, "name": name, "value": value}
S, I, G = 1, 0, 2      # string, integer, host group

def tophosts(name, group, cols, x, y, w, h, order=1, count=25):
    """cols: ("host", label) | ("text", label, text) | ("item", label, item name, bar(min,max) or None, decimals)"""
    fields = [f(G, "groupids.0", gid(group)), f(I, "column", order), f(I, "count", count)]
    for i, c in enumerate(cols):
        p = f"columns.{i}."
        # Zabbix 7.0's widget view reads these on every column; the API does not default them.
        fields += [f(S, p + "name", c[1]), f(S, p + "base_color", "")]
        if c[0] == "host":
            fields.append(f(I, p + "data", 2))
        elif c[0] == "text":
            fields += [f(I, p + "data", 3), f(S, p + "text", c[2])]
        else:
            fields += [f(I, p + "data", 1), f(S, p + "item", c[2]), f(I, p + "decimal_places", c[4] if len(c) > 4 else 1),
                       f(I, p + "history", 1), f(I, p + "aggregate_function", 0)]
            if len(c) > 3 and c[3]:
                fields += [f(I, p + "display", 2), f(S, p + "min", str(c[3][0])), f(S, p + "max", str(c[3][1]))]
            else:
                fields.append(f(I, p + "display", 1))
    return {"type": "tophosts", "name": name, "x": x, "y": y, "width": w, "height": h, "fields": fields}

def graph(name, items, x, y, w, h):
    fields = []
    for i, it in enumerate(items):
        fields += [f(S, f"ds.{i}.hosts.0", "*"), f(S, f"ds.{i}.items.0", it), f(S, f"ds.{i}.color", ["1A7C11", "F63100", "2774A4", "A54F10"][i % 4])]
    return {"type": "svggraph", "name": name, "x": x, "y": y, "width": w, "height": h, "fields": fields}

linux = lambda: [("host", "Host"), ("text", "Client", "{$CLIENT}"),
                 ("item", "CPU %", "CPU utilization", (0, 100)), ("item", "Memory %", "Memory utilization", (0, 100)),
                 ("item", "Disk / %", "FS [/]: Space: Used, in %", (0, 100)), ("item", "Load 1m", "Load average (1m avg)", None, 2)]
def problems(name, groups, x, y, w, h):
    """Open problems for these host groups — the one place alerts are shown and acknowledged."""
    fields = [f(G, f"groupids.{i}", gid(g)) for i, g in enumerate(groups)] + [f(I, "show_lines", 12), f(I, "show_tags", 1)]
    return {"type": "problems", "name": name, "x": x, "y": y, "width": w, "height": h, "fields": fields}

ROLE_GROUPS = ["Elasticsearch clusters", "Forwarders", "Parsers", "ESNodes", "Engines"]
fleet = [
    problems("Problems — clusters, forwarders, parsers, ES nodes", ROLE_GROUPS, 0, 0, 72, 5),
    tophosts("Forwarders", "Forwarders", linux(), 0, 5, 36, 6),
    tophosts("Parsers", "Parsers", linux(), 36, 5, 36, 6),
    tophosts("Elasticsearch nodes", "ESNodes", linux(), 0, 11, 72, 6),
]
clusters = [
    tophosts("Clusters — health", "Elasticsearch clusters", [
        ("host", "Cluster"), ("text", "Client", "{$GRP.CLIENT}"),
        ("item", "Health (0 green · 1 yellow · 2 red)", "Cluster health status", None, 0),
        ("item", "Nodes", "Number of nodes", None, 0), ("item", "Unassigned shards", "Number of unassigned shards", None, 0),
        ("item", "Reachable", "Client plan: cluster reachable", None, 0)], 0, 0, 72, 5),
    tophosts("Clusters — client storage plan", "Elasticsearch clusters", [
        ("host", "Cluster"),
        ("item", "Per day GB", "Client plan: Current Per Day Volume"), ("item", "+ buffer GB", "Client plan: Daily Volume + buffer"),
        ("item", "Live GB", "Client plan: Current Live Storage"), ("item", "Live used %", "Client plan: Live Used", (0, 100)),
        ("item", "Live lasts (days)", "Client plan: Current Live Storage Store Upto", None, 0),
        ("item", "Need 30d GB", "Client plan: Required Live Storage for 30days"), ("item", "Need 90d GB", "Client plan: Required Live Storage for 90days"),
        ("item", "Backup GB", "Client plan: Current Backup Storage"), ("item", "Backup 365d GB", "Client plan: Required Backup Storage for 365 days"),
        ("item", "Backup lasts (days)", "Client plan: Current Backup storage Store upto", None, 0)], 0, 5, 72, 6),
]
trends = [
    graph("Volume per day (GB)", ["Client plan: Current Per Day Volume", "Client plan: Daily Volume + buffer"], 0, 0, 36, 6),
    graph("Live storage used (%)", ["Client plan: Live Used"], 36, 0, 36, 6),
    graph("Linux CPU across the fleet (%)", ["CPU utilization"], 0, 6, 36, 6),
    graph("Linux memory across the fleet (%)", ["Memory utilization"], 36, 6, 36, 6),
]
name = "ElasticPro — Fleet"
for d in call("dashboard.get", {"filter": {"name": name}, "output": ["dashboardid"]}):
    call("dashboard.delete", [d["dashboardid"]])
did = call("dashboard.create", {"name": name, "display_period": 60, "auto_start": 0, "pages": [
    {"name": "Fleet: forwarders, parsers, ES nodes", "widgets": fleet},
    {"name": "Clusters: health and client plan", "widgets": clusters},
    {"name": "Trends", "widgets": trends},
], "userGroups": [{"usrgrpid": ug["usrgrpid"], "permission": 2} for ug in call("usergroup.get", {"filter": {"name": ["ES vm-1", "Zabbix administrators"]}, "output": ["usrgrpid"]})]})["dashboardids"][0]
print("dashboard", did, "created:", name)
