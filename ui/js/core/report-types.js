/**
 * The report kinds (0.3.54, docs/REPORT-TYPES.md): Volume report, Indices report and Volume
 * by host. This file is the ONE place the UI knows how those messages are shaped; the core's
 * field names are read here and nowhere else, so reconciling the two is a one-file change.
 *
 * Sent:
 *   REPORT_RUN           {kind, clusterIds, period, format, mail, collectAgain?}
 *   REPORT_SCHEDULE_GET  {kind}   -> flat schedule + {kind, managed, nextPeriod?, config?}
 *   REPORT_SCHEDULE_SET  {kind, enabled, to, cc, bcc, schedule, at, period, clusters, subject, ...}
 *   REPORT_SEND_NOW      {kind}
 *   HOSTS_QUERY          {clusterId, period:{from,to}, q, sort:"<col>:<asc|desc>", offset, limit}
 *     sort columns: day index source host docs eventBytes subBytes meta.<field>
 *
 * Read (HOSTS_QUERY): {rows:[{day,index,source,host,docs,eventBytes,subBytes,meta}], total,
 *   totals:{docs,eventBytes,subBytes}, incompleteDays, fields, notInMapping}. A figure that is
 *   null/absent is NOT MEASURED, never 0.
 */

import { reportSend } from './reports.js';

/** The most clusters one Volume by host run takes (docs/REPORT-TYPES.md "Run now"). */
export const HOSTS_MAX_CLUSTERS = 5;
export const HOSTS_PAGE = 200;

export const KINDS = Object.freeze([
  { id: 'volume', label: 'Volume report', sizes: 'Every size in this report is event_logsize.',
    defaults: { schedule: 'monthly', at: '07:00', period: 'cadence' } },
  { id: 'indices', label: 'Indices report', sizes: 'Sizes in this report are index store size (primary shards), not event_logsize: it lists the indices as Elasticsearch holds them.',
    defaults: { schedule: 'daily', at: '08:00', period: 'monthSoFar' } },
  { id: 'hosts', label: 'Volume by host', sizes: 'Sizes in this report are event_logsize (and the forwarded size), summed per day, index and source host.',
    defaults: { schedule: 'daily', at: '06:00', period: 'monthSoFar' } },
]);
export const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];

/** Cadences, as the Volume report offers them. */
export const CADENCES = [
  ['monthly', 'Monthly · 1st of the month'], ['weekly', 'Weekly · Monday'],
  ['daily', 'Daily'], ['manual', 'Only when sent by hand'],
];
/** What the scheduled mail covers. `cadence` is the cadence's own period (the Volume report's today). */
export const SCHEDULE_PERIODS = [
  ['monthSoFar', 'Month so far'], ['yesterday', 'Yesterday'], ['cadence', "The cadence's own period"],
];

/** The periods Run now offers: Month so far first (the default), then the existing presets. */
export function runPeriods(presets) {
  return [{ value: 'monthSoFar', label: 'Month so far' }, ...(presets || []).slice(1)];
}

const asList = (x) => (Array.isArray(x) ? x : []);

/** A schedule reply as the editor reads it, with the kind's defaults where the core says nothing. */
export function scheduleOf(kind, res) {
  const d = kindOf(kind).defaults;
  const s = res && res.ok ? res : {};
  return {
    kind,
    enabled: !!s.enabled,
    to: asList(s.to), cc: asList(s.cc), bcc: asList(s.bcc),
    schedule: s.schedule || d.schedule,
    at: s.at || d.at,
    period: s.period || d.period,
    clusters: s.clusters === 'all' || !s.clusters ? 'all' : asList(s.clusters),
    subject: s.subject || '',
    sheets: s.sheets,
    lastSent: s.lastSent || null,
    nextSendAt: s.nextSendAt ?? null,
    nextPeriod: s.nextPeriod || null,
    mailConfigured: s.mailConfigured,
    managed: managedKeys(res && res.managed),
    config: configOf(s.config),
  };
}

const KEY_FIELD = /^UI_REPORT_(?:(?:INDICES|HOSTS)_)?(TO|AT|SCHEDULE|PERIOD|SUBJECT|CLUSTERS|CC|BCC)$/i;
/** The schedule fields config.txt locks: field names, or the UI_REPORT_*_TO style keys. */
export function managedKeys(list) {
  const out = new Set();
  for (const raw of asList(list)) {
    const k = String(raw || '').trim();
    const m = KEY_FIELD.exec(k);
    out.add(m ? m[1].toLowerCase() : k.replace(/^(?:smtp|report|mail|indices|hosts)(?=[A-Z])/, '').replace(/^./, (c) => c.toLowerCase()));
  }
  return out;
}

/**
 * The global hosts settings of config.txt, from `config` in the hosts schedule reply:
 * {fields:[...], clientIdField, branchField, branchDefault, collectAt, keepMonths, mailMaxMb,
 *  managed:[config.txt keys]}. Absent from a core that does not say: the rows read "not reported".
 */
export const CONFIG_ROWS = [
  ['fields', 'Metadata fields', 'UI_REPORT_HOSTS_FIELDS'],
  ['clientIdField', 'ClientID field', 'UI_REPORT_CLIENT_ID_FIELD'],
  ['branchField', 'Branch field', 'UI_REPORT_BRANCH_FIELD'],
  ['branchDefault', 'Branch when missing', 'UI_REPORT_BRANCH_DEFAULT'],
  ['collectAt', 'Collection time (server time)', 'UI_REPORT_HOSTS_AT'],
  ['keepMonths', 'Months kept', 'UI_REPORT_HOSTS_KEEP_MONTHS'],
  ['mailMaxMb', 'Largest mail attachment (MB)', 'UI_REPORT_MAIL_MAX_MB'],
];
export function configOf(c) {
  if (!c || typeof c !== 'object') return null;
  const locked = new Set(asList(c.managed).map((k) => String(k).toUpperCase()));
  return CONFIG_ROWS.map(([key, label, env]) => {
    const v = c[key];
    const known = v !== undefined && v !== null && v !== '';
    return { key, label, env, known, value: Array.isArray(v) ? v.join(', ') : known ? String(v) : null, locked: locked.has(env) || locked.has(key.toUpperCase()) };
  });
}

/* -------------------------------- the messages -------------------------------- */

export const kindScheduleGet = (kind) => reportSend({ type: 'REPORT_SCHEDULE_GET', kind });
export const kindScheduleSet = (kind, schedule) => reportSend({ type: 'REPORT_SCHEDULE_SET', kind, ...schedule });
export const kindSendNow = (kind) => reportSend({ type: 'REPORT_SEND_NOW', kind });

/** Why a Run now cannot start, or ''. The core still refuses `too_many_clusters` itself. */
export function runProblem(kind, ids) {
  if (!ids.length) return 'Pick at least one cluster.';
  if (kind === 'hosts' && ids.length > HOSTS_MAX_CLUSTERS) return `Volume by host takes at most ${HOSTS_MAX_CLUSTERS} clusters at a time.`;
  return '';
}

export function kindRun(kind, { clusterIds, period, format, mail, collectAgain }) {
  return reportSend({
    type: 'REPORT_RUN', kind, clusterIds, period, format, mail: !!mail,
    ...(kind === 'hosts' ? { collectAgain: !!collectAgain } : {}),
  });
}

/** `too_many_clusters` (and the other bounds) in words. */
export function runFailText(res) {
  if (res && res.kind === 'too_many_clusters') return res.message || `Volume by host takes at most ${HOSTS_MAX_CLUSTERS} clusters at a time; nothing was queued.`;
  return null;
}

/* ------------------------------- Volume by host ------------------------------- */

/** A UTC month "2026-11" as {from,to}; the current month ends yesterday (docs: month so far). */
export function monthRange(ym, today) {
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  if (today && today.slice(0, 7) === ym) {
    const yest = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    return { from, to: yest < from ? from : yest };
  }
  return { from, to: last };
}

export const hostsQuery = ({ clusterId, period, q, sort, offset = 0, limit = HOSTS_PAGE }) =>
  reportSend({ type: 'HOSTS_QUERY', clusterId, period, q: q || '', sort: sort || 'day:asc', offset, limit: Math.min(200, limit) });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A HOSTS_QUERY reply as the view reads it; every missing figure stays null. */
export function hostsOf(res) {
  const t = (res && res.totals) || {};
  return {
    rows: asList(res && res.rows).map((r) => ({
      day: r.day, index: r.index, source: r.source ?? null, host: r.host ?? null,
      docs: num(r.docs), eventBytes: num(r.eventBytes), subBytes: num(r.subBytes),
      meta: r.meta && typeof r.meta === 'object' ? r.meta : {},
    })),
    total: num(res && res.total) ?? 0,
    totals: { docs: num(t.docs), eventBytes: num(t.eventBytes), subBytes: num(t.subBytes) },
    incompleteDays: asList(res && res.incompleteDays),
    fields: asList(res && res.fields),
    notInMapping: asList(res && res.notInMapping),
  };
}

/** The sort string for a column and direction. */
export const sortKey = (col, dir) => `${col}:${dir === 'desc' ? 'desc' : 'asc'}`;
