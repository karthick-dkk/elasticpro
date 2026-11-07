/** What the expanded Clusters row is drawn from (core/cluster-boxes.js): disk lines, free size, the red/yellow list, donuts, the Backups card. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const B = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/cluster-boxes.js')).href);
const LC = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/lifecycle-errors.js')).href);

const DW = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/disk-balance.js')).href);
const K = (n) => `cluster.routing.allocation.disk.watermark.${n}`;

test('disk level is the cluster\'s own watermarks (one definition: Size %, Disk bar and nodes agree); unread settings give no level', () => {
  const lvl = (pct, settings) => DW.diskAgainstWatermarks({ percent: pct }, settings).level;
  const dflt = { persistent: {}, transient: {}, defaults: { [K('low')]: '85%', [K('high')]: '90%', [K('flood_stage')]: '95%' } };
  assert.deepEqual([84.9, 85, 89.9, 90].map((p) => lvl(p, dflt)), ['ok', 'low', 'low', 'high']);
  const own = { persistent: { [K('low')]: '70%', [K('high')]: '80%' }, transient: {}, defaults: dflt.defaults };
  assert.deepEqual([69, 75, 85].map((p) => lvl(p, own)), ['ok', 'low', 'high'], 'a cluster with its own watermarks is coloured by them, not by 85/90');
  assert.equal(lvl(91, undefined), 'unknown', 'settings never read: no colour, not a guess');
  assert.equal(lvl(NaN, dflt), 'unknown');
});

test('free size: total minus used, else avail, else unknown (never 0 B)', () => {
  assert.equal(B.nodeFreeBytes({ 'disk.total': '8000', 'disk.used': '7280' }), 720);
  assert.equal(B.nodeFreeBytes({ 'disk.total': '100', 'disk.used': '120' }), 0, 'over-full is 0, not negative');
  assert.equal(B.nodeFreeBytes({ 'disk.avail': '55' }), 55, 'avail when total/used are missing');
  assert.equal(B.nodeFreeBytes({ 'disk.total': '', 'disk.used': '', 'disk.avail': '55' }), 55, 'empty strings are not 0');
  assert.equal(B.nodeFreeBytes({}), null);
  assert.equal(B.nodeFreeBytes(null), null);
});

test('a data node is one with data or any data_* role', () => {
  assert.equal(B.isDataNode(['master']), false);
  assert.equal(B.isDataNode(['master', 'ingest']), false);
  assert.equal(B.isDataNode(['data_hot']), true);
  assert.equal(B.isDataNode(['data_content', 'ingest']), true);
  assert.equal(B.isDataNode(['data']), true);
  assert.equal(B.isDataNode([]), false, 'coordinating-only holds no data');
});

test('role chips: every data role is one plain "data" chip, tiers only in its tooltip; the rest is counted', () => {
  assert.deepEqual(B.roleChips([]).chips.map((c) => c.label), ['coordinating']);
  const one = B.roleChips(['master']);
  assert.deepEqual([one.chips.map((c) => c.label), one.more], [['master'], []]);
  const hot = B.roleChips(['data_hot', 'data_content', 'ingest']);
  assert.deepEqual(hot.chips.map((c) => c.label), ['data', 'ingest'], 'two data roles are one data chip');
  assert.equal(hot.chips[0].kind, 'other', 'plain: no tier colour');
  assert.equal(hot.chips[0].title, 'Data tiers: hot, content');
  const all = B.roleChips(['master', 'data_hot', 'data_warm', 'data_cold', 'data_frozen', 'data_content', 'ingest', 'ml', 'transform', 'remote_cluster_client']);
  assert.deepEqual(all.chips.map((c) => c.label), ['master', 'data', 'ingest']);
  assert.ok(!all.chips.some((c) => /hot|warm|cold|frozen|·/.test(c.label)), 'no tier is listed on a chip');
  assert.equal(all.chips[1].title, 'Data tiers: hot, warm, cold, frozen, content');
  assert.deepEqual(all.chips[1].roles, ['data_hot', 'data_warm', 'data_cold', 'data_frozen', 'data_content']);
  assert.deepEqual(all.more, ['ml', 'transform', 'remote_cluster_client'], '+3 and the names for the tooltip');
  const plain = B.roleChips(['data', 'master']);
  assert.deepEqual([plain.chips.map((c) => c.label), plain.chips[0].title], [['data', 'master'], 'data (every tier)']);
  assert.equal(B.roleChips(['data', 'data_hot']).chips[0].title, 'Data tiers: hot (and the generic data role)');
});

test('the nodes header: counts, master-eligible, data with tiers, the elected master', () => {
  const lists = [['master'], ['master'], ['master'], ['data_hot', 'ingest'], ['data_hot'], ['data_warm']];
  assert.equal(B.nodesSummary(lists, true), '6 · 3 master-eligible · 3 data (2 hot, 1 warm) · ★ elected master');
  assert.equal(B.nodesSummary([['master', 'data', 'ingest']], true), '1 · 1 master-eligible · 1 data · ★ elected master');
  assert.equal(B.nodesSummary([['data']], false), '1 · 0 master-eligible · 1 data');
});

test('the health list: a red cluster lists red indices only, yellow lists yellow only, green nothing', () => {
  const rows = [
    { index: 'b', health: 'yellow', pri: '1', rep: '1' }, { index: 'a', health: 'red', pri: '1', rep: '1' },
    { index: 'c', health: 'green', pri: '1', rep: '1' }, { index: 'd', health: 'yellow', pri: '3', rep: '1' },
  ];
  assert.deepEqual(B.problemIndices('red', rows).rows.map((r) => r.index), ['a']);
  assert.deepEqual(B.problemIndices('yellow', rows).rows.map((r) => r.index), ['b', 'd'], 'sorted by name');
  assert.equal(B.problemIndices('green', rows), null);
  assert.equal(B.problemIndices('unreachable', rows), null);
  assert.equal(B.problemIndices(undefined, rows), null);
  assert.deepEqual(B.problemIndices('red', null).rows, [], 'an answer that is not a list is no rows, not a throw');
  assert.equal(B.problemIndices('yellow', rows).rows[1].pri, 3, 'figures are numbers');
  assert.equal(B.problemButtonText('yellow', 2), '2 yellow indices');
  assert.equal(B.problemButtonText('red', 1), '1 red index');
});

test('unassigned shards per index, in words, with the reason code or explain sentence', () => {
  const m = B.unassignedByIndex([
    { index: 'a', shard: '0', prirep: 'r', state: 'UNASSIGNED', 'unassigned.reason': 'NODE_LEFT' },
    { index: 'a', shard: '1', prirep: 'r', state: 'UNASSIGNED', 'unassigned.reason': 'NODE_LEFT' },
    { index: 'a', shard: '0', prirep: 'p', state: 'STARTED', 'unassigned.reason': '' },
    { index: 'b', shard: '0', prirep: 'p', state: 'UNASSIGNED', 'unassigned.reason': 'ALLOCATION_FAILED' },
    { index: 'b', shard: '0', prirep: 'r', state: 'UNASSIGNED', 'unassigned.reason': 'REPLICA_ADDED' },
  ]);
  const only = B.unassignedByIndex([{ index: 'a', prirep: 'r', state: 'UNASSIGNED' }, { index: 'z', prirep: 'r', state: 'UNASSIGNED' }], ['a']);
  assert.deepEqual([...only.keys()], ['a'], 'one cluster-wide listing, filtered to the indices the list shows');
  assert.equal(B.unassignedText(m.get('a')), '2 replicas');
  assert.equal(B.unassignedText(m.get('b')), '1 primary, 1 replica');
  assert.equal(B.unassignedText(undefined), null);
  assert.equal(B.reasonFor('a', m, null).text, 'a node left the cluster');
  assert.equal(B.reasonFor('a', m, null).source, 'unassigned.reason');
  assert.equal(B.reasonFor('b', m, null).text, 'allocation failed, replica added');
  assert.equal(B.reasonFor('zzz', m, null), null, 'no shard data for it: unknown, not a guess');
  const ex = B.explainLine({ index: 'a', node_allocation_decisions: [{ node_name: 'n1', deciders: [{ decision: 'YES', explanation: 'fine' }, { decision: 'NO', explanation: 'over the high watermark' }] }] });
  assert.deepEqual(ex, { index: 'a', text: 'n1: over the high watermark' });
  assert.deepEqual(B.reasonFor('a', m, ex), { text: 'n1: over the high watermark', source: 'allocation explain' });
  assert.equal(B.reasonFor('b', m, ex).source, 'unassigned.reason', 'explain covers the one shard it named');
  assert.equal(B.explainLine({ error: { type: 'illegal_argument_exception' } }), null);
  assert.equal(B.explainLine(null), null);
});

test('donut segments sum to the whole ring; an empty total is an empty ring', () => {
  const segs = B.donutSegments([{ key: 'a', n: 1406 }, { key: 'i', n: 4 }, { key: 'u', n: 0 }, { key: 'x', n: 2 }]);
  assert.deepEqual(segs.map((s) => s.key), ['a', 'i', 'x'], 'zero parts are skipped');
  assert.ok(Math.abs(segs.reduce((s, x) => s + x.len, 0) - 100) < 1e-9);
  assert.equal(segs[0].offset, -0);
  assert.ok(Math.abs(segs[1].offset + segs[0].len) < 1e-9, 'each segment starts where the last ended');
  assert.deepEqual(B.donutSegments([{ key: 'a', n: 0 }]), []);
  assert.deepEqual(B.donutSegments([]), []);
});

test('shard allocation card: the pill follows unassigned, initializing, relocating', () => {
  const h = (o) => ({ status: 'green', active_shards: 100, relocating_shards: 0, initializing_shards: 0, unassigned_shards: 0, active_shards_percent_as_number: 100, ...o });
  assert.equal(B.shardCard(null), null, 'health not read is unknown, not Healthy');
  assert.deepEqual(B.shardCard(h({})).pill, { tone: 'green', text: 'Healthy' });
  assert.equal(B.shardCard(h({})).figure, '100.0%');
  assert.deepEqual(B.shardCard(h({ status: 'yellow', unassigned_shards: 2 })).pill, { tone: 'yellow', text: '2 unassigned' });
  assert.deepEqual(B.shardCard(h({ status: 'red', unassigned_shards: 2 })).pill, { tone: 'red', text: '2 unassigned' });
  assert.deepEqual(B.shardCard(h({ initializing_shards: 4 })).pill, { tone: 'yellow', text: '4 initializing' });
  assert.deepEqual(B.shardCard(h({})).parts.map((p) => p.key), ['active', 'init', 'unas']);
  assert.deepEqual(B.shardCard(h({ relocating_shards: 1 })).parts.map((p) => p.key), ['active', 'reloc', 'init', 'unas'], 'relocating is listed only when something moves');
  assert.equal(B.shardCard(h({ active_shards_percent_as_number: undefined })).figure, null);
});

const ilmData = (of, errors = {}, mode = 'RUNNING') => ({ ilm: { operation_mode: mode }, ilmOfIndex: of, ilmErrors: errors });

test('ILM card: managed / error / no policy, the pill and when the Indices link is offered', () => {
  const all = { 'logstash-1': 'p', 'logstash-2': 'p', 'logstash-3': 'p' };
  const ok = B.ilmCard(ilmData(all), 'logstash-*');
  assert.deepEqual([ok.known, ok.pill.text, ok.managed, ok.total, ok.link], [true, 'Healthy', 3, 3, false]);
  const err = B.ilmCard(ilmData(all, { 'logstash-2': { step: 'ERROR' } }), 'logstash-*');
  assert.deepEqual([err.pill, err.managed, err.parts.map((p) => p.n), err.link], [{ tone: 'yellow', text: '1 error' }, 3, [2, 1, 0], false]);
  const none = B.ilmCard(ilmData({ 'logstash-1': null, 'logstash-2': null, 'logstash-3': null }), 'logstash-*');
  assert.deepEqual([none.pill.text, none.managed, none.total, none.link, none.noPolicy.length], ['Logs not covered', 0, 3, true, 3]);
  const both = B.ilmCard(ilmData({ 'logstash-1': 'p', 'logstash-2': null }, { 'logstash-1': { step: 'ERROR' } }), 'logstash-*');
  assert.equal(both.link, false, 'no link when a log index is in error (owner)');
  assert.equal(B.ilmCard(ilmData(all, {}, 'STOPPED'), 'logstash-*').pill.text, 'Stopped');
  assert.equal(B.ilmCard({ ilm: { operation_mode: 'RUNNING' } }, 'logstash-*').known, false, 'which policy each index has is not known: no donut figures');
  assert.equal(B.ilmCard({}, 'logstash-*').pill.text, 'Unknown');
  assert.equal(B.ilmCard(ilmData({ 'other-1': 'p' }), 'logstash-*').pill.text, 'No log index');
});

const slmData = (policies, mode = 'RUNNING') => ({ slmStatus: { operation_mode: mode }, slm: policies });
const pol = (id, indices, lastOk, lastFail) => ({ id, policy: { schedule: '0 30 2 * * ?', config: indices ? { indices } : {} },
  last_success: lastOk ? { time: lastOk, snapshot_name: 's' } : undefined, last_failure: lastFail ? { time: lastFail, details: 'x' } : undefined });
const view = (d, c = null) => LC.lifecycleView('SLM', d, 'logstash-*', c);

test('Backups card: the policy that takes logstash-* (wildcard), its newest run, or why not', () => {
  const d = slmData([pol('nightly-logs', ['logstash-*'], 2000, 1000), pol('other', ['audit-*'], 5000)]);
  const ok = B.slmCard(d, view(d), 'logstash-*', {});
  assert.deepEqual([ok.kind, ok.policy, ok.status, ok.at, ok.pill.text], ['ok', 'nightly-logs', 'Success', 2000, 'SLM Running']);
  const failed = slmData([pol('nightly-logs', ['logstash-2026*'], 1000, 3000)]);
  assert.deepEqual([B.slmCard(failed, view(failed), 'logstash-*', {}).status, B.slmCard(failed, view(failed), 'logstash-*', {}).at], ['Failed', 3000], 'a wildcard on logstash-2026* counts, and the newest run is the failure');
  const never = slmData([pol('p', ['logstash-*'])]);
  assert.deepEqual([B.slmCard(never, view(never), 'logstash-*', {}).kind, B.slmCard(never, view(never), 'logstash-*', {}).status], ['ok', null]);
  const star = slmData([pol('all', null, 10)]);
  assert.equal(B.slmCard(star, view(star), 'logstash-*', {}).policy, 'all', 'no selection means every index');
  const none = slmData([pol('other', ['audit-*'], 5000)]);
  const n = B.slmCard(none, view(none), 'logstash-*', {});
  assert.deepEqual([n.kind, n.logs], ['none', 'logstash-*']);
  assert.equal(B.slmCard(slmData([], 'STOPPED'), view(slmData([], 'STOPPED')), 'logstash-*', {}).pill.text, 'SLM Stopped');
  assert.equal(B.slmCard({}, view({}), 'logstash-*', {}).kind, 'unknown');
  assert.equal(B.slmCard({ slmSupported: false }, view({ slmSupported: false }), 'logstash-*', {}).pill.text, 'n/a');
  assert.equal(B.slmCard({ slmStatus: { operation_mode: 'RUNNING' } }, view({ slmStatus: { operation_mode: 'RUNNING' } }), 'logstash-*', {}).kind, 'unread', 'policies not read: unknown, not "no policy"');
});

test('ULM on: SLM is Not used - the summary cell and the card read the same view, even when SLM runs', () => {
  const d = slmData([pol('nightly-logs', ['logstash-*'], 2000)]);
  const cluster = { id: 'x', type: 'ci', ulm: { bucket: 'client-a-logs' } };
  const v = view(d, cluster);
  assert.deepEqual([v.word, v.tone], ['Not used', 'grey']);
  const card = B.slmCard(d, v, 'logstash-*', { enabled: true, bucket: 'client-a-logs' });
  assert.deepEqual([card.kind, card.pill.text, card.note], ['unused', 'Not used', 'Logs archived by ULM to client-a-logs']);
  assert.equal(B.slmCard(d, v, 'logstash-*', { enabled: true, bucket: '' }).note, 'Logs archived by ULM');
  assert.equal(view(d, { id: 'y', type: 'onprem' }).word, 'Running', 'ULM off keeps the normal card');
});
