/**
 * Report jobs and mail, the UI side (ui/js/core/reports.js): the period presets the panel
 * offers, the words a job row and the top-bar pill say, how often the job list is asked
 * for, an older core told apart from a refusal, and which fields config.txt locks. None of
 * it works out a figure: the core runs the jobs and counts them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'customElements', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/reports.js')).href);

const NOW = Date.UTC(2026, 9, 29, 9, 0, 0);   // Thu 29 Oct 2026

test('the period presets: this month so far, the months before, yesterday, last 7 days', () => {
  const p = R.periodPresets(NOW, 2);
  assert.deepEqual(p.map((x) => x.value), ['month:2026-10', 'month:2026-09', 'month:2026-08', 'yesterday', 'last7']);
  assert.equal(p[0].label, 'Oct 2026 (so far)');
  assert.equal(p[1].label, 'Sep 2026');
  // Across a year boundary, by UTC month.
  assert.equal(R.periodPresets(Date.UTC(2027, 0, 3), 1)[1].value, 'month:2026-12');
});

test('a period in words, from a preset or from a job', () => {
  assert.equal(R.periodLabel('month:2026-10', NOW), 'Oct 2026 (so far)');
  assert.equal(R.periodLabel('month:2026-07', NOW), 'Jul 2026');
  assert.equal(R.periodLabel('yesterday', NOW), 'Yesterday');
  assert.equal(R.periodLabel('last7', NOW), 'Last 7 days');
  assert.equal(R.periodLabel({ from: '2026-10-01', to: '2026-10-28', label: 'Oct 2026 (so far)' }), 'Oct 2026 (so far)');
  assert.equal(R.periodLabel({ from: '2026-10-19', to: '2026-10-25' }), '2026-10-19 to 2026-10-25');
  assert.equal(R.periodLabel({ from: '2026-10-28', to: '2026-10-28' }), '2026-10-28');
});

test('the period Download .xlsx covers is the core\'s nextPeriod, never computed here', () => {
  assert.equal(R.schedulePeriod, undefined, 'one definition: the core\'s');
  assert.deepEqual(R.nextPeriodOf({ nextPeriod: { from: '2026-10-01', to: '2026-10-31', label: '2026-10' } }),
    { from: '2026-10-01', to: '2026-10-31', label: '2026-10' });
  assert.equal(R.nextPeriodOf({}), null, 'an older core does not say');
  assert.equal(R.nextPeriodOf({ nextPeriod: { from: 5 } }), null);
  assert.equal(R.nextPeriodOf(null), null);
});

test('a bound the core enforces is shown as the core says it', () => {
  const m = 'at most 15 jobs at once: 3 more fit';
  assert.equal(R.failText({ kind: 'too_many_jobs', message: m }, 'The report did not start'), m);
  assert.equal(R.failText({ kind: 'too_many_mails', message: 'ten an hour' }, 'x'), 'ten an hour');
  assert.equal(R.failText({ kind: 'bad_request', message: 'no recipients' }, 'Not sent'), 'Not sent: no recipients');
  assert.equal(R.failText({}, 'Not sent'), 'Not sent: refused');
});

const job = (o) => ({ id: o.id || 'j', clusterId: 'prod-eu', clusterName: 'prod-eu', status: 'queued', progress: { done: 0, total: 0 }, createdAt: 0, ...o });

test('what a job row says', () => {
  assert.equal(R.jobStatusText(job({ status: 'running', progress: { done: 31, total: 50 } })), 'Running · 62 %');
  assert.equal(R.jobStatusText(job({ status: 'running', progress: { done: 0, total: 0 } })), 'Running');
  const q = [job({ id: 'a', createdAt: 3 }), job({ id: 'b', createdAt: 1 }), job({ id: 'c', status: 'running', createdAt: 0 })];
  assert.equal(R.jobStatusText(q[0], q), 'Queued · #2 in line', 'FIFO by createdAt among the queued');
  assert.equal(R.jobStatusText(q[1], q), 'Queued · #1 in line');
  assert.equal(R.jobStatusText(job({ position: 4 }), q), 'Queued · #4 in line', 'the core\'s own position wins');
  assert.equal(R.jobStatusText(job({ status: 'done', file: { name: 'volume-prod-eu-2026-10-01_2026-10-28.xlsx', bytes: 9 } })),
    'Done · volume-prod-eu-2026-10-01_2026-10-28.xlsx');
  assert.equal(R.jobStatusText(job({ status: 'stopped', stoppedBy: 'admin', progress: { done: 2, total: 5 } })), 'Stopped by admin at 40 %');
  assert.equal(R.jobStatusText(job({ status: 'stopped', progress: { done: 0, total: 0 } })), 'Stopped by admin');
  assert.equal(R.jobStatusText(job({ status: 'failed', error: 'the server restarted' })), 'Failed: the server restarted');
  assert.equal(R.jobStatusText(job({ status: 'running', stopping: true, progress: { done: 1, total: 4 } })), 'Stopping…');
  assert.equal(R.jobStatusText(job({ status: 'stopped', stopping: true, stoppedBy: 'kd' })), 'Stopped by kd', 'stopping means nothing once it has ended');
  assert.equal(R.jobPct(job({ progress: { done: 9, total: 4 } })), 100, 'clamped');
});

test('a job\'s client: its cluster, or the mailed report', () => {
  assert.equal(R.jobClient(job({ clusterName: 'Acme prod' })), 'Acme prod');
  assert.equal(R.jobClient(job({ kind: 'mailed', clusterId: '*', clusterName: '', clusterIds: ['a', 'b'] })), 'Mailed report · 2 clusters');
  assert.equal(R.jobClient(job({ clusterId: '*', clusterName: '' })), 'Mailed report');
});

test('running first, the queue in order, the finished newest first', () => {
  const s = R.sortJobs([
    job({ id: 'old-done', status: 'done', endedAt: 10 }), job({ id: 'q2', createdAt: 5 }), job({ id: 'run', status: 'running' }),
    job({ id: 'new-fail', status: 'failed', endedAt: 20 }), job({ id: 'q1', createdAt: 4 })]);
  assert.deepEqual(s.map((j) => j.id), ['run', 'q1', 'q2', 'new-fail', 'old-done']);
});

test('the counts and the pill', () => {
  const jobs = [job({ status: 'running' }), job({ status: 'done' }), job({ status: 'done' }), job({ status: 'queued' })];
  assert.equal(R.countsText({ jobs }), '1 running · 1 queued · 2 done');
  // The core's counts are the ones shown (it may see jobs this caller's list leaves out).
  assert.equal(R.pillText({ jobs, running: 3, queued: 1 }), 'Reports · 3 running · 1 queued');
  assert.equal(R.pillText({ jobs: [], running: 0, queued: 2 }), 'Reports · 2 queued');
  assert.equal(R.pillText({ jobs: [job({ status: 'done' })], running: 0, queued: 0 }), 'Reports · idle');
});

test('how often the job list is asked for', () => {
  assert.equal(R.pollInterval({ supported: true, jobs: [], running: 1, queued: 0 }), 5000);
  assert.equal(R.pollInterval({ supported: true, jobs: [], running: 0, queued: 2 }), 5000);
  assert.equal(R.pollInterval({ supported: true, jobs: [job({ status: 'done' })], running: 0, queued: 0 }), 60000);
  assert.equal(R.pollInterval({ supported: null, jobs: [] }), 60000, 'not asked yet: the slow look');
  assert.equal(R.pollInterval({ supported: false, jobs: [] }), null, 'an older core is not asked again');
  assert.equal(R.pollInterval(null), null);
});

test('an older core is told apart from a refusal', () => {
  const unknown = { ok: false, kind: 'bad_message', message: 'Unknown message type "REPORT_JOBS"' };
  assert.equal(R.reportUnsupported(unknown, 'REPORT_JOBS'), true);
  // Hosted, below admin: an unknown type needs admin, so a user's REPORT_JOBS comes back as a role refusal.
  assert.equal(R.reportUnsupported({ ok: false, kind: 'forbidden', role: 'user', message: 'REPORT_JOBS is not available to the user role' }, 'REPORT_JOBS'), true);
  // An admin-only message refused to a user is a refusal, not an older core.
  assert.equal(R.reportUnsupported({ ok: false, kind: 'forbidden', role: 'user', message: 'REPORT_STOP is not available to the user role' }, 'REPORT_STOP'), false);
  assert.equal(R.reportUnsupported({ ok: false, kind: 'bad_message', message: 'Unknown message type "MAIL_TEST"' }, 'MAIL_TEST'), true);
  assert.equal(R.reportUnsupported({ ok: false, kind: 'smtp_failed', message: 'x' }, 'MAIL_TEST'), false);
  assert.equal(R.reportUnsupported({ ok: true }, 'REPORT_JOBS'), false);
});

test('which fields config.txt locks, however the core names them', () => {
  assert.deepEqual([...R.managedFields(['host', 'port'])], ['host', 'port']);
  assert.deepEqual([...R.managedFields(['UI_SMTP_PASSWORD_FILE', 'UI_REPORT_TO', 'UI_SMTP_SECURITY'])], ['password', 'to', 'security']);
  assert.deepEqual([...R.managedFields(['smtpHost', 'reportSchedule'])], ['host', 'schedule']);
  assert.equal(R.managedFields(null).size, 0);
});

test('the settings of a reply, flat or wrapped', () => {
  assert.deepEqual(R.settingsOf({ ok: true, host: 'smtp', passwordSet: true, managed: ['host'] }), { host: 'smtp', passwordSet: true });
  assert.deepEqual(R.settingsOf({ ok: true, settings: { host: 'smtp' }, managed: [] }), { host: 'smtp' });
  assert.equal(R.settingsOf({ ok: false }), null);
});

test('last sent, a test step, addresses, the config.txt lines and a file', () => {
  assert.deepEqual(R.lastSentText(null), { ok: null, text: 'not sent yet' });
  assert.deepEqual(R.lastSentText({ at: 1000, to: 3, ok: true }, () => '2 h ago'), { ok: true, text: '✓ last sent 2 h ago to 3 addresses' });
  assert.deepEqual(R.lastSentText({ at: 1000, to: 1, ok: true }, () => 'now'), { ok: true, text: '✓ last sent now to 1 address' });
  assert.deepEqual(R.lastSentText({ at: 1000, to: 2, ok: false, error: '550 relay denied' }), { ok: false, text: '✗ last send failed: 550 relay denied' });
  assert.equal(R.stepText({ step: 'auth', ok: false, detail: '535 bad credentials' }), '✗ auth: 535 bad credentials');
  assert.equal(R.stepText({ step: 'connect', ok: true }), '✓ connect');
  assert.deepEqual(R.addressList(' a@x, b@y ;c@z,, '), ['a@x', 'b@y', 'c@z']);
  const lines = R.mailConfigTxtLines({ host: 'smtp.x', port: 465, security: 'tls', user: 'u', from: 'f@x', password: 'never' },
    { to: ['a@x', 'b@x'], schedule: 'weekly', at: '06:30', sheets: ['daily'] });
  assert.ok(lines.includes('UI_SMTP_HOST=smtp.x') && lines.includes('UI_SMTP_SECURITY=tls') && lines.includes('UI_REPORT_TO=a@x,b@x'));
  assert.ok(lines.includes('UI_REPORT_SCHEDULE=weekly') && lines.includes('UI_REPORT_AT=06:30') && lines.includes('UI_REPORT_SHEETS=daily'));
  assert.ok(!lines.includes('never'), 'a password is never written into the example lines');
  assert.deepEqual([...R.base64ToBytes('UEsDBA==')], [0x50, 0x4b, 0x03, 0x04]);
});
