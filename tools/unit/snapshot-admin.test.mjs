/**
 * SLM Edit / Delete and the snapshot list's bulk delete (ui/js/core/snapshot-admin.js): the
 * form read from a policy, its checks, the PUT body that keeps every key it does not show, and
 * the DELETE batches that stay short enough for a request line. Pure: no DOM, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const X = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-admin.js')).href);

const ENTRY = {
  version: 4, modified_date_millis: 1,
  policy: {
    name: '<daily-{now/d}>', schedule: '0 30 1 * * ?', repository: 'daily',
    config: { indices: ['logstash-*', 'metrics-*'], include_global_state: false, ignore_unavailable: true,
      partial: true, feature_states: ['kibana'], metadata: { owner: 'ops', ticket: 42 } },
    retention: { expire_after: '30d', min_count: 7, max_count: 60 },
  },
  last_success: { time: 1 },
};

test('the form reads the editable fields of a policy, nothing set reads empty', () => {
  assert.deepEqual(X.slmForm(ENTRY), {
    name: '<daily-{now/d}>', schedule: '0 30 1 * * ?', repository: 'daily', indices: 'logstash-*, metrics-*',
    expireAfter: '30d', minCount: '7', maxCount: '60' });
  assert.deepEqual(X.slmForm({ policy: { name: 'n', schedule: 's', repository: 'r' } }),
    { name: 'n', schedule: 's', repository: 'r', indices: '', expireAfter: '', minCount: '', maxCount: '' });
  // The policy itself works as well as the GET answer's entry.
  assert.equal(X.slmForm(ENTRY.policy).schedule, '0 30 1 * * ?');
});

test('an unchanged form gives back the policy exactly as read', () => {
  assert.deepEqual(X.slmPolicyBody(ENTRY, X.slmForm(ENTRY)), ENTRY.policy);
});

test('an edit changes only what was edited; every other config key is kept as read', () => {
  const f = { ...X.slmForm(ENTRY), schedule: '0  0 2 * * ?', indices: 'logstash-*', minCount: '', maxCount: '90' };
  const b = X.slmPolicyBody(ENTRY, f);
  assert.equal(b.schedule, '0 0 2 * * ?');
  assert.deepEqual(b.config, { ...ENTRY.policy.config, indices: ['logstash-*'] });
  assert.deepEqual(b.config.metadata, { owner: 'ops', ticket: 42 });
  assert.deepEqual(b.config.feature_states, ['kibana']);
  assert.equal(b.config.include_global_state, false);
  assert.deepEqual(b.retention, { expire_after: '30d', max_count: 90 });
  // The read is not changed by building the body.
  assert.equal(ENTRY.policy.config.indices.length, 2);
  assert.equal(ENTRY.policy.retention.min_count, 7);
});

test('empty indices means every index (the key is left out); no retention leaves retention out', () => {
  const b = X.slmPolicyBody(ENTRY, { ...X.slmForm(ENTRY), indices: ' , ', expireAfter: '', minCount: '', maxCount: '' });
  assert.equal('indices' in b.config, false);
  assert.equal(b.config.partial, true);
  assert.equal('retention' in b, false);
});

test('top-level keys the dialog does not show are carried over', () => {
  const b = X.slmPolicyBody({ policy: { ...ENTRY.policy, future_key: { a: 1 } } }, X.slmForm(ENTRY));
  assert.deepEqual(b.future_key, { a: 1 });
});

test('the checks: cron of 6 or 7 fields, a repository that exists, counts and ages', () => {
  const ok = X.slmForm(ENTRY);
  assert.deepEqual(X.slmFormErrors(ok, ['daily']), []);
  assert.deepEqual(X.slmFormErrors({ ...ok, schedule: '0 30 1 * * ? 2027' }, ['daily']), []);
  assert.match(X.slmFormErrors({ ...ok, schedule: '30 1 * * *' }, ['daily']).join(' '), /5 fields.*6 or 7/);
  assert.match(X.slmFormErrors({ ...ok, schedule: '' }, ['daily']).join(' '), /0 fields/);
  assert.match(X.slmFormErrors({ ...ok, schedule: '0 0 0 0 0 0 0 0' }, ['daily']).join(' '), /8 fields/);
  assert.match(X.slmFormErrors(ok, ['weekly']).join(' '), /"daily" does not exist/);
  assert.match(X.slmFormErrors({ ...ok, repository: '' }, ['daily']).join(' '), /Choose a repository/);
  assert.match(X.slmFormErrors({ ...ok, name: ' ' }, ['daily']).join(' '), /name pattern is empty/);
  assert.match(X.slmFormErrors({ ...ok, expireAfter: '30 days' }, ['daily']).join(' '), /not a time value/);
  assert.match(X.slmFormErrors({ ...ok, minCount: '-1' }, ['daily']).join(' '), /Min count/);
  assert.match(X.slmFormErrors({ ...ok, maxCount: '0' }, ['daily']).join(' '), /Max count/);
  assert.match(X.slmFormErrors({ ...ok, minCount: '9', maxCount: '3' }, ['daily']).join(' '), /more than max/);
  assert.equal(X.cronFields('  0 30   1 * * ? '), 6);
});

test('the policy path is encoded once, the same for read, edit and delete', () => {
  assert.equal(X.slmPolicyPath('nightly'), '/_slm/policy/nightly');
  assert.equal(X.slmPolicyPath('a b/c'), '/_slm/policy/a%20b%2Fc');
});

test('a bulk delete names every snapshot with literal commas, each name encoded', () => {
  assert.equal(X.snapshotsDeletePath('daily', ['a', 'b c', 'd,e']), '/_snapshot/daily/a,b%20c,d%2Ce');
});

test('batches keep every path within the limit, keep the order, and lose no name', () => {
  const names = Array.from({ length: 200 }, (_, i) => `nightly-snapshot-of-the-production-cluster-${String(i).padStart(4, '0')}`);
  const b = X.snapshotDeleteBatches('daily', names);
  assert.ok(b.length > 1);
  for (const x of b) {
    assert.ok(x.path.length <= X.DELETE_PATH_MAX, `${x.path.length}`);
    assert.equal(x.path, X.snapshotsDeletePath('daily', x.names));
  }
  assert.deepEqual(b.flatMap((x) => x.names), names);
  // Each batch is as full as it can be: the next name would not have fitted.
  for (let i = 0; i < b.length - 1; i++) {
    assert.ok(X.snapshotsDeletePath('daily', [...b[i].names, b[i + 1].names[0]]).length > X.DELETE_PATH_MAX);
  }
  // A few short names are one request; nothing is no request.
  assert.equal(X.snapshotDeleteBatches('daily', ['a', 'b']).length, 1);
  assert.deepEqual(X.snapshotDeleteBatches('daily', []), []);
  // A name longer than the limit goes alone rather than being dropped.
  const huge = 'x'.repeat(X.DELETE_PATH_MAX + 10);
  assert.deepEqual(X.snapshotDeleteBatches('daily', ['a', huge, 'b']).map((x) => x.names), [['a'], [huge], ['b']]);
  assert.equal(X.snapshotDeleteBatches('daily', ['a', 'b', 'c'], 21).length, 2);
});

test('a snapshot still being taken cannot be ticked', () => {
  assert.equal(X.snapshotSelectable({ status: 'IN_PROGRESS' }), false);
  assert.equal(X.snapshotSelectable({ status: 'in_progress' }), false);
  for (const s of ['SUCCESS', 'PARTIAL', 'FAILED', 'INCOMPATIBLE', '']) assert.equal(X.snapshotSelectable({ status: s }), true);
  assert.ok(X.NOT_SELECTABLE_WHY.length > 10);
});

test('the bulk delete is confirmed by the word delete or the number of snapshots', () => {
  assert.equal(X.bulkDeleteConfirmed('delete', 12), true);
  assert.equal(X.bulkDeleteConfirmed(' DELETE ', 12), true);
  assert.equal(X.bulkDeleteConfirmed('12', 12), true);
  assert.equal(X.bulkDeleteConfirmed('11', 12), false);
  assert.equal(X.bulkDeleteConfirmed('', 12), false);
  assert.equal(X.bulkDeleteConfirmed('0', 0), false);
  assert.equal(X.bulkDeleteConfirmed('yes', 3), false);
});
