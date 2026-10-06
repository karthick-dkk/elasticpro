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

/* ------------- the status strip stays off the pages people work in ------------- */

const STRIP_HIDDEN = ['indices', 'console', 'logs', 'snapshots', 'shards', 'volume'];
const STRIP_SHOWN = ['overview', 'alerts'];

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
  const base = config.clusters[0].url.replace(/\/+$/, '');
  ok(target && target.textContent.startsWith(base),
    `console: the address line reads "${target && target.textContent}", expected to start with ${base}`);

  const pathInput = doc.getElementById('c-path');
  ok(!!pathInput, 'console: no path input');
  if (pathInput && target) {
    for (const [typed, want] of [['/_cat/indices', `${base}/_cat/indices`],
                                 ['_cluster/health', `${base}/_cluster/health`]]) {
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

/* ---------------------------- alerts show their shape ---------------------------- */

await go('alerts');
{
  const titles = [...doc.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.includes('Alert statistics'), `alerts: no statistics card, saw ${titles.join(' | ')}`);
  // Two gauges, drawn as arcs rather than written as numbers.
  const paths = doc.querySelectorAll('section.card svg path').length;
  ok(paths >= 2, `alerts: expected gauge arcs, found ${paths} path(s)`);
  ok(/clusters alerting/.test(doc.body.textContent), 'alerts: the fleet gauge is unlabelled');
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

await go('snapshots');
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
  await go('snapshots');
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
      ok(m.querySelector('.ev-cluster') && config.clusters.some((c) => c.name === m.querySelector('.ev-cluster').textContent),
        `snapshots: evidence should lead with the cluster name, shows "${m.querySelector('.ev-cluster') && m.querySelector('.ev-cluster').textContent}"`);
      const rows = [...m.querySelectorAll('.ev-table tbody tr')];
      ok(rows.length === 4, `snapshots: the newest mock snapshot holds 4 indices, evidence lists ${rows.length}`);
      ok(rows.every((r) => /2026-09-0\d/.test(r.textContent)), 'snapshots: every mock logstash index should show its data date');
      ok(!/no dated indices/.test(m.textContent), 'snapshots: evidence says "no dated indices" for dated indices');
      ok(/covers 2026-09-07 → 2026-09-09 \(3 days, 0 missing days\)/.test(m.textContent),
        `snapshots: the evidence cover line is wrong: ${(m.querySelector('.ev-head') || {}).textContent}`);
      ok(/Evidence generated/.test(m.textContent), 'snapshots: evidence does not say when it was generated');
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
        return { ok: true, json: async () => ({ ok: true, ...stub, config: body.config }) };
      }
      return { ok: true, json: async () => ({ ok: true, ...stub }) };
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

    // The row expander is a button people can find, and it says which way it goes.
    const expand = [...firstRow.querySelectorAll('button')].find((b) => /Details/.test(b.textContent));
    ok(!!expand, 'overview: no Details button on a summary row');
    if (expand) {
      ok(expand.getAttribute('aria-expanded') === 'false', 'overview: a collapsed row should say so');
      ok(!expand.className.includes('ghost'),
        'overview: the row expander should look like a button, not a label');
      const before = summary.querySelectorAll('tbody tr').length;
      expand.click();
      await settleFor(300);
      const after = [...doc.querySelectorAll('section.card')]
        .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Cluster summary');
      ok(after.querySelectorAll('tbody tr').length > before,
        'overview: pressing Details did not open the detail row');
      const now = [...after.querySelector('tbody tr').querySelectorAll('button')]
        .find((b) => /Hide details/.test(b.textContent));
      ok(!!now, 'overview: an open row should offer to close');
      ok(now && now.getAttribute('aria-expanded') === 'true', 'overview: an open row should say it is open');
      now.click();
      await settleFor(250);
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
  await go('snapshots');
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

  // The evidence view on one of them: every index dated, the span and gaps stated.
  const opener = list() && [...list().querySelectorAll('button')].find((b) => /audit evidence/.test(b.title || ''));
  if (opener) {
    opener.click(); await settleFor(150);
    const m = doc.querySelector('.modal.evidence');
    ok(!!m, 'evidence: did not open');
    if (m) {
      ok(!/no dated indices/.test(m.textContent), 'evidence: says "no dated indices" for logstash-2026.09.23 … .29');
      ok(/covers 2026-09-23 → 2026-09-29 \(7 days, 0 missing days\)/.test(m.textContent),
        `evidence: wrong cover line — ${(m.querySelector('.ev-head') || {}).textContent}`);
      const dates = [...m.querySelectorAll('.ev-table tbody tr')].map((tr) => tr.children[2].textContent);
      ok(dates.join(',') === '2026-09-23,2026-09-24,2026-09-25,2026-09-26,2026-09-27,2026-09-28,2026-09-29',
        `evidence: data dates should run 23 → 29 in order, got ${dates.join(',')}`);
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
  const spy = (msg, kind) => said.push({ msg, kind });

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
  ok(said.length === 1 && /daily/.test(said[0].msg), `announcement text: ${JSON.stringify(said)}`);

  said.length = 0;
  notify.announceNewAlerts({ notify: spy });
  ok(said.length === 0, 'the same alert must not be announced on the next refresh');

  // Many at once collapse to one line rather than burying the screen.
  d.repos = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: n, error: 'gone' }));
  d.snapshots = {};
  said.length = 0;
  notify.announceNewAlerts({ notify: spy });
  ok(said.length === 1 && /5 new alerts/.test(said[0].msg),
    `five at once should collapse to one summary, got ${JSON.stringify(said)}`);
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
  ok(!!moved && moved.level === 'critical', `a master election should be critical: ${keys().join(', ')}`);
  ok(moved && /from n1 to n2/.test(moved.title), `the alert should name both: ${moved && moved.title}`);

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
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('ok: strip, console, shards, volume, hand-off, refresh, snapshots, tasks, toasts, accounts split and the log-delay preflight');
// The pages leave auto-refresh timers and a live tail running; nothing here waits on them.
process.exit(0);
