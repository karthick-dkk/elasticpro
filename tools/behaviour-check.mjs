#!/usr/bin/env node
/**
 * Drive the pages, rather than only draw them.
 *
 *   cargo run -p elasticpro-core --features bridge --bin elasticpro-bridge -- ui 8765 &
 *   node tools/mock-es.mjs 9299 &
 *   node tools/behaviour-check.mjs
 *
 * `check-ui.mjs` resolves imports and `render-check.mjs` draws every page, but a page can
 * draw perfectly and still be wrong the moment somebody uses it: a view behind a select
 * that nothing ever selects, an export nothing ever clicks, a panel whose folded state is
 * only decided on the second render. Two shipped bugs came out of exactly that gap — a
 * dialog that threw on open because its import was never added, and a jump-host button
 * that did nothing until you pressed refresh — and neither check could have caught
 * either, because neither one ever pressed anything.
 *
 * So this presses things. It needs the mock cluster, because behaviour without data is a
 * different code path from the one people use.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findJsdom, bootApp, applyConfig, settleFor } from './lib/jsdom-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const bridgeUrl = arg('--bridge', 'http://127.0.0.1:8765');
const configPath = arg('--config', path.join(ROOT, 'tools/render-fixture.json'));

let JSDOM;
{
  const { entry, paths } = findJsdom([ROOT, process.cwd()]);
  if (!entry) {
    console.log('behaviour-check: jsdom not found — skipping.');
    console.log(`  install it in one of: ${paths.join(', ')}  (npm i jsdom)`);
    process.exit(0);
  }
  ({ JSDOM } = await import(pathToFileURL(entry).href));
}

try {
  const ping = await fetch(`${bridgeUrl}/bridge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"PING"}',
  });
  if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
} catch (e) {
  console.error(`behaviour-check: no dev bridge at ${bridgeUrl} (${e.message})`);
  console.error('  start one with: cargo run -p elasticpro-core --features bridge --bin elasticpro-bridge -- ui 8765');
  process.exit(1);
}

const { window, files, sent, load, restoreConsole } = await bootApp({ JSDOM, uiRoot: UI, bridgeUrl, fleet: !process.argv.includes('--direct') });
const { config, fleet: viaFleet } = await applyConfig({ load, configPath });
console.log(`behaviour-check: data path — ${viaFleet ? 'fleet cache' : 'direct'}${process.argv.includes('--direct') ? ' (--direct)' : ''}`);
if (!config.clusters.length) {
  console.error('behaviour-check: the config has no clusters — there would be nothing to drive');
  process.exit(1);
}

const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };
const doc = window.document;

/* ----------------------------- the app's own shell ----------------------------- */

const app = await load('app.js');
{
  // Built here rather than through boot(), which would pull in the auth gate and config
  // loading — neither is what any of this is about.
  const mk = (tag, cls, id) => { const e = doc.createElement(tag); e.className = cls; e.id = id; return e; };
  const header = doc.createElement('header');
  header.append(mk('div', 'topbar', 'topbar'), mk('nav', 'nav', 'nav'), mk('div', 'status-strip', 'side-foot'));
  const main = doc.createElement('main');
  main.append(mk('div', 'page', 'view'));
  doc.body.append(header, main);
}

const panel = (title) => [...doc.querySelectorAll('section.card')]
  .find((s) => s.querySelector('header h2') && s.querySelector('header h2').textContent === title);
const shown = (title) => {
  const p = panel(title);
  return !!(p && p.querySelector('.body') && !p.querySelector('.body').hidden);
};
const sheetHeaders = () => [...doc.querySelectorAll('table.sheet thead tr:last-child th')]
  .map((th) => th.textContent.replace(/[▲▼]/g, '').replace(/i$/, '').trim());
const groupBand = () => [...doc.querySelectorAll('table.sheet thead tr.group-head th')]
  .map((th) => `${th.textContent.trim()}×${th.getAttribute('colspan') || 1}`);

async function go(id) { app.go(id); await settleFor(350); }

/**
 * Wait, up to `ms`, for `find()` to give an element; a named problem and null when it never
 * does, with what the page was showing, instead of a TypeError on the next `.click()`.
 * A page that failed to draw ("No cluster selected", "Page failed to render") reads very
 * differently from a slow one, and this says which.
 */
async function waitFor(find, what, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const el = find();
    if (el) return el;
    if (Date.now() >= until) break;
    await settleFor(50);
  }
  const view = doc.getElementById('view');
  problems.push(`${what}: not on the page after ${ms} ms — the view reads "${view ? view.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) : '(no #view)'}"`);
  return null;
}

// An evidence page (core/evidence.js) asks for one cluster when the fleet is selected, as a
// person would be asked; this answers it with the first. backToFleet() undoes that choice
// through the picker, the way a person would, so the sections after it still start on "All".
async function goOne(id) {
  await go(id);
  const pick = doc.getElementById('evidence-pick');
  if (pick) { pick.value = pick.options[1].value; pick.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(450); }
}
async function backToFleet() {
  // Through the picker, as a person would: first one cluster (which clears "All clusters was
  // asked for", so Nodes & shards opens on one again), then the fleet view the sections after
  // this expect.
  await go('overview');
  const s = doc.getElementById('cluster-select');
  if (s) { s.value = s.options[1].value; s.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(250); }
  (await load('core/state.js')).state.selected = 'all';
  await go('overview');
}

/* ------------- the status strip stays off the pages people work in ------------- */

const STRIP_HIDDEN = ['overview', 'indices', 'console', 'logs', 'snapshots', 'shards', 'volume'];
const STRIP_SHOWN = ['alerts'];

for (const id of [...STRIP_HIDDEN, ...STRIP_SHOWN]) {
  await go(id);
  const strip = doc.getElementById('side-foot');
  if (!strip) { problems.push(`${id}: the shell has no #side-foot at all`); continue; }
  const want = STRIP_HIDDEN.includes(id);
  ok(strip.hidden === want, `${id}: status strip hidden=${strip.hidden}, expected ${want}`);
}

// A refresh rebuilds the strip from an event that fires whatever page is open. Deciding
// its visibility anywhere but in that rebuild means it reappears on the next tick.
await go('indices');
app.renderSideFoot();
await settleFor(80);
ok(doc.getElementById('side-foot').hidden === true,
  'indices: the status strip came back when the strip was rebuilt');

/* ------------------------ the REST console names its target ------------------------ */

await go('console');
{
  const target = doc.getElementById('c-target');
  const run = doc.getElementById('c-run');
  ok(!!target, 'console: no #c-target line naming the address');
  ok(!!run, 'console: no Run button');
  if (target && run) {
    ok(!!(target.compareDocumentPosition(run) & window.Node.DOCUMENT_POSITION_FOLLOWING),
      'console: the address is not above the Run button, where it is read before pressing it');
  }
  // An evidence page: the line names the path the request will take, never the host.
  const base = config.clusters[0].url.replace(/\/+$/, '');
  ok(target && target.textContent === '/_cluster/health',
    `console: the target line reads "${target && target.textContent}", expected the path alone`);
  ok(target && !target.textContent.includes(base), 'console: the target line still names the cluster address');

  const pathInput = doc.getElementById('c-path');
  ok(!!pathInput, 'console: no path input');
  if (pathInput && target) {
    for (const [typed, want] of [['/_cat/indices', '/_cat/indices'], ['_cluster/health', '/_cluster/health']]) {
      pathInput.value = typed;
      pathInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      await settleFor(50);
      ok(target.textContent === want,
        `console: typing "${typed}" gave "${target.textContent}", expected "${want}"`);
    }
  }

  const body = doc.getElementById('c-body');
  ok(!!body, 'console: no query textarea');
  ok(body && !body.getAttribute('placeholder'),
    `console: the query box still carries a placeholder — "${body && body.getAttribute('placeholder')}"`);
}

/* ---------------------------- charts start unfolded ---------------------------- */

// The shards page replaced Nodes & shards. It has no folding panels — everything on it
// is the working surface — so what is checked is that the surface is actually there.
await go('shards');
{
  const titles = [...doc.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.some((t) => t.startsWith('Shards —')), `shards: no shard table card, saw ${titles.join(' | ')}`);
  ok(titles.includes('Nodes & cluster load'), `shards: no node pane, saw ${titles.join(' | ')}`);

  const heads = [...doc.querySelectorAll('table.tbl thead th')].map((x) => x.textContent.trim());
  for (const col of ['Index', 'Shard', 'Type', 'State', 'Node', 'Store', 'Unassigned reason']) {
    ok(heads.includes(col), `shards: the table has no "${col}" column, saw ${heads.join(', ')}`);
  }
  // The page renders every selected cluster, and the fixture points two of them at the
  // same mock — so the counts are per cluster, not absolute.
  const shown = [...doc.querySelectorAll('section.card header h2')]
    .filter((x) => x.textContent.startsWith('Shards —')).length;
  // Scoped to the shard tables: the page also carries a node table per cluster now, and
  // counting every row on the page conflates the two.
  const shardRows = [...doc.querySelectorAll('section.card')]
    .filter((sec) => (sec.querySelector('header h2') || {}).textContent?.startsWith('Shards —'))
    .reduce((n, sec) => n + sec.querySelectorAll('table.tbl tbody tr').length, 0);
  ok(shardRows === 3 * shown,
    `shards: expected 3 shards on each of ${shown} cluster(s), rendered ${shardRows} row(s)`);

  // The unassigned one is the row that matters, and it must read as unassigned rather
  // than as a shard sitting on a node called nothing.
  const text = doc.body.textContent;
  ok(/unassigned/i.test(text), 'shards: the unassigned shard is not marked as such');
  ok(/node left/i.test(text), 'shards: the unassigned reason is not shown');

  // A started shard can be moved; an unassigned one has nowhere to move from.
  const moves = [...doc.querySelectorAll('button')].filter((b) => b.textContent === 'Move…').length;
  ok(moves === 2 * shown,
    `shards: expected a Move button on each of the 2 started shards per cluster (${2 * shown}), found ${moves}`);

  // The node half, which this page lost when it stopped being "Nodes & shards".
  ok(titles.includes('Nodes & cluster load'), `shards: no Nodes pane, saw ${titles.join(' | ')}`);
  for (const col of ['Node', 'Roles', 'Version', 'Heap', 'RAM', 'CPU', 'Load 1m/5m', 'Disk', 'Uptime']) {
    ok(heads.includes(col), `shards: the node table has no "${col}" column, saw ${heads.join(', ')}`);
  }
  ok(/master/i.test(doc.body.textContent), 'shards: the master node is not marked');

  // The honeycomb is gone: several hundred hexagons answered "how many are wrong" at a
  // glance, and the split gauge in Cluster at a glance answers the same question in a tenth
  // of the height. Two pictures of one fact is one too many.
  ok(!titles.includes('Shard states'), `shards: the honeycomb card is still here — ${titles.join(' | ')}`);
  ok(doc.querySelectorAll('polygon').length === 0, 'shards: honeycomb cells are still being drawn');

  // Placement and storage share one card, because their shapes do not match: the gauge
  // half is tall and fixed, the storage half is four short figures, and side by side as
  // separate cards whichever was shorter left a block of empty page under it.
  ok(titles.includes('Cluster at a glance'), `shards: no single glance card — ${titles.join(' | ')}`);
  ok(!titles.includes('Shard placement') && !titles.includes('Storage accounting'),
    `shards: the old separate cards survive — ${titles.join(' | ')}`);
  // The stat tiles said Nodes / Shards / Unassigned / Moving, which the gauge and its
  // legend say in the same card. Two pictures of one fact; the tiles were the redundant
  // half, and what only they carried moved into the glance card's figures.
  ok(!doc.querySelector('.stat'), 'shards: the stat tiles are still here, duplicating the gauge');
  {
    const glance = [...doc.querySelectorAll('section.card')]
      .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Cluster at a glance');
    for (const label of ['Nodes', 'Indices', 'Indices hold', 'Disk used']) {
      ok(glance && glance.textContent.includes(label),
        `glance card: "${label}" is missing — the tiles' figures must survive their removal`);
    }
  }
  {
    const merged = [...doc.querySelectorAll('section.card')]
      .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Cluster at a glance');
    ok(merged && merged.querySelectorAll('svg').length === 1,
      'glance card: expected exactly one chart — the split gauge');
    ok(merged && /Indices hold/i.test(merged.textContent),
      'glance card: the storage figures are missing from the merged card');
    const marks = merged ? [...merged.querySelectorAll('div[title]')].map((d) => d.getAttribute('title')) : [];
    for (const want of ['assigned', 'moving', 'unassigned']) {
      ok(marks.some((t) => t.startsWith(`${want}:`)), `glance card: "${want}" is not marked — ${marks.join(' | ')}`);
    }
  }

  // Storage accounting is shown whether or not the figures disagree — the two numbers are
  // asked for either way.
  const acct = [...doc.querySelectorAll('section.card')]
    .find((sec) => /Cluster at a glance/.test((sec.querySelector('header h2') || {}).textContent || ''));
  ok(!!acct, `shards: no glance card, saw ${titles.join(' | ')}`);
  for (const label of ['Indices hold', 'Elasticsearch holds', 'Disk used', 'Unaccounted']) {
    ok(acct && acct.textContent.includes(label), `shards: accounting is missing "${label}"`);
  }

  // Clear any name filter before counting movable shards.
  const idxFilter = [...doc.querySelectorAll('input[type=search]')]
    .find((x) => x.placeholder === 'filter by name');
  if (idxFilter) {
    idxFilter.value = '';
    idxFilter.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(250);
  }

  // Ticking a started shard offers a bulk move; ticking nothing offers nothing.
  ok(!/ticked/.test(doc.body.textContent), 'shards: the bulk bar is showing with nothing ticked');
  const tick = [...doc.querySelectorAll('input[type=checkbox]')].find((x) => x.title === 'Include this shard in a bulk move');
  ok(!!tick, 'shards: no per-row tick on a started shard');
  if (tick) {
    tick.checked = true;
    tick.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settleFor(250);
    ok(/1 shard\(s\) ticked/.test(doc.body.textContent), 'shards: ticking one did not open the bulk bar');
    ok([...doc.querySelectorAll('button')].some((b) => b.textContent === 'Move them…'),
      'shards: the bulk bar has no bulk move');
    const clear = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Clear');
    if (clear) { clear.click(); await settleFor(200); }
  }
}

/* ------------------- the overview sorts by any column that means something ------------------- */

await go('overview');
{
  const heads = [...doc.querySelectorAll('table.tbl thead th')];
  const sortable = heads.filter((th) => th.classList.contains('sortable')).map((th) => th.textContent.replace(/[▲▼]/g, '').trim());
  for (const col of ['Cluster', 'Version', 'Health', 'Disk usage', 'ILM', 'SLM', 'Last snapshot', 'Alerts']) {
    ok(sortable.includes(col), `overview: "${col}" is not sortable — sortable are ${sortable.join(', ')}`);
  }
  // Clicking the active column reverses it rather than re-sorting the same way.
  const first = heads.find((th) => th.textContent.includes('Version'));
  first.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settleFor(200);
  let v = [...doc.querySelectorAll('table.tbl thead th')].find((th) => th.textContent.includes('Version'));
  ok(/▲/.test(v.textContent), `overview: first click should sort ascending, header reads "${v.textContent}"`);
  v.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settleFor(200);
  v = [...doc.querySelectorAll('table.tbl thead th')].find((th) => th.textContent.includes('Version'));
  ok(/▼/.test(v.textContent), `overview: second click should reverse, header reads "${v.textContent}"`);
}

await go('indices');
// The Indices page is for managing indices. The volume breakdown moved to the Volume
// report; what must be on THIS page is the table and the controls that act on it.
{
  const txt = doc.body.textContent;
  const btn = (label) => [...doc.querySelectorAll('button')].some((b) => b.textContent.trim() === label);
  ok(/Indices on /.test(txt), 'indices: the index table card is missing');
  ok(btn('Live') && btn('Snapshot') && btn('Live + Snapshot'),
    'indices: the three search scopes (Live, Snapshot, Live + Snapshot) are not all present');
  ok(btn('‹ Previous') && btn('Next ›'), 'indices: the table is not paged');
  // The breakdown lives behind the Summary tab, not stacked above the table.
  ok(btn('Indices') && btn('Summary'), 'indices: the Indices/Summary tabs are missing');
  ok(!/Volume analysis/.test(txt), 'indices: the volume analysis should sit behind the Summary tab');
  ok(!/Store size by source/.test(txt), 'indices: the source breakdown should sit behind the Summary tab');
  // ...and pressing Summary must actually produce it, or "not on the default view" is
  // indistinguishable from "gone".
  [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Summary').click();
  await settleFor(250);
  // The bug this guards: the selected tab looked unselected — an accent border and
  // unchanged text, which reads as "focused", not "you are here".
  const pressed = [...doc.querySelectorAll('.seg .btn')].filter((b) => b.getAttribute('aria-pressed') === 'true');
  ok(pressed.length && pressed.some((b) => b.textContent.trim() === 'Summary'),
    'indices: the Summary tab is not marked selected after being pressed');
  const sum = doc.body.textContent;
  ok(/Store size by source/.test(sum), 'indices: Summary does not show the source breakdown');
  ok(/Indices per day/.test(sum), 'indices: Summary does not show indices per day');
  ok(/Volume analysis/.test(sum), 'indices: Summary does not show the volume analysis');
}

await goOne('snapshots');
{
  // Two views, like Indices. "Snapshots" is what the page opens on: the search bar and the
  // list, and nothing else — the tiles, repositories, SLM and the strip are on the Summary.
  const segBtn = (label) => [...doc.querySelectorAll('.seg .btn')].find((b) => b.textContent.trim() === label);
  const pressedIs = (label) => segBtn(label) && segBtn(label).getAttribute('aria-pressed') === 'true';
  ok(!!segBtn('Snapshots') && !!segBtn('Snapshot Summary'), 'snapshots: no Snapshots | Snapshot Summary switch');
  ok(pressedIs('Snapshots'), 'snapshots: the page should open on the Snapshots view');
  ok(!!doc.querySelector('input[aria-label="Search snapshots"]'), 'snapshots: no snapshot search bar on the Snapshots view');
  const listCards = () => [...doc.querySelectorAll('section.card header h2')].filter((x) => x.textContent.startsWith('Snapshots in '));
  ok(listCards().length > 0, 'snapshots: no "Snapshots in <repo>" card on the Snapshots view');
  ok(!panel('Snapshot availability') && !panel('Repositories') && !panel('SLM policies'),
    'snapshots: the Snapshots view should carry only the search and the list — summary panels are showing');
  ok(!/Index data recoverable from/.test(doc.body.textContent), 'snapshots: the stat tiles belong on the Summary view');
  ok(!!doc.querySelector('.pager'), 'snapshots: the snapshot list has no pager');
  ok(!/Show all|more \(\d+ hidden\)/.test(doc.body.textContent), 'snapshots: the old "Show N more" control is still there');

  segBtn('Snapshot Summary').click();
  await settleFor(150);
  ok(pressedIs('Snapshot Summary'), 'snapshots: Snapshot Summary is not marked selected after being pressed');
  ok(shown('Snapshot availability'), 'snapshots: "Snapshot availability" starts folded');
  ok(panel('Repositories') && panel('Repositories').querySelector('.body').hidden,
    'snapshots: "Repositories" is a table and should still start folded');
  ok(!!panel('SLM policies'), 'snapshots: Summary has no SLM policies panel');
  ok(/Index data recoverable from/.test(doc.body.textContent), 'snapshots: Summary has no stat tiles');
  ok(listCards().length === 0, 'snapshots: the snapshot list should not be on the Summary view');

  // Remembered for the tab: away and back lands on the same view.
  await go('volume');
  await goOne('snapshots');
  ok(pressedIs('Snapshot Summary'), 'snapshots: the chosen view was not remembered across a page change');
  segBtn('Snapshots').click();
  await settleFor(150);
  ok(pressedIs('Snapshots'), 'snapshots: could not switch back to the Snapshots view');

  // The evidence view, opened from the real row control on the newest snapshot.
  const card0 = listCards()[0].closest('section.card');
  const opener = card0 && [...card0.querySelectorAll('button')].find((b) => /audit evidence/.test(b.title || ''));
  ok(!!opener, 'snapshots: no control on a snapshot row opens the evidence view');
  if (opener) {
    opener.click();
    await settleFor(400);
    const m = doc.querySelector('.modal.evidence');
    ok(!!m, 'snapshots: the evidence view did not open as the wide evidence panel');
    if (m) {
      // Snapshot data only (0.3.29): no cluster address and no "generated by" stamp — the
      // evidence is handed to clients. The cluster is named once, in the subtitle.
      const head = m.querySelector('.ev-head');
      ok(!!head && !config.clusters.some((c) => c.url && head.textContent.includes(c.url.replace(/\/$/, ''))),
        'snapshots: the evidence head still shows the cluster address');
      ok(!m.querySelector('.ev-cluster') && !m.querySelector('.ev-band'), 'snapshots: the evidence head still carries the cluster band');
      ok(!/Evidence generated|user not known/.test(m.textContent), 'snapshots: evidence still carries the generated-by stamp');
      // The facts fold behind a thin bar, closed until asked.
      const bar = m.querySelector('.ev-toggle');
      ok(!!bar && bar.getAttribute('aria-expanded') === 'false' && !m.querySelector('.ev-kv'),
        'snapshots: the snapshot facts should start folded behind the bar');
      ok(bar && bar.textContent.trim() === '▸' + 'Show snapshot details' && bar.querySelector('.sr-only'),
        'snapshots: the fold bar should draw only a chevron (its label is for screen readers)');
      if (bar) { bar.click(); await settleFor(30); }
      ok(!!m.querySelector('.ev-kv') && /Taken → ended/.test(m.textContent), 'snapshots: the bar did not open the facts');
      const rows = [...m.querySelectorAll('.ev-table tbody tr')];
      ok(rows.length === 4, `snapshots: the newest mock snapshot holds 4 indices, evidence lists ${rows.length}`);
      ok(rows.every((r) => /2026-09-0\d/.test(r.textContent)), 'snapshots: every mock logstash index should show its data date');
      ok(!/no dated indices/.test(m.textContent), 'snapshots: evidence says "no dated indices" for dated indices');
      ok(/covers 2026-09-07 → 2026-09-09 \(3 days, 0 missing days\)/.test(m.textContent),
        `snapshots: the evidence cover line is wrong: ${(m.querySelector('.ev-head') || {}).textContent}`);
      ok(/sorted by data date, newest first/.test(m.textContent), 'snapshots: evidence does not say how it is sorted');
      ok(rows.some((r) => /ok/.test(r.textContent)), 'snapshots: the detail read should give per-index shard status');
      const labels = [...m.querySelectorAll('.modal-foot button')].map((b) => b.textContent);
      for (const l of ['Export CSV', 'Copy as text', 'Close']) ok(labels.includes(l), `snapshots: evidence has no "${l}" action`);
      const close = [...m.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Close');
      if (close) close.click();
      await settleFor(50);
      ok(!doc.querySelector('.modal.evidence'), 'snapshots: Close did not close the evidence view');
    }
  }
}

/* --------------------- the volume report and its two sheets --------------------- */

await backToFleet();
await go('volume');
// Moved here from the Indices page — the assertion moves with them, so a future change
// that drops them cannot pass by simply not rendering them anywhere.
{
  const txt = doc.body.textContent;
}
{
  const viewBtn = (label) => [...doc.querySelectorAll('button')].find((b) => b.textContent === label);
  // Three buttons, not a dropdown, and the summary is what the page opens on.
  for (const label of ['Summary', 'Full report', 'Client plan']) {
    ok(!!viewBtn(label), `volume: no "${label}" view button`);
  }
  ok(!!panel('Capacity by cluster'), 'volume: the page should open on the summary table');
  ok(![...doc.querySelectorAll('.stat')].some((x) => /FLEET INGEST/i.test(x.textContent)),
    'volume: the fleet stat tiles are back');

  viewBtn('Full report').click();
  await settleFor(220);

  let h = sheetHeaders();
  ok(h.some((x) => x.startsWith('Current live storage store upto')),
    `volume: the renamed column is missing — got ${h.slice(5, 10).join(' | ')}`);
  ok(!h.some((x) => x.includes('Free disk lasts')), 'volume: the old "Free disk lasts" label is still here');
  ok(h.length === 36, `volume: the full sheet should have 36 columns, has ${h.length}`);

  const exportBtn = () => [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Export CSV');
  ok(!!exportBtn(), 'volume: no Export CSV button');
  exportBtn().click();
  const full = files.at(-1);
  ok(full && /^volume-resource-report-\d{4}-\d{2}-\d{2}\.csv$/.test(full.name),
    `volume: the full export is named "${full && full.name}"`);
  ok(full && full.text.split('\n')[0].split(',').length === 37,
    `volume: the full CSV has ${full && full.text.split('\n')[0].split(',').length} headers, expected 36 + "Generated at"`);
  ok(full && full.text.includes('Current live storage store upto (days)'),
    'volume: the renamed column did not reach the CSV');

  {
    viewBtn('Client plan').click();
    await settleFor(220);

    const WANT = ['ClientName', 'ES Host', 'Current Per Day Volume', 'Daily Volume + buffer',
      'Current Live Storage', 'Live Used', 'Current Live Storage Store Upto',
      'Required Live Storage for 30days', 'Required Live Storage for 90days',
      'Live Indices From', 'Live Indices To',
      'Current Backup Storage', 'Backup Storage Type',
      'Required Backup Storage for 365 days', 'Current Backup storage Store upto',
      'Snapshot Indices From', 'Snapshot Indices To'];
    h = sheetHeaders();
    ok(h.length === 17, `volume: the client plan should have 17 columns, has ${h.length}`);
    WANT.forEach((w, i) => ok(h[i] && h[i].startsWith(w),
      `volume: client column ${i} is "${h[i]}", expected "${w}"`));
    ok(JSON.stringify(groupBand()) === JSON.stringify(
      ['Client×1', '×1', 'Volume×2', 'Live storage×7', 'Backup storage×6']),
      `volume: the client plan's group band reads ${groupBand().join(' ')}`);

    const rows = doc.querySelectorAll('table.sheet tbody tr').length;
    ok(rows === config.clusters.length,
      `volume: the client plan has ${rows} rows for ${config.clusters.length} cluster(s)`);

    exportBtn().click();
    const cli = files.at(-1);
    ok(cli && /^client-storage-plan-\d{4}-\d{2}-\d{2}\.csv$/.test(cli.name),
      `volume: the client export is named "${cli && cli.name}"`);
    const hdr = cli ? cli.text.split('\n')[0].split(',') : [];
    ok(hdr.length === 18, `volume: the client CSV has ${hdr.length} headers, expected 17 + "Generated at"`);
    ok(hdr[0] === 'ClientName', `volume: the client CSV starts with "${hdr[0]}"`);
    ok(hdr[2] === 'Current Per Day Volume (GB)', `volume: client CSV column 2 is "${hdr[2]}"`);
    ok(hdr[14] === 'Current Backup storage Store upto (days)', `volume: client CSV column 14 is "${hdr[14]}"`);
    ok(hdr[16] === 'Snapshot Indices To', `volume: client CSV column 16 is "${hdr[16]}"`);
    ok(cli && cli.text.split('\n').length === config.clusters.length + 1,
      `volume: the client CSV has ${cli && cli.text.split('\n').length} lines`);

    viewBtn('Summary').click();
    await settleFor(200);
    ok(!!panel('Capacity by cluster'), 'volume: the summary view did not render');
  }
}

/* --------------------- alert triggers are listed and switchable --------------------- */

/** What transport.js reads off a reply: status, headers, and the body as text. jsdom has no Response. */
const stubReply = (obj) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });

/** The Config page is tabbed; open one by its label. */
async function openSettingsTab(label) {
  const nav = doc.querySelector('nav.subnav');
  const btn = nav && [...nav.querySelectorAll('button')].find((b) => b.textContent.includes(label));
  if (btn) { btn.click(); await settleFor(300); }
  return !!btn;
}

await go('settings');
{
  // The bar is the page's table of contents: every job it does, visible without
  // scrolling, exactly one of them open.
  const nav = doc.querySelector('nav.subnav');
  ok(!!nav, 'settings: no section tab bar');
  if (nav) {
    const tabs = [...nav.querySelectorAll('button')];
    ok(tabs.length >= 7, `settings: ${tabs.length} section tabs, expected the page's several jobs`);
    const current = tabs.filter((b) => b.getAttribute('aria-current') === 'page');
    ok(current.length === 1, `settings: ${current.length} tabs marked current, expected exactly 1`);
    // One section at a time — the whole point of the bar.
    const cards = [...doc.querySelectorAll('section.card')].length;
    ok(cards === 1, `settings: ${cards} cards on screen, expected the one open section`);
    // Switching moves the marker and changes what is shown.
    const other = tabs.find((b) => b.getAttribute('aria-current') !== 'page');
    const otherLabel = other.textContent;
    const wasTitle = (doc.querySelector('section.card header h2') || {}).textContent;
    other.click();
    await settleFor(300);
    const nowTitle = (doc.querySelector('section.card header h2') || {}).textContent;
    ok(nowTitle !== wasTitle, `settings: switching tab left "${wasTitle}" on screen`);
    // The bar is redrawn, so find the tab again by its label: the marker has to be on
    // the one that was pressed, not merely on exactly one of them.
    const after = [...doc.querySelectorAll('nav.subnav button')];
    const pressed = after.find((b) => b.textContent === otherLabel);
    ok(pressed && pressed.getAttribute('aria-current') === 'page',
      `settings: the current marker did not move to "${otherLabel}"`);
    ok(after.filter((b) => b.getAttribute('aria-current') === 'page').length === 1,
      'settings: more than one tab marked current');
  }

  ok(await openSettingsTab('Alert triggers'), 'settings: no Alert triggers tab');
  const titles = [...doc.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.includes('Alert triggers'), `settings: no alert triggers card, saw ${titles.join(' | ')}`);

  const ar = await load('core/alert-rules.js');
  const card = [...doc.querySelectorAll('section.card')]
    .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Alert triggers');
  const rows = card ? card.querySelectorAll('table.tbl tbody tr').length : 0;
  ok(rows === ar.ALERT_RULES.length,
    `settings: ${rows} trigger rows for ${ar.ALERT_RULES.length} rules — the table must be the registry`);

  // Every rule has a switch, and the ones with thresholds expose them as numbers.
  const boxes = card ? card.querySelectorAll('input[type=checkbox]').length : 0;
  ok(boxes === ar.ALERT_RULES.length, `settings: ${boxes} switches for ${ar.ALERT_RULES.length} rules`);
  const nums = card ? card.querySelectorAll('input[type=number]').length : 0;
  const expected = ar.ALERT_RULES.reduce((n, r) => n + (r.thresholds || []).length, 0);
  ok(nums === expected, `settings: ${nums} threshold inputs, expected ${expected}`);

  // It points at the one rule editor rather than being a second one.
  ok(card && /Automation/.test(card.textContent),
    'settings: the triggers card should send new-rule authoring to Automation');
}

/* --------- nodes & shards opens on one cluster, and honours an explicit "all" --------- */

{
  const st = await load('core/state.js');
  // Arrive from a fleet-wide page. The selection is "all" and was never asked for, so
  // the shards page opens on a single cluster rather than a long scroll of repeats.
  st.state.selected = 'all';
  await go('overview');
  await go('shards');
  ok(st.state.selected !== 'all',
    'shards: opened on the whole fleet without anyone asking for it');
  const one = [...doc.querySelectorAll('section.card header h2')]
    .filter((x) => x.textContent.startsWith('Shards —')).length;
  ok(one === 1, `shards: ${one} shard tables on entry, expected the one selected cluster`);

  // Now ask for the fleet by name. It is offered — the page is multi — and the choice
  // sticks, including after leaving and coming back.
  const sel = doc.getElementById('cluster-select');
  ok(sel && [...sel.options].some((o) => o.value === 'all'),
    'shards: "All clusters" is not offered, so the choice cannot be made');
  if (sel) {
    sel.value = 'all';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settleFor(500);
    const many = [...doc.querySelectorAll('section.card header h2')]
      .filter((x) => x.textContent.startsWith('Shards —')).length;
    ok(many === config.clusters.length,
      `shards: asked for all ${config.clusters.length} clusters, drew ${many}`);

    await go('overview');
    await go('shards');
    await settleFor(400);
    const still = [...doc.querySelectorAll('section.card header h2')]
      .filter((x) => x.textContent.startsWith('Shards —')).length;
    ok(still === config.clusters.length,
      `shards: the explicit fleet choice was forgotten on the way back (${still} tables)`);

    // Leave the fleet selected: later cases drive the fleet-wide log delay view, and a
    // single-cluster selection here would silently narrow them.
    sel.value = 'all';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settleFor(400);
  }
}

/* ------------- the nodes page: one pane on top, one arc for the shards ------------- */

await go('shards');
{
  const pane = doc.getElementById('view');
  const titles = [...pane.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.includes('Nodes & cluster load'),
    `shards: nodes and load are not one pane, saw ${titles.join(' | ')}`);
  ok(!titles.includes('Nodes') && !titles.includes('Cluster load'),
    `shards: the old separate cards are still there: ${titles.join(' | ')}`);

  // The merged pane comes first: it is what the page is for.
  const cards = [...pane.querySelectorAll('section.card')];
  const merged = cards.find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Nodes & cluster load');
  ok(merged && cards.indexOf(merged) <= 1,
    `shards: the nodes pane is at position ${merged ? cards.indexOf(merged) : -1}, expected the top`);
  // And it holds both halves — the node table and what the cluster is busy doing.
  ok(merged && /Uptime/.test(merged.textContent), 'shards: the merged pane lost the node table');

  const mix = cards.find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Cluster at a glance');
  ok(!!mix, `shards: no glance card, saw ${titles.join(' | ')}`);
  if (mix) {
    // One arc split, not three gauges: a single svg carrying the track plus a segment
    // per non-zero part.
    const svgs = mix.querySelectorAll('svg');
    ok(svgs.length === 1, `shard gauge: ${svgs.length} charts, expected one split arc`);
    // Every part is marked with its own count, including the zeroes.
    const marks = [...mix.querySelectorAll('div[title]')].map((d) => d.getAttribute('title'));
    for (const want of ['assigned', 'moving', 'unassigned']) {
      ok(marks.some((t) => t.startsWith(`${want}:`)), `shard gauge: "${want}" is not marked — ${marks.join(' | ')}`);
    }
    ok(/shards total/.test(mix.textContent), 'shard gauge: the centre should name what the total counts');
  }
}

/* ------------- the scheduled measurement is offered only where it can run ------------- */

// The dev bridge runs on loopback, which is the portable edition, so the core answers
// `supported: false` and the card is correctly absent. That is the first half of the
// claim; the second half — that it appears, and that saving sends what the admin typed —
// needs a hosted answer, which is stubbed here rather than by standing up a second
// bridge on a routable address.
await go('settings');
{
  const labels = [...doc.querySelectorAll('nav.subnav button')].map((b) => b.textContent);
  ok(!labels.some((l) => /Scheduled log delay/.test(l)),
    `settings: the scheduler tab appeared on a loopback (portable) bridge, where it cannot run: ${labels.join(' | ')}`);
}

{
  const realFetch = globalThis.fetch;
  let lastSet = null;
  const stub = {
    supported: true,
    config: { enabled: false, sinkClusterId: '', clusters: [], everyHours: 2,
              indexPrefix: 'elasticpro-log-delay', indexPattern: 'logstash-*',
              deviceField: 'src_hostname.keyword', arrivalField: '@timestamp',
              eventTimeFields: ['ingested_time', 'event_created'], maxDevices: 2000 },
    state: { runs: 0, lastOk: false, lastMeasured: 0, lastFailed: 0, consecutiveFailures: 0 },
    blocked: null,
  };
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(body.type || '').startsWith('DELAY_SINK')) {
      // transport.js only ever calls .json() on the answer, and jsdom has no Response.
      if (body.type === 'DELAY_SINK_SET') {
        lastSet = body.config;
        return stubReply({ ok: true, ...stub, config: body.config });
      }
      return stubReply({ ok: true, ...stub });
    }
    return realFetch(input, init);
  };

  await go('overview');
  await go('settings');
  await settleFor(400);

  ok(await openSettingsTab('Scheduled log delay'),
    'settings: no scheduler tab on a hosted core');
  const card = [...doc.querySelectorAll('section.card')]
    .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Scheduled log delay');
  ok(!!card, 'settings: no scheduled log delay card on a hosted core');

  if (card) {
    // Every cluster is offered as the destination, and every cluster can be measured.
    const options = [...card.querySelectorAll('#sink-target option')].length;
    ok(options === config.clusters.length + 1,
      `settings: ${options} sink options for ${config.clusters.length} clusters (plus the empty one)`);
    ok(card.querySelectorAll('input[id^="sink-pick-"]').length === config.clusters.length,
      'settings: the clusters to measure are not one box per cluster');
    ok(/Log delay/.test(card.textContent),
      'settings: the card should say where the thresholds are applied');

    // Arming it without naming a destination must not reach the core at all.
    card.querySelector('#sink-enabled').checked = true;
    [...card.querySelectorAll('input[id^="sink-pick-"]')].forEach((b) => { b.checked = false; });
    [...card.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await settleFor(120);
    ok(lastSet === null, 'settings: saving with no cluster picked was sent to the core anyway');

    // With a destination and a cluster that is not the destination, what is sent is what
    // was on the screen. (Measuring only the sink is refused too; the card says so.)
    const target = card.querySelector('#sink-target');
    const dest = config.clusters[config.clusters.length - 1].id;
    target.value = dest;
    const first = card.querySelector(`#sink-pick-${config.clusters[0].id}`);
    if (first) first.checked = true;
    card.querySelector('#sink-everyHours').value = '6';
    [...card.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await settleFor(200);
    ok(lastSet !== null, 'settings: a complete setting was not sent to the core');
    if (lastSet) {
      ok(lastSet.enabled === true, 'settings: the armed switch did not travel');
      ok(lastSet.everyHours === 6, `settings: the interval travelled as ${lastSet.everyHours}, not 6`);
      ok(lastSet.sinkClusterId === dest,
        `settings: the destination travelled as ${lastSet.sinkClusterId}, expected ${dest}`);
      ok(!lastSet.clusters.includes(dest) || lastSet.clusters.length > 1,
        'settings: the cluster being written to was the only one measured');
      ok(lastSet.eventTimeFields.length === 2,
        `settings: the event time fields travelled as ${JSON.stringify(lastSet.eventTimeFields)}`);
    }
  }
  globalThis.fetch = realFetch;
}

/* ------------- the cluster summary names the JVM and opens a row ------------- */

await go('overview');
// JDK starts hidden (core/cluster-view.js SUMMARY_COLUMNS): turn it on the way a person
// does, through the Columns panel.
{
  const btn = doc.getElementById('cl-columns');
  ok(!!btn, 'overview: no Columns button on the summary');
  if (btn) {
    btn.click(); await settleFor(150);
    const box = doc.getElementById('cl-colvis-jdk');
    ok(box && !box.checked, 'overview: JDK should start hidden');
    if (box && !box.checked) { box.checked = true; box.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(250); }
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settleFor(100);
    ok(!doc.querySelector('.pop.cl-cols'), 'overview: Escape did not close the Columns panel');
  }
}
{
  const summary = [...doc.querySelectorAll('section.card')]
    .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Cluster summary');
  ok(!!summary, 'overview: no cluster summary card');
  if (summary) {
    const heads = [...summary.querySelectorAll('thead tr:last-child th')]
      .map((th) => th.textContent.replace(/[▲▼]/g, '').replace(/i$/, '').trim());
    ok(heads.includes('JDK'), `overview: no JDK column, saw ${heads.join(' | ')}`);

    // The fixture runs two nodes on 17.0.9 and one on 21.0.2 — a half-finished upgrade,
    // which must read as mixed rather than as whichever node answered first.
    const jdkAt = heads.indexOf('JDK');
    const firstRow = summary.querySelector('tbody tr');
    const jdkCell = firstRow && firstRow.children[jdkAt];
    ok(jdkCell && /mixed/.test(jdkCell.textContent),
      `overview: JDK cell reads "${jdkCell && jdkCell.textContent}", expected mixed for a cluster on two JVMs`);
    ok(jdkCell && /17\.0\.9/.test(jdkCell.getAttribute('title') || ''),
      'overview: the JDK cell should carry the per-version breakdown');

    // The row expander is a chevron button at the START of the row; it says which way it goes
    // (aria-expanded), is a real button (so Tab and Enter/Space reach it), and there is no
    // per-row "Details" button any more.
    ok(![...firstRow.querySelectorAll('button')].some((b) => /Details/i.test(b.textContent)), 'overview: the per-row Details button is still there');
    const expand = firstRow.querySelector('td:first-child button.cl-chev');
    ok(!!expand, 'overview: no chevron button at the start of a summary row');
    if (expand) {
      ok(expand.tagName === 'BUTTON' && expand.type === 'button' && expand.tabIndex >= 0, 'overview: the chevron is not a keyboard-reachable button');
      ok(expand.getAttribute('aria-expanded') === 'false', 'overview: a collapsed row should say so');
      ok(/Show details for /.test(expand.getAttribute('aria-label') || ''), `overview: the chevron's name is "${expand.getAttribute('aria-label')}"`);
      const rowId = firstRow.dataset.cluster;
      const before = summary.querySelectorAll('table.cl-tbl > tbody > tr').length;
      expand.focus();
      expand.click();
      await settleFor(300);
      const after = [...doc.querySelectorAll('section.card')]
        .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Cluster summary');
      ok(after.querySelectorAll('table.cl-tbl > tbody > tr').length === before + 1,
        'overview: pressing the chevron did not open exactly one detail row');
      const detailRow = after.querySelector('tbody tr.cl-detail-row');
      ok(detailRow && /Cluster URL/.test(detailRow.textContent) && /Repository\/Snapshot/.test(detailRow.textContent) && /Shard allocation/.test(detailRow.textContent),
        'overview: the opened row does not show the details (URL, shard allocation, Repository/Snapshot)');
      ok(detailRow && !/Cluster UUID|Lucene|path\.repo|Our requests/.test(detailRow.textContent),
        'overview: the open row still shows a tile the board removed');
      ok(detailRow && [...detailRow.querySelectorAll('.cl-role')].length >= 3, 'overview: the Nodes table has no role chips');
      const now = after.querySelector(`tbody tr[data-cluster="${rowId}"] button.cl-chev`);
      ok(now && now.getAttribute('aria-expanded') === 'true', 'overview: an open row should say it is open');
      ok(now && /Hide details for /.test(now.getAttribute('aria-label') || ''), 'overview: an open row should offer to close');
      ok(now && doc.activeElement === now, 'overview: the keyboard lost the chevron when the row opened');
      now.click();
      await settleFor(250);
      const closed = doc.querySelector(`#view tbody tr[data-cluster="${rowId}"] button.cl-chev`);
      ok(closed && closed.getAttribute('aria-expanded') === 'false' && !doc.querySelector('#view tr.cl-detail-row'), 'overview: the chevron did not close the row');
      ok(closed && doc.activeElement === closed, 'overview: the keyboard lost the chevron when the row closed');
    }

    // The Alerts cell is a link to THAT cluster's alerts, or a dash with no link at all.
    {
      const alertsAt = heads.indexOf('Alerts');
      // Fresh from the page: opening and closing a row rebuilt the ones in `summary`.
      const live = [...doc.querySelectorAll('section.card')].find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Cluster summary');
      const trs = [...live.querySelectorAll('tbody tr[data-cluster]')];
      const withLink = trs.find((tr) => tr.children[alertsAt] && tr.children[alertsAt].querySelector('a.cl-alink'));
      const without = trs.find((tr) => tr.children[alertsAt] && !tr.children[alertsAt].querySelector('a, button'));
      ok(alertsAt > 0, 'overview: no Alerts column');
      ok(!!withLink, 'overview: no cluster in the fixture has an alert to link to');
      if (without) {
        ok(/^\u2014$/.test(without.children[alertsAt].textContent.trim()), `overview: a cluster with no alerts reads "${without.children[alertsAt].textContent.trim()}", expected a dash`);
      }
      if (withLink) {
        const link = withLink.children[alertsAt].querySelector('a.cl-alink');
        ok(/^\d+ \u2192$/.test(link.textContent.trim()), `overview: the alerts link reads "${link.textContent}"`);
        ok(/^#\/alerts$/.test(link.getAttribute('href')), 'overview: the alerts link does not point at the Alerts page');
        const cid = withLink.dataset.cluster;
        const cname = (withLink.querySelector('button.cl-name .cl-name-t') || {}).textContent;
        // (the harness replaces HTMLAnchorElement.click to catch downloads, so dispatch the event)
        link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        await settleFor(500);
        ok(/#\/alerts$/.test(window.location.hash), `overview: the alerts link went to "${window.location.hash}"`);
        const banner = doc.querySelector('#view .banner .ttl');
        ok(banner && banner.textContent === `Showing ${cname} only`, `overview: the Alerts page was not filtered to ${cname}: "${banner && banner.textContent}"`);
        const groups = [...doc.querySelectorAll('#view .agroup-name')].map((x) => x.textContent.trim());
        ok(groups.length > 0 && groups.every((g) => g === cname), `overview: the Alerts page shows groups ${groups.join(', ')} for ${cname}`);
        await go('overview');
      }
    }
  }
}

/* ------------- Clusters page: columns, the name menu, unreachable rows ------------- */

{
  const st = await load('core/state.js');
  const cv = await load('core/cluster-view.js');
  const press = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const key = (k, target = doc) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const summary = () => panel('Cluster summary');
  const headCells = () => [...summary().querySelectorAll('.cl-head .cl-hcell[data-col]')];
  const headIds = () => headCells().map((b) => b.dataset.col);
  const headNames = () => headCells().map((b) => b.textContent.replace(/[▲▼]/g, '').trim());
  const openCols = async () => { press(doc.getElementById('cl-columns')); await settleFor(150); return doc.querySelector('.pop.cl-cols'); };
  const closeCols = async () => { key('Escape'); await settleFor(100); };
  const user = () => (st.state.caller && st.state.caller.name) || 'local';
  const stored = () => JSON.parse(window.localStorage.getItem(cv.prefsKey(user())) || 'null');

  // Start from the defaults whatever an earlier case did.
  window.localStorage.removeItem(cv.prefsKey(user()));
  st.state.caller = { name: 'columns-check', role: 'admin' };
  await go('overview');

  // Every head sorts, says so, and the strip and the real <thead> agree.
  {
    const ids = headIds();
    ok(ids[0] === 'name', `overview: the first column is "${ids[0]}", expected the cluster name`);
    const real = [...summary().querySelectorAll('table.cl-tbl thead th[data-col]')].map((th) => th.dataset.col);
    ok(JSON.stringify(real) === JSON.stringify(ids), `overview: pinned heads ${ids.join(',')} differ from the table's ${real.join(',')}`);
    ok(headCells().every((b) => b.tagName === 'BUTTON' && b.hasAttribute('aria-sort')), 'overview: a pinned head is not a sort button');
    for (const id of ids) {
      press(summary().querySelector(`.cl-head .cl-hcell[data-col="${id}"]`)); await settleFor(120);
      const a = summary().querySelector(`.cl-head .cl-hcell[data-col="${id}"]`);
      const first = a.getAttribute('aria-sort');
      press(a); await settleFor(120);
      const b = summary().querySelector(`.cl-head .cl-hcell[data-col="${id}"]`);
      ok(first !== 'none' && b.getAttribute('aria-sort') !== first && b.getAttribute('aria-sort') !== 'none',
        `overview: "${id}" did not sort and then reverse (${first} → ${b.getAttribute('aria-sort')})`);
    }
    press(summary().querySelector('.cl-head .cl-hcell[data-col="name"]')); await settleFor(120);
    if (summary().querySelector('.cl-head .cl-hcell[data-col="name"]').getAttribute('aria-sort') !== 'ascending') {
      press(summary().querySelector('.cl-head .cl-hcell[data-col="name"]')); await settleFor(120);
    }
  }

  // The rows are in the page: no box of their own.
  ok(!summary().querySelector('.cluster-tbl-scroll'), 'overview: the summary still has its own scroll box');

  // Columns: hide, reorder (keyboard and drag), rename (Enter saves, Escape cancels), reset.
  {
    let pop = await openCols();
    ok(!!pop, 'overview: Columns did not open its panel');
    ok(doc.getElementById('cl-columns').getAttribute('aria-expanded') === 'true', 'overview: the Columns button does not say it is open');
    const nameBox = doc.getElementById('cl-colvis-name');
    ok(nameBox && nameBox.disabled && nameBox.checked, 'overview: Cluster must be shown and not hideable');
    const ilm = doc.getElementById('cl-colvis-ilm');
    ilm.checked = false; ilm.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(200);
    ok(!headIds().includes('ilm'), 'overview: hiding ILM left it in the table');
    ok(doc.querySelector('.pop.cl-cols'), 'overview: the panel closed after a change inside it');

    const before = headIds();
    press(doc.getElementById('cl-colup-alerts')); await settleFor(200);
    const after = headIds();
    ok(after.indexOf('alerts') === before.indexOf('alerts') - 1, `overview: Move up did not move Alerts (${before.join(',')} → ${after.join(',')})`);
    ok(doc.activeElement && doc.activeElement.id === 'cl-colup-alerts', 'overview: the keyboard lost its place after Move up');

    // Drag Version below Health.
    const li = (id) => doc.querySelector(`.pop.cl-cols li[data-col="${id}"]`);
    const dt = { setData() {}, effectAllowed: '' };
    const fire = (el, type, extra = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { dataTransfer: dt, clientY: 1e6 }, extra); el.dispatchEvent(e); };
    fire(li('version'), 'dragstart'); fire(li('health'), 'dragover'); fire(li('health'), 'drop'); await settleFor(200);
    const dragged = headIds();
    ok(dragged.indexOf('version') === dragged.indexOf('health') + 1, `overview: dragging Version after Health gave ${dragged.join(',')}`);

    // Rename: click, type, Escape cancels; click, type, Enter saves.
    press(doc.getElementById('cl-colnm-version')); await settleFor(100);
    let input = doc.getElementById('cl-colname-version');
    ok(!!input && doc.activeElement === input, 'overview: clicking a column name did not open its rename box');
    if (input) {
      input.value = 'Throwaway';
      key('Escape', input); await settleFor(150);
      ok(doc.querySelector('.pop.cl-cols'), 'overview: Escape in the rename box closed the whole panel');
      ok(!headNames().includes('Throwaway'), 'overview: Escape saved the rename');
      press(doc.getElementById('cl-colnm-version')); await settleFor(100);
      input = doc.getElementById('cl-colname-version');
      input.value = 'ES version';
      key('Enter', input); await settleFor(200);
      ok(headNames().includes('ES version'), `overview: the renamed column reads ${headNames().join(' | ')}`);
    }
    await closeCols();
    ok(!doc.querySelector('.pop.cl-cols'), 'overview: Escape did not close the Columns panel');

    // Saved for this user — and read back from storage, not from memory: another user signs
    // in on this tab and sees the defaults, then this one comes back to their layout.
    const s = stored();
    ok(s && s.columns && s.columns.names.version === 'ES version' && s.columns.shown.ilm === false,
      `overview: the layout was not saved for this user (${JSON.stringify(s)})`);
    const mine = headNames().join('|');
    st.state.caller = { name: 'someone-else', role: 'admin' };
    await go('overview');
    ok(headIds().includes('ilm') && !headNames().includes('ES version'), 'overview: another user got this user\'s columns');
    st.state.caller = { name: 'columns-check', role: 'admin' };
    await go('overview');
    ok(headNames().join('|') === mine, `overview: after signing back in the columns read ${headNames().join('|')}, expected ${mine}`);

    // The CSV follows the columns on screen, in order, under their names.
    files.length = 0;
    press([...summary().querySelectorAll('header button')].find((b) => b.textContent === 'Export CSV')); await settleFor(150);
    const csv = files.find((f) => /^es-cluster-summary-.*\.csv$/.test(f.name));
    ok(!!csv, 'overview: Export CSV produced no file');
    if (csv) {
      const header = csv.text.split('\n')[0];
      ok(header.includes('ES version') && !/(^|,)ILM(,|$)/.test(header), `overview: the CSV header ignores the columns on screen: ${header}`);
      ok(header.indexOf('Health') < header.indexOf('ES version'), `overview: the CSV is not in the order on screen: ${header}`);
    }

    pop = await openCols();
    press(doc.getElementById('cl-cols-reset')); await settleFor(200);
    await closeCols();
    ok(JSON.stringify(headIds()) === JSON.stringify(cv.visibleColumns(null).map((c) => c.id)), `overview: Reset left ${headIds().join(',')}`);
    ok(headNames().includes('Version') && headIds().includes('ilm'), 'overview: Reset did not restore the names and the hidden column');
  }

  // A cluster's name opens its menu: Edit (an admin), Nodes, Repo, Live log, each going
  // to the right page with that cluster selected.
  {
    const target = config.clusters[config.clusters.length - 1];
    const trigger = () => [...summary().querySelectorAll('button.cl-name')].find((b) => b.textContent.includes(target.name));
    const openMenu = async () => { press(trigger()); await settleFor(100); return doc.querySelector('.menu-pop'); };
    let menu = await openMenu();
    ok(!!menu, 'overview: clicking a cluster name opened no menu');
    if (menu) {
      const labels = [...menu.querySelectorAll('button[role=menuitem]')].map((b) => b.children[1].textContent);
      for (const l of ['Edit', 'Nodes', 'Repo', 'Live log']) ok(labels.includes(l), `overview: the name menu has no "${l}" (has ${labels.join(', ')})`);
      ok(trigger().getAttribute('aria-expanded') === 'true', 'overview: the name does not say its menu is open');
      ok(doc.activeElement && menu.contains(doc.activeElement), 'overview: the menu did not take the keyboard');
      key('ArrowDown'); ok(doc.activeElement !== menu.querySelector('button'), 'overview: ArrowDown did not move in the menu');
      key('Escape'); await settleFor(80);
      ok(!doc.querySelector('.menu-pop'), 'overview: Escape did not close the name menu');
      ok(doc.activeElement === trigger(), 'overview: Escape did not hand the keyboard back to the name');
    }
    const go2 = async (label) => {
      await go('overview');
      st.state.selected = 'all';
      const m = await openMenu();
      const item = m && [...m.querySelectorAll('button[role=menuitem]')].find((b) => b.children[1].textContent === label);
      press(item); await settleFor(450);
    };
    await go2('Nodes');
    ok(/#\/shards$/.test(window.location.hash) && st.state.selected === target.id, `name menu → Nodes: at ${window.location.hash}, selected ${st.state.selected}`);
    await go2('Repo');
    ok(/#\/snapshots$/.test(window.location.hash) && st.state.selected === target.id, `name menu → Repo: at ${window.location.hash}, selected ${st.state.selected}`);
    const summaryTab = [...doc.querySelectorAll('#view .seg button')].find((b) => b.textContent === 'Snapshot Summary');
    ok(summaryTab && summaryTab.getAttribute('aria-pressed') === 'true', 'name menu → Repo: the repositories view is not the one open');
    const snapTab = [...doc.querySelectorAll('#view .seg button')].find((b) => b.textContent === 'Snapshots');
    if (snapTab) { press(snapTab); await settleFor(150); }
    await go2('Live log');
    ok(/#\/logs$/.test(window.location.hash) && st.state.selected === target.id, `name menu → Live log: at ${window.location.hash}, selected ${st.state.selected}`);
    await go2('Edit');
    const dlg = doc.querySelector('.modal-overlay .modal');
    ok(dlg && /Edit cluster/.test(dlg.textContent), 'name menu → Edit: the cluster editor did not open');
    if (dlg) { const cancel = [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'); press(cancel); await settleFor(150); }
    // A role that may not change clusters is not offered Edit.
    st.state.caller = { name: 'columns-check', role: 'user' };
    await go('overview');
    menu = await openMenu();
    ok(menu && ![...menu.querySelectorAll('button[role=menuitem]')].some((b) => b.children[1].textContent === 'Edit'), 'name menu: Edit offered to a role that cannot edit');
    key('Escape'); await settleFor(60);
    st.state.caller = { name: 'columns-check', role: 'admin' };
    st.state.selected = 'all';
  }

  // Unreachable clusters are rows in the table, in their A–Z place, marked red, with one line
  // above the table pointing at the Alerts page. The old section (cards, Retry all, Hide) is gone.
  {
    const [a, b] = config.clusters;
    const real = new Map(config.clusters.map((c) => [c.id, { d: st.state.data.get(c.id), cl: st.client(c.id) && { state: st.client(c.id).state, lastError: st.client(c.id).lastError } }]));
    const takeDown = (c, state = 'offline', message = 'connect ECONNREFUSED 127.0.0.1:9299 (EP-301)') => {
      st.state.data.set(c.id, { ...(st.state.data.get(c.id) || {}), updatedAt: Date.now(), reachable: false, healthUnknown: false, reach: { state: 'unreachable', since: Date.now() - 18 * 60000 } });
      const cl = st.client(c.id); if (cl) { cl.state = state; cl.lastError = { ok: false, kind: 'unreachable', message }; }
    };
    const restore = () => {
      for (const [id, r] of real) { st.state.data.set(id, r.d); const cl = st.client(id); if (cl && r.cl) { cl.state = r.cl.state; cl.lastError = r.cl.lastError; } }
    };
    const note = () => doc.querySelector('#view .cl-down-note');
    const rowOf = (c) => summary().querySelector(`tbody tr[data-cluster="${c.id}"]`);
    const rowNames = () => [...summary().querySelectorAll('tbody button.cl-name')].map((x) => x.textContent.replace('▾', '').trim());
    const colAt = (id) => headIds().indexOf(id) + 1;   // the chevron column comes first
    try {
      st.state.selected = 'all';
      ok(!note(), 'unreachable: the pointer line is there with every cluster answering');
      takeDown(a);
      await go('overview');
      ok(!doc.querySelector('#view section.cl-down, #view .cl-down-card, #view #cl-down-toggle'), 'unreachable: the old unreachable section is still on the page');
      ok(rowNames().includes(a.name), `unreachable: ${a.name} is not a row in the table`);
      const A = rowOf(a);
      ok(A && A.classList.contains('cl-row-down'), 'unreachable: the row is not marked');
      if (A) {
        const health = A.children[colAt('health')];
        // A red pill reading Unreachable; the reason, the error and where to go are on hover.
        ok(/^Unreachable$/.test(health.textContent.trim()) && !!health.querySelector('.pill.red .dot'),
          `unreachable: Health reads "${health.textContent.trim()}"`);
        const tip = (health.querySelector('.pill') || {}).title || '';
        ok(/Offline/.test(tip) && /ECONNREFUSED/.test(tip) && /see Alerts/.test(tip), `unreachable: the Health tooltip does not give reason and error: "${tip}"`);
        const disk = A.children[colAt('disk')];
        ok(/^unknown while unreachable$/.test(disk.textContent.trim()) && !disk.querySelector('.disk-bar, .disk-tick, .disk-fill'),
          `unreachable: Disk reads "${disk.textContent.trim()}" or still draws a bar`);
        for (const id of ['version', 'nodes', 'size', 'ilm', 'slm', 'snapshot']) {
          const i = colAt(id);
          if (i > 0) ok(A.children[i].textContent.trim() === '\u2014', `unreachable: ${id} reads "${A.children[i].textContent.trim()}", expected a dash`);
        }
        ok(!A.querySelector('button.cl-chev'), 'unreachable: an unreachable row has an expand chevron');
        ok(!!A.querySelector('button.cl-name'), 'unreachable: the name menu is gone from the row');
        ok(A.children.length === headCells().length + 1, 'unreachable: the row has a different number of cells than the heads');
        const al = A.children[colAt('alerts')];
        ok(!!al.querySelector('a.cl-alink') && /^\d+ \u2192$/.test(al.textContent.trim()), `unreachable: its Alerts cell reads "${al.textContent.trim()}"`);
      }
      // Worst first (the page's default order: health, then the fullest disk): the unreachable
      // row leads. An earlier case left the page sorted by name, so the order is set here.
      const sortTo = async (col, want) => {
        for (let i = 0; i < 3; i++) {
          const b = headCells().find((x) => x.dataset.col === col);
          if (b.getAttribute('aria-sort') === want) return;
          press(b); await settleFor(200);
        }
      };
      await sortTo('health', 'descending');
      ok(rowNames()[0] === a.name, `unreachable: sorted worst first, the unreachable cluster is not first: ${rowNames().join(', ')}`);
      // Sorted by name its place among the others is the place its name has.
      await sortTo('name', 'ascending');
      const names = rowNames();
      const sorted = [...names].sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
      ok(JSON.stringify(names) === JSON.stringify(sorted), `unreachable: rows are not A–Z: ${names.join(', ')}`);

      const n1 = note();
      ok(!!n1, 'unreachable: no pointer line above the table');
      if (n1) {
        ok(!!(n1.compareDocumentPosition(summary()) & window.Node.DOCUMENT_POSITION_FOLLOWING), 'unreachable: the pointer line is not above the summary');
        ok(/^1 unreachable: listed in the table in A\u2013Z order\. Reasons, Retry and Diagnose are at the top of Alerts \u2192$/.test(n1.textContent.trim()), `unreachable: the pointer line reads "${n1.textContent.trim()}"`);
        const link = n1.querySelector('a');
        ok(link && /#\/alerts$/.test(link.getAttribute('href')), 'unreachable: the pointer line does not link to Alerts');
      }
      ok(/End of the list \u00b7 \d+ clusters?$/.test(summary().querySelector('.cl-end').textContent), `unreachable: the end line reads "${summary().querySelector('.cl-end').textContent}"`);
      // The header carries no subtitle (the board of 2026-10-25): the count is on the end
      // line and in the search box, and nothing says "shown above" or "reachable cluster".
      ok(!summary().querySelector('header .sub'), 'unreachable: the summary header grew a subtitle back');
      ok(!/shown above|reachable cluster/.test(summary().querySelector('header').textContent), 'unreachable: the header talks about a fold that is gone');

      // Nothing about it is stored: the fold is retired, and an old one is dropped on the next save.
      const user0 = user();
      window.localStorage.setItem(cv.prefsKey('columns-check'), JSON.stringify({ v: 1, columns: { order: [], shown: {}, names: {} }, unreachable: { hidden: true, seen: [a.id] } }));
      st.state.caller = { name: 'columns-check', role: 'admin' }; await go('overview');
      ok(!!note() && !!rowOf(a), 'unreachable: an old stored fold hid the cluster or the pointer line');
      press(doc.getElementById('cl-columns')); await settleFor(150);
      const box = doc.getElementById('cl-colvis-reqs');
      if (box) { box.checked = !box.checked; box.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(200); }
      key('Escape'); await settleFor(100);
      ok(stored() && !('unreachable' in stored()), `unreachable: the old fold survived the next save: ${JSON.stringify(stored())}`);
      st.state.caller = { name: user0, role: 'admin' };

      // A second one goes down.
      if (b) {
        takeDown(b, 'auth_error', 'HTTP 401 from the cluster (EP-401)');
        await go('overview');
        ok(note() && /^2 unreachable/.test(note().textContent.trim()), `unreachable: the pointer line reads "${note() && note().textContent.trim()}" with two down`);
        ok(rowOf(b) && /Unreachable/.test(rowOf(b).children[colAt('health')].textContent) && /Auth error/.test(rowOf(b).children[colAt('health')].querySelector('.pill').title),
          'unreachable: the second row has no reason in its tooltip');
        // Sorted by a figure they go after the rest, A–Z among themselves.
        const sortBtn = headCells().find((x) => x.dataset.col === 'nodes');
        press(sortBtn); await settleFor(200);
        const idx = rowNames();
        const downNames = [a.name, b.name].sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
        ok(JSON.stringify(idx.slice(-2)) === JSON.stringify(downNames), `unreachable: sorted by Nodes, the unreachable rows are not last, A–Z: ${idx.join(', ')}`);
        press(headCells().find((x) => x.dataset.col === 'name')); await settleFor(200);
        // The pointer link goes to the Alerts page.
        note().querySelector('a').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); await settleFor(450);
        ok(/#\/alerts$/.test(window.location.hash), `unreachable: the pointer link went to "${window.location.hash}"`);
        await go('overview');
      }

      // "Go to" from an unreachable alert: that cluster's row, scrolled to and flashed.
      {
        const goto = await load('core/alert-goto.js');
        goto.openGoto({ page: 'overview', focus: goto.FOCUS.unreachable({ clusterId: a.id }), clusterId: a.id });
        await settleFor(450);
        const row = rowOf(a);
        ok(row && row.classList.contains('focus-flash'), 'unreachable Go to: the cluster\'s row was not brought into view');
      }
      restore();
      await go('overview');
      ok(!note(), 'unreachable: the pointer line stayed after every cluster answered');
    } finally {
      restore();
      window.localStorage.removeItem(cv.prefsKey('columns-check'));
      window.localStorage.removeItem(cv.prefsKey('someone-else'));
      st.state.caller = null;
      await go('overview');
      // The name menu's hand-offs picked one cluster; later cases drive the whole fleet,
      // so ask for it back the way a person does — through the picker.
      const pick = doc.getElementById('cluster-select');
      if (pick) { pick.value = 'all'; pick.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(300); }
    }
  }
}

/* ---------------- the console: a bigger result, searchable, editable ---------------- */

await go('console');
{
  const pane = doc.getElementById('view');
  const run = doc.getElementById('c-run');
  ok(!!run, 'console: no Run button');
  run.click();
  await settleFor(900);

  // The response gets the larger share: a request body is a few lines, a response is
  // hundreds, and an even split gave half the window to whitespace.
  const cols = doc.getElementById('c-columns');
  ok(!!cols, 'console: the two panes are not a resizable split');
  if (cols) {
    const tpl = cols.style.gridTemplateColumns;
    const nums = (tpl.match(/([\d.]+)fr/g) || []).map((x) => parseFloat(x));
    ok(nums.length === 2, `console: expected two proportional columns, got "${tpl}"`);
    ok(nums[1] > nums[0], `console: the result column (${nums[1]}) is not bigger than the query (${nums[0]})`);
    ok(Math.abs(nums[0] - 35) < 0.5 && Math.abs(nums[1] - 65) < 0.5,
      `console: expected a 35/65 split, got ${nums[0]}/${nums[1]}`);
    ok(!!cols.querySelector('.split-handle'), 'console: no handle to resize the split');
  }

  // Search inside the response.
  const find = doc.getElementById('c-find');
  ok(!!find, 'console: no search box on the results');
  if (find) {
    // A term the fixture's health response actually contains — "cluster" is not in it,
    // which is how the first version of this case failed for its own reasons.
    find.value = 'shards';
    find.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(300);
    const marks = doc.querySelectorAll('#c-response mark').length;
    ok(marks > 0, `console: searching marked nothing — response was ${doc.getElementById('c-response').textContent.slice(0, 80)}`);
    ok(/\d+ of \d+/.test(doc.getElementById('c-response').textContent),
      'console: the search does not say which match you are on, out of how many');

    // A response is cluster data. Marking matches must not turn it into markup.
    const nonsense = doc.getElementById('c-find');
    nonsense.value = 'zzzznotpresentzzzz';
    nonsense.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(250);
    ok(/no hits/.test(doc.getElementById('c-response').textContent),
      'console: a search with no matches should say so');
    nonsense.value = '';
    nonsense.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(200);
  }

  // Editable where it sits: no button, no mode.
  ok(![...pane.querySelectorAll('button')].some((b) => b.textContent === 'Edit'),
    'console: there is still an Edit button — the response should just be editable');
  {
    const out = doc.getElementById('c-out');
    ok(!!out, 'console: the response is not an editable region');
    ok(out && (out.contentEditable === 'true' || out.contentEditable === 'plaintext-only'),
      `console: the response is not editable (contentEditable=${out && out.contentEditable})`);
    ok(out && out.textContent.length > 0, 'console: the editable region is empty');
    ok(out && out.spellcheck === false, 'console: spellcheck should be off on a response body');
  }

  // Next/previous match, and a distinct mark for the one you are on.
  {
    const f = doc.getElementById('c-find');
    f.value = 'shards';
    f.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(300);
    const total = doc.querySelectorAll('#c-response mark').length;
    ok(total > 1, `console: need several matches to test stepping, found ${total}`);
    ok(doc.querySelectorAll('#c-response mark.on').length === 1,
      'console: exactly one match should be marked as current');
    ok(/1 of \d/.test(doc.getElementById('c-response').textContent),
      'console: the find bar does not say which match you are on');

    const next = [...pane.querySelectorAll('button')].find((b) => b.title && /Next match/.test(b.title));
    const prev = [...pane.querySelectorAll('button')].find((b) => b.title && /Previous match/.test(b.title));
    ok(!!next && !!prev, 'console: no next/previous match buttons');
    if (next && prev) {
      next.click();
      await settleFor(250);
      ok(/2 of \d/.test(doc.getElementById('c-response').textContent),
        'console: Next did not move to the second match');
      prev.click(); await settleFor(200);
      prev.click(); await settleFor(250);
      // Wrapping backwards from the first lands on the last, as every find bar does.
      ok(new RegExp(`${total} of ${total}`).test(doc.getElementById('c-response').textContent),
        'console: Previous did not wrap to the last match');
    }
    f.value = '';
    f.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(200);
  }

  // Full screen, and Escape out of it.
  const full = doc.getElementById('c-full');
  ok(!!full, 'console: no full-screen control on the results');
  if (full) {
    full.click();
    await settleFor(300);
    ok(!doc.getElementById('c-columns'), 'console: full screen still shows the query column');
    ok(!doc.getElementById('c-run'), 'console: full screen still shows the request bar');
    ok(!!doc.getElementById('c-response'), 'console: full screen lost the response');
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settleFor(350);
    ok(!!doc.getElementById('c-columns'), 'console: Escape did not leave full screen');
  }
}

/* ----------------- the brand is the product, not the filename ----------------- */

{
  const brand = doc.querySelector('.brand');
  ok(!!brand, 'no brand block in the topbar');
  ok(!doc.getElementById('cfg-name'), 'the config filename is back in the brand block');
  ok(brand && !/\.json|\.ya?ml/i.test(brand.textContent),
    `the brand names a config file: "${brand && brand.textContent.trim()}"`);
  ok(brand && /ElasticPro/.test(brand.textContent), 'the brand should still name the product');
}

/* ------------------- log delay: can this cluster be analysed? ------------------- */

await go('logs');
{
  const ld = await load('core/log-delay.js');

  // The rule that makes a preflight worth having: the aggregation runs on .keyword, so
  // checking the base name would pass and the query that follows would return nothing.
  ok(ld.aggregatableName('src_hostname') === 'src_hostname.keyword', 'text field should gain .keyword');
  ok(ld.aggregatableName('tag1.keyword') === 'tag1.keyword', 'an already-keyword name must not be doubled');
  ok(ld.aggregatableName('src_ip') === 'src_ip', 'an ip-like field must not gain .keyword');
  ok(ld.aggregatableName('ClientID') === 'ClientID', 'ClientID is mapped keyword directly');
  ok(ld.aggregatableName('') === '', 'an empty field name stays empty');

  // decide() is the part with the rules in it, exercised without a cluster.
  const fields = ld.resolveFields({ timeField: '@timestamp' });
  const caps = (names) => ({ fields: Object.fromEntries(names.map((n) => [n, { keyword: {} }])) });

  let d = ld.decide(fields, caps(['src_hostname.keyword', 'ingested_time', '@timestamp']));
  ok(d.ok === true, `all three present should be analysable: ${JSON.stringify(d.missing)}`);
  ok(d.resolved.eventTime === 'ingested_time', `first available event-time wins: ${d.resolved.eventTime}`);

  d = ld.decide(fields, caps(['src_hostname.keyword', 'event_created', '@timestamp']));
  ok(d.ok === true && d.resolved.eventTime === 'event_created',
    'a later event-time candidate should be accepted');

  d = ld.decide(fields, caps(['ingested_time', '@timestamp']));
  ok(d.ok === false && d.missing.includes('src_hostname.keyword'),
    `a missing device field must refuse and name it: ${JSON.stringify(d.missing)}`);

  d = ld.decide(fields, caps(['src_hostname.keyword', '@timestamp']));
  ok(d.ok === false && d.missing.length === 3,
    `no event-time candidate should name all three: ${JSON.stringify(d.missing)}`);

  d = ld.decide(fields, caps([]));
  ok(d.ok === false, 'an empty cluster must never be analysable');
  ok(d.resolved.device === null && d.resolved.eventTime === null,
    'nothing resolved when nothing is present');

  // Metadata absence narrows the result; it must not refuse the analysis.
  const withMeta = ld.resolveFields({ delayFields: { device: 'src_hostname', eventTime: ['ingested_time'], metadata: ['tag1', 'parser_tag'] } });
  d = ld.decide(withMeta, caps(['src_hostname.keyword', 'ingested_time', '@timestamp', 'tag1.keyword']));
  ok(d.ok === true, 'a missing context field must not refuse the analysis');
  ok(d.metadataMissing.includes('parser_tag.keyword'), `absent context should be named: ${JSON.stringify(d.metadataMissing)}`);
  ok(d.resolved.metadata.includes('tag1.keyword'), 'present context should be resolved');

  // End to end against the mock, which maps a parsed-log shape.
  const st = await load('core/state.js');
  const target = config.clusters[0];
  const live = await ld.preflight(st.client(target.id), { ...target, logIndexPattern: 'logstash-*' });
  ok(live.unknown === false, `the mock should answer _field_caps: ${live.error}`);
  ok(live.ok === true, `the mock should be analysable, missing: ${JSON.stringify(live.missing)}`);
  ok(live.resolved.device === 'src_hostname.keyword', `resolved device: ${live.resolved.device}`);

  // A cluster that cannot be asked is unknown, never "no fields". Two ways to fail to
  // ask, and both must land on unknown: no client at all, and a client that throws.
  const dead = await ld.preflight(null, target);
  ok(dead.unknown === true && dead.ok === false, 'no client should be unknown, not a refusal');

  // End to end: switch to the delay view, check the fleet, fetch, read the table.
  {
    // The page must arrive on the fleet selection rather than collapsing it. It used to
    // be marked single-cluster, which silently reduced "all" to the first cluster on the
    // way in — and would have made the fan-out below fan out to exactly one.
    const stateMod = await load('core/state.js');
    ok(stateMod.state.selected === 'all',
      `logs: opening the page left the selection on "${stateMod.state.selected}", not the fleet`);
    const fleet = stateMod.activeClusters().length;
    ok(fleet === config.clusters.length,
      `logs: ${fleet} active clusters, expected ${config.clusters.length}`);

    const pane = doc.getElementById('view');

    // The other half of making the page fleet-wide: a tail is one cluster's stream, so
    // with several selected it must say which one it is following and let that be
    // changed — without narrowing the fleet the delay view measures.
    const tailPick = [...pane.querySelectorAll('label.field')]
      .find((l) => /Tailing/.test(l.textContent));
    ok(!!tailPick, 'logs: no tail cluster picker with several clusters selected');
    if (tailPick) {
      const opts = [...tailPick.querySelectorAll('option')].map((o) => o.value);
      ok(opts.length === config.clusters.length,
        `tail picker: ${opts.length} options for ${config.clusters.length} clusters`);
      ok(!opts.includes('all'), 'a tail cannot follow every cluster at once');
      const sel2 = tailPick.querySelector('select');
      const other = opts.find((o) => o !== sel2.value);
      sel2.value = other;
      sel2.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settleFor(400);
      ok(stateMod.state.selected === 'all',
        'changing which cluster is tailed must not narrow the fleet selection');
      // The picker is redrawn from whichever cluster the tail actually resolved to, so
      // a tail that ignored the choice snaps the control back to the first cluster.
      // Both fixture clusters share a URL, so the documents cannot tell them apart —
      // this is the only observable proof the choice was honoured.
      const after = [...pane.querySelectorAll('label.field')]
        .find((l) => /Tailing/.test(l.textContent));
      const now = after && after.querySelector('select').value;
      ok(now === other, `the tail did not follow the picked cluster: shows "${now}", picked "${other}"`);
    }

    const toDelay = [...pane.querySelectorAll('button')].find((b) => b.textContent === 'Log delay');
    ok(!!toDelay, 'logs: no "Log delay" view button');
    toDelay.click();
    await settleFor(1200);

    // Coverage is per cluster, and every configured cluster is accounted for — a cluster
    // that is simply missing from this table is the failure the fan-out must not have.
    const coverage = [...pane.querySelectorAll('section.card')]
      .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Log delay coverage');
    ok(!!coverage, `logs: no coverage card — the view said: ${pane.textContent.slice(0, 160)}`);
    if (coverage) {
      const covRows = [...coverage.querySelectorAll('table.tbl tbody tr')];
      ok(covRows.length === config.clusters.length,
        `coverage: ${covRows.length} rows for ${config.clusters.length} clusters`);
      for (const c of config.clusters) {
        ok(coverage.textContent.includes(c.name), `coverage: ${c.name} is not listed`);
      }
    }

    // The report sits in the toolbar, not inside the results card: a fleet where nothing
    // can be analysed is exactly the case somebody needs to hand to someone else, and it
    // was unreachable until a fetch had succeeded.
    {
      const reportBtn = doc.getElementById('delay-report');
      ok(!!reportBtn, 'delay view: no Report button in the toolbar');
      ok(!!doc.getElementById('delay-schedule'), 'delay view: no way to schedule the report');
      ok(reportBtn && !reportBtn.disabled,
        'delay view: the report should be available once the fleet has been checked, before any fetch');
      files.length = 0;
      reportBtn.click();
      await settleFor(500);
      ok(files.some((f) => /^log-delay-.*\.xlsx$/.test(f.name)),
        `delay view: Report produced ${files.map((f) => f.name).join(', ') || 'no download'}`);
    }

    const fetchBtn = [...pane.querySelectorAll('button')].find((b) => /^Fetch details \(/.test(b.textContent));
    ok(!!fetchBtn, `logs: no Fetch button — the view said: ${pane.textContent.slice(0, 160)}`);
    if (fetchBtn) {
      fetchBtn.click();
      await settleFor(2000);
      const devices = [...pane.querySelectorAll('section.card')]
        .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Devices across the fleet');
      ok(!!devices, 'logs: no fleet devices card after fetching');
      const trs = devices ? [...devices.querySelectorAll('table.tbl tbody tr')] : [];
      // Six devices in the fixture, once per cluster that could be analysed.
      const measurable = config.clusters.length;
      ok(trs.length === 6 * measurable,
        `delay table: ${trs.length} rows, expected 6 devices x ${measurable} cluster(s)`);
      ok(trs.every((tr) => tr.children[0].textContent.trim()),
        'every device row must name the cluster it came from');

      // Keyed by device only, so the two clusters' copies collapse — what is asserted
      // below is the classification, which must not depend on which cluster it came from.
      const byDevice = Object.fromEntries(trs.map((tr) => {
        const c = [...tr.children].map((td) => td.textContent.trim());
        return [c[1], { status: c[2], delay: c[3], pattern: c[4], means: c[7] }];
      }));
      ok(byDevice['fw-edge-01'] && byDevice['fw-edge-01'].status === 'ok', `2 min should be ok: ${JSON.stringify(byDevice['fw-edge-01'])}`);
      ok(byDevice['fw-core-02'] && byDevice['fw-core-02'].status === 'delayed', '41 min should be delayed');
      ok(byDevice['proxy-03'] && byDevice['proxy-03'].status === 'critical', '95 min should be critical');
      ok(byDevice['vpn-04'] && byDevice['vpn-04'].status === 'clock ahead',
        `-37 min must be clock ahead, not critical: ${JSON.stringify(byDevice['vpn-04'])}`);
      ok(byDevice['vpn-04'] && byDevice['vpn-04'].delay.startsWith('-'), 'a negative delay must render negative');

      // The discrimination that justifies the pattern code at all.
      ok(byDevice['router-06'] && byDevice['router-06'].pattern === 'timezone',
        `exactly 5h should read as a timezone offset: ${JSON.stringify(byDevice['router-06'])}`);
      ok(byDevice['switch-05'] && byDevice['switch-05'].pattern !== 'timezone',
        `5h30 is a queue, not an offset: ${JSON.stringify(byDevice['switch-05'])}`);

      // The measurement is published as each cluster's log-delay alert — the one the Alerts
      // page lists and the scraper sends to Zabbix. proxy-03 is critical in the fixture.
      const stNow = await load('core/state.js');
      const late = stNow.alerts().filter((a) => /:log-delay$/.test(a.key));
      ok(late.length === measurable && late.every((a) => a.level === 'critical'),
        `log delay should raise one critical alert per measured cluster: ${JSON.stringify(late.map((a) => [a.key, a.level]))}`);

      // Worst first — a critical device at the bottom of the list is a device nobody sees.
      const first = [...trs[0].children][2].textContent.trim();
      ok(first === 'critical', `the first row should be the worst, was "${first}"`);

      // Filtering to unhealthy drops the healthy one and keeps the clock-ahead one.
      const showSel = [...pane.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'unhealthy'));
      ok(!!showSel, 'delay view: no unhealthy filter');
      if (showSel) {
        showSel.value = 'unhealthy';
        showSel.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settleFor(250);
        const card2 = [...pane.querySelectorAll('section.card')]
          .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Devices across the fleet');
        const after = [...card2.querySelectorAll('table.tbl tbody tr')].map((tr) => tr.children[1].textContent.trim());
        ok(!after.includes('fw-edge-01'), `the healthy device should be filtered out: ${after.join(', ')}`);
        ok(after.includes('vpn-04'), 'a clock-ahead device counts as unhealthy');
        showSel.value = 'all';
        showSel.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settleFor(200);
      }

      /* ------------------- one device, watched live ------------------- */

      const watchRow = [...pane.querySelectorAll('table.tbl tbody tr')]
        .find((tr) => tr.children[1] && tr.children[1].textContent.trim() === 'fw-core-02');
      const watchBtn = watchRow && [...watchRow.querySelectorAll('button')].find((b) => b.textContent === 'Watch');
      ok(!!watchBtn, 'delay table: no Watch button on a device row');
      if (watchBtn) {
        watchBtn.click();
        await settleFor(900);
        const live = [...pane.querySelectorAll('section.card')]
          .find((sec) => /fw-core-02/.test((sec.querySelector('header h2') || {}).textContent || ''));
        ok(!!live, `logs: no close-up card after pressing Watch — saw ${pane.textContent.slice(0, 160)}`);
        if (live) {
          ok(/matched as a hostname/.test(live.textContent),
            'the close-up should say how the device was looked up');
          const docRows = [...live.querySelectorAll('table.tbl tbody tr')]
            .filter((tr) => tr.children.length === 5);
          ok(docRows.length === 15, `close-up: ${docRows.length} document rows, expected 15`);
          // The newest document carries the exact delay the fleet table reported, so the
          // two views cannot disagree about what this device is doing.
          const newest = docRows.length ? docRows[0].children[2].textContent.trim() : '(no rows)';
          ok(newest === '41 min', `close-up: newest delay reads "${newest}", expected 41 min`);
          ok(/delayed/.test(live.textContent), 'the close-up should carry the status');

          // Pausing must stop it repeating; the button says which state it is in.
          const pause = [...live.querySelectorAll('button')].find((b) => /Pause/.test(b.textContent));
          ok(!!pause, 'close-up: no pause control on a view that polls');
          if (pause) {
            pause.click();
            await settleFor(150);
            const resumed = [...pane.querySelectorAll('button')].find((b) => /Resume/.test(b.textContent));
            ok(!!resumed, 'close-up: pausing did not offer to resume');
          }
        }

        // A device with a parser miss: the unreadable document is listed as evidence and
        // must not be counted as a delay of zero.
        const proxyRow = [...pane.querySelectorAll('table.tbl tbody tr')]
          .find((tr) => tr.children[1] && tr.children[1].textContent.trim() === 'proxy-03');
        const proxyBtn = proxyRow && [...proxyRow.querySelectorAll('button')].find((b) => b.textContent === 'Watch');
        if (proxyBtn) {
          proxyBtn.click();
          await settleFor(900);
          const live2 = [...pane.querySelectorAll('section.card')]
            .find((sec) => /proxy-03/.test((sec.querySelector('header h2') || {}).textContent || ''));
          ok(!!live2, 'logs: no close-up for proxy-03');
          if (live2) {
            ok(/unreadable/.test(live2.textContent),
              'the close-up should say a document could not be read, not hide it');
            const rows2 = [...live2.querySelectorAll('table.tbl tbody tr')].filter((tr) => tr.children.length === 5);
            ok(rows2.length === 15, `close-up: ${rows2.length} rows — the unreadable document was dropped`);
            // Guarded: a regression that empties the table should be reported as a
            // problem, not thrown as a stack trace that stops every later case running.
            const last = rows2.length ? rows2[rows2.length - 1].children[2].textContent.trim() : '(no rows)';
            ok(last === 'unknown', `an unreadable document must read "unknown", read "${last}"`);
          }
          const close = [...pane.querySelectorAll('button')].find((b) => b.textContent === 'Close');
          ok(!!close, 'close-up: no way to close it');
          if (close) {
            close.click();
            await settleFor(200);
            ok(![...pane.querySelectorAll('section.card')]
              .some((sec) => /proxy-03 —/.test((sec.querySelector('header h2') || {}).textContent || '')),
              'close-up: closing left the card on screen');
          }
        }
      }
    }
  }

  const refusing = { fieldCaps: async () => {
    const e = new Error('HTTP 503 Service Unavailable');
    e.res = { status: 503, json: { error: { reason: 'all shards failed' } } };
    throw e;
  } };
  const thrown = await ld.preflight(refusing, target);
  ok(thrown.unknown === true, 'a cluster that refuses the call is unknown, not "no fields"');
  ok(thrown.ok === false, 'unknown is never analysable');
  ok(/all shards failed/.test(thrown.error || ''),
    `the cluster's own reason should survive, got "${thrown.error}"`);
  ok(thrown.missing.length === 0,
    'an unasked cluster must not claim fields are missing — it does not know');
}

/* ------------- an alert hands over the cluster, not just the page ------------- */

{
  const { navigateTo } = await load('core/intent.js');
  const state = (await load('core/state.js')).state;
  const target = config.clusters[config.clusters.length - 1];

  await go('overview');
  state.selected = 'all';
  navigateTo('shards', null, { cluster: target.id });
  await settleFor(350);
  ok(state.selected === target.id,
    `hand-off: selected is "${state.selected}", expected "${target.id}" — the page opened on the wrong cluster`);
  ok((window.location.hash || '').includes('shards'),
    `hand-off: landed on "${window.location.hash}", expected the shards page`);

  // A page that can show the whole fleet must keep the named cluster too, or the fleet
  // preference quietly puts "All clusters" back and the hand-off does nothing.
  state.selected = 'all';
  navigateTo('snapshots', null, { cluster: target.id });
  await settleFor(350);
  ok(state.selected === target.id,
    `hand-off to a fleet page: selected is "${state.selected}", expected "${target.id}"`);

  // No cluster named means no opinion about the selection.
  state.selected = 'all';
  navigateTo('overview');
  await settleFor(300);
  ok(state.selected === 'all', `plain navigation should not change the selection, got "${state.selected}"`);
}

/* ------------------ refresh follows the cluster picker ------------------ */

if (config.clusters.length >= 2 && !viaFleet) {
  const st = await load('core/state.js');
  const [a, b] = config.clusters;
  const seen = () => [st.state.data.get(a.id), st.state.data.get(b.id)];

  // fetchOverview replaces the whole data object, so identity is how "was this one
  // refreshed" is answered without instrumenting the fetch.
  st.state.selected = a.id;
  let [a0, b0] = seen();
  await st.refreshAll({ force: true, selected: true });
  let [a1, b1] = seen();
  ok(a1 !== a0, 'refresh with one cluster selected did not refresh that cluster');
  ok(b1 === b0, 'refresh with one cluster selected also refreshed the other one');

  st.state.selected = 'all';
  [a0, b0] = seen();
  await st.refreshAll({ force: true, selected: true });
  [a1, b1] = seen();
  ok(a1 !== a0 && b1 !== b0, 'refresh on "All clusters" should refresh every cluster');
}

// Through the fleet cache the data objects change whenever the core pushes, whichever
// cluster is selected, so identity says nothing. What the picker decides there is which
// clusters the REFRESH message names — and that no page asked Elasticsearch itself.
if (config.clusters.length >= 2 && viaFleet) {
  const st = await load('core/state.js');
  const [a, b] = config.clusters;
  const refreshes = () => sent.filter((m) => m.type === 'REFRESH');

  st.state.selected = a.id;
  let before = refreshes().length;
  await st.refreshAll({ force: true, selected: true });
  let r = refreshes().slice(before);
  ok(r.length === 1, `refresh with one cluster selected should send one REFRESH, sent ${r.length}`);
  ok(r[0] && JSON.stringify(r[0].clusterIds) === JSON.stringify([a.id]),
    `refresh with one cluster selected should name only it, named ${r[0] && JSON.stringify(r[0].clusterIds)}`);

  st.state.selected = 'all';
  before = refreshes().length;
  await st.refreshAll({ force: true, selected: true });
  r = refreshes().slice(before);
  ok(r[0] && Array.isArray(r[0].clusterIds) && r[0].clusterIds.includes(a.id) && r[0].clusterIds.includes(b.id),
    `refresh on "All clusters" should name every cluster, named ${r[0] && JSON.stringify(r[0].clusterIds)}`);

  // The refresh itself reads the cache: FLEET_STATE, never the ES passthrough.
  before = sent.length;
  await st.refreshAll();
  // (A GET / is allowed: it is how a banner gets the certificate or host key to offer
  // for trust, which the core's reach error does not carry — once per outage.)
  const direct = sent.slice(before).filter((m) => m.type === 'ES' && m.path !== '/');
  ok(!direct.length, `a fleet refresh sent ${direct.length} ES request(s) itself: ${direct.slice(0, 3).map((m) => m.path).join(', ')}`);
  ok(sent.slice(before).some((m) => m.type === 'FLEET_STATE' && m.since),
    'a later refresh should ask FLEET_STATE only for what changed (since)');

  // A pushed change reaches the page state: FLEET_STATE {since} merged over what was there.
  const d0 = st.state.data.get(a.id);
  ok(d0 && d0.datasets && d0.datasets.health, 'fleet data should carry per-dataset status for the freshness lines');
  ok(st.datasetFreshness(a.id, 'health').status, 'datasetFreshness should report the core\'s status for health');
}

/* ----------- the last five snapshots, per repository, with crafted state ----------- */

// Last, and deliberately: this replaces state.config and state.data wholesale, so every
// section above has to have had its turn with the real fixture first.
{
  const st = await load('core/state.js');
  // Crafted state from here on: nothing may overwrite it. With the fleet cache the app's
  // own loop (the 60 s FLEET_STATE fallback) would otherwise merge the bridge's clusters
  // back over it halfway through a case.
  st.stopAutoRefresh();
  const { DEFAULTS } = await load('core/config.js');
  const DAY = 86400000;
  const now = Date.now();
  const snap = (id, status, ageDays) => ({
    id, status, start: now - ageDays * DAY, end: now - ageDays * DAY, failed: 0,
  });
  const setup = (repos, snapshots) => {
    st.state.defaults = { ...DEFAULTS };
    st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
    st.state.selected = 'all';
    st.state.clients = new Map([['c1', { state: 'online' }]]);
    st.state.data = new Map([['c1', { reachable: true, health: { status: 'green' }, repos, snapshots, slm: [] }]]);
  };
  const snapAlerts = () => st.alerts().filter((x) => x.key.includes(':repo:'));

  ok(st.SNAPSHOT_WINDOW === 5, `the snapshot window should be 5, is ${st.SNAPSHOT_WINDOW}`);

  // Two repositories are two answers. One broken, one fine.
  setup([{ name: 'daily', error: null }, { name: 'weekly', error: null }], {
    daily: [snap('d3', 'SUCCESS', 0.2), snap('d2', 'SUCCESS', 1.2), snap('d1', 'SUCCESS', 2.2)],
    weekly: [snap('w5', 'FAILED', 0.3), snap('w4', 'FAILED', 1.3), snap('w3', 'FAILED', 2.3),
             snap('w2', 'SUCCESS', 3.3), snap('w1', 'SUCCESS', 4.3)],
  });
  let al = snapAlerts();
  ok(al.length === 1, `two repos with one broken should raise one alert, raised ${al.length}`);
  ok(al[0] && al[0].repo === 'weekly', `the alert should name the broken repository, named "${al[0] && al[0].repo}"`);
  ok(al[0] && al[0].level === 'critical', `a failing repository is critical, got "${al[0] && al[0].level}"`);
  ok(al[0] && Math.round((now - al[0].failingSince) / DAY) === 2,
    'failing-since should be the oldest run of the failing streak, not the newest');
  ok(al[0] && al[0].snapshot && al[0].snapshot.isNew === true,
    'the newest run is recent, so isNew is true even though it failed');
  ok(al[0] && !/unknown/.test(al[0].detail), `the detail printed "unknown" for a date it has: ${al[0] && al[0].detail}`);

  // A failure older than the window is not this week's problem.
  setup([{ name: 'daily', error: null }], {
    daily: [snap('s6', 'SUCCESS', 0.2), snap('s5', 'SUCCESS', 1.2), snap('s4', 'SUCCESS', 2.2),
            snap('s3', 'SUCCESS', 3.2), snap('s2', 'SUCCESS', 4.2), snap('s1', 'FAILED', 5.2)],
  });
  ok(snapAlerts().length === 0, 'a failure older than the five-run window must not raise an alert');

  // A window that is entirely failures started before we looked, and says so.
  setup([{ name: 'daily', error: null }], {
    daily: [snap('f5', 'FAILED', 0.2), snap('f4', 'FAILED', 1.2), snap('f3', 'FAILED', 2.2),
            snap('f2', 'FAILED', 3.2), snap('f1', 'FAILED', 4.2), snap('f0', 'FAILED', 5.2)],
  });
  al = snapAlerts();
  ok(al.length === 1 && /or earlier/.test(al[0].detail),
    `a full window of failures should say the start may be older: ${al[0] && al[0].detail}`);

  // Successful but old is a stopped schedule, not a broken one.
  setup([{ name: 'daily', error: null }], { daily: [snap('old', 'SUCCESS', 4)] });
  al = snapAlerts();
  ok(al.length === 1 && al[0].level === 'warning', 'a stale-but-successful repository is a warning');
  ok(al[0] && al[0].snapshot.isNew === false, 'a four-day-old snapshot is not new');
  ok(al[0] && /succeeded at 20/.test(al[0].detail), `the stale detail should date the run: ${al[0] && al[0].detail}`);

  setup([{ name: 'daily', error: null }], { daily: [snap('good', 'SUCCESS', 0.1)] });
  ok(snapAlerts().length === 0, 'a healthy recent repository should raise nothing');

  setup([{ name: 'daily', error: null }], { daily: [snap('p', 'PARTIAL', 0.1), snap('ok', 'SUCCESS', 1.1)] });
  ok(snapAlerts().length === 1, 'PARTIAL is a failed run');

  setup([{ name: 'broken', error: 'connect timed out' }], { broken: [] });
  al = snapAlerts();
  ok(al.length === 1 && /unknown, not empty/.test(al[0].detail),
    `an unreadable repository is unknown, not empty: ${al[0] && al[0].detail}`);

  /* ---- the Snapshots page with enough snapshots to page through ---- */
  // 23 snapshots: three pages at ten. Each holds a week of plain logstash-YYYY.MM.DD
  // indices, and the cluster carries the naming pattern older configs were written with —
  // the pair that made the evidence view say "no dated indices" while listing seven.
  const WEEK = ['23', '24', '25', '26', '27', '28', '29'].map((d) => `logstash-2026.09.${d}`);
  const many = Array.from({ length: 23 }, (_, i) => ({
    ...snap(`snap-${String(i).padStart(2, '0')}`, 'SUCCESS', 23 - i), indices: WEEK.length, indexNames: WEEK,
    coverFrom: null, coverTo: null, coverDays: 0, successful: 7, total: 7, duration: 60000,
  }));
  setup([{ name: 'daily', type: 'fs', error: null }], { daily: many });
  st.state.config.clusters[0].indexNameRegex = st.LEGACY_INDEX_RE;
  await goOne('snapshots');
  const list = () => [...doc.querySelectorAll('section.card')].find((x) => (x.querySelector('header h2') || {}).textContent === 'Snapshots in daily');
  const rowIds = () => [...(list() ? list().querySelectorAll('tbody tr') : [])].map((tr) => tr.querySelector('td').textContent.trim());
  const pagerBtn = (label) => [...(list() ? list().querySelectorAll('.pager button') : [])].find((b) => b.textContent.trim() === label);
  ok(!!list(), 'snapshot paging: no "Snapshots in daily" card');
  ok(rowIds().length === 10 && rowIds()[0] === 'snap-22', `snapshot paging: page 1 should be the newest ten, got ${rowIds().join(',')}`);
  ok(/1–10 of 23 snapshots/.test((list() || doc.body).textContent), 'snapshot paging: no "1–10 of 23" position label');
  ok(!!pagerBtn('1') && !!pagerBtn('2') && !!pagerBtn('3'), 'snapshot paging: no numbered page buttons 1–3');
  if (pagerBtn('3')) {
    pagerBtn('3').click(); await settleFor(50);
    ok(rowIds().length === 3 && rowIds()[2] === 'snap-00', `snapshot paging: page 3 should hold the oldest three, got ${rowIds().join(',')}`);
    ok(pagerBtn('3').getAttribute('aria-current') === 'page', 'snapshot paging: page 3 is not marked current');
  }
  if (pagerBtn('‹ Previous')) {
    pagerBtn('‹ Previous').click(); await settleFor(50);
    ok(rowIds()[0] === 'snap-12', `snapshot paging: Previous from page 3 should show page 2, got ${rowIds()[0]}`);
  }
  const size = list() && list().querySelector('.pager select');
  ok(!!size, 'snapshot paging: no rows-per-page picker');
  if (size) {
    size.value = '25'; size.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(100);
    ok(rowIds().length === 23, `snapshot paging: 25 per page should show all 23, shows ${rowIds().length}`);
    const s2 = list() && list().querySelector('.pager select');
    if (s2) { s2.value = '10'; s2.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(100); }
  }
  const search = doc.querySelector('input[aria-label="Search snapshots"]');
  if (search) {
    search.value = 'snap-05'; search.dispatchEvent(new window.Event('input', { bubbles: true })); await settleFor(50);
    ok(rowIds().length === 1 && rowIds()[0] === 'snap-05', `snapshot search: "snap-05" should leave one row, got ${rowIds().join(',')}`);
    search.value = ''; search.dispatchEvent(new window.Event('input', { bubbles: true })); await settleFor(50);
    ok(rowIds().length === 10, 'snapshot search: clearing the search should bring the page back');
  } else ok(false, 'snapshot search: no search bar');

  // The Sort select and the column headers are one control (0.3.29).
  const sortSel = doc.querySelector('select[aria-label="Sort snapshots"]');
  ok(!!sortSel && sortSel.value === 'taken:-1', `snapshot sort: no Sort select, or it does not open on newest first (${sortSel && sortSel.value})`);
  ok(/23 total · sorted by taken, newest first/.test((list() || doc.body).textContent), 'snapshot sort: the caption does not name the order');
  if (sortSel) {
    sortSel.value = 'taken:1'; sortSel.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(50);
    ok(rowIds()[0] === 'snap-00', `snapshot sort: "Taken · oldest first" should lead with snap-00, got ${rowIds()[0]}`);
    ok(/sorted by taken, oldest first/.test((list() || doc.body).textContent), 'snapshot sort: the caption did not follow the select');
    const takenTh = list() && [...list().querySelectorAll('thead th')].find((th) => /^Taken/.test(th.textContent));
    ok(!!takenTh && takenTh.getAttribute('aria-sort') === 'ascending', 'snapshot sort: the Taken header should show the active order');
    if (takenTh) {
      takenTh.click(); await settleFor(50);
      ok(rowIds()[0] === 'snap-22', `snapshot sort: a click on Taken should flip back to newest first, got ${rowIds()[0]}`);
      ok(doc.querySelector('select[aria-label="Sort snapshots"]').value === 'taken:-1', 'snapshot sort: the select did not follow the header click');
    }
    const nameTh = list() && [...list().querySelectorAll('thead th')].find((th) => /^Snapshot/.test(th.textContent));
    if (nameTh) {
      nameTh.click(); await settleFor(50);
      ok(rowIds()[0] === 'snap-00' && rowIds()[9] === 'snap-09', `snapshot sort: Snapshot A → Z should run snap-00…09, got ${rowIds().slice(0, 2).join(',')}`);
      sortSel.value = 'taken:-1'; sortSel.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(50);
    }
  }
  // Which columns to show: a chooser behind a ⋮ on the toolbar (no "Columns · 9 of 9" caption;
  // the count is on the trigger's label and in the menu), Snapshot always on, the rest optional.
  ok(![...doc.querySelectorAll('.toolbar button, .toolbar label')].some((b) => /^Columns/.test(b.textContent)), 'snapshot columns: the toolbar should not show a "Columns" caption or button');
  const colsBtn = doc.querySelector('.toolbar button.menu-trigger');
  const colsLabel = () => (colsBtn && colsBtn.getAttribute('aria-label')) || '';
  ok(!!colsBtn && colsBtn.textContent === '⋮' && /9 of 9 columns shown/.test(colsLabel()), `snapshot columns: no ⋮ trigger, or it miscounts (${colsLabel()})`);
  const ths = () => (list() ? [...list().querySelectorAll('thead th')].map((th) => th.textContent.replace(/ [▲▼]$/, '')) : []);
  if (colsBtn) {
    colsBtn.click(); await settleFor(50);
    const pop = doc.querySelector('.pop');
    ok(!!pop, 'snapshot columns: the ⋮ opened nothing');
    ok(!!pop && /Show columns/.test(pop.textContent) && /9 of 9 shown/.test(pop.textContent), 'snapshot columns: the menu should be titled Show columns and count 9 of 9 shown');
    if (pop) {
      const boxes = [...pop.querySelectorAll('input[type="checkbox"]')];
      ok(boxes.length === 9 && boxes.every((b) => b.checked), `snapshot columns: expected 9 ticked boxes, got ${boxes.length}`);
      ok(boxes[0].disabled, 'snapshot columns: the Snapshot column should not be hideable');
      const ended = boxes.find((b) => /Ended/.test(b.getAttribute('aria-label') || ''));
      if (ended) {
        ended.checked = false; ended.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(50);
        ok(!ths().includes('Ended') && ths().length === 9, `snapshot columns: unticking Ended should drop its column, headers now ${ths().join('|')}`);
        ok(list().querySelector('tbody tr').children.length === 9, 'snapshot columns: the rows should lose the cell too');
        ok(/8 of 9 columns shown/.test(colsLabel()), `snapshot columns: the trigger should count 8 of 9, says ${colsLabel()}`);
        ok(/8 of 9 shown/.test(pop.textContent), 'snapshot columns: the menu should say 8 of 9 shown');
        ok(rowIds().length === 10 && rowIds()[0] === 'snap-22', 'snapshot columns: hiding a column changed the rows');
      }
      const reset = [...pop.querySelectorAll('button')].find((b) => /Show all columns/.test(b.textContent));
      if (reset) { reset.click(); await settleFor(50); ok(ths().includes('Ended') && ths().length === 10, 'snapshot columns: Show all did not bring Ended back'); }
      const away = doc.body; away.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); await settleFor(30);
      ok(!doc.querySelector('.pop'), 'snapshot columns: a click outside should close the chooser');
    }
  }

  // The evidence view on one of them: every index dated, the span and gaps stated.
  const opener = list() && [...list().querySelectorAll('button')].find((b) => /audit evidence/.test(b.title || ''));
  if (opener) {
    opener.click(); await settleFor(150);
    const m = doc.querySelector('.modal.evidence');
    ok(!!m, 'evidence: did not open');
    if (m) {
      ok(!/no dated indices/.test(m.textContent), 'evidence: says "no dated indices" for logstash-2026.09.23 … .29');
      const bar = m.querySelector('.ev-toggle');
      if (bar) { bar.click(); await settleFor(30); }
      ok(/covers 2026-09-23 → 2026-09-29 \(7 days, 0 missing days\)/.test(m.textContent),
        `evidence: wrong cover line — ${(m.querySelector('.ev-head') || {}).textContent}`);
      const dates = () => [...m.querySelectorAll('.ev-table tbody tr')].map((tr) => tr.children[2].textContent);
      ok(dates().join(',') === '2026-09-29,2026-09-28,2026-09-27,2026-09-26,2026-09-25,2026-09-24,2026-09-23',
        `evidence: data dates should open newest first, got ${dates().join(',')}`);
      // The Data date header is the sort control: a click flips it, and the # column follows.
      const dateTh = [...m.querySelectorAll('.ev-table th')].find((th) => /^Data date/.test(th.textContent));
      ok(!!dateTh && dateTh.getAttribute('aria-sort') === 'descending', 'evidence: the Data date header should say it is the active, descending sort');
      if (dateTh) {
        dateTh.click(); await settleFor(30);
        ok(dates().join(',') === '2026-09-23,2026-09-24,2026-09-25,2026-09-26,2026-09-27,2026-09-28,2026-09-29',
          `evidence: a click on Data date should flip to oldest first, got ${dates().join(',')}`);
        ok(m.querySelector('.ev-table tbody tr td').textContent === '1', 'evidence: the # column should count in the order shown');
        ok(/sorted by data date, oldest first/.test(m.textContent), 'evidence: the caption did not follow the sort');
        const nameTh = [...m.querySelectorAll('.ev-table th')].find((th) => /^Index/.test(th.textContent));
        if (nameTh) {
          nameTh.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settleFor(30);
          ok(/sorted by index name, A → Z/.test(m.textContent), 'evidence: Enter on the Index header should sort by name');
        }
      }
      // The stub client cannot read the detail: per-index status is unknown, never "ok".
      ok(!/\bok\b/.test([...m.querySelectorAll('.ev-table tbody td:last-child')].map((td) => td.textContent).join(' ')),
        'evidence: shard status shown as ok without the detail having been read');
      const filter = m.querySelector('input[type="search"]');
      if (filter) {
        filter.value = '09.27'; filter.dispatchEvent(new window.Event('input', { bubbles: true })); await settleFor(30);
        ok(m.querySelectorAll('.ev-table tbody tr').length === 1, 'evidence: the filter box does not filter');
      }
      const close = [...m.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Close');
      if (close) close.click();
      await settleFor(30);
    }
  } else ok(false, 'evidence: no opener on a snapshot row');
  await backToFleet();
}

/* -------------------- tasks: one request, applied to many clusters -------------------- */

// Last of the crafted-state sections, and after the snapshot one, because it replaces the
// clients with stubs that answer without a network.
{
  const st = await load('core/state.js');
  const tasks = await load('core/tasks.js');
  const { DEFAULTS } = await load('core/config.js');

  const role = tasks.taskById('security-role');
  const user = tasks.taskById('security-user');
  ok(!!role && !!user, 'the role and user tasks should both exist');

  // What goes on the wire.
  const r = role.build({ name: 'log reader', cluster_privileges: 'monitor, read_ilm',
                         index_patterns: 'logstash-*, app-*', index_privileges: 'read' });
  ok(r.method === 'PUT' && r.path === '/_security/role/log%20reader',
    `role path should be escaped: ${r.method} ${r.path}`);
  ok(JSON.stringify(r.body.cluster) === JSON.stringify(['monitor', 'read_ilm']),
    `cluster privileges should split on commas: ${JSON.stringify(r.body.cluster)}`);
  ok(r.body.indices && r.body.indices[0].names.length === 2 && r.body.indices[0].privileges[0] === 'read',
    `index block: ${JSON.stringify(r.body.indices)}`);
  // An indices block with patterns but no privileges is refused by Elasticsearch, so it
  // must not be sent at all rather than sent empty.
  const noPriv = role.build({ name: 'x', index_patterns: 'a-*', index_privileges: '' });
  ok(!('indices' in noPriv.body), `an indices block with no privileges must be omitted: ${JSON.stringify(noPriv.body)}`);

  const u = user.build({ name: 'analyst', password: 'hunter2-hunter2', roles: 'log-reader, monitoring_user' });
  ok(u.path === '/_security/user/analyst' && u.body.password === 'hunter2-hunter2',
    'the user request should carry the password it was given');
  ok(u.body.roles.length === 2, `roles should split: ${JSON.stringify(u.body.roles)}`);
  ok(!('full_name' in u.body), 'an empty optional field should be left out entirely');

  // The credential never reaches anything that displays.
  const shown = tasks.preview(user, { name: 'analyst', password: 'hunter2-hunter2', roles: 'r' });
  ok(shown.body.password === '••••••••', `preview must redact the password, got "${shown.body.password}"`);
  ok(!JSON.stringify(shown).includes('hunter2'), `the password leaked into the preview: ${JSON.stringify(shown)}`);

  ok(tasks.missingFields(user, { name: 'a' }).length === 2,
    'a user with no password and no roles is missing two required fields');
  ok(tasks.missingFields(role, { name: 'a' }).length === 0, 'a role only requires a name');

  // Running it. Stub clients, so nothing reaches a cluster.
  const sent = [];
  const stub = (id, behaviour) => [id, {
    request: async (method, path, body, opts) => {
      sent.push({ id, method, path, body, allowWrites: opts && opts.allowWrites });
      if (behaviour === 'throw') throw new Error('connection reset');
      if (behaviour === 'refuse') return { ok: false, status: 403, message: 'action not permitted' };
      return { ok: true, status: 200 };
    },
  }];
  st.state.defaults = { ...DEFAULTS, readOnly: true };
  st.state.config = { clusters: [] };
  st.state.clients = new Map([stub('a', 'ok'), stub('b', 'refuse'), stub('c', 'throw'), stub('d', 'ok')]);

  // The pages rendered above may have left the session unlocked, which would make the
  // next assertion pass for the wrong reason. Put the switch back and check it landed.
  const writes = await load('core/writes.js');
  await writes.setWritesUnlocked(false, { confirmFirst: false });
  ok(writes.writesAllowed() === false,
    'the premise of the next check is a locked session, and it is not locked');

  // Locked means locked: nothing is sent at all.
  let threw = null;
  try { await tasks.runTask(role, { name: 'x' }, ['a']); } catch (e) { threw = e; }
  ok(threw && /locked/.test(threw.message), `a locked session must refuse before sending: ${threw && threw.message}`);
  ok(sent.length === 0, `nothing should have been sent while locked, ${sent.length} was`);

  st.state.defaults = { ...DEFAULTS, readOnly: false };   // config allows writes
  const res = await tasks.runTask(role, { name: 'log-reader', cluster_privileges: 'monitor' },
    ['a', 'b', 'c', 'd']);
  ok(res.length === 4, `every cluster should get a result, got ${res.length}`);
  ok(res[0].ok === true && res[3].ok === true,
    'a cluster refusing must not stop the ones after it');
  ok(res[1].ok === false && /not permitted/.test(res[1].message), `refusal: ${JSON.stringify(res[1])}`);
  ok(res[2].ok === false && /connection reset/.test(res[2].message), `thrown error: ${JSON.stringify(res[2])}`);
  ok(sent.length === 4 && sent.every((x) => x.allowWrites === true),
    'every task request must carry allowWrites');

  // A missing field is refused before anything is sent, not halfway through.
  sent.length = 0;
  threw = null;
  try { await tasks.runTask(user, { name: 'a' }, ['a', 'd']); } catch (e) { threw = e; }
  ok(threw && /fill in/.test(threw.message), `incomplete task: ${threw && threw.message}`);
  ok(sent.length === 0, `an incomplete task must send nothing, sent ${sent.length}`);
}

/* ------------------------ new alerts announce themselves ------------------------ */

// After the snapshot section, which leaves crafted state behind that this one reuses.
{
  const notify = await load('core/notify.js');
  const st = await load('core/state.js');
  const { DEFAULTS } = await load('core/config.js');
  const said = [];
  const spy = (msg, kind, ms, opts) => said.push({ msg, kind, opts });

  // Its own state: the task section above emptied state.config to run against stubs, and
  // alerts() walks the configured clusters — with none, there is nothing to announce and
  // this would pass by having nothing to say.
  st.state.defaults = { ...DEFAULTS };
  st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
  st.state.selected = 'all';
  st.state.clients = new Map([['c1', { state: 'online' }]]);
  // Something is ALREADY wrong before the first pass. That is the whole point of the
  // baseline rule, and a clean start would let a notifier that announces everything it
  // sees pass this by having nothing to see.
  st.state.data = new Map([['c1', {
    reachable: true, health: { status: 'green' }, slm: [],
    repos: [{ name: 'already-broken', error: 'was broken before you opened the app' }],
    snapshots: { 'already-broken': [] },
  }]]);
  ok(st.alerts().length === 1,
    `the baseline needs exactly one pre-existing alert to be a real test, has ${st.alerts().length}`);

  // The first pass is a baseline: whatever is already wrong is a state, not news.
  notify.resetAnnounced();
  const first = notify.announceNewAlerts({ notify: spy });
  ok(first.length === 0 && said.length === 0,
    `the first pass must announce nothing even though an alert is open, announced ${said.length}`);

  // Nothing changed, so nothing is new — even though alerts() rebuilds the same list.
  notify.announceNewAlerts({ notify: spy });
  ok(said.length === 0, `an unchanged alert must not be announced again, got ${said.length}`);

  // Break a second repository: one NEW alert beside the one that was already there.
  const d = st.state.data.get('c1');
  d.repos = [{ name: 'already-broken', error: 'was broken before you opened the app' },
             { name: 'daily', error: 'connect timed out' }];
  d.snapshots = { 'already-broken': [], daily: [] };
  const fresh = notify.announceNewAlerts({ notify: spy });
  ok(fresh.length === 1, `a newly broken repository should announce once, announced ${fresh.length}`);
  ok(said.length === 1 && /1 new alert/.test(said[0].msg) && /daily/.test((said[0].opts.detail || []).join(' ')), `announcement text: ${JSON.stringify(said)}`);

  said.length = 0;
  notify.announceNewAlerts({ notify: spy });
  ok(said.length === 0, 'the same alert must not be announced on the next refresh');

  // Many at once collapse to one line rather than burying the screen.
  d.repos = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: n, error: 'gone' }));
  d.snapshots = {};
  said.length = 0;
  notify.announceNewAlerts({ notify: spy });
  // Five repositories on one cluster are one merged alert, so one notice about five items — not a wall.
  ok(said.length === 1 && /1 new alert/.test(said[0].msg),
    `five at once on one cluster should be one notice, got ${JSON.stringify(said)}`);
}

/* -------------- accounts keeps the two kinds of user apart -------------- */

// Rendered directly rather than navigated to: the page is admin-only, and go() correctly
// refuses it for a session without that role — which would leave this checking Alerts.
{
  const accounts = await load('pages/accounts.js');
  // The router's page is the one data redraws go to, and those are spaced by what the last
  // one cost (app.js), so one can land during the settle below. Park the router on a page
  // whose redraw draws nothing, as it would be if this page had been navigated to.
  window.dispatchEvent(new window.CustomEvent('ep:navigate', { detail: { page: 'console' } }));
  const pane = doc.getElementById('view');
  while (pane.firstChild) pane.removeChild(pane.firstChild);
  accounts.render(pane);
  await settleFor(500);

  const titles = [...pane.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.includes('ElasticPro users'),
    `accounts: no "ElasticPro users" card, saw ${titles.join(' | ')}`);
  ok(titles.includes('Cluster users'),
    `accounts: no "Cluster users" card, saw ${titles.join(' | ')}`);
  // The two must not be merged back into one "Accounts" table: an app login and a cluster
  // login are different credentials and one list implies they are not.
  ok(!titles.includes('Accounts'),
    'accounts: the generic "Accounts" card is back — the two kinds of user are merged again');
  ok([...pane.querySelectorAll('button')].some((b) => b.textContent === '+ Create'),
    'accounts: no "+ Create" button on the cluster users card');

  // The three are told apart by labelled bands: app credentials above, cluster ones below.
  const bands = [...pane.querySelectorAll('h3')].map((x) => x.textContent);
  ok(bands.includes('On this installation'), `accounts: no installation band, saw ${bands.join(' | ')}`);
  ok(bands.includes('On the clusters'), `accounts: no cluster band, saw ${bands.join(' | ')}`);

  // A Zabbix account's role editor says whether Zabbix still sets the role or an admin pinned
  // it here, and "Follow Zabbix again" is a button that does something: it asks the core, and
  // whatever the core answers lands in the dialog the admin is looking at.
  const close = () => { const o = doc.querySelector('.modal-overlay'); if (o) o.remove(); };
  accounts.editUser({ name: 'adam@zabbix', role: 'operator', source: 'zabbix', rolePinned: false });
  let dlg = doc.querySelector('.modal');
  ok(dlg && /Follows Zabbix at each sign-in \(Zabbix Admin → Operator, Super admin → Admin\)\. Changing it here pins it\./.test(dlg.textContent),
    `accounts: the unpinned help text is missing: ${dlg && dlg.textContent}`);
  ok(dlg && ![...dlg.querySelectorAll('button')].some((b) => b.textContent === 'Follow Zabbix again'),
    'accounts: an account that already follows Zabbix offers to follow Zabbix again');
  close();
  accounts.editUser({ name: 'adam@zabbix', role: 'admin', source: 'zabbix', rolePinned: true });
  dlg = doc.querySelector('.modal');
  ok(dlg && /Pinned here\. Zabbix sign-ins no longer change it\./.test(dlg.textContent),
    `accounts: the pinned help text is missing: ${dlg && dlg.textContent}`);
  const follow = dlg && [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Follow Zabbix again');
  ok(follow, 'accounts: a pinned Zabbix account has no "Follow Zabbix again" button');
  if (follow) {
    follow.click();
    await settleFor(800);
    // This bridge has no such account (and the portable build no accounts at all), so the
    // core refuses — and the refusal must be shown in the dialog, not swallowed.
    const still = doc.querySelector('.modal');
    const said = still ? (still.querySelector('.modal-msg') || {}).textContent || '' : '';
    ok(!still || said.trim().length > 0,
      `accounts: "Follow Zabbix again" did nothing visible (dialog open, no message)`);
  }
  close();
  const cell = accounts.originCell({ name: 'adam@zabbix', role: 'admin', source: 'zabbix', rolePinned: true });
  ok(/pinned/.test(cell.textContent), `accounts: no pinned pill on a pinned account: ${cell.textContent}`);
}

/* ------- a cluster with security off says so, not "HTTP 500" ------- */

{
  const cuMod = await load('ui/cluster-users.js');
  const st = await load('core/state.js');
  const err = (reason) => {
    const e = new Error('HTTP 500 Internal Server Error');
    e.res = { status: 500, json: { error: { reason } } };
    return e;
  };
  st.state.clients = new Map([['x', { securityUsers: async () => { throw err(
    'Security must be explicitly enabled when using a [basic] license. Enable security by '
    + 'setting [xpack.security.enabled] to [true] in the elasticsearch.yml file and restart the node.'); } }]]);
  let r = await cuMod.fetchClusterUsers('x');
  ok(/switched off/.test(r.error), `security-off should be named, got "${r.error}"`);
  ok(!/500/.test(r.error), `the status line must not be the message: "${r.error}"`);
  ok(/xpack\.security\.enabled/.test(r.fix || ''), `the fix should name the setting, got "${r.fix}"`);

  st.state.clients = new Map([['x', { securityUsers: async () => { throw err('no handler found for uri [/_security/user]'); } }]]);
  r = await cuMod.fetchClusterUsers('x');
  ok(/no security API/.test(r.error), `an OSS build should be named, got "${r.error}"`);

  st.state.clients = new Map([['x', { securityUsers: async () => { throw err('security_exception: action unauthorized'); } }]]);
  r = await cuMod.fetchClusterUsers('x');
  ok(/may not read/.test(r.error), `a privilege problem should be named, got "${r.error}"`);
}

/* ------------- the create dialog asks for what the kind needs ------------- */

{
  const tasks = await load('core/tasks.js');
  const byId = (id) => tasks.taskById(id);
  const names = (t) => t.fields.map((f) => f.name);

  ok(byId('security-api-key'), 'there should be an API key task');
  ok(!names(byId('security-role')).includes('password'),
    'a role must not ask for a password');
  ok(names(byId('security-user')).includes('password'),
    'a user must ask for a password');
  ok(!names(byId('security-api-key')).includes('password'),
    'an API key must not ask for a password');
  ok(names(byId('security-api-key')).includes('expiration'),
    'an API key should offer an expiry');

  // The screenshot bug: an untyped form previewed as PUT /_security/user/undefined.
  const shown = tasks.preview(byId('security-user'), {});
  ok(!/undefined/.test(shown.path), `an empty form still previews "undefined": ${shown.path}`);
  ok(shown.path.endsWith('…'), `an empty name should preview as a placeholder: ${shown.path}`);

  // An API key comes back in the response and nowhere else, so the runner keeps it.
  const key = byId('security-api-key');
  ok(typeof key.keep === 'function', 'the API key task must keep the key from the response');
  ok(key.keep({ value: { encoded: 'abc', id: '1' } }).encoded === 'abc',
    'keep() should lift the encoded key out of the response');
  ok(key.keep({ value: {} }) === null, 'keep() should return null when there is no key');
  const noRoles = key.build({ name: 'k' });
  ok(!('role_descriptors' in noRoles.body),
    `no roles means inherit the caller's, so the descriptor block is omitted: ${JSON.stringify(noRoles.body)}`);
}

/* --------------- the master and the disk that nothing accounts for --------------- */

{
  const st = await load('core/state.js');
  const { DEFAULTS } = await load('core/config.js');
  const base = (nodes, extra = {}) => {
    st.state.defaults = { ...DEFAULTS };
    st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
    st.state.selected = 'all';
    st.state.clients = new Map([['c1', { state: 'online' }]]);
    st.state.indices = new Map();
    st.state.data = new Map([['c1', {
      reachable: true, health: { status: 'green' }, slm: [], repos: [], snapshots: {},
      nodes, master: (nodes.find((n) => n.master === '*') || {}).name || null, ...extra,
    }]]);
  };
  const keys = () => st.alerts().map((a) => a.key);

  // No master at all is critical.
  base([{ name: 'n1', master: '-' }, { name: 'n2', master: '-' }]);
  ok(keys().includes('c1:no-master'), `a cluster with no master should be critical: ${keys().join(', ')}`);
  ok(st.alerts().find((a) => a.key === 'c1:no-master').level === 'critical', 'no-master must be critical');

  // A master that has always been this one is not news.
  base([{ name: 'n1', master: '*' }, { name: 'n2', master: '-' }]);
  ok(!keys().some((k) => k.startsWith('c1:master-changed')),
    `a steady master should raise nothing: ${keys().join(', ')}`);

  // One that just moved is.
  base([{ name: 'n2', master: '*' }, { name: 'n1', master: '-' }],
    { masterChangedFrom: 'n1', masterChangedAt: Date.now() - 60000 });
  const moved = st.alerts().find((a) => a.key.startsWith('c1:master-changed'));
  // Tuned: on a cluster that is green again a re-election is worth knowing, not paging over
  // (warning); while the cluster is not green it stays critical.
  ok(!!moved && moved.level === 'warning', `a master election on a green cluster should be a warning: ${keys().join(', ')}`);
  ok(moved && /from n1 to n2/.test(moved.title), `the alert should name both: ${moved && moved.title}`);
  base([{ name: 'n2', master: '*' }, { name: 'n1', master: '-' }],
    { masterChangedFrom: 'n1', masterChangedAt: Date.now() - 60000, health: { status: 'yellow', unassigned_shards: 2 } });
  const movedYellow = st.alerts().find((a) => a.key.startsWith('c1:master-changed'));
  ok(!!movedYellow && movedYellow.level === 'critical', `a master election on a cluster that is not green should be critical: ${keys().join(', ')}`);

  // And one that moved a week ago is history, not an alert.
  base([{ name: 'n2', master: '*' }],
    { masterChangedFrom: 'n1', masterChangedAt: Date.now() - 8 * 86400000 });
  ok(!keys().some((k) => k.startsWith('c1:master-changed')),
    'an election from last week should have aged out');

  // Disk capacity: the size of the disk, not how full it is.
  const cap = (nodes, capacity) => {
    base(nodes);
    st.state.data.get('c1').capacity = capacity;
  };
  const GB = 1024 ** 3;

  cap([{ name: 'n1', master: '*' }],
    { total: 200 * GB, nodeCount: 1, changedFrom: 100 * GB, changedAt: Date.now() - 60000 });
  let grew = st.alerts().find((a) => a.key.startsWith('c1:capacity'));
  ok(!!grew, `a capacity change should alert: ${keys().join(', ')}`);
  ok(grew && grew.level === 'warning', 'growing is informational, not critical');
  ok(grew && /grew to/.test(grew.title), `grew title: ${grew && grew.title}`);

  cap([{ name: 'n1', master: '*' }],
    { total: 50 * GB, nodeCount: 1, changedFrom: 100 * GB, changedAt: Date.now() - 60000 });
  const fell = st.alerts().find((a) => a.key.startsWith('c1:capacity'));
  ok(fell && fell.level === 'critical', 'a disk shrinking is critical — a path went away');
  ok(fell && /FELL/.test(fell.title), `fell title: ${fell && fell.title}`);
  ok(fell && /not a node leaving/.test(fell.detail), 'the detail should rule out the innocent explanation');

  // Unchanged capacity says nothing, and an ancient change has aged out.
  cap([{ name: 'n1', master: '*' }], { total: 100 * GB, nodeCount: 1, changedFrom: null, changedAt: null });
  ok(!keys().some((k) => k.startsWith('c1:capacity')), 'steady capacity must be silent');
  cap([{ name: 'n1', master: '*' }],
    { total: 50 * GB, nodeCount: 1, changedFrom: 100 * GB, changedAt: Date.now() - 5 * 86400000 });
  ok(!keys().some((k) => k.startsWith('c1:capacity')), 'a change from last week has aged out');

  // Disk Elasticsearch holds against disk the indices explain.
  base([{ name: 'n1', master: '*' }], { disk: { indicesBytes: 100 * 1024 ** 3, nodes: [] } });
  st.state.indices.set('c1', [{ index: 'a', size: 30 * 1024 ** 3 }]);
  const gap = st.alerts().find((a) => a.key === 'c1:disk-unaccounted');
  ok(!!gap, `a 70 GB gap should be reported: ${keys().join(', ')}`);
  ok(gap && /not accounted for/.test(gap.title), `gap title: ${gap && gap.title}`);

  // Agreeing closely is the normal case and says nothing.
  st.state.indices.set('c1', [{ index: 'a', size: 99 * 1024 ** 3 }]);
  ok(!keys().includes('c1:disk-unaccounted'), 'a 1% difference is not worth an alert');

  // No index list means unknown, not "all of it is unaccounted for".
  st.state.indices = new Map();
  ok(!keys().includes('c1:disk-unaccounted'),
    'without an index list the gap is unknown and must not be reported as the whole of it');
}

/* ------------------------------------ verdict ------------------------------------ */

restoreConsole();
// Request Centre: reads the core's own log, shows the poller's requests with who asked, and
// stops re-reading once the page is left.
{
  const before = sent.filter((m) => m.type === 'REQUEST_LOG').length;
  await go('requests'); await settleFor(2500);
  ok(sent.filter((m) => m.type === 'REQUEST_LOG').length > before, 'requests: opening the page should read REQUEST_LOG');
  const direct = sent.slice(-20).filter((m) => m.type === 'ES');
  ok(!direct.length, `requests: the page sent ${direct.length} ES request(s) itself — it must only read the core's log`);
  const rows = doc.querySelectorAll('section.card table tbody tr');
  ok(rows.length > 0, 'requests: no rows — the poller has been running, so the log cannot be empty');
  const origins = [...doc.querySelectorAll('section.card table tbody tr td:nth-child(3)')].map((td) => td.textContent.trim());
  ok(origins.some((o) => /^poller · /.test(o)), `requests: rows should name the poller as the asker, saw ${JSON.stringify(origins.slice(0, 3))}`);
  await go('overview'); const after = sent.filter((m) => m.type === 'REQUEST_LOG').length; await settleFor(2600);
  ok(sent.filter((m) => m.type === 'REQUEST_LOG').length === after, 'requests: the log is still being re-read after leaving the page');
}

// Housekeeping card on the Request Centre: read on entry, Dry run asks the core for a dry
// run and draws what came back, and Run now asks first (a real run deletes). The real run is
// never pressed here: against a bridge with a real data dir it would clean it.
{
  await go('requests'); await settleFor(800);
  ok(sent.some((m) => m.type === 'HOUSEKEEPING_GET'), 'housekeeping: opening the Request Centre should read HOUSEKEEPING_GET');
  const card = panel('Housekeeping');
  ok(!!card, 'housekeeping: no Housekeeping card on the Request Centre');
  if (card) {
    const act = (a) => panel('Housekeeping').querySelector(`[data-act="${a}"]`);
    ok(act('hk-dry') && act('hk-run'), 'housekeeping: the card has no Dry run / Run now buttons');
    ok(/Runs\s+every hour|Runs\s+off/.test(card.textContent), `housekeeping: the card does not say when it runs: ${card.textContent.slice(0, 200)}`);
    const runs = () => sent.filter((m) => m.type === 'HOUSEKEEPING_RUN');
    const before = runs().length;
    act('hk-dry').click(); await settleFor(1500);
    ok(runs().length === before + 1, `housekeeping: Dry run sent ${runs().length - before} HOUSEKEEPING_RUN, expected 1`);
    ok(runs().length > before && runs()[runs().length - 1].dryRun === true, 'housekeeping: Dry run did not ask for a dry run');
    const after = panel('Housekeeping');
    ok(after.querySelectorAll('tr[data-job]').length >= 6, `housekeeping: the result lists ${after.querySelectorAll('tr[data-job]').length} jobs, expected one row per job`);
    ok(/dry run/i.test(after.textContent), 'housekeeping: the last run is not marked as a dry run');
    ok(!/\bremoved \d/.test(after.textContent), 'housekeeping: a dry run read as a deletion ("removed N")');
    // Run now asks before it deletes anything; answering No sends nothing.
    const askedBefore = runs().length;
    act('hk-run').click(); await settleFor(300);
    const dlg = doc.querySelector('.modal');
    ok(!!dlg && /housekeeping/i.test(dlg.textContent), 'housekeeping: Run now did not ask first');
    ok(runs().length === askedBefore, 'housekeeping: Run now sent the run before it was confirmed');
    const no = dlg && [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'No');
    if (no) { no.click(); await settleFor(300); }
    ok(!doc.querySelector('.modal'), 'housekeeping: the confirmation did not close on No');
    ok(runs().length === askedBefore, 'housekeeping: answering No still ran housekeeping');
  }
}

// Config page: a fleet event must not reload the open tab or wipe what is being typed.
// On a 32-cluster install data lands every couple of seconds; the page used to rebuild on
// each one, re-asking TUNNELS/PINS (Jump hosts) and ZABBIX_CLUSTERS (Zabbix) every time.
{
  await go('settings');
  const bus = (await load('core/state.js')).bus;
  const tab = (label) => [...doc.querySelectorAll('nav.subnav button')].find((b) => b.title === label);
  const countOf = (type) => sent.filter((m) => m.type === type).length;
  const fire = async () => { for (const c of config.clusters) bus.emit('data', c.id); await settleFor(700); };
  const trust = tab('Jump hosts & trust');
  ok(!!trust, 'config: no Jump hosts & trust tab');
  if (trust) {
    trust.click(); await settleFor(500);
    const tunnels = countOf('TUNNELS'), pins = countOf('PINS');
    ok(tunnels >= 1, 'config: opening Jump hosts & trust should ask the core for TUNNELS once');
    const card = doc.querySelector('#trust-card');
    await fire(); await fire();
    ok(countOf('TUNNELS') === tunnels && countOf('PINS') === pins,
      `config: fleet events re-asked the core (TUNNELS ${countOf('TUNNELS') - tunnels}, PINS ${countOf('PINS') - pins} more)`);
    ok(doc.querySelector('#trust-card') === card, 'config: a fleet event rebuilt the Jump hosts tab');
  }
  const zbx = tab('Zabbix');
  if (zbx) {
    zbx.click(); await settleFor(500);
    const asked = countOf('ZABBIX_CLUSTERS');
    const url = doc.querySelector('#zl-zurl');
    if (url) { url.value = 'https://zabbix.typing.test'; }
    await fire();
    ok(countOf('ZABBIX_CLUSTERS') === asked, 'config: a fleet event re-asked ZABBIX_CLUSTERS');
    if (url) ok(doc.querySelector('#zl-zurl') === url && url.value === 'https://zabbix.typing.test',
      'config: a fleet event wiped the Zabbix form while it was being typed into');
  }
  // The one thing fleet data does change — a cluster's state pill — still updates in place.
  tab('Clusters').click(); await settleFor(300);
  const shown = (await load('core/state.js')).clusters().length;   // enabled clusters only, like the table
  const pills = doc.querySelectorAll('td[data-cluster-state]');
  ok(pills.length === shown, `config: ${pills.length} state pills for ${shown} clusters`);
}

// Config page: saving something there leaves you on the Config page. A save re-reads and
// re-applies the whole config (setConfig, the Zabbix clusters, a refresh), and "back to
// Clusters" is where start() falls when it has nothing better — which is where people were
// being sent in the middle of changing a setting. Driven through the real dialogs; the
// write is stubbed so the fixture file is not rewritten, and read back as written.
{
  await go('settings');
  const realFetch = globalThis.fetch;
  let written = null;
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (body.type === 'CONFIG_WRITE') {
      written = body.text;
      return stubReply({ ok: true, path: body.path, bytes: body.text.length });
    }
    if (body.type === 'CONFIG_READ' && written !== null) {
      return stubReply({ ok: true, text: written, size: written.length, lastModified: Date.now() });
    }
    return realFetch(input, init);
  };
  const stays = (what) => ok((window.location.hash || '') === '#/settings',
    `config: ${what} left the Config page — now at "${window.location.hash}"`);
  const press = async (root, label) => {
    const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
    if (b) { b.click(); await settleFor(900); }
    return !!b;
  };
  try {
    const tabButton = (label) => [...doc.querySelectorAll('nav.subnav button')].find((b) => b.title === label);
    // Defaults → Edit defaults… → Save
    tabButton('Defaults').click(); await settleFor(300);
    ok(await press(doc.querySelector('#view'), 'Edit defaults…'), 'config: no Edit defaults button');
    const dialog = doc.querySelector('.modal');
    ok(!!dialog, 'config: the Defaults dialog did not open');
    if (dialog) {
      ok(await press(dialog, 'Save'), 'config: no Save in the Defaults dialog');
      ok(written !== null, 'config: saving the Defaults dialog never wrote the config');
      ok(!doc.querySelector('.modal'), `config: the Defaults dialog stayed open after a good save: ${(doc.querySelector('.modal-msg') || {}).textContent}`);
      stays('saving Defaults');
    }
    // A default config.txt manages is locked in the dialog with the reason, and a save does
    // not write it (config.txt would keep overriding a value nobody could see take effect).
    {
      const managed = await load('core/managed.js');
      managed.setManaged({ ok: true, managedDefaults: { diskWarnPercent: 71 }, managedZabbixOptions: {} });
      written = null;
      ok(await press(doc.querySelector('#view'), 'Edit defaults…'), 'config: no Edit defaults button (managed)');
      const dlg = doc.querySelector('.modal');
      const dw = dlg && dlg.querySelector('#ce-dw');
      ok(!!dw && dw.disabled && dw.value === '71', `config: a managed default is not shown locked at its managed value (${dw && dw.disabled}, ${dw && dw.value})`);
      ok(!!dw && dw.closest('label').textContent.includes('managed by config.txt'), 'config: a managed default does not say it is managed by config.txt');
      ok(!!dlg && !dlg.querySelector('#ce-dc').disabled, 'config: a default config.txt does not manage was locked');
      if (dlg) {
        await press(dlg, 'Save');
        ok(written !== null && !/"?diskWarnPercent"?\s*[:=]\s*71\b/.test(written), 'config: saving wrote a managed default into the config');
      }
      managed.setManaged({ ok: true, managedDefaults: {}, managedZabbixOptions: {} });
      doc.querySelectorAll('.modal').forEach((m) => m.remove());
    }
    // Clusters → Edit → Save
    tabButton('Clusters').click(); await settleFor(300);
    written = null;
    const edit = [...doc.querySelectorAll('#view button')].find((b) => b.textContent.trim() === 'Edit');
    if (edit) {
      edit.click(); await settleFor(500);
      const dlg = doc.querySelector('.modal');
      if (dlg) {
        await press(dlg, 'Save');
        ok(written !== null, 'config: saving a cluster never wrote the config');
        stays('saving a cluster');
      }
    }
    // The Zabbix options save the config and then sync; both ends of that must stay put too.
    tabButton('Zabbix').click(); await settleFor(600);
    const box = doc.querySelector('#view input[type="checkbox"]:not([disabled])');
    if (box) {
      written = null;
      box.checked = !box.checked; box.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(1200);
      stays('toggling a Zabbix option');
      const again = doc.querySelector('#view input[type="checkbox"]:not([disabled])');
      if (again) { again.checked = !again.checked; again.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(1200); }
      stays('toggling a Zabbix option back');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  // The saves above replaced the working config with what the stub kept; the cases after
  // this one expect the fixture exactly as it was loaded.
  await applyConfig({ load, configPath });
  await go('overview');
}

// Quiet UI: fleet data landing while somebody reads the Clusters page does not repaint it,
// and nothing on the bar says it was held (no "N updates — Apply" pill). It is drawn by itself
// once the page has gone 3 s untouched; Refresh draws it at once. A live page — the Request
// Centre — still takes every event.
{
  await go('overview');
  const bus = (await load('core/state.js')).bus;
  const view = doc.querySelector('#view');
  const touch = () => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  touch();
  ok(!doc.querySelector('#pending-updates'), 'quiet: the topbar has a #pending-updates pill');
  const first = view.firstElementChild;
  for (const c of config.clusters) bus.emit('data', c.id); await settleFor(700);
  ok(view.firstElementChild === first, 'quiet: a fleet event repainted the Clusters page while it was being read');
  ok(!doc.querySelector('#pending-updates') && ![...doc.querySelectorAll('#topbar *')].some((e) => /updates? — Apply/.test(e.textContent)),
    'quiet: a held update showed a pill or counter');
  ok([...doc.querySelectorAll('#topbar .pill')].some((p) => p.textContent.trim() === 'quiet'),
    'quiet: the top bar should say "quiet" under the default policy, not "live"');
  await go('requests');
  for (const c of config.clusters) bus.emit('data', c.id); await settleFor(300);
  ok(!doc.querySelector('#pending-updates'), 'quiet: a live page (Requests) grew a pill');
  await go('overview');
}

// Request policy: Config → Requests asks the core once per visit, stays quiet under fleet
// events, and saves what the presets and the Request Centre's pause buttons decide.
{
  const es = await load('core/es.js');
  const before = await es.policyGet();
  ok(before && before.ok, `policy: POLICY_GET was refused: ${JSON.stringify(before)}`);
  // A bridge keeps policy.json between runs, and the restore at the end of this case saves
  // one. With a policy already stored, "Client basis" may be what is saved, so pressing it
  // changes nothing: start from a different mode so the press and the Save mean something
  // on every run. The fresh-install assertions below need no policy saved, so they run
  // only on a data directory that has none (the first run on a fresh one, as in CI).
  if (before && before.ok && before.stored !== false && before.policy && before.policy.mode === 'on-demand') {
    await es.policySet({ ...before.policy, mode: 'background' });
  }
  const bus = (await load('core/state.js')).bus;
  const countOf = (type) => sent.filter((m) => m.type === type).length;
  const lastOf = (type) => sent.filter((m) => m.type === type).at(-1);
  const fire = async () => { for (const c of config.clusters) bus.emit('data', c.id); await settleFor(700); };
  const button = (label, scope = doc) => [...scope.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

  await go('settings');
  const tab = [...doc.querySelectorAll('nav.subnav button')].find((b) => b.title === 'Requests');
  ok(!!tab, 'policy: no Requests tab on the Config page');
  if (tab) {
    const gets = countOf('POLICY_GET');
    tab.click(); await settleFor(500);
    ok(countOf('POLICY_GET') === gets + 1, `policy: opening Requests sent ${countOf('POLICY_GET') - gets} POLICY_GET, expected exactly 1`);
    const asked = countOf('POLICY_GET');
    await fire(); await fire();
    ok(countOf('POLICY_GET') === asked, `policy: fleet events re-asked POLICY_GET (${countOf('POLICY_GET') - asked} more)`);

    // The poller's concurrency inputs sit under the request gate's caps, which POLICY_GET
    // reports: they say so, and a value typed past one is brought back to it.
    const gate = before && before.gate;
    ok(gate && Number.isInteger(gate.perCluster), `policy: POLICY_GET reports no gate: ${JSON.stringify(gate)}`);
    if (gate) {
      const per = doc.getElementById('pol-per');
      ok(per && Number(per.max) === Math.min(8, gate.perCluster), `policy: per-cluster input allows up to ${per && per.max}, the gate ${gate.perCluster}`);
      ok(per && per.closest('label').textContent.includes(`request gate: ${gate.perCluster}`), 'policy: the per-cluster input does not show the gate\'s cap');
      if (per) {
        per.value = '8'; per.dispatchEvent(new window.Event('change', { bubbles: true }));
        ok(per.value === String(Math.min(8, gate.perCluster)), `policy: typing 8 per cluster left ${per.value} under a gate of ${gate.perCluster}`);
      }
      const all = doc.getElementById('pol-global');
      ok(all && Number(all.max) === Math.min(256, gate.global), `policy: overall input allows up to ${all && all.max}, the gate ${gate.global}`);
    }

    // Change 15: each preset says what it sends, as lower bounds from its intervals.
    const effects = [...doc.querySelectorAll('#pol-effects .pol-effect')];
    ok(['client', 'auto', 'background', 'hybrid'].every((id) => effects.some((e) => e.dataset.preset === id)),
      `policy: not every preset says what it sends: ${JSON.stringify(effects.map((e) => e.dataset.preset))}`);
    ok(effects.length && effects.every((e) => /When nobody is looking: \S/.test(e.textContent) && /When a page is open: \S/.test(e.textContent)),
      'policy: a preset\'s effect does not have both lines');
    const effectOf = (id) => (effects.find((e) => e.dataset.preset === id) || {}).textContent || '';
    ok(/When nobody is looking: no requests\./.test(effectOf('client')), `policy: Client basis effect reads "${effectOf('client')}"`);
    ok(/When nobody is looking: at least \d+ an? (minute|hour) \(health every \d+ (min|s|h) × \d+/.test(effectOf('hybrid')), `policy: Hybrid effect reads "${effectOf('hybrid')}"`);
    ok(/Lower bounds: a poll can take more than one request/.test((doc.getElementById('pol-effects') || {}).textContent || ''), 'policy: the effects do not say they are lower bounds');
    ok(!!doc.getElementById('pol-mode') && doc.querySelectorAll('[aria-label="Request policy presets"] button').length === 4, 'policy: the preset bar and the Mode dropdown are not both kept');

    // Change 16: the numbers fold behind "Fine-tune", folded at first, one line saying them,
    // and the fold remembered per person.
    const fine = doc.getElementById('pol-fine');
    ok(fine && fine.tagName === 'DETAILS', 'fine-tune: the numbers are not behind a Fine-tune fold');
    if (fine) {
      const key = 'elasticpro.config.requests.fineTune.' + String(((await load('core/state.js')).state.caller || {}).name || 'local').toLowerCase();
      const wasOpen = window.localStorage.getItem(key) === '1';
      ok(fine.open === wasOpen, `fine-tune: open=${fine.open} but the remembered state is ${wasOpen}`);
      const line = fine.querySelector('summary').textContent;
      ok(/^Fine-tune\s*All clusters \d+ · per cluster \d+ · per jump host \d+ · timeout \d+ (s|ms) · \S/.test(line), `fine-tune: the folded line reads "${line}"`);
      ok(!!fine.querySelector('#pol-global') && !!fine.querySelector('#pol-iv-health') && !!fine.querySelector('#pol-watch'), 'fine-tune: the fields and the intervals are not inside the fold');
      ok(/request gate: \d+/.test(fine.textContent), 'fine-tune: the request gate ceiling is no longer said');
      if (doc.getElementById('pol-mode').value === 'on-demand') {
        ok([...fine.querySelectorAll('.pol-iv-note')].every((n) => /not on a schedule: fetched when a page asks/.test(n.textContent)), 'fine-tune: under Client basis an interval is not marked as off the schedule');
      }
      // The line follows what is typed inside.
      const g = doc.getElementById('pol-global');
      const was = g.value;
      g.value = '3'; g.dispatchEvent(new window.Event('input', { bubbles: true }));
      ok(/All clusters 3 ·/.test(fine.querySelector('summary').textContent), `fine-tune: the folded line did not follow the typed value: "${fine.querySelector('summary').textContent}"`);
      g.value = was; g.dispatchEvent(new window.Event('input', { bubbles: true }));
      // Opened, it stays open after the page is drawn again, and is put back as it was.
      fine.open = !wasOpen; fine.dispatchEvent(new window.Event('toggle'));
      ok((window.localStorage.getItem(key) === '1') === !wasOpen, 'fine-tune: the fold\'s state is not remembered');
      const other = [...doc.querySelectorAll('nav.subnav button')].find((b) => b.title === 'Defaults');
      if (other) { other.click(); await settleFor(200); tab.click(); await settleFor(500); }
      const again = doc.getElementById('pol-fine');
      ok(again && again.open === !wasOpen, `fine-tune: after a redraw the fold is ${again && again.open ? 'open' : 'folded'}, expected ${!wasOpen ? 'open' : 'folded'}`);
      if (again) { again.open = wasOpen; again.dispatchEvent(new window.Event('toggle')); }
    }

    const client = [...doc.querySelectorAll('button')].find((b) => b.textContent.startsWith('Client basis'));
    ok(!!client, 'policy: no "Client basis" preset button');
    // An install with no saved policy runs Client basis, and the page says so: that preset
    // is the one marked, and the only one called recommended. (Skipped when this bridge's
    // data directory already holds a policy somebody saved.)
    if (before && before.stored === false && client) {
      ok(client.getAttribute('aria-pressed') === 'true',
        `policy: with no saved policy "Client basis" is not the selected preset (mode ${before.policy && before.policy.mode})`);
      ok(/\(recommended\)/.test(client.textContent), 'policy: "Client basis" is not marked recommended');
      const others = [...doc.querySelectorAll('button[aria-pressed="true"]')].filter((b) => b.closest('[aria-label="Request policy presets"]'));
      ok(others.length === 1, `policy: ${others.length} presets are marked selected on a fresh install, expected 1`);
      ok(doc.querySelector('#pol-mode').value === 'on-demand', 'policy: the mode select does not show on-demand on a fresh install');
      ok(/shipped policy is running/.test(doc.body.textContent), 'policy: the page does not say that nothing is saved');
    }
    if (client) {
      client.click(); await settleFor(200);
      const pressed = [...doc.querySelectorAll('button')].find((b) => b.textContent.startsWith('Client basis'));
      ok(pressed && pressed.getAttribute('aria-pressed') === 'true', 'policy: the chosen preset is not marked aria-pressed');
      const sets = countOf('POLICY_SET');
      const save = button('Save'); ok(!!save, 'policy: no Save button');
      if (save) { save.click(); await settleFor(500); }
      const m = lastOf('POLICY_SET');
      ok(countOf('POLICY_SET') === sets + 1 && m && m.policy.mode === 'on-demand' && m.policy.concurrency.perCluster === 1,
        `policy: Save after "Client basis" sent ${JSON.stringify(m && m.policy)}`);
    }
  }

  await go('requests'); await settleFor(500);
  const per = [...doc.querySelectorAll('section.card')].find((x) => (x.querySelector('header h2') || {}).textContent === 'Per cluster');
  const pause = per && button('Pause', per);
  ok(!!pause, 'policy: the Request Centre has no per-cluster Pause button');
  if (pause) {
    const sets = countOf('POLICY_SET');
    const was = new Set(((lastOf('POLICY_SET') || {}).policy || before.policy || { paused: { clusters: [] } }).paused.clusters);
    pause.click(); await settleFor(600);
    const m = lastOf('POLICY_SET');
    const added = m ? m.policy.paused.clusters.filter((c) => !was.has(c)) : [];
    ok(countOf('POLICY_SET') === sets + 1 && added.length === 1 && config.clusters.some((c) => c.id === added[0]),
      `policy: Pause sent ${JSON.stringify(m && m.policy && m.policy.paused)}`);
    ok([...per.ownerDocument.querySelectorAll('section.card .pill.grey')].some((x) => x.textContent === 'paused'),
      'policy: a paused cluster has no "paused" pill');
  }
  ok(!!button('Pause all requests'), 'policy: the Request Centre has no "Pause all requests" button');

  // Stop all traffic: the pause-everything control sits in its own card, not in the table's
  // way, and it still pauses and still resumes — exactly one POLICY_SET each, asking for the
  // thing it says.
  const stopCard = () => doc.querySelector('.rq-stop');
  ok(!!stopCard() && /Stop all traffic/.test(stopCard().textContent), 'stop: no "Stop all traffic" card on the Request Centre');
  ok(stopCard() && /Holds every request to every cluster until you resume/.test(stopCard().textContent), 'stop: the card does not say what pausing does');
  const pauseAll = stopCard() && button('Pause all requests', stopCard());
  ok(!!pauseAll, 'stop: "Pause all requests" is not inside the Stop all traffic card');
  ok(pauseAll && pauseAll.classList.contains('danger'), 'stop: the pause button is not styled as a warning (.btn.danger)');
  ok(!doc.querySelector('.rq-tbl') || ![...doc.querySelectorAll('.rq-tbl button')].some((b) => /pause/i.test(b.textContent)), 'stop: a pause button is still among the requests table');
  if (pauseAll) {
    const wasAll = !!((lastOf('POLICY_SET') || {}).policy || before.policy || { paused: {} }).paused.all;
    ok(!wasAll, 'stop: the policy is already paused before the test pressed anything');
    const sets = countOf('POLICY_SET');
    pauseAll.click(); await settleFor(800);
    let m = lastOf('POLICY_SET');
    ok(countOf('POLICY_SET') === sets + 1 && m && m.policy.paused.all === true, `stop: Pause all requests sent ${JSON.stringify(m && m.policy && m.policy.paused)}`);
    const resume = stopCard() && button('Resume all', stopCard());
    ok(!!resume, 'stop: after pausing, the card offers no "Resume all"');
    ok(/^Paused:/.test((doc.querySelector('.rq-status h2') || {}).textContent || ''), `stop: the status line does not say paused: "${(doc.querySelector('.rq-status h2') || {}).textContent}"`);
    if (resume) {
      resume.click(); await settleFor(800);
      m = lastOf('POLICY_SET');
      ok(countOf('POLICY_SET') === sets + 2 && m && m.policy.paused.all === false, `stop: Resume all sent ${JSON.stringify(m && m.policy && m.policy.paused)}`);
      ok(!!(stopCard() && button('Pause all requests', stopCard())), 'stop: after resuming, the card does not offer "Pause all requests" again');
      ok(!/^Paused:/.test((doc.querySelector('.rq-status h2') || {}).textContent || ''), 'stop: the status line still says paused after resuming');
    }
  }

  // Answer first: one status line from the gate, the sentence under it, and the limits as chips.
  const head = (doc.querySelector('.rq-status h2') || {}).textContent || '';
  ok(/^(Quiet|Working normally|Busy|Holding back|Not known)\b/.test(head), `status: the Request Centre opens with "${head}"`);
  const under = (doc.querySelector('.rq-status p') || {}).textContent || '';
  ok(/Mode: \S/.test(under), `status: the sentence under the status line does not name the mode: "${under}"`);
  ok(!/\bGate: \d+ connections/.test(doc.querySelector('#view').textContent), 'status: the dense "Gate: N connections" sentence is still on the page');
  const chips = [...doc.querySelectorAll('.rq-limits .rq-chip')].map((c) => c.textContent);
  ok(chips.some((t) => /^\d+ at once$/.test(t)) && chips.some((t) => /per cluster$/.test(t)) && chips.some((t) => /^a person waits up to /.test(t)),
    `status: the limits are not drawn as chips: ${JSON.stringify(chips)}`);
  const tileKeys = [...doc.querySelectorAll('.rq-tiles .stat .k')].map((k) => k.textContent);
  ok(JSON.stringify(tileKeys) === JSON.stringify(['In flight', 'Waiting', 'Wait (95th %)', 'Turned away', 'Not sent again', 'Rate']), `status: tiles are ${JSON.stringify(tileKeys)}`);

  // A table people can scan: time of day with the date on hover, the path on one line with
  // its whole self on hover, the class as a tag, the result as a dot and a code.
  const first = doc.querySelector('.rq-tbl tbody tr:not(.inflight)');
  ok(!!first, 'table: no finished row to read');
  if (first) {
    const cells = [...first.children];
    ok(/^\d\d:\d\d:\d\d$/.test(cells[0].textContent) && cells[0].title.length > 8, `table: Time is "${cells[0].textContent}" (title "${cells[0].title}")`);
    const pb = first.querySelector('button.rq-path');
    ok(pb && pb.title.startsWith(pb.textContent), `table: the path is not a one-line cell with its full text on hover: ${pb && pb.title}`);
    ok(first.querySelector('.rq-tag'), 'table: the class is not a tag');
    ok(first.querySelector('.rq-result .rq-rdot'), 'table: the result has no dot');
    ok(![...doc.querySelectorAll('.rq-tbl td.num, .rq-tbl th.num')].length, 'table: a right-aligned numeric column is left in the requests table');
  }
  const heads = [...doc.querySelectorAll('.rq-tbl thead th')].map((t) => t.textContent);
  ok(JSON.stringify(heads) === JSON.stringify(['Time', 'Cluster', 'From', 'Class', 'Method', 'Path', 'Wait', 'Took', 'Result']), `table: columns are ${JSON.stringify(heads)}`);
  const hk = doc.querySelector('details.rq-hk');
  ok(!!hk && /Housekeeping/.test(hk.querySelector('summary').textContent) && !!hk.querySelector('[data-act="hk-dry"]'), 'housekeeping: not a one-line summary with the full card inside');

  // The mode in the sentence links to Config > Requests.
  const modeLink = doc.querySelector('.rq-status p a');
  ok(!!modeLink, 'status: the mode is not a link');
  if (modeLink) {
    modeLink.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); await settleFor(900);
    const cur = doc.querySelector('nav.subnav button[aria-current="page"]');
    ok(cur && cur.title === 'Requests', `status: the mode link did not open Config > Requests (open tab: ${cur && cur.title})`);
    await go('requests'); await settleFor(300);
  }
  await go('overview');
  // The harness writes into the dev core's data directory; leave the policy as it was.
  if (before && before.ok) await es.policySet(before.policy);
}

/* ------------- fleet pages state their cost up front; reading is the button ------------- */

if (viaFleet) {
  const st = await load('core/state.js');
  const DS = ['health', 'nodes', 'ilm_errors', 'snapshots', 'policies'];   // alerts.js DATASETS
  // Under hybrid/on-demand a page can open onto clusters nothing was read for. The mock's
  // poller runs `background`, so make that true here: forget one dataset everywhere.
  for (const cur of st.fleet.raw.values()) delete cur.datasets.snapshots;
  await go('overview');
  ok(!doc.querySelector('#view .banner.coverage'), 'coverage: the Clusters page shows the coverage bar again (removed 2026-10-25)');
  ok(!doc.querySelector('#side-foot:not([hidden])'), 'coverage: the status strip is back on the Clusters page');
  // The Alerts page keeps the bar and Read all.
  await go('overview');
  let before = sent.length;
  await go('alerts');
  const bar = doc.querySelector('#view .banner.coverage');
  ok(!!bar, 'coverage: the Alerts page has no coverage bar');
  ok(bar && /never read|No data read yet/.test(bar.textContent), `coverage: the bar does not say what was never read: "${bar && bar.textContent}"`);
  const opened = sent.slice(before).filter((m) => m.type === 'CLUSTER_DATASET');
  ok(opened.length === 0, `coverage: opening the Alerts page sent ${opened.length} CLUSTER_DATASET (reading must be a decision)`);
  const btn = bar && bar.querySelector('button[data-act="read-all"]');
  ok(!!btn && /Read all \(one at a time\)/.test(btn.textContent), 'coverage: no "Read all (one at a time)" button');
  if (btn) {
    const ids = st.activeClusters().map((c) => c.id);
    const want = ids.length * DS.length;
    before = sent.length;
    btn.click();
    await settleFor(60);
    ok(!!doc.querySelector('#view .banner.coverage button[data-act="read-cancel"]') || sent.slice(before).filter((m) => m.type === 'CLUSTER_DATASET').length === want,
      'coverage: a running Read all shows no Cancel button');
    // One at a time: wait until every read has been sent, up to a generous bound.
    for (let i = 0; i < 100 && sent.slice(before).filter((m) => m.type === 'CLUSTER_DATASET').length < want; i++) await settleFor(100);
    await settleFor(300);
    const reads = sent.slice(before).filter((m) => m.type === 'CLUSTER_DATASET');
    ok(reads.length === want, `coverage: Read all sent ${reads.length} CLUSTER_DATASET, expected ${ids.length} clusters × ${DS.length} datasets = ${want}`);
    ok(reads.every((m) => m.wait === true), 'coverage: a Read all ask did not wait for its answer');
    const order = reads.map((m) => `${m.clusterId}/${m.dataset}`);
    const expect = ids.flatMap((id) => DS.map((d) => `${id}/${d}`));
    ok(JSON.stringify(order) === JSON.stringify(expect), `coverage: Read all went out of order: ${order.join(', ')}`);
    const after = doc.querySelector('#view .banner.coverage');
    ok(after && !after.querySelector('button[data-act="read-cancel"]'), 'coverage: the bar still says Cancel after the run');
    ok(after && !/never read/.test(after.textContent), `coverage: still "never read" after Read all: "${after && after.textContent}"`);
  }
}

// Tasks panel: one request to the chosen cluster on the button, ours told from a stranger's
// by the opaque id, and Cancel is a write — under read-only it asks for the guard first.
{
  // Earlier cases replaced the cluster clients with stubs that have no request(); the panel
  // sends a real ES message through the bridge, so give it real clients again.
  const stx = await load('core/state.js');
  const esm = await load('core/es.js');
  stx.state.config = config;                       // some cases also swapped the config for a stub one
  if (!config.clusters.some((c) => c.id === stx.state.selected)) stx.state.selected = config.clusters[0].id;
  for (const c of config.clusters) stx.state.clients.set(c.id, new esm.EsClient(c, stx.state.defaults, async () => {}));
  await go('requests');
  const before = sent.length;
  const read = doc.querySelector('button[data-act="read-tasks"]');
  ok(!!read, 'tasks: no "Read tasks" button');
  if (read) {
    read.click(); await settleFor(900);
    const asked = sent.slice(before).filter((m) => m.type === 'ES' && /^\/_tasks/.test(m.path));
    ok(asked.length === 1 && asked[0].method === 'GET', `tasks: expected one GET _tasks, saw ${JSON.stringify(asked.map((m) => m.method + ' ' + m.path))}`);
    const pills = [...doc.querySelectorAll('section.card .pill')].map((p) => p.textContent.trim());
    ok(pills.some((t) => /^ours/.test(t)), `tasks: no task marked as ours (pills: ${JSON.stringify(pills.slice(-6))})`);
    ok(pills.includes('someone else'), 'tasks: the stranger\u2019s search is not marked as someone else\u2019s');
    const cancel = doc.querySelector('button[data-act="cancel-task"]');
    ok(!!cancel, 'tasks: no Cancel button');
    if (cancel) {
      const n = sent.length;
      cancel.click(); await settleFor(400);
      const dialog = doc.querySelector('.modal, [role="dialog"], .overlay');
      ok(!!dialog, 'tasks: Cancel under read-only should ask for the write guard first (no dialog appeared)');
      ok(!sent.slice(n).some((m) => m.type === 'ES' && /_cancel/.test(m.path)), 'tasks: a _cancel was sent before anybody said yes');
      doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const no = dialog && [...dialog.querySelectorAll('button')].find((b) => /^(no|cancel|keep)/i.test(b.textContent.trim()));
      if (no) no.click();
      await settleFor(300);
    }
  }
}

// REST console tabs: up to ten, each keeping its own query; the eleventh is refused.
consoleTabs: {
  await go('console');
  const strip = () => doc.querySelectorAll('.console-tab');
  const add = () => doc.querySelector('.console-tab-add');
  // The page is entitled to be drawn the moment go() returns; waiting is for a machine slow
  // enough that it is not, and the message names what stood there instead if it never is.
  if (!(await waitFor(add, 'console tabs: the + button'))) break consoleTabs;
  ok(strip().length >= 1, 'console tabs: no tab strip');
  // The tabs are remembered across visits (and a bridge keeps its data directory between
  // runs), so start from one tab rather than from whatever an earlier visit left.
  while (strip().length > 1) { strip()[strip().length - 1].querySelector('.console-tab-x').click(); await settleFor(30); }
  const path = doc.querySelector('#c-path');
  if (path) { path.value = '/_cat/health'; path.dispatchEvent(new window.Event('input', { bubbles: true })); }
  const before = strip().length;
  add().click(); await settleFor(200);
  ok(strip().length === before + 1, `console tabs: + did not add a tab (${strip().length})`);
  ok(doc.querySelector('#c-path').value !== '/_cat/health', 'console tabs: a new tab should not carry the previous path');
  doc.querySelectorAll('.console-tab')[before - 1].querySelector('.console-tab-label').click(); await settleFor(200);
  ok(doc.querySelector('#c-path').value === '/_cat/health', `console tabs: switching back lost the path (${doc.querySelector('#c-path').value})`);
  for (let i = 0; i < 12; i++) { if (!add().disabled) { add().click(); await settleFor(50); } }
  ok(strip().length === 10, `console tabs: expected at most 10, saw ${strip().length}`);
  ok(add().disabled, 'console tabs: + should be disabled at ten');
  while (strip().length > 1) { strip()[strip().length - 1].querySelector('.console-tab-x').click(); await settleFor(30); }
  ok(strip().length === 1, 'console tabs: closing should leave one tab');
}

// Templates: a third view on the Indices page. Built-in templates are hidden until asked
// for; Save under read-only asks for the guard and sends no PUT before anybody says yes;
// Simulate POSTs _simulate_index (not on the core's read-only list, so it goes through the
// guard too) and names the template that wins.
{
  const stx = await load('core/state.js');
  const esm = await load('core/es.js');
  const wr = await load('core/writes.js');
  stx.state.config = config;
  if (!config.clusters.some((c) => c.id === stx.state.selected)) stx.state.selected = config.clusters[0].id;
  for (const c of config.clusters) stx.state.clients.set(c.id, new esm.EsClient(c, stx.state.defaults, async () => {}));
  await go('indices');
  const tabs = () => [...doc.querySelectorAll('#view .seg button')];
  const tplTab = tabs().find((b) => b.textContent.trim() === 'Templates');
  ok(!!tplTab, `templates: no Templates tab on the Indices page (tabs: ${tabs().map((b) => b.textContent.trim()).join(', ')})`);
  if (tplTab) {
    tplTab.click();
    for (let i = 0; i < 40 && !doc.querySelector('#view tr[data-name="logs-app"]'); i++) await settleFor(100);
    const names = [...doc.querySelectorAll('#view tr[data-name]')].map((tr) => tr.getAttribute('data-name'));
    ok(names.includes('logs-app'), `templates: logs-app is not listed (rows: ${names.join(', ')})`);
    ok(!names.includes('.ilm-history-7'), 'templates: the built-in .ilm-history-7 is shown although "show built-in" is off');
    ok(!doc.querySelector('#idx-table'), 'templates: the indices table is still drawn under the Templates view');

    const topModal = () => { const m = doc.querySelectorAll('.modal'); return m.length ? m[m.length - 1] : null; };
    const press = (root, re) => { const b = root && [...root.querySelectorAll('button')].find((x) => re.test(x.textContent.trim())); if (b) b.click(); return !!b; };
    const row = () => doc.querySelector('#view tr[data-name="logs-app"]');

    const view = row() && row().querySelector('button[data-act="tpl-view"]');
    ok(!!view, 'templates: no View / Edit button on logs-app');
    if (view) {
      view.click(); await settleFor(250);
      const area = doc.querySelector('#tpl-json');
      ok(area && area.value.includes('"index_patterns"'), 'templates: the editor does not show the template body');
      const save = doc.querySelector('button[data-act="tpl-save"]');
      ok(!!save, 'templates: no Save button in the editor');
      if (save) {
        const n = sent.length;
        save.click(); await settleFor(500);
        const dlg = topModal();
        ok(!!dlg && !dlg.querySelector('#tpl-json'), 'templates: Save under read-only should ask for the write guard first (no dialog appeared)');
        ok(!sent.slice(n).some((m) => m.type === 'ES' && m.method === 'PUT'), 'templates: a PUT was sent before anybody said yes');
        press(dlg, /^no$/i); await settleFor(400);
        // Declining puts the editor back with the text intact; close it.
        ok(!!doc.querySelector('#tpl-json'), 'templates: declining the guard lost the editor');
        press(topModal(), /^cancel$/i); await settleFor(200);
        ok(!sent.slice(n).some((m) => m.type === 'ES' && m.method === 'PUT'), 'templates: a PUT was sent after the guard was declined');
      }
    }

    const sim = row() && row().querySelector('button[data-act="tpl-simulate"]');
    ok(!!sim, 'templates: no Simulate button on logs-app');
    if (sim) {
      const n = sent.length;
      sim.click(); await settleFor(250);
      const input = topModal() && topModal().querySelector('input');
      ok(!!input, 'templates: Simulate did not ask for an index name');
      if (input) {
        input.value = 'logs-app-2026.10.14';
        press(topModal(), /^simulate$/i); await settleFor(400);
        const unlockedHere = !wr.writesUnlocked();
        if (unlockedHere) { press(topModal(), /^allow writes$/i); }
        for (let i = 0; i < 40 && !doc.querySelector('#tpl-sim-result'); i++) await settleFor(100);
        const posts = sent.slice(n).filter((m) => m.type === 'ES' && m.method === 'POST' && /^\/_index_template\/_simulate_index\//.test(m.path));
        ok(posts.length === 1, `templates: expected one POST _simulate_index, saw ${posts.length}`);
        const res = doc.querySelector('#tpl-sim-result');
        ok(res && res.querySelector('[data-winner="logs-app"]'), `templates: the simulate result does not name logs-app as the winner ("${res && res.textContent.slice(0, 160)}")`);
        ok(res && /logs-default/.test(res.textContent), 'templates: the overlapping lower-priority template is not shown');
        press(topModal(), /^done$/i); await settleFor(150);
        if (unlockedHere) await wr.setWritesUnlocked(false);
      }
    }
    // Leave the page on its default view for whatever runs next.
    const back = tabs().find((b) => b.textContent.trim() === 'Indices');
    if (back) { back.click(); await settleFor(100); }
  }
}

/* ------------- alerts: grouped by cluster, repeats merged, a way on from each ------------- */

// Last, on purpose: it follows links to other pages, which selects clusters and leaves a request
// prepared in the console. Nothing after it would be checking what it thinks it is checking.

{
  const st = await load('core/state.js');
  const acks = await load('core/acks.js');
  const notify = await load('core/notify.js');
  const { DEFAULTS } = await load('core/config.js');
  // The harness's IndexedDB never completes a transaction, so anything that awaits a write
  // (an acknowledgement is one) would wait for ever. The browser's does; here a Map stands in,
  // answering at once — what is under test is what the page does with the records.
  const { idb } = await load('lib/idb.js');
  const realIdb = { putAck: idb.putAck, delAck: idb.delAck, allAcks: idb.allAcks, setKV: idb.setKV, getKV: idb.getKV };
  const ackRows = new Map();
  Object.assign(idb, {
    putAck: async (r) => { ackRows.set(r.key, JSON.parse(JSON.stringify(r))); return true; },
    delAck: async (k) => { ackRows.delete(k); return true; },
    allAcks: async () => [...ackRows.values()],
    setKV: async () => true,
    getKV: async (k) => (k === 'ackUser' ? 'qa' : undefined),
  });
  const saved = { config: st.state.config, data: st.state.data, clients: st.state.clients,
    selected: st.state.selected, defaults: st.state.defaults, indices: st.state.indices };
  const automation = await load('core/automation.js');

  // Its own fleet: the real one answers with whatever the mock happens to be doing, and
  // this is about how a known set of alerts is laid out and what each button does.
  const node = (name, used) => ({ node: name, 'disk.used': String(used), 'disk.total': '100', 'disk.avail': String(100 - used), shards: '10' });
  const healthy = () => ({ reachable: true, health: { status: 'green', unassigned_shards: 0 }, slm: [], repos: [], snapshots: {} });
  const fleet = () => ({
    a: { ...healthy(), health: { status: 'yellow', unassigned_shards: 4 },
         disk: { percent: 91, nodes: [node('es-hot-1', 89), node('es-hot-2', 88), node('es-hot-3', 86)] },
         ilmErrorCount: 2, ilmErrors: { 'logs-1': { failed_step: 'rollover' }, 'logs-2': { failed_step: 'rollover' } } },
    k: { reachable: false },
    b: { ...healthy(), slmStatus: { operation_mode: 'STOPPED' } },
    q: healthy(),
  });
  const names = { a: 'atlas-prod', k: 'kestrel-dc', b: 'bravo-ci', q: 'quiet-lab' };
  st.state.defaults = { ...DEFAULTS, diskWarnPercent: 85, diskCritPercent: 90 };
  // An automation that raised an alert on kestrel-dc while it was up: an alert raised before the
  // cluster went down, which is what the Alerts page holds behind the Unreachable line.
  st.state.config = { clusters: Object.entries(names).map(([id, name]) => ({ id, name, url: `http://${id}.example:9200`, enabled: true })),
    raw: { automations: [{ id: 'old', name: 'Old logs', enabled: true, clusters: ['*'], when: [],
      match: { conditions: [{ field: 'day', op: 'olderThan', value: '30d' }], all: true }, scope: { kind: 'all' },
      trigger: { when: 'any', count: 1 }, action: 'notify', notify: { alert: true, level: 'warning', webhook: '' } }] } };
  st.state.selected = 'all';
  st.state.clients = new Map(Object.keys(names).map((id) => [id, { state: 'online' }]));
  st.state.indices = new Map([['k', [{ index: 'logs-2020.01.01', day: '2020-01-01', size: 1, docs: 1, health: 'green', status: 'open' }]]]);
  st.state.data = new Map(Object.entries({ ...fleet(), k: healthy() }));
  automation.clearAutomation();
  await automation.runAutomation();
  st.state.data = new Map(Object.entries(fleet()));      // …and now kestrel-dc is down
  await acks.setCurrentUser('qa');
  for (const k of ['a:disk', 'a:health', 'a:ilm', 'a:disk-balance', 'k:unreachable', 'b:slm-mode']) await acks.unacknowledge(k);
  st.invalidateAlerts();

  // The harness turns a.click() into a no-op (it only captures downloads), so a link is followed
  // the way a browser does it: by dispatching the click.
  const follow = (a) => a.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const navs = [];
  const onNav = (e) => navs.push(e.detail);
  window.addEventListener('ep:navigate', onNav);
  try {
    await go('alerts');
    const groupNames = () => [...doc.querySelectorAll('#view .agroup-name')].map((x) => x.textContent);
    const press = (label) => [...doc.querySelectorAll('#view .seg-btn')].find((b) => b.textContent === label);

    // Default: the unreachable cluster first, then clusters with two alerts or more as groups
    // (worst, then most, then name), and a cluster with one alert as one line.
    ok(press('Cluster') && press('Cluster').getAttribute('aria-pressed') === 'true', 'alerts: Cluster is not the default grouping');
    ok(JSON.stringify(groupNames()) === JSON.stringify(['Unreachable · 1 cluster', 'atlas-prod']),
      `alerts: the groups should be Unreachable first, then atlas-prod (bravo-ci has one alert, so it is a line) — saw ${groupNames().join(', ')}`);
    const sections = () => [...doc.querySelectorAll('#view .agroups > section')];
    ok(sections()[0] && sections()[0].classList.contains('adown'), 'alerts: the Unreachable group is not first');
    ok(!doc.querySelector('#view .stat'), 'alerts: the four tiles are still there');
    const sumText = () => [...doc.querySelector('#view .alerts-sum').children].map((x) => x.textContent.trim()).join(' ');
    ok(/^\d+ critical · \d+ warning · in 3 of 4 clusters · 0 acknowledged/.test(sumText()), `alerts: the summary line reads "${sumText()}"`);
    ok(!/Alerts current for/.test(doc.getElementById('view').textContent), 'alerts: the "Alerts current for N of M clusters" sentence is still there');
    const foot = doc.querySelector('#view .alerts-foot').textContent;
    ok(/1 cluster has no open alerts/.test(foot) && /1 older alert held on unreachable clusters, not counted/.test(foot), `alerts: footer reads "${foot}"`);
    ok(!!doc.querySelector('#view .agroup-head a.agroup-name'), 'alerts: the cluster name in a group header is not a link');

    // Unreachable first: one line, the whole name and reason, how long, Retry (primary), Diagnose, Ack, More.
    {
      const down = doc.querySelector('#view .adown');
      const line = down && down.querySelector('.adown-row');
      ok(!!line && /kestrel-dc/.test(line.textContent), 'alerts: the unreachable cluster has no line');
      ok(line && line.querySelector('.adown-name').textContent === 'kestrel-dc', 'alerts: the line does not carry the full name');
      ok(line && line.querySelector('.adown-reason').textContent.length > 5, 'alerts: the line carries no reason');
      ok(line && /down (under a minute|\d+ (min|h))/.test(line.querySelector('.adown-meta').textContent), `alerts: no "down for" on the line: "${line && line.querySelector('.adown-meta').textContent}"`);
      const btns = line ? [...line.querySelectorAll('.arow-main button')].map((b) => b.textContent) : [];
      ok(['Retry', 'Diagnose', 'Ack', 'More'].every((w) => btns.includes(w)), `alerts: the unreachable line has ${JSON.stringify(btns)}`);
      ok(line && line.querySelector('button.primary') && line.querySelector('button.primary').textContent === 'Retry', 'alerts: Retry is not the primary button');
      ok(line && !line.querySelector('a.golink'), 'alerts: the unreachable line has a Go to as well');
      const dh = [...down.querySelectorAll('.adown-head button')].map((b) => b.textContent);
      ok(dh.includes('Retry all') && dh.includes('Acknowledge all'), `alerts: the Unreachable header has ${JSON.stringify(dh)}`);
      // …and shown once: kestrel-dc is in no group below, whatever the grouping.
      const kRows = () => [...doc.querySelectorAll('#view .arow')].filter((r) => /kestrel-dc/.test(r.textContent));
      ok(kRows().length === 1, `alerts: kestrel-dc is listed ${kRows().length} times`);
      // Its older alert is held: said on the line, not listed, not counted.
      ok(/1 older alert held, not current/.test(line.textContent), `alerts: the line does not say what is held: "${line.querySelector('.adown-meta').textContent}"`);
      ok(![...doc.querySelectorAll('#view .arow-title b')].some((b) => b.textContent === 'Old logs'), 'alerts: the held alert is listed as a current row');
      ok(!st.openAlertsNow().some((m) => m.key.startsWith('k:automation')), 'alerts: the held alert is counted as open');
      line.querySelector('.arow-toggle').click(); await settleFor(80);
      const opened = doc.querySelector('#view .adown .adown-row');
      const held = opened && opened.querySelector('.aheld');
      ok(held && /Old logs/.test(held.textContent) && /not current/.test(held.textContent), 'alerts: opening the line does not list the held alert, labelled not current');
      ok(opened && /How to fix/.test(opened.textContent) && /Related/.test(opened.textContent), 'alerts: the unreachable line has no How to fix and Related when opened');
      opened.querySelector('.arow-toggle').click(); await settleFor(60);
    }

    // One line for a cluster with one alert: no header, severity, name, title, age, Go to, Ack, More.
    {
      const one = [...doc.querySelectorAll('#view .arow.single')];
      ok(one.length === 1 && /bravo-ci/.test(one[0].textContent), `alerts: bravo-ci (one alert) should be one line, saw ${one.length} line(s)`);
      const r1 = one[0];
      ok(r1 && !r1.closest('section').querySelector('.agroup-head'), 'alerts: a one-alert cluster has a group header');
      const w = r1 ? [...r1.querySelectorAll('.arow-main button')].map((b) => b.textContent) : [];
      ok(w.includes('Ack') && w.includes('More') && r1.querySelector('a.golink') && r1.querySelector('.apill') && r1.querySelector('.arow-age'),
        `alerts: the one-line cluster has ${JSON.stringify(w)}`);
      ok(r1 && r1.querySelector('a.golink') && !r1.querySelector('a.golink').classList.contains('btn'), 'alerts: Go to is a button, not a link');
      const ah = [...doc.querySelectorAll('#view .agroup-head')].find((x) => /atlas-prod/.test(x.textContent));
      const ahb = ah ? [...ah.querySelectorAll('button')].map((b) => b.textContent) : [];
      ok(ahb.includes('Acknowledge all') && ahb.includes('Silence ▾'), `alerts: a group header has ${JSON.stringify(ahb)}`);
      ok(ah && [...ah.querySelectorAll('button.btn')].every((b) => b.classList.contains('ghost')), 'alerts: a group-header action is not quiet');
    }

    // The counts are filters.
    {
      const cnt = (id) => doc.getElementById(id);
      const levels = () => [...doc.querySelectorAll('#view .arow:not(.adown-row) > .arow-main > .apill')].map((x) => x.textContent);
      const allLevels = levels();
      ok(allLevels.includes('warning') && allLevels.includes('critical'), `alerts: the fleet should have both levels, saw ${allLevels.join(',')}`);
      cnt('alerts-sum-critical').click(); await settleFor(60);
      ok(cnt('alerts-sum-critical').getAttribute('aria-pressed') === 'true' && press('Critical').getAttribute('aria-pressed') === 'true', 'alerts: the critical count did not apply the critical filter');
      ok(levels().every((x) => x === 'critical') && !!doc.querySelector('#view .adown'), 'alerts: the critical count still shows warnings, or hides the unreachable cluster');
      cnt('alerts-sum-critical').click(); await settleFor(60);
      ok(press('All').getAttribute('aria-pressed') === 'true' && levels().length === allLevels.length, 'alerts: pressing the critical count again did not show all');
      cnt('alerts-sum-warning').click(); await settleFor(60);
      ok(press('Warning').getAttribute('aria-pressed') === 'true' && levels().length > 0 && levels().every((x) => x === 'warning') && !doc.querySelector('#view .adown'),
        'alerts: the warning count did not show warnings only (an unreachable cluster is critical)');
      cnt('alerts-sum-warning').click(); await settleFor(60);
      cnt('alerts-sum-acked').click(); await settleFor(60);
      ok(doc.getElementById('alerts-handled').checked && cnt('alerts-sum-acked').getAttribute('aria-pressed') === 'true', 'alerts: the acknowledged count did not show acknowledged alerts');
      cnt('alerts-sum-acked').click(); await settleFor(60);
      ok(!doc.getElementById('alerts-handled').checked, 'alerts: the acknowledged count did not toggle back');
    }

    // Export CSV lists held alerts too, marked: held is never passed off as current.
    {
      files.length = 0;
      [...doc.querySelectorAll('#view .alerts-bar button')].find((b) => b.textContent === 'Export CSV').click(); await settleFor(150);
      const csv = files.find((f) => /^es-alerts-.*\.csv$/.test(f.name));
      ok(!!csv, 'alerts: Export CSV produced no file');
      if (csv) {
        const lines = csv.text.split('\n');
        ok(/(^|,)held_not_current(,|$)/.test(lines[0]), `alerts: the CSV has no held column: ${lines[0].slice(0, 120)}`);
        const heldRow = lines.find((l) => /k:automation/.test(l));
        ok(heldRow && /,held,yes,/.test(heldRow), `alerts: the held alert is not marked in the CSV: ${heldRow}`);
        ok(lines.filter((l) => /k:unreachable/.test(l) && /,no,/.test(l)).length === 1, 'alerts: the unreachable alert is not exactly one current row in the CSV');
      }
    }

    // The merged disk alert: one row, three nodes inside, opened with its toggle.
    const row = (title) => [...doc.querySelectorAll('#view .arow')].find((r) => r.querySelector('.arow-title b').textContent.startsWith(title));
    let disk = row('Disk usage above 85%');
    ok(!!disk, `alerts: no merged disk row, rows: ${[...doc.querySelectorAll('#view .arow-title b')].map((x) => x.textContent).join(' | ')}`);
    if (disk) {
      ok(/on 3 nodes/.test(disk.textContent), 'alerts: the disk row does not say "on 3 nodes"');
      ok(!disk.querySelector('.apanel'), 'alerts: the panel is open before anyone asked');
      const t = disk.querySelector('.arow-toggle');
      ok(t && t.getAttribute('aria-expanded') === 'false', 'alerts: the toggle does not say it is collapsed');
      t.click();
      await settleFor(80);
      disk = row('Disk usage above 85%');
      const t2 = disk.querySelector('.arow-toggle');
      ok(t2.getAttribute('aria-expanded') === 'true', 'alerts: the toggle does not say it is expanded');
      const items = [...disk.querySelectorAll('.aitem')];
      ok(items.length === 3, `alerts: expected 3 nodes under the merged disk alert, saw ${items.length}`);
      ok(items.length && /es-hot-1/.test(items[0].textContent) && /89%/.test(items[0].textContent), `alerts: the fullest node is not first: "${items[0] && items[0].textContent}"`);
      ok(items.every((i) => i.querySelector('a.aitem-link')), 'alerts: an item has no link of its own');
      const panel = disk.querySelector('.apanel');
      ok(/How to fix/.test(panel.textContent) && /Related/.test(panel.textContent), 'alerts: the panel lacks How to fix or Related');
      ok(/Likely cause/.test(panel.textContent), 'alerts: the playbook names no likely cause');
      ok(/ILM/.test(panel.textContent), 'alerts: the disk playbook does not point at the ILM errors open on the same cluster');
      ok(/No history yet for this alert on atlas-prod/.test(panel.textContent), `alerts: no "No history yet" in Related: ${panel.querySelector('.related-hist') && panel.querySelector('.related-hist').textContent}`);
      const prep = [...panel.querySelectorAll('.apanel-steps a')].filter((a) => /Prepare .* in the REST console/.test(a.textContent));
      ok(prep.length >= 2, `alerts: expected prepared console requests in the playbook, saw ${prep.length}`);
      ok([...panel.querySelectorAll('.apanel-steps li')].some((li) => /writes still need the unlock/.test(li.textContent)),
        'alerts: a prepared write is not labelled as needing the unlock');
    }

    // A prepared request opens the console filled in and sends nothing.
    const before = sent.length;
    const writeStep = disk && [...disk.querySelectorAll('.apanel-steps li')].find((li) => /read_only_allow_delete|release them/.test(li.textContent));
    const writeLink = writeStep && writeStep.querySelector('a[href="#/console"]');
    ok(!!writeLink, 'alerts: no prepared release request in the disk playbook');
    if (writeLink) {
      follow(writeLink);
      await settleFor(350);
      const path = doc.getElementById('c-path');
      ok(path && /_all\/_settings/.test(path.value), `alerts: the console was not filled in, path is "${path && path.value}"`);
      ok(sent.slice(before).every((m) => !(m.method && m.method !== 'GET' && /_all\/_settings/.test(m.path || ''))), 'alerts: a prepared write was sent');
      st.state.selected = 'all';
      await go('alerts');
      disk = row('Disk usage above 85%');
    }

    // Go to: a visible link on every alert, and it opens the page with the cluster selected.
    const rows = [...doc.querySelectorAll('#view .arow:not(.adown-row)')];
    ok(rows.length >= 5 && rows.every((r) => r.querySelector('a.golink')), `alerts: every alert needs a "Go to" link (${rows.filter((r) => r.querySelector('a.golink')).length} of ${rows.length} have one)`);
    const link = disk && disk.querySelector('.arow-main a.golink');
    ok(link && /^Go to .+ →$/.test(link.textContent), `alerts: the link reads "${link && link.textContent}"`);
    navs.length = 0;
    if (link) {
      follow(link);
      await settleFor(350);
      ok(navs.some((n) => n.page === 'shards' && n.cluster === 'a'), `alerts: Go to did not navigate to shards with the cluster: ${JSON.stringify(navs)}`);
      ok(st.state.selected === 'a', `alerts: the cluster was not selected on arrival (${st.state.selected})`);
      ok(doc.querySelector('#view [data-focus="nodes"]'), 'alerts: the Nodes page did not bring the node table into view');
      await go('alerts');
      st.state.selected = 'all';
      await go('alerts');
    }
    const ilmGo = row('Indices in an ILM error step');
    navs.length = 0;
    if (ilmGo) {
      follow(ilmGo.querySelector('a.golink'));
      await settleFor(450);
      ok(navs.some((n) => n.page === 'indices' && n.cluster === 'a'), `alerts: the ILM alert did not go to Indices: ${JSON.stringify(navs)}`);
      ok(/Only indices in an ILM error step/.test(doc.getElementById('view').textContent), 'alerts: the Indices page was not filtered to the ILM errors');
      st.state.selected = 'all';
      await go('alerts');
    }

    // Collapse, remembered.
    const toggle = (name) => [...doc.querySelectorAll('#view .agroup-toggle')].find((b) => b.getAttribute('aria-label').endsWith(` ${name}`));
    const kt = toggle('atlas-prod');
    ok(kt && kt.getAttribute('aria-expanded') === 'true', 'alerts: a group does not say it is expanded');
    if (kt) {
      kt.click();
      await settleFor(60);
      const after = toggle('atlas-prod');
      ok(after.getAttribute('aria-expanded') === 'false', 'alerts: collapsing did not collapse');
      ok(/cluster:a/.test(window.localStorage.getItem('elasticpro.alerts.collapsed') || ''), 'alerts: the collapsed group is not remembered');
      ok(doc.querySelectorAll('#view .agroups > section').length === 3, 'alerts: collapsing removed the group');
      after.click();
      await settleFor(60);
    }
    const ut = toggle('Unreachable');
    ok(ut && ut.getAttribute('aria-expanded') === 'true', 'alerts: the Unreachable group has no toggle');
    if (ut) {
      ut.click(); await settleFor(60);
      ok(toggle('Unreachable').getAttribute('aria-expanded') === 'false' && !doc.querySelector('#view .adown .adown-row'), 'alerts: collapsing Unreachable left its lines');
      toggle('Unreachable').click(); await settleFor(60);
      ok(!!doc.querySelector('#view .adown .adown-row'), 'alerts: expanding Unreachable did not bring its lines back');
    }
    const ca = doc.getElementById('alerts-collapse-all');
    ok(!!ca, 'alerts: no Collapse all');
    if (ca) {
      ca.click(); await settleFor(60);
      ok([...doc.querySelectorAll('#view .agroup-toggle')].every((b) => b.getAttribute('aria-expanded') === 'false'), 'alerts: Collapse all left a group open');
      doc.getElementById('alerts-collapse-all').click(); await settleFor(60);
      ok([...doc.querySelectorAll('#view .agroup-toggle')].every((b) => b.getAttribute('aria-expanded') === 'true'), 'alerts: Expand all left a group closed');
    }

    // Keyboard: arrows step between the toggles, which are real buttons with a name.
    {
      const navs = [...doc.querySelectorAll('#view [data-nav]')];
      ok(navs.length >= 4 && navs.every((b) => b.tagName === 'BUTTON' && b.hasAttribute('aria-expanded') && b.getAttribute('aria-label')), 'alerts: the toggles are not named, expandable buttons');
      navs[0].focus();
      navs[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      ok(doc.activeElement === navs[1], 'alerts: ArrowDown did not move to the next toggle');
      navs[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      ok(doc.activeElement === navs[0], 'alerts: ArrowUp did not move back');
      ok([...doc.querySelectorAll('#view .golink')].every((a) => a.tagName === 'A' && a.getAttribute('href')), 'alerts: a Go to is not a real link');
    }

    // The other groupings and the filters. Unreachable is first in every one, and only once.
    const firstIsDown = () => !!doc.querySelector('#view .agroups > section:first-child.adown');
    const kestrelRows = () => [...doc.querySelectorAll('#view .arow')].filter((r) => /kestrel-dc/.test(r.textContent)).length;
    press('Alert type').click(); await settleFor(60);
    ok(doc.querySelectorAll('#view .agroup').length >= 4 && firstIsDown() && !groupNames().includes('Cluster unreachable'), `alerts: Alert type grouping: ${groupNames().join(', ')}`);
    ok(kestrelRows() === 1, `alerts: by Alert type kestrel-dc is listed ${kestrelRows()} times`);
    press('None').click(); await settleFor(60);
    ok(doc.querySelectorAll('#view .agroup.flat').length === 1 && !doc.querySelector('#view .agroup.flat .agroup-head') && firstIsDown(), 'alerts: None should be one flat list, Unreachable first');
    ok(kestrelRows() === 1, `alerts: with no grouping kestrel-dc is listed ${kestrelRows()} times`);
    press('Cluster').click(); await settleFor(60);
    press('Critical').click(); await settleFor(60);
    ok([...doc.querySelectorAll('#view .arow .apill')].filter((p) => p.textContent === 'warning').length === 0, 'alerts: Critical shows a warning');
    press('All').click(); await settleFor(60);
    const search = doc.getElementById('alerts-search');
    search.value = 'bravo'; search.dispatchEvent(new window.Event('input', { bubbles: true })); await settleFor(60);
    ok(doc.querySelectorAll('#view .arow').length === 1 && /bravo-ci/.test(doc.querySelector('#view .arow').textContent) && !doc.querySelector('#view .adown'),
      `alerts: searching "bravo" left ${[...doc.querySelectorAll('#view .arow')].map((r) => r.textContent.slice(0, 30)).join(' | ')}`);
    doc.getElementById('alerts-search').value = '';
    doc.getElementById('alerts-search').dispatchEvent(new window.Event('input', { bubbles: true })); await settleFor(60);

    // Acknowledge all on one cluster: its open alerts go, the rest stay, the footer says so.
    const head = [...doc.querySelectorAll('#view .agroup-head')].find((x) => x.querySelector('.agroup-name').textContent === 'atlas-prod');
    const ackAll = head && [...head.querySelectorAll('button')].find((b) => b.textContent === 'Acknowledge all');
    ok(!!ackAll, 'alerts: no Acknowledge all in the group header');
    ok(head && [...head.querySelectorAll('button')].some((b) => b.textContent === 'Silence ▾' && b.classList.contains('menu-trigger')), 'alerts: no "Silence ▾" with its duration menu');
    if (ackAll) {
      ackAll.click();
      await settleFor(200);
      ok(JSON.stringify(groupNames()) === JSON.stringify(['Unreachable · 1 cluster']) && doc.querySelectorAll('#view .arow.single').length === 1,
        `alerts: after Acknowledge all the groups are ${groupNames().join(', ')}`);
      ok(/acknowledged hidden/.test(doc.querySelector('#view .alerts-foot').textContent), `alerts: footer after ack reads "${doc.querySelector('#view .alerts-foot').textContent}"`);
      ok(st.openAlertsNow().every((m) => m.clusterId !== 'a'), 'alerts: the open counts still include the acknowledged cluster');
      ok(Number((doc.getElementById('alerts-sum-acked').textContent.match(/^\d+/) || [0])[0]) >= 3, `alerts: the acknowledged count reads "${doc.getElementById('alerts-sum-acked').textContent}"`);
      // Shown on request, with Re-open.
      doc.getElementById('alerts-handled').click(); await settleFor(80);
      ok(groupNames().includes('atlas-prod') && [...doc.querySelectorAll('#view .arow.handled')].length >= 3, 'alerts: Show acknowledged did not show them');
      ok([...doc.querySelectorAll('#view .arow.handled button')].some((b) => b.textContent === 'Re-open'), 'alerts: an acknowledged alert has no Re-open');
      // A node that joins an acknowledged disk alert opens it again.
      st.state.data.get('a').disk.nodes.push(node('es-hot-4', 87));
      st.invalidateAlerts(); await go('alerts');
      ok(/1 new since acknowledged/.test(doc.getElementById('view').textContent), 'alerts: a new node did not re-open the acknowledged disk alert');
      doc.getElementById('alerts-handled').click(); await settleFor(60);
      ok(st.openAlertsNow().some((m) => m.key === 'a:disk' || m.key === 'a:disk-balance'), 'alerts: the re-opened alert is not counted as open');
    }

    // The bell: one entry per cluster, with a way to the cluster's alerts.
    notify.resetAnnounced();
    notify.announceNewAlerts({ notify: () => {} });
    const d = st.state.data.get('q');
    d.health = { status: 'yellow', unassigned_shards: 2 };
    d.ilmErrorCount = 1; d.ilmErrors = { 'x-1': {} };
    st.invalidateAlerts();
    notify.announceNewAlerts();
    const bell = doc.querySelector('button.bell');
    ok(!!bell, 'alerts: the shell has no bell');
    if (bell) {
      bell.click(); await settleFor(80);
      const entries = [...doc.querySelectorAll('.notif')].filter((n) => /quiet-lab: \d+ new alert/.test(n.textContent));
      ok(entries.length === 1 && /quiet-lab: 2 new alerts/.test(entries[0].textContent), `alerts: the bell should have one quiet-lab entry, saw ${entries.length}: ${entries.map((e) => e.textContent).join(' / ')}`);
      const acts = entries[0] ? [...entries[0].querySelectorAll('.notif-actions a')].map((a) => a.textContent) : [];
      ok(acts[0] === 'Open quiet-lab alerts →' && /^Go to /.test(acts[1] || ''), `alerts: the bell entry links read ${JSON.stringify(acts)}`);
      navs.length = 0;
      if (entries[0]) { follow(entries[0].querySelector('.notif-actions a')); await settleFor(250); }
      ok(navs.some((n) => n.page === 'alerts'), `alerts: "Open quiet-lab alerts" did not go to Alerts: ${JSON.stringify(navs)}`);
      ok(JSON.stringify(groupNames()) === JSON.stringify(['quiet-lab']) && !doc.querySelector('#view .adown'), `alerts: the page was not filtered to quiet-lab, it shows ${groupNames().join(', ')}`);
      ok(/Showing quiet-lab only/.test(doc.getElementById('view').textContent), 'alerts: the cluster filter does not say it is on');
      const showAll = [...doc.querySelectorAll('#view button')].find((b) => b.textContent === 'Show all clusters');
      ok(!!showAll, 'alerts: no way back to every cluster');
      if (showAll) { showAll.click(); await settleFor(60); ok(groupNames().length >= 2 && !!doc.querySelector('#view .adown'), `alerts: Show all clusters did not show them (${groupNames().join(', ')})`); }
      // the next visit starts on the whole fleet again
      await go('overview'); await go('alerts');
      ok(groupNames().length >= 2 && !!doc.querySelector('#view .adown') && !/Showing quiet-lab only/.test(doc.getElementById('view').textContent), 'alerts: the cluster filter outlived the visit');
      st.state.selected = 'all';
    }
  } finally {
    window.removeEventListener('ep:navigate', onNav);
    Object.assign(st.state, saved);
    automation.clearAutomation();
    for (const k of ['a:disk', 'a:health', 'a:ilm', 'a:disk-balance', 'k:unreachable', 'b:slm-mode']) await acks.unacknowledge(k);
    Object.assign(idb, realIdb);
    st.invalidateAlerts();
  }
}

/* ------- the redraw gate holds against the core's 5 s `refreshed`, not only against `data` ------- */

// Every core push that carries changes ends in a `refreshed`. It used to apply whatever the
// gate was holding, so a change landed 1-2 s after it arrived — while keys were still being
// pressed. Only a refresh a person asked for may do that.
{
  const st = await load('core/state.js');
  const savedPolicy = st.state.defaults.liveRedraw;
  st.state.defaults.liveRedraw = 'pending';
  await go('overview');
  await settleFor(400);
  const view = doc.getElementById('view');
  const id = st.activeClusters()[0].id;      // a cluster the page is showing
  let marks = 0;
  const mo = new window.MutationObserver((ms) => { marks += ms.length; });
  mo.observe(view, { childList: true, subtree: true, characterData: true, attributes: true });
  const type = () => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  // Something visibly different, so that a redraw cannot hide behind an unchanged DOM.
  const land = (nodes) => {
    const d = st.state.data.get(id);
    st.state.data.set(id, { ...d, health: { ...d.health, number_of_nodes: nodes } });
    st.bus.emit('data', { id });
  };
  const seen = () => view.textContent.includes('777') || view.textContent.includes('888');
  try {
    // 1. A push-driven refreshed, with keys pressed throughout: nothing draws until 3 s of quiet.
    type(); await settleFor(100);
    marks = 0; land(777);
    for (let i = 0; i < 10; i++) {
      type();
      if (i === 2) st.bus.emit('refreshed', { byPerson: false });   // what announceRefreshed emits
      await settleFor(400);
    }
    ok(marks === 0 && !seen(), `gate: a push-driven refreshed redrew the page while keys were still being pressed (${marks} mutations)`);
    await settleFor(3400);
    ok(seen(), 'gate: the held change never drew after the page had gone quiet for 3 s');

    // 2. A person's Refresh applies at once, however recently they touched the page.
    type(); await settleFor(50);
    land(888);
    st.bus.emit('refreshed', { byPerson: false });
    await settleFor(200);
    ok(!view.textContent.includes('888'), 'gate: a held change drew without anyone asking or waiting');
    st.bus.emit('refreshed', { byPerson: true });
    await settleFor(250);
    ok(view.textContent.includes('888'), 'gate: a person\'s Refresh did not apply the held change at once');
  } finally {
    mo.disconnect();
    st.state.defaults.liveRedraw = savedPolicy;
    await settleFor(3400);
  }
}

// Client basis fetches nothing on its own, so a page that shows a cluster has to ask: opening
// the Clusters page and the Alerts page asks the core (one REFRESH per dataset) for what they
// show, and a cluster whose health was never read is "not read yet" on Nodes & shards, never
// "unreachable".
if (viaFleet) {
  const st = await load('core/state.js');
  const es = await load('core/es.js');
  const pol = await es.policyGet();
  if (pol && pol.ok && (pol.resolvedMode || pol.policy.mode) === 'on-demand') {
    ok(st.fetchesOnlyOnAsk(), 'on-demand: the app does not know the core fetches nothing on its own');
    const refreshed = new Set(sent.filter((m) => m.type === 'REFRESH').flatMap((m) => m.datasets || []));
    for (const ds of ['health', 'nodes', 'ilm_errors', 'policies', 'snapshots']) {
      ok(refreshed.has(ds), `on-demand: opening the Clusters and Alerts pages never asked the core for "${ds}"`);
    }
    // Asked again once the 30 s gap has passed, for the clusters that need it.
    ok(sent.filter((m) => m.type === 'REFRESH' && (m.clusterIds || []).length >= config.clusters.length).length > 0,
      'on-demand: no REFRESH named every cluster — a page asks for the whole fleet in one message');
    const c0 = config.clusters[0];
    const d0 = st.state.data.get(c0.id);
    const was = d0 && { healthUnknown: d0.healthUnknown, reachable: d0.reachable, updatedAt: d0.updatedAt };
    if (d0) {
      Object.assign(d0, { healthUnknown: true, reachable: false, updatedAt: 0 });
      await go('shards');
      const body = doc.getElementById('view').textContent;
      ok(/not read yet/.test(body), `shards: a cluster never read says "${body.slice(0, 120)}", not that it was not read yet`);
      ok(!/No response from the cluster|— unreachable/.test(body), 'shards: a cluster whose health was never read is called unreachable');
      Object.assign(d0, was);
    }
  }
}

/* ------- the evidence layout: Snapshots, REST console and Indices show one cluster and nothing else ------- */

// One client is one cluster, and these three pages are screenshotted for that client. With 24
// clusters, four of them down, nothing about the other 23 may be on screen: no fleet chips, no
// alert count, no bell, no picker listing them, no toast naming one, no history from one. And
// the page must say what it shows: the cluster, when its data was read, when it was captured.
{
  const st = await load('core/state.js');
  const menu = await load('ui/menu.js');
  const { idb } = await load('lib/idb.js');
  const realAllQueries = idb.allQueries;
  const reachableUrl = config.clusters[0].url;
  const pad2 = (n) => String(n).padStart(2, '0');
  const fleet24 = {
    version: 2,
    credentials: { username: 'elastic', password: 'not-a-real-password' },
    defaults: { readOnly: true, autoRefresh: false, logIndexPattern: 'logstash-*' },
    clusters: Array.from({ length: 24 }, (_, i) => ({
      name: `evc-${pad2(i + 1)}-fleetname`,
      url: i < 20 ? reachableUrl : 'http://127.0.0.1:9',      // nothing listens on 9: connection refused
      tags: ['prod'],
    })),
  };
  await applyConfig({ load, configPath, raw: fleet24 });
  const all = st.clusters();
  ok(all.length === 24, `evidence: expected 24 clusters in the fixture, saw ${all.length}`);
  const down = all.filter((c) => st.healthState(st.state.data.get(c.id)) === 'unreachable');
  ok(down.length >= 1, `evidence: the fixture has no unreachable cluster (${down.length}) - it would prove nothing about them`);
  const byName = (n) => all.find((c) => c.name.startsWith(n));
  const main = byName('evc-03');
  const other = byName('evc-09');
  const dead = down[0];

  const text = () => doc.body.textContent;
  const barText = () => (doc.getElementById('topbar') || { textContent: '' }).textContent;
  const noOthers = (where, mine) => {
    for (const c of all) if (c.id !== mine.id && text().includes(c.name)) problems.push(`evidence ${where}: the page names another cluster, ${c.name}`);
  };
  const noFleetChrome = (where) => {
    const bar = doc.getElementById('topbar');
    ok(!/\d+\s+(green|yellow|red|unreachable|loading)\b/.test(bar.textContent), `evidence ${where}: a fleet status chip is in the top bar: "${bar.textContent}"`);
    ok(![...bar.querySelectorAll('button')].some((b) => /^\d+ alerts?$/.test(b.textContent.trim())), `evidence ${where}: the alerts chip is in the top bar`);
    ok(!bar.querySelector('.bell'), `evidence ${where}: the bell is in the top bar`);
    ok(!bar.querySelector('#cluster-select, #cluster-finder'), `evidence ${where}: a cluster picker or finder is in the top bar`);
    ok(!/updated|live|quiet|manual/.test(bar.textContent.replace(/Refresh/g, '')), `evidence ${where}: a fleet freshness claim is in the top bar: "${bar.textContent}"`);
    ok(!doc.querySelector('#nav button[data-page="alerts"] .pill'), `evidence ${where}: the Alerts tab carries a count`);
    ok(doc.getElementById('side-foot').hidden === true, `evidence ${where}: the Config/Clusters/Health/Requests strip is showing`);
    ok(!doc.querySelector('.banner.coverage'), `evidence ${where}: the "Showing cached data for N clusters" banner is showing`);
    ok(!/Showing cached data for \d+ clusters|oldest .* unreachable/.test(text()), `evidence ${where}: fleet coverage wording is on the page`);
    // The stamp (cluster, data time, capture time, version, user) and its stale banner went in
    // 0.3.39 at the user's request; nothing may bring them back.
    ok(!doc.getElementById('evidence-foot') && !doc.getElementById('evidence-note'), `evidence ${where}: the evidence stamp or its banner is drawn`);
    ok(!/Refresh before capturing|before this capture|Captured \d{2}:\d{2}/.test(text()), `evidence ${where}: stamp wording is on the page`);
  };

  // Control: the same fleet on Clusters has all of it, so the checks below can fail.
  st.state.selected = 'all';
  await go('overview'); await settleFor(300);
  {
    const bar = doc.getElementById('topbar').textContent;
    ok(/\d+\s+(green|yellow|red|unreachable)/.test(bar), `evidence control: Clusters has no fleet chip, so the absence checks prove nothing: "${bar}"`);
    ok(!!doc.querySelector('#topbar .bell'), 'evidence control: Clusters has no bell');
    ok(!!doc.getElementById('cluster-select'), 'evidence control: Clusters has no picker');
    // The Clusters page keeps the strip off by design (2026-10-25); Alerts is where it shows.
    ok(doc.getElementById('side-foot').hidden === true, 'evidence control: the status strip is back on the Clusters page');
    await go('alerts'); ok(doc.getElementById('side-foot').hidden === false, 'evidence control: Alerts has no status strip'); await go('overview');
  }

  // Snapshots with "All clusters": asks for one, and shows no fleet while it asks.
  await go('snapshots'); await settleFor(300);
  {
    const pick = doc.getElementById('evidence-pick');
    ok(!!pick, 'evidence snapshots: with "All clusters" the page does not ask for one cluster');
    ok(/Evidence needs one cluster/.test(text()), 'evidence snapshots: no explanation that evidence needs one cluster');
    ok(!doc.querySelector('#view section.lazy-block, #view .seg'), 'evidence snapshots: a fleet of snapshot lists is drawn under the question');
    noFleetChrome('snapshots (choosing)');
    if (pick) { pick.value = main.id; pick.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(500); }
  }

  for (const [id, label] of [['snapshots', 'Snapshots'], ['console', 'REST console'], ['indices', 'Indices']]) {
    if (id === 'console') {
      // The harness's in-memory IndexedDB never completes a transaction, so the history is handed
      // to the page the way the real store would. A request recorded against another cluster
      // must not be listed, let alone offered to Run here.
      idb.allQueries = async () => [
        { id: 'evd-other', ts: Date.now() - 5000, cluster: other.name, clusterId: other.id, method: 'GET',
          path: '/_cat/evd-foreign-path', body: '', status: 200, ok: true, tookMs: 3, fav: 0 },
        { id: 'evd-mine', ts: Date.now() - 4000, cluster: main.name, clusterId: main.id, method: 'GET',
          path: '/_cat/evd-own-path', body: '', status: 200, ok: true, tookMs: 3, fav: 0 }];
    }
    await go(id); await settleFor(id === 'snapshots' ? 900 : 500);
    ok(st.state.selected === main.id, `evidence ${id}: selected ${st.state.selected}, expected the chosen cluster`);
    ok(doc.querySelector('#topbar h1').textContent === label, `evidence ${id}: the top bar does not carry the page title`);
    const chip = doc.querySelector('#topbar .pill');
    ok(chip && chip.textContent.includes(main.name), `evidence ${id}: the top bar does not name this cluster with its health: "${chip && chip.textContent}"`);
    ok([...doc.querySelectorAll('#topbar button')].some((b) => /Refresh/.test(b.textContent)), `evidence ${id}: no Refresh in the top bar`);
    noFleetChrome(id);
    if (id === 'snapshots') {
      // Where the backups are kept (a bucket, an NFS path) is not evidence and must not be in
      // it (user decision, 0.3.23): no Location column and no repository path, in either view.
      // The mock's "daily" repository is an fs repository at /mnt/backups.
      for (const label of ['Snapshot Summary', 'Snapshots']) {
        const b = [...doc.querySelectorAll('#view .seg button')].find((x) => x.textContent.trim() === label);
        if (b) { b.click(); await settleFor(300); }
        ok(![...doc.querySelectorAll('#view th')].some((th) => /^Location/.test(th.textContent.trim())), `evidence snapshots (${label}): a Location column is shown`);
        ok(!text().includes('/mnt/backups'), `evidence snapshots (${label}): the repository path /mnt/backups is on the page`);
      }
    }
    if (id === 'console') {
      const t = text();
      ok(!t.includes('evd-foreign-path'), 'evidence console: the history lists a request recorded on another cluster');
      ok(t.includes('evd-own-path'), 'evidence console: this cluster\'s own history is missing');
      ok(![...doc.querySelectorAll('#c-history th')].some((th) => th.textContent === 'Cluster'), 'evidence console: the history still has a Cluster column');
      doc.getElementById('c-path').value = '/_cluster/health';
      doc.getElementById('c-path').dispatchEvent(new window.Event('input', { bubbles: true }));
      doc.getElementById('c-run').click();
      await settleFor(800);
    }
    noOthers(id, main);
    // Nowhere on the page: no http(s) address at all (the console's response body, which the person
    // asked for, is the one exception and is checked separately), and not the cluster's host:port.
    {
      const own = new URL(main.url).host;
      const t = doc.getElementById('view').textContent + doc.getElementById('topbar').textContent;
      const body = doc.getElementById('c-out');
      const shown = body ? t.replace(body.textContent, '') : t;
      ok(!/https?:\/\/\S/.test(shown), `evidence ${id}: the page prints an address: "${(shown.match(/https?:\/\/\S+/) || [''])[0]}"`);
      ok(!shown.includes(own), `evidence ${id}: the page prints the cluster's host ${own}`);
    }
  }

  // What the app says by itself, while an evidence page is open: held, not shown, not lost.
  {
    await go('overview'); await settleFor(200);
    // A snapshot running on another cluster, seen once so that its finishing is news.
    const setSnap = (status) => {
      const d = st.state.data.get(other.id);
      st.state.data.set(other.id, { ...d, snapshots: { 'evd-repo': [{ id: 'evd-snap', status }] } });
    };
    setSnap('IN_PROGRESS');
    st.bus.emit('refreshed', { byPerson: false });
    await settleFor(100);
    await go('indices'); await settleFor(300);
    const before = menu.notifications().length;
    setSnap('SUCCESS');                                      // …and it finishes while an evidence page is open
    st.bus.emit('data', { id: other.id });
    st.bus.emit('refreshed', { byPerson: false });
    await settleFor(400);
    ok(!doc.querySelector('.toast-wrap') || !doc.querySelector('.toast-wrap').textContent.includes(other.name),
      `evidence indices: an alert toast about another cluster is on screen: "${(doc.querySelector('.toast-wrap') || {}).textContent}"`);
    ok(menu.notifications().length === before, 'evidence indices: the notice went to the bell while the page was open');
    noOthers('indices after an alert elsewhere', main);
    await go('overview'); await settleFor(300);
    const held = [...doc.querySelectorAll('.toast-wrap .toast')].map((t) => t.textContent).join(' | ');
    ok(/Held \d+ notices? while on an evidence page/.test(held), `evidence: leaving did not say what was held: "${held}"`);
    ok(menu.notifications().some((n) => n.message.includes(other.name)), 'evidence: the held alert never reached the bell - it was dropped');
    // …and everything fleet-wide is back at once (on the fleet view, which is the person's to pick).
    { const sel = doc.getElementById('cluster-select'); ok(!!sel, 'evidence: the picker did not come back on Clusters');
      if (sel) { sel.value = 'all'; sel.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(400); } }
    const bar = doc.getElementById('topbar').textContent;
    ok(/\d+\s+(green|yellow|red|unreachable)/.test(bar), `evidence: the fleet chip did not come back on Clusters: "${bar}"`);
    ok(!!doc.querySelector('#topbar .bell'), 'evidence: the bell did not come back on Clusters');
    ok(!!doc.getElementById('cluster-select'), 'evidence: the picker did not come back on Clusters');
    // The top bar has no alerts chip any more (the board of 2026-10-25): the Alerts tab carries the count.
    ok(![...doc.querySelectorAll('#topbar button')].some((b) => /^\d+ alerts?$/.test(b.textContent.trim())), 'evidence: an alerts chip is back in the top bar');
    ok(doc.getElementById('side-foot').hidden === true, 'evidence: the status strip is back on the Clusters page');
    ok(!!doc.querySelector('#nav button[data-page="alerts"] .pill'), 'evidence: the Alerts tab count did not come back');
  }

  // A cluster that cannot be reached: still one cluster on the page, nobody else named.
  {
    st.state.selected = dead.id;
    await go('indices'); await settleFor(500);
    noFleetChrome('indices (unreachable cluster)');
    noOthers('unreachable', dead);
    await go('overview');
  }
  idb.allQueries = realAllQueries;
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('ok: strip, console, shards, the Clusters page (columns, name menu, unreachable rows, expand chevron, alerts link), volume, hand-off, refresh, snapshots, tasks, toasts, accounts split and pinned Zabbix roles, the log-delay preflight, a quiet Config page, the Request Centre and the redraw gate, the request policy, the coverage bar, the Tasks panel and the console tabs, template management, the Alerts page grouped by cluster with merged repeats, Go to, playbooks and the bell');
// The pages leave auto-refresh timers and a live tail running; nothing here waits on them.
process.exit(0);
