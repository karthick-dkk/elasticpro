/** What a cluster's open row is drawn from (core/cluster-detail.js): roles, tiers, gauges, rates, sizes, the Refresh badge. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const D = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/cluster-detail.js')).href);
const V = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/cluster-view.js')).href);

test('node.role letters become Elasticsearch role names; "-" is coordinating-only', () => {
  assert.deepEqual(D.nodeRoles('dhim'), ['data', 'data_hot', 'ingest', 'master']);
  assert.deepEqual(D.nodeRoles('mhi'), ['master', 'data_hot', 'ingest']);
  assert.deepEqual(D.nodeRoles('-'), []);
  assert.deepEqual(D.nodeRoles(''), []);
  assert.deepEqual(D.nodeRoles('zz'), [], 'letters Elasticsearch does not use are ignored, never invented');
});

test('the tier is the hottest data_* role; plain data is "data"; no data role is none', () => {
  assert.equal(D.nodeTier(['master', 'data_hot', 'ingest']), 'hot');
  assert.equal(D.nodeTier(['data_warm', 'data_cold']), 'warm');
  assert.equal(D.nodeTier(['data_frozen']), 'frozen');
  assert.equal(D.nodeTier(['data', 'ingest']), 'data');
  assert.equal(D.nodeTier(['master']), null);
  assert.equal(D.nodeTier([]), null);
  assert.equal(D.roleKind('data_hot'), 'hot');
  assert.equal(D.roleKind('data_frozen'), 'cold');
  assert.equal(D.roleKind('ml'), 'other');
});

test('shard allocation: the counts, the total, the active share; unknown health is null', () => {
  const a = D.shardAllocation({ status: 'yellow', active_shards: 40, relocating_shards: 0, initializing_shards: 0, unassigned_shards: 2, active_shards_percent_as_number: 95.2 });
  assert.deepEqual(a, { active: 40, relocating: 0, initializing: 0, unassigned: 2, total: 42, pct: 95.2, level: 'warn' });
  assert.equal(D.shardAllocation({ status: 'red', active_shards: 10, unassigned_shards: 3, active_shards_percent_as_number: 70 }).level, 'bad');
  assert.equal(D.shardAllocation({ status: 'green', active_shards: 10, active_shards_percent_as_number: 100 }).level, 'ok');
  assert.equal(D.shardAllocation(null), null);
  assert.equal(D.shardAllocation({}), null, 'no shard count is unknown, not zero');
});

test('tasks: how many run, how many run long', () => {
  const res = { nodes: { a: { tasks: { 'a:1': { running_time_in_nanos: 95e9 }, 'a:2': { running_time_in_nanos: 4e9 } } }, b: { tasks: { 'b:1': {} } } } };
  assert.deepEqual(D.taskSummary(res), { running: 3, slow: 1 });
  assert.deepEqual(D.taskSummary({}), { running: 0, slow: 0 });
  assert.equal(D.taskSummary(null), null);
});

test('a rate needs two readings seconds apart; a counter that went backwards is no rate', () => {
  const stats = (q, i) => ({ nodes: { n1: { indices: { search: { query_total: q }, indexing: { index_total: i } } }, n2: { indices: { search: { query_total: q }, indexing: { index_total: 0 } } } } });
  const a = D.statsCounters(stats(100, 1000), 1000), b = D.statsCounters(stats(310, 4000), 11000);
  assert.deepEqual(a, { query: 200, index: 1000, at: 1000 });
  const r = D.rateBetween(a, b);
  assert.equal(r.seconds, 10);
  assert.equal(r.qps, 42);
  assert.equal(r.dps, 300);
  assert.equal(D.rateBetween(null, b), null);
  assert.equal(D.rateBetween(a, { ...b, at: 1500 }), null, 'half a second apart is not a reading');
  assert.equal(D.rateBetween(b, a), null, 'backwards is a restart, not a negative rate');
  assert.equal(D.statsCounters(null), null);
});

test('the SLM policies that write to a repository, with what they last produced', () => {
  const slm = [
    { id: 'nightly', policy: { name: '<daily-{now/d}>', repository: 'daily', schedule: '0 30 1 * * ?' }, last_success: { snapshot_name: 'daily-2026.10.25', time: 5 } },
    { id: 'weekly', policy: { name: '<weekly-{now/w}>', repository: 'archive' } },
  ];
  const got = D.slmForRepo(slm, 'daily');
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 'nightly');
  assert.equal(got[0].pattern, '<daily-{now/d}>');
  assert.equal(got[0].lastSnapshot, 'daily-2026.10.25');
  assert.deepEqual(D.slmForRepo(slm, 'other'), []);
  assert.deepEqual(D.slmForRepo(null, 'daily'), []);
});

test('a repository size is the sum only when every finished snapshot is measured', () => {
  const snaps = [{ id: 's3', status: 'IN_PROGRESS' }, { id: 's2', status: 'SUCCESS' }, { id: 's1', status: 'PARTIAL' }];
  const cache = new Map([['daily/s1', 100], ['daily/s2', 250]]);
  assert.equal(D.repoSizeFromCache('daily', snaps, cache), 350, 'the running one is not expected to be measured');
  assert.equal(D.repoSizeFromCache('daily', snaps, new Map([['daily/s1', 100]])), null, 'one unmeasured snapshot: unknown, not a smaller number');
  assert.equal(D.repoSizeFromCache('daily', [], cache), null);
  assert.equal(D.repoSizeFromCache('daily', snaps, null), null);
});

test('the Refresh badge counts whole minutes, then hours and minutes', () => {
  const now = 10_000_000;
  assert.equal(D.refreshAge(0, now), '', 'nothing before the first refresh');
  assert.equal(D.refreshAge(now - 20_000, now), '0m');
  assert.equal(D.refreshAge(now - 5 * 60_000, now), '5m');
  assert.equal(D.refreshAge(now - 19 * 60_000 - 59_000, now), '19m');
  assert.equal(D.refreshAge(now - 65 * 60_000, now), '1h 5m');
  assert.equal(D.refreshAge(now - 3 * 86_400_000, now), '3d');
});

test('health counts, one bucket per row', () => {
  const rows = ['green', 'green', 'yellow', 'red', 'unreachable', 'loading', 'weird'].map((s) => ({ s }));
  assert.deepEqual(D.healthCounts(rows, (r) => r.s), { all: 7, green: 2, yellow: 1, red: 1, unreachable: 1, loading: 2 });
});

/* ---- the open row's show/hide groups live with the column preferences ---- */

test('the open row: every tile, section and column shown by default except the node id', () => {
  const p = V.sanitizePrefs(null);
  assert.deepEqual(V.detailShown(p, 'tiles').map((x) => x.id), ['url', 'jump', 'ilm', 'slm', 'shards', 'tasks', 'rate', 'bucket']);
  assert.deepEqual(V.detailShown(p, 'sections').map((x) => x.id), ['repo', 'nodes']);
  assert.ok(!V.detailShown(p, 'nodes').some((x) => x.id === 'id'), 'the node id starts hidden');
  assert.equal(V.detailItems(p, 'repo')[0].fixed, true, 'the repository name is the row');
  assert.equal(V.expandByDefault(p), false);
});

test('hide a tile, a section and a column; the name columns stay; reset clears it all', () => {
  let p = V.setDetailShown(null, 'tiles', 'bucket', false);
  p = V.setDetailShown(p, 'sections', 'nodes', false);
  p = V.setDetailShown(p, 'nodes', 'id', true);
  p = V.setDetailShown(p, 'repo', 'name', false);
  p = V.setExpandByDefault(p, true);
  assert.ok(!V.detailShown(p, 'tiles').some((x) => x.id === 'bucket'));
  assert.deepEqual(V.detailShown(p, 'sections').map((x) => x.id), ['repo']);
  assert.ok(V.detailShown(p, 'nodes').some((x) => x.id === 'id'));
  assert.equal(V.detailShown(p, 'repo')[0].id, 'name', 'a fixed column cannot be hidden');
  assert.equal(V.expandByDefault(p), true);
  // Round trip through storage, as the page does.
  const store = new Map();
  V.writePrefs({ getItem: (k) => store.get(k), setItem: (k, v) => store.set(k, v) }, 'ann', p);
  const back = V.readPrefs({ getItem: (k) => store.get(k) }, 'ANN');
  assert.equal(V.expandByDefault(back), true);
  assert.deepEqual(V.detailShown(back, 'sections').map((x) => x.id), ['repo']);
  const reset = V.resetColumns(back);
  assert.equal(V.expandByDefault(reset), false);
  assert.deepEqual(V.detailShown(reset, 'sections').map((x) => x.id), ['repo', 'nodes']);
  assert.ok(!V.detailShown(reset, 'nodes').some((x) => x.id === 'id'));
});

test('junk in storage is dropped, not trusted', () => {
  const p = V.sanitizePrefs({ details: { tiles: { url: 'no', jump: false }, bogus: { a: true } }, expand: 'yes' });
  assert.ok(V.detailShown(p, 'tiles').some((x) => x.id === 'url'), 'a string is not a boolean');
  assert.ok(!V.detailShown(p, 'tiles').some((x) => x.id === 'jump'));
  assert.equal(V.expandByDefault(p), false);
});
