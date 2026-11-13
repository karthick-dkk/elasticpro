/**
 * Zabbix hosts held for review (core/zabbix-review.js, ui/zabbix-review.js): the side-by-side
 * says what differs and never invents a value; the dialog sends nothing until Confirm, and then
 * exactly one ZABBIX_CONFLICT_DECIDE naming the values it showed; Cancel sends nothing; the
 * preview applies nothing. Nothing here touches a real core.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://ep.test/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'KeyboardEvent', 'Event', 'CustomEvent', 'localStorage', 'sessionStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}

const sent = [];
let answer = { ok: true };
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg);
  const reply = typeof answer === 'function' ? answer(msg) : answer;
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply, text: async () => JSON.stringify(reply) };
};

const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/zabbix-review.js')).href);
const U = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/zabbix-review.js')).href);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const dialog = () => document.querySelector('.modal-overlay .modal');
const button = (label) => [...dialog().querySelectorAll('button')].find((x) => x.textContent === label);

const ENTRY = {
  hostId: '202', host: 'lab-zbx', clusterId: 'zbx-lab-zbx', identity: 'http://10.0.0.5:9200', state: 'pending', decision: null,
  decidedBy: '', decidedAt: 0, firstSeen: 1, fingerprint: 'abc123',
  existing: { kind: 'config', id: 'lab', hostId: '', values: { name: 'lab', url: 'HTTP://10.0.0.5:9200/', via: 'jumpa', tls: 'system', tags: ['eu'], enabled: true, username: null } },
  zabbix: { name: 'lab-zbx', url: 'http://10.0.0.5:9200', host: 'lab-zbx', via: null, username: 'svc', client: 'acme', tags: ['acme'], tls: null, enabled: true,
    macros: 'HOST=10.0.0.5 SCHEME=http PORT=(not set)' },
  decidedValues: null,
};

test('side by side: what differs is marked, and not set is a dash', () => {
  const rows = R.sideBySide(ENTRY);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual([by.name.old, by.name.new, by.name.differs], ['lab', 'lab-zbx', true]);
  assert.deepEqual([by.via.old, by.via.new], ['jumpa', '—'], 'Zabbix routes it directly: a dash, never a guess');
  assert.deepEqual([by.username.old, by.username.new], ['—', 'svc']);
  assert.equal(by.enabled.differs, false);
  assert.equal(R.existingLabel(ENTRY), 'config-file cluster lab');
  assert.equal(R.existingLabel({ existing: { kind: 'zabbix', id: 'zbx-a', values: { name: 'es-a' } } }), 'Zabbix host es-a');
  assert.match(R.updateMeans(ENTRY), /config-file cluster is set aside/);
  assert.match(R.updateMeans({ existing: { kind: 'zabbix' } }), /no longer built/);
});

test('states, and what changed since a decision', () => {
  assert.equal(R.stateLabel(ENTRY), 'Waiting for review');
  const changed = { ...ENTRY, state: 'changed', decision: 'keepBoth', decidedValues: { ...ENTRY.zabbix, name: 'old' } };
  assert.match(R.stateLabel(changed), /^Keep both — Zabbix changed since/);
  assert.deepEqual(R.changedSinceDecided(changed), ['name']);
  assert.equal(R.stateLabel({ ...ENTRY, state: 'decided', decision: 'skip' }), 'Skip');
  assert.equal(R.needsReview([ENTRY, changed, { state: 'decided' }]), 2);
  const s = R.previewSummary({ add: [{}], change: [], remove: [{}, {}], hold: [ENTRY], wouldCreate: [], unchanged: 7 });
  assert.equal(s.line, '1 to add · 0 to change · 2 to remove · 1 held for review · 7 unchanged');
});

test('the dialog sends nothing until Confirm, then one decision naming the values it showed', async () => {
  sent.length = 0;
  answer = { ok: true, hostId: '202', decision: 'update', entry: { ...ENTRY, state: 'decided', decision: 'update' } };
  let decided = null;
  const done = U.reviewConflict(ENTRY, { onDecided: (r) => { decided = r; } });
  await tick();
  assert.ok(dialog(), 'the dialog opened');
  assert.match(dialog().textContent, /Nothing about that cluster has changed/);
  assert.equal(dialog().querySelectorAll('tr.zr-differs').length, 7, 'name, address, route, tags, user, certificates and the raw macros differ; polled does not');
  assert.match(dialog().textContent, /HOST=10\.0\.0\.5 SCHEME=http PORT=\(not set\)/, 'the macros as Zabbix holds them');
  assert.equal(button('Confirm').disabled, true, 'pending: no answer is chosen for the administrator');
  dialog().querySelector('input[value="update"]').click();
  assert.equal(button('Confirm').disabled, false);
  assert.equal(sent.length, 0, 'choosing sends nothing');
  button('Confirm').click();
  const res = await done;
  await tick();
  assert.equal(res.ok, true);
  assert.deepEqual(sent, [{ type: 'ZABBIX_CONFLICT_DECIDE', hostId: '202', decision: 'update', fingerprint: 'abc123' }]);
  assert.equal(decided && decided.decision, 'update');
  assert.equal(dialog(), null, 'closed');
});

test('Cancel sends nothing; a refusal stays in the dialog', async () => {
  sent.length = 0;
  const done = U.reviewConflict({ ...ENTRY, state: 'decided', decision: 'skip' });
  await tick();
  assert.equal(dialog().querySelector('input[value="skip"]').checked, true, 'a decided one opens on its decision');
  button('Cancel').click();
  assert.equal(await done, null);
  assert.equal(sent.length, 0);

  answer = { ok: false, kind: 'changed_since_review', message: 'Zabbix’s values for this host changed since the review was opened: open it again' };
  const again = U.reviewConflict(ENTRY);
  await tick();
  dialog().querySelector('input[value="keepBoth"]').click();
  button('Confirm').click();
  await tick(60);
  assert.ok(dialog(), 'still open');
  assert.match(dialog().textContent, /changed since the review was opened/);
  button('Cancel').click();
  assert.equal(await again, null);
});

test('the card lists every conflict, waiting first; none is no card', () => {
  assert.equal(U.zabbixReviewCard({ held: [] }), null);
  assert.equal(U.zabbixReviewCard(null), null);
  const card = U.zabbixReviewCard({ held: [ENTRY, { ...ENTRY, hostId: '205', host: 'web-zbx', state: 'decided', decision: 'keepBoth', decidedBy: 'sara' }] });
  assert.match(card.textContent, /1 waiting · 1 decided/);
  assert.deepEqual([...card.querySelectorAll('tr[data-held]')].map((tr) => tr.dataset.held), ['202', '205']);
  assert.deepEqual([...card.querySelectorAll('button')].map((b) => b.textContent), ['Review…', 'Change…']);
});

test('the preview asks once and applies nothing', async () => {
  sent.length = 0;
  answer = { ok: true, dryRun: true, add: [{ name: 'es-new', url: 'http://10.0.0.7:9200', host: 'es-new' }], change: [], remove: [],
             hold: [ENTRY], wouldCreate: [], skipped: [], unchanged: 3, lastSync: 1 };
  const done = U.previewSync();
  await tick();
  assert.deepEqual(sent.map((m) => m.type), ['ZABBIX_SYNC_PREVIEW']);
  assert.match(dialog().textContent, /1 to add · 0 to change · 0 to remove · 1 held for review · 3 unchanged/);
  assert.match(dialog().textContent, /nothing was applied/);
  button('Close').click();
  await done;
  assert.equal(sent.length, 1, 'closing sends nothing');
});
