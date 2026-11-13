/**
 * The Jobs page's words and arithmetic (ui/js/core/jobs.js, docs/JOBS.md): status and progress
 * text, durations, the next run, which controls a job offers, refusals as sentences, the Create
 * job checks and the settings changes sent.
 *
 * The contract: unknown is never zero — a progress the core does not know is "counting…" and no
 * bar; a next run the core does not know is its note, never a guessed time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const J = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/jobs.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/sort.js')).href);

const NOW = 1_793_944_800_000;
const run = (o) => ({ id: 'r1', jobId: 'volume.daily', trigger: 'timer', status: 'running', createdAt: NOW - 60_000, startedAt: NOW - 60_000, endedAt: null,
  progress: null, done: null, total: null, records: null, error: null, clusters: [], ...o });
const job = (o = {}, st = {}) => ({ id: 'volume.daily', name: 'Daily volume collection', kind: 'automatic', pausable: true, priority: 'medium',
  requests: { min: 1, max: 4 }, state: { enabled: true, paused: false, current: null, activeRuns: 0, lastRun: null, nextRunAt: null, nextRunNote: null, ...st }, ...o });

test('status words and tones', () => {
  assert.equal(J.statusWord('running'), 'Running');
  assert.equal(J.statusWord('deferred'), 'Deferred');
  assert.equal(J.statusWord('brand_new'), 'brand_new', 'a status the page does not know is shown as sent');
  assert.equal(J.statusWord(null), '—');
  assert.deepEqual(['running', 'completed', 'failed', 'deferred', 'paused', 'skipped'].map(J.statusTone), ['blue', 'green', 'red', 'orange', 'yellow', 'grey']);
});

test('bars are light green, blue, pink or orange — never red or yellow', () => {
  const tones = ['running', 'completed', 'failed', 'queued', 'deferred', 'cancelled', 'pending'].map(J.barTone);
  for (const t of tones) assert.ok(['green', 'blue', 'pink', 'orange'].includes(t), t);
  assert.equal(J.barTone('failed'), 'pink');
});

test('who started a run', () => {
  assert.equal(J.triggerText('timer'), 'Automatic');
  assert.equal(J.triggerText('manual:ann'), 'by ann');
  assert.equal(J.triggerText('retry'), 'Retry');
  assert.equal(J.triggerText(null), '—');
});

test('progress: a percent when known, "counting…" and no bar when not', () => {
  assert.deepEqual(J.progressOf(run({ progress: 40, done: 2, total: 5 })), { pct: 40, text: '40 %', detail: '2 of 5' });
  const unknown = J.progressOf(run({ progress: null }));
  assert.equal(unknown.pct, null, 'no percent invented');
  assert.equal(unknown.text, 'counting…');
  assert.equal(J.progressOf(run({ progress: null, done: 3 })).text, '3 done · counting…');
  assert.equal(J.progressOf(run({ status: 'queued' })).text, 'queued');
  assert.equal(J.progressOf(run({ status: 'completed', progress: null })).text, '—');
  assert.equal(J.progressOf(run({ progress: 140 })).pct, 100, 'clamped');
  assert.equal(J.progressOf(null).text, '—');
});

test('duration: so far for an open run, start to end for a finished one, unknown when not started', () => {
  assert.equal(J.durationMs(run({ startedAt: NOW - 200_000 }), NOW), 200_000);
  assert.equal(J.durationMs(run({ status: 'completed', startedAt: NOW - 5000, endedAt: NOW - 2000 }), NOW), 3000);
  assert.equal(J.durationMs(run({ status: 'queued', startedAt: null }), NOW), null);
  assert.equal(J.durationMs(run({ status: 'failed', endedAt: null }), NOW), null, 'a finished run without an end is not timed against now');
  assert.deepEqual([350, 12_400, 200_000, 3_900_000, 3 * 86_400_000 + 7_200_000].map(J.durationText), ['350 ms', '12 s', '3m 20s', '1h 05m', '3d 2h']);
  assert.equal(J.durationText(null), '—');
  // The words read back in the same order (core/sort.js `duration`).
  const shown = ['3m 20s', '12 s', '1h 05m', '350 ms'];
  assert.deepEqual([...shown].sort((a, b) => S.compareValues(a, b, 'duration')), ['350 ms', '12 s', '3m 20s', '1h 05m']);
});

test('relative and absolute times', () => {
  assert.equal(J.relativeText(NOW + 5 * 60_000, NOW), 'in 5 min');
  assert.equal(J.relativeText(NOW - 3 * 60_000, NOW), '3 min ago');
  assert.equal(J.relativeText(NOW + 3 * 3600_000, NOW), 'in 3 h');
  assert.equal(J.relativeText(NOW + 10_000, NOW), 'within a minute');
  assert.equal(J.relativeText(null, NOW), '—');
  const srv = J.absoluteText(Date.UTC(2026, 10, 10, 8, 30), { tz: 'Asia/Kolkata', now: Date.UTC(2026, 10, 10, 8, 0) });
  assert.equal(srv.text, '14:00');
  assert.match(srv.zone, /server time \(Asia\/Kolkata\)/);
  assert.equal(J.absoluteText(NOW, { now: NOW }).zone, 'your time', 'no zone from the core: said to be the reader\'s own');
});

test('next run: the core\'s time, or its note — never a guess', () => {
  const timed = J.nextRunOf(job({}, { nextRunAt: NOW + 600_000 }), { now: NOW });
  assert.equal(timed.at, NOW + 600_000);
  assert.equal(timed.rel, 'in 10 min');
  const paused = J.nextRunOf(job({}, { nextRunAt: null, nextRunNote: 'paused by ann (JOB_RESUME starts the timer again)' }), { now: NOW });
  assert.equal(paused.at, null);
  assert.match(paused.note, /paused by ann/);
  assert.equal(J.nextRunOf(job(), { now: NOW }).note, 'not known');
});

test('which controls a job and a run offer', () => {
  assert.equal(J.canRunNow(job()), true);
  assert.equal(J.canRunNow(job({ id: 'report.run', kind: 'manual' })), false, 'a report run names its clusters and dates');
  assert.equal(J.canRunNow(job({ id: 'zabbix.push' })), false);
  assert.equal(J.canPause(job()), true);
  assert.equal(J.canPause(job({ pausable: false })), false);
  assert.equal(J.canPause(job({ kind: 'manual', pausable: true })), false);
  assert.equal(J.canCancel(run()), true);
  assert.equal(J.canCancel(run({ cancelAsked: 'ann' })), false, 'asked already');
  assert.equal(J.canCancel(run({ status: 'completed' })), false);
  assert.equal(J.canRetry(run({ status: 'failed' })), true);
  assert.equal(J.canRetry(run({ status: 'completed' })), false);
  assert.equal(J.canRetry(run({ status: 'failed', jobId: 'zabbix.push' })), false);
  assert.equal(J.canRetry(run({ id: 'report-abc', status: 'cancelled', jobId: 'report.run' })), true, 'a report job is retried with its own parameters');
  assert.equal(J.isCreated(job({ id: 'report.schedule.0a1b2c3d4e5f' })), true);
});

test('a job\'s status, priority and requests', () => {
  assert.equal(J.jobStatus(job({}, { current: run() })), 'running');
  assert.equal(J.jobStatus(job({}, { paused: true })), 'paused');
  assert.equal(J.jobStatus(job({}, { enabled: false })), 'off');
  assert.equal(J.jobStatus(job()), 'idle');
  assert.deepEqual(['high', 'medium', 'low', null].map(J.priorityRank), [1, 2, 3, null]);
  assert.equal(J.requestsText(job()).text, '1–4', 'no governor: the range only');
  assert.equal(J.requestsText(job()).now, null);
  const gov = J.requestsText(job({}, { allocation: { requests: 2, min: 1, max: 6, auto: true, reason: 'share' } }));
  assert.equal(gov.text, '2 of 1–6 · auto');
  assert.equal(gov.title, 'its share of the total, by priority', 'the core\'s reason code in words');
  assert.equal(J.requestsText(job({}, { allocation: { requests: 4, min: 1, max: 4, auto: false, reason: 'fixed' } })).text, '4 of 1–4 · fixed');
  assert.equal(J.allocationReasonText('something_new'), 'something_new', 'a code the page does not know is shown as sent');
});

test('open runs: from the page and from each job, once each, newest first', () => {
  const a = run({ id: 'a', startedAt: NOW - 10_000 });
  const b = run({ id: 'b', status: 'queued', startedAt: null, createdAt: NOW - 5000 });
  const old = run({ id: 'old', startedAt: NOW - 9_000_000 });
  const list = { runs: [a, b, run({ id: 'done', status: 'completed' })], jobs: [job({}, { current: a }), job({ id: 'hosts.collect' }, { current: old })] };
  assert.deepEqual(J.openRuns(list).map((r) => r.id), ['b', 'a', 'old']);
  assert.deepEqual(J.runCounts(list), { running: 2, queued: 1 });
  assert.equal(J.pollDelay(list), 2000);
  assert.equal(J.pollDelay({ runs: [], jobs: [job()] }), 15000);
  assert.equal(J.pollDelay(null), 15000);
});

test('up next: timed jobs soonest first, then the held ones; manual jobs are not scheduled', () => {
  const list = { jobs: [
    job({ id: 'late', name: 'Late' }, { nextRunAt: NOW + 7200_000 }),
    job({ id: 'soon', name: 'Soon' }, { nextRunAt: NOW + 60_000 }),
    job({ id: 'held', name: 'Held' }, { paused: true, nextRunNote: 'paused by ann' }),
    job({ id: 'report.run', name: 'Report runs', kind: 'manual' }, { nextRunNote: 'runs when a person asks' }),
    job({ id: 'noconf', name: 'Not configured' }, { nextRunNote: 'not configured' }),
  ] };
  assert.deepEqual(J.upNext(list, { now: NOW }).map((r) => r.job.id), ['soon', 'late', 'held']);
});

test('the strip: process figures, busy clusters, the governor when there is one', () => {
  const p = J.processFigures({ core: { cpuPct: 3.1, memoryPct: 19.7 }, worker: { state: 'up', cpuPct: 41, memoryPct: 23.8 } });
  assert.deepEqual([p.coreCpu, p.workerCpu, p.coreMem, p.workerMem, p.inCore], [3.1, 41, 19.7, 23.8, false]);
  const all = J.processFigures({ core: { cpuPct: null }, worker: { state: 'not_deployed' } });
  assert.equal(all.inCore, true);
  assert.equal(all.workerCpu, null);
  assert.equal(J.pctText(null), '—', 'not read yet is not 0 %');
  assert.equal(J.pctText(3.14), '3.1 %');
  assert.equal(J.pctText(41.2), '41 %');
  assert.match(J.processFigures({ worker: { state: 'late', text: 'last heartbeat 3 min ago' } }).workerText, /worker late/);
  assert.equal(J.busyText({ cluster: 'c1', signal: '429', reason: 'the cluster answered 429', since: NOW - 300_000 }, (id) => `name-${id}`, NOW),
    'name-c1 — 429: the cluster answered 429 (since 5 min ago)');
  assert.equal(J.governorText(null), null, 'no governor: nothing, not a zero');
  const g = J.governorText({ auto: true, inUse: 3, total: 16, mostAtOnce: 4, jobsRunning: 2, lastChange: { at: NOW, from: 16, to: 8, reason: 'people_waiting' },
    signals: { cpuPct: 41.2, memoryPct: null, peopleWaiting: 2, queue: 0, avgPageMs: null } });
  assert.equal(g.text, '3 of 16 in use');
  assert.equal(g.change, 'last change 16 → 8: people waiting');
  assert.equal(g.jobs, '2 of 4 jobs at once');
  assert.equal(g.signals, 'CPU 41 % · memory not known · people waiting 2 · reports queued 0 · average answer not known', 'null signals are not known, never 0');
  const bare = J.governorText({ auto: false, inUse: null, total: 8, lastChange: null, signals: null });
  assert.deepEqual([bare.text, bare.auto, bare.change, bare.jobs], ['—', 'fixed', '', ''], 'a governor with nothing known yet');
  assert.equal(J.governorReasonText('cpu_throttled'), 'CPU throttled');
});

test('refusals are sentences, never a bare kind', () => {
  assert.match(J.refusalText({ ok: false, kind: 'already_running', runId: '9f2c' }, { what: 'Housekeeping' }), /^Housekeeping is already running \(run 9f2c\)/);
  assert.match(J.refusalText({ ok: false, kind: 'blocked_readonly', message: 'x' }), /read-only.*readOnly to false/);
  assert.match(J.refusalText({ ok: false, kind: 'retry_limit', attempt: 3, retryLimit: 3 }), /tried again 3 times and the limit is 3/);
  assert.match(J.refusalText({ ok: false, kind: 'retry_wait', retryAt: NOW + 4 * 60_000 }, { now: NOW }), /tried again in 4 min/);
  assert.match(J.refusalText({ ok: false, kind: 'forbidden', message: 'the jobs are fleet-wide' }), /^Only an administrator who sees every cluster/);
  assert.match(J.refusalText({ ok: false, kind: 'joined', runId: 'report-1' }), /joined it/);
  assert.match(J.refusalText({ ok: false, kind: 'name_taken' }), /already has that name/);
  assert.equal(J.refusalText({ ok: false, kind: 'bad_request', message: 'housekeeping has no timer to pause' }), 'Housekeeping has no timer to pause.');
  assert.equal(J.refusalText({ ok: true }), '');
  assert.equal(J.refusalLevel({ kind: 'retry_wait' }), 'warn');
  assert.equal(J.refusalLevel({ kind: 'forbidden' }), 'err');
});

test('create: the checks, and the message sent', () => {
  const sched = { mode: 'schedule', report: 'volume', name: 'Monthly volume', clusters: [], allClusters: true, schedule: 'monthly', at: '07:00', to: 'ops@example.com', cc: '', bcc: '', period: 'cadence' };
  assert.equal(J.createProblem(sched), '');
  assert.equal(J.createProblem({ ...sched, name: '  ' }), 'Give the schedule a name.');
  assert.match(J.createProblem({ ...sched, at: '7am' }), /like 07:00/);
  assert.match(J.createProblem({ ...sched, to: '' }), /at least one address/);
  assert.match(J.createProblem({ ...sched, to: 'ops@example.com, nobody' }), /"nobody" is not an e-mail address/);
  assert.match(J.createProblem({ ...sched, allClusters: false }), /at least one cluster/);
  assert.match(J.createProblem({ ...sched, schedule: 'manual' }), /daily, weekly or monthly/);
  assert.equal(J.createProblem({ ...sched, report: 'nope' }), 'Pick a report.');
  assert.match(J.createProblem({ ...sched, schedule: 'hourly' }), /daily, weekly or monthly/, 'hourly is the log delay report\'s alone');
  assert.equal(J.createProblem({ ...sched, report: 'log_delay', schedule: 'hourly' }), '');
  assert.equal(J.createMessage({ ...sched, report: 'log_delay', schedule: 'hourly', period: 'yesterday' }).period, undefined, 'an hourly schedule sends no period');
  assert.deepEqual(J.createMessage({ ...sched, to: 'a@x.io; b@x.io', subject: ' Volume {period} ' }), {
    type: 'JOB_CREATE', report: 'volume', name: 'Monthly volume', clusters: 'all', schedule: 'monthly', at: '07:00',
    to: ['a@x.io', 'b@x.io'], cc: [], bcc: [], period: 'cadence', subject: 'Volume {period}',
  });
  const once = { mode: 'once', report: 'hosts', clusters: ['a', 'b'], period: 'monthSoFar', format: 'csvzip', mail: true, collectAgain: true };
  assert.equal(J.createProblem(once), '');
  assert.match(J.createProblem({ ...once, clusters: ['1', '2', '3', '4', '5', '6'] }), /at most 5 clusters/);
  assert.match(J.createProblem({ ...once, clusters: [] }), /at least one cluster/);
  assert.deepEqual(J.createMessage(once), { type: 'JOB_CREATE', once: true, report: 'hosts', clusterIds: ['a', 'b'], period: 'monthSoFar', format: 'csvzip', mail: true, collectAgain: true });
  assert.equal('collectAgain' in J.createMessage({ ...once, report: 'volume' }), false, 'only the hosts report collects again');
});

test('settings: the core\'s limits, and only what changed is sent', () => {
  assert.equal(J.overallProblem({ mostAtOnce: 4, cpuPct: 85, retryLimit: 0, retryWaitMinutes: 0 }), '');
  assert.match(J.overallProblem({ cpuPct: 5 }), /CPU must be a whole number from 10 to 100/);
  assert.match(J.overallProblem({ mostAtOnce: '' }), /from 1 to 32/);
  assert.match(J.overallProblem({ retryLimit: 2.5 }), /from 0 to 10/);
  assert.equal(J.jobSettingProblem({ min: 1, max: 4 }), '');
  assert.match(J.jobSettingProblem({ min: 5, max: 4 }, 'Housekeeping'), /^Housekeeping: requests at least \(5\) is above requests at most \(4\)/);
  assert.match(J.jobSettingProblem({ min: 0, max: 4 }), /from 1 to 64/);
  const saved = { overall: { mostAtOnce: 4, workerTotal: 16, cpuPct: 85, memoryPct: 85, retryLimit: 3, retryWaitMinutes: 5 },
    jobs: [{ jobId: 'housekeeping', enabled: true, auto: true, requests: { min: 1, max: 1 }, priority: 'low' },
      { jobId: 'volume.daily', enabled: true, auto: true, requests: { min: 1, max: 4 }, priority: 'medium' }] };
  const same = { overall: { ...saved.overall }, jobs: { housekeeping: { enabled: true, auto: true, min: 1, max: 1, priority: 'low' } } };
  assert.deepEqual(J.settingsChanges(saved, same), []);
  const typed = { overall: { ...saved.overall, mostAtOnce: '6' }, jobs: {
    housekeeping: { enabled: false, auto: true, min: '1', max: '2', priority: 'low' },
    'volume.daily': { enabled: true, auto: true, min: 1, max: 4, priority: 'high' } } };
  assert.deepEqual(J.settingsChanges(saved, typed), [
    { type: 'JOB_SETTINGS_SET', overall: { mostAtOnce: 6 } },
    { type: 'JOB_SETTINGS_SET', jobId: 'housekeeping', enabled: false, requests: { max: 2 } },
    { type: 'JOB_SETTINGS_SET', jobId: 'volume.daily', priority: 'high' },
  ]);
  assert.deepEqual([...J.lockedSettings({ managed: ['overall.cpuPct', 'housekeeping.priority'] })], ['cpuPct', 'housekeeping.priority']);
  assert.equal(J.lockedSettings({}).size, 0);
});

test('history filter and truncation', () => {
  const runs = [run({ id: 'a', status: 'failed' }), run({ id: 'b', status: 'completed' })];
  assert.deepEqual(J.filterRuns(runs, 'failed').map((r) => r.id), ['a']);
  assert.equal(J.filterRuns(runs, '').length, 2);
  assert.equal(J.truncate('abcdefghij', 5), 'abcd…');
  assert.equal(J.truncate('abc', 5), 'abc');
  assert.equal(J.truncate(null), '');
});
