#!/usr/bin/env node
/**
 * Put log data into a real cluster, shaped so every branch of this app has something to
 * show.
 *
 *   ES_URL=http://host:9200 ES_USER=elastic ES_PASS=… node tools/seed-test-logs.mjs
 *   …                                                  node tools/seed-test-logs.mjs --dry-run
 *   …                                                  node tools/seed-test-logs.mjs --delete
 *
 * The mock cluster covers the code paths; this covers the ones only a real cluster has —
 * actual mappings, actual aggregations, actual index names being parsed for their day.
 * A cluster with no `ingested_time` mapped cannot exercise the delay engine at all, and
 * that is the state a fresh Filebeat estate is in, which is why "it works against the
 * fixture" and "it works here" keep diverging.
 *
 * Everything it writes is namespaced and removable with one wildcard. It creates
 * indices; it never touches one it did not create.
 *
 * The devices mirror tools/mock-es.mjs on purpose. If a device reads DELAYED here and OK
 * in the fixture, one of them is lying, and it is worth being able to tell which.
 */

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);

const URL_BASE = (process.env.ES_URL || 'http://localhost:9200').replace(/\/+$/, '');
const USER = process.env.ES_USER || '';
const PASS = process.env.ES_PASS || '';
const APIKEY = process.env.ES_APIKEY || '';
const PREFIX = arg('--prefix', 'logstash-elasticprotest');
const DAYS = Number(arg('--days', '7')) || 7;
const PER_DEVICE_PER_DAY = Number(arg('--per-day', '40')) || 40;
const DRY = has('--dry-run');

if (!APIKEY && !(USER && PASS)) {
  console.error('Set ES_USER and ES_PASS, or ES_APIKEY. This writes to a real cluster and will not guess.');
  process.exit(2);
}

const auth = APIKEY
  ? `ApiKey ${APIKEY}`
  : `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

async function es(method, path, body, contentType = 'application/json') {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { authorization: auth, 'content-type': contentType },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* _cat returns text */ }
  if (!res.ok) {
    const reason = (json && json.error && (json.error.reason || json.error.type)) || text.slice(0, 200);
    throw new Error(`${method} ${path} → ${res.status}: ${reason}`);
  }
  return json ?? text;
}

/**
 * The devices, and how far behind each one runs.
 *
 * Chosen to produce every state the classifier can reach, including the two that are
 * easy to get wrong: a negative delay (the device's clock is ahead of the collector) and
 * a delay sitting exactly on a whole hour, which is what a timezone misconfiguration
 * looks like and must not be reported as a queue.
 */
const DEVICES = [
  { host: 'fw-edge-01', delayMin: 2, tag: 'acme', branch: 'HQ', type: 'firewall', expect: 'ok' },
  { host: 'fw-core-02', delayMin: 41, tag: 'acme', branch: 'HQ', type: 'firewall', expect: 'delayed' },
  { host: 'proxy-03', delayMin: 95, tag: 'acme', branch: 'HQ', type: 'proxy', expect: 'critical' },
  { host: 'vpn-04', delayMin: -37, tag: 'beta', branch: 'DR', type: 'vpn', expect: 'clock ahead' },
  { host: 'switch-05', delayMin: 330, tag: 'beta', branch: 'DR', type: 'syslog', expect: 'critical, not a timezone' },
  { host: 'router-06', delayMin: 300, tag: 'beta', branch: 'DR', type: 'syslog', expect: 'critical, timezone shape' },
  // No event time at all. The engine must report this as unmeasurable rather than as a
  // delay of zero, and there is no way to check that without a device like this.
  { host: 'silent-07', delayMin: null, tag: 'acme', branch: 'HQ', type: 'syslog', expect: 'unknown — no event time' },
];

/**
 * The mapping the delay engine actually needs.
 *
 * `src_hostname` is text with a keyword subfield, because the engine aggregates on
 * `src_hostname.keyword` — mapping it as a plain keyword would mean that field does not
 * exist and the preflight would correctly refuse to run. `ClientID` and `src_ip` are the
 * opposite case: the engine uses them unsuffixed, so they are keyword and ip directly.
 */
const MAPPING = {
  mappings: {
    properties: {
      '@timestamp': { type: 'date' },
      ingested_time: { type: 'date' },
      event_created: { type: 'date' },
      src_hostname: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
      src_ip: { type: 'ip' },
      ClientID: { type: 'keyword' },
      tag1: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
      branch: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
      log_type: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
      parser_tag: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
      fwdtag: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
      message: { type: 'text' },
    },
  },
  settings: { number_of_shards: 1, number_of_replicas: 0 },
};

const pad = (n) => String(n).padStart(2, '0');
const indexFor = (d) => `${PREFIX}-${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;

async function remove() {
  const pattern = `${PREFIX}-*`;
  const existing = await es('GET', `/_cat/indices/${encodeURIComponent(pattern)}?h=index&format=json&ignore_unavailable=true`)
    .catch(() => []);
  const names = (Array.isArray(existing) ? existing : []).map((r) => r.index);
  if (!names.length) { console.log(`Nothing to remove: no index matches ${pattern}`); return; }
  console.log(`Removing ${names.length} index/indices:`);
  for (const n of names) console.log(`  ${n}`);
  if (DRY) { console.log('(--dry-run, nothing deleted)'); return; }
  await es('DELETE', `/${encodeURIComponent(pattern)}`);
  console.log('Removed.');
}

async function seed() {
  const now = Date.now();
  console.log(`Seeding ${URL_BASE}`);
  console.log(`  ${DAYS} day(s) · ${DEVICES.length} devices · ${PER_DEVICE_PER_DAY} docs each per day`);
  console.log(`  indices: ${PREFIX}-YYYY.MM.DD  (remove with: --delete)`);
  if (DRY) console.log('  --dry-run: nothing will be written\n');

  let totalDocs = 0;
  for (let back = DAYS - 1; back >= 0; back -= 1) {
    const day = new Date(now - back * 86400000);
    const index = indexFor(day);

    if (!DRY) {
      // Create explicitly rather than relying on dynamic mapping: the whole point is that
      // the fields exist with the right types, and a dynamically mapped date arriving as
      // a string is exactly the mismatch this is meant to rule out.
      const exists = await fetch(`${URL_BASE}/${index}`, { method: 'HEAD', headers: { authorization: auth } });
      if (exists.status === 404) await es('PUT', `/${index}`, JSON.stringify(MAPPING));
    }

    const lines = [];
    for (const dev of DEVICES) {
      for (let i = 0; i < PER_DEVICE_PER_DAY; i += 1) {
        // Spread arrivals across the day so the histogram has a shape.
        const arrival = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(),
          Math.floor((i / PER_DEVICE_PER_DAY) * 24), (i * 7) % 60, (i * 13) % 60);
        // The newest document of each device carries the exact delay; the rest wobble a
        // little, deterministically, so a re-run produces the same figures.
        const wobble = i === PER_DEVICE_PER_DAY - 1 ? 0 : ((i * 7) % 5) - 2;
        const doc = {
          '@timestamp': new Date(arrival).toISOString(),
          src_hostname: dev.host,
          src_ip: `10.0.0.${DEVICES.indexOf(dev) + 1}`,
          tag1: dev.tag,
          ClientID: dev.tag.toUpperCase(),
          branch: dev.branch,
          log_type: dev.type,
          parser_tag: `parse-${dev.type}`,
          fwdtag: `fwd-${dev.tag}`,
          message: `${dev.type} event ${i} from ${dev.host}`,
        };
        if (dev.delayMin !== null) {
          const event = arrival - (dev.delayMin + wobble) * 60000;
          doc.ingested_time = new Date(event).toISOString();
          doc.event_created = new Date(event).toISOString();
        }
        lines.push(JSON.stringify({ index: { _index: index } }));
        lines.push(JSON.stringify(doc));
      }
    }

    if (!DRY) {
      const res = await es('POST', '/_bulk', `${lines.join('\n')}\n`, 'application/x-ndjson');
      if (res.errors) {
        const first = (res.items || []).find((it) => it.index && it.index.error);
        throw new Error(`bulk into ${index} had errors: ${JSON.stringify(first && first.index.error).slice(0, 200)}`);
      }
    }
    totalDocs += lines.length / 2;
    console.log(`  ${index}  ${lines.length / 2} docs`);
  }

  if (!DRY) await es('POST', `/${PREFIX}-*/_refresh`);
  console.log(`\n${DRY ? 'Would write' : 'Wrote'} ${totalDocs} documents.`);
  console.log('\nWhat each device should read as on the Log delay page:');
  for (const d of DEVICES) {
    console.log(`  ${d.host.padEnd(12)} ${String(d.delayMin === null ? '—' : `${d.delayMin} min`).padStart(8)}  ${d.expect}`);
  }
  console.log(`\nRemove it all:  node tools/seed-test-logs.mjs --delete`);
}

try {
  if (has('--delete')) await remove();
  else await seed();
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
}
