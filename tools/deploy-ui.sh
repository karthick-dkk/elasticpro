#!/usr/bin/env bash
# Ship ui/ to a hosted deployment's bind-mounted UI directory.
#
# COPYFILE_DISABLE is the point of this script existing: macOS tar writes an AppleDouble
# "._name" sidecar for every file carrying an extended attribute, and a plain
# `tar czf - ui | ssh ...` therefore litters the server with dozens of them. They are
# inert, but they are junk in a production directory and they make "is the deployment
# what I built" impossible to answer by comparing file lists.
#
#   HOST=user@203.0.113.12 DEST=/opt/elasticpro_0.1.0/deploy/ui-feature-v1 tools/deploy-ui.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:?set HOST, e.g. test@203.0.113.12}
DEST=${DEST:?set DEST, the ui directory on the server}
SSH=${SSH:-ssh}

echo "→ backing up $DEST"
$SSH "$HOST" "sudo -n tar czf ${DEST%/*}/ui-backup-\$(date +%Y%m%d-%H%M).tgz -C ${DEST%/*} $(basename "$DEST")" \
  || echo "  (backup skipped — sudo needs a password; take one by hand before relying on this)"

echo "→ shipping ui/"
COPYFILE_DISABLE=1 tar czf - ui | $SSH "$HOST" "cat > /tmp/ui-new.tgz"

echo "→ syncing into place"
# Sync INTO the directory, never replace it: the container's bind mount is that
# directory, and swapping it detaches the running container from what is served.
$SSH "$HOST" "sudo -n sh -c 'rm -rf /tmp/ui-stage && mkdir /tmp/ui-stage \
  && tar xzf /tmp/ui-new.tgz -C /tmp/ui-stage \
  && rsync -a --delete /tmp/ui-stage/ui/ $DEST/ \
  && find $DEST -name \"._*\" -delete'"

echo "→ deployed"
