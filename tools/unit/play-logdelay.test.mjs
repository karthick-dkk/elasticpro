/**
 * Play's Log delay slide (ui/js/play/logdelay.js): what it makes of LOGDELAY_BOARD — the figures
 * of this display's clusters only, part delayed counted on time, a cluster not read lately in no
 * "now" figure, a period nobody measured a gap — and of Play's own measurement without a record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
globalThis.indexedDB = undefined;
const L = await import(pathToFileURL(path.join(ROOT, 'ui/js/play/logdelay.js')).href);

const H = 3600000;
const T0 = Date.UTC(2026, 10, 24);
const windows = [0, 1, 2, 3].map((i) => ({ from: T0 + i * 12 * H, to: T0 + (i + 1) * 12 * H, complete: i < 3 }));
const LV = { noDelayUnder: 30, delayFrom: 30, criticalOver: 60 };
const row = (id, x = {}) => ({ id, name: id, state: 'ok', lastRunAt: T0 + 40 * H, levels: LV, devices: 20, onTime: 10, partDelayed: 2, delay: 3, critical: 1, late: 4, silent: 2, cantMeasure: 1, otherTz: 1, newToday: 2, solvedToday: 1, windows: [5, 4, null, 4], ...x });
const ctxOf = (clusters, board, over = {}) => ({ now: T0 + 41 * H, tz: 'UTC', clusters: clusters.map((id) => ({ id, name: id })), delay: new Map(), delayBoard: board, watch: { delayYellowFromMin: 30, delayRedAboveMin: 60 },
  display: { dwellSec: 20, slideDwell: {} }, elapsed: 0, ...over });
const board = (clusters) => ({ ok: true, now: T0 + 41 * H, scheduled: true, windows, clusters });

test('the devices now: part delayed on time, every class once, the excluded cluster in none', () => {
  const ctx = ctxOf(['a', 'b'], board([row('a'), row('b', { devices: 5, onTime: 5, partDelayed: 0, delay: 0, critical: 0, late: 0, silent: 0, cantMeasure: 0, otherTz: 0, newToday: 0, solvedToday: 3 }), row('hidden', { late: 99 })]));
  const t = L.delayTotals(L.delayRows(ctx));
  assert.deepEqual(t, { clusters: 2, devices: 25, onTime: 17, delay: 3, critical: 1, late: 4, grey: 3, otherTz: 1, newToday: 2, solvedToday: 4 });
  assert.equal(t.onTime + t.delay + t.critical + t.grey + t.otherTz, t.devices, 'the classes add up to the devices');
  assert.deepEqual(L.delayRows(ctx).map((r) => r.id), ['a', 'b'], 'most late first');
});

test('a cluster not read lately is in no figure of now, and says when it was read', () => {
  const ctx = ctxOf(['a', 'old', 'bad', 'new'], board([row('a'), row('old', { state: 'old', late: 50, lastRunAt: T0 + 20 * H }), row('bad', { state: 'failed', late: 50 }), row('new', { state: 'never', lastRunAt: null, late: 0 })]));
  const t = L.delayTotals(L.delayRows(ctx));
  assert.equal(t.clusters, 1);
  assert.equal(t.late, 4);
  const el = L.render({ ...ctx, afterMount() {} });
  const text = (id) => el.querySelector(`[data-cluster="${id}"]`).textContent;
  assert.match(text('old'), /read 20:00, 24 Nov/);
  assert.match(text('bad'), /failed/);
  assert.match(text('new'), /not read/);
  assert.match(el.textContent, /1 of 4 clusters/);
});

test('the graph: sums per period, a gap where nothing was measured, the clusters said when fewer', () => {
  const ctx = ctxOf(['a', 'b'], board([row('a'), row('b', { windows: [null, 6, null, 1] })]));
  assert.deepEqual(L.delayWindows(ctx).map((w) => [w.late, w.measured]), [[5, 1], [10, 2], [null, 0], [5, 2]]);
  const el = L.render({ ...ctx, afterMount() {} });
  const g = el.querySelector('.pl-ldgraph');
  assert.deepEqual([...g.querySelectorAll('.val')].map((x) => x.textContent), ['5', '10', '5']);
  assert.equal(g.querySelectorAll('polyline').length, 1, 'no line across the gap');
  assert.match(g.textContent, /1 of 2 clusters/);
  assert.match(g.textContent, /not measured/);
  assert.deepEqual(L.delayWindows(ctx).map((w) => L.periodText(w, 'UTC')), ['00:00–12:00', '12:00–24:00', '00:00–12:00', '12:00–now']);
});

test('the most delayed clusters of a period: at most three, none with no late device', () => {
  const ctx = ctxOf(['a', 'b', 'c', 'd', 'e'], board([['a', 1], ['b', 9], ['c', 0], ['d', 4], ['e', 9]].map(([id, n]) => row(id, { windows: [n, n, n, n] }))));
  assert.deepEqual(L.topOf(ctx, 3), [{ name: 'b', n: 9 }, { name: 'e', n: 9 }, { name: 'd', n: 4 }]);
});

test('the late classes are named in minutes only when every cluster has the same levels', () => {
  assert.deepEqual(L.levelWords([row('a'), row('b')], null), { delay: '30–60 min late', critical: 'Over 60 min late' });
  assert.deepEqual(L.levelWords([row('a'), row('b', { levels: { ...LV, criticalOver: 120 } })], null), { delay: 'Delayed', critical: 'Critical' });
});

test('without a record: Play\'s own measurement, today unknown, the graph says why', () => {
  const delay = new Map([['a', { records: [{}], summary: { devices: 3, by: { OK: 1, DELAYED: 1, CRITICAL: 0, CLOCK_AHEAD: 0, OTHER_TZ: 0, ERROR: 0, NO_DATA: 1, UNKNOWN: 0 } } }]]);
  const none = board([row('a', { state: 'never', lastRunAt: null, windows: [null, null, null, null] })]);
  none.scheduled = false;
  const ctx = ctxOf(['a'], none, { delay });
  const t = L.delayTotals(L.delayRows(ctx));
  assert.deepEqual([t.devices, t.onTime, t.late, t.grey, t.newToday, t.solvedToday], [3, 1, 1, 1, null, null]);
  const el = L.render({ ...ctx, afterMount() {} });
  assert.match(el.querySelector('.pl-ldgraph').textContent, /measurement is off/);
  assert.equal(L.isEmpty(ctx), false);
  assert.equal(L.isEmpty(ctxOf(['a'], none)), true, 'nothing measured anywhere: skipped');
});

test('the scale is in whole devices and leaves room above the highest', () => {
  assert.deepEqual(L.scaleTop(0), { top: 4, step: 1 });
  assert.deepEqual(L.scaleTop(61), { top: 80, step: 20 });
  for (const n of [1, 3, 4, 7, 19, 99, 1234]) assert.ok(L.scaleTop(n).top >= n * 1.1 && Number.isInteger(L.scaleTop(n).step), `${n}`);
});
