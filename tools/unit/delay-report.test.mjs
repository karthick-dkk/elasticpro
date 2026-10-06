/**
 * The log-delay report.
 *
 * What is asserted here is mostly about what a spreadsheet does to a reader: a figure in
 * a cell gets totalled, sorted and quoted, with none of the context the page had. So the
 * rules the screen enforces — unknown is not zero, six clusters is not nine — have to
 * survive the export, and a spreadsheet is where their absence is least visible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { reportSheets, reportFilename, DEVICE_COLUMNS } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/delay-report.js')).href);

const sheet = (sheets, name) => sheets.find((s) => s.name === name);
const col = (key) => DEVICE_COLUMNS.findIndex((c) => c.key === key);

const rec = (o) => ({
  cluster: 'vm-1', device: 'd', status: 'OK', delayMinutes: 1, docs: 10,
  pattern: '-', arrival: Date.UTC(2026, 8, 20, 15, 0, 0), event: Date.UTC(2026, 8, 20, 14, 59, 0),
  reason: '', patternNote: '', ...o,
});

test('the header comes from the column list, so they cannot drift', () => {
  const s = sheet(reportSheets([], {}, {}), 'Devices');
  assert.deepEqual(s.rows[0], DEVICE_COLUMNS.map((c) => c.label));
});

test('an unmeasurable delay is an empty cell, never a zero', () => {
  // The whole point. In a spreadsheet a zero is a measurement somebody averages.
  const s = sheet(reportSheets([rec({ device: 'ghost', status: 'ERROR', delayMinutes: null })], {}, {}), 'Devices');
  assert.equal(s.rows[1][col('delayMinutes')], null);
});

test('a real zero delay stays a zero', () => {
  const s = sheet(reportSheets([rec({ delayMinutes: 0 })], {}, {}), 'Devices');
  assert.equal(s.rows[1][col('delayMinutes')], 0);
});

test('a negative delay keeps its sign', () => {
  // A device whose clock is ahead. Clamping it would turn a clock problem into "fine".
  const s = sheet(reportSheets([rec({ status: 'CLOCK_AHEAD', delayMinutes: -37.456 })], {}, {}), 'Devices');
  assert.equal(s.rows[1][col('delayMinutes')], -37.46);
});

test('worst first, the same order as the screen', () => {
  const s = sheet(reportSheets([
    rec({ device: 'fine', status: 'OK', delayMinutes: 1 }),
    rec({ device: 'bad', status: 'CRITICAL', delayMinutes: 95 }),
    rec({ device: 'late', status: 'DELAYED', delayMinutes: 41 }),
  ], {}, {}), 'Devices');
  assert.deepEqual(s.rows.slice(1).map((r) => r[col('device')]), ['bad', 'late', 'fine']);
});

test('the status reads as the word the page shows, not the enum', () => {
  const s = sheet(reportSheets([rec({ status: 'CLOCK_AHEAD', delayMinutes: -5 })], {}, {}), 'Devices');
  assert.equal(s.rows[1][col('status')], 'clock ahead');
});

test('timestamps are written as UTC, not as a number', () => {
  const s = sheet(reportSheets([rec({})], {}, {}), 'Devices');
  assert.equal(s.rows[1][col('arrival')], '2026-09-20T15:00:00Z');
  assert.equal(s.rows[1][col('event')], '2026-09-20T14:59:00Z');
});

test('a device that was never seen has an empty timestamp, not the epoch', () => {
  const s = sheet(reportSheets([rec({ arrival: null, event: null })], {}, {}), 'Devices');
  assert.equal(s.rows[1][col('arrival')], null);
  assert.equal(s.rows[1][col('event')], null);
});

test('the clusters that did not answer are named', () => {
  const s = sheet(reportSheets([], {}, {
    missing: [{ cluster: 'mock-lab', reason: 'never asked (stopped)' },
              { cluster: 'prod-3', reason: 'query failed: all shards failed' }],
  }), 'Not measured');
  const names = s.rows.slice(1).map((r) => r[0]);
  assert.deepEqual(names, ['mock-lab', 'prod-3']);
  assert.match(s.rows[2][1], /all shards failed/);
});

test('the not-measured sheet exists even when nothing was missed', () => {
  // A sheet that vanishes when everything worked makes its absence carry information
  // nobody reads. A reader must be able to tell "all answered" from "does not say".
  const s = sheet(reportSheets([rec({})], {}, { missing: [] }), 'Not measured');
  assert.ok(s, 'the sheet is missing entirely');
  assert.equal(s.rows.length, 2);
  assert.match(s.rows[1][1], /Every selected cluster was measured/);
});

test('the summary carries the denominator', () => {
  const s = sheet(reportSheets([], { devices: 12, median: 41.5, by: { OK: 9, DELAYED: 3 } },
    { measured: 6, notMeasured: 3, windowHours: 24, generatedAt: Date.UTC(2026, 8, 20, 15, 30) }), 'Summary');
  const flat = s.rows.map((r) => r.join('|')).join('\n');
  assert.match(flat, /Clusters measured\|6/);
  assert.match(flat, /Clusters not measured\|3/);
  assert.match(flat, /Devices\|12/);
  assert.match(flat, /Median delay \(minutes\)\|41\.5/);
  assert.match(flat, /2026-09-20T15:30:00Z/);
});

test('a median that could not be computed is empty, not zero', () => {
  const s = sheet(reportSheets([], { devices: 0, median: null, by: {} }, {}), 'Summary');
  const row = s.rows.find((r) => r[0] === 'Median delay (minutes)');
  assert.equal(row[1], null);
});

test('every status is listed in the summary, including the ones at zero', () => {
  // "0 critical" is the reassurance the report is read for; a row that only appears when
  // it is non-zero makes its absence indistinguishable from the report not knowing.
  const s = sheet(reportSheets([], { devices: 1, median: 1, by: { OK: 1 } }, {}), 'Summary');
  const flat = s.rows.map((r) => r.join('|')).join('\n');
  for (const label of ['ok', 'delayed', 'critical', 'clock ahead']) {
    assert.match(flat, new RegExp(`${label}\\|\\d`, 'i'), `"${label}" is not in the summary`);
  }
});

test('the filename sorts and is unique per minute', () => {
  const n = reportFilename(Date.UTC(2026, 8, 20, 15, 30));
  assert.equal(n, 'log-delay-2026-09-20-1530.xlsx');
  assert.ok(n < reportFilename(Date.UTC(2026, 8, 20, 15, 31)), 'names do not sort by time');
});
