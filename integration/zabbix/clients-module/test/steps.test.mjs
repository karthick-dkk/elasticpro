/**
 * The cluster devices template's JavaScript steps (lib/cluster-steps.json), run on answers
 * Elasticsearch gives. Zabbix runs them in Duktape (ES5); here they run as the same function
 * body, with `value` as the one argument, as Zabbix calls them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');
const { steps } = JSON.parse(fs.readFileSync(path.join(HERE, 'lib/cluster-steps.json'), 'utf8'));
// Zabbix fills user macros into the script before running it.
const run = (name, answer, macros = { '{$EP.TASK.LONG}': '300' }) => {
  let code = steps[name];
  for (const [m, v] of Object.entries(macros)) code = code.split(m).join(v);
  return new Function('value', code)(JSON.stringify(answer));
};

test('every step is ES5: no let, const, arrows, template strings or classes', () => {
  for (const [name, code] of Object.entries(steps)) {
    assert.ok(!/\b(let|const|class)\b|=>|`/.test(code), `${name} uses syntax Duktape does not run`);
  }
});

test('unassigned shards by reason, most common first', () => {
  const rows = [{ state: 'STARTED' }, { state: 'UNASSIGNED', 'unassigned.reason': 'NODE_LEFT' },
    { state: 'UNASSIGNED', 'unassigned.reason': 'INDEX_CREATED' }, { state: 'UNASSIGNED', 'unassigned.reason': 'NODE_LEFT' }];
  assert.equal(run('unassigned_by_reason', rows), 'NODE_LEFT: 2, INDEX_CREATED: 1');
  assert.equal(run('unassigned_by_reason', [{ state: 'STARTED' }]), 'none');
});

test('red and yellow indices', () => {
  const rows = [{ health: 'green' }, { health: 'yellow' }, { health: 'red' }, { health: 'yellow' }];
  assert.equal(run('indices_red', rows), 1);
  assert.equal(run('indices_yellow', rows), 2);
});

test('SLM: policies and the age of the newest good snapshot; none is unknown, not 0', () => {
  const now = Date.now();
  const p = { daily: { last_success: { time: now - 3600e3 } }, weekly: { last_success: { time: now - 86400e3 } }, never: {} };
  assert.equal(run('slm_policies', p), 3);
  assert.ok(Math.abs(run('slm_last_success_age', p) - 3600) <= 2);
  assert.throws(() => run('slm_last_success_age', { never: {} }), /no SLM policy has a successful snapshot/);
});

test('get thread pool: queue and rejected summed over nodes, other pools ignored', () => {
  const rows = [{ node_name: 'a', name: 'get', queue: '2', rejected: '5' }, { node_name: 'b', name: 'get', queue: '1', rejected: '0' },
    { node_name: 'a', name: 'write', queue: '9', rejected: '9' }];
  assert.equal(run('tp_get_queue', rows), 3);
  assert.equal(run('tp_get_rejected', rows), 5);
});

test('node CPU: busiest and average; no node reporting is unknown', () => {
  const a = { nodes: { x: { os: { cpu: { percent: 20 } } }, y: { os: { cpu: { percent: 65 } } }, z: { os: {} } } };
  assert.equal(run('cpu_max', a), 65);
  assert.equal(run('cpu_avg', a), 42.5);
  assert.throws(() => run('cpu_max', { nodes: {} }), /no node reported/);
});

test('dangling indices, long-running tasks, aliases without a write index', () => {
  assert.equal(run('dangling', { dangling_indices: [{}, {}] }), 2);
  assert.equal(run('dangling', {}), 0);
  const tasks = [{ running_time_ns: String(10e9) }, { running_time_ns: String(400e9) }, { running_time_ns: String(301e9) }];
  assert.equal(run('tasks_long', tasks), 2);
  assert.equal(run('tasks_long', tasks, { '{$EP.TASK.LONG}': '600' }), 0);
  const aliases = [{ alias: 'logs', index: 'l-1', is_write_index: 'false' }, { alias: 'logs', index: 'l-2', is_write_index: 'false' },
    { alias: 'app', index: 'a-1', is_write_index: 'false' }, { alias: 'app', index: 'a-2', is_write_index: 'true' },
    { alias: 'single', index: 's-1', is_write_index: '-' }];
  assert.equal(run('aliases_no_write', aliases), 1, 'only "logs": several indices, none the write index');
});

// The jump template's steps: its placeholders filled as JumpTemplate.php fills them.
const jump = (name, n, paths, out) => new Function('value',
  steps[name].split('__N__').join(String(n)).split('__PATHS__').join(JSON.stringify(paths)))(out);
const PATHS = ['/_cluster/health', '/_cluster/stats', '/_nodes/stats'];
const answer = (...parts) => parts.map(([body, code]) => `${body}\n@@HTTP ${code}@@\n`).join('');

test('jump host: each part of one curl.exe answer, by its marker', () => {
  const out = answer(['{"status":"green"}', 200], ['{"indices":{"count":7}}', 200], ['{"nodes":{}}', 200]);
  assert.equal(jump('jump_part', 0, PATHS, out), '{"status":"green"}');
  assert.equal(JSON.parse(jump('jump_part', 1, PATHS, out)).indices.count, 7);
  assert.equal(jump('jump_problem', 0, PATHS, out), '', 'all 200: no problem');
});

test('jump host: a rejected key names the endpoint and Elasticsearch’s reason', () => {
  const out = answer(['{"error":{"type":"security_exception","reason":"unable to authenticate"}}', 401], ['', 401], ['', 401]);
  assert.throws(() => jump('jump_part', 0, PATHS, out), /Elasticsearch answered 401 for \/_cluster\/health: unable to authenticate/);
  assert.equal(jump('jump_problem', 0, PATHS, out), 'HTTP 401 for /_cluster/health; HTTP 401 for /_cluster/stats; HTTP 401 for /_nodes/stats');
});

test('jump host: no answer from the cluster, and curl.exe missing, are said as such', () => {
  const none = answer(['', '000'], ['', '000'], ['', '000']);
  assert.throws(() => jump('jump_part', 2, PATHS, none), /did not answer \/_nodes\/stats through the jump host/);
  const missing = "'curl.exe' is not recognized as an internal or external command,\r\noperable program or batch file.";
  assert.throws(() => jump('jump_part', 0, PATHS, missing), /curl.exe did not run on the jump host: 'curl.exe' is not recognized/);
  assert.match(jump('jump_problem', 0, PATHS, missing), /curl.exe did not run on the jump host/);
});

test('jump host: Windows line endings around the markers are fine', () => {
  const out = '{"status":"yellow"}\r\n@@HTTP 200@@\r\n{"x":1}\r\n@@HTTP 200@@\r\n';
  assert.equal(jump('jump_part', 0, PATHS.slice(0, 2), out), '{"status":"yellow"}');
  assert.equal(jump('jump_part', 1, PATHS.slice(0, 2), out), '{"x":1}');
});
