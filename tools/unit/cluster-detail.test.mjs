/** Small readings the cluster pages share (core/cluster-detail.js): roles, the shard gauge, the Refresh badge, health counts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const D = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/cluster-detail.js')).href);

test('node.role letters become Elasticsearch role names; "-" is coordinating-only', () => {
  assert.deepEqual(D.nodeRoles('dhim'), ['data', 'data_hot', 'ingest', 'master']);
  assert.deepEqual(D.nodeRoles('mhi'), ['master', 'data_hot', 'ingest']);
  assert.deepEqual(D.nodeRoles('-'), []);
  assert.deepEqual(D.nodeRoles(''), []);
  assert.deepEqual(D.nodeRoles('zz'), [], 'letters Elasticsearch does not use are ignored, never invented');
});

test('shard allocation: the counts, the total, the active share; unknown health is null', () => {
  const a = D.shardAllocation({ status: 'yellow', active_shards: 40, relocating_shards: 0, initializing_shards: 0, unassigned_shards: 2, active_shards_percent_as_number: 95.2 });
  assert.deepEqual(a, { active: 40, relocating: 0, initializing: 0, unassigned: 2, total: 42, pct: 95.2, level: 'warn' });
  assert.equal(D.shardAllocation({ status: 'red', active_shards: 10, unassigned_shards: 3, active_shards_percent_as_number: 70 }).level, 'bad');
  assert.equal(D.shardAllocation({ status: 'green', active_shards: 10, active_shards_percent_as_number: 100 }).level, 'ok');
  assert.equal(D.shardAllocation(null), null);
  assert.equal(D.shardAllocation({}), null, 'no shard count is unknown, not zero');
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
