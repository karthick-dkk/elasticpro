#!/usr/bin/env node
/**
 * Load check: a fleet of mock clusters, a hosted core, and a room full of browsers.
 *
 *   cargo build --release -p elasticpro-core --features bridge --bin elasticpro-bridge
 *   node tools/load-check.mjs [--minutes 10] [--clusters 36] [--browsers 20]
 *                             [--bin target/release/elasticpro-bridge] [--report-only]
 *
 * What it stands up, all on this machine:
 *   - tools/mock-es.mjs --ports: one mock cluster per port, answering after 150–450 ms
 *     (MOCK_LATENCY_MS + MOCK_JITTER_MS), with a 2 000-index _cat/indices (MOCK_INDEX_COUNT)
 *     and 1 % of answers a 429 (MOCK_429_RATE). Each port counts what it holds at once.
 *   - the core in hosted mode (accounts on, proxy identity from loopback — the same set-up
 *     tools/hosted-check.sh uses), primed with every mock, its poller forced to `background`
 *     mode at the shortest intervals the policy allows.
 *   - N browsers, each its own account, doing what people do: open a page that fans out over
 *     a handful of clusters (6 at a time, as the UI does), type in the console, keep a live
 *     tail running, and sometimes leave a page with requests still out (ABORT_REQUESTS plus
 *     the connection closed).
 *
 * At the end it pushes one person past their queue share, then asserts:
 *   1. no mock ever held more than ES_PER_CLUSTER at once, and the fleet never more than
 *      ES_CONCURRENCY;
 *   2. the core's RSS stayed under the container limit it would run in (--memory-mb, 1024:
 *      the 1 GiB limit 0.3.21 was sized for; the core reads its budget from the cgroup);
 *   3. a person's request p95 under that background load stayed under the target (below);
 *   4. nothing was refused while the queue had room, and past it refusals came at once with
 *      a time to retry;
 *   5. no request is left in flight once everyone has gone (no ghost rows);
 *   6. every cluster's health was fresh throughout (never older than two poll intervals
 *      and a margin).
 *
 * The interactive p95 target is 3 000 ms, and why: the slowest mock answer is 450 ms; a
 * page fan-out from 20 people spread over 36 clusters puts at most a handful of requests
 * ahead of any one of them at a 4-per-cluster cap, plus the poller's share (2 per cluster)
 * ahead in the round; three rounds of the slowest answer behind the cap, plus a 2 000-row
 * _cat/indices to serialise, is ~2 s. 3 s is that with a margin, and well inside the 20 s a
 * request may wait before EP-215 — a p95 near the queue wait would mean the gate is
 * starving people, which is what this exists to catch.
 *
 * --report-only prints the same numbers without failing: for measuring a core built before
 * the gate existed, against the same load.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg('minutes', 10));
const CLUSTERS = Number(arg('clusters', 36));
const BROWSERS = Number(arg('browsers', 20));
const BIN = path.resolve(ROOT, arg('bin', 'target/release/elasticpro-bridge'));
const REPORT_ONLY = process.argv.includes('--report-only');
const BASE_PORT = Number(arg('mock-base', 19300));
const CORE_PORT = Number(arg('core-port', 18765));
const MEMORY_LIMIT_MB = Number(arg('memory-mb', 1024));
const P95_TARGET_MS = 3000;
// The gate's numbers this run uses: the shipped defaults, said out loud so the asserts
// read against them.
const LIMITS = { perCluster: 4, global: 24, queueMax: 256, queuePerUser: 64 };
const HEALTH_SECS = 60;

if (!fs.existsSync(BIN)) {
  console.error(`load-check: no core at ${BIN} — build it first:\n  cargo build --release -p elasticpro-core --features bridge --bin elasticpro-bridge`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const children = [];
function stopAll() { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } }
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

/* ------------------------------------- stand it up ------------------------------------- */

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'elasticpro-load-'));
const pwFile = path.join(data, 'admin-password');
fs.writeFileSync(pwFile, `load-${Math.random().toString(36).slice(2)}-${Date.now()}\n`, { mode: 0o600 });

const mockPorts = `${BASE_PORT}-${BASE_PORT + CLUSTERS - 1}`;
const mock = spawn(process.execPath, [path.join(ROOT, 'tools/mock-es.mjs'), '--ports', mockPorts], {
  env: { ...process.env, MOCK_LATENCY_MS: '150', MOCK_JITTER_MS: '300', MOCK_INDEX_COUNT: '2000', MOCK_429_RATE: '0.01' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
children.push(mock);

const coreLog = fs.openSync(path.join(data, 'core.log'), 'w');
const core = spawn(BIN, [path.join(ROOT, 'ui'), String(CORE_PORT)], {
  env: {
    ...process.env,
    // Hosted, as tools/hosted-check.sh runs it: accounts on, identity from the proxy header,
    // and the only proxy trusted is loopback.
    ELASTICPRO_BIND: '0.0.0.0', ELASTICPRO_PROXY_AUTH: '1', ELASTICPRO_TRUSTED_PROXIES: '127.0.0.1/32',
    ELASTICPRO_DATA_DIR: data, ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE: pwFile,
    RUST_LOG: 'warn',
  },
  stdio: ['ignore', coreLog, coreLog],
});
children.push(core);

const B = `http://127.0.0.1:${CORE_PORT}/bridge`;
// Every answer the core gives moves this on; a core that stops answering is a failure in
// itself, reported as one rather than as a crash of this script.
let lastAnswerAt = Date.now();
let longestSilenceMs = 0;
async function bridge(user, msg, { signal } = {}) {
  // No reply takes longer than the core's own ceiling (115 s) plus a margin.
  const limit = AbortSignal.timeout(130_000);
  const r = await fetch(B, { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-user': user }, body: JSON.stringify(msg),
    signal: signal ? AbortSignal.any([signal, limit]) : limit });
  const out = await r.json();
  const t = Date.now();
  longestSilenceMs = Math.max(longestSilenceMs, t - lastAnswerAt);
  lastAnswerAt = t;
  return out;
}
async function waitFor(f, ms, what) {
  const until = now() + ms;
  for (;;) {
    try { if (await f()) return; } catch { /* not up yet */ }
    if (now() > until) throw new Error(`load-check: timed out waiting for ${what}`);
    await sleep(250);
  }
}
await waitFor(async () => (await fetch(`http://127.0.0.1:${BASE_PORT}/_mock/stats`)).ok, 15000, 'the mock fleet');
await waitFor(async () => (await bridge('Admin', { type: 'PING' })).ok, 30000, 'the core');

const ADMIN = 'Admin';
const users = Array.from({ length: BROWSERS }, (_, i) => `load-user-${String(i + 1).padStart(2, '0')}`);
for (const u of users) {
  const r = await bridge(ADMIN, { type: 'USER_ADD', name: u, role: 'user', password: `pw-${Math.random().toString(36).slice(2)}-long` });
  if (!r.ok && !/exists|taken/i.test(r.message || '')) throw new Error(`USER_ADD ${u}: ${r.message}`);
}
const clusters = Array.from({ length: CLUSTERS }, (_, i) => ({ id: `c${String(i).padStart(2, '0')}`, name: `load ${i}`, url: `http://127.0.0.1:${BASE_PORT + i}`, authHeader: '' }));
const primed = await bridge(ADMIN, { type: 'PRIME', readOnly: true, clusters });
if (!primed.ok) throw new Error(`PRIME: ${primed.message}`);
const intervalsSec = { health: HEALTH_SECS };
const pol = await bridge(ADMIN, { type: 'POLICY_SET', policy: { mode: 'background', intervalsSec, watchMinutes: 240, budgetPerClusterPerMin: 0 } });
if (!pol.ok) throw new Error(`POLICY_SET: ${pol.message}`);
// The rest of the datasets at their floor, so the poller is as busy as policy lets it be.
const catalogue = await bridge(ADMIN, { type: 'FLEET_STATE', include: [] });
const names = (Array.isArray(catalogue.catalogue) ? catalogue.catalogue : []).map((d) => d.dataset);
for (const n of names) if (n !== 'health') intervalsSec[n] = 30;
await bridge(ADMIN, { type: 'POLICY_SET', policy: { mode: 'background', intervalsSec, watchMinutes: 240, budgetPerClusterPerMin: 0 } });
// Keep the poller watched: an idle core polls health only.
const touch = setInterval(() => bridge(ADMIN, { type: 'FLEET_STATE', include: [] }).catch(() => {}), 20000);

const ping = await bridge(ADMIN, { type: 'PING' });
console.log(`load-check: core ${ping.version} at :${CORE_PORT}, ${CLUSTERS} mock clusters on ${mockPorts}, ${BROWSERS} browsers, ${MINUTES} min; data in ${data}`);

/* --------------------------------------- measure --------------------------------------- */

const stats = { lat: [], kinds: {}, sent: 0, refusedWithoutRetryAfter: 0, aborted: 0, tailSkipped: 0 };
const note = (r, ms) => {
  stats.sent++;
  const k = r && r.ok ? 'ok' : (r && r.kind) || 'error';
  stats.kinds[k] = (stats.kinds[k] || 0) + 1;
  if (r && r.ok) stats.lat.push(ms);
  if (k === 'overloaded' && !(r.retryAfterMs > 0)) stats.refusedWithoutRetryAfter++;
};
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))]; };
const rss = () => { try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(core.pid)]).toString().trim()) * 1024; } catch { return 0; } };
let peakRss = 0;
const freshness = { worstMs: 0, worstCluster: null, samples: 0 };
const gate = { maxQueued: 0, maxRunning: 0 };

async function sample() {
  peakRss = Math.max(peakRss, rss());
  const log = await bridge(ADMIN, { type: 'REQUEST_LOG', limit: 1 }).catch(() => null);
  if (log && log.gate) {
    gate.maxQueued = Math.max(gate.maxQueued, (log.gate.queued || {}).total || 0);
    gate.maxRunning = Math.max(gate.maxRunning, (log.gate.running || {}).total || 0);
  }
}
async function checkFreshness() {
  const st = await bridge(ADMIN, { type: 'FLEET_STATE', include: ['health'] }).catch(() => null);
  if (!st || !st.clusters) return;
  const t = now();
  for (const [id, c] of Object.entries(st.clusters)) {
    const e = c.datasets && c.datasets.health;
    const at = e && (e.fetchedAt || e.lastOkAt);
    if (!at) continue;
    const age = t - at;
    if (age > freshness.worstMs) { freshness.worstMs = age; freshness.worstCluster = id; }
  }
  freshness.samples++;
}

/* ---------------------------------------- browse ---------------------------------------- */

const PAGE_PATHS = ['/_cluster/health', '/_cat/indices?format=json&bytes=b', '/_cat/nodes?format=json', '/_cluster/stats', '/_cat/allocation?format=json&bytes=b'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const end = now() + MINUTES * 60_000;

async function timed(user, msg, opts) {
  const t0 = now();
  try {
    const r = await bridge(user, msg, opts);
    note(r, now() - t0);
    return r;
  } catch (e) {
    if (e && e.name === 'AbortError') { stats.aborted++; return null; }
    note({ ok: false, kind: 'transport' }, now() - t0);
    return null;
  }
}

/** Bounded fan-out, like the UI's runBounded (limit 6). */
async function fanOut(items, f, limit = 6) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await f(items[i++]); }));
}

async function browser(user, n) {
  let tailBusy = false;
  const tailCluster = clusters[n % clusters.length].id;
  // The live tail: a search every 5 s, skipped while the last one is still out.
  const tail = setInterval(() => {
    if (tailBusy) { stats.tailSkipped++; return; }
    tailBusy = true;
    timed(user, { type: 'ES', clusterId: tailCluster, method: 'POST', path: '/logstash-*/_search', origin: 'page:logs', timeoutMs: 45000,
      body: JSON.stringify({ size: 50, query: { range: { '@timestamp': { gte: `now-${5 + (now() % 7)}m` } } } }) })
      .finally(() => { tailBusy = false; });
  }, 5000);
  while (now() < end) {
    const r = Math.random();
    if (r < 0.7) {
      // A page: a handful of clusters, every one of a page's calls to each.
      const page = pick(['overview', 'indices', 'nodes', 'shards']);
      const targets = Array.from({ length: 4 + Math.floor(Math.random() * 9) }, () => pick(clusters).id);
      const ctl = new AbortController();
      const leaveEarly = Math.random() < 0.1;
      if (leaveEarly) setTimeout(() => { ctl.abort(); bridge(user, { type: 'ABORT_REQUESTS', origin: `page:${page}` }).catch(() => {}); }, 300 + Math.random() * 700);
      await fanOut(targets.flatMap((id) => PAGE_PATHS.map((p) => [id, p])), ([id, p]) =>
        timed(user, { type: 'ES', clusterId: id, method: 'GET', path: p, origin: `page:${page}`, timeoutMs: 30000 }, { signal: ctl.signal }));
    } else {
      // The console: a search nobody else is typing.
      await timed(user, { type: 'ES', clusterId: pick(clusters).id, method: 'POST', path: `/logstash-*/_search?q=${Math.random().toString(36).slice(2, 8)}`,
        origin: 'console', timeoutMs: 30000, body: JSON.stringify({ size: 20 }) });
    }
    await sleep(1000 + Math.random() * 4000);
  }
  clearInterval(tail);
  while (tailBusy) await sleep(100);
}

const sampler = setInterval(() => { sample().catch(() => {}); }, 2000);
const fresher = setInterval(() => { checkFreshness().catch(() => {}); }, 30000);
const progress = setInterval(() => {
  const left = Math.max(0, Math.round((end - now()) / 1000));
  console.log(`  ${left}s left · sent ${stats.sent} · p95 ${pct(stats.lat, 0.95)} ms · ${JSON.stringify(stats.kinds)} · queued≤${gate.maxQueued} running≤${gate.maxRunning} · rss ${(peakRss / 1048576).toFixed(0)} MB · health worst ${(freshness.worstMs / 1000).toFixed(0)} s`);
}, 60000);

// Warm-up: let the poller fill the cache before measuring freshness.
await sleep(5000);
await Promise.all(users.map((u, i) => browser(u, i)));
clearInterval(progress);

/* ------------------------------- one person past their share ------------------------------- */

const burstUser = users[0];
const burstN = LIMITS.queuePerUser + LIMITS.perCluster + 30;
const burst = await Promise.all(Array.from({ length: burstN }, (_, i) =>
  bridge(burstUser, { type: 'ES', clusterId: clusters[CLUSTERS - 1].id, method: 'GET', path: `/_cluster/health?burst=${i}`, origin: 'page:burst', timeoutMs: 30000 })
    .catch((e) => ({ ok: false, kind: 'transport', message: String(e) }))));
const burstKinds = burst.reduce((m, r) => { const k = r.ok ? 'ok' : r.kind; m[k] = (m[k] || 0) + 1; return m; }, {});
const burstRefused = burst.filter((r) => r.kind === 'overloaded');

/* ---------------------------------------- settle ---------------------------------------- */

clearInterval(sampler); clearInterval(fresher); clearInterval(touch);
await sleep(10000);
await checkFreshness().catch(() => {});
const finalLog = await bridge(ADMIN, { type: 'REQUEST_LOG', limit: 2000 }).catch((e) => ({ ok: false, unreachable: String(e) }));
const ghosts = (finalLog.inflight || []).filter((r) => r.class === 'interactive' || String(r.origin || '').startsWith('page:') || r.origin === 'console');
const stale = (finalLog.inflight || []).filter((r) => now() - r.startedAt > (r.timeoutMs || 30000) + 5000);
const mocks = await Promise.all(Array.from({ length: CLUSTERS }, (_, i) => fetch(`http://127.0.0.1:${BASE_PORT + i}/_mock/stats`).then((r) => r.json())));
const peakPerMock = Math.max(...mocks.map((m) => m.peak));
const fleetPeak = mocks[0].fleetPeak;
const totalAtMocks = mocks.reduce((s, m) => s + m.total, 0);
peakRss = Math.max(peakRss, rss());

const report = {
  core: ping.version, minutes: MINUTES, clusters: CLUSTERS, browsers: BROWSERS,
  interactive: { sent: stats.sent, p50Ms: pct(stats.lat, 0.5), p95Ms: pct(stats.lat, 0.95), p99Ms: pct(stats.lat, 0.99), kinds: stats.kinds, abortedByBrowser: stats.aborted, tailTicksSkipped: stats.tailSkipped },
  atTheClusters: { requests: totalAtMocks, peakPerCluster: peakPerMock, peakFleet: fleetPeak },
  gate: { maxQueued: gate.maxQueued, maxRunning: gate.maxRunning, report: finalLog.gate ? { waits: finalLog.gate.waits, refused: finalLog.gate.refused, shared: finalLog.gate.shared, cacheHits: finalLog.gate.cacheHits } : 'not reported by this core' },
  burst: { sent: burstN, kinds: burstKinds },
  coreRssPeakMb: Math.round(peakRss / 1048576),
  healthWorstAgeSec: Math.round(freshness.worstMs / 1000), healthWorstCluster: freshness.worstCluster,
  inflightAfter: (finalLog.inflight || []).length, ghostsAfter: ghosts.length, staleAfter: stale.length,
  longestSilenceSec: Math.round(longestSilenceMs / 1000),
};
console.log(JSON.stringify(report, null, 2));

const failures = [];
const must = (cond, what) => { if (!cond) failures.push(what); };
must(finalLog.ok === true, `the core stopped answering: ${finalLog.unreachable || finalLog.message}`);
must(longestSilenceMs < 30_000, `the core went ${Math.round(longestSilenceMs / 1000)} s without answering anybody`);
must(peakPerMock <= LIMITS.perCluster, `a cluster held ${peakPerMock} requests at once (ES_PER_CLUSTER ${LIMITS.perCluster})`);
must(fleetPeak <= LIMITS.global, `the fleet held ${fleetPeak} at once (ES_CONCURRENCY ${LIMITS.global})`);
must(peakRss < MEMORY_LIMIT_MB * 1048576, `core RSS peaked at ${Math.round(peakRss / 1048576)} MB (budget ${MEMORY_LIMIT_MB} MB)`);
must(pct(stats.lat, 0.95) != null && pct(stats.lat, 0.95) < P95_TARGET_MS, `interactive p95 ${pct(stats.lat, 0.95)} ms (target < ${P95_TARGET_MS} ms)`);
must(!stats.kinds.overloaded, `${stats.kinds.overloaded} request(s) refused while every browser stayed within its share`);
must(!stats.kinds.queue_timeout, `${stats.kinds.queue_timeout} request(s) waited out ES_QUEUE_WAIT_MS under ordinary load`);
must(burstRefused.length > 0 && burstRefused.length <= burstN - LIMITS.queuePerUser - 1, `past the per-person share: ${burstRefused.length} of ${burstN} refused`);
must(burstRefused.every((r) => r.retryAfterMs > 0 && r.errorCode === 'EP-214'), 'a refusal without retryAfterMs or EP-214');
must(!stats.refusedWithoutRetryAfter, 'an overloaded reply without retryAfterMs');
must(ghosts.length === 0, `${ghosts.length} request(s) from browsers still in flight after everyone left`);
must(stale.length === 0, `${stale.length} in-flight record(s) older than their own timeout`);
must(freshness.samples > 0 && freshness.worstMs < (2 * HEALTH_SECS + 60) * 1000, `health went ${Math.round(freshness.worstMs / 1000)} s without a refresh on ${freshness.worstCluster}`);

stopAll();
if (failures.length) {
  console.log(`\nload-check: ${failures.length} problem(s):\n  - ${failures.join('\n  - ')}`);
  if (!REPORT_ONLY) process.exit(1);
} else {
  console.log('\nok: load-check passed');
}
fs.rmSync(data, { recursive: true, force: true });
process.exit(0);
