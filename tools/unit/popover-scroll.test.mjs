/**
 * A floating panel closes when the PAGE scrolls, never when the panel does.
 *
 * It listens for `scroll` on the window in the capture phase, which hears scrolling
 * anywhere — including the panel's own list. It used to close on all of it, so the bell's
 * notification list and the alert-notes popover closed on the first wheel tick and could
 * never be scrolled ("not able to mouse-scroll the alerts"). jsdom does no layout, so
 * this fires the scroll events themselves; tools/scroll-check.mjs does the real wheel.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'customElements']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { popover, closePopover, rowMenu, closeMenus } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/menu.js')).href);
const { h } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/dom.js')).href);

const scrollOn = (el) => el.dispatchEvent(new window.Event('scroll'));
const popOpen = () => !!document.querySelector('.pop');
const menuOpen = () => !!document.querySelector('.menu-pop');

let page;
beforeEach(() => {
  closePopover(); closeMenus();
  document.body.replaceChildren();
  page = h('div.page', h('button', 'anchor'), h('div.far', 'elsewhere on the page'));
  document.body.append(page);
});

function openPopover() {
  popover(page.querySelector('button'), () => h('div.list', h('div.row', 'one'), h('div.row', 'two')), { title: 't' });
  assert.ok(popOpen());
}

test('a scroll inside the popover does not close it', () => {
  openPopover();
  scrollOn(document.querySelector('.pop .list'));
  scrollOn(document.querySelector('.pop > .body'));
  assert.ok(popOpen(), 'the popover closed while its own list scrolled');
});

/** jsdom lays nothing out, so the anchor's position is whatever the test says it is. */
function anchorAt(top) {
  const btn = page.querySelector('button');
  btn.getBoundingClientRect = () => ({ top, left: 10, right: 50, bottom: top + 20, width: 40, height: 20 });
  return btn;
}
const aWhileLater = () => mock.timers.tick(2000);   // past the "somebody just scrolled" window

test('the page scrolled by the wheel closes it, even if the anchor is where it was', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    openPopover();
    page.dispatchEvent(new window.Event('wheel', { bubbles: true }));
    scrollOn(page.querySelector('.far'));
    assert.ok(!popOpen(), 'the page scrolled away from the anchor and the popover stayed');
  } finally { mock.timers.reset(); }
});

test('a scroll outside with the anchor moved closes it', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const btn = anchorAt(100);
    openPopover();
    aWhileLater();
    btn.getBoundingClientRect = () => ({ top: 40, left: 10, right: 50, bottom: 60, width: 40, height: 20 });
    scrollOn(document);
    assert.ok(!popOpen());
  } finally { mock.timers.reset(); }
});

test('a scroll nobody caused, anchor unmoved (a refresh resizing the page), keeps it', () => {
  // The browser adjusts the scroll offset when new data changes the document's height and
  // fires `scroll`; the notes someone was reading must not shut because of it.
  mock.timers.enable({ apis: ['Date'] });
  try {
    anchorAt(100);
    openPopover();
    aWhileLater();
    scrollOn(document);
    assert.ok(popOpen(), 'a scroll event with no wheel and no movement closed the popover');
  } finally { mock.timers.reset(); }
});

test('a scroll after the anchor was redrawn away closes it', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    anchorAt(100);
    openPopover();
    aWhileLater();
    page.querySelector('button').remove();
    scrollOn(document);
    assert.ok(!popOpen());
  } finally { mock.timers.reset(); }
});

test('a wheel inside the popover is not page-scrolling input', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    anchorAt(100);
    openPopover();
    aWhileLater();
    document.querySelector('.pop .list').dispatchEvent(new window.Event('wheel', { bubbles: true }));
    scrollOn(document);               // a refresh lands while the list is being wheeled
    assert.ok(popOpen());
  } finally { mock.timers.reset(); }
});

test('a closed popover leaves no scroll listener behind', () => {
  openPopover();
  closePopover();
  openPopover();                       // a second one, to see the first was not still listening
  scrollOn(document.querySelector('.pop .list'));
  assert.ok(popOpen());
});

test('the row menu follows the same rule', () => {
  const trigger = rowMenu([{ label: 'Open', onClick() {} }]);
  page.append(trigger);
  trigger.click();
  assert.ok(menuOpen());
  scrollOn(document.querySelector('.menu-pop button'));
  assert.ok(menuOpen(), 'the menu closed while scrolling inside itself');
  page.dispatchEvent(new window.Event('wheel', { bubbles: true }));
  scrollOn(page.querySelector('.far'));
  assert.ok(!menuOpen(), 'the menu stayed after the page scrolled');
});
