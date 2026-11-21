/** UI-01 / UI-05: a sign-out that failed is not a sign-out, and a server that does not answer is not "no sign-in needed". */
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
let answer = null;          // a JSON reply, or an Error to throw (the network failed)
globalThis.fetch = async () => {
  if (answer instanceof Error) throw answer;
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(answer) };
};
const L = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/login.js')).href);
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/transport.js')).href);

test('a server that does not answer WHOAMI is unreachable, with the reason — not "no sign-in needed"', async () => {
  answer = new Error('Failed to fetch');
  const st = await L.authState();
  assert.equal(st.unreachable, true);
  assert.match(st.message, /did not answer/);
  answer = { ok: false, kind: 'core_unavailable', message: 'the ElasticPro core is not answering nginx' };
  assert.equal((await L.authState()).unreachable, true);
  // A core too old to know WHOAMI has no accounts, as before.
  answer = { ok: false, kind: 'bad_message', message: 'Unknown message type "WHOAMI"' };
  const old = await L.authState();
  assert.equal(old.unreachable, undefined);
  assert.equal(old.required, false);
  answer = { ok: true, authRequired: true, edition: 'hosted', caller: null };
  const live = await L.authState();
  assert.equal(live.unreachable, undefined);
  assert.equal(live.required, true);
});

test('a sign-out whose reply failed reports it and leaves the page signed in', async () => {
  T.setSignedIn(true); T.setSession('frame-token');
  answer = new Error('Failed to fetch');
  const r = await L.signOut();
  assert.notEqual(r.ok, true);
  assert.equal(T.getSession(), 'frame-token', 'a failed sign-out must not drop the session as if it had ended');
  answer = { ok: true };
  assert.equal((await L.signOut()).ok, true);
  assert.equal(T.getSession(), '', 'a sign-out that worked does');
});
