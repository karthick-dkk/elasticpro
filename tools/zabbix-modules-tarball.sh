#!/usr/bin/env bash
# Build the Zabbix modules release asset, exactly as the release workflow does.
#
#   tools/zabbix-modules-tarball.sh                    # version from Cargo.toml, into dist/
#   tools/zabbix-modules-tarball.sh --version v0.2.0 --out /tmp/pkg
#
# Writes two files:
#   elasticpro-zabbix-modules-<ver>.tar.gz          the five module folders, nothing else
#   elasticpro-zabbix-modules-<ver>.tar.gz.sha256   `sha256sum` line for it
#
# This is the one definition of what goes into a Zabbix modules folder. The release workflow
# runs it on a tag, and deploy/zabbix/zabbix-modules-install.sh --from-dir <checkout> runs it
# too, so a local install and a downloaded release install the same files.
#
# Deterministic: files sorted by name, owner/group 0, one fixed mtime (SOURCE_DATE_EPOCH,
# default 1980-01-01), gzip without a name or timestamp. The same sources give the same
# bytes on any machine with GNU tar. The installer extracts with fresh mtimes, so PHP's opcode
# cache still sees an upgrade as a change.
#
# Left out: tests, tool scripts (*.py, *.mjs), READMEs, .gitignore, macOS ._* files, and every
# config.php (config.php.example stays — it is documentation, not a setting).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=
OUT=$ROOT/dist

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:?--version needs a value}; shift 2 ;;
    --out) OUT=${2:?--out needs a directory}; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# Zabbix module id (the folder name in Zabbix's modules/) <- where it lives in this repo.
# deploy/zabbix/zabbix-modules-install.sh keeps the same five ids for --uninstall.
MODULES=(
  "elasticpro:deploy/zabbix/module/elasticpro"
  "ep_clients:integration/zabbix/clients-module"
  "ep_capacity:integration/zabbix/capacity-widget"
  "ep_resources:integration/zabbix/resources-widget"
  "ep_volume:integration/zabbix/volume-widget"
)

fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

case "$(tar --version 2>/dev/null || true)" in *'GNU tar'*) ;; *) fail "GNU tar is needed for a reproducible archive (macOS: brew install gnu-tar, then put gtar first on PATH as tar)" ;; esac
if [ -z "$VERSION" ]; then
  VERSION=$(sed -n 's/^version *= *"\(.*\)".*/\1/p' "$ROOT/Cargo.toml" | head -1)
  [ -n "$VERSION" ] || fail "no --version given and none found in Cargo.toml"
fi
VERSION=${VERSION#v}
NAME=elasticpro-zabbix-modules-$VERSION
EPOCH=${SOURCE_DATE_EPOCH:-315532800}

for m in "${MODULES[@]}"; do
  id=${m%%:*}; src=$ROOT/${m#*:}
  [ -f "$src/manifest.json" ] || fail "$src/manifest.json is missing — run this from a full checkout"
  got=$(sed -n 's/^[[:space:]]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/manifest.json" | head -1)
  [ "$got" = "$id" ] || fail "$src/manifest.json says id \"$got\", expected \"$id\""
done

# The widgets carry copies of shared code; a copy that differs means sync-assets.mjs was not run.
if command -v node >/dev/null 2>&1; then
  (cd "$ROOT/integration/zabbix" && node --input-type=module -e "
    import fs from 'node:fs';
    const { SHARED_PHP, PHP_MODULES, phpFor } = await import('./sync-assets.mjs');
    const bad = [];
    for (const [dir, ns] of Object.entries(PHP_MODULES)) for (const f of SHARED_PHP) {
      if (fs.readFileSync(dir + '/lib/' + f, 'utf8') !== phpFor(fs.readFileSync('shared/php/' + f, 'utf8'), ns)) bad.push(dir + '/lib/' + f);
    }
    if (bad.length) { console.error('out of date: ' + bad.join(', ') + ' — run: node integration/zabbix/sync-assets.mjs'); process.exit(1); }
  ") || fail "shared code is out of date in a module"
else
  echo "! node not found — skipped the check that shared code is in sync (CI runs it)" >&2
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME"
for m in "${MODULES[@]}"; do
  id=${m%%:*}; src=$ROOT/${m#*:}
  mkdir -p "$STAGE/$NAME/$id"
  (cd "$src" && find . \
      \( -name test -o -name tests \) -prune -o \
      -type f ! -name '*.py' ! -name '*.mjs' ! -name 'README.md' ! -name '.gitignore' \
        ! -name '._*' ! -name '.DS_Store' ! -name 'config.php' \
        ! \( -name 'config.php.*' ! -name 'config.php.example' \) -print0) |
    (cd "$src" && xargs -0 -r cp --parents -t "$STAGE/$NAME/$id")
done
printf '%s\n' "$VERSION" > "$STAGE/$NAME/VERSION"

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
LC_ALL=C tar --sort=name --format=gnu --mtime="@$EPOCH" \
  --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' \
  -C "$STAGE" -cf - "$NAME" | gzip -9n > "$OUT/$NAME.tar.gz"
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")

printf '%s\n' "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256"
cat "$OUT/$NAME.tar.gz.sha256"
