/**
 * The split gauge's arithmetic.
 *
 * Drawing is checked by render-check and behaviour-check; what belongs here is the part
 * that decides what the picture claims — how a total is divided, and what happens when
 * the parts do not account for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

// charts.js builds DOM. A minimal document is enough for these — no layout, no styling,
// just enough for the element tree the assertions read.
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Node', 'Element', 'SVGElement', 'HTMLElement', 'customElements']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { splitGauge } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/charts.js')).href);

const legendOf = (el) => [...el.querySelectorAll('div[title]')].map((d) => d.getAttribute('title'));
const arcs = (el) => [...el.querySelectorAll('path')];

test('every segment is listed, including the ones that are zero', () => {
  // "0 unassigned" is the reassurance the page is opened for. A legend that drops it
  // makes its absence indistinguishable from the chart not knowing.
  const g = splitGauge([
    { key: 'a', label: 'assigned', value: 8, color: 'green' },
    { key: 'm', label: 'moving', value: 0, color: 'orange' },
    { key: 'u', label: 'unassigned', value: 0, color: 'red' },
  ], { total: 8 });
  const marks = legendOf(g);
  assert.equal(marks.length, 3);
  assert.ok(marks.some((t) => /unassigned: 0/.test(t)), marks.join(' | '));
  assert.ok(marks.some((t) => /moving: 0/.test(t)), marks.join(' | '));
});

test('a zero segment draws no arc, so the picture is not a lie', () => {
  const g = splitGauge([
    { key: 'a', label: 'assigned', value: 5, color: 'green' },
    { key: 'u', label: 'unassigned', value: 0, color: 'red' },
  ], { total: 5 });
  // one track + one segment
  assert.equal(arcs(g).length, 2);
});

test('the centre shows the total, not the sum of what was drawn', () => {
  const g = splitGauge([{ key: 'a', label: 'assigned', value: 3, color: 'green' }], { total: 10 });
  assert.match(g.textContent, /10/);
  // The unaccounted seven stays on the grey track rather than being shared out.
  assert.equal(arcs(g).length, 2);
});

test('an empty total draws a track and nothing else', () => {
  const g = splitGauge([{ key: 'a', label: 'assigned', value: 0, color: 'green' }], { total: 0 });
  assert.equal(arcs(g).length, 1, 'no segment can be drawn against a zero total');
  assert.match(g.textContent, /0/);
});

test('a negative or missing value is treated as none, never as a subtraction', () => {
  const g = splitGauge([
    { key: 'a', label: 'assigned', value: -4, color: 'green' },
    { key: 'u', label: 'unassigned', value: undefined, color: 'red' },
  ], { total: 6 });
  assert.equal(arcs(g).length, 1);
  assert.ok(legendOf(g).every((t) => /: 0$/.test(t)), legendOf(g).join(' | '));
});

test('with no explicit total the parts are the total', () => {
  const g = splitGauge([
    { key: 'a', label: 'assigned', value: 7, color: 'green' },
    { key: 'u', label: 'unassigned', value: 3, color: 'red' },
  ]);
  assert.match(g.textContent, /10/);
});

// Regression: ISSUE-A — the Live logs chart said "No documents in this range" above a list
// of matching documents when the cluster sent hits but no time buckets.
// Found by /qa on 2026-10-13
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-10-13.md
const { histogramEmptyText, timeHistogram } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/charts.js')).href);

test('an empty histogram says "no documents" only when there are none', () => {
  assert.equal(histogramEmptyText(0), 'No documents in this range');
  assert.equal(histogramEmptyText(undefined), 'No documents in this range');
  assert.match(histogramEmptyText(2, '@timestamp'), /No time buckets came back for the 2 matching documents on @timestamp/);
  assert.match(histogramEmptyText(1), /the 1 matching document —/, 'singular, and no field when none is known');
  assert.match(histogramEmptyText(2), /the list below is complete/);
});

test('timeHistogram shows the caller\'s empty text, and the default without one', () => {
  assert.equal(timeHistogram([], { emptyText: 'custom' }).textContent, 'custom');
  assert.equal(timeHistogram([]).textContent, 'No documents in this range');
});

// The volume line (Indices › Summary): what the picture claims about gaps, the average
// and the peak. The figures are the core's; the chart must neither invent nor drop one.
const { lineChart, signedPct } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/charts.js')).href);
const pt = (i, value, extra = {}) => ({ key: `d${i}`, label: `D${i}`, value, ...extra });
const lines = (el) => [...el.querySelectorAll('path.lc-line')];

test('lineChart draws one line through known points, with an area under it', () => {
  const el = lineChart([pt(0, 10), pt(1, 20), pt(2, 15)]);
  assert.equal(lines(el).length, 1);
  assert.equal(el.querySelectorAll('path.lc-area').length, 1);
  assert.equal((lines(el)[0].getAttribute('d').match(/[ML]/g) || []).length, 3);
});

test('a missing value is a gap, never a dip to zero', () => {
  const el = lineChart([pt(0, 10), pt(1, 20), pt(2, null), pt(3, 30), pt(4, 25)]);
  const ls = lines(el);
  assert.equal(ls.length, 2, 'two runs either side of the gap');
  assert.ok(ls.every((p) => (p.getAttribute('d').match(/M/g) || []).length === 1));
  // A lone point between gaps still shows, as a dot.
  const lone = lineChart([pt(0, null), pt(1, 5), pt(2, null)]);
  assert.equal(lone.querySelectorAll('circle.lc-dot').length, 1);
});

test('the dashed average follows each point\'s own average, and only when there is one', () => {
  const withAvg = lineChart([pt(0, 10, { avg: 12 }), pt(1, 20, { avg: 13 }), pt(2, 15, { avg: 14 })]);
  assert.equal(withAvg.querySelectorAll('path.lc-avg').length, 1);
  assert.equal(lineChart([pt(0, 10), pt(1, 20)]).querySelectorAll('path.lc-avg').length, 0);
});

test('the peak is named with its day, its size and its change against the average', () => {
  const fmt = (v) => `${v} B`;
  const el = lineChart([pt(0, 10, { changePct: 1 }), pt(1, 40, { changePct: 61.04 }), pt(2, 15)], { formatY: fmt });
  const label = el.querySelector('text.lc-peak-label').textContent;
  assert.equal(label, '▲ D1 · 40 B · +61.0 %');
  // Without a change the label says only what is known.
  const plain = lineChart([pt(0, 3), pt(1, 9)], { formatY: fmt }).querySelector('text.lc-peak-label').textContent;
  assert.equal(plain, '▲ D1 · 9 B');
});

test('five dates along the bottom, the first and the last among them', () => {
  const pts = Array.from({ length: 30 }, (_, i) => pt(i, i + 1));
  const xs = [...lineChart(pts).querySelectorAll('g.lc-x text')].map((t) => t.textContent);
  assert.equal(xs.length, 5);
  assert.equal(xs[0], 'D0');
  assert.equal(xs[4], 'D29');
  assert.equal([...lineChart([pt(0, 1), pt(1, 2)]).querySelectorAll('g.lc-x text')].length, 2, 'no repeats when there are fewer points');
});

test('nothing known: the caller\'s empty text, not an empty frame', () => {
  assert.equal(lineChart([pt(0, null), pt(1, null)], { emptyText: 'No finished day recorded yet' }).textContent, 'No finished day recorded yet');
  assert.equal(lineChart([]).textContent, 'Nothing recorded yet');
});

test('signedPct always writes the sign, and an unknown as a dash', () => {
  assert.equal(signedPct(12.345), '+12.3 %');
  assert.equal(signedPct(-4), '-4.0 %');
  assert.equal(signedPct(0), '+0.0 %');
  assert.equal(signedPct(null), '–');
});
