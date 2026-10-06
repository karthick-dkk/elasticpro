#!/usr/bin/env bash
# Add or update one user in the phase-1 auth gate. Prompts for the password.
#   ./make-htpasswd.sh alice
set -euo pipefail
cd "$(dirname "$0")"
[ $# -eq 1 ] || { echo "usage: $0 <username>"; exit 1; }
touch nginx/htpasswd
docker run --rm -i -v "$PWD/nginx:/w" httpd:2.4-alpine htpasswd -B /w/htpasswd "$1"
echo "users now in nginx/htpasswd:"; cut -d: -f1 nginx/htpasswd | sed 's/^/  /'
