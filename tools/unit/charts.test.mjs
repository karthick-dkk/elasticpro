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
