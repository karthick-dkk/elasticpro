/** The request policy's presets, bounds and form arithmetic — core/policy.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const P = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/policy.js')).href);
const D = P.FALLBACK_DEFAULTS;

test('four presets, Client basis first and recommended, each producing a whole policy', () => {
  assert.deepEqual(P.PRESETS.map((x) => x.id), ['client', 'auto', 'background', 'hybrid']);
  assert.match(P.PRESETS[0].label, /^Client basis \(recommended\)/);
  assert.ok(P.PRESETS.slice(1).every((x) => !/recommended/.test(x.label)), 'only one preset is recommended');
  assert.equal(D.mode, 'on-demand', 'the shipped mode is Client basis');
  assert.deepEqual(P.applyPreset(null, 'client', D), P.normalisePolicy(D, D), 'Client basis is the shipped policy');
  const bg = P.applyPreset(null, 'background', D);
  assert.equal(bg.mode, 'background');
  assert.deepEqual(bg.concurrency, { global: 16, perCluster: 2, tunnel: 6 }, 'the classic presets keep the classic concurrency, not Client basis\'s');
  assert.equal(P.applyPreset(bg, 'hybrid', D).mode, 'hybrid');
  assert.equal(P.applyPreset(bg, 'auto', D).concurrency.perCluster, 2);
  const client = P.applyPreset(bg, 'client', D);
  assert.equal(client.mode, 'on-demand');
  assert.equal(client.concurrency.perCluster, 1);
  assert.equal(client.concurrency.global, 4);
  assert.throws(() => P.applyPreset(bg, 'nope', D));
});

test('a fresh install is the client preset, and the UI and the core ship the same numbers', () => {
  // No saved policy: the core's `policy` equals its `defaults`, Client basis.
  assert.equal(P.activePreset(P.normalisePolicy(D, D), D), 'client');
  assert.equal(P.activePreset(P.normalisePolicy(null, D), D), 'client', 'a missing policy is the shipped one');
  assert.equal(P.activePreset(P.normalisePolicy(null), undefined), 'client', 'an older core that reports no defaults');
  // The fallback is derived from the one definition, not typed twice…
  assert.deepEqual([D.mode, D.concurrency.perCluster, D.concurrency.global],
    [P.CLIENT_BASIS.mode, P.CLIENT_BASIS.perCluster, P.CLIENT_BASIS.global]);
  // …and it is the core's: crates/elasticpro-core/src/fleet/policy.rs.
  const rs = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/fleet/policy.rs'), 'utf8');
  const num = (name) => Number(new RegExp(`pub const ${name}: usize = (\\d+);`).exec(rs)[1]);
  assert.equal(num('CLIENT_BASIS_PER_CLUSTER'), P.CLIENT_BASIS.perCluster);
  assert.equal(num('CLIENT_BASIS_GLOBAL'), P.CLIENT_BASIS.global);
  assert.equal(num('CLASSIC_PER_CLUSTER'), P.CLASSIC.perCluster);
  assert.equal(num('CLASSIC_GLOBAL'), P.CLASSIC.global);
  assert.match(rs, /mode: Mode::OnDemand,\s*concurrency: Concurrency::with_global\(CLIENT_BASIS_GLOBAL, CLIENT_BASIS_PER_CLUSTER\)/,
    'Policy::shipped() is Client basis');
  assert.equal(Number(/pub const AUTO_HYBRID_ABOVE: usize = (\d+);/.exec(rs)[1]), P.AUTO_HYBRID_ABOVE);
  // A policy somebody saved is read as it is: auto stays auto, whatever is shipped.
  const saved = { ...P.normalisePolicy(D, D), mode: 'auto', concurrency: { global: 16, perCluster: 2, tunnel: 6 } };
  assert.equal(P.normalisePolicy(saved, D).mode, 'auto');
  assert.equal(P.activePreset(saved, D), 'auto');
});

test('a preset keeps what is paused', () => {
  const paused = { ...P.normalisePolicy(D, D), paused: { all: true, clusters: ['a'] } };
  assert.deepEqual(P.applyPreset(paused, 'client', D).paused, { all: true, clusters: ['a'] });
});

test('activePreset recognises a preset and not a hand-made policy', () => {
  assert.equal(P.activePreset(P.applyPreset(null, 'client', D), D), 'client');
  assert.equal(P.activePreset(P.normalisePolicy(D, D), D), 'client', 'the shipped policy is the Client basis preset');
  assert.equal(P.activePreset(P.applyPreset(null, 'auto', D), D), 'auto');
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
  assert.equal(P.normalisePolicy({ mode: 'sometimes' }, D).mode, 'on-demand', 'an unknown mode takes the shipped one');
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
  assert.equal(bad.policy.concurrency.global, 4, 'left empty: the shipped value, which is Client basis\'s');
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

test('the concurrency fields sit under the request gate the core reports', () => {
  const gate = { global: 24, perCluster: 4, perJump: 8 };
  const b = P.boundsUnder(gate);
  assert.deepEqual([b.global.max, b.perCluster.max, b.tunnel.max], [24, 4, 8]);
  assert.deepEqual([b.global.gate, b.perCluster.gate, b.tunnel.gate], ['ES_CONCURRENCY', 'ES_PER_CLUSTER', 'ES_PER_JUMP_HOST']);
  assert.equal(b.timeoutMs, P.BOUNDS.timeoutMs, 'fields without a gate cap keep their bounds');
  assert.deepEqual(P.boundsUnder(undefined), P.BOUNDS, 'an older core that reports no gate: the form keeps its own bounds');
  assert.equal(P.boundsUnder({ perCluster: 16 }).perCluster.max, 8, 'a gate above the poller\'s own bound does not raise it');

  // Typed 8 per cluster under a gate of 4: saved as 4, and the person is told why.
  const f = P.fromForm({ mode: 'background', intervalsSec: { ...D.intervalsSec }, watchMinutes: '15',
    global: '16', perCluster: '8', tunnel: '6', timeoutMs: '30000' }, D, b);
  assert.equal(f.policy.concurrency.perCluster, 4);
  assert.equal(f.problems.length, 1);
  assert.match(f.problems[0], /per cluster: 8 is more than this core's request gate allows \(4, set by ES_PER_CLUSTER/);
  // A preset above a lowered gate is clamped too, and matches what the core keeps.
  const low = P.boundsUnder({ global: 8, perCluster: 1, perJump: 2 });
  const n = P.applyPreset(null, 'background', D, low);
  assert.deepEqual(n.concurrency, { global: 8, perCluster: 1, tunnel: 2 });
  assert.equal(P.activePreset(n, D, low), 'background');
  assert.deepEqual(P.normalisePolicy(D, D, low).concurrency, { global: 4, perCluster: 1, tunnel: 2 }, 'Client basis already fits under it');
  assert.equal(P.activePreset(P.normalisePolicy(D, D, low), D, low), 'client');
});
