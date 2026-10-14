/** Templates: reading the three listings, which template wins, and comparing across clusters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const t = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/templates.js')).href);

const INDEX_JSON = { index_templates: [
  { name: 'logs-app', index_template: { index_patterns: ['logs-app-*'], priority: 200, composed_of: ['base-settings'],
    template: { settings: { index: { number_of_replicas: '1', refresh_interval: '5s' } },
      mappings: { properties: { message: { type: 'text' }, host: { properties: { name: { type: 'keyword' } } } } } }, version: 3 } },
  { name: 'logstash', index_template: { index_patterns: 'logstash-*', priority: 100 } },
  { name: '.ilm-history-7', index_template: { index_patterns: ['ilm-history-7*'], priority: 5, data_stream: {} } },
  { name: 'vendor', index_template: { index_patterns: ['vendor-*'], _meta: { managed: true }, data_stream: { hidden: false } } },
] };

test('index templates normalise to rows with the body to PUT back', () => {
  const rows = t.normalizeIndexTemplates(INDEX_JSON);
  assert.equal(rows.length, 4);
  const a = rows[0];
  assert.equal(a.kind, 'index');
  assert.deepEqual(a.patterns, ['logs-app-*']);
  assert.equal(a.priority, 200);
  assert.deepEqual(a.composedOf, ['base-settings']);
  assert.equal(a.version, 3);
  assert.equal(a.dataStream, false);
  assert.equal(a.managed, false);
  assert.equal(a.settingsCount, 2);
  assert.equal(a.mappingFieldCount, 3, 'message, host, host.name');
  assert.equal(a.body, INDEX_JSON.index_templates[0].index_template);
  assert.deepEqual(rows[1].patterns, ['logstash-*'], 'a single pattern string is a list of one');
  assert.equal(rows[1].version, null, 'no version is unknown, not 0');
  assert.equal(rows[2].managed, true, 'dot-prefixed is built in');
  assert.equal(rows[2].dataStream, true);
  assert.equal(rows[3].managed, true, '_meta.managed is built in');
  assert.equal(rows[3].priority, null);
  assert.deepEqual(t.normalizeIndexTemplates(null), []);
});

test('component and legacy templates normalise', () => {
  const c = t.normalizeComponentTemplates({ component_templates: [
    { name: 'base-settings', component_template: { template: { settings: { number_of_replicas: 1 } }, version: 2 } },
    { name: 'logs@mappings', component_template: { template: {}, _meta: { managed: true } } },
  ] });
  assert.equal(c[0].kind, 'component');
  assert.equal(c[0].settingsCount, 1);
  assert.equal(c[0].version, 2);
  assert.deepEqual(c[0].patterns, []);
  assert.equal(c[1].managed, true);
  const l = t.normalizeLegacyTemplates({ 'old-logstash': { order: 3, index_patterns: ['logstash-*'], settings: { a: 1 }, mappings: { properties: { x: {} } } } });
  assert.equal(l.length, 1);
  assert.equal(l[0].kind, 'legacy');
  assert.equal(l[0].order, 3);
  assert.equal(l[0].settingsCount, 1);
  assert.equal(l[0].mappingFieldCount, 1);
  assert.deepEqual(t.normalizeLegacyTemplates({}), [], 'no legacy templates is an empty list');
});

test('patternMatches is the plain * wildcard, everything else literal', () => {
  assert.ok(t.patternMatches('logs-app-*', 'logs-app-2026.10.14'));
  assert.ok(t.patternMatches('*', 'anything'));
  assert.ok(t.patternMatches('a*b*c', 'axxbyyc'));
  assert.ok(!t.patternMatches('logs-app-*', 'logs-apps'));
  assert.ok(!t.patternMatches('logs.app', 'logsXapp'), 'a dot is a dot');
  assert.ok(!t.patternMatches('logs-*', 'xlogs-1'), 'anchored');
  const r = t.normalizeIndexTemplates(INDEX_JSON)[0];
  assert.deepEqual(t.matchingIndices(r, ['logs-app-1', 'logs-other', 'logs-app-2']), ['logs-app-1', 'logs-app-2']);
});

test('winningTemplate picks the highest priority, and calls a tie ambiguous', () => {
  const rows = t.normalizeIndexTemplates({ index_templates: [
    { name: 'broad', index_template: { index_patterns: ['logs-*'], priority: 50 } },
    { name: 'narrow', index_template: { index_patterns: ['logs-app-*'], priority: 200 } },
    { name: 'unset', index_template: { index_patterns: ['*'] } },
  ] });
  const w = t.winningTemplate('logs-app-1', rows);
  assert.equal(w.template.name, 'narrow');
  assert.equal(w.ambiguous, false);
  assert.equal(w.candidates.length, 3);
  assert.equal(t.winningTemplate('other', rows).template.name, 'unset', 'an unset priority is 0 and still wins alone');
  assert.equal(t.winningTemplate('x', []), null);
  const tie = t.normalizeIndexTemplates({ index_templates: [
    { name: 'a', index_template: { index_patterns: ['logs-*'], priority: 10 } },
    { name: 'b', index_template: { index_patterns: ['logs-a*'], priority: 10 } },
  ] });
  const w2 = t.winningTemplate('logs-a1', tie);
  assert.equal(w2.ambiguous, true);
  assert.deepEqual(w2.tiedWith, ['b']);
  assert.match(w2.note, /ambiguous/);
});

test('overlaps finds same-priority templates whose patterns can match one index', () => {
  const rows = t.normalizeIndexTemplates({ index_templates: [
    { name: 'a', index_template: { index_patterns: ['logs-*'], priority: 10 } },
    { name: 'b', index_template: { index_patterns: ['logs-*-app'], priority: 10 } },
    { name: 'c', index_template: { index_patterns: ['metrics-*'], priority: 10 } },
    { name: 'd', index_template: { index_patterns: ['logs-*'], priority: 11 } },
  ] });
  const ov = t.overlaps(rows);
  assert.deepEqual(ov.map((o) => `${o.a}/${o.b}`), ['a/b'], 'logs-* and logs-*-app share logs-x-app; different priorities never clash');
  assert.ok(t.patternsOverlap('logs-*', 'logs-app-*'));
  assert.ok(!t.patternsOverlap('logs-*', 'metrics-*'));
  assert.ok(t.patternsOverlap('a*', '*b'));
  assert.ok(!t.patternsOverlap('abc', 'abd'));
  assert.ok(t.patternsOverlap('x', 'x'));
});

test('fingerprint ignores key order and nothing else', () => {
  const a = { priority: 1, index_patterns: ['x'], template: { settings: { b: 1, a: 2 } }, version: 1 };
  const b = { template: { settings: { a: 2, b: 1 } }, version: 1, index_patterns: ['x'], priority: 1 };
  assert.equal(t.canonical(a), t.canonical(b));
  assert.equal(t.fingerprint(a), t.fingerprint(b));
  assert.match(t.fingerprint(a), /^[0-9a-f]{8}$/);
  assert.notEqual(t.fingerprint(a), t.fingerprint({ ...a, version: 2 }), 'version is kept');
  assert.notEqual(t.fingerprint({ p: ['a', 'b'] }), t.fingerprint({ p: ['b', 'a'] }), 'list order matters');
  assert.equal(t.fnv1a(''), '811c9dc5');
});

test('compareAcross: same, differs, missing, and unread kept apart', () => {
  const row = (name, body) => ({ kind: 'index', name, body, managed: false });
  const out = t.compareAcross({
    c1: [row('x', { v: 1 }), row('y', { v: 1 })],
    c2: [row('x', { v: 1 }), row('y', { v: 2 })],
    c3: [row('x', { v: 1 }), row('y', { v: 1 }), row('z', { v: 1 })],
    c4: { error: 'HTTP 403' },
  });
  const by = Object.fromEntries(out.map((r) => [r.name, r]));
  assert.equal(by.x.same, true);
  assert.deepEqual(by.x.missingOn, []);
  assert.equal(by.x.clusters.c4, undefined, 'unread is not null');
  assert.equal(by.x.unread.c4, 'HTTP 403');
  assert.equal(by.y.same, false);
  assert.equal(by.y.reference, t.fingerprint({ v: 1 }), 'the majority version is the reference');
  assert.deepEqual(by.y.differsOn, ['c2']);
  assert.equal(by.z.same, false);
  assert.deepEqual(by.z.missingOn, ['c1', 'c2']);
  assert.equal(by.z.clusters.c1, null);
  assert.ok(!by.z.missingOn.includes('c4'), 'an unread cluster is never "missing"');
});

test('changedKeys names what a save changes', () => {
  assert.deepEqual(t.changedKeys({ priority: 1, template: { settings: { a: 1 }, mappings: {} } },
    { priority: 2, template: { settings: { a: 1 }, mappings: { x: 1 } } }), ['priority', 'template.mappings']);
  assert.deepEqual(t.changedKeys({ a: 1 }, { a: 1 }), []);
});

test('validateTemplateBody: per-kind rules, errors stop, warnings do not', () => {
  const bad = t.validateTemplateBody('index', '{ nope');
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0].text, /JSON/);
  assert.equal(t.validateTemplateBody('index', '[1]').ok, false, 'an array is not a template');

  const noPat = t.validateTemplateBody('index', JSON.stringify({ priority: 10 }));
  assert.equal(noPat.ok, false);
  assert.ok(noPat.problems.some((p) => p.level === 'error' && /index_patterns/.test(p.text)));

  const good = t.validateTemplateBody('index', JSON.stringify({ index_patterns: ['app-*'], priority: 10 }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.problems, []);

  const noPrio = t.validateTemplateBody('index', JSON.stringify({ index_patterns: ['app-*'] }));
  assert.equal(noPrio.ok, true);
  assert.ok(noPrio.problems.some((p) => p.level === 'warn' && /priority/.test(p.text)));

  const shadow = t.validateTemplateBody('index', JSON.stringify({ index_patterns: ['logs-*'], priority: 200 }));
  assert.equal(shadow.ok, true);
  assert.ok(shadow.problems.some((p) => p.level === 'warn' && /shadows the built-in "logs"/.test(p.text)));
  const low = t.validateTemplateBody('index', JSON.stringify({ index_patterns: ['logs-*'], priority: 50 }));
  assert.ok(!low.problems.some((p) => /built-in/.test(p.text)), 'below 100 the built-in wins; nothing to warn about');
  const metrics = t.validateTemplateBody('index', JSON.stringify({ index_patterns: ['metrics-*'], priority: 100 }));
  assert.ok(metrics.problems.some((p) => /refuses/.test(p.text)));

  assert.equal(t.validateTemplateBody('component', JSON.stringify({ version: 1 })).ok, false, 'component needs template');
  assert.equal(t.validateTemplateBody('component', JSON.stringify({ template: { settings: {} } })).ok, true);
  assert.equal(t.validateTemplateBody('component', JSON.stringify({ template: {}, index_patterns: ['x'] })).ok, false);

  assert.equal(t.validateTemplateBody('legacy', JSON.stringify({ order: 0 })).ok, false, 'legacy needs index_patterns');
  const leg = t.validateTemplateBody('legacy', JSON.stringify({ index_patterns: ['x-*'], order: 0 }));
  assert.equal(leg.ok, true);
  assert.ok(leg.problems.every((p) => p.level === 'warn'));

  for (const k of ['index', 'component', 'legacy']) {
    assert.equal(t.validateTemplateBody(k, JSON.stringify(t.skeleton(k))).ok, true, `${k} skeleton is valid`);
  }
});

test('names and requests', () => {
  assert.equal(t.validateTemplateName('logs-app'), null);
  assert.ok(t.validateTemplateName(''));
  assert.ok(t.validateTemplateName('has space'));
  assert.ok(t.validateTemplateName('Upper'));
  assert.ok(t.validateTemplateName('_x'));
  assert.deepEqual(t.putRequest('index', 'a b', { x: 1 }), { method: 'PUT', path: '/_index_template/a%20b', body: { x: 1 } });
  assert.deepEqual(t.deleteRequest('component', 'c'), { method: 'DELETE', path: '/_component_template/c' });
  assert.equal(t.deleteRequest('legacy', 'l').path, '/_template/l');
  assert.deepEqual(t.simulateRequest('logs-app-1'), { method: 'POST', path: '/_index_template/_simulate_index/logs-app-1' });
  const r = { patterns: ['logs-app-*'] };
  assert.equal(t.exampleIndexName(r, ['logs-app-x']), 'logs-app-x');
  assert.equal(t.exampleIndexName(r, [], new Date(Date.UTC(2026, 9, 14))), 'logs-app-2026.10.14');
});
