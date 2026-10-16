#!/usr/bin/env bash
# Build the Zabbix modules release asset, exactly as the release workflow does.
#
#   tools/zabbix-modules-tarball.sh --modules-src DIR                  # version from Cargo.toml, into dist/
#   tools/zabbix-modules-tarball.sh --modules-src DIR --version v0.2.0 --out /tmp/pkg
#
#   --modules-src DIR   a checkout of the modules project, github.com/karthick-dkk/integration-zabbix-elasticpro
#                       (DIR, or DIR/zabbix, holds clients-module/, capacity-widget/ ... and
#                       sync-assets.mjs). Required: the widgets live there, not in this
#                       repository. The release builds from the commit pinned in
#                       deploy/zabbix/MODULES_REF (the first line that is not a comment).
#
# Writes two files:
#   elasticpro-zabbix-modules-<ver>.tar.gz          the seven module folders, nothing else
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
MODULES_SRC=

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:?--version needs a value}; shift 2 ;;
    --modules-src) MODULES_SRC=${2:?--modules-src needs a directory}; shift 2 ;;
    --out) OUT=${2:?--out needs a directory}; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

if [ -z "$MODULES_SRC" ]; then
  fail "--modules-src is needed: the widgets are in the modules project, not in this repository.
  Get it at the commit the release uses:
    git clone https://github.com/karthick-dkk/integration-zabbix-elasticpro modules-src
    git -C modules-src checkout \"\$(grep -v '^#' deploy/zabbix/MODULES_REF | head -1)\"
    tools/zabbix-modules-tarball.sh --modules-src modules-src"
fi
[ -d "$MODULES_SRC" ] || fail "--modules-src $MODULES_SRC is not a folder"
# The project root or its zabbix/ folder.
if [ -f "$MODULES_SRC/zabbix/sync-assets.mjs" ]; then MODULES_SRC=$MODULES_SRC/zabbix; fi
Z=$(cd "$MODULES_SRC" && pwd)
{ [ -f "$Z/sync-assets.mjs" ] && [ -d "$Z/clients-module" ]; } \
  || fail "$MODULES_SRC is not a checkout of integration-zabbix-elasticpro (no zabbix/sync-assets.mjs and clients-module/)"

# Zabbix module id (the folder name in Zabbix's modules/) <- where it comes from.
# deploy/zabbix/zabbix-modules-install.sh keeps the same seven ids (KNOWN_IDS).
# Six come from the modules project. The ElasticPro menu module (elasticpro) is the exception
# for now: this repository's copy carries the EP-701..703 error codes, which the modules
# project's embed-module does not have yet. Switch the first line to "$Z/embed-module" once it
# does, and delete deploy/zabbix/module/elasticpro.
MODULES=(
  "elasticpro:$ROOT/deploy/zabbix/module/elasticpro"
  "ep_clients:$Z/clients-module"
  "ep_capacity:$Z/capacity-widget"
  "ep_resources:$Z/resources-widget"
  "ep_volume:$Z/volume-widget"
  "ep_tophosts:$Z/tophosts-widget"
  "ep_overview:$Z/overview-widget"
)

case "$(tar --version 2>/dev/null || true)" in *'GNU tar'*) ;; *) fail "GNU tar is needed for a reproducible archive (macOS: brew install gnu-tar, then put gtar first on PATH as tar)" ;; esac
if [ -z "$VERSION" ]; then
  VERSION=$(sed -n 's/^version *= *"\(.*\)".*/\1/p' "$ROOT/Cargo.toml" | head -1)
  [ -n "$VERSION" ] || fail "no --version given and none found in Cargo.toml"
fi
VERSION=${VERSION#v}
NAME=elasticpro-zabbix-modules-$VERSION
EPOCH=${SOURCE_DATE_EPOCH:-315532800}

for m in "${MODULES[@]}"; do
  id=${m%%:*}; src=${m#*:}
  [ -f "$src/manifest.json" ] || fail "$src/manifest.json is missing — is --modules-src a full checkout?"
  got=$(sed -n 's/^[[:space:]]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/manifest.json" | head -1)
  [ "$got" = "$id" ] || fail "$src/manifest.json says id \"$got\", expected \"$id\""
done

# The widgets carry copies of shared code; a copy that differs means sync-assets.mjs was not run.
if command -v node >/dev/null 2>&1; then
  (cd "$Z" && node --input-type=module -e "
    import fs from 'node:fs';
    const { SHARED_PHP, PHP_MODULES, phpFor } = await import('./sync-assets.mjs');
    const bad = [];
    for (const [dir, ns] of Object.entries(PHP_MODULES)) for (const f of SHARED_PHP) {
      if (fs.readFileSync(dir + '/lib/' + f, 'utf8') !== phpFor(fs.readFileSync('shared/php/' + f, 'utf8'), ns)) bad.push(dir + '/lib/' + f);
    }
    if (bad.length) { console.error('out of date: ' + bad.join(', ') + ' — run: node sync-assets.mjs in the modules project'); process.exit(1); }
  ") || fail "shared code is out of date in a module of $Z"
else
  echo "! node not found — skipped the check that shared code is in sync (CI runs it)" >&2
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME"
for m in "${MODULES[@]}"; do
  id=${m%%:*}; src=${m#*:}
  mkdir -p "$STAGE/$NAME/$id"
  (cd "$src" && find . \
      \( -name test -o -name tests -o -name node_modules \) -prune -o \
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
