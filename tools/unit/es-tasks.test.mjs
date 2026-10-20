/** The Tasks panel model — core/es-tasks.js: ours vs theirs, longest first, both answer shapes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/es-tasks.js')).href);

const nodesShape = {
  nodes: { 'node-1': { name: 'node-1', tasks: {
    'node-1:4711': { node: 'node-1', id: 4711, action: 'indices:data/read/search', description: 'indices[logstash-*]',
      running_time_in_nanos: 95e9, cancellable: true, headers: { 'X-Opaque-Id': 'elasticpro/ab12/page:indices/mock-prod/17' } },
    'node-1:4712': { node: 'node-1', id: 4712, action: 'indices:data/read/search', description: 'indices[metrics-*]',
      running_time_in_nanos: 42e9, cancellable: true, headers: { 'x-opaque-id': ['kibana-reporting-7f3a'] } },
  } } },
};

const contract = T.contractOf({ tasks: { path: '/_tasks?actions=*search*&detailed&group_by=none', prefix: 'elasticpro/', instance: 'ab12', previousInstance: 'zz99' } });

test('ours are told from theirs by the opaque id, and the longest runs first', () => {
  const rows = T.taskRows(nodesShape, { contract });
  assert.deepEqual(rows.map((r) => [r.id, r.ours, r.origin, r.runningMs]),
    [['node-1:4711', true, 'page:indices', 95000], ['node-1:4712', false, '', 42000]]);
  assert.equal(rows[1].opaqueId, 'kibana-reporting-7f3a', 'a lower-case header name, as an array, still reads');
  assert.equal(rows[0].run, 'this');
});

test('group_by=none answers a flat list; a task with no header is theirs', () => {
  const rows = T.taskRows({ tasks: [{ node: 'n', id: 5, action: 'indices:data/read/search', start_time_in_millis: 1000 }] }, { nowMs: 61_000, contract });
  assert.deepEqual([rows[0].id, rows[0].ours, rows[0].runningMs, rows[0].cancellable], ['n:5', false, 60_000, true]);
});

test('an empty or odd answer is no rows, not a crash', () => {
  assert.deepEqual(T.taskRows(null), []); assert.deepEqual(T.taskRows({}), []); assert.deepEqual(T.taskRows({ nodes: null }), []);
});

test('the cancel path and the privilege hints', () => {
  assert.equal(T.cancelPath('node-1:4711'), '/_tasks/node-1%3A4711/_cancel');
  assert.match(T.privilegeHint(403, 'cancel'), /"manage"/); assert.match(T.privilegeHint(403, 'list'), /"monitor"/);
  assert.equal(T.privilegeHint(500, 'cancel'), '');
  assert.deepEqual(T.parseOpaqueId('elasticpro/ab12/console/c1/3', 'elasticpro/'), { install: 'ab12', origin: 'console', cluster: 'c1', n: 3 });
  assert.equal(T.parseOpaqueId('kibana', 'elasticpro/'), null);
  assert.equal(T.parseOpaqueId('elasticpro/ab12/console/c1/3', ''), null, 'without the core\'s prefix nothing is claimed as ours');
});

test('the listing and our prefix come from the core, defined once', async () => {
  const fs = await import('node:fs');
  assert.equal(T.contractOf({}), null, 'an older core that does not say: no contract, not a guess');
  assert.deepEqual(T.taskRows({ tasks: [{ node: 'n', id: 1, headers: { 'X-Opaque-Id': 'elasticpro/a/b/c/1' } }] })[0].ours, false);
  const rs = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/tasks.rs'), 'utf8');
  assert.match(rs, /pub const TASKS_PATH: &str = "\/_tasks\?/);
  assert.match(rs, /pub const OPAQUE_PREFIX: &str = "elasticpro\/";/);
  for (const f of ['ui/js/core/es-tasks.js', 'ui/js/pages/requests.js']) {
    const js = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/['"`]\/_tasks\?actions/.test(js), `${f} keeps its own copy of the task listing path`);
    assert.ok(!/['"`]elasticpro\/['"`]/.test(js), `${f} keeps its own copy of the opaque-id prefix`);
  }
});
