/**
 * What the Nodes & shards page decides before it draws (core/nodes-shards.js): how a shard
 * population splits, which indices are hidden and when they show anyway, the usage levels
 * the bars are coloured by, and how a load average becomes a bar — or does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { shardSplit, isHiddenIndex, wantsHidden, visibleShards, USAGE_THRESHOLDS, usageLevel, loadPercent, coresByNode } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/nodes-shards.js')).href);

const rows = [
  { index: 'logstash-a', state: 'STARTED' },
  { index: 'logstash-a', state: 'STARTED' },
  { index: 'logstash-b', state: 'RELOCATING' },
  { index: 'logstash-b', state: 'initializing' },
  { index: 'logstash-c', state: 'UNASSIGNED' },
  { index: '.kibana_1', state: 'STARTED' },
  { index: '.security-7', state: 'STARTED' },
];

test('shardSplit counts the three parts and the total, whatever the case of the state', () => {
  assert.deepEqual(shardSplit(rows), { started: 4, moving: 2, unassigned: 1, total: 7 });
  assert.deepEqual(shardSplit([]), { started: 0, moving: 0, unassigned: 0, total: 0 });
  assert.deepEqual(shardSplit(null), { started: 0, moving: 0, unassigned: 0, total: 0 });
});

test('a state outside the three is in the total and in no part', () => {
  const s = shardSplit([{ state: 'STARTED' }, { state: 'CLOSED' }]);
  assert.deepEqual(s, { started: 1, moving: 0, unassigned: 0, total: 2 });
});

test('hidden indices are the ones whose name starts with "."', () => {
  assert.equal(isHiddenIndex('.kibana_1'), true);
  assert.equal(isHiddenIndex('logstash-2026.11.14'), false);
  assert.equal(isHiddenIndex(''), false);
  assert.equal(isHiddenIndex(null), false);
});

test('hidden indices are wanted when the box is ticked or the filter starts with "."', () => {
  assert.equal(wantsHidden(false, ''), false);
  assert.equal(wantsHidden(true, ''), true);
  assert.equal(wantsHidden(false, '.kib'), true);
  assert.equal(wantsHidden(false, '  .kib'), true);
  assert.equal(wantsHidden(false, 'kib.'), false);
});

test('visibleShards keeps hidden indices out by default and counts them', () => {
  const off = visibleShards(rows, false, '');
  assert.equal(off.rows.length, 5);
  assert.equal(off.hidden, 2);
  assert.ok(off.rows.every((r) => !r.index.startsWith('.')));
  const on = visibleShards(rows, true, '');
  assert.equal(on.rows.length, 7);
  assert.equal(on.hidden, 0);
  const asked = visibleShards(rows, false, '.sec');
  assert.equal(asked.rows.length, 7, 'a "." filter is asking for them');
  assert.equal(asked.hidden, 0);
});

test('usage levels: heap turns at 75/85, everything else at the disk watermark shape 80/90', () => {
  assert.deepEqual(USAGE_THRESHOLDS.heap, { warn: 75, crit: 85 });
  assert.deepEqual(USAGE_THRESHOLDS.disk, { warn: 80, crit: 90 });
  assert.equal(usageLevel(74.9, 'heap'), 'ok');
  assert.equal(usageLevel(75, 'heap'), 'warn');
  assert.equal(usageLevel(85, 'heap'), 'crit');
  assert.equal(usageLevel(79, 'disk'), 'ok');
  assert.equal(usageLevel(80, 'disk'), 'warn');
  assert.equal(usageLevel(90, 'disk'), 'crit');
  assert.equal(usageLevel(80), 'warn', 'disk is the default kind');
  assert.equal(usageLevel(80, 'no-such-kind'), 'warn', 'an unknown kind reads as disk');
});

test('usage level of an unknown figure is null, not ok and not zero', () => {
  assert.equal(usageLevel(NaN), null);
  assert.equal(usageLevel(''), null);
  assert.equal(usageLevel(null), null);
  assert.equal(usageLevel('61', 'heap'), 'ok', 'a _cat string is a number');
});

test('loadPercent is load over cores, capped at 100', () => {
  assert.equal(loadPercent('3.55', 4), 88.75);
  assert.equal(loadPercent(2, 4), 50);
  assert.equal(loadPercent('9.5', 4), 100, 'capped');
  assert.equal(loadPercent(0, 4), 0, 'an idle node is a real zero');
});

test('loadPercent is null when the load or the core count is not known', () => {
  assert.equal(loadPercent('', 4), null);
  assert.equal(loadPercent(null, 4), null);
  assert.equal(loadPercent('1.2', undefined), null);
  assert.equal(loadPercent('1.2', null), null);
  assert.equal(loadPercent('1.2', 0), null, 'zero cores is not a scale');
  assert.equal(loadPercent('1.2', NaN), null);
  assert.equal(loadPercent('n/a', 4), null);
});

test('coresByNode reads allocated_processors by node name and skips nodes without one', () => {
  const m = coresByNode({ nodes: {
    a: { name: 'node-1', os: { allocated_processors: 4, available_processors: 8 } },
    b: { name: 'node-2', os: { allocated_processors: '2' } },
    c: { name: 'node-3' },
    d: { name: 'node-4', os: { allocated_processors: 0 } },
  } });
  assert.deepEqual([...m.entries()], [['node-1', 4], ['node-2', 2]]);
  assert.equal(coresByNode(null).size, 0);
  assert.equal(coresByNode({ acknowledged: true }).size, 0, 'a fixture answering nothing useful is nobody’s core count');
});
