/**
 * Play's browser full screen: the toggle never throws, only gives the screen back if Play
 * took it, and the ⛶ button is withheld where the frame does not allow full screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const m = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/fullscreen.js')).href);

function fakeDoc({ refuse = false, enabled = true, api = true, prefixed = false } = {}) {
  const fns = {};
  const doc = {
    fullscreenElement: null, fullscreenEnabled: enabled, calls: { req: 0, exit: 0 },
    addEventListener: (ev, fn) => { fns[ev] = fn; },
    fire: () => fns.fullscreenchange && fns.fullscreenchange(),
    exitFullscreen: async () => { doc.calls.exit++; doc.fullscreenElement = null; doc.fire(); },
  };
  const request = async () => {
    doc.calls.req++;
    if (refuse) throw new TypeError('Permissions check failed');
    doc.fullscreenElement = doc.documentElement; doc.fire();
  };
  doc.documentElement = api ? (prefixed ? { webkitRequestFullscreen: request } : { requestFullscreen: request }) : {};
  return doc;
}

test('request enters full screen and toggle leaves it', async () => {
  const d = fakeDoc(); const fs = m.createFullscreen(d);
  assert.equal(await fs.request(), true);
  assert.equal(fs.active(), true);
  await fs.toggle();
  assert.equal(fs.active(), false);
  assert.equal(d.calls.exit, 1);
});

test('a refusal is not an error', async () => {
  const fs = m.createFullscreen(fakeDoc({ refuse: true }));
  assert.equal(await fs.request(), false);
  assert.equal(await fs.toggle(), false);
  assert.equal(fs.active(), false);
});

test('no API, or a frame that disallows it: unsupported, and requests resolve false', async () => {
  const none = m.createFullscreen(fakeDoc({ api: false }));
  assert.equal(none.supported(), false);
  assert.equal(await none.request(), false);
  const framed = m.createFullscreen(fakeDoc({ enabled: false }));
  assert.equal(framed.supported(), false);
  assert.equal(await framed.request(), false);
});

test('the webkit-prefixed request is used when the standard one is missing', async () => {
  const d = fakeDoc({ prefixed: true }); const fs = m.createFullscreen(d);
  assert.equal(fs.supported(), true);
  assert.equal(await fs.request(), true);
  assert.equal(d.calls.req, 1);
});

test('leaving Play exits only what Play entered', async () => {
  const d = fakeDoc(); const fs = m.createFullscreen(d);
  d.fullscreenElement = {};                       // the person was already full screen
  await fs.leavePlay();
  assert.equal(d.calls.exit, 0);
  d.fullscreenElement = null;
  await fs.request();
  await fs.leavePlay();
  assert.equal(d.calls.exit, 1);
  assert.equal(fs.active(), false);
});

test('Esc leaving full screen forgets that Play entered it, and tells subscribers', async () => {
  const d = fakeDoc(); const fs = m.createFullscreen(d);
  const seen = []; fs.subscribe((on) => seen.push(on));
  await fs.request();
  d.fullscreenElement = null; d.fire();           // Esc
  assert.equal(fs.ours(), false);
  assert.deepEqual(seen, [true, false]);
  await fs.leavePlay();
  assert.equal(d.calls.exit, 0);
});

test('the hint dismissal survives a broken store', () => {
  assert.equal(m.hintDismissed({ getItem() { throw new Error('blocked'); } }), false);
  m.dismissHint({ setItem() { throw new Error('blocked'); } });
  const mem = {}; const store = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
  assert.equal(m.hintDismissed(store), false);
  m.dismissHint(store);
  assert.equal(m.hintDismissed(store), true);
});
