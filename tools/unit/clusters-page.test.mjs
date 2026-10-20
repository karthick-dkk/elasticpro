/**
 * The Clusters page's own arithmetic: every summary column sorts (both ways, unknowns
 * last), unreachable clusters are split out A–Z, and the CSV follows the columns a person
 * has on screen — their order and their names. The page module draws DOM, so jsdom
 * provides a document; nothing is rendered here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'customElements', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const P = await imp('ui/js/pages/overview.js');
const V = await imp('ui/js/core/cluster-view.js');
const S = await imp('ui/js/core/state.js');

const T0 = Date.UTC(2026, 9, 19, 12);
/** A reachable cluster, with whatever figures `d` gives it. */
const up = (id, d = {}, c = {}) => ({ c: { id, name: id, url: `http://${id}:9200`, ...c }, d: { updatedAt: T0, reachable: true, ...d }, cl: { state: 'online' } });
const down = (id, state = 'offline', err = {}) => ({ c: { id, name: id, url: `http://${id}:9200` }, d: { updatedAt: T0, reachable: false }, cl: { state, lastError: err } });
const loading = (id) => ({ c: { id, name: id, url: `http://${id}:9200` }, d: {}, cl: { state: 'unknown' } });
const order = (rows) => rows.map((r) => r.c.id);

const ROWS = [
  up('es-node-10', {
    info: { version: { number: '8.13.4' } }, nodes: [{ jdk: '21.0.2' }],
    health: { status: 'green', number_of_nodes: 9, number_of_data_nodes: 6 },
    disk: { percent: 81, used: 81, total: 100, indicesBytes: 5000 },
    ilm: { operation_mode: 'RUNNING' }, slmStatus: { operation_mode: 'STOPPED' },
    repos: [{ name: 'zeta', location: '/z' }], snapshots: { zeta: [{ id: 's2', start: T0 - 1000, status: 'SUCCESS' }] },
  }),
  up('es-node-2', {
    info: { version: { number: '8.9.0' } }, nodes: [{ jdk: '17.0.9' }],
    health: { status: 'red', number_of_nodes: 3, number_of_data_nodes: 3 },
    disk: { percent: 41, used: 41, total: 100, indicesBytes: 900 },
    ilm: { operation_mode: 'STOPPED' }, slmStatus: { operation_mode: 'RUNNING' },
    repos: [{ name: 'alpha', location: '/a' }], snapshots: { alpha: [{ id: 's1', start: T0 - 99000, status: 'FAILED' }] },
  }),
  // Not read yet: every figure unknown.
  up('Atlas', { health: { status: 'yellow', number_of_nodes: 5, number_of_data_nodes: 5 } }),
];

test('every summary column has a sort, and a SORTS entry for each', () => {
  for (const col of V.SUMMARY_COLUMNS) assert.ok(P.SORTS[col.id], `column ${col.id} has no sort`);
});

test('each column sorts both ways, and unknown stays at the end both ways', () => {
  // [column, ascending order]; Atlas knows only its health and node count.
  const expected = {
    name: ['Atlas', 'es-node-2', 'es-node-10'],
    version: ['es-node-2', 'es-node-10', 'Atlas'],        // 8.9 below 8.13
    jdk: ['es-node-2', 'es-node-10', 'Atlas'],
    health: ['es-node-10', 'Atlas', 'es-node-2'],         // green, yellow, red
    nodes: ['es-node-2', 'Atlas', 'es-node-10'],
    size: ['es-node-2', 'es-node-10', 'Atlas'],
    disk: ['es-node-2', 'es-node-10', 'Atlas'],
    ilm: ['es-node-10', 'es-node-2', 'Atlas'],            // RUNNING, STOPPED
    slm: ['es-node-2', 'es-node-10', 'Atlas'],
    repo: ['es-node-2', 'es-node-10', 'Atlas'],           // alpha, zeta
    snapshot: ['es-node-2', 'es-node-10', 'Atlas'],
    alerts: ['Atlas', 'es-node-2', 'es-node-10'],         // all 0: A–Z
    reqs: ['Atlas', 'es-node-2', 'es-node-10'],           // all 0: A–Z
  };
  const unknownLast = ['version', 'jdk', 'size', 'disk', 'ilm', 'slm', 'repo', 'snapshot'];
  for (const col of V.SUMMARY_COLUMNS) {
    const asc = order(P.sortRows(ROWS, col.id, 1));
    assert.deepEqual(asc, expected[col.id], `${col.id} ascending`);
    const desc = order(P.sortRows(ROWS, col.id, -1));
    if (unknownLast.includes(col.id)) {
      assert.equal(desc.at(-1), 'Atlas', `${col.id}: unknown is last descending too`);
      assert.deepEqual(desc.slice(0, 2), [...expected[col.id]].slice(0, 2).reverse(), `${col.id} descending`);
    } else if (col.id === 'alerts' || col.id === 'reqs') {
      assert.deepEqual(desc, expected[col.id], `${col.id}: equal values stay A–Z`);
    } else {
      assert.deepEqual(desc, [...expected[col.id]].reverse(), `${col.id} descending`);
    }
  }
});

test('names sort naturally and without regard to case', () => {
  const rows = ['es-node-10', 'ES-node-1', 'es-node-2', 'beta'].map((n) => up(n));
  assert.deepEqual(order(P.sortRows(rows, 'name', 1)), ['beta', 'ES-node-1', 'es-node-2', 'es-node-10']);
});

test('unreachable clusters stay in the table: A–Z by name, and after every figure otherwise', () => {
  const rows = [up('m', { health: { status: 'green', number_of_nodes: 3 } }), down('zz', 'auth_error'), loading('l'),
    down('Bb', 'tunnel_error'), down('a10'), down('a9', 'tls_error')];
  assert.deepEqual(order(P.sortRows(rows, 'name', 1)), ['a9', 'a10', 'Bb', 'l', 'm', 'zz'], 'in their A–Z place');
  // What an unreachable cluster last said is not a measurement now: it sorts as unknown.
  const stale = [...rows, { ...down('stale'), d: { updatedAt: T0, reachable: false, health: { number_of_nodes: 99 }, disk: { percent: 99 } } }];
  assert.equal(order(P.sortRows(stale, 'nodes', 1))[0], 'm');
  assert.deepEqual(order(P.sortRows(stale, 'nodes', -1)), ['m', 'a9', 'a10', 'Bb', 'l', 'stale', 'zz'], 'figures first, then the unknowns A–Z');
  assert.deepEqual(order(P.sortRows(stale, 'disk', -1)), order(P.sortRows(stale, 'disk', 1)), 'no cluster here has a disk figure: unknown stays A–Z both ways');
  assert.deepEqual(order(P.unreachableRows(rows)).sort(), ['Bb', 'a10', 'a9', 'zz'], 'a cluster not read yet is not unreachable');
});

test('the CSV follows the visible columns, their order and their names', () => {
  let prefs = V.setColumnShown(null, 'disk', false);
  prefs = V.setColumnShown(prefs, 'jdk', true);
  prefs = V.moveColumn(prefs, 'health', 0);
  prefs = V.renameColumn(prefs, 'version', 'ES');
  for (const id of ['size', 'ilm', 'slm', 'snapshot', 'alerts', 'nodes']) prefs = V.setColumnShown(prefs, id, false);
  const { headers, data } = P.csvTable(ROWS.slice(0, 2), V.visibleColumns(prefs));
  assert.deepEqual(headers, ['Cluster', 'Cluster (URL)', 'Health', 'ES', 'JDK', 'JDK (detail)']);
  assert.deepEqual(data[0], {
    Cluster: 'es-node-10', 'Cluster (URL)': 'http://es-node-10:9200', Health: 'green', ES: '8.13.4',
    JDK: '21.0.2', 'JDK (detail)': 'every node runs JVM 21.0.2',
  });
  assert.ok(!headers.some((h) => /Disk/.test(h)), 'a hidden column is not in the file');
});

test('the CSV: several figures per column, unknown left empty, renamed twins kept apart', () => {
  let prefs = V.renameColumn(null, 'ilm', 'Policy');
  prefs = V.renameColumn(prefs, 'slm', 'Policy');
  const { headers, data } = P.csvTable([ROWS[0], ROWS[2], down('gone', 'auth_error')], V.visibleColumns(prefs));
  assert.ok(headers.includes('Disk usage (%)') && headers.includes('Disk usage (used bytes)') && headers.includes('Disk usage (total bytes)'));
  assert.ok(headers.includes('Policy') && headers.includes('Policy 2'), headers.join(' | '));
  assert.equal(new Set(headers).size, headers.length, 'headers are unique');
  assert.equal(data[0]['Disk usage (%)'], '81.00');
  assert.equal(data[0]['Last snapshot'], 's2');
  assert.equal(data[1]['Disk usage (%)'], '', 'unknown is empty, not 0');
  assert.equal(data[1]['Size (bytes)'], '');
  assert.equal(data[2].Health, 'auth error', 'an unreachable cluster says why');
});

test('the CSV says where disk stands against the watermarks, from the same function as the bar', () => {
  const K = (n) => `cluster.routing.allocation.disk.watermark.${n}`;
  const set = (low, high) => ({ persistent: { [K('low')]: low, [K('high')]: high }, transient: {}, defaults: {} });
  const rows = [
    up('read', { disk: { percent: 81, used: 81, total: 100 }, clusterSettings: set('80%', '90%') }),
    up('unread', { disk: { percent: 81, used: 81, total: 100 } }),
    up('bytes', { disk: { percent: 81, used: 81, total: 100 }, clusterSettings: set('80%', '50gb') }),
  ];
  const { data } = P.csvTable(rows, V.visibleColumns(null));
  assert.deepEqual(data.map((r) => r['Disk usage (watermark)']), ['above low', 'unknown', 'unknown']);
  assert.deepEqual(data.map((r) => r['Disk usage (high watermark %)']), [90, '', ''], 'unknown is empty, not a default');
});

test('clusters() lists the enabled clusters A–Z, whatever order the config has', () => {
  S.state.config = { clusters: [{ id: 'b', name: 'es-node-10', enabled: true }, { id: 'a', name: 'es-node-2', enabled: true },
    { id: 'c', name: 'Alpha', enabled: true }, { id: 'd', name: 'beta', enabled: false }] };
  assert.deepEqual(S.clusters().map((c) => c.name), ['Alpha', 'es-node-2', 'es-node-10']);
  // A new config is a new list.
  S.state.config = { clusters: [{ id: 'x', name: 'zulu', enabled: true }, { id: 'y', name: 'Yankee', enabled: true }] };
  assert.deepEqual(S.clusters().map((c) => c.name), ['Yankee', 'zulu']);
  S.state.config = null;
});
