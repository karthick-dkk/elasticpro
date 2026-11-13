/**
 * The Jobs page's arithmetic and words (docs/JOBS.md): what a run's status, progress,
 * duration and next run read as, which controls a job or run offers, and a refused control
 * as a plain sentence. Pure — no DOM, no network — so it is tested on its own
 * (tools/unit/jobs.test.mjs); pages/jobs.js draws it and sends the messages.
 *
 * Unknown is not zero (CLAUDE.md): a progress the core does not know is "counting…", never a
 * bar at 0 %; a figure the core did not send is null here and "—" on screen.
 */

/* ---------------------------------- statuses ---------------------------------- */

/** A run still open: it may be stopped, and the page reads the list every 2 s while one is. */
export const OPEN_STATUSES = new Set(['pending', 'queued', 'running']);
/** The ends JOB_RETRY takes (docs/JOBS.md "Retry"). */
export const RETRY_STATUSES = new Set(['failed', 'deferred', 'cancelled']);

export const isOpen = (run) => !!run && OPEN_STATUSES.has(run.status);

const WORDS = {
  pending: 'Pending', queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed',
  paused: 'Paused', cancelled: 'Cancelled', deferred: 'Deferred', skipped: 'Skipped',
  // A job's own state when no run is open: what JOBS_LIST says about its timer.
  idle: 'Idle', off: 'Off',
};
/** A status as a word; one the page does not know is shown as the core sent it. */
export function statusWord(status) {
  if (status === null || status === undefined || status === '') return '—';
  return WORDS[status] || String(status);
}

/**
 * The pill tone of a status, from the app's own tones (app.css `.pill.*`): running blue,
 * completed green, failed red, deferred orange (it is tried again by itself), paused yellow,
 * the rest grey. Pills, not bars: the bar colours are BAR_TONE.
 */
export function statusTone(status) {
  switch (status) {
    case 'running': return 'blue';
    case 'completed': return 'green';
    case 'failed': return 'red';
    case 'deferred': return 'orange';
    case 'paused': return 'yellow';
    default: return 'grey';
  }
}

/**
 * The colour of a progress bar (owner rule: never red and yellow together in a bar set; light
 * green, blue, pink, orange): running light blue, completed light green, failed light pink,
 * waiting (queued, deferred, cancelled while asked) light orange.
 */
export function barTone(status) {
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'pink';
  if (status === 'running') return 'blue';
  return 'orange';
}

/** Who started a run: "timer" → Automatic, "manual:ann" → by ann, "retry" → Retry. */
export function triggerText(trigger) {
  const t = typeof trigger === 'string' ? trigger : trigger && typeof trigger === 'object' ? (trigger.text || trigger.kind || '') : '';
  if (!t) return '—';
  if (t === 'timer') return 'Automatic';
  if (t === 'retry') return 'Retry';
  if (t.startsWith('manual:')) return `by ${t.slice('manual:'.length) || 'a person'}`;
  return t;
}

/* ---------------------------------- progress ---------------------------------- */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A run's progress: `pct` (0–100) only when the core gives one, `text` for the cell.
 *   running, 40 %, 2 of 5 → { pct: 40, text: '40 %', detail: '2 of 5' }
 *   running, total unknown, 3 done → { pct: null, text: '3 done · counting…' }
 *   running, nothing known → { pct: null, text: 'counting…' }
 *   queued → { pct: null, text: 'queued' }; a finished run without counts → '—'
 */
export function progressOf(run) {
  if (!run) return { pct: null, text: '—', detail: '' };
  const pct = num(run.progress);
  const done = num(run.done), total = num(run.total);
  const detail = done !== null && total !== null ? `${done} of ${total}` : '';
  if (pct !== null) return { pct: Math.max(0, Math.min(100, Math.round(pct))), text: `${Math.max(0, Math.min(100, Math.round(pct)))} %`, detail };
  if (run.status === 'queued' || run.status === 'pending') return { pct: null, text: 'queued', detail };
  if (run.status === 'running') return { pct: null, text: done !== null ? `${done} done · counting…` : 'counting…', detail };
  return { pct: null, text: '—', detail };
}

/* ---------------------------------- time ---------------------------------- */

/** How long a run took, or has taken so far: ms, or null when it has not started. */
export function durationMs(run, now = Date.now()) {
  if (!run) return null;
  const start = num(run.startedAt);
  if (start === null) return null;
  const end = num(run.endedAt) ?? (isOpen(run) ? now : null);
  if (end === null) return null;
  return Math.max(0, end - start);
}

/**
 * A duration as a person reads it — and as core/sort.js `duration` reads it back: "350 ms",
 * "12 s", "3m 20s", "1h 05m", "2d 3h". Null and nonsense are "—".
 */
export function durationText(ms) {
  const v = num(ms);
  if (v === null || v < 0) return '—';
  if (v < 1000) return `${Math.round(v)} ms`;
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const hr = Math.floor(m / 60);
  if (hr < 48) return `${hr}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

/** A moment relative to now: "in 5 min", "3 min ago", "in 2 h", "now". Null is "—". */
export function relativeText(at, now = Date.now()) {
  const t = num(at);
  if (t === null) return '—';
  const d = t - now;
  const a = Math.abs(d);
  if (a < 45_000) return d >= 0 ? 'within a minute' : 'just now';
  const mins = Math.round(a / 60_000);
  const span = mins < 90 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}

/**
 * An absolute time, in the server's time zone when the core names it (`tz`, IANA), else in
 * this browser's — and `zone` says which, so a reader never takes one for the other.
 */
export function absoluteText(at, { tz = null, now = Date.now() } = {}) {
  const t = num(at);
  if (t === null) return { text: '—', zone: '' };
  const sameDay = Math.abs(t - now) < 20 * 3600_000;
  const opts = sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  let text;
  try { text = new Intl.DateTimeFormat('en-GB', { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(new Date(t)); }
  catch (_) { text = new Intl.DateTimeFormat('en-GB', opts).format(new Date(t)); tz = null; }
  return { text, zone: tz ? `server time (${tz})` : 'your time' };
}

/**
 * When a job runs next: `at` (ms) and the words, or the core's note when it knows no time —
 * paused (by whom), off, not armed, "runs when a person asks". Never a guessed time.
 */
export function nextRunOf(job, { now = Date.now(), tz = null } = {}) {
  const st = (job && job.state) || {};
  const at = num(st.nextRunAt);
  if (at === null) return { at: null, text: '—', rel: '', note: st.nextRunNote ? String(st.nextRunNote) : 'not known' };
  const abs = absoluteText(at, { tz, now });
  return { at, text: abs.text, zone: abs.zone, rel: relativeText(at, now), note: '' };
}

/* ---------------------------------- jobs ---------------------------------- */

/** Automatic or Manual, from the registry's `kind`. */
export const jobTypeText = (job) => (job && job.kind === 'manual' ? 'Manual' : job && job.kind === 'automatic' ? 'Automatic' : '—');

/** A job made with JOB_CREATE (`report.schedule.<id>`): it can be deleted. */
export const isCreated = (job) => !!job && typeof job.id === 'string' && job.id.startsWith('report.schedule.');

/**
 * The jobs JOB_RUN refuses (docs/JOBS.md "Run now"): a report run names its clusters and
 * dates (JOB_CREATE {once}), and the Zabbix push runs every minute by itself. JOBS_LIST does
 * not say which jobs run on demand, so these two are named here; the core still decides.
 */
const NOT_ON_DEMAND = new Set(['report.run', 'zabbix.push']);
export const canRunNow = (job) => !!job && !NOT_ON_DEMAND.has(job.id);
/** Pause holds a timer: an automatic job that says it is pausable. */
export const canPause = (job) => !!job && job.pausable === true && job.kind !== 'manual';
/** Stop: an open run nobody has asked to stop yet. */
export const canCancel = (run) => isOpen(run) && !run.cancelAsked;
/**
 * Retry: a failed, deferred or cancelled run of a job that runs on demand (a report job is
 * retried with its own parameters). Whether the policy allows it now is the core's
 * (`retry_limit`, `retry_wait`), said as a sentence when it refuses.
 */
export const canRetry = (run) => !!run && RETRY_STATUSES.has(run.status)
  && (String(run.id || '').startsWith('report-') || !NOT_ON_DEMAND.has(run.jobId));

/** A job's status for the table: its open run's, else paused / off / idle. */
export function jobStatus(job) {
  const st = (job && job.state) || {};
  if (st.current && st.current.status) return st.current.status;
  if (st.paused) return 'paused';
  if (st.enabled === false && job.kind !== 'manual') return 'off';
  return 'idle';
}

/** The priority's order: high first. Unknown is null (sorted last). */
export function priorityRank(p) {
  const r = { high: 1, medium: 2, low: 3 }[String(p || '').toLowerCase()];
  return r === undefined ? null : r;
}
export const priorityText = (p) => (p ? String(p).charAt(0).toUpperCase() + String(p).slice(1).toLowerCase() : '—');

/**
 * Requests a job may use: "1–4" from its settings, and when the governor reports one (PR 4,
 * `state.allocation`) what it is given now: "2 of 1–4 · auto". Unknown parts are left out,
 * never shown as 0.
 */
export function requestsText(job) {
  const alloc = job && job.state && job.state.allocation && typeof job.state.allocation === 'object' ? job.state.allocation : null;
  const r = (job && job.requests) || {};
  const min = num(alloc && alloc.min) ?? num(r.min);
  const max = num(alloc && alloc.max) ?? num(r.max);
  const range = min !== null && max !== null ? `${min}–${max}` : '—';
  if (!alloc) return { text: range, now: null, title: 'what the job may be given; the adaptive governor is not reporting what it is given now' };
  const now = num(alloc.requests);
  const auto = alloc.auto === true ? ' · auto' : alloc.auto === false ? ' · fixed' : '';
  return {
    text: now !== null ? `${now} of ${range}${auto}` : `${range}${auto}`,
    now,
    title: alloc.reason ? allocationReasonText(alloc.reason) : 'what the adaptive governor gives the job now',
  };
}

/** Why the governor gave a job what it has (docs/JOBS.md "Sharing"); a code it does not know is shown as sent. */
const ALLOCATION_REASONS = {
  share: 'its share of the total, by priority',
  min: 'held at its minimum: the total has no more to give',
  max: 'at its maximum',
  auto_off: 'automatic optimisation is off for it: its maximum',
  limit: 'automatic optimisation is off for it, but the worker\'s total is spent',
  fixed: 'a job of the core: fixed at its maximum',
};
export const allocationReasonText = (r) => ALLOCATION_REASONS[r] || String(r || '');

/** Why the governor's total last changed (docs/JOBS.md "The rule"); a code it does not know is shown as sent. */
const GOVERNOR_REASONS = {
  calm: 'calm',
  cpu: 'CPU over its limit',
  cpu_throttled: 'CPU throttled',
  memory: 'memory over its limit',
  people_waiting: 'people waiting',
  cluster_rejecting: 'clusters rejecting',
  limit: 'back inside its limits',
};
export const governorReasonText = (r) => GOVERNOR_REASONS[r] || String(r || '');

/** Text cut to `n` characters with an ellipsis; the whole of it goes in a title or an expanded row. */
export function truncate(text, n = 60) {
  const s = text === null || text === undefined ? '' : String(text);
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…` : s;
}

/**
 * Every open run, newest first and each once: the open runs of the page of runs, and each
 * job's `state.current` (an old long run may be past the first page of runs).
 */
export function openRuns(list) {
  const out = new Map();
  for (const r of (list && Array.isArray(list.runs) ? list.runs : [])) if (isOpen(r)) out.set(r.id, r);
  for (const j of (list && Array.isArray(list.jobs) ? list.jobs : [])) {
    const c = j && j.state && j.state.current;
    if (isOpen(c) && !out.has(c.id)) out.set(c.id, c);
  }
  return [...out.values()].sort((a, b) => (num(b.startedAt) ?? num(b.createdAt) ?? 0) - (num(a.startedAt) ?? num(a.createdAt) ?? 0));
}

/** Running and queued counts, from the open runs. */
export function runCounts(list) {
  const open = openRuns(list);
  return { running: open.filter((r) => r.status === 'running').length, queued: open.filter((r) => r.status !== 'running').length };
}

/** How often the page reads JOBS_LIST: every 2 s while anything runs or waits, else every 15 s. */
export const FAST_POLL_MS = 2000;
export const SLOW_POLL_MS = 15000;
export function pollDelay(list) {
  const c = runCounts(list);
  return c.running + c.queued > 0 ? FAST_POLL_MS : SLOW_POLL_MS;
}

/**
 * The scheduled jobs in the order they run next: those with a time first (soonest first),
 * then paused or off ones (they have none), each with what it says instead.
 */
export function upNext(list, { now = Date.now(), tz = null } = {}) {
  const jobs = (list && Array.isArray(list.jobs) ? list.jobs : []).filter((j) => j.kind !== 'manual');
  const rows = jobs.map((j) => ({ job: j, next: nextRunOf(j, { now, tz }) }));
  const timed = rows.filter((r) => r.next.at !== null).sort((a, b) => a.next.at - b.next.at);
  const held = rows.filter((r) => r.next.at === null && (r.job.state && (r.job.state.paused || r.job.state.enabled === false)));
  return [...timed, ...held];
}

/* ---------------------------------- the strip ---------------------------------- */

/** A percent as the strip shows it: "41 %", or "—" when not read yet. */
export const pctText = (v) => (num(v) === null ? '—' : `${num(v) >= 10 ? Math.round(num(v)) : num(v).toFixed(1)} %`);

/**
 * The process figures JOBS_LIST already carries (docs/JOBS.md `process`): CPU and memory of the
 * core and of the worker. A worker not deployed (role all) runs in the core: its figures are
 * the core's, and it says so rather than showing an empty worker.
 */
export function processFigures(process) {
  const core = (process && process.core) || {};
  const worker = (process && process.worker) || {};
  const inCore = worker.state === 'not_deployed';
  return {
    coreCpu: num(core.cpuPct), coreMem: num(core.memoryPct),
    workerCpu: inCore ? null : num(worker.cpuPct), workerMem: inCore ? null : num(worker.memoryPct),
    workerState: worker.state || null,
    workerText: inCore ? 'runs in the core (role all)' : worker.state && worker.state !== 'up' ? `worker ${worker.state}${worker.text ? `: ${worker.text}` : ''}` : '',
    inCore,
  };
}

/** One busy cluster as a line: "prod — 429: the cluster answered 429 (since 5 min ago)". */
export function busyText(b, nameOf = (id) => id, now = Date.now()) {
  if (!b) return '';
  const since = num(b.since) !== null ? ` (since ${relativeText(b.since, now)})` : '';
  return `${nameOf(b.cluster)} — ${b.signal || 'busy'}: ${b.reason || 'busy'}${since}`;
}

/**
 * The governor (PR 4), when the core reports one: "3 of 16 in use". Null when it does not —
 * the strip then shows nothing for it, not a zero.
 */
export function governorText(g) {
  if (!g || typeof g !== 'object') return null;
  const inUse = num(g.inUse), total = num(g.total);
  const head = inUse !== null && total !== null ? `${inUse} of ${total} in use` : inUse !== null ? `${inUse} in use` : '—';
  const lc = g.lastChange && typeof g.lastChange === 'object' ? g.lastChange : null;
  const change = lc ? `last change ${num(lc.from) ?? '?'} → ${num(lc.to) ?? '?'}${lc.reason ? `: ${governorReasonText(lc.reason)}` : ''}` : '';
  // Its signals, each "not known" when null — never a 0 it did not measure.
  const sg = g.signals && typeof g.signals === 'object' ? g.signals : {};
  const known = (v, f) => (num(v) === null ? 'not known' : f(num(v)));
  const signals = [
    `CPU ${known(sg.cpuPct, pctText)}`, `memory ${known(sg.memoryPct, pctText)}`,
    `people waiting ${known(sg.peopleWaiting, String)}`, `reports queued ${known(sg.queue, String)}`,
    `average answer ${known(sg.avgPageMs, (v) => `${Math.round(v)} ms`)}`,
  ].join(' · ');
  const jobs = num(g.jobsRunning) !== null && num(g.mostAtOnce) !== null ? `${num(g.jobsRunning)} of ${num(g.mostAtOnce)} jobs at once` : '';
  return { text: head, auto: g.auto === true ? 'auto' : g.auto === false ? 'fixed' : '', change, signals, jobs };
}

/* ---------------------------------- refusals ---------------------------------- */

const sentence = (s) => {
  const t = String(s || '').trim();
  if (!t) return '';
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(c) ? c : `${c}.`;
};

/**
 * A refused control as one plain sentence (docs/JOBS.md), never a bare kind. `now` for the
 * retry wait. Kinds the page does not know keep the core's own message.
 */
export function refusalText(res, { now = Date.now(), what = 'it' } = {}) {
  if (!res || res.ok !== false) return '';
  switch (res.kind) {
    case 'already_running':
      return `${sentence(what).replace(/\.$/, '')} is already running${res.runId ? ` (run ${res.runId})` : ''}: that run is the one you asked for, so wait for it to end.`;
    case 'joined':
      return `The same report was already queued by you: your ask joined it${res.runId ? ` (run ${res.runId})` : ''}.`;
    case 'blocked_readonly':
      return 'The config is read-only, so this job may not write to its cluster. Set readOnly to false to let it write — unlocking writes for your session does not reach background work.';
    case 'retry_limit': {
      const a = num(res.attempt), l = num(res.retryLimit);
      return `This run has been tried again ${a !== null ? `${a} time${a === 1 ? '' : 's'}` : 'as often as allowed'}${l !== null ? ` and the limit is ${l}` : ''}: run the job afresh instead (Run now), or raise the retry limit in Settings.`;
    }
    case 'retry_wait': {
      const at = num(res.retryAt);
      return at !== null
        ? `Tries of one run are kept apart: this one may be tried again ${relativeText(at, now)} (the retry wait is in Settings).`
        : 'Tries of one run are kept apart: try this one again in a few minutes (the retry wait is in Settings).';
    }
    case 'forbidden':
      return 'Only an administrator who sees every cluster may change the jobs.';
    case 'name_taken':
      return 'A schedule already has that name: pick another.';
    case 'not_found':
      return `That is no longer there${res.message ? ` (${res.message})` : ''}: the list is read again.`;
    case 'worker_unavailable':
      return res.message ? sentence(res.message) : 'The report worker is not running: its jobs resume when it is back. Monitoring is not affected.';
    case 'worker_version':
      return res.message ? sentence(res.message) : 'The report worker runs a different ElasticPro version from the core: its jobs wait until both are upgraded.';
    default:
      return sentence(res.message || res.kind || 'refused');
  }
}

/** Refusals that are the state of things, not a fault of the ask: amber, not red. */
export const refusalLevel = (res) => (res && ['already_running', 'joined', 'retry_wait', 'worker_unavailable', 'worker_version'].includes(res.kind) ? 'warn' : 'err');

/* ---------------------------------- create ---------------------------------- */

/** The report kinds JOB_CREATE takes (docs/JOBS.md "Create a job"). */
export const CREATE_KINDS = Object.freeze([
  ['volume', 'Volume report'], ['indices', 'Indices report'], ['hosts', 'Volume by host'], ['log_delay', 'Log delay report'],
]);
/** Cadences a created schedule may have: no "only by hand" (that is Run once). */
export const CREATE_CADENCES = Object.freeze([['daily', 'Daily'], ['weekly', 'Weekly · Monday'], ['monthly', 'Monthly · 1st of the month']]);
/** The most clusters one Volume by host run takes (core/report-types.js HOSTS_MAX_CLUSTERS). */
export const HOSTS_MAX = 5;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// The core checks addresses (report::mail::check_addresses); this catches a typo before it is sent.
const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** A comma, semicolon or newline list as the items it names. */
export const listOf = (text) => String(text || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

/**
 * What is wrong with the Create job form, as one sentence, or '' when it may be sent.
 * `form`: { mode: 'once'|'schedule', report, name, clusters: [ids], allClusters, period,
 *           format, schedule, at, to, cc, bcc }.
 */
export function createProblem(form) {
  const f = form || {};
  if (!CREATE_KINDS.some(([k]) => k === f.report)) return 'Pick a report.';
  const ids = Array.isArray(f.clusters) ? f.clusters : [];
  if (f.mode === 'once') {
    if (!ids.length) return 'Pick at least one cluster.';
    if (f.report === 'hosts' && ids.length > HOSTS_MAX) return `Volume by host takes at most ${HOSTS_MAX} clusters at a time.`;
    if (!f.period) return 'Pick a period.';
    return '';
  }
  const name = String(f.name || '').trim();
  if (!name) return 'Give the schedule a name.';
  if (name.length > 80) return 'The name is at most 80 characters.';
  if (!f.allClusters && !ids.length) return 'Pick at least one cluster, or All clusters.';
  if (!CREATE_CADENCES.some(([c]) => c === f.schedule)) return 'Pick when it runs: daily, weekly or monthly.';
  if (!HHMM.test(String(f.at || ''))) return 'At must be a time like 07:00 (server time).';
  const to = listOf(f.to);
  if (!to.length) return 'Add at least one address to Send to.';
  for (const [label, list] of [['Send to', to], ['Cc', listOf(f.cc)], ['Bcc', listOf(f.bcc)]]) {
    const bad = list.find((a) => !ADDRESS.test(a));
    if (bad) return `${label}: "${bad}" is not an e-mail address.`;
  }
  return '';
}

/** The JOB_CREATE message for a form createProblem() passed. */
export function createMessage(form) {
  const f = form || {};
  if (f.mode === 'once') {
    return {
      type: 'JOB_CREATE', once: true, report: f.report, clusterIds: [...f.clusters], period: f.period,
      format: f.format || 'xlsx', mail: !!f.mail, ...(f.report === 'hosts' ? { collectAgain: !!f.collectAgain } : {}),
    };
  }
  const subject = String(f.subject || '').trim();
  return {
    type: 'JOB_CREATE', report: f.report, name: String(f.name).trim(),
    clusters: f.allClusters ? 'all' : [...f.clusters],
    schedule: f.schedule, at: f.at, to: listOf(f.to), cc: listOf(f.cc), bcc: listOf(f.bcc),
    ...(f.period ? { period: f.period } : {}), ...(subject ? { subject } : {}),
  };
}

/* ---------------------------------- settings ---------------------------------- */

/** The overall settings (docs/JOBS.md `JOB_SETTINGS_*`): key, label, lowest, highest, unit. */
export const OVERALL_FIELDS = Object.freeze([
  ['mostAtOnce', 'Most jobs at once', 1, 32, ''],
  ['workerTotal', 'Worker requests in total', 1, 256, ''],
  ['cpuPct', 'Hold new runs above CPU', 10, 100, '%'],
  ['memoryPct', 'Hold new runs above memory', 10, 100, '%'],
  ['retryLimit', 'Retries of one run, at most', 0, 10, ''],
  ['retryWaitMinutes', 'Wait between tries', 0, 1440, 'min'],
]);
export const REQUESTS_CEILING = 64;

const whole = (v) => (typeof v === 'number' ? v : String(v ?? '').trim() === '' ? NaN : Number(v));

/** What is wrong with the overall settings typed, or ''. Mirrors the core's checks (jobs/controls.rs). */
export function overallProblem(o) {
  for (const [key, label, lo, hi] of OVERALL_FIELDS) {
    if (!o || !(key in o)) continue;
    const n = whole(o[key]);
    if (!Number.isInteger(n) || n < lo || n > hi) return `${label} must be a whole number from ${lo} to ${hi}.`;
  }
  return '';
}

/** What is wrong with one job's settings typed ({min, max}), or ''. */
export function jobSettingProblem(s, name = 'This job') {
  const min = whole(s && s.min), max = whole(s && s.max);
  for (const [n, w] of [[min, 'least'], [max, 'most']]) {
    if (!Number.isInteger(n) || n < 1 || n > REQUESTS_CEILING) return `${name}: requests at ${w} must be a whole number from 1 to ${REQUESTS_CEILING}.`;
  }
  if (min > max) return `${name}: requests at least (${min}) is above requests at most (${max}).`;
  return '';
}

/**
 * The JOB_SETTINGS_SET messages for what changed between `saved` (JOB_SETTINGS_GET) and the
 * `draft` typed: one for the overall settings when any changed, one per job that changed.
 * Only the fields that changed are sent.
 */
export function settingsChanges(saved, draft) {
  const out = [];
  const so = (saved && saved.overall) || {}, d = (draft && draft.overall) || {};
  const overall = {};
  for (const [key] of OVERALL_FIELDS) if (key in d && whole(d[key]) !== so[key]) overall[key] = whole(d[key]);
  if ('auto' in d && typeof so.auto === 'boolean' && d.auto !== so.auto) overall.auto = !!d.auto;
  if (Object.keys(overall).length) out.push({ type: 'JOB_SETTINGS_SET', overall });
  const byId = new Map(((saved && saved.jobs) || []).map((j) => [j.jobId, j]));
  for (const [id, dj] of Object.entries((draft && draft.jobs) || {})) {
    const sj = byId.get(id);
    if (!sj) continue;
    const m = { type: 'JOB_SETTINGS_SET', jobId: id };
    if ('enabled' in dj && !!dj.enabled !== !!sj.enabled) m.enabled = !!dj.enabled;
    if ('auto' in dj && !!dj.auto !== !!sj.auto) m.auto = !!dj.auto;
    const req = {};
    if ('min' in dj && whole(dj.min) !== (sj.requests || {}).min) req.min = whole(dj.min);
    if ('max' in dj && whole(dj.max) !== (sj.requests || {}).max) req.max = whole(dj.max);
    if (Object.keys(req).length) m.requests = req;
    if ('priority' in dj && dj.priority !== sj.priority) m.priority = dj.priority;
    if (Object.keys(m).length > 2) out.push(m);
  }
  return out;
}

/**
 * Which settings config.txt locks, from a reply's `managed` (names or `overall.<key>` /
 * `<jobId>.<key>`). The core sends none today; a reply that does is honoured.
 */
export function lockedSettings(res) {
  const out = new Set();
  for (const k of (res && Array.isArray(res.managed) ? res.managed : [])) out.add(String(k).replace(/^overall\./, ''));
  return out;
}

/* ---------------------------------- history ---------------------------------- */

/** The results the History filter offers. */
export const RESULTS = Object.freeze(['completed', 'failed', 'cancelled', 'deferred', 'skipped', 'running', 'queued']);

/** The runs of one page that match the result filter ('' = every one). */
export function filterRuns(runs, result) {
  const list = Array.isArray(runs) ? runs : [];
  return result ? list.filter((r) => r && r.status === result) : list;
}
