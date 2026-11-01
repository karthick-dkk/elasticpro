/**
 * Held alerts from cached data: what was wrong with a cluster when it was last reachable.
 *
 * When a cluster stops answering, its alert rules are evaluated against its newest CACHED
 * datasets (the fleet cache keeps the last good answers and their fetchedAt when a fetch
 * fails) — nothing is fetched. What they raise is held under the cluster's unreachable line,
 * each "as of" the data it rests on, and counted nowhere: not the bell, the tab, the top bar,
 * the summary, Play's takeover, or the values sent to Zabbix. A rule whose data is missing or
 * older than HELD_MAX_AGE_MS says nothing. When the cluster answers, what still applies is
 * current again through the normal path — not announced a second time — and the rest is gone.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const H = await import(url('ui/js/core/alert-held.js'));
const G = await import(url('ui/js/core/alert-groups.js'));
const S = await import(url('ui/js/core/state.js'));
const Z = await import(url('ui/js/core/zabbix-alerts.js'));
const E = await import(url('ui/js/play/engine.js'));
const notify = await import(url('ui/js/core/notify.js'));
const { DEFAULTS } = await import(url('ui/js/core/config.js'));
const { state, fleet, applyFleetEntry, setFleetMode } = S;

const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/* --------------------------------- the pure part --------------------------------- */

test('a rule is dated by the dataset it reads; unknown or too old says nothing', () => {
  const at = { health: NOW - 10 * MIN, nodes: NOW - 12 * MIN, policies: NOW - 30 * HOUR };
  const a = (key) => ({ key: `c1:${key}`, level: 'warning', title: key });
  const out = H.stampHeld([a('health'), a('disk'), a('slm-fail:nightly'), a('ilm'), a('volume:f:t'), a('log-delay')],
    { at, now: NOW, delayAt: NOW - 20 * MIN });
  assert.deepEqual(out.map((x) => [x.key, x.asOf]), [
    ['c1:health', NOW - 10 * MIN],
    ['c1:disk', NOW - 12 * MIN],
    ['c1:log-delay', NOW - 20 * MIN],
  ], 'policies is older than a day, ilm_errors was never read, a volume spike has no date: all three say nothing');
  assert.ok(out.every((x) => x.cached === true));
  assert.equal(H.HELD_MAX_AGE_MS, 24 * HOUR);
  assert.equal(H.evaluatedAt(at), NOW - 10 * MIN, 'evaluated as of the newest reading — when it was last read');
  assert.equal(H.evaluatedAt({}), null);
  assert.equal(H.readingTime('repo', { snapshots: NOW - MIN }), NOW - MIN);
  assert.equal(H.readingTime('log-delay', {}, null), null);
});

test('the held line: count, not current, and as of the OLDEST reading', () => {
  const clock = (t) => `T${(NOW - t) / MIN}`;
  assert.equal(G.heldLine([], clock), 'no other alerts');
  assert.equal(G.heldLine([{ asOf: NOW - 5 * MIN }, { asOf: NOW - 9 * MIN }], clock), '2 older alerts held, not current · as of T9');
  assert.equal(G.heldLine([{ asOf: null }], clock), '1 older alert held, not current', 'no date, no "as of"');
});

test('merged: a cached alert carries its as-of and is held even with no unreachable line beside it', () => {
  const c = { id: 'c1', name: 'prod' };
  const merged = G.holdUnreachable(G.mergeAlerts([
    { key: 'c1:disk', level: 'critical', cluster: c, title: 'disk', cached: true, asOf: NOW - 7 * MIN },
  ], { now: NOW, defaults: {}, data: () => null }));
  assert.equal(merged[0].asOf, NOW - 7 * MIN);
  assert.equal(merged[0].state, 'held');
  assert.equal(G.isOpen(merged[0]), false);
});

/* ------------------------- through the fleet cache and state.js ------------------------- */

const ans = (json) => ({ ok: true, status: 200, kind: 'ok', message: '', json, tookMs: 5 });
const entry = (data, extra = {}) => ({
  status: 'ok', fetchedAt: NOW - MIN, attemptedAt: NOW - MIN, nextDue: NOW + MIN, tookMs: 40,
  staleAfterMs: 360000, seq: 1, error: null, data, ...extra,
});
const ROOT_BODY = { name: 'n1', cluster_name: 'prod', version: { number: '8.13.0' } };
const HEALTH_BODY = { status: 'yellow', number_of_nodes: 1, unassigned_shards: 3 };
const NODES_BODY = [{ name: 'n1', master: '*', jdk: '21', 'heap.percent': '40' }];
// 95 % full: the disk rule says critical.
const ALLOC_BODY = [{ node: 'n1', 'disk.used': '950', 'disk.avail': '50', 'disk.total': '1000', 'disk.indices': '900', shards: '10' }];

/** Every background dataset, `age` ms old; `down` makes the last health check fail (the core keeps the body). */
function cluster({ age = 10 * MIN, down = false } = {}) {
  const at = NOW - age;
  const health = entry({ root: ans(ROOT_BODY), health: ans(HEALTH_BODY) }, { fetchedAt: at,
    ...(down ? { status: 'error', attemptedAt: NOW - MIN, error: { ok: false, kind: 'connect', message: 'connection refused' } } : {}) });
  return {
    reach: down
      ? { state: 'unreachable', since: NOW - 5 * MIN, lastError: { kind: 'connect', message: 'connection refused' }, nextProbeAt: NOW + MIN, failures: 3, seq: 2 }
      : { state: 'reachable', since: NOW - HOUR, lastError: null, nextProbeAt: null, failures: 0, seq: 1 },
    datasets: {
      health,
      nodes: entry({ nodes: ans(NODES_BODY), alloc: ans(ALLOC_BODY) }, { fetchedAt: at }),
      ilm_errors: entry({ ilmErr: ans({ indices: {} }) }, { fetchedAt: at }),
      policies: entry({
        repos: ans({}), slm: ans({}), slmStatus: ans({ operation_mode: 'RUNNING' }),
        ilm: ans({ operation_mode: 'RUNNING' }), ilmPolicies: ans({}), repoPaths: ans({ nodes: {} }),
        clusterSettings: ans({ persistent: {} }),
      }, { fetchedAt: at }),
      ilm_assign: entry({ ilmOfIndices: ans({}) }, { fetchedAt: at }),
    },
  };
}

beforeEach(() => {
  state.data.clear(); state.clients.clear(); state.indices.clear();
  fleet.raw.clear();
  fleet.skew = 0;
  setFleetMode('fleet');
  state.defaults = { ...DEFAULTS };
  state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }], raw: {} };
  S.invalidateAlerts();
});

const families = (list) => list.map((m) => m.family).sort();

test('down with a fresh cache: the rules run on the cached data, held under the line, as of its time', () => {
  applyFleetEntry('c1', cluster({ age: 10 * MIN, down: true }));
  assert.equal(state.data.get('c1').reachable, false, 'the cluster itself reads as down');
  assert.deepEqual(S.alerts().map((a) => a.key), ['c1:unreachable'], 'alerts() stays what is true now');

  const all = S.mergedAlerts({ fresh: true });
  const held = all.filter(G.isHeld);
  assert.deepEqual(families(held), ['disk', 'health']);
  for (const m of held) {
    assert.equal(m.asOf, NOW - 10 * MIN, `${m.family} is as of the cached reading`);
    assert.equal(m.state, 'held');
    assert.equal(m.heldState, 'open');
  }
  // Disk per node, from the cached data the alert was raised from.
  assert.deepEqual(held.find((m) => m.family === 'disk').items.map((i) => [i.label, i.value]), [['n1', '95%']]);
  const { down, rest } = G.splitUnreachable(all);
  assert.equal(down.length, 1);
  assert.equal(down[0].held.length, 2);
  assert.deepEqual(rest, []);
  assert.match(G.heldLine(down[0].held), /^2 older alerts held, not current · as of \d\d:\d\d$/);
});

test('held alerts count nowhere: open counts, the summary, Zabbix', () => {
  applyFleetEntry('c1', cluster({ down: true }));
  S.invalidateAlerts();
  assert.deepEqual(S.openAlertsNow().map((m) => m.key), ['c1:unreachable']);
  assert.deepEqual(S.openAlertCounts(), { total: 1, critical: 1, warning: 0 }, 'the disk critical is not counted');
  const sum = G.summaryOf(S.mergedAlerts(), 1);
  assert.deepEqual([sum.critical, sum.warning, sum.open, sum.held], [1, 0, 1, 2]);
  // Zabbix: nothing is sent for a cluster that did not answer, and a held alert is never a value.
  assert.equal(Z.zabbixAlertsToSend(false, S.alerts()), null);
  const asCurrent = Z.zabbixAlertValues(S.heldAlerts());
  assert.ok(Object.values(asCurrent).every((v) => v.level === 0 && v.detail === ''), 'held alerts are never sent as current');
});

test('a cache older than the limit holds nothing — unknown, not clear', () => {
  applyFleetEntry('c1', cluster({ age: H.HELD_MAX_AGE_MS + MIN, down: true }));
  const all = S.mergedAlerts({ fresh: true });
  assert.deepEqual(all.map((m) => m.family), ['unreachable']);
  assert.deepEqual(S.heldAlerts(), []);
});

test('never read before it went down: nothing to hold', () => {
  const cs = cluster({ down: true });
  for (const n of Object.keys(cs.datasets)) if (n !== 'health') delete cs.datasets[n];
  cs.datasets.health = entry(null, { status: 'error', fetchedAt: null, error: { ok: false, kind: 'connect', message: 'refused' } });
  applyFleetEntry('c1', cs);
  assert.deepEqual(S.mergedAlerts({ fresh: true }).map((m) => m.family), ['unreachable']);
});

test('the cluster answers again: still true is current, not announced again; cleared is gone', () => {
  const said = [];
  const spy = (msg, kind, ms, opts) => said.push({ msg, opts });
  const pass = () => notify.announceNewAlerts({ notify: spy, now: Date.now() });
  notify.resetAnnounced();

  applyFleetEntry('c1', cluster({ age: MIN }));            // up, disk critical and health yellow
  pass();                                                   // the baseline: what is already wrong
  assert.deepEqual(families(S.openAlertsNow()), ['disk', 'health']);

  applyFleetEntry('c1', cluster({ age: MIN, down: true })); // down for several passes
  for (let i = 0; i < 5; i++) pass();
  assert.deepEqual(said.map((x) => x.msg), ['prod: 1 new alert'], 'only the unreachable alert is news');
  assert.deepEqual(families(S.mergedAlerts({ fresh: true }).filter(G.isHeld)), ['disk', 'health']);

  // Back, with the disk still full and health now green.
  const back = cluster({ age: 0 });
  back.datasets.health.data.health = ans({ status: 'green', number_of_nodes: 1, unassigned_shards: 0 });
  applyFleetEntry('c1', back);
  const fresh = pass();
  assert.deepEqual(fresh, [], 'the disk alert was raised before the outage: not announced again');
  assert.equal(said.length, 1);
  const now = S.mergedAlerts({ fresh: true });
  assert.deepEqual(now.map((m) => [m.family, m.state]), [['disk', 'open']], 'one current disk alert, no duplicate; health gone');
  assert.equal(now[0].held, undefined);
  assert.equal(now[0].asOf, null, 'current again: no "as of"');
  notify.resetAnnounced();
});

test('acknowledging a held alert carries over when the cluster answers', () => {
  const c = { id: 'c1', name: 'prod' };
  const rec = { 'c1:disk': { acked: true, ackedBy: 'asha', ackedItems: ['c1:disk'] } };
  const ctx = { now: NOW, defaults: {}, data: () => null, ackFor: (k) => rec[k] || null, isAcked: (k) => !!rec[k] };
  const down = G.holdUnreachable(G.mergeAlerts([
    { key: 'c1:unreachable', level: 'critical', cluster: c, title: 'prod unreachable' },
    { key: 'c1:disk', level: 'critical', cluster: c, title: 'disk', cached: true, asOf: NOW - MIN },
  ], ctx));
  const h = down.find((m) => m.family === 'disk');
  assert.deepEqual([h.state, h.heldState, h.ackedBy], ['held', 'acked', 'asha'], 'acknowledged while held, still held');
  const up = G.holdUnreachable(G.mergeAlerts([{ key: 'c1:disk', level: 'critical', cluster: c, title: 'disk' }], ctx));
  assert.equal(up[0].state, 'acked', 'the same key: the acknowledgement covers it when it is current');
});

test('Play: a held alert never takes the screen, and does not take it on the way back either', () => {
  let t = E.takeover(null, { open: ['a:health'], now: 0 });
  // b goes down with a critical disk alert: held, not open.
  t = E.takeover(t, { open: ['a:health', 'b:unreachable'], held: ['b:disk'], now: 1000 });
  assert.equal(t.active && t.active.key, 'b:unreachable', 'the outage itself is news');
  t = E.takeover(t, { open: ['a:health'], held: ['b:disk'], now: E.TAKEOVER_MS + 2000 });
  for (let i = 0; i < 5; i++) t = E.takeover(t, { open: ['a:health'], held: ['b:disk'], now: E.TAKEOVER_MS + 3000 + i });
  assert.ok(t.seen.has('b:disk'), 'remembered while held');
  t = E.takeover(t, { open: ['a:health', 'b:disk'], now: E.TAKEOVER_MS + 9000 });
  assert.equal(t.active, null, 'b answers with the disk still critical: raised before the outage, no takeover');
});

test('memory: one cached copy per cluster that is down, none once it answers', () => {
  applyFleetEntry('c1', cluster({ down: true }));
  S.heldAlerts();
  assert.ok(S.heldDataFor('c1'), 'held while down');
  const a = S.heldDataFor('c1');
  S.heldAlerts();
  assert.equal(S.heldDataFor('c1'), a, 'not rebuilt while the cached readings are the same');
  applyFleetEntry('c1', cluster({ age: 0 }));
  S.heldAlerts();
  assert.equal(S.heldDataFor('c1'), null, 'dropped once it answers');
});
