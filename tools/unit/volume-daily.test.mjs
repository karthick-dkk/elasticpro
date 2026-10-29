/**
 * The daily volume record's UI side (ui/js/core/volume-daily.js): telling an older core
 * from a refusal, when the desktop asks for a run, the words for where a month came from,
 * and the CSV columns docs/VOLUME.md names. None of it works out a figure; these check
 * that what the core sends reaches the file unchanged, and that null stays empty.
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

test('an older core is told apart from a real refusal', () => {
  assert.equal(V.isUnsupported({ ok: false, kind: 'bad_message', message: 'Unknown message type "VOLUME_DAILY" (EP-202)' }, 'VOLUME_DAILY'), true);
  // Hosted, below admin: an unknown type needs admin, so it arrives as a role refusal.
  assert.equal(V.isUnsupported({ ok: false, kind: 'forbidden', role: 'user', message: 'VOLUME_DAILY is not available to the user role' }, 'VOLUME_DAILY'), true);
  // A guest refused is refused; so is an operator-only write.
  assert.equal(V.isUnsupported({ ok: false, kind: 'forbidden', role: 'guest', message: 'VOLUME_DAILY is not available to the guest role' }, 'VOLUME_DAILY'), false);
  assert.equal(V.isUnsupported({ ok: false, kind: 'forbidden', role: 'user', message: 'VOLUME_LAYOUT_SET is not available to the user role' }, 'VOLUME_LAYOUT_SET'), false);
  assert.equal(V.isUnsupported({ ok: false, kind: 'unreachable', message: 'x' }, 'VOLUME_DAILY'), false);
  assert.equal(V.isUnsupported({ ok: true }, 'VOLUME_DAILY'), false);
});

test('the desktop asks for a run when the last is older than the last collectAt that passed', () => {
  const at = (h, m, dayOffset = 0) => { const d = new Date(2026, 9, 29 + dayOffset, h, m, 0, 0); return d.getTime(); };
  const now = at(9, 0);
  assert.equal(V.collectDue({ lastRunAt: null, collectAt: '06:00' }, now), true, 'never run');
  assert.equal(V.collectDue({ lastRunAt: at(5, 59), collectAt: '06:00' }, now), true, 'before today\'s 06:00');
  assert.equal(V.collectDue({ lastRunAt: at(6, 30), collectAt: '06:00' }, now), false, 'after it');
  // Before today's collectAt, yesterday's is the one that counts.
  const early = at(4, 0);
  assert.equal(V.collectDue({ lastRunAt: at(7, 0, -1), collectAt: '06:00' }, early), false);
  assert.equal(V.collectDue({ lastRunAt: at(5, 0, -1), collectAt: '06:00' }, early), true);
  // A run under way is followed, not asked for again; an ISO time reads as well as ms.
  assert.equal(V.collectDue({ lastRunAt: null, running: true }, now), false);
  assert.equal(V.collectDue({ lastRunAt: new Date(at(6, 30)).toISOString(), collectAt: '06:00' }, now), false);
});

test('where a month came from, in words', () => {
  assert.equal(V.fromText({ month: '2026-10', daysWithData: 29, liveDays: 29, keptDays: 0 }, '2026-01'), 'live indices');
  assert.equal(V.fromText({ month: '2026-03', daysWithData: 31, liveDays: 0, keptDays: 31 }, '2026-01'), 'kept record');
  assert.equal(V.fromText({ month: '2026-09', daysWithData: 31, liveDays: 19, keptDays: 12 }, '2026-01'), '12 days kept record, 19 live');
  assert.equal(V.fromText({ month: '2025-12', daysWithData: 0 }, '2026-01'), 'before the record began');
  assert.equal(V.fromText({ month: '2026-05', daysWithData: 0 }, '2026-01'), 'no record');
});

test('daily CSV: the contract\'s columns, null left empty, "measured" said', () => {
  const reply = { days: [
    { day: '2026-10-28', indices: 2, docs: 10, priBytes: 100, totalBytes: 200, eventBytes: 50, subBytes: null, changeVsAvgPct: 61.04 },
    { day: '2026-10-27', indices: 2, docs: null, priBytes: 90, totalBytes: 180, eventBytes: null, subBytes: null, changeVsAvgPct: null },
  ] };
  const rows = V.dailyCsvRows('prod', reply, 7);
  assert.deepEqual(Object.keys(rows[0]), V.DAILY_CSV);
  assert.equal(rows[0].event_bytes_measured, 'true');
  assert.equal(rows[1].event_bytes_measured, 'false');
  assert.equal(rows[1].event_bytes, null);
  assert.equal(rows[1].docs, null);
  assert.equal(rows[0].change_vs_avg_pct, 61);
  assert.equal(rows[0].avg_days, 7);
});

test('monthly and breakdown CSV: the contract\'s columns, picked from the core\'s rows', () => {
  const m = V.monthlyCsvRows('prod', [{ month: '2026-09', daysWithData: 30, priBytes: 3000, avgPerDay: 100, peakDay: { day: '2026-09-14', basis: 160 }, docs: 9, eventBytes: null, keptDays: 12 }]);
  assert.deepEqual(Object.keys(m[0]), V.MONTHLY_CSV);
  assert.deepEqual([m[0].peak_day, m[0].peak_primary_bytes, m[0].from_kept_record_days, m[0].event_bytes], ['2026-09-14', 160, 12, null]);
  const b = V.breakdownCsvRows('prod', { field: 'sourceHost', resolved: 'src_hostname', rows: [
    { value: 'fw-1', docs: 5, eventBytes: 10, estPriBytes: 20, sharePct: 40.04, daysSeen: 3 },
    { kind: 'missing', docs: 1, eventBytes: null, estPriBytes: 2, sharePct: 4, daysSeen: 3 },
    { kind: 'other', docs: 2, eventBytes: 3, estPriBytes: 4, sharePct: 8, daysSeen: 3 },
  ] }, { from: '2026-10-01', to: '2026-10-29' });
  assert.deepEqual(Object.keys(b[0]), V.BREAKDOWN_CSV);
  assert.deepEqual(b.map((r) => r.value), ['fw-1', '(not set)', 'all others']);
  assert.equal(b[0].share_pct, 40);
  assert.equal(b[1].event_bytes, null);
});

test('all clusters by month: a column per month any cluster has, empty where there is no record', () => {
  const { headers, rows } = V.monthlyAllCsvRows({ clusters: [
    { clusterId: 'a', name: 'A', months: [{ month: '2026-09', daysWithData: 30, priBytes: 5 }, { month: '2026-10', daysWithData: 29, priBytes: 6 }] },
    { clusterId: 'b', name: 'B', months: [{ month: '2026-10', daysWithData: 0, priBytes: 0 }] },
  ] });
  assert.deepEqual(headers, ['cluster', '2026-09', '2026-10']);
  assert.deepEqual(rows, [{ cluster: 'A', '2026-09': 5, '2026-10': 6 }, { cluster: 'B', '2026-09': null, '2026-10': null }]);
});

test('breakdown periods are whole UTC days, finished ones for yesterday and the last 7', () => {
  const now = Date.UTC(2026, 9, 29, 15);
  const p = V.breakdownPeriods(now, 2);
  const by = Object.fromEntries(p.map((x) => [x.id, x]));
  assert.deepEqual([by.month.from, by.month.to], ['2026-10-01', '2026-10-29']);
  assert.deepEqual([by.yesterday.from, by.yesterday.to], ['2026-10-28', '2026-10-28']);
  assert.deepEqual([by.last7.from, by.last7.to], ['2026-10-22', '2026-10-28']);
  assert.deepEqual([by['m:2026-09'].from, by['m:2026-09'].to], ['2026-09-01', '2026-09-30']);
  assert.deepEqual([by['m:2026-08'].from, by['m:2026-08'].to], ['2026-08-01', '2026-08-31']);
  assert.deepEqual(V.lastMonths(3, now), ['2026-08', '2026-09', '2026-10']);
});
