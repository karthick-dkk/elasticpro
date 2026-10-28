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

/* ------------------------- what a policy sends (change 15) ------------------------- */

const effectOf = (id, counts) => P.policyEffect(P.applyPreset(null, id, D), counts);

test('the effect of each preset, for 24 clusters, from the shipped intervals', () => {
  const n24 = { clusters: 24 };
  const client = effectOf('client', n24);
  assert.equal(client.idle.perMinute, 0);
  assert.equal(client.idle.text, 'no requests.');
  assert.match(client.open.text, /^only what that page shows, for the clusters on it/);
  assert.equal(client.open.perMinute, null, 'what a page costs depends on the page');

  const hybrid = effectOf('hybrid', n24);
  assert.equal(hybrid.idle.perMinute, 8, '24 clusters × health every 180 s');
  assert.equal(hybrid.idle.text, 'at least 8 a minute (health every 3 min × 24).');

  const bg = effectOf('background', n24);
  // health 1/3 + nodes 1/5 + ilm_errors 1/15 + policies 1/60 + ilm_assign 1/60 + snapshots 1/30
  // = 2/3 of a poll a minute per cluster; indices, shards and snapshots_full never on a schedule.
  assert.ok(Math.abs(bg.open.perMinute - 16) < 1e-9, String(bg.open.perMinute));
  assert.match(bg.open.text, /^at least 16 a minute \(6 datasets kept fresh for each of 24 clusters\)/);
  assert.match(bg.open.text, /indices, shards and full snapshot listings are fetched when a page asks/);
  // The core polls health only once nobody has asked for ten minutes (scheduler.rs idle()).
  assert.equal(bg.idle.perMinute, 8);
  assert.match(bg.idle.text, /^at least 8 a minute \(health every 3 min × 24\) once no page has asked for 10 min; at least 16 a minute until then\.$/);

  const auto = effectOf('auto', n24);
  assert.equal(auto.mode, 'background');
  assert.equal(auto.auto, true);
  assert.equal(auto.open.text, bg.open.text, 'Automatic with 24 clusters is Background');
  assert.match(auto.why, /with 24 it runs as Background/);
});

test('Automatic follows AUTO_HYBRID_ABOVE', () => {
  const at = effectOf('auto', { clusters: P.AUTO_HYBRID_ABOVE });
  const above = effectOf('auto', { clusters: P.AUTO_HYBRID_ABOVE + 1 });
  assert.equal(at.mode, 'background');
  assert.equal(above.mode, 'hybrid');
  assert.equal(above.idle.text, `at least ${Math.floor((P.AUTO_HYBRID_ABOVE + 1) / 3)} a minute (health every 3 min × ${P.AUTO_HYBRID_ABOVE + 1}).`);
});

test('the bound uses the policy\'s own intervals, is rounded down, and counts what the core really skips', () => {
  const p = P.normalisePolicy({ ...P.applyPreset(null, 'hybrid', D), intervalsSec: { ...D.intervalsSec, health: 240 } }, D);
  assert.equal(P.policyEffect(p, { clusters: 24 }).idle.text, 'at least 6 a minute (health every 4 min × 24).');
  assert.equal(P.policyEffect(p, { clusters: 10 }).idle.text, 'at least 2 a minute (health every 4 min × 10).', '2.5 is at least 2');
  // Below one a minute it says so per hour rather than "at least 0".
  assert.equal(effectOf('hybrid', { clusters: 1 }).idle.text, 'at least 20 an hour (health every 3 min × 1).');
  // A cluster that does not answer gets one probe every 2 min and nothing else.
  const down = effectOf('background', { clusters: 24, unreachable: 4 });
  assert.ok(Math.abs(down.open.perMinute - (20 * 2 / 3 + 4 * 0.5)) < 1e-9);
  assert.match(down.open.text, /^at least 15 a minute \(6 datasets kept fresh for each of 20 clusters, and a probe every 2 min × 4 not answering\)/);
  // Paused clusters get nothing; pause all stops everything.
  assert.equal(effectOf('hybrid', { clusters: 24, paused: 12 }).idle.perMinute, 4);
  const all = P.policyEffect(P.setPausedAll(P.applyPreset(null, 'background', D), true), { clusters: 24 });
  assert.equal(all.idle.perMinute, 0);
  assert.match(all.idle.text, /every cluster is paused/);
  assert.match(effectOf('background', { clusters: 0 }).idle.text, /no clusters/);
});

test('the classes agree with the core: catalogue.rs, scheduler.rs', () => {
  const cat = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/fleet/catalogue.rs'), 'utf8');
  const arm = /Dataset::(\w+(?:\s*\|\s*Dataset::\w+)*)\s*=>\s*Class::OnDemand/.exec(cat);
  assert.ok(arm, 'Dataset::class() has an OnDemand arm');
  const snake = (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const fromRs = arm[1].split('|').map((x) => snake(x.replace('Dataset::', '').trim())).sort();
  assert.deepEqual([...P.ON_DEMAND_ALWAYS].sort(), fromRs);
  assert.equal(Number(/pub const UNREACHABLE_PROBE_MS: u64 = ([\d_]+);/.exec(cat)[1].replace(/_/g, '')), P.UNREACHABLE_PROBE_SEC * 1000);
  const sch = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/fleet/scheduler.rs'), 'utf8');
  assert.equal(Number(/pub const IDLE_MS: u64 = (\d+) \* 60_000;/.exec(sch)[1]), P.IDLE_MINUTES);
  // effective_class: background keeps the class, hybrid only health, on-demand nothing.
  assert.equal(P.effectiveClass('indices', 'background', 3), 'onDemand');
  assert.equal(P.effectiveClass('nodes', 'background', 3), 'background');
  assert.equal(P.effectiveClass('health', 'hybrid', 3), 'background');
  assert.equal(P.effectiveClass('nodes', 'hybrid', 3), 'onDemand');
  assert.equal(P.effectiveClass('health', 'on-demand', 3), 'onDemand');
  assert.equal(P.effectiveClass('nodes', 'auto', P.AUTO_HYBRID_ABOVE + 1), 'onDemand');
});

test('the Fine-tune line, folded (change 16)', () => {
  assert.equal(P.fineTuneSummary(P.applyPreset(null, 'client', D), 24),
    'All clusters 4 · per cluster 1 · per jump host 6 · timeout 30 s · intervals only while a page watches');
  assert.equal(P.fineTuneSummary(P.applyPreset(null, 'hybrid', D), 24),
    'All clusters 16 · per cluster 2 · per jump host 6 · timeout 30 s · health every 3 min, the rest while a page watches');
  assert.equal(P.fineTuneSummary(P.applyPreset(null, 'auto', D), 24),
    'All clusters 16 · per cluster 2 · per jump host 6 · timeout 30 s · 6 datasets on a schedule, health every 3 min');
  assert.match(P.fineTuneSummary({ ...P.applyPreset(null, 'client', D), timeoutMs: 1500 }, 24), /timeout 1500 ms/);
  assert.equal(P.everyText(3600), '1 h');
  assert.equal(P.everyText(90), '90 s');
});

test('a pause says what is paused, since when and by whom — and an old pause with no stamp still reads', () => {
  const now = new Date(2026, 9, 28, 12, 0).getTime();
  const since = new Date(2026, 9, 25, 6, 38).getTime();
  const all = P.pausedLine({ all: true, since, by: 'Admin@zabbix' }, { now });
  assert.match(all, /^Requests to every cluster are paused since .*25.*2026.*, by Admin@zabbix\. Nothing new is fetched until an administrator resumes/);
  assert.match(P.pausedLine({ all: false, since: now - 60000, by: 'ops' }, { now }), /^Requests to this cluster are paused since .* today, by ops\./);
  assert.match(P.pausedLine({ all: true, since: 0, by: '' }, { now }), /^Requests to every cluster are paused\. Nothing new/);
  assert.equal(P.pauseFor(null, 'c1'), null);
  assert.equal(P.pauseFor({ pausedAll: false, paused: ['c2'] }, 'c1'), null);
  assert.deepEqual(P.pauseFor({ pausedAll: false, paused: ['c1'], pausedSince: 5, pausedBy: 'x' }, 'c1'), { all: false, since: 5, by: 'x' });
  assert.deepEqual(P.pauseFor({ pausedAll: true, paused: [] }, null), { all: true, since: 0, by: '' }, 'the fleet view: only a pause of everything');
});

test('only a change that begins pausing everything is asked about', () => {
  const on = P.setPausedAll(D, true);
  const off = P.setPausedAll(D, false);
  assert.equal(P.beginsPauseAll(off, on), true);
  assert.equal(P.beginsPauseAll(null, on), true, 'not knowing the current policy still asks');
  assert.equal(P.beginsPauseAll(on, on), false, 'already paused: saving another field does not ask again');
  assert.equal(P.beginsPauseAll(on, off), false, 'resuming is not asked about');
  assert.equal(P.beginsPauseAll(off, P.togglePaused(off, 'c1', true)), false, 'one cluster is not everything');
  assert.match(P.PAUSE_ALL_QUESTION.body, /until an administrator resumes/);
});
