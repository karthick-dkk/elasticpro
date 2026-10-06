#!/usr/bin/env node
/**
 * A stand-in Elasticsearch, just complete enough for every page to render with data.
 *
 * `render-check.mjs` against an empty config only ever draws "No cluster selected", which
 * exercises almost nothing. Pointing it at this instead makes the pages walk their real
 * paths — tables, charts, coverage strips, snapshot lists — which is where render bugs are.
 *
 *   node tools/mock-es.mjs [port]        # default 9299
 *
 * Read-only fixture: any write returns {"acknowledged": true} without changing anything.
 */

import http from 'node:http';

const port = Number(process.argv[2]) || 9299;
const bind = process.env.MOCK_BIND || '127.0.0.1';
const DAY = 86400000;

const index = (name, size, status = 'open', health = 'green') => ({
  index: name, health, status, uuid: name, pri: '1', rep: '1',
  'docs.count': '1000', 'docs.deleted': '12',
  'store.size': String(size), 'pri.store.size': String(Math.round(size / 2)),
  'creation.date': String(Date.now() - DAY),
});

const INDICES = [
  index('logstash-acme-2026.09.09', 5e9),
  index('logstash-acme-2026.09.08', 4e9),
  index('logstash-acme-2026.09.07', 4.2e9, 'close'),
  index('logstash-beta-2026.09.09', 2e9, 'open', 'yellow'),
  index('metrics-2026.09', 9e8),
];

// Enough snapshots that the snapshot list has more than one page to move through.
const SNAPSHOTS = Array.from({ length: 23 }, (_, i) => {
  const start = Math.floor((Date.now() - i * DAY) / 1000);
  return {
    id: `daily-${new Date((start * 1000)).toISOString().slice(0, 10).replace(/-/g, '.')}-${i}`,
    status: i === 3 ? 'PARTIAL' : 'SUCCESS',
    start_epoch: String(start), end_epoch: String(start + 300), duration: '5m',
    indices: '5', successful_shards: '10', failed_shards: i === 3 ? '1' : '0', total_shards: '10',
  };
});

/**
 * The fixture's devices: one per status the classifier can produce, including the two
 * that are easy to get wrong — a negative delay (the device's clock is ahead) and a
 * delay sitting exactly on a whole hour, which is what a timezone misconfiguration
 * looks like.
 *
 * [device, delayMinutes, logType, tag]
 */
const DEVICES = [
  ['fw-edge-01',     2,    'firewall', 'acme'],
  ['fw-core-02',     41,   'firewall', 'acme'],
  ['proxy-03',       95,   'proxy',    'acme'],
  ['vpn-04',         -37,  'vpn',      'beta'],
  ['switch-05',      330,  'syslog',   'beta'],   // 5h30 — not a whole hour
  ['router-06',      300,  'syslog',   'beta'],   // exactly 5h — timezone shape
];

/**
 * The field/value pairs a single-device query is looking for, or null if this is not
 * one.
 *
 * The field matters. A real cluster searching `src_ip` for a hostname finds nothing, so
 * a fixture that matches on the value alone would let a page look a device up in the
 * wrong field and still look correct here — which is the class of bug this fixture has
 * had before.
 */
function termClauses(body) {
  const must = (((body.query || {}).bool || {}).must) || [];
  const out = [];
  for (const m of must) {
    for (const c of ((m.bool || {}).should) || []) {
      const [field, value] = Object.entries(c.term || {})[0] || [];
      if (typeof value === 'string' && value) out.push({ field: String(field).replace(/\.keyword$/, ''), value });
    }
  }
  return out.length ? out : null;
}

/**
 * A `_cat` answer carries only the columns that were asked for.
 *
 * The fixture used to hand back every field it knew regardless of `h=`, which let a page
 * read a column it had never requested and still look correct here. A real cluster
 * returns the projection, so this does too.
 */
function catProject(url, rows) {
  const q = url.split('?')[1] || '';
  const h = new URLSearchParams(q).get('h');
  if (!h) return rows;
  const want = h.split(',').map((x) => x.trim()).filter(Boolean);
  return rows.map((r) => Object.fromEntries(want.filter((k) => k in r).map((k) => [k, r[k]])));
}

const routes = [
  [(u) => u === '/', () => ({ cluster_name: 'mock', cluster_uuid: 'mock-uuid',
    version: { number: '8.13.4', lucene_version: '9.10.0' } })],
  [(u) => u.startsWith('/_cluster/health'), () => ({ status: 'yellow', number_of_nodes: 3,
    number_of_data_nodes: 3, active_shards: 40, active_primary_shards: 20, unassigned_shards: 2,
    relocating_shards: 0, initializing_shards: 0, delayed_unassigned_shards: 0, number_of_pending_tasks: 0, number_of_in_flight_fetch: 0,
    task_max_waiting_in_queue_millis: 0, active_shards_percent_as_number: 95 })],
  // Deliberately skewed: node-1 heavy, node-3 nearly idle, so the disk-balance panel
  // has a real case to describe rather than a flat one.
  [(u) => u.startsWith('/_cat/allocation'), () => ([
    { node: 'node-1', shards: '38', 'disk.used': '91000000000', 'disk.avail': '9000000000',
      'disk.total': '100000000000', 'disk.percent': '91', 'disk.indices': '86000000000' },
    { node: 'node-2', shards: '22', 'disk.used': '55000000000', 'disk.avail': '45000000000',
      'disk.total': '100000000000', 'disk.percent': '55', 'disk.indices': '50000000000' },
    { node: 'node-3', shards: '9', 'disk.used': '21000000000', 'disk.avail': '79000000000',
      'disk.total': '100000000000', 'disk.percent': '21', 'disk.indices': '18000000000' },
    { node: 'UNASSIGNED', shards: '2' },
  ])],
  [(u) => u.startsWith('/_cluster/settings'), () => ({
    persistent: {}, transient: {},
    defaults: {
      'cluster.routing.allocation.disk.watermark.low': '85%',
      'cluster.routing.allocation.disk.watermark.high': '90%',
      'cluster.routing.allocation.disk.watermark.flood_stage': '95%',
      'cluster.routing.allocation.enable': 'all',
      'cluster.routing.rebalance.enable': 'all',
      // flip either of these to 'none' to see the "left switched off" path
    },
  })],
  // Must agree with _cat/allocation above and with _cluster/health below: three nodes,
  // all data-bearing, and the same disk figures. They disagreed before — allocation said
  // three nodes at 91/55/21%, nodes said two at 80/70% — so the Nodes page contradicted
  // itself on one screen and every QA run had to re-establish that the fixture, not the
  // app, was wrong.
  [(u) => u.startsWith('/_cat/nodes'), (hit) => catProject(hit.url, [
    { name: 'node-1', ip: '10.0.0.1', version: '8.13.4', jdk: '17.0.9', 'node.role': 'dim', master: '*',
      'heap.percent': '61', 'ram.percent': '70', cpu: '12', load_1m: '1.2',
      'disk.used': '91000000000', 'disk.avail': '9000000000', 'disk.total': '100000000000',
      'disk.used_percent': '91', uptime: '10d' },
    { name: 'node-2', ip: '10.0.0.2', version: '8.13.4', jdk: '17.0.9', 'node.role': 'dim', master: '-',
      'heap.percent': '55', 'ram.percent': '66', cpu: '9', load_1m: '0.8',
      'disk.used': '55000000000', 'disk.avail': '45000000000', 'disk.total': '100000000000',
      'disk.used_percent': '55', uptime: '10d' },
    { name: 'node-3', ip: '10.0.0.3', version: '8.13.4', jdk: '21.0.2', 'node.role': 'dim', master: '-',
      'heap.percent': '38', 'ram.percent': '52', cpu: '4', load_1m: '0.3',
      'disk.used': '21000000000', 'disk.avail': '79000000000', 'disk.total': '100000000000',
      'disk.used_percent': '21', uptime: '10d' }])],
  // _field_caps: the log-delay preflight asks this before it aggregates. Only the names
  // it was asked about AND that this fixture "has" come back — real _field_caps omits
  // what it cannot find rather than returning it empty, and the preflight reads absence
  // from the map, so a fixture that echoed every requested name would make the refusal
  // path untestable.
  [(u) => u.includes('/_field_caps'), ({ url }) => {
    const asked = new URLSearchParams(url.split('?')[1] || '').get('fields') || '';
    const fields = {};
    for (const name of asked.split(',').map((x) => x.trim()).filter(Boolean)) {
      const type = FIELD_TYPES[name];
      if (type) fields[name] = { [type]: { type, searchable: true, aggregatable: type !== 'text' } };
    }
    return { indices: ['logstash-acme-2026.09.09'], fields };
  }],
  [(u) => u.startsWith('/_cat/indices'), () => INDICES],
  [(u) => u.startsWith('/_cat/shards'), () => ([
    { index: 'logstash-acme-2026.09.09', shard: '0', prirep: 'p', state: 'STARTED', node: 'node-1', store: '2500000000' },
    { index: 'logstash-acme-2026.09.09', shard: '0', prirep: 'r', state: 'STARTED', node: 'node-2', store: '2500000000' },
    { index: 'logstash-beta-2026.09.09', shard: '0', prirep: 'r', state: 'UNASSIGNED',
      'unassigned.reason': 'NODE_LEFT', node: null, store: '0' }])],
  [(u) => u.startsWith('/_cat/snapshots'), () => SNAPSHOTS],
  [(u) => u.startsWith('/_cat/aliases'), () => ([{ alias: 'logstash', index: 'logstash-acme-2026.09.09', is_write_index: 'true' }])],
  [(u) => /^\/_snapshot\/[^/]+\//.test(u), () => ({ snapshots: [
    // A good copy of every logstash index — but NOT of metrics-2026.09, which is therefore
    // "not in any snapshot" and must be ticked on purpose before it can be deleted.
    { snapshot: 'daily-1', state: 'SUCCESS',
      indices: INDICES.map((i) => i.index).filter((n) => n.startsWith('logstash-')),
      shards: { total: 10, successful: 10, failed: 0 }, failures: [],
      start_time_in_millis: Date.now() - 3600000, end_time_in_millis: Date.now() - 3300000,
      start_time: new Date(Date.now() - 3600000).toISOString(), end_time: new Date(Date.now() - 3300000).toISOString(),
      duration_in_millis: 300000, version: '8.13.4', include_global_state: false },
    // A PARTIAL snapshot that does list metrics-2026.09 — which must NOT count as a copy.
    { snapshot: 'daily-0', state: 'PARTIAL',
      indices: ['metrics-2026.09', 'logstash-acme-2026.09.09'],
      shards: { total: 10, successful: 8, failed: 2 },
      failures: [{ index: 'metrics-2026.09', shard_id: 0, reason: 'node left' }],
      start_time_in_millis: Date.now() - 90000000, end_time_in_millis: Date.now() - 89700000,
      start_time: new Date(Date.now() - 90000000).toISOString(), end_time: new Date(Date.now() - 89700000).toISOString(),
      duration_in_millis: 300000, version: '8.13.4', include_global_state: false },
  ] })],
  [(u) => u === '/_snapshot' || u.startsWith('/_snapshot?'), () => ({
    daily: { type: 'fs', settings: { location: '/mnt/backups', compress: true } } })],
  [(u) => u.startsWith('/_slm/status'), () => ({ operation_mode: 'RUNNING' })],
  [(u) => u.startsWith('/_slm/stats'), () => ({ retention_runs: 3, retention_failed: 0 })],
  [(u) => u.startsWith('/_slm/policy'), () => ({ nightly: {
    policy: { name: '<daily-{now/d}>', schedule: '0 30 1 * * ?', repository: 'daily',
      config: { indices: ['logstash-*'] }, retention: { expire_after: '30d', min_count: 7, max_count: 60 } },
    last_success: { time: Date.now() - 7200000, snapshot_name: 'daily-1' },
    next_execution_millis: Date.now() + 3600000 } })],
  [(u) => u.startsWith('/_ilm/status'), () => ({ operation_mode: 'RUNNING' })],
  [(u) => u.startsWith('/_ilm/policy'), () => ({
    'logs-retention': {
      version: 3, modified_date_string: '2026-08-01T00:00:00Z',
      policy: { phases: {
        hot: { min_age: '0ms', actions: { rollover: { max_age: '1d' } } },
        warm: { min_age: '7d', actions: { forcemerge: { max_num_segments: 1 } } },
        delete: { min_age: '30d', actions: { delete: {} } },
      } },
    },
  })],
  [(u) => /_settings\?filter_path=\*\.settings\.index\.lifecycle\.name/.test(u), () =>
    Object.fromEntries(INDICES.map((i) => [i.index, { settings: { index: { lifecycle: { name: 'logs-retention' } } } }]))],
  [(u) => u.includes('_ilm/explain'), () => ({ indices: { 'logstash-beta-2026.09.09': { step: 'ERROR' } } })],
  [(u) => u.startsWith('/_nodes/settings'), () => ({ nodes: { n1: { name: 'node-1',
    settings: { path: { repo: ['/mnt/backups'] } } } } })],
  // Three nodes, with what the Zabbix jump-host template reads: heap, uptime, CPU, disk, the
  // thread pools that reject work. node-3 is the busy one.
  [(u) => u.startsWith('/_nodes/stats'), () => ({ nodes: Object.fromEntries([['n1', 'node-1', 41, 22], ['n2', 'node-2', 57, 35], ['n3', 'node-3', 88, 71]]
    .map(([id, name, heap, cpu]) => [id, { name, jvm: { mem: { heap_used_percent: heap }, uptime_in_millis: 864e6 },
      os: { cpu: { percent: cpu } }, fs: { total: { total_in_bytes: 1e12, available_in_bytes: 4e11 } },
      thread_pool: { search: { queue: 0, rejected: 2 }, write: { queue: id === 'n3' ? 5 : 0, rejected: 7 }, get: { queue: 0, rejected: 0 } } }])) })],
  [(u) => u.startsWith('/_cluster/stats'), () => ({ indices: { count: INDICES.length, docs: { count: 5000 }, store: { size_in_bytes: 16e9 } },
    nodes: { count: { total: 3 }, versions: ['8.13.4'], jvm: { versions: [{ version: '21.0.2' }], max_uptime_in_millis: 864e6 },
      fs: { total_in_bytes: 3e12, available_in_bytes: 1.2e12 } } })],
  [(u) => u.startsWith('/_resolve/index'), () => ({ indices: INDICES.map((i) => ({ name: i.index })) })],
  [(u) => u.includes('/_settings'), () => ({ 'logstash-acme-2026.09.09': {
    settings: { 'index.number_of_replicas': '1', 'index.refresh_interval': '1s' } } })],
  // Field-volume aggregation: terms split by day, plus the day totals. One value spikes
  // on the latest complete day so the 40% rule has something to catch.
  // _bulk: echo back the shape the sink checks — item count and an errors flag.
  [(u) => u.includes('/_bulk'), ({ body }) => {
    const lines = String(body || '').split('\n').filter(Boolean);
    const n = Math.floor(lines.length / 2);
    return { took: 4, errors: false,
             items: Array.from({ length: n }, () => ({ index: { status: 201, result: 'created' } })) };
  }],
  [(u) => u.includes('/_search'), (hit) => {
    let body = {};
    try { body = JSON.parse(hit.body || '{}'); } catch { /* fall through to the hit list */ }

    // The close-up: the newest documents for one device, looked up by hostname or by
    // address. Answered from the same DEVICES table the aggregation uses, so the fixture
    // cannot tell one story per device in the fleet table and a different one here.
    const clauses = termClauses(body);
    if (clauses) {
      // src_hostname holds the name; src_ip holds the address. Asking the wrong field
      // for the wrong kind of value matches nothing, exactly as a real cluster would.
      const idx = DEVICES.findIndex(([name], i) => clauses.some(({ field, value }) =>
        (field === 'src_hostname' && value === name) || (field === 'src_ip' && value === `10.0.0.${i + 1}`)));
      if (idx < 0) {
        return { took: 2, timed_out: false, hits: { total: { value: 0, relation: 'eq' }, hits: [] } };
      }
      const [device, mins, logType, tag] = DEVICES[idx];
      const size = Math.min(Number(body.size) || 15, 50);
      const now = Date.now();
      const hits = Array.from({ length: size }, (_, n) => {
        const arrival = now - 60000 - n * 60000;
        // A little wobble, deterministic so a re-run says the same thing. The newest
        // document keeps the exact delay the fleet table reported for this device.
        const wobble = n === 0 ? 0 : ((n * 7) % 5) - 2;
        const event = arrival - (mins + wobble) * 60000;
        const src = {
          '@timestamp': new Date(arrival).toISOString(),
          ingested_time: new Date(event).toISOString(),
          src_hostname: device,
          src_ip: `10.0.0.${idx + 1}`,
          tag1: tag, fwdtag: `fwd-${tag}`, ClientID: tag.toUpperCase(),
          branch: tag === 'acme' ? 'HQ' : 'DR', log_type: logType,
        };
        // One parser miss, on the oldest document of one device: the UI must list it
        // rather than drop it, and must not count it as a zero delay.
        if (device === 'proxy-03' && n === size - 1) delete src.ingested_time;
        return { _index: `logstash-${tag}-2026.09.09`, _id: `${device}-${n}`, _source: src };
      });
      return { took: 4, timed_out: false,
               hits: { total: { value: 100 + Math.round(Math.abs(mins)), relation: 'eq' }, hits } };
    }
    // Log delay: terms on the device field with a top_hits sub-agg per bucket. Devices
    // are shaped to cover every status the classifier can produce, including the two that
    // are easy to get wrong — a negative delay (device clock ahead) and a delay sitting
    // exactly on a whole-hour boundary, which is what timezone misconfiguration looks like.
    // The log archive check's two searches (Zabbix ULM template): tag1 values, and which
    // tag x branch x day has logs — yesterday and the day before, for two tags.
    if (body.aggs && body.aggs.tags && body.aggs.tags.terms) {
      const day = (n) => { const d = new Date(Date.now() - n * 86400000); return `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}`; };
      const days = { buckets: [1, 2].map((n) => ({ key_as_string: day(n), doc_count: 10 })) };
      const tags = [['acme', 'HQ'], ['beta', 'DR']].map(([key, branch]) => (body.aggs.tags.aggs
        ? { key, doc_count: 20, branches: { buckets: [{ key: branch, doc_count: 20, days }] } } : { key, doc_count: 20 }));
      return { took: 2, timed_out: false, hits: { total: { value: 0 }, hits: [] }, aggregations: { tags: { buckets: tags } } };
    }
    // Device count (the Zabbix devices templates): a cardinality on the same field.
    if (body.aggs && body.aggs.devices && body.aggs.devices.cardinality) {
      return { took: 3, timed_out: false, hits: { total: { value: 0 }, hits: [] },
               aggregations: { devices: { value: DEVICES.length } } };
    }
    if (body.aggs && body.aggs.devices) {
      const now = Date.now();
      const iso = (ms) => new Date(ms).toISOString();
      const buckets = DEVICES.map(([device, mins, logType, tag]) => {
        const arrival = now - 60000;
        const event = arrival - mins * 60000;
        return {
          key: device,
          doc_count: 100 + Math.round(Math.abs(mins)),
          latest: { hits: { total: { value: 1 }, hits: [{
            _index: 'logstash-acme-2026.09.09',
            _source: {
              '@timestamp': iso(arrival),
              ingested_time: iso(event),
              src_hostname: device,
              src_ip: `10.0.0.${DEVICES.findIndex((d) => d[0] === device) + 1}`,
              tag1: tag,
              fwdtag: `fwd-${tag}`,
              ClientID: tag.toUpperCase(),
              branch: tag === 'acme' ? 'HQ' : 'DR',
              log_type: logType,
            },
          }] } },
        };
      });
      return { took: 12, timed_out: false, hits: { total: { value: 0 }, hits: [] },
               aggregations: { devices: { buckets, sum_other_doc_count: 0 } } };
    }

    if (body.aggs && body.aggs.terms) {
      const DAYS = 14;
      // UTC midnight, as a real date_histogram buckets by default.
      const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
      const dayMs = (n) => midnight.getTime() - n * 86400000;
      // oldest -> newest, ending today
      const keys = Array.from({ length: DAYS + 1 }, (_, i) => dayMs(DAYS - i));
      const shape = { 'fw-edge-01': 1000, 'fw-core-02': 600, 'proxy-03': 300, 'vpn-04': 120 };
      const spikeOn = dayMs(1);          // yesterday: the latest complete day
      const buckets = Object.entries(shape).map(([key, base]) => ({
        key,
        doc_count: base * DAYS,
        per_day: { buckets: keys.map((k) => ({
          key: k,
          // fw-edge-01 triples yesterday; everything else stays flat.
          doc_count: k === spikeOn && key === 'fw-edge-01' ? base * 3
                   : k === midnight.getTime() ? Math.round(base / 4)   // today is partial
                   : base,
        })) },
      }));
      const totalPerDay = keys.map((k) => ({
        key: k,
        doc_count: buckets.reduce((s, b) => s + (b.per_day.buckets.find((x) => x.key === k) || {}).doc_count, 0),
      }));
      return { took: 5, timed_out: false, hits: { total: { value: 0 }, hits: [] },
               aggregations: { terms: { buckets }, per_day_total: { buckets: totalPerDay } } };
    }
    return { took: 3, hits: { total: { value: 2 }, hits: [
    { _index: 'logstash-acme-2026.09.09', _id: '1', _source: { '@timestamp': new Date().toISOString(), message: 'hello' } },
    { _index: 'logstash-acme-2026.09.09', _id: '2', _source: { '@timestamp': new Date().toISOString(), message: 'world' } },
  ] }, aggregations: { over_time: { buckets: [] } } };
  }],
];

/**
 * What this fixture pretends to have mapped.
 *
 * Deliberately a parsed-log shape rather than the Filebeat ECS the dev cluster ships, so
 * the delay preflight has something it can say yes to. `parser_tag` is left out on
 * purpose: a metadata field that is absent is a real case and the page reports it
 * without refusing the whole analysis.
 */
const FIELD_TYPES = {
  '@timestamp': 'date',
  ingested_time: 'date',
  'src_hostname.keyword': 'keyword',
  src_ip: 'ip',
  'tag1.keyword': 'keyword',
  'fwdtag.keyword': 'keyword',
  ClientID: 'keyword',
  'branch.keyword': 'keyword',
  'log_type.keyword': 'keyword',
};

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const url = req.url;
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !url.includes('_search') && !url.includes('_bulk')) {
      return res.end(JSON.stringify({ acknowledged: true }));   // fixture: writes are no-ops
    }
    const hit = routes.find(([match]) => match(url));
    res.end(JSON.stringify(hit ? hit[1]({ body, url }) : { acknowledged: true, url }));
  });
// Loopback by default, and that default is deliberate: a fixture that answers anything
// on every interface is one an unrelated thing on the network can find and believe. Set
// MOCK_BIND=0.0.0.0 only to let a container reach it — which is what verifying the
// hosted stack against it needs, and nothing else should.
}).listen(port, bind, () => console.log(`mock elasticsearch on http://${bind}:${port}`));
