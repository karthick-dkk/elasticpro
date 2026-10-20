/**
 * The bell: one notification per cluster per burst. Alerts raised for the same cluster
 * within the window are one entry ("<cluster>: N new alerts", a line each) that is updated
 * in place; another cluster, or the same one after the window, is another entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), dispatchEvent() {} };

const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const notify = await import(url('ui/js/core/notify.js'));
const st = await import(url('ui/js/core/state.js'));
const { DEFAULTS } = await import(url('ui/js/core/config.js'));
const labels = await import(url('ui/js/core/page-labels.js'));
const menu = await import(url('ui/js/ui/menu.js'));

const MIN = 60000;
const T0 = 1_800_000_000_000;
const said = [];
const spy = (msg, kind, ms, opts) => said.push({ msg, kind, ms, opts });
const run = (now) => notify.announceNewAlerts({ notify: spy, now });

const clusters = [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, name: `cluster-${n}`, url: `http://es${n}:9200`, enabled: true }));
const data = (over = {}) => ({ reachable: true, health: { status: 'green', unassigned_shards: 0 }, slm: [], repos: [], snapshots: {}, ...over });
const setData = (m) => { st.state.data = new Map(Object.entries(m)); };

import { beforeEach } from 'node:test';
beforeEach(() => {
  said.length = 0;
  st.state.defaults = { ...DEFAULTS };
  st.state.config = { clusters };
  st.state.selected = 'all';
  st.state.clients = new Map(clusters.map((c) => [c.id, { state: 'online' }]));
  setData(Object.fromEntries(clusters.map((c) => [c.id, data()])));
  notify.resetAnnounced();
  run(T0);                                   // the baseline pass
});

const down = (...ids) => setData(Object.fromEntries(clusters.map((c) => [c.id, ids.includes(c.id) ? { reachable: false } : data()])));

test('the window is two minutes', () => assert.equal(notify.BURST_WINDOW_MS, 2 * MIN));

test('three alerts on one cluster in one pass are one notification listing each', () => {
  setData({ ...Object.fromEntries(clusters.map((c) => [c.id, data()])),
    c1: data({ health: { status: 'yellow', unassigned_shards: 4 }, disk: { percent: 92, nodes: [] }, ilmErrorCount: 6, ilmErrors: { 'logs-1': {} } }) });
  const fresh = run(T0 + MIN);
  assert.equal(fresh.length, 3);
  assert.equal(said.length, 1, 'one notification, not three');
  assert.equal(said[0].msg, 'cluster-1: 3 new alerts');
  assert.equal(said[0].opts.cluster, 'c1');
  assert.equal(said[0].opts.detail.length, 3);
  assert.ok(said[0].opts.detail.some((l) => /Disk usage/.test(l)));
  assert.ok(said[0].opts.detail.some((l) => /health yellow/.test(l)));
  assert.ok(said[0].opts.detail.some((l) => /ILM/.test(l)));
  assert.equal(said[0].kind, 'err', 'a critical one makes it an error');
});

test('a later pass inside the window joins the same entry; after the window it is a new one', () => {
  setData({ ...Object.fromEntries(clusters.map((c) => [c.id, data()])), c1: data({ health: { status: 'yellow', unassigned_shards: 1 } }) });
  run(T0 + MIN);
  const key = said[0].opts.key;
  setData({ ...Object.fromEntries(clusters.map((c) => [c.id, data()])),
    c1: data({ health: { status: 'yellow', unassigned_shards: 1 }, ilmErrorCount: 2, ilmErrors: { a: {}, b: {} } }) });
  run(T0 + MIN + 90000);                      // 90 s after the burst began
  assert.equal(said.length, 2);
  assert.equal(said[1].opts.key, key, 'the same bell entry, updated');
  assert.equal(said[1].msg, 'cluster-1: 2 new alerts');
  assert.equal(said[1].opts.detail.length, 2);

  setData({ ...Object.fromEntries(clusters.map((c) => [c.id, data()])),
    c1: data({ health: { status: 'yellow', unassigned_shards: 1 }, ilmErrorCount: 2, ilmErrors: { a: {}, b: {} }, slmStatus: { operation_mode: 'STOPPED' } }) });
  run(T0 + MIN + 3 * MIN);                    // well after it
  assert.equal(said.length, 3);
  assert.notEqual(said[2].opts.key, key, 'a new burst is a new entry');
  assert.equal(said[2].msg, 'cluster-1: 1 new alert');
});

test('two clusters in one pass are two notifications', () => {
  down('c1', 'c2');
  run(T0 + MIN);
  assert.deepEqual(said.map((s) => s.msg).sort(), ['cluster-1: 1 new alert', 'cluster-2: 1 new alert']);
  assert.notEqual(said[0].opts.key, said[1].opts.key);
});

test('a dozen clusters at once: every cluster still gets its bell entry, the screen gets one line', () => {
  down('c1', 'c2', 'c3', 'c4', 'c5');
  run(T0 + MIN);
  const bell = said.filter((s) => s.opts.bellOnly);
  assert.equal(bell.length, 5);
  const card = said.filter((s) => !s.opts.bellOnly);
  assert.equal(card.length, 1);
  assert.match(card[0].msg, /^5 new alerts on 5 clusters, 5 critical$/);
  assert.equal(card[0].opts.noHistory, true, 'the summary card is not itself a bell entry');
});

test('an announced alert is not announced again on the next pass', () => {
  down('c1');
  run(T0 + MIN);
  said.length = 0;
  run(T0 + 2 * MIN);
  assert.equal(said.length, 0);
});

test('an acknowledged alert is not announced', async () => {
  const acks = await import(url('ui/js/core/acks.js'));
  await acks.acknowledgeItems('c1:unreachable', ['c1:unreachable']);
  down('c1');
  run(T0 + MIN);
  assert.equal(said.length, 0, 'acknowledged is how somebody says they have seen it');
  await acks.unacknowledge('c1:unreachable');
});

test('a second broken repository on a cluster that already has one says what is new on it', () => {
  const repos = (names) => ({ repos: names.map((n) => ({ name: n, error: 'gone' })), snapshots: {} });
  setData({ ...Object.fromEntries(clusters.map((c) => [c.id, data()])), c1: data(repos(['first'])) });
  notify.resetAnnounced(); run(T0 + MIN);           // first is already broken: the baseline
  said.length = 0;
  setData({ ...Object.fromEntries(clusters.map((c) => [c.id, data()])), c1: data(repos(['first', 'second'])) });
  const fresh = run(T0 + 2 * MIN);
  assert.equal(fresh.length, 1);
  assert.equal(said.length, 1);
  assert.equal(said[0].msg, 'cluster-1: 1 new alert');
  assert.match(said[0].opts.detail[0], /1 new — second/);
  assert.ok(!/first/.test(said[0].opts.detail[0]), 'what was already there is not repeated as news');
});

test('the bell entry carries links: the cluster\'s alerts, and the page for its worst alert', () => {
  labels.registerPages([{ id: 'alerts', label: 'Alerts' }, { id: 'overview', label: 'Clusters' }]);
  down('c1');
  run(T0 + MIN);
  const acts = notify.burstActions({ key: said[0].opts.key, cluster: 'c1' });
  assert.deepEqual(acts.map((a) => a.label), ['Open cluster-1 alerts →', 'Go to Clusters']);
  assert.deepEqual(acts.map((a) => a.page), ['alerts', 'overview']);
  // an entry that is not an alert burst has none; an old per-alert entry still renders as before
  assert.deepEqual(notify.burstActions({ key: 'alert:c1:unreachable', message: 'x' }), []);
  assert.deepEqual(notify.burstActions({ key: 'task-1' }), []);
  assert.deepEqual(notify.burstActions({ message: 'unkeyed' }), []);
});

test('the bell asks for the links through a hook, so it imports nothing about alerts', () => {
  assert.equal(typeof menu.setNotificationActions, 'function');
});

test('burstNotice: singular, plural and level', () => {
  const m = (level, title, count = '') => ({ level, title, count });
  const one = notify.burstNotice({ key: 'alerts:c1:1', clusterId: 'c1', alerts: new Map([['k', m('warning', 'Indices in an ILM error step', '6 indices')]]) }, 'prod');
  assert.deepEqual([one.message, one.kind, one.detail], ['prod: 1 new alert', 'warn', ['Indices in an ILM error step 6 indices']]);
});

test('bursts are keyed by cluster and start, and expire', () => {
  const open = new Map();
  const a = { clusterId: 'c1', key: 'c1:disk', level: 'warning', title: 'd', count: '' };
  const [b1] = notify.groupIntoBursts([a], T0, open);
  assert.equal(b1.key, `alerts:c1:${T0}`);
  const [b2] = notify.groupIntoBursts([{ ...a, key: 'c1:ilm' }], T0 + MIN, open);
  assert.equal(b2, b1);
  assert.equal(b2.alerts.size, 2);
  const [b3] = notify.groupIntoBursts([{ ...a, key: 'c1:health' }], T0 + 2 * MIN + 1, open);
  assert.notEqual(b3, b1);
  assert.equal(b3.key, `alerts:c1:${T0 + 2 * MIN + 1}`);
});
