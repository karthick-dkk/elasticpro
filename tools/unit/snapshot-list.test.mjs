/** The Snapshots page's list: search, newest-first paging, and an export of every match. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { filterSnapshots, snapshotPage, snapshotCsvRows, SNAPSHOT_PAGE_SIZES, sortSnapshots, durationMs,
        SNAPSHOT_SORTS, DEFAULT_SNAPSHOT_SORT, SNAPSHOT_COLUMNS, shownColumns } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-list.js')).href);
const { cycleSort, sortOptions, parseSort, sortValue } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/sort-order.js')).href);

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

/* ---- the sort select / header click, one order for the page and its export ---- */

const ids = (rows) => rows.map((s) => s.id);

test('the list opens newest first; the select offers every key both ways', () => {
  assert.deepEqual(DEFAULT_SNAPSHOT_SORT, { key: 'taken', dir: -1 });
  assert.equal(ids(sortSnapshots(SNAPS))[0], 'daily-10');
  assert.equal(ids(snapshotPage(SNAPS, { sort: { key: 'taken', dir: 1 } }).rows)[0], 'daily-00');
  const opts = sortOptions(SNAPSHOT_SORTS);
  assert.equal(opts.length, 12);
  assert.equal(opts[0].value, 'taken:-1');
  assert.equal(opts[0].label, 'Taken · newest first');
  assert.ok(opts.some((o) => o.label === 'Data inside · oldest covered day first'));
  assert.deepEqual(parseSort('status:-1', SNAPSHOT_SORTS, DEFAULT_SNAPSHOT_SORT), { key: 'status', dir: -1 });
  assert.deepEqual(parseSort('bogus', SNAPSHOT_SORTS, DEFAULT_SNAPSHOT_SORT), DEFAULT_SNAPSHOT_SORT, 'an unknown value falls back');
  assert.equal(sortValue(cycleSort(DEFAULT_SNAPSHOT_SORT, 'taken', SNAPSHOT_SORTS)), 'taken:1', 'clicking Taken again flips it');
  assert.equal(sortValue(cycleSort(DEFAULT_SNAPSHOT_SORT, 'name', SNAPSHOT_SORTS)), 'name:1');
});

test('status: failures first, then partial, then successes; ties newest first', () => {
  const mixed = [
    { id: 'ok-old', status: 'SUCCESS', start: 1 }, { id: 'part', status: 'PARTIAL', start: 2 },
    { id: 'ok-new', status: 'SUCCESS', start: 3 }, { id: 'fail', status: 'FAILED', start: 0 }, { id: 'run', status: 'IN_PROGRESS', start: 4 },
  ];
  assert.deepEqual(ids(sortSnapshots(mixed, { key: 'status', dir: -1 })), ['fail', 'part', 'run', 'ok-new', 'ok-old']);
  assert.deepEqual(ids(sortSnapshots(mixed, { key: 'status', dir: 1 })), ['ok-new', 'ok-old', 'run', 'part', 'fail']);
});

test('name, indices, duration and data inside; unknowns last either way', () => {
  const rows = [
    { id: 'b', start: 1, indices: 3, duration: 60000, coverFrom: '2026-09-20' },
    { id: 'a', start: 2, indices: 7, duration: '5.5m', coverFrom: '2026-09-10' },
    { id: 'c', start: 3, indices: 1, duration: 'weird', coverFrom: null, indexNames: null },
  ];
  assert.deepEqual(ids(sortSnapshots(rows, { key: 'name', dir: 1 })), ['a', 'b', 'c']);
  assert.deepEqual(ids(sortSnapshots(rows, { key: 'name', dir: -1 })), ['c', 'b', 'a']);
  assert.deepEqual(ids(sortSnapshots(rows, { key: 'indices', dir: -1 })), ['a', 'b', 'c']);
  assert.deepEqual(ids(sortSnapshots(rows, { key: 'duration', dir: -1 })), ['a', 'b', 'c'], '5.5m is longer than 60000 ms; unreadable last');
  assert.deepEqual(ids(sortSnapshots(rows, { key: 'duration', dir: 1 })), ['b', 'a', 'c'], 'unreadable still last when shortest first');
  assert.deepEqual(ids(sortSnapshots(rows, { key: 'cover', dir: 1 })), ['a', 'b', 'c']);
  assert.deepEqual(ids(sortSnapshots(rows, { key: 'cover', dir: -1 })), ['b', 'a', 'c'], 'a _cat row has no covered day: last, not first');
});

test('durationMs reads a number or an Elasticsearch time string; anything else is unknown', () => {
  assert.equal(durationMs(1500), 1500);
  assert.equal(durationMs('350ms'), 350);
  assert.equal(durationMs('5.5m'), 330000);
  assert.equal(durationMs('1.5h'), 5400000);
  assert.equal(durationMs('2s'), 2000);
  assert.equal(durationMs(''), null);
  assert.equal(durationMs(undefined), null);
  assert.equal(durationMs('n/a'), null);
});

test('columns: all nine by default, Snapshot cannot be hidden, the rest can', () => {
  assert.equal(SNAPSHOT_COLUMNS.length, 9);
  assert.equal(shownColumns().length, 9);
  const shown = shownColumns(['ended', 'shards', 'snapshot']);
  assert.deepEqual(shown.map((c) => c.key), ['snapshot', 'status', 'taken', 'duration', 'indices', 'cover', 'failed']);
  assert.equal(shown[0].key, 'snapshot', 'the fixed column stays even when asked off');
});
