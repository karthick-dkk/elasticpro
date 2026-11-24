/**
 * A snapshot alert's two lines say the snapshot's start with the same zone (0.3.90): the detail was
 * labelled, the line under it was not. The CSV's column stays ISO UTC, as the file's other times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'localStorage', 'sessionStorage', 'navigator', 'matchMedia', 'location']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
globalThis.indexedDB = undefined;
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const { snapshotLine, alertsCsv } = await import(url('ui/js/pages/alerts.js'));
const { dtz } = await import(url('ui/js/lib/fmt.js'));

const at = Date.UTC(2026, 10, 21, 3, 41, 47);
const snapshot = { at, repo: 'daily', status: 'SUCCESS', id: 'snap-1', isNew: false };

test('the second line is written by the labelled formatter of the first', () => {
  assert.equal(snapshotLine(snapshot), `${dtz(at)} · daily · SUCCESS`);
  assert.match(snapshotLine(snapshot), /(GMT|UTC)/);
  assert.equal(snapshotLine({ at: null, repo: 'daily' }), '– · daily', 'no start is not a date');
});

test('the CSV column is the same moment, ISO UTC', () => {
  const row = { level: 'warning', cluster: { name: 'c', url: 'u' }, title: 't', detail: `snap-1 started ${dtz(at)}`, items: [], since: at, snapshot, state: 'open', notes: [], key: 'k', keys: ['k'] };
  const csv = alertsCsv([row, { ...row, snapshot: { ...snapshot, at: null } }]);
  assert.equal(csv.split('2026-11-21T03:41:47.000Z').length - 1, 1, 'the first row\'s snapshot date');
  assert.equal(csv.split(dtz(at)).length - 1, 2, 'the detail of both rows');
});
