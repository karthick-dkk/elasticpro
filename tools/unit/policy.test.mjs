/** The request policy's presets, bounds and form arithmetic — core/policy.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const P = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/policy.js')).href);
const D = P.FALLBACK_DEFAULTS;

test('four presets, automatic first, each producing a whole policy', () => {
  assert.deepEqual(P.PRESETS.map((x) => x.id), ['auto', 'background', 'hybrid', 'client']);
  assert.match(P.PRESETS[0].label, /^Automatic \(recommended\)/);
  assert.equal(P.MODES[0], 'auto', 'auto is the default mode');
  assert.equal(D.mode, 'auto');
  assert.deepEqual(P.applyPreset(null, 'auto', D), P.normalisePolicy(D, D), 'automatic is the shipped policy');
  const bg = P.applyPreset(null, 'background', D);
  assert.equal(bg.mode, 'background');
  assert.equal(P.applyPreset(bg, 'hybrid', D).mode, 'hybrid');
  const client = P.applyPreset(bg, 'client', D);
  assert.equal(client.mode, 'on-demand');
  assert.equal(client.concurrency.perCluster, 1);
  assert.equal(client.concurrency.global, 4);
  assert.throws(() => P.applyPreset(bg, 'nope', D));
});

test('a preset keeps what is paused', () => {
  const paused = { ...P.normalisePolicy(D, D), paused: { all: true, clusters: ['a'] } };
  assert.deepEqual(P.applyPreset(paused, 'client', D).paused, { all: true, clusters: ['a'] });
});

test('activePreset recognises a preset and not a hand-made policy', () => {
  assert.equal(P.activePreset(P.applyPreset(null, 'client', D), D), 'client');
  assert.equal(P.activePreset(P.normalisePolicy(D, D), D), 'auto', 'the shipped policy is the automatic preset');
  assert.equal(P.activePreset(P.applyPreset(null, 'background', D), D), 'background');
  assert.equal(P.activePreset({ ...P.applyPreset(null, 'background', D), paused: { all: true, clusters: ['x'] } }, D), 'background');
  const custom = P.applyPreset(null, 'background', D);
  custom.intervalsSec = { ...custom.intervalsSec, nodes: 999 };
  assert.equal(P.activePreset(custom, D), null);
});

test('normalise clamps like the core and drops unknown datasets', () => {
  const n = P.normalisePolicy({
    mode: 'on-demand', intervalsSec: { health: 5, nodes: 1, indices: 10 ** 9, bogus: 9 },
    watchMinutes: 0, concurrency: { global: 999, perCluster: 0, tunnel: 99 }, timeoutMs: 10,
    paused: { clusters: ['a', 'a', ' ', 'b'] },
  }, D);
  assert.equal(n.intervalsSec.health, 60, 'health floor');
  assert.equal(n.intervalsSec.nodes, 30, 'other floor');
  assert.equal(n.intervalsSec.indices, 86400);
  assert.equal(n.intervalsSec.shards, 300, 'missing takes the default');
  assert.ok(!('bogus' in n.intervalsSec));
  assert.equal(n.watchMinutes, 1);
  assert.deepEqual(n.concurrency, { global: 256, perCluster: 1, tunnel: 32 });
  assert.equal(n.timeoutMs, 1000);
  assert.deepEqual(n.paused, { all: false, clusters: ['a', 'b'] });
  assert.equal(P.normalisePolicy({ mode: 'sometimes' }, D).mode, 'auto');
});

test('fromForm names every field it had to change', () => {
  const ok = P.fromForm({ mode: 'hybrid', intervalsSec: { ...D.intervalsSec }, watchMinutes: '20',
    global: '8', perCluster: '2', tunnel: '6', timeoutMs: '30000', pausedAll: false, pausedClusters: [] }, D);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.policy.watchMinutes, 20);
  assert.equal(ok.policy.mode, 'hybrid');

  const bad = P.fromForm({ mode: 'background', intervalsSec: { ...D.intervalsSec, health: '10', nodes: 'abc' },
    watchMinutes: '500', global: '', perCluster: '9', tunnel: '6', timeoutMs: '30000' }, D);
  assert.equal(bad.policy.intervalsSec.health, 60);
  assert.equal(bad.policy.intervalsSec.nodes, 300);
  assert.equal(bad.policy.watchMinutes, 240);
  assert.equal(bad.policy.concurrency.global, 16);
  assert.equal(bad.policy.concurrency.perCluster, 8);
  const said = bad.problems.join('\n');
  for (const word of ['Health interval', 'Nodes & disk interval', 'Watch window', 'all clusters', 'per cluster']) {
    assert.ok(said.includes(word), `expected a problem naming "${word}", got:\n${said}`);
  }
  assert.equal(bad.problems.length, 5);
});

test('togglePaused: idempotent, keeps order, removes on resume, returns a new policy', () => {
  const p = { mode: 'background', paused: { all: false, clusters: ['a', 'b'] } };
  const q = P.togglePaused(p, 'c', true);
  assert.deepEqual(q.paused.clusters, ['a', 'b', 'c']);
  assert.notEqual(q, p);
  assert.deepEqual(p.paused.clusters, ['a', 'b'], 'the original is untouched');
  assert.deepEqual(P.togglePaused(q, 'a', true).paused.clusters, ['a', 'b', 'c'], 'pausing twice changes nothing');
  assert.deepEqual(P.togglePaused(q, 'b', false).paused.clusters, ['a', 'c']);
  assert.deepEqual(P.togglePaused(q, 'zz', false).paused.clusters, ['a', 'b', 'c']);
  assert.deepEqual(P.togglePaused({}, 'x', true).paused, { all: false, clusters: ['x'] });
  assert.equal(P.togglePaused({ paused: { all: true, clusters: [] } }, 'x', true).paused.all, true);
});

test('describeMode has a sentence for each mode', () => {
  for (const m of P.MODES) assert.match(P.describeMode(m), /\.$/);
  assert.equal(new Set(P.MODES.map(P.describeMode)).size, 4);
  assert.equal(P.describeMode('auto'), 'Background up to 25 clusters, hybrid above — so a large fleet is not polled for everything all the time.');
});

test('every dataset has a label', () => {
  assert.deepEqual(Object.keys(P.DATASET_LABELS).sort(), Object.keys(D.intervalsSec).sort());
});
