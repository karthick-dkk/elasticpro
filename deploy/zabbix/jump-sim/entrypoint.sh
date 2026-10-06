#!/bin/sh
# Host keys on first start; the Zabbix server's public key is the only way in.
set -e
ssh-keygen -A >/dev/null
install -d -m 700 -o elasticpro -g elasticpro /home/elasticpro/.ssh
install -m 600 -o elasticpro -g elasticpro /authorized_keys /home/elasticpro/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e
