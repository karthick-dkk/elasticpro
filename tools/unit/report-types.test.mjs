/**
 * The report kinds' adapter (core/report-types.js, docs/REPORT-TYPES.md): schedule defaults
 * per kind, the 5-cluster cap, month ranges, and a HOSTS_QUERY reply where an absent figure
 * stays null (not measured), never 0. Pure; jsdom only because core/reports.js sits beside DOM code.
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
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/report-types.js')).href);

test('defaults per kind: Indices daily 08:00, Volume by host daily 06:00, both month so far, off', () => {
  const i = T.scheduleOf('indices', { ok: true });
  assert.deepEqual([i.schedule, i.at, i.period, i.enabled], ['daily', '08:00', 'monthSoFar', false]);
  const hs = T.scheduleOf('hosts', { ok: true });
  assert.deepEqual([hs.schedule, hs.at, hs.period, hs.enabled], ['daily', '06:00', 'monthSoFar', false]);
  assert.equal(T.scheduleOf('volume', { ok: true }).period, 'cadence');
});

test('a locked field is read from field names and config.txt keys', () => {
  const s = T.scheduleOf('hosts', { ok: true, managed: ['UI_REPORT_HOSTS_TO', 'UI_REPORT_HOSTS_AT', 'schedule', 'UI_REPORT_TO'] });
  assert.deepEqual([...s.managed].sort(), ['at', 'schedule', 'to']);
});

test('Volume by host takes at most 5 clusters', () => {
  assert.equal(T.runProblem('hosts', ['a', 'b', 'c', 'd', 'e']), '');
  assert.match(T.runProblem('hosts', ['a', 'b', 'c', 'd', 'e', 'f']), /at most 5/);
  assert.equal(T.runProblem('indices', ['a', 'b', 'c', 'd', 'e', 'f']), '');
  assert.match(T.runProblem('indices', []), /at least one/);
  assert.match(T.runFailText({ kind: 'too_many_clusters' }), /at most 5/);
});

test('month so far ends yesterday; a past month is whole; the 1st shows its own day', () => {
  assert.deepEqual(T.monthRange('2026-11', '2026-11-04'), { from: '2026-11-01', to: '2026-11-03' });
  assert.deepEqual(T.monthRange('2026-10', '2026-11-04'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(T.monthRange('2026-02', '2026-11-04'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(T.monthRange('2026-11', '2026-11-01'), { from: '2026-11-01', to: '2026-11-01' });
});

test('HOSTS_QUERY: a missing figure is null, not 0; fields and incomplete days pass through', () => {
  const r = T.hostsOf({ ok: true, rows: [{ day: '2026-11-01', index: 'a-2026.11.01', host: 'h1', docs: 5, eventBytes: null, meta: { zone: 'x' } }],
    total: 1, totals: { docs: 5 }, incompleteDays: ['2026-11-02'], fields: ['zone'], notInMapping: ['tag1'] });
  assert.equal(r.rows[0].eventBytes, null);
  assert.equal(r.rows[0].subBytes, null);
  assert.equal(r.totals.eventBytes, null);
  assert.deepEqual([r.incompleteDays, r.fields, r.notInMapping], [['2026-11-02'], ['zone'], ['tag1']]);
  assert.equal(T.hostsOf(null).total, 0);
  assert.equal(T.sortKey('docs', 'desc'), 'docs:desc');
});

test('config.txt hosts keys: not reported stays unknown, locked ones are marked', () => {
  assert.equal(T.configOf(undefined), null);
  const rows = T.configOf({ fields: ['zone', 'tag1'], keepMonths: 3, managed: ['UI_REPORT_HOSTS_KEEP_MONTHS'] });
  const by = Object.fromEntries(rows.map((x) => [x.key, x]));
  assert.equal(by.fields.value, 'zone, tag1');
  assert.equal(by.keepMonths.locked, true);
  assert.equal(by.branchDefault.known, false);
});
