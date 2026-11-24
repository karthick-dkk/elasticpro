/**
 * Clusters › Overview, the figures under the board (core/cluster-overview.js): the route, which
 * node is highest (unknown left out, never read as 0), the shard split, the two tables' orders,
 * this cluster's alerts, the rate text. No DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const O = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/cluster-overview.js')).href);

test('the route: #/clusters/overview is the Overview, with or without a cluster; everything else on the page is the List', () => {
  assert.equal(O.clustersSection('#/clusters/overview'), 'overview');
  assert.equal(O.clustersSection('#/clusters/overview/c%201'), 'overview');
  assert.equal(O.clustersSection('#/overview/overview'), 'overview', 'the page id form (render-check) reads the same');
  assert.equal(O.clustersSection('#/clusters'), 'list');
  assert.equal(O.clustersSection('#/overview'), 'list');
  assert.equal(O.clustersSection('#/alerts'), 'list');
  assert.equal(O.overviewClusterOf('#/clusters/overview/c%201'), 'c 1');
  assert.equal(O.overviewClusterOf('#/clusters/overview'), null);
  assert.equal(O.overviewClusterOf('#/clusters'), null);
  assert.equal(O.overviewHash('c 1'), '#/clusters/overview/c%201');
  assert.equal(O.overviewHash(), '#/clusters/overview');
  assert.equal(O.listHash(), '#/clusters');
});

const NODES = [
  { name: 'node-1', master: '*', 'node.role': 'dim', cpu: '12', 'heap.percent': '61', 'heap.current': '10522669875', 'heap.max': '17179869184', 'disk.used_percent': '91', load_1m: '1.2', uptime: '10d' },
  { name: 'node-2', master: '-', 'node.role': 'dim', cpu: '9', 'heap.percent': '55', 'disk.used_percent': '55' },
  { name: 'node-3', master: '-', 'node.role': 'm', cpu: '', 'heap.percent': '38', 'disk.used_percent': '' },
];

test('highest node: the largest reported figure; blanks are not 0; no node list is null', () => {
  assert.deepEqual([O.highestNode(NODES, 'cpu').name, O.highestNode(NODES, 'cpu').value], ['node-1', 12]);
  assert.equal(O.highestNode(NODES, 'disk.used_percent').name, 'node-1');
  assert.equal(O.highestNode(NODES, 'heap.percent').name, 'node-1');
  assert.equal(O.highestNode([{ name: 'a', cpu: '' }, { name: 'b' }], 'cpu'), null, 'nobody reported it');
  assert.equal(O.highestNode([], 'cpu'), null);
  assert.equal(O.highestNode(undefined, 'cpu'), null);
  assert.equal(O.highestNode([{ name: 'z', cpu: '0' }, { name: 'a', cpu: '' }], 'cpu').name, 'z', 'a real 0 beats a blank');
});

test('heap figures and gauge levels', () => {
  assert.deepEqual(O.heapFigures(NODES[0]), { percent: 61, current: 10522669875, max: 17179869184 });
  assert.deepEqual(O.heapFigures(NODES[1]), { percent: 55, current: null, max: null });
  assert.deepEqual(O.heapFigures(null), { percent: null, current: null, max: null });
});

test('busiest first: CPU, then heap, unknown CPU last; the given list is not reordered', () => {
  const given = [NODES[2], NODES[1], NODES[0]];
  assert.deepEqual(O.busiestFirst(given).map((n) => n.name), ['node-1', 'node-2', 'node-3']);
  assert.deepEqual(given.map((n) => n.name), ['node-3', 'node-2', 'node-1']);
  assert.deepEqual(O.busiestFirst(null), []);
});

test('the Nodes card counts roles and names the master with its uptime; no list is null', () => {
  assert.deepEqual(O.nodeCounts(NODES), { total: 3, data: 2, masterEligible: 3, masterName: 'node-1', uptime: '10d' });
  assert.equal(O.nodeCounts([]), null);
  assert.deepEqual(O.nodeCounts([{ name: 'x', master: '-', 'node.role': 'd' }]), { total: 1, data: 1, masterEligible: 0, masterName: null, uptime: null });
});

test('shard figures from health: primaries, total, the split, the assigned share; health unread is null', () => {
  const f = O.shardFigures({ active_shards: 68, active_primary_shards: 35, relocating_shards: 0, initializing_shards: 0, unassigned_shards: 1 });
  assert.deepEqual([f.primary, f.total, f.assigned, f.moving, f.unassigned], [35, 69, 68, 0, 1]);
  assert.ok(Math.abs(f.pct - (68 / 69) * 100) < 1e-9);
  assert.equal(O.placedText(f), '68 of 69 shards placed');
  assert.equal(O.shardFigures(null), null);
  assert.equal(O.placedText(null), '');
  const moving = O.shardFigures({ active_shards: 10, relocating_shards: 2, initializing_shards: 1, unassigned_shards: 0 });
  assert.equal(moving.moving, 3);
  assert.equal(moving.primary, null, 'no primaries figure: not known, not 0');
});

const IDX = [
  { index: 'g-big', health: 'green', size: 100, docs: 5, pri: 1, rep: 1 },
  { index: 'y-small', health: 'yellow', size: 1, docs: 1, pri: 2, rep: 0 },
  { index: 'g-small', health: 'green', size: 10, docs: 2, pri: 1, rep: 2 },
  { index: 'r', health: 'red', size: 50, docs: 0, pri: '', rep: 1 },
  { index: 'unknown', size: 999, docs: 9, pri: 3, rep: 1 },
];

test('indices unhealthy first (red, yellow, green, unknown), then by size, then A–Z', () => {
  assert.deepEqual(O.unhealthyFirst(IDX).map((r) => r.index), ['r', 'y-small', 'g-big', 'g-small', 'unknown']);
  assert.deepEqual(O.unhealthyFirst(null), []);
  assert.deepEqual(O.indexHealthCounts(IDX), { red: 1, yellow: 1, green: 2, total: 5 });
  assert.deepEqual(O.indexTotals(IDX), { docs: 17, size: 1160, note: '1 red index counted in part' });
  assert.deepEqual(IDX.map(O.indexShards), [2, 2, 3, null, 6], 'primaries × (1 + replicas); no primary count is null');
});

test('this cluster\'s alerts: count, worst, the two worst titles', () => {
  const c1 = { id: 'c1' }, c2 = { id: 'c2' };
  const list = [
    { cluster: c1, level: 'warning', title: 'w1' }, { cluster: c2, level: 'critical', title: 'other' },
    { cluster: c1, level: 'critical', title: 'crit' }, { cluster: c1, level: 'high', title: 'hi' }, { level: 'critical', title: 'no cluster' },
  ];
  assert.deepEqual(O.clusterAlerts(list, 'c1'), { count: 3, worst: 'critical', titles: ['crit', 'hi'] });
  assert.deepEqual(O.clusterAlerts(list, 'c3'), { count: 0, worst: null, titles: [] });
  assert.deepEqual(O.clusterAlerts(null, 'c1'), { count: 0, worst: null, titles: [] });
});

test('long-running searches: over a minute, searches only, longest first; not a list is null (not readable)', () => {
  const rows = [
    { action: 'indices:data/read/search', node: 'node-1', running_time_ns: '130000000000', description: 'indices[logstash-*]   terms(src_hostname)' },
    { action: 'indices:data/read/search', node: 'node-2', running_time_ns: '42000000000', description: 'short one' },
    { action: 'cluster:monitor/tasks/lists', node: 'node-1', running_time_ns: '900000000000', description: 'not a search' },
    { action: 'indices:data/read/search[phase/query]', node: 'node-3', running_time: '2.5m', description: 'from the time string' },
  ];
  const got = O.longRunningSearches(rows);
  assert.deepEqual(got.map((t) => [t.node, Math.round(t.ms / 1000)]), [['node-3', 150], ['node-1', 130]]);
  assert.equal(got[1].description, 'indices[logstash-*] terms(src_hostname)', 'whitespace folded to one line');
  assert.deepEqual(O.longRunningSearches([]), []);
  assert.equal(O.longRunningSearches(null), null);
  assert.equal(O.longRunningSearches(undefined), null);
  assert.equal(O.LONG_SEARCH_MS, 60000);
});

test('the operation pill: running is green, anything else red, not read grey', () => {
  assert.deepEqual(O.operationPill('RUNNING'), { tone: 'green', word: 'running' });
  assert.deepEqual(O.operationPill('STOPPING'), { tone: 'red', word: 'stopping' });
  assert.deepEqual(O.operationPill(undefined), { tone: 'grey', word: 'not read' });
});

const T0 = Date.UTC(2026, 10, 14, 2, 10);
const CLUSTER = { id: 'c1', name: 'c1', url: 'http://c1:9200', liveRetention: '30d' };
const DEFAULTS = { logIndexPattern: 'logstash-*' };
const SLM_D = {
  slmStatus: { operation_mode: 'RUNNING' },
  slm: [{ id: 'daily-logs', policy: { schedule: '0 10 2 * * ?', repository: 'daily', config: { indices: ['logstash-*'] } }, last_success: { time: T0, snapshot_name: 'daily-1' } }],
  snapshots: { daily: [{ id: 'daily-1', status: 'SUCCESS', start: T0, duration: 760000, indices: 95 }] },
};

test('the SLM line: the policy taking the logs, its last run with the snapshot\'s own duration and index count', () => {
  const s = O.slmSummary(SLM_D, CLUSTER, DEFAULTS);
  assert.deepEqual([s.pill.word, s.kind, s.policy, s.status, s.at, s.durationMs, s.indices], ['running', 'ok', 'daily-logs', 'Success', T0, 760000, 95]);
  const none = O.slmSummary({ slmStatus: { operation_mode: 'RUNNING' }, slm: [] }, CLUSTER, DEFAULTS);
  assert.equal(none.kind, 'none', 'running with no policy for the logs is "no policy"');
  const unread = O.slmSummary({}, CLUSTER, DEFAULTS);
  assert.deepEqual([unread.pill.word, unread.kind], ['not read', 'unknown'], 'SLM status not read is not "no policy"');
  const stopped = O.slmSummary({ slmStatus: { operation_mode: 'STOPPED' }, slm: SLM_D.slm }, CLUSTER, DEFAULTS);
  assert.deepEqual([stopped.pill.tone, stopped.kind], ['red', 'stopped']);
});

test('the ILM line: managed count, the past-retention figure from the index dates, the errors; unread is unknown', () => {
  const now = Date.UTC(2026, 10, 14);
  const idx = [
    { index: 'logstash-a-2026.09.01', day: '2026-09-01', size: 100 }, { index: 'logstash-a-2026.10.01', day: '2026-10-01', size: 50 },
    { index: 'logstash-a-2026.11.13', day: '2026-11-13', size: 10 }, { index: 'undated', day: null, size: 999 },
  ];
  const d = { ilm: { operation_mode: 'RUNNING' }, ilmOfIndex: { 'logstash-a-2026.09.01': 'p', 'logstash-a-2026.10.01': 'p', 'logstash-a-2026.11.13': 'p' }, ilmErrors: { 'logstash-a-2026.10.01': { step: 'ERROR' } } };
  const s = O.ilmSummary(d, CLUSTER, DEFAULTS, idx, now);
  assert.deepEqual([s.pill.word, s.known, s.managed, s.total, s.errors], ['running', true, 3, 3, 1]);
  assert.deepEqual(s.stale, { count: 2, bytes: 150, policy: '30 days', known: true }, 'two dated indices are older than 30 days; the undated one is not guessed');
  const noRet = O.ilmSummary(d, { ...CLUSTER, liveRetention: undefined }, DEFAULTS, idx, now);
  assert.deepEqual([noRet.stale.known, noRet.stale.policy], [false, ''], 'no retention set: not known, not 0');
  const unread = O.ilmSummary({}, CLUSTER, DEFAULTS, null, now);
  assert.deepEqual([unread.pill.word, unread.known, unread.managed, unread.errors], ['not read', false, null, null]);
});

test('the Devices & log delay card: the last run’s devices, the late counts by the configured levels, the boards’ own words', () => {
  const LEVELS = { delayFrom: 30, criticalOver: 60 };
  const now = Date.now();
  const res = { ok: true, devicesInLastRun: 120, totals: { onTime: 99, delay: 14, critical: 7, otherTz: 0, silent: 0 },
    byCluster: [{ id: 'c1', levels: LEVELS, lastRunAt: now - 3600000 }], schedule: { supported: true, enabled: true, everyHours: 2, state: { nextDueAt: now + 3600000 } } };
  const d = O.devicesDelay(res, 'c1');
  assert.deepEqual([d.state, d.inLastRun, d.delay, d.critical, d.late, d.lastRunAt, d.nextDueAt], ['ok', 120, 14, 7, 21, now - 3600000, now + 3600000]);
  assert.deepEqual([d.bands.mid, d.bands.high, d.bands.lateShort], ['30–60 min', 'Above 60 min', '30+ min']);
  const never = O.devicesDelay({ ...res, byCluster: [{ id: 'c1', levels: LEVELS, lastRunAt: null }] }, 'c1');
  assert.deepEqual([never.state, never.message, never.inLastRun], ['never', 'never measured: not in the scheduled measurement yet', null]);
  const off = O.devicesDelay({ ...res, schedule: { ...res.schedule, enabled: false } }, 'c1');
  assert.deepEqual([off.state, off.message, off.late], ['off', 'The scheduled measurement is switched off; the figures stop at its last run.', 21]);
  const unsupported = O.devicesDelay({ ...res, schedule: { supported: false } }, 'c1');
  assert.equal(unsupported.state, 'unsupported');
  assert.equal(O.devicesDelay({ ok: false, unsupported: true, message: 'old core' }, 'c1').state, 'unsupported');
  assert.equal(O.devicesDelay({ ok: false, message: 'boom' }, 'c1').state, 'error');
  assert.equal(O.devicesDelay(null, 'c1').state, 'none');
  const noTotals = O.devicesDelay({ ...res, totals: {} }, 'c1');
  assert.deepEqual([noTotals.delay, noTotals.critical, noTotals.late], [null, null, null], 'a count the core did not give is not 0');
  // Part delayed (0.3.90): said only where the core measures log types, beside the delayed devices and never in them.
  assert.equal(d.part, undefined, 'a core without log types');
  const typed = O.devicesDelay({ ...res, totals: { ...res.totals, partDelayed: 5, pctPartDelayed: 4.2, logTypes: { total: 300, late: 9, above: 3 } }, byCluster: [{ ...res.byCluster[0], logTypeField: 'log_type' }] }, 'c1');
  assert.deepEqual([typed.part.count, typed.part.late, typed.late], [5, 9, 21]);
  const off0 = O.devicesDelay({ ...res, totals: { ...res.totals, partDelayed: 0 }, byCluster: [{ ...res.byCluster[0], logTypeField: null, logTypeWhy: 'log_type is not in the mapping' }] }, 'c1');
  assert.deepEqual([off0.part.count, off0.part.why], [null, 'log_type is not in the mapping'], 'no field: not 0 part delayed');
});

test('rate text: null is a dash, small rates keep a decimal, large ones are whole', () => {
  assert.equal(O.rateText(null), '–');
  assert.equal(O.rateText(undefined), '–');
  assert.equal(O.rateText(0.3), '0.3');
  assert.equal(O.rateText(14.2), '14.2');
  assert.equal(O.rateText(38), '38');
  assert.equal(O.rateText(1840), (1840).toLocaleString());
});
