/** The page-side alert reporter's pure logic (core/alert-events.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/alert-events.js')).href);

const m = (keys, extra = {}) => ({ state: 'open', keys, key: keys[0], ...extra });

test('only keys the core accepts are tracked', () => {
  assert.equal(A.reportable('c1:disk'), true);
  assert.equal(A.reportable('c1:slm-fail:policy-a'), true);
  assert.equal(A.reportable('c1:node-left:n2'), true);
  assert.equal(A.reportable('c1:no-such-rule'), false);
  assert.equal(A.reportable('c1'), false);
  assert.deepEqual([...A.keysOf([m(['c1:disk', 'c1:bogus']), { state: 'acked', keys: ['c1:heap'] }, { state: 'held', held: true, keys: ['c2:health'] }])].sort(), ['c1:disk', 'c2:health']);
});

test('the first pass reports nothing; later passes report appearances and (after grace) disappearances', () => {
  let r = A.transitions(null, new Set(['c1:disk']));
  assert.deepEqual(r.events, []);
  r = A.transitions(r.seen, new Set(['c1:disk', 'c1:heap']), { at: 5 });
  assert.deepEqual(r.events, [{ event: 'raised', key: 'c1:heap', at: 5 }]);
  r = A.transitions(r.seen, new Set(['c1:disk']), { at: 6 });
  assert.deepEqual(r.events, [], 'one pass absent is a blip');
  r = A.transitions(r.seen, new Set(['c1:disk']), { at: 7 });
  assert.deepEqual(r.events, [{ event: 'cleared', key: 'c1:heap', at: 7 }]);
  r = A.transitions(r.seen, new Set(['c1:disk']));
  assert.deepEqual(r.events, [], 'cleared once');
});

test('a blip that returns reports nothing', () => {
  let r = A.transitions(null, new Set(['c1:disk']));
  r = A.transitions(r.seen, new Set());
  r = A.transitions(r.seen, new Set(['c1:disk']));
  assert.deepEqual(r.events, []);
});

test('batches hold at most 200 events', () => {
  const ev = Array.from({ length: 450 }, (_, i) => ({ event: 'raised', key: `c:disk:${i}` }));
  assert.deepEqual(A.batches(ev).map((b) => b.length), [200, 200, 50]);
  assert.deepEqual(A.batches([]), []);
});

test('raised then cleared before a flush cancel out', () => {
  const q = [{ event: 'raised', key: 'a:disk' }, { event: 'raised', key: 'b:disk' }, { event: 'cleared', key: 'a:disk' }];
  assert.deepEqual(A.coalesce(q).map((e) => e.key), ['b:disk']);
});

function rig({ reply = { ok: true, routed: true }, store = null, enabled = true } = {}) {
  let t = 1_000_000;
  const sent = [];
  const rep = A.createReporter({ send: async (b) => { sent.push(b); return reply; }, now: () => t, store, enabled: () => enabled });
  return { rep, sent, tick: (ms) => { t += ms; } };
}

test('the reporter sends transitions, at most once per flush interval', async () => {
  const { rep, sent, tick } = rig();
  await rep.observe([m(['c1:disk'])]);
  tick(30000);
  await rep.observe([m(['c1:disk', 'c1:heap'])]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].event, 'raised');
  tick(1000);
  await rep.observe([m(['c1:disk', 'c1:heap', 'c1:health'])]);
  assert.equal(sent.length, 1, 'debounced');
  assert.equal(rep.queued, 1);
  tick(30000);
  await rep.observe([m(['c1:disk', 'c1:heap', 'c1:health'])]);
  assert.equal(sent.length, 2);
});

test('too_many pauses for the quota window, then reporting resumes', async () => {
  const { rep, sent, tick } = rig({ reply: { ok: false, kind: 'too_many' } });
  await rep.observe([m(['c1:disk'])]);
  tick(30000);
  await rep.observe([m(['c1:disk', 'c1:heap'])]);
  assert.equal(rep.stopped, false, 'not permanent');
  assert.ok(rep.pausedUntil > 1_000_000 + 30000 + A.ALERT_EVENTS_WINDOW_MS - 1);
  tick(60000);
  await rep.observe([m(['c1:disk', 'c1:heap', 'c1:health'])]);
  assert.equal(sent.length, 1, 'nothing sent while paused');
  tick(A.ALERT_EVENTS_WINDOW_MS);
  await rep.observe([m(['c1:disk', 'c1:heap', 'c1:health', 'c1:ilm'])]);
  assert.equal(sent.length, 2, 'resumed after the window');
});

test('an unsupported core stops the reporter for good', async () => {
  const { rep, sent, tick } = rig({ reply: { ok: false, supported: false } });
  await rep.observe([m(['c1:disk'])]);
  tick(30000);
  await rep.observe([m(['c1:disk', 'c1:heap'])]);
  assert.equal(rep.stopped, true);
  tick(60000);
  await rep.observe([m(['c1:disk'])]);
  assert.equal(sent.length, 1);
});

test('forbidden for one cluster drops that cluster and carries on', async () => {
  let t = 1_000_000; const sent = [];
  const rep = A.createReporter({ now: () => t, send: async (evs) => {
    sent.push(evs.map((e) => e.key));
    return evs.some((e) => e.key.startsWith('secret:')) ? { ok: false, kind: 'forbidden' } : { ok: true, routed: true };
  } });
  await rep.observe([m(['a:disk', 'secret:disk'])]);
  t += 30000;
  await rep.observe([m(['a:disk', 'secret:disk', 'a:heap', 'secret:heap'])]);
  assert.equal(rep.stopped, false);
  assert.deepEqual(rep.blocked, ['secret']);
  assert.ok(sent.some((s) => s.length === 1 && s[0] === 'a:heap'), 'the allowed cluster was still sent');
  t += 30000;
  await rep.observe([m(['a:disk', 'secret:disk', 'a:heap', 'secret:heap', 'a:ilm', 'secret:ilm'])]);
  assert.deepEqual(sent.at(-1), ['a:ilm'], 'the blocked one is not tried again');
});

const status = (map) => (id) => map[id];

test('keys of a down cluster are carried forward, not cleared; its unreachable key transitions', () => {
  let r = A.transitions(null, new Set(['c1:disk', 'c1:health']));
  const down = status({ c1: 'down' });
  for (let i = 0; i < 4; i++) {
    r = A.transitions(r.seen, new Set(['c1:unreachable']), { status: down });
    assert.ok(r.events.every((e) => e.key === 'c1:unreachable'), JSON.stringify(r.events));
  }
  assert.ok(r.seen.has('c1:disk') && r.seen.has('c1:health'), 'still remembered');
  r = A.transitions(r.seen, new Set(['c1:disk', 'c1:health']), { status: status({ c1: 'up' }) });
  assert.deepEqual(r.events.map((e) => e.event), [], 'back with the same alerts: nothing raised, nothing cleared');
});

test('the unreachable key itself clears when the cluster answers again', () => {
  let r = A.transitions(null, new Set());
  r = A.transitions(r.seen, new Set(['c1:unreachable']), { status: status({ c1: 'down' }) });
  assert.deepEqual(r.events.map((e) => e.event), ['raised']);
  r = A.transitions(r.seen, new Set(), { status: status({ c1: 'up' }) });
  r = A.transitions(r.seen, new Set(), { status: status({ c1: 'up' }) });
  assert.deepEqual(r.events.map((e) => `${e.event} ${e.key}`), ['cleared c1:unreachable']);
});

test('an unknown (rebuilt) cluster clears nothing, however long', () => {
  let r = A.transitions(null, new Set(['c1:disk']));
  for (let i = 0; i < 5; i++) r = A.transitions(r.seen, new Set(), { status: status({ c1: 'unknown' }) });
  assert.deepEqual(r.events, []);
  assert.ok(r.seen.has('c1:disk'));
});

test('a cluster that left the config or scope is forgotten silently', () => {
  let r = A.transitions(null, new Set(['c1:disk', 'c2:disk']));
  r = A.transitions(r.seen, new Set(['c2:disk']), { status: status({ c2: 'up' }) });
  assert.deepEqual(r.events, [], 'no cleared for c1');
  assert.equal(r.seen.has('c1:disk'), false);
});

test('only one tab holds the lease; another takes it once it expires', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  let t = 1000;
  const a = A.createLease({ storage, id: 'a', now: () => t, ttl: 100 });
  const b = A.createLease({ storage, id: 'b', now: () => t, ttl: 100 });
  assert.equal(a.acquire(), true);
  assert.equal(b.acquire(), false, 'a holds it');
  t += 50; assert.equal(a.acquire(), true, 'renewed');
  t += 90; assert.equal(b.acquire(), false, 'still within a\'s renewed lease');
  t += 20; assert.equal(b.acquire(), true, 'a stopped renewing: expired');
  assert.equal(a.acquire(), false);
  b.release();
  assert.equal(a.acquire(), true, 'released');
  assert.equal(A.createLease({ storage: null }).acquire(), true, 'no storage: report');
});

test('a tab without the lease reports nothing but keeps its picture current', async () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  let t = 1_000_000; const sentA = []; const sentB = [];
  const mk2 = (id, sent) => A.createReporter({ now: () => t, send: async (e) => { sent.push(e); return { ok: true, routed: true }; }, lease: A.createLease({ storage, id, now: () => t }) });
  const a = mk2('a', sentA); const b = mk2('b', sentB);
  await a.observe([m(['c1:disk'])]); await b.observe([m(['c1:disk'])]);
  t += 30000;
  await a.observe([m(['c1:disk', 'c1:heap'])]); await b.observe([m(['c1:disk', 'c1:heap'])]);
  assert.equal(sentA.length, 1);
  assert.equal(sentB.length, 0);
  assert.equal(b.queued, 0);
});

test('routed:false (alerts kept built-in) pauses sending', async () => {
  const { rep, sent, tick } = rig({ reply: { ok: true, routed: false } });
  await rep.observe([m(['c1:disk'])]);
  tick(30000);
  await rep.observe([m(['c1:disk', 'c1:heap'])]);
  tick(30000);
  await rep.observe([m(['c1:disk', 'c1:heap', 'c1:health'])]);
  assert.equal(sent.length, 1);
});

test('a reload in the same session compares with the set last seen', async () => {
  const mem = { v: null };
  const store = { get: () => mem.v, set: (a) => { mem.v = a; } };
  const a = rig({ store });
  await a.rep.observe([m(['c1:disk'])]);
  const b = rig({ store });      // "reload"
  await b.rep.observe([m(['c1:disk'])]);
  assert.equal(b.sent.length, 0, 'nothing repeated');
  assert.equal(b.rep.queued, 0);
});

test('a disabled reporter (display link, no user) reports nothing', async () => {
  const { rep, sent } = rig({ enabled: false });
  await rep.observe([m(['c1:disk'])]);
  await rep.observe([m(['c1:disk', 'c1:heap'])]);
  assert.equal(sent.length, 0);
});
