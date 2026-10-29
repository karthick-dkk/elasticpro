/**
 * Report jobs and mail (0.3.45): the core's REPORT_* / MAIL_* messages, the one poller
 * that follows the job list, and the words the pages show for what it says.
 *
 * docs/VOLUME.md "Reports and mail" is the contract. The core queues the jobs, runs at most
 * `concurrency` of them, builds the files and sends the mail; this module asks and tells,
 * and works none of that out again. The only thing derived here is presentation: a job's
 * place in the queue when the core does not say it, a percentage from `progress`, and the
 * label of a period preset.
 *
 * An older core does not know these messages. That is `unsupported`, and everything that
 * shows reports (the top-bar pill, Generate report, the mail panels) hides itself or says
 * "needs 0.3.45" on it: never a crash, never a list that is merely empty.
 *
 * Reply shapes beyond the contract table, as the core sends them:
 *   REPORT_RUN           {jobs, refused:[{clusterId, reason}]}
 *   Job                  also {kind:"cluster"|"mailed", clusterIds, warning, stopping}
 *   MAIL_SETTINGS_GET    flat {host, port, security, auth, user, from, passwordSet,
 *                        passwordFrom, managed:[field names], configured, problem,
 *                        canStorePassword, passwordStoreProblem}
 *   REPORT_SCHEDULE_GET  flat {enabled, to, cc, bcc, schedule, at, clusters, subject, sheets,
 *                        lastSent:{at, to:<count>, ok, error}|null, managed, timer,
 *                        nextSendAt, mailConfigured}
 *   the *_SET messages   send the same fields flat beside `type`.
 * settingsOf() also takes the fields under `settings`, in case a core ever wraps them.
 */

import { bridge } from './transport.js';
import { isUnsupported, utcDay, monthName, toMs } from './volume-daily.js';
import { navigateTo } from './intent.js';
import { setFocus } from './focus.js';

/** The version that first runs report jobs, for the "needs" line. */
export const REPORTS_NEEDS = '0.3.45';

/** Admin-only messages: a role refusal of one of these is a refusal, never "an older core". */
const ADMIN_ONLY = new Set(['REPORT_STOP', 'REPORT_CONCURRENCY_SET', 'MAIL_SETTINGS_GET', 'MAIL_SETTINGS_SET',
  'MAIL_TEST', 'REPORT_SCHEDULE_GET', 'REPORT_SCHEDULE_SET', 'REPORT_SEND_NOW']);

/**
 * Whether the reply says the core has no such message. For a user-level message an older
 * hosted core answers a non-admin with the same "not available to the role" it uses for
 * any unknown type (volume-daily.js isUnsupported); an admin-only one is only unsupported
 * when the core says it does not know it.
 */
export function reportUnsupported(res, type) {
  if (!isUnsupported(res, type)) return false;
  return !ADMIN_ONLY.has(type) || res.kind === 'bad_message';
}

/** Never throws: `{ok:false, unsupported:true}` for an older core, `{ok:false, message}` otherwise. */
async function send(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { return { ok: false, message: e.message || String(e) }; }
  if (reportUnsupported(res, msg.type)) {
    return { ok: false, unsupported: true, kind: 'unsupported', message: `This server does not run reports yet (needs ElasticPro ${REPORTS_NEEDS})` };
  }
  return res || { ok: false, kind: 'worker_error', message: 'the core did not answer' };
}

/* -------------------------------- the messages -------------------------------- */

/** One job per cluster. `period`: a preset ("month:2026-10", "yesterday", "last7") or {from, to}. */
export const reportRun = ({ clusterIds, period, format, mail }) =>
  send({ type: 'REPORT_RUN', clusterIds, period, format, mail: !!mail });
/** `{jobs, concurrency, running, queued}` */
export const reportJobs = () => send({ type: 'REPORT_JOBS' });
/** Admin. `{id}` or `{all:true}`. */
export const reportStop = (which) => send({ type: 'REPORT_STOP', ...which });
/** Finished, stopped and failed jobs the caller started (an admin: all). */
export const reportClear = () => send({ type: 'REPORT_CLEAR' });
/** `{name, mime, base64}`: the starter or an admin. */
export const reportDownload = (id) => send({ type: 'REPORT_DOWNLOAD', id });
/** Admin, 3..5. */
export const reportConcurrencySet = (n) => send({ type: 'REPORT_CONCURRENCY_SET', n: Number(n) });
export const mailSettingsGet = () => send({ type: 'MAIL_SETTINGS_GET' });
/** The password goes only when it was typed: absent keeps the stored one. */
export const mailSettingsSet = (settings) => send({ type: 'MAIL_SETTINGS_SET', ...settings });
/** `{ok, steps:[{step, ok, detail}]}` */
export const mailTest = (to) => send({ type: 'MAIL_TEST', to });
export const reportScheduleGet = () => send({ type: 'REPORT_SCHEDULE_GET' });
export const reportScheduleSet = (settings) => send({ type: 'REPORT_SCHEDULE_SET', ...settings });
/** Runs the mailed report now, as a background job: `{job}`. `period` as REPORT_RUN takes it; absent = the schedule's. */
export const reportSendNow = (period) => send({ type: 'REPORT_SEND_NOW', ...(period ? { period } : {}) });

/** The settings object of a *_GET reply, flat or under `settings`. */
export function settingsOf(res) {
  if (!res || !res.ok) return null;
  if (res.settings && typeof res.settings === 'object') return res.settings;
  const { ok: _ok, type: _t, managed: _m, ...rest } = res;
  return rest;
}

/**
 * Open Indices › Summary › Monthly with the report panel open: the top-bar pill, and the
 * Config page after it starts a job. The hint is taken by the Indices page (core/focus.js).
 */
export function openReportJobs() {
  setFocus('indices', { reports: true });
  navigateTo('indices');
}

/* --------------------------------- the poller --------------------------------- */

/**
 * What the last REPORT_JOBS said. `supported` is null until the core has answered once,
 * false for an older core (the poller then stops for good, until resetReports()).
 */
export const reports = { supported: null, jobs: [], concurrency: 3, running: 0, queued: 0, error: null, at: 0 };

const FAST_MS = 5000;
const SLOW_MS = 60000;

/** How long until the next look: often while something runs or waits, rarely when idle, never when unsupported. */
export function pollInterval(snap) {
  if (!snap || snap.supported === false) return null;
  const c = jobCounts(snap);
  return c.running + c.queued > 0 ? FAST_MS : SLOW_MS;
}

const listeners = new Set();
/** Be told after every answer. Returns the function that stops it. */
export function onReports(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) { try { fn(reports); } catch (_) { /* the rest still hear */ } } };

let timer = null;
let started = false;
let inflight = null;

function schedule() {
  if (timer) { clearTimeout(timer); timer = null; }
  const ms = pollInterval(reports);
  if (ms === null || !started) return;
  timer = setTimeout(tick, ms);
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

async function tick() {
  timer = null;
  // A tab nobody is looking at asks nothing; becoming visible asks at once (below).
  if (hidden()) return;
  await refreshReports();
}

/**
 * Ask REPORT_JOBS now and reschedule. Pages call this straight after they run, stop or
 * clear a job, so the list moves with the press rather than up to a minute later.
 */
export function refreshReports() {
  if (reports.supported === false) return Promise.resolve(reports);
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await reportJobs();
    if (res.unsupported) {
      Object.assign(reports, { supported: false, jobs: [], running: 0, queued: 0, error: null });
    } else if (!res.ok) {
      // Signed out, a restart, a refusal: say nothing new, and look again later.
      reports.error = res.message || res.kind || 'no answer';
    } else {
      Object.assign(reports, {
        supported: true, error: null, at: Date.now(),
        jobs: Array.isArray(res.jobs) ? res.jobs : [],
        concurrency: Number(res.concurrency) || reports.concurrency,
      });
      const c = jobCounts({ ...res, jobs: reports.jobs });
      reports.running = c.running;
      reports.queued = c.queued;
    }
    inflight = null;
    notify();
    schedule();
    return reports;
  })();
  return inflight;
}

/** Start following the job list (idempotent). The pill calls this once the shell is up. */
export function startReportsPoll() {
  if (started) return;
  started = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (started && !hidden() && !timer && !inflight && reports.supported !== false) refreshReports();
    });
  }
  refreshReports();
}

/** Forget everything (the tests, and a core upgraded since). The poller restarts on the next start. */
export function resetReports() {
  if (timer) clearTimeout(timer);
  timer = null;
  inflight = null;
  started = false;
  Object.assign(reports, { supported: null, jobs: [], concurrency: 3, running: 0, queued: 0, error: null, at: 0 });
  notify();
}

/* ---------------------------------- the words ---------------------------------- */

const ACTIVE = new Set(['running', 'queued']);
export const isActive = (job) => !!job && ACTIVE.has(job.status);
export const isFinished = (job) => !!job && !ACTIVE.has(job.status);

/** Running / queued / done, the core's counts when it sent them, else counted from the jobs. */
export function jobCounts(snap) {
  const jobs = (snap && snap.jobs) || [];
  const count = (s) => jobs.filter((j) => j && j.status === s).length;
  const n = (v, s) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : count(s));
  return { running: n(snap && snap.running, 'running'), queued: n(snap && snap.queued, 'queued'), done: count('done') };
}

/** "3 running · 1 queued · 4 done" */
export function countsText(snap) {
  const c = jobCounts(snap);
  return `${c.running} running · ${c.queued} queued · ${c.done} done`;
}

/** The top-bar pill: "Reports · 3 running · 1 queued", or "Reports · idle". */
export function pillText(snap) {
  const c = jobCounts(snap);
  const parts = [];
  if (c.running) parts.push(`${c.running} running`);
  if (c.queued) parts.push(`${c.queued} queued`);
  return `Reports · ${parts.length ? parts.join(' · ') : 'idle'}`;
}

/** Whole percent of a job's progress, or null when the core has not said how much there is. */
export function jobPct(job) {
  const p = job && job.progress;
  if (!p || !(Number(p.total) > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((Number(p.done) || 0) / Number(p.total) * 100)));
}

/** Oldest first, as the core starts them (FIFO). */
const byCreated = (a, b) => (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0);

/** A queued job's place in line: the core's `position` when it sends one, else its FIFO place. */
export function queuePosition(job, jobs) {
  if (!job || job.status !== 'queued') return null;
  if (Number(job.position) > 0) return Number(job.position);
  const q = (jobs || []).filter((j) => j && j.status === 'queued').sort(byCreated);
  const i = q.findIndex((j) => j.id === job.id);
  return i >= 0 ? i + 1 : null;
}

/** The client a job is for: its cluster, or "Mailed report" for the scheduled one (clusterId "*"). */
export function jobClient(job) {
  if (!job) return '';
  if (job.kind === 'mailed' || job.clusterId === '*') {
    const n = Array.isArray(job.clusterIds) ? job.clusterIds.length : 0;
    return n ? `Mailed report · ${n} cluster${n === 1 ? '' : 's'}` : 'Mailed report';
  }
  return job.clusterName || job.clusterId || '';
}

/** What a job row says about where it is. */
export function jobStatusText(job, jobs) {
  if (!job) return '';
  const pct = jobPct(job);
  // An admin pressed Stop; the job ends at the next day boundary it reaches.
  if (job.stopping && isActive(job)) return 'Stopping…';
  switch (job.status) {
    case 'running': return pct === null ? 'Running' : `Running · ${pct} %`;
    case 'queued': { const pos = queuePosition(job, jobs); return pos ? `Queued · #${pos} in line` : 'Queued'; }
    case 'done': return job.file && job.file.name ? `Done · ${job.file.name}` : 'Done';
    case 'stopped': return `Stopped by ${job.stoppedBy || 'admin'}${pct === null ? '' : ` at ${pct} %`}`;
    case 'failed': return `Failed: ${job.error || 'no reason given'}`;
    default: return String(job.status || '');
  }
}

/** Running first, then the queue in the order it starts, then the finished ones newest first. */
export function sortJobs(jobs) {
  const rank = { running: 0, queued: 1 };
  return [...(jobs || [])].filter(Boolean).sort((a, b) => {
    const ra = rank[a.status] ?? 2, rb = rank[b.status] ?? 2;
    if (ra !== rb) return ra - rb;
    if (ra < 2) return byCreated(a, b);
    return (toMs(b.endedAt ?? b.createdAt) ?? 0) - (toMs(a.endedAt ?? a.createdAt) ?? 0);
  });
}

/* ---------------------------------- periods ---------------------------------- */

/**
 * The periods Generate report offers, as the presets the core takes. Calendar months are
 * UTC, as the core counts days. The current month is "so far".
 */
export function periodPresets(now = Date.now(), previous = 12) {
  const d = new Date(now);
  const ym = (i) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
  const out = [{ value: `month:${ym(0)}`, label: `${monthName(ym(0))} (so far)` }];
  for (let i = 1; i <= previous; i++) out.push({ value: `month:${ym(i)}`, label: monthName(ym(i)) });
  out.push({ value: 'yesterday', label: 'Yesterday' }, { value: 'last7', label: 'Last 7 days' });
  return out;
}

/** A period in words: a preset, a job's `{from, to, label}`, or a bare range. */
export function periodLabel(p, now = Date.now()) {
  if (!p) return '';
  if (typeof p === 'object') {
    if (p.label) return String(p.label);
    return p.from && p.to ? (p.from === p.to ? p.from : `${p.from} to ${p.to}`) : '';
  }
  const m = /^month:(\d{4}-\d{2})$/.exec(String(p));
  if (m) return m[1] === utcDay(now).slice(0, 7) ? `${monthName(m[1])} (so far)` : monthName(m[1]);
  if (p === 'yesterday') return 'Yesterday';
  if (p === 'last7') return 'Last 7 days';
  return String(p);
}

/**
 * The period "Download .xlsx" beside the mailed report's settings covers: the core's
 * `nextPeriod` from REPORT_SCHEDULE_GET (the one definition: the timer's own function),
 * as a REPORT_RUN `{from, to}`. null from an older core, which does not say.
 */
export function nextPeriodOf(sched) {
  const p = sched && sched.nextPeriod;
  return p && typeof p.from === 'string' && typeof p.to === 'string' ? { from: p.from, to: p.to, label: p.label } : null;
}

/** Kinds whose message is the whole answer: the core says how many more fit, or when. */
const BOUND_KINDS = new Set(['too_many_jobs', 'too_many_mails']);

/**
 * A refused REPORT_RUN / REPORT_SEND_NOW in words. A bound the core enforces (too many
 * jobs, too many mails) is shown as the core says it; anything else gets `prefix`.
 */
export function failText(res, prefix) {
  const msg = (res && (res.message || res.kind)) || 'refused';
  return res && BOUND_KINDS.has(res.kind) && res.message ? String(res.message) : `${prefix}: ${msg}`;
}

/* ---------------------------------- the mail ---------------------------------- */

/** A comma list as typed, as the addresses it names. */
export function addressList(text) {
  return String(text || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Which form fields config.txt locks, from a reply's `managed` list. The core may name a
 * field (`host`), its config.txt key (`UI_SMTP_HOST`) or a managed-style name
 * (`smtpHost`); each is read as the field it locks.
 */
const ENV_FIELD = {
  UI_SMTP_HOST: 'host', UI_SMTP_PORT: 'port', UI_SMTP_SECURITY: 'security', UI_SMTP_USER: 'user',
  UI_SMTP_PASSWORD_FILE: 'password', UI_SMTP_PASSWORD: 'password', UI_SMTP_FROM: 'from', UI_SMTP_AUTH: 'auth',
  UI_REPORT_TO: 'to', UI_REPORT_SCHEDULE: 'schedule', UI_REPORT_AT: 'at', UI_REPORT_SHEETS: 'sheets',
};
export function managedFields(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const k = String(raw || '').trim();
    if (!k) continue;
    if (ENV_FIELD[k.toUpperCase()]) { out.add(ENV_FIELD[k.toUpperCase()]); continue; }
    const m = /^(?:smtp|report|mail)([A-Z].*)$/.exec(k);
    const f = m ? m[1][0].toLowerCase() + m[1].slice(1) : k;
    out.add(f === 'passwordFile' ? 'password' : f);
  }
  return out;
}

/** The config.txt lines for mail and the mailed report, with what is set now (the password never). */
export function mailConfigTxtLines(mail, schedule) {
  const m = mail || {};
  const s = schedule || {};
  const list = (x) => (Array.isArray(x) ? x.join(',') : String(x ?? ''));
  return [
    `UI_SMTP_HOST=${m.host ?? ''}`,
    `UI_SMTP_PORT=${m.port ?? 587}`,
    `UI_SMTP_SECURITY=${m.security || 'starttls'}`,
    `UI_SMTP_USER=${m.user ?? ''}`,
    'UI_SMTP_PASSWORD_FILE=<path of a file that holds the password>',
    `UI_SMTP_FROM=${m.from ?? ''}`,
    `UI_REPORT_TO=${list(s.to)}`,
    `UI_REPORT_SCHEDULE=${s.schedule || 'monthly'}`,
    `UI_REPORT_AT=${s.at || '07:00'}`,
    `UI_REPORT_SHEETS=${list(s.sheets || ['daily', 'monthly', 'breakdown'])}`,
  ].join('\n');
}

/** "✓ last sent 2 h ago to 3 addresses" / "✗ last send failed: …" / "not sent yet". */
export function lastSentText(last, agoText = (ms) => new Date(ms).toLocaleString()) {
  if (!last || (!last.at && last.ok === undefined)) return { ok: null, text: 'not sent yet' };
  const at = toMs(last.at);
  if (last.ok === false) return { ok: false, text: `✗ last send failed: ${last.error || 'no reason given'}` };
  const n = Array.isArray(last.to) ? last.to.length : Number(last.to) || 0;
  return { ok: true, text: `✓ last sent ${at === null ? '' : `${agoText(at)} `}to ${n} address${n === 1 ? '' : 'es'}` };
}

/** One MAIL_TEST step in words: "✓ connect" / "✗ auth: 535 bad credentials". */
export function stepText(s) {
  if (!s) return '';
  return `${s.ok ? '✓' : '✗'} ${s.step || '?'}${s.detail ? `: ${s.detail}` : ''}`;
}

/** The base64 the core sends a file in, as bytes. */
export function base64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
