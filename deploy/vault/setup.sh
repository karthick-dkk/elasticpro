#!/bin/sh
# One-time Vault setup for ElasticPro + Zabbix. Idempotent: safe to run again.
#
# Writes, all 0600/0640 and never printed:
#   secrets/vault-init.json     unseal key + root token (keep offline in production)
#   secrets/unseal_key          for the test-only unsealer
#   ../secrets/vault_role_id    ElasticPro's AppRole role_id   (read by the core)
#   ../secrets/vault_secret_id  ElasticPro's AppRole secret_id (read by the core)
#   ../secrets/vault_write_*    the write-only AppRole, for zabbix.createHosts
#   ../zabbix/stack/secrets/zabbix-vault.env   VAULT_TOKEN for the Zabbix server
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p secrets
V() { docker compose exec -T -e VAULT_TOKEN="${ROOT:-}" vault vault "$@"; }

if ! V status -format=json | grep -q '"initialized": true'; then
  V operator init -key-shares=1 -key-threshold=1 -format=json > secrets/vault-init.json
  echo "initialized"
fi
python3 -c 'import json;print(json.load(open("secrets/vault-init.json"))["unseal_keys_b64"][0])' > secrets/unseal_key
chmod 644 secrets/unseal_key       # read inside the unsealer container; the directory is 700
ROOT=$(python3 -c 'import json;print(json.load(open("secrets/vault-init.json"))["root_token"])')
V status -format=json | grep -q '"sealed": false' || V operator unseal "$(cat secrets/unseal_key)" >/dev/null
echo "unsealed"

# KV version 2 at secret/ — the layout Zabbix's HashiCorp support expects.
V secrets list -format=json | grep -q '"secret/"' || V secrets enable -path=secret kv-v2 >/dev/null
echo "kv-v2 at secret/"

# Read-only, and only under secret/elasticpro/. Neither reader can list or write.
printf 'path "secret/data/elasticpro/*" { capabilities = ["read"] }\n' | V policy write elasticpro-read - >/dev/null
printf 'path "secret/data/elasticpro/*" { capabilities = ["read"] }\n' | V policy write zabbix-read - >/dev/null
echo "policies: elasticpro-read, zabbix-read"

# ElasticPro: AppRole. Short-lived tokens it renews by logging in again.
V auth list -format=json | grep -q '"approle/"' || V auth enable approle >/dev/null
V write auth/approle/role/elasticpro token_policies=elasticpro-read token_ttl=1h token_max_ttl=4h \
      secret_id_ttl=0 secret_id_num_uses=0 >/dev/null
V read -field=role_id auth/approle/role/elasticpro/role-id > ../secrets/vault_role_id
[ -s ../secrets/vault_secret_id ] || V write -f -field=secret_id auth/approle/role/elasticpro/secret-id > ../secrets/vault_secret_id
chmod 640 ../secrets/vault_role_id ../secrets/vault_secret_id    # the core runs with this group
echo "approle: elasticpro"

# ElasticPro's writer, used only by zabbix.createHosts to store the password of a
# cluster it makes a Zabbix host for. Create and update, and not read: the identity that
# writes passwords cannot read any back.
printf 'path "secret/data/elasticpro/*" { capabilities = ["create", "update"] }\n' | V policy write elasticpro-write - >/dev/null
V write auth/approle/role/elasticpro-provision token_policies=elasticpro-write token_ttl=15m token_max_ttl=1h \
      secret_id_ttl=0 secret_id_num_uses=0 >/dev/null
V read -field=role_id auth/approle/role/elasticpro-provision/role-id > ../secrets/vault_write_role_id
[ -s ../secrets/vault_write_secret_id ] || V write -f -field=secret_id auth/approle/role/elasticpro-provision/secret-id > ../secrets/vault_write_secret_id
chmod 640 ../secrets/vault_write_role_id ../secrets/vault_write_secret_id
echo "approle: elasticpro-provision (write-only)"

# Zabbix server: it takes a token, not AppRole, and does not renew it. One year, then
# rotate: vault token create -orphan -policy=zabbix-read -ttl=8760h
V write sys/auth/token/tune max_lease_ttl=8760h >/dev/null
ZENV=../zabbix/stack/secrets/zabbix-vault.env
if [ ! -s "$ZENV" ]; then
  TOK=$(V token create -orphan -policy=zabbix-read -ttl=8760h -display-name=zabbix-server -field=token)
  printf 'VAULT_TOKEN=%s\n' "$TOK" > "$ZENV"
fi
chmod 600 "$ZENV"
echo "zabbix token written"
