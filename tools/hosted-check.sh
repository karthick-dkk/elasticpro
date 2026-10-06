#!/usr/bin/env bash
# Hosted-mode contract for elasticpro-bridge, checked black-box against the real binary:
#
#   1. with ELASTICPRO_BIND set to a non-loopback address, a request without X-Auth-User is
#      refused, one with it is served, and a blank header is not an identity;
#   2. every write is audited on stdout as JSON with the user's name, reads are not;
#   3. the default (loopback) mode needs no header at all.
#
# The audit stream is on STDOUT on purpose: that is what `docker compose logs` captures.
#
#   cargo build -p elasticpro-core --features bridge --bin elasticpro-bridge
#   tools/hosted-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=${BIN:-target/debug/elasticpro-bridge}
[ -x "$BIN" ] || { echo "build first: cargo build -p elasticpro-core --features bridge --bin elasticpro-bridge"; exit 1; }

free_port() { python3 -c "import socket;s=socket.socket();s.bind(('',0));print(s.getsockname()[1]);s.close()"; }
post() { curl -s -X POST "$1" -H 'content-type: application/json' "${@:2}"; }
field() { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1'))"; }
fail=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; fail=1; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

echo "== hosted mode =="
P=$(free_port); OUT=$(mktemp)
ELASTICPRO_BIND=0.0.0.0 RUST_LOG=info "$BIN" ui "$P" >"$OUT" 2>&1 & PID=$!; disown
trap 'kill $PID 2>/dev/null; rm -f "$OUT"' EXIT
until curl -s -o /dev/null "http://127.0.0.1:$P/"; do sleep 0.2; done
B="http://127.0.0.1:$P/bridge"

# PING is the handshake and has to answer before anyone signs in, so it is not the thing
# to probe for refusal — CONFIG_READ is. What PING owes us instead is silence about the
# estate: it once returned the cluster list, the config path and the request rates to a
# bare curl, which is how that went unnoticed.
check "no header is refused"        "$(post $B -d '{"type":"CONFIG_READ"}' | field kind)" "unauthenticated"
check "blank header is refused"     "$(post $B -H 'x-auth-user:  ' -d '{"type":"CONFIG_READ"}' | field kind)" "unauthenticated"
check "the handshake still answers" "$(post $B -d '{"type":"PING"}' | field ok)" "True"
check "the handshake names nothing" "$(post $B -d '{"type":"PING"}' | python3 -c '
import json,sys
d = json.load(sys.stdin)
named = [k for k in ("clusters","dataDir","configHint","defaultConfigPath",
                     "requests","tunnels","uptimeSec","defaultUser","defaultPasswordUnchanged") if k in d]
print(",".join(named) or "nothing")')" "nothing"
check "a named user is served"      "$(post $B -H 'x-auth-user: alice' -d '{"type":"PING"}' | field ok)" "True"

post $B -H 'x-auth-user: alice' -d '{"type":"WRITE_UNLOCK","on":true}' >/dev/null
post $B -H 'x-auth-user: alice' -d '{"type":"ES","clusterId":"x","method":"DELETE","path":"/idx","allowWrites":true}' >/dev/null
post $B -H 'x-auth-user: alice' -d '{"type":"ES","clusterId":"x","method":"GET","path":"/"}' >/dev/null
sleep 0.3
# Counted by "names a user" rather than by every audit line, because the stream also
# carries things this process did on its own — the scheduled measurement announcing that
# it started is the first of them, and it has no user because nobody asked for it.
AUDIT=$(grep '"target":"audit"' "$OUT" | grep -c '"user":' || true)
check "writes are audited (unlock + delete = 2 lines)" "$AUDIT" "2"
check "the audit line names the user"  "$(grep '"target":"audit"' "$OUT" | grep -c '"user":"alice"')" "2"
check "reads are not audited"          "$(grep '"target":"audit"' "$OUT" | grep -c '"method":"GET"' || true)" "0"

# The one timer in the product. It exists here and nowhere else, it says so on the way
# up, and it is disarmed until an admin arms it — a fresh server writes nothing.
check "the scheduler announces itself" "$(grep -c 'delay sink: timer started' "$OUT" || true)" "1"
# Reading the schedule is as admin-only as arming it: it names the cluster credentials
# would be sent to. Signing in properly is what the in-process tests do; what this
# script is for is proving the refusal reaches the wire.
check "reading it needs a caller"      "$(post $B -d '{"type":"DELAY_SINK_GET"}' | field kind)" "unauthenticated"
check "arming it needs a caller"       "$(post $B -d '{"type":"DELAY_SINK_SET","config":{"enabled":true,"sinkClusterId":"x"}}' | field kind)" "unauthenticated"
check "running it needs a caller"      "$(post $B -d '{"type":"DELAY_SINK_RUN"}' | field kind)" "unauthenticated"

# The notification history is per person. PING offers it before anyone signs in (the UI
# needs to know), and every message about it needs a caller like everything else.
check "PING offers the notification store" "$(post $B -d '{"type":"PING"}' | field notifyStore)" "True"
check "listing it needs a caller"      "$(post $B -d '{"type":"NOTIFY_LIST"}' | field kind)" "unauthenticated"
check "adding to it needs a caller"    "$(post $B -d '{"type":"NOTIFY_PUT","message":"m","kind":"ok"}' | field kind)" "unauthenticated"
check "clearing it needs a caller"     "$(post $B -d '{"type":"NOTIFY_CLEAR"}' | field kind)" "unauthenticated"

# Zabbix sign-in. Off until a secret is set, and a way in only with the right signature.
S="http://127.0.0.1:$P/sso/zabbix"
code_of() { curl -s -o /dev/null -w '%{http_code}' -X POST "$1" -H 'content-type: application/json' "${@:2}"; }
check "zabbix sign-in is off without a secret" "$(code_of $S -d '{}')" "503"
check "a made-up sign-in code is refused"      "$(post $B -d '{"type":"SSO_EXCHANGE","code":"deadbeef"}' | field kind)" "bad_credentials"
check "the cluster view needs a caller"        "$(post $B -d '{"type":"CONFIG_VIEW"}' | field kind)" "unauthenticated"

# The Zabbix connection (Config → Zabbix). PING says it exists; every message about it
# needs a caller — an admin, which the in-process tests sign in as.
check "PING offers the zabbix link"            "$(post $B -d '{"type":"PING"}' | field zabbixLink)" "True"
for t in ZABBIX_LINK_GET ZABBIX_LINK_SET ZABBIX_LINK_TEST ZABBIX_PAIR_BEGIN ZABBIX_UNPAIR; do
  check "$t needs a caller"                    "$(post $B -d "{\"type\":\"$t\"}" | field kind)" "unauthenticated"
done
check "a header with no account is nobody"     "$(post $B -H 'x-auth-user: mallory' -d '{"type":"ZABBIX_LINK_GET"}' | field kind)" "unauthenticated"
# Pairing: with nothing in progress, unsigned and signed-with-anything look the same.
PZ="http://127.0.0.1:$P/zabbix/pair"
PB=$(printf '{"nonce":"n","zabbixUrl":"https://zbx","apiUrl":"https://zbx/api_jsonrpc.php","apiToken":"%s","zabbixVersion":"7.0","ts":%s}' "$(printf 'a%.0s' $(seq 64))" "$(date +%s)")
check "an unsigned pairing is refused"         "$(code_of $PZ -d "$PB")" "401"
check "a guessed signature is refused"         "$(code_of $PZ -H "x-zabbix-module-signature: $(printf '%s' "$PB" | openssl dgst -sha256 -hmac guessed-secret-0123456789abcdef-00 -r | cut -d' ' -f1)" -d "$PB")" "401"
check "and says nothing about why"             "$(post $PZ -d "$PB" | field kind)" "unauthorized"
check "GET is not a pairing"                   "$(curl -s -o /dev/null -w '%{http_code}' "$PZ")" "405"
# Ten a minute per source, enforced by the core itself (nginx has its own in front).
RL=""; for _ in $(seq 1 12); do RL=$(code_of $PZ -d "$PB"); [ "$RL" = "429" ] && break; done
check "pairing is rate limited"                "$RL" "429"
# Nobody may frame an unpaired app; the core says so on every response.
CSP=$(curl -s -D - -o /dev/null "http://127.0.0.1:$P/" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}')
check "frame-ancestors 'none' while unpaired"  "$CSP" "frame-ancestors 'none'"
for _ in $(seq 1 25); do
  N=$(grep '"target":"audit"' "$OUT" | grep -c 'zabbix pairing refused' || true); [ "$N" -ge 3 ] && break; sleep 0.2
done
check "every refused pairing is audited"       "$([ "$N" -ge 3 ] && echo yes || echo "no ($N)")" "yes"
check "and no secret reaches the log"          "$(grep -c 'guessed-secret' "$OUT" || true)" "0"
kill $PID; wait $PID 2>/dev/null || true

echo "== hosted mode, allowed sources and a server frame-ancestors =="
P4=$(free_port); OUT4=$(mktemp)
ELASTICPRO_BIND=0.0.0.0 ELASTICPRO_ZABBIX_ALLOWED_SOURCES="10.99.0.0/16" ELASTICPRO_FRAME_ANCESTORS="https://zbx.example.com" \
  ELASTICPRO_ZABBIX_SSO_SECRET="allowed-sources-secret-0123456789abcdef" RUST_LOG=info "$BIN" ui "$P4" >"$OUT4" 2>&1 & PID4=$!; disown
trap 'kill $PID $PID4 2>/dev/null; rm -f "$OUT" "$OUT4"' EXIT
until curl -s -o /dev/null "http://127.0.0.1:$P4/"; do sleep 0.2; done
check "pairing from outside the list is 403"   "$(code_of http://127.0.0.1:$P4/zabbix/pair -d '{}')" "403"
check "sign-in from outside the list is 403"   "$(code_of http://127.0.0.1:$P4/sso/zabbix -d '{}')" "403"
check "X-Real-IP inside it gets past the list" "$(code_of http://127.0.0.1:$P4/zabbix/pair -H 'x-real-ip: 10.99.4.5' -d '{}')" "401"
CSP=$(curl -s -D - -o /dev/null "http://127.0.0.1:$P4/" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}')
check "the server's frame-ancestors wins"      "$CSP" "frame-ancestors https://zbx.example.com"
kill $PID4; wait $PID4 2>/dev/null || true

echo "== hosted mode, zabbix sign-in on =="
SECRET="hosted-check-secret-0123456789abcdef"
P3=$(free_port); OUT3=$(mktemp)
ELASTICPRO_BIND=0.0.0.0 ELASTICPRO_ZABBIX_SSO_SECRET="$SECRET" RUST_LOG=info "$BIN" ui "$P3" >"$OUT3" 2>&1 & PID3=$!; disown
trap 'kill $PID $PID3 2>/dev/null; rm -f "$OUT" "$OUT3"' EXIT
until curl -s -o /dev/null "http://127.0.0.1:$P3/"; do sleep 0.2; done
S3="http://127.0.0.1:$P3/sso/zabbix"
body() { printf '{"username":"%s","zabbix_user_type":%s,"groups":[],"ts":%s,"nonce":"%s"}' "$1" "$2" "$(date +%s)" "hc-$RANDOM$RANDOM$RANDOM$RANDOM"; }
sig()  { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1; }
BODY=$(body alice 2)
check "an unsigned request is refused"   "$(code_of $S3 -d "$BODY")" "401"
check "a wrongly signed one is refused"  "$(code_of $S3 -H "x-zabbix-module-signature: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac wrong-secret-0123456789abcdef0000 -r | cut -d' ' -f1)" -d "$BODY")" "401"
GOOD=$(post $S3 -H "x-zabbix-module-signature: $(sig "$BODY")" -d "$BODY")
check "a correctly signed one gets a code" "$(echo "$GOOD" | field ok)" "True"
check "and the same request cannot be replayed" "$(code_of $S3 -H "x-zabbix-module-signature: $(sig "$BODY")" -d "$BODY")" "401"
CODE=$(echo "$GOOD" | field sso_code)
# Built here rather than inline: a comma inside braces in a nested quote is brace
# expansion waiting to happen, and it once turned this request into two bad ones.
EX=$(printf '{"type":"SSO_EXCHANGE","code":"%s"}' "$CODE")
check "the code becomes an operator session" "$(post http://127.0.0.1:$P3/bridge -d "$EX" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("caller",{}).get("role"))')" "operator"
check "and is spent"                        "$(post http://127.0.0.1:$P3/bridge -d "$EX" | field kind)" "bad_credentials"
# The code issued, then the session it became. Waited for rather than read once: the log
# is written by the server, not by this script, and may land a moment after the reply.
for _ in $(seq 1 25); do
  N=$(grep '"target":"audit"' "$OUT3" | grep -c 'alice@zabbix' || true); [ "$N" -ge 2 ] && break; sleep 0.2
done
check "the sign-in is audited"              "$N" "2"
kill $PID3; wait $PID3 2>/dev/null || true

echo "== dev mode (loopback) =="
P2=$(free_port)
"$BIN" ui "$P2" >/dev/null 2>&1 & PID=$!; disown
until curl -s -o /dev/null "http://127.0.0.1:$P2/"; do sleep 0.2; done
check "no header needed on loopback" "$(post http://127.0.0.1:$P2/bridge -d '{"type":"PING"}' | field ok)" "True"
# Loopback is the portable edition: an app that is only running while somebody has it
# open must not offer to do anything every two hours.
check "no scheduler off hosted"     "$(post http://127.0.0.1:$P2/bridge -d '{"type":"DELAY_SINK_GET"}' | field supported)" "False"

[ $fail -eq 0 ] && echo "ok: hosted-mode contract holds" || { echo "FAILED"; exit 1; }
