/**
 * Your settings (ui/your-settings.js) offers exactly the spellings the core keeps
 * (core/prefs-rules.js, docs/HANDBOOK.md "Your settings"): a choice the panel offers and the
 * core refuses would be a setting that silently never sticks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://ep.test/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only */ }
}
const Y = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/your-settings.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/prefs-rules.js')).href);

test('the menu positions are the core\'s', () => {
  assert.deepEqual(Y.MENU_POSITIONS.map(([v]) => v).sort(), [...R.MENUS].sort());
  assert.equal(Y.MENU_POSITIONS[0][0], 'left', 'the left menu is offered first: it is the default');
  assert.equal(Y.normaliseMenuPosition('top'), 'top');
  assert.equal(Y.normaliseMenuPosition('sideways'), 'left', 'anything but a chosen top menu is the left one (0.3.72)');
  assert.equal(Y.normaliseMenuPosition(null), 'left');
});

test('"Opens on" offers the core\'s choices, plus "not chosen" (the config default)', () => {
  const offered = Y.OPENS_ON.map(([v]) => v);
  assert.equal(offered[0], '');
  assert.deepEqual(offered.slice(1), R.OPENS_ON);
  for (const v of offered.slice(1)) assert.ok(R.isChoice('opensOn', v));
  // "Not chosen" is sent as null, which unsets it on the account.
  assert.deepEqual(R.changePatch('opensOn', null), { opensOn: null });
});

test('the panel saves what was picked, icons only, and says where it is kept', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const got = [];
  const el = Y.openYourSettings(anchor, {
    prefs: { menu: 'top', theme: 'dark', opensOn: '' }, supported: true,
    themes: R.THEMES.map((id) => ({ id, label: `\u25D0 ${id}` })), who: { name: 'ann', role: 'admin' },
    onChange: (k, v) => got.push([k, v]), onSignOut: null,
  });
  assert.match(el.title, /Kept with your account/);
  assert.ok(![...el.querySelectorAll('.ys-seg button')].some((b) => /[A-Za-z]/.test(b.textContent)), 'a menu or theme button carries words, not an icon');
  assert.ok([...el.querySelectorAll('.ys-seg button')].every((b) => b.title && b.getAttribute('aria-label')), 'an icon button has no name');
  el.querySelector('button[data-menu="left"]').click();
  const open = el.querySelector('#ys-open');
  open.value = 'all'; open.dispatchEvent(new window.Event('change'));
  assert.deepEqual(got, [['menu', 'left'], ['opensOn', 'all']]);
  el.querySelector('#ys-theme button[data-theme="light"]').click();
  assert.deepEqual(got.at(-1), ['theme', 'light']);
  assert.deepEqual([...el.querySelectorAll('#ys-theme button')].map((b) => b.dataset.theme), R.THEMES);
  Y.closeYourSettings();
  const older = Y.openYourSettings(anchor, { prefs: { menu: 'top', theme: 'system', opensOn: '' }, supported: false, themes: null, who: null, onChange: () => {}, onSignOut: null });
  assert.match(older.title, /Kept in this browser/);
  assert.equal(older.querySelector('#ys-theme'), null, 'a theme is offered where Zabbix owns it');
  Y.closeYourSettings();
});
