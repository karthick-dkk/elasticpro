#!/usr/bin/env bash
# The Zabbix stack's first run: the files docker-compose.yml expects, then `up -d`.
#
#   cd deploy/zabbix/stack && ./setup.sh            # safe to run again: nothing is overwritten
#   ./setup.sh --no-up                              # make the files, start nothing
#
# Makes, only when missing:
#   secrets/db_password      the Postgres password
#   tls/ssl.crt, ssl.key     a self-signed certificate for the frontend on :${ZBX_HTTPS_PORT:-9443}
#   tls/dhparam.pem            (replace the pair with a real one; the names are the image's)
#   the ep_sso and vault_net networks (external in the compose files)
#
# The zabbix/* images run as uid 1997 / gid 1995: run this with sudo (or as root) so
# db_password, ssl.key and module/elasticpro/config.php end up owned 1997:1995, mode 0640 —
# otherwise the containers that read them crash-loop or answer 500, and the script tells you
# exactly which `chown`/`chmod` to run by hand instead.
#
# Needs, and says so rather than guessing:
#   secrets/zabbix-vault.env — from ../../vault/setup.sh, which
#   gives the Zabbix server its read-only Vault token. Run that first.
#
# On a host that also runs the hosted ElasticPro stack (deploy/docker-compose.yml): that
# one owns 443; this one publishes 9443 (frontend) and 10051 (trapper) and nothing else, and
# the agent binds the host's 10050. See ../README.md, "One host, both stacks", for memory.
set -euo pipefail
cd "$(dirname "$0")"

UP=1
[ "${1:-}" = "--no-up" ] && UP=0

say() { printf '%s\n' "$*"; }
fail() { say "✗ $*" >&2; exit 1; }

# The zabbix/* images run as uid 1997 / gid 1995. A secret or key that user cannot read makes
# the container that needs it crash-loop (db, server) or answer 500 (web) — silently, since
# nothing in the container log says "permission" until you go looking. Only root can chown to
# an arbitrary uid, so when this script is not run with sudo, say exactly what to run instead.
fix_owner() {
  local path=$1
  if [ "$(stat -c '%u:%g %a' "$path" 2>/dev/null)" = "1997:1995 640" ]; then
    say "✓ $path: already owned by 1997:1995, mode 0640 (the Zabbix container user)"
  elif [ "$(id -u)" = 0 ]; then
    chown 1997:1995 "$path" && chmod 0640 "$path"
    say "✓ $path: owned by 1997:1995, mode 0640 (the Zabbix container user)"
  else
    say "! $path: not owned by the Zabbix container user (1997:1995) — run: sudo chown 1997:1995 $path && sudo chmod 0640 $path"
  fi
}

command -v docker >/dev/null || fail "docker is not installed"
command -v openssl >/dev/null || fail "openssl is needed for the password and the certificate"

umask 027
mkdir -p secrets tls

if [ ! -s secrets/db_password ]; then
  openssl rand -base64 32 | tr -d '\n' > secrets/db_password
  say "✓ secrets/db_password made"
else
  say "✓ secrets/db_password kept"
fi
fix_owner secrets/db_password

if [ ! -s tls/ssl.crt ] || [ ! -s tls/ssl.key ]; then
  CN=${ZBX_TLS_CN:-$(hostname -f 2>/dev/null || hostname)}
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$CN" \
    -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" \
    -keyout tls/ssl.key -out tls/ssl.crt 2>/dev/null
  chmod 644 tls/ssl.crt
  say "✓ tls/ssl.crt + ssl.key: self-signed for $CN (replace with a real pair when you have one)"
else
  say "✓ tls/ssl.crt + ssl.key kept"
fi
# The key, not the certificate: ssl.crt is public, but the image's nginx (uid 1997) must be
# able to read ssl.key or the web container answers 500 for every request.
fix_owner tls/ssl.key
if [ ! -s tls/dhparam.pem ]; then
  openssl dhparam -out tls/dhparam.pem 2048 2>/dev/null
  chmod 644 tls/dhparam.pem
  say "✓ tls/dhparam.pem made"
fi

# ep_sso: shared with the ElasticPro core alone (../compose.sso.yml). vault_net: the Vault
# stack and its readers (deploy/vault/docker-compose.yml declares it external too).
for net in ep_sso vault_net; do
  if ! docker network inspect "$net" >/dev/null 2>&1; then
    docker network create "$net" >/dev/null
    say "✓ network $net created"
  else
    say "✓ network $net exists"
  fi
done

missing=0
[ -s secrets/zabbix-vault.env ] || { say "✗ secrets/zabbix-vault.env is missing — run deploy/vault/setup.sh first (it writes this file)"; missing=1; }
[ "$missing" = 0 ] || fail "not starting: the Zabbix server reads Vault macros and needs its token"

# Modules the web container bind-mounts. A missing source folder would be created by Docker as
# an empty root-owned directory, and the module would silently not be there.
for m in ep_capacity ep_volume ep_resources ep_clients; do
  [ -f "../module/$m/manifest.json" ] || say "! ../module/$m is not in place yet — run: deploy/zabbix/install-modules.sh --docker"
done
if [ -f ../module/elasticpro/config.php ]; then
  fix_owner ../module/elasticpro/config.php
else
  say "! ../module/elasticpro/config.php is missing — copy config.php.example and fill it in (the frame shows a 'not configured' notice until then)"
fi

if [ "$UP" = 1 ]; then
  docker compose up -d
  say "✓ up — https://<this host>:${ZBX_HTTPS_PORT:-9443}/ (Admin / zabbix: change it now)"
else
  say "(--no-up: nothing started)"
fi
