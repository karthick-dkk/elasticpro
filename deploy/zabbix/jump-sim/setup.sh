#!/bin/sh
# Makes the Zabbix server's SSH key pair (once) in the stack's ssh-keys volume, owned by the
# zabbix user (1997), and copies only the public half here for the simulated jump host.
# On a real Windows jump host the same public key goes in the jump user's authorized_keys.
set -e
cd "$(dirname "$0")"
vol=zabbix_ssh-keys
docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create "$vol" >/dev/null
docker run --rm -v "$vol":/k alpine:3.20 sh -c '
  apk add --no-cache openssh-keygen >/dev/null
  [ -f /k/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C zabbix-server -f /k/id_ed25519
  chown -R 1997:1995 /k && chmod 700 /k && chmod 600 /k/id_ed25519 && chmod 644 /k/id_ed25519.pub
  cat /k/id_ed25519.pub' > authorized_keys
echo "public key written to $(pwd)/authorized_keys"
