/**
 * Play's figures, from existing pieces: each cluster's problems (what, why, since when), the
 * Fleet page's four figures and its cards, and the fleet's volume sums — each said with what
 * it covers, unknown never read as 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'navigator', 'matchMedia']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
globalThis.indexedDB = undefined;
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const St = await import(url('ui/js/play/status.js'));
const V = await import(url('ui/js/play/volume.js'));
const F = await import(url('ui/js/play/fleet.js'));
const P = await import(url('ui/js/play/parts.js'));

const GB = 1024 ** 3;
const node = (name, used, total = 100) => ({ node: name, 'disk.used': used * GB, 'disk.total': total * GB, 'disk.avail': (total - used) * GB, shards: 10 });
const cluster = { id: 'c1', name: 'prod' };
const data = (status, nodes) => ({ reachable: true, updatedAt: 1, health: { status, unassigned_shards: 3, number_of_nodes: nodes.length },
  disk: { nodes, percent: 50, used: 500, total: 1000 }, clusterSettings: null });
const lines = { warning: 85, high: 90, critical: 95 };
const al = (level, family, title, more = {}) => ({ key: `c1:${family}`, clusterId: 'c1', level, family, title, state: 'open', items: [], since: 1, ...more });

test('a problem says what it is and why it matters: disk, red health, a node that left, not answering', () => {
  const d = data('green', [node('data-3', 96.4), node('data-1', 40)]);
  const s = St.clusterStatus(cluster, d, { alerts: [al('critical', 'disk', 'Disk usage above 95%')], lines });
  assert.equal(s.problems[0].what, 'Disk 96 % on data-3');
  assert.match(s.problems[0].why, /^3\.\d+ GB free\. From 95 % Elasticsearch may make/);
  const hi = St.clusterStatus(cluster, data('green', [node('n', 92)]), { alerts: [al('high', 'disk', 'x')], lines });
  assert.match(hi.problems[0].why, /8\.00 GB free\. From 90 % shards may move away/);
  const held = St.clusterStatus(cluster, data('green', [node('n', 94)]), { alerts: [al('critical', 'disk', 'x')], lines });
  assert.match(held.problems[0].why, /Stays Critical until it falls below 93 %/, 'held by the hysteresis: the reason is its level\'s');
  const red = St.clusterStatus(cluster, data('red', [node('a', 10)]), {});
  assert.deepEqual([red.level, red.problems[0].what, red.problems[0].why], ['critical', 'Cluster health red', '3 shards have no node. Red: part of the data cannot be read.']);
  const left = St.clusterStatus(cluster, data('yellow', [node('a', 10)]), { nodes: { left: [{ node: 'es-warm-2', since: 777 }] } });
  assert.deepEqual([left.level, left.problems[0].what, left.problems[0].since], ['high', 'Node es-warm-2 left the cluster', 777]);
  const down = St.clusterStatus(cluster, { reachable: false, updatedAt: 1 }, { alerts: [al('critical', 'unreachable', 'prod unreachable')] });
  assert.equal(down.problems.length, 1);
  assert.equal(down.problems[0].what, 'Not answering');
  assert.equal(down.fullest, null, 'a disk not read now is not shown');
  assert.equal(St.clusterStatus(cluster, null, {}).state, 'loading');
});

test('the node-level disk alert, into which the disk rule is folded, is told as a full disk', () => {
  const bal = (level, causes, detail) => al(level, 'disk-balance', 'Disk', { detail, members: [{ title: 'prod: disk over the high watermark on data-3', balanceCauses: causes }] });
  const one = (pct, a) => St.clusterStatus(cluster, data('green', [node('data-3', pct), node('data-1', 40)]), { alerts: [a], lines }).problems[0];
  const high = one(92, bal('high', ['high', 'spread'], 'd'));
  assert.deepEqual([high.what, high.why], ['Disk 92 % on data-3', '8.00 GB free. From 90 % shards may move away.']);
  const flood = one(96, bal('critical', ['flood'], 'd'));
  assert.match(flood.why, /From 95 % Elasticsearch may make indices read-only/);
  // Watermarks of its own (flood at 88 %, say): the alert's words, never a line it has not reached.
  assert.equal(one(91, bal('critical', ['flood'], 'Its indices are read-only.')).why, '9.00 GB free. Its indices are read-only.');
  assert.equal(one(88, bal('critical', ['flood'], 'Its indices are read-only.')).why, '12.0 GB free. Its indices are read-only.');
  // Uneven disks alone are not a full disk.
  assert.equal(one(92, bal('high', ['spread'], 'uneven')).what, 'Disk over the high watermark on data-3');
});

test('an alert without its own words here keeps its title, without the cluster name', () => {
  const s = St.clusterStatus(cluster, data('green', [node('a', 10)]), { alerts: [al('high', 'slm-fail', 'Last SLM run failed', { members: [{ title: 'prod: daily failed' }], detail: 'on 24 Nov' })] });
  assert.equal(s.problems[0].what, 'Daily failed');
  assert.equal(s.problems[0].why, 'on 24 Nov');
});

test('the problem that took the screen is first; then Critical before High, not acknowledged first', () => {
  const alerts = [al('high', 'heap', 'h'), al('critical', 'ilm', 'i', { state: 'acked' }), al('critical', 'capacity', 'c')];
  const keys = (hot) => St.clusterStatus(cluster, data('green', [node('a', 10)]), { alerts, hot }).problems.map((p) => p.key);
  assert.deepEqual(keys(null), ['c1:capacity', 'c1:ilm', 'c1:heap']);
  assert.deepEqual(keys('c1:heap'), ['c1:heap', 'c1:capacity', 'c1:ilm']);
});

/* ------------------------------------------ Fleet ------------------------------------------ */

const NOW = 1793000000000;
function fleetCtx(specs, over = {}) {
  const clusters = specs.map((s) => ({ id: s.id, name: s.name || s.id }));
  const datas = new Map(specs.map((s) => [s.id, s.data]));
  const st = new Map(specs.map((s) => [s.id, St.clusterStatus({ id: s.id, name: s.name || s.id }, s.data, { alerts: s.alerts || [], nodes: s.nodes || null, lines })]));
  return { now: NOW, tz: null, clusters, st, lines, data: (id) => datas.get(id) || null, open: specs.flatMap((s) => (s.alerts || []).filter((m) => m.state === 'open')), openBy: new Map(),
    heldBy: new Map(), delay: new Map(), delayBoard: null, volume: new Map(), takeover: null, watch: { delayYellowFromMin: 30, delayRedAboveMin: 60 },
    display: { fleetOrder: ['critical', 'name'] }, openSince: (p) => (p.alert && p.alert.opened) || null, afterMount: () => {}, ...over };
}
const good = (id) => ({ id, data: data('green', [node('a', 40)]) });

test('Fleet: clusters by level, the fullest disks past the High line, and what is not read', () => {
  const ctx = fleetCtx([{ id: 'a', data: data('green', [node('n1', 96)]), alerts: [al('critical', 'disk', 'x', { key: 'a:disk' })] },
    { id: 'b', data: data('green', [node('n2', 91), node('n9', 20)]), alerts: [al('high', 'disk', 'x', { key: 'b:disk' })] }, good('c'), { id: 'd', data: null }]);
  assert.deepEqual(F.levelCounts(ctx), { critical: 1, high: 1, none: 1, nodata: 1 });
  const f = F.fullDisks(ctx);
  assert.deepEqual(f.list.map((x) => [x.c.id, Math.floor(x.f.pct), x.f.name]), [['a', 96, 'n1'], ['b', 91, 'n2']]);
  assert.equal(f.read, 3, 'the cluster with no data is not "read"');
  const el = F.render(ctx);
  assert.deepEqual([...el.querySelectorAll('.pl-ft.big .pl-ftn')].map((x) => x.textContent), ['a', 'b']);
  assert.match(el.textContent, /2 of 3 read, 1 not read/);
  assert.match(el.textContent, /Other clusters: no Critical or High problem, 1 with no data yet/);
  assert.match([...el.querySelectorAll('.pl-ft.small')].find((x) => x.dataset.cluster === 'd').textContent, /no data yet/);
});

test('Fleet: how long a problem is open is said only when it is known', () => {
  const ctx = fleetCtx([{ id: 'a', data: data('green', [node('n1', 96)]), alerts: [al('critical', 'disk', 'x', { key: 'a:disk', opened: NOW - 125000 })] },
    { id: 'b', data: data('green', [node('n1', 96)]), alerts: [al('critical', 'disk', 'x', { key: 'b:disk' })] }]);
  const pills = [...F.render(ctx).querySelectorAll('.pl-lvl')].map((x) => x.textContent);
  assert.deepEqual(pills, ['Critical · 2 min', 'Critical · since: not known']);
  // Against the server's clock, not this screen's; failing snapshots by their first failed run.
  assert.equal(F.sinceText({ ...ctx, serverNow: () => NOW + 600000 }, ctx.st.get('a').problems[0]), '12 min');
  const snaps = { key: 'a:repo', level: 'critical', alert: { key: 'a:repo', level: 'critical', members: [{ level: 'warning', failingSince: NOW - 9 * 86400000 }, { level: 'critical', failingSince: NOW - 3 * 86400000 }] } };
  assert.equal(F.sinceText(ctx, snaps), 'failing 3 d 0 h');
  assert.deepEqual([0, 59, 60, 192, 1439, 1620].map((m) => P.openFor(m * 60000)), ['0 min', '59 min', '1 h 0 min', '3 h 12 min', '23 h 59 min', '1 d 3 h']);
});

test('Fleet: one layout for any number — 3 large, 4 half, the rest small with problems first; none is said', () => {
  const bad = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, data: data('green', [node('n', 92)]), alerts: [al('high', 'disk', 'x', { key: `p${i}:disk` })] }));
  const el = F.render(fleetCtx([...bad, good('z1'), good('z2')]));
  assert.equal(el.querySelectorAll('.pl-ft.big').length, 3);
  assert.equal(el.querySelectorAll('.pl-ft.half').length, 4);
  assert.deepEqual([...el.querySelectorAll('.pl-ft.small')].map((x) => x.dataset.cluster), ['p7', 'p8', 'z1', 'z2']);
  assert.match(el.textContent, /2 more with a Critical or High problem, then the others/);
  const none = F.render(fleetCtx([good('a')]));
  assert.match(none.textContent, /No Critical or High problem on 1 cluster/);
  assert.match(none.textContent, /None\. Fullest: 40 % on a, a/);
  assert.match(none.textContent, /not measured/, 'no delay measurement: said, not 0');
  assert.equal(F.render(fleetCtx([{ id: 'a', data: null }])).querySelector('.pl-fclear').textContent, 'No cluster has answered yet');
});

test('Fleet: the cluster of the alert that took the screen is first', () => {
  const ctx = fleetCtx([{ id: 'a', data: data('green', [node('n', 97)]), alerts: [al('critical', 'disk', 'x', { key: 'a:disk' })] },
    { id: 'b', data: data('green', [node('n', 97)]), alerts: [al('critical', 'disk', 'x', { key: 'b:disk' })] }], { takeover: { key: 'b:disk', since: NOW } });
  assert.deepEqual(F.splitFleet(ctx).bad.map((c) => c.id), ['b', 'a']);
  assert.equal(F.render(ctx).querySelector('.pl-ft.big.hot').dataset.cluster, 'b');
});

/* ------------------------------------------ Volume ------------------------------------------ */

const TODAY = '2026-11-25';
const rec = (rows, settings = { sizeBasis: 'primary' }) => ({ settings, days: rows.map(([day, v, more]) => ({ day, priBytes: v, ...(more || {}) })) });

test('volume: cards as the Reports page reads them', () => {
  const reply = { cards: { yesterday: { value: 100, changeVsAvgPct: 25 }, average: { value: 80 }, monthSoFar: { value: 3000 } } };
  assert.deepEqual(V.cardsOf(reply), { yesterday: 100, average: 80, month: 3000, change: 25 });
  assert.deepEqual(V.cardsOf(null), { yesterday: null, average: null, month: null, change: null });
});

test('volume: finished days only; a missing day is in no sum and no change, one that is not final is said', () => {
  const a = V.seriesOf(rec([['2026-11-23', 100, { avg: 90 }], ['2026-11-24', 120, { avg: 95 }], ['2026-11-25', 5]]), TODAY);
  const b = V.seriesOf(rec([['2026-11-23', 50, { avg: 40 }], ['2026-11-24', null, { final: false }]]), TODAY);
  assert.deepEqual([...a.keys()], ['2026-11-23', '2026-11-24'], 'today is not a finished day');
  assert.deepEqual([...b.keys()], ['2026-11-23']);
  const days = V.fleetDays([a, b], TODAY);
  assert.equal(days.length, 14);
  assert.deepEqual(days[0], { day: '2026-11-11', of: 0, notFinal: 0, value: null, avg: null, pctOf: 0, pct: null });
  assert.deepEqual([days[12].value, days[12].of, days[12].avg, days[12].pct], [150, 2, 130, null]);
  assert.deepEqual([days[13].value, days[13].of, days[13].avg, days[13].pctOf], [120, 1, 95, 1]);
  assert.ok(Math.abs(days[13].pct - 20) < 1e-9, 'a 120 against 100: b, with one day, is in neither side');
  const nf = V.fleetDays([V.seriesOf(rec([['2026-11-24', 30, { final: false }]]), TODAY)], TODAY)[13];
  assert.deepEqual([nf.value, nf.notFinal], [30, 1], 'yesterday, read too soon to be final, is drawn as Reports draws it and said');
  const noAvg = V.fleetDays([a, V.seriesOf(rec([['2026-11-24', 9]]), TODAY)], TODAY);
  assert.equal(noAvg[13].avg, null, 'the average of part of the clusters is not drawn over their sum');
  assert.equal(V.seriesOf(null), null);
});

test('volume: the top changes are by size, and a cluster with a day missing is counted as not known', () => {
  const row = (name, x, y) => ({ c: { name }, series: new Map([...(x === null ? [] : [['2026-11-23', { value: x }]]), ...(y === null ? [] : [['2026-11-24', { value: y }]])]) });
  const ch = V.changeList([row('small', 1, 5), row('big', 400, 300), row('gone', 10, null), { c: { name: 'none' }, series: null }, row('new', 0, 7)], TODAY);
  assert.deepEqual(ch.list.map((x) => [x.name, x.diff]), [['big', -100], ['new', 7], ['small', 4]]);
  assert.equal(ch.list[1].pct, null, 'from 0 there is no percent');
  assert.equal(ch.unknown, 2);
  const s = V.shareList([row('a', 1, 50), row('b', 1, 30), row('c', 1, 10), row('d', 1, 5), row('e', 1, 3), row('f', 1, 2), row('g', 1, null)], TODAY);
  assert.deepEqual([s.total, s.of, s.others, s.rest], [100, 6, 2, 5]);
  assert.deepEqual(s.top.map((x) => x.name), ['a', 'b', 'c', 'd']);
});

test('volume: disks over the whole cluster, fullest first, only those read', () => {
  const ctx = { clusters: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }], lines, now: Date.parse(`${TODAY}T06:00:00Z`),
    data: (id) => ({ a: { disk: { percent: 40, used: 40, total: 100 } }, b: { disk: { percent: 88, used: 176, total: 200 } } })[id] || null, volume: new Map() };
  const d = V.diskList(ctx);
  assert.deepEqual(d.list.map((x) => x.c.id), ['b', 'a']);
  assert.deepEqual([d.read, d.used, d.total], [2, 216, 300]);
  ctx.volume.set('a', { reply: rec([['2026-11-23', 10 * GB], ['2026-11-24', 11 * GB, { final: false }]]) });
  ctx.volume.set('b', { reply: null, error: 'x' });
  const el = V.render(ctx);
  assert.match(el.textContent, /24 Nov: 11\.0 GB \(1 of 3 clusters, not final\), \+10\.0 % on the day before/);
  assert.match(el.textContent, /2 of 3 read: 72 %/);
  assert.match(el.textContent, /2 of 3 clusters: not known/);
  assert.equal(el.querySelectorAll('.pl-vb.none').length, 12);
  assert.equal(V.headText(ctx), 'last finished day 24 Nov');
  const none = V.render({ ...ctx, volume: new Map(ctx.clusters.map((c) => [c.id, { reply: null, unsupported: true }])) });
  assert.match(none.textContent, /needs 0\.3/);
  assert.equal(V.byteTop(1.92 * 1024 * GB), 2.5 * 1024 * GB);
});
