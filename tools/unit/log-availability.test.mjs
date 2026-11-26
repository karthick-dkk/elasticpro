/**
 * The log availability map (0.3.98, owner 2026-11-26): one cell per day, green when a live
 * index carries the day (also when a snapshot holds it), blue when only a successful snapshot
 * does, red when only a partial one names it, grey when nothing does — and hatched, never
 * grey, when not every snapshot could be read. The figures beside it are Capacity's.
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
const at = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const A = await at('ui/js/core/log-availability.js');
const V = await at('ui/js/core/volume.js');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysFrom = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(iso(t)); return out; };
const name = (d) => `logstash-${d.replace(/-/g, '.')}`;
const dayOf = (n) => { const m = /(\d{4})\.(\d{2})\.(\d{2})/.exec(n); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const idx = (days) => days.map((d) => ({ index: name(d), day: d }));
const snap = (id, status, days, extra = {}) => ({ id, status, indexNames: days.map(name), failedIndices: [], failed: 0, start: 1, ...extra });
const data = (rows, more = {}) => ({ repos: [{ name: 'r1' }], reposRead: true, snapshots: { r1: rows }, snapshotTotals: { r1: { total: rows.length } }, ...more });
const TODAY = '2026-11-26';

test('live wins: a day both live and backed up is green; blue, red and grey follow', () => {
  const live = daysFrom('2026-11-10', TODAY);
  const av = A.logAvailability({
    indices: idx(live),
    data: data([
      snap('s-ok', 'SUCCESS', daysFrom('2026-11-01', '2026-11-15')),
      snap('s-part', 'PARTIAL', ['2026-10-28', '2026-10-29'], { failed: 1, failedIndices: [name('2026-10-28')] }),
    ]),
    dayOf, today: TODAY,
  });
  assert.equal(av.stateOf('2026-11-12'), 'live', 'live and in a snapshot: green only');
  assert.equal(av.stateOf('2026-11-05'), 'ok');
  assert.equal(av.stateOf('2026-10-28'), 'partial');
  assert.equal(av.stateOf('2026-10-29'), 'partial', 'named only by a partial snapshot: red, even when restorable');
  assert.equal(av.stateOf('2026-10-31'), 'none');
  assert.equal(av.from, '2026-10-28');
  assert.equal(av.to, TODAY);
  assert.deepEqual(av.counts, { live: 17, ok: 9, partial: 2, none: 2, unknown: 0 });
  // The hover names both, so green never hides the backup.
  assert.match(av.describe('2026-11-12'), /Live: 1 index\nBackup: in 1 successful snapshot/);
  assert.match(av.describe('2026-10-28'), /an index of this day failed in 1/);
  assert.match(av.describe('2026-10-29'), /restorable/);
});

test('a successful snapshot outranks a partial one for the same day', () => {
  const av = A.logAvailability({
    indices: [],
    data: data([snap('p', 'PARTIAL', ['2026-11-20'], { failed: 1, failedIndices: [name('2026-11-20')] }), snap('s', 'SUCCESS', ['2026-11-20'])]),
    dayOf, today: TODAY,
  });
  assert.equal(av.stateOf('2026-11-20'), 'ok');
  assert.match(av.describe('2026-11-20'), /1 successful snapshot[\s\S]*1 partial snapshot/);
});

test('SUCCESS with a failed shard counts as partial; failed and running snapshots hold nothing', () => {
  const av = A.logAvailability({
    indices: [],
    data: data([
      snap('sf', 'SUCCESS', ['2026-11-20'], { failed: 1, failedIndices: [name('2026-11-20')] }),
      snap('f', 'FAILED', ['2026-11-21']),
      snap('ip', 'IN_PROGRESS', ['2026-11-22']),
    ]),
    dayOf, today: TODAY,
  });
  assert.equal(av.stateOf('2026-11-20'), 'partial');
  assert.equal(av.stateOf('2026-11-21'), 'none');
  assert.equal(av.stateOf('2026-11-22'), 'none');
});

test('unknown is not grey: unread names, a cut listing, an unread repository, switched off', () => {
  const cat = { id: 'c', status: 'SUCCESS', indexNames: null, failedIndices: null, failed: 0 };
  const cases = [
    [data([snap('s', 'SUCCESS', ['2026-11-20']), cat]), /index names not read/],
    [data([snap('s', 'SUCCESS', ['2026-11-20'])], { snapshotTotals: { r1: { total: 900 } } }), /only the newest 1 of 900/],
    [{ repos: [{ name: 'r1' }], reposRead: true, snapshots: {} }, /not read yet/],
    [{ repos: [], reposRead: false }, /repository list has not been read/],
    [data([], { switchedOff: { snapshots: true } }), /switched off/],
  ];
  for (const [d, why] of cases) {
    const av = A.logAvailability({ indices: idx(['2026-11-10']), data: d, dayOf, today: TODAY });
    assert.equal(av.stateOf('2026-11-15'), 'unknown', String(why));
    assert.equal(av.stateOf('2026-11-10'), 'live');
    assert.match(av.unknown.join(' '), why);
    assert.equal(av.counts.none, 0);
  }
  const ulm = A.logAvailability({ indices: idx(['2026-11-10']), data: { repos: [], reposRead: true }, dayOf, ulm: true, today: TODAY });
  assert.equal(ulm.stateOf('2026-11-15'), 'unknown');
  assert.match(ulm.unknown[0], /ULM/);
  const none = A.logAvailability({ indices: idx(['2026-11-10']), data: { repos: [], reposRead: true }, dayOf, today: TODAY });
  assert.equal(none.stateOf('2026-11-15'), 'none', 'no repository registered, and that was read: grey');
});

test('the reported case: a stray day, a long empty stretch collapsed, Capacity figures reused', () => {
  const live = ['2025-05-03', ...daysFrom('2026-10-01', TODAY)];
  const indices = [...idx(live), ...idx(['2025-05-03', '2025-05-03', '2025-05-03', '2025-05-03'])];
  const av = A.logAvailability({ indices, data: { repos: [], reposRead: true }, dayOf, today: TODAY });
  assert.equal(av.from, '2025-05-03');
  const gap = av.months.find((r) => r.kind === 'gap');
  assert.deepEqual({ from: gap.from, to: gap.to, state: gap.state }, { from: '2025-06', to: '2026-09', state: 'none' });
  assert.equal(gap.days, V.spanDaysIso('2025-06-01', '2026-09-30'));
  assert.equal(av.months[0].ym, '2025-05', 'the month with the stray day is drawn, not folded');
  assert.equal(av.months[0].cells.find((c) => c.day === '2025-05-03').state, 'live');
  assert.equal(av.months[0].cells.find((c) => c.day === '2025-05-01').state, 'out');
  // The same figure as the Capacity column, not a second count.
  assert.deepEqual(av.held, V.liveHeldDays(indices, {}, TODAY));
  assert.equal(av.held.days, 57);
  assert.equal(av.held.from, '2026-10-01');
  assert.equal(av.counts.live, 58);
});

test('trailing gap: days since the newest live index, flagged past 7, future days ignored', () => {
  assert.deepEqual(A.trailingGap(idx([TODAY]), TODAY), { newest: TODAY, days: 0, stale: false });
  assert.deepEqual(A.trailingGap(idx(['2026-11-25']), TODAY), { newest: '2026-11-25', days: 1, stale: false });
  assert.deepEqual(A.trailingGap(idx(['2026-11-19']), TODAY), { newest: '2026-11-19', days: 7, stale: false });
  assert.deepEqual(A.trailingGap(idx(['2026-11-18']), TODAY), { newest: '2026-11-18', days: 8, stale: true });
  assert.deepEqual(A.trailingGap(idx(['2026-11-02', '2026-12-10']), TODAY), { newest: '2026-11-02', days: 24, stale: true });
  assert.equal(A.trailingGap(null, TODAY), null, 'not read is not "no gap"');
  assert.deepEqual(A.trailingGap([{ index: 'x', day: null }], TODAY), { newest: null, days: null, stale: false });
  assert.equal(A.trailingGapText({ newest: '2026-11-02', days: 24 }), 'No live index for 24 days (newest 2026-11-02)');
  assert.equal(A.trailingGapText({ newest: '2026-11-25', days: 1 }), 'No live index for today yet (newest 2026-11-25)');
  assert.equal(A.trailingGapText({ newest: TODAY, days: 0 }), '');
});

test('future-dated days stretch the map and are counted apart', () => {
  const av = A.logAvailability({ indices: idx(['2026-11-25', '2026-12-10']), data: { repos: [], reposRead: true }, dayOf, today: TODAY });
  assert.equal(av.to, '2026-12-10');
  assert.equal(av.ahead, 1);
  assert.equal(av.stateOf('2026-12-01'), 'future');
  assert.equal(av.stateOf('2026-12-10'), 'live');
  assert.match(av.describe('2026-12-10'), /Dated after today/);
});

test('nothing to draw while the index list is unread; undated indices are counted', () => {
  assert.equal(A.logAvailability({ indices: null, data: {}, dayOf, today: TODAY }), null);
  const av = A.logAvailability({ indices: [{ index: '.kibana', day: null }, ...idx([TODAY])], data: { repos: [], reposRead: true }, dayOf, today: TODAY });
  assert.equal(av.undated, 1);
});

test('a date that does not exist, or one far away, cannot stretch or break the map', () => {
  assert.equal(A.realDay('2026-02-29'), false);
  assert.equal(A.realDay('2028-02-29'), true);
  assert.equal(A.realDay('2026-13-45'), false);
  const indices = [...idx(['2026-11-20', '2026-13-45', '2026-02-30']), { index: 'a', day: '9999-12-31' }, { index: 'b', day: '0001-01-01' }];
  const t0 = Date.now();
  const av = A.logAvailability({
    indices,
    data: data([snap('s', 'SUCCESS', ['2026-11-21', '9999-01-01', '2026-04-31'])]),
    dayOf, today: TODAY,
  });
  assert.ok(Date.now() - t0 < 1000, 'the walk stays inside the window');
  assert.equal(av.from, '2026-11-20');
  assert.equal(av.to, TODAY);
  assert.equal(av.badDates, 2);
  assert.equal(av.outside.after, 2, '9999-12-31 live, 9999-01-01 in a snapshot');
  assert.equal(av.outside.before, 1);
  assert.equal(av.outside.first, '0001-01-01');
  assert.equal(av.outside.last, '9999-12-31');
  assert.equal(av.stateOf('2026-11-21'), 'ok');
  assert.deepEqual(A.trailingGap([{ day: '2026-02-30' }, ...idx(['2026-11-20'])], TODAY), { newest: '2026-11-20', days: 6, stale: false });
});

test('empty months after today fold into one line', () => {
  const av = A.logAvailability({ indices: idx(['2026-11-25', '2027-04-02']), data: { repos: [], reposRead: true }, dayOf, today: TODAY });
  const fut = av.months.find((r) => r.kind === 'gap' && r.state === 'future');
  assert.deepEqual(fut && [fut.from, fut.to], ['2026-12', '2027-03']);
});
