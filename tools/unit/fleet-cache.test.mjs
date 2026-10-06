/**
 * The fleet cache, as the UI reads it: the core's entries (docs/HANDBOOK.md, "Fleet cache —
 * the message contract") turned into the same {ok, value, error} pairs buildClusterData
 * took from a direct fetch.
 *
 * What these guard is the promise that moving the data path changed no figure and made no
 * guess: one definition computes the overview whichever way the bodies arrived, a dataset
 * the core could not fetch reads as unknown (never as empty), a value read back from disk
 * says so, and the _cat snapshot listing — which names no indices — is never taken to mean
 * "this index is not in a snapshot".
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

// state.js wants a browser; nothing exercised here needs one, but the import chain has to
// resolve. Same shim as snapshot-verify.test.mjs.
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);
const { state, fleet, applyFleetEntry, applyFleetState, fleetPairs, buildClusterData, answerToPair,
        mergeSnapshotListings, datasetFreshness, fetchedAt, oldestFetch, alerts, setFleetMode } = S;
const { freshnessText } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/freshness.js')).href);
const { verifyIndicesInSnapshots } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-verify.js')).href);
const { DEFAULTS } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/config.js')).href);

const NOW = Date.now();
const MIN = 60 * 1000;

/** An answer the way the core stores one: the ES passthrough's own shape. */
const ans = (json, extra = {}) => ({ ok: true, status: 200, kind: 'ok', message: '', json, tookMs: 5, ...extra });
const httpErr = (status, message) => ({ ok: false, status, kind: 'http', message, json: null, tookMs: 5 });
const entry = (data, extra = {}) => ({
  status: 'ok', fetchedAt: NOW - MIN, attemptedAt: NOW - MIN, nextDue: NOW + MIN, tookMs: 40,
  staleAfterMs: 360000, seq: 1, error: null, data, ...extra,
});

const ROOT_BODY = { name: 'n1', cluster_name: 'prod', version: { number: '8.13.0' } };
const HEALTH_BODY = { status: 'green', number_of_nodes: 2, unassigned_shards: 0 };
const NODES_BODY = [
  { name: 'n1', master: '*', jdk: '21', 'heap.percent': '40' },
  { name: 'n2', master: '-', jdk: '21', 'heap.percent': '55' },
];
const ALLOC_BODY = [
  { node: 'n1', 'disk.used': '600', 'disk.avail': '400', 'disk.total': '1000', 'disk.indices': '500', shards: '10' },
  { node: 'n2', 'disk.used': '300', 'disk.avail': '700', 'disk.total': '1000', 'disk.indices': '250', shards: '10' },
];
const REPOS_BODY = { daily: { type: 'fs', settings: { location: '/snap' } } };
const SLM_BODY = { nightly: { policy: { repository: 'daily', retention: { expire_after: '30d' } }, last_success: { time: NOW - 3600000 } } };

/** Every background dataset, answered. */
function fullCluster() {
  return {
    reach: { state: 'reachable', since: NOW - 3600000, lastError: null, nextProbeAt: null, failures: 0, seq: 1 },
    datasets: {
      health: entry({ root: ans(ROOT_BODY), health: ans(HEALTH_BODY) }),
      nodes: entry({ nodes: ans(NODES_BODY), alloc: ans(ALLOC_BODY) }, { fetchedAt: NOW - 3 * MIN }),
      ilm_errors: entry({ ilmErr: ans({ indices: {} }) }),
      policies: entry({
        repos: ans(REPOS_BODY), slm: ans(SLM_BODY), slmStatus: ans({ operation_mode: 'RUNNING' }),
        ilm: ans({ operation_mode: 'RUNNING' }), ilmPolicies: ans({}), repoPaths: ans({ nodes: {} }),
        clusterSettings: ans({ persistent: {} }),
      }, { fetchedAt: NOW - 10 * MIN }),
      ilm_assign: entry({ ilmOfIndices: ans({}) }),
    },
  };
}

beforeEach(() => {
  state.data.clear(); state.clients.clear(); state.indices.clear(); state.shards.clear();
  for (const k of Object.keys(state.fetchedAt)) delete state.fetchedAt[k];
  setFleetMode(null);
  fleet.raw.clear();
  fleet.skew = 0;
  state.defaults = { ...DEFAULTS };
  state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }], raw: {} };
});

test('an answer becomes the pair a direct fetch would have produced', () => {
  assert.deepEqual(answerToPair(ans({ a: 1 })), { ok: true, value: { a: 1 } });
  const bad = answerToPair(httpErr(405, 'no SLM on a basic licence'));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.res.status, 405, 'the HTTP answer stays reachable as error.res, like EsClient.json()');
  assert.match(bad.error.message, /basic licence/);
});

test('entry → pairs → the SAME figures buildClusterData gives a direct fetch', () => {
  const cs = fullCluster();
  const d = applyFleetEntry('c1', cs);
  // The direct path, from identical bodies: settled() pairs straight into buildClusterData.
  const direct = buildClusterData('c1', {}, {
    root: { ok: true, value: ROOT_BODY }, health: { ok: true, value: HEALTH_BODY },
    nodes: { ok: true, value: NODES_BODY }, alloc: { ok: true, value: ALLOC_BODY },
    ilmErr: { ok: true, value: { indices: {} } }, repos: { ok: true, value: REPOS_BODY },
    slm: { ok: true, value: SLM_BODY }, slmStatus: { ok: true, value: { operation_mode: 'RUNNING' } },
    ilm: { ok: true, value: { operation_mode: 'RUNNING' } }, ilmPolicies: { ok: true, value: {} },
    repoPaths: { ok: true, value: { nodes: {} } }, clusterSettings: { ok: true, value: { persistent: {} } },
    ilmOfIndices: { ok: true, value: {} },
  });
  for (const k of ['reachable', 'health', 'disk', 'nodes', 'master', 'repos', 'slm', 'slmSupported', 'appliedSlm', 'ilmErrorCount']) {
    assert.deepEqual(d[k], direct[k], `${k} differs between the fleet and the direct path`);
  }
  assert.equal(d.disk.percent, 45);
  assert.equal(d.healthUnknown, false);
});

test('an HTTP error on one request stays on that figure; the entry is still ok', () => {
  const cs = fullCluster();
  cs.datasets.policies.data.slm = httpErr(405, 'no SLM on a basic licence');
  const pairs = fleetPairs(cs);
  assert.equal(pairs.slm.ok, false);
  assert.equal(pairs.repos.ok, true, 'one failing request must not take its neighbours with it');
  const d = applyFleetEntry('c1', cs);
  assert.equal(d.slmSupported, false, 'a 405 from _slm IS "no SLM API"');
});

test('an error entry is unknown with its last good value kept — never empty', () => {
  const cs = fullCluster();
  cs.datasets.nodes = entry(cs.datasets.nodes.data, {
    status: 'error', fetchedAt: NOW - 20 * MIN, error: { kind: 'timeout', message: 'timed out', query: 'nodes' },
  });
  const pairs = fleetPairs(cs);
  assert.equal(pairs.nodes.ok, true, 'the last good body is still the best answer there is');
  assert.equal(pairs.nodes.stale, 'error', '…and it is marked as not current');
  const d = applyFleetEntry('c1', cs);
  assert.equal(d.nodes.length, 2, 'a failed re-fetch must not blank the node list');
  const f = datasetFreshness('c1', 'nodes');
  // datasetFreshness answers from the cache only in fleet mode; the wording is the point.
  const w = freshnessText('nodes', { ts: NOW - 20 * MIN, status: 'error', error: { message: 'timed out' } }, NOW);
  assert.match(w.text, /^nodes unknown — last fetch failed: timed out \(showing what was fetched 20 m ago\)$/);
  assert.equal(w.unknown, true);
  assert.ok(f, 'datasetFreshness always answers');
});

test('a never-fetched dataset is unknown, not zero', () => {
  const cs = fullCluster();
  cs.datasets.policies = { status: 'never', fetchedAt: null, staleAfterMs: 10800000, seq: 0, error: null, data: null };
  const pairs = fleetPairs(cs);
  assert.equal(pairs.slm.ok, false);
  assert.equal(pairs.slm.unknown, true);
  const d = applyFleetEntry('c1', cs);
  assert.equal(d.slmSupported, null, 'not fetched is not "this cluster has no SLM API"');
  assert.equal(freshnessText('policies', { ts: 0, status: 'never' }, NOW).text, 'policies never fetched');
});

test('health never fetched: loading, and no "unreachable" alert about a cluster nobody asked', () => {
  const cs = fullCluster();
  cs.reach = { state: 'unknown', since: null, lastError: null, nextProbeAt: null, failures: 0, seq: 0 };
  cs.datasets.health = { status: 'never', fetchedAt: null, staleAfterMs: 360000, seq: 0, error: null, data: null };
  const d = applyFleetEntry('c1', cs);
  assert.equal(d.healthUnknown, true);
  assert.equal(d.updatedAt, 0, 'the overview reads "loading" from a zero updatedAt');
  assert.equal(alerts().filter((a) => a.key === 'c1:unreachable').length, 0);
});

test('health error: the cluster is down — its last good body must not make it look up', () => {
  applyFleetEntry('c1', fullCluster());
  const cs = fullCluster();
  cs.reach = { state: 'unreachable', since: NOW - 30 * MIN, lastError: { kind: 'timeout', message: 'connect timed out' }, failures: 4, seq: 9 };
  cs.datasets.health = entry(cs.datasets.health.data, {
    status: 'error', fetchedAt: NOW - 31 * MIN, error: { kind: 'timeout', message: 'connect timed out', query: 'root' },
  });
  const d = applyFleetEntry('c1', cs);
  assert.equal(d.reachable, false);
  assert.equal(d.error.kind, 'timeout');
  assert.deepEqual(d.info, ROOT_BODY, 'what it was (version, name) is still known from before');
  assert.ok(alerts().some((a) => a.key === 'c1:unreachable'));
  const since = new Date(NOW - 30 * MIN);
  const hhmm = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`;
  const w = freshnessText('health', { ts: NOW - 31 * MIN, status: 'error', reach: { state: 'unreachable', since: NOW - 30 * MIN } }, NOW);
  assert.equal(w.text, `health unknown — unreachable since ${hhmm}, retrying every 2 min (showing what was fetched 31 m ago)`);
});

test('restored from disk: used, and labelled as not yet re-verified', () => {
  const cs = fullCluster();
  cs.datasets.health = entry(cs.datasets.health.data, { status: 'restored', fetchedAt: NOW - 90 * MIN });
  const pairs = fleetPairs(cs);
  assert.equal(pairs.health.ok, true);
  assert.equal(pairs.health.stale, 'restored');
  const d = applyFleetEntry('c1', cs);
  assert.equal(d.reachable, true);
  assert.equal(d.datasets.health.status, 'restored');
  assert.equal(freshnessText('health', { ts: NOW - 90 * MIN, status: 'restored' }, NOW).text,
    'health restored from cache (before restart), refreshing…');
});

test('the overview stamp is the OLDEST dataset it is built from, in our clock', () => {
  applyFleetEntry('c1', fullCluster());
  assert.equal(fetchedAt('c1', 'data'), NOW - 10 * MIN, 'policies is the stalest of the five');
  assert.equal(fetchedAt('c1', 'health'), NOW - MIN);
  // The core's clock is five seconds ahead of ours: its times are shifted back.
  applyFleetState({ ok: true, seq: 5, now: Date.now() + 5000, full: true, clusterIds: ['c1'], catalogue: [],
    clusters: { c1: fullCluster() } });
  const got = fetchedAt('c1', 'data');
  assert.ok(Math.abs(got - (NOW - 10 * MIN - 5000)) < 1000, `expected the skew removed, got ${NOW - got} ms ago`);
  // …and a fleet figure is still the oldest cluster.
  state.fetchedAt['c2:data'] = NOW - 60 * MIN;
  assert.equal(oldestFetch(['c1', 'c2'], 'data'), NOW - 60 * MIN);
});

test('FLEET_STATE with since merges over what the cluster already had', () => {
  applyFleetState({ ok: true, seq: 10, now: Date.now(), full: true, clusterIds: ['c1'], catalogue: [], clusters: { c1: fullCluster() } });
  assert.equal(fleet.seq, 10);
  const nodes = entry({ nodes: ans(NODES_BODY.slice(0, 1)), alloc: ans(ALLOC_BODY.slice(0, 1)) }, { seq: 11 });
  applyFleetState({ ok: true, seq: 11, now: Date.now(), full: false, clusterIds: ['c1'], clusters: { c1: { datasets: { nodes } } } });
  const d = state.data.get('c1');
  assert.equal(d.nodes.length, 1, 'the changed dataset is applied');
  assert.equal(d.health.status, 'green', 'the unchanged ones are kept, not dropped');
  assert.equal(fleet.seq, 11);
});

/* --------------------------------- snapshots --------------------------------- */

const catRow = (id, status, startSec, indices = 3) => ({
  id, status, start_epoch: String(startSec), end_epoch: String(startSec + 60), duration: '1m',
  indices: String(indices), successful_shards: '3', failed_shards: '0', total_shards: '3',
});
const verboseRow = (id, state_, startMs, indices) => ({
  snapshot: id, state: state_, start_time_in_millis: startMs, end_time_in_millis: startMs + 60000,
  duration_in_millis: 60000, indices, shards: { successful: 3, failed: 0, total: 3 },
});

test('the _cat listing names no indices: unknown, never "not covered"', async () => {
  const cs = fullCluster();
  cs.datasets.snapshots = entry({ byRepo: { daily: ans([catRow('s1', 'SUCCESS', 1000)], { source: 'cat' }) } });
  applyFleetEntry('c1', cs);
  const rows = state.data.get('c1').snapshots.daily;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].indexNames, null);
  assert.equal(state.data.get('c1').snapshotsSource.daily, 'cat');
  state.clients.set('c1', { snapshots: async () => { throw new Error('must not be asked: the cache has a listing'); } });
  const v = (await verifyIndicesInSnapshots({ id: 'c1' }, ['logs-2026.09.01'])).get('logs-2026.09.01');
  assert.equal(v.covered, false);
  assert.ok(v.unverified.length, 'coverage from a listing without index names is reported unverified');
});

test('cat newer than full: the cat decides what exists, full lends index names by id', () => {
  const full = { rows: null, at: 1000 };
  const cat = { rows: null, at: 2000 };
  const S2 = S;
  full.rows = S2.snapshotRowsVerbose({ snapshots: [
    verboseRow('s1', 'SUCCESS', 1_000_000, ['logs-2026.09.01']),
    verboseRow('gone', 'SUCCESS', 900_000, ['logs-2026.08.31']),
  ] }, '(?<date>\\d{4}\\.\\d{2}\\.\\d{2})');
  full.source = 'verbose';
  cat.rows = S2.snapshotRowsCat([catRow('s2', 'IN_PROGRESS', 1100), catRow('s1', 'SUCCESS', 1000)]);
  cat.source = 'cat';
  const m = mergeSnapshotListings(cat, full);
  assert.deepEqual(m.rows.map((r) => r.id), ['s2', 's1'], 'deleted since the verbose read: gone; taken since: present');
  assert.equal(m.rows[0].indexNames, null, 's2 was never read verbosely: unknown');
  assert.deepEqual(m.rows[1].indexNames, ['logs-2026.09.01'], 's1 borrows its names from the verbose listing');
  assert.equal(m.rows[1].coverFrom, '2026-09-01');
  assert.equal(m.source, 'mixed');
});

test('full newer than cat: the verbose listing is used as it is', () => {
  const cat = { rows: S.snapshotRowsCat([catRow('s1', 'IN_PROGRESS', 1000)]), at: 1000, source: 'cat' };
  const full = { rows: S.snapshotRowsVerbose({ snapshots: [verboseRow('s1', 'SUCCESS', 1_000_000, ['a'])] }), at: 2000, source: 'verbose' };
  const m = mergeSnapshotListings(cat, full);
  assert.equal(m.rows[0].status, 'SUCCESS', 'the newer listing decides the status');
  assert.equal(m.source, 'verbose');
});

test('neither listing has the repository: unknown — no "no snapshots" alert', () => {
  assert.equal(mergeSnapshotListings(null, null), null);
  const cs = fullCluster();
  cs.datasets.snapshots = entry({ byRepo: {} });
  applyFleetEntry('c1', cs);
  assert.equal(state.data.get('c1').snapshots.daily, undefined);
  assert.equal(alerts().filter((a) => a.key.startsWith('c1:repo:daily')).length, 0);
});

test('a repository listing that answered with an HTTP error is "could not be read", not empty', () => {
  const cs = fullCluster();
  cs.datasets.snapshots = entry({ byRepo: { daily: { ...httpErr(500, 'repository_missing_exception'), source: 'cat' } } });
  applyFleetEntry('c1', cs);
  const d = state.data.get('c1');
  assert.deepEqual(d.snapshots.daily, []);
  assert.match(d.repos[0].error, /repository_missing/);
  assert.ok(alerts().some((a) => a.key === 'c1:repo:daily:unreadable'));
});

test('indices and shards entries land where the pages read them', () => {
  const cs = { datasets: {
    indices: entry({ indices: ans([{ index: 'logs-a', health: 'green', status: 'open', 'store.size': '100', pri: '1', rep: '1' }]) }),
    shards: entry({ shards: ans([{ index: 'logs-a', shard: '0', prirep: 'p', state: 'STARTED' }]),
      tasks: httpErr(404, 'no _cat/tasks'), threadPools: ans([]), pendingTasks: ans({ tasks: [] }) }),
  } };
  applyFleetEntry('c1', cs);
  assert.equal(state.indices.get('c1')[0].index, 'logs-a');
  assert.equal(state.indices.get('c1')[0].size, 100);
  const sh = state.shards.get('c1');
  assert.equal(sh.rows.length, 1);
  assert.equal(sh.error, null);
  assert.equal(sh.tasks, null, 'a failed side read is null (unknown), not []');
  assert.deepEqual(sh.pending, []);
});
