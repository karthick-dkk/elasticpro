#!/usr/bin/env node
/**
 * A stand-in Elasticsearch, just complete enough for every page to render with data.
 *
 * `render-check.mjs` against an empty config only ever draws "No cluster selected", which
 * exercises almost nothing. Pointing it at this instead makes the pages walk their real
 * paths — tables, charts, coverage strips, snapshot lists — which is where render bugs are.
 *
 *   node tools/mock-es.mjs [port]        # default 9299
 *   node tools/mock-es.mjs --ports 9300-9335   # a fleet: one cluster per port
 *
 * For load testing (tools/load-check.mjs), all optional:
 *   MOCK_LATENCY_MS   every answer waits this long (default 0)
 *   MOCK_JITTER_MS    …plus up to this much more, at random (default 0)
 *   MOCK_INDEX_COUNT  _cat/indices lists this many more indices (a big cluster's answer)
 *   MOCK_429_RATE     this fraction of requests (0..1) is answered 429 Too Many Requests
 *   MOCK_ILM_UNMANAGED  comma-separated index names left without an ILM policy, so the
 *                       ILM pill's red "N of M open log indices have no policy" shows
 * Each instance counts the requests it is holding at once; GET /_mock/stats answers
 * {port, now, peak, total, rejected429} and POST /_mock/reset starts the count again.
 *
 * At scale, for the fleet cache's memory (tools/fleet-load.sh): MOCK_INDICES=4000 makes
 * every listing that many indices long — _cat/indices and _cat/shards, the ILM settings and
 * policies' in_use_by, ILM errors for one index in twenty, and MOCK_SNAPSHOTS (default 1000)
 * snapshots whose verbose listing names MOCK_SNAP_INDICES (default 200) indices each. Real
 * production bodies are megabytes; the default fixture's are a few hundred bytes, which is
 * how a cache that does not count its own memory passed every test.
 *
 * The two index knobs differ on purpose: MOCK_INDEX_COUNT only lengthens _cat/indices and
 * leaves the five-index fixture every page reads; MOCK_INDICES replaces the fixture with N
 * generated indices everywhere. Both may be set. A fleet is always --ports: each port is
 * its own cluster, named MOCK_CLUSTER_NAME-<port> with its own uuid.
 *
 * Read-only fixture: any write returns {"acknowledged": true} without changing anything —
 * except snapshot deletes and index-template PUT/DELETE, which are honoured in memory.
 */

import http from 'node:http';

/** `--ports 9300-9335` or `--ports 9300,9301`: a fleet of clusters, one per port. */
function portsFromArgs(argv) {
  const i = argv.indexOf('--ports');
  if (i < 0) return [Number(argv[2]) || 9299];
  const spec = String(argv[i + 1] || '');
  const out = [];
  for (const part of spec.split(',').filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    for (let p = a; p <= (b || a); p++) out.push(p);
  }
  if (!out.length || out.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    console.error(`mock-es: --ports wants 9300-9335 or 9300,9301; got ${JSON.stringify(spec)}`);
    process.exit(2);
  }
  return out;
}
const ports = portsFromArgs(process.argv);
const fleet = ports.length > 1;
const bind = process.env.MOCK_BIND || '127.0.0.1';
const LATENCY_MS = Math.max(0, Number(process.env.MOCK_LATENCY_MS) || 0);
const JITTER_MS = Math.max(0, Number(process.env.MOCK_JITTER_MS) || 0);
const INDEX_COUNT = Math.max(0, Number(process.env.MOCK_INDEX_COUNT) || 0);
const RATE_429 = Math.min(1, Math.max(0, Number(process.env.MOCK_429_RATE) || 0));
// Identity, so several instances can stand in for a fleet rather than for one cluster.
// Without this every instance calls itself "mock" with uuid "mock-uuid", and anything
// that keys clusters by uuid — which the fleet cache does — treats ten of them as one.
const clusterName = process.env.MOCK_CLUSTER_NAME || 'mock';
const clusterUuid = process.env.MOCK_CLUSTER_UUID || `${clusterName}-uuid`;
// In fleet mode each port is its own cluster, by name and by uuid.
const nameFor = (port) => (fleet ? `${clusterName}-${port}` : clusterName);
const uuidFor = (port) => (fleet ? `${clusterName}-${port}-uuid` : clusterUuid);
const DAY = 86400000;

const index = (name, size, status = 'open', health = 'green') => ({
  index: name, health, status, uuid: name, pri: '1', rep: '1',
  'docs.count': '1000', 'docs.deleted': '12',
  'store.size': String(size), 'pri.store.size': String(Math.round(size / 2)),
  'creation.date': String(Date.now() - DAY),
});

const SCALE = Math.max(0, Number(process.env.MOCK_INDICES) || 0);
const TENANTS = ['acme', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'zeta'];
const scaledName = (i) => `logstash-${TENANTS[i % TENANTS.length]}-${new Date(Date.now() - Math.floor(i / TENANTS.length) * DAY).toISOString().slice(0, 10).replace(/-/g, '.')}-${String(i).padStart(6, '0')}`;

const INDICES = SCALE ? Array.from({ length: SCALE }, (_, i) => index(scaledName(i), 1e8 + i * 12345, i % 97 === 0 ? 'close' : 'open', i % 53 === 0 ? 'yellow' : 'green')) : [
  index('logstash-acme-2026.09.09', 5e9),
  index('logstash-acme-2026.09.08', 4e9),
  index('logstash-acme-2026.09.07', 4.2e9, 'close'),
  index('logstash-beta-2026.09.09', 2e9, 'open', 'yellow'),
  index('metrics-2026.09', 9e8),
];
/**
 * The daily volume record (docs/VOLUME.md, "Collection") reads every
 * logstash-<source>-<day> index the cluster has. 45 days of two sources, dated back from
 * today (UTC, as the core counts days), so the per-day and per-month views have a history
 * to show. Deterministic per date, so a re-run draws the same picture; acme jumps
 * 60 % yesterday, so the peak label and the red "vs avg" have a case.
 * Today's indices are a third full: today is still filling up.
 *
 * Listed by _cat/indices and searched by the per-day `_search` only — the five-index
 * fixture above is what shards, ILM and snapshots keep reading.
 */
const VOLUME_DAYS = 45;
const VOLUME_SOURCES = { acme: { bytes: 6e9, docs: 4.2e6 }, beta: { bytes: 2.1e9, docs: 1.6e6 } };
const ymdUtc = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
/** 0.8 .. 1.2, the same every time for the same day and salt. */
function wobble(ymd, salt) {
  let x = 7;
  for (const ch of `${ymd}|${salt}`) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return 0.8 + (x % 401) / 1000;
}
function volumeDay(source, ymd) {
  const s = VOLUME_SOURCES[source];
  let f = wobble(ymd, source);
  if (source === 'acme' && ymd === ymdUtc(1)) f *= 1.6;
  if (ymd === ymdUtc(0)) f *= 0.35;
  return { pri: Math.round(s.bytes * f), docs: Math.round(s.docs * f) };
}
const VOLUME_INDICES = SCALE ? [] : Array.from({ length: VOLUME_DAYS }, (_, n) => ymdUtc(n)).flatMap((ymd) =>
  Object.keys(VOLUME_SOURCES).map((src) => {
    const { pri, docs } = volumeDay(src, ymd);
    const name = `logstash-${src}-${ymd.replace(/-/g, '.')}`;
    return { index: name, health: 'green', status: 'open', uuid: name, pri: '1', rep: '1',
      'docs.count': String(docs), 'docs.deleted': '0', 'store.size': String(pri * 2), 'pri.store.size': String(pri),
      'creation.date': String(Date.parse(`${ymd}T00:05:00Z`)) };
  }));

// MOCK_INDEX_COUNT more, for a _cat/indices answer the size a big cluster gives. Listed
// only by _cat/indices: the pages' other checks keep reading the five above.
const CAT_INDICES = [...INDICES, ...VOLUME_INDICES,
  ...(INDEX_COUNT ? Array.from({ length: INDEX_COUNT }, (_, i) => index(`bulk-${String(i).padStart(6, '0')}-2026.09.09`, 1e8 + i)) : [])];

/** `logstash-*-2026.10.20` or `a,b*` → a test on an index name, as Elasticsearch reads a target. */
function globTest(target) {
  const parts = String(target || '*').split(',').map((g) => g.trim()).filter(Boolean);
  const res = parts.map((g) => new RegExp('^' + g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
  return (name) => res.some((re) => re.test(name));
}

// Enough snapshots that the snapshot list has more than one page to move through.
const SNAPSHOTS = Array.from({ length: SCALE ? (Number(process.env.MOCK_SNAPSHOTS) || 1000) : 23 }, (_, i) => {
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

// Snapshots deleted during this run. Writes are no-ops here (see the handler below), which
// is fine for most of them — but a delete that answers 200 and changes nothing makes the app
// look broken: the page re-reads after the write, the cluster still lists the snapshot, and
// the operator deletes it again. That has been reported as a product bug. Deleting is the one
// write this fixture honours. In memory only: restarting the mock brings both snapshots back,
// which the index checks below rely on.
const deletedSnapshots = new Set();
const snapshotsLeft = (list) => list.filter((s) => !deletedSnapshots.has(s.snapshot));

const routes = [
  [(u) => u === '/', ({ port }) => ({ cluster_name: nameFor(port), cluster_uuid: uuidFor(port),
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
    { id: 'Xk3pQ9aTn1', name: 'node-1', ip: '10.0.0.1', version: '8.13.4', jdk: '17.0.9', 'node.role': 'dim', master: '*',
      'heap.percent': '61', 'ram.percent': '70', cpu: '12', load_1m: '1.2',
      'disk.used': '91000000000', 'disk.avail': '9000000000', 'disk.total': '100000000000',
      'disk.used_percent': '91', uptime: '10d' },
    { id: 'b7Lm2RfEn2', name: 'node-2', ip: '10.0.0.2', version: '8.13.4', jdk: '17.0.9', 'node.role': 'dim', master: '-',
      'heap.percent': '55', 'ram.percent': '66', cpu: '9', load_1m: '0.8',
      'disk.used': '55000000000', 'disk.avail': '45000000000', 'disk.total': '100000000000',
      'disk.used_percent': '55', uptime: '10d' },
    { id: 'Qw8nZc4Hn3', name: 'node-3', ip: '10.0.0.3', version: '8.13.4', jdk: '21.0.2', 'node.role': 'dim', master: '-',
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
  // Narrowed to the target a real cluster would be asked for (`/_cat/indices/logstash-*-*`
  // from the volume collector); a bare `/_cat/indices` or `*` lists everything.
  [(u) => u.startsWith('/_cat/indices'), ({ url }) => {
    const target = decodeURIComponent((url.split('?')[0].split('/_cat/indices/')[1] || '*'));
    const keep = globTest(target);
    return CAT_INDICES.filter((i) => keep(i.index));
  }],
  // /_cat/recovery, which restorePoll watches after a restore. Without a route here the
  // catch-all answered {acknowledged:true} — an object, not a list of shards — and the
  // poller died with "rows.map is not a function" after five tries. Every shard reports
  // done, so a restore watched against this fixture completes rather than hanging.
  [(u) => u.startsWith('/_cat/recovery'), ({ url }) => {
    const names = decodeURIComponent((url.split('?')[0].split('/_cat/recovery/')[1] || '')).split(',').filter(Boolean);
    return names.flatMap((index) => [0, 1].map((shard) => ({
      index, shard: String(shard), stage: 'done', type: 'snapshot' })));
  }],
  [(u) => u.startsWith('/_cat/shards'), () => ([
    { index: 'logstash-acme-2026.09.09', shard: '0', prirep: 'p', state: 'STARTED', node: 'node-1', store: '2500000000' },
    { index: 'logstash-acme-2026.09.09', shard: '0', prirep: 'r', state: 'STARTED', node: 'node-2', store: '2500000000' },
    { index: 'logstash-beta-2026.09.09', shard: '0', prirep: 'r', state: 'UNASSIGNED',
      'unassigned.reason': 'NODE_LEFT', node: null, store: '0' }])],
  [(u) => u.startsWith('/_cat/snapshots'), () => SNAPSHOTS],
  [(u) => u.startsWith('/_cat/aliases'), () => ([{ alias: 'logstash', index: 'logstash-acme-2026.09.09', is_write_index: 'true' }])],
  [(u) => /^\/_snapshot\/[^/]+\//.test(u), () => ({ snapshots: snapshotsLeft([
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
  ]) })],
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
  // As ES answers it: the open indices the pattern matches, each with its uuid, and the
  // policy where it has one — an index without one keeps only its uuid.
  [(u) => /_settings\?filter_path=\*\.settings\.index\.lifecycle\.name/.test(u), ({ url: u }) => {
    const glob = decodeURIComponent(u.split('/')[1]);
    const re = new RegExp('^' + glob.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const unmanaged = new Set((process.env.MOCK_ILM_UNMANAGED || '').split(',').filter(Boolean));
    return Object.fromEntries(INDICES.filter((i) => i.status === 'open' && re.test(i.index)).map((i) => [i.index,
      { settings: { index: { uuid: i.uuid, ...(unmanaged.has(i.index) ? {} : { lifecycle: { name: 'logs-retention' } }) } } }]));
  }],
  [(u) => u.includes('_ilm/explain'), () => ({ indices: { 'logstash-beta-2026.09.09': { step: 'ERROR' } } })],
  [(u) => u.startsWith('/_nodes/settings'), () => ({ nodes: { n1: { name: 'node-1',
    settings: { path: { repo: ['/mnt/backups'] } } } } })],
  // Three nodes, with what the Zabbix jump-host template reads: heap, uptime, CPU, disk, the
  // thread pools that reject work. node-3 is the busy one.
  [(u) => u.startsWith('/_nodes/stats'), () => ({ nodes: Object.fromEntries([['n1', 'node-1', 41, 22], ['n2', 'node-2', 57, 35], ['n3', 'node-3', 88, 71]]
    .map(([id, name, heap, cpu]) => [id, { name, jvm: { mem: { heap_used_percent: heap }, uptime_in_millis: 864e6 },
      os: { cpu: { percent: cpu } }, fs: { total: { total_in_bytes: 1e12, available_in_bytes: 4e11 } },
      // Counters that climb with the clock (42 searches and 300 documents a second across the
      // three nodes), so two readings make the rate the Clusters page's open row shows.
      indices: { search: { query_total: 1e6 + Math.floor(Date.now() / 1000) * 14 }, indexing: { index_total: 5e7 + Math.floor(Date.now() / 1000) * 100 } },
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

    // The volume collector's one search per day (docs/VOLUME.md, "Collection" step 3).
    if (body.aggs && body.aggs.by_index) return volumeSearch(hit.url, body);

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
  ] }, aggregations: { over_time: { buckets: [
      // Real Elasticsearch always buckets the range (min_doc_count 0 + extended_bounds); the
      // two hits above are "now", so one bucket at the current minute holds them both.
      { key: Math.floor(Date.now() / 60000) * 60000, doc_count: 2 },
    ] } } };
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
  // What the volume collector resolves (docs/VOLUME.md, "Settings"): tag1 is text with a
  // keyword under it, so the core must pick tag1.keyword; the forwarder is fwdtag (fwd_tag
  // is absent, so the row's first name misses); event_logsize is the numeric Event size.
  // sub_size is left out on purpose: Sub size stays "not measured", never 0.
  tag1: 'text',
  fwdtag: 'keyword',
  src_hostname: 'keyword',
  event_logsize: 'long',
  log_type: 'keyword',
};

/**
 * The values each volume field holds, with their weights. Shares are the same every day
 * apart from a per-date wobble, so the breakdown and the "top" columns are stable.
 */
const VOLUME_VALUES = {
  tag1: [['acme', 5], ['beta', 3], ['gamma', 1]],
  fwdtag: [['fwd-acme', 6], ['fwd-beta', 3]],
  src_hostname: DEVICES.map(([name], i) => [name, 6 - i]),
  src_ip: DEVICES.map((_, i) => [`10.0.0.${i + 1}`, 6 - i]),
  log_type: [['firewall', 5], ['proxy', 2], ['vpn', 1], ['syslog', 2]],
  event_logsize: [],
};
/** Bytes per event, per day: what `sum(event_logsize)` adds up to. */
const eventBytesPer = (ymd) => Math.round(560 * wobble(ymd, 'ev'));

/**
 * One day's volume search, answered as Elasticsearch would: the total, the sums, a bucket
 * per index, and for each `f_<row>` terms agg the top values with `ev`/`sub` sums, and for
 * each `m_<row>` the documents without the field. Sums are asked only for resolved fields,
 * and a sum on an unmapped field is 0 in a real cluster, so that is what comes back here.
 */
function volumeSearch(url, body) {
  const target = decodeURIComponent(url.split('?')[0].split('/')[1] || '');
  const keep = globTest(target);
  const day = (/(\d{4})\.(\d{2})\.(\d{2})/.exec(target) || []).slice(1).join('-');
  const idx = [...INDICES, ...VOLUME_INDICES].filter((i) => i.status === 'open' && keep(i.index));
  const per = eventBytesPer(day);
  const docsOf = (i) => Number(i['docs.count']) || 0;
  const total = idx.reduce((s, i) => s + docsOf(i), 0);
  const subs = (aggs, docs) => {
    const out = {};
    if (aggs && aggs.ev) out.ev = { value: aggs.ev.sum && aggs.ev.sum.field === 'event_logsize' ? docs * per : 0 };
    if (aggs && aggs.sub) out.sub = { value: 0 };
    return out;
  };
  const aggregations = { ...subs(body.aggs, total) };
  aggregations.by_index = { doc_count_error_upper_bound: 0, sum_other_doc_count: 0,
    buckets: idx.map((i) => ({ key: i.index, doc_count: docsOf(i), ...subs(body.aggs.by_index.aggs, docsOf(i)) })) };
  for (const [name, agg] of Object.entries(body.aggs)) {
    if (name.startsWith('f_') && agg.terms) {
      const field = String(agg.terms.field || '').replace(/\.keyword$/, '');
      const values = VOLUME_VALUES[field] || [];
      const weights = values.map(([v, w]) => [v, w * wobble(day, `${field}|${v}`)]);
      const sumW = weights.reduce((s, [, w]) => s + w, 0) || 1;
      const present = Math.round(total * 0.97);
      let left = present;
      const all = weights.map(([v, w], k) => {
        const n = k === weights.length - 1 ? left : Math.round((present * w) / sumW);
        left -= n;
        return { key: v, doc_count: Math.max(0, n) };
      }).sort((a, b) => b.doc_count - a.doc_count);
      const size = Number(agg.terms.size) || 10;
      const top = all.slice(0, size);
      aggregations[name] = { doc_count_error_upper_bound: 0,
        sum_other_doc_count: all.slice(size).reduce((s, b) => s + b.doc_count, 0),
        buckets: top.map((b) => ({ ...b, ...subs(agg.aggs, b.doc_count) })) };
    } else if (name.startsWith('m_') && agg.missing) {
      const field = String(agg.missing.field || '').replace(/\.keyword$/, '');
      const missing = VOLUME_VALUES[field] && VOLUME_VALUES[field].length ? total - Math.round(total * 0.97) : total;
      aggregations[name] = { doc_count: missing, ...subs(agg.aggs, missing) };
    }
  }
  return { took: 9, timed_out: false, _shards: { total: idx.length, successful: idx.length, skipped: 0, failed: 0 },
    hits: { total: { value: total, relation: 'eq' }, max_score: null, hits: [] }, aggregations };
}

// The task list. Two long searches are always "running": one is ours — it carries the last
// X-Opaque-Id this fixture was sent, so the Tasks panel can tell our query from a stranger's
// — and one is somebody else's. POST /_tasks/<id>/_cancel removes it from the listing, so
// "cancelled and still there" means the app, not the fixture.
const seenOpaqueIds = [];
const cancelledTasks = new Set();
function tasksListing() {
  const ours = seenOpaqueIds.length ? seenOpaqueIds[seenOpaqueIds.length - 1] : 'elasticpro/mock/page:indices/mock-prod/1';
  const all = {
    'node-1:4711': { node: 'node-1', id: 4711, type: 'transport', action: 'indices:data/read/search', description: 'indices[logstash-*], search_type[QUERY_THEN_FETCH]',
      start_time_in_millis: Date.now() - 95_000, running_time_in_nanos: 95_000_000_000, cancellable: true, headers: { 'X-Opaque-Id': ours } },
    'node-1:4712': { node: 'node-1', id: 4712, type: 'transport', action: 'indices:data/read/search', description: 'indices[metrics-*], search_type[QUERY_THEN_FETCH]',
      start_time_in_millis: Date.now() - 42_000, running_time_in_nanos: 42_000_000_000, cancellable: true, headers: { 'X-Opaque-Id': 'kibana-reporting-7f3a' } },
  };
  const tasks = Object.fromEntries(Object.entries(all).filter(([id]) => !cancelledTasks.has(id)));
  return { nodes: { 'node-1': { name: 'node-1', transport_address: '127.0.0.1:9300', tasks } } };
}
routes.unshift([(u) => u.startsWith('/_tasks?') || u === '/_tasks', () => tasksListing()]);

// The listings that grow with the index count, at MOCK_INDICES. Generated once: the shapes
// are Elasticsearch's, the sizes are a large production cluster's.
if (SCALE) {
  const names = INDICES.map((i) => i.index);
  const SNAP_INDICES = Number(process.env.MOCK_SNAP_INDICES) || 200;
  const shards = names.flatMap((n, i) => ['p', 'r'].map((prirep) => ({
    index: n, shard: '0', prirep, state: 'STARTED', node: `node-${(i + (prirep === 'r' ? 1 : 0)) % 3 + 1}`,
    store: String(5e7 + i * 999), docs: String(100000 + i), 'unassigned.reason': null })));
  const verbose = SNAPSHOTS.slice(0, 500).map((s, k) => ({
    snapshot: s.id, uuid: `snap-uuid-${k}`, repository: 'daily', state: s.status,
    indices: names.slice((k * 7) % Math.max(1, names.length - SNAP_INDICES), (k * 7) % Math.max(1, names.length - SNAP_INDICES) + SNAP_INDICES),
    data_streams: [], include_global_state: false,
    shards: { total: SNAP_INDICES, successful: SNAP_INDICES, failed: 0 }, failures: [],
    start_time_in_millis: Number(s.start_epoch) * 1000, end_time_in_millis: Number(s.end_epoch) * 1000,
    start_time: new Date(Number(s.start_epoch) * 1000).toISOString(), end_time: new Date(Number(s.end_epoch) * 1000).toISOString(),
    duration_in_millis: 300000, version: '8.13.4', version_id: 8130499 }));
  const policies = Object.fromEntries(TENANTS.map((t) => [`logs-${t}`, {
    version: 3, modified_date: '2026-08-01T00:00:00Z',
    policy: { phases: { hot: { min_age: '0ms', actions: { rollover: { max_age: '1d', max_primary_shard_size: '50gb' } } },
      warm: { min_age: '7d', actions: { forcemerge: { max_num_segments: 1 }, shrink: { number_of_shards: 1 } } },
      delete: { min_age: '30d', actions: { delete: { delete_searchable_snapshot: true } } } } },
    in_use_by: { indices: names.filter((n) => n.includes(`-${t}-`)), data_streams: [], composable_templates: [`logs-${t}`] } }]));
  const errors = Object.fromEntries(names.filter((_, i) => i % 20 === 0).map((n) => [n, {
    index: n, managed: true, policy: 'logs-acme', lifecycle_date_millis: Date.now() - DAY, age: '1d',
    phase: 'warm', action: 'shrink', step: 'ERROR', failed_step: 'shrink',
    step_info: { type: 'illegal_argument_exception', reason: `index [${n}] cannot be shrunk: not enough nodes with the required attributes` },
    phase_execution: { policy: 'logs-acme', version: 3, modified_date_in_millis: Date.now() - 30 * DAY } }]));
  routes.unshift(
    [(u) => u.startsWith('/_cat/shards'), ({ url }) => catProject(url, shards)],
    [(u) => /^\/_snapshot\/[^/]+\//.test(u), () => ({ snapshots: verbose, total: verbose.length, remaining: 0 })],
    [(u) => u.startsWith('/_ilm/policy'), () => policies],
    [(u) => u.includes('_ilm/explain'), () => ({ indices: errors })],
  );
}
// Scaled bodies are the same every time, and big: serialised once each.
const memo = new Map();
const memoable = (u) => SCALE && u !== '/' && !u.startsWith('/_tasks') && !u.includes('_template') && !u.includes('_search') && !u.includes('_bulk');
// The native realm, as Elasticsearch answers it: a map of username → user. (Without this the
// fixture's generic acknowledgement stood in for it, which is not a shape a cluster sends.)
routes.unshift([(u) => u.split('?')[0] === '/_security/user', () => ({
  elastic: { username: 'elastic', roles: ['superuser'], full_name: null, email: null, metadata: { _reserved: true }, enabled: true },
  kibana_system: { username: 'kibana_system', roles: ['kibana_system'], metadata: { _reserved: true }, enabled: true },
  'log-reader': { username: 'log-reader', roles: ['viewer'], full_name: 'Log reader', email: 'logs@example.test', metadata: {}, enabled: true },
})]);

// Templates. Index templates are the one kind whose writes this fixture honours: a saved
// template that does not show up when the list is read again looks exactly like a page
// that forgot to save, and that is the confusion the snapshot deletes above already cost.
// In memory only — restarting the mock puts the starting four back.
const indexTemplates = new Map([
  ['logs-app', { index_patterns: ['logs-app-*'], priority: 200, composed_of: ['base-settings'],
    template: { settings: { index: { number_of_replicas: '1', refresh_interval: '5s' } },
      mappings: { properties: { message: { type: 'text' }, level: { type: 'keyword' } } },
      aliases: { 'logs-app': {} } },
    version: 3, _meta: { description: 'application logs' } }],
  ['logstash', { index_patterns: ['logstash-*'], priority: 100, composed_of: ['base-settings', 'base-mappings'],
    template: { settings: { index: { number_of_shards: '1' } } }, version: 1 }],
  ['.ilm-history-7', { index_patterns: ['ilm-history-7*'], priority: 2147483647, composed_of: [],
    template: { settings: { index: { hidden: 'true', lifecycle: { name: 'ilm-history-ilm-policy' } } } },
    data_stream: { hidden: true, allow_custom_routing: false }, version: 7,
    _meta: { description: 'index template for ILM history indices', managed: true } }],
  // A data stream catch-all under logs-app, so simulating a logs-app index has something
  // in `overlapping`.
  ['logs-default', { index_patterns: ['logs-*'], priority: 50, composed_of: ['base-mappings'],
    template: { mappings: { properties: { '@timestamp': { type: 'date' } } } },
    data_stream: { hidden: false, allow_custom_routing: false } }],
]);
const COMPONENT_TEMPLATES = {
  'base-settings': { template: { settings: { index: { number_of_replicas: '1', codec: 'best_compression' } } }, version: 2 },
  'base-mappings': { template: { mappings: { properties: { '@timestamp': { type: 'date' }, host: { properties: { name: { type: 'keyword' } } } } } }, version: 1 },
};
const LEGACY_TEMPLATES = {
  'old-logstash': { order: 0, index_patterns: ['logstash-*'], settings: { index: { number_of_shards: '1' } },
    mappings: { properties: { message: { type: 'text' } } }, aliases: {}, version: 1 },
};
const tplPath = (u) => decodeURIComponent(u.split('?')[0].split('/')[2] || '');
const listIndexTemplates = (only) => ({ index_templates: [...indexTemplates.entries()]
  .filter(([name]) => !only || only.split(',').some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name)))
  .map(([name, index_template]) => ({ name, index_template })) });
const wild = (p, n) => new RegExp(`^${String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(n);
/** What _simulate_index answers: the winner's resolved template, and the rest that match. */
function simulateIndex(indexName) {
  const matching = [...indexTemplates.entries()].filter(([, t]) => [].concat(t.index_patterns).some((p) => wild(p, indexName)))
    .sort(([, a], [, b]) => (b.priority || 0) - (a.priority || 0));
  if (!matching.length) return { template: { settings: {}, mappings: {}, aliases: {} }, overlapping: [] };
  const [, win] = matching[0];
  const settings = {}; let mappings = { properties: {} };
  for (const c of win.composed_of || []) {
    const ct = (COMPONENT_TEMPLATES[c] || {}).template || {};
    Object.assign(settings, ((ct.settings || {}).index) || {});
    Object.assign(mappings.properties, ((ct.mappings || {}).properties) || {});
  }
  Object.assign(settings, (((win.template || {}).settings || {}).index) || {});
  Object.assign(mappings.properties, (((win.template || {}).mappings || {}).properties) || {});
  return { template: { settings: { index: settings }, mappings, aliases: (win.template || {}).aliases || {} },
    overlapping: matching.slice(1).map(([name, t]) => ({ name, index_patterns: [].concat(t.index_patterns) })) };
}
routes.unshift(
  [(u) => u === '/_index_template' || u.startsWith('/_index_template?'), () => listIndexTemplates()],
  [(u) => /^\/_index_template\/[^_/?][^/?]*/.test(u), ({ url }) => {
    const name = tplPath(url);
    const out = listIndexTemplates(name);
    return out.index_templates.length ? out : { error: { type: 'resource_not_found_exception', reason: `index template matching [${name}] not found` }, status: 404 };
  }],
  [(u) => u === '/_component_template' || u.startsWith('/_component_template?'), () => ({
    component_templates: Object.entries(COMPONENT_TEMPLATES).map(([name, component_template]) => ({ name, component_template })) })],
  [(u) => u === '/_template' || u.startsWith('/_template?'), () => LEGACY_TEMPLATES],
);

// Across every port this process serves: what a whole fleet is holding at once.
const all = { now: 0, peak: 0 };
function serve(port) {
const gauge = { port, now: 0, peak: 0, total: 0, rejected429: 0 };
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const url = req.url;
    res.setHeader('content-type', 'application/json');
    if (url === '/_mock/stats') return res.end(JSON.stringify({ ...gauge, fleetNow: all.now, fleetPeak: all.peak }));
    if (url === '/_mock/reset' && req.method === 'POST') {
      Object.assign(gauge, { peak: gauge.now, total: 0, rejected429: 0 });
      all.peak = all.now;
      return res.end(JSON.stringify(gauge));
    }
    // Held from here until the answer is written or the client lets go.
    gauge.now++; gauge.total++; all.now++;
    if (gauge.now > gauge.peak) gauge.peak = gauge.now;
    if (all.now > all.peak) all.peak = all.now;
    let held = true;
    const release = () => { if (held) { held = false; gauge.now--; all.now--; } };
    res.on('finish', release);
    res.on('close', release);
    const delay = LATENCY_MS + (JITTER_MS ? Math.random() * JITTER_MS : 0);
    const answer = () => handle(req, res, url, body, port);
    if (RATE_429 && Math.random() < RATE_429) {
      gauge.rejected429++;
      res.statusCode = 429;
      return setTimeout(() => res.end(JSON.stringify({ error: { type: 'es_rejected_execution_exception', reason: 'rejected execution (mock)' }, status: 429 })), delay);
    }
    if (delay) setTimeout(answer, delay); else answer();
  });
// Loopback by default, and that default is deliberate: a fixture that answers anything
// on every interface is one an unrelated thing on the network can find and believe. Set
// MOCK_BIND=0.0.0.0 only to let a container reach it — which is what verifying the
// hosted stack against it needs, and nothing else should.
}).listen(port, bind, () => console.log(`mock elasticsearch on http://${bind}:${port}`));
}

function handle(req, res, url, body, port) {
    if (res.writableEnded || res.destroyed) return;
    const opaque = req.headers['x-opaque-id'];
    if (opaque) { seenOpaqueIds.push(opaque); if (seenOpaqueIds.length > 50) seenOpaqueIds.shift(); }
    const cancel = req.method === 'POST' && /^\/_tasks\/([^/?]+)\/_cancel/.exec(url);
    if (cancel) {
      const id = decodeURIComponent(cancel[1]);
      cancelledTasks.add(id);
      return res.end(JSON.stringify({ node_failures: [], nodes: { 'node-1': { name: 'node-1', tasks: { [id]: { cancelled: true } } } } }));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !url.includes('_search') && !url.includes('_bulk')) {
      // DELETE /_snapshot/<repo>/<name>[,<name>...] really removes them from the listing, so
      // "deleted it and it is still there" means the app, not the fixture. Everything else
      // stays a no-op.
      const bare = url.split('?')[0];
      const sim = req.method === 'POST' && /^\/_index_template\/_simulate_index\/([^/]+)$/.exec(bare);
      if (sim) return res.end(JSON.stringify(simulateIndex(decodeURIComponent(sim[1]))));
      const tpl = /^\/_index_template\/([^_/][^/]*)$/.exec(bare);
      if (tpl && req.method === 'PUT') {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { /* answered below */ }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { type: 'parse_exception', reason: 'request body is required' }, status: 400 }));
        }
        indexTemplates.set(decodeURIComponent(tpl[1]), parsed);
        return res.end(JSON.stringify({ acknowledged: true }));
      }
      if (tpl && req.method === 'DELETE') {
        const name = decodeURIComponent(tpl[1]);
        if (!indexTemplates.has(name)) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: { type: 'resource_not_found_exception', reason: `index_template [${name}] missing` }, status: 404 }));
        }
        indexTemplates.delete(name);
        return res.end(JSON.stringify({ acknowledged: true }));
      }
      const del = req.method === 'DELETE' && /^\/_snapshot\/[^/]+\/[^/?]+/.exec(url.split('?')[0]);
      if (del) {
        for (const name of del[0].split('/')[3].split(',')) {
          if (name && name !== '_all') { deletedSnapshots.add(decodeURIComponent(name)); }
        }
      }
      return res.end(JSON.stringify({ acknowledged: true }));   // fixture: other writes are no-ops
    }
    if (memoable(url) && memo.has(url)) return res.end(memo.get(url));
    const hit = routes.find(([match]) => match(url));
    const out = hit ? hit[1]({ body, url, port }) : { acknowledged: true, url };
    // A route answering an Elasticsearch error shape gets that error's HTTP status too.
    if (out && out.error && typeof out.status === 'number') res.statusCode = out.status;
    const text = JSON.stringify(out);
    if (memoable(url) && res.statusCode === 200) memo.set(url, text);
    res.end(text);
}

for (const p of ports) serve(p);
