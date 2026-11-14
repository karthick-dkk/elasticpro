/**
 * The pure parts of the Log Delay "i" popover (ui/js/logdelay/fix-popover.js): what a row's fixes
 * are read from (the core's words, never the UI's), and where the popover is placed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
const { fixesFor, place, fixButton, NO_FINDING } = await import(pathToFileURL(path.join(ROOT, 'ui/js/logdelay/fix-popover.js')).href);

test("a device's finding is shown in the core's words, with the step as the place", () => {
  const fix = { step: 'forwarder', stepLabel: 'Forwarder', why: 'w', fix: 'x', devices: ['a'] };
  assert.deepEqual(fixesFor({ device: 'a', fix }), [{ title: 'Forwarder', cause: 'w', fix: 'x', where: 'Forwarder', count: null }]);
  assert.equal(fixesFor({ finding: fix })[0].fix, 'x');
});

test("a cluster's fixes carry their device count", () => {
  const c = fixesFor({ fixes: [{ step: 'elasticsearch', stepLabel: 'Elasticsearch', why: 'w', fix: 'x', devices: ['a', 'b'] }] }, 'cluster');
  assert.equal(c[0].count, 2);
  assert.equal(c[0].where, 'Elasticsearch');
});

test('a device with no finding says so and invents no fix', () => {
  const [one] = fixesFor({ state: 'delay', fix: null });
  assert.equal(one.cause, NO_FINDING);
  assert.equal(one.fix, '');
  assert.deepEqual(fixesFor(null), []);
});

test('the popover flips above and stays inside the window', () => {
  assert.deepEqual(place({ right: 300, bottom: 100, top: 80 }, 200, 100, 800, 600), { left: 100, top: 106 });
  assert.deepEqual(place({ right: 300, bottom: 560, top: 540 }, 200, 100, 800, 600), { left: 100, top: 434 });
  assert.equal(place({ right: 50, bottom: 10, top: 0 }, 200, 100, 800, 600).left, 8);
  assert.equal(place({ right: 900, bottom: 10, top: 0 }, 200, 100, 800, 600).left, 592);
});

test('the button names what it is for', () => {
  const d = fixButton({ kind: 'device', id: 'fw-1', items: () => [] });
  assert.equal(d.getAttribute('aria-label'), 'Recommended fix for fw-1');
  assert.equal(d.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(d.getAttribute('aria-expanded'), 'false');
  assert.equal(fixButton({ kind: 'about', id: 'Live Watch', items: [] }).getAttribute('aria-label'), 'About Live Watch');
});
