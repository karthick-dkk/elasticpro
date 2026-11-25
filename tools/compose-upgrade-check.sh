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
#      again — against a stand-in `docker` that records what it was asked, so nothing starts;
#   8. --upgrade puts the target release's own deploy.sh in place and runs it (0.3.79): not on a
#      dry run, not with ELASTICPRO_NO_SELF_UPDATE=1, not when the fetched one does not parse,
#      once (no loop), and the old script is kept as deploy.sh.previous.
#   9. the first administrator (0.3.82): a fresh install (no core container, no core-data volume)
#      gets a random password file, private, shown never on stdout; a dry run makes nothing; an
#      install that has run before never gets one; an existing file is never replaced; a password
#      the core did not use is removed; the compose file mounts it and points the core at it; an
#      existing install where secrets/admin cannot be made still upgrades; a fresh install whose
#      .env has no ELASTICPRO_GID gets this user's group (written to .env), and a group the user is
#      not in is a clear error.
#  10. a Zabbix scraper's code (0.3.93): with the plan scraper in the stack, an upgrade copies ui and
#      tools out of the new core image and points .env there, also on an install whose images are
#      already current; --rollback goes back and forward; code no longer needed is removed; a folder
#      the operator named is left alone; an image without the code changes nothing; a stack without a
#      scraper is untouched; a dry run makes nothing.
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
      *" --services "*) awk '/^services:/{f=1;next} /^[^ #]/{f=0} f && /^  [a-z_-]+:/{sub(/:.*/,"");sub(/^  /,"");print}' docker-compose.yml; [ "${SHIM_SCRAPER:-0}" = 1 ] && echo plan-scraper ;;
      *" -q "*) ;;
      *) echo "name: shimproj" ;;
    esac ;;
  "compose ps")
    # SHIM_FRESH=1: no container of this project has ever existed (ps -a finds none).
    case " $* " in *" -a "*) [ "${SHIM_FRESH:-0}" = 1 ] && exit 0 ;; esac
    case " $* " in *" -q "*) echo "shim-${*: -1}" ;; esac ;;
  "compose logs") [ "${SHIM_SEEDED:-0}" = 1 ] && echo '{"fields":{"message":"no accounts existed: created the first one, with the password from ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE"}}' ;;
  "volume ls") [ "${SHIM_FRESH:-0}" = 1 ] || echo shimproj_core-data ;;
  "inspect "*) echo healthy ;;
  "image inspect") grep -qxF "$3" "$SHIM_IMAGES"; exit $? ;;
  "create "*) echo shim-created ;;
  "cp shim-created:/app/ui") mkdir -p "$3/js/core"; echo "// ui" > "$3/js/core/state.js" ;;
  "cp shim-created:/app/tools") [ "${SHIM_NO_TOOLS:-0}" = 1 ] && exit 1; mkdir -p "$3"; echo "// tools" > "$3/elasticpro-scrape.mjs" ;;
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
# No deploy.sh in the mirror (section 8 adds one): the fetch fails and the installed script goes on.
case $OUT in *"could not be fetched"*) ok "no deploy.sh in the mirror: the installed one went on, and said so" ;; *) bad "no note that the script could not be fetched: $OUT" ;; esac
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

[ ! -e "$R/secrets/admin/initial_admin_password" ] && ok "an install that has run before is given no first-administrator password" \
  || bad "an existing install was given a first-administrator password file"
case $OUT in *"first administrator"*) bad "an upgrade of an existing install talked about a first administrator: $OUT" ;; *) ok "and says nothing about one" ;; esac

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

# --- 8. the script brings itself up to date (0.3.79) ------------------------------------------
# The mirror's 9.9.0 deploy.sh is today's with one line that says it ran. Sections 1-7 had no
# deploy.sh in the mirror: there the fetch failed and the installed script went on (checked too).
echo "== deploy.sh --upgrade: the target release's deploy.sh does the upgrade"
awk '{ print } /^set -euo pipefail$/ && !d { print "echo \"MIRROR-9.9.0-SCRIPT-RAN self=${ELASTICPRO_SELF_UPDATED:-}\""; d=1 }' deploy/deploy.sh > "$T/mirror/v9.9.0/deploy/deploy.sh"
S=$T/self/deploy
mkdir -p "$T/self"
cp -R "$T/inst/deploy" "$S"; cp Cargo.toml "$T/self/"
cp "$T/mirror/v9.8.0/deploy/docker-compose.yml" "$S/docker-compose.yml"
cp deploy/deploy.sh "$T/installed.sh"
selfrun() {
  RC=0
  : > "$T/shim.log"; printf '%s\n' karthickdk02/elasticpro-core:9.8.0 karthickdk02/elasticpro-nginx:9.8.0 > "$T/images"
  OUT=$(cd "$S" && PATH="$T/bin:$PATH" SHIM_LOG="$T/shim.log" SHIM_IMAGES="$T/images" ELASTICPRO_RELEASE_URL="file://$T/mirror" \
        "$@" 2>&1) || RC=$?
  LOG=$(cat "$T/shim.log")
}
selfrun ./deploy.sh --timeout 5 --upgrade=9.9.0 --dry-run
cmp -s "$S/deploy.sh" "$T/installed.sh" && [ ! -e "$S/deploy.sh.previous" ] && ok "a dry run keeps the installed script" || bad "a dry run replaced the script"
case $OUT in *"would: put the 9.9.0 deploy.sh in place"*) ok "the dry run says it would put the 9.9.0 script in place" ;; *) bad "the dry run did not say so: $OUT" ;; esac
case $OUT in *MIRROR-9.9.0-SCRIPT-RAN*) bad "the dry run ran the fetched script: $OUT" ;; *) ok "the dry run did not run the fetched script" ;; esac

selfrun env ELASTICPRO_NO_SELF_UPDATE=1 ./deploy.sh --timeout 5 --upgrade=9.9.0 --dry-run
case $OUT in *"9.9.0 deploy.sh"*|*MIRROR-9.9.0*) bad "ELASTICPRO_NO_SELF_UPDATE=1 still fetched the script: $OUT" ;; *) ok "ELASTICPRO_NO_SELF_UPDATE=1 keeps the installed script" ;; esac

printf '#!/usr/bin/env bash\nif then fi --upgrade\n' > "$T/broken.sh"; cp "$T/mirror/v9.9.0/deploy/deploy.sh" "$T/good.sh"; cp "$T/broken.sh" "$T/mirror/v9.9.0/deploy/deploy.sh"
selfrun ./deploy.sh --timeout 5 --upgrade=9.9.0 --dry-run
case $OUT in *"is not a deploy script"*) ok "a fetched script that does not parse is refused; the installed one goes on" ;; *) bad "a broken fetched script was not refused: $OUT" ;; esac
cp "$T/good.sh" "$T/mirror/v9.9.0/deploy/deploy.sh"

selfrun ./deploy.sh --timeout 5 --upgrade=9.9.0
[ $RC = 0 ] && ok "the upgrade ran" || bad "the self-updating upgrade (rc $RC): $OUT"
cmp -s "$S/deploy.sh" "$T/mirror/v9.9.0/deploy/deploy.sh" && ok "the 9.9.0 deploy.sh is in place" || bad "the script was not replaced"
cmp -s "$S/deploy.sh.previous" "$T/installed.sh" && ok "the old script is kept as deploy.sh.previous" || bad "no deploy.sh.previous"
[ -x "$S/deploy.sh" ] && ok "the new script is executable" || bad "the new script is not executable"
case $OUT in *"MIRROR-9.9.0-SCRIPT-RAN self=9.9.0"*) ok "the 9.9.0 script ran the upgrade, with the same options" ;; *) bad "the fetched script did not run: $OUT" ;; esac
[ "$(printf '%s' "$OUT" | grep -c 'MIRROR-9.9.0-SCRIPT-RAN')" = 1 ] && ok "it switched once (no loop)" || bad "the script ran more than once: $OUT"
case $LOG in *"pull -q karthickdk02/elasticpro-core:9.9.0"*) ok "and the upgrade itself went on (the core was pulled)" ;; *) bad "the upgrade did not go on after the switch: $LOG" ;; esac

selfrun ./deploy.sh --timeout 5 --upgrade=9.9.0
case $OUT in *"is in place (the old one"*) bad "the same script was put in place again: $OUT" ;; *) ok "a script already the target's is kept as it is" ;; esac

# --- 9. the first administrator on a fresh install (0.3.82) ------------------------------------
echo "== deploy.sh on a fresh install: a random first-administrator password"
grep -q -- '- ./secrets/admin:/run/elasticpro-admin:ro' deploy/docker-compose.yml && ok "the compose file mounts secrets/admin into the core, read-only" \
  || bad "the compose file does not mount secrets/admin"
grep -q -- '-e /run/elasticpro-admin/initial_admin_password ]; then export ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE=' deploy/docker-compose.yml \
  && ok "the core is pointed at the file when it exists (an empty one stops it rather than meaning none)" || bad "the entrypoint does not point the core at the file"
F=$T/fresh/deploy
mkdir -p "$T/fresh"
cp -R "$T/inst/deploy" "$F"; cp Cargo.toml "$T/fresh/"
rm -rf "$F/secrets/admin"
cp deploy/docker-compose.yml "$F/docker-compose.yml"
printf 'ELASTICPRO_IMAGE=karthickdk02/elasticpro-core:9.9.0\nELASTICPRO_GID=%s\n' "$(id -g)" > "$F/.env"
fresh() {
  RC=0
  : > "$T/shim.log"; printf '%s\n' karthickdk02/elasticpro-core:9.9.0 > "$T/images"
  OUT=$(cd "$F" && PATH="$T/bin:$PATH" SHIM_LOG="$T/shim.log" SHIM_IMAGES="$T/images" "$@" 2>&1) || RC=$?
  LOG=$(cat "$T/shim.log")
}
PWF=$F/secrets/admin/initial_admin_password
fresh env SHIM_FRESH=1 ./deploy.sh --timeout 5 --image karthickdk02/elasticpro-core:9.9.0 --dry-run
case $OUT in *"would: make a random first-administrator password"*) ok "a dry run says it would make one" ;; *) bad "the dry run did not say so (rc $RC): $OUT" ;; esac
[ ! -e "$PWF" ] && ok "and makes nothing" || bad "a dry run made the password file"

fresh env SHIM_FRESH=1 SHIM_SEEDED=1 ./deploy.sh --timeout 5 --image karthickdk02/elasticpro-core:9.9.0
[ $RC = 0 ] && ok "the fresh deploy ran" || bad "the fresh deploy (rc $RC): $OUT"
PW=$(head -1 "$PWF" 2>/dev/null || true)
printf '%s' "$PW" | grep -Eq '^[0-9a-f]{24}$' && ok "a random 24-character password is in secrets/admin/initial_admin_password" || bad "no password in the file: '$PW'"
mode=$(stat -c %a "$PWF" 2>/dev/null || stat -f %Lp "$PWF")
if [ "$(id -u)" = 0 ]; then want=600; else want=640; fi
[ "$mode" = "$want" ] && ok "the file is $mode (private; the core's group may read it)" || bad "the file is $mode, want $want"
case $OUT in *"$PW"*) bad "the password was printed on stdout (captured logs would keep it)" ;; *) ok "the password is never printed on stdout" ;; esac
case $OUT in *"made a random password for the first administrator"*) ok "it says it made one" ;; *) bad "no word that it made one: $OUT" ;; esac
[ -n "$PW" ] && ! grep -rqF --exclude=initial_admin_password "$PW" "$F" && ok "and the password is in no other file here" || bad "the password is in another file"

fresh env SHIM_FRESH=1 SHIM_SEEDED=1 ./deploy.sh --timeout 5 --image karthickdk02/elasticpro-core:9.9.0
[ "$(head -1 "$PWF")" = "$PW" ] && ok "a second deploy keeps the file as it is (never regenerated)" || bad "the password file was replaced"
case $OUT in *"made a random password"*) bad "a second deploy made another: $OUT" ;; *) ok "and makes no other" ;; esac

rm -f "$PWF"
fresh env SHIM_FRESH=1 ./deploy.sh --timeout 5 --image karthickdk02/elasticpro-core:9.9.0
[ ! -e "$PWF" ] && case $OUT in *"was not used and was removed"*) true ;; *) false ;; esac \
  && ok "a password the core did not take (it had accounts) is removed, and it says so" || bad "an unused password was kept or not reported: $OUT"

# An install that has run before, where secrets/admin cannot be made (a root-owned secrets/ when
# run as a normal user; here a plain file in the way, which stops root too): the upgrade goes on.
B=$T/blocked/deploy
mkdir -p "$T/blocked"
cp -R "$T/inst/deploy" "$B"; rm -rf "$B/secrets/admin"; echo in-the-way > "$B/secrets/admin"
RC=0; OUT=$(cd "$B" && PATH="$T/bin:$PATH" SHIM_LOG="$T/shim.log" ./initial-admin.sh ensure 2>&1) || RC=$?
[ $RC = 0 ] && [ -z "$OUT" ] && ok "an existing install where secrets/admin cannot be made: the step passes quietly (the upgrade goes on)" \
  || bad "an existing install with secrets/admin blocked failed the step (rc $RC): $OUT"

# A fresh install whose .env has no ELASTICPRO_GID (only install.sh wrote it; deploy.sh alone did not).
N=$T/nogid/deploy
mkdir -p "$T/nogid"
cp -R "$F" "$N"; rm -rf "$N/secrets/admin"
printf 'ELASTICPRO_IMAGE=karthickdk02/elasticpro-core:9.9.0\n' > "$N/.env"
gidrun() {
  RC=0; OUT=$(cd "$N" && env -u ELASTICPRO_GID PATH="$T/bin:$PATH" SHIM_LOG="$T/shim.log" SHIM_FRESH=1 ./initial-admin.sh ensure 2>&1) || RC=$?
}
gidrun
NF=$N/secrets/admin/initial_admin_password
if [ "$(id -u)" = 0 ]; then
  [ $RC = 0 ] && [ "$(stat -c %u "$NF" 2>/dev/null || stat -f %u "$NF")" = 999 ] \
    && ok "no ELASTICPRO_GID, as root: the file is the core's (uid 999)" || bad "no ELASTICPRO_GID, as root (rc $RC): $OUT"
else
  g=$(stat -c %g "$NF" 2>/dev/null || stat -f %g "$NF" 2>/dev/null || true)
  [ $RC = 0 ] && [ "$g" = "$(id -g)" ] && grep -qx "ELASTICPRO_GID=$(id -g)" "$N/.env" \
    && ok "no ELASTICPRO_GID: the file gets this user's group and ELASTICPRO_GID=$(id -g) goes into .env (the core's group)" \
    || bad "no ELASTICPRO_GID (rc $RC, group $g): $OUT / $(cat "$N/.env")"
  # A group this user is not in: a clear error, and no file the core could not read is left behind.
  for other in 54321 54322 54323; do id -G | tr ' ' '\n' | grep -qx "$other" || break; done
  rm -rf "$N/secrets/admin"
  printf 'ELASTICPRO_IMAGE=karthickdk02/elasticpro-core:9.9.0\nELASTICPRO_GID=%s\n' "$other" > "$N/.env"
  gidrun
  [ $RC != 0 ] && [ ! -e "$NF" ] && case $OUT in *"not in it"*) true ;; *) false ;; esac \
    && ok "ELASTICPRO_GID names a group this user is not in: a clear error, no file left" || bad "a group the user is not in (rc $RC): $OUT"
fi


# --- 10. the Zabbix scraper's code (0.3.93) ----------------------------------------------------
echo "== the Zabbix scraper's code comes with the release"
Z=$T/scr/deploy
mkdir -p "$T/scr"
cp -R "$T/inst/deploy" "$Z"; cp Cargo.toml "$T/scr/"
rm -rf "$Z/scraper"
scr_env() {   # VERSION [lines…]
  printf 'ELASTICPRO_IMAGE=karthickdk02/elasticpro-core:%s\nELASTICPRO_NGINX_IMAGE=karthickdk02/elasticpro-nginx:%s\n' "$1" "$1" > "$Z/.env"; shift
  [ $# = 0 ] || printf '%s\n' "$@" >> "$Z/.env"
}
scr() {
  RC=0; : > "$T/shim.log"
  OUT=$(cd "$Z" && PATH="$T/bin:$PATH" SHIM_LOG="$T/shim.log" SHIM_IMAGES="$T/images" SHIM_SCRAPER=${SCRAPER_ON:-1} SHIM_NO_TOOLS=${NO_TOOLS:-0} \
        ELASTICPRO_NO_SELF_UPDATE=1 ELASTICPRO_RELEASE_URL="file://$T/mirror" ./deploy.sh --timeout 5 "$@" 2>&1) || RC=$?
  LOG=$(cat "$T/shim.log")
}
zenv() { [ "$(sed -n "s/^$1=//p" "$Z/.env" | tail -1)" = "$2" ]; }
cp "$T/mirror/v9.9.0/deploy/docker-compose.yml" "$Z/docker-compose.yml"
scr_env 9.8.0
printf '%s\n' karthickdk02/elasticpro-core:9.8.0 karthickdk02/elasticpro-nginx:9.8.0 > "$T/images"

scr --upgrade=9.9.0 --dry-run
[ $RC = 0 ] && case $OUT in *"would: copy ui and tools out of karthickdk02/elasticpro-core:9.9.0"*) true ;; *) false ;; esac \
  && [ ! -e "$Z/scraper" ] && zenv ELASTICPRO_UI_DIR "" && ok "a dry run says it and makes nothing" || bad "dry run (rc $RC): $OUT"

scr --upgrade=9.9.0
[ $RC = 0 ] && [ -f "$Z/scraper/9.9.0/ui/js/core/state.js" ] && [ -f "$Z/scraper/9.9.0/tools/elasticpro-scrape.mjs" ] \
  && ok "ui and tools are copied out of the 9.9.0 core image" || bad "no code of 9.9.0 (rc $RC): $OUT"
zenv ELASTICPRO_UI_DIR ./scraper/9.9.0/ui && zenv ELASTICPRO_TOOLS_DIR ./scraper/9.9.0/tools && zenv ELASTICPRO_UI_DIR_PREVIOUS ../ui \
  && ok ".env names them, and keeps the old folders for --rollback" || bad ".env: $(cat "$Z/.env")"
case $LOG in *"rm shim-created"*) ok "the container made for the copy is removed" ;; *) bad "the copy's container stays: $LOG" ;; esac

scr --upgrade=9.9.0
[ $RC = 0 ] && case $OUT in *"already on 9.9.0"*) true ;; *) false ;; esac && ok "a second run has nothing to do" || bad "second run (rc $RC): $OUT"

scr --rollback
[ $RC = 0 ] && zenv ELASTICPRO_UI_DIR ../ui && zenv ELASTICPRO_TOOLS_DIR ../tools && ok "--rollback goes back to the old folders" || bad "--rollback (rc $RC): $(cat "$Z/.env") $OUT"
scr --rollback
[ $RC = 0 ] && zenv ELASTICPRO_UI_DIR ./scraper/9.9.0/ui && ok "a second --rollback goes forward again" || bad "second --rollback (rc $RC): $(cat "$Z/.env")"

scr_env 9.9.0
rm -rf "$Z/scraper"
scr --upgrade=9.9.0
[ $RC = 0 ] && zenv ELASTICPRO_UI_DIR ./scraper/9.9.0/ui && [ -d "$Z/scraper/9.9.0/ui" ] \
  && ok "images already on 9.9.0, the scraper's code not: it is brought in" || bad "current images (rc $RC): $OUT"

mkdir -p "$Z/scraper/9.1.0/ui" "$Z/scraper/9.8.0/ui"
scr_env 9.8.0 ELASTICPRO_UI_DIR=./scraper/9.8.0/ui ELASTICPRO_TOOLS_DIR=./scraper/9.8.0/tools
scr --upgrade=9.9.0
[ $RC = 0 ] && [ ! -e "$Z/scraper/9.1.0" ] && [ -d "$Z/scraper/9.8.0" ] && [ -d "$Z/scraper/9.9.0" ] \
  && ok "code of versions neither running nor to roll back to is removed" || bad "tidy (rc $RC): $(ls "$Z/scraper")"

scr_env 9.8.0 ELASTICPRO_UI_DIR=/srv/my-ui
rm -rf "$Z/scraper"
scr --upgrade=9.9.0
[ $RC = 0 ] && zenv ELASTICPRO_UI_DIR /srv/my-ui && [ ! -e "$Z/scraper" ] && case $OUT in *"ELASTICPRO_UI_DIR=/srv/my-ui"*) true ;; *) false ;; esac \
  && ok "a folder the operator named is left alone, with a note" || bad "own folder (rc $RC): $OUT"

scr_env 9.8.0
NO_TOOLS=1 scr --upgrade=9.9.0
[ $RC = 0 ] && zenv ELASTICPRO_UI_DIR "" && [ ! -e "$Z/scraper/9.9.0" ] && zenv ELASTICPRO_IMAGE karthickdk02/elasticpro-core:9.9.0 \
  && case $OUT in *"could not be taken from"*) true ;; *) false ;; esac && ok "an image without the code: the upgrade goes on, the scraper keeps its code, and it says so" || bad "no code (rc $RC): $OUT"

scr_env 9.8.0
rm -rf "$Z/scraper"
SCRAPER_ON=0 scr --upgrade=9.9.0
[ $RC = 0 ] && zenv ELASTICPRO_UI_DIR "" && [ ! -e "$Z/scraper" ] && ok "a stack without a scraper is untouched" || bad "no scraper (rc $RC): $OUT"

sed -i.tmp -e 's|\${ELASTICPRO_UI_DIR:-../ui}|../ui|' -e 's|\${ELASTICPRO_TOOLS_DIR:-../tools}|../tools|' "$Z/zabbix/compose.scraper.yml"
scr_env 9.8.0
scr --upgrade=9.9.0
[ $RC = 0 ] && cmp -s "$Z/zabbix/compose.scraper.yml" deploy/zabbix/compose.scraper.yml && ok "an automation scraper file from before 0.3.93 reads the same two keys now" \
  || bad "compose.scraper.yml (rc $RC): $(diff "$Z/zabbix/compose.scraper.yml" deploy/zabbix/compose.scraper.yml)"
for f in tools/elasticpro-scrape.mjs tools/zabbix-sender.mjs tools/lib/refetch-interval.mjs tools/lib/scrape-sender.mjs; do
  grep -q "$f" deploy/Dockerfile || bad "deploy/Dockerfile does not carry $f"
done
for f in $(grep -ohE "from '\./lib/[a-z-]+\.mjs'" tools/elasticpro-scrape.mjs | sed "s/.*'\.\/\(.*\)'/\1/"); do
  grep -q "tools/$f" deploy/Dockerfile && ok "the image carries tools/$f, which the scraper imports" || bad "deploy/Dockerfile does not carry tools/$f, which tools/elasticpro-scrape.mjs imports"
done

[ $fail = 0 ] && echo "ok" || { echo "FAILED"; exit 1; }
