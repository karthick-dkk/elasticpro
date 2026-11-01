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
globalThis.fetch = async (url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg.type);
  let out;
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
