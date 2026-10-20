/**
 * A cluster that cannot be reached is one problem, shown and counted once.
 *
 * Its other alerts were raised from data read before it went down. They are HELD: kept,
 * labelled not current, listed under the cluster's one Unreachable line, and counted
 * nowhere — not in the Alerts summary, the tab badge, the top bar or the bell. Nothing is
 * dropped silently, and nothing is listed twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const G = await import(url('ui/js/core/alert-groups.js'));
const st = await import(url('ui/js/core/state.js'));
const auto = await import(url('ui/js/core/automation.js'));
const notify = await import(url('ui/js/core/notify.js'));
const { DEFAULTS } = await import(url('ui/js/core/config.js'));

const C = (id, name = id) => ({ id, name, url: `http://${id}:9200` });
const cl = { g: C('g', 'Gamma-down'), z: C('z', 'zeta-down'), l: C('l', 'late-up-1'), a: C('a', 'atlas-prod'), b: C('b', 'bravo-ci') };
const alert = (c, key, level, extra = {}) => ({ key: `${c.id}:${key}`, level, cluster: c, title: `${c.name} ${key}`, detail: '', ...extra });
const ctx = (over = {}) => ({ now: Date.now(), defaults: { diskWarnPercent: 85, diskCritPercent: 90 }, data: () => null,
  ackFor: () => null, isAcked: () => false, silenced: () => false, ...over });

// Two unreachable clusters with older alerts, one unreachable with none, two that answer.
const raw = () => [
  alert(cl.z, 'unreachable', 'critical', { detail: 'Connection refused' }),
  alert(cl.z, 'ilm', 'warning'), alert(cl.z, 'health', 'warning'),
  alert(cl.g, 'unreachable', 'critical', { detail: 'Connection refused' }),
  alert(cl.g, 'disk', 'critical'),
  alert(cl.l, 'unreachable', 'critical', { detail: 'Connection refused' }),
  alert(cl.a, 'health', 'warning'), alert(cl.a, 'ilm', 'warning'),
  alert(cl.b, 'slm-mode', 'warning'),
];
const merged = () => G.holdUnreachable(G.mergeAlerts(raw(), ctx()));

test('every other alert on an unreachable cluster is held, and held alerts are not open', () => {
  const m = merged();
  const held = m.filter(G.isHeld).map((x) => x.key).sort();
  assert.deepEqual(held, ['g:disk', 'z:health', 'z:ilm']);
  for (const x of m.filter(G.isHeld)) {
    assert.equal(x.state, 'held');
    assert.equal(x.heldState, 'open', 'what it was before is kept');
    assert.equal(G.isOpen(x), false);
    assert.equal(G.isHandled(x), false, 'held is not a person\'s decision');
  }
  assert.ok(m.filter(G.isUnreachableAlert).every((x) => G.isOpen(x) && !G.isHeld(x)), 'the unreachable alert itself is open');
  assert.ok(m.filter((x) => !G.isHeld(x) && !G.isUnreachableAlert(x)).every((x) => x.clusterId === 'a' || x.clusterId === 'b'));
});

test('dedup: each alert is in exactly one place — the unreachable line, its held list, or a group below', () => {
  const m = merged();
  const { down, rest } = G.splitUnreachable(m);
  const placed = [...down.map((d) => d.alert.key), ...down.flatMap((d) => d.held.map((x) => x.key)), ...rest.map((x) => x.key)];
  assert.equal(new Set(placed).size, placed.length, 'no alert twice');
  assert.deepEqual([...placed].sort(), m.map((x) => x.key).sort(), 'no alert dropped');
  // A–Z, one entry per cluster, whatever order they were raised in.
  assert.deepEqual(down.map((d) => d.name), ['Gamma-down', 'late-up-1', 'zeta-down']);
  assert.deepEqual(down.map((d) => d.held.length), [1, 0, 2]);
  // Nothing of an unreachable cluster is among the groups below, in any grouping.
  assert.deepEqual(rest.map((x) => x.clusterId).sort(), ['a', 'a', 'b']);
  for (const mode of ['cluster', 'type', 'none']) {
    const groups = G.groupAlerts(G.filterAlerts(rest), mode);
    const keys = groups.flatMap((g) => g.alerts.map((x) => x.key));
    assert.ok(keys.every((k) => !/^(g|z|l):/.test(k)), `${mode}: an unreachable cluster is also a group below`);
    assert.ok(!groups.some((g) => g.family === 'unreachable'), `${mode}: no "Cluster unreachable" type group`);
  }
});

test('counts: an unreachable cluster counts once, as critical; held alerts count nowhere', () => {
  const s = G.summaryOf(merged(), 5);
  // critical: 3 unreachable (not Gamma's held critical disk). warning: atlas 2 + bravo 1 (not zeta's 2 held).
  assert.deepEqual([s.critical, s.warning, s.open], [3, 3, 6]);
  assert.equal(s.held, 3);
  assert.deepEqual([s.clustersAffected, s.fleet, s.clustersClear], [5, 5, 0], 'an unreachable cluster is affected, once');
  assert.deepEqual([s.acknowledged, s.silenced], [0, 0]);
});

test('held alerts follow the cluster: acknowledging the unreachable alert does not release them', () => {
  const rec = { 'z:unreachable': { acked: true } };
  const m = G.holdUnreachable(G.mergeAlerts(raw(), ctx({ ackFor: (k) => rec[k] || null, isAcked: (k) => !!rec[k] })));
  const z = m.filter((x) => x.clusterId === 'z');
  assert.equal(z.find(G.isUnreachableAlert).state, 'acked');
  assert.equal(z.filter(G.isHeld).length, 2, 'still held — the cluster is still down');
  const s = G.summaryOf(m, 5);
  assert.deepEqual([s.critical, s.acknowledged, s.held], [2, 1, 3]);
  const { down } = G.splitUnreachable(m);
  assert.equal(G.filterDown(down).length, 2, 'hidden with the acknowledged ones');
  assert.equal(G.filterDown(down, { showHandled: true }).length, 3);
});

test('filters decide an unreachable line by its own alert; held alerts are never listed as rows', () => {
  const m = merged();
  const { down } = G.splitUnreachable(m);
  assert.equal(G.filterDown(down, { level: 'critical' }).length, 3);
  assert.equal(G.filterDown(down, { level: 'warning' }).length, 0, 'an unreachable cluster is critical');
  assert.deepEqual(G.filterDown(down, { text: 'GAMMA' }).map((d) => d.name), ['Gamma-down']);
  assert.equal(G.filterAlerts(m, { showHandled: true }).some(G.isHeld), false);
});

test('no unreachable alert, nothing held: the list is returned as it was', () => {
  const m = G.mergeAlerts([alert(cl.a, 'health', 'warning')], ctx());
  assert.equal(G.holdUnreachable(m), m);
  assert.deepEqual(G.splitUnreachable(m).down, []);
});

test('the words: how long down, why, and what is held', () => {
  assert.equal(G.downFor(20000), 'under a minute');
  assert.equal(G.downFor(12 * 60000), '12 min');
  assert.equal(G.downFor(100 * 60000), '1 h 40 min');
  assert.equal(G.downFor(26 * 3600000), '1 d 2 h');
  assert.equal(G.heldText(0), 'no other alerts');
  assert.equal(G.heldText(1), '1 older alert held, not current');
  assert.equal(G.heldText(2), '2 older alerts held, not current');
  assert.deepEqual(G.unreachableReason({ state: 'tls_error' }), { label: 'Certificate', cls: 'yellow' });
  assert.deepEqual(G.unreachableReason({ state: 'offline' }), { label: 'Offline', cls: 'red' });
});

/* ---- through the real pipeline: state.js mergedAlerts, the one list every count reads ---- */

test('state: an automation alert raised before the cluster went down is held, and in no count', async () => {
  const idx = (n) => ({ index: n, day: n.slice(-10).replace(/\./g, '-'), size: 1, docs: 1, health: 'green', status: 'open' });
  st.state.defaults = { ...DEFAULTS };
  st.state.config = { clusters: [{ id: 'g', name: 'Gamma-down', url: 'http://g:9200', enabled: true }, { id: 'a', name: 'atlas-prod', url: 'http://a:9200', enabled: true }],
    raw: { automations: [{ id: 'old', name: 'Old logs', enabled: true, clusters: ['*'], when: [],
      match: { conditions: [{ field: 'day', op: 'olderThan', value: '30d' }], all: true },
      scope: { kind: 'all' }, trigger: { when: 'any', count: 1 }, action: 'notify', notify: { alert: true, level: 'warning', webhook: '' } }] } };
  st.state.selected = 'all';
  st.state.clients = new Map([['g', { state: 'online' }], ['a', { state: 'online' }]]);
  const up = () => ({ reachable: true, updatedAt: Date.now(), health: { status: 'green', unassigned_shards: 0 }, slm: [], repos: [], snapshots: {} });
  st.state.data = new Map([['g', up()], ['a', up()]]);
  st.state.indices = new Map([['g', [idx('logs-2020.01.01')]], ['a', [idx('logs-2020.01.01')]]]);
  await auto.runAutomation();
  st.invalidateAlerts();
  const before = st.openAlertsNow().map((m) => m.key).sort();
  assert.deepEqual(before, ['a:automation', 'g:automation'], `both clusters raise the automation alert, saw ${before}`);

  // Gamma goes down: its automation alert stays in the results, but the cluster is now one problem.
  st.state.data.set('g', { reachable: false, updatedAt: Date.now() });
  st.invalidateAlerts();
  const all = st.mergedAlerts();
  const g = all.filter((m) => m.clusterId === 'g');
  assert.deepEqual(g.map((m) => [m.family, m.state]).sort(), [['automation', 'held'], ['unreachable', 'open']]);
  assert.deepEqual(st.openAlertsNow().map((m) => m.key).sort(), ['a:automation', 'g:unreachable'], 'the held alert is in no count');
  assert.deepEqual(st.openAlertCounts(), { total: 2, critical: 1, warning: 1 });
  auto.clearAutomation();
});

test('the bell: one entry for an unreachable cluster, none for the alerts held behind it', () => {
  const said = [];
  const spy = (msg, kind, ms, opts) => said.push({ msg, opts });
  const pass = (list) => notify.announceNewAlerts({ notify: spy, list });
  notify.resetAnnounced();
  pass(G.holdUnreachable(G.mergeAlerts([alert(cl.a, 'health', 'warning')], ctx())));       // the baseline
  // zeta goes down with two alerts raised before it did; they arrive in the same pass.
  const next = G.holdUnreachable(G.mergeAlerts([alert(cl.a, 'health', 'warning'),
    alert(cl.z, 'unreachable', 'critical'), alert(cl.z, 'ilm', 'warning'), alert(cl.z, 'health', 'warning')], ctx()));
  const fresh = pass(next);
  assert.deepEqual(fresh.map((m) => m.key), ['z:unreachable'], 'only the unreachable alert is news');
  assert.equal(said.length, 1, 'one entry for the cluster');
  assert.match(said[0].msg, /: 1 new alert$/, 'and it does not count the held ones');
  notify.resetAnnounced();
});
