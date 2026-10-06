#!/usr/bin/env bash
# End-to-end trial of the hosted stack on this machine, against the mock cluster.
# Proves the four things the deployment is for:
#   1. no credentials -> 401 at nginx, the core is never reached
#   2. valid credentials -> the UI and the bridge work through TLS
#   3. a write shows up in the core's audit log under the signed-in user's name
#   4. port 8765 is NOT reachable from outside the compose network
set -uo pipefail
cd "$(dirname "$0")"
LISTEN=${LISTEN:-443}
U=alice; PW='test-password-1'
fail=0; ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; fail=1; }

# The certificate, the auth gate and the database password are all gitignored, so on a
# fresh clone — and in CI — none of them exist. Make throwaway ones; never overwrite.
./trial-setup.sh

docker compose build core 2>&1 | tail -2
docker compose up -d 2>&1 | tail -3

# If a container did not start — a port already taken is the usual reason — then whatever
# else happens to answer on $LISTEN would be tested instead, and an unrelated web server
# returning 200 would be reported as "UI served over TLS". Check the stack is actually up
# before believing anything it says.
running=$(docker compose ps --services --filter status=running | sort | tr '\n' ' ')
for svc in core db nginx; do
  case " $running " in
    *" $svc "*) ;;
    *) echo "  ✗ service '$svc' is not running — the trial would be testing something else"
       echo "    running: ${running:-none}"
       docker compose ps -a --format '    {{.Service}}  {{.Status}}'
       docker compose logs --tail 25 "$svc" 2>&1 | sed 's/^/    /'
       exit 1;;
  esac
done

echo "waiting for nginx…"
for i in $(seq 1 40); do
  # 200, not 401: nginx stopped carrying auth_basic when the app grew its own accounts,
  # so the login page is served to anyone who asks and the gate is behind it.
  [ "$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$LISTEN/" 2>/dev/null)" = 200 ] && break
  sleep 1
done
echo
# The edge used to answer 401 to everything, because nginx carried auth_basic. The app
# authenticates itself now, so the login page has to be served to a stranger — the gate is
# the bridge, and what matters is that it refuses the messages and gives nothing away in
# the handshake it must answer.
echo "== 1. no credentials =="
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$LISTEN/")
[ "$code" = 200 ] && ok "GET / serves the login page -> 200" || bad "GET / -> $code (want 200)"

anon=$(curl -sk -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"PING"}')
echo "$anon" | grep -q '"ok":true' \
  && ok "PING answers unauthenticated (the shell must know whether to sign in)" \
  || bad "PING -> $anon"
leaked=$(printf '%s' "$anon" | python3 -c '
import json,sys
d = json.load(sys.stdin)
named = [k for k in ("clusters","dataDir","configHint","defaultConfigPath",
                     "requests","tunnels","uptimeSec","defaultUser","defaultPasswordUnchanged") if k in d]
print(",".join(named))')
[ -z "$leaked" ] && ok "the unauthenticated handshake names nothing" \
                 || bad "unauthenticated PING leaked: $leaked"

for t in CONFIG_READ USER_LIST PINS; do
  kind=$(curl -sk -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' \
           -d "{\"type\":\"$t\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("kind"))')
  [ "$kind" = unauthenticated ] && ok "$t without credentials -> refused" \
                                || bad "$t without credentials -> '$kind' (want unauthenticated)"
done

echo "== 2. with credentials, through TLS =="
code=$(curl -sk -o /dev/null -w '%{http_code}' -u "$U:$PW" "https://127.0.0.1:$LISTEN/")
[ "$code" = 200 ] && ok "UI served over TLS" || bad "UI -> $code"
ping=$(curl -sk -u "$U:$PW" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"PING"}')
echo "$ping" | grep -q '"ok":true' && ok "bridge answers PING: $(echo "$ping" | python3 -c 'import json,sys;print("v"+json.load(sys.stdin)["version"])')" || bad "PING -> $ping"

echo "== 3. audit trail names the user =="
curl -sk -u "$U:$PW" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"WRITE_UNLOCK","on":true}' >/dev/null
curl -sk -u "$U:$PW" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"WRITE_UNLOCK","on":false}' >/dev/null
sleep 1
# --no-log-prefix: each line is then exactly the JSON the core wrote, nothing else.
auditlines=$(docker compose logs --no-log-prefix core 2>/dev/null | grep '"target":"audit"' || true)
audit=$(printf '%s\n' "$auditlines" | grep -c "\"user\":\"$U\"" || true)
[ "$audit" -ge 2 ] && ok "$audit audit line(s) under user '$U'" || bad "expected >=2 audit lines for '$U', got $audit"
printf '%s\n' "$auditlines" | tail -1 | python3 -c 'import json,sys
for line in sys.stdin:
    if line.strip(): print("     latest:", json.dumps(json.loads(line)["fields"]))' 2>/dev/null || true

echo "== 4. the core is not reachable except through nginx =="
# Ask Docker, not the network: a probe of host:8765 would also hit an unrelated process
# that happens to listen there (a dev bridge, say) and blame the container for it.
# `docker inspect` is the authority: a null host binding means the port is exposed
# inside the network only. (`docker compose port` prints ":0" for the same state, and
# `compose ps` shows the image's EXPOSE as "8765/tcp" — neither is a host mapping.)
# Ask compose which container is the core rather than assuming it is called
# deploy-core-1: the project name comes from the directory, so a checkout elsewhere
# names it something else and the check would silently pass against nothing.
CORE_ID=$(docker compose ps -q core)
binding=$(docker inspect "$CORE_ID" --format '{{index .NetworkSettings.Ports "8765/tcp"}}' 2>/dev/null || echo '?')
[ "$binding" = "[]" ] || [ "$binding" = "<no value>" ] || [ -z "$binding" ] \
  && ok "core has no host port binding (docker inspect: 8765/tcp -> none)" \
  || bad "core has a host binding for 8765: $binding — it must not"
# And from a fresh container outside the compose network, the core's address is unreachable.
if docker run --rm --network none alpine:3 sh -c 'true' >/dev/null 2>&1; then
  CORE_NAME=$(docker inspect "$CORE_ID" --format '{{.Name}}' | sed 's|^/||')
  if docker run --rm alpine:3 sh -c "wget -q -T 2 -O /dev/null http://$CORE_NAME:8765/ 2>/dev/null"; then
    bad "core reachable from a container outside the compose network"
  else ok "core unreachable from outside the compose network"; fi
fi
docker compose ps --format '  {{.Service}}  {{.Status}}  {{.Ports}}'

[ $fail -eq 0 ] && echo "ok: hosted stack trial passed" || { echo "FAILED"; exit 1; }
