/**
 * Retention counts from when the logs are really there (0.3.97, owner 2026-11-26).
 *
 * The case reported: five indices dated 2025-05-03, then nothing until 2026-10-01, then every
 * day to today. Capacity said "logs from 2025-05-03 to today" — five stray indices made the
 * cluster look like it held a year and a half. Live retention, the sheet's oldest index day,
 * each snapshot's "covers" and the backup range now start at 2026-10-01, and the stray day is
 * named apart, never hidden. One rule (volume.js currentRun): going back from the newest day,
 * the run ends at a gap of MORE than STALE_GAP_DAYS (7) days with no index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
const at = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const V = await at('ui/js/core/volume.js');
const S = await at('ui/js/core/state.js');
const E = await at('ui/js/core/snapshot-evidence.js');
const L = await at('ui/js/core/snapshot-list.js');
const R = await at('ui/js/core/snapshot-restorable.js');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysFrom = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(iso(t)); return out; };
const TODAY = '2026-11-26';
const RUN = daysFrom('2026-10-01', TODAY);                       // 57 days, both ends counted
const STRAY = Array.from({ length: 5 }, (_, i) => ({ index: `logstash-app${i}-2025.05.03`, day: '2025-05-03', size: 10 }));
const LIVE = [...STRAY, ...RUN.map((d) => ({ index: `logstash-${d.replaceAll('-', '.')}`, day: d, size: 100 }))];

test('the reported case: 5 indices on 2025-05-03, then every day from 2026-10-01 — live retention starts 2026-10-01', () => {
  const h = V.liveHeldDays(LIVE, {}, TODAY);
  assert.equal(h.from, '2026-10-01');
  assert.equal(h.days, 57);
  assert.deepEqual({ ...h.left, list: undefined }, { days: 1, from: '2025-05-03', to: '2025-05-03', list: undefined, gapDays: 515, indices: 5 });
  assert.equal(V.leftOutText(h.left, h.from), '5 indices on 1 older day (2025-05-03) left out: 515 days with no index before 2026-10-01');
  assert.equal(V.leftOutShort(h.left), '+1 older day left out');
});

test('the gap must be MORE than 7 days: 7 empty days stay one run, 8 split it', () => {
  assert.equal(V.currentRun(['2026-11-01', '2026-11-09']).from, '2026-11-01', '02..08 empty: 7 days');
  const split = V.currentRun(['2026-11-01', '2026-11-10']);
  assert.equal(split.from, '2026-11-10', '02..09 empty: 8 days');
  assert.equal(split.left.gapDays, 8);
  assert.equal(V.currentRun(['2026-11-01', '2026-11-02']).left, null, 'next days: nothing left out');
  assert.deepEqual(V.currentRun([]), { from: null, to: null, days: [], left: null });
  assert.deepEqual(V.currentRun(['2026-11-03', '2026-11-03', '', null]).days, ['2026-11-03'], 'duplicates and blanks');
});

test('stray days scattered through older months are all left out, and a long run with short gaps is kept whole', () => {
  const r = V.currentRun(['2025-01-30', '2025-03-11', '2025-03-12', '2025-07-02', ...RUN]);
  assert.equal(r.from, '2026-10-01');
  assert.deepEqual([r.left.days, r.left.from, r.left.to], [4, '2025-01-30', '2025-07-02']);
  // A weekend and a 5-day outage inside the run do not cut it.
  const holes = RUN.filter((d) => !['2026-10-11', '2026-10-12', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].includes(d));
  assert.equal(V.currentRun(holes).from, '2026-10-01');
});

test('the Capacity sheet: oldest index day and days held agree with the Live retention column', () => {
  // dailyVolume reads the real today; build the same shape relative to it.
  const now = Date.now();
  const recent = Array.from({ length: 20 }, (_, i) => iso(now - (i + 1) * DAY));
  const old = iso(now - 400 * DAY);
  const idx = [{ day: old, size: 1 }, { day: old, size: 1 }, ...recent.map((d) => ({ day: d, size: 5 }))];
  const vol = V.dailyVolume(idx);
  assert.equal(vol.oldestDay, recent[19]);
  assert.equal(vol.daysCovered, 20);
  assert.deepEqual([vol.leftOut.days, vol.leftOut.from, vol.leftOut.indices], [1, old, 2]);
  assert.ok(!vol.days.some((d) => d.day === old), 'a left-out day is not a sizing day either');
  assert.equal(V.liveHeldDays(idx).from, vol.oldestDay, 'one definition: column and sheet start on the same day');
  const rep = V.volumeReport({ name: 'c' }, {}, idx);
  const col = (label) => V.SHEET_COLUMNS.find((c) => c.label === label);
  assert.equal(col('Oldest index day').get(rep), recent[19]);
  assert.equal(col('Older index days left out').get(rep), 1);
  assert.match(col('Older index days left out').note(rep), /^2 indices on 1 older day \(\d{4}-\d{2}-\d{2}\) left out: 379 days with no index before /);
  const clean = V.volumeReport({ name: 'c' }, {}, idx.slice(2));
  assert.equal(col('Older index days left out').get(clean), 0);
  assert.equal(col('Older index days left out').note(clean), 'none');
  assert.equal(col('Older index days left out').get(V.volumeReport({ name: 'c' }, {}, [])), null, 'no dated indices: unknown, not 0');
});

const T = Date.UTC(2026, 10, 26);
const name = (d) => `logstash-${d.replaceAll('-', '.')}`;
const snap = (snapshot, days, n = 0) => ({ snapshot, state: 'SUCCESS', indices: days.map(name),
  start_time_in_millis: T - n * DAY, end_time_in_millis: T - n * DAY + 1000, duration_in_millis: 1000,
  shards: { total: days.length, successful: days.length, failed: 0 }, failures: [] });

test('one snapshot holding the stray day: its cover starts at the run, the stray day is named and still restorable', () => {
  const names = [...STRAY.map((r) => r.index), ...RUN.slice(0, 10).map(name)];
  const c = S.coveredDays(names, S.LEGACY_INDEX_RE);
  assert.deepEqual([c.coverFrom, c.coverTo, c.coverDays, c.missingDays, c.datedIndices], ['2026-10-01', '2026-10-10', 10, 0, 15]);
  assert.deepEqual(c.leftDays, { days: 1, from: '2025-05-03', to: '2025-05-03', gapDays: 515, indices: 5 });
  assert.equal(E.coverLine(c), 'covers 2026-10-01 → 2026-10-10 (10 days, 0 missing days); 5 indices on 1 older day (2025-05-03) left out: 515 days with no index before 2026-10-01');
  const [row] = S.snapshotRowsVerbose({ snapshots: [snap('s1', ['2025-05-03', ...RUN.slice(0, 10)])] });
  assert.ok(row.days.includes('2025-05-03'), 'the day is still in what the snapshot can give back');
  assert.deepEqual(R.snapshotCover(row).left, row.leftDays);
  const [csv] = L.snapshotCsvRows([row]);
  assert.deepEqual([csv.data_from, csv.data_days, csv.data_left_out_days, csv.data_left_out], ['2026-10-01', 10, 1, '2025-05-03']);
});

test('the backup range across snapshots: a 2025 snapshot is left out of the range, on the sheet and on the Snapshots page alike', () => {
  const rows = S.snapshotRowsVerbose({ snapshots: [
    snap('new', RUN.slice(-30), 0),
    snap('mid', RUN.slice(0, 30), 26),
    snap('old', daysFrom('2025-04-28', '2025-05-03'), 570),
  ] });
  const r = E.recoverableRange(rows);
  assert.deepEqual([r.from, r.to, r.days, r.held, r.missing], ['2026-10-01', TODAY, 57, 57, 0]);
  assert.deepEqual([r.left.days, r.left.from, r.left.to, r.left.gapDays], [6, '2025-04-28', '2025-05-03', 515]);
  assert.match(E.spanTitle(r), /6 older days \(2025-04-28 → 2025-05-03\) left out: 515 days with no index before 2026-10-01/);
  const rep = V.volumeReport({ name: 'c' }, { snapshots: { repo: rows } }, []);
  assert.deepEqual([rep.snapshotDataFrom, rep.snapshotDataDays, rep.snapshotDataHeld], [r.from, r.days, r.held]);
  const col = (label) => V.SHEET_COLUMNS.find((c) => c.label === label);
  assert.equal(col('Older backed-up days left out').get(rep), 6);
  assert.match(col('Oldest index day backed up').note(rep), /\+6 older days left out/);
  // Rows that do not carry their days: the plain oldest-to-newest, nothing can be left out.
  const bare = rows.map(({ days, ...x }) => x);
  const b = E.recoverableRange(bare);
  assert.deepEqual([b.from, b.held, b.left], ['2025-04-28', null, null]);
  assert.equal(col('Older backed-up days left out').get(V.volumeReport({ name: 'c' }, { snapshots: { repo: bare } }, [])), null);
});
