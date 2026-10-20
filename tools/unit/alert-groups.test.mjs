/**
 * Alerts merged and grouped for the Alerts page: one alert per cluster and rule, the worst
 * level and the oldest age winning, an acknowledgement that does not hide a newcomer, and
 * groups ordered by worst severity, then how many alerts, then name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const G = await import(url('ui/js/core/alert-groups.js'));
const { compareNames } = await import(url('ui/js/lib/cluster-order.js'));

const C = (id, name = id) => ({ id, name, url: `http://${id}:9200` });
const clusters = { a: C('a', 'atlas-prod'), k: C('k', 'kestrel-dc'), r: C('r', 'raven-onprem'), b: C('b', 'bravo-ci') };
const alert = (c, key, level, extra = {}) => ({ key: `${c.id}:${key}`, level, cluster: c, title: `${c.name} ${key}`, detail: '', ...extra });

const NOW = Date.parse('2026-10-20T12:00:00Z');
const MIN = 60000;

const nodes = (rows) => ({ disk: { percent: 90, nodes: rows.map(([node, pct]) => ({ node, 'disk.used': String(pct), 'disk.total': '100' })) } });
const ctxFor = (over = {}) => ({
  now: NOW,
  defaults: { diskWarnPercent: 85, diskCritPercent: 90 },
  data: () => null,
  ackFor: () => null, isAcked: () => false, silenced: () => false,
  ...over,
});

test('same cluster and same rule is one alert; another cluster or rule is another', () => {
  const list = [
    alert(clusters.a, 'slm-fail:daily', 'critical'), alert(clusters.a, 'slm-fail:weekly', 'critical'),
    alert(clusters.a, 'health', 'warning'), alert(clusters.k, 'slm-fail:daily', 'critical'),
  ];
  const merged = G.mergeAlerts(list, ctxFor());
  assert.deepEqual(merged.map((m) => m.key).sort(), ['a:health', 'a:slm-fail', 'k:slm-fail']);
  const slm = merged.find((m) => m.key === 'a:slm-fail');
  assert.equal(slm.items.length, 2);
  assert.deepEqual(slm.items.map((i) => i.label).sort(), ['daily', 'weekly']);
  assert.deepEqual(slm.keys.sort(), ['a:slm-fail:daily', 'a:slm-fail:weekly']);
  assert.equal(slm.count, '2 policies');
});

test('the merged level is the worst item, and its age the oldest', () => {
  const list = [
    alert(clusters.a, 'slm-stale:daily', 'warning'),
    alert(clusters.a, 'slm-stale:weekly', 'critical'),
  ];
  const firstSeen = { 'a:slm-stale:daily': NOW - 5 * 3600000, 'a:slm-stale:weekly': NOW - 2 * 3600000 };
  const [m] = G.mergeAlerts(list, ctxFor({ itemFirstSeen: (k, id) => firstSeen[id] }));
  assert.equal(m.level, 'critical');
  assert.equal(m.since, NOW - 5 * 3600000);
  assert.equal(G.ageShort(NOW - m.since), '5 h');
  // the items are listed worst first, then oldest
  assert.deepEqual(m.items.map((i) => i.label), ['weekly', 'daily']);
});

test('a snapshot failing since a known time beats the first sighting', () => {
  const [m] = G.mergeAlerts([alert(clusters.a, 'repo:s3:failing', 'critical', { failingSince: NOW - 26 * 3600000, repo: 's3' })],
    ctxFor({ itemFirstSeen: () => NOW - 10 * MIN, startOf: () => NOW - 10 * MIN }));
  assert.equal(m.since, NOW - 26 * 3600000);
  assert.equal(m.approxSince, false);
});

test('disk across nodes lists each node over the warning line, with its own level', () => {
  const a = alert(clusters.a, 'disk', 'critical', { diskPercent: 90 });
  const data = nodes([['es-hot-1', 92], ['es-hot-2', 88], ['es-hot-3', 86], ['es-warm-1', 40]]);
  const [m] = G.mergeAlerts([a], ctxFor({ data: () => data }));
  assert.deepEqual(m.items.map((i) => [i.label, i.value, i.level]),
    [['es-hot-1', '92%', 'critical'], ['es-hot-2', '88%', 'warning'], ['es-hot-3', '86%', 'warning']]);
  assert.equal(m.count, 'on 3 nodes');
  assert.equal(m.title, 'Disk usage above 85%');
  assert.equal(m.level, 'critical');
  assert.match(m.detail, /es-hot-1 92% · es-hot-2 88% · es-hot-3 86%/);
});

test('without per-node figures the disk alert is one item and says so, not a guess at nodes', () => {
  const [m] = G.mergeAlerts([alert(clusters.a, 'disk', 'warning', { diskPercent: 86.4 })], ctxFor());
  assert.deepEqual(m.items.map((i) => [i.label, i.value]), [['cluster average', '86.4%']]);
  assert.equal(m.count, '');
});

test('a node-level disk alert lists the nodes past the watermarks, and is titled by what it found', () => {
  const data = nodes([['es-hot-1', 96], ['es-hot-2', 92], ['es-warm-1', 40]]);
  const a = alert(clusters.a, 'disk-balance', 'critical', { title: 'atlas-prod: disk at flood stage on es-hot-1 — indices are read-only' });
  const [m] = G.mergeAlerts([a], ctxFor({ data: () => data }));
  assert.deepEqual(m.items.map((i) => [i.label, i.value, i.level]), [['es-hot-1', '96%', 'critical'], ['es-hot-2', '92%', 'warning']]);
  assert.equal(m.count, 'on 2 nodes');
  assert.equal(m.title, 'Disk at flood stage on es-hot-1 — indices are read-only');
});

test('ILM errors list the indices the cluster reports', () => {
  const data = { ilmErrors: { 'logs-2': { failed_step: 'rollover' }, 'logs-1': { step: 'ERROR' } } };
  const [m] = G.mergeAlerts([alert(clusters.a, 'ilm', 'warning')], ctxFor({ data: () => data }));
  assert.deepEqual(m.items.map((i) => [i.label, i.value]), [['logs-1', 'ERROR'], ['logs-2', 'rollover']]);
  assert.equal(m.count, '2 indices');
});

test('a tuned field-volume row keeps its member spikes as items', () => {
  const members = [
    alert(clusters.a, 'volume:host.name:p7', 'warning', { title: 'atlas-prod: host.name "p7" volume up 520%' }),
    alert(clusters.a, 'volume:src:x', 'warning', { title: 'atlas-prod: src "x" volume up 150%' }),
  ];
  const tuned = alert(clusters.a, 'volume', 'warning', { members, grouped: 2 });
  const [m] = G.mergeAlerts([tuned], ctxFor());
  assert.deepEqual(m.items.map((i) => [i.label, i.value]).sort(), [['host.name = p7', 'up 520%'], ['src = x', 'up 150%']]);
  assert.equal(m.items[0].field != null, true);
});

/* ------------------------------ acknowledgements ------------------------------ */

const acks = (rec) => ({ ackFor: (k) => (rec[k] ? { key: k, ...rec[k] } : null), isAcked: (k) => !!(rec[k] && rec[k].acked) });

test('acknowledging a merged alert covers its items; a new item re-opens it', () => {
  const two = [alert(clusters.a, 'slm-fail:daily', 'critical'), alert(clusters.a, 'slm-fail:weekly', 'critical')];
  const rec = { 'a:slm-fail': { acked: true, ackedBy: 'sam', ackedAt: NOW - MIN, ackedItems: ['a:slm-fail:daily', 'a:slm-fail:weekly'] } };
  let [m] = G.mergeAlerts(two, ctxFor(acks(rec)));
  assert.equal(m.state, 'acked');
  assert.equal(m.newSince, 0);

  const three = [...two, alert(clusters.a, 'slm-fail:monthly', 'critical')];
  [m] = G.mergeAlerts(three, ctxFor(acks(rec)));
  assert.equal(m.state, 'open', 'a newcomer must not hide behind an older acknowledgement');
  assert.equal(m.newSince, 1);
  assert.equal(m.items.find((i) => i.label === 'monthly').acked, false);
  assert.equal(m.items.find((i) => i.label === 'daily').acked, true);
  assert.equal(G.summaryOf([m], 4).critical, 1, 'and it counts as open');
});

test('a node joining an acknowledged disk alert is 1 new since acknowledged', () => {
  const a = alert(clusters.a, 'disk', 'critical', { diskPercent: 90 });
  const rec = { 'a:disk': { acked: true, ackedItems: ['a:disk|es-hot-1', 'a:disk|es-hot-2'] } };
  const before = nodes([['es-hot-1', 92], ['es-hot-2', 88]]);
  assert.equal(G.mergeAlerts([a], ctxFor({ ...acks(rec), data: () => before }))[0].state, 'acked');
  const after = nodes([['es-hot-1', 92], ['es-hot-2', 88], ['es-hot-3', 86]]);
  const [m] = G.mergeAlerts([a], ctxFor({ ...acks(rec), data: () => after }));
  assert.equal(m.state, 'open');
  assert.equal(m.newSince, 1);
});

test('an acknowledgement written before merging still covers what it covered', () => {
  // against the merged key with no item list: everything under it, as it always did
  const a = alert(clusters.a, 'disk', 'critical', { diskPercent: 90 });
  const rec = { 'a:disk': { acked: true, ackedBy: 'old', ackedAt: NOW - 3600000 } };
  const data = nodes([['n1', 92], ['n2', 91], ['n3', 95]]);
  assert.equal(G.mergeAlerts([a], ctxFor({ ...acks(rec), data: () => data }))[0].state, 'acked');
  // against a member's own key
  const two = [alert(clusters.a, 'slm-fail:daily', 'critical'), alert(clusters.a, 'slm-fail:weekly', 'critical')];
  const legacy = { 'a:slm-fail:daily': { acked: true }, 'a:slm-fail:weekly': { acked: true } };
  assert.equal(G.mergeAlerts(two, ctxFor(acks(legacy)))[0].state, 'acked');
  const partly = { 'a:slm-fail:daily': { acked: true } };
  const [m] = G.mergeAlerts(two, ctxFor(acks(partly)));
  assert.equal(m.state, 'open', 'one of two items unhandled leaves it open');
});

test('silenced members: all silenced is silenced, some is still open', () => {
  const two = [alert(clusters.a, 'slm-fail:daily', 'critical'), alert(clusters.a, 'slm-fail:weekly', 'critical')];
  assert.equal(G.mergeAlerts(two, ctxFor({ silenced: () => true }))[0].state, 'silenced');
  assert.equal(G.mergeAlerts(two, ctxFor({ silenced: (a) => a.key.endsWith('daily') }))[0].state, 'open');
});

/* --------------------------------- ordering --------------------------------- */

function merged(spec) {
  // spec: { cluster, family, level, since }
  const list = spec.map((s, i) => alert(s.cluster, s.family, s.level, { failingSince: s.since }));
  return G.mergeAlerts(list, ctxFor());
}

test('groups: worst severity first, then most alerts, then name A–Z (natural, case-blind)', () => {
  const X = (id, name) => C(id, name);
  const m = merged([
    { cluster: X('w1', 'warn-many'), family: 'health', level: 'warning' },
    { cluster: X('w1', 'warn-many'), family: 'ilm', level: 'warning' },
    { cluster: X('w1', 'warn-many'), family: 'slm-mode', level: 'warning' },
    { cluster: X('c1', 'crit-one'), family: 'unreachable', level: 'critical' },
    { cluster: X('c2', 'Crit-two'), family: 'unreachable', level: 'critical' },
    { cluster: X('c2', 'Crit-two'), family: 'health', level: 'warning' },
    { cluster: X('n10', 'es-node-10'), family: 'ilm', level: 'warning' },
    { cluster: X('n2', 'es-node-2'), family: 'ilm', level: 'warning' },
  ]);
  const groups = G.groupAlerts(m, 'cluster');
  assert.deepEqual(groups.map((g) => g.name),
    ['Crit-two',                       // critical, 2 alerts
     'crit-one',                       // critical, 1 alert
     'warn-many',                      // warnings only, 3 alerts
     'es-node-2', 'es-node-10']);      // warnings, 1 alert each: natural order, 2 before 10
  assert.deepEqual([groups[0].critical, groups[0].warning], [1, 1]);
});

test('name order ignores case and reads numbers as numbers, and is total', () => {
  assert.ok(compareNames('es-node-2', 'es-node-10') < 0);
  assert.ok(compareNames('Alpha', 'alpha') !== 0, 'equal-looking names still have one fixed order');
  assert.equal(compareNames('Alpha', 'alpha'), -compareNames('alpha', 'Alpha'));
  assert.ok(compareNames('beta', 'Alpha') > 0);
});

test('inside a group: critical first, then the oldest', () => {
  const c = clusters.a;
  const m = merged([
    { cluster: c, family: 'ilm', level: 'warning', since: NOW - 55 * MIN },
    { cluster: c, family: 'disk', level: 'critical', since: NOW - 2 * 3600000 },
    { cluster: c, family: 'health', level: 'critical', since: NOW - 100 * MIN },
    { cluster: c, family: 'slm-mode', level: 'warning', since: NOW - 3 * 3600000 },
  ]);
  const [g] = G.groupAlerts(m, 'cluster');
  assert.deepEqual(g.alerts.map((a) => a.family), ['disk', 'health', 'slm-mode', 'ilm']);
  assert.equal(g.oldest, NOW - 3 * 3600000);
});

test('group by alert type: one section per rule, across clusters', () => {
  const m = merged([
    { cluster: clusters.a, family: 'disk', level: 'critical' }, { cluster: clusters.k, family: 'disk', level: 'critical' },
    { cluster: clusters.b, family: 'ilm', level: 'warning' },
  ]);
  const groups = G.groupAlerts(m, 'type');
  assert.deepEqual(groups.map((g) => [g.family, g.alerts.length]), [['disk', 2], ['ilm', 1]]);
});

test('group by none is one flat list: critical first, then cluster, then age', () => {
  const m = merged([
    { cluster: clusters.b, family: 'ilm', level: 'warning' },
    { cluster: clusters.k, family: 'unreachable', level: 'critical' },
    { cluster: clusters.a, family: 'disk', level: 'critical' },
  ]);
  const groups = G.groupAlerts(m, 'none');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].alerts.map((a) => a.clusterId), ['a', 'k', 'b']);
  assert.deepEqual(G.groupAlerts([], 'cluster'), []);
});

test('filters: severity, text (title, cluster, items, notes) and the acknowledged toggle', () => {
  const rec = { 'a:ilm': { acked: true } };
  const list = [alert(clusters.a, 'ilm', 'warning'), alert(clusters.a, 'unreachable', 'critical'), alert(clusters.k, 'disk', 'critical')];
  const m = G.mergeAlerts(list, ctxFor(acks(rec)));
  assert.equal(G.filterAlerts(m).length, 2, 'acknowledged ones are hidden by default');
  assert.equal(G.filterAlerts(m, { showHandled: true }).length, 3);
  assert.equal(G.filterAlerts(m, { level: 'critical' }).length, 2);
  assert.equal(G.filterAlerts(m, { level: 'warning', showHandled: true }).length, 1);
  assert.equal(G.filterAlerts(m, { text: 'KESTREL' }).length, 1);
  assert.equal(G.filterAlerts(m, { text: 'ticket 4412', notesOf: (x) => (x.key === 'k:disk' ? 'ticket 4412' : '') }).length, 1);
});

test('tiles and footer come from one summary', () => {
  const rec = { 'a:ilm': { acked: true } };
  const list = [alert(clusters.a, 'ilm', 'warning'), alert(clusters.a, 'unreachable', 'critical'), alert(clusters.k, 'disk', 'critical'), alert(clusters.b, 'health', 'warning')];
  const s = G.summaryOf(G.mergeAlerts(list, ctxFor(acks(rec))), 32);
  assert.deepEqual([s.critical, s.warning, s.open], [2, 1, 3]);
  assert.deepEqual([s.clustersAffected, s.fleet, s.clustersClear], [3, 32, 29]);
  assert.deepEqual([s.acknowledged, s.silenced], [1, 0]);
});

test('an alert of no registered rule still merges, by its family', () => {
  const m = G.mergeAlerts([alert(clusters.a, 'mystery:1', 'warning'), alert(clusters.a, 'mystery:2', 'warning')], ctxFor());
  assert.equal(m.length, 1);
  assert.equal(m[0].family, 'mystery');
  assert.equal(m[0].rule, null);
});
