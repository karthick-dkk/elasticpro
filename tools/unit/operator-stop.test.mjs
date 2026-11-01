/**
 * An operator begins and ends the emergency stop (roles plan, decision 2).
 *
 * `mayStop()` offers the stop to an operator as well as an admin, not to an operator limited
 * to some clusters (it holds every cluster), never to a user or a display link. The Request
 * Centre opens for an operator with the stop card alone — no request log, no housekeeping —
 * asks first as it does an admin, and sends POLICY_PAUSE {minutes} / POLICY_RESUME, never
 * POLICY_SET (the rest of the policy stays an admin's). The top bar's pill is a Resume button
 * for an operator, and that sends POLICY_RESUME alone. Nothing here touches a real core.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="view"></div></body></html>', { url: 'https://ep.test/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'localStorage', 'sessionStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}

const POLICY = { mode: 'hybrid', budgetPerClusterPerMin: 12, concurrency: { global: 4, perCluster: 1, tunnel: 6 }, paused: { all: false } };
let paused = { all: false };
const sent = [];
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg);
  if (msg.type === 'POLICY_PAUSE') {
    const now = Date.now();
    paused = { all: true, minutes: msg.minutes, since: now, until: now + msg.minutes * 60000, by: 'olga' };
  }
  if (msg.type === 'POLICY_RESUME') paused = { all: false };
  const reply = ['POLICY_GET', 'POLICY_PAUSE', 'POLICY_RESUME'].includes(msg.type)
    ? { ok: true, policy: { ...POLICY, paused }, saved: msg.type !== 'POLICY_GET' }
    : { ok: true };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply, text: async () => JSON.stringify(reply) };
};

const P = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/policy.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/pages/requests.js')).href);
const Pill = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/paused-pill.js')).href);
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const view = () => document.getElementById('view');
const dialog = () => document.querySelector('.modal-overlay .modal');
const press = (label, scope) => {
  const b = [...scope.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
  assert.ok(b, `a "${label}" button`);
  b.click();
};
const types = () => sent.map((m) => m.type);

test('who is offered the stop: an operator who sees every cluster, an admin, the portable build', () => {
  const cases = [
    [null, true, 'portable: no accounts'],
    [{ name: 'Admin', role: 'admin' }, true, 'admin'],
    [{ name: 'z@zabbix', role: 'admin', scoped: true }, true, 'a limited admin may set the whole policy anyway'],
    [{ name: 'olga', role: 'operator' }, true, 'operator'],
    [{ name: 'uma@zabbix', role: 'operator', scoped: true }, false, 'a limited operator: the stop holds every cluster'],
    [{ name: 'ursula', role: 'user' }, false, 'user'],
    [{ name: 'g', role: 'guest' }, false, 'guest'],
    [{ name: 'display:Lobby', role: 'user', playOnly: true }, false, 'display link'],
    [{ name: 'display:Lobby', role: 'admin', playOnly: true }, false, 'a display link, whatever its role'],
  ];
  for (const [caller, want, why] of cases) assert.equal(P.mayStop(caller), want, why);
  assert.match(P.stopRefusal({ role: 'operator', scoped: true }), /limited to some clusters/);
  assert.equal(P.stopRefusal({ role: 'user' }), '', 'pausedLine already says who can');
  assert.equal(P.stopRefusal({ role: 'operator' }), '');
});

test('the stop line names operators as well as administrators', () => {
  const now = Date.UTC(2026, 10, 1, 10, 0);
  assert.match(P.pausedLine({ all: true, since: now - 60000, until: now + 600000, by: 'olga' }, { now }), /an operator or administrator can end it sooner/);
});

test('an operator opens the Request Centre on the stop alone, which asks first and sends POLICY_PAUSE', async () => {
  S.state.caller = { name: 'olga', role: 'operator' };
  paused = { all: false }; sent.length = 0;
  R.render(view());
  await tick(150);
  assert.ok(!types().includes('REQUEST_LOG'), `the log is an admin's: sent ${types()}`);
  assert.ok(!types().includes('HOUSEKEEPING_GET'), `housekeeping is an admin's: sent ${types()}`);
  assert.ok(types().includes('POLICY_GET'));
  assert.ok(!view().querySelector('.rq-status') && !view().querySelector('.rq-tbl') && !view().querySelector('.rq-tiles'), 'no log, figures or status line');
  const card = view().querySelector('.rq-stop');
  assert.ok(card && /Emergency stop/.test(card.textContent), 'the stop card');
  const lengths = [...card.querySelectorAll('button[data-act="pause-all"]')].map((b) => b.textContent);
  assert.deepEqual(lengths, ['15 min', '30 min', '60 min'], 'the same three lengths as an admin');

  // It asks first; No sends nothing.
  press('30 min', card);
  await tick();
  assert.ok(dialog() && /Stop all requests for 30 minutes\?/.test(dialog().textContent), 'asked first');
  press('No', dialog());
  await tick();
  assert.ok(!types().some((t) => t === 'POLICY_PAUSE' || t === 'POLICY_SET'), 'No stops nothing');

  press('30 min', view().querySelector('.rq-stop'));
  await tick();
  press('Stop for 30 min', dialog());
  await tick(150);
  const ask = sent.find((m) => m.type === 'POLICY_PAUSE');
  assert.deepEqual(ask && { type: ask.type, minutes: ask.minutes, policy: ask.policy }, { type: 'POLICY_PAUSE', minutes: 30, policy: undefined }, 'the stop alone, no policy');
  assert.ok(!types().includes('POLICY_SET'), 'never the whole policy');

  const stopped = view().querySelector('.rq-stop');
  assert.ok(stopped.classList.contains('paused') && /It ends by itself/.test(stopped.textContent), 'the card says until when');
  press('Resume now', stopped);
  await tick(150);
  assert.ok(types().includes('POLICY_RESUME') && !types().includes('POLICY_SET'), `Resume now sent ${types()}`);
  assert.ok(view().querySelector('.rq-stop button[data-act="pause-all"]'), 'offered again after resuming');
  R.onLeave();
});

test('an operator limited to some clusters sees the stop and why it is not theirs', async () => {
  S.state.caller = { name: 'uma@zabbix', role: 'operator', scoped: true };
  paused = { all: false }; sent.length = 0;
  R.render(view());
  await tick(150);
  const card = view().querySelector('.rq-stop');
  assert.ok(card, 'the card');
  assert.equal(card.querySelectorAll('button').length, 0, 'no stop buttons');
  assert.match(card.textContent, /limited to some clusters/);
  R.onLeave();
});

test('an admin still gets the log, and the stop through the same narrow messages', async () => {
  S.state.caller = { name: 'Admin', role: 'admin' };
  paused = { all: false }; sent.length = 0;
  R.render(view());
  await tick(150);
  assert.ok(types().includes('REQUEST_LOG') && types().includes('HOUSEKEEPING_GET'), `sent ${types()}`);
  press('15 min', view().querySelector('.rq-stop'));
  await tick();
  press('Stop for 15 min', dialog());
  await tick(150);
  assert.ok(sent.some((m) => m.type === 'POLICY_PAUSE' && m.minutes === 15) && !types().includes('POLICY_SET'), `sent ${types()}`);
  R.onLeave();
});

test('the top bar: a Resume button for an operator that sends POLICY_RESUME alone; a pill for a user', async () => {
  S.setFleetMode('fleet');
  const now = Date.now();
  S.fleet.policy = { mode: 'hybrid', pausedAll: true, pausedSince: now - 60000, pausedUntil: now + 600000, pausedBy: 'Admin' };
  const user = { name: 'ursula', role: 'user' };
  const pill = Pill.pausedPill({ selected: 'all', mayEnd: P.mayStop(user), refusal: P.stopRefusal(user) });
  assert.equal(pill.tagName, 'SPAN', 'a user is told, not offered');
  assert.match(pill.title, /an operator or administrator can end it sooner/);
  const scoped = { name: 'uma@zabbix', role: 'operator', scoped: true };
  const sp = Pill.pausedPill({ selected: 'all', mayEnd: P.mayStop(scoped), refusal: P.stopRefusal(scoped) });
  assert.equal(sp.tagName, 'SPAN');
  assert.match(sp.title, /limited to some clusters/);

  const op = { name: 'olga', role: 'operator' };
  let resumed = 0;
  const btn = Pill.pausedPill({ selected: 'all', mayEnd: P.mayStop(op), refusal: P.stopRefusal(op), onResumed: () => { resumed++; } });
  assert.equal(btn.tagName, 'BUTTON');
  assert.match(btn.textContent, /Resume$/);
  document.body.append(btn);
  sent.length = 0;
  btn.click();
  await tick();
  assert.ok(dialog() && /End the emergency stop now\?/.test(dialog().textContent), 'asks first');
  press('Resume now', dialog());
  await tick(150);
  assert.deepEqual(types(), ['POLICY_RESUME'], 'the stop alone: no POLICY_GET and POLICY_SET of the whole policy');
  assert.equal(resumed, 1);
  btn.remove();
  S.fleet.policy = null;
  S.setFleetMode(null);
});
