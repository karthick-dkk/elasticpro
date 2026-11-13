/**
 * Collect now (docs/REPORTS.md, docs/JOBS.md): start the daily collection for some clusters and
 * follow its run to the end. One definition for Daily & monthly and for Measure size.
 *
 * `VOLUME_RUN` never waits for the collection: the core starts it in the background (the report
 * worker, on hosted) and answers at once with what it started, what was already collecting, what
 * it turned away and the run's id in the run log. The run is then followed through `JOBS_LIST
 * {jobId: 'volume.daily'}` — its status, how many of its clusters ended, the days it collected
 * and why it failed — every 3 s, for as long as it runs (at most two hours), whatever page is
 * open: coming back to Reports shows where it is. A run the caller may not read in the run log
 * (it also covers a cluster they do not see) is followed through the cluster's own status, which
 * the sections read anyway (`reportStatus`).
 *
 * How far a cluster is, in days, is the cluster's status in `VOLUME_DAILY` (`progress`); the run
 * log counts clusters.
 */

import { bridge } from '../core/transport.js';
import { volumeRun, isUnsupported } from '../core/volume-daily.js';
import { isWorkerDown } from '../core/reports.js';
import { clusters } from '../core/state.js';

export const JOB_ID = 'volume.daily';
export const FOLLOW_MS = 3000;
/** A run is followed this long at most; it carries on in the core after that. */
export const FOLLOW_LIMIT_MS = 2 * 60 * 60 * 1000;
/** Polls in a row that got no answer before the page says it lost touch. */
const MAX_MISSES = 5;
/** The worker's heartbeat, and a little: a status read sooner may predate the run. */
const STATUS_LAG_MS = 12000;

/**
 * Per cluster, the last Collect now and its run:
 * { runId, phase: 'running'|'ended'|'lost', status, done, total, records, error, note, since, endedAt }
 * `status` is the run log's (`completed`, `failed`, `deferred`, `cancelled`, `skipped`), null
 * while it runs or when the run log does not list the run for this caller.
 */
const byCluster = new Map();
/** Runs being followed: key → { ids, runId, timer, until, misses, visible, ticks } */
const follows = new Map();
/** Per cluster, the status a section last read (VOLUME_DAILY): for a run the run log does not show. */
const seen = new Map();
let listeners = [];
const changed = () => { for (const fn of listeners) { try { fn(); } catch (_) { /* the rest still hear */ } } };
export function onCollect(fn) { listeners.push(fn); return () => { listeners = listeners.filter((x) => x !== fn); }; }

export const collectOf = (id) => byCluster.get(id) || null;
export const collecting = (id) => { const e = byCluster.get(id); return !!(e && e.phase === 'running'); };
export const anyCollecting = (ids) => ids.some(collecting);

const nameOf = (id) => { const c = clusters().find((x) => x.id === id); return (c && c.name) || id; };
const names = (ids) => (ids.length <= 3 ? ids.map(nameOf).join(', ') : `${ids.slice(0, 2).map(nameOf).join(', ')} and ${ids.length - 2} more`);
const shortRun = (id) => (id ? String(id).slice(0, 8) : '');

/** Why VOLUME_RUN left a cluster alone, in words (`skipped[].reason`). */
export function skipText(reason) {
  if (reason === 'stopped') return 'the emergency stop is on: nothing was sent';
  if (reason === 'unreachable') return 'it cannot be reached: nothing was asked; collect it once it answers again';
  if (reason === 'unknown') return 'it is not one of the clusters you see';
  return String(reason || 'not started');
}

/**
 * What a `VOLUME_RUN` answer means, in the words the page shows: `{ok, level, message, lines,
 * started, already, tooSoon, skipped, runId}`. Pure, so tools/unit can hold it to the contract.
 */
export function runAnswer(res, ids) {
  if (!res) return { ok: false, level: 'err', message: 'Could not start a collection: no answer', lines: [] };
  if (res.unsupported) return { ok: false, level: 'warn', unsupported: true, message: 'This server does not keep a daily record yet.', lines: [] };
  if (res.kind === 'no_store') return { ok: false, level: 'warn', noStore: true, message: 'This server keeps no daily record.', lines: [] };
  if (!res.ok && isWorkerDown(res)) return { ok: false, level: 'warn', message: res.message || 'The report worker is not running: collection resumes when it is back.', lines: [] };
  if (!res.ok) return { ok: false, level: 'err', message: res.kind === 'config_unreadable' ? res.message : `Could not start a collection: ${res.message || res.kind}`, lines: [] };
  const started = res.started || [];
  const already = res.already || [];
  const tooSoon = res.tooSoon || [];
  const skipped = res.skipped || [];
  const run = res.runId ? ` (run ${shortRun(res.runId)})` : '';
  const lines = [];
  if (started.length) lines.push({ level: 'info', text: `Collecting ${names(started)}${run}. It runs on the server: you can leave this page.` });
  if (already.length) lines.push({ level: 'info', text: `${names(already)} ${already.length === 1 ? 'was' : 'were'} already collecting${run}: following that run.` });
  if (tooSoon.length) lines.push({ level: 'warn', text: `${names(tooSoon)} ${tooSoon.length === 1 ? 'was' : 'were'} collected less than a minute ago: try again in a minute.` });
  for (const s of skipped) lines.push({ level: 'warn', text: `${nameOf(s.clusterId)}: ${skipText(s.reason)}.` });
  if (res.stopped && !skipped.length) lines.push({ level: 'warn', text: 'The emergency stop is on: nothing was sent.' });
  if (!lines.length) lines.push({ level: 'warn', text: `Nothing was started for ${names(ids || [])}.` });
  const level = started.length || already.length ? 'info' : 'warn';
  return { ok: true, level, message: lines.map((l) => l.text).join(' '), lines, started, already, tooSoon, skipped, runId: res.runId || null };
}

/** Collect now for these clusters: the answer in words, and the run followed. */
export async function collectNow(ids) {
  let res;
  try { res = await volumeRun(ids); } catch (e) { res = { ok: false, message: e && e.message }; }
  const out = runAnswer(res, ids);
  if (!out.ok) return out;
  const going = [...out.started, ...out.already];
  const now = Date.now();
  for (const id of going) byCluster.set(id, { runId: out.runId, phase: 'running', status: null, done: null, total: null, records: null, error: null, note: null, since: now, endedAt: null, lines: out.lines });
  // A refusal for a cluster is its latest word too, until a run starts for it.
  for (const id of out.tooSoon) if (!collecting(id)) byCluster.set(id, { ...(byCluster.get(id) || {}), refused: { level: 'warn', text: `${nameOf(id)} was collected less than a minute ago: try again in a minute.` } });
  for (const s of out.skipped) if (!collecting(s.clusterId)) byCluster.set(s.clusterId, { ...(byCluster.get(s.clusterId) || {}), refused: { level: 'warn', text: `${nameOf(s.clusterId)}: ${skipText(s.reason)}.` } });
  if (going.length) follow(out.runId, going);
  changed();
  return out;
}

/**
 * A run already going that this page did not start (the timer's, another person's, one started
 * before a reload): follow it too. The open run is the run log's `state.current`; when the
 * caller may not read it, the cluster's own status is followed.
 */
export async function adopt(ids) {
  // Not a run that just ended here: on hosted the cluster's status comes from the worker's
  // heartbeat and may still say running for a few seconds after.
  const want = ids.filter((id) => { const e = byCluster.get(id); return !collecting(id) && !(e && e.endedAt && Date.now() - e.endedAt < STATUS_LAG_MS * 2); });
  if (!want.length) return;
  const now = Date.now();
  let runId = null;
  const res = await listRuns();
  if (res && res.ok) {
    const job = (res.jobs || []).find((j) => j.id === JOB_ID);
    const cur = job && job.state && job.state.current;
    if (cur && cur.id && !(cur.status && ['completed', 'failed', 'deferred', 'cancelled', 'skipped'].includes(cur.status))) runId = cur.id;
  }
  for (const id of want) if (!collecting(id)) byCluster.set(id, { runId, phase: 'running', status: null, done: null, total: null, records: null, error: null, note: null, since: now, endedAt: null, lines: [], adopted: true });
  follow(runId, want);
  changed();
}

/** A section read this cluster's status (VOLUME_DAILY `status`). */
export function reportStatus(id, status) {
  if (!status) return;
  seen.set(id, { running: !!status.running, lastError: status.lastError || null, at: Date.now() });
}

const listRuns = () => bridge({ type: 'JOBS_LIST', jobId: JOB_ID, limit: 25 }).catch((e) => ({ ok: false, message: e && e.message }));

function endCluster(id, patch) {
  const e = byCluster.get(id);
  if (!e || e.phase !== 'running') return;
  byCluster.set(id, { ...e, ...patch, endedAt: Date.now() });
}

function follow(runId, ids) {
  const key = runId || `status:${ids.join(',')}`;
  const had = follows.get(key);
  if (had) { for (const id of ids) if (!had.ids.includes(id)) had.ids.push(id); return; }
  const f = { key, runId, ids: [...ids], timer: null, until: Date.now() + FOLLOW_LIMIT_MS, misses: 0, ticks: 0 };
  follows.set(key, f);
  const stop = () => { if (f.timer) clearTimeout(f.timer); follows.delete(key); };
  const tick = async () => {
    f.timer = null;
    f.ticks++;
    const res = f.runId ? await listRuns() : null;
    let run = null;
    if (res && res.ok) {
      f.misses = 0;
      run = (res.runs || []).find((r) => r.id === f.runId) || null;
    } else if (res && !res.ok && !isUnsupported(res, 'JOBS_LIST') && res.kind !== 'forbidden' && res.kind !== 'bad_request') {
      f.misses++;
    }
    if (run) {
      for (const id of f.ids) {
        const e = byCluster.get(id);
        if (e && e.phase === 'running' && e.runId === f.runId) byCluster.set(id, { ...e, done: run.done ?? null, total: run.total ?? null, records: run.records ?? null });
      }
      if (['completed', 'failed', 'deferred', 'cancelled', 'skipped'].includes(run.status)) {
        for (const id of f.ids) endCluster(id, { phase: 'ended', status: run.status, error: run.error || null, note: run.note || null, records: run.records ?? null, done: run.done ?? null, total: run.total ?? null });
        stop();
        changed();
        return;
      }
    } else if (f.ticks > 1) {
      // The run log does not show this run to this caller (or the core keeps none): the
      // clusters' own status says when each ended, and its last error how. Read at least
      // STATUS_LAG_MS after the start: on hosted the status comes from the worker's heartbeat
      // (every 10 s), which may not list a run that has just begun.
      for (const id of f.ids) {
        const s = seen.get(id);
        const since = (byCluster.get(id) || {}).since || 0;
        if (s && !s.running && s.at - since > STATUS_LAG_MS) endCluster(id, { phase: 'ended', status: null, error: s.lastError });
      }
      if (f.ids.every((id) => !collecting(id))) { stop(); changed(); return; }
    }
    if (f.misses >= MAX_MISSES) {
      const why = (res && (res.message || res.kind)) || 'no answer';
      for (const id of f.ids) endCluster(id, { phase: 'lost', error: `Lost touch with the server while following the collection: ${why}. It carries on there; open this page again to see where it is.` });
      stop();
      changed();
      return;
    }
    if (Date.now() >= f.until) {
      for (const id of f.ids) endCluster(id, { phase: 'lost', error: 'Still collecting after two hours: no longer followed here. It carries on on the server; Collect now again shows where it is.' });
      stop();
      changed();
      return;
    }
    changed();
    f.timer = setTimeout(tick, FOLLOW_MS);
  };
  f.timer = setTimeout(tick, 1000);
}

/** The run's result for a cluster in words, once it ended: `{level, title, text}`; null while it runs. */
export function endText(e) {
  if (!e || e.phase === 'running' || !e.phase) return null;
  const run = e.runId ? ` · run ${shortRun(e.runId)}` : '';
  const days = typeof e.records === 'number' ? ` · ${e.records} ${e.records === 1 ? 'day' : 'days'} searched` : '';
  if (e.phase === 'lost') return { level: 'warn', title: 'Collection not followed any more', text: e.error };
  switch (e.status) {
    case 'completed': return { level: 'ok', title: `Collection finished${days}${run}`, text: e.note || '' };
    case 'failed': return { level: 'err', title: `Collection failed${run}`, text: e.error || 'the run ended with an error' };
    case 'deferred': return { level: 'warn', title: `Collection deferred${run}`, text: e.error || 'it is tried again later' };
    case 'cancelled': return { level: 'warn', title: `Collection cancelled${run}`, text: e.note || e.error || '' };
    case 'skipped': return { level: 'warn', title: `Collection skipped${run}`, text: e.error || 'nothing was attempted' };
    default: return e.error ? { level: 'warn', title: 'Collection ended', text: e.error } : { level: 'ok', title: 'Collection finished', text: '' };
  }
}

/** Forget what was shown about a cluster's last collection (the person closed the note). */
export function dismiss(id) {
  const e = byCluster.get(id);
  if (!e || e.phase === 'running') return;
  byCluster.delete(id);
  changed();
}

/** Tests only: stop following everything and forget it. */
export function resetCollect() {
  for (const f of follows.values()) if (f.timer) clearTimeout(f.timer);
  follows.clear();
  byCluster.clear();
  seen.clear();
}
