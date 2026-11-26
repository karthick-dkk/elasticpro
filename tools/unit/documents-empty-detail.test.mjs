/**
 * Indices › Documents, the empty note (0.3.100): "the indices hold no documents" only when
 * nothing narrowed the search; a custom range is named with its dates, never left out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: globalThis.localStorage };
const { emptyDetail } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/documents-view.js')).href);
const { dt } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/fmt.js')).href);

test('no query and no window: the indices hold no documents', () => {
  assert.equal(emptyDetail({ query: '', range: 'custom' }, null), 'The indices matched hold no documents');
});

test('custom dates are named; an open end says so', () => {
  const from = Date.UTC(2026, 9, 13), to = Date.UTC(2026, 9, 14);
  assert.equal(emptyDetail({ query: '', range: 'custom' }, { from, to }),
    `Query "*" between ${dt(from)} and ${dt(to)} — widen the time range or clear the query`);
  assert.match(emptyDetail({ query: '', range: 'custom' }, { from, to: null }), /and the newest/);
  assert.match(emptyDetail({ query: 'level:error', range: 'custom' }, { from: null, to }), /^Query "level:error" between the oldest and /);
});

test('a preset reads as before; a query alone names no range', () => {
  assert.equal(emptyDetail({ query: 'x', range: '24h' }, { from: 1, to: 2 }), 'Query "x" in the last 24h — widen the time range or clear the query');
  assert.equal(emptyDetail({ query: 'x', range: 'custom' }, null), 'Query "x" — widen the time range or clear the query');
});
