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
  assert.deepEqual(R.statusCell(undefined), { tone: 'muted', text: 'status unknown' }, 'no state is unknown, not built-in');
  assert.deepEqual(R.statusCell({ mode: 'es' }), { tone: 'muted', text: 'status unknown' });
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

test('store stream rows name a stream that is not writing and what was dropped', () => {
  const st = { kinds: {
    history: { mode: 'copy', store: { writing: true, dropped: 0 } },
    reports: { mode: 'es', store: { writing: false, why: 'the reports template was refused', queued: 3, dropped: 2 } },
    alerts: { mode: 'builtin', store: { writing: false, why: 'ignored' } },
  } };
  assert.deepEqual(R.storeStreamRows(st), [
    ['Reports stream', 'not writing: the reports template was refused \u00b7 3 queued'],
    ['Reports dropped', '2 records dropped (queue full or routed back to built-in)'],
  ]);
  assert.deepEqual(R.storeStreamRows(null), []);
});

test('only changed fields are sent, and going back to built-in is named', () => {
  const routing = { history: 'copy', reports: 'builtin', alerts: 'es', reportFiles: false };
  assert.deepEqual(R.routingChanges(routing, { history: 'copy', reports: 'es', alerts: 'builtin', reportFiles: true }),
    { reports: 'es', alerts: 'builtin', reportFiles: true });
  assert.deepEqual(R.routingChanges(routing, {}), {});
  assert.deepEqual(R.letGoKinds(routing, { history: 'builtin', alerts: 'es', reports: 'builtin' }), ['History']);
});

test('the warning omits a count the core did not give', () => {
  const w = R.esOnlyWarning({ kinds: { alerts: { mode: 'es', state: 'queued', store: { why: 'gate closed' } } } });
  assert.match(w, /gate closed/);
  assert.doesNotMatch(w, /queued\./);
  assert.doesNotMatch(w, /0 queued/);
  assert.match(R.esOnlyWarning({ kinds: { alerts: { mode: 'es', state: 'queued', store: { why: 'x', queued: 4 } } } }), /4 queued/);
});
