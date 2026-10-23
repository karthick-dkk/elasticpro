#!/usr/bin/env bash
# The version, in the four places it has to agree, and the one command that moves it.
#
#   tools/version.sh            print the workspace version
#   tools/version.sh --check    fail if the four disagree, naming which
#   tools/version.sh --set X.Y.Z   move all four at once
#   tools/version.sh --tag vX.Y.Z  print the tag's version, or fail if it disagrees
#
# Why this exists. The version lives in Cargo.toml, in Cargo.lock once per workspace
# member, in the three support-image pins in deploy/docker-compose.yml, and in the
# CHANGELOG heading. Each has bitten a release on its own:
#
#   * a bump that patched one Cargo.lock member and not the other failed the release
#     build with "cannot update the lock file ... --locked", exit 101, long after the
#     pull request was green;
#   * compose pins moved to a version whose images did not exist yet, so the hosted
#     trial could not pull them and reported the stack as down;
#   * the workspace said 0.4.0 while the tag said v0.3.2, so every asset job was
#     skipped and the release came out with nothing but GitHub's source archives.
#
# --check runs in ci.yml on every change, so drift fails a pull request instead of a
# release. build.yml and docker.yml separately refuse a tag that disagrees with
# Cargo.toml, which is the other half: this file keeps the repository self-consistent,
# those keep the tag honest about it.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=deploy/docker-compose.yml
CHANGELOG=CHANGELOG.md
# Put under a new version's heading by --set; --check fails until it is replaced by the notes.
PLACEHOLDER="(write this release's entry before tagging)"

# The one definition. Everything else is checked against it.
workspace_version() {
  sed -n 's/^version *= *"\(.*\)".*/\1/p' Cargo.toml | head -1
}

# Workspace members, so a member added later is checked without editing this list.
members() {
  sed -n '/^members *= *\[/,/\]/p' Cargo.toml \
    | grep -oE '"[^"]+"' | tr -d '"' \
    | while read -r dir; do
        [ -f "$dir/Cargo.toml" ] || continue
        sed -n 's/^name *= *"\(.*\)".*/\1/p' "$dir/Cargo.toml" | head -1
      done
}

# A package's version as Cargo.lock records it.
lock_version() {
  awk -v want="$1" '
    $0 == "name = \"" want "\"" { found = 1; next }
    found && /^version = / { gsub(/^version = "|"$/, ""); print; exit }
  ' Cargo.lock
}

check() {
  local v fail=0
  v=$(workspace_version)
  [ -n "$v" ] || { echo "no version line in the workspace Cargo.toml" >&2; exit 1; }

  for m in $(members); do
    local lv
    lv=$(lock_version "$m")
    if [ -z "$lv" ]; then
      echo "Cargo.lock has no entry for the workspace member $m" >&2; fail=1
    elif [ "$lv" != "$v" ]; then
      echo "Cargo.lock says $m is $lv, Cargo.toml says $v — run cargo update -p $m --precise $v" >&2; fail=1
    fi
  done

  # Every pinned support image, whatever they are called, must be on this version.
  # Only real `image:` lines: the file also mentions an old tag in a comment, explaining
  # an incident, and a checker that reads prose would fail on the documentation.
  while IFS= read -r line; do
    local pin=${line##*:}
    [ "$pin" = "$v" ] || {
      echo "$COMPOSE pins ${line%%:*} at $pin, Cargo.toml says $v" >&2; fail=1; }
  done < <(grep -E '^[[:space:]]*image:' "$COMPOSE" \
             | grep -oE 'karthickdk02/[a-z-]+:[0-9][0-9A-Za-z.-]*' || true)

  # Notes for the next release may sit on top as "## Unreleased" or "## Unreleased (x.y.z)"
  # while changes land; the release heading under them must still be this version.
  local head
  head=$(grep '^## ' "$CHANGELOG" | grep -vE '^## Unreleased( \([0-9][0-9A-Za-z.-]*\))?$' | head -1 | sed 's/^## *//')
  [ "$head" = "$v" ] || {
    echo "$CHANGELOG opens with '$head', Cargo.toml says $v — the release needs its entry" >&2; fail=1; }
  if grep -qF "$PLACEHOLDER" "$CHANGELOG"; then
    echo "$CHANGELOG still has the placeholder under ## $v — write the release notes" >&2; fail=1
  fi

  [ "$fail" -eq 0 ] || exit 1
  echo "version $v is consistent across Cargo.toml, Cargo.lock, $COMPOSE and $CHANGELOG"
}

set_to() {
  local new=$1 old
  echo "$new" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || {
    echo "not a version: $new" >&2; exit 1; }
  old=$(workspace_version)
  [ "$new" != "$old" ] || { echo "already $new"; exit 0; }

  # Line-anchored, so a dependency that happens to be on the same version is untouched.
  sed -i.bak "s/^version = \"$old\"$/version = \"$new\"/" Cargo.toml && rm -f Cargo.toml.bak
  # cargo writes the lock. Hand-editing it is what broke two releases.
  for m in $(members); do
    cargo update -p "$m" --precise "$new" --offline >/dev/null 2>&1 \
      || cargo update -p "$m" --precise "$new" >/dev/null
  done
  sed -i.bak -E "s|(karthickdk02/[a-z-]+):$old|\1:$new|g" "$COMPOSE" && rm -f "$COMPOSE.bak"
  # A new heading for the new version, above the last release's — never a rename of it: that
  # overwrote 0.3.15's heading with 0.3.16 and 0.3.16's with 0.3.17. An entry already written
  # for the new version is kept; an "## Unreleased" one becomes it.
  if grep -q "^## $new\$" "$CHANGELOG"; then :
  elif grep -qE "^## Unreleased( \($new\))?\$" "$CHANGELOG"; then
    sed -i.bak -E "s/^## Unreleased( \($new\))?\$/## $new/" "$CHANGELOG" && rm -f "$CHANGELOG.bak"
  else
    awk -v v="$new" -v p="$PLACEHOLDER" '!done && /^## /{print "## " v "\n\n" p "\n"; done=1} {print}' "$CHANGELOG" > "$CHANGELOG.new" \
      && mv "$CHANGELOG.new" "$CHANGELOG"
  fi

  echo "moved $old -> $new"
  check
}

# Does a tag name this source? Only the part in front of the first hyphen has to match,
# so a pre-release tag is allowed to carry an identifier the app version cannot (the MSI
# target rejects one). build.yml and docker.yml both ask this, so the answer is here once
# rather than as three copies of the same shell.
matches_tag() {
  local tag=$1 want v
  want=${tag#v}
  v=$(workspace_version)
  [ -n "$v" ] || { echo "no version line in the workspace Cargo.toml" >&2; exit 1; }
  [ "${want%%-*}" = "$v" ] || {
    echo "tag $tag does not match the workspace version $v — bump with tools/version.sh --set, or move the tag" >&2
    exit 1
  }
  echo "$want"
}

case "${1:-}" in
  --check) check ;;
  --tag)   matches_tag "${2:?usage: tools/version.sh --tag vX.Y.Z}" ;;
  --set)   set_to "${2:?usage: tools/version.sh --set X.Y.Z}" ;;
  "")      workspace_version ;;
  *)       echo "usage: tools/version.sh [--check | --set X.Y.Z | --tag vX.Y.Z]" >&2; exit 1 ;;
esac
