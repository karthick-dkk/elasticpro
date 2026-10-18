#!/usr/bin/env bash
# Check that deploy/zabbix/MODULES_REF pins what it says it pins.
#
#   tools/check-modules-pin.sh --modules-src DIR            a checkout of the modules project
#   tools/check-modules-pin.sh --ref-only                   only the file's own shape, no checkout
#   tools/check-modules-pin.sh --modules-src DIR --ref FILE use another file than deploy/zabbix/MODULES_REF
#
# MODULES_REF holds two facts that have to move together: the modules commit (the first line that
# is not a comment) and the modules version, on a comment line `# modules X.Y.Z`. This fails when
#
#   * there is no such version line, or more than one, or no 40-character commit;
#   * the checkout is a git checkout at a different commit than the pin;
#   * any zabbix/*/manifest.json in the checkout carries another version than the one named;
#   * the checkout's zabbix/CHANGELOG.md has no "## X.Y.Z" section for it.
#
# build.yml runs it on the checkout it just made at the pinned commit, so a release cannot go out
# carrying modules of a different version than the one MODULES_REF (and the docs) say. Moving the
# pin: cut the modules release (a v<version> tag on the modules project), then set both lines.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REF=$ROOT/deploy/zabbix/MODULES_REF
SRC=
REF_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --modules-src) SRC=${2:?--modules-src needs a directory}; shift 2 ;;
    --ref) REF=${2:?--ref needs a file}; shift 2 ;;
    --ref-only) REF_ONLY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
[ -f "$REF" ] || fail "$REF is missing"

# The same expression the release workflow and the docs use for the commit.
COMMIT=$(grep -v '^[[:space:]]*#' "$REF" | grep -v '^[[:space:]]*$' | head -1 | tr -d '[:space:]' || true)
[[ $COMMIT =~ ^[0-9a-f]{40}$ ]] || fail "$REF must hold a full 40-character commit SHA on its first line that is not a comment, got: ${COMMIT:-nothing}"

LINES=$(sed -n 's/^#[[:space:]]*modules[[:space:]][[:space:]]*\(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$REF")
N=$(printf '%s' "$LINES" | grep -c . || true)
[ "$N" = 1 ] || fail "$REF needs exactly one comment line '# modules X.Y.Z' naming the modules version the commit carries (found $N)"
WANT=$LINES
[[ $WANT =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail "$REF: '# modules $WANT' is not an X.Y.Z version"

if [ "$REF_ONLY" = 1 ]; then
  printf '✓ %s pins %s, modules %s (shape only; no checkout was compared)\n' "$(basename "$REF")" "${COMMIT:0:7}" "$WANT"
  exit 0
fi

[ -n "$SRC" ] || fail "--modules-src DIR is needed (or --ref-only)"
[ -d "$SRC" ] || fail "--modules-src $SRC is not a folder"
if [ -f "$SRC/zabbix/sync-assets.mjs" ]; then Z=$SRC/zabbix; else Z=$SRC; fi
[ -d "$Z/clients-module" ] || fail "$SRC is not a checkout of integration-zabbix-elasticpro (no clients-module/)"

if git -C "$Z" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  HEAD=$(git -C "$Z" rev-parse HEAD)
  [ "$HEAD" = "$COMMIT" ] || fail "the checkout is at ${HEAD:0:7}, but MODULES_REF pins ${COMMIT:0:7}"
  CHECKED="at ${COMMIT:0:7}"
else
  echo "! $Z is not a git checkout — the commit itself could not be compared" >&2
  CHECKED="commit not verified"
fi

BAD=()
COUNT=0
for mf in "$Z"/*/manifest.json; do
  [ -f "$mf" ] || continue
  COUNT=$((COUNT + 1))
  got=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",]*\).*/\1/p' "$mf" | head -1)
  [ "$got" = "$WANT" ] || BAD+=("$(basename "$(dirname "$mf")") has ${got:-no version}")
done
[ "$COUNT" -gt 0 ] || fail "no module manifests under $Z"
[ ${#BAD[@]} -eq 0 ] || fail "MODULES_REF says modules $WANT, but in the commit ${COMMIT:0:7}: $(IFS=,; echo "${BAD[*]}" | sed 's/,/, /g'). Move the pin to a commit that carries $WANT, or change the '# modules' line"

if [ -f "$Z/CHANGELOG.md" ]; then
  grep -qx "## $WANT" "$Z/CHANGELOG.md" || fail "$Z/CHANGELOG.md has no '## $WANT' section"
else
  fail "$Z/CHANGELOG.md is missing — the modules project keeps one, with a section per version"
fi

printf '✓ MODULES_REF pins %s (%s): %s manifests carry modules %s, and the CHANGELOG has its section\n' "${COMMIT:0:7}" "$CHECKED" "$COUNT" "$WANT"
