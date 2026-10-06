"""Shared by the setup scripts in this folder. Stdlib only, like the scripts that import it.

Every script here used to have one particular test VM's address baked in —
as the ES host macro, as a Linux host's agent interface, even just in a comment. That broke
the moment anyone ran them against a different VM. Nothing in this file defaults to an
address: callers must say which VM they mean, with --host or $EP_HOST.
"""
import os
import sys


def flag_value(name):
    """--name value from argv, or None if the flag was not given. Exits with a clear error
    if the flag is present but has nothing after it."""
    argv = sys.argv[1:]
    if name not in argv:
        return None
    i = argv.index(name)
    if i + 1 >= len(argv):
        sys.exit(f"{name} needs a value")
    return argv[i + 1]


def require_host():
    """The VM these scripts are configuring. --host wins over $EP_HOST; neither given is a
    hard error naming both ways to supply it, rather than silently falling back to someone
    else's test VM."""
    host = flag_value("--host") or os.environ.get("EP_HOST", "").strip()
    if not host:
        sys.exit(
            "no host given — pass --host <address> or set EP_HOST=<address>, e.g.\n"
            "  EP_HOST=203.0.113.10 python3 setup/zbx_templates.py\n"
            "  python3 setup/zbx_templates.py --host 203.0.113.10\n"
            "(this used to be a hardcoded IP from an earlier VM; every VM must say its own now)"
        )
    return host


# Which templates. The three base template names used to be literals in the scripts, so a
# Zabbix whose templates are named differently (an older import, or a site that renamed them)
# could only be driven by editing the code. Each is now a flag or an environment variable, with
# the name this repo's own export uses as the default. ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE is
# deliberately the same variable the core reads (compose.hosts.yml), so one value covers both.
def cluster_template():
    """The template that marks a Zabbix host as an Elasticsearch cluster."""
    return (flag_value("--cluster-template") or os.environ.get("ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE", "").strip()
            or "Elasticsearch Cluster by HTTP EP")


def es_template():
    """The per-node Elasticsearch template that ships alongside the cluster one."""
    return (flag_value("--es-template") or os.environ.get("ELASTICPRO_ZABBIX_ES_TEMPLATE", "").strip()
            or "Elasticsearch by EP")


def linux_template():
    """The Linux agent template linked to ES node hosts."""
    return (flag_value("--linux-template") or os.environ.get("ELASTICPRO_ZABBIX_LINUX_TEMPLATE", "").strip()
            or "Linux by Zabbix agent -EP")


def find_templates_yaml(name="zbx_export_templates_ES_Linux.yaml"):
    """zbx_export_templates_ES_Linux.yaml is not ours to move — it lives at the repo root —
    but every script here runs with deploy/zabbix as its working directory. Look there first
    (in case a copy is ever placed alongside the scripts), then the repo root, and say which
    one was used so a stale copy in the wrong place is obvious rather than silent."""
    here = name                                  # deploy/zabbix/<name>, if run from there
    root = os.path.join("..", "..", name)        # repo root, two levels up from deploy/zabbix
    for path, where in [(here, "deploy/zabbix"), (root, "repo root")]:
        if os.path.exists(path):
            print(f"templates file: {path} ({where})")
            return path
    sys.exit(f"{name} not found in deploy/zabbix/ or the repo root — run this from deploy/zabbix/")


# Which Zabbix. These scripts were written for the Docker stack in ../stack (web on 9443 of
# this machine, Admin's password in stack/secrets/zabbix-accounts.txt), and had both baked in —
# so on a host that also runs a second Zabbix (a package install, say) there was no way to
# point them at it. --zabbix-url / $ZBX_URL and --accounts / $ZBX_ACCOUNTS choose; the
# defaults are what they always were.
def zabbix_url():
    """The Zabbix frontend's base URL, without a trailing slash (…/api_jsonrpc.php is added)."""
    return (flag_value("--zabbix-url") or os.environ.get("ZBX_URL", "").strip()
            or "https://127.0.0.1:9443").rstrip("/")


def api_url():
    return zabbix_url() + "/api_jsonrpc.php"


def accounts_file():
    """The 0600 'name: password' file holding Admin's password (and the test users')."""
    return (flag_value("--accounts") or os.environ.get("ZBX_ACCOUNTS", "").strip()
            or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stack", "secrets", "zabbix-accounts.txt"))


def read_accounts():
    return dict(l.rstrip("\n").split(": ", 1) for l in open(accounts_file()) if ": " in l and not l.startswith("#"))


def secrets_dir():
    """Where the ElasticPro side's token files go (default: deploy/secrets, the hosted stack's)."""
    return (flag_value("--secrets-dir") or os.environ.get("EP_SECRETS_DIR", "").strip()
            or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "secrets"))


def ep_url():
    """The ElasticPro this Zabbix is paired with, as the checks reach it (default: the
    hosted stack's nginx on this machine)."""
    return (flag_value("--ep-url") or os.environ.get("EP_URL", "").strip() or "https://127.0.0.1").rstrip("/")
