/**
 * Alerts that flap are announced once, not once per flap.
 *
 * A cluster that fails one refresh and answers the next made "unreachable" leave the list
 * and come back, and every return was announced as new. These pin the grace, and that each
 * announcement is keyed so a genuine return updates a toast rather than stacking one.
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
const notify = await import(url('ui/js/core/notify.js'));
const st = await import(url('ui/js/core/state.js'));
const { DEFAULTS } = await import(url('ui/js/core/config.js'));

const said = [];
const spy = (msg, kind, ms, opts) => said.push({ msg, kind, opts });
const run = () => notify.announceNewAlerts({ notify: spy });

const setReachable = (v) => {
  st.state.data = new Map([['c1', { reachable: v, health: { status: 'green' }, slm: [], repos: [], snapshots: {} }]]);
};

beforeEach(() => {
  said.length = 0;
  st.state.defaults = { ...DEFAULTS };
  st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
  st.state.selected = 'all';
  st.state.clients = new Map([['c1', { state: 'online' }]]);
  setReachable(true);
  notify.resetAnnounced();
  run();                                   // the baseline pass
});

test('going down is announced once, as one notice for the cluster', () => {
  setReachable(false);
  assert.equal(st.alerts().some((a) => /unreachable/.test(a.title)), true, 'the fixture must raise the alert');
  run(); run(); run();
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'err');
  assert.match(said[0].opts.key, /^alerts:c1:\d+$/, 'keyed by the cluster and the burst, not by the alert');
  assert.equal(said[0].msg, 'prod: 1 new alert');
  assert.deepEqual(said[0].opts.detail, ['Cluster unreachable']);
});

test('one missed refresh and a return is not news', () => {
  setReachable(false); run();
  said.length = 0;
  setReachable(true); run();               // one pass answering
  setReachable(false); run();              // and gone again
  assert.equal(said.length, 0, 'a blip was announced a second time');
});

test('down for good, back up, and down again is announced again', () => {
  setReachable(false); run();
  said.length = 0;
  setReachable(true); run(); run(); run(); // long enough to count as recovered
  setReachable(false); run();
  assert.equal(said.length, 1);
});
