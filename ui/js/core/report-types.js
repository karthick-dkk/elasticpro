/**
 * The report kinds (0.3.54, docs/REPORT-TYPES.md): Volume report, Indices report and Volume
 * by host. This file is the ONE place the UI knows how those messages are shaped; the core's
 * field names are read here and nowhere else, so reconciling the two is a one-file change.
 *
 * Sent:
 *   REPORT_RUN           {kind, clusterIds, period, format, mail, collectAgain?}
 *     volume: one job per cluster; indices/hosts: ONE job for every picked cluster.
 *   REPORT_SCHEDULE_GET  {kind}   -> flat schedule + {kind, managed, timer, nextSendAt, nextPeriod,
 *                                    mailConfigured, sheets (volume), config (hosts), worker? (role core)}
 *   REPORT_SCHEDULE_SET  {kind, enabled, to, cc, bcc, schedule, at, period, clusters, subject, ...}
 *   REPORT_SEND_NOW      {kind}
 *   HOSTS_QUERY          {clusterId, period:{from,to}, q, sort:"<col>:<asc|desc>", offset, limit}
 *     sort columns: day index source host docs eventBytes subBytes clientId branch meta.<field>
 *
 * Read (HOSTS_QUERY): {rows:[{day,index,source,host,docs,eventBytes,subBytes,eventMissingDocs,
 *   clientId,branch,meta,incomplete}], total, offset, limit, totals:{docs,eventBytes,subBytes},
 *   days:[{day,held,incomplete,rows,notes,failed,collecting?}], fill:{clientId,branchDefault},
 *   incompleteDays, fields, notInMapping}. A figure that is null/absent is NOT MEASURED, never 0.
 *
 * Read (a job, REPORT_JOBS / REPORT_RUN): reportKind, failedClusters [{clusterId, reason}],
 *   warning, progress {done,total,state,cluster,day,pages,rows,retries,partitions,concurrency,
 *   halvings,lastReason, clusters:{<id>:{state,day,pages,rows,retries,concurrency,
 *   partitions:{done,total},halvings,lastReason,days:{done,total}}}}.
 *
 * Refusals: `worker_unavailable` (the report worker is not running; monitoring is not affected)
 * and `worker_version` (worker and core are different versions) are amber, said as the core says them.
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
    worker: workerOf(s.worker),
  };
}

/* ------------------------------- the report worker ------------------------------- */

/** Refusals that mean the report worker cannot take the work now: amber, not a fault of the ask. */
export const WORKER_KINDS = new Set(['worker_unavailable', 'worker_version']);
export const isWorkerRefusal = (res) => !!res && res.ok === false && WORKER_KINDS.has(res.kind);

/** A refusal in words, or null when it is not the worker's. */
export function workerRefusalText(res) {
  if (!isWorkerRefusal(res)) return null;
  if (res.message) return String(res.message);
  return res.kind === 'worker_version'
    ? 'The report worker runs a different ElasticPro version from the core: reports wait until both are upgraded.'
    : 'The report worker is not running: reports and collection resume when it is back. Monitoring is not affected.';
}

/** `worker` in a schedule reply (role core): {state, heartbeatAt, text}, or null when the core does not say. */
export function workerOf(w) {
  if (!w || typeof w !== 'object') return null;
  const at = typeof w.heartbeatAt === 'number' && Number.isFinite(w.heartbeatAt) ? w.heartbeatAt : null;
  const state = String(w.state || '');
  return { state, heartbeatAt: at, text: w.text ? String(w.text) : '', ok: state === 'up' };
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
 * {fields:[...], clientIdField, branchField, branchDefault, collectAt, keepMonths, maxPages, mailMaxMb,
 *  managed:[config.txt keys]}. Absent from a core that does not say: the rows read "not reported".
 */
export const CONFIG_ROWS = [
  ['fields', 'Metadata fields', 'UI_REPORT_HOSTS_FIELDS'],
  ['clientIdField', 'ClientID field', 'UI_REPORT_CLIENT_ID_FIELD'],
  ['branchField', 'Branch field', 'UI_REPORT_BRANCH_FIELD'],
  ['branchDefault', 'Branch when missing', 'UI_REPORT_BRANCH_DEFAULT'],
  ['collectAt', 'Collection time (server time)', 'UI_REPORT_HOSTS_AT'],
  ['keepMonths', 'Months kept', 'UI_REPORT_HOSTS_KEEP_MONTHS'],
  ['maxPages', 'Most pages per cluster-day', 'UI_REPORT_HOSTS_MAX_PAGES'],
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

/** `too_many_clusters` (and the other bounds, and the worker's refusals) in words. */
export function runFailText(res) {
  const w = workerRefusalText(res);
  if (w) return w;
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

/** The meta field the core fills with ClientID / branch: the reply's name when it gives one, else the shipped default name. */
const fillField = (fields, given, re) => (given && fields.includes(given) ? given : fields.find((f) => re.test(f)) || null);

/** A HOSTS_QUERY reply as the view reads it; every missing figure stays null. */
export function hostsOf(res) {
  const t = (res && res.totals) || {};
  const fields = asList(res && res.fields);
  const days = asList(res && res.days).map((d) => ({
    day: d.day, held: !!d.held, incomplete: !!d.incomplete, rows: num(d.rows),
    notes: asList(d.notes), failed: d.failed ? String(d.failed) : null, collecting: !!d.collecting,
  }));
  const fill = (res && res.fill) || {};
  return {
    rows: asList(res && res.rows).map((r) => ({
      day: r.day, index: r.index, source: r.source ?? null, host: r.host ?? null,
      docs: num(r.docs), eventBytes: num(r.eventBytes), subBytes: num(r.subBytes),
      eventMissingDocs: num(r.eventMissingDocs),
      clientId: r.clientId ?? null, branch: r.branch ?? null, incomplete: !!r.incomplete,
      meta: r.meta && typeof r.meta === 'object' ? r.meta : {},
    })),
    total: num(res && res.total) ?? 0,
    totals: { docs: num(t.docs), eventBytes: num(t.eventBytes), subBytes: num(t.subBytes) },
    // The core sends both; an answer with only `days` still flags its incomplete days.
    incompleteDays: res && Array.isArray(res.incompleteDays) ? res.incompleteDays : days.filter((d) => d.incomplete).map((d) => d.day),
    failedDays: days.filter((d) => !d.held && d.failed),
    collectingDays: days.filter((d) => !d.held && d.collecting),
    days,
    fill: { clientId: fill.clientId ?? null, branchDefault: fill.branchDefault ?? null },
    fields,
    clientIdField: fillField(fields, res && res.clientIdField, /^client_?id$/i),
    branchField: fillField(fields, res && res.branchField, /^branch$/i),
    notInMapping: asList(res && res.notInMapping),
  };
}

/* ------------------------------- job progress ------------------------------- */

const cnt = (c) => (c && typeof c === 'object' && num(c.total) !== null ? { done: num(c.done) ?? 0, total: num(c.total) } : null);

/**
 * An indices or hosts job's per-cluster lines, from `progress.clusters` (one job covers every
 * picked cluster), with the clusters the job could not read and why. Every figure the core did
 * not send stays null ("not reported"). `nameOf(id)` names a cluster. Empty for a job that has
 * no per-cluster progress (a volume job, or one not started).
 */
export function jobClusterLines(job, nameOf = (id) => id) {
  const p = (job && job.progress) || {};
  const per = p.clusters && typeof p.clusters === 'object' ? p.clusters : {};
  const failed = new Map(asList(job && job.failedClusters).filter((f) => f && f.clusterId).map((f) => [f.clusterId, String(f.reason || 'no reason given')]));
  if (!Object.keys(per).length && !failed.size) return [];
  const ids = [...new Set([...asList(job && job.clusterIds), ...Object.keys(per), ...failed.keys()])];
  return ids.map((id) => {
    const c = per[id] || null;
    const reason = failed.get(id) || null;
    const state = reason ? 'failed' : c && c.state ? String(c.state) : 'waiting';
    return {
      id, name: nameOf(id) || id, state,
      day: c && c.day ? String(c.day) : null,
      pages: c ? num(c.pages) : null, rows: c ? num(c.rows) : null, retries: c ? num(c.retries) : null,
      // Requests the controller allows now: only meaningful while the cluster is being read.
      concurrency: c && (state === 'collecting' || state === 'retrying') ? num(c.concurrency) : null,
      halvings: c ? num(c.halvings) : null,
      lastReason: c && c.lastReason ? String(c.lastReason) : null,
      partitions: c ? cnt(c.partitions) : null, days: c ? cnt(c.days) : null,
      failed: reason,
    };
  });
}

const STATE_WORDS = {
  waiting: 'waiting', collecting: 'collecting', retrying: 'retrying', deferred: 'deferred (cluster red)',
  done: 'done', failed: 'failed', stopped: 'stopped', building: 'building', mailing: 'mailing',
};

/** One cluster line in words: "collecting · day 2026-11-03 · 3 of 5 days · 2/4 partitions · 120 pages · 2 at once · halved 1× (429)". */
export function clusterLineText(l) {
  const head = STATE_WORDS[l.state] || l.state;
  if (l.failed) return `${head}: ${l.failed}`;
  const parts = [head];
  if (l.day) parts.push(`day ${l.day}`);
  if (l.days && l.days.total) parts.push(`${l.days.done} of ${l.days.total} days`);
  if (l.partitions && l.partitions.total) parts.push(`${l.partitions.done}/${l.partitions.total} partitions`);
  if (l.pages !== null && l.state !== 'waiting') parts.push(`${l.pages} pages`);
  if (l.concurrency !== null) parts.push(`${l.concurrency} at once`);
  if (l.halvings) parts.push(`halved ${l.halvings}×${l.lastReason ? ` (${l.lastReason})` : ''}`);
  else if (l.lastReason) parts.push(l.lastReason);
  if (l.retries) parts.push(`${l.retries} ${l.retries === 1 ? 'retry' : 'retries'}`);
  return parts.join(' · ');
}

/** The report a job builds, in words: every job carries `reportKind` (absent before 0.3.54: the volume report). */
export const jobKindLabel = (job) => {
  const k = (job && (job.reportKind || job.report)) || 'volume';
  // The log delay report (0.3.57) is built from Reports › Log delay and Config › Data, not from this list.
  return k === 'log_delay' ? 'Log delay report' : kindOf(k).label;
};

/** The sort string for a column and direction. */
export const sortKey = (col, dir) => `${col}:${dir === 'desc' ? 'desc' : 'asc'}`;
