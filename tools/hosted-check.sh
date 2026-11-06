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
# Exactly three arguments, or the check is vacuous: under bash 3.2 (macOS) escaped-quote JSON
# inside "$( )" brace-expands, and a check given its answer in pieces compared two of them.
check(){ [ $# -eq 3 ] || { bad "$1 (check got $# args)"; return; }; if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

echo "== hosted mode =="
P=$(free_port); OUT=$(mktemp)
# X-Auth-User counts only with PROXY_AUTH on and the proxy named; this instance plays the
# authenticating proxy from loopback. The second instance below checks the default: ignored.
ELASTICPRO_BIND=0.0.0.0 ELASTICPRO_PROXY_AUTH=1 ELASTICPRO_TRUSTED_PROXIES=127.0.0.1/32 RUST_LOG=info "$BIN" ui "$P" >"$OUT" 2>&1 & PID=$!; disown
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

# "Your settings" are kept with the account (user_prefs.rs) and the running-snapshot reading
# comes from the fleet cache (SNAPSHOT_RUNNING). PING offers both before anyone signs in; every
# message about them needs a caller (the signed-in checks are in the sessions section below).
check "PING offers account settings"        "$(post $B -d '{"type":"PING"}' | field userPrefs)" "True"
check "reading them needs a caller"         "$(post $B -d '{"type":"PREFS_GET"}' | field kind)" "unauthenticated"
check "setting them needs a caller"         "$(post $B -d '{"type":"PREFS_SET","prefs":{"theme":"warm"}}' | field kind)" "unauthenticated"
check "PING offers the running-snapshot reading" "$(post $B -d '{"type":"PING"}' | field snapshotRunning)" "True"
check "reading it needs a caller"           "$(post $B -d '{"type":"SNAPSHOT_RUNNING"}' | field kind)" "unauthenticated"

# The daily volume record (docs/VOLUME.md). Reading it names sources and field values, and
# Refresh now sends searches, so every message needs a caller; the roles are proved in-process
# (tests/volume.rs). Its timer logs "volume daily: timer started" without a user, so the
# audit count above is unchanged — and this instance has no data dir, so no timer at all.
for t in VOLUME_SETTINGS VOLUME_FIELDS_CHECK VOLUME_DAILY VOLUME_MONTHLY VOLUME_BREAKDOWN VOLUME_MONTHLY_ALL VOLUME_RUN VOLUME_LAYOUT_GET VOLUME_LAYOUT_SET VOLUME_PATTERN_CHECK; do
  check "$t needs a caller"              "$(post $B -d '{"type":"'"$t"'","clusterId":"x"}' | field kind)" "unauthenticated"
done

# Volume reports and mail (docs/VOLUME.md "Reports and mail"): generating a report reads the
# record, downloading hands over a file, the mail settings hold a credential and MAIL_TEST
# sends a mail — every one needs a caller. Roles and ownership are proved in-process
# (tests/report.rs, tests/report_types.rs). The report timer, like the volume timer, logs
# without a user. HOSTS_QUERY (0.3.54) reads volume by host's day files: a caller's too.
for t in REPORT_RUN REPORT_JOBS REPORT_STOP REPORT_CLEAR REPORT_DOWNLOAD REPORT_CONCURRENCY_SET \
         MAIL_SETTINGS_GET MAIL_SETTINGS_SET MAIL_TEST REPORT_SCHEDULE_GET REPORT_SCHEDULE_SET REPORT_SEND_NOW HOSTS_QUERY; do
  check "$t needs a caller"              "$(post $B -d '{"type":"'"$t"'","clusterIds":["x"],"to":"a@example.com"}' | field kind)" "unauthenticated"
done

# The credentials the server keeps (0.3.42; CREDENTIAL_PROMOTE since 0.3.46): an admin's, so
# never a caller-less request's. Roles and the promote itself are proved in-process
# (tests/cluster_save.rs, tests/default_credential.rs).
for t in CREDENTIAL_STATUS CREDENTIAL_SET CREDENTIAL_CLEAR CREDENTIAL_PROMOTE; do
  check "$t needs a caller"              "$(post $B -d '{"type":"'"$t"'","cluster":"*","from":"x"}' | field kind)" "unauthenticated"
done

# The history store (docs/HISTORY.md): where the core writes unattended, with a credential it
# keeps. Every message needs a caller; the roles, the two gates and the guard are proved
# in-process (tests/history_store.rs, tests/history_store_gate.rs).
for t in HISTORY_STORE_GET HISTORY_STORE_SET HISTORY_STORE_TEST HISTORY_STORE_ARM HISTORY_STORE_BACKFILL HISTORY_QUERY; do
  check "$t needs a caller"              "$(post $B -d '{"type":"'"$t"'","on":true,"clusterId":"x","stream":"volume","settings":{"url":"http://x:9200"}}' | field kind)" "unauthenticated"
done

# Cluster type, ULM bucket and whether SLM is expected (0.3.47, cluster_meta.rs): reading it is a
# user's, setting it an admin's — never a caller-less request's. Roles, validation, the Zabbix tag
# seed and the 0600 store are proved in-process (tests/cluster_meta.rs).
for t in CLUSTER_META_GET CLUSTER_META_SET; do
  check "$t needs a caller"              "$(post $B -d '{"type":"'"$t"'","clusterId":"x","meta":{"type":"ci"}}' | field kind)" "unauthenticated"
done

# Plan templates (0.3.53, plan_templates.rs): reading is a user's, replacing an administrator's —
# never a caller-less request's. Roles, validation, the limited admin and the display link are
# proved in-process (tests/plan_templates.rs).
for t in PLAN_TEMPLATES_GET PLAN_TEMPLATES_SET; do
  check "$t needs a caller"              "$(post $B -d '{"type":"'"$t"'","templates":[{"name":"x","roles":[]}]}' | field kind)" "unauthenticated"
done

# Play, the NOC wall display (docs/PLAY.md). Every message needs a caller but one: a TV trades
# its display link's secret for a session (PLAY_EXCHANGE), and a made-up secret gets nothing —
# no session, no cookie. What a display-link session may then send, allowFrom, revoke and
# expiry are proved in-process (tests/play.rs, tests/play_settings.rs).
check "PING offers display links"        "$(post $B -d '{"type":"PING"}' | field playLinks)" "True"
check "PING offers shared acks"          "$(post $B -d '{"type":"PING"}' | field sharedAcks)" "True"
for t in PLAY_LINK_CREATE PLAY_LINK_LIST PLAY_LINK_REVOKE PLAY_LINK_SET PLAY_CONFIG_GET PLAY_CONFIG_SET \
         PLAY_NODE_FORGET PLAY_STATE PLAY_ZOOM_SET PLAY_SHARE_GET PLAY_SHARE_PUT ACK_LIST ACK_SET ACK_CLEAR; do
  check "$t needs a caller"              "$(post $B -d '{"type":"'"$t"'","id":"x","name":"tv","key":"x:y","kind":"delay","clusterId":"x"}' | field kind)" "unauthenticated"
done
check "a made-up display secret is refused" "$(post $B -d '{"type":"PLAY_EXCHANGE","secret":"epdisplay_00"}' | field kind)" "bad_credentials"
check "and sets no cookie"               "$(curl -s -o /dev/null -D - -X POST $B -H 'content-type: application/json' -d '{"type":"PLAY_EXCHANGE","secret":"epdisplay_00"}' | grep -ci '^set-cookie' || true)" "0"

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
  check "$t needs a caller"                    "$(post $B -d '{"type":"'"$t"'"}' | field kind)" "unauthenticated"
done
check "a header with no account is nobody"     "$(post $B -H 'x-auth-user: mallory' -d '{"type":"ZABBIX_LINK_GET"}' | field kind)" "unauthenticated"

# The default: no authenticating proxy, so X-Auth-User names nobody — not even a real account.
# nginx used to fill it from any client's Basic header, unchecked: Admin for the asking.
PD=$(free_port); OUTD=$(mktemp); DD=$(mktemp -d)
ELASTICPRO_BIND=0.0.0.0 ELASTICPRO_DATA_DIR="$DD" RUST_LOG=warn,audit=info "$BIN" ui "$PD" >"$OUTD" 2>&1 & PIDD=$!; disown
# A debug build takes over a minute to come up (the first admin password is derived at start).
for _ in $(seq 1 900); do curl -s -o /dev/null "http://127.0.0.1:$PD/" && break; sleep 0.2; done
check "X-Auth-User is ignored by default"      "$(post "http://127.0.0.1:$PD/bridge" -H 'x-auth-user: Admin' -d '{"type":"USER_LIST"}' | field kind)" "unauthenticated"
# With a data directory the volume timer starts, says so once, and names nobody.
check "the volume timer announces itself"      "$(grep -c 'volume daily: timer started' "$OUTD" || true)" "1"
check "and names no user"                      "$(grep 'volume daily: timer started' "$OUTD" | grep -c '"user":' || true)" "0"
check "the report timer announces itself"      "$(grep -c 'volume report: timer started' "$OUTD" || true)" "1"
check "and it names no user either"            "$(grep 'volume report: timer started' "$OUTD" | grep -c '"user":' || true)" "0"
kill $PIDD 2>/dev/null; rm -rf "$OUTD" "$DD"
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

# The role lookup Cluster Management asks: GET, signed both ways, read-only.
R3="http://127.0.0.1:$P3/sso/zabbix/role"
rclaim() { printf '{"zabbix_user":"%s","zabbix_user_type":2,"ts":%s,"nonce":"%s"}' "$1" "$2" "$3"; }
enc()    { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
RTS=$(date +%s); RN="hc-role-$RANDOM$RANDOM$RANDOM"
RC=$(rclaim alice "$RTS" "$RN"); RH=$(mktemp); RB=$(mktemp)
RCODE=$(curl -s -D "$RH" -o "$RB" -w '%{http_code}' -H "x-zabbix-module-signature: $(sig "$RC")" "$R3?claim=$(enc "$RC")")
check "a signed role lookup is answered"    "$RCODE" "200"
check "with the account's role"             "$(field role <"$RB")" "operator"
RSIG=$(tr -d '\r' <"$RH" | awk -F': ' 'tolower($1)=="x-elasticpro-signature"{print $2}')
WANT=$({ printf '%s\n%s\n' "$RTS" "$RN"; cat "$RB"; } | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
check "and the answer is signed over the question" "$([ -n "$RSIG" ] && [ "$RSIG" = "$WANT" ] && echo yes || echo "no ('$RSIG')")" "yes"
check "the same question cannot be asked twice" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-zabbix-module-signature: $(sig "$RC")" "$R3?claim=$(enc "$RC")")" "401"
RC2=$(rclaim alice "$RTS" "hc-role-bad-$RANDOM$RANDOM")
check "a wrongly signed lookup is refused"  "$(curl -s -o /dev/null -w '%{http_code}' -H "x-zabbix-module-signature: $(printf '%s' "$RC2" | openssl dgst -sha256 -hmac wrong-secret-0123456789abcdef0000 -r | cut -d' ' -f1)" "$R3?claim=$(enc "$RC2")")" "401"
RC3=$(rclaim alice "$((RTS - 600))" "hc-role-old-$RANDOM$RANDOM")
check "a stale lookup is refused"           "$(curl -s -o /dev/null -w '%{http_code}' -H "x-zabbix-module-signature: $(sig "$RC3")" "$R3?claim=$(enc "$RC3")")" "401"
RC4=$(rclaim nobody-here "$(date +%s)" "hc-role-new-$RANDOM$RANDOM")
check "an unknown user has no role"         "$(curl -s -H "x-zabbix-module-signature: $(sig "$RC4")" "$R3?claim=$(enc "$RC4")" | field role)" "None"
check "POST is not a lookup"                "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$R3")" "405"
check "no signature reaches the log"        "$(grep -c "$(sig "$RC")" "$OUT3" || true)" "0"
rm -f "$RH" "$RB"

# The Elasticsearch password Cluster Management hands over: POST, signed both ways, kept
# encrypted, never echoed and never logged.
S3="http://127.0.0.1:$P3/sso/zabbix/cluster-secret"
STS=$(date +%s); SN="hc-secret-$RANDOM$RANDOM$RANDOM"; SPW="hc-pw-$RANDOM$RANDOM"
SB=$(printf '{"cluster":"hc-es","user":"elastic","password":"%s","set_by":"hosted-check","ts":%s,"nonce":"%s"}' "$SPW" "$STS" "$SN")
SH=$(mktemp); SR=$(mktemp)
SCODE=$(curl -s -D "$SH" -o "$SR" -w '%{http_code}' -H 'content-type: application/json' -H "x-zabbix-module-signature: $(sig "$SB")" --data-binary "$SB" "$S3")
check "a signed password hand-over is kept"  "$SCODE" "200"
check "the answer names the cluster"        "$(field cluster <"$SR")" "hc-es"
SSIG=$(tr -d '\r' <"$SH" | awk -F': ' 'tolower($1)=="x-elasticpro-signature"{print $2}')
SWANT=$({ printf '%s\n%s\n' "$STS" "$SN"; cat "$SR"; } | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
check "and is signed over the request"      "$([ -n "$SSIG" ] && [ "$SSIG" = "$SWANT" ] && echo yes || echo "no ('$SSIG')")" "yes"
check "the answer never carries the password" "$(grep -c "$SPW" "$SR" || true)" "0"
check "the same hand-over cannot be replayed" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-zabbix-module-signature: $(sig "$SB")" --data-binary "$SB" "$S3")" "401"
SB2=$(printf '{"cluster":"hc-es","user":"elastic","password":"x","set_by":"hc","ts":%s,"nonce":"hc-secret-bad-%s"}' "$(date +%s)" "$RANDOM$RANDOM")
check "an unsigned hand-over is refused"    "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-zabbix-module-signature: 00' --data-binary "$SB2" "$S3")" "401"
check "GET is not a hand-over"              "$(curl -s -o /dev/null -w '%{http_code}' "$S3")" "405"
check "the password is not in the log"      "$(grep -c "$SPW" "$OUT3" || true)" "0"
rm -f "$SH" "$SR"
kill $PID3; wait $PID3 2>/dev/null || true

echo "== hosted mode, sessions: an HttpOnly cookie, kept across a restart =="
# Signed in once, a person stays signed in: no idle timeout, and a restart of the core keeps
# the session. The browser carries it only as an HttpOnly cookie — never a token a script
# can read or a page could store.
P5=$(free_port); OUT5=$(mktemp); D5=$(mktemp -d); JAR=$(mktemp)
start5() { ELASTICPRO_BIND=0.0.0.0 ELASTICPRO_DATA_DIR="$D5" "$BIN" ui "$P5" >>"$OUT5" 2>&1 & PID5=$!; disown
           until curl -s -o /dev/null "http://127.0.0.1:$P5/"; do sleep 0.2; done; }
start5
trap 'kill $PID $PID5 2>/dev/null; rm -rf "$OUT" "$OUT5" "$D5" "$JAR"' EXIT
B5="http://127.0.0.1:$P5/bridge"
HDR=$(curl -s -D - -o /tmp/ep-login.$$ -X POST "$B5" -H 'content-type: application/json' -c "$JAR" \
        -d '{"type":"LOGIN","name":"Admin","password":"elastic"}' | tr -d '\r' | grep -i '^set-cookie:' || true)
check "login answers ok"                     "$(field ok </tmp/ep-login.$$)" "True"
check "the reply carries no token"           "$(python3 -c 'import json,sys;print("session" in json.load(open(sys.argv[1])))' /tmp/ep-login.$$)" "False"
rm -f /tmp/ep-login.$$
case "$HDR" in *ep_session=*HttpOnly*Secure*SameSite=Strict*) ok "the session is an HttpOnly, Secure, SameSite=Strict cookie";;
  *) bad "session cookie attributes (got '$HDR')";; esac
TOK=$(awk '$6=="ep_session"{print $7}' "$JAR")
cookie() { post "$B5" -H "cookie: ep_session=$TOK" "$@"; }
check "the cookie signs requests in"         "$(cookie -d '{"type":"WHOAMI"}' | python3 -c 'import json,sys;print((json.load(sys.stdin).get("caller") or {}).get("name"))')" "Admin"
check "only a hash of it is on disk"         "$(grep -c "$TOK" "$D5/sessions.json" || true)" "0"
kill $PID5; wait $PID5 2>/dev/null || true
start5
check "a restart keeps the session"          "$(cookie -d '{"type":"WHOAMI"}' | python3 -c 'import json,sys;print((json.load(sys.stdin).get("caller") or {}).get("name"))')" "Admin"

# The emergency stop is an operator's as well as an admin's (roles plan, decision 2): the stop
# alone, through POLICY_PAUSE / POLICY_RESUME; the rest of the policy stays POLICY_SET's, an
# admin's, and POLICY_SET leaves the stop as it is. A user and a display link are refused. Limited operators, the other fields and the
# lengths are proved in-process (tests/policy.rs).
JOP=$(mktemp); JUS=$(mktemp); JTV=$(mktemp)
trap 'kill $PID $PID5 2>/dev/null; rm -rf "$OUT" "$OUT5" "$D5" "$JAR" "$JOP" "$JUS" "$JTV"' EXIT
cookie -d '{"type":"USER_ADD","name":"hc-op","password":"hc-operator-pw-0123","role":"operator"}' >/dev/null
cookie -d '{"type":"USER_ADD","name":"hc-user","password":"hc-user-pw-0123456","role":"user"}' >/dev/null
post "$B5" -c "$JOP" -d '{"type":"LOGIN","name":"hc-op","password":"hc-operator-pw-0123"}' >/dev/null
post "$B5" -c "$JUS" -d '{"type":"LOGIN","name":"hc-user","password":"hc-user-pw-0123456"}' >/dev/null
as_jar() { post "$B5" -H "cookie: ep_session=$(awk '$6=="ep_session"{print $7}' "$1")" "${@:2}"; }
paused() { python3 -c 'import json,sys;d=json.load(sys.stdin);p=(d.get("policy") or {}).get("paused") or {};print(d.get("ok"),p.get("all"),p.get("minutes"),p.get("by"))'; }
check "an operator begins the emergency stop"   "$(as_jar "$JOP" -d '{"type":"POLICY_PAUSE","minutes":15}' | paused)" "True True 15 hc-op"
check "an admin's stale Save does not lift it"  "$(cookie -d '{"type":"POLICY_SET","policy":{"mode":"on-demand","paused":{"all":false}}}' | paused)" "True True 15 hc-op"
check "but sets no other policy field"         "$(as_jar "$JOP" -d '{"type":"POLICY_SET","policy":{"mode":"background"}}' | field kind)" "forbidden"
check "nor smuggles one into the stop"          "$(as_jar "$JOP" -d '{"type":"POLICY_PAUSE","minutes":15,"policy":{"mode":"background"}}' | field kind)" "bad_request"
check "a user may not end it"                   "$(as_jar "$JUS" -d '{"type":"POLICY_RESUME"}' | field kind)" "forbidden"
check "a user may not begin one"                "$(as_jar "$JUS" -d '{"type":"POLICY_PAUSE","minutes":15}' | field kind)" "forbidden"
check "an operator ends it"                     "$(as_jar "$JOP" -d '{"type":"POLICY_RESUME"}' | paused)" "True False None None"
check "and POLICY_SET never begins one"        "$(cookie -d '{"type":"POLICY_SET","policy":{"mode":"on-demand","paused":{"all":true,"minutes":30}}}' | paused)" "True False None None"
SECRET5=$(cookie -d '{"type":"PLAY_LINK_CREATE","name":"hc-tv"}' | field secret)
post "$B5" -c "$JTV" -d "$(printf '{"type":"PLAY_EXCHANGE","secret":"%s"}' "$SECRET5")" >/dev/null
check "a display link is signed in"             "$(as_jar "$JTV" -d '{"type":"WHOAMI"}' | python3 -c 'import json,sys;print((json.load(sys.stdin).get("caller") or {}).get("playOnly"))')" "True"
check "a display link may not begin a stop"     "$(as_jar "$JTV" -d '{"type":"POLICY_PAUSE","minutes":15}' | field kind)" "forbidden"
check "nor end one"                             "$(as_jar "$JTV" -d '{"type":"POLICY_RESUME"}' | field kind)" "forbidden"
check "the operator's mode was never changed"   "$(cookie -d '{"type":"POLICY_GET"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["policy"]["mode"])')" "on-demand"
# Duplicate requests and While Play runs (Config › Requests) are the request policy's like the
# rest: POLICY_SET, an admin's. Bounds, config.txt locking and the scheduler are proved
# in-process (fleet/policy.rs, fleet/scheduler.rs, tests/gap.rs).
gp() { python3 -c 'import json,sys;d=json.load(sys.stdin);p=d.get("policy") or {};print(d.get("ok"),p.get("minGapSec"),(p.get("play") or {}).get("healthSec"),(p.get("play") or {}).get("delayLateSec"))'; }
check "an admin sets the gap and Play's pace"   "$(cookie -d '{"type":"POLICY_SET","policy":{"mode":"on-demand","minGapSec":120,"play":{"healthSec":600,"delayLateSec":1200}}}' | gp)" "True 120 600 1200"
check "kept within bounds"                     "$(cookie -d '{"type":"POLICY_SET","policy":{"mode":"on-demand","minGapSec":5,"play":{"healthSec":600,"delayLateSec":99999}}}' | gp)" "True 30 600 7200"
check "an operator may not set them"            "$(as_jar "$JOP" -d '{"type":"POLICY_SET","policy":{"mode":"on-demand","minGapSec":600}}' | field kind)" "forbidden"
check "nor a user"                              "$(as_jar "$JUS" -d '{"type":"POLICY_SET","policy":{"mode":"on-demand","minGapSec":600}}' | field kind)" "forbidden"
check "nor a display link"                      "$(as_jar "$JTV" -d '{"type":"POLICY_SET","policy":{"mode":"on-demand","play":{"healthSec":60}}}' | field kind)" "forbidden"
check "the admin's values stand"                "$(cookie -d '{"type":"POLICY_GET"}' | gp)" "True 30 600 7200"
# The log delay's late list (docs/PLAY.md): a display link may send the measurement narrowed to
# the late devices — one terms filter on the aggregation's own field — and nothing wider. No
# cluster here: the gate checks the shape first, so a body it lets through ends at no_creds.
# No cluster: the shipped delay fields (device src_hostname, arrival @timestamp) are the only ones.
DELAY='{"size":0,"query":{"bool":{"filter":[{"range":{"@timestamp":{"gte":"now-24h","lte":"now","format":"strict_date_optional_time"}}}FILTER]}},"aggs":{"devices":{"terms":{"field":"src_hostname.keyword","size":500,"order":{"_count":"desc"}},"aggs":{"latest":{"top_hits":{"size":1,"sort":[{"@timestamp":{"order":"desc"}}],"_source":["@timestamp","event.created"]}}}}}}'
es_tv() { python3 -c 'import json,sys;print(json.dumps({"type":"ES","clusterId":"x","method":"POST","path":"/logstash-*/_search?ignore_unavailable=true&allow_no_indices=true","body":sys.argv[1].replace("FILTER",sys.argv[2])}))' "$DELAY" "$1"; }
gate() { python3 -c 'import json,sys;k=json.load(sys.stdin).get("kind");print("refused" if k=="forbidden" else "through")'; }
check "a display link may re-check the late list"      "$(as_jar "$JTV" -d "$(es_tv ',{"terms":{"src_hostname.keyword":["fw-01","fw 02"]}}')" | gate)" "through"
check "the full check as before"                       "$(as_jar "$JTV" -d "$(es_tv '')" | gate)" "through"
check "but not on another field"                       "$(as_jar "$JTV" -d "$(es_tv ',{"terms":{"user.name":["root"]}}')" | gate)" "refused"
check "nor with a wildcard"                            "$(as_jar "$JTV" -d "$(es_tv ',{"terms":{"src_hostname.keyword":["fw-*"]}}')" | gate)" "refused"
check "nor with a second filter"                       "$(as_jar "$JTV" -d "$(es_tv ',{"terms":{"src_hostname.keyword":["a"]}},{"terms":{"src_hostname.keyword":["b"]}}')" | gate)" "refused"
check "nor with a script"                              "$(as_jar "$JTV" -d "$(es_tv ',{"script":{"script":"true"}}')" | gate)" "refused"
# "Your settings" (user_prefs.rs): kept with the account, the caller's own and nobody else's — a
# guest's too; unset is null, not a default; a patch the store does not take saves nothing; a
# display link has none. The running-snapshot reading: any signed-in user, not a display link,
# and with no cluster it answers at once, empty — it never fetches.
pref() { python3 -c 'import json,sys;p=json.load(sys.stdin)["prefs"];print(p["theme"],p["menu"],p["opensOn"])'; }
check "unset is null, not a default"            "$(as_jar "$JUS" -d '{"type":"PREFS_GET"}' | pref)" "None None None"
as_jar "$JUS" -d '{"type":"PREFS_SET","prefs":{"theme":"warm","menu":"left"}}' >/dev/null
check "a setting is kept with the account"      "$(as_jar "$JUS" -d '{"type":"PREFS_GET"}' | pref)" "warm left None"
check "another account has its own"             "$(as_jar "$JOP" -d '{"type":"PREFS_GET"}' | pref)" "None None None"
check "a value the store does not take is refused" "$(as_jar "$JUS" -d '{"type":"PREFS_SET","prefs":{"theme":"neon","menu":"top"}}' | field kind)" "bad_message"
check "and the refused patch saved nothing"     "$(as_jar "$JUS" -d '{"type":"PREFS_GET"}' | pref)" "warm left None"
check "the message cannot name a user"          "$(as_jar "$JOP" -d '{"type":"PREFS_SET","prefs":{"user":"hc-user","theme":"dark"}}' | field kind)" "bad_message"
check "a display link has no settings"          "$(as_jar "$JTV" -d '{"type":"PREFS_GET"}' | field kind)" "forbidden"
check "a user reads the running-snapshot reading" "$(as_jar "$JUS" -d '{"type":"SNAPSHOT_RUNNING"}' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["ok"], d["unknown"], d["running"])')" "True [] []"
check "a display link does not"                 "$(as_jar "$JTV" -d '{"type":"SNAPSHOT_RUNNING"}' | field kind)" "forbidden"
for _ in $(seq 1 25); do
  N=$(grep '"target":"audit"' "$OUT5" | grep '"user":"hc-op"' | grep -c 'emergency stop' || true); [ "$N" -ge 2 ] && break; sleep 0.2
done
check "begun and ended are audited by name"     "$N" "2"
# Roles from Zabbix user groups and the No access pin (docs/ROLES.md): the map, its preview and
# the Zabbix users table are an administrator's; a draft is checked like a save; No access is for
# accounts another system signs in, never one's own, and never the last administrator. The
# sign-in itself, pins beating the map and the lock-out rule are proved in-process
# (tests/zabbix_roles.rs).
check "the Zabbix users table is an admin's"        "$(as_jar "$JOP" -d '{"type":"ZABBIX_USERS"}' | field kind)" "forbidden"
check "so is the role-map preview"                  "$(as_jar "$JOP" -d '{"type":"ZABBIX_ROLEMAP_PREVIEW","roleMap":{}}' | field kind)" "forbidden"
check "nor may a user read the map"                 "$(as_jar "$JUS" -d '{"type":"ZABBIX_ROLEMAP_GET"}' | field kind)" "forbidden"
check "an admin reads the table (nobody from Zabbix yet)" "$(cookie -d '{"type":"ZABBIX_USERS"}' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("ok"),d.get("total"),d.get("groupsFrom"))')" "True 0 lastSignIn"
check "a draft with one group under two roles is refused" "$(cookie -d '{"type":"ZABBIX_ROLEMAP_PREVIEW","roleMap":{"groups":{"admin":["NOC"],"user":["NOC"]}}}' | field kind)" "bad_message"
check "a sound draft previews without writing"      "$(cookie -d '{"type":"ZABBIX_ROLEMAP_PREVIEW","roleMap":{"groups":{"operator":["NOC leads"]},"unmapped":"none"}}' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("ok"),d.get("lockout"),d.get("changes"))')" "True False []"
check "no access is a role only for an account another system signs in" "$(cookie -d '{"type":"USER_SET_ROLE","name":"hc-user","role":"none"}' | field kind)" "bad_request"
check "and never one's own"                         "$(cookie -d '{"type":"USER_SET_ROLE","name":"Admin","role":"none"}' | field kind)" "bad_request"
check "a role that is not one is refused"           "$(cookie -d '{"type":"USER_SET_ROLE","name":"hc-user","role":"emperor"}' | field kind)" "bad_request"
check "the accounts list says what is in force"     "$(cookie -d '{"type":"USER_LIST"}' | python3 -c 'import json,sys;u=[x for x in json.load(sys.stdin)["users"] if x["name"]=="hc-user"][0];print(u.get("noAccess"),u.get("roleInForce"))')" "False user"
# Backend routing (docs/HISTORY.md "Backend routing"): where each kind of record is kept —
# built-in, a copy on the history store, or the store only. An admin's to read and set; a user
# and an operator get neither. This instance has no HISTORY_STORE_WRITES, so the store's gates
# are closed: "Elasticsearch only" still writes the built-in record, queues the store's copy and
# says so, and no monitored cluster is ever written. The store side is proved in-process
# (tests/data_routing.rs).
rt() { python3 -c 'import json,sys;d=json.load(sys.stdin);r=d.get("routing") or {};print(d.get("ok"),r.get("history"),r.get("reports"),r.get("alerts"))'; }
check "routing: PING says the core has it"          "$(cookie -d '{"type":"PING"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["dataRouting"]["supported"])')" "True"
check "routing: built-in is the default for all"    "$(cookie -d '{"type":"DATA_ROUTING_GET"}' | rt)" "True builtin builtin builtin"
check "routing: a user may not read it"             "$(as_jar "$JUS" -d '{"type":"DATA_ROUTING_GET"}' | field kind)" "forbidden"
check "routing: an operator may not set it"         "$(as_jar "$JOP" -d '{"type":"DATA_ROUTING_SET","routing":{"alerts":"es"}}' | field kind)" "forbidden"
check "routing: nor read its status"                "$(as_jar "$JOP" -d '{"type":"DATA_ROUTING_STATUS"}' | field kind)" "forbidden"
check "routing: a mode that is not one is refused"  "$(cookie -d '{"type":"DATA_ROUTING_SET","routing":{"alerts":"cluster"}}' | field kind)" "bad_request"
check "routing: an admin sends alerts to ES only"   "$(cookie -d '{"type":"DATA_ROUTING_SET","routing":{"alerts":"es"}}' | rt)" "True builtin builtin es"
cookie -d '{"type":"PRIME","readOnly":true,"clusters":[{"id":"hc-es","url":"http://127.0.0.1:9"}]}' >/dev/null
check "ES only, gates closed: the silence is taken" "$(cookie -d '{"type":"SILENCE_SET","scope":"cluster","target":"hc-es","minutes":5,"reason":"hosted-check"}' | field ok)" "True"
check "and kept in the built-in store"             "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$D5/silences.json")" "1"
rs() { python3 -c 'import json,sys;d=json.load(sys.stdin);a=d["kinds"]["alerts"];print(d.get("ok"),a["state"],a["store"]["queued"],a["store"]["writing"],"built-in store" in a["line"])'; }
check "and queued for the store, saying so"         "$(cookie -d '{"type":"DATA_ROUTING_STATUS"}' | rs)" "True queued 1 False True"
check "and nothing was written to a monitored cluster" "$(cookie -d '{"type":"REQUEST_LOG"}' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len([r for r in (d.get("recent") or [])+(d.get("inflight") or []) if str(r.get("method","GET")).upper()!="GET"]))')" "0"
# A page may report only what the pages raise: a flood of made-up keys is refused by name,
# queues nothing and evicts nothing; the account is then over its budget (200 in 15 minutes).
FLOOD=$(python3 -c 'import json;print(json.dumps({"type":"ALERT_EVENTS_PUT","events":[{"event":"raised","key":"hc-es:junk-%d"%i} for i in range(150)]}))')
check "a flood of junk alert keys is refused"       "$(cookie -d "$FLOOD" | field kind)" "bad_request"
check "and the queued record is still there"       "$(cookie -d '{"type":"DATA_ROUTING_STATUS"}' | rs)" "True queued 1 False True"
MORE=$(python3 -c 'import json;print(json.dumps({"type":"ALERT_EVENTS_PUT","events":[{"event":"raised","key":"hc-es:heap:n%d"%i} for i in range(60)]}))')
check "and the account is over its budget"         "$(cookie -d "$MORE" | field kind)" "too_many"
check "alerts back to built-in lets the queue go"  "$(cookie -d '{"type":"DATA_ROUTING_SET","routing":{"alerts":"builtin"}}' >/dev/null; cookie -d '{"type":"DATA_ROUTING_STATUS"}' | python3 -c 'import json,sys;a=json.load(sys.stdin)["kinds"]["alerts"];print(a["state"],a["store"]["queued"],a["store"]["dropped"])')" "builtin 0 1"
# Backup and restore (docs/HANDBOOK.md "Backup and restore — the message contract"): an
# administrator's and nobody else's; a backup made without a password carries no secret and a
# sealed one none in the clear; the wrong password is refused; a preview writes nothing; a
# restore keeps the current state first; the Zabbix API token is never in a backup. The
# sections, merge and replace, the format checks and the timer are proved in-process
# (tests/backup.rs).
check "PING offers backup & restore"            "$(post $B5 -d '{"type":"PING"}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("backup",{}).get("supported"))')" "True"
check "the backup status needs a caller"        "$(post $B5 -d '{"type":"BACKUP_STATUS"}' | field kind)" "unauthenticated"
check "an operator may not take a backup"       "$(as_jar "$JOP" -d '{"type":"BACKUP_CREATE"}' | field kind)" "forbidden"
check "nor restore one"                         "$(as_jar "$JOP" -d '{"type":"BACKUP_RESTORE","mode":"merge","file":"{}"}' | field kind)" "forbidden"
check "a display link may not either"           "$(as_jar "$JTV" -d '{"type":"BACKUP_STATUS"}' | field kind)" "forbidden"
BPW="hc-backup-secret-$RANDOM$RANDOM"; ZTOK="$(printf 'ab%.0s' $(seq 1 32))"
# Single-quoted JSON with the variable spliced in: under bash 3.2 (macOS) the escaped-quote form
# brace-expands inside "$( )", check gets its answer in pieces and compares two of them.
check "a credential is kept for the test"       "$(cookie -d '{"type":"CREDENTIAL_SET","cluster":"*","username":"elastic","password":"'"$BPW"'"}' | field ok)" "True"
check "a Zabbix token is kept for the test"     "$(cookie -d '{"type":"ZABBIX_LINK_SET","zabbixUrl":"https://zbx.example.com/","apiToken":"'"$ZTOK"'"}' | field ok)" "True"
BK0=$(cookie -d '{"type":"BACKUP_CREATE"}')
check "a backup without a password is made"     "$(echo "$BK0" | field ok)" "True"
check "and holds no credentials"                "$(echo "$BK0" | field credentials)" "none"
check "not the cluster password"                "$(echo "$BK0" | grep -c "$BPW" || true)" "0"
check "not the Zabbix token"                    "$(echo "$BK0" | grep -c "$ZTOK" || true)" "0"
check "and says what it left out"               "$(echo "$BK0" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("leftOut"), d.get("notes"))')" "1 []"
check "a short backup password is refused"      "$(cookie -d '{"type":"BACKUP_CREATE","password":"short"}' | field kind)" "weak_password"
BK1=$(cookie -d '{"type":"BACKUP_CREATE","password":"hosted-check-backup-pw"}')
check "a sealed backup is made"                 "$(echo "$BK1" | field credentials)" "password"
check "with no secret in the clear"             "$(echo "$BK1" | grep -c -e "$BPW" -e "$ZTOK" || true)" "0"
BKF=$(mktemp); echo "$BK1" | python3 -c 'import json,sys;print(json.dumps({"type":"BACKUP_PREVIEW","password":sys.argv[1],"file":json.load(sys.stdin)["file"]}))' hosted-check-backup-px >"$BKF"
check "the wrong password is refused"           "$(cookie --data-binary "@$BKF" | field kind)" "bad_password"
MARK="$D5/.hc-mark"; touch "$MARK"; sleep 1
echo "$BK1" | python3 -c 'import json,sys;print(json.dumps({"type":"BACKUP_PREVIEW","password":sys.argv[1],"file":json.load(sys.stdin)["file"]}))' hosted-check-backup-pw >"$BKF"
check "the right one previews"                  "$(cookie --data-binary "@$BKF" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("ok"),d.get("credentials",{}).get("state"))')" "True opened"
# Settings files only: the session store, the health samples and the activity log move on their own.
check "and a preview writes nothing"            "$(find "$D5" -type f -newer "$MARK" \( -name '*.json' -o -path '*/backups/*' -o -path '*/config-history/*' \) ! -name sessions.json ! -path '*/health/*' ! -path '*/worker/*' ! -path '*/cache/*' | wc -l | tr -d ' ')" "0"
echo "$BK1" | python3 -c 'import json,sys;print(json.dumps({"type":"BACKUP_RESTORE","mode":"merge","sections":["clusters"],"password":sys.argv[1],"file":json.load(sys.stdin)["file"]}))' hosted-check-backup-pw >"$BKF"
RS=$(cookie --data-binary "@$BKF")
check "a restore answers ok"                    "$(echo "$RS" | field ok)" "True"
BEFORE=$(echo "$RS" | field beforeRestore)
check "and kept the current state first"        "$([ -n "$BEFORE" ] && [ -f "$D5/backups/$BEFORE" ] && echo yes || echo "no ('$BEFORE')")" "yes"
check "kept 0600"                               "$(stat -c '%a' "$D5/backups/$BEFORE" 2>/dev/null || stat -f '%Lp' "$D5/backups/$BEFORE")" "600"
check "in a 0700 directory"                     "$(stat -c '%a' "$D5/backups" 2>/dev/null || stat -f '%Lp' "$D5/backups")" "700"
check "the kept copy has no secret in the clear" "$(grep -c -e "$BPW" -e "$ZTOK" "$D5/backups/$BEFORE" || true)" "0"
check "the kept copy is sealed under the server key" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("credentials",{}).get("scheme"))' "$D5/backups/$BEFORE")" "server"
check "a restore is audited by name"            "$(grep '"target":"audit"' "$OUT5" | grep 'backup restored' | grep -c '"user":"Admin"')" "1"
check "and the backup password never reaches the log" "$(grep -c 'hosted-check-backup-pw' "$OUT5" || true)" "0"
check "the backup timer announces itself"       "$(grep -c 'backup: timer started' "$OUT5" | sed 's/^[1-9][0-9]*$/yes/')" "yes"
rm -f "$BKF" "$MARK"
OUTH=$(curl -s -D - -o /dev/null -X POST "$B5" -H 'content-type: application/json' -H "cookie: ep_session=$TOK" -d '{"type":"LOGOUT"}' | tr -d '\r' | grep -i '^set-cookie:' || true)
case "$OUTH" in *ep_session=\;*Max-Age=0*) ok "signing out clears the cookie";; *) bad "logout cookie (got '$OUTH')";; esac
check "and ends the session"                 "$(cookie -d '{"type":"WHOAMI"}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("caller"))')" "None"
kill $PID5; wait $PID5 2>/dev/null || true

echo "== dev mode (loopback) =="
P2=$(free_port)
"$BIN" ui "$P2" >/dev/null 2>&1 & PID=$!; disown
until curl -s -o /dev/null "http://127.0.0.1:$P2/"; do sleep 0.2; done
check "no header needed on loopback" "$(post http://127.0.0.1:$P2/bridge -d '{"type":"PING"}' | field ok)" "True"
# Loopback is the portable edition: an app that is only running while somebody has it
# open must not offer to do anything every two hours.
check "no scheduler off hosted"     "$(post http://127.0.0.1:$P2/bridge -d '{"type":"DELAY_SINK_GET"}' | field supported)" "False"
# Nor a history store: it is written by the server, the one edition still running at night.
check "no history store off hosted" "$(post http://127.0.0.1:$P2/bridge -d '{"type":"HISTORY_STORE_GET"}' | field supported)" "False"
# Backups can be downloaded here, but nothing is kept or scheduled: a kept backup is a server's.
check "backups: download only off hosted" "$(post http://127.0.0.1:$P2/bridge -d '{"type":"BACKUP_STATUS"}' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("supported"),d.get("keeps"))')" "True False"
kill $PID; wait $PID 2>/dev/null || true

# docs/WORKER.md, black-box: one binary in role worker, one in role core, the same data
# directory (loopback, so no accounts: the one person is the administrator).
echo "== the report worker =="
DW=$(mktemp -d); WP=$(free_port); CP=$(free_port); OUTW=$(mktemp); OUTC=$(mktemp)
ELASTICPRO_ROLE=worker ELASTICPRO_WORKER_PORT=$WP ELASTICPRO_DATA_DIR=$DW RUST_LOG=info "$BIN" ui 0 >"$OUTW" 2>&1 & PIDW=$!; disown
ELASTICPRO_ROLE=core ELASTICPRO_WORKER_URL=http://127.0.0.1:$WP ELASTICPRO_DATA_DIR=$DW RUST_LOG=info "$BIN" ui "$CP" >"$OUTC" 2>&1 & PIDC=$!; disown
trap 'kill $PIDW $PIDC 2>/dev/null; rm -rf "$DW" "$OUTW" "$OUTC"' EXIT
until curl -s -o /dev/null "http://127.0.0.1:$WP/health"; do sleep 0.2; done
until curl -s -o /dev/null "http://127.0.0.1:$CP/"; do sleep 0.2; done
check "the worker answers /health in role worker" "$(curl -s "http://127.0.0.1:$WP/health" | field role)" "worker"
check "the worker serves no UI and no message API" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WP/bridge" -d '{}')" "404"
check "an action without the shared token is refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WP/queue" -d '{}')" "401"
check "one token for both, 0600" "$(stat -c '%a' "$DW/worker/token" 2>/dev/null || stat -f '%Lp' "$DW/worker/token")" "600"
check "the core forwards an action to the worker" "$(post "http://127.0.0.1:$CP/bridge" -d '{"type":"REPORT_CONCURRENCY_SET","n":4}' | field ok)" "True"
got=; for _ in $(seq 1 25); do got=$(post "http://127.0.0.1:$CP/bridge" -d '{"type":"REPORT_JOBS"}' | field concurrency); [ "$got" = 4 ] && break; sleep 0.2; done
check "and reads the worker's jobs.json back" "$got" "4"
check "the core does not start the report timer" "$(grep -c 'volume report: timer started' "$OUTC" || true)" "0"
check "the core says its role" "$(grep -c '"role":"core"' "$OUTC" | tr -d ' ' | sed 's/^[1-9][0-9]*$/yes/')" "yes"
kill $PIDW; wait $PIDW 2>/dev/null || true
check "worker down: an action is worker_unavailable" "$(post "http://127.0.0.1:$CP/bridge" -d '{"type":"REPORT_CONCURRENCY_SET","n":3}' | field kind)" "worker_unavailable"
check "and PING still answers" "$(post "http://127.0.0.1:$CP/bridge" -d '{"type":"PING"}' | field ok)" "True"
check "and the jobs are still read" "$(post "http://127.0.0.1:$CP/bridge" -d '{"type":"REPORT_JOBS"}' | field ok)" "True"
kill $PIDC; wait $PIDC 2>/dev/null || true

[ $fail -eq 0 ] && echo "ok: hosted-mode contract holds" || { echo "FAILED"; exit 1; }
