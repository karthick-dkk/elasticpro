#!/usr/bin/env bash
# End-to-end trial of the hosted stack on this machine, against the mock cluster.
# Proves the four things the deployment is for:
#   1. no credentials -> 401 at nginx, the core is never reached
#   2. a signed-in session -> the UI and the bridge work through TLS (and a bare Basic header gets nothing)
#   3. a write shows up in the core's audit log under the signed-in user's name
#   4. port 8765 is NOT reachable from outside the compose network
# and, since 0.3.54, the report worker (docs/WORKER.md):
#   5. the worker is up and healthy, and the core sees its heartbeat
#   6. the core in role core never starts the report timer; the worker does
#   7. the worker cannot be reached through nginx, nor from the host
#   8. (on a stack with a real cluster: TRIAL_CLUSTER_ID=<cluster id>) killing the worker during
#      a hosts collection leaves PING and an ES read answering in their normal time; the core
#      says worker_unavailable; the checkpoint survives and the collection finishes when the
#      worker is back; the job names any cluster that failed
set -uo pipefail
cd "$(dirname "$0")"
LISTEN=${LISTEN:-443}
U=alice; PW='test-password-1'
fail=0; ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; fail=1; }

# The certificate, the auth gate and the database password are all gitignored, so on a
# fresh clone — and in CI — none of them exist. Make throwaway ones; never overwrite.
./trial-setup.sh

# The three support images are pinned in docker-compose.yml to the version being
# released, but they are only pushed to the registry by docker.yml, which runs on the
# release tag. Between the commit that bumps the pin and the tag that publishes the
# images, the pinned tag does not exist — so this trial, which runs on every push, failed
# with "manifest for karthickdk02/elasticpro-nginx:0.4.0 not found" and then reported
# that the core was not running. The trial is here to prove the stack comes up and the
# four properties below hold, not to pin a support image to a digest, so it runs them at
# :latest — which docker.yml moves on every non-pre-release tag and is therefore always
# resolvable. The core itself is still built from this checkout, which is the thing under
# test.
export ELASTICPRO_NGINX_IMAGE=${ELASTICPRO_NGINX_IMAGE:-karthickdk02/elasticpro-nginx:latest}
export ELASTICPRO_REDIS_IMAGE=${ELASTICPRO_REDIS_IMAGE:-karthickdk02/elasticpro-redis:latest}
export ELASTICPRO_DB_IMAGE=${ELASTICPRO_DB_IMAGE:-karthickdk02/elasticpro-postgres:latest}

docker compose build core 2>&1 | tail -2
docker compose up -d 2>&1 | tail -3

# If a container did not start — a port already taken is the usual reason — then whatever
# else happens to answer on $LISTEN would be tested instead, and an unrelated web server
# returning 200 would be reported as "UI served over TLS". Check the stack is actually up
# before believing anything it says.
running=$(docker compose ps --services --filter status=running | sort | tr '\n' ' ')
for svc in core worker db nginx; do
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
# Signing in is the app's own: LOGIN sets the session cookie. (This used to send Basic
# credentials, which only worked because nginx turned any Basic header into a trusted
# X-Auth-User with no password check — the hole this step now proves is closed.)
JA=$(mktemp); JU=$(mktemp); trap 'rm -f "$JA" "$JU"' EXIT
bridge(){ curl -sk -b "$1" -c "$1" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d "$2"; }
# The shipped first account, then its forced password change, then the trial's own account.
bridge "$JA" '{"type":"LOGIN","name":"Admin","password":"elastic"}' >/dev/null
bridge "$JA" '{"type":"USER_SET_PASSWORD","name":"Admin","password":"trial-admin-password-1"}' >/dev/null
bridge "$JA" "{\"type\":\"USER_ADD\",\"name\":\"$U\",\"password\":\"$PW\",\"role\":\"admin\"}" >/dev/null
login=$(bridge "$JU" "{\"type\":\"LOGIN\",\"name\":\"$U\",\"password\":\"$PW\"}")
echo "$login" | grep -q '"ok":true' && ok "signed in as $U (session cookie)" || bad "LOGIN as $U -> $login"
code=$(curl -sk -o /dev/null -w '%{http_code}' -b "$JU" "https://127.0.0.1:$LISTEN/")
[ "$code" = 200 ] && ok "UI served over TLS" || bad "UI -> $code"
ping=$(bridge "$JU" '{"type":"PING"}')
echo "$ping" | grep -q '"ok":true' && ok "bridge answers PING: $(echo "$ping" | python3 -c 'import json,sys;print("v"+json.load(sys.stdin)["version"])')" || bad "PING -> $ping"
basic=$(curl -sk -u "$U:wrong-password" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"USER_LIST"}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("kind"))')
[ "$basic" = unauthenticated ] && ok "a Basic header with any password signs nobody in" || bad "Basic header -> '$basic' (want unauthenticated)"

echo "== 3. audit trail names the user =="
bridge "$JU" '{"type":"WRITE_UNLOCK","on":true}' >/dev/null
bridge "$JU" '{"type":"WRITE_UNLOCK","on":false}' >/dev/null
sleep 1
# --no-log-prefix: each line is then exactly the JSON the core wrote, nothing else.
auditlines=$(docker compose logs --no-log-prefix core 2>/dev/null | grep '"target":"audit"' || true)
audit=$(printf '%s\n' "$auditlines" | grep '"msg_type":"WRITE_UNLOCK"' | grep -c "\"user\":\"$U\"" || true)
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
echo "== 5. the report worker is up =="
WORKER_ID=$(docker compose ps -q worker)
wh=missing
for i in $(seq 1 30); do
  wh=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$WORKER_ID" 2>/dev/null || echo missing)
  [ "$wh" = healthy ] && break
  sleep 3
done
[ "$wh" = healthy ] && ok "worker container healthy (GET /health on 8766)" || bad "worker is '$wh' (want healthy)"
wstate=$(bridge "$JU" '{"type":"SYSTEM_HEALTH"}' | python3 -c 'import json,sys
d = json.load(sys.stdin); print(d.get("role"), (d.get("worker") or {}).get("state"))')
[ "$wstate" = "core up" ] && ok "the core (role core) reads the worker’s heartbeat: up" || bad "SYSTEM_HEALTH role/worker: '$wstate' (want 'core up')"

echo "== 6. the report timer runs in the worker, never in the core =="
corelog=$(docker compose logs --no-log-prefix core 2>/dev/null || true)
workerlog=$(docker compose logs --no-log-prefix worker 2>/dev/null || true)
printf '%s\n' "$corelog" | grep -q '"role":"core"' && ok "the core started in role core" || bad "no 'starting' line with role core in the core's log"
printf '%s\n' "$corelog" | grep -q 'volume report: timer started' && bad "the core started the report timer in role core" \
  || ok "the core did not start the report timer"
printf '%s\n' "$workerlog" | grep -q 'volume report: timer started' && ok "the worker started the report timer" \
  || bad "the worker's log has no 'volume report: timer started'"
runs=$(bridge "$JU" '{"type":"REPORT_JOBS"}' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("ok"), (d.get("worker") or {}).get("state"))')
[ "$runs" = "True up" ] && ok "REPORT_JOBS answers from jobs.json and names the worker up" || bad "REPORT_JOBS -> '$runs' (want 'True up')"

echo "== 7. the worker is not reachable through nginx or from the host =="
for path in /run /send-now /stop /queue /health; do
  body=$(curl -sk -X POST "https://127.0.0.1:$LISTEN$path" -H 'content-type: application/json' -d '{}' 2>/dev/null | head -c 400)
  if printf '%s' "$body" | grep -q '"role":"worker"\|worker token'; then bad "nginx routes $path to the worker: $body"; else ok "$path through nginx does not reach the worker"; fi
done
wbinding=$(docker inspect "$WORKER_ID" --format '{{index .NetworkSettings.Ports "8766/tcp"}}' 2>/dev/null || echo '?')
[ "$wbinding" = "[]" ] || [ "$wbinding" = "<no value>" ] || [ -z "$wbinding" ] \
  && ok "worker has no host port binding (8766/tcp -> none)" || bad "worker has a host binding for 8766: $wbinding — it must not"
# Inside the network the token is what keeps an action out: no token, refused.
wrun=$(docker compose exec -T core wget -q -O - -T 4 --header='content-type: application/json' \
        --post-data='{"type":"REPORT_STOP","msg":{"all":true}}' http://worker:8766/stop 2>&1 || true)
printf '%s' "$wrun" | grep -q '"ok":true' && bad "the worker took an action without its token: $wrun" || ok "the worker refuses an action without the shared token"

echo "== 8. killing the worker mid hosts collection =="
if [ -z "${TRIAL_CLUSTER_ID:-}" ]; then
  echo "  - skipped: set TRIAL_CLUSTER_ID to a cluster this stack can read (the test VM) to run it"
else
  C=$TRIAL_CLUSTER_ID
  job=$(bridge "$JU" "{\"type\":\"REPORT_RUN\",\"kind\":\"hosts\",\"clusterIds\":[\"$C\"],\"period\":\"last7\",\"collectAgain\":true}" \
        | python3 -c 'import json,sys;d=json.load(sys.stdin);j=(d.get("jobs") or [{}])[0];print(j.get("id") or "", d.get("kind") or "")')
  JOB=${job%% *}
  [ -n "$JOB" ] && ok "hosts job $JOB queued in the worker" || bad "REPORT_RUN hosts -> '$job'"
  # Until a page is in and checkpointed.
  pages=0
  for i in $(seq 1 60); do
    pages=$(bridge "$JU" '{"type":"REPORT_JOBS"}' | python3 -c "import json,sys
d = json.load(sys.stdin)
j = next((j for j in d.get('jobs', []) if j.get('id') == '$JOB'), {})
print(((j.get('progress') or {}).get('pages')) or 0)")
    [ "${pages:-0}" -gt 0 ] && break
    sleep 2
  done
  [ "${pages:-0}" -gt 0 ] && ok "collection under way ($pages page(s) in)" || bad "no page collected within 120 s"
  docker compose kill worker >/dev/null 2>&1
  ok "worker killed"
  # Monitoring answers in its normal time (2 s here) without the worker.
  t_ping=$(curl -sk -o /dev/null -w '%{time_total}' -b "$JU" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"PING"}')
  t_es=$(curl -sk -o /tmp/trial-es.$$ -w '%{time_total}' -b "$JU" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' \
         -d "{\"type\":\"ES\",\"clusterId\":\"$C\",\"method\":\"GET\",\"path\":\"/_cluster/health\"}")
  python3 -c "import sys; sys.exit(0 if float('$t_ping') < 2 else 1)" && ok "PING answered in ${t_ping}s with the worker down" || bad "PING took ${t_ping}s with the worker down"
  if python3 -c "import sys; sys.exit(0 if float('$t_es') < 2 else 1)" && grep -q '"ok":true' /tmp/trial-es.$$; then ok "an ES read answered in ${t_es}s with the worker down"
  else bad "ES read with the worker down: ${t_es}s, $(head -c 200 /tmp/trial-es.$$)"; fi
  rm -f /tmp/trial-es.$$
  down=$(bridge "$JU" '{"type":"REPORT_CONCURRENCY_SET","n":3}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("kind"))')
  [ "$down" = worker_unavailable ] && ok "an action is refused as worker_unavailable" || bad "with the worker down an action answered '$down'"
  cps=$(docker compose exec -T core sh -c "ls /app/data/volume/*/hosts/*.partial.json 2>/dev/null | wc -l" | tr -d ' \r')
  [ "${cps:-0}" -gt 0 ] && ok "$cps checkpoint(s) kept on the data volume" || bad "no hosts checkpoint on the data volume after the kill"
  docker compose start worker >/dev/null 2>&1
  for i in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$WORKER_ID" 2>/dev/null)" = healthy ] && break; sleep 3
  done
  st=$(bridge "$JU" '{"type":"REPORT_JOBS"}' | python3 -c "import json,sys
d = json.load(sys.stdin); j = next((j for j in d.get('jobs', []) if j.get('id') == '$JOB'), {}); print(j.get('status'), j.get('error'))")
  case "$st" in failed*restarted*) ok "the cut-short job is marked by the restarted worker ($st)";; *) bad "the cut-short job reads '$st' (want failed, the server restarted)";; esac
  # Run again without collectAgain: it resumes from the checkpoints rather than starting over.
  job2=$(bridge "$JU" "{\"type\":\"REPORT_RUN\",\"kind\":\"hosts\",\"clusterIds\":[\"$C\"],\"period\":\"last7\"}" \
         | python3 -c 'import json,sys;d=json.load(sys.stdin);print(((d.get("jobs") or [{}])[0]).get("id") or "")')
  end=""
  for i in $(seq 1 300); do
    end=$(bridge "$JU" '{"type":"REPORT_JOBS"}' | python3 -c "import json,sys
d = json.load(sys.stdin); j = next((j for j in d.get('jobs', []) if j.get('id') == '$job2'), {})
print(j.get('status'), json.dumps(j.get('failedClusters') or []))")
    case "$end" in done*|failed*|stopped*) break;; esac
    sleep 2
  done
  case "$end" in "done "*) ok "the collection finished after the restart; clusters named as failed: ${end#done }";;
                 *) bad "the resumed job ended '$end' (want done)";; esac
  left=$(docker compose exec -T core sh -c "ls /app/data/volume/*/hosts/*.partial.json 2>/dev/null | wc -l" | tr -d ' \r')
  [ "${left:-0}" -lt "${cps:-0}" ] && ok "the checkpoints were taken up ($cps → $left)" || bad "checkpoints before $cps, after $left"
fi

docker compose ps --format '  {{.Service}}  {{.Status}}  {{.Ports}}'

[ $fail -eq 0 ] && echo "ok: hosted stack trial passed" || { echo "FAILED"; exit 1; }
