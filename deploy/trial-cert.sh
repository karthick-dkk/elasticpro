#!/usr/bin/env bash
# Issue the trial's self-signed certificate: privkey.pem and fullchain.pem in DIR (default ./tls).
#
#   ./trial-cert.sh [DIR]
#
# It carries a subjectAltName, because a client that verifies TLS (curl, PHP, a browser, the
# Zabbix module's "Verify TLS" rule for Cluster Management edit rights) matches the address it
# dialled against the SAN and ignores the CN:
#   DNS:elasticpro.trial, DNS:<this host's name>, IP:<each non-loopback IPv4 of this host>, IP:127.0.0.1
# and basic constraints CA:TRUE, so the same file can be installed as a trusted CA on the client
# (see deploy/README.md). 825 days is the longest lifetime the browsers still accept. Throwaway:
# not for a real deployment.
set -euo pipefail

DIR=${1:-tls}

host_ips() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}'
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '$1 == "inet" {print $2}'
  fi
}

san="DNS:elasticpro.trial"
name=$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)
case "$name" in ""|localhost|localhost.*|elasticpro.trial) ;; *) san="$san,DNS:$name" ;; esac
seen=" 127.0.0.1 "
for ip in $(host_ips); do
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  case "$seen" in *" $ip "*) continue ;; esac
  case "$ip" in 127.*|169.254.*|0.*) continue ;; esac
  seen="$seen$ip "; san="$san,IP:$ip"
done
san="$san,IP:127.0.0.1"

mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$DIR/privkey.pem" -out "$DIR/fullchain.pem" -subj "/CN=elasticpro.trial" \
  -addext "subjectAltName=$san" -addext "basicConstraints=critical,CA:TRUE" 2>/dev/null
echo "  certificate names: ${san//,/ }"
