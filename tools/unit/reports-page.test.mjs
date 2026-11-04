/**
 * The Reports page's figures (docs/REPORTS.md): the one per-day rate (perDayEventBytes) and
 * what is built on it, the data-node disk (dataNodeDisk), a Storage plan row and its
 * shortfalls, Measure size's difference and ratio, the day status, the route, and the group
 * band of the Columns menu. Pure arithmetic; jsdom only because the modules sit beside
 * renderers.
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
const V = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume-daily.js')).href);
const VOL = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/reports/route.js')).href);
const C = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/columns.js')).href);

const GB = 1024 ** 3;
const TODAY = '2026-11-04';
/** A record of `n` finished days before TODAY plus today, eventBytes = f(i) (i = 1 is yesterday). */
function record(n, f, extra = () => ({})) {
  const days = [{ day: TODAY, final: false, indices: 2, docs: 10, priBytes: 1 * GB, eventBytes: 0.5 * GB }];
  for (let i = 1; i <= n; i++) {
    const day = V.addDays(TODAY, -i);
    days.push({ day, final: true, indices: 2, docs: 100 * i, priBytes: 2 * GB, eventBytes: f(i), ...extra(i) });
  }
  return { days };
}

/* --------------------------------- the per-day rate --------------------------------- */

test('perDayEventBytes is the mean event_logsize of the last N finished days; today never counts', () => {
  const r = record(20, (i) => i * GB);                  // yesterday 1 GB, the day before 2 GB, …
  assert.equal(V.perDayEventBytes(r, 7, { today: TODAY }), 4 * GB);   // (1+…+7)/7
  assert.equal(V.perDayEventBytes(r, 3, { today: TODAY }), 2 * GB);
  // The 7 days before yesterday: days 2..8.
  assert.equal(V.perDayEventBytes(r, 7, { today: TODAY, before: V.addDays(TODAY, -1) }), 5 * GB);
  const w = V.eventWindow(r, 7, { today: TODAY });
  assert.deepEqual([w.from, w.to, w.measured, w.of], ['2026-10-28', '2026-11-03', 7, 7]);
});

test('a day without event_logsize is left out of the rate, never counted as 0', () => {
  const r = record(7, (i) => (i % 2 ? 2 * GB : null));  // days 1, 3, 5, 7 measured
  assert.equal(V.perDayEventBytes(r, 7, { today: TODAY }), 2 * GB);
  assert.equal(V.eventWindow(r, 7, { today: TODAY }).measured, 4);
  assert.equal(V.perDayEventBytes(record(7, () => null), 7, { today: TODAY }), null);
  assert.equal(V.perDayEventBytes(null, 7, { today: TODAY }), null);
  assert.equal(V.perDayEventBytes({ days: [] }, 7, { today: TODAY }), null);
});

test('a day against its average uses the N days before it (the core\'s row rule) on event_logsize', () => {
  const r = record(10, (i) => (i === 1 ? 12 * GB : 10 * GB));
  assert.equal(V.eventVsAvgPct(r, V.addDays(TODAY, -1), 7, { today: TODAY }), 20);
  assert.equal(V.eventVsAvgPct(r, V.addDays(TODAY, -2), 7, { today: TODAY }), 0);
  // Not measured on either side: no change, not -100 %.
  assert.equal(V.eventVsAvgPct(record(3, (i) => (i === 1 ? null : GB)), V.addDays(TODAY, -1), 7, { today: TODAY }), null);
  assert.equal(V.eventVsAvgPct(record(1, () => GB), V.addDays(TODAY, -1), 7, { today: TODAY }), null, 'no earlier day');
});

test('month so far counts this month\'s finished days only; on the 1st there are none', () => {
  const r = record(10, () => GB);
  const m = V.eventMonthSoFar(r, { today: TODAY });
  assert.deepEqual([m.from, m.to, m.days, m.measured, m.value], ['2026-11-01', '2026-11-03', 3, 3, 3 * GB]);
  assert.equal(m.docs, 100 + 200 + 300);
  const first = V.eventMonthSoFar(r, { today: '2026-11-01' });
  assert.deepEqual([first.days, first.value], [0, null]);
});

test('the peak is the heaviest finished day; a month\'s peak stays inside the month', () => {
  const r = record(40, (i) => (i === 5 ? 9 * GB : i === 20 ? 11 * GB : GB));
  assert.deepEqual(V.eventPeak(r, { today: TODAY }), { day: V.addDays(TODAY, -20), value: 11 * GB });
  assert.deepEqual(V.eventPeak(r, { today: TODAY, from: V.addDays(TODAY, -10) }), { day: V.addDays(TODAY, -5), value: 9 * GB });
  assert.deepEqual(V.monthEventPeak(r, '2026-10', { today: TODAY }), { day: '2026-10-15', value: 11 * GB });
});

test('the fleet totals add the clusters that measured each figure and count the ones that did not', () => {
  const a = record(10, () => 2 * GB);
  const b = record(10, (i) => (i === 1 ? 4 * GB : 2 * GB));
  const none = record(10, () => null);
  const t = V.fleetEventTotals([a, b, none], { today: TODAY });
  assert.equal(t.yesterday, 6 * GB);
  assert.equal(t.yesterdayN, 2);
  assert.equal(t.notMeasured, 1);
  assert.equal(t.avg, V.perDayEventBytes(a, 7, { today: TODAY }) + V.perDayEventBytes(b, 7, { today: TODAY }));
  assert.equal(t.vsAvgPct, 50);                          // 6 GB against 4 GB the 7 days before
  assert.equal(t.month, 14 * GB);                        // 1–3 Nov: a 3 × 2 GB, b 4 + 2 + 2 GB
});

/* ------------------------------------ data-node disk ------------------------------------ */

const alloc = (name, total, used) => ({ node: name, 'disk.total': String(total), 'disk.used': String(used), 'disk.avail': String(total - used) });

test('dataNodeDisk counts only nodes whose roles include a data role', () => {
  const data = {
    disk: { nodes: [alloc('hot-1', 100, 60), alloc('warm-1', 300, 100), alloc('master-1', 50, 10), alloc('content-1', 50, 25)] },
    nodes: [{ name: 'hot-1', 'node.role': 'hi' }, { name: 'warm-1', 'node.role': 'w' }, { name: 'master-1', 'node.role': 'm' },
      { name: 'content-1', roles: ['data_content', 'ingest'] }],
  };
  const d = VOL.dataNodeDisk(data);
  assert.equal(d.measured, true);
  assert.deepEqual([d.total, d.used, d.avail, d.nodes], [450, 185, 265, 3]);
  assert.equal(Math.round(d.percent * 10) / 10, 41.1);
  // Every data role counts: data, data_content, data_hot, data_warm, data_cold, data_frozen.
  assert.deepEqual(VOL.DATA_ROLES, ['data', 'data_content', 'data_hot', 'data_warm', 'data_cold', 'data_frozen']);
  for (const [letter] of [['d'], ['s'], ['h'], ['w'], ['c'], ['f']]) {
    assert.equal(VOL.dataNodeDisk({ disk: { nodes: [alloc('n', 10, 1)] }, nodes: [{ name: 'n', 'node.role': letter }] }).measured, true, letter);
  }
});

test('dataNodeDisk says "not measured" rather than assume, when roles are missing', () => {
  assert.equal(VOL.dataNodeDisk({}).measured, false);
  assert.match(VOL.dataNodeDisk({ disk: { nodes: [alloc('a', 10, 1)] } }).reason, /node list/);
  const unknown = VOL.dataNodeDisk({ disk: { nodes: [alloc('a', 10, 1), alloc('b', 10, 1)] }, nodes: [{ name: 'a', 'node.role': 'd' }] });
  assert.equal(unknown.measured, false);
  assert.match(unknown.reason, /roles not reported for 1 node \(b\)/);
  assert.equal(VOL.dataNodeDisk({ disk: { nodes: [alloc('m', 10, 1)] }, nodes: [{ name: 'm', 'node.role': 'm' }] }).measured, false, 'no data node');
  // Unassigned shards are a row of _cat/allocation, not a node.
  const withUnassigned = VOL.dataNodeDisk({ disk: { nodes: [alloc('a', 10, 4), { node: 'UNASSIGNED', shards: '3' }] }, nodes: [{ name: 'a', 'node.role': 'd' }] });
  assert.deepEqual([withUnassigned.measured, withUnassigned.total], [true, 10]);
});

test('disk lasts = free data-node disk ÷ the per-day rate; unknown when either is', () => {
  const disk = { measured: true, total: 100 * GB, used: 40 * GB, avail: 60 * GB };
  assert.equal(VOL.diskLastsDays(disk, 2 * GB), 30);
  assert.equal(VOL.diskLastsDays(disk, null), null);
  assert.equal(VOL.diskLastsDays({ measured: false }, 2 * GB), null);
});

/* ------------------------------------ storage plan ------------------------------------ */

const disk = (totalGB, usedGB) => ({ measured: true, total: totalGB * GB, used: usedGB * GB, avail: (totalGB - usedGB) * GB, percent: (usedGB / totalGB) * 100, nodes: 2 });

test('a Storage plan row: per day, buffer, required disks and shortfalls (docs/REPORTS.md table)', () => {
  const row = VOL.storagePlanRow({
    perDay: 100 * GB, headroomPercent: 30, livePolicy: VOL.parseRetention('30d'), disk: disk(3000, 1000),
    ulm: false, backupPolicy: VOL.parseRetention('7d'), backupCapacity: VOL.parseSize('500GB'), repoBytes: 100 * GB,
  });
  assert.equal(row.buffered, 130 * GB);
  assert.equal(row.liveRequired, 130 * 30 * GB);          // per day × policy days × buffer
  assert.equal(row.liveShortfall, 3900 * GB - 3000 * GB); // required − total
  assert.equal(row.backupRequired, 130 * 7 * GB);
  assert.equal(row.backupShortfall, 910 * GB - 500 * GB);
  // Fits: none (0), not a negative number.
  const fits = VOL.storagePlanRow({ perDay: 10 * GB, headroomPercent: 30, livePolicy: VOL.parseRetention('7d'), disk: disk(3000, 1000),
    ulm: false, backupPolicy: VOL.parseRetention('7d'), backupCapacity: VOL.parseSize('2TB') });
  assert.deepEqual([fits.liveShortfall, fits.backupShortfall], [0, 0]);
});

test('a Storage plan row never guesses: not set, not measured, ULM', () => {
  const noPolicy = VOL.storagePlanRow({ perDay: 10 * GB, headroomPercent: 30, livePolicy: null, disk: disk(100, 10), ulm: false, backupPolicy: null, backupCapacity: null });
  assert.deepEqual([noPolicy.liveRequired, noPolicy.liveShortfall, noPolicy.liveWhy], [null, null, 'not set']);
  assert.deepEqual([noPolicy.backupRequired, noPolicy.backupShortfall, noPolicy.backupWhy], [null, null, 'not set']);
  const noRate = VOL.storagePlanRow({ perDay: null, headroomPercent: 30, livePolicy: VOL.parseRetention('30d'), disk: disk(100, 10), ulm: false,
    backupPolicy: VOL.parseRetention('30d'), backupCapacity: VOL.parseSize('1TB') });
  assert.deepEqual([noRate.buffered, noRate.liveShortfall, noRate.liveWhy, noRate.backupWhy], [null, null, 'not measured', 'not measured']);
  const noDisk = VOL.storagePlanRow({ perDay: GB, headroomPercent: 30, livePolicy: VOL.parseRetention('30d'), disk: { measured: false } });
  assert.deepEqual([noDisk.liveShortfall, noDisk.liveWhy], [null, 'disk not measured']);
  const noCap = VOL.storagePlanRow({ perDay: GB, headroomPercent: 30, backupPolicy: VOL.parseRetention('30d'), backupCapacity: null, disk: disk(1, 0) });
  assert.deepEqual([noCap.backupShortfall, noCap.backupWhy, noCap.backupRequired], [null, 'no capacity', 1.3 * 30 * GB]);
  const ulm = VOL.storagePlanRow({ perDay: GB, headroomPercent: 30, ulm: true, backupPolicy: VOL.parseRetention('90d'), backupCapacity: null, disk: disk(1, 0) });
  assert.deepEqual([ulm.backupRequired, ulm.backupShortfall, ulm.backupWhy], [null, null, 'ulm']);
  // The headroom is the cluster's own (volumeHeadroomPercent), default 30.
  assert.equal(VOL.storagePlanRow({ perDay: 10 * GB, headroomPercent: 50 }).buffered, 15 * GB);
  assert.equal(VOL.storagePlanRow({ perDay: 10 * GB }).buffered, 13 * GB);
});

test('live retention held now: oldest dated index to today, else the ILM delete age', () => {
  assert.deepEqual(VOL.liveHeldDays([{ day: '2026-10-22' }, { day: '2026-11-04' }, { index: 'x' }], {}, TODAY), { days: 14, from: '2026-10-22', source: 'indices' });
  assert.deepEqual(VOL.liveHeldDays([], { appliedIlm: { deleteAfter: '30d' } }, TODAY), { days: 30, from: null, source: 'ILM' });
  assert.equal(VOL.liveHeldDays([], {}, TODAY), null);
});

test('volumeReport on the Reports figures: the event rate and the data-node disk, unknown stays unknown', () => {
  const c = { name: 'c', url: 'http://c', liveRetention: '10d' };
  const data = { disk: { total: 999 * GB, used: 1, avail: 1, percent: 1 } };
  const r = VOL.volumeReport(c, data, [], null, { perDayBytes: 10 * GB, disk: disk(200, 50) });
  assert.equal(r.perDayGB, 10);
  assert.equal(r.liveTotalGB, 200, 'data nodes, not the allocation sum');
  assert.equal(r.requiredLiveGB, 130);
  assert.equal(r.liveRetentionMet, true);
  const unknown = VOL.volumeReport(c, data, [], null, { perDayBytes: null, disk: { measured: false } });
  assert.equal(unknown.liveRetentionMet, null, 'no rate: unknown, not NO');
  assert.equal(VOL.sheetCell(VOL.SHEET_COLUMNS.find((x) => x.label === 'Indices size per day'), unknown), '–');
  assert.equal(VOL.sheetCell(VOL.SHEET_COLUMNS.find((x) => x.label === 'Disk total'), unknown), '–');
  // Without opts: the index-list figure the Zabbix feed, Play and the alert rules keep.
  assert.equal(VOL.volumeReport(c, data, [], null).liveTotalGB, 999);
});

/* ------------------------------------ measure size ------------------------------------ */

test('Measure size: difference = index − event_logsize (signed), ratio = index ÷ event_logsize', () => {
  assert.deepEqual(V.sizeDifference(12 * GB, 10 * GB), { diff: 2 * GB, ratio: 1.2 });
  assert.deepEqual(V.sizeDifference(8 * GB, 10 * GB), { diff: -2 * GB, ratio: 0.8 });
  assert.deepEqual(V.sizeDifference(null, 10 * GB), { diff: null, ratio: null });
  assert.deepEqual(V.sizeDifference(1, 0), { diff: 1, ratio: null });
  const r = record(30, (i) => (i <= 7 ? 1 * GB : null));
  const m = V.measureSize(r, 7, { today: TODAY });
  assert.equal(m.indexPerDay, 2 * GB);
  assert.equal(m.eventPerDay, V.perDayEventBytes(r, 7, { today: TODAY }), 'the one rate');
  assert.deepEqual([m.diff, m.ratio, m.eventField, m.rows.length, m.rows[0].day], [GB, 2, true, 7, V.addDays(TODAY, -1)]);
  const none = V.measureSize(record(7, () => null), 7, { today: TODAY });
  assert.deepEqual([none.eventPerDay, none.diff, none.ratio, none.eventField], [null, null, null, false]);
  assert.equal(V.measureSize(r, 1, { today: TODAY }).rows.length, 1, 'Yesterday');
});

/* ------------------------------------ day and month ------------------------------------ */

test('a day\'s status: final, today so far, shards failed, not measured', () => {
  assert.equal(V.dayStatus({ day: TODAY }, { today: TODAY }).text, 'today so far');
  assert.equal(V.dayStatus({ day: '2026-11-01', final: true, eventBytes: 1 }, { today: TODAY }).text, 'final');
  assert.equal(V.dayStatus({ day: '2026-11-01', final: false, error: '2 of 28 shards failed (timeout): figures may be short; asked again on the next run' }, { today: TODAY }).text,
    '2 of 28 shards failed · asked again');
  assert.equal(V.dayStatus({ day: '2026-11-01', final: true, eventBytes: null }, { today: TODAY }).text, 'not measured');
  assert.equal(V.dayStatus({ day: '2026-11-01', final: false }, { today: TODAY }).text, 'not aggregated yet');
});

test('a month against the previous one only when both are whole', () => {
  const m = (month, days, ev, partial = false) => ({ month, daysWithData: days, eventBytes: ev, partial });
  assert.equal(V.monthVsPrevious(m('2026-10', 31, 110), m('2026-09', 30, 100)).pct, 10);
  assert.equal(V.monthVsPrevious(m('2026-11', 3, 10, true), m('2026-10', 31, 110)).why, 'so far');
  assert.equal(V.monthVsPrevious(m('2026-04', 28, 10), m('2026-03', 31, 110)).why, 'partial');
  assert.equal(V.monthVsPrevious(m('2026-10', 31, 110), m('2026-09', 20, 100)).pct, null);
  assert.equal(V.monthVsPrevious(m('2026-10', 31, 110), null).pct, null);
});

test('the Reports CSVs carry event_logsize and leave unmeasured cells empty', () => {
  const r = record(3, (i) => (i === 2 ? null : i * GB));
  const rows = V.reportDailyCsvRows('prod', r, 7, { today: TODAY });
  assert.deepEqual(Object.keys(rows[0]), V.REPORT_DAILY_CSV);
  assert.equal(rows[0].day, TODAY, 'newest first');
  assert.equal(rows[2].event_bytes, null);
  assert.equal(rows[2].event_bytes_measured, 'false');
  assert.equal(rows[2].status, 'not measured');
  const months = [{ month: '2026-09', daysWithData: 30, eventBytes: 100, docs: 1 }, { month: '2026-10', daysWithData: 31, eventBytes: 120, docs: 2 }];
  const mrows = V.reportMonthlyCsvRows('prod', months, null, { today: TODAY });
  assert.deepEqual(Object.keys(mrows[0]), V.REPORT_MONTHLY_CSV);
  assert.deepEqual([mrows[0].month, mrows[0].vs_previous_pct, mrows[0].peak_event_bytes], ['2026-10', 20, null]);
  const all = V.monthlyAllEventCsvRows({ clusters: [{ name: 'a', months: [{ month: '2026-10', daysWithData: 3, eventBytes: 7, priBytes: 99 }] }] });
  assert.deepEqual(all.rows, [{ cluster: 'a', '2026-10': 7 }], 'event_logsize, not primary size');
});

/* ------------------------------------ route, band ------------------------------------ */

test('the route: #/reports/<section>, Overview by default, #/volume is an alias', () => {
  assert.deepEqual(R.REPORT_SECTIONS.map((s) => s.label), ['Overview', 'Daily & monthly', 'Capacity & retention', 'Measure size', 'Planning', 'Exports & schedules']);
  assert.equal(R.sectionOfHash('#/reports'), 'overview');
  assert.equal(R.sectionOfHash('#/reports/capacity'), 'capacity');
  assert.equal(R.sectionOfHash('#/volume'), 'overview');
  assert.equal(R.sectionOfHash('#/volume/measure'), 'measure');
  assert.equal(R.sectionOfHash('#/reports/nonsense'), 'overview');
  assert.equal(R.sectionOfHash('#/indices'), 'overview');
  assert.deepEqual(R.parseHash('#/volume/daily?x=1'), { page: 'reports', rest: 'daily' });
  assert.deepEqual(R.parseHash('#/play'), { page: 'play', rest: '' });
  assert.equal(R.pageAlias('volume'), 'reports');
  assert.equal(R.pageAlias('indices'), 'indices');
  assert.equal(R.sectionHash('daily'), '#/reports/daily');
  assert.equal(R.sectionHash('nope'), '#/reports/overview');
});

test('the group band shows while each group is one run, and hides when a reorder mixes them', () => {
  const defs = [
    { key: 'cluster', label: 'Cluster', locked: true }, { key: 'perDay', label: 'Per day' },
    { key: 'a', label: 'A', group: 'Live' }, { key: 'b', label: 'B', group: 'Live' },
    { key: 'x', label: 'X', group: 'Backup' }, { key: 'y', label: 'Y', group: 'Backup' },
  ];
  assert.deepEqual(C.groupBand(defs, null), [{ group: '', span: 2 }, { group: 'Live', span: 2 }, { group: 'Backup', span: 2 }]);
  const mixed = C.moveTo(defs, null, 'x', 1);            // X between Per day and A: still runs
  assert.equal(C.groupBand(defs, mixed), null, 'Backup comes back after Live: mixed');
  const hidden = C.setShown(defs, null, 'b', false);
  assert.deepEqual(C.groupBand(defs, hidden), [{ group: '', span: 2 }, { group: 'Live', span: 1 }, { group: 'Backup', span: 2 }]);
});


test('a null index size (not measured since 0.3.53) renders "not measured" in amber, never "0 B"', async () => {
  const D = await import(pathToFileURL(path.join(ROOT, 'ui/js/reports/daily.js')).href);
  const nm = D.indexSizeCell(null);
  assert.equal(nm.textContent, 'not measured');
  assert.ok(nm.classList.contains('vs-notm'), 'amber');
  assert.equal(D.indexSizeCell(undefined).textContent, 'not measured');
  assert.equal(D.indexSizeCell(0), '0 B', 'a measured 0 is a 0');
  const cell = D.dailyCellFor({ settings: {}, days: [] });
  const day = { day: '2026-11-01', final: true, indices: 2, docs: 10, priBytes: null, totalBytes: null, eventBytes: 5 };
  for (const k of ['priBytes', 'totalBytes']) {
    const c = cell(k, day);
    assert.equal(typeof c === 'string' ? c : c.textContent, 'not measured', k);
  }
  // Measure size: a null day is left out of the index size per day, never counted as 0.
  const m = V.measureSize({ days: [{ day: '2026-11-03', priBytes: null, eventBytes: GB }, { day: '2026-11-02', priBytes: 2 * GB, eventBytes: GB }] }, 7, { today: TODAY });
  assert.equal(m.indexPerDay, 2 * GB);
  assert.deepEqual([m.rows[0].index, m.rows[0].diff, m.rows[0].ratio], [null, null, null]);
  assert.equal(V.measureSize({ days: [{ day: '2026-11-03', priBytes: null, eventBytes: GB }] }, 7, { today: TODAY }).indexPerDay, null);
  // The CSVs keep a null size empty.
  assert.equal(V.monthlyCsvRows('c', [{ month: '2026-10', daysWithData: 3, priBytes: null, eventBytes: 9 }])[0].primary_bytes, null);
  assert.equal(V.dailyCsvRows('c', { days: [day] }, 7)[0].primary_bytes, null);
});
