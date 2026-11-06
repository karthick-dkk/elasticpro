/**
 * Data › Backend: the pure helpers over DATA_ROUTING_STATUS (docs/HISTORY.md "Backend
 * routing"). The core decides each kind's state and line; these format what it said and never
 * turn an unknown figure into 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/data-routing.js')).href);

test('the panel is offered only when PING says so', () => {
  assert.equal(R.isSupported({ dataRouting: { supported: true } }), true);
  assert.equal(R.isSupported({ dataRouting: { supported: false } }), false);
  assert.equal(R.isSupported({}), false, 'an older core has no flag');
  assert.equal(R.isSupported(null), false);
});

test('modes have the board\'s labels and anything else is built-in', () => {
  assert.equal(R.modeLabel('es'), 'Elasticsearch only');
  assert.equal(R.modeLabel('copy'), 'ElasticPro + Elasticsearch (copy)');
  assert.equal(R.modeLabel('cluster'), 'ElasticPro built-in');
  assert.equal(R.modeOf({ alerts: 'es' }, 'alerts'), 'es');
  assert.equal(R.modeOf({ alerts: 'monitored' }, 'alerts'), 'builtin');
  assert.equal(R.modeOf(null, 'history'), 'builtin');
  assert.deepEqual(R.KINDS.map((k) => k[0]), ['history', 'reports', 'alerts']);
});

test('the status cell is the core\'s line with a tone', () => {
  assert.deepEqual(R.statusCell({ state: 'writing', line: 'writing · 3 queued' }), { tone: 'ok', text: 'writing · 3 queued' });
  assert.deepEqual(R.statusCell({ state: 'builtin', line: 'ElasticPro built-in only' }), { tone: 'ok', text: 'ElasticPro built-in only' });
  assert.equal(R.statusCell({ state: 'queued', line: 'not writing …' }).tone, 'warn');
  assert.equal(R.statusCell({ state: 'paused', line: 'not copying …' }).tone, 'warn');
  assert.deepEqual(R.statusCell(undefined), { tone: 'ok', text: 'ElasticPro built-in only' });
});

test('kept for names both sides only when the kind goes to the store', () => {
  const kept = { builtin: '13 months (the volume record\'s keepMonths)', store: "the store owner's ILM" };
  assert.equal(R.keptForCell({ mode: 'builtin', keptFor: kept }), '13 months (the volume record\'s keepMonths)');
  assert.equal(R.keptForCell({ mode: 'es', keptFor: kept }), "13 months (the volume record's keepMonths) · Elasticsearch: the store owner's ILM");
  assert.equal(R.keptForCell({ mode: 'copy', keptFor: { builtin: '7 days' } }), "7 days · Elasticsearch: owner's ILM");
});

test('size now never shows an unknown as 0', () => {
  assert.equal(R.sizeCell({ mode: 'builtin', builtin: { size: { bytes: null } } }), 'unknown');
  assert.equal(R.sizeCell({ mode: 'builtin', builtin: { size: { bytes: 146 * 1024 * 1024, truncated: true } } }), 'at least 146 MB');
  assert.equal(R.sizeCell({ mode: 'es', builtin: { size: { bytes: 2048 } }, store: { docs: null, docsNote: 'the store did not answer' } }),
    '2.00 KB · Elasticsearch: the store did not answer');
  assert.equal(R.sizeCell({ mode: 'copy', builtin: { size: { bytes: 0 } }, store: { docs: 1200000 } }),
    `0 B · ${(1200000).toLocaleString()} documents in Elasticsearch`);
});

test('the built-in card says its size and the free disk, or that it does not know', () => {
  assert.equal(R.builtinLine({ builtin: { size: { bytes: 1024 ** 3 }, diskFree: 212 * 1024 ** 3 } }), '1.00 GB · 212 GB free on that disk');
  assert.equal(R.builtinLine({ builtin: { size: { bytes: null }, diskFree: null } }), 'size unknown · free space unknown');
  assert.equal(R.builtinLine(null), 'size unknown · free space unknown');
});

test('the amber line appears once, for ES-only kinds the store is not taking', () => {
  assert.equal(R.esOnlyWarning({ kinds: { alerts: { mode: 'es', state: 'writing' } } }), '');
  assert.equal(R.esOnlyWarning({ kinds: { alerts: { mode: 'copy', state: 'paused', store: { why: 'off' } } } }), '', 'a paused copy is not a loss');
  const w = R.esOnlyWarning({ kinds: {
    alerts: { mode: 'es', state: 'queued', store: { why: 'Write history is off', queued: 2 } },
    reports: { mode: 'es', state: 'queued', store: { why: 'Write history is off', queued: 1 } },
  } });
  assert.match(w, /Write history is off/);
  assert.match(w, /built-in store meanwhile · 3 queued/);
  assert.equal(R.esOnlyWarning(undefined), '');
});
