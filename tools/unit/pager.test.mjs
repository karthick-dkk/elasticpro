/**
 * Table paging arithmetic.
 *
 * The case that matters is filtering: someone on page 7 types a search that matches
 * four rows. Without clamping they land on an empty page 7, which reads as "no results"
 * — the filter looks broken when it worked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { pageSlice, clampPage, pageCount } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/pager.js')).href);

const rows = (n) => Array.from({ length: n }, (_, i) => i);

test('a full page reports its 1-based inclusive range', () => {
  const s = pageSlice(rows(120), 0, 50);
  assert.deepEqual(s.rows, rows(50));
  assert.equal(s.first, 1);
  assert.equal(s.last, 50);
  assert.equal(s.pages, 3);
});

test('the last page is short, not padded', () => {
  const s = pageSlice(rows(120), 2, 50);
  assert.equal(s.rows.length, 20);
  assert.equal(s.first, 101);
  assert.equal(s.last, 120);
});

test('a page beyond the end clamps to the last page that exists', () => {
  const s = pageSlice(rows(4), 7, 50);
  assert.equal(s.page, 0, 'four rows have exactly one page');
  assert.equal(s.rows.length, 4);
});

test('no rows reports 0-0, not 1-0', () => {
  const s = pageSlice([], 0, 50);
  assert.equal(s.first, 0);
  assert.equal(s.last, 0);
  assert.equal(s.total, 0);
  assert.equal(s.pages, 1, 'there is always one page, even an empty one');
});

test('negative and nonsense pages land on the first page', () => {
  assert.equal(pageSlice(rows(10), -3, 5).page, 0);
  assert.equal(pageSlice(rows(10), NaN, 5).page, 0);
});

test('a nonsense page size does not divide by zero', () => {
  const s = pageSlice(rows(10), 0, 0);
  assert.equal(s.rows.length, 1, 'clamped to one row per page rather than none');
  assert.equal(s.pages, 10);
});

test('clampPage and pageCount agree with each other', () => {
  for (const total of [0, 1, 49, 50, 51, 999]) {
    const pages = pageCount(total, 50);
    assert.equal(clampPage(9999, total, 50), pages - 1,
      `the clamped page must be the last page for ${total} rows`);
  }
});

test('exactly one full page is one page, not two', () => {
  assert.equal(pageCount(50, 50), 1);
  assert.equal(pageSlice(rows(50), 1, 50).page, 0, 'there is no page 2 to move to');
});

const { pageWindow } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/pager.js')).href);

test('page numbers: few pages are all shown', () => {
  assert.deepEqual(pageWindow(0, 1), [0]);
  assert.deepEqual(pageWindow(1, 3), [0, 1, 2]);
  assert.deepEqual(pageWindow(0, 4), [0, 1, 2, 3], 'four pages need no ellipsis');
});

test('page numbers: first, last and the neighbours, with an ellipsis for each gap', () => {
  assert.deepEqual(pageWindow(5, 12), [0, '…', 4, 5, 6, '…', 11]);
  assert.deepEqual(pageWindow(0, 12), [0, 1, '…', 11]);
  assert.deepEqual(pageWindow(11, 12), [0, '…', 10, 11]);
});

test('page numbers: a gap of one page shows that page, not an ellipsis', () => {
  assert.deepEqual(pageWindow(3, 12), [0, 1, 2, 3, 4, '…', 11], 'page 1 (0-based) fills the gap between 0 and 2');
  assert.deepEqual(pageWindow(0, 3), [0, 1, 2]);
});

test('page numbers: a stale page beyond the end is clamped, like pageSlice', () => {
  assert.deepEqual(pageWindow(40, 3), [0, 1, 2]);
  assert.deepEqual(pageWindow(-2, 0), [0]);
});
