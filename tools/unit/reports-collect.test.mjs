/**
 * Reports › Collect now and the empty record (docs/REPORTS.md): what a VOLUME_RUN answer says
 * in words (reports/collect.js runAnswer) — started, already collecting, too soon, unreachable,
 * the stop, the refusals — and why a record shows nothing (core/volume-daily.js
 * recordEmptyWhy): never just "nothing" when the record knows why.
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
const V = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume-daily.js')).href);
const K = await import(pathToFileURL(path.join(ROOT, 'ui/js/reports/collect.js')).href);

/* ------------------------------------ runAnswer ------------------------------------ */

test('a started run says it runs on the server and carries the run id', () => {
  const a = K.runAnswer({ ok: true, started: ['prod'], already: [], tooSoon: [], skipped: [], stopped: false, runId: '4b0e9f2c51ab03de' }, ['prod']);
  assert.equal(a.ok, true);
  assert.equal(a.level, 'info');
  assert.deepEqual(a.started, ['prod']);
  assert.equal(a.runId, '4b0e9f2c51ab03de');
  assert.match(a.message, /Collecting prod \(run 4b0e9f2c\)\. It runs on the server: you can leave this page\./);
});

test('already collecting is followed, too soon and refusals are said plainly', () => {
  const a = K.runAnswer({ ok: true, started: [], already: ['prod'], tooSoon: ['dr'], runId: 'aaaaaaaabbbbbbbb',
    skipped: [{ clusterId: 'lab', reason: 'unreachable' }, { clusterId: 'x', reason: 'unknown' }], stopped: false }, ['prod', 'dr', 'lab', 'x']);
  assert.equal(a.level, 'info');
  assert.deepEqual(a.already, ['prod']);
  const t = a.lines.map((l) => `${l.level}:${l.text}`);
  assert.ok(t.includes('info:prod was already collecting (run aaaaaaaa): following that run.'), t.join('\n'));
  assert.ok(t.includes('warn:dr was collected less than a minute ago: try again in a minute.'), t.join('\n'));
  assert.ok(t.some((l) => /^warn:lab: it cannot be reached: nothing was asked/.test(l)), t.join('\n'));
  assert.ok(t.some((l) => /^warn:x: it is not one of the clusters you see/.test(l)), t.join('\n'));
});

test('the emergency stop and nothing started are warnings, not silence', () => {
  const stopped = K.runAnswer({ ok: true, started: [], already: [], tooSoon: [], skipped: [{ clusterId: 'prod', reason: 'stopped' }], stopped: true }, ['prod']);
  assert.equal(stopped.level, 'warn');
  assert.match(stopped.message, /the emergency stop is on: nothing was sent/);
  const none = K.runAnswer({ ok: true, started: [], already: [], tooSoon: [], skipped: [] }, ['prod']);
  assert.equal(none.level, 'warn');
  assert.match(none.message, /Nothing was started for prod/);
});

test('a refused VOLUME_RUN keeps the core\'s words; the worker being down is amber', () => {
  assert.deepEqual(K.runAnswer({ ok: false, kind: 'config_unreadable', message: 'the config file could not be read: x' }).message, 'the config file could not be read: x');
  const w = K.runAnswer({ ok: false, kind: 'worker_unavailable', message: 'The report worker is not running' });
  assert.equal(w.level, 'warn');
  assert.equal(K.runAnswer({ ok: false, kind: 'forbidden', message: 'no' }).message, 'Could not start a collection: no');
  assert.equal(K.runAnswer({ ok: false, unsupported: true }).unsupported, true);
  assert.equal(K.runAnswer({ ok: false, kind: 'no_store' }).noStore, true);
  assert.equal(K.runAnswer(null).ok, false);
});

test('how a followed run ended, in words', () => {
  assert.equal(K.endText({ phase: 'running' }), null);
  assert.match(K.endText({ phase: 'ended', status: 'completed', records: 48, runId: 'abcdefabcdef0000' }).title, /^Collection finished · 48 days searched · run abcdefab$/);
  const f = K.endText({ phase: 'ended', status: 'failed', error: '2026-11-12: the search failed: Request timed out after 110.0 s (3 tries)' });
  assert.equal(f.level, 'err');
  assert.match(f.text, /3 tries/);
  assert.equal(K.endText({ phase: 'ended', status: 'deferred', error: 'prod is busy' }).level, 'warn');
  assert.equal(K.endText({ phase: 'lost', error: 'Lost touch' }).level, 'warn');
  // The run log did not show the run: the cluster's own last error, else finished.
  assert.equal(K.endText({ phase: 'ended', status: null, error: null }).level, 'ok');
  assert.equal(K.endText({ phase: 'ended', status: null, error: '_cat/indices: timed out' }).level, 'warn');
});

/* ---------------------------------- recordEmptyWhy ---------------------------------- */

const reply = (over = {}) => ({ ok: true, days: [], window: { days: 40 }, matched: 4, skipped: [], skippedCount: 0,
  status: { running: false, lastRunAt: 1794537853613, lastError: null, collectAt: '06:00' }, ...over });

test('a record with days to show has no empty reason; one without event_logsize says which field', () => {
  const days = [{ day: '2026-11-12', eventBytes: null }, { day: '2026-11-11', eventBytes: null }];
  assert.equal(V.recordEmptyWhy(reply({ days })), null, 'Daily shows the rows: not measured in the cells');
  const w = V.recordEmptyWhy(reply({ days, settings: { eventSize: ['event_logsize'] } }), { event: true });
  assert.equal(w.fix, 'eventSize');
  assert.match(w.reason, /event_logsize is not measured/);
  assert.equal(V.recordEmptyWhy(reply({ days: [{ day: '2026-11-12', eventBytes: 5 }] }), { event: true }), null);
});

test('why a record is empty: running, a source with no index, never collected, failed, no match, too old', () => {
  assert.match(V.recordEmptyWhy(reply({ status: { running: true, progress: { done: 3, total: 40 } } })).detail, /3 of 40 days searched/);
  const src = V.recordEmptyWhy(reply(), { source: 'paloalto-fw01' });
  assert.equal(src.fix, 'source');
  assert.match(src.reason, /No index of source paloalto-fw01 in the last 40 days/);
  const never = V.recordEmptyWhy(reply({ status: { running: false, lastRunAt: null, collectAt: '06:00' } }));
  assert.equal(never.fix, 'collect');
  assert.match(never.detail, /runs at 06:00/);
  const failed = V.recordEmptyWhy(reply({ newestDay: '2026-09-09', status: { lastRunAt: 1, lastError: '_cat/indices: No route to that address from this machine.' } }));
  assert.equal(failed.reason, 'The last collection did not finish.');
  assert.match(failed.detail, /No route .* · the record ends on 2026-09-09/);
  const none = V.recordEmptyWhy(reply({ matched: 0, skipped: ['metrics-2026.09'], skippedCount: 1 }));
  assert.equal(none.fix, 'pattern');
  assert.match(none.detail, /1 index was skipped .*metrics-2026\.09/);
  const old = V.recordEmptyWhy(reply({ newestDay: '2026-09-09' }));
  assert.match(old.reason, /the record ends on 2026-09-09/);
  assert.equal(V.recordEmptyWhy(reply()).reason, 'Nothing recorded yet for this cluster.');
  assert.equal(V.recordEmptyWhy(null), null);
});
