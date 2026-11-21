/**
 * Shared acknowledgements on the hosted server (0.3.47, docs/PLAY.md): acks.js keeps them
 * through ACK_LIST / ACK_SET / ACK_CLEAR when WHOAMI says the edition is hosted, with the same
 * keys and the same exports, and takes the server's word for who acknowledged and when.
 * The desktop path (IndexedDB) is acks.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** A hosted core in miniature: WHOAMI, and the three ACK messages over a Map. */
const server = new Map();
const sent = [];
/** Set to a reply to make the next ACK_SETs fail with it (a refusal, an unreachable core). */
let failSet = null;
globalThis.fetch = async (url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg.type);
  let out;
  if (msg.type === 'ACK_SET' && failSet) {
    out = failSet;
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(out) };
  }
  switch (msg.type) {
    case 'WHOAMI': out = { ok: true, edition: 'hosted' }; break;
    case 'ACK_LIST': out = { ok: true, acks: Object.fromEntries(server) }; break;
    case 'ACK_SET': {
      const record = { ...msg.record, ackedBy: msg.record.acked === false ? '' : 'server-says-kd' };
      const ack = { by: 'server-says-kd', at: 42, record };
      server.set(msg.key, ack);
      out = { ok: true, key: msg.key, ack };
      break;
    }
    case 'ACK_CLEAR': server.delete(msg.key); out = { ok: true, key: msg.key }; break;
    default: out = { ok: false, kind: 'bad_message', message: `Unknown message type ${msg.type}` };
  }
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(out) };
};

const acks = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/acks.js')).href);

test('on the hosted server an acknowledgement goes to the core and comes back stamped', async () => {
  server.set('c1:old', { by: 'ann', at: 7, note: 'set by a script' });
  await acks.loadAcks();
  assert.equal(sent[0], 'WHOAMI');
  assert.ok(sent.includes('ACK_LIST'));
  assert.equal(acks.isAcked('c1:old'), true, 'an entry with no record is an acknowledgement');
  assert.equal(acks.ackFor('c1:old').ackedBy, 'ann');
  assert.equal(acks.noteCount('c1:old'), 1, 'its note is shown as one');

  const rec = await acks.acknowledge('c1:disk', { by: 'typed-name', note: 'vendor called' });
  assert.equal(rec.ackedBy, 'server-says-kd', 'the server says who, not the page');
  assert.equal(acks.ackFor('c1:disk').ackedBy, 'server-says-kd');
  assert.equal(server.get('c1:disk').record.notes[0].text, 'vendor called');
  assert.equal(server.get('c1:disk').record.key, undefined, 'the key travels once, beside the record');

  await acks.unacknowledge('c1:disk');
  assert.equal(acks.isAcked('c1:disk'), false);
  assert.equal(acks.noteCount('c1:disk'), 1, 'notes are kept when the acknowledgement goes');
});

test('pruning never rewrites a shared record: it clears one only when its cluster is gone and the fleet has answered', async () => {
  server.set('c2:disk', { by: 'ann', at: 7, record: { acked: true, ackedBy: 'ann', ackedAt: 7, notes: [] } });
  server.set('c3:health', { by: 'bo', at: 8, record: { acked: true, ackedBy: 'bo', ackedAt: 8, notes: [] } });
  await acks.loadAcks();
  sent.length = 0;
  // A partial list of live alerts (a fleet still loading): nothing is written, nobody re-acknowledges.
  await acks.pruneAcks([], { clusterIds: ['c2', 'c3'], complete: false });
  await acks.pruneAcks([]);
  await acks.pruneAcks([], { clusterIds: ['c2', 'c3'], complete: true });
  assert.ok(!sent.includes('ACK_SET'), `a prune wrote a shared record: ${sent.join(', ')}`);
  assert.equal(server.get('c2:disk').by, 'ann', 'still acknowledged by the person who did');
  assert.ok(!sent.includes('ACK_CLEAR'), 'the clusters still exist');
  // c3 is gone from the fleet, and every cluster has answered: its record goes.
  await acks.pruneAcks([], { clusterIds: ['c2'], complete: true });
  assert.equal(server.has('c3:health'), false);
  assert.equal(server.has('c2:disk'), true);
  assert.equal(acks.ackClusterOf('prod:eu:disk', ['prod', 'prod:eu']), 'prod:eu', 'the longest id wins');
});

test('an acknowledgement or a note the server did not take is marked not saved, kept, and retried', async () => {
  failSet = { ok: false, kind: 'worker_error', message: 'ElasticPro server did not answer: offline' };
  const rec = await acks.acknowledge('c9:heap', { by: 'x' });
  assert.match(rec.unsaved, /did not answer/, 'the record says it is not saved');
  assert.match(acks.unsavedReason('c9:heap'), /did not answer/);
  assert.equal(server.has('c9:heap'), false);
  const n = await acks.addNote('c9:heap', 'ticket 77');
  assert.ok(n.unsaved, 'a note that failed is not saved either');
  // A reload of the server's list keeps it shown (marked) rather than losing the note.
  await acks.loadAcks();
  assert.ok(acks.unsavedReason('c9:heap'));
  assert.equal(acks.noteCount('c9:heap'), 1);
  // Retry, with the server back: saved, the mark gone, and the mark itself never sent.
  failSet = null;
  const kept = await acks.retrySave('c9:heap');
  assert.equal(kept.unsaved, undefined);
  assert.equal(acks.unsavedReason('c9:heap'), '');
  assert.equal(server.get('c9:heap').record.unsaved, undefined, 'the mark is not stored');
  assert.equal(server.get('c9:heap').record.notes[0].text, 'ticket 77');
});

test('Retry merges with the server copy: others\' notes are kept, the unsaved note is added once, a newer ack wins', async () => {
  // This browser's acknowledgement and note fail to save.
  failSet = { ok: false, kind: 'worker_error', message: 'offline' };
  const before = Date.now();
  await acks.acknowledge('c7:disk', { by: 'me', note: 'mine, unsaved' });
  assert.ok(acks.unsavedReason('c7:disk'));
  // Meanwhile someone else acknowledges on the server, later than the attempt, with a note of their own.
  server.set('c7:disk', { by: 'ann', at: before + 60000, record: { acked: true, ackedBy: 'ann', ackedAt: before + 60000, notes: [{ text: 'ann: vendor on it', by: 'ann', ts: 5 }] } });
  failSet = null;
  sent.length = 0;
  const kept = await acks.retrySave('c7:disk');
  assert.ok(sent.indexOf('ACK_LIST') >= 0 && sent.indexOf('ACK_LIST') < sent.indexOf('ACK_SET'), `Retry re-reads the server first: ${sent.join(', ')}`);
  const notes = server.get('c7:disk').record.notes.map((n) => n.text);
  assert.deepEqual(notes, ['ann: vendor on it', 'mine, unsaved'], 'the server\'s notes, then the unsaved one');
  assert.equal(server.get('c7:disk').record.ackedAt, before + 60000, 'the newer acknowledgement on the server stands');
  assert.match(kept.dropped, /ann acknowledged it on the server after your attempt/);
  assert.equal(server.get('c7:disk').record.dropped, undefined, 'the message is not stored');
  assert.equal(server.get('c7:disk').record.attemptAt, undefined, 'nor the attempt time');
});

test('mergeForRetry: no duplicate notes; this browser\'s ack wins over an older one; no server record', () => {
  const n1 = { text: 'a', by: 'x', ts: 1 }; const n2 = { text: 'b', by: 'me', ts: 9 };
  const local = { key: 'k', acked: true, ackedAt: 100, ackedBy: 'me', notes: [n1, n2], missingSince: 0, unsaved: 'offline', attemptAt: 100 };
  const older = { key: 'k', acked: true, ackedAt: 50, ackedBy: 'ann', notes: [n1], missingSince: 0 };
  const m = acks.mergeForRetry(local, older);
  assert.deepEqual(m.rec.notes, [n1, n2], 'a note the server already has is not added twice');
  assert.deepEqual([m.rec.ackedBy, m.rec.ackedAt, m.dropped], ['me', 100, ''], 'the server\'s older ack gives way');
  assert.equal(m.rec.unsaved, undefined);
  const none = acks.mergeForRetry(local, null);
  assert.deepEqual([none.rec.acked, none.rec.notes.length, none.dropped], [true, 2, '']);
  const unack = acks.mergeForRetry({ ...local, acked: false, ackedAt: 0, ackedBy: '' }, { ...older, ackedAt: 200 });
  assert.equal(unack.rec.acked, true, 'an un-acknowledge tried before a newer ack does not undo it');
  assert.ok(unack.dropped);
});
