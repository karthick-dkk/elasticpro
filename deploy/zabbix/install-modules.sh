#!/usr/bin/env bash
# Put ElasticPro's Zabbix modules in place, in one step.
#
#   sudo deploy/zabbix/install-modules.sh                      # Zabbix installed from packages
#   deploy/zabbix/install-modules.sh --docker                  # the stack in deploy/zabbix/stack
#   ZABBIX_URL=https://zabbix.example.com ZABBIX_TOKEN=… sudo deploy/zabbix/install-modules.sh
#                                                              # …and register + enable them
#
# What it does, in order:
#   1. copies the five modules (elasticpro, ep_clients, ep_capacity, ep_resources,
#      ep_volume) into Zabbix's modules folder, without tests and tools — the ones already
#      there are first copied to a dated backup folder, outside the modules folder;
#   2. makes the writable data folder the Cluster Management page needs, owned by the user
#      the Zabbix frontend's PHP runs as (not with --docker: the stack's volume is that folder);
#      with --docker, also fixes module/elasticpro/config.php to be owned 1997:1995 (the
#      zabbix image's uid/gid) when run as root, or says which `sudo chown`/`chmod` to run;
#   3. with ZABBIX_URL and ZABBIX_TOKEN (a Super admin API token; or ZABBIX_USER and
#      ZABBIX_PASSWORD): registers and enables the
#      modules and creates the host groups and report dashboards (integration/zabbix/master/import.py).
#
# It touches no Zabbix configuration file. Options:
#   --modules-dir DIR   Zabbix's modules folder       (default /usr/share/zabbix/modules;
#                                                      --docker: deploy/zabbix/module)
#   --data-dir DIR      the page's data folder        (default /var/lib/elasticpro-zabbix;
#                                                      set EP_DATA_DIR for PHP if you change it)
#   --web-user USER     who PHP runs as               (default: found from php-fpm, else nginx,
#                                                      www-data or apache)
#   --backup-dir DIR    where the old modules go      (default /var/backups/elasticpro-zabbix)
#   --docker            the Docker stack: modules into deploy/zabbix/module, no data folder
#   --insecure          ZABBIX_URL has a self-signed certificate
#   --dry-run           say what would happen, change nothing
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MODULES_DIR=/usr/share/zabbix/modules
DATA_DIR=/var/lib/elasticpro-zabbix
BACKUP_DIR=/var/backups/elasticpro-zabbix
WEB_USER=
DOCKER=0
DRY=0
INSECURE=()

while [ $# -gt 0 ]; do
  case "$1" in
    --modules-dir) MODULES_DIR=$2; shift 2 ;;
    --data-dir) DATA_DIR=$2; shift 2 ;;
    --web-user) WEB_USER=$2; shift 2 ;;
    --backup-dir) BACKUP_DIR=$2; shift 2 ;;
    --docker) DOCKER=1; MODULES_DIR=$ROOT/deploy/zabbix/module; BACKUP_DIR=$ROOT/deploy/zabbix/.module-backups; shift ;;
    --insecure) INSECURE=(--insecure); shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  would: $*"; else "$@"; fi; }
fail() { say "✗ $*" >&2; exit 1; }

# --docker: the zabbix/zabbix-web-nginx-pgsql image runs as uid 1997 / gid 1995, and it bind-
# mounts elasticpro/config.php straight from the repo (elasticpro itself is never copied
# below). A config.php that user cannot read makes the module fail with a 500 instead of the
# app. Only root can chown to an arbitrary uid, so say what to run instead when this isn't root.
fix_owner() {
  local path=$1
  if [ "$(stat -c '%u:%g %a' "$path" 2>/dev/null)" = "1997:1995 640" ]; then
    say "  ✓ $path: already owned by 1997:1995, mode 0640 (the Zabbix container user)"
  elif [ "$DRY" = 1 ]; then
    say "  would: chown 1997:1995 $path && chmod 0640 $path"
  elif [ "$(id -u)" = 0 ]; then
    chown 1997:1995 "$path" && chmod 0640 "$path"
    say "  ✓ $path: owned by 1997:1995, mode 0640 (the Zabbix container user)"
  else
    say "  ! $path: not owned by the Zabbix container user (1997:1995) — run: sudo chown 1997:1995 $path && sudo chmod 0640 $path"
  fi
}

# Module folder in Zabbix <- where it is in this repo.
MODULES=(
  "elasticpro:deploy/zabbix/module/elasticpro"
  "ep_clients:integration/zabbix/clients-module"
  "ep_capacity:integration/zabbix/capacity-widget"
  "ep_resources:integration/zabbix/resources-widget"
  "ep_volume:integration/zabbix/volume-widget"
)

# --- checks, before anything changes -----------------------------------------------------
for m in "${MODULES[@]}"; do
  src=$ROOT/${m#*:}
  [ -f "$src/manifest.json" ] || fail "$src/manifest.json is missing — run this from a full checkout of the repo"
done
# The widgets carry copies of shared code; a copy that differs means sync-assets.mjs was not run.
if command -v node >/dev/null; then
  (cd "$ROOT/integration/zabbix" && node --input-type=module -e "
    import fs from 'node:fs';
    const { SHARED_PHP, PHP_MODULES, phpFor } = await import('./sync-assets.mjs');
    const bad = [];
    for (const [dir, ns] of Object.entries(PHP_MODULES)) for (const f of SHARED_PHP) {
      if (fs.readFileSync(dir + '/lib/' + f, 'utf8') !== phpFor(fs.readFileSync('shared/php/' + f, 'utf8'), ns)) bad.push(dir + '/lib/' + f);
    }
    if (bad.length) { console.error('out of date: ' + bad.join(', ') + ' — run: node integration/zabbix/sync-assets.mjs'); process.exit(1); }
  ") || fail "shared code is out of date in a module"
fi
[ "$DOCKER" = 1 ] || [ -d "$MODULES_DIR" ] || fail "$MODULES_DIR does not exist — is the Zabbix frontend installed here? (--modules-dir, or --docker)"
[ "$DRY" = 1 ] || [ -w "$(dirname "$MODULES_DIR")" ] || [ -w "$MODULES_DIR" ] || fail "cannot write to $MODULES_DIR — run with sudo"

# --- 1. modules -------------------------------------------------------------------------
STAMP=$(date +%Y%m%d-%H%M%S)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
say "== modules → $MODULES_DIR"
run mkdir -p "$MODULES_DIR"
for m in "${MODULES[@]}"; do
  id=${m%%:*}; src=$ROOT/${m#*:}; dst=$MODULES_DIR/$id
  # --docker: elasticpro is mounted straight from where it lives in the repo.
  if [ -d "$dst" ] && [ "$(cd "$src" && pwd -P)" = "$(cd "$dst" && pwd -P)" ]; then
    say "  ✓ $id (already in place)"; continue
  fi
  if [ -d "$dst" ]; then
    run mkdir -p "$BACKUP_DIR/$STAMP"
    run cp -a "$dst" "$BACKUP_DIR/$STAMP/$id"
  fi
  # Staged outside the modules folder, then copied INTO the module's folder. The folder itself
  # is never replaced: Docker bind-mounts each module folder, and one swapped or re-created
  # under a running container vanishes from it ("Page not found" until the web container restarts).
  stage=$STAGE/$id
  if [ "$DRY" = 1 ]; then
    say "  would: copy $src → $dst (without test/, *.py, *.mjs, README.md, macOS ._* files), keeping the folder itself"
  else
    mkdir -p "$stage"
    # Everything but tests, tool scripts and notes; tar so no rsync is needed.
    (cd "$src" && tar -cf - --exclude=./test --exclude='*.py' --exclude='*.mjs' --exclude=./README.md --exclude='._*' --exclude=.DS_Store .) | (cd "$stage" && tar -xf -)
    chmod -R u=rwX,go=rX "$stage"
    mkdir -p "$dst"
    find "$dst" -mindepth 1 -delete
    cp -a "$stage/." "$dst/"
  fi
  say "  ✓ $id"
done
[ -d "$BACKUP_DIR/$STAMP" ] && say "  previous modules kept in $BACKUP_DIR/$STAMP"

# --- 2. data folder ---------------------------------------------------------------------
if [ "$DOCKER" = 1 ]; then
  say "== data folder: the stack's ep-data volume (EP_DATA_DIR in docker-compose.yml)"
  CONFIG_PHP="$ROOT/deploy/zabbix/module/elasticpro/config.php"
  if [ -f "$CONFIG_PHP" ]; then
    say "== module/elasticpro/config.php ownership"
    fix_owner "$CONFIG_PHP"
  else
    say "! $CONFIG_PHP is missing — copy config.php.example, fill it in, then run this again (or fix its ownership: sudo chown 1997:1995 $CONFIG_PHP && sudo chmod 0640 $CONFIG_PHP)"
  fi
else
  if [ -z "$WEB_USER" ]; then
    WEB_USER=$(ps -eo user=,comm= 2>/dev/null | awk '$2 ~ /php-fpm/ && $1 != "root" {print $1; exit}')
    for u in nginx www-data apache; do [ -n "$WEB_USER" ] && break; id "$u" >/dev/null 2>&1 && WEB_USER=$u; done
  fi
  [ -n "$WEB_USER" ] || fail "cannot tell which user PHP runs as — give --web-user"
  say "== data folder → $DATA_DIR (owner $WEB_USER)"
  run mkdir -p "$DATA_DIR"
  run chown "$WEB_USER" "$DATA_DIR"
  run chmod 0770 "$DATA_DIR"
  [ "$DATA_DIR" = /var/lib/elasticpro-zabbix ] || say "  ! not the default folder: set EP_DATA_DIR=$DATA_DIR in PHP's environment (php-fpm pool: env[EP_DATA_DIR] = $DATA_DIR)"
  say "  ✓ writable by $WEB_USER"
fi

# --- 3. register and enable -------------------------------------------------------------
if [ -n "${ZABBIX_URL:-}" ] && { [ -n "${ZABBIX_TOKEN:-}" ] || [ -n "${ZABBIX_USER:-}" ]; }; then
  say "== registering in Zabbix at $ZABBIX_URL"
  if [ "$DRY" = 1 ]; then
    say "  would: python3 integration/zabbix/master/import.py ${INSECURE[*]:-}"
  else
    (cd "$ROOT/integration/zabbix/master" && python3 import.py "${INSECURE[@]}")
  fi
else
  say "== not registered (no ZABBIX_URL with ZABBIX_TOKEN, or ZABBIX_USER + ZABBIX_PASSWORD). Run again with them, or in Zabbix:"
  say "   Administration → General → Modules → Scan directory, then enable the five ElasticPro modules."
fi

say ""
say "Next:"
[ "$DOCKER" = 1 ] && say "  - cd deploy/zabbix/stack && docker compose up -d web   (picks up new mounts and PHP)"
[ "$DOCKER" = 1 ] || say "  - reload PHP so its opcode cache drops the old code: systemctl reload php-fpm (or php8.x-fpm)"
say "  - in Zabbix: ElasticPro → Cluster Management → Write master template (when the page asks)"
say "  - log archive template, if it changed: elasticpro-zabbix/ulm/import.py"
[ "$DRY" = 1 ] && say "(dry run: nothing was changed)"
exit 0
