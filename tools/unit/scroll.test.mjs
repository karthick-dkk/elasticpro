/**
 * Re-rendering must not move the page.
 *
 * Every page here redraws by emptying its container and rebuilding it. That makes the
 * document briefly shorter than the current scroll offset, the browser clamps the offset
 * to the top, and re-appending does not put it back — so a search, a filter or a refresh
 * threw you to the top of the page. Nothing scrolled; the page just stopped being tall
 * enough for a moment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'CSS', 'customElements']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { h, mount } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/dom.js')).href);

/**
 * jsdom does no layout, so nothing clamps on its own. This models the one browser
 * behaviour that matters: when the content collapses to nothing, the scroll offset is
 * lost — not on the next read, not on the next write, but at the moment the last child
 * goes. Hooking removeChild is what makes that synchronous, the way it really is, so a
 * fix that captures the offset too late fails here exactly as it would on screen.
 */
function scroller() {
  const outer = document.createElement('div');
  const inner = document.createElement('div');
  outer.append(inner);
  let top = 0;
  Object.defineProperty(outer, 'scrollTop', {
    get: () => top,
    set: (v) => { top = v; },
    configurable: true,
  });
  const realRemove = inner.removeChild.bind(inner);
  inner.removeChild = (node) => {
    const out = realRemove(node);
    if (!inner.childNodes.length) top = 0;   // nothing left to scroll
    return out;
  };
  document.body.append(outer);
  return { outer, inner };
}

test('a redraw keeps the scroll position of the container above it', () => {
  const { outer, inner } = scroller();
  mount(inner, h('div', 'tall content'));
  outer.scrollTop = 420;

  mount(inner, h('div', 'tall content, redrawn'));
  assert.equal(outer.scrollTop, 420, 'the redraw scrolled the page back to the top');
  outer.remove();
});

test('the offset is captured before the container is emptied', () => {
  // The order is the whole fix: capture, clear, append, restore. Capturing after the
  // clear reads zero, restores zero, and is the bug.
  const { outer, inner } = scroller();
  mount(inner, h('div', 'x'));
  outer.scrollTop = 200;
  mount(inner, h('div', 'y'), h('div', 'z'));
  assert.equal(outer.scrollTop, 200);
  outer.remove();
});

test('an unscrolled page is left alone', () => {
  const { outer, inner } = scroller();
  mount(inner, h('div', 'x'));
  mount(inner, h('div', 'y'));
  assert.equal(outer.scrollTop, 0);
  outer.remove();
});

test('focus and caret still survive a redraw', () => {
  // The scroll restore runs alongside the focus restore that was already here; neither
  // may cost the other.
  const host = document.createElement('div');
  document.body.append(host);
  const input = h('input', { id: 'keep', type: 'text', value: 'hello world' });
  mount(host, input);
  const live = document.getElementById('keep');
  live.focus();
  live.setSelectionRange(3, 7);
  mount(host, h('input', { id: 'keep', type: 'text', value: 'hello world' }));
  const after = document.getElementById('keep');
  assert.equal(document.activeElement, after, 'focus was lost on redraw');
  assert.equal(after.selectionStart, 3);
  assert.equal(after.selectionEnd, 7);
  host.remove();
});
