#!/usr/bin/env bash
# deploy.sh --upgrade and the compose file (deploy/README.md "Upgrading to 0.3.54 or later"),
# checked with --dry-run against a throwaway install and a release mirror on disk
# (ELASTICPRO_RELEASE_URL=file://…), so nothing is fetched, pulled or started:
#
#   1. a file exactly as the running release shipped it is replaced (adds the worker);
#   2. so is one as an OLDER release shipped it, found by the file's own image pins — a
#      deploy.sh from before 0.3.54 upgraded the images and left the file behind;
#   3. a file edited by hand is refused, and so is one whose pins disagree;
#   4. --replace-compose replaces an edited file;
#   5. a dry run never changes the file.
#
# The mirror's releases are made from today's deploy/docker-compose.yml: the target is it as
# it is, an older release is it without the worker and with its pins set to that version.
#
#   tools/compose-upgrade-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fail=1; }

# A release's compose file: today's, pins at $1; without the worker unless $2 = worker.
release() {
  local f=$T/mirror/v$1/deploy/docker-compose.yml
  mkdir -p "$(dirname "$f")"
  sed -E "s/(elasticpro-(nginx|postgres|redis)):[0-9]+\.[0-9]+\.[0-9]+/\1:$1/" deploy/docker-compose.yml > "$f"
  [ "${2:-}" = worker ] || sed -i.bak 's/^  worker:/  worker_was_not_here_yet:/' "$f"
  rm -f "$f.bak"
}
release 9.9.0 worker   # the target
release 9.8.0          # running now
release 9.7.0          # the one before (ELASTICPRO_IMAGE_PREVIOUS)
release 9.1.0          # installed with, long ago

mkdir -p "$T/inst"
cp -R deploy "$T/inst/deploy"
cp Cargo.toml "$T/inst/"
rm -rf "$T/inst/deploy/.env" "$T/inst/deploy/secrets"
mkdir -p "$T/inst/deploy/secrets"
echo not-a-real-password > "$T/inst/deploy/secrets/db_password"
cat > "$T/inst/deploy/.env" <<EOF
ELASTICPRO_IMAGE=karthickdk02/elasticpro-core:9.8.0
ELASTICPRO_NGINX_IMAGE=karthickdk02/elasticpro-nginx:9.8.0
ELASTICPRO_DB_IMAGE=karthickdk02/elasticpro-postgres:9.8.0
ELASTICPRO_IMAGE_PREVIOUS=karthickdk02/elasticpro-core:9.7.0
EOF

# Puts $1 in place as the install's compose file, dry-runs the upgrade to 9.9.0 with the rest
# of the arguments; OUT is what it said, RC how it ended, and the file must be as it was.
OUT=; RC=0
try() {
  local file=$1; shift
  cp "$file" "$T/inst/deploy/docker-compose.yml"
  cp "$file" "$T/before.yml"
  RC=0
  OUT=$(cd "$T/inst/deploy" && ELASTICPRO_RELEASE_URL="file://$T/mirror" COMPOSE_PROJECT_NAME=ep-compose-check-none \
        ./deploy.sh --upgrade=9.9.0 --dry-run "$@" 2>&1) || RC=$?
  cmp -s "$T/before.yml" "$T/inst/deploy/docker-compose.yml" || bad "a dry run changed the compose file ($*)"
}
says() { case $OUT in *"$1"*) return 0 ;; esac; return 1; }

echo "== deploy.sh --upgrade: the compose file"
try "$T/mirror/v9.8.0/deploy/docker-compose.yml"
says "as 9.8.0 shipped it" && [ $RC = 0 ] && ok "the running release's file is replaced" \
  || bad "the running release's file (rc $RC): $OUT"

try "$T/mirror/v9.7.0/deploy/docker-compose.yml"
says "as 9.7.0 shipped it" && [ $RC = 0 ] && ok "the previous release's file is replaced" \
  || bad "the previous release's file (rc $RC): $OUT"

try "$T/mirror/v9.1.0/deploy/docker-compose.yml"
says "as 9.1.0 shipped it" && [ $RC = 0 ] && ok "an older release's file is found by its pins and replaced" \
  || bad "an older release's file (rc $RC): $OUT"

sed 's/restart: unless-stopped/restart: always/' "$T/mirror/v9.1.0/deploy/docker-compose.yml" > "$T/edited.yml"
try "$T/edited.yml"
says "it was edited here" && [ $RC != 0 ] && ok "an edited file is refused" \
  || bad "an edited file was not refused (rc $RC): $OUT"

sed -E 's/elasticpro-nginx:9\.1\.0/elasticpro-nginx:9.4.0/' "$T/mirror/v9.1.0/deploy/docker-compose.yml" > "$T/mixed.yml"
try "$T/mixed.yml"
says "it was edited here" && [ $RC != 0 ] && ok "a file whose pins disagree is refused" \
  || bad "a file whose pins disagree was not refused (rc $RC): $OUT"

try "$T/edited.yml" --replace-compose
says "(--replace-compose)" && [ $RC = 0 ] && ok "--replace-compose replaces an edited file" \
  || bad "--replace-compose (rc $RC): $OUT"

[ $fail = 0 ] && echo "ok" || { echo "FAILED"; exit 1; }
