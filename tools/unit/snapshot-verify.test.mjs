/**
 * verifyIndicesInSnapshots: reuse the per-repo snapshot listing state.js already fetched
 * for this cluster in the same run (state.data.get(id).snapshots), instead of listing the
 * repository again — and never claim a listing that could not be read (or that cannot
 * name indices) means "not covered".
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

// state.js wants a browser; none of what verifyIndicesInSnapshots touches needs one, but
// the import chain has to resolve. Same shim as snapshot-notify.test.mjs.
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

const { state } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);
const { verifyIndicesInSnapshots, coverageLabel } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-verify.js')).href);

const CLUSTER = { id: 'c1' };

beforeEach(() => { state.data.clear(); state.clients.clear(); });

test('reuses the cached per-repo listing instead of asking Elasticsearch again', async () => {
  let calls = 0;
  state.clients.set('c1', { snapshots: async () => { calls++; return { snapshots: [] }; } });
  state.data.set('c1', {
    repos: [{ name: 'daily' }],
    snapshots: { daily: [
      { id: 'snap-1', status: 'SUCCESS', start: 100, end: 200, failed: 0, indexNames: ['logs-01'] },
    ] },
  });

  const v = await verifyIndicesInSnapshots(CLUSTER, ['logs-01']);
  assert.equal(calls, 0, 'the cached listing should have been used, not refetched');
  const r = v.get('logs-01');
  assert.equal(r.covered, true);
  assert.equal(r.best.snapshot, 'snap-1');
  assert.equal(coverageLabel(r).text, 'in snap-1');
});

test('falls back to fetching when nothing was cached for the repository', async () => {
  let calls = 0;
  state.clients.set('c1', {
    snapshots: async (repo) => {
      calls++;
      assert.equal(repo, 'daily');
      return { snapshots: [{
        snapshot: 'snap-9', state: 'SUCCESS', indices: ['logs-02'],
        start_time_in_millis: 1, end_time_in_millis: 2,
        shards: { failed: 0 }, failures: [],
      }] };
    },
  });
  // No `snapshots` key at all on the data entry — as if fetchSnapshots never ran this run.
  state.data.set('c1', { repos: [{ name: 'daily' }] });

  const v = await verifyIndicesInSnapshots(CLUSTER, ['logs-02']);
  assert.equal(calls, 1, 'with nothing cached, the repository should be listed once');
  assert.equal(v.get('logs-02').covered, true);
});

test('a cached snapshot with a shard failure is treated conservatively, not as covered', async () => {
  state.clients.set('c1', { snapshots: async () => { throw new Error('should not be called'); } });
  state.data.set('c1', {
    repos: [{ name: 'daily' }],
    snapshots: { daily: [
      { id: 'snap-2', status: 'SUCCESS', start: 100, end: 200, failed: 1, indexNames: ['logs-03'] },
    ] },
  });

  const v = await verifyIndicesInSnapshots(CLUSTER, ['logs-03']);
  const r = v.get('logs-03');
  // The cached listing only knows the snapshot had SOME shard failure, not whose — so a
  // failure anywhere in the snapshot disqualifies it for every index, never the other way.
  assert.equal(r.covered, false);
  assert.equal(r.all.length, 1, 'the snapshot still appears as a holder, just not a good one');
  assert.equal(coverageLabel(r).text, 'only in a SUCCESS snapshot');
});

test('a fresh fetch keeps per-index failure precision the cached listing cannot', async () => {
  // Two indices in the same snapshot; only one of them has a recorded failure. A fresh
  // fetch (nothing cached) has the raw `failures[]` array and can tell them apart.
  state.clients.set('c1', {
    snapshots: async () => ({
      snapshots: [{
        snapshot: 'snap-7', state: 'SUCCESS', indices: ['logs-a', 'logs-b'],
        start_time_in_millis: 1, end_time_in_millis: 2,
        shards: { failed: 1 }, failures: [{ index: 'logs-a' }],
      }],
    }),
  });
  state.data.set('c1', { repos: [{ name: 'daily' }] });

  const v = await verifyIndicesInSnapshots(CLUSTER, ['logs-a', 'logs-b']);
  assert.equal(v.get('logs-a').covered, false, 'the index named in failures[] is not covered');
  assert.equal(v.get('logs-b').covered, true, 'its sibling in the same snapshot is unaffected');
});

test('a cached listing with no index names is unknown, never "not covered"', async () => {
  state.clients.set('c1', { snapshots: async () => { throw new Error('should not be called'); } });
  state.data.set('c1', {
    repos: [{ name: 'daily' }],
    // fetchSnapshots' own _cat fallback shape: indexNames is null, not an empty array.
    snapshots: { daily: [
      { id: 'snap-3', status: 'SUCCESS', start: 100, end: 200, failed: 0, indexNames: null },
    ] },
  });

  const v = await verifyIndicesInSnapshots(CLUSTER, ['logs-04']);
  const r = v.get('logs-04');
  assert.equal(r.covered, false);
  assert.equal(r.all.length, 0, 'membership could not be checked, so it is not listed as a holder either');
  assert.ok(r.unverified.length > 0, 'the repository is flagged unverified');
  assert.equal(coverageLabel(r).text, 'could not verify');
});

test('a repository that fails to list is unverified, not empty', async () => {
  state.clients.set('c1', { snapshots: async () => { throw new Error('timed out'); } });
  state.data.set('c1', { repos: [{ name: 'daily' }] });

  const v = await verifyIndicesInSnapshots(CLUSTER, ['logs-05']);
  const r = v.get('logs-05');
  assert.equal(r.covered, false);
  assert.equal(r.all.length, 0);
  assert.match(r.unverified[0], /timed out/);
  assert.equal(coverageLabel(r).text, 'could not verify');
});
