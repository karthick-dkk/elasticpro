#!/usr/bin/env bash
# Throwaway credentials so `trial.sh` runs on a fresh clone — and in CI, where none of
# the real ones exist because every one of them is gitignored.
#
# Everything here is deliberately worthless: a self-signed certificate, one user whose
# password is printed in this file, a random database password. Nothing is overwritten —
# if a file is already there it is left exactly as it is, so running this on a machine
# that holds real credentials cannot destroy them.
set -euo pipefail
cd "$(dirname "$0")"

TRIAL_USER=${TRIAL_USER:-alice}
TRIAL_PASS=${TRIAL_PASS:-test-password-1}
made=0

[ -f .env ] || { cp .env.example .env; echo "  made .env"; made=1; }

if [ ! -s tls/fullchain.pem ] || [ ! -s tls/privkey.pem ]; then
  ./trial-cert.sh tls
  echo "  made tls/ (self-signed, 825 days, valid for this host's names and addresses — NOT for a real deployment)"; made=1
fi

if [ ! -s nginx/htpasswd ]; then
  mkdir -p nginx
  # The same bcrypt hash make-htpasswd.sh writes, from the same image — htpasswd is not
  # installed everywhere, and Python's crypt module was removed in 3.13. Docker is already
  # a requirement for the trial, so depending on it here adds nothing.
  docker run --rm httpd:2.4-alpine htpasswd -Bbn "$TRIAL_USER" "$TRIAL_PASS" > nginx/htpasswd
  # Not the login. nginx.conf has no auth_basic — signing in is the app's own job, and it
  # creates `Admin` / `elastic` on first run. This file only matters if you turn edge
  # authentication back on, and saying otherwise would send someone hunting for a
  # password prompt that is not there.
  echo "  made nginx/htpasswd (unused unless you re-enable auth_basic — not the app login)"; made=1
fi

# The config the compose file points ELASTICPRO_CONFIG at. It has to exist before the
# first start: without it every fresh hosted deploy opens on "cannot read
# /app/config/config_cluster.json", which looks like a broken install and is not one.
#
# An empty starter, not a missing file. Adding clusters from the Config page is the
# normal way to fill it in — the mount is writable and CONFIG_WRITE is admin-only — but
# the file still has to be there for the core to read at boot. Editing it on the host
# works too; the installer leaves it group-writable for exactly that.
if [ ! -s config/config_cluster.json ]; then
  mkdir -p config
  cat > config/config_cluster.json <<'JSON'
{
  "version": 2,
  "defaults": {
    "readOnly": true,
    "autoRefresh": false,
    "refreshIntervalSec": 30,
    "logIndexPattern": "logstash-*",
    "tls": "auto"
  },
  "jump_hosts": {},
  "clusters": []
}
JSON
  echo "  made config/config_cluster.json (no clusters yet — add them here, then restart the core)"; made=1
fi

# The settings file the compose file mounts into the core (./config.txt:/app/config.txt).
# Docker answers a bind mount whose source is missing by creating a DIRECTORY there, so it
# has to exist before the first `docker compose up` — which is this script's reason to run.
# Every key in the copy is empty (not managed), apart from the port the stack is already
# using, so a stack set up without it behaves exactly as before.
if [ -d config.txt ]; then rmdir config.txt 2>/dev/null || { echo "  ✗ deploy/config.txt is a directory with files in it — move it away"; exit 1; }; fi
if [ ! -f config.txt ]; then
  cp config.txt.example config.txt
  port=$(sed -n 's/^LISTEN=//p' .env | tail -1)
  if [ -n "$port" ]; then sed -i.tmp "s|^LISTEN_PORT=.*|LISTEN_PORT=$port|" config.txt && rm -f config.txt.tmp; fi
  echo "  made config.txt (from config.txt.example — the one settings file; deploy.sh --apply-config puts it in force)"; made=1
fi

if [ ! -s secrets/db_password ]; then
  mkdir -p secrets
  openssl rand -base64 32 > secrets/db_password
  echo "  made secrets/db_password"; made=1
fi

[ $made -eq 1 ] || echo "  nothing to do — every file the trial needs is already here"
