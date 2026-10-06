/** The Clusters page's figures from Zabbix — and when they are not believed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const z = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/zabbix-metrics.js')).href);
const NOW = 1_790_000_000;
const at = (value, age) => ({ value: String(value), clock: NOW - age });
const healthy = () => ({
  'es.cluster.status': at(1, 60), 'es.cluster.unassigned_shards': at(113, 60),
  'es.cluster.initializing_shards': at(0, 60), 'es.cluster.relocating_shards': at(0, 60),
  'es.cluster.number_of_nodes': at(1, 3000), 'es.cluster.number_of_data_nodes': at(1, 3000),
  'es.cluster.inactive_shards_percent_as_number': at(49.5, 60),
  'es.version': at('8.19.3', 2000), 'es.cluster.get_ilm': at(1, 3000), 'es.cluster.get_slm': at(0, 3000),
});

test('fresh Zabbix values become the health response the page already parses', () => {
  const r = z.fromZabbix(healthy(), NOW);
  assert.deepEqual(r.health.value, {
    status: 'yellow', number_of_nodes: 1, number_of_data_nodes: 1, unassigned_shards: 113,
    initializing_shards: 0, relocating_shards: 0, delayed_unassigned_shards: null,
    number_of_pending_tasks: null, active_shards_percent_as_number: 50.5,
  });
  assert.equal(r.root.value.version.number, '8.19.3');
  assert.equal(r.ilm.value.operation_mode, 'RUNNING');
  assert.equal(r.slmStatus.value.operation_mode, 'STOPPED');
});

test('a node count an hour old is current — it is stored only when it changes', () => {
  assert.ok(z.fromZabbix(healthy(), NOW).health, 'a heartbeat item must not make health stale');
});

test('stale health is not believed: the page asks Elasticsearch instead', () => {
  const items = healthy();
  items['es.cluster.status'] = at(0, 6 * 60);
  assert.equal(z.fromZabbix(items, NOW).health, null);
});

test('"unknown" from Zabbix is not a status', () => {
  const items = healthy();
  items['es.cluster.status'] = at(255, 60);
  assert.equal(z.fromZabbix(items, NOW).health, null);
});

test('half a health object is not offered — a missing shard count means ask', () => {
  const items = healthy();
  delete items['es.cluster.unassigned_shards'];
  assert.equal(z.fromZabbix(items, NOW).health, null);
});

test('nothing from Zabbix is nothing, not zeros', () => {
  const r = z.fromZabbix({}, NOW);
  assert.deepEqual([r.root, r.health, r.ilm, r.slmStatus], [null, null, null, null]);
});
