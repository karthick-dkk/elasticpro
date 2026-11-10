/**
 * The remembered order of a table (ui/js/lib/table-sort.js): a header press is written to the
 * browser, a link's order (one node's shards, largest first) lasts one visit and is never
 * written, and storage that throws only means the table opens in its default order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const store = new Map();
let broken = false;
globalThis.window = {
  localStorage: {
    getItem: (k) => { if (broken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('blocked'); store.set(k, String(v)); },
  },
};
const { tableSort, resetTableSorts } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/table-sort.js')).href);
const COLS = { index: { type: 'text' }, store: { type: 'bytes' } };
const rows = [{ index: 'b', store: 1 }, { index: 'a', store: 9 }, { index: 'c', store: null }];

test('a header press is remembered and read back on the next load', () => {
  store.clear(); resetTableSorts();
  const s = tableSort('t1', { initial: { key: 'index', dir: 1 } });
  assert.deepEqual(s.apply(rows, COLS).map((r) => r.index), ['a', 'b', 'c']);
  s.on('store');
  assert.equal(store.get('elasticpro.sort.t1'), JSON.stringify({ key: 'store', dir: 1 }));
  resetTableSorts();
  const again = tableSort('t1', { initial: { key: 'index', dir: 1 } });
  again.apply([], COLS);
  assert.deepEqual(again.sort, { key: 'store', dir: 1 });
});

test('a link\'s order lasts the visit and never overwrites the remembered one', () => {
  store.clear(); resetTableSorts();
  const s = tableSort('t2', { initial: { key: 'index', dir: 1 } });
  s.on('index');                                   // remembered: index, descending
  const remembered = store.get('elasticpro.sort.t2');
  s.forVisit({ key: 'store', dir: -1 });
  assert.equal(s.visiting, true);
  assert.deepEqual(s.apply(rows, COLS).map((r) => r.index), ['a', 'b', 'c'], 'largest first, unknown last');
  assert.equal(store.get('elasticpro.sort.t2'), remembered, 'the link wrote nothing');
  s.forVisit(null);                                // the next ordinary visit
  assert.deepEqual(s.sort, { key: 'index', dir: -1 });
  resetTableSorts();
  assert.deepEqual(tableSort('t2', { initial: { key: 'index', dir: 1 } }).sort, { key: 'index', dir: -1 });
});

test('a header pressed during a link\'s visit starts from what is on screen and is remembered', () => {
  store.clear(); resetTableSorts();
  const s = tableSort('t3', { initial: { key: 'index', dir: 1 } });
  s.apply(rows, COLS);
  s.forVisit({ key: 'store', dir: -1 });
  s.on('store');                                   // reverses the shown order
  assert.equal(s.visiting, false);
  assert.deepEqual(s.sort, { key: 'store', dir: 1 });
  assert.equal(store.get('elasticpro.sort.t3'), JSON.stringify({ key: 'store', dir: 1 }));
});

test('storage that throws: the default order, and sorting still works', () => {
  store.clear(); resetTableSorts(); broken = true;
  try {
    const s = tableSort('t4', { initial: { key: 'index', dir: 1 } });
    assert.deepEqual(s.sort, { key: 'index', dir: 1 });
    s.apply(rows, COLS);
    s.on('index');
    assert.deepEqual(s.sort, { key: 'index', dir: -1 });
  } finally { broken = false; }
});
