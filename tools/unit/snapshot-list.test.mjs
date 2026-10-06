/** The Snapshots page's list: search, newest-first paging, and an export of every match. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { filterSnapshots, snapshotPage, snapshotCsvRows, SNAPSHOT_PAGE_SIZES } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-list.js')).href);

const DAY = 86400000;
// Eleven snapshots, oldest first — the page must not depend on arrival order.
const SNAPS = Array.from({ length: 11 }, (_, i) => ({
  id: `daily-${String(i).padStart(2, '0')}`, status: i === 3 ? 'FAILED' : 'SUCCESS', start: 1e12 + i * DAY,
  indexNames: [`logstash-2026.09.${String(10 + i).padStart(2, '0')}`], coverFrom: `2026-09-${10 + i}`, coverTo: `2026-09-${10 + i}`, coverDays: 1,
}));   // oldest first: the opposite of the order the page shows

test('the page opens on the smallest size, newest first', () => {
  assert.equal(SNAPSHOT_PAGE_SIZES[0], 10);
  const { rows, slice } = snapshotPage(SNAPS, {});
  assert.equal(rows[0].id, 'daily-10');
  assert.equal(slice.rows.length, 10);
  assert.equal(slice.pages, 2);
  assert.deepEqual(snapshotPage(SNAPS, { page: 1 }).slice.rows.map((s) => s.id), ['daily-00']);
});

test('eleven snapshots at five per page are three pages; a stale page clamps', () => {
  assert.equal(snapshotPage(SNAPS, { perPage: 5 }).slice.pages, 3);
  const s = snapshotPage(SNAPS, { perPage: 5, page: 9 }).slice;
  assert.equal(s.page, 2);
  assert.equal(s.rows.length, 1);
});

test('search matches name, status, or an index the snapshot holds', () => {
  assert.equal(filterSnapshots(SNAPS, 'daily-0').length, 10);
  assert.deepEqual(filterSnapshots(SNAPS, 'failed').map((s) => s.id), ['daily-03']);
  assert.deepEqual(filterSnapshots(SNAPS, 'logstash-2026.09.15').map((s) => s.id), ['daily-05']);
  assert.equal(filterSnapshots(SNAPS, '  ').length, 11, 'blank search keeps everything');
  const cat = [{ id: 'x', status: 'SUCCESS', indexNames: null }];
  assert.equal(filterSnapshots(cat, 'logstash').length, 0, 'a _cat row names no indices to match');
});

test('a search that matches four rows lands on page 1 even from page 2', () => {
  const { slice } = snapshotPage(SNAPS, { text: 'daily-0', page: 5, perPage: 25 });
  assert.equal(slice.page, 0);
});

test('CSV rows: every row, with the data days inside, unknown where the listing had no names', () => {
  const rows = snapshotCsvRows([...SNAPS, { id: 'cat', status: 'SUCCESS', start: 0, indexNames: null }]);
  assert.equal(rows.length, 12);
  assert.equal(rows[0].data_from, '2026-09-10');
  const cat = rows.find((r) => r.snapshot === 'cat');
  assert.equal(cat.data_from, 'unknown');
  assert.equal(cat.start, '');
});
