#!/usr/bin/env bash
# Deploy (or update) hosted ElasticPro in one step, with automatic rollback.
#
#   deploy/deploy.sh                          # build this checkout and run it
#   deploy/deploy.sh --pull                   # git pull first
#   deploy/deploy.sh --image repo/core:0.1.0  # run an image built elsewhere (no build here)
#   deploy/deploy.sh --rollback               # back to the image that ran before the last deploy
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
# Options: --pull, --image TAG, --rollback, --all, --timeout SECONDS (default 180), --dry-run
set -euo pipefail
cd "$(dirname "$0")"

PULL=0; IMAGE=; ROLLBACK=0; ALL=0; TIMEOUT=180; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pull) PULL=1; shift ;;
    --image) IMAGE=$2; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    --all) ALL=1; shift ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { say "✗ $*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then say "  would: $*"; else "$@"; fi; }
env_get() { sed -n "s/^$1=//p" .env | tail -1; }
env_set() {   # KEY VALUE — replace the line, or add it
  if [ "$DRY" = 1 ]; then say "  would: set $1=$2 in .env"; return; fi
  if grep -q "^$1=" .env; then sed -i.tmp "s|^$1=.*|$1=$2|" .env && rm -f .env.tmp; else printf '%s=%s\n' "$1" "$2" >> .env; fi
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

# --- 1. checks --------------------------------------------------------------------------
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is needed (docker compose …)"
[ -f .env ] || fail "deploy/.env is missing — a first install starts with README.md (Install)"
[ -f secrets/db_password ] || fail "deploy/secrets/db_password is missing — see README.md (Install, step 4)"

CURRENT=$(env_get ELASTICPRO_IMAGE)
CURRENT=${CURRENT:-elasticpro-core:latest}
PREVIOUS_BEFORE=$(env_get ELASTICPRO_IMAGE_PREVIOUS)

# --- rollback only ----------------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  PREV=$(env_get ELASTICPRO_IMAGE_PREVIOUS)
  [ -n "$PREV" ] || fail "no previous image recorded (ELASTICPRO_IMAGE_PREVIOUS in .env)"
  docker image inspect "$PREV" >/dev/null 2>&1 || fail "the previous image $PREV is no longer on this machine"
  say "== rollback: $CURRENT → $PREV"
  env_set ELASTICPRO_IMAGE "$PREV"
  env_set ELASTICPRO_IMAGE_PREVIOUS "$CURRENT"
  run docker compose up -d core
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
  if wait_healthy; then say "✓ back on $CURRENT, healthy"; else say "✗ not healthy on $CURRENT either — docker compose logs core"; fi
fi
exit 1
