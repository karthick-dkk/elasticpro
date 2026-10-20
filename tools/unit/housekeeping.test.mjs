/**
 * The Request Centre's housekeeping card — what it says, from the core's status.
 *
 * The wording is the contract: a dry run must never read as a deletion, a job that did not
 * run must say why rather than show a zero, and a core without housekeeping must read as
 * "not available", not as "nothing to clean".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const H = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/housekeeping.js')).href);

const job = (o) => ({ id: 'fleet-cache', label: 'Fleet disk cache', ok: true, skipped: null, items: 0, bytes: 0, error: null, notes: [], ...o });
const status = (o = {}) => ({
  ok: true, enabled: true, minutes: 60, dryRun: false, cacheDays: 2, backgroundCacheDays: 7,
  sessionIdleDays: 0, activityKeepDays: 0, running: false, nextRunAt: 1_000_000 + 600_000, lastRun: null, ...o,
});

test('before the first read, and when the core has none', () => {
  assert.equal(H.housekeepingView(null).state, 'loading');
  const v = H.housekeepingView({ error: 'Unknown message type "HOUSEKEEPING_GET"' });
  assert.equal(v.state, 'unavailable');
  assert.match(v.reason, /Unknown message/);
  assert.equal(H.housekeepingView({ ok: false, message: 'housekeeping is for administrators' }).state, 'unavailable');
});

test('a job says what it did, and a dry run says "would"', () => {
  const real = H.describeJob(job({ items: 3, bytes: 2048 }), false);
  assert.deepEqual([real.state, real.text], ['ok', 'removed 3 files and folders, 2.00 KB']);
  const dry = H.describeJob(job({ items: 1, id: 'sessions' }), true);
  assert.equal(dry.text, 'would remove 1 session');
  assert.doesNotMatch(dry.text, /^removed/);
  assert.equal(H.describeJob(job({ items: 0 }), false).state, 'idle');
});

test('a skipped job gives its reason, a failed one its error', () => {
  const skip = H.describeJob(job({ skipped: 'Redis is not configured' }), false);
  assert.deepEqual([skip.state, skip.text], ['skip', 'Redis is not configured']);
  const bad = H.describeJob(job({ ok: false, error: 'redis could not be scanned' }), false);
  assert.deepEqual([bad.state, bad.text], ['err', 'redis could not be scanned']);
  assert.equal(H.describeJob(job({ ok: false, error: null }), false).text, 'failed');
});

test('the schedule in words', () => {
  assert.deepEqual([0, 60, 90, 120, 1440, 2880, 15].map(H.everyText),
    ['off', 'every hour', 'every 90 minutes', 'every 2 hours', 'every day', 'every 2 days', 'every 15 minutes']);
});

test('next run is relative to the clock it is given; off says why', () => {
  const v = H.housekeepingView(status(), 1_000_000);
  assert.equal(v.nextRun, 'in 10 m');
  assert.equal(H.housekeepingView(status({ nextRunAt: 5 }), 1_000_000).nextRun, 'due now');
  const off = H.housekeepingView(status({ enabled: false, minutes: 0, nextRunAt: null }), 1_000_000);
  assert.match(off.nextRun, /not scheduled/);
  assert.equal(off.schedule, 'off');
});

test('the last run is summarised with who started it and what it did', () => {
  const run = { startedAt: 1_000, finishedAt: 1_450, trigger: 'manual', by: 'Admin', dryRun: false, items: 5, bytes: 1048576, errors: 1,
    jobs: [job({ items: 4, bytes: 1048576 }), job({ id: 'redis', label: 'Redis cache keys', ok: false, error: 'redis could not be scanned' })],
    reportOnly: [{ id: 'keys', label: 'Uploaded keys', files: 2, bytes: 1536, oldestAgeDays: 12, note: 'never deleted' },
                 { id: 'users', label: 'Users', files: 0, bytes: 0, oldestAgeDays: null, note: '' }] };
  const v = H.housekeepingView(status({ lastRun: run }), 2_000);
  assert.equal(v.last.trigger, 'by Admin');
  assert.equal(v.last.summary, 'removed 5 items, 1.00 MB');
  assert.equal(v.last.errors, 1);
  assert.equal(v.last.tookMs, 450);
  assert.equal(v.jobs.length, 2);
  assert.equal(v.jobs[1].state, 'err');
  assert.equal(v.reportOnly[0].text, '2 files, 1.50 KB, oldest 12 d');
  assert.equal(v.reportOnly[1].text, 'none');
  const dry = H.housekeepingView(status({ lastRun: { ...run, trigger: 'schedule', by: null, dryRun: true, items: 1 } }), 2_000);
  assert.equal(dry.last.trigger, 'on schedule');
  assert.equal(dry.last.summary, 'would remove 1 item, 1.00 MB');
});

test('the rules in force are the configured ones', () => {
  const v = H.housekeepingView(status({ cacheDays: 5, sessionIdleDays: 30, activityKeepDays: 90 }), 0);
  assert.ok(v.rules.some((r) => /on-demand cache files untouched for 5 days/.test(r)));
  assert.ok(v.rules.some((r) => /sessions unused for 30 days/.test(r)));
  assert.ok(v.rules.some((r) => /rotated activity logs older than 90 days/.test(r)));
  const dflt = H.housekeepingView(status(), 0);
  assert.ok(dflt.rules.some((r) => /other sessions never expire/.test(r)), 'the default says sessions do not expire');
  assert.ok(!dflt.rules.some((r) => /activity logs/.test(r)), 'no activity-log rule when the age limit is off');
  assert.equal(dflt.dryRun, false);
  assert.equal(H.housekeepingView(status({ dryRun: true }), 0).dryRun, true);
});
