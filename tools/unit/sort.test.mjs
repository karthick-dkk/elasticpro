/**
 * The one column sort (ui/js/core/sort.js): how each kind of value compares, that an unknown
 * sorts last whichever way the column runs (unknown is not zero), natural text order, and
 * where a header click goes next.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { sortValue, isUnknown, compareValues, sortRows, nextSort, ariaSort, sortArrow, validSort } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/sort.js')).href);
const { compareNullLast } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/sort-order.js')).href);

const by = (type, values, dir = 1) => sortRows(values.map((v) => ({ v })), { key: 'v', dir }, { v: { type } }).map((r) => r.v);

test('unknown markers are unknown, a zero is not', () => {
  for (const v of [null, undefined, NaN, '', '  ', '—', '–', '-', 'not measured', 'Not measured', '[set]', 'unknown', 'n/a', new Date('nope')]) {
    assert.equal(isUnknown(v), true, `${String(v)} should be unknown`);
  }
  for (const v of [0, '0', 'node1', -1, false, new Date(0)]) assert.equal(isUnknown(v), false, `${String(v)} should be known`);
  assert.equal(sortValue(0, 'number'), 0);
  assert.equal(sortValue('0 B', 'bytes'), 0);
});

test('an unknown sorts last ascending AND descending, never as zero', () => {
  const vals = [5, null, 0, 'not measured', -3, NaN, '[set]', 12];
  assert.deepEqual(by('number', vals, 1).slice(0, 4), [-3, 0, 5, 12]);
  assert.deepEqual(by('number', vals, -1).slice(0, 4), [12, 5, 0, -3]);
  for (const dir of [1, -1]) {
    const out = by('number', vals, dir);
    assert.ok(out.slice(4).every((v) => isUnknown(v)), `dir ${dir}: unknowns not last: ${out}`);
  }
  // the same for text, sizes, dates
  assert.equal(by('text', ['b', '—', 'a'], -1)[2], '—');
  assert.equal(by('bytes', ['not measured', '1 GB', '2 GB'], 1)[2], 'not measured');
  assert.equal(by('date', [null, '2026-01-01', '2025-01-01'], -1)[2], null);
  assert.equal(compareValues(null, 0, 'number', -1), 1);
  assert.equal(compareValues(0, null, 'number', -1), -1);
  assert.equal(compareValues(null, undefined, 'number', 1), 0);
});

test('text is natural: node2 before node10, case and accents ignored', () => {
  assert.deepEqual(by('text', ['node10', 'node2', 'Node1', 'node-3']), ['node-3', 'Node1', 'node2', 'node10']);
  assert.deepEqual(by('text', ['es-node-10', 'es-node-9', 'es-node-100']), ['es-node-9', 'es-node-10', 'es-node-100']);
  assert.deepEqual(by('text', ['beta', 'Alpha', 'café', 'cafe']).slice(0, 1), ['Alpha']);
  assert.deepEqual(by('text', ['b', 'a', 'c'], -1), ['c', 'b', 'a']);
});

test('sizes compare by what they are, not by their text', () => {
  assert.deepEqual(by('bytes', ['1 TB', '900 GB', '2 GB', '512 MB', '1.5 TB']), ['512 MB', '2 GB', '900 GB', '1 TB', '1.5 TB']);
  assert.equal(sortValue('1 KB', 'bytes'), 1024);
  assert.equal(sortValue('1 GiB', 'bytes'), 1024 ** 3);
  assert.equal(sortValue('12.3GB', 'bytes'), 12.3 * 1024 ** 3);
  assert.equal(sortValue(2048, 'bytes'), 2048);
  assert.equal(sortValue('3 bananas', 'bytes'), null);
});

test('percentages, numbers with separators', () => {
  assert.deepEqual(by('percent', ['9 %', '45.5%', '100 %', '10%']), ['9 %', '10%', '45.5%', '100 %']);
  assert.equal(sortValue('1,234', 'number'), 1234);
  assert.equal(sortValue('12 docs', 'number'), 12);
  assert.equal(sortValue('-4.5', 'number'), -4.5);
  assert.equal(sortValue('abc', 'number'), null);
});

test('durations: ms, s, m, h, d, compound and clock forms', () => {
  assert.equal(sortValue('350 ms', 'duration'), 350);
  assert.equal(sortValue('1.5 s', 'duration'), 1500);
  assert.equal(sortValue('3m 20s', 'duration'), 200000);
  assert.equal(sortValue('2 h', 'duration'), 7200000);
  assert.equal(sortValue('1 d', 'duration'), 86400000);
  assert.equal(sortValue('01:02:03', 'duration'), 3723000);
  assert.deepEqual(by('duration', ['2 h', '90 s', '1.0 d', '350 ms', '45 m']), ['350 ms', '90 s', '45 m', '2 h', '1.0 d']);
});

test('dates: Date, epoch ms and ISO text', () => {
  const d = new Date('2026-11-10T00:00:00Z');
  assert.equal(sortValue(d, 'date'), d.getTime());
  assert.equal(sortValue('2026-11-10T00:00:00Z', 'date'), d.getTime());
  assert.equal(sortValue(d.getTime(), 'date'), d.getTime());
  assert.deepEqual(by('date', ['2026-11-10', '2025-01-01', '2026-02-03']), ['2025-01-01', '2026-02-03', '2026-11-10']);
});

test('the sort is stable: equal rows keep the order they came in', () => {
  const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 0 }, { id: 'c', v: 1 }, { id: 'd', v: null }, { id: 'e', v: 1 }];
  const cols = { v: { type: 'number' } };
  assert.deepEqual(sortRows(rows, { key: 'v', dir: 1 }, cols).map((r) => r.id), ['b', 'a', 'c', 'e', 'd']);
  assert.deepEqual(sortRows(rows, { key: 'v', dir: -1 }, cols).map((r) => r.id), ['a', 'c', 'e', 'b', 'd']);
});

test('the underlying value is read through the column, and no sort leaves the order alone', () => {
  const rows = [{ n: 'x', size: 10 }, { n: 'y', size: 2 }];
  const cols = { size: { type: 'bytes', value: (r) => r.size } };
  assert.deepEqual(sortRows(rows, { key: 'size', dir: 1 }, cols).map((r) => r.n), ['y', 'x']);
  assert.deepEqual(sortRows(rows, null, cols).map((r) => r.n), ['x', 'y']);
  assert.deepEqual(sortRows(rows, { key: 'nope', dir: 1 }, cols).map((r) => r.n), ['x', 'y']);
  assert.notEqual(sortRows(rows, null, cols), rows, 'a copy, never the caller\'s array');
});

test('a header click: new column in its first direction, again reverses, a natural order comes back third', () => {
  assert.deepEqual(nextSort(null, 'a'), { key: 'a', dir: 1 });
  assert.deepEqual(nextSort({ key: 'a', dir: 1 }, 'a'), { key: 'a', dir: -1 });
  assert.deepEqual(nextSort({ key: 'a', dir: -1 }, 'a'), { key: 'a', dir: 1 });
  assert.deepEqual(nextSort({ key: 'a', dir: -1 }, 'b', { start: -1 }), { key: 'b', dir: -1 });
  assert.deepEqual(nextSort({ key: 'a', dir: 1 }, 'a', { natural: true }), { key: 'a', dir: -1 });
  assert.equal(nextSort({ key: 'a', dir: -1 }, 'a', { natural: true }), null);
});

test('aria-sort, the arrow, and a stored order checked before use', () => {
  assert.equal(ariaSort({ key: 'a', dir: 1 }, 'a'), 'ascending');
  assert.equal(ariaSort({ key: 'a', dir: -1 }, 'a'), 'descending');
  assert.equal(ariaSort({ key: 'a', dir: 1 }, 'b'), 'none');
  assert.equal(ariaSort(null, 'a'), 'none');
  assert.equal(sortArrow({ key: 'a', dir: 1 }, 'a'), '▲');
  assert.equal(sortArrow({ key: 'a', dir: -1 }, 'a'), '▼');
  assert.equal(sortArrow({ key: 'a', dir: -1 }, 'b'), '');
  assert.deepEqual(validSort({ key: 'a', dir: -1 }, ['a']), { key: 'a', dir: -1 });
  assert.equal(validSort({ key: 'a', dir: 2 }), null);
  assert.equal(validSort({ key: 'z', dir: 1 }, ['a']), null);
  assert.equal(validSort('a:1'), null);
});

test('compareNullLast (lib/sort-order.js) is the same rule', () => {
  assert.equal(compareNullLast(null, 1, 1), 1);
  assert.equal(compareNullLast(null, 1, -1), 1);
  assert.equal(compareNullLast(1, null, -1), -1);
  assert.equal(compareNullLast(NaN, 1, -1), 1);
  assert.ok(compareNullLast(1, 2, 1) < 0);
  assert.ok(compareNullLast(1, 2, -1) > 0);
  assert.ok(compareNullLast('a', 'b', 1) < 0);
});
