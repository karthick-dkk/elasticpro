/**
 * The sender protocol, byte for byte. Getting the header wrong fails silently in the worst
 * way: the server drops the connection and the scraper reports nothing sent, which looks
 * like every client having no data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const z = await import(pathToFileURL(path.join(ROOT, 'tools/zabbix-sender.mjs')).href);

test('a request is ZBXD, flags 1, a little-endian length, then the JSON', () => {
  const b = z.frame([{ host: 'h', key: 'k', value: 1.5 }]);
  assert.equal(b.subarray(0, 5).toString('latin1'), 'ZBXD\x01');
  const n = Number(b.readBigUInt64LE(5));
  assert.equal(n, b.length - 13);
  const body = JSON.parse(b.subarray(13).toString('utf8'));
  assert.deepEqual(body, { request: 'sender data', data: [{ host: 'h', key: 'k', value: '1.5' }] });
});

test('the length counts bytes, not characters', () => {
  // A client name with a non-ASCII character is several bytes; counting characters
  // truncates the body and the server rejects the whole batch.
  const b = z.frame([{ host: 'h', key: 'k', value: 'Zürich — Nord' }]);
  assert.equal(Number(b.readBigUInt64LE(5)), b.length - 13);
  assert.match(JSON.parse(b.subarray(13).toString('utf8')).data[0].value, /Zürich/);
});

test('a reply is read back, and its counts parsed', () => {
  const reply = z.frame([]);            // same framing both ways
  const body = Buffer.from(JSON.stringify({ response: 'success', info: 'processed: 3; failed: 1; total: 4; seconds spent: 0.000055' }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(body.length));
  const r = z.unframe(Buffer.concat([reply.subarray(0, 5), len, body]));
  assert.equal(r.response, 'success');
  assert.deepEqual(z.parseInfo(r.info), { processed: 3, failed: 1, total: 4 });
});

test('garbage is refused rather than parsed', () => {
  assert.throws(() => z.unframe(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')), /ZBXD/);
});

test('send talks the protocol to a server and reports what it said', async () => {
  let got = null;
  const srv = net.createServer((s) => {
    const chunks = [];
    s.on('data', (c) => chunks.push(c));
    s.on('end', () => {
      got = z.unframe(Buffer.concat(chunks));
      const body = Buffer.from(JSON.stringify({ response: 'success', info: 'processed: 2; failed: 0; total: 2; seconds spent: 0.0001' }));
      const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(body.length));
      s.end(Buffer.concat([Buffer.from('ZBXD\x01', 'latin1'), len, body]));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await z.send(`127.0.0.1:${srv.address().port}`, [
    { host: 'ep', key: 'elasticpro.plan[vm-1,volume.day]', value: 12.5 },
    { host: 'ep', key: 'elasticpro.plan[vm-1,live.from]', value: '2026-09-01' },
  ]);
  srv.close();
  assert.equal(res.processed, 2);
  assert.equal(res.failed, 0);
  assert.equal(got.request, 'sender data');
  assert.equal(got.data.length, 2);
  assert.equal(got.data[1].value, '2026-09-01');
});
