/**
 * Reports: every figure says what it covers (docs/REPORTS.md "What a figure covers"). A fleet tile
 * that could be measured for no cluster reads "not measured", one that covers some says "N of M",
 * an average says which days it is over, a file names the clusters it has nothing for.
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
const at = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const V = await at('ui/js/core/volume-daily.js');
const VOL = await at('ui/js/core/volume.js');
const O = await at('ui/js/reports/overview.js');
const X = await at('ui/js/reports/exports.js');
const S = await at('ui/js/core/indices-summary.js');
const FV = await at('ui/js/core/field-volume.js');
const T = await at('ui/js/core/report-types.js');

const GB = 1024 ** 3;
const TODAY = '2026-11-24';
const record = (n, f, extra = () => ({})) => ({ days: Array.from({ length: n }, (_, i) => ({ day: V.addDays(TODAY, -(i + 1)), final: true, docs: 10, eventBytes: f(i + 1), ...extra(i + 1) })) });
const row = (o = {}) => ({ record: null, lasts: null, data: { repos: [{ name: 'r' }], reposRead: true }, waiting: false, ...o,
  plan: { ulm: false, backupShortfall: null, backupWhy: 'no capacity', ...(o.plan || {}) } });
const texts = (rows) => O.tileTexts(O.fleetTiles(rows, { today: TODAY }));

test('a fleet tile nothing could be measured for reads "not measured", never 0', () => {
  const x = texts([row(), row()]);
  assert.deepEqual(x.disk, { value: null, detail: '0 of 2 clusters measured' });
  assert.deepEqual(x.backups, { value: null, detail: '2 clusters with no backupCapacity' });
  assert.equal(x.month.value, null);
  assert.ok(!/23|day/.test(x.month.detail), `no day count beside "not measured": ${x.month.detail}`);
  assert.equal(x.yesterday.value, null);
});

test('a fleet tile that covers some clusters says how many of how many, and why the rest are not in it', () => {
  const rec = record(30, () => GB);
  const x = texts([
    row({ record: rec, lasts: 10, plan: { backupShortfall: 5, backupWhy: null } }),
    row({ record: rec, lasts: 30, plan: { backupShortfall: 0, backupWhy: null } }),
    row({ plan: { backupWhy: 'not set' } }),
    row({ data: { repos: [], reposRead: true }, plan: { backupShortfall: 0, backupWhy: null } }),
    row({ plan: { ulm: true, backupWhy: 'ulm' } }),
  ]);
  assert.deepEqual(x.disk, { value: '2 clusters', detail: '1 within 2 weeks · 2 of 5 clusters measured' });
  assert.equal(x.backups.value, '1');
  assert.equal(x.backups.detail, '2 of 4 clusters measured · 1 cluster with no snapshotRetention · 1 cluster with no repository');
  assert.equal(x.month.detail, '1–23 Nov · 46 of 115 cluster-days measured · 2 of 5 clusters');
  assert.equal(x.yesterday.detail, 'vs the 7 days before it · 2 of 5 clusters');
  assert.equal(x.avg.detail, 'event_logsize · 2 of 5 clusters');
  const whole = texts([row({ record: rec, lasts: 100, plan: { backupShortfall: 0, backupWhy: null } })]);
  assert.equal(whole.month.detail, '1–23 Nov · 23 days · 1 cluster');
  assert.equal(whole.backups.detail, '1 cluster measured');
  assert.deepEqual(texts([row({ plan: { ulm: true, backupWhy: 'ulm' } })]).backups, { value: '—', detail: 'every cluster archives to S3 (ULM)' });
  assert.equal(O.moreText([{ lasts: 100 }, { lasts: null }, { lasts: null }]), 'and 3 more clusters: 1 further out, 2 not measured');
});

test('a day that is not final is counted: yesterday, the averages, the month', () => {
  const rec = record(30, () => GB, (i) => (i === 1 || i === 3 ? { final: false } : {}));
  assert.equal(V.eventWindow(rec, 7, { today: TODAY }).notFinal, 2);
  assert.equal(V.eventMonthSoFar(rec, { today: TODAY }).notFinal, 2);
  const t = V.fleetEventTotals([rec], { today: TODAY });
  assert.deepEqual([t.yesterdayNotFinal, t.notFinal, t.monthMeasured, t.vsN], [1, 2, 23, 1]);
  assert.match(texts([row({ record: rec })]).yesterday.detail, /1 cluster not final$/);
  assert.match(texts([row({ record: rec })]).month.detail, /2 days not final$/);
});

test('yesterday against the days before it: the day is not in its own average, and the words say how many days were', () => {
  const rec = record(8, (i) => (i === 1 ? 15 * GB : 14 * GB));
  const y = V.addDays(TODAY, -1);
  assert.equal(Math.round(V.eventVsAvgPct(rec, y, 7, { today: TODAY }) * 10) / 10, 7.1);
  assert.equal(V.vsAvgWords(rec, y, 7, { today: TODAY }), 'the 7 days before it');
  assert.equal(V.vsAvgWords(record(7, () => GB), y, 7, { today: TODAY }), '6 of the 7 days before it');
});

test('today says when it was read, in the zone given', () => {
  const ms = Date.UTC(2026, 10, 24, 4, 30);
  assert.equal(V.hhmm(ms, 'Asia/Kolkata'), '10:00');
  assert.match(V.dayStatus({ day: TODAY, totalsAt: ms }, { today: TODAY }).text, /^today so far, as of \d\d:\d\d$/);
  assert.match(S.sizeDayStatus({ day: TODAY, aggregatedAt: ms }, 'primary', { today: TODAY }).text, /^today so far, as of \d\d:\d\d$/);
});

test('the files name the clusters they have nothing for', () => {
  const out = X.dailyRows([{ id: 'nobody', name: 'nobody' }]);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].cluster, out[0].event_bytes, out[0].day], ['nobody', null, null]);
  assert.match(out[0].status, /^not (measured|read)/);
  const reply = { clusters: [{ clusterId: 'a', name: 'a', months: [{ month: '2026-10', daysWithData: 12, eventBytes: 7 }, { month: '2026-09', daysWithData: 30, eventBytes: 9 }] },
    { clusterId: 'z', name: 'z', months: [{ month: '2026-08', daysWithData: 31, eventBytes: 1 }] }] };
  const m = V.monthlyAllEventCsvRows(reply, [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]);
  assert.deepEqual(m.headers, ['cluster', '2026-09', '2026-10', 'days_note'], 'only the clusters chosen');
  assert.deepEqual(m.rows, [{ cluster: 'a', '2026-09': 9, '2026-10': 7, days_note: '2026-10: 12 of 31 days' },
    { cluster: 'b', '2026-09': null, '2026-10': null, days_note: 'no monthly record on the server' }]);
});

test('a breakdown with a row nobody measured has no shares', () => {
  const r = (eventBytes, docs = 1) => ({ value: 'x', docs, eventBytes });
  assert.deepEqual(V.breakdownEventShares({ rows: [r(3), r(1)] }).map((x) => x.share), [75, 25]);
  assert.deepEqual(V.breakdownEventShares({ rows: [r(3), r(null)] }).map((x) => x.share), [null, null]);
  assert.deepEqual(V.breakdownEventShares({ rows: [r(3), r(null, 0)] }).map((x) => x.share), [100, null], 'a row with no document takes nothing');
});

test('the repository size is whole or it is "at least": the cap limits calls, the cached ones are free', async () => {
  const snaps = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, status: 'SUCCESS' }));
  const data = { reposRead: true, repos: [{ name: 'r' }], snapshots: { r: snaps }, snapshotTotals: { r: { whole: true } } };
  let calls = 0;
  const cl = { snapshotStatus: async () => { calls++; return { snapshots: [{ stats: { incremental: { size_in_bytes: 10 } } }] }; } };
  const cache = new Map();
  const first = await VOL.measureRepoBytes(cl, data, { cap: 3, cache });
  assert.deepEqual([first.total, first.atLeast, first.counted, first.of, calls], [null, 30, 3, 5, 3]);
  assert.equal(VOL.repoMeasureText(first, (n) => `${n} B`), 'measured 3 of 5 snapshots: at least 30 B');
  const second = await VOL.measureRepoBytes(cl, data, { cap: 3, cache });
  assert.deepEqual([second.total, second.counted, calls], [50, 5, 5]);
  assert.equal(VOL.repoMeasureText(second, String), '');
  const noSize = await VOL.measureRepoBytes({ snapshotStatus: async () => ({ snapshots: [{}] }) }, data, {});
  assert.deepEqual([noSize.total, noSize.failed], [null, 5], 'an answer without a size is not a size of 0');
  const unlisted = await VOL.measureRepoBytes(cl, { ...data, snapshots: {} }, {});
  assert.equal(unlisted.total, null);
  const cut = await VOL.measureRepoBytes(cl, { ...data, snapshotTotals: { r: { total: 9 } } }, { cache });
  assert.deepEqual([cut.total, cut.more], [null, true]);
  assert.equal((await VOL.measureRepoBytes(cl, { reposRead: false, repos: [] }, {})).total, null, 'a list nobody read is not an empty one');
  assert.equal((await VOL.measureRepoBytes(cl, { reposRead: true, repos: [] }, {})).total, 0);
});

test('volume by host: a filled value is marked, an event size nobody had is not 0', () => {
  const r = T.hostsOf({ ok: true, rows: [
    { day: 'd', index: 'i', docs: 5, eventBytes: 0, eventMissingDocs: 5, clientId: 'DC', clientIdFilled: true, branch: 'x' },
    { day: 'd', index: 'i', docs: 5, eventBytes: 0, eventMissingDocs: 2 }], totals: { docs: 5, eventBytes: 0, eventMissingDocs: 5 } });
  assert.deepEqual([r.rows[0].eventBytes, r.rows[0].clientIdFilled, r.rows[0].branchFilled], [null, true, false]);
  assert.equal(r.rows[1].eventBytes, 0, 'some documents had one and it summed to 0: measured');
  assert.equal(r.totals.eventBytes, null);
});

test('sizes per tag1 value are called estimated; a short average says so in the file', () => {
  assert.equal(S.TAG_ESTIMATE, 'estimated by document share');
  assert.equal(S.tagColumnName('tag1', 'fw'), 'tag1=fw_bytes_estimated');
  assert.ok(S.SUMMARY_CSV.includes('avg_7d_days_recorded'));
});

test('the sheet names what it holds: log volume, with what it was measured as', () => {
  const r = VOL.volumeReport({ name: 'c', url: 'u' }, {}, [], null, { perDayBytes: 10 * GB, disk: { measured: false } });
  const col = (l) => VOL.SHEET_COLUMNS.find((c) => c.label === l);
  assert.ok(!VOL.SHEET_COLUMNS.some((c) => /Indices size per day/.test(`${c.label} ${c.help}`)), 'event_logsize is not called index size');
  assert.equal(VOL.sheetCell(col('Log volume per day'), r), '10');
  assert.match(VOL.sheetCell(col('Log volume measured as'), r), /event_logsize/);
  assert.match(col('Current live storage store upto').note(r), /event_logsize.*replicas not counted/);
  assert.match(VOL.DISK_LASTS_BASIS, /event_logsize per day \(7-day average\), replicas not counted/);
});

test('document counts are exact only when every shard answered and no bound was set', () => {
  const res = (o = {}) => ({ timed_out: false, _shards: { total: 4, failed: 0 }, aggregations: { terms: { doc_count_error_upper_bound: 0, buckets: [] } }, ...o });
  assert.equal(FV.countsNotExact(res()), null);
  assert.equal(FV.countsNotExact(res({ _shards: { total: 4, failed: 1 } })), '1 of 4 shards failed');
  assert.match(FV.countsNotExact(res({ timed_out: true })), /timed out/);
  assert.match(FV.countsNotExact(res({ aggregations: { terms: { doc_count_error_upper_bound: 12, buckets: [] } } })), /up to 12 documents/);
  assert.equal(FV.countsNotExact(null), 'no answer');
});
