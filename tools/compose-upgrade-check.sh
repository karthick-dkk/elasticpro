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
#   5. a dry run never changes the file;
#   6. a file that still has the db service (PostgreSQL, gone from the stack) is replaced: the
#      db goes with --remove-orphans, its volume is kept, elasticpro-postgres is never pulled,
#      and ELASTICPRO_DB_IMAGE leaves .env (kept as _PREVIOUS); an edited one is left alone
#      with a note, and the upgrade goes on;
#   7. the same upgrade for real, then --rollback (the db file and image back) and --rollback
#      again — against a stand-in `docker` that records what it was asked, so nothing starts.
#
# The mirror's releases are made from today's deploy/docker-compose.yml: the target is it as
# it is, an older release is it without the worker (and with the db it had then) and with its
# pins set to that version.
#
#   tools/compose-upgrade-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fail=1; }

# The db service as releases up to 0.3.76 shipped it, the secret and the volume with it.
cat > "$T/db-service.yml" <<'EOF'
  db:
    image: ${ELASTICPRO_DB_IMAGE:-karthickdk02/elasticpro-postgres:0.0.0}
    restart: unless-stopped
    environment:
      POSTGRES_DB: elasticpro
      POSTGRES_USER: elasticpro
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    volumes:
      - db-data:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U elasticpro"]
      interval: 10s

secrets:
  db_password:
    file: ./secrets/db_password

EOF

# A release's compose file: today's, pins at $1; with the worker when $2 has `worker`, with the
# db when it has `db`.
release() {
  local f=$T/mirror/v$1/deploy/docker-compose.yml
  mkdir -p "$(dirname "$f")"
  if case " ${2:-} " in *" db "*) true ;; *) false ;; esac; then
    awk -v svc="$T/db-service.yml" '
      /^volumes:/ { while ((getline l < svc) > 0) print l }
      { print }
      /^  core-data:/ { print "  db-data:" }' deploy/docker-compose.yml > "$f"
  else
    cp deploy/docker-compose.yml "$f"
  fi
  sed -i.bak -E "s/(elasticpro-(nginx|postgres|redis)):[0-9]+\.[0-9]+\.[0-9]+/\1:$1/" "$f"
  case " ${2:-} " in *" worker "*) ;; *) sed -i.bak 's/^  worker:/  worker_was_not_here_yet:/' "$f" ;; esac
  rm -f "$f.bak"
}
release 9.9.0 worker      # the target: no db
release 9.8.0 db          # running now
release 9.7.0 db          # the one before (ELASTICPRO_IMAGE_PREVIOUS)
release 9.6.0 "worker db" # a release with the worker and still the db
release 9.1.0 db          # installed with, long ago

mkdir -p "$T/inst"
cp -R deploy "$T/inst/deploy"
cp Cargo.toml "$T/inst/"
rm -rf "$T/inst/deploy/.env" "$T/inst/deploy/secrets" "$T/inst/deploy/.compose-previous" "$T/inst/deploy"/docker-compose.yml.bak-*
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
says "(--replace-compose" && [ $RC = 0 ] && ok "--replace-compose replaces an edited file" \
  || bad "--replace-compose (rc $RC): $OUT"

echo "== deploy.sh --upgrade: the db service leaves (dry run)"
try "$T/mirror/v9.6.0/deploy/docker-compose.yml"
says "as 9.6.0 shipped it" && says "takes out the unused PostgreSQL service db" && [ $RC = 0 ] \
  && ok "a file with the worker and the db, as a release shipped it, is replaced" \
  || bad "a file with the db (rc $RC): $OUT"
says "would: docker compose up -d --remove-orphans" && ok "the stack comes up with --remove-orphans (the db container goes)" \
  || bad "no --remove-orphans: $OUT"
says "ep-compose-check-none_db-data is kept" && says "docker volume rm ep-compose-check-none_db-data" \
  && ok "the db-data volume is kept, and the way to delete it by hand is named" || bad "no volume note: $OUT"
says "would: remove ELASTICPRO_DB_IMAGE from .env" && says "would: set ELASTICPRO_DB_IMAGE_PREVIOUS=karthickdk02/elasticpro-postgres:9.8.0" \
  && ok "ELASTICPRO_DB_IMAGE leaves .env, kept as ELASTICPRO_DB_IMAGE_PREVIOUS" || bad "ELASTICPRO_DB_IMAGE in .env: $OUT"
says "elasticpro-postgres:9.9.0" && bad "elasticpro-postgres:9.9.0 was planned: $OUT" || ok "elasticpro-postgres is not pulled or set"
case $OUT in *"would: docker volume"*|*"would: docker compose down"*) bad "a volume would be removed: $OUT" ;; *) ok "nothing removes a volume" ;; esac

sed 's/restart: unless-stopped/restart: always/' "$T/mirror/v9.6.0/deploy/docker-compose.yml" > "$T/edited-db.yml"
try "$T/edited-db.yml"
says "still has the db service" && says "left as it is" && [ $RC = 0 ] \
  && ok "an edited file with the db is left alone, with a note, and the upgrade goes on" \
  || bad "an edited file with the db (rc $RC): $OUT"
says "would: docker compose up -d --remove-orphans" && bad "the edited file's db would be removed: $OUT" || ok "the edited file's db keeps running (no --remove-orphans)"
says "would: remove ELASTICPRO_DB_IMAGE" && bad "ELASTICPRO_DB_IMAGE removed although the db stays: $OUT" || ok "ELASTICPRO_DB_IMAGE stays while the file has the db"

# --- 7. for real, against a stand-in docker --------------------------------------------------
# Answers what deploy.sh asks: every container healthy, the services read from the compose file,
# an image "here" once pulled (or seeded), and every call written to $SHIM_LOG.
mkdir -p "$T/bin"
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SHIM_LOG"
case "$1 ${2:-}" in
  "compose version") echo "Docker Compose version v2-shim" ;;
  "compose config")
    case " $* " in
      *" --services "*) awk '/^services:/{f=1;next} /^[^ #]/{f=0} f && /^  [a-z_-]+:/{sub(/:.*/,"");sub(/^  /,"");print}' docker-compose.yml ;;
      *" -q "*) ;;
      *) echo "name: shimproj" ;;
    esac ;;
  "compose ps") case " $* " in *" -q "*) echo "shim-${*: -1}" ;; esac ;;
  "inspect "*) echo healthy ;;
  "image inspect") grep -qxF "$3" "$SHIM_IMAGES"; exit $? ;;
  "pull "*) printf '%s\n' "${*: -1}" >> "$SHIM_IMAGES" ;;
esac
exit 0
EOF
chmod +x "$T/bin/docker"

R=$T/real/deploy
mkdir -p "$T/real"
cp -R "$T/inst/deploy" "$R"; cp Cargo.toml "$T/real/"
cp "$T/mirror/v9.6.0/deploy/docker-compose.yml" "$R/docker-compose.yml"
cat > "$R/.env" <<EOF
ELASTICPRO_IMAGE=karthickdk02/elasticpro-core:9.6.0
ELASTICPRO_NGINX_IMAGE=karthickdk02/elasticpro-nginx:9.6.0
ELASTICPRO_DB_IMAGE=karthickdk02/elasticpro-postgres:9.6.0
EOF
printf '%s\n' karthickdk02/elasticpro-core:9.6.0 karthickdk02/elasticpro-nginx:9.6.0 karthickdk02/elasticpro-postgres:9.6.0 > "$T/images"
real() {
  RC=0
  : > "$T/shim.log"
  OUT=$(cd "$R" && PATH="$T/bin:$PATH" SHIM_LOG="$T/shim.log" SHIM_IMAGES="$T/images" ELASTICPRO_RELEASE_URL="file://$T/mirror" \
        ./deploy.sh --timeout 5 "$@" 2>&1) || RC=$?
  LOG=$(cat "$T/shim.log")
}
env_is() { [ "$(sed -n "s/^$1=//p" "$R/.env" | tail -1)" = "$2" ]; }
no_volume_touched() {
  case $LOG in *"volume rm"*|*"compose down"*|*" -v "*|*"--volumes"*) bad "$1: a volume was removed: $LOG" ;; *) ok "$1: no volume was removed" ;; esac
}

echo "== deploy.sh --upgrade from a compose file with the db, for real, then --rollback"
real --upgrade=9.9.0
[ $RC = 0 ] && ok "the upgrade ran" || bad "the upgrade (rc $RC): $OUT"
cmp -s "$R/docker-compose.yml" "$T/mirror/v9.9.0/deploy/docker-compose.yml" && ok "the 9.9.0 file (no db) is in place" || bad "the compose file is not the 9.9.0 one"
prev=$(head -1 "$R/.compose-previous" 2>/dev/null || true)
[ -n "$prev" ] && cmp -s "$R/$prev" "$T/mirror/v9.6.0/deploy/docker-compose.yml" && ok "the old file (with the db) is kept as $prev, named in .compose-previous" \
  || bad "no backup of the old file named in .compose-previous ($prev)"
case $LOG in *"compose up -d --remove-orphans"*) ok "docker compose up -d --remove-orphans: the db container goes" ;; *) bad "no up --remove-orphans: $LOG" ;; esac
case $LOG in *"pull"*"postgres"*) bad "elasticpro-postgres was pulled: $LOG" ;; *) ok "elasticpro-postgres was not pulled" ;; esac
case $LOG in *"pull -q karthickdk02/elasticpro-core:9.9.0"*) ok "the core image was pulled" ;; *) bad "the core was not pulled: $LOG" ;; esac
no_volume_touched "upgrade"
case $OUT in *"shimproj_db-data is kept"*) ok "it says the volume shimproj_db-data is kept" ;; *) bad "no volume note: $OUT" ;; esac
! grep -q '^ELASTICPRO_DB_IMAGE=' "$R/.env" && env_is ELASTICPRO_DB_IMAGE_PREVIOUS karthickdk02/elasticpro-postgres:9.6.0 \
  && ok ".env: ELASTICPRO_DB_IMAGE removed, kept as ELASTICPRO_DB_IMAGE_PREVIOUS" || bad ".env after the upgrade: $(cat "$R/.env")"
env_is ELASTICPRO_NGINX_IMAGE karthickdk02/elasticpro-nginx:9.9.0 && env_is ELASTICPRO_IMAGE karthickdk02/elasticpro-core:9.9.0 \
  && ok ".env: core and nginx on 9.9.0" || bad ".env images: $(cat "$R/.env")"

sleep 1    # the backups are named by the second
real --rollback
[ $RC = 0 ] && ok "--rollback ran" || bad "--rollback (rc $RC): $OUT"
cmp -s "$R/docker-compose.yml" "$T/mirror/v9.6.0/deploy/docker-compose.yml" && ok "the old file, with the db, is back" || bad "the old compose file is not back"
env_is ELASTICPRO_DB_IMAGE karthickdk02/elasticpro-postgres:9.6.0 && ! grep -q '^ELASTICPRO_DB_IMAGE_PREVIOUS=' "$R/.env" \
  && ok ".env: ELASTICPRO_DB_IMAGE is back on the image the db ran" || bad ".env after --rollback: $(cat "$R/.env")"
env_is ELASTICPRO_IMAGE karthickdk02/elasticpro-core:9.6.0 && env_is ELASTICPRO_NGINX_IMAGE karthickdk02/elasticpro-nginx:9.6.0 \
  && ok ".env: core and nginx back on 9.6.0" || bad ".env images after --rollback: $(cat "$R/.env")"
case $LOG in *"compose up -d --remove-orphans"*) ok "the stack comes up again (the db with its kept volume)" ;; *) bad "no compose up: $LOG" ;; esac
no_volume_touched "rollback"

sleep 1
real --rollback
[ $RC = 0 ] && cmp -s "$R/docker-compose.yml" "$T/mirror/v9.9.0/deploy/docker-compose.yml" \
  && ok "a second --rollback goes forward again (the file without the db)" || bad "second --rollback (rc $RC): $OUT"
no_volume_touched "second rollback"

[ $fail = 0 ] && echo "ok" || { echo "FAILED"; exit 1; }
