/**
 * Jobs › Jobs, the pure half of two parts of the page (docs/JOBS.md "Run details", "Slow
 * searches"): a job row's result and exact times, the expanded row's summary, exceptions and
 * log (JOB_RUN_DETAIL), and the *Slow searches now* card (SLOW_SEARCHES). No DOM, no network —
 * tested on its own (tools/unit/job-detail.test.mjs); pages/jobs.js draws it.
 *
 * Unknown is not zero: a figure the core did not send is null here and "—" on screen; a
 * cluster the core could not read is "not read", never counted as having no slow search.
 */

import { durationText, durationMs } from './jobs.js';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const fmtInt = (n) => Number(n).toLocaleString('en');

/* ---------------------------------- times ---------------------------------- */

/**
 * An exact moment for a table cell: "19 Nov 22:26:03" (`seconds`) or "20 Nov 00:26", in the
 * server's time zone when the core names it, else this browser's. Null is "—".
 */
export function exactTime(at, { tz = null, seconds = true } = {}) {
  const t = num(at);
  if (t === null) return '—';
  const opts = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, ...(seconds ? { second: '2-digit' } : {}) };
  let parts;
  try { parts = new Intl.DateTimeFormat('en-GB', { ...opts, ...(tz ? { timeZone: tz } : {}) }).formatToParts(new Date(t)); }
  catch (_) { parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(new Date(t)); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.hour}:${p.minute}${seconds ? `:${p.second}` : ''}`;
}

/** A clock time only: "22:26:03" ("22:26" without seconds). */
export function clockTime(at, { tz = null, seconds = true } = {}) {
  const s = exactTime(at, { tz, seconds });
  return s === '—' ? s : s.split(' ').pop();
}

/** A run's duration for the job row: "1m 31s", "—" when it has not started or has not ended. */
export function runDuration(run, now = Date.now()) {
  return durationText(durationMs(run, now));
}

/* ---------------------------------- a run's result ---------------------------------- */

const total = (p) => (p ? ['succeeded', 'partial', 'failed', 'deferred', 'skipped'].reduce((s, k) => s + (num(p[k]) || 0), 0) : 0);

/**
 * The job row's Result cell, from the run's status and its parts when it reported them
 * (`parts`, docs/JOBS.md "Run details"): "Succeeded · 71 clusters", "Partial · 4 of 71
 * clusters", "Failed · 3 of 3 clusters", "Deferred · 1 cluster". A deferral is a warning,
 * not a failure: amber, never red. Tones are the app's pill tones.
 */
export function resultOf(run) {
  if (!run) return { text: '—', tone: 'grey', warn: false };
  const p = run.parts || null;
  const n = total(p);
  const plural = (k) => `${k} cluster${k === 1 ? '' : 's'}`;
  if (run.status === 'running' || run.status === 'queued' || run.status === 'pending') return { text: 'Running', tone: 'blue', warn: false };
  if (!n) {
    const word = { completed: 'Succeeded', failed: 'Failed', deferred: 'Deferred', skipped: 'Skipped', cancelled: 'Cancelled' }[run.status] || String(run.status || '—');
    const tone = { completed: 'green', failed: 'red', deferred: 'orange', skipped: 'grey', cancelled: 'grey' }[run.status] || 'grey';
    return { text: word, tone, warn: run.status === 'deferred' };
  }
  const bad = (num(p.failed) || 0), part = (num(p.partial) || 0), def = (num(p.deferred) || 0), skip = (num(p.skipped) || 0);
  const ex = bad + part + def + skip;
  if (!ex) return { text: `Succeeded · ${plural(n)}`, tone: 'green', warn: false };
  if (bad === n) return { text: `Failed · ${plural(n)}`, tone: 'red', warn: false };
  if (def === ex && !bad && !part) return { text: `Deferred · ${plural(def)}`, tone: 'orange', warn: true };
  if (ex === n && !bad && !part) return { text: `Skipped · ${plural(n)}`, tone: 'grey', warn: false };
  return { text: `Partial · ${ex} of ${plural(n)}`, tone: 'orange', warn: true };
}

/**
 * The line under a job row about its last run's trouble: a deferral (a busy cluster) is a
 * warning in amber — "ussc deferred — …; retried automatically when it eases" — and never an
 * "Error:". Null when the run has nothing to say.
 */
export function troubleOf(run, nameOf = (id) => id) {
  if (!run || !run.error) return null;
  const err = String(run.error);
  const one = Array.isArray(run.clusters) && run.clusters.length === 1 ? run.clusters[0] : null;
  // The core's words start with the cluster's id; shown, they start with its name.
  const named = (id) => (id && err.startsWith(id) ? `${nameOf(id)}${err.slice(id.length)}` : err);
  if (run.status === 'deferred') {
    const d = run.deferred || null;
    const id = d && d.cluster ? d.cluster : one;
    // A wait with words of its own (docs/JOBS.md): moved to the cluster's quietest hour, or
    // waiting for its heavy-job hours — those words, still a warning.
    if (/quietest hour|heavy jobs only/.test(err)) return { level: 'warn', text: `${named(id)} (a warning, not a failure)`, title: err };
    const who = id ? nameOf(id) : null;
    const why = d && d.reason ? d.reason : err;
    return { level: 'warn', text: who ? `${who} deferred — ${why}; retried automatically when it eases (a warning, not a failure)` : `Deferred — ${why}` };
  }
  // Switched off for the cluster (Edit cluster › Collection): skipped on purpose, never an error.
  if (run.status === 'skipped' && /switched off for this cluster/.test(err)) return { level: 'warn', text: named(one), title: err };
  return { level: 'err', text: `Error: ${run.error}`, title: String(run.error) };
}

/* ---------------------------------- the expanded row ---------------------------------- */

/** The tabs of an expanded row, with their counts. */
export function detailTabs(detail) {
  const c = (detail && detail.counts) || null;
  const n = total(c);
  const ex = c ? n - (num(c.succeeded) || 0) : 0;
  return [
    { id: 'summary', label: 'Summary' },
    { id: 'exceptions', label: `Exceptions (${c ? ex : '—'})` },
    { id: 'clusters', label: `All clusters (${c ? n : '—'})` },
    { id: 'log', label: 'Log' },
    { id: 'history', label: 'Run history' },
  ];
}

/**
 * The run summary grid: [label, value, tone]. Clusters = succeeded + partial + failed +
 * deferred + skipped, always (the counts are one set). A figure not known is "—".
 */
export function summaryCells(run, detail, { tz = null, now = Date.now() } = {}) {
  const c = (detail && detail.counts) || (run && run.parts) || null;
  const n = c ? total(c) : null;
  const cell = (label, value, tone = '') => [label, value === null || value === undefined ? '—' : String(value), tone];
  const win = detail && Array.isArray(detail.window) && detail.window.length === 2 ? detail.window : null;
  const out = [
    cell('Run ID', run ? run.id : null),
    cell('Trigger', run ? triggerWord(run.trigger) : null),
    cell('Start → end', run && run.startedAt ? `${clockTime(run.startedAt, { tz })} → ${run.endedAt ? clockTime(run.endedAt, { tz }) : 'running'}` : null),
    cell('Duration', run ? runDuration(run, now) : null),
  ];
  if (win) out.push(cell('Query window', `${clockTime(win[0], { tz, seconds: false })} – ${clockTime(win[1], { tz, seconds: false })}`));
  if (c) {
    out.push(cell('Clusters', fmtInt(n)), cell('Succeeded', fmtInt(num(c.succeeded) || 0), 'ok'), cell('Partial', fmtInt(num(c.partial) || 0), 'warn'),
      cell('Failed', fmtInt(num(c.failed) || 0), 'bad'));
    if (num(c.deferred)) out.push(cell('Deferred', fmtInt(c.deferred), 'warn'));
    if (num(c.skipped)) out.push(cell('Skipped', fmtInt(c.skipped)));
  }
  out.push(cell('Records collected', run && num(run.records) !== null ? fmtInt(run.records) : null));
  if (c && n) out.push(cell('Success rate', `${(((num(c.succeeded) || 0) * 100) / n).toFixed(1)} %`));
  return out;
}

function triggerWord(t) {
  if (t === 'timer') return 'Scheduled';
  if (t === 'retry') return 'Retry';
  if (typeof t === 'string' && t.startsWith('manual:')) return `By ${t.slice(7)}`;
  return t ? String(t) : '—';
}

/** A run's details are read once; asked for again only after a refusal, or after "no details" for a run that ended under this long ago. */
export const DETAIL_YOUNG_MS = 60_000;
/** Not more often than this, so a refresh every 3 s does not ask every 3 s. */
export const DETAIL_RETRY_MS = 5_000;

/**
 * Whether a run's kept answer (`had`: `{res, error, loading, at}`) should be asked for again
 * now: never while loading or within DETAIL_RETRY_MS of the last ask; after a refusal (unless
 * the server does not know the message); after "no details" while the run is younger than
 * DETAIL_YOUNG_MS (its details may still have been on their way).
 */
export function detailAgain(had, run, now = Date.now()) {
  if (!had || had.loading || had.unsupported) return false;
  if (now - (num(had.at) || 0) < DETAIL_RETRY_MS) return false;
  if (had.error) return true;
  const ended = num(run && run.endedAt);
  return !!(had.res && !had.res.detail && ended !== null && now - ended < DETAIL_YOUNG_MS);
}

/** Parts that did not succeed (the Exceptions tab), as the core ordered them: worst first. */
export const exceptionsOf = (detail) => ((detail && detail.parts) || []).filter((p) => p.status !== 'succeeded');

/** A part's result as a pill: Failed red, Partial and Deferred amber, Skipped grey, Succeeded green. */
export function partTone(status) {
  return { succeeded: 'green', failed: 'red', partial: 'orange', deferred: 'orange', skipped: 'grey' }[status] || 'grey';
}
export const partWord = (status) => ({ succeeded: 'Succeeded', failed: 'Failed', partial: 'Partial', deferred: 'Deferred', skipped: 'Skipped' }[status] || String(status || '—'));

/** A part's elapsed time: "0.4 s", "30.0 s", "1m 31s"; null is "—". */
export function elapsedText(ms) {
  const v = num(ms);
  if (v === null) return '—';
  return v < 60_000 ? `${(v / 1000).toFixed(1)} s` : durationText(v);
}

/** What the core's `todo.page` opens, among the app's pages (unknown: nothing to link). */
export const TODO_PAGES = Object.freeze(['settings', 'reports', 'overview', 'shards']);

/**
 * A part's fix as a link: `{page, label, text, cluster}` when the core names a page among
 * TODO_PAGES that the caller may open (`canOpen(page)`), `{label, text}` alone when not, null
 * when there is none (or the core keeps it for an administrator). Jobs › Exceptions and the Log
 * Delay page's not-measured line both link through it.
 */
export function todoTarget(p, canOpen = () => true) {
  const t = p && p.todo;
  if (!t || !t.label) return null;
  if (!TODO_PAGES.includes(t.page) || !canOpen(t.page)) return { label: t.label, text: t.text || '' };
  return { page: t.page, label: t.label, text: t.text || '', cluster: p.cluster };
}

/* ---------------------------- the Log Delay page's not-measured line ---------------------------- */

/** The log delay measurement's job id (crates/elasticpro-core/src/jobs/mod.rs LOGDELAY_MEASURE). */
export const LOGDELAY_JOB = 'logdelay.measure';

/**
 * Why a cluster's part of a run did not (fully) do its work, in a few words, from the part the
 * run details keep (`code`, `message`, `elapsedMs`) — the one wording the Log Delay page's
 * not-measured line uses: "no index matches logstash-*", "timed out (30 s)", "part read (2
 * shards failed)", "busy — deferred", "credentials refused", "unreachable".
 */
export function partReason(p) {
  if (!p) return '';
  const msg = String(p.message || '');
  const secs = num(p.elapsedMs) === null ? null : Math.round(num(p.elapsedMs) / 1000);
  if (p.status === 'skipped') return msg ? `skipped — ${msg}` : 'skipped';
  switch (p.code) {
    case 'INDEX_NOT_FOUND': {
      const named = /no index matches\s+(\S+)/i.exec(msg) || /no such index \[([^\]]+)\]/i.exec(msg) || /index_not_found[^[]*\[([^\]]+)\]/i.exec(msg);
      return named ? `no index matches ${named[1]}` : 'no index matches the log index';
    }
    case 'TIMEOUT': return secs === null ? 'timed out' : `timed out (${secs} s)`;
    case 'SHARD_FAILURE': {
      const m = /(\d+) of \d+ shards? failed/i.exec(msg) || /(\d+) shards? failed/i.exec(msg);
      return m ? `part read (${m[1]} shard${m[1] === '1' ? '' : 's'} failed)` : 'part read (shards failed)';
    }
    case 'BUSY': return 'busy — deferred';
    case 'AUTH': return 'credentials refused';
    case 'UNREACHABLE': return 'unreachable';
    default:
      if (p.status === 'deferred') return 'deferred';
      if (p.status === 'partial') return msg ? `part read — ${msg.slice(0, 80)}` : 'part read';
      return msg ? msg.slice(0, 80) : partWord(p.status).toLowerCase();
  }
}

/**
 * The last finished run of `jobId` in a JOBS_LIST answer (newest first); null when none has
 * ended. A run still going keeps no details yet, so the one before it is the last run.
 */
export function lastFinishedRun(listRes, jobId = LOGDELAY_JOB) {
  const runs = (listRes && Array.isArray(listRes.runs)) ? listRes.runs : [];
  return runs.find((r) => r && r.jobId === jobId && !['running', 'queued', 'pending'].includes(r.status)) || null;
}

/**
 * The Log Delay page's line about the last run: `{runId, total, missed: [{cluster, reason,
 * fix}]}` from the run's details as JOB_RUN_DETAIL gives them (already narrowed to the caller's
 * clusters), kept to the clusters `sees` lets through; null when every cluster was read, or
 * when there are no details to say it from.
 */
export function notMeasured(detailRes, sees = () => true, canOpen = () => true) {
  const d = detailRes && detailRes.detail;
  if (!d || !d.counts) return null;
  const missed = exceptionsOf(d).filter((p) => sees(p.cluster))
    .map((p) => ({ cluster: p.cluster, status: p.status, reason: partReason(p), fix: todoTarget(p, canOpen) }));
  if (!missed.length) return null;
  return { runId: detailRes.run ? detailRes.run.id : null, total: total(d.counts), missed };
}

/**
 * The run's log as plain text, for Copy and Download .txt: one line each, "22:26:03.112 ERROR
 * demo INDEX_NOT_FOUND …", and where lines were left out between the first and the last, a
 * line that says how many.
 */
export function logText(detail, { tz = null, runId = '' } = {}) {
  const lines = (detail && detail.lines) || [];
  const head = runId ? [`# ElasticPro run ${runId}`] : [];
  const out = lines.map((l) => `${logStamp(l.at, tz)}  ${String(l.level || '').padEnd(5)}  ${l.text}`);
  const dropped = num(detail && detail.linesDropped) || 0;
  // The core keeps the first LOG_HEAD lines and the last ones: the gap is between them.
  if (dropped) out.splice(Math.min(LOG_HEAD, out.length), 0, `… ${fmtInt(dropped)} lines not kept (the first ${LOG_HEAD} and the last ${LOG_TAIL} are) …`);
  return [...head, ...out].join('\n') + (out.length ? '\n' : '');
}

/** "22:26:03.112": a log line's time to the millisecond. */
export function logStamp(at, tz = null) {
  const t = num(at);
  if (t === null) return '—';
  const ms = String(Math.floor(t % 1000)).padStart(3, '0');
  return `${clockTime(t, { tz })}.${ms}`;
}

/** How many of a run's lines the core keeps from its start and from its end (jobs/detail.rs). */
export const LOG_HEAD = 100;
export const LOG_TAIL = 400;

/** The file name of a run's log: "elasticpro-run-be9229a1.txt". */
export const logFileName = (runId) => `elasticpro-run-${String(runId || 'run').replace(/[^A-Za-z0-9-]/g, '')}.txt`;

/* ---------------------------------- slow searches ---------------------------------- */

/** The thresholds the card offers (ms) and their words; 30 s is where it starts. */
export const SLOW_THRESHOLDS = Object.freeze([[10_000, '10 s'], [30_000, '30 s'], [60_000, '1 min'], [300_000, '5 min']]);
export const SLOW_DEFAULT_MS = 30_000;
/** The card asks at most this often, and only while the Jobs page is open. */
export const SLOW_POLL_MS = 30_000;
/** Sooner when the core answered with clusters still being read (`reading`). */
export const SLOW_RETRY_MS = 5_000;
/** Rows shown before "Show all". */
export const SLOW_ROWS = 3;

/** A running time: "6m 12s", "58 s", "2m 40s". */
export function runningText(ms) {
  const v = num(ms);
  if (v === null) return '—';
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Long, longer, longest: red from 5 min, amber from 1 min, else plain. */
export function runningTone(ms) {
  const v = num(ms) || 0;
  return v >= 300_000 ? 'bad' : v >= 60_000 ? 'warn' : '';
}

/**
 * The three tiles: how many run long and on how many clusters, the longest (cluster · node),
 * and the cluster slowest now (most long searches, then the longest). Clusters not read are
 * said under the count — never taken as "none running".
 */
export function slowTiles(answer, nameOf = (id) => id) {
  const list = (answer && Array.isArray(answer.searches)) ? answer.searches : null;
  if (!list) return null;
  const count = num(answer.count) ?? list.length;
  const by = new Map();
  for (const s of list) {
    const e = by.get(s.cluster) || { cluster: s.cluster, n: 0, longest: 0 };
    e.n += 1; e.longest = Math.max(e.longest, num(s.runningMs) || 0);
    by.set(s.cluster, e);
  }
  const notRead = Array.isArray(answer.notRead) ? answer.notRead.length : 0;
  const reading = Array.isArray(answer.reading) ? answer.reading.length : 0;
  const nr = `${notRead ? ` · ${notRead} not read` : ''}${reading ? ` · ${reading} reading…` : ''}`;
  const top = list[0] || null;
  const worst = [...by.values()].sort((a, b) => b.n - a.n || b.longest - a.longest)[0] || null;
  return {
    count: { value: String(count), sub: `on ${by.size} cluster${by.size === 1 ? '' : 's'}${nr}` },
    longest: top ? { value: runningText(top.runningMs), tone: runningTone(top.runningMs), sub: `${top.name || nameOf(top.cluster)} · node ${top.node || '—'}` }
      : { value: '—', tone: '', sub: 'nothing over the threshold' },
    slowest: worst ? { value: nameOf(worst.cluster), sub: `${worst.n} long search${worst.n === 1 ? '' : 'es'} · longest ${runningText(worst.longest)}` }
      : { value: '—', sub: notRead ? 'some clusters not read' : reading ? 'some clusters still being read' : 'no cluster is slow now' },
  };
}

/** Who ran a search: "ElasticPro" for our own, else the X-Opaque-Id when the cluster says, else null. */
export function whoRan(s) {
  if (!s) return null;
  if (s.by === 'ElasticPro') return 'ElasticPro';
  return s.opaqueId ? String(s.opaqueId) : null;
}

/** Everything "Open" shows, as text for Copy. */
export function searchText(s, nameOf = (id) => id) {
  if (!s) return '';
  return [
    `Cluster: ${s.name || nameOf(s.cluster)}`, `Running: ${runningText(s.runningMs)}`, `Node: ${s.node || '—'}`, `Index: ${s.indices || 'not said'}`,
    `Task: ${s.taskId}`, `X-Opaque-Id: ${s.opaqueId || 'not set'}${s.by === 'ElasticPro' ? ' (ElasticPro)' : ''}`, `Action: ${s.action || '—'}`,
    '', s.query || s.description || 'the cluster did not say the query',
  ].join('\n');
}
