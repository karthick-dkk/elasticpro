/**
 * The Request Centre's model: the core's request log, filtered and shaped for a table and
 * a CSV. Pure, so the rules are testable without a page: what a row says about a request
 * is decided here once, and the table and the export agree.
 */

import { dur } from '../lib/fmt.js';

/** Filters the page offers. Empty / 'all' means "no filter". */
export const NO_FILTER = { cluster: 'all', origin: 'all', outcome: 'all', slowerThanMs: 0 };

/** The gate's refusals: nothing was sent to the cluster (errors.rs EP-214, EP-215). */
export const REFUSED = new Set(['overloaded', 'queue_timeout']);

/** `poller:health` → "poller · health"; `page:indices` → "Indices page"; `console` → "REST console". */
export function originLabel(origin) {
  const o = String(origin || 'core');
  if (o.startsWith('page:')) {
    const id = o.slice(5);
    return `${id.charAt(0).toUpperCase()}${id.slice(1)} page`;
  }
  if (o.startsWith('poller:')) return `poller · ${o.slice(7)}`;
  if (o === 'console') return 'REST console';
  return o;
}

/** "200", "timeout", "overloaded" … or, in flight, what it is doing and for how long. */
export function outcomeLabel(r, now = Date.now()) {
  if (r.ms == null) {
    const so = `${Math.max(0, now - (r.startedAt || now))} ms so far`;
    if (r.state === 'queued') return `queued · ${so}`;
    if (r.state === 'shared') return `waiting on #${r.leader} · ${so}`;
    return `in flight · ${so}`;
  }
  return r.status || (r.ok ? 'ok' : 'error');
}

/** Which bucket a record falls in for the outcome filter. */
export function outcomeOf(r) {
  if (r.ms == null) return r.state === 'queued' ? 'queued' : 'inflight';
  if (r.ok) return 'ok';
  if (REFUSED.has(String(r.status || ''))) return 'refused';
  return /^[45]\d\d$/.test(String(r.status || '')) ? 'http-error' : 'failed';
}

/** "shared", "cached 2.1 s old" — how a request was answered without going to the cluster. */
export function answeredBy(r) {
  if (r.cached) return `cached${r.ageMs != null ? ` ${(r.ageMs / 1000).toFixed(1)} s old` : ''}`;
  if (r.shared) return r.leader != null ? `shared #${r.leader}` : 'shared';
  return '';
}

/**
 * Rows for the table: in-flight first (oldest first, so the one stuck longest is on top),
 * then finished newest first, after the filters.
 */
export function requestRows(log, f = NO_FILTER, now = Date.now()) {
  const inflight = [...(log.inflight || [])].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const recent = [...(log.recent || [])];
  const keep = (r) => (f.cluster === 'all' || r.cluster === f.cluster)
    && (f.origin === 'all' || r.origin === f.origin || (f.origin === 'poller' && String(r.origin).startsWith('poller:')))
    && (f.outcome === 'all' || outcomeOf(r) === f.outcome || (f.outcome === 'inflight' && outcomeOf(r) === 'queued'))
    && (!f.slowerThanMs || (r.ms == null ? now - (r.startedAt || now) : r.ms) >= f.slowerThanMs);
  return [...inflight, ...recent].filter(keep).map((r) => ({
    ...r, inflight: r.ms == null, elapsedMs: r.ms == null ? Math.max(0, now - (r.startedAt || now)) : r.ms,
    originLabel: originLabel(r.origin), outcome: outcomeLabel(r, now), answeredBy: answeredBy(r),
  }));
}

/** The distinct origins in a log, for the filter — pollers collapsed into one entry. */
export function originChoices(log) {
  const set = new Set();
  for (const r of [...(log.inflight || []), ...(log.recent || [])]) set.add(String(r.origin).startsWith('poller:') ? 'poller' : r.origin);
  return [...set].sort();
}

/** Per-cluster totals over what the log holds: count, in flight, queued, failed, refused, slowest ms. */
export function perCluster(log) {
  const out = {};
  for (const r of [...(log.inflight || []), ...(log.recent || [])]) {
    const c = out[r.cluster] || (out[r.cluster] = { cluster: r.cluster, count: 0, inflight: 0, queued: 0, failed: 0, refused: 0, slowestMs: 0 });
    c.count++;
    if (r.ms == null) { c.inflight++; if (r.state === 'queued') c.queued++; }
    else if (REFUSED.has(String(r.status || ''))) c.refused++;
    else { if (!r.ok) c.failed++; if (r.ms > c.slowestMs) c.slowestMs = r.ms; }
  }
  return Object.values(out).sort((a, b) => b.count - a.count);
}

/**
 * The four gate tiles, from REQUEST_LOG's `gate` block. A core that does not send one (an
 * older core) has not measured these: every figure is null, never 0.
 */
export function gateFigures(log) {
  const g = log && log.gate;
  if (!g) return { known: false, running: null, windowMs: null, queued: null, waitP95Ms: null, refused: null, sharedOrCached: null, oldestWaitMs: null };
  const w = (g.waits && g.waits.interactive) || {};
  return {
    known: true,
    running: g.running ? g.running.total : null,
    windowMs: g.windowMs ?? null,
    queued: g.queued ? g.queued.total : null,
    oldestWaitMs: g.oldestWaitMs ?? null,
    waitP95Ms: w.p95Ms ?? null,
    waitCount: w.count ?? 0,
    refused: g.refused ? g.refused.total : null,
    overloaded: g.refused ? g.refused.overloaded : null,
    queueTimeout: g.refused ? g.refused.queueTimeout : null,
    sharedOrCached: (g.shared ?? 0) + (g.cacheHits ?? 0),
    shared: g.shared ?? 0,
    cacheHits: g.cacheHits ?? 0,
    limits: g.limits || null,
  };
}

export const CSV_HEADER = ['started', 'cluster', 'origin', 'class', 'method', 'path', 'queuedMs', 'ms', 'outcome', 'answeredBy', 'via', 'id'];

/** The same rows as the table, keyed by CSV_HEADER for toCsv (started as ISO time). */
export function requestCsvRows(rows) {
  return rows.map((r) => ({
    started: new Date(r.startedAt || 0).toISOString(), cluster: r.cluster, origin: r.origin, class: r.class || '',
    method: r.method, path: r.path, queuedMs: r.queuedMs == null ? '' : String(r.queuedMs),
    ms: r.inflight ? '' : String(r.ms), outcome: r.inflight ? (r.state === 'queued' ? 'queued' : 'in flight') : r.outcome,
    answeredBy: r.answeredBy || '', via: r.via || '', id: String(r.id),
  }));
}

/* ------------------------------ the answer, first ------------------------------ */

/**
 * Where "busy" and "holding back" start. One place, so the page, its tests and anybody
 * reading the thresholds agree.
 *   nearLimit      in flight at this share of the gate's overall limit is Busy, even with
 *                  nobody waiting: the next request will have to.
 *   redRefused     this many turned away in the window is no longer a blip: red, not amber.
 */
export const STATUS_THRESHOLDS = { nearLimit: 0.75, redRefused: 10 };

/** How many finished requests the page asks the core for; a log that long may not reach back 5 minutes. */
export const LOG_LIMIT = 500;

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Requests the core is sending right now (not waiting, not sharing another's answer). */
function inFlightNow(log, g) {
  if (g.known && g.running != null) return g.running;
  return (log.inflight || []).filter((r) => r.state !== 'queued' && r.state !== 'shared').length;
}

/**
 * The page's one-line answer: is the core quiet, busy, or holding requests back — and the
 * sentence under it. Pure, from the numbers the core reports and nothing else.
 *
 * `log`     REQUEST_LOG's reply, or null before the first read.
 * `opts.paused`     true / false when the policy is known, null when it is not.
 * `opts.sentLast5m` requests sent in the last five minutes, from REQUEST_STATS, null if unread.
 * `opts.now`        the clock.
 *
 * Returns { level, tone, title, detail, inFlight, waiting, refused, windowMin }. level is one
 * of loading | unknown | paused | holding | busy | quiet | normal. tone is the dot's colour:
 * green | accent | yellow | red | grey. Unknown is not zero: with no gate block in the log
 * (an older core) the level is `unknown` and no gate figure is invented; a figure the core
 * did not send is null here and is worded as "not reported".
 */
export function requestStatus(log, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!log) {
    return { level: 'loading', tone: 'grey', title: 'Loading the request log\u2026', detail: '',
      inFlight: null, waiting: null, refused: null, windowMin: null };
  }
  const g = gateFigures(log);
  const inFlight = inFlightNow(log, g);
  const waiting = g.known ? g.queued : null;
  const refused = g.known ? g.refused : null;
  const windowMin = Math.round((g.windowMs || 300_000) / 60_000);
  const T = STATUS_THRESHOLDS;
  const waitText = waiting == null ? 'waiting not reported' : waiting ? `${waiting.toLocaleString()} waiting` : 'nothing waiting';
  const inText = `${inFlight.toLocaleString()} in flight`;
  const out = { inFlight, waiting, refused, windowMin, detail: requestSentence(log, { now, sentLast5m: opts.sentLast5m ?? null, windowMin }) };

  if (opts.paused) return { ...out, level: 'paused', tone: 'yellow', title: 'Paused: no request goes to any cluster until you resume' };
  if (!g.known) {
    return { ...out, level: 'unknown', tone: 'grey',
      title: `Not known: this core does not report its request gate${inFlight ? ` (${inText} in the log)` : ''}` };
  }
  if (refused > 0) {
    const lim = g.limits;
    const red = refused >= T.redRefused || (lim && lim.queueMax > 0 && waiting != null && waiting >= lim.queueMax);
    return { ...out, level: 'holding', tone: red ? 'red' : 'yellow',
      title: `Holding back: ${refused.toLocaleString()} turned away in the last ${windowMin} min` };
  }
  const global = g.limits && g.limits.global > 0 ? g.limits.global : null;
  if ((waiting != null && waiting > 0) || (global && inFlight >= Math.ceil(global * T.nearLimit))) {
    return { ...out, level: 'busy', tone: 'accent', title: `Busy: ${inText}, ${waitText}` };
  }
  if (inFlight === 0 && waiting === 0) return { ...out, level: 'quiet', tone: 'green', title: 'Quiet: nothing in flight, nothing waiting' };
  return { ...out, level: 'normal', tone: 'green', title: `Working normally: ${inText}, ${waitText}` };
}

/**
 * "11 requests in the last 5 minutes, all answered. The slowest took 30 ms." — the second
 * line, without the mode. The count is the Rate tile's (REQUEST_STATS); what happened to
 * them, and the slowest, are read from the finished rows inside the window. A log that is
 * full to its limit and does not reach back that far says so rather than passing itself off
 * as the whole window.
 */
export function requestSentence(log, { now = Date.now(), sentLast5m = null, windowMin = 5, limit = LOG_LIMIT } = {}) {
  const span = `in the last ${windowMin === 1 ? 'minute' : `${windowMin} minutes`}`;
  if (sentLast5m == null) return `How many requests went out ${span} is not known yet.`;
  if (sentLast5m === 0) return `No requests ${span}.`;
  const recent = log.recent || [];
  const cut = now - windowMin * 60_000;
  const rows = recent.filter((r) => (r.startedAt || 0) >= cut);
  const oldest = recent.reduce((m, r) => Math.min(m, r.startedAt || now), now);
  const partial = recent.length >= limit && oldest > cut;
  const head = `${plural(sentLast5m, 'request', 'requests')} ${span}`;
  if (!rows.length) return `${head}; none of them is in the log to say how they went.`;
  const failed = rows.filter((r) => !r.ok && !REFUSED.has(String(r.status || ''))).length;
  const slowest = perCluster({ recent: rows }).reduce((m, c) => Math.max(m, c.slowestMs), 0);
  const how = failed ? `${failed.toLocaleString()} failed` : 'all answered';
  const scope = partial ? ` (of the latest ${limit.toLocaleString()} in the log)` : '';
  return `${head}, ${how}${scope}. The slowest took ${dur(slowest)}.`;
}

/** Display names for the request policy's modes, and what each means in one clause. */
const MODE_TEXT = {
  auto: ['Automatic', 'so the core picks background or hybrid by how many clusters there are'],
  background: ['Background', 'so the core keeps every cluster fresh on its own'],
  hybrid: ['Hybrid', 'so only health is fetched in the background'],
  'on-demand': ['Client basis', 'so requests go out only when a page asks'],
};

/** { label, because } for the mode the core runs; label null when it did not say. */
export function modeText(mode) {
  const m = MODE_TEXT[mode];
  return m ? { label: m[0], because: m[1] } : { label: null, because: 'the core did not say which mode it runs' };
}

/**
 * The gate's limits as labelled chips: [{ id, pre, value, post, title }], drawn as
 * `pre <b>value</b> post`. From `gate.limits`, `gate.readCache` and `gate.taskReaper` — the
 * same data the old sentence used. null when the core reports no limits.
 */
export function limitChips(log) {
  const g = log && log.gate;
  const lim = g && g.limits;
  if (!lim) return null;
  const n = (v) => Number(v).toLocaleString();
  const chips = [
    { id: 'global', pre: '', value: n(lim.global), post: ' at once', title: 'Requests open at once, all clusters and all askers together' },
    { id: 'perCluster', pre: '', value: n(lim.perCluster), post: ' per cluster', title: 'Requests open at once to any one cluster' },
    { id: 'perJump', pre: '', value: n(lim.perJump), post: ' per jump host', title: 'Requests open at once through any one jump host' },
    { id: 'reserve', pre: '', value: n(lim.backgroundReserve), post: ' kept for background', title: 'Slots only background work may use, so a busy page never starves the poller' },
    { id: 'wait', pre: 'a person waits up to ', value: dur(lim.queueWaitMs), post: '', title: 'The longest a person\u2019s request waits for a free slot before it is turned away' },
  ];
  const secs = g.readCache && g.readCache.seconds;
  chips.push(secs
    ? { id: 'cache', pre: 'repeats served from a ', value: `${secs} s`, post: ' cache', title: 'An identical read within this many seconds is answered without asking the cluster again' }
    : { id: 'cache', pre: 'read cache ', value: 'off', post: '', title: 'Identical reads are all sent to the cluster' });
  const r = g.taskReaper;
  if (r) {
    const last = r.last && Array.isArray(r.last.cancelled) ? r.last.cancelled.filter((x) => x.ok).length : null;
    const how = `Task reaper mode: ${r.mode}. ` + (last == null ? 'It has not run since the core started.' : `Its last run cancelled ${last}.`);
    chips.push(r.mode === 'off'
      ? { id: 'reaper', pre: 'orphaned tasks: ', value: 'not cancelled', post: '', title: how }
      : last == null
        ? { id: 'reaper', pre: 'orphaned tasks cancelled: ', value: 'not run yet', post: '', title: how }
        : { id: 'reaper', pre: 'orphaned tasks cancelled: ', value: n(last), post: '', title: `${how} (the core reports its last run, not a running total)` });
  }
  return chips;
}

/** HH:MM:SS in the viewer's time zone — the table's Time column; the title carries the date. */
export function clockTime(ms) {
  if (!ms) return '\u2013';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '\u2013';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The gate's class as the table's tag: { label, title }. A class the core did not name is shown as is. */
export function classTag(cls) {
  switch (cls) {
    case 'interactive': return { label: 'person', title: 'interactive: a person asked for it' };
    case 'prompted': return { label: 'page', title: 'prompted: the poller fetching what a page is waiting on' };
    case 'background': return { label: 'background', title: 'background: the poller\u2019s own schedule, the core\u2019s housekeeping' };
    default: return cls ? { label: String(cls), title: String(cls) } : null;
  }
}

/** Result cell: tone is ok | warn | err — a refusal by the gate is a warning, not the cluster failing. */
export function resultTone(r) {
  if (r.ok) return 'ok';
  return REFUSED.has(String(r.status || '')) ? 'warn' : 'err';
}
