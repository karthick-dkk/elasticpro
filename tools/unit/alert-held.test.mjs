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
  assert.equal(H.readingTime('repo', { snapshots: NOW - MIN, policies: NOW - 2 * MIN }), NOW - 2 * MIN);
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
  assert.deepEqual(S.openAlertCounts(), { total: 1, critical: 1, high: 0, warning: 0 }, 'the disk critical is not counted');
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

test('the bell: a page opened mid-outage announces the held alert when it is current and still true', () => {
  const said = [];
  const spy = (msg) => said.push(msg);
  const pass = () => notify.announceNewAlerts({ notify: spy, now: Date.now() });
  notify.resetAnnounced();
  applyFleetEntry('c1', cluster({ age: MIN, down: true }));   // down before this page opened
  pass();                                                     // the first pass: nothing is news
  for (let i = 0; i < 3; i++) pass();
  assert.deepEqual(said, [], 'held alerts are never news while held');
  const back = cluster({ age: 0 });
  back.datasets.health.data.health = ans({ status: 'green', number_of_nodes: 1, unassigned_shards: 0 });
  applyFleetEntry('c1', back);
  const fresh = pass();
  assert.deepEqual(fresh.map((m) => m.family), ['disk'], 'nobody was shown it: announced once it is current');
  assert.equal(said.length, 1);
  notify.resetAnnounced();
});

test('the bell: a held alert that appears only during the outage (a threshold moved) is announced on return', () => {
  const said = [];
  const pass = () => notify.announceNewAlerts({ notify: (m) => said.push(m), now: Date.now() });
  notify.resetAnnounced();
  state.defaults = { ...DEFAULTS, diskWarnPercent: 98, diskCritPercent: 99 };   // 95 %: no disk alert, hysteresis included
  applyFleetEntry('c1', cluster({ age: MIN }));
  pass();
  assert.ok(!S.openAlertsNow().some((m) => m.family === 'disk'));
  applyFleetEntry('c1', cluster({ age: MIN, down: true }));
  pass();
  state.defaults = { ...DEFAULTS };                                              // moved while it is down
  S.invalidateAlerts();
  pass(); pass();
  assert.ok(S.mergedAlerts({ fresh: true }).some((m) => m.family === 'disk' && G.isHeld(m)), 'held under the new threshold');
  said.length = 0;
  applyFleetEntry('c1', cluster({ age: 0 }));
  assert.ok(pass().some((m) => m.family === 'disk'), 'never shown before: announced when current');
  notify.resetAnnounced();
});

test('direct mode: a failing refresh of a down cluster does not rewrite what is held', async () => {
  setFleetMode('direct');
  const refused = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { res: { ok: false, kind: 'connect' } }));
  const c = { id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true };
  state.clients.set('c1', { c, state: 'online', root: refused, health: refused, snapshots: refused, snapshotsCat: refused });
  const bad = (id, h) => ({ id, status: 'FAILED', start: NOW - h * HOUR, end: NOW - h * HOUR + MIN });
  state.data.set('c1', { id: 'c1', reachable: true, updatedAt: NOW - 10 * MIN, health: { status: 'green', unassigned_shards: 0 },
    repos: [{ name: 'daily', type: 'fs', settings: {} }], snapshots: { daily: [bad('s2', 1), bad('s1', 25)] }, slm: [], nodes: [] });
  await S.fetchOverview('c1');                     // the cluster refuses: down, and the listing fails
  const d = state.data.get('c1');
  assert.equal(d.reachable, false);
  assert.ok(d.repos[0].error, 'the live entry says the listing failed');
  const held = S.mergedAlerts({ fresh: true }).filter(G.isHeld);
  assert.deepEqual(held.map((m) => m.keys.join()), ['c1:repo:daily:failing'], 'the held repository alert is what was true, not the outage');
  assert.equal(held[0].asOf, NOW - 10 * MIN);
  assert.equal(S.heldDataFor('c1').snapshots.daily.length, 2, 'the held copy kept its listing');
  setFleetMode('fleet');
});

test('a fallback blip: answering again through the fleet cache keeps nothing frozen', async () => {
  applyFleetEntry('c1', cluster({ age: 0 }));                                    // up, disk 95 %
  setFleetMode('direct');                                                       // a worker_error: direct for a moment
  const refused = () => Promise.reject(new Error('connect ECONNREFUSED'));
  state.clients.set('c1', { c: { id: 'c1', name: 'prod' }, state: 'online', _track() {}, root: refused, health: refused, snapshots: refused, snapshotsCat: refused });
  await S.fetchOverview('c1');
  assert.ok(S.heldDataFor('c1'), 'down: the last good data is held');
  setFleetMode('fleet');
  const back = cluster({ age: 0 });
  back.datasets.nodes.data.alloc = ans([{ node: 'n1', 'disk.used': '850', 'disk.avail': '150', 'disk.total': '1000', 'disk.indices': '800', shards: '10' }]);
  applyFleetEntry('c1', back);                                                  // answers via the cache: 85 %
  assert.equal(S.heldDataFor('c1'), null, 'not down: nothing held is offered');
  const disk = S.mergedAlerts({ fresh: true }).find((m) => m.family === 'disk');
  assert.deepEqual(disk.items.map((i) => i.value), ['85%'], 'the items are from the live reading, not the frozen one');
  S.heldAlerts();
  setFleetMode('direct');
  state.data.set('c1', { reachable: false, updatedAt: NOW });
  assert.equal(S.heldDataFor('c1'), null, 'and the frozen copy was dropped once it answered');
  setFleetMode('fleet');
});

test('a rule is as old as the oldest thing it reads (RULE_READS)', () => {
  const at = { health: NOW - 1 * MIN, nodes: NOW - 2 * MIN, policies: NOW - 3 * MIN, ilm_errors: NOW - 4 * MIN, snapshots: NOW - 5 * MIN };
  assert.equal(H.readingTime('disk-unaccounted', at), null, 'the index list was never read: unknown');
  assert.equal(H.readingTime('disk-unaccounted', { ...at, indices: NOW - 3 * HOUR }), NOW - 3 * HOUR, 'dated by the index list');
  assert.equal(H.readingTime('disk-balance', at), NOW - 3 * MIN, 'nodes and the watermarks from policies');
  assert.equal(H.readingTime('master-changed', at), NOW - 2 * MIN, 'nodes and health');
  assert.equal(H.readingTime('ilm', at), NOW - 4 * MIN, 'ilm_errors and ILM mode from policies');
  assert.equal(H.readingTime('repo', at), NOW - 5 * MIN, 'snapshots and the repository list');
  assert.equal(H.readingTime('repo', { snapshots: NOW }), null, 'repository list unknown: unknown');
  assert.ok(!H.HELD_DATASETS.includes('indices'), 'the index list is dated by its own read, not from the fleet cache');
});

test('Zabbix: a cluster no longer configured is sent every rule clear once, then forgotten', () => {
  const { clear, keep } = Z.alertHostsToClear({ c1: 'host-1', gone: 'host-gone', off: 'host-off' }, ['c1', 'c2']);
  assert.deepEqual(clear, [{ id: 'gone', host: 'host-gone' }, { id: 'off', host: 'host-off' }]);
  assert.deepEqual(keep, { c1: 'host-1' }, 'still configured — down or not — stays remembered and is not cleared');
  const cleared = Z.zabbixAlertsCleared();
  assert.deepEqual(Object.keys(cleared), Z.ZABBIX_ALERT_RULES);
  assert.ok(Object.values(cleared).every((v) => v.level === 0 && v.detail === ''));
  assert.deepEqual(Z.alertHostsToClear(undefined, ['c1']), { clear: [], keep: {} }, 'nothing remembered: nothing to clear');
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

test('Play: seen open before the outage, held through it — no second takeover on the way back', () => {
  let t = E.takeover(null, { open: ['a:health', 'b:disk'], now: 0 });   // b's disk already on screen
  // b goes down: its disk alert is held, never taking the screen.
  t = E.takeover(t, { open: ['a:health', 'b:unreachable'], held: ['b:disk'], now: 1000 });
  assert.equal(t.active && t.active.key, 'b:unreachable', 'the outage itself is news');
  for (let i = 0; i < 5; i++) t = E.takeover(t, { open: ['a:health'], held: ['b:disk'], now: E.TAKEOVER_MS + 3000 + i });
  assert.ok(t.seen.has('b:disk'), 'remembered while held');
  t = E.takeover(t, { open: ['a:health', 'b:disk'], now: E.TAKEOVER_MS + 9000 });
  assert.equal(t.active, null, 'b answers with the disk still critical: shown before the outage, no takeover');
});

test('Play: a display switched on mid-outage was never shown the held alert — it takes over when current', () => {
  // The first look: b is down, its disk held. Held keys are never added to what was seen.
  let t = E.takeover(null, { open: ['b:unreachable'], held: ['b:disk'], now: 0 });
  assert.ok(!t.seen.has('b:disk'));
  for (let i = 1; i < 4; i++) t = E.takeover(t, { open: ['b:unreachable'], held: ['b:disk'], now: i });
  assert.equal(t.active, null, 'held never takes the screen');
  assert.ok(!t.seen.has('b:disk'), 'not added while held either');
  t = E.takeover(t, { open: ['b:disk'], now: 10 });
  assert.equal(t.active && t.active.key, 'b:disk', 'current now, and nobody saw it: it takes the screen');
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
