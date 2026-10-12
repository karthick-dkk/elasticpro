/** A refused sign-in clears the password and nothing else: the name stays typed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://ep.test/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'KeyboardEvent', 'Event', 'sessionStorage']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
// The core's answer to a wrong password, verbatim shape; what it says is not the point here.
const replies = [];
globalThis.fetch = async (_url, init) => {
  replies.push(JSON.parse(init.body));
  return { json: async () => ({ ok: false, kind: 'bad_credentials', message: 'that username and password do not match an account' }) };
};
const { loginScreen } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/login.js')).href);
const tick = () => new Promise((r) => setTimeout(r, 20));
const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

test('after a refusal the user name is still there and only the password is cleared', async () => {
  loginScreen(document.getElementById('root'));
  document.getElementById('login-name').value = 'elasticpro';
  document.getElementById('login-pw').value = 'not-the-password';
  enter(document.getElementById('login-pw'));
  await tick();
  assert.equal(replies.length, 1, 'one LOGIN was sent');
  assert.equal(replies[0].type, 'LOGIN');
  assert.ok(document.querySelector('.banner.err'), 'the refusal banner is shown');
  assert.equal(document.getElementById('login-name').value, 'elasticpro', 'the name was wiped by the redraw');
  assert.equal(document.getElementById('login-pw').value, '', 'the password must be cleared');
});

test('a validation refusal before any request keeps the name too', async () => {
  // "Enter a user name" is impossible to hit with a name, so use the bootstrap screen,
  // whose short-password check also redraws before anything is sent.
  const before = replies.length;
  loginScreen(document.getElementById('root'), { bootstrap: true });
  document.getElementById('login-name').value = 'first-admin';
  document.getElementById('login-pw').value = 'short';
  document.getElementById('login-pw2').value = 'short';
  enter(document.getElementById('login-pw2'));
  await tick();
  assert.equal(replies.length, before, 'nothing was sent for a password the form already knows is too short');
  assert.equal(document.getElementById('login-name').value, 'first-admin');
});
