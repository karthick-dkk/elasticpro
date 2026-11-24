/**
 * The log-delay report, as sheets.
 *
 * Pure: records in, rows out. The page downloads it and the scheduler will hand the same
 * rows to whatever runs unattended, so the report cannot come out differently depending
 * on which of them asked for it — the failure this codebase has had three times.
 *
 * Three sheets (four with log types), because a report that flattens them answers only one question:
 *
 *   * **Devices** — every measurement, the thing that gets sorted and filtered.
 *   * **Log types** — one row per device and log type, where log types were measured (0.3.90).
 *   * **Summary** — the counts by status and the median, so a reader who wants the
 *     shape does not have to build a pivot table to get it.
 *   * **Not measured** — the clusters that did not answer, by name. A report of six
 *     clusters that looks like a report of nine is the failure this whole feature has
 *     been built to avoid, and a spreadsheet is where a missing row is least visible.
 */

import { STATUS } from './log-delay.js';
import { isLate } from './delay-levels.js';
import { noDelayOfStatuses, noDelaySplit, shareText } from './logdelay-report.js';

/** The column order, in one place, so the header and the rows cannot drift apart. */
export const DEVICE_COLUMNS = [
  { key: 'cluster', label: 'Cluster' },
  { key: 'device', label: 'Device' },
  { key: 'zone', label: 'zone' },
  { key: 'tag1', label: 'tag1' },
  { key: 'status', label: 'Status' },
  { key: 'delayMinutes', label: 'Delay (minutes)', number: true },
  { key: 'docs', label: 'Documents', number: true },
  { key: 'pattern', label: 'Pattern' },
  { key: 'arrival', label: 'Last seen (UTC)' },
  { key: 'event', label: 'Event time (UTC)' },
  { key: 'detail', label: 'What it means' },
];

/** Added after Status where log types were measured: how many, how many late, which. Blank: not measured, never 0. */
export const TYPE_COLUMNS = Object.freeze(['Log types', 'Log types measured', 'Log types late', 'Late log types', 'Delay is of log type']);
const hasTypes = (records) => (records || []).some((r) => Array.isArray(r.types));
const typeCells = (r) => {
  if (!Array.isArray(r.types)) return [null, null, null, null, null];
  const late = r.types.filter((t) => isLate(t.state));
  const measured = r.types.filter((t) => t.delayMinutes !== null).length;
  return [r.typesTruncated ? `${r.types.length}+` : r.types.length, measured, measured ? late.length : null, late.map((t) => t.label).join('; ') || null, r.delayLogType || null];
};
const AFTER = DEVICE_COLUMNS.findIndex((c) => c.key === 'status') + 1;
const deviceHead = (records) => { const l = DEVICE_COLUMNS.map((c) => c.label); if (hasTypes(records)) l.splice(AFTER, 0, ...TYPE_COLUMNS); return l; };

const iso = (ms) => (ms ? new Date(ms).toISOString().replace('.000Z', 'Z') : null);

/** Two decimals, or null. A delay that could not be measured is never a zero. */
function delayCell(v) {
  return v === null || v === undefined || !isFinite(v) ? null : Math.round(v * 100) / 100;
}

/** A context field of a measured device (its `meta`, any case); null when the device has none. */
function contextOf(r, name) {
  for (const [k, v] of Object.entries((r && r.meta) || {})) {
    if (String(k).toLowerCase() === name && v !== null && v !== undefined && v !== '') return String(v);
  }
  return null;
}

function deviceRows(records) {
  const rank = { CRITICAL: 0, DELAYED: 1, PART_DELAY: 1.5, CLOCK_AHEAD: 2, ERROR: 3, NO_DATA: 4, OK: 5 };
  const typed = hasTypes(records);
  const sorted = [...(records || [])].sort((a, b) =>
    (rank[a.status] - rank[b.status]) || ((b.delayMinutes ?? -1e9) - (a.delayMinutes ?? -1e9)));
  return sorted.map((r) => [
    r.cluster || '',
    r.device || '',
    contextOf(r, 'zone'),
    contextOf(r, 'tag1'),
    (STATUS[r.status] || {}).label || r.status || '',
    ...(typed ? typeCells(r) : []),
    delayCell(r.delayMinutes),
    Number(r.docs) || 0,
    r.pattern && r.pattern !== '-' ? r.pattern : null,
    iso(r.arrival),
    iso(r.event),
    r.patternNote || r.reason || '',
  ]);
}

/** One row per device and log type measured; a cluster without log_type is named under them. */
function typeRows(records, noLogTypes) {
  const rows = [['Cluster', 'Device', 'Log type', 'Status', 'Delay (minutes)', 'Documents', 'Last seen (UTC)', 'Event time (UTC)']];
  for (const r of records || []) {
    for (const t of Array.isArray(r.types) ? r.types : []) {
      rows.push([r.cluster || '', r.device || '', t.label, (STATUS[t.status] || {}).label || t.status || '', delayCell(t.delayMinutes), Number(t.docs) || 0, iso(t.arrival), iso(t.event)]);
    }
    if (r.typesTruncated) rows.push([r.cluster || '', r.device || '', `the ${r.types.length} log types read; the device has more, not read`]);
  }
  for (const x of noLogTypes || []) rows.push([`Not measured per log type: ${x}`]);
  return rows;
}

function summaryRows(records, summary, meta) {
  const s = summary || {};
  const by = s.by || {};
  const rows = [
    ['Generated (UTC)', iso(meta.generatedAt || Date.now())],
    ['Window', meta.windowText || (meta.windowHours ? `last ${meta.windowHours} hour(s)` : '')],
    ['Clusters measured', Number(meta.measured) || 0],
    ['Clusters not measured', Number(meta.notMeasured) || 0],
    ['Devices', Number(s.devices) || 0],
    ['Median delay (minutes)', delayCell(s.median)],
    [],
    ['Status', 'Devices'],
  ];
  for (const [key, label] of Object.entries(STATUS).map(([k, v]) => [k, v.label])) {
    // Part delayed is counted only where log types were measured: no row is not "0".
    if (key === 'PART_DELAY' && by[key] === undefined) continue;
    rows.push([label, Number(by[key]) || 0]);
  }
  const nd = noDelayOfStatuses(s);
  if (s.logTypes) rows.push(['Log types late (counted per device)', Number(s.logTypes.late) || 0, `of ${Number(s.logTypes.total) || 0} log types`]);
  rows.push([], ['No delay (on time, silent and can\'t measure)', nd.count, nd.pct ? shareText(nd.pct.noDelay) : `no percentage: ${nd.why}`, noDelaySplit(nd, { counts: true })]);
  // Elasticsearch counts the documents of the devices it left out, not the devices.
  if (s.truncated) rows.push([], ['Documents of devices beyond the per-cluster limit (how many devices is not known)', Number(s.truncated) || 0]);
  if ((s.gaps || []).length) rows.push([], ['Read in part'], ...s.gaps.map((g) => [g]));
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
 * @param meta     { generatedAt, windowHours, measured, notMeasured, missing: [{cluster, reason}], noLogTypes: ['cluster: why'] }
 * @returns [{ name, rows }] ready for the workbook writer
 */
export function reportSheets(records, summary, meta = {}) {
  return [
    { name: 'Devices', rows: [deviceHead(records), ...deviceRows(records)] },
    ...(hasTypes(records) ? [{ name: 'Log types', rows: typeRows(records, meta.noLogTypes) }] : []),
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
