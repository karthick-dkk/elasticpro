/**
 * Indices › Summary (ui/js/core/indices-summary.js): the days each button shows, the one
 * average (missing days left out and counted, never a 0), a tag1 value's share of a day, the
 * chart's date labels and months, and the day's status. Pure: the record is a plain object.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'customElements', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
const X = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/indices-summary.js')).href);
const { volumeAnswer, GAP_DAYS_AGO } = await import(pathToFileURL(path.join(ROOT, 'tools/lib/volume-fixture.mjs')).href);

const TODAY = '2026-11-17';
const pts = (list) => list.map(([day, value]) => ({ day, value }));

test('each day button is a window of that many days ending today, oldest first', () => {
  for (const n of [15, 30, 60, 90]) {
    const w = X.dayWindow(n, TODAY);
    assert.equal(w.length, n);
    assert.equal(w[w.length - 1], TODAY);
  }
  assert.equal(X.dayWindow(15, TODAY)[0], '2026-11-03');
  assert.equal(X.dayWindow(30, TODAY)[0], '2026-10-19');
  assert.equal(X.dayWindow(90, TODAY)[0], '2026-08-20');
  // Anything else is the default, 15.
  assert.equal(X.dayWindow(7, TODAY).length, X.DEFAULT_DAYS);
  assert.deepEqual(X.DAY_CHOICES, [15, 30, 60, 90]);
  // The record asked for covers the widest window and the line's 7 days before it.
  assert.ok(X.RECORD_DAYS >= 90 + X.LINE_AVG_DAYS);
});

test('the average per day: the finished days before, today never counted', () => {
  const p = pts([['2026-11-14', 100], ['2026-11-15', 200], ['2026-11-16', 300], ['2026-11-17', 9999]]);
  const a = X.avgPerDay(p, 3, { today: TODAY });
  assert.equal(a.value, 200);
  assert.equal(a.measured, 3);
  assert.equal(a.of, 3);
  assert.equal(a.from, '2026-11-14');
  assert.equal(a.to, '2026-11-16');
});

test('a day missing from the record is left out and counted, never a 0', () => {
  // 7 days asked, 5 in the record, one of them with its size not measured (null).
  const p = pts([['2026-11-10', 100], ['2026-11-11', 100], ['2026-11-13', 400], ['2026-11-15', null], ['2026-11-16', 100]]);
  const a = X.avgPerDay(p, 7, { today: TODAY });
  assert.equal(a.measured, 4);
  assert.equal(a.of, 7);
  assert.equal(a.value, 175);   // (100+100+400+100)/4, not /7
  // Nothing recorded: unknown, not zero.
  const none = X.avgPerDay([], 30, { today: TODAY });
  assert.equal(none.value, null);
  assert.equal(none.measured, 0);
});

test('the average for a day is over the days before it (the line, the tooltip, the CSV)', () => {
  const p = pts([['2026-11-01', 10], ['2026-11-02', 20], ['2026-11-03', 30], ['2026-11-04', 1000]]);
  assert.equal(X.avgPerDay(p, 3, { today: TODAY, before: '2026-11-04' }).value, 20);
  assert.equal(X.avgPerDay(p, 3, { today: TODAY, before: '2026-11-01' }).value, null);
});

test('the fixture record: 60 days with one missing says 59 of 60', () => {
  const now = Date.parse(`${TODAY}T12:00:00Z`);
  const rec = volumeAnswer({ type: 'VOLUME_DAILY', days: X.RECORD_DAYS }, { now });
  const p = X.basisPoints(rec);
  assert.ok(p.length >= 90);
  const a60 = X.avgPerDay(p, 60, { today: TODAY });
  assert.ok(GAP_DAYS_AGO <= 60);
  assert.equal(a60.of, 60);
  assert.equal(a60.measured, 59);
  const a7 = X.avgPerDay(p, 7, { today: TODAY });
  assert.equal(a7.measured, 7);
  // Points are on the size basis (primary by default): the core's `basis`.
  assert.equal(p[p.length - 1].value, rec.days.find((d) => d.day === TODAY).basis);
});

test('a tag1 value\'s size is its share of the day\'s documents × the day\'s size', () => {
  assert.equal(X.tagShareBytes(25, 100, 4000), 1000);
  assert.equal(X.tagShareBytes(0, 100, 4000), 0);
  // Unknown parts make the answer unknown, never 0.
  assert.equal(X.tagShareBytes(null, 100, 4000), null);
  assert.equal(X.tagShareBytes(25, 0, 4000), null);
  assert.equal(X.tagShareBytes(25, 100, null), null);
});

test('on primary size the share rule is the core\'s breakdown estimate for that day', () => {
  const now = Date.parse(`${TODAY}T12:00:00Z`);
  const rec = volumeAnswer({ type: 'VOLUME_DAILY', days: 30 }, { now });
  const day = rec.days[3];
  const bd = volumeAnswer({ type: 'VOLUME_BREAKDOWN', field: 'tag', from: day.day, to: day.day, top: 100 }, { now });
  for (const r of bd.rows.filter((x) => x.kind === 'value')) {
    assert.ok(Math.abs(X.tagShareBytes(X.valueDocsOn(bd, r.value), day.docs, day.basis) - r.estPriBytes) <= 1, r.value);
  }
});

test('a value\'s documents on a day: its row, 0 when every value was kept, unknown when it may be in "all others"', () => {
  const reply = { rows: [{ value: 'fw', kind: 'value', docs: 40 }, { value: '(not set)', kind: 'missing', docs: 5 }, { value: 'all others', kind: 'other', docs: 0 }] };
  assert.equal(X.valueDocsOn(reply, 'fw'), 40);
  assert.equal(X.valueDocsOn(reply, 'vpn'), 0);
  const folded = { rows: [{ value: 'fw', kind: 'value', docs: 40 }, { value: 'all others', kind: 'other', docs: 12 }] };
  assert.equal(X.valueDocsOn(folded, 'vpn'), null);
  assert.equal(X.valueDocsOn({ error: 'no field', rows: [] }, 'fw'), null);
  assert.equal(X.valueDocsOn(null, 'fw'), null);
  // The rest: every row not named, "(not set)" and "all others" included.
  assert.equal(X.restDocsOn(reply, ['fw']), 5);
});

test('the ranking is the core\'s: values only, most documents first; a missing field is an error', () => {
  const r = X.rankedValues({ rows: [{ value: 'a', kind: 'value', docs: 9 }, { value: 'b', kind: 'value', docs: 3 }, { value: 'z', kind: 'value', docs: 0 },
    { value: '(not set)', kind: 'missing', docs: 50 }, { value: 'all others', kind: 'other', docs: 7 }] });
  assert.deepEqual(r.values, ['a', 'b']);
  assert.equal(r.error, null);
  const e = X.rankedValues({ error: 'no field of tag1 in the mapping', rows: [] });
  assert.deepEqual(e.values, []);
  assert.match(e.error, /no field/);
});

test('dates read "03 Nov", the month once under its days, two months when the range spans two', () => {
  assert.equal(X.dayMonth('2026-11-03'), '03 Nov');
  assert.equal(X.dayMonth('2026-01-21'), '21 Jan');
  const one = X.monthSpans(X.dayWindow(15, TODAY));
  assert.deepEqual(one.map((m) => m.label), ['November 2026']);
  const two = X.monthSpans(X.dayWindow(30, TODAY));
  assert.deepEqual(two.map((m) => m.label), ['October 2026', 'November 2026']);
  assert.equal(two[0].first, 0);
  assert.equal(two[1].last, 29);
  assert.equal(two[0].last + 1, two[1].first);
  assert.deepEqual(X.monthSpans(['2026-12-31', '2027-01-01']).map((m) => m.label), ['December 2026', 'January 2027']);
});

test('date labels are thinned for 60 and 90 days so they never collide; today always has its own', () => {
  const plot = 934;   // the chart's plot width in its own units
  assert.equal(X.labelStep(15, plot), 1);
  assert.equal(X.labelStep(30, plot), 2);
  const s60 = X.labelStep(60, plot);
  const s90 = X.labelStep(90, plot);
  assert.ok(s60 >= 3 && s90 > s60);
  for (const [n, s] of [[60, s60], [90, s90]]) {
    const at = X.labelledBars(n, s);
    assert.equal(at[at.length - 1], n - 1);
    // Room for each: the gap between two labelled bars is at least a label's width.
    const slot = plot / n;
    for (let i = 1; i < at.length; i++) assert.ok((at[i] - at[i - 1]) * slot >= 46);
  }
  assert.deepEqual(X.labelledBars(5, 1), [0, 1, 2, 3, 4]);
  assert.deepEqual(X.labelledBars(5, 2), [0, 2, 4]);
});

test('a day\'s status: final, today so far, not measured, or what went wrong', () => {
  const ok = { day: '2026-11-15', final: true, priBytes: 5, basis: 5 };
  assert.equal(X.sizeDayStatus(ok, 'primary', { today: TODAY }).text, 'final');
  assert.equal(X.sizeDayStatus({ ...ok, day: TODAY, final: false }, 'primary', { today: TODAY }).text, 'today so far');
  assert.equal(X.sizeDayStatus(null, 'primary', { today: TODAY }).text, 'not measured');
  assert.equal(X.sizeDayStatus({ day: '2026-11-15', final: true, priBytes: null, basis: null }, 'primary', { today: TODAY }).text, 'not measured');
  assert.match(X.sizeDayStatus({ ...ok, final: false, error: '2 of 28 shards failed (timeout)' }, 'primary', { today: TODAY }).text, /2 of 28 shards failed/);
});
