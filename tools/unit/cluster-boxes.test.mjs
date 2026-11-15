/** What the Overview cards read (core/cluster-boxes.js): disk lines, data nodes, unassigned shards, the ILM and Backups cards. */
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

test('a data node is one with data or any data_* role', () => {
  assert.equal(B.isDataNode(['master']), false);
  assert.equal(B.isDataNode(['master', 'ingest']), false);
  assert.equal(B.isDataNode(['data_hot']), true);
  assert.equal(B.isDataNode(['data_content', 'ingest']), true);
  assert.equal(B.isDataNode(['data']), true);
  assert.equal(B.isDataNode([]), false, 'coordinating-only holds no data');
});

test('unassigned shards per index, filtered to the indices asked for', () => {
  const m = B.unassignedByIndex([
    { index: 'a', shard: '0', prirep: 'r', state: 'UNASSIGNED', 'unassigned.reason': 'NODE_LEFT' },
    { index: 'a', shard: '1', prirep: 'r', state: 'UNASSIGNED', 'unassigned.reason': 'NODE_LEFT' },
    { index: 'a', shard: '0', prirep: 'p', state: 'STARTED', 'unassigned.reason': '' },
    { index: 'b', shard: '0', prirep: 'p', state: 'UNASSIGNED', 'unassigned.reason': 'ALLOCATION_FAILED' },
    { index: 'b', shard: '0', prirep: 'r', state: 'UNASSIGNED', 'unassigned.reason': 'REPLICA_ADDED' },
  ]);
  const only = B.unassignedByIndex([{ index: 'a', prirep: 'r', state: 'UNASSIGNED' }, { index: 'z', prirep: 'r', state: 'UNASSIGNED' }], ['a']);
  assert.deepEqual([...only.keys()], ['a'], 'one cluster-wide listing, filtered to the indices the list shows');
  assert.deepEqual([m.get('a').primaries, m.get('a').replicas], [0, 2]);
  assert.deepEqual([m.get('b').primaries, m.get('b').replicas], [1, 1]);
  assert.ok(!m.has('zzz'), 'no shard data for it: unknown, not a guess');
});

const ilmData = (of, errors = {}, mode = 'RUNNING') => ({ ilm: { operation_mode: mode }, ilmOfIndex: of, ilmErrors: errors });

test('ILM card: managed / error / no policy, the pill and when the Indices link is offered', () => {
  const all = { 'logstash-1': 'p', 'logstash-2': 'p', 'logstash-3': 'p' };
  const ok = B.ilmCard(ilmData(all), 'logstash-*');
  assert.deepEqual([ok.known, ok.pill.text, ok.managed, ok.total, ok.link], [true, 'Healthy', 3, 3, false]);
  const err = B.ilmCard(ilmData(all, { 'logstash-2': { step: 'ERROR' } }), 'logstash-*');
  assert.deepEqual([err.pill, err.managed, err.parts.map((p) => p.n), err.link], [{ tone: 'yellow', text: '1 error' }, 3, [2, 1, 0], false]);
  const none = B.ilmCard(ilmData({ 'logstash-1': null, 'logstash-2': null, 'logstash-3': null }), 'logstash-*');
  assert.deepEqual([none.state, none.pill, none.headline, none.managed, none.total, none.link, none.noPolicy.length],
    ['none', { tone: 'red', text: 'No policy' }, 'No policy for logstash-*', 0, 3, true, 3], 'confirmed by Elasticsearch: No policy, red, with the link');
  const some = B.ilmCard(ilmData({ 'logstash-1': 'p', 'logstash-2': null }), 'logstash-*');
  assert.deepEqual([some.state, some.pill.text, some.headline, some.link], ['some', 'Logs not covered', undefined, true], 'partly covered keeps the donut');
  const both = B.ilmCard(ilmData({ 'logstash-1': 'p', 'logstash-2': null }, { 'logstash-1': { step: 'ERROR' } }), 'logstash-*');
  assert.equal(both.link, false, 'no link when a log index is in error (owner)');
  assert.equal(B.ilmCard(ilmData(all, {}, 'STOPPED'), 'logstash-*').pill.text, 'Stopped');
  // Unknown is not zero: an unread answer is "Not known" (grey), never "No policy"; the permission sentence is a tooltip.
  const unread = B.ilmCard({ ilm: { operation_mode: 'RUNNING' } }, 'logstash-*');
  assert.deepEqual([unread.known, unread.state, unread.pill.tone, unread.pill.text, unread.headline], [false, 'unknown', 'grey', 'Not known', 'Not known'],
    'which policy each index has is not known: no donut figures, no "No policy"');
  assert.match(unread.pill.title, /^Which policy each logstash-\* index has could not be read \(it needs view_index_metadata on logstash-\*\)\.$/);
  assert.equal(unread.why, unread.pill.title);
  assert.equal(B.ilmCard({ ilm: { operation_mode: 'STOPPED' } }, 'logstash-*').pill.text, 'Stopped', 'stopped is known even when the policies are not');
  assert.equal(B.ilmCard({ ilm: { operation_mode: 'STOPPED' } }, 'logstash-*').headline, 'Not known');
  assert.deepEqual([B.ilmCard({}, 'logstash-*').pill.text, B.ilmCard({}, 'logstash-*').pill.tone], ['Not known', 'grey']);
  // No log index listed is not "none": _settings lists only what the account may see (a missing privilege answers {}).
  for (const of of [{}, { 'other-1': 'p' }]) {
    const c = B.ilmCard(ilmData(of), 'logstash-*');
    assert.deepEqual([c.known, c.state, c.pill.tone, c.pill.text, c.headline], [false, 'unknown', 'grey', 'Not known', 'Not known'], JSON.stringify(of));
    assert.match(c.pill.title, /^No open logstash-\* index was listed.*view_index_metadata on logstash-\*/);
  }
  // The latest ask failed: the earlier answer is kept but never shown as current.
  const failed = B.ilmCard({ ...ilmData({ 'logstash-1': null }), ilmOfIndexFailed: true }, 'logstash-*');
  assert.deepEqual([failed.state, failed.pill.text], ['unknown', 'Not known']);
  assert.match(failed.why, /^The latest ask .* failed/);
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
