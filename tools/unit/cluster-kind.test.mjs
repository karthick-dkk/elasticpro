/**
 * Cluster type and ULM (core/cluster-kind.js) — the defaults each type carries, where the
 * settings are read from (the clusters file on desktop, the core's store hosted), and the
 * one thing they change: a CI / DI cluster with no SLM raises no "SLM not running", "no
 * snapshots" or "no recent snapshot", while a policy it does have that fails still raises.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const ck = await load('ui/js/core/cluster-kind.js');
const sc = await load('ui/js/core/server-credentials.js');
const st = await load('ui/js/core/state.js');
const lc = await load('ui/js/core/lifecycle-errors.js');

const kind = (c) => { const k = ck.clusterKind(c); return [k.type, k.ulm.enabled, k.slmExpected, ck.slmExempt(c)]; };

test('each type carries its defaults; an unknown type is On-Prem', () => {
  sc.setHostedEdition(false);
  assert.deepEqual(kind({ id: 'a', type: 'ci' }), ['ci', true, false, true]);
  assert.deepEqual(kind({ id: 'a', type: 'DI' }), ['di', true, false, true]);
  assert.deepEqual(kind({ id: 'a', type: 'On-Prem' }), ['onprem', false, true, false]);
  assert.deepEqual(kind({ id: 'a' }), ['onprem', false, true, false], 'not set: On-Prem');
  assert.deepEqual(kind({ id: 'a', type: 'cloud' }), ['onprem', false, true, false], 'unknown: On-Prem');
  assert.deepEqual(kind(null), ['onprem', false, true, false]);
  assert.equal(ck.typeLabel('onprem'), 'On-Prem');
});

test('desktop: the cluster file keys override either half of the default', () => {
  sc.setHostedEdition(false);
  assert.deepEqual(kind({ id: 'a', type: 'ci', slm: 'expected' }), ['ci', true, true, false], 'a CI cluster that does take snapshots');
  assert.deepEqual(kind({ id: 'a', type: 'ci', ulm: false }), ['ci', false, false, false], 'no ULM: no exemption');
  assert.deepEqual(kind({ id: 'a', type: 'onprem', ulm: { enabled: true }, slm: 'none' }), ['onprem', true, false, true]);
  assert.equal(ck.clusterKind({ id: 'a', type: 'ci', ulm: { bucket: 'acme-logs' } }).ulm.bucket, 'acme-logs');
  assert.equal(ck.clusterKind({ id: 'a', type: 'ci', logBucket: 'old-logs' }).ulm.bucket, 'old-logs', 'the bucket named before 0.3.47');
  assert.equal(ck.ulmLabel({ id: 'a', type: 'ci', ulm: { bucket: 'acme-logs' } }), 'ULM · s3 acme-logs');
  assert.deepEqual(ck.clusterKind({ id: 'a', type: 'ci' }).set, { type: true, ulm: false, slm: false });
});

test('hosted: the core’s store, not the file keys', () => {
  sc.setHostedEdition(true);
  try {
    ck.setClusterMeta({
      z1: { type: 'ci', ulm: { bucket: 'acme-logs' }, source: 'zabbix-tag' },
      z2: { type: 'di', ulm: { enabled: false, bucket: '' }, source: 'set' },
    });
    assert.deepEqual(kind({ id: 'z1' }), ['ci', true, false, true]);
    assert.equal(ck.clusterKind({ id: 'z1' }).source, 'zabbix-tag');
    assert.deepEqual(kind({ id: 'z2' }), ['di', false, false, false]);
    assert.deepEqual(kind({ id: 'z3', type: 'ci' }), ['onprem', false, true, false], 'no entry: defaults, never the file keys');
    const r0 = ck.clusterKindRev();
    ck.setClusterMeta({});
    assert.ok(ck.clusterKindRev() > r0, 'a change moves the redraw signature');
  } finally {
    ck.setClusterMeta({});
    sc.setHostedEdition(false);
  }
});

test('types and bucket names are checked as the core checks them', () => {
  assert.equal(ck.normalizeType('On_Prem'), 'onprem');
  assert.equal(ck.normalizeType('x'), '');
  for (const ok of ['', 'abc', 'acme-logs', 'acme.logs.2026']) assert.equal(ck.bucketProblem(ok), '', ok);
  for (const bad of ['ab', 'Acme', 'acme_logs', '-acme', 'acme-', 'acme..logs', '192.168.1.10', 'a'.repeat(64)]) {
    assert.notEqual(ck.bucketProblem(bad), '', bad);
  }
});

/* ---------------------------------- the alert rules ---------------------------------- */

const OLD = Date.now() - 30 * 24 * 3600 * 1000;
/** A reachable cluster with a repository holding nothing, SLM stopped and a policy whose last success is old. */
const quiet = (failing = false) => ({
  reachable: true, updatedAt: Date.now(), health: { status: 'green', unassigned_shards: 0 },
  repos: [{ name: 'r1', type: 'fs' }], snapshots: { r1: [] },
  slmStatus: { operation_mode: failing ? 'RUNNING' : 'STOPPED' },
  slm: [{ id: 'daily', policy: { repository: 'r1', schedule: '0 30 1 * * ?' },
    last_success: { time: OLD }, ...(failing ? { last_failure: { time: Date.now() - 3600e3, details: 'repository missing' } } : {}) }],
});
function withClusters(list, data) {
  sc.setHostedEdition(false);
  st.state.config = { clusters: list.map((c) => ({ url: `http://${c.id}:9200`, enabled: true, source: 'file', name: c.id, ...c })), raw: {} };
  st.state.data = new Map(Object.entries(data));
  st.invalidateAlerts();
}

test('a CI cluster with no SLM raises nothing about snapshots', () => {
  withClusters([{ id: 'ci1', type: 'ci' }, { id: 'op1', type: 'onprem' }], { ci1: quiet(), op1: quiet() });
  const all = st.alerts();
  const of = (id) => all.filter((a) => a.cluster && a.cluster.id === id).map((a) => a.key);
  assert.deepEqual(of('ci1'), [], `CI: ${of('ci1').join(', ')}`);
  const op = of('op1');
  assert.ok(op.includes('op1:slm-mode'), op.join(', '));
  assert.ok(op.includes('op1:repo:r1:none'), op.join(', '));
});

test('a CI cluster whose existing SLM policy fails still raises it', () => {
  withClusters([{ id: 'ci2', type: 'ci' }], { ci2: quiet(true) });
  const keys = st.alerts().filter((a) => a.cluster && a.cluster.id === 'ci2').map((a) => a.key);
  assert.ok(keys.includes('ci2:slm-fail:daily'), keys.join(', '));
  assert.ok(!keys.some((k) => /slm-stale|slm-mode|:none$|:stale$/.test(k)), keys.join(', '));
});

test('a CI cluster whose snapshots fail still raises the failing repository', () => {
  const d = quiet();
  d.snapshots.r1 = [{ id: 's2', status: 'FAILED', start: Date.now() - 1e6 }, { id: 's1', status: 'FAILED', start: Date.now() - 2e6 }];
  withClusters([{ id: 'ci3', type: 'ci' }], { ci3: d });
  const keys = st.alerts().filter((a) => a.cluster && a.cluster.id === 'ci3').map((a) => a.key);
  assert.ok(keys.includes('ci3:repo:r1:failing'), keys.join(', '));
});

test('the SLM pill says "Not used", not red, for an exempt cluster', () => {
  sc.setHostedEdition(false);
  const v = lc.lifecycleView('SLM', quiet(), 'logstash-*', { id: 'x', type: 'ci', ulm: { bucket: 'acme-logs' } });
  assert.equal(v.tone, 'grey');
  assert.equal(v.word, 'Not used');
  assert.match(v.why, /ULM · s3 acme-logs/);
  assert.equal(lc.lifecycleView('SLM', quiet(), 'logstash-*', { id: 'x', type: 'onprem' }).tone, 'red');
});
