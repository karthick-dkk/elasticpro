/**
 * Acknowledgement retention.
 *
 * The behaviour under test is a deletion, so every case here is about something NOT being
 * destroyed. An alert that stops being emitted for a moment — a retuned threshold, a
 * disabled rule, a cluster that missed one refresh — must not cost anyone their triage.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** acks.js talks to lib/idb.js, which wants IndexedDB. A Map is enough for the rules. */
const store = new Map();
globalThis.indexedDB = undefined;

const idbPath = pathToFileURL(path.join(ROOT, 'ui/js/lib/idb.js')).href;
const { default: _ } = { default: null };
// Stub the module the same way the app would see it, by pre-populating the registry.
const acksUrl = pathToFileURL(path.join(ROOT, 'ui/js/core/acks.js')).href;

// idb.js resolves every call through IndexedDB; with none present its promises reject,
// which acks.js already tolerates (`catch (_) {}`). That is exactly the path a browser
// with storage disabled takes, so the rules are exercised on the in-memory cache.
const acks = await import(acksUrl);

const DAY = 86400000;

beforeEach(async () => {
  store.clear();
  await acks.loadAcks();          // starts empty; IndexedDB absent is a supported state
});

test('an alert still being emitted keeps its acknowledgement', async () => {
  await acks.acknowledge('c1:disk', { by: 'kd' });
  assert.equal(acks.isAcked('c1:disk'), true);
  await acks.pruneAcks(['c1:disk']);
  assert.equal(acks.isAcked('c1:disk'), true);
});

test('an alert that stops being emitted is NOT deleted immediately', async () => {
  await acks.acknowledge('c1:disk', { by: 'kd' });
  await acks.pruneAcks([]);                      // threshold retuned; the key is gone
  assert.equal(acks.isAcked('c1:disk'), true, 'a retune must not destroy the acknowledgement');
  assert.ok(acks.ackFor('c1:disk').missingSince > 0, 'absence starts a clock');
});

test('an alert that comes back keeps everything and the clock resets', async () => {
  await acks.acknowledge('c1:disk', { by: 'kd' });
  const firstAckedAt = acks.ackFor('c1:disk').ackedAt;
  await acks.pruneAcks([]);                      // disabled
  await acks.pruneAcks(['c1:disk']);             // re-enabled
  assert.equal(acks.isAcked('c1:disk'), true);
  assert.equal(acks.ackFor('c1:disk').missingSince, 0, 'the clock is cleared on return');
  assert.equal(acks.ackFor('c1:disk').ackedAt, firstAckedAt, 'the original date survives');
});

test('an alert gone longer than the grace period is finally forgotten', async () => {
  await acks.acknowledge('c1:old', { by: 'kd' });
  await acks.pruneAcks([]);                      // starts the clock
  // Wind it back past the grace period.
  const rec = acks.ackFor('c1:old');
  rec.missingSince = Date.now() - (acks.ACK_GRACE_DAYS + 1) * DAY;
  await acks.pruneAcks([]);
  assert.equal(acks.isAcked('c1:old'), false, 'long-gone acknowledgements do get cleaned up');
});

test('a record with a note is never removed, however long it has been gone', async () => {
  await acks.acknowledge('c1:noted', { by: 'kd' });
  await acks.addNote('c1:noted', 'raised with the network team', 'kd');
  await acks.pruneAcks([]);
  const rec = acks.ackFor('c1:noted');
  rec.missingSince = Date.now() - 10 * 365 * DAY;
  await acks.pruneAcks([]);
  assert.equal(acks.noteCount('c1:noted'), 1, 'somebody wrote that — it stays');
});

test('the grace period is long enough to cover an ordinary outage', () => {
  assert.ok(acks.ACK_GRACE_DAYS >= 7,
    'a grace period shorter than a week would lose acks over a long weekend');
});
