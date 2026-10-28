/**
 * The Request Centre's answer-first line: quiet, busy or holding back, decided in one place
 * (requestStatus) from numbers the core reports — and "not known" where it does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const M = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/request-log.js')).href);
const H = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/housekeeping.js')).href);
const now = 1_800_000_000_000;

const limits = { global: 24, perCluster: 4, perJump: 8, backgroundReserve: 2, queueMax: 50, queueWaitMs: 20000 };
const gate = (over = {}) => ({
  running: { total: 0 }, queued: { total: 0 }, oldestWaitMs: 0, windowMs: 300000,
  waits: { interactive: { count: 0, p95Ms: null } }, refused: { total: 0, overloaded: 0, queueTimeout: 0 },
  shared: 0, cacheHits: 0, limits, readCache: { seconds: 5 }, taskReaper: { mode: 'orphans', last: null }, ...over,
});
const row = (id, ms, over = {}) => ({ id, cluster: 'a', origin: 'poller:health', method: 'GET', path: '/', startedAt: now - 10_000 - id, ms, ok: true, status: '200', ...over });

test('before the first read it says it is loading, not quiet', () => {
  const s = M.requestStatus(null, { now });
  assert.equal(s.level, 'loading'); assert.equal(s.tone, 'grey'); assert.match(s.title, /^Loading/);
});

test('quiet: nothing in flight, nothing waiting, nothing turned away', () => {
  const s = M.requestStatus({ inflight: [], recent: [], gate: gate() }, { now, sentLast5m: 0 });
  assert.equal(s.level, 'quiet'); assert.equal(s.tone, 'green');
  assert.equal(s.title, 'Quiet: nothing in flight, nothing waiting');
});

test('some work in flight with room to spare is normal, still green', () => {
  const s = M.requestStatus({ inflight: [], recent: [], gate: gate({ running: { total: 3 } }) }, { now });
  assert.equal(s.level, 'normal'); assert.equal(s.tone, 'green');
  assert.equal(s.title, 'Working normally: 3 in flight, nothing waiting');
});

test('busy: anybody waiting, or in flight at three quarters of the overall limit', () => {
  const w = M.requestStatus({ inflight: [], recent: [], gate: gate({ running: { total: 12 }, queued: { total: 3 } }) }, { now });
  assert.equal(w.level, 'busy'); assert.equal(w.title, 'Busy: 12 in flight, 3 waiting');
  const edge = M.STATUS_THRESHOLDS.nearLimit * limits.global;                     // 18 of 24
  const at = M.requestStatus({ inflight: [], recent: [], gate: gate({ running: { total: edge } }) }, { now });
  assert.equal(at.level, 'busy'); assert.match(at.title, /^Busy: 18 in flight, nothing waiting$/);
  const below = M.requestStatus({ inflight: [], recent: [], gate: gate({ running: { total: edge - 1 } }) }, { now });
  assert.equal(below.level, 'normal');
});

test('holding back: any turned away is amber; many, or a full queue, is red', () => {
  const few = M.requestStatus({ inflight: [], recent: [], gate: gate({ refused: { total: 5, overloaded: 5, queueTimeout: 0 } }) }, { now });
  assert.equal(few.level, 'holding'); assert.equal(few.tone, 'yellow');
  assert.equal(few.title, 'Holding back: 5 turned away in the last 5 min');
  const many = M.requestStatus({ inflight: [], recent: [], gate: gate({ refused: { total: M.STATUS_THRESHOLDS.redRefused } }) }, { now });
  assert.equal(many.tone, 'red');
  const full = M.requestStatus({ inflight: [], recent: [], gate: gate({ queued: { total: 50 }, refused: { total: 1 } }) }, { now });
  assert.equal(full.tone, 'red', 'a queue at its maximum is red whatever the refusal count');
  const beats = M.requestStatus({ inflight: [], recent: [], gate: gate({ running: { total: 20 }, queued: { total: 4 }, refused: { total: 2 } }) }, { now });
  assert.equal(beats.level, 'holding', 'turned away outranks busy');
});

test('the emergency stop outranks everything: nothing is going out', () => {
  const s = M.requestStatus({ inflight: [], recent: [], gate: gate({ refused: { total: 9 } }) }, { now, paused: true });
  assert.equal(s.level, 'paused'); assert.equal(s.tone, 'yellow'); assert.match(s.title, /^Emergency stop: /);
});

test('an older core with no gate block: not known, never a quiet 0', () => {
  const s = M.requestStatus({ inflight: [{ id: 1, cluster: 'a', method: 'GET', path: '/', startedAt: now - 50 }], recent: [] }, { now });
  assert.equal(s.level, 'unknown'); assert.equal(s.tone, 'grey');
  assert.match(s.title, /^Not known: this core does not report its request gate/);
  assert.equal(s.waiting, null); assert.equal(s.refused, null);
  assert.equal(s.inFlight, 1, 'what the log itself holds is still counted');
});

test('a gate that does not report its queue says "waiting not reported"', () => {
  const g = gate({ running: { total: 2 } }); delete g.queued;
  const s = M.requestStatus({ inflight: [], recent: [], gate: g }, { now });
  assert.equal(s.level, 'normal'); assert.equal(s.waiting, null);
  assert.equal(s.title, 'Working normally: 2 in flight, waiting not reported');
});

test('the sentence: count, outcome and slowest, from the window', () => {
  const log = { inflight: [], recent: [row(1, 12), row(2, 30), row(3, 4)], gate: gate() };
  assert.equal(M.requestSentence(log, { now, sentLast5m: 11 }), '11 requests in the last 5 minutes, all answered. The slowest took 30 ms.');
  assert.equal(M.requestStatus(log, { now, sentLast5m: 11 }).detail, M.requestSentence(log, { now, sentLast5m: 11 }));
  const bad = { ...log, recent: [...log.recent, row(4, 900, { ok: false, status: '500' }), row(5, 0, { ok: false, status: 'overloaded' })] };
  assert.match(M.requestSentence(bad, { now, sentLast5m: 1 }), /^1 request in the last 5 minutes, 1 failed\. The slowest took 900 ms\.$/,
    'a failure is counted, a refusal by the gate is not a failure and not the slowest');
  const old = { inflight: [], recent: [row(6, 20000, { startedAt: now - 10 * 60_000 }), row(7, 7)] };
  assert.match(M.requestSentence(old, { now, sentLast5m: 2 }), /The slowest took 7 ms\.$/, 'rows older than the window do not count');
});

test('the sentence says so when it cannot know', () => {
  const log = { inflight: [], recent: [] };
  assert.match(M.requestSentence(log, { now, sentLast5m: null }), /is not known yet\.$/, 'the rate was never read: not "0 requests"');
  assert.equal(M.requestSentence(log, { now, sentLast5m: 0 }), 'No requests in the last 5 minutes.');
  assert.match(M.requestSentence(log, { now, sentLast5m: 3 }), /none of them is in the log/);
  const full = { inflight: [], recent: Array.from({ length: M.LOG_LIMIT }, (_, i) => row(i + 1, 5, { startedAt: now - 1000 - i })) };
  assert.match(M.requestSentence(full, { now, sentLast5m: 900 }), /\(of the latest 500 in the log\)/, 'a full log that does not reach back 5 minutes is not passed off as the window');
});

test('mode text: names the mode, and says so when the core did not', () => {
  assert.deepEqual(M.modeText('on-demand'), { label: 'Client basis', because: 'so requests go out only when a page asks' });
  assert.equal(M.modeText('auto').label, 'Automatic');
  assert.equal(M.modeText(undefined).label, null);
});

test('limit chips: the same values the old sentence gave, as labelled chips', () => {
  const chips = M.limitChips({ gate: gate({ taskReaper: { mode: 'orphans', last: { cancelled: [{ ok: true }, { ok: true }, { ok: false }] } } }) });
  const text = chips.map((c) => `${c.pre}${c.value}${c.post}`);
  assert.deepEqual(text, ['24 at once', '4 per cluster', '8 per jump host', '2 kept for background', 'a person waits up to 20 s',
    'repeats served from a 5 s cache', 'orphaned tasks cancelled: 2']);
});

test('limit chips: unknown stays unknown', () => {
  assert.equal(M.limitChips({ gate: { queued: { total: 0 } } }), null, 'no limits block: nothing to draw');
  const base = { gate: gate() };
  const never = M.limitChips(base).at(-1);
  assert.equal(`${never.pre}${never.value}`, 'orphaned tasks cancelled: not run yet', 'a reaper that has not run is not "0 cancelled"');
  const off = M.limitChips({ gate: gate({ taskReaper: { mode: 'off', last: null } }) }).at(-1);
  assert.equal(off.value, 'not cancelled');
  const noCache = M.limitChips({ gate: gate({ readCache: { seconds: 0 } }) }).find((c) => c.id === 'cache');
  assert.equal(`${noCache.pre}${noCache.value}`, 'read cache off');
  assert.equal(M.limitChips({ gate: gate({ taskReaper: undefined }) }).some((c) => c.id === 'reaper'), false, 'no reaper block: no reaper chip');
});

test('table cells: clock time, class tag, result tone', () => {
  const t = new Date(2026, 9, 20, 9, 5, 7).getTime();
  assert.equal(M.clockTime(t), '09:05:07');
  assert.equal(M.clockTime(0), '–'); assert.equal(M.clockTime(undefined), '–');
  assert.equal(M.classTag('interactive').label, 'person'); assert.equal(M.classTag('background').label, 'background');
  assert.equal(M.classTag(undefined), null);
  assert.equal(M.resultTone({ ok: true }), 'ok');
  assert.equal(M.resultTone({ ok: false, status: '500' }), 'err');
  assert.equal(M.resultTone({ ok: false, status: 'timeout' }), 'err');
  assert.equal(M.resultTone({ ok: false, status: 'overloaded' }), 'warn');
});

test('housekeeping on one line', () => {
  const clock = (ms) => `t${ms}`;
  assert.equal(H.housekeepingLine(H.housekeepingView(null), clock), 'Loading…');
  assert.match(H.housekeepingLine(H.housekeepingView({ error: 'nope' }), clock), /^not available: nope$/);
  const idle = H.housekeepingView({ ok: true, enabled: true, minutes: 60, nextRunAt: now + 40 * 60_000 }, now);
  assert.equal(H.housekeepingLine(idle, clock), 'not run since the core started · next in 40 m');
  const ran = H.housekeepingView({ ok: true, enabled: true, minutes: 60, nextRunAt: now + 60_000,
    lastRun: { startedAt: 77, trigger: 'schedule', dryRun: true, items: 1, bytes: 0, errors: 0, jobs: [] } }, now);
  assert.equal(H.housekeepingLine(ran, clock), 'ran t77 (dry run), would remove 1 item, 0 B · next in 1.0 m'.replace('1.0 m', '60 s'));
});
