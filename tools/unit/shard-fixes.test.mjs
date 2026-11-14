/**
 * Why a shard is unassigned and what to do (core/shard-fixes.js): every reason code has words and
 * a fix, a decider that names the fix wins over the code, and nothing is invented for a code the
 * mapping does not know.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const F = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/shard-fixes.js')).href);

const CODES = ['NODE_LEFT', 'ALLOCATION_FAILED', 'INDEX_CREATED', 'REPLICA_ADDED', 'CLUSTER_RECOVERED', 'DANGLING_INDEX_IMPORTED',
  'NEW_INDEX_RESTORED', 'EXISTING_INDEX_RESTORED', 'REROUTE_CANCELLED', 'REINITIALIZED', 'REALLOCATED_REPLICA', 'PRIMARY_FAILED',
  'FORCED_EMPTY_PRIMARY', 'MANUAL_ALLOCATION', 'INDEX_REOPENED', 'NODE_RESTARTING'];

test('every reason code Elasticsearch records has a title, a cause and a fix', () => {
  for (const c of CODES) {
    const r = F.REASONS[c];
    assert.ok(r, c);
    assert.ok(typeof r.title === 'string' && r.title.length > 3, `${c}.title`);
    for (const k of ['cause', 'fix']) assert.ok(typeof r[k] === 'string' && r[k].length > 20, `${c}.${k}`);
  }
});

const explain = (reason, deciders = [], more = {}) => ({
  index: 'logstash-beta-2026.09.09', shard: 0, primary: false, current_state: 'unassigned',
  unassigned_info: { reason, details: 'node_left [abc]' }, can_allocate: 'no',
  allocate_explanation: "Elasticsearch isn't allowed to allocate this shard to any of the nodes in the cluster.",
  node_allocation_decisions: [
    { node_name: 'node-1', node_decision: 'no', deciders: deciders.map((d) => ({ decider: d, decision: 'NO', explanation: `${d} said no` })) },
    { node_name: 'node-2', node_decision: 'no', deciders: [{ decider: 'same_shard', decision: 'YES', explanation: 'fine' }] },
  ],
  ...more,
});

test('refusals lists only the deciders that said NO, with the node', () => {
  assert.deepEqual(F.refusals(explain('NODE_LEFT', ['disk_threshold'])),
    [{ node: 'node-1', decider: 'disk_threshold', explanation: 'disk_threshold said no' }]);
  assert.deepEqual(F.refusals(null), []);
  assert.deepEqual(F.refusals({ node_allocation_decisions: 'nope' }), []);
});

test('a decider that names the fix wins over the code; the code alone otherwise; unknown is null', () => {
  assert.equal(F.fixFor('NODE_LEFT', ['disk_threshold']).title, 'Disk watermark');
  assert.equal(F.fixFor('NODE_LEFT', ['awareness']).title, 'Allocation awareness');
  assert.equal(F.fixFor('REPLICA_ADDED', ['filter']).title, 'Allocation filtering');
  assert.equal(F.fixFor('REPLICA_ADDED', ['same_shard']).title, 'Same shard');
  assert.equal(F.fixFor('ALLOCATION_FAILED', ['max_retry']).title, 'Retries exhausted');
  assert.equal(F.fixFor('INDEX_CREATED', ['enable']).title, 'Allocation switched off');
  assert.equal(F.fixFor('NODE_LEFT', []).title, 'Node left');
  assert.equal(F.fixFor('node_left', ['throttling']).title, 'Recoveries throttled');
  assert.equal(F.fixFor('SOMETHING_NEW', ['unheard_of']), null);
  assert.equal(F.fixFor('', []), null);
});

test('explainInWords puts the answer in words and keeps the cluster\'s own sentence', () => {
  const w = F.explainInWords(explain('NODE_LEFT', ['disk_threshold']));
  assert.equal(w.reason, 'NODE_LEFT');
  assert.equal(w.title, 'Node left');
  assert.match(w.cause, /left the cluster/);
  assert.match(w.explanation, /isn't allowed to allocate/);
  assert.equal(w.details, 'node_left [abc]');
  assert.equal(w.canAllocate, 'no');
  assert.equal(w.deciders.length, 1);
  assert.equal(w.fix.title, 'Disk watermark');
  assert.deepEqual(w.shard, { index: 'logstash-beta-2026.09.09', shard: 0, primary: false });
});

test('a code the mapping does not know is shown as the code, never as a guessed cause or fix', () => {
  const w = F.explainInWords(explain('BRAND_NEW_REASON'));
  assert.equal(w.title, 'brand new reason');
  assert.match(w.cause, /no words for/);
  assert.equal(w.fix, null);
  const none = F.explainInWords({ index: 'x', shard: 1, primary: true });
  assert.equal(none.reason, null);
  assert.equal(none.title, 'reason not recorded');
  assert.equal(none.fix, null);
  assert.equal(F.explainInWords(null), null);
});

test('explainBody is the body the REST console is opened with', () => {
  assert.deepEqual(F.explainBody('idx', '3', false), { index: 'idx', shard: 3, primary: false });
});
