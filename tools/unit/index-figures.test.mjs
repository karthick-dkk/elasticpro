/** Index figures Elasticsearch did not report (closed, red): null, never 0 — in the rows, the sums and the rules. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
const at = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const S = await at('ui/js/core/state.js');
const F = await at('ui/js/core/index-figures.js');
const V = await at('ui/js/core/volume.js');
const O = await at('ui/js/core/cluster-overview.js');
const U = await at('ui/js/core/user-rules.js');
const fmt = await at('ui/js/lib/fmt.js');

const row = (index, over) => S.parseIndexName(index, undefined, { status: 'open', health: 'green', 'docs.count': '10', 'store.size': '2048', 'pri.store.size': '1024', ...over });
const ROWS = [
  row('logstash-2026.11.20', {}),
  row('logstash-2026.11.21', { status: 'close', health: 'yellow', 'docs.count': null, 'store.size': null }),
  row('logstash-2026.11.22', { health: 'red', 'docs.count': undefined, 'store.size': undefined }),
];

test('a row: not reported is null, 0 is 0', () => {
  assert.deepEqual([ROWS[0].docs, ROWS[0].size], [10, 2048]);
  assert.deepEqual([ROWS[1].docs, ROWS[1].size, ROWS[2].docs, ROWS[2].size], [null, null, null, null]);
  assert.equal(row('x', { 'docs.count': '0' }).docs, 0);
  assert.equal(F.figureWhy(ROWS[0]), '');
  assert.equal(F.figureWhy(ROWS[1]), 'closed: not reported');
  assert.equal(F.figureWhy(ROWS[2]), 'red: not reported');
  assert.equal(F.figureWhy(row('r', { health: 'red' })), 'red: assigned shards only');
});

test('num, bytes, compact, pct and dur of null are unknown, not 0', () => {
  for (const f of [fmt.num, fmt.bytes, fmt.compact, fmt.pct, fmt.dur]) assert.equal(f(null), '–');
  assert.equal(fmt.num(0), '0');
  assert.equal(fmt.bytes(0), '0 B');
});

test('a sum says what it does not hold', () => {
  assert.deepEqual(F.sumKnown(ROWS, 'size'), { sum: 2048, counted: 1, missing: 2, red: 0 });
  assert.equal(F.sumKnown(ROWS.slice(1), 'size').sum, null, 'nothing reported is unknown, not 0');
  assert.equal(F.sumKnown([], 'size').sum, 0, 'no indices is 0');
  const t = O.indexTotals(ROWS);
  assert.deepEqual([t.docs, t.size], [10, 2048]);
  assert.match(t.note, /2 indices not counted/);
});

test('the daily volume names the indices without a size; a rule never matches an unknown size or count', async () => {
  assert.match(V.dailyVolume(ROWS).basis, /2 indices of those days without a size not counted/);
  for (const field of ['size', 'docs']) {
    const rule = { ...U.blankRule(), match: { all: true, conditions: [{ field, op: 'lessThan', value: field === 'size' ? '1gb' : '1000' }] } };
    const m = await U.matchIndices(rule, { id: 'c' }, ROWS);
    assert.deepEqual(m.matched.map((r) => r.index), ['logstash-2026.11.20'], field);
  }
});

test('REST: a response belongs to the cluster that sent it', async () => {
  const { responseFor } = await at('ui/js/pages/console.js');
  assert.equal(responseFor({ status: 200, fromCluster: 'a' }, 'b'), null);
  assert.equal(responseFor({ status: 200, fromCluster: 'a' }, 'a').status, 200);
  assert.equal(responseFor(null, 'a'), null);
});
