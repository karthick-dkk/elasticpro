/**
 * What an alert's text may claim: what was measured, with its zone. The disk gap and a capacity
 * change name no cause; a snapshot's time is in the page's zone and says which.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'navigator', 'matchMedia']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
globalThis.indexedDB = undefined;
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const st = await import(url('ui/js/core/state.js'));
const { DEFAULTS } = await import(url('ui/js/core/config.js'));
const P = await import(url('ui/js/core/alert-playbooks.js'));
const { dtz } = await import(url('ui/js/lib/fmt.js'));
const GB = 1024 ** 3;
const DAY = 86400000;

function base(over = {}) {
  st.state.config = { clusters: [{ id: 'c1', name: 'one', enabled: true, url: 'http://one:9200' }], users: [], defaults: {} };
  st.state.defaults = { ...DEFAULTS };
  st.state.data = new Map([['c1', { reachable: true, updatedAt: Date.now(), health: { status: 'green' }, nodes: [{ name: 'n1', master: '*' }], master: 'n1', repos: [], snapshots: {}, slm: [], ...over }]]);
  st.state.indices = new Map();
}
const find = (key) => st.alerts().find((a) => a.key.startsWith(key));
beforeEach(() => base());

test('the disk gap says what was compared and that it measures no dangling or orphaned data', () => {
  base({ disk: { indicesBytes: 100 * GB, nodes: [] } });
  st.state.indices.set('c1', [{ index: 'a', size: 30 * GB }, { index: 'closed', size: null }]);
  for (const dang of [null, { indices: [] }, { indices: [], failed: true }]) {
    st.setDangling('c1', dang);
    const a = find('c1:disk-unaccounted');
    assert.match(a.title, /70\.0 GB of shard data is not in the index list/);
    assert.match(a.detail, /hidden indices not listed, closed indices without a size/);
    assert.match(a.detail, /does not measure dangling or orphaned data/);
    assert.ok(!/so it is orphaned/.test(a.detail));
  }
  st.setDangling('c1', { indices: [{ index_name: 'lost' }] });
  assert.match(find('c1:disk-unaccounted').detail, /1 dangling index\(es\): lost/, 'a dangling index that was found is said');
});

test('a capacity drop says what the nodes report, not why', () => {
  base({ capacity: { total: 50 * GB, nodeCount: 1, changedFrom: 100 * GB, changedAt: Date.now() - 60000 } });
  const a = find('c1:capacity');
  assert.match(a.title, /FELL to 50\.0 GB/);
  assert.match(a.detail, /why it changed is not measured/);
  assert.ok(!/mount|data path/.test(a.detail));
});

test('snapshot times in an alert carry the zone they are in, the page\'s own', () => {
  const at = Date.now() - 20 * DAY;
  base({ repos: [{ name: 'r' }], snapshots: { r: [{ id: 's1', start: at, status: 'SUCCESS' }] },
    slm: [{ id: 'p', last_success: { time: at } }] });
  const stale = find('c1:repo:r:stale');
  assert.ok(stale.detail.includes(`s1 (SUCCESS) started ${dtz(at)}`), stale.detail);
  assert.match(stale.detail, /None of the last 1 run failed or came back partial/);
  assert.match(dtz(at), / (UTC|GMT[+-]?[\d:]*|[A-Z]{2,5})$/);
  base({ slm: [{ id: 'p', last_success: { time: at } }] });
  assert.equal(find('c1:slm-stale:p').detail, `Last success ${dtz(at)}`);
  base({ repos: [{ name: 'r' }], snapshots: { r: [{ id: 's2', start: at, status: 'SUCCESS' }, { id: 's1', start: at - DAY, status: 'PARTIAL' }] } });
  assert.match(find('c1:repo:r:stale').detail, /1 of the last 2 runs failed or came back partial/, 'not "all succeeded"');
});

test('the playbook claims no cause for the disk gap', () => {
  const book = P.playbookFor ? P.playbookFor({ key: 'c1:disk-unaccounted', cluster: { id: 'c1', name: 'one' }, items: [] }, {}) : null;
  if (book) assert.ok(!/orphaned shard directories/.test(JSON.stringify(book)));
});
