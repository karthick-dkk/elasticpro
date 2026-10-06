#!/usr/bin/env bash
# ElasticPro — install or update the Zabbix 7.0 frontend modules.
#
# One line (the latest release):
#   curl -fsSL https://github.com/karthick-dkk/elasticpro/releases/latest/download/zabbix-modules-install.sh | sudo bash
#
# Safer — download, read, then run:
#   curl -fsSLO https://github.com/karthick-dkk/elasticpro/releases/latest/download/zabbix-modules-install.sh
#   less zabbix-modules-install.sh
#   sudo bash zabbix-modules-install.sh --dry-run
#   sudo bash zabbix-modules-install.sh [options]
#
# Options through the pipe: ... | sudo bash -s -- --dry-run
#
# What it does:
#   1. downloads elasticpro-zabbix-modules-<ver>.tar.gz and its .sha256 from the GitHub
#      release, and checks the SHA-256 before extracting anything;
#   2. finds the Zabbix frontend: a package install (its modules/ folder, and the user PHP
#      runs as), or a running zabbix-web-* container (the host folder mounted at
#      /usr/share/zabbix/modules, or at /usr/share/zabbix/modules/<module>);
#   3. puts the five module folders in place — each one staged beside the modules folder and
#      renamed in, the previous one kept in a dated backup; config.php is never touched;
#   4. optionally registers and enables them through the Zabbix API, and presses
#      "Write master template" on Cluster Management.
# Safe to run again: a module already at this version is left alone.
#
# Options:
#   --version vX.Y.Z        that release instead of the latest
#   --from-dir PATH         no download: PATH is a checkout of the repository (the archive is
#                           built from it by tools/zabbix-modules-tarball.sh, as the release is),
#                           or an extracted release archive
#   --tarball FILE          no download: a release archive you fetched yourself; its
#                           FILE.sha256 is checked when it is next to it
#   --modules-dir DIR       Zabbix's modules folder (skips detection; use with --owner)
#   --owner UID:GID         owner of the installed files (default: root:<PHP's group> for
#                           packages, 1997:1995 for the official Docker images)
#   --container NAME        the Zabbix web container, when more than one is running
#   --package               the package frontend, when a Zabbix web container runs here too
#                           (with --zabbix-url the choice is made from its port instead)
#   --data-dir DIR          the Cluster Management page's writable folder (package installs:
#                           default /var/lib/elasticpro-zabbix; made writable by PHP's user)
#   --backup-dir DIR        where replaced modules go (default /var/backups/elasticpro-zabbix)
#   --zabbix-url URL        the Zabbix frontend, e.g. https://zabbix.example.com (or …/zabbix)
#   --token-file FILE       a Super admin API token, alone in a file readable only by its
#                           owner (chmod 600); with --zabbix-url, the modules are registered
#                           and enabled through the API
#   --write-master-template also press ElasticPro → Cluster Management → "Write master
#                           template". That is a page action, not an API method, so it signs in
#                           to the frontend: needs --password-file (and --user, default Admin)
#   --user NAME             Super admin user for --write-master-template (default Admin)
#   --password-file FILE    that user's password, alone in a chmod 600 file
#   --insecure              the Zabbix URL has a self-signed certificate
#   --uninstall             remove the modules this installed (kept in the backup folder).
#                           Disable them in Zabbix first (Administration → General → Modules),
#                           or give --zabbix-url and --token-file and this disables them
#   --dry-run               say everything it would do; change nothing
#   -h, --help              this text
#
# Secrets are read from files, never taken on the command line, and never printed.
set -euo pipefail

REPO=${EP_REPO:-karthick-dkk/elasticpro}
# The module ids, the folder names under modules/. tools/zabbix-modules-tarball.sh builds
# the archive from the same five.
KNOWN_IDS=(elasticpro ep_clients ep_capacity ep_resources ep_volume)

VERSION=latest
FROM_DIR=
TARBALL=
MODULES_DIR=
OWNER=
CONTAINER=
FORCE_PACKAGE=0
DATA_DIR=
BACKUP_DIR=/var/backups/elasticpro-zabbix
ZBX_URL=
TOKEN_FILE=
ZBX_USER=Admin
PASSWORD_FILE=
WRITE_MASTER=0
INSECURE=0
UNINSTALL=0
DRY=0

need_arg() { [ -n "${2:-}" ] || { echo "$1 needs a value (see --help)" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --version) need_arg "$@"; VERSION=$2; shift 2 ;;
    --from-dir) need_arg "$@"; FROM_DIR=$2; shift 2 ;;
    --tarball) need_arg "$@"; TARBALL=$2; shift 2 ;;
    --modules-dir) need_arg "$@"; MODULES_DIR=$2; shift 2 ;;
    --owner) need_arg "$@"; OWNER=$2; shift 2 ;;
    --container) need_arg "$@"; CONTAINER=$2; shift 2 ;;
    --package) FORCE_PACKAGE=1; shift ;;
    --data-dir) need_arg "$@"; DATA_DIR=$2; shift 2 ;;
    --backup-dir) need_arg "$@"; BACKUP_DIR=$2; shift 2 ;;
    --zabbix-url) need_arg "$@"; ZBX_URL=${2%/}; shift 2 ;;
    --token-file) need_arg "$@"; TOKEN_FILE=$2; shift 2 ;;
    --user) need_arg "$@"; ZBX_USER=$2; shift 2 ;;
    --password-file) need_arg "$@"; PASSWORD_FILE=$2; shift 2 ;;
    --write-master-template) WRITE_MASTER=1; shift ;;
    --insecure) INSECURE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help)
      if [ -f "$0" ]; then sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
      else echo "Download the script to read its help: https://github.com/$REPO/releases/latest/download/zabbix-modules-install.sh"; fi
      exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# --- output -------------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
note() { printf '  ! %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
# Runs a change, or in a dry run says it would.
run()  { if [ "$DRY" = 1 ]; then printf '  would: %s\n' "$*"; else "$@"; fi; }
DRYTAG=; [ "$DRY" = 1 ] && DRYTAG="(dry run) "

# --- checks before anything changes ---------------------------------------------------------
[ -z "$FROM_DIR" ] || [ -z "$TARBALL" ] || fail "--from-dir and --tarball are two sources; give one"
[ -z "$MODULES_DIR" ] || [ -z "$CONTAINER" ] || fail "--modules-dir and --container both say where; give one"
[ "$FORCE_PACKAGE" = 0 ] || [ -z "$CONTAINER$MODULES_DIR" ] || fail "--package and --container/--modules-dir both say where; give one"
case "$OWNER" in ''|[0-9a-z_]*:[0-9a-z_]*) ;; *) fail "--owner is uid:gid (or user:group), e.g. 1997:1995" ;; esac
if [ -n "$TOKEN_FILE" ] && [ -z "$ZBX_URL" ]; then fail "--token-file needs --zabbix-url"; fi
if [ "$WRITE_MASTER" = 1 ]; then
  [ -n "$ZBX_URL" ] && [ -n "$PASSWORD_FILE" ] || fail "--write-master-template needs --zabbix-url and --password-file (a Super admin's password: the button is a page action, and Zabbix API tokens cannot sign in to pages)"
  [ "$UNINSTALL" = 0 ] || fail "--write-master-template and --uninstall do not go together"
fi
[ -z "$PASSWORD_FILE" ] || [ "$WRITE_MASTER" = 1 ] || fail "--password-file is only used by --write-master-template"
if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then
  [ -n "$MODULES_DIR" ] || fail "run as root (sudo), or give --modules-dir you can write to with --owner"
fi
for tool in curl tar gzip sha256sum find mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed and not installed"
done

# A secret file: a regular file, and nobody but its owner may read it.
secret_file() {
  local f=$1 what=$2 mode
  [ -f "$f" ] || fail "$what: $f is not a file"
  mode=$(stat -c '%a' "$f")
  [ $((8#$mode & 8#077)) = 0 ] || fail "$what: $f is readable by others (mode $mode) — chmod 600 $f, then run this again"
  [ -s "$f" ] || fail "$what: $f is empty"
}
[ -z "$TOKEN_FILE" ] || secret_file "$TOKEN_FILE" "--token-file"
[ -z "$PASSWORD_FILE" ] || secret_file "$PASSWORD_FILE" "--password-file"

WORK=$(mktemp -d)
chmod 700 "$WORK"
STAGES=()
cleanup() {
  local s
  for s in "${STAGES[@]+"${STAGES[@]}"}"; do [ -d "$s" ] && rm -rf "$s"; done
  rm -rf "$WORK"
}
trap cleanup EXIT
STAMP=$(date +%Y%m%d-%H%M%S)
# Two runs in one second must not share a backup folder: a second mv into an existing
# <stamp>/<id> would nest the folder instead of keeping it beside the first.
n=1; base=$STAMP
while [ -e "$BACKUP_DIR/$STAMP" ]; do STAMP=$base-$n; n=$((n+1)); done
CURL_TLS=()
[ "$INSECURE" = 1 ] && CURL_TLS=(-k)

# --- 1. the package -------------------------------------------------------------------------
PKG_DIR=
PKG_VERSION=
sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# Checks a .tar.gz against its .sha256 file, then extracts it into $WORK/pkg.
verify_and_extract() {
  local tgz=$1 sumfile=$2 want got top
  if [ -n "$sumfile" ]; then
    want=$(awk 'NR==1 {print tolower($1)}' "$sumfile")
    [[ $want =~ ^[0-9a-f]{64}$ ]] || fail "$sumfile does not hold a SHA-256"
    got=$(sha256_of "$tgz")
    [ "$got" = "$want" ] || fail "SHA-256 mismatch for $(basename "$tgz"): expected $want, got $got — not extracted, nothing changed"
    ok "SHA-256 verified ($got)"
  fi
  # No absolute paths, no .., one top-level folder. (Listed to a file first: grep -q stopping
  # early would make tar fail under pipefail and turn the check into a pass.)
  tar -tzf "$tgz" > "$WORK/listing" || fail "$(basename "$tgz") is not a readable .tar.gz"
  if grep -Eq '^/|(^|/)\.\.(/|$)' "$WORK/listing"; then fail "$(basename "$tgz") holds unsafe paths — refused"; fi
  top=$(sed 's|/.*||' "$WORK/listing" | sort -u)
  [ "$(printf '%s\n' "$top" | wc -l)" = 1 ] || fail "$(basename "$tgz") is not a release archive (more than one top-level folder)"
  mkdir -p "$WORK/pkg"
  # -m: fresh mtimes, so PHP's opcode cache sees changed files as changed.
  tar -xzf "$tgz" -m --no-same-owner --no-same-permissions -C "$WORK/pkg"
  PKG_DIR=$WORK/pkg/$top
}

if [ "$UNINSTALL" = 1 ]; then
  : # nothing to fetch
elif [ -n "$TARBALL" ]; then
  step "package: $TARBALL"
  [ -f "$TARBALL" ] || fail "$TARBALL is not a file"
  if [ -f "$TARBALL.sha256" ]; then verify_and_extract "$TARBALL" "$TARBALL.sha256"
  else note "no $TARBALL.sha256 beside it — not verified"; verify_and_extract "$TARBALL" ""; fi
elif [ -n "$FROM_DIR" ]; then
  step "package: from $FROM_DIR"
  [ -d "$FROM_DIR" ] || fail "$FROM_DIR is not a folder"
  if [ -f "$FROM_DIR/tools/zabbix-modules-tarball.sh" ]; then
    # A checkout: build the archive the release would have, and install that.
    bash "$FROM_DIR/tools/zabbix-modules-tarball.sh" --out "$WORK/built" >/dev/null
    tgz=$(ls "$WORK/built"/*.tar.gz)
    ok "built $(basename "$tgz") with tools/zabbix-modules-tarball.sh"
    verify_and_extract "$tgz" "$tgz.sha256"
  else
    # An extracted release archive (or a folder of module folders).
    [ -n "$(ls "$FROM_DIR"/*/manifest.json 2>/dev/null)" ] || fail "$FROM_DIR has no module folders (*/manifest.json) and is not a repository checkout"
    PKG_DIR=$(cd "$FROM_DIR" && pwd)
    ok "module folders in $PKG_DIR"
  fi
else
  if [ "$VERSION" = latest ]; then
    step "package: latest release of $REPO"
    # releases/latest redirects to releases/tag/<tag>; no API call, so no rate limit.
    loc=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
      || fail "cannot reach github.com — use --from-dir or --tarball on a machine without internet"
    TAG=${loc##*/}
    case "$loc" in */releases/tag/*) ;; *) fail "$REPO has no published release yet — use --version or --from-dir" ;; esac
  else
    step "package: release $VERSION of $REPO"
    case "$VERSION" in [0-9]*) TAG=v$VERSION ;; *) TAG=$VERSION ;; esac
  fi
  ASSET=elasticpro-zabbix-modules-${TAG#v}.tar.gz
  BASE=https://github.com/$REPO/releases/download/$TAG
  curl -fsSL --retry 3 -o "$WORK/$ASSET" "$BASE/$ASSET" \
    || fail "cannot download $BASE/$ASSET — release $TAG may predate the Zabbix modules asset (give --version, or --from-dir a checkout)"
  curl -fsSL --retry 3 -o "$WORK/$ASSET.sha256" "$BASE/$ASSET.sha256" \
    || fail "cannot download $BASE/$ASSET.sha256 — refusing to install an unverified archive"
  ok "downloaded $ASSET ($TAG)"
  verify_and_extract "$WORK/$ASSET" "$WORK/$ASSET.sha256"
fi

PKG_IDS=()
if [ "$UNINSTALL" = 0 ]; then
  for mf in "$PKG_DIR"/*/manifest.json; do
    d=$(dirname "$mf"); id=$(basename "$d")
    got=$(sed -n 's/^[[:space:]]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$mf" | head -1)
    [ "$got" = "$id" ] || fail "$mf says id \"$got\" in folder $id — archive damaged?"
    PKG_IDS+=("$id")
  done
  [ ${#PKG_IDS[@]} -gt 0 ] || fail "no modules in the package"
  PKG_VERSION=$(cat "$PKG_DIR/VERSION" 2>/dev/null || echo "?")
  ok "modules: ${PKG_IDS[*]} (version $PKG_VERSION)"
fi

# --- 2. where Zabbix is -----------------------------------------------------------------------
MODE=
declare -A TARGET=()   # id -> folder, when it is not $MODULES_DIR/<id>
declare -A INPLACE=()  # id -> 1: the folder is itself bind-mounted; replace its contents, keep it
WEB_USER=
NOT_MOUNTED=0          # Docker: some module has no mount into the container yet
DOCKER_HINTS=()        # volume lines for the web service
DATA_HINT=0            # Docker: EP_DATA_DIR is not set on the web container
COMPOSE_UP=

detect_web_user() {
  local root=$1 u
  # No early exit in awk: ps would take a SIGPIPE, and pipefail would end the script.
  # Only users this host knows: a Zabbix web container's php-fpm shows up in ps too, as a
  # bare uid (1997) with no account here — not the user the package frontend runs as.
  local cand
  u=
  for cand in $(ps -eo user=,comm= 2>/dev/null | awk '$2 ~ /php-fpm|httpd|apache2/ && $1 != "root" {print $1}' | awk '!seen[$0]++'); do
    id "$cand" >/dev/null 2>&1 && { u=$cand; break; }
  done
  if [ -z "$u" ] && [ -n "$root" ]; then
    u=$(stat -c '%U' "$root" 2>/dev/null || true); [ "$u" = root ] && u=
  fi
  if [ -z "$u" ]; then
    for c in www-data apache nginx; do id "$c" >/dev/null 2>&1 && { u=$c; break; }; done
  fi
  printf '%s' "$u"
}

find_frontend() {
  local c conf roots=()
  # The frontend's own config tells where the frontend is: <root>/conf/zabbix.conf.php.
  for c in /usr/share/zabbix /usr/share/zabbix/ui /usr/share/zabbix-frontend /var/www/html/zabbix /var/www/zabbix /srv/www/htdocs/zabbix; do
    roots+=("$c")
  done
  if command -v locate >/dev/null 2>&1; then
    while IFS= read -r conf; do roots+=("$(dirname "$(dirname "$conf")")"); done \
      < <(locate -l 10 -r '/conf/zabbix\.conf\.php$' 2>/dev/null || true)
  fi
  # Prefer one that is configured, then any with zabbix.php.
  for c in "${roots[@]}"; do [ -f "$c/zabbix.php" ] && [ -e "$c/conf/zabbix.conf.php" ] && { printf '%s' "$c"; return; }; done
  for c in "${roots[@]}"; do [ -f "$c/zabbix.php" ] && { printf '%s' "$c"; return; }; done
}

zabbix_web_containers() {
  # The frontend images (zabbix-web-nginx-pgsql, zabbix-web-apache-mysql …), not zabbix-web-service.
  docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | awk -F'\t' '$2 ~ /zabbix-web-(nginx|apache)/ {print $1}'
}

step "Zabbix frontend"
if [ -n "$MODULES_DIR" ]; then
  MODE=manual
  [ -n "$OWNER" ] || { WEB_USER=$(detect_web_user ""); [ -n "$WEB_USER" ] && OWNER=root:$(id -gn "$WEB_USER"); }
  [ -n "$OWNER" ] || fail "cannot tell who the files should belong to — give --owner uid:gid"
  ok "modules folder (given): $MODULES_DIR, owner $OWNER"
else
  if [ -z "$CONTAINER" ] && [ "$FORCE_PACKAGE" = 0 ] && command -v docker >/dev/null 2>&1; then
    mapfile -t found < <(zabbix_web_containers)
    if [ ${#found[@]} -gt 1 ]; then fail "more than one Zabbix web container is running (${found[*]}) — pick one with --container NAME"; fi
    if [ ${#found[@]} = 1 ]; then
      pkg_root=$(find_frontend)
      if [ -z "$pkg_root" ]; then
        CONTAINER=${found[0]}
      else
        # A package frontend AND a Zabbix web container on one host: installing into the
        # wrong one is the one mistake this must not make. --zabbix-url says which Zabbix
        # is meant: the container when it publishes that URL's port, else the package.
        if [ -n "$ZBX_URL" ]; then
          hp=${ZBX_URL#*://}; hp=${hp%%/*}
          case "$hp" in *:*) port=${hp##*:} ;; *) case "$ZBX_URL" in https:*) port=443 ;; *) port=80 ;; esac ;; esac
          published=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostPort}} {{end}}{{end}}' "${found[0]}" 2>/dev/null || true)
          if grep -qw -- "$port" <<<"$published"; then
            CONTAINER=${found[0]}
            note "a package frontend is also here ($pkg_root) — using container ${found[0]}, which publishes port $port of --zabbix-url"
          else
            note "container ${found[0]} is also running, but does not publish port $port of --zabbix-url — using the package frontend ($pkg_root)"
          fi
        else
          fail "a package frontend ($pkg_root) and a Zabbix web container (${found[0]}) are both here — say which: --package, --container ${found[0]}, or --zabbix-url"
        fi
      fi
    fi
  fi
  if [ -n "$CONTAINER" ]; then
    MODE=docker
    command -v docker >/dev/null 2>&1 || fail "--container given, but docker is not installed"
    docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "no container named $CONTAINER (docker ps)"
    [ -n "$OWNER" ] || OWNER=1997:1995   # the zabbix user and group in the official images
    ok "Docker: container $CONTAINER ($(docker inspect -f '{{.Config.Image}}' "$CONTAINER"))"
    while IFS=$'\t' read -r type src dest; do
      [ -n "$dest" ] || continue
      case "$dest" in
        /usr/share/zabbix/modules) MODULES_DIR=$src; ok "modules folder mounted from $src ($type)" ;;
        /usr/share/zabbix/modules/*)
          id=${dest#/usr/share/zabbix/modules/}
          for k in "${KNOWN_IDS[@]}"; do
            if [ "$k" = "$id" ]; then TARGET[$id]=$src; INPLACE[$id]=1; ok "$id mounted from $src"; fi
          done ;;
      esac
    done < <(docker inspect -f '{{range .Mounts}}{{.Type}}{{"\t"}}{{.Source}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}' "$CONTAINER")
    if [ -z "$MODULES_DIR" ]; then
      MODULES_DIR=/opt/elasticpro/zabbix-modules
      # Files copied into a container are gone when it is re-created; a mount is not.
      for id in "${KNOWN_IDS[@]}"; do
        [ -n "${TARGET[$id]:-}" ] || { NOT_MOUNTED=1; DOCKER_HINTS+=("      - $MODULES_DIR/$id:/usr/share/zabbix/modules/$id:ro"); }
      done
      if [ "$NOT_MOUNTED" = 1 ]; then note "not every module folder is mounted into $CONTAINER: those go to $MODULES_DIR (the volume lines to add are at the end)"
      else MODULES_DIR="(each module mounted on its own)"; fi
    fi
    # The Cluster Management page keeps roles and backups in $EP_DATA_DIR.
    envs=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER")
    if ! grep -q '^EP_DATA_DIR=' <<<"$envs"; then
      DATA_HINT=1
      note "EP_DATA_DIR is not set on $CONTAINER — Cluster Management cannot keep roles or backups until it is (lines at the end)"
    fi
    wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CONTAINER" 2>/dev/null || true)
    svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$CONTAINER" 2>/dev/null || true)
    [ -n "$svc" ] && COMPOSE_UP="cd ${wd:-<your Zabbix compose folder>} && docker compose up -d $svc"
  else
    MODE=package
    root=$(find_frontend)
    [ -n "$root" ] || fail "no Zabbix frontend found (looked for zabbix.php under /usr/share/zabbix, /var/www …, and no zabbix-web container is running) — give --modules-dir and --owner"
    MODULES_DIR=$root/modules
    WEB_USER=$(detect_web_user "$root")
    [ -n "$WEB_USER" ] || [ -n "$OWNER" ] || fail "cannot tell which user PHP runs as — give --owner root:<php group>"
    [ -n "$OWNER" ] || OWNER=root:$(id -gn "$WEB_USER")
    [ -n "$DATA_DIR" ] || DATA_DIR=/var/lib/elasticpro-zabbix
    ok "package install: frontend $root"
    ok "modules folder: $MODULES_DIR; PHP runs as ${WEB_USER:-?}; files owned by $OWNER"
    # The ElasticPro module calls the core with PHP's curl extension.
    if command -v php >/dev/null 2>&1 && ! grep -qi '^curl$' <<<"$(php -m 2>/dev/null || true)"; then
      note "PHP has no curl extension here (php -m) — install php-curl (or php8.x-curl), or ElasticPro cannot sign people in"
    fi
  fi
fi

# --- the Zabbix API ----------------------------------------------------------------------------
API_CFG=
if [ -n "$TOKEN_FILE" ]; then
  # The token goes to curl in a config file, not on its command line (where ps shows it).
  token=$(head -n1 "$TOKEN_FILE" | tr -d '[:space:]')
  [[ $token =~ ^[A-Za-z0-9]+$ ]] || fail "--token-file: the first line is not an API token"
  API_CFG=$WORK/api.cfg
  (umask 077; printf 'header = "Authorization: Bearer %s"\n' "$token" > "$API_CFG")
  unset token
fi
api() {   # api <method> <params json> [noauth]
  local body cfg=()
  body=$(printf '{"jsonrpc":"2.0","method":"%s","params":%s,"id":1}' "$1" "$2")
  [ "${3:-}" = noauth ] || cfg=(-K "$API_CFG")
  # Always "succeeds": a failed call comes back as an error object, so set -e does not end the
  # script halfway through without a word.
  curl -sS "${CURL_TLS[@]+"${CURL_TLS[@]}"}" --max-time 30 "${cfg[@]+"${cfg[@]}"}" \
    -H 'Content-Type: application/json-rpc' --data-binary "$body" "$ZBX_URL/api_jsonrpc.php" \
    || printf '{"error":{"code":0,"data":"no answer from %s/api_jsonrpc.php"}}' "$ZBX_URL"
}
api_error() { sed -n 's/.*"error":{[^}]*"data":"\([^"]*\)".*/\1/p' <<<"$1"; }
field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" <<<"$2" | head -1; }

ENABLED_VIA_API=0
if [ -n "$API_CFG" ]; then
  step "Zabbix API at $ZBX_URL"
  r=$(api apiinfo.version '[]' noauth) || fail "cannot reach $ZBX_URL/api_jsonrpc.php${CURL_TLS[*]:+ }${CURL_TLS[*]:-} (self-signed certificate? add --insecure)"
  ver=$(sed -n 's/.*"result":"\([^"]*\)".*/\1/p' <<<"$r")
  [ -n "$ver" ] || fail "$ZBX_URL/api_jsonrpc.php did not answer like Zabbix"
  case "$ver" in 7.0.*) ok "Zabbix $ver" ;; *) note "Zabbix $ver — these modules are made for 7.0" ;; esac
  r=$(api module.get '{"output":["moduleid"],"limit":1}')
  e=$(api_error "$r"); [ -z "$e" ] || fail "the API token was refused: $e (it must be a Super admin's token)"
fi

# --- 3. modules --------------------------------------------------------------------------------
dst_of() { printf '%s' "${TARGET[$1]:-$MODULES_DIR/$1}"; }

# Content of a module folder, as a sorted checksum list; local settings (config.php) left out.
content_sum() {
  (cd "$1" && find . -type f ! -path ./config.php ! \( -path './config.php.*' ! -path ./config.php.example \) -print0 \
     | LC_ALL=C sort -z | xargs -0 -r sha256sum) | sha256sum | awk '{print $1}'
}

# Owner and modes: folders 0755, files 0644. config.php is left exactly as it was.
set_perms() {
  local dir=$1
  chown -R "$OWNER" "$dir"
  find "$dir" -type d -exec chmod 0755 {} +
  find "$dir" -type f -exec chmod 0644 {} +
}

# The files a person put there: config.php and its copies, not the shipped example.
local_files() { find "$1" -maxdepth 1 -type f \( -name config.php -o \( -name 'config.php.*' ! -name config.php.example \) \) 2>/dev/null; }

module_ok_to_touch() {   # is <dir> one of ours? (its manifest names the id we expect)
  local dir=$1 id=$2
  [ -f "$dir/manifest.json" ] || return 1
  [ "$(sed -n 's/^[[:space:]]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/manifest.json" | head -1)" = "$id" ]
}

INSTALLED=()   # "id|folder|what happened"
BACKED_UP=0

install_module() {
  local id=$1 src=$PKG_DIR/$1 dst stage old parent f
  dst=$(dst_of "$id")
  if [ -d "$dst" ] && [ -f "$dst/manifest.json" ] && ! module_ok_to_touch "$dst" "$id"; then
    fail "$dst holds a different module (its manifest.json is not \"$id\") — not touched"
  fi
  if [ -d "$dst" ] && [ -f "$dst/manifest.json" ] && [ "$(content_sum "$dst")" = "$(content_sum "$src")" ]; then
    if [ "$DRY" = 1 ]; then say "  would: set owner $OWNER and modes 0755/0644 on $dst (config.php left as is)"; else set_perms_keep "$dst"; fi
    INSTALLED+=("$id|$dst|already this version")
    ok "$id: already this version ($dst)"
    return
  fi
  local what=installed
  [ -f "$dst/manifest.json" ] && what="updated (previous kept in $BACKUP_DIR/$STAMP/$id)"

  if [ -n "${INPLACE[$id]:-}" ]; then
    # This folder is bind-mounted into the container on its own: a folder renamed or re-made
    # under a running container vanishes from it, so its contents are replaced instead.
    if [ "$DRY" = 1 ]; then
      say "  would: copy $dst to $BACKUP_DIR/$STAMP/$id, then replace its contents (keeping config.php) — it is mounted into $CONTAINER by itself"
    else
      stage=$WORK/stage-$id
      cp -a "$src" "$stage"
      set_perms "$stage"
      if [ -f "$dst/manifest.json" ]; then
        mkdir -p "$BACKUP_DIR/$STAMP"; cp -a "$dst" "$BACKUP_DIR/$STAMP/$id"; BACKED_UP=1
      fi
      mkdir -p "$dst"
      find "$dst" -mindepth 1 -maxdepth 1 ! -name config.php ! \( -name 'config.php.*' ! -name config.php.example \) -exec rm -rf {} +
      cp -a "$stage/." "$dst/"
      chown "$OWNER" "$dst"; chmod 0755 "$dst"
    fi
  else
    # Staged next to the modules folder (not in it, where Zabbix's Scan directory would see a
    # second copy), then renamed in.
    parent=$(dirname "$dst")
    if [ "$DRY" = 1 ]; then
      say "  would: stage $id in $(dirname "$parent"), carry over config.php if any, rename into $dst${what:+ ($what)}"
    else
      mkdir -p "$parent"
      stage=$(mktemp -d "$(dirname "$parent")/.ep-$id.XXXXXX"); STAGES+=("$stage")
      cp -a "$src/." "$stage/"
      set_perms "$stage"
      if [ -d "$dst" ]; then
        while IFS= read -r f; do cp -p "$f" "$stage/"; done < <(local_files "$dst")
        old=$(dirname "$parent")/.ep-$id.old-$STAMP
        mv "$dst" "$old"; STAGES+=("$old")
        mv "$stage" "$dst"
        if [ -f "$old/manifest.json" ]; then
          mkdir -p "$BACKUP_DIR/$STAMP"; mv "$old" "$BACKUP_DIR/$STAMP/$id"; BACKED_UP=1
        fi
      else
        mv "$stage" "$dst"
      fi
    fi
  fi
  INSTALLED+=("$id|$dst|$what")
  ok "$id: ${DRYTAG}$what → $dst"
}
# Unchanged module: only owner and modes, config.php left alone.
set_perms_keep() {
  local dir=$1
  find "$dir" ! -path "$dir/config.php" ! \( -path "$dir/config.php.*" ! -path "$dir/config.php.example" \) -exec chown "$OWNER" {} +
  find "$dir" -type d -exec chmod 0755 {} +
  find "$dir" -type f ! -path "$dir/config.php" ! \( -path "$dir/config.php.*" ! -path "$dir/config.php.example" \) -exec chmod 0644 {} +
}

uninstall_module() {
  local id=$1 dst old
  dst=$(dst_of "$id")
  if [ ! -f "$dst/manifest.json" ]; then say "  - $id: not installed at $dst"; return; fi
  module_ok_to_touch "$dst" "$id" || { note "$id: $dst holds a different module — left alone"; return; }
  if [ -n "${INPLACE[$id]:-}" ]; then
    if [ "$DRY" = 1 ]; then say "  would: copy $dst to $BACKUP_DIR/$STAMP/$id and empty it (config.php kept; it is mounted into $CONTAINER)"
    else
      mkdir -p "$BACKUP_DIR/$STAMP"; cp -a "$dst" "$BACKUP_DIR/$STAMP/$id"; BACKED_UP=1
      find "$dst" -mindepth 1 -maxdepth 1 ! -name config.php ! \( -name 'config.php.*' ! -name config.php.example \) -exec rm -rf {} +
    fi
    INSTALLED+=("$id|$dst|removed (emptied; remove its volume line from the web container)")
  else
    if [ "$DRY" = 1 ]; then say "  would: move $dst to $BACKUP_DIR/$STAMP/$id"
    else
      old=$(dirname "$(dirname "$dst")")/.ep-$id.old-$STAMP
      mv "$dst" "$old"; STAGES+=("$old")   # gone from Zabbix at once, even if the backup is on another disk
      mkdir -p "$BACKUP_DIR/$STAMP"; mv "$old" "$BACKUP_DIR/$STAMP/$id"; BACKED_UP=1
    fi
    INSTALLED+=("$id|$dst|removed")
  fi
  ok "$id: ${DRYTAG}removed from $dst"
}

# Registers and enables (or disables) one module through module.get / module.create / module.update.
API_RESULTS=()
api_module() {
  local id=$1 want=$2 r e mid st
  r=$(api module.get "{\"output\":[\"moduleid\",\"status\"],\"filter\":{\"id\":\"$id\"}}")
  e=$(api_error "$r"); [ -z "$e" ] || { API_RESULTS+=("$id: module.get failed: $e"); return; }
  mid=$(field moduleid "$r"); st=$(field status "$r")
  if [ "$want" = 0 ]; then
    if [ -z "$mid" ] || [ "$st" = 0 ]; then API_RESULTS+=("$id: not enabled in Zabbix"); return; fi
    if [ "$DRY" = 1 ]; then API_RESULTS+=("$id: would disable (module.update)"); return; fi
    r=$(api module.update "{\"moduleid\":\"$mid\",\"status\":0}")
    e=$(api_error "$r"); API_RESULTS+=("$id: ${e:+not disabled: }${e:-disabled}")
    return
  fi
  if [ -z "$mid" ]; then
    if [ "$DRY" = 1 ]; then API_RESULTS+=("$id: would register and enable (module.create)"); return; fi
    r=$(api module.create "{\"id\":\"$id\",\"relative_path\":\"modules/$id\",\"status\":1}")
    e=$(api_error "$r")
    if [ -n "$e" ]; then API_RESULTS+=("$id: not registered: $e"); else API_RESULTS+=("$id: registered and enabled"); ENABLED_VIA_API=$((ENABLED_VIA_API+1)); fi
  elif [ "$st" = 1 ]; then
    API_RESULTS+=("$id: already enabled"); ENABLED_VIA_API=$((ENABLED_VIA_API+1))
  else
    if [ "$DRY" = 1 ]; then API_RESULTS+=("$id: would enable (module.update)"); return; fi
    r=$(api module.update "{\"moduleid\":\"$mid\",\"status\":1}")
    e=$(api_error "$r")
    if [ -n "$e" ]; then API_RESULTS+=("$id: not enabled: $e"); else API_RESULTS+=("$id: enabled"); ENABLED_VIA_API=$((ENABLED_VIA_API+1)); fi
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  if [ -n "$API_CFG" ]; then
    step "disabling in Zabbix first"
    for id in "${KNOWN_IDS[@]}"; do api_module "$id" 0; done
    for l in "${API_RESULTS[@]}"; do say "  - $l"; done
  else
    note "disable the modules in Zabbix before this (Administration → General → Modules → Disable): a module folder that disappears while enabled leaves its menu entries pointing nowhere"
  fi
  step "removing modules (backups in $BACKUP_DIR/$STAMP)"
  for id in "${KNOWN_IDS[@]}"; do uninstall_module "$id"; done
else
  step "modules → $MODULES_DIR"
  case "$MODULES_DIR" in /*) [ -d "$MODULES_DIR" ] || run mkdir -p "$MODULES_DIR" ;; esac
  for id in "${PKG_IDS[@]}"; do install_module "$id"; done
  [ "$BACKED_UP" = 1 ] && say "  previous versions kept in $BACKUP_DIR/$STAMP"

  # The Cluster Management page's writable folder (package installs; Docker uses a volume).
  if [ -n "$DATA_DIR" ] && [ "$MODE" != docker ]; then
    step "data folder → $DATA_DIR"
    data_owner=${WEB_USER:-${OWNER%%:*}}
    if [ -d "$DATA_DIR" ] && [ "$(stat -c '%U %a' "$DATA_DIR")" = "$(id -un "$data_owner" 2>/dev/null || echo "$data_owner") 770" ]; then
      ok "already there, writable by $data_owner"
    else
      run mkdir -p "$DATA_DIR"
      run chown "$data_owner" "$DATA_DIR"
      run chmod 0770 "$DATA_DIR"
      ok "writable by $data_owner"
    fi
    [ "$DATA_DIR" = /var/lib/elasticpro-zabbix ] || note "not the default folder: set EP_DATA_DIR=$DATA_DIR in PHP's environment (php-fpm pool: env[EP_DATA_DIR] = $DATA_DIR)"
  fi

  if [ -n "$API_CFG" ]; then
    step "registering in Zabbix"
    if [ "$NOT_MOUNTED" = 1 ]; then
      note "not every module is mounted into $CONTAINER yet — add the volume lines below, re-create the container, then run this again to enable them"
    else
      for id in "${PKG_IDS[@]}"; do api_module "$id" 1; done
      for l in "${API_RESULTS[@]}"; do say "  - $l"; done
    fi
  fi
fi

# --- 4. Write master template (the ep_clients page action) -------------------------------------
MASTER_DONE=
if [ "$WRITE_MASTER" = 1 ]; then
  step "Cluster Management → Write master template"
  if [ "$DRY" = 1 ]; then
    say "  would: sign in to $ZBX_URL as $ZBX_USER, open Cluster Management, and press Write master template if it asks"
  else
    jar=$WORK/cookies; pw=$WORK/pw; cfg=$WORK/login.cfg
    (umask 077
     printf '%s' "$(head -n1 "$PASSWORD_FILE" | tr -d '\r\n')" > "$pw"
     # curl config quoting: backslash and double quote escaped.
     u=$(printf '%s' "$ZBX_USER" | sed 's/[\\"]/\\&/g')
     printf 'data-urlencode = "name=%s"\ndata-urlencode = "password@%s"\ndata-urlencode = "enter=Sign in"\n' "$u" "$pw" > "$cfg")
    # A good sign-in answers with a redirect to the dashboard; a refused one draws the form again.
    code=$(curl -sS "${CURL_TLS[@]+"${CURL_TLS[@]}"}" --max-time 30 -c "$jar" -b "$jar" -K "$cfg" -o /dev/null -w "%{http_code}" "$ZBX_URL/index.php") \
      || fail "cannot reach $ZBX_URL/index.php"
    rm -f "$pw" "$cfg"
    [ "$code" = 302 ] || fail "Zabbix did not sign $ZBX_USER in (wrong password, MFA/SSO on that user, or locked out for a while after failed sign-ins) — press Write master template in the UI instead"
    page=$(curl -sS "${CURL_TLS[@]+"${CURL_TLS[@]}"}" --max-time 60 -c "$jar" -b "$jar" "$ZBX_URL/zabbix.php?action=ep.clients.list")
    if ! grep -q 'class="ep-l' <<<"$page"; then
      fail "Cluster Management did not open for $ZBX_USER (is ep_clients enabled, and is $ZBX_USER a Super admin?)"
    fi
    grep -q 'class="ep-l ep-ro' <<<"$page" && fail "Cluster Management is read-only for $ZBX_USER — Write master template needs a Super admin"
    csrf=$(grep -o 'action=ep\.clients\.template\.install"[^>]*><input type="hidden" name="_csrf_token" value="[^"]*"' <<<"$page" | head -1 | sed 's/.*value="//; s/"$//' || true)
    if [ -z "$csrf" ]; then
      ok "the master template is already current — nothing to write"; MASTER_DONE=1
    else
      printf 'data-urlencode = "_csrf_token=%s"\n' "$csrf" > "$cfg"
      out=$(curl -sS "${CURL_TLS[@]+"${CURL_TLS[@]}"}" --max-time 120 -c "$jar" -b "$jar" -K "$cfg" "$ZBX_URL/zabbix.php?action=ep.clients.template.install")
      # Zabbix 7.0 answers a page action with a self-submitting form; the notice it would show
      # travels in it as base64 JSON: {"messages":{"success"|"error":title,"messages":[…]}}.
      msg=$(sed -n 's/.*id="data" name="data" value="\([^"]*\)".*/\1/p' <<<"$out" | head -1 | base64 -d 2>/dev/null || true)
      if grep -q '"success":"Master template written' <<<"$msg"; then
        ok "written (the page's own action: master, cluster devices and jump host templates)"; MASTER_DONE=1
      elif grep -q '"error":"Master template not written' <<<"$msg"; then
        why=$(grep -o '"type":"error","message":"[^"]*' <<<"$msg" | head -1 | sed 's/.*"message":"//' || true)
        note "not written: ${why:-see Cluster Management in Zabbix for the reason}"
      else
        note "no answer from the page — open ElasticPro → Cluster Management and check"
      fi
    fi
    # Sign out, as the menu's Sign out does, so the session does not linger.
    bye=$(grep -o 'ZABBIX.logout(this.dataset.csrf_token)" data-csrf_token="[^"]*"' <<<"$page" | head -1 | sed 's/.*data-csrf_token="//; s/"$//' || true)
    if [ -n "$bye" ]; then
      printf 'data-urlencode = "_csrf_token=%s"\n' "$bye" > "$cfg"
      curl -sS "${CURL_TLS[@]+"${CURL_TLS[@]}"}" --max-time 15 -b "$jar" -K "$cfg" -o /dev/null "$ZBX_URL/index.php?reconnect=1" || true
    fi
  fi
fi

# --- summary ----------------------------------------------------------------------------------
step "summary"
if [ "$UNINSTALL" = 1 ]; then
  say "Removed ElasticPro Zabbix modules:"
else
  say "ElasticPro Zabbix modules $PKG_VERSION ($MODE install):"
fi
for l in "${INSTALLED[@]+"${INSTALLED[@]}"}"; do
  IFS='|' read -r id where what <<<"$l"
  printf '  %-14s %s — %s\n' "$id" "$where" "$what"
done
[ "$BACKED_UP" = 1 ] && say "  backups: $BACKUP_DIR/$STAMP"

if { [ ${#DOCKER_HINTS[@]} -gt 0 ] || [ "$DATA_HINT" = 1 ]; } && [ "$UNINSTALL" = 0 ]; then
  say ""
  say "Add to the Zabbix web service in its compose file, then re-create the container:"
  if [ "$DATA_HINT" = 1 ]; then
    say "    environment:"
    say "      EP_DATA_DIR: /var/lib/zabbix/elasticpro    # Cluster Management's roles and backups"
  fi
  say "    volumes:"
  for l in "${DOCKER_HINTS[@]+"${DOCKER_HINTS[@]}"}"; do say "$l"; done
  if [ "$DATA_HINT" = 1 ]; then
    say "      - ep-data:/var/lib/zabbix"
    say "  and at the top level of the file:"
    say "    volumes:"
    say "      ep-data:        # a named volume starts owned by the image's zabbix user"
  fi
  [ -n "$COMPOSE_UP" ] && say "  then: $COMPOSE_UP"
fi

if [ "$UNINSTALL" = 1 ]; then
  say ""
  say "In Zabbix, Administration → General → Modules: the removed modules can be deleted from the list."
  [ -n "${TARGET[*]:-}" ] && say "Remove their volume lines from the web container, then: ${COMPOSE_UP:-docker compose up -d <web service>}"
else
  say ""
  say "Left to do in Zabbix:"
  n=1
  if [ "$ENABLED_VIA_API" -lt ${#PKG_IDS[@]} ]; then
    say "  $n. Administration → General → Modules → Scan directory, then enable the five ElasticPro modules"; n=$((n+1))
  fi
  if [ -z "$MASTER_DONE" ]; then
    say "  $n. ElasticPro → Cluster Management → Write master template (when the page asks)"; n=$((n+1))
  fi
  [ "$MODE" = package ] && say "  $n. reload PHP so its opcode cache drops old code: systemctl reload php-fpm (or php8.x-fpm / apache2 / httpd)"
  say ""
  say "Then connect the two:"
  say "  ElasticPro → Config → Zabbix → Pair with Zabbix (copy the code)"
  say "  Zabbix → Administration → ElasticPro → paste the code → Pair"
fi
[ "$DRY" = 1 ] && say "" && say "(dry run: nothing was changed)"
exit 0
