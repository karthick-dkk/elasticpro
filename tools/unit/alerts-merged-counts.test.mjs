/**
 * One definition of "open": the tab badge, the top bar and the Alerts page all count merged
 * alerts (a cluster and a rule), so two failing snapshot policies are one open alert
 * everywhere — and acknowledging it takes it out of all of them at once.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const st = await import(url('ui/js/core/state.js'));
const acks = await import(url('ui/js/core/acks.js'));
const { DEFAULTS } = await import(url('ui/js/core/config.js'));

const policy = (id) => ({ id, last_failure: { time: Date.now() - 1000, details: 'repository_exception' } });

beforeEach(async () => {
  st.state.defaults = { ...DEFAULTS };
  st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
  st.state.selected = 'all';
  st.state.clients = new Map([['c1', { state: 'online' }]]);
  st.state.data = new Map([['c1', { reachable: true, health: { status: 'green' }, repos: [], snapshots: {},
    slm: [policy('daily'), policy('weekly'), policy('monthly')] }]]);
  await acks.unacknowledge('c1:slm-fail');
  st.invalidateAlerts();
});

test('three failing policies are three raw alerts but one open alert', () => {
  assert.equal(st.alerts().filter((a) => a.key.startsWith('c1:slm-fail:')).length, 3);
  const open = st.openAlertsNow();
  assert.equal(open.length, 1);
  assert.equal(open[0].key, 'c1:slm-fail');
  assert.equal(open[0].items.length, 3);
  assert.deepEqual(st.openAlertCounts(), { total: 1, critical: 1, warning: 0 });
});

test('acknowledging the merged alert drops it from the count; a fourth policy failing brings it back', async () => {
  const [m] = st.openAlertsNow();
  await acks.acknowledgeItems(m.key, m.items.map((i) => i.id));
  st.invalidateAlerts();
  assert.equal(st.openAlertCounts().total, 0);
  const merged = st.mergedAlerts();
  assert.equal(merged.length, 1);
  assert.equal(merged[0].state, 'acked');

  st.state.data.get('c1').slm.push(policy('hourly'));
  st.invalidateAlerts();
  assert.equal(st.openAlertCounts().total, 1, 'a policy that failed after the acknowledgement is not hidden by it');
  assert.equal(st.mergedAlerts()[0].newSince, 1);
});

test('re-opening clears the acknowledgement for the whole merged alert', async () => {
  const [m] = st.openAlertsNow();
  await acks.acknowledgeItems(m.key, m.items.map((i) => i.id));
  await acks.unacknowledge(m.key);
  st.invalidateAlerts();
  assert.equal(st.openAlertCounts().total, 1);
  assert.equal(acks.ackFor(m.key).ackedItems, undefined);
});
