/**
 * Reading the data day out of an index name — the one reader every caller shares.
 *
 * The bug this pins: the default pattern demanded a source between `logstash-` and the
 * date, so a plain daily index (`logstash-2026.09.23`) parsed as undated. The snapshot
 * evidence dialog then said "no dated indices in this snapshot" while listing seven of
 * them, and every coverage figure built on the same parse undercounted the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

// state.js wants a browser; nothing exercised here needs one. Same shim as fleet-cache.test.mjs.
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

const { parseIndexName, coveredDays, snapshotRowsVerbose, LEGACY_INDEX_RE } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);
const { DEFAULTS } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/config.js')).href);

const WEEK = ['23', '24', '25', '26', '27', '28', '29'].map((d) => `logstash-2026.09.${d}`);

test('plain logstash-YYYY.MM.DD names are dated with the default pattern', () => {
  for (const n of WEEK) {
    const p = parseIndexName(n, DEFAULTS.indexNameRegex);
    assert.equal(p.day, `2026-09-${n.slice(-2)}`, `${n} should be dated`);
    assert.equal(p.source, null, `${n} has no source segment`);
  }
});

test('the legacy default pattern, as older config files carry it, reads them too', () => {
  assert.notEqual(LEGACY_INDEX_RE, DEFAULTS.indexNameRegex);
  for (const n of WEEK) assert.equal(parseIndexName(n, LEGACY_INDEX_RE).day, `2026-09-${n.slice(-2)}`);
  assert.equal(parseIndexName('logstash-2026.09.23', undefined).day, '2026-09-23', 'no pattern at all means the default');
});

test('a source segment still parses as before', () => {
  const p = parseIndexName('logstash-acme-2026.09.09', DEFAULTS.indexNameRegex);
  assert.equal(p.source, 'acme');
  assert.equal(p.day, '2026-09-09');
  const q = parseIndexName('prod-logstash-web-eu-2026-09-10', DEFAULTS.indexNameRegex);
  assert.equal(q.source, 'web-eu');
  assert.equal(q.day, '2026-09-10');
});

test('names without a date stay undated — never a guessed day', () => {
  for (const n of ['.kibana_1', 'metrics-2026.09', 'logstash', 'filebeat-2026.09.23']) {
    assert.equal(parseIndexName(n, DEFAULTS.indexNameRegex).day, null, `${n} must not be dated`);
  }
});

test('a pattern somebody wrote is used exactly as written', () => {
  const re = '^(?<prefix>filebeat)-(?<date>\\d{4}\\.\\d{2}\\.\\d{2})$';
  assert.equal(parseIndexName('filebeat-2026.09.23', re).day, '2026-09-23');
  assert.equal(parseIndexName('logstash-2026.09.23', re).day, null);
});

test('coveredDays over the seven names: 23 → 29, seven days, none missing', () => {
  const c = coveredDays(WEEK, LEGACY_INDEX_RE);
  assert.deepEqual(c, { coverFrom: '2026-09-23', coverTo: '2026-09-29', coverDays: 7, datedIndices: 7, missingDays: 0 });
});

test('coveredDays counts a gap inside the span as missing, and ignores undated names', () => {
  const c = coveredDays(['logstash-2026.09.23', 'logstash-2026.09.26', 'logstash-acme-2026.09.26', '.kibana_1'], DEFAULTS.indexNameRegex);
  assert.equal(c.coverDays, 4);
  assert.equal(c.missingDays, 2, '24 and 25 are inside the span with no index');
  assert.equal(c.datedIndices, 3);
});

test('a verbose snapshot row with those names carries the covered range', () => {
  const [row] = snapshotRowsVerbose({ snapshots: [{ snapshot: 'daily-1', state: 'SUCCESS', indices: WEEK,
    start_time_in_millis: 1, end_time_in_millis: 2, shards: { total: 7, successful: 7, failed: 0 } }] }, LEGACY_INDEX_RE);
  assert.equal(row.coverFrom, '2026-09-23');
  assert.equal(row.coverTo, '2026-09-29');
  assert.equal(row.coverDays, 7);
});
