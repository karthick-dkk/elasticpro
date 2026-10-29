/**
 * The column model the volume tables share (ui/js/lib/columns.js): hide, show, move,
 * rename, reset, drag — and the locked column that names the row, which none of them may
 * hide or move. The layout is what the core stores, so what comes out of every edit must
 * be a complete, explicit layout a second browser reads the same way.
 *
 * The module also holds the renderer, so jsdom provides a document; the model functions
 * themselves touch none of it.
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
const C = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/columns.js')).href);

const DEFS = [
  { key: 'day', label: 'Index day', locked: true },
  { key: 'indices', label: 'Indices', num: true },
  { key: 'docs', label: 'Documents', num: true },
  { key: 'priBytes', label: 'Primary size', num: true },
  { key: 'eventBytes', label: 'Event bytes', num: true },
  { key: 'totalBytes', label: 'Total size', num: true, hidden: true },
];
const keys = (layout) => C.visibleColumns(DEFS, layout).map((c) => c.key);

test('nothing decided: default order, hidden-by-default columns stay hidden', () => {
  assert.deepEqual(keys(null), ['day', 'indices', 'docs', 'priBytes', 'eventBytes']);
  assert.deepEqual(keys(C.emptyLayout()), ['day', 'indices', 'docs', 'priBytes', 'eventBytes']);
  assert.equal(C.countLabel(DEFS, null), '5/6');
});

test('hide and show one column; every edit writes the full layout', () => {
  const l = C.setShown(DEFS, null, 'docs', false);
  assert.deepEqual(keys(l), ['day', 'indices', 'priBytes', 'eventBytes']);
  assert.deepEqual(l.order, ['day', 'indices', 'docs', 'priBytes', 'eventBytes', 'totalBytes']);
  assert.deepEqual(l.hidden.sort(), ['docs', 'totalBytes']);
  const back = C.setShown(DEFS, l, 'docs', true);
  assert.deepEqual(keys(back), ['day', 'indices', 'docs', 'priBytes', 'eventBytes']);
});

test('show all shows the hidden-by-default ones too', () => {
  const l = C.showAll(DEFS, C.setShown(DEFS, null, 'docs', false));
  assert.deepEqual(keys(l), ['day', 'indices', 'docs', 'priBytes', 'eventBytes', 'totalBytes']);
  assert.deepEqual(l.hidden, []);
});

test('the locked column can be neither hidden nor moved, and stays first', () => {
  assert.deepEqual(keys(C.setShown(DEFS, null, 'day', false))[0], 'day');
  assert.deepEqual(keys(C.moveTo(DEFS, null, 'day', 3))[0], 'day');
  assert.deepEqual(keys(C.moveBy(DEFS, null, 'day', 1))[0], 'day');
  // Something else moved to the very front lands after it.
  assert.deepEqual(keys(C.moveTo(DEFS, null, 'eventBytes', 0)), ['day', 'eventBytes', 'indices', 'docs', 'priBytes']);
  // A stored order that puts it elsewhere is ignored.
  assert.deepEqual(keys({ order: ['docs', 'day', 'indices'], hidden: [], labels: {} })[0], 'day');
});

test('move left and right step past the column you can see, not a hidden one', () => {
  const l = C.setShown(DEFS, null, 'docs', false);
  assert.deepEqual(keys(C.moveBy(DEFS, l, 'priBytes', -1)), ['day', 'priBytes', 'indices', 'eventBytes']);
  assert.deepEqual(keys(C.moveBy(DEFS, l, 'indices', 1)), ['day', 'priBytes', 'indices', 'eventBytes']);
  // At the edges nothing happens.
  assert.deepEqual(keys(C.moveBy(DEFS, l, 'indices', -1)), keys(l));
  assert.deepEqual(keys(C.moveBy(DEFS, l, 'eventBytes', 1)), keys(l));
});

test('dropping a header on another takes that column\'s place', () => {
  assert.deepEqual(keys(C.dropOn(DEFS, null, 'eventBytes', 'indices')), ['day', 'eventBytes', 'indices', 'docs', 'priBytes']);
  assert.deepEqual(keys(C.dropOn(DEFS, null, 'indices', 'priBytes')), ['day', 'docs', 'priBytes', 'indices', 'eventBytes']);
  // Onto the locked column, onto itself, or an unknown key: nothing moves.
  assert.deepEqual(keys(C.dropOn(DEFS, null, 'docs', 'day')), keys(null));
  assert.deepEqual(keys(C.dropOn(DEFS, null, 'docs', 'docs')), keys(null));
  assert.deepEqual(keys(C.dropOn(DEFS, null, 'nope', 'docs')), keys(null));
});

test('rename, rename back to the default, and reset', () => {
  let l = C.rename(DEFS, null, 'priBytes', '  Primary GB ');
  const col = C.resolveColumns(DEFS, l).find((c) => c.key === 'priBytes');
  assert.equal(col.name, 'Primary GB');
  assert.equal(col.renamed, true);
  assert.equal(col.label, 'Primary size', 'the default name is kept for reset and for the CSV');
  assert.deepEqual(C.rename(DEFS, l, 'priBytes', 'Primary size').labels, {}, 'typing the default back clears it');
  assert.deepEqual(C.rename(DEFS, l, 'priBytes', '   ').labels, {}, 'empty means the default');
  l = C.resetName(DEFS, l, 'priBytes');
  assert.deepEqual(l.labels, {});
  // The locked column may be renamed.
  assert.equal(C.resolveColumns(DEFS, C.rename(DEFS, null, 'day', 'Day')).find((c) => c.key === 'day').name, 'Day');
  // Long names are cut, not refused.
  assert.equal(C.rename(DEFS, null, 'docs', 'x'.repeat(100)).labels.docs.length, C.MAX_LABEL);
});

test('a stored layout from another version: unknown keys dropped, new columns at their default place', () => {
  const stored = { order: ['day', 'priBytes', 'indices', 'gone'], hidden: ['gone'], labels: { gone: 'x', indices: 'Idx' } };
  const cols = C.resolveColumns(DEFS, stored);
  assert.deepEqual(cols.map((c) => c.key), ['day', 'priBytes', 'eventBytes', 'totalBytes', 'indices', 'docs']);
  // docs and eventBytes are new to this layout: shown (their default); totalBytes stays hidden by default.
  assert.deepEqual(cols.filter((c) => c.visible).map((c) => c.key), ['day', 'priBytes', 'eventBytes', 'indices', 'docs']);
  assert.equal(cols.find((c) => c.key === 'indices').name, 'Idx');
  assert.deepEqual(C.sanitizeLayout(stored, DEFS).labels, { indices: 'Idx' });
});

test('junk in, defaults out', () => {
  for (const junk of [undefined, null, 'x', 5, [], { order: 'a', hidden: {}, labels: [] }]) {
    assert.deepEqual(keys(junk), ['day', 'indices', 'docs', 'priBytes', 'eventBytes'], JSON.stringify(junk));
  }
});

test('the renderer: no menu or dragging when the caller cannot edit', () => {
  const rows = [{ day: '2026-10-28', indices: 2 }];
  const cell = (k, r) => String(r[k] ?? '');
  const ro = C.columnTable({ defs: DEFS, layout: null, rows, cell, canEdit: false, onChange: () => {} });
  assert.equal(ro.querySelectorAll('.colhead-menu').length, 0);
  assert.equal(ro.querySelectorAll('th[draggable="true"]').length, 0);
  const rw = C.columnTable({ defs: DEFS, layout: null, rows, cell, canEdit: true, onChange: () => {} });
  assert.equal(rw.querySelectorAll('.colhead-menu').length, 5);
  assert.equal(rw.querySelectorAll('th[draggable="true"]').length, 4, 'every column but the locked one');
  assert.deepEqual([...rw.querySelectorAll('thead th .colhead-name')].map((x) => x.textContent),
    ['Index day', 'Indices', 'Documents', 'Primary size', 'Event bytes']);
  assert.match(C.columnsButton({ defs: DEFS, layout: null, onChange: () => {} }).textContent, /^Columns \(5\/6\)/);
});
