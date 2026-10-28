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

const S = await imp('ui/js/core/state.js');
const managed = (names, policy = 'logs-retention') => Object.fromEntries(names.map((n) => [n, policy]));

test('the button: the pill the view decides, Running / Stopped in capitals, a red dot when failing, never a count', () => {
  const bad = row({ ...ilmData(['logstash-1', 'logstash-2']), ilmOfIndex: managed(['logstash-1', 'logstash-2']) });
  const b = mount(P.lifecycleButton(bad, 'ILM', L.lifecycleView('ILM', bad.d, 'logstash-*'), L.ilmErrorsOf(bad.d, 'logstash-*'), L.ilmErrorTitle));
  assert.ok(b.querySelector('button.pill.green'));
  assert.equal(b.querySelector('button').textContent, 'Running');
  assert.ok(b.querySelector('.cl-errdot'), 'red dot present');
  assert.ok(!/\d/.test(b.textContent), `no count text in the cell: "${b.textContent}"`);
  assert.match(b.querySelector('button').title, /all 2 open logstash-\* indices are under a policy[\s\S]*2 log indices in ILM error[\s\S]*logstash-1/);

  const ok = row(ilmData(['metrics-1']));
  const g = mount(P.lifecycleButton(ok, 'ILM', L.lifecycleView('ILM', ok.d, 'logstash-*'), L.ilmErrorsOf(ok.d, 'logstash-*'), L.ilmErrorTitle));
  assert.ok(!g.querySelector('.cl-errdot'), 'an error outside the log pattern shows no dot');
  assert.ok(g.querySelector('button.pill.grey'), 'which index has which policy not read: grey');
  assert.equal(g.querySelector('button').textContent, 'Running ?');

  const st = row({ slmStatus: { operation_mode: 'STOPPED' }, slm: [] });
  const stopped = mount(P.lifecycleButton(st, 'SLM', L.lifecycleView('SLM', st.d, 'logstash-*'), L.slmErrorsOf(st.d), L.slmErrorTitle));
  assert.ok(stopped.querySelector('button.pill.red'));
  assert.equal(stopped.querySelector('button').textContent, 'Stopped');
});

test('ILM is green only when every open log index has a policy; unknown is grey, never green', () => {
  const v = (of, mode = RUN) => L.lifecycleView('ILM', { ilm: mode, ilmOfIndex: of }, 'logstash-*');
  const all = v(managed(['logstash-a', 'logstash-b', 'metrics-1']));
  assert.deepEqual([all.tone, all.word, all.covered], ['green', 'Running', true]);
  const some = v({ ...managed(['logstash-a']), 'logstash-b': null, 'logstash-c': null, 'metrics-1': null });
  assert.deepEqual([some.tone, some.word, some.covered], ['red', 'Running', false]);
  assert.match(some.why, /2 of 3 open logstash-\* indices have no ILM policy: logstash-b, logstash-c/);
  assert.match(v({ ...managed(['logstash-a']), 'logstash-b': null }).why, /1 of 2 open logstash-\* indices has no ILM policy: logstash-b/);
  const none = v(managed(['metrics-1']));
  assert.deepEqual([none.tone, none.covered], ['red', false]);
  assert.match(none.why, /no open logstash-\* index/);
  const unknown = v(null);
  assert.deepEqual([unknown.tone, unknown.word, unknown.covered], ['grey', 'Running ?', null]);
  assert.match(unknown.why, /view_index_metadata/);
  assert.deepEqual([v(managed(['logstash-a']), { operation_mode: 'STOPPED' }).tone, v(managed(['logstash-a']), { operation_mode: 'STOPPED' }).word], ['red', 'Stopped']);
  assert.equal(v(managed(['logstash-a']), { operation_mode: 'STOPPING' }).word, 'Stopping');
  assert.deepEqual([L.lifecycleView('ILM', {}, 'logstash-*').tone, L.lifecycleView('ILM', {}, 'logstash-*').word], ['grey', 'Unknown']);
  // The cluster's own pattern decides, and a comma list counts every part.
  assert.equal(L.ilmCoverage({ ilmOfIndex: { 'filebeat-1': null, 'logstash-1': 'p' } }, 'logstash-*').ok, true);
  assert.equal(L.ilmCoverage({ ilmOfIndex: { 'filebeat-1': null, 'logstash-1': 'p' } }, 'logstash-*, filebeat-*').ok, false);
});

test('SLM is green when a scheduled policy takes the log indices', () => {
  const v = (slm, mode = RUN) => L.lifecycleView('SLM', { slmStatus: mode, slm }, 'logstash-*');
  assert.deepEqual([v([pol('daily')]).tone, v([pol('daily')]).word], ['green', 'Running']);
  assert.equal(v([pol('all', { policy: { schedule: 'x', config: {} } })]).tone, 'green', 'no indices named: every index');
  assert.equal(v([pol('star', { policy: { schedule: 'x', config: { indices: '*' } } })]).tone, 'green');
  const other = v([pol('metrics', { policy: { schedule: 'x', config: { indices: ['metrics-*'] } } })]);
  assert.equal(other.tone, 'red');
  assert.match(other.why, /no scheduled SLM policy takes logstash-\* \(metrics takes other indices\)/);
  assert.equal(v([pol('unscheduled', { policy: { config: { indices: ['logstash-*'] } } })]).tone, 'red', 'not scheduled: not looking after anything');
  assert.deepEqual([v(undefined).tone, v(undefined).word], ['grey', 'Running ?']);
  assert.match(v(undefined).why, /manage_slm or read_slm/);
  assert.equal(v([pol('daily')], { operation_mode: 'STOPPED' }).word, 'Stopped');
});

test('ilmOfIndex: the uuid says the index was listed; an answer without it (an older core) is not known', () => {
  const res = (value) => ({ ok: true, value });
  assert.deepEqual(S.ilmOfIndex(res({ a: { settings: { index: { uuid: 'u1', lifecycle: { name: 'p' } } } }, b: { settings: { index: { uuid: 'u2' } } } })),
    { a: 'p', b: null });
  assert.equal(S.ilmOfIndex(res({ a: { settings: { index: { lifecycle: { name: 'p' } } } } })), null, 'no uuid: the unmanaged ones were filtered out');
  assert.deepEqual(S.ilmOfIndex(res({})), {}, 'no open log index at all is known: none');
  assert.equal(S.ilmOfIndex({ ok: false }), null);
  assert.equal(S.ilmOfIndex(null), null);
});

test('the CSV says whether each covers the log indices: yes, no, or empty when not known', () => {
  const rows = [
    row({ ilm: RUN, ilmOfIndex: managed(['logstash-a']), slmStatus: RUN, slm: [pol('daily')] }),
    row({ ilm: RUN, ilmOfIndex: { 'logstash-a': null }, slmStatus: RUN, slm: [] }),
    row({ ilm: RUN, slmStatus: RUN }),
  ];
  const { data } = P.csvTable(rows, [{ id: 'ilm', name: 'ILM' }, { id: 'slm', name: 'SLM' }]);
  assert.deepEqual(data.map((d) => [d.ILM, d['ILM (covers log indices)'], d['SLM (covers log indices)']]),
    [['RUNNING', 'yes', 'yes'], ['RUNNING', 'no', 'no'], ['RUNNING', '', '']]);
});

test('sort: mode first, clusters with errors ahead of clean ones; the alert uses the same definition', () => {
  const key = (d) => P.SORTS.ilm.get(row(d));
  assert.ok(key(ilmData(['logstash-1'])) < key(ilmData([])), 'errors first within a mode');
  assert.equal(key({}), null, 'unknown sorts as unknown');
  assert.equal(key(ilmData(['metrics-1'])), key(ilmData([])), 'outside the pattern is not an error');
  const m = G.itemsOf({ key: 'c1:ilm', level: 'warning' }, { data: () => ilmData(['logstash-1', 'metrics-1']), defaults: {} });
  assert.deepEqual(m.map((i) => i.label), ['logstash-1']);
});
