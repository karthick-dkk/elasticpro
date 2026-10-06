/**
 * The bounded fan-out.
 *
 * Every case here is about restraint or honesty: how many requests are in flight at
 * once, and whether the caller can tell what was never asked. A fan-out that quietly
 * returns four results for nine clusters is the bug this module exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { runBounded, cancellation, partialNote } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/fleet.js')).href);

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('every item runs, and the answers carry their item', async () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const { results, skipped, cancelled } = await runBounded(items, async (x) => x.toUpperCase(), { limit: 2 });
  assert.equal(results.length, 5);
  assert.equal(skipped.length, 0);
  assert.equal(cancelled, false);
  assert.deepEqual(results.map((r) => r.value).sort(), ['A', 'B', 'C', 'D', 'E']);
  for (const r of results) assert.equal(r.value, r.item.toUpperCase());
});

test('never more than the limit are in flight', async () => {
  let live = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await runBounded(items, async () => {
    live += 1; peak = Math.max(peak, live);
    await tick(5);
    live -= 1;
  }, { limit: 3 });
  assert.equal(peak, 3, `peak concurrency was ${peak}, expected 3`);
});

test('a limit larger than the work does not spin up idle workers', async () => {
  let starts = 0;
  const { results } = await runBounded(['only'], async () => { starts += 1; }, { limit: 8 });
  assert.equal(starts, 1);
  assert.equal(results.length, 1);
});

test('one failure does not cost the others', async () => {
  const { results } = await runBounded([1, 2, 3], async (n) => {
    if (n === 2) throw new Error('cluster 2 is unreachable');
    return n * 10;
  }, { limit: 3 });
  const failed = results.filter((r) => r.error);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error.message, /unreachable/);
  assert.deepEqual(results.filter((r) => !r.error).map((r) => r.value).sort(), [10, 30]);
});

test('cancelling stops launching, and says exactly what was never asked', async () => {
  const token = cancellation();
  const seen = [];
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await runBounded(items, async (n) => {
    seen.push(n);
    await tick(5);
    if (n === 1) token.cancel();
    return n;
  }, { limit: 2, token });

  assert.equal(out.cancelled, true);
  assert.ok(seen.length < 10, `cancelling launched ${seen.length} of 10 anyway`);
  // The arithmetic the UI depends on: answered + never-asked accounts for every cluster.
  assert.equal(out.results.length + out.skipped.length, 10);
  assert.ok(out.skipped.length > 0, 'a cancelled run reported nothing as skipped');
  for (const s of out.skipped) assert.ok(!seen.includes(s.item), `${s.item} was reported skipped but ran`);
});

test('work already in flight when the stop lands is still reported', async () => {
  const token = cancellation();
  // 0 and 1 are both in flight before the cancel fires, so both were paid for and both
  // are answers. 2 was never launched, and must be named rather than silently missing.
  const out = await runBounded([0, 1, 2], async (n) => {
    await tick(2);
    if (n === 0) token.cancel();
    return n;
  }, { limit: 2, token });
  assert.equal(out.results.length, 2, 'an answer that had already arrived was thrown away');
  assert.deepEqual(out.skipped.map((s) => s.item), [2]);
  assert.equal(out.cancelled, true);
});

test('progress is reported as answers land, not at the end', async () => {
  const at = [];
  await runBounded([1, 2, 3, 4], async (n) => { await tick(n); return n; },
    { limit: 2, onSettled: (s, p) => at.push(p.done) });
  assert.deepEqual(at, [1, 2, 3, 4], 'the page was not told until the end');
});

test('a listener that throws does not stop the fan-out', async () => {
  const { results } = await runBounded([1, 2, 3], async (n) => n,
    { limit: 2, onSettled: () => { throw new Error('a page bug'); } });
  assert.equal(results.length, 3);
});

test('an empty fleet is not an error', async () => {
  const out = await runBounded([], async () => 1, { limit: 4 });
  assert.deepEqual(out, { results: [], skipped: [], cancelled: false });
});

test('a complete run has nothing to warn about', () => {
  assert.equal(partialNote({ total: 5, ok: 5, failed: 0, skipped: 0, cancelled: false }), null);
});

test('a partial run names the denominator', () => {
  const note = partialNote({ total: 9, ok: 6, failed: 1, skipped: 2, cancelled: true });
  assert.match(note, /6 of 9/);
  assert.match(note, /1 could not be reached/);
  assert.match(note, /2 never asked \(stopped\)/);
  assert.match(note, /only the ones that answered/);
});
