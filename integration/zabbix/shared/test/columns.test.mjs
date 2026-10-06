/**
 * ep-columns.js in a DOM: the Type filter (rows, their servers, the count), expanding a client,
 * the Columns dialog (what it posts), and the export following the filter. Needs jsdom — found
 * here or at the repository root (npm i jsdom); skipped, saying so, otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(HERE, '..');

function jsdom() {
  for (const base of [ROOT, path.resolve(ROOT, '../..')]) {
    try { return createRequire(path.join(base, 'package.json'))('jsdom'); } catch { /* next */ }
  }
  return null;
}

const HTML = `<div id="w">
  <span data-ep-count data-template="%n clients">2 clients</span>
  <select data-ep-type-filter><option value="">All</option><option value="DI">DI</option><option value="On-Prem">On-Prem</option></select>
  <button data-ep-expand-all>Expand all</button><button data-ep-columns>Columns</button>
  <button data-ep-export="csv">CSV</button><button data-ep-export="csv-servers">CSV servers</button>
  <table><tbody>
    <tr data-type="On-Prem" data-row="c0"><td></td><td>acme</td></tr>
    <tr data-type="DI" data-row="c1"><td><button data-ep-expand="c1" aria-expanded="false">▸</button></td><td>karthi</td></tr>
    <tr class="ep-sub" data-parent="c1" hidden><td></td><td>servers</td></tr>
  </tbody></table></div>`;

function setup(t, canEdit = true) {
  const lib = jsdom();
  if (!lib) { t.skip('jsdom not found — npm i jsdom at the repository root'); return null; }
  const dom = new lib.JSDOM(`<body>${HTML}</body>`, { runScripts: 'outside-only', url: 'https://zabbix.example/zabbix.php' });
  const w = dom.window;
  w.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
  const saved = [];
  w.eval(fs.readFileSync(path.join(HERE, 'ep-columns.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(HERE, 'ep-export.js'), 'utf8'));
  w.EpExport.save = (blob, name) => saved.push({ blob, name });
  const posts = [];
  w.fetch = async (url, opts) => { posts.push({ url, body: Object.fromEntries(opts.body) }); return { status: 200, json: async () => ({ ok: true }) }; };
  const widget = { updated: 0, _startUpdating() { this.updated++; } };
  const body = w.document.getElementById('w');
  const meta = { title: 'Client resources', report: 'resources', action: 'widget.ep_resources.columns', token: 'tok', canEdit,
    columns: [{ id: 'client.name', label: 'Cluster Name', default: 'Cluster Name', hidden: false, section: 'Client' },
      { id: 'client.url', label: 'ES URL', default: 'ES URL', hidden: false, section: 'Client' }],
    families: [{ id: 'es', label: 'ES', split: false }] };
  w.EpColumns.init(widget, body, meta);
  const data = { headers: ['Client'], rows: [['acme'], ['karthi']], types: ['On-Prem', 'DI'],
    servers: { headers: ['Client', 'Host'], rows: [['karthi', 'karthi-ES-Data-Hot-1']], types: ['DI'] } };
  w.EpExport.bind(body, data, 'client-resources', 'Clients', () => w.EpColumns.typeOf(body));
  return { w, body, widget, posts, saved };
}

test('the Type filter hides other clients, their servers, and counts what is left', (t) => {
  const s = setup(t); if (!s) return;
  const { w, body } = s;
  body.querySelector('[data-ep-expand]').click();
  assert.equal(body.querySelector('tr[data-parent]').hidden, false, 'expanded');
  const sel = body.querySelector('select');
  sel.value = 'On-Prem';
  sel.dispatchEvent(new w.Event('change'));
  assert.deepEqual([...body.querySelectorAll('tr[data-type]')].map((r) => r.hidden), [false, true]);
  assert.equal(body.querySelector('tr[data-parent]').hidden, true, 'a hidden client\'s servers go with it');
  assert.equal(body.querySelector('[data-ep-count]').textContent, '1 clients');
});

test('Expand all opens and closes every client', (t) => {
  const s = setup(t); if (!s) return;
  const all = s.body.querySelector('[data-ep-expand-all]');
  all.click();
  assert.equal(s.body.querySelector('tr[data-parent]').hidden, false);
  assert.equal(s.body.querySelector('[data-ep-expand]').getAttribute('aria-expanded'), 'true');
  all.click();
  assert.equal(s.body.querySelector('tr[data-parent]').hidden, true);
});

test('the export follows the Type filter', async (t) => {
  const s = setup(t); if (!s) return;
  const { w, body, saved } = s;
  const sel = body.querySelector('select');
  sel.value = 'DI';
  sel.dispatchEvent(new w.Event('change'));
  body.querySelector('[data-ep-export="csv"]').click();
  body.querySelector('[data-ep-export="csv-servers"]').click();
  const text = async (b) => (typeof b.text === 'function' ? b.text() : new Promise((r) => { const f = new w.FileReader(); f.onload = () => r(f.result); f.readAsText(b); }));
  const csv = await text(saved[0].blob);
  assert.ok(csv.includes('karthi') && !csv.includes('acme'), csv);
  assert.match(saved[1].name, /client-resources-servers/);
  assert.ok((await text(saved[1].blob)).includes('karthi-ES-Data-Hot-1'));
});

test('the Columns dialog posts rename, hide, order and split to the widget\'s own action, then redraws', async (t) => {
  const s = setup(t); if (!s) return;
  const { w, body, widget, posts } = s;
  body.querySelector('[data-ep-columns]').click();
  const dlg = w.document.querySelector('.ep-modal');
  assert.ok(dlg, 'dialog open');
  const names = dlg.querySelectorAll('input[type=text]');
  names[0].value = 'Client';
  names[0].dispatchEvent(new w.Event('input'));
  const shows = dlg.querySelectorAll('tbody input[type=checkbox]');
  shows[1].checked = false;
  shows[1].dispatchEvent(new w.Event('change'));
  const split = dlg.querySelector('.ep-modal-families input');
  split.checked = true;
  split.dispatchEvent(new w.Event('change'));
  dlg.querySelector('button[aria-label="Move down: Cluster Name"]').click();
  [...w.document.querySelectorAll('.ep-modal button')].find((b) => b.textContent === 'Save').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /action=widget\.ep_resources\.columns/);
  assert.equal(posts[0].body._csrf_token, 'tok');
  assert.equal(posts[0].body.report, 'resources');
  const set = JSON.parse(posts[0].body.settings);
  assert.deepEqual(set, { labels: { 'client.name': 'Client' }, hidden: ['client.url'], order: ['client.url', 'client.name'], split: ['es'] });
  assert.equal(widget.updated, 1, 'redrawn');
  assert.equal(w.document.querySelector('.ep-modal'), null, 'closed');
});

test('without the right to edit, there is no Columns button', (t) => {
  const s = setup(t, false); if (!s) return;
  assert.equal(s.body.querySelector('[data-ep-columns]').hidden, true);
});
