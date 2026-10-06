/**
 * The log-delay report, as sheets.
 *
 * Pure: records in, rows out. The page downloads it and the scheduler will hand the same
 * rows to whatever runs unattended, so the report cannot come out differently depending
 * on which of them asked for it — the failure this codebase has had three times.
 *
 * Three sheets, because a report that flattens them answers only one question:
 *
 *   * **Devices** — every measurement, the thing that gets sorted and filtered.
 *   * **Summary** — the counts by status and the median, so a reader who wants the
 *     shape does not have to build a pivot table to get it.
 *   * **Not measured** — the clusters that did not answer, by name. A report of six
 *     clusters that looks like a report of nine is the failure this whole feature has
 *     been built to avoid, and a spreadsheet is where a missing row is least visible.
 */

import { STATUS } from './log-delay.js';

/** The column order, in one place, so the header and the rows cannot drift apart. */
export const DEVICE_COLUMNS = [
  { key: 'cluster', label: 'Cluster' },
  { key: 'device', label: 'Device' },
  { key: 'status', label: 'Status' },
  { key: 'delayMinutes', label: 'Delay (minutes)', number: true },
  { key: 'docs', label: 'Documents', number: true },
  { key: 'pattern', label: 'Pattern' },
  { key: 'arrival', label: 'Last seen (UTC)' },
  { key: 'event', label: 'Event time (UTC)' },
  { key: 'detail', label: 'What it means' },
];

const iso = (ms) => (ms ? new Date(ms).toISOString().replace('.000Z', 'Z') : null);

/** Two decimals, or null. A delay that could not be measured is never a zero. */
function delayCell(v) {
  return v === null || v === undefined || !isFinite(v) ? null : Math.round(v * 100) / 100;
}

function deviceRows(records) {
  const rank = { CRITICAL: 0, DELAYED: 1, CLOCK_AHEAD: 2, ERROR: 3, NO_DATA: 4, OK: 5 };
  const sorted = [...(records || [])].sort((a, b) =>
    (rank[a.status] - rank[b.status]) || ((b.delayMinutes ?? -1e9) - (a.delayMinutes ?? -1e9)));
  return sorted.map((r) => [
    r.cluster || '',
    r.device || '',
    (STATUS[r.status] || {}).label || r.status || '',
    delayCell(r.delayMinutes),
    Number(r.docs) || 0,
    r.pattern && r.pattern !== '-' ? r.pattern : null,
    iso(r.arrival),
    iso(r.event),
    r.patternNote || r.reason || '',
  ]);
}

function summaryRows(records, summary, meta) {
  const s = summary || {};
  const by = s.by || {};
  const rows = [
    ['Generated (UTC)', iso(meta.generatedAt || Date.now())],
    ['Window', meta.windowHours ? `last ${meta.windowHours} hour(s)` : ''],
    ['Clusters measured', Number(meta.measured) || 0],
    ['Clusters not measured', Number(meta.notMeasured) || 0],
    ['Devices', Number(s.devices) || 0],
    ['Median delay (minutes)', delayCell(s.median)],
    [],
    ['Status', 'Devices'],
  ];
  for (const [key, label] of Object.entries(STATUS).map(([k, v]) => [k, v.label])) {
    rows.push([label, Number(by[key]) || 0]);
  }
  if (s.truncated) {
    rows.push([], ['Devices beyond the per-cluster limit', Number(s.truncated) || 0]);
  }
  return rows;
}

/**
 * The clusters that produced no measurement, and why.
 *
 * Always present, even when empty — a sheet that disappears when everything worked
 * means its absence carries information nobody reads, and a reader who does not find it
 * cannot tell whether every cluster answered or the report simply does not say.
 */
function missingRows(missing) {
  const rows = [['Cluster', 'Why it is not in this report']];
  for (const m of missing || []) rows.push([m.cluster || '', m.reason || 'unknown']);
  if (!(missing || []).length) rows.push(['—', 'Every selected cluster was measured.']);
  return rows;
}

/**
 * @param records  merged device records, each carrying `cluster`
 * @param summary  the output of summarise()
 * @param meta     { generatedAt, windowHours, measured, notMeasured, missing: [{cluster, reason}] }
 * @returns [{ name, rows }] ready for the workbook writer
 */
export function reportSheets(records, summary, meta = {}) {
  return [
    { name: 'Devices', rows: [DEVICE_COLUMNS.map((c) => c.label), ...deviceRows(records)] },
    { name: 'Summary', rows: summaryRows(records, summary, meta) },
    { name: 'Not measured', rows: missingRows(meta.missing) },
  ];
}

/** `log-delay-2026-09-20-1530.xlsx` — sortable, and unique per minute. */
export function reportFilename(at = Date.now(), prefix = 'log-delay') {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    + `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}.xlsx`;
}
