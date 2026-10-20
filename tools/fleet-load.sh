#!/usr/bin/env bash
# The fleet cache's memory, under the conditions that crash-looped production at 0.3.21:
# a large fleet (32 clusters with thousands of indices each, so cached bodies are
# megabytes), the disk cache and Redis both warm, a 1 GiB container, and pages asking for
# fleet state the moment the core is back.
#
#   IMAGE=elasticpro-core:latest tools/fleet-load.sh
#
# Two phases, each in a container with a hard memory limit, against one Docker volume and
# one Redis:
#   warm    — WARM_MEM (default 3g): every dataset of every cluster is fetched once, so the
#             disk cache and Redis hold all CLUSTERS×9 bodies. Peak and settled RSS here are
#             the steady state of a fleet whose every page has been opened.
#   restart — MEM (default 1g, the shipped limit at 0.3.21), restart policy as compose
#             runs it, on-demand policy as production ran it: the core restores from disk
#             and Redis while CLIENTS pages read FLEET_STATE and open index lists. Counted:
#             peak RSS (VmHWM of the bridge, the most of any run), OOM kills, restarts.
#
# Needs Docker, node and python3. The fixture clusters run on this machine's loopback
# (tools/mock-es.mjs --ports with MOCK_INDICES), reached from the containers as
# host.docker.internal — Docker Desktop. On Linux set MOCK_HOST to the docker bridge
# address and MOCK_BIND to it. Everything it creates is named ep-load-* and removed at
# the end unless KEEP=1.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=${IMAGE:-elasticpro-core:latest}
CLUSTERS=${CLUSTERS:-32}
INDICES=${INDICES:-1100}
SNAP_INDICES=${SNAP_INDICES:-120}  # indices named per snapshot in the verbose listing
MEM=${MEM:-1g}
WARM_MEM=${WARM_MEM:-3g}
CLIENTS=${CLIENTS:-4}
RESTART_SECS=${RESTART_SECS:-90}
MOCK_PORT=${MOCK_PORT:-19400}
MOCK_HOST=${MOCK_HOST:-host.docker.internal}
CORE_PORT=${CORE_PORT:-18765}
EXTRA_ENV=${EXTRA_ENV:-}          # e.g. "-e ELASTICPRO_CACHE_MB=256"
NET=ep-load-net VOL=ep-load-data CORE=ep-load-core REDIS=ep-load-redis
PW=load-test-password-123
B="http://127.0.0.1:$CORE_PORT/bridge"
JAR=$(mktemp)
PRIMED=$(mktemp)

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  [ -n "${SAMPLER:-}" ] && kill "$SAMPLER" 2>/dev/null || true
  rm -f "$JAR" "$PRIMED"
  if [ "${KEEP:-0}" != 1 ]; then
    docker rm -f "$CORE" "$REDIS" >/dev/null 2>&1 || true
    docker volume rm "$VOL" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
docker rm -f "$CORE" "$REDIS" >/dev/null 2>&1 || true
docker volume rm "$VOL" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null 2>&1 || true

say "fixture: $CLUSTERS clusters × $INDICES indices on :${MOCK_PORT}…"
MOCK_BIND=${MOCK_BIND:-127.0.0.1} MOCK_INDICES=$INDICES MOCK_SNAP_INDICES=$SNAP_INDICES node tools/mock-es.mjs --ports "$MOCK_PORT-$((MOCK_PORT + CLUSTERS - 1))" >/dev/null &
MOCK_PID=$!
until curl -s -o /dev/null "http://127.0.0.1:$((MOCK_PORT + CLUSTERS - 1))/"; do sleep 0.2; done

docker run -d --name "$REDIS" --network "$NET" redis:7-alpine redis-server --save "" --appendonly no >/dev/null
# The last cluster setup an admin applied, as the core restores it on start; the first
# admin's password; and the policy (background to warm, on-demand as production ran).
python3 - "$CLUSTERS" "$MOCK_HOST" "$MOCK_PORT" > "$PRIMED" <<'EOF'
import json, sys
n, host, port = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
print(json.dumps({"clusters": [{"id": f"c{i:02d}", "label": f"c{i:02d}", "url": f"http://{host}:{port + i}"} for i in range(n)]}))
EOF
docker run --rm -i -v "$VOL":/d alpine:3.20 sh -c "cat > /d/primed.json; printf '%s\n' '$PW' > /d/pw; echo '{\"mode\":\"on-demand\"}' > /d/policy.json; chown -R 999 /d; chmod 600 /d/pw" < "$PRIMED"

run_core() { # $1 = memory limit, $2 = restart policy
  docker rm -f "$CORE" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker run -d --name "$CORE" --network "$NET" --memory="$1" --memory-swap="$1" --restart="$2" \
    -p "127.0.0.1:$CORE_PORT:8765" -v "$VOL":/app/data \
    -e ELASTICPRO_BIND=0.0.0.0 -e ELASTICPRO_DATA_DIR=/app/data -e RUST_LOG=info \
    -e ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE=/app/data/pw \
    -e ELASTICPRO_REDIS_URL="redis://$REDIS:6379/0" $EXTRA_ENV "$IMAGE" >/dev/null
  until curl -s -o /dev/null -X POST "$B" -H 'content-type: application/json' -d '{"type":"PING"}'; do sleep 0.2; done
}
login() {
  curl -s -c "$JAR" -X POST "$B" -H 'content-type: application/json' \
    -d "{\"type\":\"LOGIN\",\"name\":\"Admin\",\"password\":\"$PW\"}" >/dev/null
}
post() { curl -s -b "$JAR" -X POST "$B" -H 'content-type: application/json' -d "$1"; }
rss() { # current and peak RSS of the bridge (PID 1 in its container), in MiB
  docker exec "$CORE" sh -c "awk '/VmRSS|VmHWM/ {printf \"%d \", \$2/1024} END {print \"\"}' /proc/1/status" 2>/dev/null || echo "- -"
}
# One sample a second into $1: "rss hwm restarts oomkilled". A restarted bridge starts its
# own VmHWM again, which is why the peak is the most of every sample, not the last one.
sample() {
  while :; do
    printf '%s %s %s\n' "$(rss)" "$(docker inspect -f '{{.RestartCount}}' "$CORE" 2>/dev/null)" \
      "$(docker inspect -f '{{.State.OOMKilled}}' "$CORE" 2>/dev/null)" >> "$1"
    sleep 1
  done
}

# ---------------------------------------------------------------- warm
say "warm: core under $WARM_MEM, every dataset of every cluster…"
run_core "$WARM_MEM" no
login
WARM=$(mktemp); sample "$WARM" & SAMPLER=$!
ALL='["health","nodes","ilm_errors","policies","ilm_assign","snapshots","snapshots_full","indices","shards"]'
post "{\"type\":\"REFRESH\",\"clusterIds\":\"all\",\"datasets\":$ALL}" >/dev/null
want=$((CLUSTERS * 9)); t0=$(date +%s)
while :; do
  n=$(docker exec "$CORE" sh -c 'find /app/data/cache -name "*.json*" 2>/dev/null | wc -l' | tr -d ' ')
  [ "$n" -ge "$want" ] && break
  if [ $(( $(date +%s) - t0 )) -gt 900 ]; then say "warm: timed out at disk=$n of $want"; break; fi
  sleep 3
done
# Once more, eleven seconds on (a person's Refresh is rate-limited to one in ten): a body
# over 64 KiB is written to disk at most once a minute, so this round reaches Redis and
# not the disk — Redis ends up newer than the disk for every large body, which is how a
# production core that has been running a while leaves them, and what makes a restart
# take both.
sleep 11
post "{\"type\":\"REFRESH\",\"clusterIds\":\"all\",\"datasets\":$ALL}" >/dev/null
sleep 20
# Redis is written through after the disk, and a write that times out is dropped (that is
# by design: best effort). Wait until it stops growing, at most a minute.
k=0; for _ in $(seq 20); do
  k2=$(docker exec "$REDIS" redis-cli dbsize | tr -d ' ')
  [ "$k2" -ge "$want" ] && { k=$k2; break; }
  [ "$k2" = "$k" ] && break
  k=$k2; sleep 3
done
sleep 15   # let the last disk/redis writes and their copies go
kill "$SAMPLER"; SAMPLER=
read -r wrss whwm _ < <(rss)
wpeak=$(awk '{ for (i = 1; i <= 2; i++) if ($i+0 > m) m = $i+0 } END { print m+0 }' "$WARM")
say "warm: disk=$n redis=$k entries; RSS now ${wrss} MiB, peak ${wpeak} MiB"
jsonb=$(docker exec "$REDIS" redis-cli --raw info memory | awk -F: '/^used_memory:/ {printf "%d", $2/1048576}')
say "warm: redis holds ${jsonb} MiB (the JSON of every body)"
docker stop -t 10 "$CORE" >/dev/null

# ---------------------------------------------------------------- restart
say "restart: core under $MEM, on-demand, $CLIENTS pages reading for ${RESTART_SECS}s…"
RUN=$(mktemp)
T_RESTART=$(date +%s)
run_core "$MEM" unless-stopped
sample "$RUN" & SAMPLER=$!
python3 - "$B" "$PW" "$CLIENTS" "$RESTART_SECS" "$CLUSTERS" <<'EOF' &
import json, sys, threading, time, urllib.request, http.cookiejar
url, pw, clients, secs, n = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
def page(i):
    end = time.time() + secs
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    def post(m):
        r = urllib.request.Request(url, json.dumps(m).encode(), {"content-type": "application/json"})
        try:
            return json.loads(op.open(r, timeout=30).read())
        except Exception:
            return None   # down (OOM-killed, restarting): what nginx turns into a 502
    since, epoch, k = None, None, i
    while time.time() < end:
        if not post({"type": "LOGIN", "name": "Admin", "password": pw}):
            time.sleep(1); continue
        while time.time() < end:
            st = post({"type": "FLEET_STATE", **({"since": since} if since is not None else {})})
            if not st or not st.get("ok"):
                since = None; break
            if st.get("epoch") != epoch:
                epoch, since = st.get("epoch"), None   # a restarted core: everything again
                continue
            since = st.get("seq")
            # An index list opened, the way the Indices page does.
            post({"type": "CLUSTER_DATASET", "clusterId": f"c{k % n:02d}", "dataset": "indices"})
            k += clients
            time.sleep(2)
t0 = time.time()
for t in [threading.Thread(target=page, args=(i,)) for i in range(clients)]:
    t.start()
time.sleep(max(0, t0 + secs - time.time()))   # the window is the same with no pages at all
EOF
CLIENTS_PID=$!
wait "$CLIENTS_PID" || true
sleep 2
kill "$SAMPLER"; SAMPLER=
read -r rrss rhwm _ < <(rss)
rpeak=$(awk '{ for (i = 1; i <= 2; i++) if ($i+0 > m) m = $i+0 } END { print m+0 }' "$RUN")
restarts=$(docker inspect -f '{{.RestartCount}}' "$CORE")
starts=$(docker logs "$CORE" 2>&1 | grep -c '"fleet poller started"' || true)
ooms=$(docker events --since "$T_RESTART" --until "$(date +%s)" --filter "container=$CORE" --filter event=oom 2>/dev/null | wc -l | tr -d ' ')
say "restart: RSS now ${rrss} MiB, peak ${rpeak} MiB (limit $MEM); OOM kills=$ooms restarts=$restarts starts=$starts"
docker logs "$CORE" 2>&1 | grep -E 'fleet cache|fleet poller|budget|redis' | tail -8 | cut -c1-300
printf 'RESULT image=%s clusters=%s indices=%s warm_peak_mib=%s warm_settled_mib=%s restart_peak_mib=%s restart_settled_mib=%s oom_kills=%s restarts=%s\n' \
  "$IMAGE" "$CLUSTERS" "$INDICES" "$wpeak" "$wrss" "$rpeak" "$rrss" "$ooms" "$restarts"
