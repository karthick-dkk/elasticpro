/**
 * What gets written back to the repository-size cache, and what does not.
 *
 * The cache (lib/idb.js's repoSizeCache, backing measureRepoBytes in core/volume.js) exists
 * so a snapshot's bytes are only ever asked for once — but only once it has actually
 * finished. Writing an IN_PROGRESS snapshot's bytes to disk would freeze a number that is
 * still moving; re-writing an entry that was already on disk is harmless but pointless.
 * persistableEntries is where both of those are decided, separated from the IndexedDB
 * plumbing so the decision itself can be asserted on directly, with no browser needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { persistableEntries } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/idb.js')).href);
const { snapshotStatusByKey } = await import(pathToFileURL(path.join(ROOT, 'ui/js/pages/common.js')).href);

test('a snapshot never seen before is written', () => {
  const map = new Map([['repo1/snap-1', 12345]]);
  const writes = persistableEntries(map, new Set(), () => 'SUCCESS');
  assert.deepEqual(writes, [{ repoSnap: 'repo1/snap-1', bytes: 12345 }]);
});

test('an entry that came from disk this run is not written back', () => {
  const map = new Map([['repo1/snap-1', 12345]]);
  const writes = persistableEntries(map, new Set(['repo1/snap-1']), () => 'SUCCESS');
  assert.deepEqual(writes, []);
});

test('an IN_PROGRESS snapshot is never persisted, however new', () => {
  const map = new Map([['repo1/snap-2', 999]]);
  const writes = persistableEntries(map, new Set(), () => 'IN_PROGRESS');
  assert.deepEqual(writes, [], 'a still-running snapshot would freeze a size that keeps changing');
});

test('a FAILED or PARTIAL snapshot is persisted — its size is final even if it did not succeed', () => {
  const map = new Map([['r/failed-1', 10], ['r/partial-1', 20]]);
  const statusOf = (id) => (id === 'r/failed-1' ? 'FAILED' : 'PARTIAL');
  const writes = persistableEntries(map, new Set(), statusOf);
  assert.deepEqual(writes.sort((a, b) => a.repoSnap.localeCompare(b.repoSnap)), [
    { repoSnap: 'r/failed-1', bytes: 10 },
    { repoSnap: 'r/partial-1', bytes: 20 },
  ]);
});

test('a mix: only the new, finished entries are written', () => {
  const map = new Map([
    ['repo1/old', 1],       // already on disk
    ['repo1/running', 2],   // new, but still going
    ['repo1/new', 3],       // new and finished
  ]);
  const loaded = new Set(['repo1/old']);
  const statusOf = (id) => (id === 'repo1/running' ? 'IN_PROGRESS' : 'SUCCESS');
  const writes = persistableEntries(map, loaded, statusOf);
  assert.deepEqual(writes, [{ repoSnap: 'repo1/new', bytes: 3 }]);
});

test('no statusOf function at all means everything new is persisted', () => {
  // measureRepoBytes callers always pass one in practice, but the gate must not throw
  // if a caller genuinely has no way to answer — that is "assume it is done", not a crash.
  const map = new Map([['repo1/x', 5]]);
  const writes = persistableEntries(map, new Set());
  assert.deepEqual(writes, [{ repoSnap: 'repo1/x', bytes: 5 }]);
});

test('an empty cache writes nothing', () => {
  assert.deepEqual(persistableEntries(new Map(), new Set(), () => 'SUCCESS'), []);
});

/**
 * snapshotStatusByKey (pages/common.js) is the other half of the gate: it answers the
 * "is this one done?" question from the cache key alone, so both pages that measure
 * repository size (Clusters and Volume report) ask it the same way.
 */
test('snapshotStatusByKey finds the status of the named snapshot in its repo', () => {
  const data = { snapshots: { myrepo: [{ id: 'snap-1', status: 'SUCCESS' }, { id: 'snap-2', status: 'in_progress' }] } };
  assert.equal(snapshotStatusByKey(data, 'myrepo/snap-1'), 'SUCCESS');
  assert.equal(snapshotStatusByKey(data, 'myrepo/snap-2'), 'IN_PROGRESS', 'should be upper-cased for a caller comparing to IN_PROGRESS');
});

test('snapshotStatusByKey answers empty rather than throwing when it cannot tell', () => {
  assert.equal(snapshotStatusByKey({ snapshots: {} }, 'myrepo/snap-1'), '');
  assert.equal(snapshotStatusByKey({ snapshots: { myrepo: [] } }, 'myrepo/missing'), '');
  assert.equal(snapshotStatusByKey({}, 'myrepo/snap-1'), '');
  assert.equal(snapshotStatusByKey({ snapshots: { myrepo: [{ id: 'snap-1', status: 'SUCCESS' }] } }, 'not-a-key'), '');
});
