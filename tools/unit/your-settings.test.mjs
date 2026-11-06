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
  assert.deepEqual(Y.MENU_POSITIONS.map(([v]) => v), R.MENUS);
  assert.equal(Y.normaliseMenuPosition('left'), 'left');
  assert.equal(Y.normaliseMenuPosition('sideways'), 'top');
  assert.equal(Y.normaliseMenuPosition(null), 'top');
});

test('"Opens on" offers the core\'s choices, plus "not chosen" (the config default)', () => {
  const offered = Y.OPENS_ON.map(([v]) => v);
  assert.equal(offered[0], '');
  assert.deepEqual(offered.slice(1), R.OPENS_ON);
  for (const v of offered.slice(1)) assert.ok(R.isChoice('opensOn', v));
  // "Not chosen" is sent as null, which unsets it on the account.
  assert.deepEqual(R.changePatch('opensOn', null), { opensOn: null });
});

test('the panel saves what was picked, and says where it is kept', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const got = [];
  const el = Y.openYourSettings(anchor, {
    prefs: { menu: 'top', theme: 'dark', opensOn: '' }, supported: true,
    themes: R.THEMES.map((id) => ({ id, label: `x ${id}` })), who: { name: 'ann', role: 'admin' },
    onChange: (k, v) => got.push([k, v]), onSignOut: null,
  });
  assert.match(el.textContent, /Kept with your account/);
  el.querySelector('button[data-menu="left"]').click();
  const open = el.querySelector('#ys-open');
  open.value = 'all'; open.dispatchEvent(new window.Event('change'));
  assert.deepEqual(got, [['menu', 'left'], ['opensOn', 'all']]);
  assert.deepEqual([...el.querySelectorAll('#ys-theme option')].map((o) => o.value), R.THEMES);
  Y.closeYourSettings();
  const older = Y.openYourSettings(anchor, { prefs: { menu: 'top', theme: 'system', opensOn: '' }, supported: false, themes: null, who: null, onChange: () => {}, onSignOut: null });
  assert.match(older.textContent, /Kept in this browser/);
  assert.equal(older.querySelector('#ys-theme'), null, 'a theme is offered where Zabbix owns it');
  Y.closeYourSettings();
});
