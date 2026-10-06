"""Carry a live Zabbix across the rename to ElasticPro: the macros the code reads, and a
report on everything a script must not change on its own.

The rename moved identifiers that live in the operator's Zabbix database, not only in this
repository. The macros are the ones that break quietly. The code now reads {$EP.*} and
{$ELASTICPRO.*}; every host and template made before the upgrade still carries {$EVP.*} and
{$ESPRO.*}. Nothing errors — Cluster Management simply shows a client with no plan, no DL
and no contract end, because the macros it asks for are not there, and "unknown" is what the
pages are built to say when a value is missing.

Dry run unless --apply: on its own it prints what it would change and changes nothing. A
write here needs a decision a person made by hand, as everywhere else in this project.

  python3 setup/zbx_rename.py                                # what would change
  python3 setup/zbx_rename.py --apply                        # change it
  python3 setup/zbx_rename.py --apply --rewrite-vault-path   # and the Vault paths (read on)

Run it as often as you like: a second run finds nothing left to rename.

With --apply it changes exactly one kind of thing: host, template and global macros whose
name begins `{$EVP.` or `{$ESPRO.`, renamed to `{$EP.` and `{$ELASTICPRO.`. Values, types and
descriptions are left as they are — the rename sends the name alone, so even a Secret-text
value Zabbix will not give back through the API survives it. A macro whose new name is
already there with the same value is a leftover of a half-finished run and is removed; one
that is already there with a different value is a conflict: it is reported, and both macros
are left alone for a person to settle.

--rewrite-vault-path additionally points Vault macros at the new secret path
(<mount>/elasticvue/... -> <mount>/elasticpro/...). It is optional, and the order matters:
Zabbix and the core read the secret at the path the macro names, so copy the secrets to the
new path in Vault and read one back BEFORE rewriting the macros, or the macro points at
nothing. Clusters whose macro keeps the old path keep working as long as a Vault policy still
grants read on it — see "Upgrading from the previous name" in README.md.

Nothing else is ever changed here: no host is created, disabled or deleted, and no template,
module, item, trigger, dashboard, action, user or script is touched. Those are reported
instead, with the steps a person takes.

Which Zabbix and which Admin password come from --zabbix-url / $ZBX_URL and
--accounts / $ZBX_ACCOUNTS, like the rest of the scripts here (see _common.py). --host /
$EP_HOST is not needed: nothing here writes an address anywhere.
"""
import json, re, ssl, sys, urllib.request

import _common

APPLY = "--apply" in sys.argv[1:]
REWRITE_VAULT = "--rewrite-vault-path" in sys.argv[1:]
URL = _common.api_url(); CTX = ssl._create_unverified_context()   # the stack's own self-signed cert, on loopback
creds = _common.read_accounts()
auth = None
def call(m, p):
    h = {"Content-Type": "application/json-rpc"}
    if auth: h["Authorization"] = "Bearer " + auth
    r = json.load(urllib.request.urlopen(urllib.request.Request(URL, json.dumps({"jsonrpc": "2.0", "method": m, "params": p, "id": 1}).encode(), h), context=CTX))
    if "error" in r: raise RuntimeError(f"{m}: {r['error'].get('data')}")
    return r["result"]

# The two macro prefixes the rename moved, and nothing else. "Recognised" means one of these
# exact prefixes, the dot included, because that is exactly what the new code reads
# ({$EP.DL}, {$ELASTICPRO.URL}). A site's own {$EVPFOO} is not one of ours to rename: it is
# reported and left alone.
PREFIXES = [("{$EVP.", "{$EP."), ("{$ESPRO.", "{$ELASTICPRO.")]
SECRET, VAULT = "1", "2"                       # Zabbix macro types: 0 text, 1 Secret text, 2 Vault secret
# <mount>/elasticvue/<rest> -> <mount>/elasticpro/<rest>. The mount is whatever the site
# mounted its KV engine as (`secret` here); only the path segment the rename changed is
# touched, so a site on another mount is not quietly moved to ours.
OLD_VAULT_PATH = re.compile(r"^([^/]+)/elasticvue/(.+)$")

# Markers of the previous name in a name a person chose. The lookarounds are there because a
# bare search for "evp" also matches a host called devprod — three characters in the middle of
# an unrelated word — and reporting that as a leftover of the rename sends someone hunting for
# nothing. "elasticvue" and "espro" are matched case-insensitively; the three-letter marker is
# matched only as its own word (`evp_clients`, `evp.clients.list`, `{$EVP.DL}`) or as the start
# of a PHP namespace (`EvpClients`).
OLD_NAME = re.compile(r"(?i:elasticvue|espro)|(?<![A-Za-z0-9])(?:EVP|evp|Evp)(?![a-z0-9])")

# The five frontend modules, old id -> new id. Zabbix remembers a module by the id in its
# manifest.json, so a renamed folder is a different module to it, not the same one moved.
MODULES = [("elasticvuepro", "elasticpro"), ("evp_clients", "ep_clients"),
           ("evp_capacity", "ep_capacity"), ("evp_resources", "ep_resources"),
           ("evp_volume", "ep_volume")]

auth = call("user.login", {"username": "Admin", "password": creds["Admin"]})
print(f"ElasticPro — rename of a live Zabbix: {_common.zabbix_url()}")
print("DRY RUN: nothing will be changed. Pass --apply to change it." if not APPLY
      else "--apply: the macros below are being renamed.")
if REWRITE_VAULT and not APPLY:
    print("note: --rewrite-vault-path only does anything with --apply; it is listed below either way.")

found = changed = skipped = 0
human = []                                     # what is left for a person, printed at the end


def new_name(macro):
    for old, new in PREFIXES:
        if macro.startswith(old):
            return new + macro[len(old):]
    return None


def plan(macros, label, id_key, update, delete):
    """One pass over one owner's macros (a host's, a template's, or the global ones).

    A global macro and a host macro differ in two API calls and an id field, and in nothing
    else: what counts as recognised, and what counts as a conflict rather than a rename, is
    one rule. Writing that rule out twice is how this codebase has drifted before, so the
    calls are arguments and there is one copy of the rule."""
    global found, changed, skipped
    here = {m["macro"]: m for m in macros}
    for m in sorted(macros, key=lambda m: m["macro"]):
        want = new_name(m["macro"])
        if not want:
            continue
        found += 1
        there = here.get(want)
        if there is None:
            if not APPLY:
                print(f"   {label}: {m['macro']} -> {want}")
                continue
            try:
                call(update, {id_key: m[id_key], "macro": want})
            except RuntimeError as e:
                skipped += 1
                print(f"   {label}: {m['macro']} -> {want}  NOT RENAMED: {e}")
                human.append(f"{label}: rename {m['macro']} to {want} by hand — Zabbix refused it ({e})")
                continue
            here.pop(m["macro"], None)
            here[want] = m
            changed += 1
            print(f"   {label}: {m['macro']} -> {want}  renamed")
            continue
        # The new name is already there. Same value and type: a leftover of a run that
        # stopped half way, safe to drop. Anything else is a decision, not a rename.
        if m["type"] == SECRET or there["type"] == SECRET:
            skipped += 1
            print(f"   {label}: {m['macro']} and {want} both exist, one of them Secret text — "
                  f"SKIPPED: the API does not give a Secret-text value back, so these cannot be compared")
            human.append(f"{label}: {m['macro']} and {want} both exist and one is Secret text — "
                         f"check which value is current, then delete the other")
        elif m["type"] == there["type"] and m.get("value") == there.get("value"):
            if not APPLY:
                print(f"   {label}: {want} already carries this value — would remove the stale {m['macro']}")
                continue
            try:
                call(delete, [m[id_key]])
            except RuntimeError as e:
                skipped += 1
                print(f"   {label}: stale {m['macro']} NOT REMOVED: {e}")
                continue
            changed += 1
            print(f"   {label}: stale {m['macro']} removed ({want} already carries its value)")
        else:
            skipped += 1
            print(f"   {label}: {m['macro']} -> {want}  CONFLICT: {want} is already there with a "
                  f"different value — both left alone")
            human.append(f"{label}: {m['macro']} and {want} hold different values — decide which is "
                         f"current, set it on {want}, delete {m['macro']}")


print("\n== macros on hosts and templates")
# In the macro API a template is a host, so one usermacro.get covers both; host.get and
# template.get are only here to put a name on each one in the report.
label_of = {h["hostid"]: f'host "{h["host"]}"' for h in call("host.get", {"output": ["host"]})}
label_of.update({t["templateid"]: f'template "{t["host"]}"' for t in call("template.get", {"output": ["host"]})})
owned = {}
for m in call("usermacro.get", {"output": "extend"}):
    owned.setdefault(m["hostid"], []).append(m)
before = found
for hostid in sorted(owned, key=lambda i: label_of.get(i, i)):
    plan(owned[hostid], label_of.get(hostid, f"hostid {hostid}"), "hostmacroid",
         "usermacro.update", "usermacro.delete")
if found == before:
    print("   nothing to rename")

print("\n== global macros")
before = found
glob = call("usermacro.get", {"globalmacro": True, "output": "extend"})
plan(glob, "global", "globalmacroid", "usermacro.updateGlobal", "usermacro.deleteGlobal")
if found == before:
    print("   nothing to rename")

# A macro that looks like the old name but is not one of the two prefixes the code reads — a
# site's own {$EVPFOO}, say. Renaming it would be guessing at what it is for, so it is named
# here and left exactly as it is.
unknown = sorted({m["macro"] for ms in list(owned.values()) + [glob] for m in ms
                  if not new_name(m["macro"]) and OLD_NAME.search(m["macro"])})
if unknown:
    print("\n== macros that name the old product but are none of ours")
    for macro in unknown:
        print(f"   {macro}  (left alone — not a macro this code reads)")
    human.append(f"{len(unknown)} macro(s) carry the old name but are not ones ElasticPro reads "
                 f"({', '.join(unknown)}) — rename them yourself if they are yours")

print("\n== Vault secret paths")
vault_hits = []
for hostid, macros in owned.items():
    for m in macros:
        if m["type"] == VAULT and OLD_VAULT_PATH.match(m.get("value") or ""):
            vault_hits.append((hostid, m))
if not vault_hits:
    print("   no macro points at the old secret path")
for hostid, m in sorted(vault_hits, key=lambda p: label_of.get(p[0], p[0])):
    label = label_of.get(hostid, f"hostid {hostid}")
    mount, rest = OLD_VAULT_PATH.match(m["value"]).groups()
    want = f"{mount}/elasticpro/{rest}"
    if not (APPLY and REWRITE_VAULT):
        print(f"   {label}: {m['macro']} = {m['value']}  ->  {want}  (only with --apply --rewrite-vault-path)")
        continue
    try:
        call("usermacro.update", {"hostmacroid": m["hostmacroid"], "value": want})
    except RuntimeError as e:
        skipped += 1
        print(f"   {label}: {m['macro']} NOT rewritten: {e}")
        continue
    changed += 1
    print(f"   {label}: {m['macro']} = {want}  rewritten")
if vault_hits and not (APPLY and REWRITE_VAULT):
    human.append(f"{len(vault_hits)} Vault macro(s) still point at <mount>/elasticvue/… — copy those "
                 f"secrets to <mount>/elasticpro/… in Vault, read one back, then run this with "
                 f"--apply --rewrite-vault-path; or leave them and keep a Vault policy that grants "
                 f"read on the old path")

# ---------------------------------------------------------------------------------------------
# Everything below is read-only. These are the parts of the rename a script cannot do safely,
# so it says what it found and what a person does about it, rather than guessing.
# ---------------------------------------------------------------------------------------------
print("\n== the frontend modules (no script can rename one)")
try:
    registered = {m["id"]: m for m in call("module.get", {"output": ["id", "status", "relative_path"]})}
except RuntimeError as e:
    registered = {}
    print(f"   could not read the module list: {e}")
old_present = [old for old, _ in MODULES if old in registered]
new_missing = [new for _, new in MODULES if new not in registered]
new_off = [new for _, new in MODULES if new in registered and registered[new].get("status") == "0"]
for old, new in MODULES:
    was = "registered" if old in registered else "not registered"
    now = ("enabled" if registered.get(new, {}).get("status") == "1" else
           "registered but disabled" if new in registered else "not registered")
    print(f"   {old} ({was})  ->  {new} ({now})")
if old_present or new_missing or new_off:
    print("   Zabbix keys a module on the id in its manifest.json and remembers it in the database,")
    print("   so the renamed folders are new modules to it — disabled until someone enables them —")
    print("   and the old rows stay until their folder is gone. In order:")
    print("     1. Administration -> General -> Modules: disable the old entries listed above.")
    print("        A module whose folder vanishes while it is enabled leaves menu items pointing nowhere.")
    print("     2. Install the new folders: sudo bash zabbix-modules-install.sh (a package install or a")
    print("        zabbix-web-* container), or install-modules.sh for the stack in ../stack.")
    print("        It puts modules/<new id> in place and registers and enables each one.")
    print("     3. Delete the old folders from the same modules folder (/usr/share/zabbix/modules for a")
    print("        package install, the folder mounted there for the container), then")
    print("        Administration -> General -> Modules -> Scan directory: Zabbix drops the rows whose")
    print("        folder is gone.")
    print("     4. Cluster Management keeps its clients, roles and backups outside the module folder, and")
    print("        that folder was renamed too: move /var/lib/elasticvue-zabbix to /var/lib/elasticpro-zabbix")
    print("        (same owner, same 0770), or the page opens with no clients in it. If PHP sets the folder")
    print("        explicitly, the variable is now EP_DATA_DIR, not EVP_DATA_DIR.")
    human.append("enable the new modules in Administration -> General -> Modules, remove the old module "
                 "folders, and move the Cluster Management data folder (steps above)")

print("\n== links that still name the old actions")
# Zabbix action names are in the URL (zabbix.php?action=…), and they were renamed with the
# modules. Anything holding one of the old names points at a page that no longer exists.
print("   elasticvuepro.<page> -> elasticpro.<page>   evp.clients.<what> -> ep.clients.<what>")
print("   widget.evp_<name>.<what> -> widget.ep_<name>.<what>")
try:
    for s in call("script.get", {"output": ["name", "url", "scope"]}):
        if OLD_NAME.search(s.get("name") or "") or OLD_NAME.search(s.get("url") or ""):
            print(f"   script \"{s['name']}\" -> {s.get('url')}")
            human.append(f"script \"{s['name']}\" still opens an old action — re-run "
                         f"setup/zbx_troubleshoot.py, then delete the old script")
except RuntimeError as e:
    print(f"   could not read the scripts: {e}")
try:
    for d in call("dashboard.get", {"output": ["name"], "selectPages": ["widgets"]}):
        hits = set()
        for page in d.get("pages") or []:
            for w in page.get("widgets") or []:
                if w.get("type") in dict(MODULES):
                    hits.add(w["type"])
                for f in w.get("fields") or []:
                    if isinstance(f.get("value"), str) and OLD_NAME.search(f["value"]):
                        hits.add(f["value"][:80])
        if hits:
            print(f"   dashboard \"{d['name']}\": {', '.join(sorted(hits))}")
            human.append(f"dashboard \"{d['name']}\" holds widgets of a renamed module or a URL naming an "
                         f"old action — add the new widget and remove the old one")
except RuntimeError as e:
    print(f"   could not read the dashboards: {e}")
print("   A bookmark, or a favourite a user saved in their own profile, is not reachable through the")
print("   API: those have to be opened once and re-saved.")

print("\n== objects still carrying the old name (nothing here changes them)")
# Named objects the module and these scripts create. After the rename the code looks for the
# new names, finds nothing, and makes a second set beside the first — two API users, two
# alert actions, two master templates. Which of each pair is the live one is a decision.
checks = [("template", "template.get", {"output": ["host"]}, "host"),
          ("host", "host.get", {"output": ["host"]}, "host"),
          ("host group", "hostgroup.get", {"output": ["name"]}, "name"),
          ("user group", "usergroup.get", {"output": ["name"]}, "name"),
          ("user", "user.get", {"output": ["username"]}, "username"),
          ("role", "role.get", {"output": ["name"]}, "name"),
          ("trigger action", "action.get", {"output": ["name"]}, "name")]
stale = 0
for what, method, params, key in checks:
    try:
        rows = call(method, params)
    except RuntimeError as e:
        print(f"   could not read the {what}s: {e}")
        continue
    hit = sorted(r[key] for r in rows if OLD_NAME.search(r.get(key) or ""))
    stale += len(hit)
    for name in hit:
        print(f"   {what}: {name}")
    if hit:
        human.append(f"{len(hit)} {what}(s) still named for the old product — see the list above")
if not stale:
    print("   none")

# The four templates Cluster Management generates (client master, cluster devices, and the two
# jump-host ones) take their uuids from a hash of the product name, so the rename changed every
# uuid: "Write master template" creates a new template beside the old one instead of updating
# it, and the old one keeps the hosts, the item history and the old item keys. Of the four templates this repo
# exports as YAML, only template-elasticpro.yaml kept its uuids; the other three are generated
# by tools/zabbix-{alert,plan,delay}-template.mjs, which hash the product name into every uuid,
# so re-importing them creates new templates beside the old ones too.
try:
    old_keys = int(call("item.get", {"search": {"key_": "evp."}, "countOutput": True})) + \
               int(call("item.get", {"search": {"key_": "espro."}, "countOutput": True}))
except (RuntimeError, ValueError) as e:
    old_keys = None
    print(f"   could not count the items with old keys: {e}")
if old_keys:
    print(f"   {old_keys} item(s) still have an evp.* / espro.* key, with all of their history.")
    print("   The generated templates (client master, cluster devices, the jump-host ones) are keyed on")
    print("   uuids derived from the product name, so Cluster Management -> Write master template makes a")
    print("   NEW template rather than updating the old one, and Cluster Management finds a client by the")
    print("   new template's name. Decide per client whether to link its master host to the new template")
    print("   (new items, history starts again) or to keep the old one; a script should not pick for you.")
    human.append(f"{old_keys} item(s) keep an old key: decide what happens to the generated templates "
                 f"and the history on them")

print("\n== summary")
print(f"   recognised old macros found: {found}")
print(f"   changed: {changed}" + ("" if APPLY else "   (dry run — nothing was written)"))
print(f"   skipped: {skipped}")
if not human:
    print("   nothing left for a person")
else:
    print(f"   left for a person: {len(human)}")
    for line in human:
        print(f"     - {line}")
if found and not APPLY:
    print("\n   run it again with --apply to rename the macros.")
