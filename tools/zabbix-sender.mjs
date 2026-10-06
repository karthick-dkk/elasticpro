/**
 * The Zabbix sender protocol, which is all `zabbix_sender` does: one TCP connection to the
 * server's trapper port (10051), a `ZBXD\x01` header, the body length as a little-endian
 * 64-bit integer, and a JSON body. The server answers in the same framing.
 *
 * Written here rather than shelling out so the scraper needs nothing but Node — the
 * container it runs in has no zabbix_sender, and installing an agent package to send a
 * few lines would be the larger dependency by far.
 *
 * Pure framing is exported separately from the socket so it can be tested without a server.
 */
import net from 'node:net';

const MAGIC = Buffer.from('ZBXD\x01', 'latin1');

/** `{host, key, value, clock?}` rows → one framed request. */
export function frame(rows) {
  const body = Buffer.from(JSON.stringify({
    request: 'sender data',
    data: rows.map((r) => ({ host: r.host, key: r.key, value: String(r.value), ...(r.clock ? { clock: r.clock } : {}) })),
  }), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(body.length));
  return Buffer.concat([MAGIC, len, body]);
}

/** A framed reply → its JSON, or throws naming what was wrong with it. */
export function unframe(buf) {
  if (buf.length < 13 || !buf.subarray(0, 4).equals(MAGIC.subarray(0, 4))) {
    throw new Error('not a Zabbix reply (no ZBXD header)');
  }
  const flags = buf[4];
  if (flags & 0x02) throw new Error('compressed replies are not supported');
  const n = Number(buf.readBigUInt64LE(5));
  const body = buf.subarray(13, 13 + n);
  if (body.length < n) throw new Error(`reply truncated: ${body.length} of ${n} bytes`);
  return JSON.parse(body.toString('utf8'));
}

/**
 * `processed: 3; failed: 1; total: 4; seconds spent: 0.000055` → numbers. `failed` is the
 * one that matters: it counts values for items that do not exist yet or have the wrong
 * type, which the server accepts silently otherwise.
 */
export function parseInfo(info) {
  const out = {};
  for (const m of String(info || '').matchAll(/(processed|failed|total):\s*(\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

/** Send, and resolve with `{response, processed, failed, total}`. */
export function send(hostPort, rows, { timeoutMs = 10000 } = {}) {
  const [host, port] = String(hostPort).split(':');
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: Number(port) || 10051 });
    const chunks = [];
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error(`no reply from ${hostPort} in ${timeoutMs} ms`)); });
    sock.on('connect', () => sock.end(frame(rows)));
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('close', () => {
      if (!chunks.length) return;
      try {
        const r = unframe(Buffer.concat(chunks));
        resolve({ response: r.response, ...parseInfo(r.info), info: r.info });
      } catch (e) { reject(e); }
    });
  });
}
