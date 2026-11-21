#!/usr/bin/env bash
# The first administrator's password on a FRESH install (0.3.82): random, never the public default.
#
#   deploy/initial-admin.sh ensure [--dry-run]   # a fresh install: make the password file
#   deploy/initial-admin.sh report               # once the core is up: show it, once
#
# `ensure` makes secrets/admin/initial_admin_password only when this is a fresh install: no such
# file, no core container of this compose project (running or stopped), and no <project>_core-data
# volume. Anything that cannot be told (Docker not answering, no project name) counts as NOT fresh.
# An existing file is never replaced, and nothing here ever touches an install that already has
# accounts. It prints "made" when it made the file. The file is created private from its first
# byte (umask 077, noclobber), then given to the core: the core runs as uid 999 with this install's
# group (ELASTICPRO_GID) added, so as root the file is chowned to 999 and stays 0600; as the
# installing user it is 0640 with that group, the same as secrets/redis/redis_password.
#
# The compose file mounts secrets/admin read-only into the core, and the core's entrypoint points
# ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE at the file when it exists. The core reads it only when
# it has no accounts at all; a file that cannot be used stops the core (it never falls back to
# the shipped Admin/elastic). Once the first account exists the file is not read again: delete it.
#
# `report` prints the password once — to the terminal (/dev/tty) only, never to stdout, so a
# deploy whose output is captured in a log file does not capture it. With no terminal it says
# where the file is instead.
set -euo pipefail
cd "$(dirname "$0")"
DIR=secrets/admin
FILE=$DIR/initial_admin_password

fresh() {
  [ ! -e "$FILE" ] || return 1
  local proj ps vols
  proj=$(docker compose config 2>/dev/null | sed -n 's/^name: *//p' | head -1)
  [ -n "$proj" ] || return 1
  ps=$(docker compose ps -a -q core 2>/dev/null) || return 1
  [ -z "$ps" ] || return 1
  vols=$(docker volume ls -q 2>/dev/null) || return 1
  ! printf '%s\n' "$vols" | grep -qx "${proj}_core-data" || return 1
  return 0
}

case "${1:-}" in
  ensure)
    # The folder exists before compose mounts it, so Docker does not make it as root.
    if [ "${2:-}" != --dry-run ]; then
      mkdir -p "$DIR"
      chmod 0750 "$DIR" 2>/dev/null || true
    fi
    fresh || exit 0
    if [ "${2:-}" = --dry-run ]; then
      echo "  would: make a random first-administrator password in deploy/$FILE (fresh install)"
      exit 0
    fi
    gid=$(sed -n 's/^ELASTICPRO_GID=//p' .env 2>/dev/null | tail -1); gid=${gid:-1000}
    pw=$(openssl rand -hex 12 2>/dev/null || od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
    [ "${#pw}" -ge 20 ] || { echo "✗ could not make a random password (no openssl, no /dev/urandom)" >&2; exit 1; }
    ( umask 077; set -C; printf '%s\n' "$pw" > "$FILE" ) || { echo "✗ could not write deploy/$FILE" >&2; exit 1; }
    if [ "$(id -u)" = 0 ]; then
      chown 999:"$gid" "$FILE" && chgrp "$gid" "$DIR" || { echo "✗ could not give deploy/$FILE to the core (uid 999)" >&2; exit 1; }
    else
      chgrp "$gid" "$DIR" "$FILE" 2>/dev/null || true
      chmod 0640 "$FILE" || { echo "✗ could not set the mode of deploy/$FILE" >&2; exit 1; }
    fi
    echo made
    ;;
  report)
    [ -s "$FILE" ] || exit 0
    if { : > /dev/tty; } 2>/dev/null; then
      {
        printf '\n== The first administrator (shown once)\n'
        printf '   Sign in as  Admin  with the password  %s\n' "$(head -1 "$FILE")"
        printf '   Then set your own on the Accounts page (at least 10 characters), and delete\n'
        printf '   deploy/%s — the core does not read it again once an account exists.\n\n' "$FILE"
      } > /dev/tty
    else
      echo "== The first administrator: Admin, with the password in deploy/$FILE (not printed: no terminal)."
      echo "   Set your own on the Accounts page, then delete that file."
    fi
    ;;
  *) echo "usage: $0 ensure [--dry-run] | report" >&2; exit 2 ;;
esac
