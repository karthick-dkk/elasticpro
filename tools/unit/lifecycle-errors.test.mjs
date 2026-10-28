/**
 * ILM / SLM errors: one definition (core/lifecycle-errors.js) — log indices only (the cluster's
 * logIndexPattern, logstash-* by default), only while the feature runs — and the Clusters
 * cell, sort and alert that read it: a button, a red dot, never a count.
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
const L = await imp('ui/js/core/lifecycle-errors.js');
const P = await imp('ui/js/pages/overview.js');
const G = await imp('ui/js/core/alert-groups.js');

const RUN = { operation_mode: 'RUNNING' };
const ilmData = (errs, mode = RUN) => ({ ilm: mode, ilmErrors: Object.fromEntries(errs.map((n) => [n, { step: 'ERROR', policy: 'p' }])) });

test('matchesPattern: comma-separated globs', () => {
  assert.ok(L.matchesPattern('logstash-2026.10.27', 'logstash-*'));
  assert.ok(!L.matchesPattern('metrics-2026', 'logstash-*'));
  assert.ok(L.matchesPattern('filebeat-1', 'logstash-*, filebeat-*'));
  assert.ok(L.matchesPattern('logstash-x', undefined), 'no pattern = the default logstash-*');
  assert.ok(!L.matchesPattern('logstashX', 'logstash.*'), 'dots are literal');
});

test('ILM: only indices in the log pattern count', () => {
  const e = L.ilmErrorsOf(ilmData(['logstash-b', 'logstash-a', 'metrics-1', '.ds-x']), 'logstash-*');
  assert.deepEqual([e.known, e.count, e.names], [true, 2, ['logstash-a', 'logstash-b']]);
  assert.equal(L.ilmErrorsOf(ilmData(['filebeat-1', 'logstash-1']), 'filebeat-*').count, 1, 'the cluster own pattern is used');
});

test('ILM: counted only while RUNNING; unknown mode is unknown, not zero', () => {
  assert.equal(L.ilmErrorsOf(ilmData(['logstash-1'], { operation_mode: 'STOPPED' }), 'logstash-*').count, 0);
  const u = L.ilmErrorsOf({ ilmErrors: { 'logstash-1': {} } }, 'logstash-*');
  assert.deepEqual([u.known, u.count], [false, 0]);
});

const pol = (id, over = {}) => ({ id, policy: { schedule: '0 30 1 * * ?', repository: 'r', config: { indices: ['logstash-*'] } },
  last_success: { time: 1000 }, last_failure: { time: 2000, details: 'repository_exception' }, ...over });
const slmData = (slm, mode = RUN) => ({ slmStatus: mode, slm });

test('SLM: failed last run, scheduled, covering the log pattern, SLM running', () => {
  const e = L.slmErrorsOf(slmData([
    pol('bad'),
    pol('recovered', { last_success: { time: 3000 } }),
    pol('never-failed', { last_failure: undefined }),
    pol('other-indices', { policy: { schedule: 'x', config: { indices: ['metrics-*'] } } }),
    pol('unscheduled', { policy: { config: { indices: ['logstash-*'] } } }),
    pol('everything', { policy: { schedule: 'x', config: {} } }),
    pol('narrower', { policy: { schedule: 'x', config: { indices: ['logstash-2026*'] } } }),
  ]), 'logstash-*');
  assert.deepEqual(e.names, ['bad', 'everything', 'narrower']);
  assert.equal(e.count, 3);
});

test('SLM: stopped counts nothing; unknown mode is unknown', () => {
  assert.equal(L.slmErrorsOf(slmData([pol('bad')], { operation_mode: 'STOPPED' }), 'logstash-*').count, 0);
  assert.equal(L.slmErrorsOf({ slm: [pol('bad')] }, 'logstash-*').known, false);
});

const row = (d, c = {}) => ({ c: { id: 'c1', name: 'c1', url: 'http://c1:9200', ...c }, d: { reachable: true, ...d }, cl: { state: 'online' } });
const mount = (el) => { const td = document.createElement('div'); td.appendChild(el); return td; };

test('the button: mode as a pill, a red dot when failing, never a count', () => {
  const bad = row(ilmData(['logstash-1', 'logstash-2']));
  const b = mount(P.lifecycleButton(bad, 'ILM', 'RUNNING', L.ilmErrorsOf(bad.d, 'logstash-*'), L.ilmErrorTitle));
  assert.ok(b.querySelector('button.pill.green'));
  assert.equal(b.querySelector('button').textContent, 'running');
  assert.ok(b.querySelector('.cl-errdot'), 'red dot present');
  assert.ok(!/\d/.test(b.textContent), `no count text in the cell: "${b.textContent}"`);
  assert.match(b.querySelector('button').title, /2 log indices in ILM error[\s\S]*logstash-1/);

  const ok = row(ilmData(['metrics-1']));
  const g = mount(P.lifecycleButton(ok, 'ILM', 'RUNNING', L.ilmErrorsOf(ok.d, 'logstash-*'), L.ilmErrorTitle));
  assert.ok(!g.querySelector('.cl-errdot'), 'an error outside the log pattern shows no dot');

  const stopped = mount(P.lifecycleButton(ok, 'SLM', 'STOPPED', L.slmErrorsOf(ok.d), L.slmErrorTitle));
  assert.ok(stopped.querySelector('button.pill.yellow'));
});

test('sort: mode first, clusters with errors ahead of clean ones; the alert uses the same definition', () => {
  const key = (d) => P.SORTS.ilm.get(row(d));
  assert.ok(key(ilmData(['logstash-1'])) < key(ilmData([])), 'errors first within a mode');
  assert.equal(key({}), null, 'unknown sorts as unknown');
  assert.equal(key(ilmData(['metrics-1'])), key(ilmData([])), 'outside the pattern is not an error');
  const m = G.itemsOf({ key: 'c1:ilm', level: 'warning' }, { data: () => ilmData(['logstash-1', 'metrics-1']), defaults: {} });
  assert.deepEqual(m.map((i) => i.label), ['logstash-1']);
});
