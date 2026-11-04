/**
 * The plan template editor's pure helpers (core/plan-templates.js) and the "which indices count"
 * preview text (core/volume-config.js patternPreview).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/plan-templates.js')).href);
const V = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume-config.js')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/plan.js')).href);

test('changing a rule drops what belonged to the old one and keeps the specs', () => {
  const r = { on: true, name: 'Parser', rule: 'volume', cap: 150, cpu: 8, ram: 16, root: null, notes: 'x' };
  const t = T.withRule(r, 'tier:warm');
  assert.deepEqual(t, { on: true, name: 'Parser', rule: 'tier', tier: 'warm', nodeTB: null, cpu: 8, ram: 16, root: null, notes: 'x' });
  assert.equal(T.ruleValue(t), 'tier:warm');
  assert.equal('cap' in t, false);
  assert.equal(T.ruleValue(T.withRule(r, 'target:ulm')), 'target:ulm');
  assert.equal(T.withRule(r, 'whenData').from, null, 'a new rule starts with its numbers unset, never 0');
  assert.equal(T.withRule(r, 'follows').of, '');
});

test('every rule the editor offers is one the core knows, and plans', () => {
  const known = ['volume', 'fixed', 'tier', 'whenData', 'follows', 'target'];
  assert.ok(T.RULE_OPTIONS.every((o) => known.includes(o.rule)));
  for (const o of T.RULE_OPTIONS) {
    const role = T.withRule({ name: 'R', cpu: 2, ram: 4 }, o.value);
    assert.doesNotThrow(() => P.computePlan({ roles: [role] }, {}), o.value);
  }
});

test('a number box reads empty as unset and junk as unset, never as 0', () => {
  assert.equal(T.numberOrNull(''), null);
  assert.equal(T.numberOrNull('  '), null);
  assert.equal(T.numberOrNull('abc'), null);
  assert.equal(T.numberOrNull('-3'), null);
  assert.equal(T.numberOrNull('0'), 0);
  assert.equal(T.numberOrNull('8.5'), 8.5);
});

test('problems are named before the list is sent', () => {
  const ok = [{ name: 'A', roles: [{ name: 'x', rule: 'fixed', count: 1 }] }];
  assert.deepEqual(T.listProblems(ok), []);
  assert.match(T.listProblems([...ok, { name: ' a ', roles: [] }].map((t) => ({ ...t, name: t.name.trim() })))[0], /Two templates are called/);
  assert.match(T.listProblems([{ name: '', roles: [] }])[0], /needs a name/);
  assert.match(T.listProblems([{ name: 'A', roles: [{ name: 'x', rule: 'fixed' }, { name: 'X', rule: 'fixed' }] }])[0], /two roles/);
  assert.match(T.listProblems([{ name: 'A', roles: [{ name: 'q', rule: 'follows', of: 'nope', per: 2 }] }])[0], /not in this template/);
});

test('duplicates get a free name; the summary says how many roles still need values', () => {
  const t = { name: 'Standard', backup: 'disk', roles: [{ on: true, name: 'a', rule: 'fixed', count: 1, cpu: 1, ram: 1, root: 1 }, { on: true, name: 'b', rule: 'fixed', count: 1, cpu: null, ram: 1, root: 1 }] };
  assert.equal(T.duplicateOf(t, ['Standard']).name, 'Standard copy');
  assert.equal(T.duplicateOf(t, ['Standard', 'Standard copy']).name, 'Standard copy 2');
  assert.notEqual(T.duplicateOf(t, []).roles, t.roles, 'a copy, not the same roles');
  assert.equal(T.templateSummary(t), '2 roles · values to set in amber');
  assert.equal(T.templateSummary({ roles: [t.roles[0]] }), '1 role');
});

test('the preview says what matched, and says so when nothing did', () => {
  const v = V.patternPreview({ ok: true, matched: 412, dated: 398, undated: 14, datedExample: 'logstash-fw-2026.11.02', undatedExample: 'logstash-000014' }, '@timestamp');
  assert.deepEqual(v.rows.map((r) => r[0]), ['Indices matched', 'Dated by name', 'Split by @timestamp', 'Matched nothing']);
  assert.equal(v.rows[1][1], '398 · e.g. logstash-fw-2026.11.02');
  assert.equal(v.rows[3][1], '—');
  const none = V.patternPreview({ ok: true, matched: 0, dated: 0, undated: 0 });
  assert.match(none.rows[3][1], /matches no index/);
  assert.equal(none.rows[3][2], 'vf-warn');
  assert.match(V.patternPreview({ ok: false, unknown: true, message: 'The index preview needs ElasticPro 0.3.53' }).banner, /needs ElasticPro 0\.3\.53/);
  assert.match(V.patternPreview({ ok: false, message: 'cluster unreachable' }).banner, /Preview failed: cluster unreachable/);
});
