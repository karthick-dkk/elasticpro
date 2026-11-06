/**
 * Config-Management's one save bar: the change list (core/save-bar.js) and the DOM tracker
 * that feeds it (ui/change-tracker.js).
 *
 * The bar appears only when something changed, names each change, never shows a secret, and
 * Save runs the save path of each section involved — and only those. A section whose save
 * fails stays changed; one whose save works starts again from what is on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const B = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/save-bar.js')).href);

const f = (section, label, value, extra = {}) => ({ section, label, value, shown: B.shownValue(value), ...extra });

test('diffFields: only fields whose value moved, in page order', () => {
  const base = new Map([['p:a', f('p', 'Watch window', '15')], ['p:b', f('p', 'Health', '60')], ['p:c', f('p', 'On', true)]]);
  const now = new Map([['p:a', f('p', 'Watch window', '20')], ['p:b', f('p', 'Health', '60')], ['p:c', f('p', 'On', false)]]);
  const d = B.diffFields(base, now);
  assert.deepEqual(d.map((c) => [c.label, c.from, c.to]), [['Watch window', '15', '20'], ['On', 'on', 'off']]);
  assert.deepEqual(B.diffFields(base, base), []);
  assert.deepEqual(B.diffFields(null, now), []);
});

test('a secret is never shown, only that one was typed', () => {
  const base = new Map([['z:t', f('z', 'API token', '', { secret: true })]]);
  const now = new Map([['z:t', f('z', 'API token', 'hunter2', { secret: true })]]);
  const [c] = B.diffFields(base, now);
  assert.equal(c.to, 'new value typed');
  assert.equal(c.from, '');
  assert.ok(!B.changeText(c).includes('hunter2'));
  assert.ok(!B.changeSummary([c]).title.includes('hunter2'));
});

test('changeSummary: the count, the first few, "+N more", and all of them on hover', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ section: 's', sectionLabel: 'Requests', label: x, from: String(i), to: String(i + 1) }));
  const s = B.changeSummary(list);
  assert.equal(s.count, 5);
  assert.equal(s.head, '5 unsaved changes');
  assert.equal(s.list, 'a 0 → 1 · b 1 → 2 · c 2 → 3 · +2 more');
  assert.equal(s.title.split('\n').length, 5);
  assert.ok(s.title.startsWith('Requests › a 0 → 1'));
  assert.equal(B.changeSummary(list.slice(0, 1)).head, '1 unsaved change');
  assert.equal(B.changeSummary([]).count, 0);
  // A section with its own words (plan templates) says them as they are.
  assert.equal(B.changeText({ text: 'Plan template "Standard" edited' }), 'Plan template "Standard" edited');
});

test('shownValue: empty says so, long values are cut', () => {
  assert.equal(B.shownValue(''), 'empty');
  assert.equal(B.shownValue(null), 'empty');
  assert.equal(B.shownValue(true), 'on');
  assert.equal(B.shownValue('x'.repeat(60)).length, 40);
});

test('sectionsOf and mergeBaseline', () => {
  assert.deepEqual(B.sectionsOf([{ section: 'a' }, { section: 'b' }, { section: 'a' }]), ['a', 'b']);
  const base = new Map([['k', f('s', 'K', '1')]]);
  const merged = B.mergeBaseline(base, new Map([['k', f('s', 'K', '2')], ['n', f('s', 'N', 'x')]]));
  assert.equal(merged.get('k').value, '1', 'a field already in the baseline keeps its saved value');
  assert.equal(merged.get('n').value, 'x', 'a field drawn later starts unchanged');
  assert.equal(B.mergeBaseline(null, new Map([['n', f('s', 'N', 'x')]])).size, 1);
});

/* ------------------------------- the tracker, in a DOM ------------------------------- */

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://ep.test/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'NodeFilter']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only */ }
}
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/change-tracker.js')).href);
const root = document.getElementById('root');
/** What the "server" holds; draw() shows it, as a page draws from what is saved. */
let saved = { watch: '15', on: true, day: 'name' };
const draw = () => {
  root.innerHTML = `
    <div data-track="policy" data-track-label="Requests">
      <label class="field">Watch window (minutes)<input id="pol-watch" type="number" value="${saved.watch}"></label>
      <table><tr><td>Health<div>health</div></td><td><input id="pol-iv-health" value="60"></td></tr></table>
      <label><input id="pol-on" type="checkbox" ${saved.on ? 'checked' : ''}><span>Run on a timer</span></label>
      <select id="pol-mode" aria-label="Mode"><option value="auto">auto</option><option value="on-demand" selected>on-demand</option></select>
      <input id="pol-locked" value="9" disabled>
      <select id="pol-preview" data-untracked><option>a</option><option>b</option></select>
      <div role="radiogroup" aria-label="Which day"><label><input type="radio" name="day" value="name" ${saved.day === 'name' ? 'checked' : ''}> From the name</label><label><input type="radio" name="day" value="time" ${saved.day === 'time' ? 'checked' : ''}> From the time field</label></div>
    </div>
    <div data-track="smtp" data-track-label="Mail server"><label class="field">Password<input id="ms-password" type="password" value=""></label></div>`;
};

test('labels come off the page', () => {
  draw();
  assert.equal(T.labelOf(document.getElementById('pol-watch')), 'Watch window (minutes)');
  assert.equal(T.labelOf(document.getElementById('pol-iv-health')), 'Health');
  assert.equal(T.labelOf(document.getElementById('pol-on')), 'Run on a timer');
  assert.equal(T.labelOf(document.getElementById('pol-mode')), 'Mode');
});

test('the tracker: hidden until a change, names it, saves only the sections involved', async () => {
  saved = { watch: '15', on: true, day: 'name' };
  draw();
  const calls = [];
  let policyOk = false;
  const t = T.createTracker({ root: () => root });
  t.register('policy', { save: async () => {
    calls.push('policy');
    if (!policyOk) return false;
    saved = { watch: document.getElementById('pol-watch').value, on: document.getElementById('pol-on').checked, day: document.querySelector('input[name="day"]:checked').value };
    draw();
    return true;
  }, discard: () => draw() });
  t.register('smtp', { save: async () => { calls.push('smtp'); return true; }, discard: () => draw() });
  root.append(t.bar);
  assert.deepEqual(t.refresh(), []);
  assert.equal(t.bar.hidden, true, 'the bar shows with nothing changed');

  // Untracked and disabled fields never count.
  document.getElementById('pol-preview').value = 'b';
  document.getElementById('pol-locked').disabled = false; document.getElementById('pol-locked').value = '10'; document.getElementById('pol-locked').disabled = true;
  assert.deepEqual(t.refresh(), []);

  document.getElementById('pol-watch').value = '20';
  document.getElementById('pol-on').checked = false;
  document.querySelector('input[name="day"][value="time"]').checked = true;
  const ch = t.refresh();
  assert.deepEqual(ch.map((c) => `${c.label}: ${c.from} → ${c.to}`),
    ['Watch window (minutes): 15 → 20', 'Run on a timer: on → off', 'Which day: From the name → From the time field']);
  assert.equal(t.bar.hidden, false);
  assert.match(t.bar.textContent, /3 unsaved changes/);
  assert.match(t.bar.textContent, /Watch window \(minutes\) 15 → 20/);

  // Save runs the policy's save only (SMTP did not change); a failed save stays changed.
  assert.equal(await t.save(), false);
  assert.deepEqual(calls, ['policy']);
  assert.equal(t.changes().length, 3);
  // Once it works, what is on screen is the new saved state.
  policyOk = true;
  assert.equal(await t.save(), true);
  assert.deepEqual(calls, ['policy', 'policy']);
  assert.equal(document.getElementById('pol-watch').value, '20', 'the page did not redraw from what was saved');
  assert.deepEqual(t.changes(), []);
  assert.equal(t.bar.hidden, true);

  // A typed password is named, never shown; Discard redraws from what is saved.
  document.getElementById('ms-password').value = 's3cret';
  const [pw] = t.refresh();
  assert.equal(pw.label, 'Password');
  assert.ok(!t.bar.textContent.includes('s3cret'));
  t.discard();
  assert.deepEqual(t.changes(), []);
  assert.equal(document.getElementById('ms-password').value, '');
});

test('a section with its own model of what changed', () => {
  draw();
  let dirty = false;
  const t = T.createTracker({ root: () => root });
  root.insertAdjacentHTML('beforeend', '<div data-track="pt"><input id="pt-name" value="x"></div>');
  t.register('pt', { save: async () => true, changes: () => (dirty ? [{ key: 'pt:a', label: 'A', text: 'Plan template "A" edited' }] : []) });
  document.getElementById('pt-name').value = 'y';
  assert.deepEqual(t.refresh(), [], 'the fields of a model-tracked section counted on their own');
  dirty = true;
  const [c] = t.refresh();
  assert.equal(c.section, 'pt');
  assert.match(t.bar.textContent, /Plan template "A" edited/);
});

test('redraws are held while the sections save, so one section cannot wipe the next one\'s typing', async () => {
  // Two sections, like Zabbix's connection and its sync options: the first one's save redraws
  // the whole page from what is saved, which would put the second one's old value back.
  const held = { n: 0, wanted: false };
  let store = { url: 'a', opt: false };
  const page = () => {
    if (held.n) { held.wanted = true; return; }
    root.innerHTML = `<div data-track="link"><label class="field">URL<input id="z-url" value="${store.url}"></label></div>`
      + `<div data-track="opts"><label><input id="z-opt" type="checkbox" ${store.opt ? 'checked' : ''}><span>Create hosts</span></label></div>`;
  };
  page();
  const t = T.createTracker({
    root: () => root,
    beforeSave: () => { held.n += 1; },
    afterSave: () => { held.n -= 1; if (!held.n && held.wanted) { held.wanted = false; page(); } },
  });
  t.register('link', { save: async () => { store = { ...store, url: document.getElementById('z-url').value }; page(); return true; } });
  t.register('opts', { save: async () => { store = { ...store, opt: document.getElementById('z-opt').checked }; page(); return true; } });
  t.refresh();
  document.getElementById('z-url').value = 'b';
  document.getElementById('z-opt').checked = true;
  assert.equal(t.refresh().length, 2);
  assert.equal(await t.save(), true);
  assert.deepEqual(store, { url: 'b', opt: true }, 'the second section\'s change was lost to the first one\'s redraw');
  assert.deepEqual(t.changes(), []);
  assert.equal(document.getElementById('z-opt').checked, true, 'the page was not redrawn once at the end');
});
