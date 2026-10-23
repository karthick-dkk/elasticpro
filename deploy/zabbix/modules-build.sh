#!/usr/bin/env bash
# Sourced, not run. The one definition of a module's BUILD file (key=value lines: which modules
# version and commit a folder was made from), used by tools/zabbix-modules-tarball.sh and
# deploy/zabbix/install-modules.sh. ElasticPro -> Settings in Zabbix reads it.
#
#   modules_build_init Z "id:srcdir" ...   Z is the modules project's zabbix/ folder; sets MB_VERSION,
#                                          MB_COMMIT, MB_SHORT, MB_DATE, MB_TREE (warns on stderr)
#   modules_build_write DIR GENERATOR      writes DIR/BUILD; GENERATOR names the script in its comment

modules_build_manifest_version() { sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",]*\).*/\1/p' "$1/manifest.json" | head -1; }

modules_build_init() {
  local Z=$1; shift
  local m v
  MB_VERSION=
  for m in "$@"; do
    v=$(modules_build_manifest_version "${m#*:}")
    if [ -z "$MB_VERSION" ]; then MB_VERSION=$v; elif [ "$v" != "$MB_VERSION" ] && [ "$MB_VERSION" != mixed ]; then MB_VERSION=mixed; fi
  done
  case "$MB_VERSION" in
    mixed) echo "! the modules' manifests do not share one version ($(for m in "$@"; do printf '%s %s, ' "${m%%:*}" "$(modules_build_manifest_version "${m#*:}")"; done | sed 's/, $//')) — BUILD says mixed" >&2 ;;
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "! the manifests' version \"$MB_VERSION\" is not x.y.z — BUILD records it as unknown" >&2; MB_VERSION=unknown ;;
  esac
  MB_COMMIT=unknown; MB_SHORT=unknown; MB_DATE=unknown; MB_TREE=unknown
  if command -v git >/dev/null 2>&1 && git -C "$Z" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    MB_COMMIT=$(git -C "$Z" rev-parse HEAD 2>/dev/null || echo unknown)
    if [ "$MB_COMMIT" != unknown ]; then
      MB_SHORT=$(git -C "$Z" rev-parse --short=7 HEAD)
      MB_DATE=$(git -C "$Z" show -s --format=%cI HEAD)
      if [ -n "$(git -C "$Z" status --porcelain --untracked-files=normal -- . 2>/dev/null)" ]; then MB_TREE=modified; else MB_TREE=clean; fi
    fi
  fi
  [ "$MB_COMMIT" != unknown ] || echo "! $Z is not a git checkout — BUILD records the modules commit as unknown" >&2
  return 0
}

modules_build_write() {
  cat > "$1/BUILD" <<BUILD_EOF
# Written by $2. Read by ElasticPro -> Settings in Zabbix and by zabbix-modules-install.sh.
modules_version=$MB_VERSION
modules_commit=$MB_COMMIT
modules_commit_short=$MB_SHORT
modules_commit_date=$MB_DATE
modules_tree=$MB_TREE
BUILD_EOF
}
