#!/usr/bin/env bash
# Deploy (or update) hosted ElasticPro in one step, with automatic rollback.
#
#   deploy/deploy.sh                          # build this checkout and run it
#   deploy/deploy.sh --pull                   # git pull first
#   deploy/deploy.sh --image repo/core:0.1.0  # run an image built elsewhere (no build here)
#   deploy/deploy.sh --upgrade                # the latest release's published images
#   deploy/deploy.sh --upgrade=0.3.16         # one release's published images (v0.3.16 works too)
#   deploy/deploy.sh --rollback               # back to the images that ran before the last deploy
#   deploy/deploy.sh --apply-config           # put deploy/config.txt in force, restart the core
#
# deploy/config.txt is the one settings file (config.txt.example lists every key and the
# rules: KEY=VALUE, empty = not managed, a value = managed and wins). --apply-config checks
# it, reports every problem and changes nothing if there is one; otherwise it renders
# LISTEN_PORT and CORE_MEM_LIMIT into .env and ALLOWED_UI_IPS, ALLOWED_DOMAINS and
# RATE_EXEMPT_IPS into nginx/allow-ui, allow-host and rate-exempt (config-txt.conf in each;
# the operator's own files there are left alone). nginx is checked and reloaded (recreated
# when the port changes), then the core is recreated, because it reads config.txt at start.
# Nobody is signed out. A normal deploy and --upgrade do the same render at the start, and
# restart the core anyway; config.txt is created from the example first when it is missing.
#
# --upgrade moves all four released images together, core, nginx, PostgreSQL and Redis, to
# one version, through .env (ELASTICPRO_IMAGE, ELASTICPRO_NGINX_IMAGE, ELASTICPRO_DB_IMAGE,
# ELASTICPRO_REDIS_IMAGE), so docker-compose.yml is never edited. Every image is pulled
# before anything changes; a version that is not published fails with nothing touched. The
# images come from Docker Hub's karthickdk02/ unless ELASTICPRO_REGISTRY names another
# namespace. Going to an older version is refused without --force (--rollback is the usual
# way back).
#
# In order:
#   1. checks: .env and the stack's secrets exist, Docker Compose v2 is there;
#   2. names the new image elasticpro-core:<version>-<commit> (or takes --image), keeping
#      the one running now for rollback, and backs up .env;
#   3. builds it (a Rust build: long on a small server — see --image);
#   4. points ELASTICPRO_IMAGE in .env at it and restarts only the core;
#   5. waits for the core's health check. Not healthy in time: ELASTICPRO_IMAGE goes back to the
#      previous image, the core is restarted on it, and the script fails.
#
# The rest of the stack (nginx, database) is left running as it is; `--all` restarts it too.
# One exception: when deploy/nginx/nginx.conf differs from the config the running nginx has,
# nginx is recreated — a bind-mounted file is not picked up by a restart or a reload.
# Options: --pull, --image TAG, --upgrade[=VERSION], --force, --rollback, --all,
#          --apply-config, --timeout SECONDS (default 180), --dry-run
set -euo pipefail
cd "$(dirname "$0")"

PULL=0; IMAGE=; ROLLBACK=0; ALL=0; TIMEOUT=180; DRY=0; UPGRADE=; FORCE=0; APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pull) PULL=1; shift ;;
    --image) IMAGE=$2; shift 2 ;;
    --upgrade=*) UPGRADE=${1#*=}; [ -n "$UPGRADE" ] || UPGRADE=latest; shift ;;
    # `--upgrade 0.3.16` as well as `--upgrade=0.3.16`, but only when what follows is a version.
    --upgrade) if [ $# -gt 1 ] && printf '%s' "$2" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$'; then UPGRADE=$2; shift 2; else UPGRADE=latest; shift; fi ;;
    --force) FORCE=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --all) ALL=1; shift ;;
    --apply-config) APPLY=1; shift ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$(basename "$0")" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

[ -z "$UPGRADE" ] || [ -z "$IMAGE" ] || { echo "--upgrade and --image both pick the core image — use one" >&2; exit 2; }
[ -z "$UPGRADE" ] || [ "$ROLLBACK" = 0 ] || { echo "--upgrade and --rollback go opposite ways — use one" >&2; exit 2; }
if [ "$APPLY" = 1 ] && { [ -n "$UPGRADE$IMAGE" ] || [ "$ROLLBACK$PULL$ALL" != 000 ]; }; then
  echo "--apply-config applies config.txt on its own — run it without the other options (a deploy applies it too)" >&2; exit 2
fi

say() { printf '%s\n' "$*"; }
fail() { say "✗ $*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then say "  would: $*"; else "$@"; fi; }
env_get() { sed -n "s/^$1=//p" .env | tail -1; }
env_set() {   # KEY VALUE — replace the line, or add it
  if [ "$DRY" = 1 ]; then say "  would: set $1=$2 in .env"; return; fi
  if grep -q "^$1=" .env; then sed -i.tmp "s|^$1=.*|$1=$2|" .env && rm -f .env.tmp; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
env_del() {   # KEY — remove the line if it is there
  if [ "$DRY" = 1 ]; then grep -q "^$1=" .env && say "  would: remove $1 from .env"; return 0; fi
  sed -i.tmp "/^$1=/d" .env && rm -f .env.tmp
}

# The four images a release publishes: the .env key compose reads, and the image's name.
RELEASED="ELASTICPRO_IMAGE:core ELASTICPRO_NGINX_IMAGE:nginx ELASTICPRO_DB_IMAGE:postgres ELASTICPRO_REDIS_IMAGE:redis"
SUPPORT_KEYS="ELASTICPRO_NGINX_IMAGE ELASTICPRO_DB_IMAGE ELASTICPRO_REDIS_IMAGE"
# The image a key stands for now: .env when it says, else the default in docker-compose.yml.
image_of() {
  local v; v=$(env_get "$1")
  [ -n "$v" ] || v=$(sed -n "s/.*\${$1:-\([^}]*\)}.*/\1/p" docker-compose.yml | head -1)
  printf '%s' "$v"
}
# "0.3.16" from karthickdk02/elasticpro-core:0.3.16 or elasticpro-core:0.3.16-ab12cd3; empty otherwise.
version_of() { printf '%s' "${1##*:}" | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p'; }
# True when $1 is an older version than $2.
older() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }
# Redis runs only with the cache profile; its image is pulled only then.
redis_used() {
  case ",$(env_get COMPOSE_PROFILES),${COMPOSE_PROFILES:-}," in *,cache,*) return 0 ;; esac
  docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx redis
}

core_health() {
  local id; id=$(docker compose ps -q core 2>/dev/null)
  [ -n "$id" ] || { echo missing; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}
wait_healthy() {
  local t=0 h
  while [ "$t" -lt "$TIMEOUT" ]; do
    h=$(core_health)
    case "$h" in healthy) return 0 ;; unhealthy|exited|dead|missing) [ "$t" -ge 20 ] && return 1 ;; esac
    sleep 5; t=$((t + 5))
  done
  return 1
}

# --- config.txt: the one settings file ----------------------------------------------------
# config.txt.example is the single definition of the keys (and the rules, in its header);
# config.txt is the operator's copy. The core reads config.txt itself, at start. What only
# this script can do is the part that is not the core's: the port, the core's memory limit,
# and the three nginx include files (who may open the UI, under which name, and who is not
# rate limited). A key left empty is not managed here and nothing is rendered for it.
CONFIG=config.txt
CONFIG_EXAMPLE=config.txt.example
FRAGMENTS="allow-ui:ALLOWED_UI_IPS allow-host:ALLOWED_DOMAINS rate-exempt:RATE_EXEMPT_IPS"
FRAGMENT_NAME=config-txt.conf    # the operator's own files beside it in those directories stay theirs
FRAGMENT_HEADER="# generated from config.txt by deploy.sh — edit config.txt, not this"
CFG_TMP=
BOM=$(printf '\357\273\277')    # UTF-8 byte order mark
cleanup() { [ -z "$CFG_TMP" ] || rm -rf "$CFG_TMP"; }
trap cleanup EXIT

cfg_set() {   # FILE KEY VALUE — only to seed a copy made just now
  sed -i.tmp "s|^$2=.*|$2=$3|" "$1" && rm -f "$1.tmp"
}
CONFIG_SRC=$CONFIG    # what is read: config.txt, or in a dry run that has none yet, a seeded copy
# config.txt has to exist before any `docker compose up`: it is bind-mounted into the core,
# and Docker answers a missing file with a DIRECTORY at that path — which the core then
# reads as "no settings" and the operator cannot edit.
ensure_config() {
  if [ -d "$CONFIG" ]; then
    if [ "$DRY" = 1 ]; then say "  would: remove the empty directory Docker left at $CONFIG"
    else rmdir "$CONFIG" 2>/dev/null || fail "deploy/$CONFIG is a directory with files in it (Docker makes one when the file is missing) — move it away"; say "  removed the directory Docker had made at $CONFIG"; fi
  fi
  [ -f "$CONFIG" ] && return 0
  [ -f "$CONFIG_EXAMPLE" ] || fail "deploy/$CONFIG_EXAMPLE is missing — cannot make $CONFIG"
  local target=$CONFIG v
  if [ "$DRY" = 1 ]; then
    say "  would: create $CONFIG from $CONFIG_EXAMPLE"
    [ -n "$CFG_TMP" ] || CFG_TMP=$(mktemp -d)
    target=$CFG_TMP/config.seeded; CONFIG_SRC=$target
  fi
  cp "$CONFIG_EXAMPLE" "$target"
  # A host that was set up before config.txt existed has its port and memory limit in .env.
  # Carry them over, or the first --apply-config would put the port back to 443 and the
  # memory back to 2g — a settings file must start out saying what is already true.
  v=$(env_get LISTEN); [ -z "$v" ] || cfg_set "$target" LISTEN_PORT "$v"
  v=$(env_get ELASTICPRO_MEM_LIMIT); [ -z "$v" ] || cfg_set "$target" CORE_MEM_LIMIT "$v"
  [ "$DRY" = 1 ] || say "== made deploy/$CONFIG from $CONFIG_EXAMPLE (edit it, then: deploy/deploy.sh --apply-config)"
}

# Address and name checks. Pure bash, so a server needs nothing beyond what this script uses.
is_int() { case $1 in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 9 ]; }
in_range() { is_int "$1" && [ "$((10#$1))" -ge "$2" ] && [ "$((10#$1))" -le "$3" ]; }   # VALUE MIN MAX
is_v4() {
  local o ip=$1 re='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
  [[ $ip =~ $re ]] || return 1
  local IFS=.
  for o in $ip; do [ "$((10#$o))" -le 255 ] || return 1; done
}
is_v6() {
  local a=$1 g n=0 re='^[0-9A-Fa-f:.]+$' hex='^[0-9A-Fa-f]{1,4}$' dc=0 two
  [[ $a == *:* ]] && [[ $a =~ $re ]] || return 1
  case $a in *:::*|:[!:]*|*[!:]:) return 1 ;; esac
  two=${a//::/X}; case $two in *X*X*) return 1 ;; *X*) dc=1 ;; esac
  if [[ $a == *.* ]]; then      # ::ffff:192.0.2.1 — the dotted tail stands for two groups
    is_v4 "${a##*:}" || return 1
    a=${a%"${a##*:}"}0:0
  fi
  local IFS=:
  set -- $a
  for g in "$@"; do
    [ -n "$g" ] || continue
    [[ $g =~ $hex ]] || return 1
    n=$((n + 1))
  done
  if [ "$dc" = 1 ]; then [ "$n" -le 7 ]; else [ "$n" -eq 8 ]; fi
}
is_cidr() {   # an IPv4 or IPv6 address, with or without /prefix
  local a=${1%%/*} p=
  case $1 in */) return 1 ;; */*) p=${1#*/} ;; esac
  if is_v4 "$a"; then [ -z "$p" ] || { is_int "$p" && [ "$p" -le 32 ]; }
  elif is_v6 "$a"; then [ -z "$p" ] || { is_int "$p" && [ "$p" -le 128 ]; }
  else return 1; fi
}
is_hostname() {
  local re='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
  [[ $1 =~ $re ]] && [ "${#1}" -le 253 ]
}
cfg_list() {   # a comma-separated value, one trimmed non-empty item per line
  printf '%s\n' "$1" | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d'
}
cfg_get() { sed -n "s/^$1=//p" "$CFG_TMP/parsed" | tail -1; }

# One rule per key, the same ones the core applies (SPECS in crates/elasticpro-core/src/settings.rs).
# tools/unit/settings-parity.test.mjs fails when the two drift, so change both together.
#   KEY bool | KEY int MIN MAX | KEY enum a,b,c | KEY text | KEY deploy (this script's own key)
# bool and enum compare case-insensitively, as the core does.
CFG_RULES='
TRUSTED_PROXIES text
PROXY_AUTH_HEADER bool
PUBLIC_URL text
FRAME_ANCESTORS text
ZABBIX_URL text
ZABBIX_API_URL text
ZABBIX_ALLOWED_SOURCES text
ZABBIX_SYNC_SECONDS int 30 86400
ZABBIX_VERIFY_TLS bool
ZABBIX_CLUSTER_TEMPLATE text
ZABBIX_SCOPE_USERS_BY_GROUP bool
ZABBIX_USE_ELASTICPRO_CREDENTIALS bool
ZABBIX_CREATE_HOSTS bool
ZABBIX_HOST_GROUP text
ZABBIX_METRICS_HOST text
ACTIVITY_LOG text
ACTIVITY_LOG_MAX_MB int 1 100000
ACTIVITY_LOG_KEEP int 0 1000
ACTIVITY_LOG_STDOUT bool
NOTIFY_DAYS int 1 3650
LOG_LEVEL enum error,warn,info,debug,trace
POLL_HEALTH_SECONDS int 180 300
POLL_CONCURRENCY int 1 256
ES_CONCURRENCY int 1 1024
ES_PER_CLUSTER int 1 1024
ES_PER_JUMP_HOST int 1 1024
ES_BACKGROUND_RESERVE int 0 1023
ES_QUEUE_MAX int 0 100000
ES_QUEUE_PER_USER int 1 100000
ES_QUEUE_WAIT_MS int 100 600000
ES_MAX_TIMEOUT_MS int 1000 600000
ES_READ_CACHE_SECONDS int 0 300
ES_READ_CACHE_MB int 0 65536
ES_MAX_RESPONSE_MB int 1 4096
ES_MAX_FLEET_RESPONSE_MB int 1 4096
ES_TASK_REAPER enum off,orphans,overdue
ES_TASK_MAX_SECONDS int 30 86400
ZABBIX_CONCURRENCY int 1 64
CACHE_MB int 1 1048576
HOUSEKEEPING_MINUTES int 0 10080
HOUSEKEEPING_CACHE_DAYS int 1 3650
HOUSEKEEPING_DRY_RUN bool
SESSION_IDLE_DAYS int 0 3650
ACTIVITY_LOG_KEEP_DAYS int 0 3650
UI_READ_ONLY bool
UI_AUTO_REFRESH bool
UI_REFRESH_SECONDS int 5 3600
UI_REQUEST_TIMEOUT_MS int 1000 600000
UI_DISK_WARN_PERCENT int 1 100
UI_DISK_CRIT_PERCENT int 1 100
UI_SNAPSHOT_STALE_HOURS int 1 2160
UI_LOG_INDEX_PATTERN text
UI_TIME_FIELD text
UI_TLS enum auto,system,insecure
UI_LIVE_REDRAW enum pending,live,manual
UI_DEFAULT_SCOPE enum last-selected,all
UI_ROWS_PER_PAGE int 5 1000
UI_MAX_LOG_ROWS int 10 10000
UI_VOLUME_INDEX_FORMAT text
UI_VOLUME_TAG_FIELDS text
UI_VOLUME_FORWARDER_FIELDS text
UI_VOLUME_HOST_FIELDS text
UI_VOLUME_IP_FIELDS text
UI_VOLUME_EVENT_SIZE_FIELD text
UI_VOLUME_SUB_SIZE_FIELD text
UI_VOLUME_EXTRA_NAME text
UI_VOLUME_EXTRA_FIELDS text
UI_VOLUME_SIZE_BASIS enum primary,total,eventSize
UI_VOLUME_TOP_VALUES int 5 100
UI_VOLUME_KEEP_MONTHS int 1 36
UI_VOLUME_COLLECT_AT text
UI_SMTP_HOST text
UI_SMTP_PORT int 1 65535
UI_SMTP_SECURITY enum starttls,tls,none
UI_SMTP_USER text
UI_SMTP_PASSWORD_FILE text
UI_SMTP_FROM text
UI_REPORT_TO text
UI_REPORT_SCHEDULE enum monthly,weekly,daily,manual
UI_REPORT_AT text
UI_REPORT_SHEETS text
LISTEN_PORT deploy
ALLOWED_DOMAINS deploy
ALLOWED_UI_IPS deploy
RATE_EXEMPT_IPS deploy
CORE_MEM_LIMIT deploy
'

# Prints what is wrong with VALUE for KEY and returns 1, or returns 0. First the table above
# (what the core also enforces), then what only this script checks.
cfg_check() {
  local k=$1 v=$2 item rule kind a b lower
  if [[ $v == *[[:cntrl:]]* ]]; then echo "contains a control character"; return 1; fi
  rule=$(printf '%s\n' "$CFG_RULES" | awk -v k="$k" '$1 == k { print; exit }')
  if [ -n "$rule" ]; then
    read -r _ kind a b <<< "$rule"
    lower=$(printf '%s' "$v" | tr 'A-Z' 'a-z')
    case $kind in
      bool) case $lower in true|false) ;; *) echo "must be true or false"; return 1 ;; esac ;;
      int)  in_range "$v" "$a" "$b" || { echo "must be a whole number from $a to $b"; return 1; } ;;
      enum) case ",$(printf '%s' "$a" | tr 'A-Z' 'a-z')," in *",$lower,"*) ;; *) echo "must be one of: ${a//,/, }"; return 1 ;; esac ;;
    esac
  fi
  case $k in
    LISTEN_PORT) in_range "$v" 1 65535 || { echo "must be a port number, 1-65535"; return 1; } ;;
    ALLOWED_UI_IPS|RATE_EXEMPT_IPS|TRUSTED_PROXIES|ZABBIX_ALLOWED_SOURCES)
      while IFS= read -r item; do
        is_cidr "$item" || { echo "\"$item\" is not an IPv4/IPv6 address or CIDR (e.g. 10.0.0.0/8, 192.0.2.5, fd00::/8)"; return 1; }
      done < <(cfg_list "$v") ;;
    ALLOWED_DOMAINS)
      while IFS= read -r item; do
        is_hostname "$item" || is_v4 "$item" || is_v6 "$item" || { echo "\"$item\" is not a host name or an IP address"; return 1; }
      done < <(cfg_list "$v") ;;
    CORE_MEM_LIMIT) [[ $v =~ ^[0-9]+[bBkKmMgG]?$ ]] || { echo "must be a size such as 2g or 512m"; return 1; } ;;
    PUBLIC_URL|ZABBIX_URL|ZABBIX_API_URL)
      [[ $v =~ ^https?://[^[:space:]]+$ ]] || { echo "must be a URL starting with http:// or https://"; return 1; } ;;
    # The same two rules the core applies (settings.rs check_text).
    UI_VOLUME_INDEX_FORMAT)
      case $v in
        *YYYY.MM.DD*YYYY.MM.DD*) echo "must contain YYYY.MM.DD once"; return 1 ;;
        *'*'*YYYY.MM.DD*|*YYYY.MM.DD*'*'*) ;;
        *) echo "must contain * (the source) and YYYY.MM.DD (the day), e.g. logstash-*-YYYY.MM.DD"; return 1 ;;
      esac
      case $v in *[[:space:],/\\?#\"\<\>\|]*) echo "must be one index pattern: no spaces, commas or slashes"; return 1 ;; esac ;;
    UI_VOLUME_COLLECT_AT|UI_REPORT_AT)
      [[ $v =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo "must be a time of day HH:MM, 00:00 to 23:59"; return 1; } ;;
    # The core checks these properly (settings.rs check_text); here, the mistakes worth
    # catching before a deploy: a URL for a host, a list that is not addresses.
    UI_SMTP_HOST)
      [[ $v =~ ^[^[:space:]/@?#]+$ ]] || { echo "must be a host name or an address, without a scheme or a path"; return 1; } ;;
    UI_SMTP_FROM)
      [[ $v == *@* ]] || { echo "must be a mail address, e.g. ElasticPro <elasticpro@example.com>"; return 1; } ;;
    UI_REPORT_TO)
      while IFS= read -r item; do
        [[ $item == *?@?* ]] || { echo "\"$item\" is not a mail address"; return 1; }
      done < <(cfg_list "$v") ;;
    UI_REPORT_SHEETS)
      while IFS= read -r item; do
        case $item in daily|monthly|breakdown) ;; *) echo "\"$item\" is not one of: daily, monthly, breakdown"; return 1 ;; esac
      done < <(cfg_list "$v") ;;
  esac
  return 0
}

# Reads $1 into $CFG_TMP/parsed as KEY=VALUE lines, and reports EVERY problem before failing:
# a settings file that is wrong in three places should not take three runs to fix.
config_validate() {
  local src=$1 line n=0 key val msg errs=0 seen=" " known
  [ -n "$CFG_TMP" ] || CFG_TMP=$(mktemp -d)
  : > "$CFG_TMP/parsed"
  known=" $(LC_ALL=C sed -e "1s/^$BOM//" "$CONFIG_EXAMPLE" | sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' | tr '\n' ' ')"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [ "$n" != 1 ] || line=${line#"$BOM"}    # an editor's UTF-8 BOM; the core skips it too
    line=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    case $line in ''|'#'*) continue ;; esac
    if ! [[ $line =~ ^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*= ]]; then
      say "  ✗ $CONFIG line $n: not KEY=VALUE: $line" >&2; errs=$((errs + 1)); continue
    fi
    key=$(printf '%s' "${line%%=*}" | sed 's/[[:space:]]*$//')
    val=$(printf '%s' "${line#*=}" | sed 's/^[[:space:]]*//')
    case $val in    # the core takes one pair of matching quotes off a value
      \"*\"|\'*\') [ "${#val}" -lt 2 ] || val=${val:1:${#val}-2} ;;
    esac
    val=$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    case $known in
      *" $key "*) ;;
      *) say "  ! $CONFIG line $n: unknown key $key — ignored (see $CONFIG_EXAMPLE for the keys)" >&2; continue ;;
    esac
    case $seen in *" $key "*) say "  ✗ $CONFIG line $n: $key is set twice" >&2; errs=$((errs + 1)); continue ;; esac
    seen="$seen$key "
    if [ -n "$val" ] && ! msg=$(cfg_check "$key" "$val"); then
      say "  ✗ $CONFIG line $n: $key=$val — $msg" >&2; errs=$((errs + 1)); continue
    fi
    printf '%s=%s\n' "$key" "$val" >> "$CFG_TMP/parsed"
  done < "$src"
  [ "$errs" = 0 ] || fail "$errs problem(s) in $CONFIG — nothing was changed"
}

# The text of one include file, from the list under KEY; nothing when the list is empty.
render_fragment() {   # DIR KEY
  local dir=$1 val item
  val=$(cfg_get "$2")
  [ -n "$val" ] || return 0
  printf '%s\n' "$FRAGMENT_HEADER"
  case $dir in
    allow-ui)
      # The whole address space, as halves: geo's `default 1;` already is 0.0.0.0/0, and a
      # second /0 would only be a duplicate. Listed addresses are more specific, so they win.
      printf '%s\n' '0.0.0.0/1 0;' '128.0.0.0/1 0;' '::/1 0;' '8000::/1 0;'
      while IFS= read -r item; do printf '%s 1;\n' "$item"; done < <(cfg_list "$val") ;;
    allow-host)
      while IFS= read -r item; do
        item=$(printf '%s' "$item" | tr 'A-Z' 'a-z')    # nginx hands $host over in lower case
        if is_v6 "$item"; then printf '"%s" 1;\n"[%s]" 1;\n' "$item" "$item"; else printf '%s 1;\n' "$item"; fi
      done < <(cfg_list "$val")
      printf '%s\n' '~^ 0;' ;;     # whatever is not listed (exact names are tried first)
    rate-exempt)
      while IFS= read -r item; do printf '%s 1;\n' "$item"; done < <(cfg_list "$val") ;;
  esac
}

nginx_running() { docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx nginx; }

# Brings config.txt into force. $1 = restart (also recreate the core, which reads config.txt
# only at start) or keep (a deploy that restarts it anyway). Validates first and changes
# nothing on any error. Nobody is signed out: sessions outlive a restart.
apply_config() {
  local mode=$1 src=$CONFIG_SRC spec dir key f old new changed="" relisten="" listen_new mem_new frag_changed=0 backups check
  say "== settings: $CONFIG"
  config_validate "$src"
  listen_new=$(cfg_get LISTEN_PORT); mem_new=$(cfg_get CORE_MEM_LIMIT)

  # What each include file should say now, next to what it says.
  backups=$CFG_TMP/previous; mkdir -p "$backups" "$CFG_TMP/next"
  for spec in $FRAGMENTS; do
    dir=${spec%%:*}; key=${spec#*:}
    f=nginx/$dir/$FRAGMENT_NAME
    render_fragment "$dir" "$key" > "$CFG_TMP/next/$dir"
    old=absent; new=absent
    [ ! -f "$f" ] || old=present
    [ ! -s "$CFG_TMP/next/$dir" ] || new=present
    if [ "$old" != "$new" ] || { [ "$new" = present ] && ! cmp -s "$f" "$CFG_TMP/next/$dir"; }; then
      changed="$changed $dir"; frag_changed=1
    fi
  done

  for spec in $FRAGMENTS; do
    dir=${spec%%:*}; key=${spec#*:}
    case " $changed " in *" $dir "*) ;; *) continue ;; esac
    f=nginx/$dir/$FRAGMENT_NAME
    if [ -s "$CFG_TMP/next/$dir" ]; then say "   $key → $f: $(grep -vc '^#' "$CFG_TMP/next/$dir") line(s)"; else say "   $key is empty → $f removed"; fi
  done
  [ -n "$changed" ] || say "   nginx include files: already as config.txt says"

  if [ "$DRY" = 1 ]; then
    for dir in $changed; do
      if [ -s "$CFG_TMP/next/$dir" ]; then say "  would: write nginx/$dir/$FRAGMENT_NAME"; else say "  would: remove nginx/$dir/$FRAGMENT_NAME"; fi
    done
  else
    for dir in $changed; do
      f=nginx/$dir/$FRAGMENT_NAME
      mkdir -p "nginx/$dir"
      [ ! -f "$f" ] || cp -p "$f" "$backups/$dir"
      if [ -s "$CFG_TMP/next/$dir" ]; then cp "$CFG_TMP/next/$dir" "$f"; else rm -f "$f"; fi
    done
  fi

  # Validate in the running nginx, whose directories now hold the new files, before anything
  # is reloaded or recreated. A list that nginx rejects puts the old files back.
  if [ "$frag_changed" = 1 ] && [ "$DRY" != 1 ] && nginx_running; then
    if ! docker compose exec -T nginx test -d /etc/nginx/allow-ui -a -d /etc/nginx/allow-host 2>/dev/null; then
      relisten=mounts     # this nginx predates the directories: only a recreate adds the mounts
    elif ! check=$(docker compose exec -T nginx nginx -t 2>&1); then
      for dir in $changed; do
        f=nginx/$dir/$FRAGMENT_NAME
        if [ -f "$backups/$dir" ]; then cp -p "$backups/$dir" "$f"; else rm -f "$f"; fi
      done
      printf '  %s\n' "$check" | tail -4 >&2
      fail "nginx rejected the lists in $CONFIG — the previous nginx include files are back and nothing was reloaded"
    fi
  fi

  # .env: the port and the core's memory limit. Empty in config.txt = not managed (the port)
  # or back to the default (the memory), so a value removed from config.txt does not linger.
  if [ -n "$listen_new" ] && [ "$listen_new" != "$(env_get LISTEN)" ] && { [ "$listen_new" != 443 ] || [ -n "$(env_get LISTEN)" ]; }; then
    [ "$DRY" = 1 ] || { [ -n "${ENV_SAVED:-}" ] || { ENV_SAVED=.env.bak-$(date +%Y%m%d-%H%M%S); cp .env "$ENV_SAVED"; }; }
    say "   LISTEN_PORT → .env LISTEN=$listen_new"
    env_set LISTEN "$listen_new"; relisten=listen
  fi
  if [ -n "$mem_new" ]; then
    if [ "$mem_new" != "$(env_get ELASTICPRO_MEM_LIMIT)" ]; then say "   CORE_MEM_LIMIT → .env ELASTICPRO_MEM_LIMIT=$mem_new"; env_set ELASTICPRO_MEM_LIMIT "$mem_new"; fi
  elif [ -n "$(env_get ELASTICPRO_MEM_LIMIT)" ]; then
    say "   CORE_MEM_LIMIT is empty → .env ELASTICPRO_MEM_LIMIT removed (default 2g)"; env_del ELASTICPRO_MEM_LIMIT
  fi

  # nginx: recreate for a new port, reload for new lists (a directory mount shows new files
  # without a recreate). Not running: it reads the files when it starts.
  if [ "$DRY" = 1 ]; then
    [ -z "$relisten" ] || say "  would: docker compose up -d nginx   (the port changes)"
    [ "$frag_changed" = 0 ] || say "  would: check the lists with nginx -t in the running nginx, then nginx -s reload"
  elif nginx_running; then
    if [ -n "$relisten" ]; then
      run docker compose up -d nginx
      say "✓ nginx recreated ($relisten)"
    elif [ "$frag_changed" = 1 ]; then
      if run docker compose exec -T nginx nginx -s reload; then say "✓ nginx reloaded"; else fail "nginx did not reload — docker compose exec nginx nginx -t"; fi
    fi
  fi

  if [ "$mode" = restart ]; then
    say "== restarting the core (it reads $CONFIG at start; nobody is signed out)"
    run docker compose up -d --force-recreate core
    if [ "$DRY" != 1 ]; then
      if wait_healthy; then say "✓ core healthy with the new settings"; else
        docker compose logs --tail 30 core || true
        fail "core not healthy after applying $CONFIG — fix the value above and run --apply-config again${ENV_SAVED:+ (.env before: $ENV_SAVED)}"
      fi
    fi
  fi
  return 0
}

# --- 1. checks --------------------------------------------------------------------------
# A dry --apply-config only validates and renders, which needs no Docker.
docker compose version >/dev/null 2>&1 || { [ "$APPLY$DRY" = 11 ] || fail "Docker Compose v2 is needed (docker compose …)"; }
[ -f .env ] || fail "deploy/.env is missing — a first install starts with README.md (Install)"
[ -f secrets/db_password ] || [ "$APPLY$DRY" = 11 ] || fail "deploy/secrets/db_password is missing — see README.md (Install, step 4)"
# Before any compose command: the core mounts it, and Docker makes a directory of a missing file.
ensure_config

if [ "$APPLY" = 1 ]; then
  apply_config restart
  [ "$DRY" = 1 ] && say "(dry run: nothing was changed)" || docker compose ps
  exit 0
fi

CURRENT=$(env_get ELASTICPRO_IMAGE)
CURRENT=${CURRENT:-elasticpro-core:latest}
PREVIOUS_BEFORE=$(env_get ELASTICPRO_IMAGE_PREVIOUS)

# --- rollback only ----------------------------------------------------------------------
# Every image the last deploy changed goes back: the core always, and nginx, PostgreSQL and
# Redis too when it was an --upgrade that moved them.
if [ "$ROLLBACK" = 1 ]; then
  PREV=$(env_get ELASTICPRO_IMAGE_PREVIOUS)
  [ -n "$PREV" ] || fail "no previous image recorded (ELASTICPRO_IMAGE_PREVIOUS in .env)"
  docker image inspect "$PREV" >/dev/null 2>&1 || fail "the previous image $PREV is no longer on this machine"
  say "== rollback: $CURRENT → $PREV"
  env_set ELASTICPRO_IMAGE "$PREV"
  env_set ELASTICPRO_IMAGE_PREVIOUS "$CURRENT"
  STACK=0
  for key in $SUPPORT_KEYS; do
    old=$(env_get "${key}_PREVIOUS"); [ -n "$old" ] || continue
    now=$(image_of "$key")
    docker image inspect "$old" >/dev/null 2>&1 || run docker pull -q "$old" >/dev/null || fail "the previous image $old cannot be found or pulled"
    say "   ${key#ELASTICPRO_}: $now → $old"
    env_set "$key" "$old"; env_set "${key}_PREVIOUS" "$now"; STACK=1
  done
  if [ "$STACK" = 1 ]; then run docker compose up -d; else run docker compose up -d core; fi
  [ "$DRY" = 1 ] || { wait_healthy && say "✓ core healthy on $PREV"; } || fail "core not healthy on $PREV either — docker compose logs core"
  exit 0
fi

# --- 2. which image ---------------------------------------------------------------------
if [ "$PULL" = 1 ]; then
  say "== git pull"
  run git -C .. pull --ff-only
fi
if [ -z "$IMAGE" ]; then
  VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' ../Cargo.toml | head -1)
  COMMIT=$(git -C .. rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)
  [ -z "$(git -C .. status --porcelain -- crates ui src-tauri Cargo.toml Cargo.lock deploy/Dockerfile 2>/dev/null)" ] || COMMIT=$COMMIT-dirty
  IMAGE=elasticpro-core:$VERSION-$COMMIT
fi
# nginx is given its config as a bind-mounted FILE, which goes wrong in two different ways
# whenever a release changes that file, and releases do change it (frame-ancestors is set
# by the core, /zabbix/pair is forwarded by nginx):
#   • git pull, rsync and sed -i replace the file with a new inode. The mount still points
#     at the old one, so the container goes on serving the previous config for ever —
#     a reload rereads the file it already has. Only recreating the container picks it up.
#   • an edit in place is visible inside the container, but nginx has already parsed the
#     old text and keeps serving it until it is told to reload.
# Either way the core is new and nginx is not, which is how pairing answered 404 on a
# deployment that looked healthy.
sync_nginx() {
  local disk running started changed
  [ -f nginx/nginx.conf ] || return 0
  docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx nginx || return 0

  disk=$(sha256sum nginx/nginx.conf 2>/dev/null | cut -d' ' -f1)
  running=$(docker compose exec -T nginx sha256sum /etc/nginx/nginx.conf 2>/dev/null | cut -d' ' -f1)
  [ -n "$disk" ] && [ -n "$running" ] || return 0

  if [ "$disk" != "$running" ]; then
    # Stale inode: the container cannot see this file at all. Recreate, after checking the
    # config is valid — nginx that will not start is worse than nginx serving the old one.
    say "== nginx.conf was replaced — the running nginx still has the previous one"
    # Checked inside the running container, which has the certificates and the password
    # file this config refers to: a bare `nginx -t` in a throwaway container fails on a
    # missing TLS certificate and reads as a broken config.
    local cid check
    cid=$(docker compose ps -q nginx)
    if docker cp nginx/nginx.conf "$cid:/tmp/nginx.new.conf" >/dev/null 2>&1; then
      if ! check=$(docker compose exec -T nginx nginx -t -c /tmp/nginx.new.conf 2>&1); then
        say "✗ the new nginx.conf is not valid — leaving nginx on the old one:"
        printf '  %s\n' "$check" | tail -3 >&2
        docker compose exec -T nginx rm -f /tmp/nginx.new.conf >/dev/null 2>&1 || true
        return 0
      fi
      docker compose exec -T nginx rm -f /tmp/nginx.new.conf >/dev/null 2>&1 || true
    else
      say "  (could not check it first — recreating anyway)"
    fi
    if run docker compose up -d --force-recreate nginx; then say "✓ nginx recreated with the new config"
    else say "✗ nginx could not be recreated — the core is new, nginx still has the old config"; fi
    return 0
  fi

  # Same file, but has it changed since nginx parsed it?
  started=$(docker inspect -f '{{.State.StartedAt}}' "$(docker compose ps -q nginx)" 2>/dev/null)
  [ -n "$started" ] || return 0
  changed=$(date -u -r nginx/nginx.conf +%Y-%m-%dT%H:%M:%S 2>/dev/null) || return 0
  [ "$changed" \> "${started%.*}" ] || return 0
  say "== nginx.conf changed since nginx started — reloading it"
  if docker compose exec -T nginx nginx -t >/dev/null 2>&1 && run docker compose exec -T nginx nginx -s reload; then
    say "✓ nginx reloaded"
  else
    say "✗ nginx did not reload — check: docker compose exec nginx nginx -t"
  fi
}

# --- upgrade: a published release, all four images ------------------------------------
if [ -n "$UPGRADE" ]; then
  API="https://api.github.com/repos/karthick-dkk/elasticpro"
  REG=${ELASTICPRO_REGISTRY:-karthickdk02}
  if [ "$UPGRADE" = latest ]; then
    TAG=$(curl -fsSL --max-time 20 "$API/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$TAG" ] || fail "could not ask GitHub which release is the latest ($API) — name it: --upgrade=X.Y.Z"
    say "== latest release: $TAG"
  else
    TAG=$UPGRADE
  fi
  TARGET=${TAG#v}
  printf '%s' "$TARGET" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "not a release version: $TAG (expected X.Y.Z, e.g. --upgrade=0.3.16)"
  NOW=$(version_of "$CURRENT")

  # What changes: every released image not already at the target.
  PLAN=
  for pair in $RELEASED; do
    key=${pair%%:*}; name=${pair#*:}
    [ "$key" != ELASTICPRO_REDIS_IMAGE ] || redis_used || continue
    now=$(image_of "$key"); new="$REG/elasticpro-$name:$TARGET"
    [ "$now" = "$new" ] || PLAN="$PLAN $key=$new"
  done
  if [ -z "$PLAN" ]; then
    apply_config keep
    say "✓ already on $TARGET — nothing else to do (the core was not restarted: deploy.sh --apply-config does that)"
    exit 0
  fi
  if [ -n "$NOW" ] && older "$TARGET" "$NOW" && [ "$FORCE" != 1 ]; then
    fail "$TARGET is older than the $NOW running now — use --rollback to go back, or add --force"
  fi

  # A bad config.txt stops the upgrade before anything is pulled.
  [ ! -f "$CONFIG" ] || config_validate "$CONFIG"
  say "== upgrading ${NOW:-$CURRENT} → $TARGET"
  for item in $PLAN; do
    img=${item#*=}
    say "   pulling $img"
    run docker pull -q "$img" >/dev/null || fail "$img is not published (or cannot be pulled) — nothing changed"
  done
  # After the pulls, so a release that is not published leaves everything as it was; before
  # the .env backup, so the way back keeps the port and memory limit config.txt asks for.
  apply_config keep
  BACKUP=.env.bak-$(date +%Y%m%d-%H%M%S)
  run cp .env "$BACKUP"
  # The core's previous image is always recorded; a support image's only when it moves, and
  # a stale record from an older upgrade is dropped so --rollback undoes exactly this one.
  for key in $SUPPORT_KEYS; do env_del "${key}_PREVIOUS"; done
  for item in $PLAN; do
    key=${item%%=*}; img=${item#*=}
    env_set "${key}_PREVIOUS" "$(image_of "$key")"
    env_set "$key" "$img"
  done
  printf '%s' "$PLAN" | grep -q 'ELASTICPRO_IMAGE=' || env_set ELASTICPRO_IMAGE_PREVIOUS "$CURRENT"
  say "== restarting the stack on $TARGET"
  run docker compose up -d
  [ "$DRY" = 1 ] && { say "(dry run: nothing was changed)"; exit 0; }
  say "== waiting for the core's health check (up to ${TIMEOUT}s)"
  if wait_healthy; then
    say "✓ ElasticPro $TARGET is running and healthy"
    sync_nginx
    say "  .env before this upgrade: $BACKUP   ·   undo: deploy/deploy.sh --rollback"
    docker compose ps
    exit 0
  fi
  say "✗ core not healthy on $TARGET — last log lines:"
  docker compose logs --tail 30 core || true
  say "== putting back the .env from before the upgrade"
  cp "$BACKUP" .env
  docker compose up -d
  # The way back gets the full wait, whatever --timeout the attempt had.
  [ "$TIMEOUT" -ge 180 ] || TIMEOUT=180
  if wait_healthy; then say "✓ back on ${NOW:-$CURRENT}, healthy"; else say "✗ not healthy on ${NOW:-$CURRENT} either — docker compose logs core"; fi
  exit 1
fi

# config.txt in force before the core is switched: this deploy restarts it anyway.
apply_config keep

say "== deploying $IMAGE (running now: $CURRENT)"
BACKUP=.env.bak-$(date +%Y%m%d-%H%M%S)
run cp .env "$BACKUP"

# --- 3. build (or check the given image is here) -----------------------------------------
if [ -n "${VERSION:-}" ]; then
  say "== building (docker compose build core)"
  if [ "$DRY" = 1 ]; then say "  would: ELASTICPRO_IMAGE=$IMAGE docker compose build core"
  else ELASTICPRO_IMAGE=$IMAGE docker compose build core || fail "build failed — nothing changed; the core still runs $CURRENT"; fi
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || run docker pull "$IMAGE" || fail "image $IMAGE is not here and cannot be pulled — nothing changed"
fi

# --- 4. switch --------------------------------------------------------------------------
[ "$IMAGE" = "$CURRENT" ] || env_set ELASTICPRO_IMAGE_PREVIOUS "$CURRENT"
env_set ELASTICPRO_IMAGE "$IMAGE"
# This deploy moves the core alone; --rollback must not also undo an older upgrade's nginx.
for key in $SUPPORT_KEYS; do env_del "${key}_PREVIOUS"; done
say "== restarting $([ "$ALL" = 1 ] && echo "the stack" || echo "the core")"
if [ "$ALL" = 1 ]; then run docker compose up -d; else run docker compose up -d core; fi
[ "$DRY" = 1 ] && { say "(dry run: nothing was changed)"; exit 0; }

# --- 5. healthy, or back ------------------------------------------------------------------
say "== waiting for the core's health check (up to ${TIMEOUT}s)"
if wait_healthy; then
  say "✓ core healthy on $IMAGE"
  sync_nginx
  say "  .env before this deploy: $BACKUP   ·   undo: deploy/deploy.sh --rollback"
  docker compose ps
  exit 0
fi
say "✗ core not healthy on $IMAGE — last log lines:"
docker compose logs --tail 30 core || true
if [ "$IMAGE" != "$CURRENT" ]; then
  say "== rolling back to $CURRENT"
  env_set ELASTICPRO_IMAGE "$CURRENT"
  # This deploy never happened: --rollback keeps meaning what it meant before it.
  if [ -n "$PREVIOUS_BEFORE" ]; then env_set ELASTICPRO_IMAGE_PREVIOUS "$PREVIOUS_BEFORE"; else sed -i.tmp '/^ELASTICPRO_IMAGE_PREVIOUS=/d' .env && rm -f .env.tmp; fi
  docker compose up -d core
  [ "$TIMEOUT" -ge 180 ] || TIMEOUT=180
  if wait_healthy; then say "✓ back on $CURRENT, healthy"; else say "✗ not healthy on $CURRENT either — docker compose logs core"; fi
fi
exit 1
