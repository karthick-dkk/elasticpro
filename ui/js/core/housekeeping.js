/**
 * Housekeeping, as the Request Centre's card shows it — the arithmetic and wording, with no
 * DOM, so it can be unit-tested (tools/unit/housekeeping.test.mjs).
 *
 * The core's status (HOUSEKEEPING_GET) is `{enabled, minutes, dryRun, running, nextRunAt,
 * lastRun, ...}`; a run is `{startedAt, trigger, dryRun, items, bytes, errors, jobs[],
 * reportOnly[]}`. Everything the card says is derived here. Two rules the wording keeps:
 * a dry run says "would remove", never "removed"; and a job that did not run says why,
 * instead of showing a zero that reads as "looked and found nothing".
 */

import { bytes, num, dur } from '../lib/fmt.js';

/** What a count is a count of, per job — the words after the number. */
const UNIT = {
  'fleet-cache': ['file or folder', 'files and folders'],
  redis: ['key', 'keys'],
  sessions: ['session', 'sessions'],
  'api-tokens': ['token', 'tokens'],
  memory: ['map entry', 'map entries'],
  notifications: ['record', 'records'],
  silences: ['silence', 'silences'],
  'activity-log': ['rotated log', 'rotated logs'],
};

const unitOf = (id, n) => (UNIT[id] || ['item', 'items'])[n === 1 ? 0 : 1];

/** One job's line: `{state, text}`. state is ok | err | skip | idle. */
export function describeJob(job, dryRun) {
  if (!job) return { state: 'skip', text: '—' };
  if (!job.ok) return { state: 'err', text: job.error || 'failed' };
  if (job.skipped) return { state: 'skip', text: job.skipped };
  const n = Number(job.items) || 0;
  if (!n) return { state: 'idle', text: 'nothing to remove' };
  const size = Number(job.bytes) > 0 ? `, ${bytes(job.bytes)}` : '';
  return { state: 'ok', text: `${dryRun ? 'would remove' : 'removed'} ${num(n)} ${unitOf(job.id, n)}${size}` };
}

/** "every hour" / "every 90 minutes" / "off". */
export function everyText(minutes) {
  const m = Number(minutes) || 0;
  if (m <= 0) return 'off';
  if (m === 60) return 'every hour';
  if (m % 1440 === 0) return m === 1440 ? 'every day' : `every ${m / 1440} days`;
  if (m % 60 === 0) return `every ${m / 60} hours`;
  return `every ${m} minutes`;
}

/**
 * Everything the card draws, from a status and the clock.
 * `status` null means "not read yet"; `{error}` means the core refused or lacks housekeeping.
 */
export function housekeepingView(status, now = Date.now()) {
  if (!status) return { state: 'loading', title: 'Loading…' };
  if (status.error || status.ok === false) {
    return { state: 'unavailable', title: 'Housekeeping is not available', reason: status.error || status.message || 'the core did not answer' };
  }
  const run = status.lastRun || null;
  const dryRun = !!status.dryRun;
  const enabled = !!status.enabled;
  const view = {
    state: 'ready',
    enabled,
    dryRun,
    running: !!status.running,
    schedule: everyText(status.minutes),
    // The settings that decide what goes, so the card can say what "stale" means here.
    rules: [
      `on-demand cache files untouched for ${status.cacheDays || 2} days`,
      `background cache files untouched for ${status.backgroundCacheDays || 7} days`,
      status.sessionIdleDays > 0 ? `Zabbix-frame sessions unused for a day; ordinary sessions unused for ${status.sessionIdleDays} days (this signs people out)` : 'Zabbix-frame sessions unused for a day (other sessions never expire)',
      status.activityKeepDays > 0 ? `rotated activity logs older than ${status.activityKeepDays} days` : null,
    ].filter(Boolean),
    nextRun: null,
    last: null,
    jobs: [],
    reportOnly: [],
  };
  if (enabled && status.nextRunAt) {
    const left = status.nextRunAt - now;
    view.nextRun = left <= 0 ? 'due now' : `in ${dur(left)}`;
    view.nextRunAt = status.nextRunAt;
  } else if (!enabled) {
    view.nextRun = 'not scheduled (HOUSEKEEPING_MINUTES is 0)';
  }
  if (run) {
    const verb = run.dryRun ? 'would remove' : 'removed';
    view.last = {
      at: run.startedAt,
      trigger: run.trigger === 'manual' ? `by ${run.by || 'an administrator'}` : 'on schedule',
      dryRun: !!run.dryRun,
      errors: Number(run.errors) || 0,
      summary: `${verb} ${num(run.items)} item${run.items === 1 ? '' : 's'}, ${bytes(run.bytes || 0)}`,
      tookMs: Math.max(0, (run.finishedAt || run.startedAt) - run.startedAt),
    };
    view.jobs = (run.jobs || []).map((j) => ({ id: j.id, label: j.label, notes: j.notes || [], ...describeJob(j, !!run.dryRun) }));
    view.reportOnly = (run.reportOnly || []).map((r) => ({
      id: r.id, label: r.label, note: r.note,
      text: r.files ? `${num(r.files)} file${r.files === 1 ? '' : 's'}, ${bytes(r.bytes)}${r.oldestAgeDays != null ? `, oldest ${num(r.oldestAgeDays)} d` : ''}` : 'none',
    }));
  }
  return view;
}

/**
 * The card folded to one line: "ran 13:00:12, removed 1 item, 4 KB · next in 40 m". `clock`
 * formats a time. Nothing is said that the full card would not say: a run that did not
 * happen is "not run since the core started", never "removed 0".
 */
export function housekeepingLine(view, clock) {
  if (!view || view.state !== 'ready') return view && view.state === 'unavailable' ? `not available: ${view.reason}` : 'Loading…';
  const last = view.last
    ? `ran ${clock(view.last.at)}${view.last.dryRun ? ' (dry run)' : ''}, ${view.last.summary}${view.last.errors ? `, ${view.last.errors} failed` : ''}`
    : 'not run since the core started';
  const next = view.nextRun ? ` · next ${view.nextRun}` : '';
  return `${last}${next}`;
}
