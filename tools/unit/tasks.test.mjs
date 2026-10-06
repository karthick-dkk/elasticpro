/** Role presets: a new role starts with working values, not blank boxes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const t = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/tasks.js')).href);

test('the default preset fills every role box with something that works', () => {
  const v = t.presetValues(t.ROLE_PRESETS[0], ['logstash-*']);
  assert.deepEqual(v, { cluster_privileges: 'monitor, read_ilm', index_patterns: 'logstash-*', index_privileges: 'read, view_index_metadata' });
});

test('{logs} becomes the chosen clusters\' own log patterns, once each', () => {
  const v = t.presetValues(t.ROLE_PRESETS.find((p) => p.id === 'ingest'), ['filebeat-*', 'logstash-*', 'filebeat-*']);
  assert.equal(v.index_patterns, 'filebeat-*, logstash-*');
  assert.equal(t.presetValues(t.ROLE_PRESETS[0], []).index_patterns, 'logstash-*', 'a fallback, not an empty pattern');
});

test('every preset builds a role Elasticsearch accepts: privileges and patterns together or not at all', () => {
  const task = t.taskById('security-role');
  for (const p of t.ROLE_PRESETS) {
    const req = task.build({ name: 'x', ...t.presetValues(p, ['logstash-*']) });
    assert.equal(req.method, 'PUT');
    if (p.id === 'blank') { assert.equal(req.body.indices, undefined); continue; }
    assert.ok(req.body.indices && req.body.indices[0].names.length && req.body.indices[0].privileges.length, p.id);
  }
});

test('presets use only Elasticsearch\'s own privilege names', () => {
  const CLUSTER = new Set(['monitor', 'read_ilm', 'manage_index_templates', 'manage_ilm', 'create_snapshot', 'manage_slm', 'read_slm']);
  const INDEX = new Set(['read', 'view_index_metadata', 'monitor', 'create_doc', 'create_index', 'auto_configure', 'manage']);
  const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  for (const p of t.ROLE_PRESETS) {
    for (const c of csv(p.cluster)) assert.ok(CLUSTER.has(c), `${p.id}: unknown cluster privilege ${c}`);
    for (const i of csv(p.privileges)) assert.ok(INDEX.has(i), `${p.id}: unknown index privilege ${i}`);
  }
});
