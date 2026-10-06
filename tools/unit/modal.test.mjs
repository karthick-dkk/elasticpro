/** The one modal: Cancel and Escape must close it, from anywhere. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'KeyboardEvent', 'Event']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { modal, text } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/modal.js')).href);
const open = () => document.querySelectorAll('.modal').length;

test('a Cancel button calling ctx.close closes it — five dialogs did, and it threw', async () => {
  let cancel;
  const p = modal('t', '', [], (ctx) => { cancel = () => ctx.close(null); return []; });
  assert.equal(open(), 1);
  cancel();
  assert.equal(await p, null);
  assert.equal(open(), 0);
});

test('Escape closes it even when the page stops the key on the way', async () => {
  // A page or menu handler that stops Escape must not keep the dialog open: the dialog
  // listens on the window, in the capture phase, before any of them.
  const blocker = (e) => e.stopPropagation();
  document.addEventListener('keydown', blocker, true);
  const input = text('f', '');
  const p = modal('t', '', [input], () => []);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // Raced against a timer: a dialog Escape cannot close is a promise that never settles,
  // and a test that hangs says nothing.
  const closed = await Promise.race([p.then(() => 'closed'), new Promise((r) => setTimeout(() => r('still open'), 300))]);
  assert.equal(closed, 'closed', 'Escape did not close the dialog');
  assert.equal(open(), 0);
  document.removeEventListener('keydown', blocker, true);
});

test('a closed dialog stops listening — the next Escape is not its business', async () => {
  const p = modal('t', '', [], (ctx) => { setTimeout(() => ctx.done('ok'), 0); return []; });
  assert.equal(await p, 'ok');
  let seen = false;
  const later = (e) => { seen = e.key === 'Escape'; };
  window.addEventListener('keydown', later);
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(seen, true, 'a stale dialog listener swallowed the key');
  window.removeEventListener('keydown', later);
});

test('password fields ask browsers not to autofill, so no suggestion list eats Escape', () => {
  assert.equal(text('p', '', { type: 'password' }).getAttribute('autocomplete'), 'new-password');
  assert.equal(text('n', '').getAttribute('autocomplete'), 'off');
});
