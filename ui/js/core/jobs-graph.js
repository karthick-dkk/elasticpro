/**
 * The Jobs tab's graphical view (approved canvas "Jobs graphical view", 0.3.77) — the pure half:
 * a run's result as ok / warning / failed / running, the success rate of a window of runs, the
 * lanes of "Runs, last 24 hours", a running job's time left, the health tiles and which history
 * field draws each line. No DOM, no network: pages/jobs-graph.js draws what these return
 * (tested in tools/unit/jobs-graph.test.mjs).
 *
 * Unknown is not zero: a time left that cannot be worked out is null, never "0 s"; a success rate
 * of no runs is null; a run log that keeps only a job's newest runs is said to be partial.
 */

import { isOpen, durationText } from './jobs.js';

/** The ranges of the Health and ElasticPro health cards (HEALTH_HISTORY), and of the run lanes. */
export const HEALTH_RANGES = Object.freeze(['1h', '6h', '24h', '7d']);
export const RUN_RANGES = Object.freeze(['6h', '24h', '7d']);
export const DEFAULT_RANGE = '24h';
const SPAN = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
export const rangeMs = (r) => SPAN[r] || SPAN[DEFAULT_RANGE];
/** The run log keeps a job's newest finished runs (docs/JOBS.md "Kept"): beyond that a window is partial. */
export const KEPT_PER_JOB = 50;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A run's result as the view colours it (status colours, results only): `ok` completed, `warn`
 * ended early for a reason that passes or found nothing to do (deferred, skipped, cancelled),
 * `bad` failed, `run` still open (running, queued). Null for anything else.
 */
export function resultOf(run) {
  if (!run) return null;
  if (isOpen(run)) return 'run';
  switch (run.status) {
    case 'completed': return 'ok';
    case 'failed': return 'bad';
    case 'deferred': case 'skipped': case 'cancelled': return 'warn';
    default: return null;
  }
}
/** The mark of a "Just ran" chip. */
export const resultMark = (r) => ({ ok: '✓', warn: '⚠', bad: '✗', run: '▶' })[r] || '·';

/**
 * Finished runs that ended within [from, now]: how many succeeded, had warnings, failed; the
 * success rate (ok of all, %, null with none); `partial` when a job's kept runs all fall in the
 * window (it keeps only its newest KEPT_PER_JOB, so older runs of the window are gone).
 */
export function successOf(runs, { from, now = Date.now() } = {}) {
  const inWin = (Array.isArray(runs) ? runs : []).filter((r) => r && !isOpen(r) && num(r.endedAt) !== null && r.endedAt >= from && r.endedAt <= now);
  const c = { ok: 0, warn: 0, bad: 0 };
  const perJob = new Map();
  for (const r of inWin) {
    const k = resultOf(r);
    if (k && k in c) c[k]++;
    perJob.set(r.jobId, (perJob.get(r.jobId) || 0) + 1);
  }
  const total = c.ok + c.warn + c.bad;
  const partialJobs = [...perJob.entries()].filter(([, n]) => n >= KEPT_PER_JOB).map(([id]) => id);
  return { ...c, total, pct: total ? (c.ok * 100) / total : null, partial: partialJobs.length > 0, partialJobs };
}

/** "94 %" — whole percent, one decimal under 10 % and between 99 and 100 (so 99.6 never reads 100). */
export function pctWord(p) {
  const v = num(p);
  if (v === null) return '—';
  if (v > 99 && v < 100) return `${v.toFixed(1)} %`;
  return `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)} %`;
}

/**
 * A running run's time left, linear from its progress: null unless the core counts it (a
 * percent), it is at least 5 % in and has run 10 s — before that any figure is a guess.
 */
export function timeLeftMs(run, now = Date.now()) {
  if (!run || run.status !== 'running') return null;
  const p = num(run.progress), start = num(run.startedAt);
  if (p === null || start === null || p < 5 || p >= 100) return null;
  const el = now - start;
  if (el < 10_000) return null;
  return Math.round((el * (100 - p)) / p);
}

/** "running 1m 40s · about 55 s left" / "running 4 s" / "queued 12 s ago". */
export function elapsedText(run, now = Date.now()) {
  if (!run) return '—';
  if (run.status === 'queued' || run.status === 'pending' || num(run.startedAt) === null) {
    const at = num(run.createdAt);
    return at === null ? 'queued' : `queued ${durationText(Math.max(0, now - at))} ago`;
  }
  const left = timeLeftMs(run, now);
  return `running ${durationText(Math.max(0, now - run.startedAt))}${left !== null ? ` · about ${durationText(left)} left` : ''}`;
}

/**
 * The lanes of "Runs, last 24 hours": one per job (the registry's order), a bar per run inside
 * [from, now] — x and width in 0..1 of the window, a bar at least `minW` wide so a run of a few
 * milliseconds is still seen — and the next run (dashed) when it falls in the window's last
 * stretch or just after now (`next` is the job's nextRunAt, drawn at the right edge when later).
 */
export function lanes(jobs, runs, { from, now = Date.now(), minW = 0.002 } = {}) {
  const span = Math.max(1, now - from);
  const x = (t) => Math.max(0, Math.min(1, (t - from) / span));
  const byJob = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !r.jobId) continue;
    const start = num(r.startedAt) ?? num(r.createdAt);
    if (start === null) continue;
    const end = num(r.endedAt) ?? (isOpen(r) ? now : start);
    if (end < from || start > now) continue;
    if (!byJob.has(r.jobId)) byJob.set(r.jobId, []);
    const x0 = x(start), x1 = x(end);
    byJob.get(r.jobId).push({ run: r, x: x0, w: Math.max(minW, x1 - x0), result: resultOf(r) });
  }
  const seen = new Set();
  const out = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    seen.add(j.id);
    const bars = (byJob.get(j.id) || []).sort((a, b) => a.x - b.x);
    const nextAt = num(j.state && j.state.nextRunAt);
    out.push({ id: j.id, name: j.name || j.id, bars, next: nextAt !== null && nextAt >= now ? { at: nextAt, beyond: nextAt > now } : null });
  }
  // A run of a job no longer listed (a deleted schedule) keeps a lane of its own.
  for (const [id, bars] of byJob) if (!seen.has(id)) out.push({ id, name: id, bars: bars.sort((a, b) => a.x - b.x), next: null });
  return out;
}

/** The hour ticks of a window: [{x (0..1), t}], a step that gives at most `max` ticks. */
export function ticks(from, now, max = 8) {
  const span = now - from;
  const steps = [3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];
  const step = steps.find((s) => span / s <= max) || steps[steps.length - 1];
  const out = [];
  for (let t = Math.ceil(from / step) * step; t <= now; t += step) out.push({ x: (t - from) / span, t });
  return out;
}

/**
 * The Health card's tiles: the strip's figures (JOBS_LIST `process`, REQUEST_STATS, `busy`) and
 * the HEALTH_HISTORY field that draws each line.
 */
export const HEALTH_TILES = Object.freeze([
  { id: 'worker-cpu', label: 'Worker CPU', field: 'workerCpu', unit: '%' },
  { id: 'core-cpu', label: 'Core CPU', field: 'coreCpu', unit: '%' },
  { id: 'memory', label: 'Memory', field: 'coreMem', unit: '%' },
  { id: 'rps', label: 'Requests / s', field: 'rps', unit: '/s' },
  { id: 'busy', label: 'Busy clusters', field: 'busy', unit: '' },
]);

/**
 * The ElasticPro health card's tiles: one per SYSTEM_HEALTH check (docs/HEALTH.md "Checks"),
 * the history field that draws its line. Their levels and limits are the core's (`checks`,
 * `thresholds`) — never worked out here.
 */
export const CHECK_TILES = Object.freeze([
  { check: 'core.memory', field: 'coreMem' },
  { check: 'worker.memory', field: 'workerMem' },
  { check: 'messages.p95', field: 'p95Ms' },
  { check: 'gate.refused', field: 'refused' },
  { check: 'poller.late', field: 'latePct' },
  { check: 'disk.free', field: 'diskFreePct' },
]);

/** A check's level in the card's words: ok / watch / over (the tab's amber / red), off, not known. */
export function levelShort(level) {
  return ({ ok: 'ok', warn: 'watch', bad: 'over', off: 'off' })[level] || 'not known';
}

/** A threshold's limits as a line: "watch from ≥ 80% · over from ≥ 90%" (the core's own words). */
export function limitText(th) {
  if (!th) return '';
  const a = th.amber ? `watch ${th.amber}` : '', r = th.red ? `over ${th.red}` : '';
  return [a, r].filter(Boolean).join(' · ');
}
