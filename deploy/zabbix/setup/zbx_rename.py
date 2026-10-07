"""Carry a live Zabbix across the rename to ElasticPro: the macros the code reads, the named
objects the modules look for, and a report on everything a script must not change on its own.

The rename moved identifiers that live in the operator's Zabbix database, not only in this
repository. The macros are the ones that break quietly. The code now reads {$EP.*} and
{$ELASTICPRO.*}; every host and template made before the upgrade still carries {$EVP.*} and
{$ESPRO.*}. Nothing errors — Cluster Management simply shows a client with no plan, no DL
and no contract end, because the macros it asks for are not there, and "unknown" is what the
pages are built to say when a value is missing.

The modules recognise both generations, so an un-migrated install works. This script is for
retiring the old names once and for all, one phase at a time, on a production Zabbix.

Dry run unless --apply: on its own it prints what it would change and changes nothing. A
write here needs a decision a person made by hand, as everywhere else in this project.

  python3 setup/zbx_rename.py                                # what would change, everywhere
  python3 setup/zbx_rename.py --apply                        # rename the macros (as before)
  python3 setup/zbx_rename.py --apply --rewrite-vault-path   # the Vault paths, and nothing else
  python3 setup/zbx_rename.py --tags                         # plan one phase
  python3 setup/zbx_rename.py --apply --tags                 # run that one phase
  python3 setup/zbx_rename.py --all                          # plan every phase
  python3 setup/zbx_rename.py --apply --phase alerts --client acme   # one phase, one client

Run it as often as you like: a second run finds nothing left to do. Every phase compares what
is there with what it wants and skips a match, so "already migrated" is a result, not a crash.

THE PHASES, in the order they run. With no phase flag every phase reports and the two that
were here before this was a phased script (macros, vault) keep behaving as they did: --apply
renames the macros. --apply --rewrite-vault-path rewrites the Vault paths and now does ONLY
that — it used to reset the named-phase set, so "no phase was named" became true again and the
macro phase wrote as well, unannounced; an operator following the documented Vault command line
renamed every macro on the install without being told. Name a phase and only the named ones
may write.

  preflight    always; writes nothing. The client census, and a twin report: a name that
               exists in BOTH generations cannot be renamed onto itself, so the object is
               refused here and in every later phase.
  modules      always; writes nothing. No API renames a registered module. It prints the
               four steps by hand, and it is the gate for --dashboards.
  macros       --macros. {$EVP. -> {$EP. and {$ESPRO. -> {$ELASTICPRO. on hosts, templates
               and globally, EXCEPT a macro that an enabled calculated item's formula or an
               enabled trigger's expression still names: see "MACROS IN FORMULAS" below.
  vault        --vault (or --rewrite-vault-path). <mount>/elasticvue/... -> <mount>/elasticpro/...
  groups       --groups. Host group "ElasticVue clients" -> "ElasticPro clients".
  tags         --tags. managed-by: elasticvue-clients -> elasticpro-clients, and evp-* -> ep-*
               on every host, in ONE host.update per host.
  alerts       --alerts. Per client: user group, evp-dl-<client> account, trigger action,
               weekly report, report dashboard — all "ElasticVue: " -> "ElasticPro: ".
  widgets      --dashboards. Dashboard widgets of type evp_resources / evp_capacity /
               evp_volume, whose modules no longer exist, so they render blank.
  maintenance  --maintenance. A live Zabbix maintenance "ElasticVue: <client>".
  relink       --templates. Links "ElasticPro client master" to each master host. It unlinks
               NOTHING: see "item history" below.
  datadir      --datadir. Prints the filesystem move. No API can do it, so nothing else.

MACROS IN FORMULAS — why the macro phase leaves some macros alone. A Zabbix calculated item's
formula is text, and the master template's "requested" items are calculated items whose entire
formula is a macro: ep.devices.purchased is {$EP.DEVICES.PURCHASED}, and each role's figure is
{$EP.<ROLE>.CPU.REQUESTED} and its kind (MasterTemplate::baseItems() and roleItems()). The
legacy generation of those same items names {$EVP....}. Renaming the macro therefore leaves the
formula naming a macro that no longer exists, and Zabbix makes the item UNSUPPORTED: every
capacity and shortfall figure on every client stops being collected for however many days or
weeks the rest of the migration takes, and a value that was never collected cannot be
backfilled afterwards from anything. Trigger expressions carry macros too — the legacy
client-plan template's nodata() trigger names {$ESPRO.PLAN.STALE}.

So the macro phase refuses exactly one class of macro: one whose name appears in the formula of
an ENABLED calculated item, or in the expression of an ENABLED trigger, on any host. It renames
every other macro, which is most of them — {$EVP.DL}, {$EVP.LEAD}, {$EVP.CONTRACT.END},
{$EVP.CLIENT.STATUS}, the jump-host set — so Cluster Management's empty fields are fixed at
once. Each refused macro is listed with the items and triggers that hold it, and the way
through is to stop those objects first: --templates --disable-legacy-items links the current
master template and sets the legacy items and triggers to Disabled, a disabled object holds no
lock, and the next --apply --macros renames what is left. That is why the runbook in
setup/README.md puts the relink BEFORE the second macro run.

It is checked rather than documented-and-hoped, and the check fails closed: if the calculated
items and triggers cannot be read at all, the macro phase refuses to rename anything, because
an empty scan and a scan that was not allowed look exactly alike.

ITEM HISTORY — the one thing in this migration that cannot be got back. The rename changed
every item key the master template generates (evp.es.storage.used became ep.es.storage.used,
and so on for all of them), so the two generations of the template share no key at all and
no path carries a value across: the ep.* items begin empty at the moment they are linked.
Deleting an item deletes its history and its trends, and nothing in this module's backups
holds item values. So this script refuses, structurally and with no flag to override:

  * host.massremove in any form, and any payload carrying templateids_clear or
    templates_clear — "Unlink and clear" is what destroys the history.
  * host.update carrying a templates array — it REPLACES the link list, so one template
    missed from the array is silently unlinked and its items are stranded at host level.
  * template.update renaming a legacy template to a current name — the item keys would stay
    evp.*, the uuid would stay the legacy one, and "Write master template" would then fail
    on a name-present/uuid-different collision from that moment on, permanently.
  * template.delete, item.delete, trigger.delete, configuration.import, history.clear,
    trend.clear, housekeeping.update, and every other delete.

What --templates does instead is additive: host.massadd puts the current master template on
the master host beside the legacy one. With --disable-legacy-items it also sets to Disabled the
items and triggers the host INHERITS FROM THE LEGACY TEMPLATE IT JUST RELINKED — matched by each
object's parent id, never by its key prefix, and nothing else is touched — which stops the double
shortfall alerts and the double calculated-item load, deletes nothing and is undone by re-enabling
them. An evp.*-keyed item of the site's own, or one belonging to a legacy template this phase did
not relink, is named in the output and left collecting. Taking the legacy template off the host is left
to a person, in a maintenance window, with "Unlink" and never "Unlink and clear"; the exact
steps are printed per host.

Because the ep.* series starts empty, --templates needs a second decision of its own:
--apply --templates --accept-history-restart. Two hand-made decisions, as with every other
write in this project.

Nothing creates a host, deletes anything, or touches an item's data. Which Zabbix and which
Admin password come from --zabbix-url / $ZBX_URL and --accounts / $ZBX_ACCOUNTS, like the
rest of the scripts here (see _common.py). --host / $EP_HOST is not needed: nothing here
writes an address anywhere.
"""
import hashlib, json, re, ssl, sys, time, urllib.request

import _common

ARGV = sys.argv[1:]
APPLY = "--apply" in ARGV
REWRITE_VAULT = "--rewrite-vault-path" in ARGV
ACCEPT_HISTORY_RESTART = "--accept-history-restart" in ARGV
DISABLE_LEGACY_ITEMS = "--disable-legacy-items" in ARGV


def flag_all(name):
    """Every --name value in argv, in order, or [] if the flag was not given.

    _common.flag_value() is the right thing for a flag given once; it finds the first
    occurrence and stops. --phase and --client are deliberately repeatable, and a silently
    ignored second --client would run a phase against a client the operator did not name
    and leave the one they did name alone, so they are collected here instead."""
    out = []
    for i, a in enumerate(ARGV):
        if a == name:
            if i + 1 >= len(ARGV):
                sys.exit(f"{name} needs a value")
            out.append(ARGV[i + 1])
    return out


# ---------------------------------------------------------------------------------------------
# Phases. Each is individually selectable because this runs against a production Zabbix with
# seven live clients: an operator does one thing, looks at it, and comes back for the next.
# ---------------------------------------------------------------------------------------------
PHASES = ["macros", "vault", "groups", "tags", "alerts", "widgets", "maintenance", "relink", "datadir"]
# Phase name -> the flags that select it. More than one spelling where the obvious word and
# the precise word differ: "--dashboards" is what an operator looking at a blank widget will
# reach for, "--widgets" is what the phase actually rewrites.
PHASE_FLAGS = {"macros": ["--macros"], "vault": ["--vault", "--rewrite-vault-path"],
               "groups": ["--groups"], "tags": ["--tags"], "alerts": ["--alerts"],
               "widgets": ["--dashboards", "--widgets"], "maintenance": ["--maintenance"],
               "relink": ["--templates", "--relink"], "datadir": ["--datadir"]}
# The two phases that existed before this script had phases. With --apply and no phase flag
# they must go on doing exactly what they did, or an upgrade of this file silently stops doing
# the work someone's runbook says it does.
LEGACY_DEFAULT = {"macros", "vault"}

named = set()
for _ph, _flags in PHASE_FLAGS.items():
    if any(f in ARGV for f in _flags):
        named.add(_ph)
if "--all" in ARGV:
    named.update(PHASES)
for _v in flag_all("--phase"):
    if _v == "all":
        named.update(PHASES)
    elif _v in PHASES:
        named.add(_v)
    else:
        sys.exit(f"--phase {_v}: no such phase. One of: {', '.join(PHASES)}, or all")
# --rewrite-vault-path on its own used to empty this set, so that selected() and writing() both
# read "no phase was named" and the macro phase wrote too. That is how an operator who ran the
# documented Vault command line — the one in the Vault section of setup/README.md, which is about
# secret paths and says nothing about macros — renamed every macro on the install without being
# asked. The flag now means what it says: the vault phase, and only the vault phase. --apply on
# its own still runs the macro phase, which is the other half of what the pre-phase script did,
# so no runbook that said "--apply renames the macros" has stopped being true.
CLIENTS_WANTED = flag_all("--client")


def selected(phase):
    """Whether this phase reports. With no phase flag, everything reports."""
    return phase in named or not named


def writing(phase):
    """Whether this phase may write. --apply is necessary and never sufficient: a phase the
    operator did not name does not write, so one run changes one thing."""
    if not APPLY:
        return False
    if phase == "vault" and not REWRITE_VAULT:
        return False                           # the Vault path keeps its own flag: see the docstring
    if phase in LEGACY_DEFAULT:
        return phase in named or not named
    return phase in named


URL = _common.api_url(); CTX = ssl._create_unverified_context()   # the stack's own self-signed cert, on loopback
creds = _common.read_accounts()
auth = None


# ---------------------------------------------------------------------------------------------
# The one place a write can happen, and the allow-list it is checked against.
# ---------------------------------------------------------------------------------------------
class Refused(Exception):
    """A call this script will not make. Never caught and turned into a warning: a refusal is
    the answer, not a hiccup on the way to doing it anyway."""


# Session methods: they are neither reads nor writes of anything the migration touches.
SESSION = {"user.login", "user.logout"}
# Every write this script is allowed to make. Anything else reaching call() with --apply is a
# bug in this file, not an operator's mistake, so it raises rather than asking.
WRITE_ALLOWED = {
    "usermacro.update", "usermacro.updateGlobal", "usermacro.delete", "usermacro.deleteGlobal",
    "host.update",          # tags only; a templates array in one is refused below
    "host.massadd",         # linking the current master template: purely additive
    "hostgroup.update", "usergroup.update", "user.update", "action.update",
    "report.update", "dashboard.update", "maintenance.update",
    "item.update", "trigger.update",   # status=1 on the legacy inherited objects, nothing else
}
# Denied by name, each with the reason an operator needs to hear. These are not oversights to
# be added later: every one of them either deletes item history or makes "Write master
# template" fail for good.
WRITE_DENIED = {
    "host.massremove": "unlinking a template is a person's job in a maintenance window — and "
                       "this is the call shape that carries templateids_clear, which deletes "
                       "the inherited items and all of their history. Data collection -> Hosts "
                       "-> the host -> Templates -> Unlink (never Unlink and clear)",
    "template.delete": "triggers, graphs and discovery rules still hang off a legacy template, "
                       "and deleting it takes them with it. Delete it by hand once nobody needs them",
    "template.update": "renaming a legacy template to a current name leaves evp.* item keys and "
                       "a legacy uuid under a current name, and every later 'Write master "
                       "template' then fails on a name-present/uuid-different collision, "
                       "permanently. Link the current template instead (--templates)",
    "template.massremove": "see host.massremove: unlinking is done by hand, without clear",
    "configuration.import": "importing these templates belongs to the module, against the "
                            "current names and uuids only. Its rules carry deleteMissing for "
                            "items, triggers, graphs, discovery rules and template dashboards, "
                            "so an import aimed at the old generation deletes every evp.* item "
                            "and its history",
    "item.delete": "deleting an item deletes its history and its trends, and nothing in this "
                   "module's backups holds item values",
    "trigger.delete": "a trigger is cheap to lose and this script does not need to; refuse "
                      "rather than discover it was load-bearing",
    "host.delete": "a host carries every item of every template on it",
    "hostgroup.delete": "a group that is a host's only group cannot be deleted, so a refusal "
                        "part-way through a loop would leave the set half-moved. Move the hosts "
                        "on the Hosts page, then delete the emptied group by hand",
    "usergroup.delete": "removing a live client's alerting is a decision, not a rename",
    "user.delete": "removing a live client's DL account is a decision, not a rename",
    "action.delete": "deleting a trigger action takes its escalation steps with it",
    "report.delete": "deleting a scheduled report takes its delivery history with it",
    "dashboard.delete": "a dashboard holds an arrangement someone made",
    "maintenance.delete": "ending a maintenance by surprise un-suppresses a live client",
    "history.clear": "this is the irrecoverable one",
    "trend.clear": "this is the irrecoverable one",
    "housekeeping.update": "retention is what is keeping the evp.* history alive while the "
                           "operator decides what to export",
}
# Any payload carrying one of these is refused whatever the method is. It is checked
# structurally rather than merely never typed, because "Unlink" and "Unlink and clear" differ
# by this one field name and the second one is the only irrecoverable thing in the migration.
FORBIDDEN_KEYS = ("templateids_clear", "templates_clear")


def _forbidden_key(x):
    if isinstance(x, dict):
        for k, v in x.items():
            if k in FORBIDDEN_KEYS:
                return k
            found = _forbidden_key(v)
            if found:
                return found
    elif isinstance(x, (list, tuple)):
        for v in x:
            found = _forbidden_key(v)
            if found:
                return found
    return None


def call(m, p):
    bad = _forbidden_key(p)
    if bad:
        raise Refused(f"{m}: refusing a payload carrying {bad} — that deletes the inherited "
                      f"items and every value of their history, and nothing restores them")
    if m not in SESSION and not m.endswith(".get"):
        if m in WRITE_DENIED:
            raise Refused(f"{m}: refused — {WRITE_DENIED[m]}")
        if m not in WRITE_ALLOWED:
            raise Refused(f"{m}: refused — not one of the write methods this script is allowed "
                          f"to make. Adding one is a change to this file, reviewed, not a flag")
        if m == "host.update" and ("templates" in p or "parentTemplates" in p):
            raise Refused("host.update with a templates array: refused — it replaces the link "
                          "list, so a template missed from the array is unlinked and its items "
                          "are stranded at host level. Linking is done with host.massadd")
        if not APPLY:
            raise Refused(f"{m}: refused — a dry run tried to write. This is a bug in this script")
    h = {"Content-Type": "application/json-rpc"}
    if auth: h["Authorization"] = "Bearer " + auth
    r = json.load(urllib.request.urlopen(urllib.request.Request(URL, json.dumps({"jsonrpc": "2.0", "method": m, "params": p, "id": 1}).encode(), h), context=CTX))
    if "error" in r: raise RuntimeError(f"{m}: {r['error'].get('data')}")
    return r["result"]


# ---------------------------------------------------------------------------------------------
# What the rename moved. Every value here is the constant the PHP reads, cited, so that a
# later change to one of them is a change in two places that a grep finds, not a drift.
# ---------------------------------------------------------------------------------------------
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
# bare search for "evp" also matches a host called devprod — three characters in the middle of an
# unrelated word — and reporting that as a leftover of the rename sends someone hunting for
# nothing. The first version of this put the boundaries on the three-letter marker only, and on
# only one side of it, so "esproxy-01" and "EVPN-router" were both reported as objects still
# carrying the old product name. Report-only, but it sends an operator through a 42-host install
# looking for a rename that never touched either of them, which is time spent and trust lost. So:
#   * "elasticvue" needs no boundary — nothing else contains it, and "elasticvuepro" must match.
#   * "espro" is bounded on both sides, so esproxy-01 and ESPROXY-01 do not match while
#     "espro.delay[...]" and "{$ESPRO.URL}" still do.
#   * the three-letter marker is bounded on the left always, and on the right by its own case:
#     all-caps EVP must be followed by something that is not alphanumeric ({$EVP.DL},
#     evp_clients, evp.clients.list), which is what keeps EVPN-router out, while Evp and evp may
#     be followed by a capital, which is what lets the PHP namespace EvpClients match.
OLD_NAME = re.compile(r"(?i:elasticvue)"
                      r"|(?<![A-Za-z0-9])(?i:espro)(?![A-Za-z0-9])"
                      r"|(?<![A-Za-z0-9])(?:EVP(?![A-Za-z0-9])|evp(?![a-z0-9])|Evp(?![a-z0-9]))")
# A macro of the site's own that names the old product: {$EVPFOO}, {$ESPROBAR}. OLD_NAME cannot
# be used for this — it now bounds EVP on the right so that EVPN-router is not reported, and that
# same boundary would hide {$EVPFOO}, which the macro report is specifically about. A macro name
# has a shape of its own (uppercase, after "{$"), so it gets a test of its own.
OLD_MACRO_NAME = re.compile(r"^\{\$(EVP|ESPRO)")

# The five frontend modules, old id -> new id. Zabbix remembers a module by the id in its
# manifest.json, so a renamed folder is a different module to it, not the same one moved.
MODULES = [("elasticvuepro", "elasticpro"), ("evp_clients", "ep_clients"),
           ("evp_capacity", "ep_capacity"), ("evp_resources", "ep_resources"),
           ("evp_volume", "ep_volume")]

# Reconciler::MANAGED / LEGACY_MANAGED (lib/Reconciler.php:32, :68).
MANAGED_TAG, MANAGED_NEW, MANAGED_OLD = "managed-by", "elasticpro-clients", "elasticvue-clients"
# Reconciler::TAG_PREFIX / LEGACY_TAG_PREFIX (:45, :81).
TAG_NEW, TAG_OLD = "ep-", "evp-"
# Lifecycle::WAS_OFF / Lifecycle::LEGACY_WAS_OFF (lib/Lifecycle.php:26, :54). This file used to
# say the marker had no legacy constant, and the tags phase printed that in '!!' markers as the
# one deadline in the migration: that Clients -> Enable could not see an evp-was-off and would
# switch back on a host an operator had deliberately left off. It was true when it was written
# and it is not true now — Lifecycle::enable() tests both spellings and ownTags() strips all
# four. The warning stayed behind as a false alarm, which is worse than no warning at all: an
# operator who catches one '!!' line being wrong in the middle of a production migration has no
# reason left to believe the next one.
WAS_OFF_NEW, WAS_OFF_OLD = "ep-was-off", "evp-was-off"
# Reconciler::MASTERS_GROUP / LEGACY_MASTERS_GROUP (:33, :70). CLUSTER_GROUP
# ("Elasticsearch clusters") and ULM_GROUP ("Log archive") have no legacy spelling and are
# shared with the rest of the install: they are never touched here.
GROUP_NEW, GROUP_OLD = "ElasticPro clients", "ElasticVue clients"
# AlertRouting::NAME_PREFIX / LEGACY_NAME_PREFIX (:33, :44) — and Lifecycle::NAME_PREFIX /
# Lifecycle::LEGACY_NAME_PREFIX (lib/Lifecycle.php:23, :57), which are the same two strings.
PREFIX_NEW, PREFIX_OLD = "ElasticPro: ", "ElasticVue: "
# AlertRouting::USER_PREFIX / LEGACY_USER_PREFIX (:34, :45). The two differ in length, which is
# why the new username is rebuilt rather than sliced: see client_user().
USER_NEW, USER_OLD = "ep-dl-", "evp-dl-"
# AlertRouting::REPORT_WIDGETS / LEGACY_REPORT_WIDGETS (:107, :114), against the id in each
# widget's manifest.json.
WIDGET_TYPES = {"evp_resources": "ep_resources", "evp_capacity": "ep_capacity",
                "evp_volume": "ep_volume"}
# Store::DIR / LEGACY_DIR (shared/php/Store.php:25, :28).
DATA_DIR_NEW, DATA_DIR_OLD = "/var/lib/elasticpro-zabbix", "/var/lib/elasticvue-zabbix"
# MasterTemplate::NAME / Reconciler::LEGACY_MASTER_TEMPLATES (:21, :77). The second legacy name
# is the spelling the live install reported; nothing in this repository records its item key
# prefix, so a host carrying only that one is reported and never relinked.
MASTER_NEW = "ElasticPro client master"
MASTER_OLD = "ElasticVue Pro client master"
MASTER_OLDEST = "ElasticVue client master"
# TemplateInstaller::LEGACY_TEMPLATES (:44-50): uuid seed -> legacy name -> current name.
LEGACY_TEMPLATES = [
    ("template", MASTER_OLD, MASTER_NEW),
    ("devices/template", "ElasticVue Pro cluster devices", "ElasticPro cluster devices"),
    ("jump/template", "ElasticVue Pro Elasticsearch via SSH jump host",
     "ElasticPro Elasticsearch via SSH jump host"),
    ("jump/ulm/template", "ElasticVue Pro log archive ES via SSH jump host",
     "ElasticPro log archive ES via SSH jump host"),
    # The cluster template's name is a setting (Roles::clusterTemplate()), so a site that
    # pointed the Roles page at the pre-rename spelling is using that name on purpose. It is
    # subtracted below exactly as TemplateInstaller::legacyTemplates() subtracts it.
    ("cluster/template", "Elasticsearch Cluster by HTTP EVP", _common.cluster_template()),
]


def new_name(macro):
    """The current spelling of a macro of the old generation, or None if it is none of ours."""
    for old, new in PREFIXES:
        if macro.startswith(old):
            return new + macro[len(old):]
    return None


def uuid_from(seed):
    """MasterTemplate::uuidFrom(), to the character.

    The product name is inside the sha256, so the rename changed every uuid and no current
    uuid can ever match a legacy object. That is what makes a uuid the only honest way to tell
    a template this module wrote from a template of the site's own that merely shares the
    name — and taking a template off a host on the strength of its name alone is how an
    administrator loses the one template their cluster hosts need."""
    h = hashlib.sha256(seed.encode()).hexdigest()
    return h[0:12] + "4" + h[13:16] + "89ab"[int(h[16], 16) % 4] + h[17:32]


def legacy_uuid(what):
    return uuid_from("espro-client-master/" + what)       # MasterTemplate::legacyUuid()


def current_uuid(what):
    return uuid_from("elasticpro-client-master/" + what)  # MasterTemplate::uuid()


def sanitise(client):
    """AlertRouting::userName()'s sanitising, without its prefix."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", client)[:90]


def client_user(client, legacy=False):
    """The DL account's username under one generation.

    Rebuilt from the client name rather than sliced out of the username that is there, because
    "evp-dl-" is seven characters and "ep-dl-" is six: slicing the prefix off a username whose
    sanitised client name was truncated at 90 characters produces a name AlertRouting::
    userNames() does not recognise, and the next save of that client creates a SECOND DL
    account beside it."""
    return (USER_OLD if legacy else USER_NEW) + sanitise(client)


auth = call("user.login", {"username": "Admin", "password": creds["Admin"]})
print(f"ElasticPro — rename of a live Zabbix: {_common.zabbix_url()}")
print("DRY RUN: nothing will be changed. Pass --apply to change it." if not APPLY
      else "--apply: the phases named below are being applied.")
if named:
    print(f"phases: {', '.join(p for p in PHASES if p in named)}"
          + ("" if APPLY else "   (planned only)"))
else:
    print("no phase named: every phase reports; with --apply only the macro phase writes, as before "
          "(the\n   Vault-path phase has always needed --rewrite-vault-path of its own).")
if REWRITE_VAULT and not APPLY:
    print("note: --rewrite-vault-path only does anything with --apply; it is listed below either way.")
if CLIENTS_WANTED:
    # Which phases honour it, named, because it used to be honoured by four of them and silently
    # ignored by the tags phase — and an operator proving one phase on one client of seven had
    # the tags of all forty-two hosts rewritten without being told.
    print(f"scoped to client(s): {', '.join(CLIENTS_WANTED)}")
    print("   scopeable phases: tags, alerts, widgets, maintenance, relink.")
    print("   NOT scopeable, and they report and write across the whole install: macros (the global")
    print("   and template macros belong to no single client), vault, groups, modules, datadir.")

found = changed = skipped = refused = objects = 0
human = []                                     # what is left for a person, printed at the end


def refuse(line):
    """One refusal: counted, printed where it happened, and repeated in the summary. A refusal
    always says what to do instead — a message that only says no sends the operator looking
    for a flag to force it."""
    global refused
    refused += 1
    print(f"   REFUSED: {line}")
    human.append(line)


def note(line):
    human.append(line)


# ---------------------------------------------------------------------------------------------
# Phase 0: preflight. Not optional, writes nothing. Everything below reads from here, so one
# run asks Zabbix each question once and every phase answers from the same census — two
# phases disagreeing about which host is a master is how a host comes to look unowned.
# ---------------------------------------------------------------------------------------------
print("\n== preflight: what is here (reads only)")

ALL_HOSTS = call("host.get", {"output": ["hostid", "host", "name", "status"],
                              "selectTags": ["tag", "value"],
                              "selectParentTemplates": ["templateid", "host"],
                              "selectHostGroups": ["groupid", "name"]})
label_of = {h["hostid"]: f'host "{h["host"]}"' for h in ALL_HOSTS}
host_by_id = {h["hostid"]: h for h in ALL_HOSTS}

# A Zabbix Admin may read hosts but not templates. An empty template.get is therefore
# ambiguous — no templates, or no permission — and the relink phase refuses to run on it
# rather than report "nothing to do", which is the blind spot TemplateInstaller's own docblock
# names. Here it only decides how the master hosts are found, as Reconciler::masterHosts does.
TEMPLATES, TEMPLATES_READABLE, TEMPLATES_ERROR = [], False, None
try:
    TEMPLATES = call("template.get", {"output": ["templateid", "host", "uuid"]})
    TEMPLATES_READABLE = bool(TEMPLATES)
except RuntimeError as e:
    TEMPLATES_ERROR = str(e)
if not TEMPLATES_READABLE:
    print(f"   templates: cannot be read ({TEMPLATES_ERROR or 'the list came back empty'}) — "
          f"master hosts are found by their kind tag instead, and the relink phase will refuse to run")
label_of.update({t["templateid"]: f'template "{t["host"]}"' for t in TEMPLATES})
tpl_by_name = {t["host"]: t for t in TEMPLATES}

MASTER_NAMES = [MASTER_NEW, MASTER_OLD, MASTER_OLDEST]     # Reconciler::masterTemplates()


def tag_values(host, name):
    return [t["value"] for t in host.get("tags") or [] if t["tag"] == name]


# Macros, read once: the macro phase renames them and the client census reads {$GRP.CLIENT}
# out of the same answer.
owned = {}
for m in call("usermacro.get", {"output": "extend"}):
    owned.setdefault(m["hostid"], []).append(m)


def macros_of(hostid):
    return {m["macro"]: m.get("value") for m in owned.get(hostid, [])}


def master_hosts():
    """Every client's master host, under either generation — Reconciler::masterHosts()'s own
    definition, including its fallback. The two kind tags are OR'd by hand because host.get
    wants every tag it is given at once unless its evaltype says otherwise, and no host carries
    ep-kind and evp-kind both, so the default would match nothing at all."""
    ids = [tpl_by_name[n]["templateid"] for n in MASTER_NAMES if n in tpl_by_name]
    if ids:
        want = set(ids)
        return [h for h in ALL_HOSTS
                if want & {t["templateid"] for t in h.get("parentTemplates") or []}]
    return [h for h in ALL_HOSTS
            if "master" in tag_values(h, TAG_NEW + "kind") + tag_values(h, TAG_OLD + "kind")]


def client_name(host):
    """ClientState::clients()' definition: the {$GRP.CLIENT} macro, else the host name less the
    master suffix. One definition, because the alert, widget and maintenance phases all look
    objects up by this name and a phase that computes it differently renames the wrong object."""
    m = macros_of(host["hostid"])
    if (m.get("{$GRP.CLIENT}") or "") != "":
        return m["{$GRP.CLIENT}"]
    return re.sub(r"(-Master| master)$", "", host["host"])


MASTERS = master_hosts()
CLIENTS = {}
for _h in MASTERS:
    CLIENTS[client_name(_h)] = _h
CLIENT_NAMES = sorted(CLIENTS, key=lambda s: s.lower())
if not CLIENT_NAMES:
    print("   no master host found: this Zabbix has no clients under either generation. "
          "Every per-client phase below will have nothing to do.")
else:
    print(f"   {len(CLIENT_NAMES)} client(s) by master host: {', '.join(CLIENT_NAMES)}")
    for _n in CLIENT_NAMES:
        _tpls = [t["host"] for t in CLIENTS[_n].get("parentTemplates") or [] if t["host"] in MASTER_NAMES]
        _gen = ("both generations" if MASTER_NEW in _tpls and len(_tpls) > 1 else
                "current" if _tpls == [MASTER_NEW] else
                f"legacy ({', '.join(_tpls)})" if _tpls else "by kind tag only (no master template linked)")
        print(f"     {_n}: master host \"{CLIENTS[_n]['host']}\" — {_gen}")

if CLIENTS_WANTED:
    _unknown = [c for c in CLIENTS_WANTED if c not in CLIENTS]
    if _unknown:
        sys.exit(f"--client {', '.join(_unknown)}: no master host carries that client name. "
                 f"Known: {', '.join(CLIENT_NAMES) or '(none)'}")
SCOPED = [c for c in CLIENT_NAMES if not CLIENTS_WANTED or c in CLIENTS_WANTED]

# The number of items still on an old key, printed here and nowhere else first: it is the
# history at stake in the relink phase, and an operator has to see it BEFORE --apply writes
# anything rather than in a paragraph that scrolls past afterwards.
try:
    old_keys_n = int(call("item.get", {"search": {"key_": "evp."}, "countOutput": True})) + \
                 int(call("item.get", {"search": {"key_": "espro."}, "countOutput": True}))
except (RuntimeError, ValueError) as e:
    old_keys_n = None
    print(f"   could not count the items with old keys: {e}")
if old_keys_n:
    print(f"   {old_keys_n} item(s) still carry an evp.* / espro.* key, with all of their history. "
          f"No phase here\n   carries one of those values across to a new key; see \"== objects still "
          f"carrying the old name\".")
elif old_keys_n == 0:
    print("   no item carries an evp.* / espro.* key any more")

# ---------------------------------------------------------------------------------------------
# Which macros a formula or a trigger expression still names. Read here so that the macro phase
# acts on the same answer the preflight printed, and because this is the one thing in the
# migration that can stop collection without anybody noticing: a Zabbix calculated item's
# formula is text, the master template's "requested" items are calculated items whose entire
# formula is one macro, and renaming that macro leaves the formula naming nothing — the item goes
# UNSUPPORTED, every capacity and shortfall figure on every client stops being collected for as
# long as the rest of the migration takes, and a value never collected cannot be backfilled.
# Only ENABLED objects hold the lock, which is why --disable-legacy-items is also what releases
# it. See "MACROS IN FORMULAS" in the module docstring.
# ---------------------------------------------------------------------------------------------
CALCULATED = "15"                              # Zabbix item type 15 — a calculated item
# A user macro reference, context stripped: {$EP.DL} and {$EP.DL:"ctx"} resolve through the same
# name, so the lock is held on the name and covers both spellings.
MACRO_REF = re.compile(r"\{\$([A-Z0-9_.]+)(?::[^}]*)?\}")
FORMULA_LOCK = {}                              # macro name, no braces -> what still names it
FORMULA_SCAN_ERROR = None
LOCKED_SEEN = set()                            # the macros the phase actually left alone


def macro_refs(text):
    return set(MACRO_REF.findall(text or ""))


def macro_base(macro):
    """The name inside a stored macro's braces, or None if it is not macro-shaped."""
    m = MACRO_REF.fullmatch(macro or "")
    return m.group(1) if m else None


def _lock(base, where):
    FORMULA_LOCK.setdefault(base, [])
    if where not in FORMULA_LOCK[base]:
        FORMULA_LOCK[base].append(where)


_host_ids = [h["hostid"] for h in ALL_HOSTS]
if not _host_ids:
    print("   no host at all, so no formula and no trigger names a macro")
else:
    try:
        # Host-level objects only, on purpose. An item on a template collects nothing; what
        # collects is the inherited copy on the host, and disabling an inherited item sets the
        # status of that copy and leaves the template's own enabled. So the host copies are what
        # decides whether anything is still resolving the macro.
        #
        # EVERY field, not just a calculated item's params. A macro resolves anywhere Zabbix
        # expands one, and the first version of this scan asked only for type=CALCULATED and read
        # only `params` — which misses, among others, this repo's own device-count item: its URL
        # holds {$EP.DEVICE.INDEX} and its POST body holds {$EP.DEVICE.TIME.FIELD},
        # {$EP.DEVICE.WINDOW} and {$EP.DEVICE.FIELD} (clients-module/lib/DevicesTemplate.php).
        # Renaming those would have left the item requesting a URL with an unresolved macro in it.
        # So: no type filter, output extend, and every string value scanned, including the
        # preprocessing steps. Reading every value rather than a list of field names means the
        # scan cannot go stale when Zabbix adds a field that expands macros.
        def _scan_values(obj):
            if isinstance(obj, str):
                return macro_refs(obj)
            if isinstance(obj, dict):
                out = set()
                for v in obj.values():
                    out |= _scan_values(v)
                return out
            if isinstance(obj, list):
                out = set()
                for v in obj:
                    out |= _scan_values(v)
                return out
            return set()

        for _it in call("item.get", {"hostids": _host_ids, "output": "extend",
                                     "selectPreprocessing": ["params"]}):
            if _it.get("status") != "0":
                continue
            for _b in _scan_values(_it):
                _lock(_b, f'{label_of.get(_it.get("hostid"), _it.get("hostid"))}: item {_it.get("key_")}')
        # Discovery rules and item prototypes expand macros too, and neither is returned by
        # item.get. A rule whose URL names a macro stops discovering if the macro is renamed,
        # and nothing about that is visible until the discovered hosts or items age out.
        for _meth, _what in (("discoveryrule.get", "discovery rule"), ("itemprototype.get", "item prototype")):
            try:
                for _o in call(_meth, {"hostids": _host_ids, "output": "extend",
                                       "selectPreprocessing": ["params"]}):
                    if _o.get("status") not in (None, "0"):
                        continue
                    for _b in _scan_values(_o):
                        _lock(_b, f'{label_of.get(_o.get("hostid"), _o.get("hostid"))}: {_what} {_o.get("key_")}')
            except RuntimeError as _e:
                # Not fatal on its own, but it is a hole in the scan, so it is named rather than
                # swallowed - the operator decides whether to go on with an incomplete lock.
                print(f"   warning: {_what}s could not be read ({_e}); macros named only there "
                      f"would not be protected")
        for _tr in call("trigger.get", {"hostids": _host_ids, "selectHosts": ["hostid"],
                                        "output": "extend"}):
            if _tr.get("status") != "0":
                continue
            _where = ", ".join(label_of.get(x["hostid"], x["hostid"])
                               for x in _tr.get("hosts") or []) or "a host"
            for _b in _scan_values({k: v for k, v in _tr.items() if k != "hosts"}):
                _lock(_b, f'{_where}: trigger "{_tr.get("description")}"')
    except RuntimeError as e:
        FORMULA_SCAN_ERROR = str(e)
        print(f"   the calculated items and trigger expressions could not be read ({e}) — the macro "
              f"phase will refuse to rename\n   anything, because an empty scan and a scan this user "
              f"is not allowed look exactly alike")
_locked_ours = sorted(m for m in FORMULA_LOCK if new_name("{$" + m + "}"))
if _locked_ours:
    print(f"   {len(_locked_ours)} macro(s) of the old generation are still named by an enabled "
          f"calculated item or trigger:")
    print("   " + ", ".join("{$" + m + "}" for m in _locked_ours[:6])
          + (f", and {len(_locked_ours) - 6} more" if len(_locked_ours) > 6 else ""))
    print("   The macro phase leaves exactly those alone: renaming one makes its item unsupported and")
    print("   stops collection. --templates --disable-legacy-items is what releases them.")

# The module list, read once: the widgets phase is gated on it and the modules report prints it.
try:
    REGISTERED = {m["id"]: m for m in call("module.get", {"output": ["id", "status", "relative_path"]})}
    MODULES_READABLE = True
except RuntimeError as e:
    REGISTERED, MODULES_READABLE = {}, False
    print(f"   could not read the module list: {e}")

# One resolver for every object that exists under a name in each generation, cached, because
# preflight prints the verdict and the phase acts on it and the two must never disagree.
RESOLVED = {}


def resolve(method, field, old, new, extra=None):
    """What is there under the two names: ('none'), ('new'), ('old') or ('twin').

    A twin is real on this install: a release before the compatibility layer saw nothing under
    the current names and built a second object beside the live one. Zabbix makes these names
    unique, so a rename onto an existing name fails outright — the pair is reported and
    refused, here and in the phase, and the script never deletes either half. Which one is
    live is the operator's decision, exactly as AlertRouting::find() leaves it."""
    key = (method, field, old, new)
    if key in RESOLVED:
        return RESOLVED[key]
    params = {"output": "extend", "filter": {field: [old, new]}}
    params.update(extra or {})
    try:
        rows = call(method, params)
    except RuntimeError as e:
        out = {"verdict": "error", "error": str(e), "old": None, "new": None}
        RESOLVED[key] = out
        return out
    o = next((r for r in rows if str(r.get(field, "")) == old), None)
    n = next((r for r in rows if str(r.get(field, "")) == new), None)
    verdict = "twin" if o and n else "old" if o else "new" if n else "none"
    out = {"verdict": verdict, "old": o, "new": n}
    RESOLVED[key] = out
    return out


def rename_plan(what, res, old, new, update, id_key, field):
    """One object's rename: plan it, apply it, or refuse it. Shared by every per-name phase so
    that "already migrated", "twin" and "not here" mean one thing across all of them."""
    global objects, changed, skipped
    if res["verdict"] == "error":
        refuse(f"{what}: Zabbix would not say whether \"{old}\" or \"{new}\" exists "
               f"({res['error']}) — check it on its own page before running this phase")
        return
    if res["verdict"] == "none":
        return
    if res["verdict"] == "new":
        skipped += 1
        print(f"   {what} \"{new}\": already migrated — skipped")
        return
    objects += 1
    if res["verdict"] == "twin":
        refuse(f"{what}: \"{old}\" and \"{new}\" both exist — Zabbix makes this name unique, so "
               f"neither can be renamed. Decide which is the live one, then remove the other by "
               f"hand (trigger action first, then the user, then the user group: Zabbix refuses "
               f"to delete a user group an action still sends to, and a user an action names). "
               f"Nothing was changed")
        return
    if not APPLY or not update:
        print(f"   {what}: \"{old}\"  ->  \"{new}\"")
        return
    try:
        call(update, {id_key: res["old"][id_key], field: new})
    except (RuntimeError, Refused) as e:
        skipped += 1
        print(f"   {what}: \"{old}\" -> \"{new}\"  NOT RENAMED: {e}")
        note(f"{what} \"{old}\": rename it to \"{new}\" by hand — Zabbix refused it ({e})")
        return
    changed += 1
    print(f"   {what}: \"{old}\"  ->  \"{new}\"  renamed")


# ---------------------------------------------------------------------------------------------
# Phase: macros. The rename itself is unchanged; what is new is that it will not rename a macro
# a formula still names. new_name() is defined up with the prefixes it reads, because preflight's
# formula scan needs it before this point.
# ---------------------------------------------------------------------------------------------
def plan(macros, label, id_key, update, delete, write):
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
        # A macro a formula still names is not renamed, whichever owner it sits on. Zabbix
        # resolves a calculated item's formula and a trigger's expression through the host's
        # macros first, then its templates', then the global ones, so renaming any of the three
        # breaks the same formula — leaving template macros alone would not have been enough,
        # because the host macro is the one carrying the client's real figure and the template's
        # is the "0 = not set" default underneath it. Reporting 0 instead of refusing would be a
        # guess rendered as a measurement, which is the one thing this project does not do.
        refs = FORMULA_LOCK.get(macro_base(m["macro"]) or "")
        if refs:
            LOCKED_SEEN.add(m["macro"])
            skipped += 1
            print(f"   {label}: {m['macro']} -> {want}  NOT RENAMED: {len(refs)} enabled object(s) "
                  f"still name it ({refs[0]}"
                  + (f", and {len(refs) - 1} more" if len(refs) > 1 else "")
                  + ") — renaming it would leave their formula naming nothing, which makes them "
                    "unsupported and stops collection")
            continue
        there = here.get(want)
        if there is None:
            if not write:
                print(f"   {label}: {m['macro']} -> {want}")
                continue
            try:
                call(update, {id_key: m[id_key], "macro": want})
            except (RuntimeError, Refused) as e:
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
            if not write:
                print(f"   {label}: {want} already carries this value — would remove the stale {m['macro']}")
                continue
            try:
                call(delete, [m[id_key]])
            except (RuntimeError, Refused) as e:
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


glob = call("usermacro.get", {"globalmacro": True, "output": "extend"})

if selected("macros"):
    print("\n== macros on hosts and templates")
    if FORMULA_SCAN_ERROR:
        # Fail closed. The whole safety of this phase is knowing which macros a formula names,
        # and a read that was refused looks the same as an install where no formula names one.
        refuse(f"the macro phase: the calculated items and trigger expressions could not be read "
               f"({FORMULA_SCAN_ERROR}), so it cannot be shown that a rename will not leave a "
               f"formula naming a macro that no longer exists. Nothing was renamed — an item left "
               f"unsupported stops collecting, and a value never collected cannot be backfilled. "
               f"Run this phase as a user that may read items and triggers")
    else:
        # In the macro API a template is a host, so one usermacro.get covers both; the host and
        # template reads in preflight are only here to put a name on each one in the report.
        before = found
        for hostid in sorted(owned, key=lambda i: label_of.get(i, i)):
            plan(owned[hostid], label_of.get(hostid, f"hostid {hostid}"), "hostmacroid",
                 "usermacro.update", "usermacro.delete", writing("macros"))
        if found == before:
            print("   nothing to rename")

        print("\n== global macros")
        before = found
        plan(glob, "global", "globalmacroid", "usermacro.updateGlobal", "usermacro.deleteGlobal",
             writing("macros"))
        if found == before:
            print("   nothing to rename")

        if LOCKED_SEEN:
            print("\n== macros a formula still names (NOT renamed, on purpose)")
            for macro in sorted(LOCKED_SEEN):
                print(f"   {macro}  <-  " + "; ".join(FORMULA_LOCK[macro_base(macro)][:4])
                      + (" …" if len(FORMULA_LOCK[macro_base(macro)]) > 4 else ""))
            print(f"   {len(LOCKED_SEEN)} macro(s) left on their old names. These are the capacity")
            print("   figures: the master template's \"requested\" items are CALCULATED items whose")
            print("   formula is the macro itself, so renaming it makes the item unsupported and the")
            print("   client's capacity and shortfall figures stop being collected — not wrong, not")
            print("   stale, simply never recorded, for as long as the rest of the migration takes.")
            print("   To finish them: run the relink phase with --disable-legacy-items, which turns")
            print("   those items and triggers off deliberately (status only, nothing deleted), then")
            print("   run --apply --macros again. A disabled object holds no lock. An object in the")
            print("   list above that is NOT one of the master template's is somebody else's and")
            print("   nothing here will disable it — turn it off yourself, or leave the macro.")
            note(f"{len(LOCKED_SEEN)} macro(s) were left on their old names because an enabled "
                 f"calculated item or trigger still names them ({', '.join(sorted(LOCKED_SEEN)[:4])}"
                 f"{' …' if len(LOCKED_SEEN) > 4 else ''}) — relink with --disable-legacy-items "
                 f"first, then run --apply --macros again")

    # A macro that looks like the old name but is not one of the two prefixes the code reads — a
    # site's own {$EVPFOO}, say. Renaming it would be guessing at what it is for, so it is named
    # here and left exactly as it is.
    unknown = sorted({m["macro"] for ms in list(owned.values()) + [glob] for m in ms
                      if not new_name(m["macro"]) and OLD_MACRO_NAME.match(m["macro"])})
    if unknown:
        print("\n== macros that name the old product but are none of ours")
        for macro in unknown:
            print(f"   {macro}  (left alone — not a macro this code reads)")
        human.append(f"{len(unknown)} macro(s) carry the old name but are not ones ElasticPro reads "
                     f"({', '.join(unknown)}) — rename them yourself if they are yours")

# ---------------------------------------------------------------------------------------------
# Phase: vault. Unchanged, flag and all.
# ---------------------------------------------------------------------------------------------
if selected("vault"):
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
        if not writing("vault"):
            print(f"   {label}: {m['macro']} = {m['value']}  ->  {want}  (only with --apply --rewrite-vault-path)")
            continue
        try:
            call("usermacro.update", {"hostmacroid": m["hostmacroid"], "value": want})
        except (RuntimeError, Refused) as e:
            skipped += 1
            print(f"   {label}: {m['macro']} NOT rewritten: {e}")
            continue
        changed += 1
        print(f"   {label}: {m['macro']} = {want}  rewritten")
    if vault_hits and not writing("vault"):
        human.append(f"{len(vault_hits)} Vault macro(s) still point at <mount>/elasticvue/… — copy those "
                     f"secrets to <mount>/elasticpro/… in Vault, read one back, then run this with "
                     f"--apply --rewrite-vault-path; or leave them and keep a Vault policy that grants "
                     f"read on the old path")

# ---------------------------------------------------------------------------------------------
# Phase: modules. Report only, always, and the gate for the widgets phase. No API renames a
# registered module: Zabbix keys it on the id in its manifest.json.
# ---------------------------------------------------------------------------------------------
print("\n== the frontend modules (no script can rename one)")
old_present = [old for old, _ in MODULES if old in REGISTERED]
new_missing = [new for _, new in MODULES if new not in REGISTERED]
new_off = [new for _, new in MODULES if new in REGISTERED and REGISTERED[new].get("status") == "0"]
for old, new in MODULES:
    was = "registered" if old in REGISTERED else "not registered"
    now = ("enabled" if REGISTERED.get(new, {}).get("status") == "1" else
           "registered but disabled" if new in REGISTERED else "not registered")
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
    print("        explicitly, the variable is now EP_DATA_DIR, not EVP_DATA_DIR. Run this script with")
    print("        --datadir for the exact steps, and do it last.")
    human.append("enable the new modules in Administration -> General -> Modules, remove the old module "
                 "folders, and move the Cluster Management data folder (steps above)")

WIDGET_MODULES_READY = MODULES_READABLE and all(
    REGISTERED.get(new, {}).get("status") == "1" for new in WIDGET_TYPES.values())

# ---------------------------------------------------------------------------------------------
# Phase: groups. One host group, one call. A rename and not a move on purpose: the groupid does
# not change, so every action condition, maintenance, dashboard widget groupids.* field and
# user-group right that points at it survives untouched.
# ---------------------------------------------------------------------------------------------
if selected("groups"):
    print("\n== the masters host group")
    print("   Elasticsearch clusters / Log archive have no legacy spelling and are shared with "
          "the rest of the install: they are never touched here.")
    res = resolve("hostgroup.get", "name", GROUP_OLD, GROUP_NEW)
    if res["verdict"] == "none":
        print(f"   neither \"{GROUP_OLD}\" nor \"{GROUP_NEW}\" is here — nothing to do")
    elif res["verdict"] == "twin":
        objects += 1
        in_old = [h["host"] for h in ALL_HOSTS
                  if GROUP_OLD in [g["name"] for g in h.get("hostgroups") or []]]
        in_new = [h["host"] for h in ALL_HOSTS
                  if GROUP_NEW in [g["name"] for g in h.get("hostgroups") or []]]
        print(f"   \"{GROUP_OLD}\" (groupid {res['old']['groupid']}): {len(in_old)} host(s)"
              + (f" — {', '.join(sorted(in_old))}" if in_old else ""))
        print(f"   \"{GROUP_NEW}\" (groupid {res['new']['groupid']}): {len(in_new)} host(s)"
              + (f" — {', '.join(sorted(in_new))}" if in_new else ""))
        refuse(f"host group: \"{GROUP_OLD}\" and \"{GROUP_NEW}\" both exist, and a Zabbix host "
               f"group name is unique, so neither can be renamed. On Data collection -> Hosts, add "
               f"the master hosts above to \"{GROUP_NEW}\" and remove them from \"{GROUP_OLD}\", "
               f"then delete the emptied group yourself. This script never deletes a host group: a "
               f"group that is a host's only group cannot be deleted, so a refusal part-way through "
               f"would leave the set half-moved")
    else:
        rename_plan("host group", res, GROUP_OLD, GROUP_NEW,
                    "hostgroup.update" if writing("groups") else None, "groupid", "name")

# ---------------------------------------------------------------------------------------------
# Phase: tags. One host.update per host, carrying the complete desired tag set.
#
# Zabbix replaces a host's tag set wholesale; there is no per-tag edit. The tempting two-step —
# host.massadd the ep-* tags, then host.massremove the evp-* ones — leaves a window in which an
# interrupted run has a host carrying NEITHER managed-by value. Reconciler::isManaged() then
# says no, and the next save of that client un-manages the host for good, after which remove()
# and a merge both refuse it. So the full set is computed and sent once, per host.
# ---------------------------------------------------------------------------------------------
if selected("tags"):
    print("\n== host tags")
    was_off_hosts = sorted(h["host"] for h in ALL_HOSTS if tag_values(h, WAS_OFF_OLD))
    if was_off_hosts:
        # This used to be four '!!' lines calling the tags phase the one deadline in the
        # migration, on the grounds that Clients -> Enable could not see an evp-was-off. It can:
        # Lifecycle::enable() tests WAS_OFF and LEGACY_WAS_OFF both, and ownTags() strips all
        # four spellings before writing one set back. Nothing is at risk and nothing is on a
        # clock, so this says so plainly — a warning that turns out to be wrong costs the
        # operator's trust in every other warning in a migration they are already nervous about.
        print(f"   {len(was_off_hosts)} host(s) carry {WAS_OFF_OLD}: {', '.join(was_off_hosts)}")
        print(f"   Nothing is at risk while they do, and this phase is not on a deadline:")
        print(f"   Lifecycle::enable() tests '{WAS_OFF_NEW}' and '{WAS_OFF_OLD}' both, and ownTags()")
        print(f"   strips all four spellings before it writes one set back, so Clients -> Enable turns")
        print(f"   back on only the hosts Disable turned off. This phase renames the marker to")
        print(f"   '{WAS_OFF_NEW}'; until it has run, both spellings are understood.")

    def clients_of(host):
        """Every client this host belongs to, under either generation.

        Reconciler writes ep-client on every host the Clients page keeps (lib/Reconciler.php:22),
        and a host from before the rename carries evp-client instead; the master host is also its
        client's by identity, whatever it is tagged. This exists only so that --client can scope
        this phase: it had no scoping at all, so an operator proving the phase on one client of
        seven rewrote the tags of all forty-two hosts in the install."""
        out = set(tag_values(host, TAG_NEW + "client") + tag_values(host, TAG_OLD + "client"))
        out |= {n for n in CLIENT_NAMES if CLIENTS[n]["hostid"] == host["hostid"]}
        return out

    touched = out_of_scope = unattributable = 0
    for h in sorted(ALL_HOSTS, key=lambda x: x["host"]):
        have = [{"tag": t["tag"], "value": t["value"]} for t in h.get("tags") or []]
        legacy_named = [t for t in have if t["tag"].startswith(TAG_OLD)]
        managed = [t["value"] for t in have if t["tag"] == MANAGED_TAG]
        if not legacy_named and MANAGED_OLD not in managed:
            continue                           # nothing of the old generation on this host
        if CLIENTS_WANTED:
            mine = clients_of(h)
            if not mine:
                # No client tag under either spelling, so --client cannot say whose host it is.
                # Swept in silently is how one client's run retags another client's host.
                unattributable += 1
                continue
            if not mine & set(CLIENTS_WANTED):
                out_of_scope += 1
                continue
        touched += 1
        objects += 1
        if len(set(managed)) > 1:
            refuse(f"host \"{h['host']}\": two different {MANAGED_TAG} values ({', '.join(sorted(set(managed)))}) "
                   f"— a merge that went wrong. Its tags were not touched. Decide which marker is right on "
                   f"Data collection -> Hosts, leave exactly one, then run this phase again")
            continue
        if not managed or managed[0] not in (MANAGED_OLD, MANAGED_NEW):
            # Reconciler::tags(): "A host made by hand still gets none". An evp-prefixed tag on a
            # host this module does not manage may be the site's own, and renaming it would be a guess.
            print(f"   host \"{h['host']}\": not ours ({MANAGED_TAG} is "
                  f"{managed[0] if managed else 'absent'}) — its "
                  f"{', '.join(sorted({t['tag'] for t in legacy_named}))} tag(s) left exactly as they are")
            skipped += 1
            note(f"host \"{h['host']}\" carries {', '.join(sorted({t['tag'] for t in legacy_named}))} "
                 f"but no {MANAGED_TAG}: {MANAGED_NEW} — it is not this module's host, so nothing was "
                 f"changed. Rename those tags yourself if they are yours")
            continue

        # Both spellings of the same tag name must agree before they can be merged: a value kept
        # under one and changed under the other is two answers to one question, which is the
        # macro phase's CONFLICT case and gets the same stance.
        conflict = None
        by_name = {}
        for t in have:
            by_name.setdefault(t["tag"], set()).add(t["value"])
        for name, values in sorted(by_name.items()):
            if not name.startswith(TAG_OLD):
                continue
            new_tag = TAG_NEW + name[len(TAG_OLD):]
            if new_tag in by_name and by_name[new_tag] != values:
                conflict = (name, sorted(values), new_tag, sorted(by_name[new_tag]))
                break
        if conflict:
            refuse(f"host \"{h['host']}\": {conflict[0]}={{{', '.join(conflict[1])}}} and "
                   f"{conflict[2]}={{{', '.join(conflict[3])}}} hold different values. Its tags were "
                   f"not touched. Decide which is current on Data collection -> Hosts, delete the "
                   f"other, then run this phase again")
            continue

        want, seen = [], set()
        for t in have:
            if t["tag"] == MANAGED_TAG:
                tag, value = MANAGED_TAG, MANAGED_NEW
            elif t["tag"].startswith(TAG_OLD):
                tag, value = TAG_NEW + t["tag"][len(TAG_OLD):], t["value"]
            else:
                tag, value = t["tag"], t["value"]   # inv:* and everything else: kept, whoever set it
            if (tag, value) in seen:
                continue                            # the ep-* spelling was already there, same value
            seen.add((tag, value))
            want.append({"tag": tag, "value": value})
        # The rename shortens nothing, so this cannot fire — asserted rather than truncated,
        # because a truncated tag value is a wrong value that looks like a right one.
        too_long = [t for t in want if len(t["tag"]) > 255 or len(t["value"]) > 255]
        if too_long:
            refuse(f"host \"{h['host']}\": tag {too_long[0]['tag']} would be over Zabbix's 255-character "
                   f"limit after renaming. Nothing was truncated and nothing was changed — shorten it by hand")
            continue

        def norm(tags):
            return sorted(t["tag"] + "\0" + t["value"] for t in tags)   # Reconciler::retag()'s comparison

        if norm(have) == norm(want):
            skipped += 1
            print(f"   host \"{h['host']}\": already migrated — skipped")
            continue
        moves = [f"{t['tag']}={t['value']}" for t in have
                 if t["tag"].startswith(TAG_OLD) or (t["tag"] == MANAGED_TAG and t["value"] == MANAGED_OLD)]
        if not writing("tags"):
            print(f"   host \"{h['host']}\": {len(moves)} tag(s) -> {', '.join(sorted(moves))}")
            print(f"      becomes: {', '.join(sorted(t['tag'] + '=' + t['value'] for t in want if t['tag'].startswith(TAG_NEW) or t['tag'] == MANAGED_TAG))}")
            continue
        try:
            call("host.update", {"hostid": h["hostid"], "tags": want})
        except (RuntimeError, Refused) as e:
            skipped += 1
            print(f"   host \"{h['host']}\": tags NOT changed: {e}")
            note(f"host \"{h['host']}\": Zabbix refused the tag update ({e}) — retag it by hand on "
                 f"Data collection -> Hosts, in one save")
            continue
        changed += 1
        print(f"   host \"{h['host']}\": {len(moves)} tag(s) renamed in one update")
    if CLIENTS_WANTED and (out_of_scope or unattributable):
        print(f"   --client: {out_of_scope} host(s) belonging to other clients and {unattributable} "
              f"host(s) with no\n   {TAG_NEW}client / {TAG_OLD}client tag were left exactly as they are")
        if unattributable:
            note(f"{unattributable} host(s) carry tags of the old generation but no {TAG_NEW}client / "
                 f"{TAG_OLD}client tag, so --client cannot attribute them to a client — run the tags "
                 f"phase without --client, or tag them, to migrate those")
    if not touched:
        print("   no host" + (" in scope" if CLIENTS_WANTED else "")
              + " carries a tag of the old generation — nothing to do")

# ---------------------------------------------------------------------------------------------
# Phase: alerts. Five named objects per client. Renames only: the ids do not move, so the
# action's operation goes on sending to the same usrgrpid and the report goes on pointing at
# the same dashboardid. Deletion is never done here, and the order it would need is printed
# with every twin report, because Zabbix refuses to delete a user group an action still sends
# to and a user an action names.
# ---------------------------------------------------------------------------------------------
if selected("alerts"):
    print("\n== alert objects, per client")
    if not SCOPED:
        print("   no client to work on")
    for c in SCOPED:
        print(f"   -- {c}")
        rename_plan("user group", resolve("usergroup.get", "name", PREFIX_OLD + c, PREFIX_NEW + c),
                    PREFIX_OLD + c, PREFIX_NEW + c,
                    "usergroup.update" if writing("alerts") else None, "usrgrpid", "name")
        rename_plan("DL account", resolve("user.get", "username", client_user(c, True), client_user(c)),
                    client_user(c, True), client_user(c),
                    "user.update" if writing("alerts") else None, "userid", "username")
        rename_plan("trigger action", resolve("action.get", "name", PREFIX_OLD + c, PREFIX_NEW + c),
                    PREFIX_OLD + c, PREFIX_NEW + c,
                    "action.update" if writing("alerts") else None, "actionid", "name")
        rename_plan("weekly report",
                    resolve("report.get", "name", PREFIX_OLD + c + " weekly", PREFIX_NEW + c + " weekly"),
                    PREFIX_OLD + c + " weekly", PREFIX_NEW + c + " weekly",
                    "report.update" if writing("alerts") else None, "reportid", "name")
        rename_plan("report dashboard", resolve("dashboard.get", "name", PREFIX_OLD + c, PREFIX_NEW + c),
                    PREFIX_OLD + c, PREFIX_NEW + c,
                    "dashboard.update" if writing("alerts") else None, "dashboardid", "name")
    print("   The dashboard's NAME is all this phase changes; its widgets are the next phase.")
    print("   Partly redundant with the module, on purpose: AlertRouting::sync() renames all five on")
    print("   the next save of a client whose macros ask for alerts or the report — and for a client")
    print("   with {$EP.ALERT.DL} = 0 a save DELETES the legacy objects instead. Doing it here covers")
    print("   every client without seven saves, including the ones nobody intends to save.")

    # Objects under the legacy prefix whose remainder is not one of this install's clients. The
    # module's own lookups are always scoped to a client name and never to the bare prefix, so
    # neither is this: a "ElasticVue: something else" is somebody else's.
    strays = []
    for what, method, field in [("user group", "usergroup.get", "name"),
                                ("trigger action", "action.get", "name"),
                                ("weekly report", "report.get", "name"),
                                ("dashboard", "dashboard.get", "name"),
                                ("user", "user.get", "username")]:
        try:
            rows = call(method, {"output": [field]})
        except RuntimeError as e:
            print(f"   could not read the {what}s: {e}")
            continue
        pre = USER_OLD if field == "username" else PREFIX_OLD
        for r in rows:
            name = str(r.get(field) or "")
            if not name.startswith(pre):
                continue
            rest = name[len(pre):]
            if field == "username":
                mine = any(rest == sanitise(c) for c in CLIENT_NAMES)
            else:
                mine = any(rest == c or rest == c + " weekly" for c in CLIENT_NAMES)
            if not mine:
                strays.append(f"{what} \"{name}\"")
    if strays:
        print(f"   not ours — left exactly as they are: {', '.join(sorted(strays))}")
        note(f"{len(strays)} object(s) carry the old prefix but name no client of this install "
             f"({', '.join(sorted(strays))}) — rename or remove them yourself if they are yours")

# ---------------------------------------------------------------------------------------------
# Phase: widgets. The three widget types whose modules no longer exist, so the widget renders
# blank and the Monday PDF arrives empty. AlertRouting::syncReport() never re-sends `pages` —
# by design, since an operator may have arranged the dashboard — so no save fixes these.
#
# dashboard.update REPLACES `pages`. A page not passed is deleted; a widget passed without its
# widgetid is deleted and recreated with a new id. So every page and every widget read back is
# re-sent verbatim with nothing but `type` substituted, and a key this script does not know how
# to re-send means the whole dashboard is refused rather than sent incomplete.
# ---------------------------------------------------------------------------------------------
PAGE_KEYS = {"dashboard_pageid", "name", "display_period", "sortorder", "widgets"}
# "reference" is a Zabbix 7.0 widget property (widgets that feed each other name one), so it is
# round-tripped like every other field rather than treated as unknown — without it every single
# dashboard on a 7.0 install is refused and the phase does nothing at all.
WIDGET_KEYS = {"widgetid", "type", "name", "x", "y", "width", "height", "view_mode", "fields",
               "reference"}
FIELD_KEYS = {"type", "name", "value"}

if selected("widgets"):
    print("\n== dashboard widgets of the renamed modules")
    for old, new in sorted(WIDGET_TYPES.items()):
        print(f"   {old} -> {new}")
    if not WIDGET_MODULES_READY:
        missing = [n for n in WIDGET_TYPES.values() if REGISTERED.get(n, {}).get("status") != "1"]
        refuse(f"dashboard widgets: {', '.join(missing)} "
               f"{'is' if len(missing) == 1 else 'are'} not both registered AND enabled"
               + ("" if MODULES_READABLE else " (the module list could not be read at all)")
               + f". The whole phase is refused: Zabbix rejects a widget type no module "
                 f"registers, and it ACCEPTS one whose module is registered but disabled — which "
                 f"renders a blank widget that looks exactly like the fault being fixed. Do the "
                 f"four module steps above first, then run this phase")
    else:
        try:
            boards = call("dashboard.get", {"output": ["dashboardid", "name", "display_period", "auto_start"],
                                            "selectPages": ["dashboard_pageid", "name", "display_period",
                                                            "sortorder", "widgets"]})
        except RuntimeError as e:
            boards = []
            refuse(f"dashboard widgets: the dashboards could not be read ({e}) — nothing was changed")
        hit_any = False
        for d in sorted(boards, key=lambda b: b["name"]):
            pages = d.get("pages") or []
            types = [w.get("type") for p in pages for w in (p.get("widgets") or [])]
            legacy_here = sorted({t for t in types if t in WIDGET_TYPES})
            if not legacy_here:
                continue
            # Scoped to no client on purpose: AlertRouting::ownWidgetTypes()' own reasoning is
            # that one of these widgets is ours wherever it lives, and an operator's own
            # dashboard holding a Client capacity widget is just as blank as the report's.
            if CLIENTS_WANTED and d["name"] not in [PREFIX_OLD + c for c in CLIENTS_WANTED] \
                    + [PREFIX_NEW + c for c in CLIENTS_WANTED]:
                continue
            hit_any = True
            objects += 1
            if not pages:
                refuse(f"dashboard \"{d['name']}\": Zabbix reported widgets of the old generation but "
                       f"gave back no pages. Nothing was sent — an empty pages array would DELETE every "
                       f"widget on it. Open it and look at it by hand")
                continue
            unknown = set()
            for p in pages:
                unknown |= set(p) - PAGE_KEYS
                for w in p.get("widgets") or []:
                    unknown |= {"widget." + k for k in set(w) - WIDGET_KEYS}
                    for f in w.get("fields") or []:
                        unknown |= {"field." + k for k in set(f) - FIELD_KEYS}
            if unknown:
                refuse(f"dashboard \"{d['name']}\": it carries {', '.join(sorted(unknown))}, which this "
                       f"script does not know how to send back. Nothing was changed: dashboard.update "
                       f"replaces pages wholesale, so a partial page DELETES the widgets left out. "
                       f"Change the widget type by hand (edit each widget, pick the new one), or update "
                       f"this script for this Zabbix version")
                continue
            if not writing("widgets"):
                for p in pages:
                    for w in p.get("widgets") or []:
                        if w.get("type") in WIDGET_TYPES:
                            print(f"   dashboard \"{d['name']}\" page \"{p.get('name') or '(first)'}\": "
                                  f"widget {w.get('widgetid')} {w['type']} -> {WIDGET_TYPES[w['type']]}")
                continue
            new_pages = []
            for p in pages:
                page = {k: p[k] for k in PAGE_KEYS if k in p and k != "widgets"}
                page["widgets"] = []
                for w in p.get("widgets") or []:
                    widget = {k: w[k] for k in WIDGET_KEYS if k in w}
                    widget["type"] = WIDGET_TYPES.get(w.get("type"), w.get("type"))
                    page["widgets"].append(widget)
                new_pages.append(page)
            try:
                call("dashboard.update", {"dashboardid": d["dashboardid"], "pages": new_pages})
            except (RuntimeError, Refused) as e:
                skipped += 1
                print(f"   dashboard \"{d['name']}\": NOT changed: {e}")
                note(f"dashboard \"{d['name']}\": Zabbix refused the widget rewrite ({e}) — change each "
                     f"widget's type by hand, or turn the client's weekly report off, save, on, save, "
                     f"which rebuilds the dashboard (and loses its arrangement)")
                continue
            changed += 1
            print(f"   dashboard \"{d['name']}\": {', '.join(legacy_here)} rewritten, "
                  f"everything else re-sent unchanged")
        if not hit_any:
            print("   no dashboard holds a widget of the old generation — nothing to do")

# ---------------------------------------------------------------------------------------------
# Phase: maintenance. This used to say that Lifecycle::NAME_PREFIX had no legacy counterpart, so
# the Clients list could not see an "ElasticVue: <client>" window and startMaintenance() created a
# second, overlapping one beside it. Lifecycle::maintenanceNames() returns both spellings now and
# startMaintenance() updates whichever it finds, today's first, so neither is true any more.
# What is left for this phase is the tidy-up: a live window still named for the old product reads
# as the old product on Data collection -> Maintenance, and a twin pair left behind from before
# the compatibility layer really is two overlapping windows on one client, refused below.
# ---------------------------------------------------------------------------------------------
if selected("maintenance"):
    print("\n== live Zabbix maintenances")
    now_ts = int(time.time())

    # selectTags / selectTimeperiods "extend" hand back maintenancetagid and timeperiodid, which
    # are read-only: maintenance.update rejected the whole payload for carrying them, the except
    # below caught the rejection, printed one line and moved on, and the phase reported success
    # while renaming nothing at all — a reliable no-op that looked like a pass. So only the
    # configurable columns are asked for, and they are picked out again by name below in case a
    # Zabbix version ignores a field list on a sub-select.
    TAG_FIELDS = ["tag", "operator", "value"]
    PERIOD_FIELDS = ["timeperiod_type", "every", "month", "dayofweek", "day", "start_time",
                     "period", "start_date"]

    def period_fields(p):
        """One time period as maintenance.update takes it.

        Zabbix validates a period against its type and rejects a column that type does not use,
        so this is per type rather than "everything except timeperiodid". None means a type this
        script does not know, and then the whole maintenance is refused rather than sent with a
        period guessed at: maintenance.update replaces the period list wholesale, so a wrong
        period changes when the window suppresses the client's alerts."""
        t = str(p.get("timeperiod_type", ""))
        if t == "0":                                   # one time only
            keys = ["timeperiod_type", "period", "start_date"]
        elif t == "2":                                 # daily
            keys = ["timeperiod_type", "period", "start_time", "every"]
        elif t == "3":                                 # weekly
            keys = ["timeperiod_type", "period", "start_time", "every", "dayofweek"]
        elif t == "4":                                 # monthly: a day of the month, or every <dayofweek>
            keys = ["timeperiod_type", "period", "start_time", "month"]
            keys += ["day"] if str(p.get("day") or "0") != "0" else ["every", "dayofweek"]
        else:
            return None
        return {k: p[k] for k in keys if k in p}

    def maintenance_rows(names):
        """One maintenance.get, read back whole. The host-group selection changed name between
        Zabbix versions (selectGroups became selectHostGroups), so both are tried: a hard
        failure here would stop the phase on a Zabbix that is perfectly fine."""
        base = {"output": ["maintenanceid", "name", "active_since", "active_till",
                           "maintenance_type", "description", "tags_evaltype"],
                "selectHosts": ["hostid"], "selectTags": TAG_FIELDS,
                "selectTimeperiods": PERIOD_FIELDS, "filter": {"name": names}}
        for sel in ("selectHostGroups", "selectGroups"):
            try:
                return call("maintenance.get", dict(base, **{sel: ["groupid"]})), None
            except RuntimeError as e:
                last = str(e)
        return [], last

    any_m = False
    for c in SCOPED:
        rows, err = maintenance_rows([PREFIX_OLD + c, PREFIX_NEW + c])
        if err and not rows:
            refuse(f"maintenance for \"{c}\": could not be read ({err}) — nothing was changed")
            continue
        old_row = next((r for r in rows if r["name"] == PREFIX_OLD + c), None)
        new_row = next((r for r in rows if r["name"] == PREFIX_NEW + c), None)
        if not old_row and not new_row:
            continue
        any_m = True
        if old_row and new_row:
            objects += 1
            refuse(f"maintenance: \"{PREFIX_OLD + c}\" and \"{PREFIX_NEW + c}\" both exist, and a "
                   f"maintenance name is unique in Zabbix, so neither can be renamed. Two overlapping "
                   f"windows on one client is what the missing legacy prefix caused; decide which is "
                   f"the real one on Data collection -> Maintenance and end the other by hand")
            continue
        if new_row:
            skipped += 1
            print(f"   maintenance \"{PREFIX_NEW + c}\": already migrated — skipped")
            continue
        objects += 1
        till = int(old_row.get("active_till") or 0)
        since = int(old_row.get("active_since") or 0)
        if till and till < now_ts:
            skipped += 1
            print(f"   maintenance \"{old_row['name']}\": over (ended already) — left as it is. "
                  f"Lifecycle::maintenances() skips a finished window, so renaming it changes nothing "
                  f"anyone reads")
            continue
        if since <= now_ts <= till:
            print(f"   maintenance \"{old_row['name']}\": a window is OPEN on this client right now. "
                  f"The maintenanceid does not change, so the suppression is not interrupted by the rename.")
        if not writing("maintenance"):
            print(f"   maintenance: \"{old_row['name']}\"  ->  \"{PREFIX_NEW + c}\"")
            continue
        groups = old_row.get("hostgroups") if "hostgroups" in old_row else old_row.get("groups") or []
        periods, bad_type = [], None
        for p in old_row.get("timeperiods") or []:
            keep = period_fields(p)
            if keep is None:
                bad_type = p.get("timeperiod_type")
                break
            periods.append(keep)
        if bad_type is not None:
            refuse(f"maintenance \"{old_row['name']}\": it has a time period of type {bad_type}, which "
                   f"this script does not know which columns to send back for, and "
                   f"maintenance.update replaces the period list wholesale. Nothing was changed — "
                   f"rename it by hand on Data collection -> Maintenance, leaving its groups, hosts "
                   f"and periods alone")
            continue
        if not periods:
            refuse(f"maintenance \"{old_row['name']}\": Zabbix gave back no time period at all, and "
                   f"maintenance.update needs at least one. An invented period would change when the "
                   f"window suppresses this client, so nothing was changed — rename it by hand")
            continue
        fields = {"maintenanceid": old_row["maintenanceid"], "name": PREFIX_NEW + c,
                  "active_since": old_row["active_since"], "active_till": old_row["active_till"],
                  "maintenance_type": old_row["maintenance_type"],
                  "description": old_row.get("description") or "",
                  "groups": [{"groupid": g["groupid"]} for g in groups],
                  "hosts": [{"hostid": h["hostid"]} for h in old_row.get("hosts") or []],
                  "tags": [{k: t[k] for k in TAG_FIELDS if k in t} for t in old_row.get("tags") or []],
                  "timeperiods": periods}
        try:
            call("maintenance.update", fields)
        except (RuntimeError, Refused) as e:
            skipped += 1
            print(f"   maintenance \"{old_row['name']}\": NOT renamed: {e}")
            note(f"maintenance \"{old_row['name']}\": Zabbix refused the rename ({e}) — rename it to "
                 f"\"{PREFIX_NEW + c}\" by hand on Data collection -> Maintenance, leaving its groups, "
                 f"hosts and periods alone")
            continue
        changed += 1
        print(f"   maintenance: \"{old_row['name']}\"  ->  \"{PREFIX_NEW + c}\"  renamed "
              f"(groups, hosts, tags and periods re-sent unchanged)")
    if not any_m:
        print("   no maintenance of either generation — nothing to do")

# ---------------------------------------------------------------------------------------------
# Phase: relink. The master template, and the one phase that costs something.
#
# Two designs disagreed about how to do this. One said host.update with a templates array, as
# one atomic swap. The other said never that call shape, because `templates` REPLACES the link
# list: one parentTemplate missed from the array silently unlinks the jump or log-archive
# template and strands its items at host level, where nothing in the module can find them
# again — status() and legacyCollision() look for templates, never for orphaned host items.
# The second wins, because the first risks losing something and the second risks only duplicate
# work that the operator can see. So this phase is additive:
#
#   host.massadd links "ElasticPro client master" and unlinks nothing. The item keys of the two
#   generations are disjoint (the rename changed every one of them), so the link cannot collide
#   on an item and cannot take one over.
#
# What that leaves is the real operational harm: trigger NAMES are identical across the two
# generations while their expressions differ, so every shortfall trigger fires twice, to the
# client's DL. --disable-legacy-items sets to Disabled the items and triggers the host inherits
# from the legacy template this phase relinked, and only those: matched by parent id, not by key
# prefix. Status is the one field editable on an inherited object; it deletes nothing and
# re-enabling undoes it. It is also what releases the macro phase's formula lock. Taking the legacy template off the host is left to a person, with "Unlink" and
# never "Unlink and clear".
# ---------------------------------------------------------------------------------------------
if selected("relink"):
    print("\n== the master template")
    legacy_current = {MASTER_NEW, "ElasticPro cluster devices", "ElasticPro Elasticsearch via SSH jump host",
                      "ElasticPro log archive ES via SSH jump host", _common.cluster_template()}
    print(f"   {MASTER_OLD} / {MASTER_OLDEST}  ->  {MASTER_NEW}")
    print(f"   This is a relink, not a rename: MasterTemplate::uuid() hashes the product name, so the")
    print(f"   two templates are different objects with different uuids and, crucially, different item")
    print(f"   keys (evp.es.storage.used vs ep.es.storage.used). The ep.* items begin EMPTY.")

    if not TEMPLATES_READABLE:
        refuse(f"the master template: the template list cannot be read "
               f"({TEMPLATES_ERROR or 'it came back empty'}). An empty read is ambiguous — no templates, "
               f"or a Zabbix Admin who may read hosts but not templates — and this phase will not report "
               f"'nothing to do' about an install it cannot see. Run it as a Super admin")
    else:
        # A legacy-named template whose uuid is not the one this module would have written is the
        # site's own template that merely shares the name. Reported, never touched: the docblock's
        # "if the report says a legacy-named template was not written here, leave it alone".
        for seed, old_name, new_name_tpl in LEGACY_TEMPLATES:
            if old_name in legacy_current or old_name == new_name_tpl:
                print(f"   \"{old_name}\" is also a name in use now (it is a setting, not a constant) — "
                      f"not a leftover, left alone")
                continue
            row = tpl_by_name.get(old_name)
            if not row:
                continue
            want_uuid = legacy_uuid(seed)
            if row.get("uuid") != want_uuid:
                print(f"   template \"{old_name}\": uuid {row.get('uuid')} is not the {want_uuid} this "
                      f"module would have written — it is the site's own template sharing the name. "
                      f"Left alone, and no host of it is relinked here")
                note(f"template \"{old_name}\" was not written by this module (its uuid does not match) "
                     f"— leave it alone; it is somebody else's")
                tpl_by_name.pop(old_name, None)
                continue
            print(f"   template \"{old_name}\": uuid matches this module's legacy seed — ours")

        old_master = tpl_by_name.get(MASTER_OLD)
        oldest_master = tpl_by_name.get(MASTER_OLDEST)
        new_master = tpl_by_name.get(MASTER_NEW)

        if oldest_master:
            print(f"   template \"{MASTER_OLDEST}\": report only. Nothing in this repository records its "
                  f"item key prefix, so whether its keys collide with ep.* cannot be checked, and an "
                  f"unchecked link could take over an item and splice two series. No host of it is relinked")
            note(f"template \"{MASTER_OLDEST}\" is on this install: its item keys are unknown to this "
                 f"repository, so relink its hosts by hand after checking the keys of both templates")

        if not new_master:
            refuse(f"the master template: \"{MASTER_NEW}\" is not in this Zabbix, so there is nothing to "
                   f"link. On the Clients page press 'Write master template' first — importing the current "
                   f"template is harmless on its own; it is the SAVE afterwards that leaves a host "
                   f"carrying two sets of items")
        elif old_master:
            # The link cannot be honest unless the two key sets really are disjoint: a shared key
            # would either be refused by Zabbix or taken over by the new template, and "the history
            # restarts" would stop being the truth being consented to.
            try:
                old_keys = {i["key_"] for i in call("item.get", {"templateids": [old_master["templateid"]],
                                                                 "output": ["key_"]})}
                new_keys = {i["key_"] for i in call("item.get", {"templateids": [new_master["templateid"]],
                                                                 "output": ["key_"]})}
                both = sorted(old_keys & new_keys)
            except RuntimeError as e:
                old_keys = new_keys = set(); both = None
                refuse(f"the master template: the two templates' items could not be read ({e}), so it "
                       f"cannot be shown that their keys are disjoint. Nothing was linked")
            if both:
                refuse(f"the master template: {len(both)} item key(s) are on BOTH templates "
                       f"({', '.join(both[:5])}{'…' if len(both) > 5 else ''}). Linking would either be "
                       f"refused by Zabbix or TAKE OVER those items, which splices two series on the "
                       f"assumption that they measure the same thing — nothing here verifies that. "
                       f"Nothing was linked; decide per item, by hand, after a database dump")
            elif both is not None:
                print(f"   checked: {len(old_keys)} legacy key(s) and {len(new_keys)} current key(s), "
                      f"{len(old_keys & new_keys)} in common. Disjoint, so the link cannot take over an item.")
                print(f"   What is lost: the ep.* series starts at the instant of linking, so graphs, the")
                print(f"   template dashboard, the Client capacity report and the shortfall triggers see")
                print(f"   nothing before it. The evp.* values survive only under their own keys, on the")
                print(f"   master host's Latest data and the legacy template's graphs, until the server's")
                print(f"   housekeeping retention expires them. Export them first if they matter.")
                print(f"   The legacy 'requested' figures are still collecting, and that is deliberate:")
                print(f"   their formulas name {{$EVP.<ROLE>.…}} and the macro phase refuses to rename a")
                print(f"   macro a formula still names, so nothing of theirs has gone unsupported. This")
                print(f"   phase with --disable-legacy-items is what stops them — knowingly, in a window")
                print(f"   you chose — and only after that will --apply --macros rename those macros.")
                print(f"   Relinking alone does not light up log delay either: ep.delay.* reads")
                print(f"   elasticpro.delay[...] and the cluster hosts still push espro.delay[...].")

                # A host that reaches the legacy template through another template rather than
                # directly. legacyCollision()'s comment records that this is real on this install,
                # and host.massadd can only add a direct link, so such a host is refused.
                reach = {h["hostid"] for h in call("host.get", {"output": ["hostid"],
                                                                "templateids": [old_master["templateid"]]})}
                direct = {h["hostid"] for h in ALL_HOSTS
                          if old_master["templateid"] in {t["templateid"] for t in h.get("parentTemplates") or []}}
                master_ids = {h["hostid"] for h in MASTERS}
                for hid in sorted(reach - direct):
                    objects += 1
                    refuse(f"host \"{host_by_id.get(hid, {}).get('host', hid)}\" reaches \"{MASTER_OLD}\" "
                           f"through another template, not directly. Nothing was linked for it. By hand: "
                           f"Data collection -> Hosts -> the host -> Templates -> Unlink on the nesting "
                           f"template (never 'Unlink and clear'), then save the client")
                for hid in sorted(direct - master_ids):
                    refuse(f"host \"{host_by_id.get(hid, {}).get('host', hid)}\" carries \"{MASTER_OLD}\" "
                           f"but was not identified as a master host. Nothing was linked for it — the "
                           f"substitution here is the master one, and that host may be a cluster or log "
                           f"archive host carrying a different legacy template")

                # --disable-legacy-items used to select by key prefix: every item on the master
                # host whose key_ began "evp.", and every trigger all of whose items did. That
                # swept in an item an operator had written themselves with that prefix, and every
                # item of any legacy template this phase never relinked, and set them to Disabled
                # — and nobody re-enables an item they did not know had been turned off, so the
                # gap in its history is as unrecoverable as a delete. The set is now exactly the
                # objects INHERITED from the legacy template this phase relinks, established from
                # each object's own parent id, and where that cannot be established nothing is
                # disabled at all.
                LEGACY_ITEM_IDS = LEGACY_TRIGGER_IDS = None
                if DISABLE_LEGACY_ITEMS:
                    try:
                        LEGACY_ITEM_IDS = {i["itemid"] for i in call(
                            "item.get", {"templateids": [old_master["templateid"]],
                                         "output": ["itemid"]})}
                        LEGACY_TRIGGER_IDS = {t["triggerid"] for t in call(
                            "trigger.get", {"templateids": [old_master["templateid"]],
                                            "output": ["triggerid"]})}
                    except RuntimeError as e:
                        LEGACY_ITEM_IDS = LEGACY_TRIGGER_IDS = None
                        refuse(f"--disable-legacy-items: the items and triggers of \"{MASTER_OLD}\" "
                               f"could not be read ({e}), so which objects on a host are inherited "
                               f"from it cannot be established. Nothing was disabled — selecting by "
                               f"key prefix instead would also turn off anything an operator wrote "
                               f"with that prefix, and an item nobody knows is off never comes back on")
                    else:
                        if not LEGACY_ITEM_IDS:
                            LEGACY_ITEM_IDS = LEGACY_TRIGGER_IDS = None
                            refuse(f"--disable-legacy-items: \"{MASTER_OLD}\" reports no item at all, "
                                   f"which is either a template with nothing on it or a read this "
                                   f"user is not allowed, and the two look the same. Nothing was "
                                   f"disabled")
                        else:
                            print(f"   --disable-legacy-items is scoped to the {len(LEGACY_ITEM_IDS)} "
                                  f"item(s) and {len(LEGACY_TRIGGER_IDS)} trigger(s) of")
                            print(f"   \"{MASTER_OLD}\" and to nothing else — not to a key prefix. "
                                  f"An item of the site's own, or")
                            print(f"   of a template this phase did not relink, is named and left "
                                  f"enabled.")
                if not (writing("relink") and ACCEPT_HISTORY_RESTART):
                    print("   to apply: --apply --templates --accept-history-restart   "
                          "(two hand-made decisions, because the series restarts)")
                for name in sorted(SCOPED):
                    h = CLIENTS[name]
                    if h["hostid"] not in direct:
                        continue
                    linked = {t["host"] for t in h.get("parentTemplates") or []}
                    if MASTER_NEW in linked:
                        skipped += 1
                        print(f"   host \"{h['host']}\" ({name}): already carries \"{MASTER_NEW}\" — "
                              f"not linked again")
                    else:
                        objects += 1
                        if not (writing("relink") and ACCEPT_HISTORY_RESTART):
                            print(f"   host \"{h['host']}\" ({name}): would link \"{MASTER_NEW}\" "
                                  f"(host.massadd; nothing unlinked)")
                        else:
                            try:
                                call("host.massadd", {"hosts": [{"hostid": h["hostid"]}],
                                                      "templates": [{"templateid": new_master["templateid"]}]})
                            except (RuntimeError, Refused) as e:
                                skipped += 1
                                print(f"   host \"{h['host']}\": NOT linked: {e}")
                                note(f"host \"{h['host']}\": Zabbix refused the template link ({e}) — "
                                     f"link \"{MASTER_NEW}\" by hand on Data collection -> Hosts")
                                continue
                            changed += 1
                            print(f"   host \"{h['host']}\" ({name}): \"{MASTER_NEW}\" linked; "
                                  f"\"{MASTER_OLD}\" left exactly as it was")

                    if DISABLE_LEGACY_ITEMS:
                        if LEGACY_ITEM_IDS is None:
                            continue           # refused once, above, with the reason
                        try:
                            rows = call("item.get", {"hostids": [h["hostid"]],
                                                     "output": ["itemid", "key_", "status", "templateid"]})
                            trows = call("trigger.get", {"hostids": [h["hostid"]],
                                                         "output": ["triggerid", "description", "status",
                                                                    "templateid"]})
                        except RuntimeError as e:
                            print(f"   host \"{h['host']}\": could not list its items and triggers "
                                  f"({e}) — nothing was disabled on it")
                            continue
                        # An inherited object's templateid is the id of its parent on the template
                        # it came from. A host-level object's is "0", which is in neither set. This
                        # phase refuses a host that reaches the legacy template through another
                        # template (above), so on the hosts that get here the parent is the legacy
                        # template's own object and nothing else.
                        items = [i for i in rows
                                 if i.get("templateid") in LEGACY_ITEM_IDS and i["status"] == "0"]
                        trigs = [t for t in trows
                                 if t.get("templateid") in LEGACY_TRIGGER_IDS and t["status"] == "0"]
                        strays = sorted(i["key_"] for i in rows
                                        if i.get("templateid") not in LEGACY_ITEM_IDS
                                        and i["key_"].startswith(("evp.", "espro."))
                                        and i["status"] == "0")
                        if strays:
                            shown = ", ".join(strays[:5]) + (" …" if len(strays) > 5 else "")
                            print(f"   host \"{h['host']}\": {len(strays)} enabled item(s) carry an old "
                                  f"key but are NOT inherited from\n      \"{MASTER_OLD}\" — left "
                                  f"collecting: {shown}")
                            note(f"host \"{h['host']}\": {len(strays)} enabled item(s) with an evp.* / "
                                 f"espro.* key ({shown}) are not inherited from \"{MASTER_OLD}\" — "
                                 f"they are the site's own or belong to a template this phase did not "
                                 f"relink, so they were left collecting. Turn them off yourself if "
                                 f"they are duplicates")
                        if not items and not trigs:
                            print(f"   host \"{h['host']}\": no enabled legacy item or trigger left to disable")
                        elif not (writing("relink") and ACCEPT_HISTORY_RESTART):
                            print(f"   host \"{h['host']}\": would disable {len(items)} legacy item(s) and "
                                  f"{len(trigs)} legacy trigger(s) — status only, nothing deleted, "
                                  f"re-enabling undoes it")
                        else:
                            done_i = done_t = 0
                            for i in items:
                                try:
                                    call("item.update", {"itemid": i["itemid"], "status": 1}); done_i += 1
                                except (RuntimeError, Refused) as e:
                                    print(f"   host \"{h['host']}\": {i['key_']} not disabled: {e}")
                            for t in trigs:
                                try:
                                    call("trigger.update", {"triggerid": t["triggerid"], "status": 1}); done_t += 1
                                except (RuntimeError, Refused) as e:
                                    print(f"   host \"{h['host']}\": trigger \"{t['description']}\" not disabled: {e}")
                            changed += done_i + done_t
                            print(f"   host \"{h['host']}\": {done_i} legacy item(s) and {done_t} legacy "
                                  f"trigger(s) set to Disabled — no data deleted, re-enable to undo")
                    elif MASTER_NEW in linked or (writing("relink") and ACCEPT_HISTORY_RESTART):
                        print(f"   host \"{h['host']}\": both generations are now on it, so each shortfall "
                              f"trigger exists twice with the same NAME and a different expression — every "
                              f"one of them mails this client's DL twice. Add --disable-legacy-items to turn "
                              f"the legacy items and triggers off (status only, nothing deleted)")

                print(f"\n   Taking \"{MASTER_OLD}\" off a host is left to a person, in a maintenance window:")
                for name in sorted(SCOPED):
                    h = CLIENTS[name]
                    if h["hostid"] in direct:
                        print(f"     {h['host']}: Data collection -> Hosts -> \"{h['host']}\" -> Templates ->")
                        print(f"       next to \"{MASTER_OLD}\" press Unlink. NEVER 'Unlink and clear':")
                        print(f"       that deletes the inherited items and every value of their history.")
                note(f"unlink \"{MASTER_OLD}\" from each master host by hand, with Unlink and never "
                     f"'Unlink and clear' — this script refuses that call shape entirely")
        else:
            if new_master:
                print(f"   \"{MASTER_OLD}\" is not in this Zabbix — nothing to relink")

        for seed, old_name, _n in LEGACY_TEMPLATES:
            row = tpl_by_name.get(old_name)
            if not row or old_name in legacy_current:
                continue
            on = [h["host"] for h in ALL_HOSTS
                  if row["templateid"] in {t["templateid"] for t in h.get("parentTemplates") or []}]
            if not on:
                print(f"   template \"{old_name}\": no host is linked to it any more. This script never "
                      f"deletes a template — its triggers, graphs and discovery rules still hang off it. "
                      f"Delete it by hand once nobody needs what is on it")
                note(f"template \"{old_name}\" has no host left: delete it by hand when nobody needs its "
                     f"triggers, graphs and discovery rules")

# ---------------------------------------------------------------------------------------------
# Read-only reports that were here before the phases and are not tied to one. These are the
# parts of the rename a script cannot do safely, so they say what was found and what a person
# does about it, rather than guessing.
# ---------------------------------------------------------------------------------------------
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
            # A widget TYPE is the widgets phase's to rewrite; a field VALUE naming an old
            # action is not, because re-keying someone's URL or navigation field is a guess.
            human.append(f"dashboard \"{d['name']}\" holds widgets of a renamed module (run --dashboards) "
                         f"or a field naming an old action (change that one by hand)")
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
if old_keys_n:
    print("   The generated templates (client master, cluster devices, the jump-host ones) are keyed on")
    print("   uuids derived from the product name, so Cluster Management -> Write master template makes a")
    print("   NEW template rather than updating the old one, and Cluster Management finds a client by the")
    print("   new template's name. --templates links the new one and unlinks nothing; nothing in this")
    print("   script ever deletes an item or clears a template off a host.")
    human.append(f"{old_keys_n} item(s) keep an old key: export what you need of their history before the "
                 f"server's retention expires it — no phase here carries a value across")

# ---------------------------------------------------------------------------------------------
# Phase: datadir. Last, and never a write, with or without --apply. The script talks to
# {$ZBX_URL}/api_jsonrpc.php and may be run from another machine entirely; the folder is on the
# frontend host or inside the zabbix-web container's volume, and no Zabbix API method moves a
# file. So it prints instructions and nothing else.
# ---------------------------------------------------------------------------------------------
if selected("datadir"):
    print("""
== the Cluster Management data folder (no script can do this — it is a filesystem move)

   /var/lib/elasticvue-zabbix  ->  /var/lib/elasticpro-zabbix

   Nothing is broken while you wait: Store::dir() uses the old folder as long as the new one
   holds no .json file. Do this LAST, after every phase above has been applied and you have
   saved one client on the Clients page and seen it come back correct.

   1. Stop the frontend, so no save lands in the folder mid-move:
        package install:  sudo systemctl stop php-fpm nginx     (or apache2)
        Docker stack:     cd <compose folder> && docker compose stop zabbix-web
   2. Move it in one step, on the same filesystem. Never cp: a partial copy leaves ONE .json
      in the new folder, Store::holds_data() then prefers the new folder over the real one,
      read() returns default roles, and Roles::hash() no longer matches the live master
      template — every client reads as 'outdated' and a save would rewrite the roles.
        sudo mv /var/lib/elasticvue-zabbix /var/lib/elasticpro-zabbix
      If the two are on different filesystems, use: sudo cp -a <old> <new>.part &&
      sudo mv <new>.part /var/lib/elasticpro-zabbix   (the rename is the atomic step)
   3. Ownership and mode, exactly as install-modules.sh sets them: owner is the user PHP runs
      as, mode 0770.
        package install:  sudo chown -R <php user>:<php group> /var/lib/elasticpro-zabbix
                          sudo chmod 0770 /var/lib/elasticpro-zabbix
                          (<php user> is php-fpm's, else nginx / www-data / apache)
        Docker stack:     the folder is the ep-data volume behind EP_DATA_DIR; chown it to the
                          runtime uid the images are pinned to (999), not to root:
                          docker compose run --rm --user 0 zabbix-web \\
                            chown -R 999:999 "$EP_DATA_DIR" && chmod 0770 "$EP_DATA_DIR"
   4. If PHP names the folder explicitly, the variable is EP_DATA_DIR, not EVP_DATA_DIR
      (php-fpm pool: env[EP_DATA_DIR] = /var/lib/elasticpro-zabbix).
   5. Start the frontend again and open ElasticPro -> Clients. Seven clients, their roles and
      their backups must all be there. If the list is empty, the folder did not move or the
      owner is wrong — put the old folder back and nothing is lost; the data is still in it.
   6. Leave /var/lib/elasticvue-zabbix absent, not empty-but-present. An empty old folder is
      harmless (holds_data() is false), but an empty NEW folder beside a full old one is the
      state that confuses the resolver, so never create the new folder by hand first.""")
    note("move the Cluster Management data folder by hand, last of all (steps above)")
else:
    print("\n== the Cluster Management data folder")
    print(f"   {DATA_DIR_OLD} -> {DATA_DIR_NEW}: a filesystem move no API can make. Run this script "
          f"with --datadir for the exact steps, and do it last of all.")

print("\n== summary")
print(f"   recognised old macros found: {found}")
print(f"   other objects of the old generation found: {objects}")
print(f"   changed: {changed}" + ("" if APPLY else "   (dry run — nothing was written)"))
print(f"   skipped: {skipped}")
print(f"   refused: {refused}" + ("   (each one is in the list below, with what to do instead)" if refused else ""))
if not human:
    print("   nothing left for a person")
else:
    print(f"   left for a person: {len(human)}")
    for line in human:
        print(f"     - {line}")
if (found or objects) and not APPLY:
    print("\n   run it again with --apply to make the changes of the phases you name. With no phase "
          "flag, --apply\n   does the macro phase only; the Vault-path phase needs "
          "--rewrite-vault-path, and that flag on its\n   own now means the Vault phase and nothing "
          "else.")
