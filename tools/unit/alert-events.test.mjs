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

test('too_many stops the reporter for good', async () => {
  const { rep, sent, tick } = rig({ reply: { ok: false, kind: 'too_many' } });
  await rep.observe([m(['c1:disk'])]);
  tick(30000);
  await rep.observe([m(['c1:disk', 'c1:heap'])]);
  assert.equal(rep.stopped, true);
  tick(60000);
  await rep.observe([m(['c1:disk'])]);
  assert.equal(sent.length, 1);
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
