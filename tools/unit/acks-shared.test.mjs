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

test('a long-gone record without notes is cleared on the server', async () => {
  await acks.acknowledge('c2:gone', {});
  await acks.pruneAcks([]);
  const rec = acks.ackFor('c2:gone');
  assert.ok(rec.missingSince > 0);
  assert.ok(server.get('c2:gone').record.missingSince > 0, 'the clock is kept where everybody sees it');
  rec.missingSince = Date.now() - (acks.ACK_GRACE_DAYS + 1) * 86400000;
  await acks.pruneAcks([]);
  assert.equal(server.has('c2:gone'), false);
  assert.ok(sent.includes('ACK_CLEAR'));
});
