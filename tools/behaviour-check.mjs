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
/** What transport.js reads off a reply: status, headers, and the body as text. jsdom has no Response. */
const stubReply = (obj) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });

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

async function go(id) {
  // A case that moves on is done with what it typed: Config-Management would ask before leaving
  // with unsaved changes (that question has its own case, through the page menu), so drop them.
  const bar = doc.getElementById('cm-savebar');
  const discard = bar && !bar.hidden && bar.querySelector('button[data-act="discard"]');
  if (discard) { discard.click(); await settleFor(150); }
  app.go(id); await settleFor(350);
}
/** A link pressed as a person would: the harness's anchor click() only captures downloads. */
const press = (a) => a && a.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

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

// An evidence page (core/evidence.js) picks one cluster itself when the fleet is selected
// (the last one chosen, else the first), so this is just go(). backToFleet() puts "All" back.
async function goOne(id) {
  await go(id);
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

const STRIP_HIDDEN = ['overview', 'indices', 'console', 'logs', 'snapshots', 'shards', 'reports'];
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
  // Typing into the Index filter keeps the field and the keyboard: the first key used to rebuild
  // the card around it, and with no id to put focus back by, the rest of the typing went to the
  // page (0.3.54 flicker pass).
  if (idxFilter) {
    idxFilter.focus();
    for (const v of ['m', 'mo', 'moc']) {
      idxFilter.value = v;
      idxFilter.dispatchEvent(new window.Event('input', { bubbles: true }));
      await settleFor(120);
    }
    const now = [...doc.querySelectorAll('input[type=search]')].find((x) => x.placeholder === 'filter by name');
    ok(now === idxFilter && idxFilter.isConnected, 'shards: typing into the Index filter replaced the field');
    ok(doc.activeElement === idxFilter, `shards: typing into the Index filter lost the keyboard to ${doc.activeElement && (doc.activeElement.id || doc.activeElement.tagName)}`);
    idxFilter.value = '';
    idxFilter.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(250);
    idxFilter.blur();
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
// ILM / SLM are buttons (as in 0.3.2); a red dot, never a count, says a log index / policy is failing.
{
  const btns = [...doc.querySelectorAll('table.cl-tbl button.cl-pillbtn')];
  ok(btns.length > 0, 'overview: the ILM/SLM cells have no buttons');
  const bad = btns.filter((b) => b.parentElement.querySelector('.cl-errdot'));
  ok(bad.length > 0, 'overview: the mock has a logstash-* index in an ILM error step, so a red dot should show');
  for (const b of bad) ok(!/\d/.test(b.parentElement.textContent), `overview: the ILM/SLM cell shows a count: "${b.parentElement.textContent}"`);
  const b0 = btns[0];
  if (b0) {
    const rowEl = b0.closest('tr.cl-row');
    const was = rowEl && rowEl.classList.contains('open');
    b0.click(); await settleFor(150);
    const after = doc.querySelector(`tr.cl-row[data-cluster="${rowEl && rowEl.getAttribute('data-cluster')}"]`);
    ok(!!after && after.classList.contains('open'), `overview: the ${b0.textContent} button did not open the cluster's details (was open: ${was})`);
    // Put it back, so the checks below start from the collapsed row they expect.
    const chev = after && after.querySelector('button.cl-chev');
    if (!was && chev) { chev.click(); await settleFor(150); }
  }
}

/* ------------- the expanded row: boxes, four cards, nodes; the health list opens on hover ------------- */
// Owner-approved board of 2026-11-05. The mock cluster is yellow (one index with an unassigned replica).
{
  await go('overview');
  const rowEl = doc.querySelector('tr.cl-row');
  const chev = rowEl && rowEl.querySelector('button.cl-chev');
  if (chev && !rowEl.classList.contains('open')) { chev.click(); await settleFor(250); }
  const det = await waitFor(() => doc.querySelector('.cl-detail'), 'overview: the expanded row');
  if (det) {
    const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();
    const strip = det.querySelector('.cl-strip');
    const labels = strip ? [...strip.querySelectorAll('.cl-box-k')].map(txt) : [];
    ok(JSON.stringify(labels) === JSON.stringify(['Cluster health', 'Endpoint', 'Jump host', 'Log bucket (S3)']), `expanded row: the strip's boxes are ${labels.join(' | ')}`);
    // 2026-11-07: the Report button left the strip; each box is its label and value on one line.
    ok(!!strip && !strip.querySelector('a.cl-report') && ![...strip.querySelectorAll('a, button')].some((a) => /^Report/.test(txt(a))), 'expanded row: the Report button is back in the strip');
    ok(!!strip && [...strip.querySelectorAll('.cl-box')].every((b) => b.firstElementChild && b.firstElementChild.classList.contains('cl-box-k') && b.children.length === 2), 'expanded row: a strip box is not "label value"');
    ok(/None \(direct\)/.test(txt(strip || det)), 'expanded row: a directly reached cluster does not say "None (direct)" as its Jump host');
    const cards = [...det.querySelectorAll('.cl-card')].map((c) => c.getAttribute('data-tile'));
    ok(JSON.stringify(cards) === JSON.stringify(['shards', 'ilm', 'slm', 'activity']), `expanded row: the cards are ${cards.join(', ')}`);
    ok(!det.querySelector('.cl-tile'), 'expanded row: the old tiles are still drawn');
    ok([...det.querySelectorAll('.cl-card svg.cl-donut')].length === 2, 'expanded row: the Shard allocation and ILM cards are not donuts');
    const shardHead = det.querySelector('.cl-card[data-tile="shards"] .cl-dhead');
    ok(!!shardHead && /\d+(\.\d)?%\s*active/.test(txt(shardHead)), `expanded row: the shard headline is "${shardHead && txt(shardHead)}", not "NN.N% active" beside the ring`);
    const bk = det.querySelector('.cl-card[data-tile="slm"]');
    ok(!!bk && !!bk.querySelector('a.cl-card-t') && /Backups \(SLM\)/.test(txt(bk)), 'expanded row: the Backups (SLM) title is not a link');
    const quick = [...det.querySelectorAll('.cl-strip a, .cl-cards a')].map(txt).filter((t) => /^(Indices|Snapshots|REST console|Nodes) ›$/.test(t));
    ok(quick.length === 0, `expanded row: quick links are back: ${quick.join(', ')}`);
    // The red/yellow list is a hover popover, fetched only when opened.
    const hp = det.querySelector('.cl-hp');
    const btn = hp && hp.querySelector('button.cl-hp-btn');
    ok(!!btn && /yellow/i.test(btn.textContent), `expanded row: a yellow cluster has no "yellow indices" button (${btn && btn.textContent})`);
    ok(!!hp && !hp.querySelector('table.cl-hp-tbl'), 'expanded row: the indices list was fetched before it was opened');
    if (hp) {
      hp.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }));
      // The list is painted three times as its answers land (indices, then shards + explanation),
      // each time as a new table in the popover, and the page may redraw the whole row on a push.
      // So never hold the table found first: look it up again each time, and wait for the final
      // state (no "…" placeholder left in it), not for the first draw.
      const liveTbl = () => {
        const pop = doc.querySelector('.cl-detail .cl-hp .cl-hp-pop') || hp.querySelector('.cl-hp-pop');
        return pop && pop.querySelector('table.cl-hp-tbl');
      };
      const settled = () => {
        const t = liveTbl();
        const loading = t && [...t.querySelectorAll('.muted')].some((m) => m.textContent.trim() === '…');
        return t && !loading && /replica/.test(txt(t)) ? t : null;
      };
      const first = await waitFor(liveTbl, 'expanded row: the yellow indices list after hover');
      const tbl = first && await waitFor(settled, 'expanded row: the unassigned replica and its reason in the list', 10000);
      if (tbl) {
        const heads = [...tbl.querySelectorAll('th')].map(txt);
        ok(JSON.stringify(heads) === JSON.stringify(['Index', 'Health', 'Primaries', 'Replicas', 'Unassigned', 'Reason']), `expanded row: the list's columns are ${heads.join(' | ')}`);
        const rows = [...tbl.querySelectorAll(':scope > tbody > tr')];
        ok(rows.length >= 1 && rows.every((tr) => /Yellow/i.test(txt(tr.children[1]))), 'expanded row: the yellow list holds a non-yellow index');
        ok(/watermark|node left/i.test(txt(tbl)), `expanded row: the list gives no reason: ${txt(tbl)}`);
      }
      ok(!!hp.querySelector('.cl-hp-head a'), 'expanded row: the list has no "Open in Indices, health" link');
    }
    // Nodes: Version before IP, no Tier, Free size after Disk, data rows tinted.
    const heads = [...det.querySelectorAll('[data-section="nodes"] thead th')].map(txt);
    ok(heads.indexOf('Version') > -1 && heads.indexOf('Version') < heads.indexOf('IP'), `expanded row: Version is not before IP: ${heads.join(' | ')}`);
    ok(!heads.includes('Tier'), 'expanded row: the Tier column is back');
    ok(heads.indexOf('Free size') === heads.indexOf('Disk') + 1, `expanded row: Free size does not follow Disk: ${heads.join(' | ')}`);
    ok(det.querySelectorAll('[data-section="nodes"] tbody tr.cl-data').length > 0, 'expanded row: no data node row is tinted');
    // 2026-11-07: no "Data node" legend, and a data node shows one plain "data" chip (tiers in its tooltip).
    ok(!/Data node/.test(txt(det.querySelector('[data-section="nodes"] .cl-sec-h') || det)) && !det.querySelector('.cl-key'), 'expanded row: the "Data node" key is back in the Nodes header');
    const chips = [...det.querySelectorAll('[data-section="nodes"] .cl-role')].map(txt);
    ok(chips.includes('data') && !chips.some((t) => /^data[:_]|hot·|·warm/.test(t)), `expanded row: the Roles column lists data tiers: ${chips.join(', ')}`);
    const nodeLinks = [...det.querySelectorAll('[data-section="nodes"] .cl-sec-h a')].map(txt);
    ok(JSON.stringify(nodeLinks) === JSON.stringify(['Nodes & shards ›']), `expanded row: the Nodes header links are ${nodeLinks.join(', ')}`);
    ok(/Data covered/.test(txt(det.querySelector('[data-section="repo"]') || det)), 'expanded row: the repositories table has no "Data covered" column');
  }
  // The summary line: disk % large with the index size, a 40 px bar with used / total.
  const sizeCell = doc.querySelector('tr.cl-row.open td .cl-size-pct');
  ok(!!sizeCell && /^\d+ %$/.test(sizeCell.textContent.trim()), 'summary: the Size cell does not lead with the disk used %');
  ok(!!doc.querySelector('tr.cl-row td .cl-dbar') && /\//.test((doc.querySelector('tr.cl-row td .cl-dtext') || {}).textContent || ''), 'summary: the Disk usage cell is not a bar with "used / total"');
  // Put it back, so the checks below start from the collapsed row they expect.
  const open = doc.querySelector('tr.cl-row.open button.cl-chev');
  if (open) { open.click(); await settleFor(150); }
}

// A hint from the Clusters row ("Open in Indices, health: yellow") starts from an unfiltered list:
// a search left from an earlier visit must not be intersected with it.
{
  await go('indices');
  const box = doc.getElementById('idx-search');
  if (box) { box.value = 'zzz-nothing-matches'; box.dispatchEvent(new window.Event('input', { bubbles: true })); await settleFor(150); }
  (await load('core/focus.js')).setFocus('indices', { health: 'yellow' });
  await go('indices');
  const b2 = doc.getElementById('idx-search');
  ok(!!b2 && b2.value === '', `indices: a health hint kept the earlier search "${b2 && b2.value}"`);
  await waitFor(() => /logstash-beta-2026\.09\.09/.test((doc.getElementById('view') || {}).textContent || ''), 'indices: the yellow index after the health hint');
  const clear = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Clear');
  if (clear) { clear.click(); await settleFor(150); }
}

await go('indices');
// The Indices page is for managing indices. Its Summary tab moved to Reports › Daily &
// monthly in 0.3.53 (docs/REPORTS.md, board 7); what must be on THIS page is the table, the
// controls that act on it, and one line saying where the summary went.
{
  const txt = doc.body.textContent;
  const btn = (label) => [...doc.querySelectorAll('button')].some((b) => b.textContent.trim() === label);
  ok(/Indices on /.test(txt), 'indices: the index table card is missing');
  ok(btn('Live') && btn('Snapshot') && btn('Live + Snapshot'),
    'indices: the three search scopes (Live, Snapshot, Live + Snapshot) are not all present');
  ok(btn('‹ Previous') && btn('Next ›'), 'indices: the table is not paged');
  const tabs = [...doc.querySelectorAll('.ix-views .seg .btn')].map((b) => b.textContent.trim());
  ok(JSON.stringify(tabs) === JSON.stringify(['Indices', 'Templates']), `indices: the view tabs are ${tabs.join(' | ')}, want Indices | Templates`);
  ok(!btn('Summary'), 'indices: the Summary tab is still there');
  ok(!doc.querySelector('.vs'), 'indices: the daily record is still drawn on the Indices page');
  ok(/Daily and monthly summary is now in Reports › Daily & monthly ›/.test(txt), 'indices: no line saying where the summary went');
  const link = doc.getElementById('ix-to-reports');
  ok(!!link, 'indices: the line has no link to Reports › Daily & monthly');
  if (link) {
    press(link);
    await settleFor(400);
    ok(app.currentPage ? app.currentPage() === 'reports' : true, 'indices: the link did not open Reports');
    ok((doc.location.hash || '') === '#/reports/daily', `indices: the link went to ${doc.location.hash}`);
    const on = doc.querySelector('.rp-nav a[aria-current="page"]');
    ok(on && on.dataset.section === 'daily', 'indices: the link did not open the Daily & monthly section');
  }
}

/* --------------------- Reports › Daily & monthly against the real core --------------------- */

await go('reports');
{
  const segBtn = (label) => [...doc.querySelectorAll('.vs .seg .btn')].find((b) => b.textContent.trim() === label);
  const navTo = async (id) => { const a = doc.querySelector(`.rp-nav a[data-section="${id}"]`); if (a) { press(a); await settleFor(250); } return !!a; };
  ok(await navTo('daily'), 'reports: no Daily & monthly in the section nav');
  ok(!!segBtn('Daily') && !!segBtn('Monthly'), 'reports daily: no Daily | Monthly switch');
  ok(segBtn('Daily') && segBtn('Daily').getAttribute('aria-pressed') === 'true', 'reports daily: should open on Daily');
  // Either the record or the plain "needs 0.3.45" state — never a crash, never zeros.
  const settled = await waitFor(() => doc.querySelector('.vs table.coltbl') || (/does not keep a daily volume record/.test(doc.body.textContent) ? doc.body : null),
    'reports daily: shows neither the daily record nor the "needs 0.3.45" state', 60000);
  const coreHasVolume = !!(settled && doc.querySelector('.vs table.coltbl'));
  if (!coreHasVolume) {
    ok(/needs ElasticPro 0\.3\.45/.test(doc.body.textContent), 'reports daily: the "needs 0.3.45" state does not name the version');
    ok(!doc.querySelector('.vs-cards'), 'reports daily: an older core still drew volume cards (they could only be zeros)');
  } else {
    // On the portable bridge opening the section asks for a run (the record is empty), so
    // wait for it to finish: the progress line goes and the rows are there.
    await waitFor(() => !doc.querySelector('.vs-progress') && doc.querySelectorAll('.vs table.coltbl tbody tr').length >= 30 ? doc.body : null,
      'reports daily: the daily record did not fill in after the run (30 days)', 120000);
    const heads = [...doc.querySelectorAll('.vs table.coltbl thead th')].map((x) => (x.querySelector('.colhead-name') || x).textContent.trim());
    ok(JSON.stringify(heads) === JSON.stringify(['Day', 'Indices', 'Documents', 'event_logsize', 'vs 7-day avg', 'Status']),
      `reports daily: the Day by day columns are ${heads.join(' | ')}`);
    const t = doc.querySelector('.vs table.coltbl').textContent;
    ok(/today so far/.test(t), 'reports daily: today\'s row does not say "today so far"');
    ok(/final/.test(t), 'reports daily: no finished day reads "final"');
    ok(!/Primary size/.test(doc.querySelector('.vs').textContent), 'reports daily: index store size is shown on Daily (it belongs to Measure size)');
    for (const k of ['Yesterday ·', '7-day average', 'Peak day in period', 'Month so far']) ok(doc.querySelector('.vs-cards').textContent.includes(k), `reports daily: no "${k}" tile`);
    ok([...doc.querySelectorAll('#vs-source option')].map((o) => o.value).join(',') === ',acme,beta',
      'reports daily: the Source select should list All sources, acme, beta');
    ok(!!doc.getElementById('vs-avg-days'), 'reports daily: no Average over select');
    ok(!!doc.querySelector('.vs .line-chart path.lc-line'), 'reports daily: the Log size per day line is missing');
    ok(/Log size per day/.test(doc.body.textContent), 'reports daily: no "Log size per day" chart');
    ok(!/Indices logstash-\*|day from/.test(doc.querySelector('.vs').textContent), 'reports daily: a source line is back (docs/REPORTS.md: none)');
    const exp = [...doc.querySelectorAll('.vs button')].find((b) => b.textContent === 'Export CSV');
    if (exp) {
      exp.click();
      const f = files.at(-1);
      ok(f && /^reports-daily-.+\.csv$/.test(f.name), `reports daily: the daily export is named "${f && f.name}"`);
      ok(f && f.text.split('\n')[0] === 'cluster,day,indices,docs,event_bytes,event_bytes_measured,change_vs_avg_pct,avg_days,status',
        `reports daily: the daily CSV header is "${f && f.text.split('\n')[0]}"`);
    }
    segBtn('Monthly').click();
    await waitFor(() => (doc.querySelector('.vs table.coltbl') && /Month by month/.test(doc.body.textContent) ? doc.body : null), 'reports daily: Monthly did not draw', 15000);
    await waitFor(() => (doc.querySelector('.vs-hbars .vs-hb') ? doc.body : null), 'reports daily: the breakdown drew no bars', 15000);
    const mh = [...doc.querySelectorAll('.vs table.coltbl thead th')].map((x) => (x.querySelector('.colhead-name') || x).textContent.trim());
    ok(JSON.stringify(mh) === JSON.stringify(['Month', 'Days', 'Documents', 'event_logsize', 'Peak day', 'vs previous']),
      `reports monthly: the Month by month columns are ${mh.join(' | ')}`);
    segBtn('Daily') && segBtn('Daily').click();
    await settleFor(150);
  }
}

/* ------------- Reports › Daily & monthly, driven against contract-shaped answers ------------- */

// The same views, with the core's VOLUME_* answers stubbed to the shapes docs/VOLUME.md
// gives (and the UI reads, core/volume-daily.js). This exercises every control whatever the
// core is; the block above is what checks the real core once it has the messages.
{
  const realFetch = globalThis.fetch;
  const DAYMS = 86400000;
  const vDay = (n) => new Date(Date.now() - n * DAYMS).toISOString().slice(0, 10);
  const settings = { sizeBasis: 'primary', extra: { name: 'Dataset', fields: ['event.dataset', 'log_type'] }, eventSize: ['event_logsize'],
    sourceHost: ['src_hostname', 'host.name'], forwarder: ['fwd_tag', 'fwdtag'], tag: ['tag1'], sourceIp: ['src_ip'] };
  const status = { lastRunAt: Date.now() - 60000, nextRunAt: null, running: false, progress: null, lastError: null, collectAt: '06:00' };
  const row = (n) => ({ day: vDay(n), final: n > 0 && n !== 4, live: true, totalsAt: Date.now() - 60000, aggregatedAt: Date.now() - 60000,
    error: n === 4 ? '2 of 28 shards failed (timeout): figures may be short; asked again on the next run' : null,
    indices: 2, docs: 5800000 - n * 1000, priBytes: n === 1 ? 1.3e10 : 8e9 + n * 1e7, totalBytes: 16e9 + n * 2e7,
    eventBytes: n === 1 ? 4.8e9 : n % 5 === 0 ? null : 3e9, subBytes: null, basis: n === 1 ? 1.3e10 : 8e9 + n * 1e7, avg: 8.1e9,
    changeVsAvgPct: n === 1 ? 61 : -2,
    top: { tag: { value: 'acme', share: 0.55 }, forwarder: { value: 'fwd-acme', share: 0.62 }, sourceHost: { value: 'fw-edge-01', share: 0.3 },
      sourceIp: { value: '10.0.0.1', share: 0.3 }, extra: { value: 'firewall', share: 0.5 } } });
  const ym = (i) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7); };
  const month = (i) => (i > 9 ? { month: ym(i), daysWithData: 0 } : {
    month: ym(i), partial: i === 0, daysWithData: i === 0 ? 3 : i === 9 ? 12 : new Date(Date.UTC(Number(ym(i).slice(0, 4)), Number(ym(i).slice(5, 7)), 0)).getUTCDate(),
    liveDays: i < 2 ? 30 : 0, keptDays: i === 1 ? 12 : i < 2 ? 0 : 30,
    priBytes: 2.4e11, totalBytes: 4.8e11, docs: 1.7e8, eventBytes: i === 3 ? null : 9e10 + i * 1e9, subBytes: null, avgPerDay: 8e9,
    peakDay: { day: `${ym(i)}-14`, basis: 1.3e10 }, top: { sourceHost: { value: 'fw-edge-01', share: 0.3 }, forwarder: { value: 'fwd-acme', share: 0.6 }, extra: { value: 'firewall', share: 0.5 } } });
  const vsent = [];
  const answer = (b) => {
    switch (b.type) {
      case 'VOLUME_DAILY': return { ok: true, settings, status, sources: ['acme', 'beta'], skipped: ['metrics-2026.09'],
        cards: { yesterday: { day: vDay(1), value: 1.3e10, avg: 8e9, changeVsAvgPct: 61 }, average: { days: b.avgDays, value: 8.4e9 },
          monthSoFar: { month: ym(0), value: 2.3e11, days: 29 }, eventBytes30: { value: null, days: 30 } },
        days: Array.from({ length: (b.days || 30) + 1 }, (_, n) => (n === 20 ? { ...row(n), source: 'history' } : row(n))),
        // The history store was asked for older days and could not be reached (docs/HISTORY.md).
        history: { asked: true, from: vDay(400), to: vDay(31), reachable: false, days: 0, truncated: false,
          message: 'in the history store · not reachable: Connection refused' },
        totals: { indices: 62, docs: 1.8e8, priBytes: 2.5e11, totalBytes: 5e11, eventBytes: null, subBytes: null } };
      case 'VOLUME_MONTHLY': return { ok: true, status, settings, months: Array.from({ length: b.months || 13 }, (_, i) => month(i)) };
      case 'VOLUME_BREAKDOWN': return { ok: true, field: b.field, resolved: 'src_hostname', totals: {}, rows: [
        { value: 'fw-edge-01', docs: 100, eventBytes: 5e8, estPriBytes: 2e9, sharePct: 40, daysSeen: 29 },
        { kind: 'missing', docs: 5, eventBytes: 1e8, estPriBytes: 1e8, sharePct: 2, daysSeen: 29 },
        { kind: 'other', docs: 50, eventBytes: 4e8, estPriBytes: 1e9, sharePct: 20, daysSeen: 29 }] };
      case 'VOLUME_RUN': return { ok: true, started: [], already: [], tooSoon: b.clusterIds || [] };
      case 'VOLUME_LAYOUT_GET': return { ok: true, layouts: { daily: null, monthly: null } };
      case 'VOLUME_LAYOUT_SET': return { ok: true, layouts: { [b.table]: b.layout } };
      case 'VOLUME_MONTHLY_ALL': return { ok: true, clusters: config.clusters.map((c, k) => ({ clusterId: c.name, name: c.name,
        months: [{ month: ym(1), daysWithData: 30, priBytes: 2e11 + k, eventBytes: 7e10 }, { month: ym(0), daysWithData: 29, priBytes: 1.9e11, eventBytes: 6e10, partial: true }, { month: ym(2), daysWithData: 0 }] })) };
      default: return null;
    }
  };
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(body.type || '').startsWith('VOLUME_')) { vsent.push(body); return stubReply(answer(body)); }
    return realFetch(input, init);
  };
  const vsBtn = (label, root = doc) => [...root.querySelectorAll('.vs button')].find((b) => b.textContent.trim() === label);
  const segBtn = (label) => [...doc.querySelectorAll('.vs .seg .btn')].find((b) => b.textContent.trim() === label);
  try {
    await go('overview');
    await go('reports');
    press(doc.querySelector('.rp-nav a[data-section="daily"]'));
    await settleFor(200);
    await waitFor(() => doc.querySelector('.vs table.coltbl'), 'daily (stubbed): the Day by day table did not draw');
    const txt = () => doc.querySelector('.vs').textContent;
    const tiles = doc.querySelector('.vs-cards').textContent;
    for (const k of [`Yesterday · `, '7-day average', 'Peak day in period', 'Month so far']) ok(tiles.includes(k), `daily (stubbed): no "${k}" tile`);
    ok(/event_logsize/.test(tiles) && /4\.47 GB/.test(tiles), `daily (stubbed): the Yesterday tile is not yesterday's event_logsize: ${tiles}`);
    ok(/yesterday against the 7 days before it/.test(tiles), 'daily (stubbed): the 7-day average tile does not compare yesterday with it');
    ok(!!doc.querySelector('.vs .line-chart path.lc-avg'), 'daily (stubbed): no dashed average line');
    // Today is not plotted: 30 finished days, one point each.
    ok(doc.querySelectorAll('.vs .line-chart svg > rect').length === 30, `daily (stubbed): ${doc.querySelectorAll('.vs .line-chart svg > rect').length} points plotted, expected 30 finished days`);
    const heads = () => [...doc.querySelectorAll('.vs table.coltbl thead th')].map((x) => (x.querySelector('.colhead-name') || x).textContent.trim());
    ok(JSON.stringify(heads()) === JSON.stringify(['Day', 'Indices', 'Documents', 'event_logsize', 'vs 7-day avg', 'Status']), `daily (stubbed): default columns ${heads().join(' | ')}`);
    const firstRow = doc.querySelector('.vs table.coltbl tbody tr');
    ok(firstRow && firstRow.classList.contains('today') && /today so far/.test(firstRow.textContent), 'daily (stubbed): the newest row is not "today so far"');
    const tt = doc.querySelector('.vs table.coltbl').textContent;
    ok(/2 of 28 shards failed · asked again/.test(tt), 'daily (stubbed): a day with failed shards does not say so');
    ok(/not measured/.test(tt), 'daily (stubbed): a day without event_logsize does not read "not measured"');
    ok(!!doc.querySelector('.vs table.coltbl .vs-high'), 'daily (stubbed): a change over +25 % is not marked');
    ok(!doc.querySelector('.vs table.coltbl tfoot'), 'daily (stubbed): a totals row is drawn (not on the board)');
    ok(!/never shown as 0/.test(txt()), 'daily (stubbed): the explanatory line under the table is back (docs/REPORTS.md: no captions)');
    // The history store: a day from it is marked, and an unreachable store is said once, in amber.
    const hb = doc.querySelectorAll('.vs .banner.warn.vs-history');
    ok(hb.length === 1 && /in the history store · not reachable: Connection refused/.test(hb[0].textContent),
      `daily (stubbed): the unreachable history store is not said once in amber (${hb.length}: ${hb[0] && hb[0].textContent})`);
    ok((tt.match(/· history/g) || []).length === 1, 'daily (stubbed): the day from the history store carries no "history" marker');

    // Average over 30 days re-asks with enough days for it, and the column follows.
    vsent.length = 0;
    const avgSel = doc.getElementById('vs-avg-days');
    avgSel.value = '30'; avgSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settleFor(250);
    ok(vsent.some((m) => m.type === 'VOLUME_DAILY' && m.days >= 61), `daily (stubbed): Average over 30 days did not ask for enough days: ${JSON.stringify(vsent.map((m) => m.days))}`);
    ok(heads().includes('vs 30-day avg'), 'daily (stubbed): the change column is not renamed to the 30-day average');
    avgSel.value = '7'; avgSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settleFor(250);

    // Hide a column from its header menu: the shared layout is saved, the header goes.
    vsent.length = 0;
    const docsTh = [...doc.querySelectorAll('.vs table.coltbl thead th')].find((th) => th.dataset.col === 'docs');
    docsTh.querySelector('.colhead-menu').click();
    const hide = [...doc.querySelectorAll('.menu-pop button')].find((b) => b.textContent.includes('Hide column'));
    ok(!!hide, 'daily (stubbed): the column menu has no "Hide column"');
    if (hide) hide.click();
    await settleFor(150);
    const set = vsent.find((m) => m.type === 'VOLUME_LAYOUT_SET');
    ok(set && set.table === 'daily' && set.layout.hidden.includes('docs'), `daily (stubbed): hiding saved ${JSON.stringify(set)}`);
    ok(!heads().includes('Documents'), 'daily (stubbed): the hidden column is still drawn');

    // Export follows the Reports daily columns: event_logsize, no primary size.
    vsBtn('Export CSV').click();
    const f = files.at(-1);
    ok(f && f.text.split('\n')[0] === 'cluster,day,indices,docs,event_bytes,event_bytes_measured,change_vs_avg_pct,avg_days,status',
      `daily (stubbed): the daily CSV header is "${f && f.text.split('\n')[0]}"`);

    // Collect now, refused politely when it is too soon.
    vsent.length = 0;
    vsBtn('↻ Collect now').click();
    await settleFor(200);
    ok(vsent.some((m) => m.type === 'VOLUME_RUN'), 'daily (stubbed): Collect now did not send VOLUME_RUN');
    ok(/less than a minute ago/.test(doc.body.textContent), 'daily (stubbed): a too-soon run is not explained');

    // Monthly: Month by month beside the Breakdown.
    segBtn('Monthly').click();
    await waitFor(() => (/Month by month/.test(doc.querySelector('.vs')?.textContent || '') && doc.querySelector('.vs-hbars') ? doc.body : null),
      'daily (stubbed): Monthly did not draw with its breakdown');
    const mt = txt();
    ok(heads().join(' | ') === 'Month | Days | Documents | event_logsize | Peak day | vs previous', `daily (stubbed): Monthly columns ${heads().join(' | ')}`);
    ok(/so far/.test(mt), 'daily (stubbed): the current month does not say "so far"');
    ok(/3 of \d\d/.test(mt), 'daily (stubbed): a month with days missing does not say "N of M"');
    ok(/[▲▼] \d+\.\d %/.test(mt), 'daily (stubbed): no month compares with the one before it');
    ok(/no src_hostname/.test(mt) && /other hosts/.test(mt), 'daily (stubbed): the breakdown does not say "no src_hostname" and "… other hosts"');
    ok(/%/.test(doc.querySelector('.vs-hbars').textContent), 'daily (stubbed): the breakdown bars carry no share');
    ok(!doc.querySelector('#vol-report-jobs') || !doc.querySelector('.vs #vol-report-jobs'), 'daily (stubbed): Generate report is still on Monthly (it moved to Exports & schedules)');
    vsBtn('Export CSV').click();
    const fm = files.at(-1);
    ok(fm && fm.text.split('\n')[0] === 'cluster,month,days_with_data,days_in_month,docs,event_bytes,peak_day,peak_event_bytes,vs_previous_pct',
      `daily (stubbed): the monthly CSV header is "${fm && fm.text.split('\n')[0]}"`);
    segBtn('Daily').click();
    await settleFor(150);
  } finally {
    globalThis.fetch = realFetch;
  }
  // Leave it as the next blocks expect: Reports re-reads on its next visit.
  await go('overview');
}

await goOne('snapshots');
{
  // Two levels. The page opens on the repositories and the SLM policies; the snapshot list
  // appears only once a repository is opened, with a way back.
  const listCards = () => [...doc.querySelectorAll('section.card header h2')].filter((x) => x.textContent.startsWith('Snapshots in '));
  const backBtn = () => doc.querySelector('button[data-act="back-to-repos"]');
  ok(!!panel('Repositories') && shown('Repositories'), 'snapshots: the page should open on a visible Repositories section');
  ok(!!panel('Policies (SLM)') && shown('Policies (SLM)'), 'snapshots: the page should open on a visible Policies (SLM) section');
  ok(!doc.querySelector('.seg .btn'), 'snapshots: the old Snapshots | Snapshot Summary switch is still there');
  ok(listCards().length === 0 && !doc.querySelector('input[aria-label="Search snapshots"]'),
    'snapshots: the snapshot list should not show before a repository is opened');
  const repoRows = () => [...(panel('Repositories') || doc.createElement('div')).querySelectorAll('tbody tr[data-repo]')];
  ok(repoRows().length > 0, 'snapshots: the Repositories section has no repository row');
  ok(!backBtn(), 'snapshots: the way-back control shows on the repositories view');
  const heads = [...panel('Repositories').querySelectorAll('thead th')].map((x) => x.textContent.trim());
  for (const hd of ['Repository', 'Type', 'Snapshots', 'Newest snapshot', 'Data span', 'SLM policies']) {
    ok(heads.includes(hd), `snapshots: the Repositories table has no "${hd}" column`);
  }
  // Where the backups are kept is not evidence (0.3.23): no Location column on this level either.
  ok(!heads.includes('Location'), 'snapshots: the Repositories table shows a Location column');

  // Open one, by its own Open control, as a person would.
  const openBtn = repoRows()[0].querySelector('button[data-act="open-repo"]');
  ok(!!openBtn, 'snapshots: a repository row has no Open control');
  openBtn.click();
  await settleFor(200);
  ok(listCards().length > 0, 'snapshots: opening a repository did not show its "Snapshots in <repo>" card');
  ok(!!doc.querySelector('input[aria-label="Search snapshots"]'), 'snapshots: no snapshot search bar in the opened repository');
  ok(!!doc.querySelector('.pager'), 'snapshots: the snapshot list has no pager');
  ok(!!backBtn() && /Repositories/.test(backBtn().textContent), 'snapshots: the opened repository has no "← Repositories" control');
  ok(!panel('Repositories') && !panel('Policies (SLM)'), 'snapshots: the repositories view is still showing under an opened repository');
  ok(!/Show all|more \(\d+ hidden\)/.test(doc.body.textContent), 'snapshots: the old "Show N more" control is still there');
  ok([...doc.querySelectorAll('button')].some((b) => b.textContent.includes('Create snapshot')), 'snapshots: "+ Create snapshot" is not reachable in the opened repository');

  // Remembered for the tab: away and back lands on the same repository.
  await go('reports');
  await goOne('snapshots');
  ok(listCards().length > 0, 'snapshots: the opened repository was not remembered across a page change');

  // The way back.
  backBtn().click();
  await settleFor(150);
  ok(listCards().length === 0 && !!panel('Repositories'), 'snapshots: "← Repositories" did not return to the repositories view');
  // And a row opens by being clicked, not only by its button.
  repoRows()[0].click();
  await settleFor(150);
  ok(listCards().length > 0, 'snapshots: clicking a repository row did not open it');

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

/* ------------- report jobs: Generate report, the job list and the top-bar pill ------------- */

// Reports › Exports & schedules › Generate report (Indices › Summary › Monthly until 0.3.53)
// and the "Reports" pill (0.3.45), against the
// REPORT_* answers docs/VOLUME.md gives, stubbed at fetch so this runs whatever the core is.
// Proves: the panel runs one job per picked cluster (the REPORT_RUN payload), the list shows
// running / queued / done and Download saves the file, Stop is an admin's alone (REPORT_STOP),
// and the pill follows REPORT_JOBS and opens the panel.
{
  const R = await load('core/reports.js');
  const st = (await load('core/state.js')).state;
  const realFetch = globalThis.fetch;
  const rsent = [];
  let jobs = [];
  let nextId = 1;
  const FILE = 'volume-prod-2026-09-01_2026-09-30.xlsx';
  const answer = (b) => {
    switch (b.type) {
      case 'REPORT_JOBS': return { ok: true, jobs, concurrency: 3,
        running: jobs.filter((j) => j.status === 'running').length, queued: jobs.filter((j) => j.status === 'queued').length };
      case 'REPORT_RUN': {
        const made = (b.clusterIds || []).map((id) => ({ id: `j${nextId++}`, kind: 'cluster', clusterId: id, clusterName: id, clusterIds: [id],
          period: { from: '2026-09-01', to: '2026-09-30', label: 'Sep 2026' }, format: b.format, mail: b.mail, by: 'local',
          createdAt: Date.now(), startedAt: null, endedAt: null, status: 'queued', progress: { done: 0, total: 0 }, file: null,
          error: null, mailError: null, stoppedBy: null, warning: null, stopping: false }));
        jobs = [...made, ...jobs];
        return { ok: true, jobs: made, refused: [] };
      }
      case 'REPORT_STOP': return { ok: true, stopped: 1, stopping: 0 };
      case 'REPORT_CLEAR': return { ok: true, removed: 0 };
      case 'REPORT_DOWNLOAD': return { ok: true, name: FILE, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 4, base64: 'UEsDBA==' };
      case 'REPORT_CONCURRENCY_SET': return { ok: true, concurrency: b.n };
      default: return { ok: false, kind: 'bad_message', message: `Unknown message type "${b.type}"` };
    }
  };
  let older = true;
  let bound = null;   // a REPORT_RUN refusal the core's bounds make
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (bound && body.type === 'REPORT_RUN') { rsent.push(body); return stubReply(bound); }
    if (/^(REPORT_|MAIL_)/.test(String(body.type || ''))) {
      rsent.push(body);
      return stubReply(older ? { ok: false, kind: 'bad_message', message: `Unknown message type "${body.type}"` } : answer(body));
    }
    return realFetch(input, init);
  };
  const pill = () => doc.getElementById('reports-pill');
  const rows = () => [...doc.querySelectorAll('#rj-panel .rj-job')];
  try {
    // An older core: no pill, no Generate report, and the job list is not asked for again.
    R.resetReports();
    R.startReportsPoll();
    await go('reports');
    press(doc.querySelector('.rp-nav a[data-section="exports"]'));
    await settleFor(300);
    ok(R.reports.supported === false, 'reports: an unknown REPORT_JOBS was not taken for an older core');
    ok(!pill() || pill().hidden, 'reports: the pill shows on a core without reports');
    const mountEl = doc.getElementById('vol-report-jobs');
    ok(!mountEl || mountEl.hidden, 'reports: Generate report is offered by a core without reports');
    const asked = rsent.length;
    await R.refreshReports();
    ok(rsent.length === asked, 'reports: an older core is asked for the job list again');

    // From here on, a core that runs reports. Whatever was said before, start over.
    older = false;
    R.resetReports();
    R.startReportsPoll();
    await go('overview');
    await waitFor(() => (pill() && !pill().hidden ? pill() : null), 'reports: the top-bar pill did not show for a core that runs reports');
    ok(pill() && pill().textContent === 'Reports · idle', `reports: the idle pill reads "${pill() && pill().textContent}"`);

    await go('reports');
    press(doc.querySelector('.rp-nav a[data-section="exports"]'));
    await settleFor(300);
    const open = await waitFor(() => doc.getElementById('rj-open'), 'reports: no Generate report button on Exports & schedules');
    ok(!!open && !!open.closest('section.card') && /Generated reports/.test(open.closest('section.card').querySelector('h2').textContent),
      'reports: Generate report is not on the Generated reports card');
    if (open) {
      // The list of jobs is what the card is for: the panel is open on arrival.
      const panelEl = doc.getElementById('rj-panel');
      if (panelEl && panelEl.hidden) { open.click(); await settleFor(100); }
      ok(!!panelEl && !panelEl.hidden, 'reports: the Generated reports card does not show the jobs');
      // The first cluster shown is listed until "More clients…".
      const first = [...doc.querySelectorAll('#rj-panel .rj-client input')];
      ok(first.length === 1, `reports: ${first.length} client boxes before More clients…, want only the first cluster`);
      const more = doc.getElementById('rj-more');
      ok(config.clusters.length < 2 || !!more, 'reports: no More clients… button');
      if (more) { more.click(); await settleFor(50); }
      const boxes = [...doc.querySelectorAll('#rj-panel .rj-client input')];
      ok(boxes.length === config.clusters.length, `reports: ${boxes.length} client boxes for ${config.clusters.length} clusters`);
      [...doc.querySelectorAll('#rj-panel button')].find((b) => b.textContent === 'Clear').click();
      await settleFor(50);
      const run = doc.getElementById('rj-run');
      ok(run && run.disabled && run.textContent === 'Run report · 0 clients', `reports: with nothing picked Run reads "${run && run.textContent}" (disabled ${run && run.disabled})`);
      [...doc.querySelectorAll('#rj-panel button')].find((b) => b.textContent === 'Select all').click();
      await settleFor(50);
      const all = [...doc.querySelectorAll('#rj-panel .rj-client input')];
      ok(all.every((b) => b.checked), 'reports: Select all left a client unticked');
      // Untick the last one by hand, as a person would.
      const last = all.at(-1);
      last.checked = false; last.dispatchEvent(new window.Event('change', { bubbles: true }));
      const want = all.slice(0, -1).map((b) => b.value);
      const period = doc.getElementById('rj-period');
      ok(period && period.options[0].textContent.endsWith('(so far)') && [...period.options].some((o) => o.value === 'last7') && [...period.options].some((o) => o.value === 'yesterday'),
        'reports: the Period list lacks this month so far, Yesterday or Last 7 days');
      period.value = period.options[1].value;
      period.dispatchEvent(new window.Event('change', { bubbles: true }));
      ok(doc.getElementById('rj-run').textContent === `Run report · ${want.length} client${want.length === 1 ? '' : 's'}`, `reports: Run reads "${doc.getElementById('rj-run').textContent}"`);
      ok(/report recipients/.test(doc.querySelector('#rj-panel .rj-check').textContent), 'reports: the mail box does not say where the mail goes');
      rsent.length = 0;
      doc.getElementById('rj-run').click();
      await settleFor(300);
      const runMsg = rsent.find((m) => m.type === 'REPORT_RUN');
      ok(!!runMsg && JSON.stringify(runMsg.clusterIds) === JSON.stringify(want) && runMsg.period === period.options[1].value
        && runMsg.format === 'xlsx' && runMsg.mail === false, `reports: Run sent ${JSON.stringify(runMsg)}`);
      ok(rows().length === want.length, `reports: ${rows().length} job rows after queueing ${want.length}`);

      // The core's bounds: its message is the status line, as it says it.
      bound = { ok: false, kind: 'too_many_jobs', message: 'at most 15 report jobs at once: 2 more fit' };
      doc.getElementById('rj-run').click();
      await settleFor(200);
      const stl = doc.getElementById('rj-status');
      ok(stl && !stl.hidden && stl.textContent.startsWith('at most 15 report jobs at once: 2 more fit'), `reports: too_many_jobs status reads "${stl && stl.textContent}"`);
      bound = { ok: false, kind: 'too_many_mails', message: 'ten mails an hour is the most' };
      doc.getElementById('rj-run').click();
      await settleFor(200);
      ok(doc.getElementById('rj-status').textContent.startsWith('ten mails an hour is the most'), 'reports: too_many_mails message not shown');
      // The report worker is down (0.3.54, docs/WORKER.md): the core's sentence, amber, not red.
      bound = { ok: false, kind: 'worker_unavailable', message: 'the report worker is not running — reports and collection resume when it is back' };
      doc.getElementById('rj-run').click();
      await settleFor(200);
      const wst = doc.getElementById('rj-status');
      ok(wst.textContent.startsWith('the report worker is not running') && wst.classList.contains('rj-warn') && !wst.classList.contains('rj-bad'),
        `reports: worker_unavailable reads "${wst.textContent}" (${wst.className}), want the core's words in amber`);
      bound = null;

      // The list as the core moves it on: running, queued, done.
      jobs = [
        { ...jobs[0], id: 'jr', status: 'running', progress: { done: 31, total: 50 }, createdAt: 1 },
        { ...jobs[0], id: 'jq', status: 'queued', createdAt: 2, clusterName: 'second' },
        { ...jobs[0], id: 'jd', status: 'done', file: { name: FILE, bytes: 4 }, endedAt: Date.now(), mailError: 'mail is not set up', createdAt: 0 },
      ];
      await R.refreshReports();
      await settleFor(50);
      const txt = doc.getElementById('rj-panel').textContent;
      ok(txt.includes('Running · 62 %') && !!doc.querySelector('#rj-panel .rj-bar'), 'reports: the running job has no "Running · 62 %" and bar');
      ok(txt.includes('Queued · #1 in line'), 'reports: the queued job does not say its place');
      ok(txt.includes(`Done · ${FILE}`), 'reports: the finished job does not name its file');
      ok(txt.includes('Not mailed: mail is not set up'), 'reports: a mailError is not shown');
      ok(txt.includes('1 running · 1 queued · 1 done'), 'reports: the list header does not count the jobs');
      ok(/At most 3 run together/.test(txt), 'reports: the footnote does not say how many run together');
      // What the pill says is the poller's.
      ok(R.pillText(R.reports) === 'Reports · 1 running · 1 queued', `reports: the pill would read "${R.pillText(R.reports)}"`);

      // The 2-s poll while a job runs moves its progress: the row and its Stop button stay the same
      // elements, only the status line changes (0.3.54 flicker pass — the button under the mouse
      // used to be replaced every 2 s, so its hover blinked and a slow click hit nothing).
      {
        const row0 = doc.querySelector('#rj-panel .rj-job[data-job="jr"]');
        const stop0 = row0 && row0.querySelector('.rj-stop');
        jobs = jobs.map((j) => (j.id === 'jr' ? { ...j, progress: { done: 40, total: 50 } } : j));
        await R.refreshReports();
        await settleFor(50);
        const row1 = doc.querySelector('#rj-panel .rj-job[data-job="jr"]');
        ok(row1 === row0 && row1.querySelector('.rj-stop') === stop0, 'reports: a progress poll rebuilt the running job\'s row or its Stop button');
        ok(/Running · 80 %/.test(row1 ? row1.textContent : ''), `reports: the progress did not move on in place (${row1 && row1.textContent})`);
        jobs = jobs.map((j) => (j.id === 'jr' ? { ...j, progress: { done: 31, total: 50 } } : j));
        await R.refreshReports();
        await settleFor(50);
      }

      // An indices / hosts job (0.3.54): ONE job for the picked clusters, a line per cluster with
      // its concurrency, halvings and last reason; a cluster it could not read named with why.
      const hostsJob = { ...jobs[0], id: 'jh', reportKind: 'hosts', report: 'hosts', clusterId: 'a', clusterName: '3 clusters', clusterIds: ['a', 'b', 'c'],
        status: 'running', createdAt: 3,
        progress: { done: 1, total: 3, state: 'collecting', cluster: 'a', clusters: {
          a: { state: 'collecting', day: '2026-11-03', pages: 40, rows: 900, retries: 1, concurrency: 3, partitions: { done: 1, total: 3 }, halvings: 1, lastReason: 'HTTP 429', days: { done: 2, total: 3 } },
          b: { state: 'waiting', day: null, pages: 0, rows: 0, retries: 0, concurrency: 0, partitions: { done: 0, total: 0 }, halvings: 0, lastReason: null, days: { done: 0, total: 0 } } } },
        failedClusters: [{ clusterId: 'c', reason: 'connection refused' }] };
      jobs = [hostsJob, ...jobs];
      await R.refreshReports();
      await settleFor(50);
      const hj = doc.querySelector('#rj-panel .rj-job[data-job="jh"]');
      const cl = (id) => hj && hj.querySelector(`.rj-cl[data-cluster="${id}"]`);
      ok(hj && /Volume by host · 3 clusters/.test(hj.textContent), `reports: the hosts job does not say its kind (${hj && hj.textContent})`);
      ok(cl('a') && /3 at once/.test(cl('a').textContent) && /halved 1× \(HTTP 429\)/.test(cl('a').textContent) && /1\/3 partitions/.test(cl('a').textContent) && /2 of 3 days/.test(cl('a').textContent),
        `reports: cluster a's line reads "${cl('a') && cl('a').textContent}"`);
      ok(cl('b') && /waiting/.test(cl('b').textContent) && !/at once/.test(cl('b').textContent), `reports: a waiting cluster shows a concurrency (${cl('b') && cl('b').textContent})`);
      ok(cl('c') && /failed: connection refused/.test(cl('c').textContent) && cl('c').classList.contains('rj-warn'), `reports: the failed cluster is not named with why (${cl('c') && cl('c').textContent})`);
      jobs = jobs.filter((j) => j.id !== 'jh');
      await R.refreshReports();
      await settleFor(50);

      // Download: REPORT_DOWNLOAD, base64 to a file of the core's name.
      rsent.length = 0;
      const dl = doc.querySelector('#rj-panel .rj-job[data-job="jd"] .rj-dl');
      ok(!!dl, 'reports: the done job has no Download');
      if (dl) {
        dl.click();
        await settleFor(200);
        ok(rsent.some((m) => m.type === 'REPORT_DOWNLOAD' && m.id === 'jd'), `reports: Download sent ${JSON.stringify(rsent)}`);
        ok(files.at(-1) && files.at(-1).name === FILE, `reports: Download saved "${files.at(-1) && files.at(-1).name}"`);
      }

      // Stop: an admin's (the portable build has no accounts, so it is admin here).
      const stop = doc.querySelector('#rj-panel .rj-job[data-job="jr"] .rj-stop');
      ok(!!stop, 'reports: an admin sees no Stop on a running job');
      rsent.length = 0;
      if (stop) { stop.click(); await settleFor(200); }
      ok(rsent.some((m) => m.type === 'REPORT_STOP' && m.id === 'jr'), `reports: Stop sent ${JSON.stringify(rsent)}`);
      ok(!doc.getElementById('rj-stop-all').hidden, 'reports: an admin sees no Stop all');

      // Anybody else: no Stop, the reason in its place, the concurrency read-only.
      st.caller = { name: 'reader', role: 'user' };
      await R.refreshReports();
      await settleFor(50);
      ok(!doc.querySelector('#rj-panel .rj-stop'), 'reports: a user is offered Stop');
      ok(/admin only/.test(doc.querySelector('#rj-panel .rj-job[data-job="jr"]').textContent), 'reports: a user is not told Stop is admin only');
      ok(doc.getElementById('rj-stop-all').hidden, 'reports: a user is offered Stop all');
      ok(doc.getElementById('rj-concurrency').disabled, 'reports: a user can change how many run at once');
      st.caller = null;
      await R.refreshReports();

      // Close it, leave, and come back through the pill: Exports & schedules, the jobs open.
      [...doc.querySelectorAll('#rj-panel button')].find((b) => b.textContent === 'Close').click();
      await go('overview');
      pill().click();
      await settleFor(500);
      const back = await waitFor(() => { const p = doc.getElementById('rj-panel'); return p && p.isConnected && !p.hidden ? p : null; },
        'reports: the pill did not open Reports › Exports & schedules with the report jobs');
      ok(!!back && (doc.location.hash || '') === '#/reports/exports', `reports: the pill went to ${doc.location.hash}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    jobs = [];
  }
  // The rest of this run is about other things: back to what the real core says.
  R.resetReports();
  await go('overview');
}

/* --------------- Reports: section nav, Overview, Capacity, Measure size, Exports --------------- */

await backToFleet();
await go('reports');
{
  const navLinks = () => [...doc.querySelectorAll('.rp-nav a')];
  const current = () => (doc.querySelector('.rp-nav a[aria-current="page"]') || {}).dataset?.section;
  const navTo = async (id) => { const a = doc.querySelector(`.rp-nav a[data-section="${id}"]`); if (a) { press(a); await settleFor(300); } return !!a; };
  const btnIn = (root, label) => [...(root || doc).querySelectorAll('button')].find((b) => b.textContent.trim() === label);

  // The page: title, subtitle, the six sections in order, Overview first; the tab reads Reports.
  ok(/^Reports$/.test((doc.querySelector('.rp-head h1') || {}).textContent || ''), 'reports: no "Reports" title');
  ok(/What each cluster takes in, what it keeps, and whether its storage holds it\./.test(doc.body.textContent), 'reports: the subtitle is missing');
  ok(navLinks().map((a) => a.textContent).join(' · ') === 'Overview · Daily & monthly · Volume by host · Capacity & retention · Measure size · Planning · Exports & schedules',
    `reports: the section nav reads ${navLinks().map((a) => a.textContent).join(' · ')}`);
  ok(current() === 'overview', `reports: opens on ${current()}, want Overview`);
  ok([...doc.querySelectorAll('#nav a, #nav button')].some((x) => x.dataset.page === "reports" && /Reports$/.test(x.textContent.trim())), 'reports: the tab is not labelled Reports');
  ok(![...doc.querySelectorAll('#nav a, #nav button')].some((x) => /Volume report/.test(x.textContent)), 'reports: a "Volume report" tab is still there');
  // Each section by the nav: the marker moves, the address follows, the body changes.
  for (const id of ['daily', 'capacity', 'measure', 'planning', 'exports', 'overview']) {
    ok(await navTo(id), `reports: no ${id} in the section nav`);
    ok(current() === id, `reports: the nav marks ${current()} after choosing ${id}`);
    ok((doc.location.hash || '') === `#/reports/${id}`, `reports: choosing ${id} left the address at ${doc.location.hash}`);
  }
  // The old address still opens the page, at the section it names.
  doc.location.hash = '#/volume/capacity';
  await settleFor(500);
  ok(current() === 'capacity', `reports: #/volume/capacity opened ${current()}`);
  ok((doc.location.hash || '').startsWith('#/reports'), `reports: #/volume did not become #/reports (${doc.location.hash})`);
  doc.location.hash = '#/reports/overview';
  await settleFor(400);

  // Overview: the five tiles, the two cards, the By cluster table; none of what the board left out.
  await waitFor(() => (panel('By cluster') && !/…/.test(panel('By cluster').querySelector('tbody').textContent) ? panel('By cluster') : null),
    'reports overview: the By cluster table did not settle', 30000);
  const tiles = doc.querySelector('.rp-tiles') ? doc.querySelector('.rp-tiles').textContent : '';
  for (const k of ['Ingested yesterday', '7-day daily average', 'Month so far', 'Disk runs out within 6 weeks', 'Backups that do not fit']) {
    ok(tiles.includes(k), `reports overview: no "${k}" tile`);
  }
  ok(!!panel('Daily volume') && !!panel('How long the free disk lasts'), 'reports overview: the Daily volume / free disk cards are missing');
  ok(!doc.querySelector('.coverage, .cov-bar') && !btnIn(doc.getElementById('view'), 'Read all'), 'reports overview: a freshness strip / Read all is drawn (docs/REPORTS.md: none)');
  ok(!/today not final/i.test(doc.getElementById('view').textContent), 'reports overview: a "today not final" pill is drawn');
  const byHeads = () => [...panel('By cluster').querySelectorAll('thead th')].map((x) => x.textContent.trim());
  ok(JSON.stringify(byHeads()) === JSON.stringify(['Cluster', 'Type', 'Yesterday', '7-day avg', 'vs avg', 'Month so far', 'Data-node disk used', 'Disk lasts', 'Live retention', 'Backups', 'Daily record']),
    `reports overview: the By cluster columns are ${byHeads().join(' | ')}`);
  ok(panel('By cluster').querySelectorAll('tbody tr').length === config.clusters.length, 'reports overview: not one line per cluster');
  // The mock's three nodes are data nodes (node.role "dim"): the disk is measured, as a percentage.
  ok(/\d+\.\d %/.test(panel('By cluster').querySelector('tbody tr td[data-col="diskUsed"]').textContent), 'reports overview: the data-node disk is not measured against the mock');

  // The Columns menu: hide, move, reset, and Save for everyone (VOLUME_LAYOUT_SET table overview).
  const realFetch = globalThis.fetch;
  const lsent = [];
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (body.type === 'VOLUME_LAYOUT_SET' || body.type === 'VOLUME_RUN') lsent.push(body);
    return realFetch(input, init);
  };
  try {
    const colBtn = doc.getElementById('rp-cols-overview');
    ok(!!colBtn, 'reports overview: no Columns button on By cluster');
    if (colBtn) {
      colBtn.click();
      await settleFor(100);
      const pop = () => doc.querySelector('.pop.colmenu');
      ok(!!pop(), 'reports overview: Columns did not open its menu');
      const item = (key) => pop() && pop().querySelector(`li[data-col="${key}"]`);
      ok(item('cluster') && item('cluster').classList.contains('lock') && item('cluster').querySelector('input').disabled, 'reports overview: Cluster is not locked first');
      ok(!!pop().querySelector('li .grip') && !!btnIn(pop(), '▲') && !!btnIn(pop(), '▼'), 'reports overview: the menu has no drag handle or ▲/▼');
      // Hide Type.
      const box = item('type').querySelector('input');
      box.checked = false; box.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settleFor(150);
      ok(!byHeads().includes('Type'), 'reports overview: unticking Type did not hide it');
      // Move Yesterday down one.
      item('yesterday').querySelector('button[aria-label^="Move Yesterday down"]').click();
      await settleFor(150);
      const hd = byHeads();
      ok(hd.indexOf('7-day avg') < hd.indexOf('Yesterday'), `reports overview: ▼ did not move Yesterday after 7-day avg: ${hd.join(' | ')}`);
      ok(/this browser only/.test(pop().textContent), 'reports overview: the menu does not say the arrangement is in this browser until saved');
      // CSV follows the columns on screen.
      btnIn(panel('By cluster'), 'Export CSV').click();
      const f = files.at(-1);
      ok(f && /^reports-overview-.+\.csv$/.test(f.name) && f.text.split('\n')[0].startsWith('Cluster,7-day avg (GB),Yesterday (GB)') && !/Type/.test(f.text.split('\n')[0]),
        `reports overview: the CSV does not follow the columns on screen: ${f && f.text.split('\n')[0]}`);
      // Save for everyone: the shared layout, table overview (the 0.3.53 core keeps it). It is
      // really kept: VOLUME_LAYOUT_GET gives it back to anybody who asks.
      lsent.length = 0;
      btnIn(pop(), 'Save for everyone').click();
      await settleFor(500);
      const set = lsent.find((m) => m.type === 'VOLUME_LAYOUT_SET');
      ok(set && set.table === 'overview' && set.layout.hidden.includes('type') && set.layout.order.indexOf('avg7') < set.layout.order.indexOf('yesterday'),
        `reports overview: Save for everyone sent ${JSON.stringify(set)}`);
      const said = pop() ? pop().textContent : '';
      ok(/Saved for everyone/.test(said), `reports overview: Save for everyone was not saved: ${said}`);
      const VD = await load('core/volume-daily.js');
      const got = await VD.volumeLayoutGet();
      const shared = got && got.layouts && got.layouts.overview;
      ok(shared && shared.hidden.includes('type') && shared.order.indexOf('avg7') < shared.order.indexOf('yesterday') && shared.order[0] === 'cluster',
        `reports overview: VOLUME_LAYOUT_GET does not give the saved layout back: ${JSON.stringify(shared)}`);
      ok(!/this browser only/.test(said), 'reports overview: still "this browser only" after a save the core kept');
      // Reset to default: every column back, in its place — and saved, so the next run starts clean.
      btnIn(pop(), 'Reset to default').click();
      await settleFor(150);
      ok(JSON.stringify(byHeads().slice(0, 3)) === JSON.stringify(['Cluster', 'Type', 'Yesterday']), `reports overview: Reset did not restore the default: ${byHeads().join(' | ')}`);
      btnIn(pop(), 'Save for everyone').click();
      await settleFor(400);
      const back = await VD.volumeLayoutGet();
      ok(back && back.layouts && back.layouts.overview && !back.layouts.overview.hidden.includes('type'), `reports overview: the reset layout was not saved: ${JSON.stringify(back && back.layouts && back.layouts.overview)}`);
      if (pop()) pop().querySelector('header button').click();
    }

    // Capacity & retention: the Storage plan, its group band, the disk bar, the switch.
    await navTo('capacity');
    const plan = await waitFor(() => panel('Storage plan'), 'reports capacity: no Storage plan');
    const planHeads = () => [...panel('Storage plan').querySelectorAll('thead tr:last-child th')].map((x) => x.textContent.trim());
    if (plan) {
      ok(JSON.stringify(planHeads()) === JSON.stringify(['Cluster', 'Per day', '30% buffer', 'Live retention', 'Live retention policy', 'Live disk (data nodes)',
        'Required live disk', 'Live disk shortfall', 'Backup policy', 'Backup disk (repository)', 'Required backup disk', 'Backup disk shortfall']),
        `reports capacity: the Storage plan columns are ${planHeads().join(' | ')}`);
      const band = () => [...panel('Storage plan').querySelectorAll('thead tr.rp-band th')].map((x) => `${x.textContent.trim()}×${x.getAttribute('colspan') || 1}`);
      ok(JSON.stringify(band()) === JSON.stringify(['×3', 'Live×5', 'Archival / snapshot / backup×4']), `reports capacity: the group band reads ${band().join(' ')}`);
      const bar = panel('Storage plan').querySelector('td[data-col="liveDisk"] .rp-disk');
      ok(!!bar && /\d+ %/.test(bar.querySelector('.rp-dp').textContent) && / of .+, .+ avail/.test(bar.querySelector('.rp-dl').textContent),
        'reports capacity: the live disk bar has no bold % or "used of total, avail" label');
      ok(/not measured · set backupCapacity|in S3|size not measured/.test(panel('Storage plan').textContent), 'reports capacity: the backup disk does not say why it is unknown');
      ok(!panel('Will the indices fit on disk?') && !panel('Will the backups fit?'), 'reports capacity: the fit cards are back (docs/REPORTS.md: none)');
      // A reorder that mixes the groups hides the band.
      doc.getElementById('rp-cols-capacity').click();
      await settleFor(100);
      const pop = doc.querySelector('.pop.colmenu');
      for (let i = 0; i < 6 && pop; i++) {
        const b = pop.isConnected && doc.querySelector('.pop.colmenu li[data-col="backupPolicy"] button[aria-label^="Move Backup policy up"]');
        if (b) { b.click(); await settleFor(80); }
      }
      ok(band().length === 0, `reports capacity: the band still shows over mixed groups: ${band().join(' ')}`);
      {
        const VD = await load('core/volume-daily.js');
        const pm = doc.querySelector('.pop.colmenu');
        lsent.length = 0;
        if (pm) { btnIn(pm, 'Save for everyone').click(); await settleFor(500); }
        const s2 = lsent.find((m) => m.type === 'VOLUME_LAYOUT_SET');
        ok(s2 && s2.table === 'capacity', `reports capacity: Save for everyone sent ${JSON.stringify(s2)}`);
        const g = await VD.volumeLayoutGet();
        const cap = g && g.layouts && g.layouts.capacity;
        ok(cap && cap.order[0] === 'cluster' && cap.order.indexOf('backupPolicy') < cap.order.indexOf('liveShortfall'),
          `reports capacity: VOLUME_LAYOUT_GET does not give the saved layout back: ${JSON.stringify(cap)}`);
      }
      const reset = doc.querySelector('.pop.colmenu') && btnIn(doc.querySelector('.pop.colmenu'), 'Reset to default');
      if (reset) { reset.click(); await settleFor(120); }
      ok(band().length === 3, 'reports capacity: Reset did not bring the band back');
      if (doc.querySelector('.pop.colmenu')) { btnIn(doc.querySelector('.pop.colmenu'), 'Save for everyone').click(); await settleFor(400); }
      if (doc.querySelector('.pop.colmenu')) doc.querySelector('.pop.colmenu header button').click();
      // CSV follows the columns on screen.
      btnIn(panel('Storage plan'), 'Export CSV').click();
      const f = files.at(-1);
      ok(f && /^reports-storage-plan-.+\.csv$/.test(f.name) && f.text.split('\n')[0].startsWith('Cluster,Per day (GB),30% buffer (GB),Live retention (days)'),
        `reports capacity: the Storage plan CSV header is ${f && f.text.split('\n')[0]}`);
    }
    // The switch: Every parameter (36) and Client plan (17), from the same report columns.
    const seg = (re) => [...doc.querySelectorAll('.rp-bar .seg .btn')].find((b) => re.test(b.textContent));
    ok(!!seg(/^Plan$/) && !!seg(/^Every parameter \(36\)$/) && !!seg(/^Client plan \(17\)$/), 'reports capacity: the Plan / Every parameter / Client plan switch is missing');
    if (seg(/^Every parameter/)) {
      seg(/^Every parameter/).click();
      await settleFor(250);
      const h = sheetHeaders();
      ok(h.length === 36 && h.some((x) => x.startsWith('Current live storage store upto')), `reports capacity: Every parameter has ${h.length} columns`);
      btnIn(doc.getElementById('view'), 'Export CSV').click();
      const full = files.at(-1);
      ok(full && /^reports-every-parameter-\d{4}-\d{2}-\d{2}\.csv$/.test(full.name) && full.text.split('\n')[0].split(',').length === 37,
        `reports capacity: the full export is "${full && full.name}" with ${full && full.text.split('\n')[0].split(',').length} headers`);
      seg(/^Client plan/).click();
      await settleFor(250);
      const WANT = ['ClientName', 'ES Host', 'Current Per Day Volume', 'Daily Volume + buffer', 'Current Live Storage', 'Live Used',
        'Current Live Storage Store Upto', 'Required Live Storage for 30days', 'Required Live Storage for 90days', 'Live Indices From', 'Live Indices To',
        'Current Backup Storage', 'Backup Storage Type', 'Required Backup Storage for 365 days', 'Current Backup storage Store upto',
        'Snapshot Indices From', 'Snapshot Indices To'];
      const ch = sheetHeaders();
      ok(ch.length === 17 && WANT.every((w, i) => ch[i] && ch[i].startsWith(w)), `reports capacity: the client plan columns are ${ch.join(' | ')}`);
      ok(JSON.stringify(groupBand()) === JSON.stringify(['Client×1', '×1', 'Volume×2', 'Live storage×7', 'Backup storage×6']),
        `reports capacity: the client plan's group band reads ${groupBand().join(' ')}`);
      seg(/^Plan$/).click();
      await settleFor(200);
    }

    // Measure size: the button sends VOLUME_RUN for the clusters shown — nothing new.
    await navTo('measure');
    const per = await waitFor(() => panel('Per cluster'), 'reports measure: no Per cluster table');
    if (per) {
      const mh = [...per.querySelectorAll('thead th')].map((x) => x.textContent.trim());
      ok(JSON.stringify(mh) === JSON.stringify(['Cluster', 'Index size per day', 'event_logsize per day', 'Difference', 'Ratio', 'Compared']),
        `reports measure: the Per cluster columns are ${mh.join(' | ')}`);
      ok([...doc.querySelectorAll('#rp-measure-period option')].map((o) => o.textContent).join(' | ') === 'Last 7 days | Last 30 days | Yesterday',
        'reports measure: the Period choices are wrong');
      ok([...doc.querySelectorAll('section.card header h2')].some((x) => / · day by day$/.test(x.textContent)), 'reports measure: no day by day table for the selected cluster');
      lsent.length = 0;
      const btn = doc.getElementById('rp-measure');
      ok(!!btn && btn.textContent === '↻ Measure size', 'reports measure: no "↻ Measure size" button');
      if (btn) { btn.click(); await settleFor(400); }
      const run = lsent.filter((m) => m.type === 'VOLUME_RUN');
      ok(run.length === 1, `reports measure: Measure size sent ${run.length} VOLUME_RUN`);
      const ids = (await load('core/state.js')).activeClusters().map((c) => c.id);
      ok(run[0] && JSON.stringify([...run[0].clusterIds].sort()) === JSON.stringify([...ids].sort()), `reports measure: VOLUME_RUN named ${JSON.stringify(run[0] && run[0].clusterIds)}, want the clusters shown`);
      ok(!lsent.some((m) => m.type !== 'VOLUME_RUN' && m.type !== 'VOLUME_LAYOUT_SET'), 'reports measure: a new kind of request was sent');
    }

    // Exports & schedules: the four downloads, every size event_logsize.
    await navTo('exports');
    const dl = await waitFor(() => panel('Download now'), 'reports exports: no Download now card');
    if (dl) {
      for (const t of ['Fleet overview', 'Daily record', 'Monthly record', 'Storage plan']) ok(dl.textContent.includes(t), `reports exports: no "${t}" download`);
      ok(/every size is event_logsize/.test(dl.textContent), 'reports exports: the downloads do not say every size is event_logsize');
      doc.getElementById('rp-x-daily-csv').click();
      const f = files.at(-1);
      ok(f && /^reports-daily-\d{4}-\d{2}-\d{2}\.csv$/.test(f.name) && f.text.split('\n')[0] === 'cluster,day,indices,docs,event_bytes,event_bytes_measured,change_vs_avg_pct,avg_days,status',
        `reports exports: the daily record file is "${f && f.name}": ${f && f.text.split('\n')[0]}`);
      doc.getElementById('rp-x-overview-xlsx').click();
      ok(files.at(-1) && /^reports-overview-.+\.xlsx$/.test(files.at(-1).name), `reports exports: the fleet overview .xlsx is "${files.at(-1) && files.at(-1).name}"`);
    }
    ok(!!panel('Mailed reports') && !!panel('Generated reports'), 'reports exports: the Mailed reports / Generated reports cards are missing');
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* --------------------- alert triggers are listed and switchable --------------------- */

/**
 * Config-Management (the board of 2026-11-05): nine pages in a menu on the left, tabs under
 * each. Yesterday's tab labels, and where each went — the cases below still name them.
 */
const CFG_HOME = {
  'Config file': ['system', 'file'], Diagnostics: ['system', 'file'], Credentials: ['clusters', 'creds'],
  Clusters: ['clusters', 'clusters'], Zabbix: ['zabbix', 'zabbix'], 'Jump hosts & trust': ['clusters', 'trust'],
  'Alert triggers': ['alerts', 'triggers'], 'Scheduled log delay': ['data', 'schedule'], 'History store': ['data', 'backend'],
  Requests: ['requests', 'policy'], Defaults: ['system', 'defaults'], Reports: ['reports', 'fields'], Play: ['play', 'play'],
  'Mail delivery': ['reports', 'mail'], 'Plan templates': ['reports', 'templates'],
};
/** The page and tab open now, as the menu and the tab row mark them. */
function cfgOpen() {
  const page = doc.querySelector('.cm-nav .cm-item[aria-current="page"]');
  const tab = doc.querySelector('nav.cm-tabs button[aria-current="page"]');
  return { page: page ? page.dataset.cmPage : '', tab: tab ? tab.dataset.cmTab : '' };
}
/** Open a page and tab of Config-Management through its menu and tab row; true when it is open. */
async function openCfg(page, tab) {
  const item = doc.querySelector(`.cm-nav .cm-item[data-cm-page="${page}"]`);
  if (!item) return false;
  // Leaving a tab with unsaved changes asks first; a case that left some behind is a bug in
  // the case (or the page), said here and answered No so nothing is lost and nothing hangs.
  const asked = () => {
    const m = [...doc.querySelectorAll('.modal')].find((x) => /Leave without saving/.test(x.textContent));
    if (!m) return false;
    ok(false, `config: leaving for ${page}/${tab} asked about unsaved changes: ${(doc.getElementById('cm-savebar') || {}).textContent}`);
    const no = [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === 'No');
    if (no) no.click();
    return true;
  };
  if (cfgOpen().page !== page) { item.click(); await settleFor(300); if (asked()) { await settleFor(100); return false; } }
  if (tab) {
    const t = doc.querySelector(`nav.cm-tabs button[data-cm-tab="${tab}"]`);
    if (t && t.getAttribute('aria-current') !== 'page') { t.click(); await settleFor(300); if (asked()) { await settleFor(100); return false; } }
  }
  const now = cfgOpen();
  return now.page === page && (!tab || now.tab === tab || !doc.querySelector('nav.cm-tabs'));
}
/** Open one by yesterday's label (CFG_HOME). */
async function openSettingsTab(label) {
  const home = CFG_HOME[label];
  return home ? openCfg(home[0], home[1]) : false;
}
/**
 * Press the save bar's "Save changes". A value set from code fires no input event, so the page
 * is told first, the way typing would; false when there was nothing to save (no bar).
 */
async function saveViaBar(wait = 400) {
  const body = doc.querySelector('#view .cm-body');
  if (body) body.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settleFor(30);
  const b = doc.querySelector('#cm-savebar:not([hidden]) button[data-act="save"]');
  if (b) { b.click(); await settleFor(wait); }
  return !!b;
}

await go('settings');
{
  // The menu is the page's table of contents: nine pages, each with its tabs named under it
  // and a state on the right; exactly one is open, and the address says which.
  const items = [...doc.querySelectorAll('.cm-nav .cm-item')];
  ok(items.length >= 6, `config: ${items.length} pages in the Config-Management menu, expected the board's nine (less what this core lacks)`);
  ok(items.filter((b) => b.getAttribute('aria-current') === 'page').length === 1, 'config: not exactly one page marked open');
  ok(!!doc.getElementById('cm-find'), 'config: no "Find a setting" box');
  ok(/Author:/.test((doc.querySelector('.cm-about') || {}).textContent || '') && !!doc.querySelector('.cm-about a[href$="/issues"]'),
    'config: the About card lacks the author or the Support link');
  ok(!/config_cluster\.json/.test((doc.querySelector('.cm-side') || {}).textContent || ''), 'config: the menu names the config file');
  // One page at a time, with its header and the tab row; switching moves the marker.
  ok(await openCfg('clusters', 'clusters'), 'config: Clusters does not open');
  const wasTitle = (doc.querySelector('.cm-head h1') || {}).textContent;
  ok(await openCfg('system', 'file'), 'config: System › Config file does not open');
  ok((doc.querySelector('.cm-head h1') || {}).textContent !== wasTitle, 'config: switching page left the old header');
  ok((window.location.hash || '') === '#/settings/system/file', `config: the address is ${window.location.hash}, not the open tab`);
  ok(!!doc.querySelector('.cm-danger') && doc.querySelector('.cm-body').lastElementChild.contains(doc.querySelector('.cm-danger')),
    'config: Forget file & credentials is not last, apart, in the danger zone');
  // "Find a setting": typing names the setting; choosing it opens its page and tab.
  const find = doc.getElementById('cm-find');
  find.value = 'watch window'; find.dispatchEvent(new window.Event('input', { bubbles: true }));
  const hit = doc.querySelector('.cm-find-hit');
  ok(hit && /Watch window/.test(hit.textContent) && /Requests › Policy/.test(hit.textContent), `config: Find a setting offered ${hit && hit.textContent}`);
  if (hit) { hit.click(); await settleFor(900); }
  ok(cfgOpen().page === 'requests' && cfgOpen().tab === 'policy', `config: the search result opened ${JSON.stringify(cfgOpen())}`);

  ok(await openSettingsTab('Alert triggers'), 'settings: no Alert triggers tab');
  const titles = [...doc.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.includes('Alert triggers'), `settings: no alert triggers card, saw ${titles.join(' | ')}`);

  const ar = await load('core/alert-rules.js');
  const card = [...doc.querySelectorAll('section.card')]
    .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Alert triggers');
  const rows = card ? card.querySelectorAll('table.tbl tbody tr[data-rule]').length : 0;
  ok(rows === ar.ALERT_RULES.length,
    `settings: ${rows} trigger rows for ${ar.ALERT_RULES.length} rules — the table must be the registry`);
  ok(card && card.querySelectorAll('tr.cm-grp').length >= 4, 'settings: the triggers are not grouped');

  // Every rule has a switch, and the ones with thresholds expose them as numbers.
  const boxes = card ? card.querySelectorAll('input[type=checkbox]').length : 0;
  ok(boxes === ar.ALERT_RULES.length, `settings: ${boxes} switches for ${ar.ALERT_RULES.length} rules`);
  const nums = card ? card.querySelectorAll('input[type=number]').length : 0;
  const expected = ar.ALERT_RULES.reduce((n, r) => n + (r.thresholds || []).length, 0);
  ok(nums === expected, `settings: ${nums} threshold inputs, expected ${expected}`);

  // It points at the one rule editor rather than being a second one.
  ok(card && /Automation/.test(card.textContent),
    'settings: the triggers card should send new-rule authoring to Automation');

  // A switch waits for Save now (it used to save at once): the bar names it, Discard puts it back.
  const sw = card && card.querySelector('input[type=checkbox]:not([disabled])');
  if (sw) {
    const was = sw.checked;
    sw.checked = !sw.checked; sw.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(200);
    const bar = doc.getElementById('cm-savebar');
    ok(bar && !bar.hidden && /1 unsaved change/.test(bar.textContent) && bar.textContent.includes(sw.dataset.label),
      `alerts: the save bar does not name the switch: ${bar && bar.textContent}`);
    const discard = bar && bar.querySelector('button[data-act="discard"]');
    if (discard) { discard.click(); await settleFor(200); }
    ok(doc.getElementById('cm-savebar').hidden, 'alerts: Discard left the save bar up');
    const again = doc.querySelector(`#${sw.id}`);
    ok(again && again.checked === was, 'alerts: Discard did not put the switch back');
  }

  // From a hosted tab (Alerts › Automation is the app's own #/automation page) a tab, a menu
  // item or a search result opens that tab of Config-Management, not its first page.
  await go('automation'); await settleFor(400);
  ok(cfgOpen().page === 'alerts' && cfgOpen().tab === 'automation', `hosted: #/automation is not Alerts › Automation (${JSON.stringify(cfgOpen())})`);
  const trig = doc.querySelector('nav.cm-tabs button[data-cm-tab="triggers"]');
  if (trig) { trig.click(); await settleFor(600); }
  ok(cfgOpen().page === 'alerts' && cfgOpen().tab === 'triggers', `hosted: Triggers from Automation opened ${JSON.stringify(cfgOpen())}`);
  await go('requests'); await settleFor(400);
  const find2 = doc.getElementById('cm-find');
  if (find2) { find2.value = 'watch window'; find2.dispatchEvent(new window.Event('input', { bubbles: true })); }
  const hit2 = doc.querySelector('.cm-find-hit');
  if (hit2) { hit2.click(); await settleFor(1200); }
  ok(cfgOpen().page === 'requests' && cfgOpen().tab === 'policy', `hosted: Find a setting from the Request Centre opened ${JSON.stringify(cfgOpen())}`);
  ok((doc.activeElement || {}).id === 'pol-watch', `hosted: Find a setting from the Request Centre did not focus the field (focus on ${(doc.activeElement || {}).id})`);

  // Leaving Config-Management by the page menu with unsaved changes asks first; No stays.
  await openSettingsTab('Defaults');
  const ri0 = doc.getElementById('ce-ri');
  if (ri0) {
    ri0.value = String(Number(ri0.value || 30) + 7); ri0.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(50);
    const alertsTab = doc.querySelector('#nav button[data-page="alerts"]');
    if (alertsTab) { alertsTab.click(); await settleFor(300); }
    const ask = [...doc.querySelectorAll('.modal')].find((m) => /Leave without saving/.test(m.textContent));
    ok(!!ask, 'leave: the page menu left Config-Management with unsaved changes and did not ask');
    const no = ask && [...ask.querySelectorAll('button')].find((b) => b.textContent.trim() === 'No');
    if (no) { no.click(); await settleFor(300); }
    ok(cfgOpen().page === 'system' && cfgOpen().tab === 'defaults' && (window.location.hash || '') === '#/settings/system/defaults',
      `leave: answering No did not stay on System › Defaults (${JSON.stringify(cfgOpen())}, ${window.location.hash})`);
    const discard2 = doc.querySelector('#cm-savebar button[data-act="discard"]');
    if (discard2) { discard2.click(); await settleFor(200); }
  }

  // A page that was left lets go of #view: a loader answering afterwards paints nothing over the next page.
  await openSettingsTab('Zabbix');
  await go('overview'); await settleFor(1500);
  ok(!doc.querySelector('#view .cm'), 'late loader: Config-Management was painted over the Clusters page');
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
  const labels = [...doc.querySelectorAll('.cm-nav .cm-item, nav.cm-tabs button')].map((b) => b.textContent);
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
    ok(await saveViaBar(120), 'settings: the save bar did not come up for the scheduled measurement');
    ok(lastSet === null, 'settings: saving with no cluster picked was sent to the core anyway');

    // With a destination and a cluster that is not the destination, what is sent is what
    // was on the screen. (Measuring only the sink is refused too; the card says so.)
    const target = card.querySelector('#sink-target');
    const dest = config.clusters[config.clusters.length - 1].id;
    target.value = dest;
    const first = card.querySelector(`#sink-pick-${config.clusters[0].id}`);
    if (first) first.checked = true;
    card.querySelector('#sink-everyHours').value = '6';
    await saveViaBar(200);
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

/* ------------- the history store card, and the delay card's destination ------------- */

await go('settings');
{
  const labels = [...doc.querySelectorAll('.cm-nav .cm-item, nav.cm-tabs button')].map((b) => b.textContent);
  ok(!labels.some((l) => /History store|Backend/.test(l)),
    `settings: the History store tab appeared on a loopback (portable) bridge: ${labels.join(' | ')}`);
}

{
  const realFetch = globalThis.fetch;
  const sent = [];
  let lastDelaySet = null;
  const hist = {
    supported: true,
    settings: { url: 'https://history.example:9200', auth: 'basic', user: 'ep', passwordSet: true, passwordStale: false,
                tls: 'auto', via: '', prefix: 'elasticpro-history', streams: { volume: true, capacity: true, delay: true } },
    armed: false, permitted: false, permitHint: 'set HISTORY_STORE_WRITES=true in config.txt',
    test: null, armBlocked: 'set HISTORY_STORE_WRITES=true in config.txt',
    status: { lastSuccessAt: null, lastError: null, lastErrorAt: null, docsWritten: 0, queue: 0, templateAt: null, backfill: null },
    jumpHosts: [],
  };
  const routingStub = { backup: false, refuse: null, routing: { history: 'copy', reports: 'builtin', alerts: 'builtin', reportFiles: false, changedBy: null, changedAt: null } };
  const MODES_STUB = [{ id: 'builtin', label: 'ElasticPro built-in' }, { id: 'copy', label: 'ElasticPro + Elasticsearch (copy)' }, { id: 'es', label: 'Elasticsearch only' }];
  const routingReply = (withStatus) => {
    const r = routingStub.routing;
    const out = { ok: true, supported: true, routing: { ...r }, modes: MODES_STUB, store: { configured: true, armed: false, writing: 'Write history is off' } };
    if (!withStatus) return out;
    const kinds = {};
    for (const k of ['history', 'reports', 'alerts']) {
      const mode = r[k];
      const onStore = mode !== 'builtin';
      kinds[k] = {
        mode, label: mode, state: mode === 'builtin' ? 'builtin' : mode === 'es' ? 'queued' : 'paused',
        line: mode === 'builtin' ? 'ElasticPro built-in only' : 'waiting for the store',
        keptFor: { builtin: k === 'history' ? '13 months' : 'as today', store: "owner's ILM" },
        // reports: the built-in size could not be read; unknown must not read as 0
        builtin: { size: { bytes: k === 'reports' ? null : 820000000, files: 3, truncated: false } },
        store: { docs: null, docsNote: onStore ? 'the store did not answer' : 'kept built-in', queued: onStore ? 7 : 0, dropped: 0, writing: !onStore, why: onStore ? 'Write history is off' : null },
      };
    }
    return { ...out, builtin: { dir: '/var/lib/elasticpro', size: { bytes: 1073741824, files: 40, truncated: false }, diskTotal: 500e9, diskFree: 212e9 }, kinds };
  };
  const delayStub = {
    supported: true,
    config: { enabled: false, sinkClusterId: '', clusters: [], everyHours: 2, indexPrefix: 'elasticpro-log-delay',
              indexPattern: 'logstash-*', deviceField: 'src_hostname.keyword', arrivalField: '@timestamp',
              eventTimeFields: ['ingested_time'], maxDevices: 2000 },
    state: { runs: 0, lastOk: false, lastMeasured: 0, lastFailed: 0, consecutiveFailures: 0 },
    blocked: null,
    historyStore: { configured: true, armed: false, permitted: false },
  };
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const t = String(body.type || '');
    if (t.startsWith('HISTORY_STORE')) {
      sent.push(body);
      if (t === 'HISTORY_STORE_TEST') {
        hist.test = { at: Date.now(), by: 'admin', ok: true, current: true, version: '8.15.0', clusterName: 'history-es',
                      securityEnabled: true, privileges: { create_doc: true, create_index: true, read: null }, message: null };
        if (hist.permitted) hist.armBlocked = null;
      }
      if (t === 'HISTORY_STORE_ARM') { hist.armed = !!body.on; }
      return stubReply({ ok: true, ...hist });
    }
    if (t === 'PING') {
      // The hosted core also says it routes its records (docs/HANDBOOK.md "Backend — the message contract").
      const r = await realFetch(input, init);
      let j = {};
      try { j = JSON.parse(await r.text()); } catch (_) { return r; }
      // Backup support is stated here, not inherited from whatever core the check runs against.
      return stubReply({ ...j, dataRouting: { supported: true }, backup: { supported: routingStub.backup === true } });
    }
    if (t.startsWith('DATA_ROUTING')) {
      sent.push(body);
      if (t === 'DATA_ROUTING_SET') {
        if (routingStub.refuse) return stubReply({ ok: false, kind: 'bad_request', message: routingStub.refuse });
        Object.assign(routingStub.routing, body.routing, { changedBy: 'admin', changedAt: Date.now() });
      }
      return stubReply(routingReply(t === 'DATA_ROUTING_STATUS'));
    }
    if (t.startsWith('DELAY_SINK')) {
      if (t === 'DELAY_SINK_SET') { lastDelaySet = body.config; return stubReply({ ok: true, ...delayStub, config: body.config }); }
      return stubReply({ ok: true, ...delayStub });
    }
    return realFetch(input, init);
  };

  await go('overview');
  await go('settings');
  await settleFor(400);

  ok(await openSettingsTab('History store'), 'settings: no History store tab on a hosted core');
  const hcard = () => [...doc.querySelectorAll('section.card')]
    .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Elasticsearch cluster');
  const click = async (c, label) => {
    [...c.querySelectorAll('button')].find((b) => b.textContent === label).click();
    await settleFor(250);
  };
  ok(!!hcard(), 'settings: no Elasticsearch cluster card on a hosted core');
  if (hcard()) {
    // Changing the kind of credential redraws the card; the change still counts for the save bar.
    {
      const au = hcard().querySelector('#hs-auth');
      if (au) {
        au.value = 'none'; au.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(200);
        const bar = doc.getElementById('cm-savebar');
        ok(bar && !bar.hidden && /Auth/.test(bar.textContent), `history: Basic → None is not on the save bar: ${bar && bar.textContent}`);
        const d = bar && bar.querySelector('button[data-act="discard"]');
        if (d) { d.click(); await settleFor(250); }
      }
    }
    let c = hcard();
    // Never pre-filled: the password field is empty and says only that one is held.
    const pw = c.querySelector('#hs-password');
    ok(pw && pw.value === '' && /set/.test(pw.getAttribute('placeholder') || ''),
      'history: the password field is pre-filled or does not say one is held');
    const arm = () => hcard().querySelector('#hs-arm');
    ok(arm().disabled, 'history: Write history is switchable while writes are not permitted');
    ok(/set HISTORY_STORE_WRITES=true in config\.txt/.test(hcard().textContent),
      'history: the reason does not name HISTORY_STORE_WRITES in config.txt');
    ok(hcard().querySelector('#hs-backfill').disabled, 'history: Copy existing history is enabled while not armed');

    await click(c, 'Test connection');
    c = hcard();
    ok(sent.some((m) => m.type === 'HISTORY_STORE_TEST'), 'history: Test connection sent nothing');
    const res = (c.querySelector('#hs-test-result') || {}).textContent || '';
    ok(/8\.15\.0/.test(res) && /history-es/.test(res), `history: the test result lacks version and cluster: ${res}`);
    ok(/create_doc[^:]*: yes/.test(res) && /read[^:]*: not checked/.test(res),
      `history: the privilege lines are wrong: ${res}`);

    // Permitted and tested: the switch is usable, and pressing it sends ARM {on:true}.
    hist.permitted = true; hist.permitHint = null; hist.armBlocked = null;
    await click(c, 'Test connection');
    ok(!arm().disabled, 'history: Write history is still disabled once permitted and tested');
    sent.length = 0;
    arm().click();
    await settleFor(250);
    const armMsg = sent.find((m) => m.type === 'HISTORY_STORE_ARM');
    ok(armMsg && armMsg.on === true, `history: pressing the switch sent ${JSON.stringify(armMsg)}`);
    ok(!hcard().querySelector('#hs-backfill').disabled, 'history: Copy existing history stays disabled when armed');
    sent.length = 0;
    await click(hcard(), 'Copy existing history');
    ok(sent.some((m) => m.type === 'HISTORY_STORE_BACKFILL'), 'history: Copy existing history sent nothing');
    sent.length = 0;
    // Save is the page's save bar now: it comes up for a change, and sends the form.
    hcard().querySelector('#hs-prefix').value = 'elasticpro-history-x';
    ok(await saveViaBar(250), 'history: the save bar did not come up for a changed prefix');
    const setMsg = sent.find((m) => m.type === 'HISTORY_STORE_SET');
    ok(setMsg && setMsg.settings.url === hist.settings.url && !('password' in setMsg.settings),
      `history: Save sent ${JSON.stringify(setMsg)} (an empty password must be left out)`);
  }

  // Data > Backend: where each kind of data goes, and the built-in card.
  {
    const rcard = () => [...doc.querySelectorAll('section.card')]
      .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Where each kind of data goes');
    await settleFor(300);
    ok(!!rcard(), 'backend: no "Where each kind of data goes" card on a core that routes its records');
    const sel = (k) => doc.getElementById(`dr-mode-${k}`);
    // A value set from code fires no input event: tell the page, as typing would, without pressing Save.
    const openBar = async () => { const body = doc.querySelector('#view .cm-body'); if (body) body.dispatchEvent(new window.Event('input', { bubbles: true })); await settleFor(60); };
    if (rcard()) {
      ok(rcard().querySelectorAll('tbody tr').length === 3, 'backend: the table does not have History, Reports and Alerts rows');
      ok(sel('history').value === 'copy' && sel('reports').value === 'builtin' && sel('alerts').value === 'builtin',
        `backend: the selects show ${['history', 'reports', 'alerts'].map((k) => sel(k).value)}`);
      ok([...sel('alerts').options].map((o) => o.textContent).join('|') === 'ElasticPro built-in|ElasticPro + Elasticsearch (copy)|Elasticsearch only',
        'backend: the Kept in options are not the board\'s three');
      const reportsRow = rcard().querySelector('tr[data-kind="reports"]');
      ok(/unknown/.test(reportsRow.querySelector('[data-cell="size"]').textContent) && !/\b0 B\b/.test(reportsRow.textContent),
        `backend: an unreadable size is not shown as unknown: ${reportsRow.textContent}`);
      ok(![...rcard().querySelectorAll('button')].some((b) => /save/i.test(b.textContent)), 'backend: the card has its own Save button');
      ok(!doc.getElementById('dr-reportFiles'), 'backend: the report file switch shows while reports are built-in');
      ok(!!doc.getElementById('dr-changed') && /history follows/i.test(doc.getElementById('dr-changed').textContent),
        'backend: an unsaved routing does not say history follows the store');
      const bcard = [...doc.querySelectorAll('section.card')].find((x) => (x.querySelector('header h2') || {}).textContent === 'ElasticPro built-in');
      ok(bcard && /1\.00 GB/.test(bcard.textContent) && /free on that disk/.test(bcard.textContent), `backend: the built-in card lacks size and free space: ${bcard && bcard.textContent}`);
      ok(bcard && !bcard.querySelector('#dr-backup-link'), 'backend: a Backed up link shows while PING says backup.supported is false');

      // Reports to the store: the switch and its warning appear; the save bar names the change.
      sel('reports').value = 'copy'; sel('reports').dispatchEvent(new window.Event('change', { bubbles: true }));
      sel('alerts').value = 'es'; sel('alerts').dispatchEvent(new window.Event('change', { bubbles: true }));
      await settleFor(250);
      ok(!!doc.getElementById('dr-reportFiles') && /reports-\*/.test(doc.getElementById('dr-reportfiles-note').textContent),
        'backend: the report file switch and its note did not appear for reports on the store');
      await openBar();
      const bar = doc.getElementById('cm-savebar');
      ok(bar && !bar.hidden && /Reports kept in/.test(bar.textContent) && /Alerts kept in/.test(bar.textContent),
        `backend: the save bar does not name the routing changes: ${bar && bar.textContent}`);
      // A refusal is shown plainly and nothing is lost.
      routingStub.refuse = 'the history store is not configured';
      sent.length = 0;
      await saveViaBar(300);
      ok(sent.some((m) => m.type === 'DATA_ROUTING_SET'), 'backend: Save sent no DATA_ROUTING_SET');
      ok(/history store is not configured/.test((doc.getElementById('dr-refusal') || {}).textContent || ''), 'backend: the core\'s refusal is not shown');
      ok(sel('alerts').value === 'es', 'backend: a refused save lost what was chosen');
      // Accepted: only the changed fields travel, the bar goes, the warning shows for es + not writing.
      routingStub.refuse = null;
      sent.length = 0;
      await saveViaBar(400);
      const setMsg = sent.find((m) => m.type === 'DATA_ROUTING_SET');
      ok(setMsg && JSON.stringify(setMsg.routing) === JSON.stringify({ reports: 'copy', alerts: 'es' }), `backend: Save sent ${JSON.stringify(setMsg)}`);
      ok(doc.getElementById('cm-savebar').hidden, 'backend: the save bar stays up after a saved routing');
      ok(/Not writing to Elasticsearch/.test((doc.getElementById('dr-es-warning') || {}).textContent || ''), 'backend: Elasticsearch only with a closed store shows no warning');
      // Discard returns the choice.
      sel('alerts').value = 'builtin'; sel('alerts').dispatchEvent(new window.Event('change', { bubbles: true }));
      await settleFor(200);
      ok(!!doc.getElementById('dr-letgo'), 'backend: setting a kind back to built-in does not say it lets go of the queue');
      await openBar();
      const d2 = doc.querySelector('#cm-savebar:not([hidden]) button[data-act="discard"]');
      if (d2) { d2.click(); await settleFor(250); }
      ok(sel('alerts').value === 'es', 'backend: Discard did not return the saved choice');
    }
  }

  // The same card on a core that can take backups: the link is there and goes to Backup & restore.
  {
    routingStub.backup = true;
    await go('overview');
    await go('settings');
    await settleFor(300);
    ok(await openSettingsTab('History store'), 'backend: the Backend tab did not open on a backup-capable core');
    await settleFor(300);
    const bcard = [...doc.querySelectorAll('section.card')].find((x) => (x.querySelector('header h2') || {}).textContent === 'ElasticPro built-in');
    const link = bcard && bcard.querySelector('#dr-backup-link');
    ok(!!link, 'backend: no Backed up link while PING says backup.supported is true');
    ok(link && link.getAttribute('href') === '#/settings/system/backup', `backend: the Backed up link goes to ${link && link.getAttribute('href')}`);
    routingStub.backup = false;
  }

  // The delay card: the monitored cluster unless the admin says otherwise.
  ok(await openSettingsTab('Scheduled log delay'), 'settings: no scheduler tab on a hosted core');
  const dcard = [...doc.querySelectorAll('section.card')]
    .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Scheduled log delay');
  ok(!!dcard, 'settings: no scheduled log delay card on a hosted core');
  if (dcard) {
    const dest = dcard.querySelector('#sink-destination');
    ok(dest && dest.value === 'cluster', `settings: the destination defaults to ${dest && dest.value}, expected the monitored cluster`);
    ok(!dcard.querySelector('#sink-history-warn'), 'settings: a history warning shows while the destination is a cluster');
    if (dest) {
      dest.value = 'history';
      dest.dispatchEvent(new window.Event('change', { bubbles: true }));
      dcard.querySelector('#sink-enabled').checked = true;
      [...dcard.querySelectorAll('input[id^="sink-pick-"]')].forEach((b, i) => { b.checked = i === 0; });
      await saveViaBar(250);
      ok(lastDelaySet && lastDelaySet.destination === 'history',
        `settings: the destination travelled as ${lastDelaySet && lastDelaySet.destination}, expected history`);
      const again = [...doc.querySelectorAll('section.card')]
        .find((sec) => (sec.querySelector('header h2') || {}).textContent === 'Scheduled log delay');
      ok(again && /not permit|switched off|not configured/.test((again.querySelector('#sink-history-warn') || {}).textContent || ''),
        'settings: no warning while the history store is not armed');
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
      ok(detailRow && /Endpoint/.test(detailRow.textContent) && /Snapshot repositories/.test(detailRow.textContent) && /Shard allocation/.test(detailRow.textContent),
        'overview: the opened row does not show the details (Endpoint, shard allocation, Snapshot repositories)');
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
    ok(!!panel('Repositories') && !doc.querySelector('input[aria-label="Search snapshots"]'), 'name menu → Repo: the repositories view is not the one open');
    await go2('Live log');
    ok(/#\/logs$/.test(window.location.hash) && st.state.selected === target.id, `name menu → Live log: at ${window.location.hash}, selected ${st.state.selected}`);
    await go2('Edit');
    const dlg = doc.querySelector('.modal-overlay .modal');
    ok(dlg && /Edit cluster/.test(dlg.textContent), 'name menu → Edit: the cluster editor did not open');
    if (dlg) { const cancel = [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'); press(cancel); await settleFor(150); }
    // A role that may not change clusters is not offered Edit, nor "+ Add cluster".
    st.state.caller = { name: 'columns-check', role: 'user' };
    await go('overview');
    menu = await openMenu();
    ok(menu && ![...menu.querySelectorAll('button[role=menuitem]')].some((b) => b.children[1].textContent === 'Edit'), 'name menu: Edit offered to a role that cannot edit');
    key('Escape'); await settleFor(60);
    ok(!doc.getElementById('cl-add'), 'overview: "+ Add cluster" offered to a user');
    // An operator is offered both (the core's CLUSTER_SAVE is theirs), but the dialog has
    // no Remove and no credential fields: those stay an admin's. Saving goes to the core,
    // which this dev bridge (no config file) refuses — and the refusal is shown, not swallowed.
    st.state.caller = { name: 'columns-check', role: 'operator' };
    await go('overview');
    ok(!!doc.getElementById('cl-add'), 'overview: no "+ Add cluster" for an operator');
    menu = await openMenu();
    const editItem = menu && [...menu.querySelectorAll('button[role=menuitem]')].find((b) => b.children[1].textContent === 'Edit');
    ok(!!editItem, 'name menu: no Edit for an operator');
    if (editItem) {
      press(editItem); await settleFor(300);
      const od = doc.querySelector('.modal-overlay .modal');
      ok(od && /Edit cluster/.test(od.textContent), 'operator: the cluster editor did not open');
      if (od) {
        const labels = [...od.querySelectorAll('button')].map((b) => b.textContent);
        ok(!labels.includes('Remove'), 'operator: Remove is offered');
        ok(!od.querySelector('#ce-cp') && !od.querySelector('#ce-cu'), 'operator: credential fields are offered');
        ok(!!od.querySelector('.ce-managed-cred'), 'operator: the dialog does not say the credential is an administrator\'s');
        const save = [...od.querySelectorAll('button')].find((b) => b.textContent === 'Save');
        press(save); await settleFor(600);
        const still = doc.querySelector('.modal-overlay .modal');
        const said = still ? ((still.querySelector('.modal-msg') || {}).textContent || '') : '';
        ok(still && /Save failed/.test(said), `operator: a refused CLUSTER_SAVE was not shown in the dialog (${said || 'closed'})`);
        const cancel = still && [...still.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'); if (cancel) { press(cancel); await settleFor(150); }
      }
    } else { key('Escape'); await settleFor(60); }
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
      // page lists and the scraper sends to Zabbix. proxy-03 is past the red line (over 60 min)
      // in the fixture, which is a High alert since 2026-11-01, not a critical one.
      const stNow = await load('core/state.js');
      const late = stNow.alerts().filter((a) => /:log-delay$/.test(a.key));
      ok(late.length === measurable && late.every((a) => a.level === 'high'),
        `log delay should raise one High alert per measured cluster: ${JSON.stringify(late.map((a) => [a.key, a.level]))}`);

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
  { const o = doc.querySelector('tr[data-repo="daily"] button[data-act="open-repo"]'); if (o) { o.click(); await settleFor(200); } }
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
  ok(dlg && /Follows Zabbix at each sign-in — the role map on this page says what each Zabbix role becomes\. Changing it here pins it\./.test(dlg.textContent),
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
  // The two-second re-read touches only what changed (0.3.54 flicker pass): the tabs and the
  // emergency stop are the same elements after it, and a filter shows the choice made — the
  // options were built with selected: '' (a false property), so every redraw showed the first.
  {
    const tabBtn = doc.querySelector('nav.rq-tabs button');
    const resultSel = [...doc.querySelectorAll('#view .toolbar select')].find((x) => [...x.options].some((o) => o.value === 'refused'));
    ok(!!resultSel, 'requests: no Result filter');
    if (resultSel) {
      resultSel.value = 'ok'; resultSel.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settleFor(2600);
      const again = [...doc.querySelectorAll('#view .toolbar select')].find((x) => [...x.options].some((o) => o.value === 'refused'));
      ok(again && again.value === 'ok', `requests: after a re-read the Result filter shows "${again && again.value}", not the choice made`);
      again.value = 'all'; again.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settleFor(300);
    }
    ok(tabBtn && tabBtn.isConnected && doc.querySelector('nav.rq-tabs button') === tabBtn, 'requests: the re-read rebuilt the tabs');
  }
  await go('overview'); const after = sent.filter((m) => m.type === 'REQUEST_LOG').length; await settleFor(2600);
  ok(sent.filter((m) => m.type === 'REQUEST_LOG').length === after, 'requests: the log is still being re-read after leaving the page');
}

// Requests › ElasticPro health (docs/HEALTH.md): an administrator's tab, read from SYSTEM_HEALTH
// every 5 s while open — the log is not read meanwhile and no cluster is ever asked; an amber or
// red line carries its fix; a part that cannot report says "not known"; leaving stops the read;
// an operator is not offered the tab, even at its address.
{
  const before = globalThis.fetch;
  const hsent = [];
  const now = Date.now();
  const snap = {
    ok: true, at: now, role: 'all', level: 'bad',
    thresholds: [{ id: 'memory', check: 'Resident memory of limit (core, worker)', amber: '≥ 80%', red: '≥ 90%, or an OOM kill in 24 h' }],
    checks: [
      { id: 'core.memory', threshold: 'memory', label: 'Core memory of limit', level: 'bad', value: '93% · 952 MiB of 1.0 GiB',
        text: 'Core is at 93% of its memory limit: close to being OOM-killed.', fix: 'Raise CORE_MEM_LIMIT in config.txt (ELASTICPRO_MEM_LIMIT in deploy/.env) and redeploy; or lower ELASTICPRO_CACHE_MB.' },
      { id: 'gate.refused', threshold: 'gate', label: 'Requests turned away (5 min)', level: 'warn', value: '3',
        text: '3 request(s) from people were refused by the gate.', fix: 'Raise ES_QUEUE_MAX / ES_QUEUE_WAIT_MS in config.txt.' },
      { id: 'disk.free', threshold: 'disk', label: 'Data volume free', level: 'unknown', value: 'not known', text: 'The data volume’s space cannot be read.', fix: null },
    ],
    parts: [
      { id: 'core', label: 'Core', level: 'bad', text: '0.3.54 · up 3 h', at: now - 3 * 3600e3 },
      { id: 'worker', label: 'Report worker', level: 'off', text: 'not deployed — role all: this container runs reports and collection itself', at: null },
      { id: 'database', label: 'Database', level: 'unknown', text: 'not known — the core does not connect to it', at: null },
    ],
    core: {
      version: '0.3.54', uptimeSec: 10800,
      memory: { rssBytes: 998244352, limitBytes: 1073741824, usedPct: 93, limitSource: 'cgroup v2', peakBytes24h: 1010000000, oomKills: 0, oomKills24h: 0 },
      budget: { cache: { budgetBytes: 268435456, usedBytes: 100000000 }, inflight: { budgetBytes: 268435456, usedBytes: 0 }, readCache: { budgetBytes: 67108864, usedBytes: 1000 }, reports: null },
      cpu: { pct1m: 40, limitCpus: null, throttledPct5m: null, nrPeriods: null },
      messages: { w5m: { all: { count: 10, errors: 0, p50Ms: 5, p95Ms: 50, p99Ms: 100 }, own: { count: 9, errors: 0, p95Ms: 25 }, byType: [] },
        w1h: { all: { count: 100 }, own: { count: 90 }, byType: [{ type: 'PING', count: 90, errors: 0, p50Ms: 2, p95Ms: 5, p99Ms: 10 }] },
        slowest: [{ type: 'FLEET_STATE', count: 3, errors: 0, p50Ms: 25, p95Ms: 100, p99Ms: 100 }], sessions: 2, eventStreams: 1 },
      gate: { label: 'core', slotsInUse: 1, slots: 24, perCluster: 4, perJump: 8, backgroundReserve: 2,
        classes: [{ class: 'interactive', running: 1, waiting: 0, waitP95Ms: 0, overloaded5m: 3, queueTimeout5m: 0, overloaded1h: 3, queueTimeout1h: 0 }],
        clusters: [{ cluster: 'c1', running: 1, waiting: 0, sent5m: 12, upstreamP95Ms: 340, timeouts5m: 0, rejected5m: 2 }] },
      poller: { enabled: true, stopped: false, clusters: 2, down: 0, tracked: 20, due: 1, late: 0, latePct: 0, cycleMs: 3, cycleP95Ms: 9 },
      disk: null, lastPrune: null,
    },
    worker: { state: 'not_deployed', level: 'off', text: 'not deployed — role all: this container runs reports and collection itself', status: null },
    reports: { source: 'core', running: [{ id: 'j1', kind: 'hosts', clusterName: 'c1', progress: { done: 1, total: 4 }, day: '2026-11-03', concurrency: 2, halvings: 1, lastReason: '429 from c1' }],
      queued: 0, queuedJobs: [], collection: [], schedules: [{ kind: 'volume', enabled: false, recipients: 0, nextAt: null, lastSent: null }], lastJob: {} },
    trends: { fields: ['t', 'rss', 'p95Ms', 'waiting', 'workerRss', 'workerConcurrency'], points: [[now - 120e3, 900e6, 20, 0, null, null], [now - 60e3, 950e6, 25, 0, null, null]] },
  };
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    hsent.push(body);
    if (body.type === 'SYSTEM_HEALTH') return stubReply(snap);
    return before(input, init);
  };
  const count = (t) => hsent.filter((m) => m.type === t).length;
  try {
    await go('requests'); await settleFor(400);
    const tab = doc.querySelector('nav.rq-tabs button[data-tab="health"]');
    ok(!!tab, 'health: no "ElasticPro health" tab on the Request Centre');
    if (tab) {
      tab.click(); await settleFor(700);
      ok(window.location.hash === '#/requests/health', `health: the tab is not at #/requests/health (${window.location.hash})`);
      ok(count('SYSTEM_HEALTH') >= 1, 'health: opening the tab did not read SYSTEM_HEALTH');
      ok(!hsent.some((m) => m.type === 'ES'), 'health: the tab sent a cluster something');
      const fix = doc.querySelector('tr[data-check="core.memory"] .hl-fix');
      ok(fix && /CORE_MEM_LIMIT/.test(fix.textContent), `health: the red memory line carries no fix: ${fix && fix.textContent}`);
      ok(doc.querySelector('tr[data-check="gate.refused"].hl-row-warn .hl-fix'), 'health: the amber gate line is not marked or has no fix');
      const db = doc.querySelector('.hl-chip[data-part="database"]');
      ok(db && /not known/.test(db.textContent) && !db.querySelector('.hl-dot.green'), `health: a part that cannot report is not "not known": ${db && db.textContent}`);
      const wk = doc.querySelector('.hl-chip[data-part="worker"]');
      ok(wk && /not deployed — role all/.test(wk.textContent), 'health: no worker chip saying not deployed');
      ok(/not known — this core has no reports share/.test(doc.body.textContent), 'health: the reports share is not said to be not known');
      ok(/2 \(halved 1×: 429 from c1\)/.test(doc.body.textContent), 'health: a running job does not show its concurrency and halvings');
      ok(doc.querySelector('.hl-spark polyline'), 'health: no trend drawn from two samples');
      const logs = count('REQUEST_LOG'), reads = count('SYSTEM_HEALTH');
      // A re-read whose answer did not change touches nothing (0.3.54 flicker pass): the row under
      // the mouse is the same row, and a fold opened stays open.
      const memRow = doc.querySelector('tr[data-check="core.memory"]');
      const chip = doc.querySelector('.hl-chip[data-part="core"]');
      const fold = doc.querySelector('.hl-page details[data-fold="thresholds"]');
      if (fold) { fold.open = true; fold.dispatchEvent(new window.Event('toggle')); }
      await settleFor(5300);
      ok(doc.querySelector('tr[data-check="core.memory"]') === memRow && memRow.isConnected, 'health: an unchanged re-read replaced the check rows');
      ok(doc.querySelector('.hl-chip[data-part="core"]') === chip, 'health: an unchanged re-read replaced the status chips');
      const foldNow = doc.querySelector('.hl-page details[data-fold="thresholds"]');
      ok(foldNow && foldNow.open, 'health: the Thresholds fold closed on a re-read');
      ok(count('REQUEST_LOG') === logs, 'health: the request log is still read while the health tab is open');
      ok(count('SYSTEM_HEALTH') > reads, 'health: the tab is not read again after 5 s');
      // Back to the log tab, then away: the health read stops.
      doc.querySelector('nav.rq-tabs button[data-tab="log"]').click(); await settleFor(500);
      ok(window.location.hash === '#/requests' && doc.querySelector('.rq-tbl, .rq-tiles'), 'health: the Requests tab did not come back');
      await go('overview');
      const left = count('SYSTEM_HEALTH');
      await settleFor(5300);
      ok(count('SYSTEM_HEALTH') === left, 'health: SYSTEM_HEALTH is still read after leaving the page');
    }
    // An operator: no tab, not even at its address, and nothing asked.
    const st = await load('core/state.js');
    const was = st.state.caller;
    try {
      st.state.caller = { name: 'olga', role: 'operator' };
      await go('overview');
      window.history.replaceState(null, '', '#/requests/health');
      const from = count('SYSTEM_HEALTH');
      app.go('requests'); await settleFor(600);
      ok(!doc.querySelector('nav.rq-tabs'), 'health: an operator is offered the Request Centre tabs');
      ok(count('SYSTEM_HEALTH') === from, 'health: an operator\'s page read SYSTEM_HEALTH');
      await go('overview');
    } finally {
      st.state.caller = was;
    }
  } finally {
    globalThis.fetch = before;
  }
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
  const tab = (label) => (CFG_HOME[label] && doc.querySelector(`.cm-nav .cm-item[data-cm-page="${CFG_HOME[label][0]}"]`)
    ? { click: () => openSettingsTab(label) } : null);
  const countOf = (type) => sent.filter((m) => m.type === type).length;
  const fire = async () => { for (const c of config.clusters) bus.emit('data', c.id); await settleFor(700); };
  const trust = tab('Jump hosts & trust');
  ok(!!trust, 'config: no Jump hosts & trust tab');
  if (trust) {
    await trust.click(); await settleFor(300);
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
    await zbx.click(); await settleFor(300);
    const asked = countOf('ZABBIX_CLUSTERS');
    const url = doc.querySelector('#zl-zurl');
    const was = url ? url.value : '';
    if (url) { url.value = 'https://zabbix.typing.test'; }
    await fire();
    ok(countOf('ZABBIX_CLUSTERS') === asked, 'config: a fleet event re-asked ZABBIX_CLUSTERS');
    if (url) ok(doc.querySelector('#zl-zurl') === url && url.value === 'https://zabbix.typing.test',
      'config: a fleet event wiped the Zabbix form while it was being typed into');
    if (url) url.value = was;
  }
  // The one thing fleet data does change — a cluster's state pill — still updates in place.
  await tab('Clusters').click(); await settleFor(300);
  const shown = (await load('core/state.js')).clusters().length;   // enabled clusters only, like the table
  const pills = doc.querySelectorAll('td[data-cluster-state]');
  ok(pills.length === shown, `config: ${pills.length} state pills for ${shown} clusters`);
}

// Config › Zabbix › roles from user groups and Zabbix users (ui/zabbix-roles.js, docs/ROLES.md).
// The dev bridge has no Zabbix, so the core's ZABBIX_ROLEMAP_* / ZABBIX_USERS / USER_SET_ROLE /
// USER_UNPIN_ROLE are a small stateful fake here; everything else goes to the real bridge.
{
  const zr = await load('ui/zabbix-roles.js');
  const realFetch = globalThis.fetch;
  const live = [['7', 'Zabbix administrators'], ['3', 'NOC'], ['2', 'NOC leads'], ['5', 'ElasticPro admins'], ['9', 'Client A team'], ['12', 'Auditors'], ['13', 'Odd <b>name</b>']]
    .map(([usrgrpid, name]) => ({ usrgrpid, name, disabled: false }));
  const nowS = Math.floor(Date.now() / 1000);
  const core = {
    unknownMessage: false, refuseAdmin: false, usersErr: null, sent: [],
    map: { groups: { admin: ['ElasticPro admins'], operator: ['NOC leads'], user: ['NOC'], guest: ['Retired group'] }, unmapped: 'zabbixRole' },
    users: [
      { account: 'a.kumar@zabbix', username: 'a.kumar', known: true, groups: [{ id: '3', name: 'NOC', role: 'user' }, { id: '2', name: 'NOC leads', role: 'operator' }],
        zabbixRole: 'User role', fromGroups: { role: 'operator', source: 'group', via: 'NOC leads', matched: [{ group: 'NOC leads', role: 'operator' }, { group: 'NOC', role: 'user' }] },
        byHand: null, pinned: false, noAccess: false, inForce: 'operator', lastSignIn: nowS - 600 },
      { account: 'b.singh@zabbix', username: 'b.singh', known: true, groups: [{ id: '9', name: 'Client A team', role: null }], fromGroups: { role: 'user', source: 'zabbixRole', matched: [] },
        byHand: 'operator', pinned: true, noAccess: false, inForce: 'operator', lastSignIn: nowS - 3600 },
      { account: 'c.ops@zabbix', username: 'c.ops', known: true, groups: [{ id: '3', name: 'NOC', role: 'user' }], fromGroups: { role: 'user', source: 'group', matched: [{ group: 'NOC', role: 'user' }] },
        byHand: 'none', pinned: true, noAccess: true, inForce: 'none', lastSignIn: null },
      { account: 'gone.person@zabbix', username: 'gone.person', known: true, groups: [{ id: '13', name: 'Odd <b>name</b>', role: null }], fromGroups: { role: 'none', source: 'unmapped', matched: [] },
        byHand: null, pinned: false, noAccess: true, inForce: 'none', gone: true, lastSignIn: 1762345678,
        syncChange: { at: 1762345678, from: 'user', to: 'none', why: 'not in Zabbix any more' } },
      { account: 'absent@zabbix', username: 'absent', known: true, groups: [{ id: '3', name: 'NOC', role: 'user' }], fromGroups: { role: 'user', source: 'group', matched: [{ group: 'NOC', role: 'user' }] },
        byHand: null, pinned: false, noAccess: false, inForce: 'user', unverifiable: true, absentSyncs: 2, lastSignIn: 1762345678 },
      { account: 'lowered@zabbix', username: 'lowered', known: true, groups: [{ id: '3', name: 'NOC', role: 'user' }], fromGroups: { role: 'user', source: 'group', matched: [{ group: 'NOC', role: 'user' }] },
        byHand: null, pinned: false, noAccess: false, inForce: 'user', lastSignIn: 1762345678,
        syncChange: { at: 1762345678, from: 'operator', to: 'user', why: 'the highest of their Zabbix user groups now gives user (NOC)' } },
    ],
  };
  const mapJson = () => ({ groups: core.map.groups, unmapped: core.map.unmapped, names: {}, types: { 1: 'user', 2: 'operator', 3: 'admin' } });
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const t = body.type;
    if (!/^(ZABBIX_ROLEMAP_|ZABBIX_USERS|USER_SET_ROLE|USER_UNPIN_ROLE)/.test(String(t))) return realFetch(input, init);
    core.sent.push(body);
    if (core.unknownMessage && t.startsWith('ZABBIX_')) return stubReply({ ok: false, kind: 'unknown_message', message: `unknown message ${t}` });
    if (t === 'ZABBIX_ROLEMAP_GET') {
      return stubReply({ ok: true, roleMap: mapJson(), defaults: { groups: {}, unmapped: 'zabbixRole' }, file: true, groupMapSaved: true, zabbixGroups: live, zabbixGroupsError: null, zabbixRoles: [], zabbixError: null });
    }
    if (t === 'ZABBIX_ROLEMAP_SET') {
      if (core.refuseAdmin) return stubReply({ ok: false, kind: 'last_admin', message: 'the save would leave no administrator who can sign in (adminsAfter 0) (EP-109)' });
      core.map = { groups: body.roleMap.groups, unmapped: body.roleMap.unmapped };
      return stubReply({ ok: true, roleMap: mapJson(), keptVersion: 'v1', adminsAfter: 2, groupMapSaved: true });
    }
    if (t === 'ZABBIX_ROLEMAP_PREVIEW') {
      return stubReply({ ok: true, roleMap: body.roleMap, adminsAfter: core.refuseAdmin ? 0 : 2, lockout: core.refuseAdmin, groupsFrom: 'zabbix', zabbixError: null,
        changes: core.refuseAdmin ? [] : [{ account: 'a.kumar@zabbix', username: 'a.kumar', from: 'operator', to: 'user', source: 'group', via: 'NOC', groups: ['NOC'], disabled: false }] });
    }
    if (t === 'ZABBIX_USERS') {
      return stubReply({ ok: true, total: core.users.length, byHand: core.users.filter((u) => u.pinned).length, groupMapSaved: true,
        groupsFrom: core.usersErr ? 'lastSignIn' : 'zabbix', zabbixError: core.usersErr, users: core.users });
    }
    const u = core.users.find((x) => x.account === body.name);
    if (!u) return stubReply({ ok: false, kind: 'not_found', message: 'no such account' });
    if (t === 'USER_SET_ROLE') {
      u.pinned = true; u.byHand = body.role; u.inForce = body.role; u.noAccess = body.role === 'none';
      return stubReply({ ok: true, pinned: true, noAccess: u.noAccess, users: [] });
    }
    u.pinned = false; u.byHand = null; u.noAccess = false;
    return stubReply({ ok: true, users: [] });
  };
  const typeInto = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const changeTo = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const rolesCard = () => panel('ElasticPro roles from Zabbix user groups');
  const usersCard = () => panel('Zabbix users');
  const bar = () => doc.getElementById('cm-savebar');
  const barText = () => (bar() && !bar().hidden ? bar().textContent : '');
  const optionOf = (sel, text) => [...sel.options].find((o) => o.textContent === text);
  const addTo = (role, text) => { const s = rolesCard().querySelector(`select.zr-add[data-role="${role}"]`); const o = s && optionOf(s, text); if (o) changeTo(s, o.value); return !!o; };
  const rowOf = (name) => usersCard().querySelector(`tr[data-user="${name}@zabbix"]`);
  const sentOf = (type) => core.sent.filter((m) => m.type === type);
  const previewBtn = () => [...rolesCard().querySelectorAll('button')].find((b) => /Preview who changes/.test(b.textContent));
  const shownRows = () => [...usersCard().querySelectorAll('tr[data-user]')].map((r) => r.dataset.user).join();
  try {
    zr.forgetZabbixRoles();
    await go('settings');
    ok(await openCfg('zabbix', 'zabbix'), 'zabbix roles: could not open Config › Zabbix');
    await settleFor(500);
    ok(!!rolesCard() && !!usersCard(), 'zabbix roles: the two cards are not on Config › Zabbix when the core knows the group map');
    if (rolesCard() && usersCard()) {
      for (const c of [rolesCard(), usersCard()]) {
        ok(![...c.querySelectorAll('button')].some((b) => /^save/i.test(b.textContent.trim())), 'zabbix roles: a card has its own Save button (edits go through the one save bar)');
      }
      const rows = [...rolesCard().querySelectorAll('tr[data-role-row]')].map((r) => r.dataset.roleRow);
      ok(rows.join() === 'admin,operator,user,guest,unmapped', `zabbix roles: rows are ${rows.join()}`);
      ok(!!rolesCard().querySelector('tr[data-role-row="admin"] .zr-chip[data-group="ElasticPro admins"]'), 'zabbix roles: no ElasticPro admins chip under Admin');
      const retired = rolesCard().querySelector('tr[data-role-row="guest"] .zr-chip[data-group="Retired group"]');
      ok(retired && /unknown group/.test(retired.textContent), 'zabbix roles: a saved group Zabbix does not list is not marked "unknown group"');
      ok(!rolesCard().querySelector('tr[data-role-row="user"] .zr-chip[data-group="NOC"] .zr-warn'), 'zabbix roles: a listed group is marked unknown');
      ok(!barText(), 'zabbix roles: the save bar is showing before anything was changed');
      // "+ Add group" offers the groups no role has, and a group added shows in the bar.
      const sel = rolesCard().querySelector('select.zr-add[data-role="user"]');
      const offered = sel ? [...sel.options].map((o) => o.textContent) : [];
      ok(offered.includes('Client A team') && !offered.includes('NOC') && !offered.includes('ElasticPro admins'), `zabbix roles: + Add group offers ${offered.join(' | ')}`);
      ok(addTo('user', 'Client A team'), 'zabbix roles: Client A team is not offered');
      await settleFor(100);
      ok(!!rolesCard().querySelector('tr[data-role-row="user"] .zr-chip[data-group="Client A team"]'), 'zabbix roles: the added group did not become a chip');
      ok(/1 unsaved change/.test(barText()) && /User: \+ Client A team/.test(barText()), `zabbix roles: the bar says "${barText()}"`);
      // Preview asks the core about the draft, writes nothing, and lists who changes.
      const setsBefore = sentOf('ZABBIX_ROLEMAP_SET').length;
      press(previewBtn());
      await settleFor(300);
      const pv = rolesCard().querySelector('[data-zr="preview"]');
      ok(pv && /1 person changes/.test(pv.textContent) && /a\.kumar/.test(pv.textContent) && /Administrators able to sign in after: 2/.test(pv.textContent), `zabbix roles: preview reads "${pv && pv.textContent}"`);
      const pvMsg = sentOf('ZABBIX_ROLEMAP_PREVIEW').pop();
      ok(pvMsg && pvMsg.roleMap.groups.user.some((g) => g && g.id === '9' && g.name === 'Client A team'), 'zabbix roles: the preview did not send the chosen group as {id, name}');
      ok(sentOf('ZABBIX_ROLEMAP_SET').length === setsBefore, 'zabbix roles: previewing wrote the map');
      // Remove a chip: two changes; Save sends one SET and the bar clears.
      press(rolesCard().querySelector('.zr-chip[data-group="NOC leads"] .zr-x'));
      await settleFor(100);
      ok(/2 unsaved changes/.test(barText()) && /Operator: − NOC leads/.test(barText()), `zabbix roles: the bar says "${barText()}" after a removal`);
      ok(!rolesCard().querySelector('[data-zr="preview"]'), 'zabbix roles: a stale preview stayed after an edit');
      await saveViaBar();
      const set = sentOf('ZABBIX_ROLEMAP_SET').pop();
      ok(set && set.roleMap.groups.operator.length === 0 && set.roleMap.groups.user.length === 2 && set.roleMap.unmapped === 'zabbixRole', `zabbix roles: SET sent ${JSON.stringify(set && set.roleMap)}`);
      ok(!barText(), `zabbix roles: the bar stayed after a successful save: "${barText()}"`);
      // "In none of these", and a refused (last admin) save stays plainly on the card.
      const un = rolesCard().querySelector('select[data-zr="unmapped"]');
      ok(!!un, 'zabbix roles: no "In none of these" select');
      if (un) changeTo(un, 'none');
      await settleFor(100);
      ok(/In none of these: no access/.test(barText()), `zabbix roles: the bar says "${barText()}" for the unmapped rule`);
      press(rolesCard().querySelector('.zr-chip[data-group="ElasticPro admins"] .zr-x'));
      await settleFor(100);
      core.refuseAdmin = true;
      press(previewBtn());
      await settleFor(300);
      ok(/Refused: .*nobody able to sign in as an administrator/.test((rolesCard().querySelector('[data-zr="preview"]') || {}).textContent || ''), 'zabbix roles: a lock-out preview is not a plain refusal');
      await saveViaBar();
      const refusal = rolesCard().querySelector('[data-zr="refusal"]');
      ok(refusal && /Not saved: this would leave nobody able to sign in as an administrator/.test(refusal.textContent) && /EP-109/.test(refusal.textContent), `zabbix roles: refusal reads "${refusal && refusal.textContent}"`);
      ok(/unsaved change/.test(barText()), 'zabbix roles: a refused save dropped the changes');
      core.refuseAdmin = false;
      press(bar().querySelector('button[data-act="discard"]'));
      await settleFor(150);
      ok(!barText() && !!rolesCard().querySelector('.zr-chip[data-group="ElasticPro admins"]') && rolesCard().querySelector('select[data-zr="unmapped"]').value === 'zabbixRole', 'zabbix roles: Discard did not put the map back');
      // Untrusted names are text, never markup.
      ok(![...usersCard().querySelectorAll('b')].some((b) => b.textContent === 'name'), 'zabbix roles: a group name became markup');
      ok(/Odd <b>name<\/b>/.test(rowOf('gone.person').textContent), 'zabbix roles: a group name with markup is not shown as typed');

      // The people: badges and notes.
      ok(rowOf('b.singh') && rowOf('b.singh').querySelector('[data-badge="pinned"]'), 'zabbix users: b.singh has no pinned badge');
      ok(rowOf('c.ops').querySelector('[data-badge="pinned"]') && /no access by hand/.test(rowOf('c.ops').textContent), 'zabbix users: c.ops is not shown as No access by hand');
      ok(/not in Zabbix any more/.test((rowOf('gone.person').querySelector('[data-badge="gone"]') || {}).textContent || ''), 'zabbix users: no gone badge');
      ok(/absent 2 syncs/.test((rowOf('absent').querySelector('[data-badge="unverifiable"]') || {}).textContent || ''), 'zabbix users: no "absent 2 syncs" badge');
      ok(/lowered at sync: Operator → User/.test((rowOf('lowered').querySelector('[data-badge="syncChange"]') || {}).textContent || '') && /highest of their Zabbix user groups/.test(rowOf('lowered').textContent), 'zabbix users: a sync lowering and its reason are not shown');
      ok(/highest of User, Operator/.test(rowOf('a.kumar').textContent), 'zabbix users: "highest of User, Operator" missing');
      ok(/never/.test(rowOf('c.ops').textContent) && /Client A team/.test(rowOf('b.singh').textContent) && /not mapped/.test(rowOf('b.singh').textContent), 'zabbix users: last sign-in "never" or "(not mapped)" missing');
      ok(!usersCard().querySelector('[data-zr="groups-from"], [data-zr="token-problem"]'), 'zabbix users: a live read shows a last-sign-in note');
      // By hand goes through the bar: No access for a.kumar, Reset for b.singh.
      changeTo(rowOf('a.kumar').querySelector('select.zr-hand'), 'none');
      await settleFor(100);
      press(rowOf('b.singh').querySelector('button.zr-reset'));
      await settleFor(100);
      ok(/2 unsaved changes/.test(barText()) && /a\.kumar: No access by hand/.test(barText()) && /b\.singh: back to the groups/.test(barText()), `zabbix users: the bar says "${barText()}"`);
      await saveViaBar();
      const setRole = sentOf('USER_SET_ROLE').pop(); const unpin = sentOf('USER_UNPIN_ROLE').pop();
      ok(setRole && setRole.name === 'a.kumar@zabbix' && setRole.role === 'none', `zabbix users: USER_SET_ROLE ${JSON.stringify(setRole)}`);
      ok(unpin && unpin.name === 'b.singh@zabbix', `zabbix users: USER_UNPIN_ROLE ${JSON.stringify(unpin)}`);
      ok(!barText(), `zabbix users: the bar stayed after saving: "${barText()}"`);
      ok(/no access by hand/.test(rowOf('a.kumar').textContent) && !rowOf('b.singh').querySelector('[data-badge="pinned"]'), 'zabbix users: rows were not refreshed after the save');
      // Filter and the All / Set by hand toggle.
      typeInto(usersCard().querySelector('input[data-zr="filter"]'), 'singh');
      await settleFor(60);
      ok(shownRows() === 'b.singh@zabbix', `zabbix users: filter "singh" shows ${shownRows()}`);
      typeInto(usersCard().querySelector('input[data-zr="filter"]'), '');
      press(usersCard().querySelector('button[data-mode="hand"]'));
      await settleFor(100);
      ok(shownRows() === 'a.kumar@zabbix,c.ops@zabbix', `zabbix users: Set by hand shows ${shownRows()}`);
      press(usersCard().querySelector('button[data-mode="all"]'));
      await settleFor(60);

      // A token that cannot read users: said, with what fixes it.
      core.usersErr = 'Zabbix refused user.get: no permission to call the method';
      ok(await openCfg('requests', 'policy'), 'zabbix roles: could not leave Zabbix');  // a tab that loads, so coming back loads again
      ok(await openCfg('zabbix', 'zabbix'), 'zabbix roles: could not come back to Zabbix');
      await settleFor(500);
      const tp = usersCard() && usersCard().querySelector('[data-zr="token-problem"]');
      ok(tp && /cannot read users \(user\.get\)/.test(tp.textContent) && /2\.1\.20/.test(tp.textContent), `zabbix users: token note reads "${tp && tp.textContent}"`);
      core.usersErr = null;
    }
    // An older core does not know the group map: neither card, no error.
    core.unknownMessage = true;
    zr.forgetZabbixRoles();
    ok(await openCfg('requests', 'policy'), 'zabbix roles: could not leave Zabbix (older core)');
    ok(await openCfg('zabbix', 'zabbix'), 'zabbix roles: could not open Zabbix (older core)');
    await settleFor(500);
    ok(!rolesCard() && !usersCard(), 'zabbix roles: an older core still shows the roles cards');
    ok(!!doc.querySelector('#view .cm-body'), 'zabbix roles: the Zabbix page itself did not draw on an older core');
  } finally {
    globalThis.fetch = realFetch;
    zr.forgetZabbixRoles();
  }
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
  // What config.txt manages for the managed case below. Every PING says it (managed.js
  // setManaged) and the dev bridge manages nothing, so a PING landing mid-case — the app asks
  // one every 10 s — would undo it; the bridge's answer goes back with the case's own list.
  let managedNow = null;
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (body.type === 'CONFIG_WRITE') {
      written = body.text;
      return stubReply({ ok: true, path: body.path, bytes: body.text.length });
    }
    if (body.type === 'CONFIG_READ' && written !== null) {
      return stubReply({ ok: true, text: written, size: written.length, lastModified: Date.now() });
    }
    // Decided when the answer comes back, not when the question went out: a PING already in
    // flight when the case sets managedNow (the side foot's, the last Save's) would otherwise
    // land unpatched after setManaged and unlock the field the case just locked — seen once,
    // on a loaded machine, as "(false, 80)" for a default managed at 71.
    if (body.type === 'PING') {
      const j = await (await realFetch(input, init)).json();
      return stubReply(managedNow ? { ...j, managedDefaults: { ...managedNow }, managedZabbixOptions: {} } : j);
    }
    return realFetch(input, init);
  };
  const stays = (what) => ok((window.location.hash || '').startsWith('#/settings'),
    `config: ${what} left the Config page — now at "${window.location.hash}"`);
  const press = async (root, label) => {
    const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
    if (b) { b.click(); await settleFor(900); }
    return !!b;
  };
  try {
    const tabButton = (label) => ({ click: () => openSettingsTab(label) });
    // System › Defaults, edited in place (it was a dialog) → the save bar's Save
    await openSettingsTab('Defaults');
    const ri = doc.querySelector('#ce-ri');
    ok(!!ri && !ri.disabled, 'config: the Defaults are not edited in place');
    if (ri) {
      ri.value = String(Number(ri.value || 30) + 1);
      ok(await saveViaBar(900), 'config: no save bar for a changed default');
      ok(written !== null, 'config: saving the Defaults never wrote the config');
      ok(doc.getElementById('cm-savebar').hidden, 'config: the save bar stayed up after a good save');
      stays('saving Defaults');
    }
    // A number out of range is refused with the same words the dialog used, and nothing is written.
    {
      written = null;
      const dw = doc.querySelector('#ce-dw');
      if (dw) {
        dw.value = '500';
        await saveViaBar(400);
        ok(written === null, 'config: an out-of-range default was written');
        ok(/Check the numeric fields/.test((doc.querySelector('#cm-defaults-msg') || {}).textContent || ''), 'config: an out-of-range default does not say why');
        const discard = doc.querySelector('#cm-savebar button[data-act="discard"]');
        if (discard) { discard.click(); await settleFor(200); }
      }
    }
    // A default config.txt manages is locked in place with the reason, and a save does not
    // write it (config.txt would keep overriding a value nobody could see take effect).
    {
      const managed = await load('core/managed.js');
      managedNow = { diskWarnPercent: 71 };
      managed.setManaged({ ok: true, managedDefaults: { ...managedNow }, managedZabbixOptions: {} });
      written = null;
      // Through Clusters, not System › Config file: that tab asks the core for PING, whose
      // answer (the dev bridge manages nothing) would undo the managed list set here.
      await openCfg('clusters', 'clusters'); await openSettingsTab('Defaults');
      const dw = doc.querySelector('#ce-dw');
      ok(!!dw && dw.disabled && dw.value === '71', `config: a managed default is not shown locked at its managed value (${dw && dw.disabled}, ${dw && dw.value})`);
      ok(!!dw && dw.closest('label').textContent.includes('managed by config.txt'), 'config: a managed default does not say it is managed by config.txt');
      // The dialog (still used where a page wants one) locks it the same way.
      // Set again: the app's own PING every 10 s says what the dev bridge manages (nothing).
      managed.setManaged({ ok: true, managedDefaults: { diskWarnPercent: 71 }, managedZabbixOptions: {} });
      // Off the Defaults tab first: the dialog's fields carry the same ids as the in-place ones.
      await openCfg('clusters', 'clusters');
      managed.setManaged({ ok: true, managedDefaults: { ...managedNow }, managedZabbixOptions: {} });
      const editor = await load('ui/config-editor.js');
      editor.editDefaults();   // drawn at once; looked at before anything else can run
      const dlg = [...doc.querySelectorAll('.modal')].at(-1);
      const ddw = dlg && dlg.querySelector('#ce-dw');
      ok(!!ddw && ddw.disabled && ddw.value === '71', `config: the Defaults dialog does not lock a managed default (${!!dlg} ${dlg && dlg.querySelector('h2') && dlg.querySelector('h2').textContent} ${ddw && ddw.disabled} ${ddw && ddw.value})`);
      doc.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
      await openSettingsTab('Defaults');
      const dc = doc.querySelector('#ce-dc');
      ok(!!dc && !dc.disabled, 'config: a default config.txt does not manage was locked');
      if (dc) {
        dc.value = String(Number(dc.value || 90) - 1);
        await saveViaBar(900);
        ok(written !== null && !/"?diskWarnPercent"?\s*[:=]\s*71\b/.test(written), 'config: saving wrote a managed default into the config');
      }
      managedNow = null;
      managed.setManaged({ ok: true, managedDefaults: {}, managedZabbixOptions: {} });
      doc.querySelectorAll('.modal').forEach((m) => m.remove());
    }
    // Clusters → Edit → Save
    await tabButton('Clusters').click(); await settleFor(300);
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
    // The Zabbix options wait for the save bar, then save the config and sync; both ends of that must stay put too.
    await tabButton('Zabbix').click(); await settleFor(600);
    const box = doc.querySelector('#zo-useElasticProCredentials:not([disabled])');
    if (box) {
      written = null;
      box.checked = !box.checked; box.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(200);
      ok(written === null, 'config: a Zabbix option saved before Save');
      await saveViaBar(1200);
      stays('saving a Zabbix option');
      const again = doc.querySelector('#zo-useElasticProCredentials:not([disabled])');
      if (again) { again.checked = !again.checked; await saveViaBar(1200); }
      stays('saving a Zabbix option back');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  // The saves above replaced the working config with what the stub kept; the cases after
  // this one expect the fixture exactly as it was loaded.
  await applyConfig({ load, configPath });
  await go('overview');
}

// Cluster type and ULM (0.3.47, core/cluster-kind.js): a CI / DI / On-Prem badge beside every
// name, the Type filter, the edit dialog writing the cluster's file keys (desktop) and
// CLUSTER_META_SET (hosted, a Zabbix cluster's meta part only), and the snapshot cell saying
// "ULM · s3 <bucket>" for a cluster that expects no snapshots. Writes are stubbed so the fixture
// is not rewritten; the core's CLUSTER_META_* are stubbed since this dev bridge is not hosted.
{
  const st = await load('core/state.js');
  const ck = await load('core/cluster-kind.js');
  const sc = await load('core/server-credentials.js');
  const press = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const realFetch = globalThis.fetch;
  let written = null;
  let metaStore = {};
  const metaSent = [];
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (body.type === 'CONFIG_WRITE') { written = body.text; return stubReply({ ok: true, path: body.path, bytes: body.text.length }); }
    if (body.type === 'CONFIG_READ' && written !== null) return stubReply({ ok: true, text: written, size: written.length, lastModified: Date.now() });
    if (body.type === 'CLUSTER_META_GET') return stubReply({ ok: true, clusters: metaStore });
    if (body.type === 'CLUSTER_META_SET') {
      metaSent.push(body);
      metaStore = { ...metaStore, [body.clusterId]: { ...body.meta, source: 'set', setBy: 'kind-check' } };
      return stubReply({ ok: true, clusters: metaStore });
    }
    return realFetch(input, init);
  };
  const summary = () => panel('Cluster summary');
  const rowOf = (c) => summary() && summary().querySelector(`tbody tr[data-cluster="${c.id}"]`);
  const badgeOf = (c) => { const r = rowOf(c); const b = r && r.querySelector('.cl-type'); return b ? b.textContent : null; };
  const target = config.clusters[0];
  const trigger = () => [...summary().querySelectorAll('button.cl-name')].find((b) => b.textContent.includes(target.name));
  const menuItem = async (label) => {
    press(trigger()); await settleFor(120);
    const m = doc.querySelector('.menu-pop');
    return m && [...m.querySelectorAll('button[role=menuitem]')].find((b) => b.children[1].textContent === label);
  };
  // Who was signed in and what was selected go back afterwards: later cases depend on them.
  const before = { caller: st.state.caller, selected: st.state.selected };
  try {
    st.state.caller = { name: 'kind-check', role: 'admin' };
    st.state.selected = 'all';
    await go('overview');
    const rows = [...summary().querySelectorAll('tbody tr[data-cluster]')];
    ok(rows.length > 0 && rows.every((r) => r.querySelector('td.cl-name-td .cl-type')), 'cluster type: a row has no CI / DI / On-Prem badge');
    ok(badgeOf(target) === 'On-Prem', `cluster type: a cluster with no type reads "${badgeOf(target)}", expected On-Prem`);

    // Desktop: Edit → CI. ULM and SLM follow the type; the bucket shows with ULM on; Save writes
    // the file keys, and the row's badge and snapshot cell follow.
    press(await menuItem('Edit')); await settleFor(400);
    let dlg = doc.querySelector('.modal-overlay .modal');
    ok(dlg && dlg.querySelector('#ce-type-ci'), 'cluster type: the edit dialog has no Cluster type control');
    if (dlg && dlg.querySelector('#ce-type-ci')) {
      ok(!dlg.querySelector('#ce-ulm').checked && dlg.querySelector('#ce-slm').value === 'expected' && dlg.querySelector('#ce-ulm-block').hidden,
        'cluster type: an unset cluster does not open on On-Prem’s defaults (ULM off, SLM expected, no bucket)');
      press(dlg.querySelector('#ce-type-ci')); await settleFor(60);
      ok(dlg.querySelector('#ce-ulm').checked && dlg.querySelector('#ce-slm').value === 'none' && !dlg.querySelector('#ce-ulm-block').hidden,
        'cluster type: choosing CI did not turn ULM on, SLM to Not used and show the bucket');
      ok(/checked in Zabbix \(log archive \(S3\) template\), not here/.test(dlg.textContent), 'cluster type: the bucket hint does not say where the archive is checked');
      dlg.querySelector('#ce-ulm-bucket').value = 'Bad_Bucket';
      press([...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Save')); await settleFor(300);
      ok(doc.querySelector('.modal-overlay .modal') && /bucket/i.test((doc.querySelector('.modal-msg') || {}).textContent || ''),
        'cluster type: an invalid bucket name was not refused in the dialog');
      dlg.querySelector('#ce-ulm-bucket').value = 'acme-logs';
      written = null;
      press([...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Save')); await settleFor(900);
      ok(written !== null && /"type":\s*"ci"/.test(written) && /"bucket":\s*"acme-logs"/.test(written) && !/"slm"/.test(written),
        `cluster type: the save did not write type ci and the bucket (with SLM following the type): ${String(written).slice(0, 300)}`);
      doc.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
      await go('overview');
      ok(badgeOf(target) === 'CI', `cluster type: after the save the badge reads "${badgeOf(target)}", expected CI`);
      const live = st.clusters().find((c) => c.id === target.id) || target;
      ok(ck.slmExempt(live), 'cluster type: a CI cluster with SLM following the type is not SLM-exempt');
      const snapCell = rowOf(target) && rowOf(target).querySelector('.cl-ulm');
      if (snapCell) ok(/ULM · s3 acme-logs/.test(snapCell.textContent), `cluster type: the snapshot cell reads "${snapCell.textContent}"`);
      ok(!st.alerts().some((a) => a.cluster && a.cluster.id === target.id && /:(slm-mode|slm-stale)|:repo:.*:(none|stale)$/.test(a.key)),
        'cluster type: a CI cluster still raises a no-snapshot / SLM-stopped alert');
    }

    // The Type filter: CI only shows that one cluster; Clear brings the fleet back.
    {
      // Open already when an earlier case left a sort set; pressing it then would clear and close it.
      if (!doc.getElementById('clusters-type')) { press(doc.getElementById('clusters-search-btn')); await settleFor(150); }
      const sel = doc.getElementById('clusters-type');
      ok(!!sel, 'cluster type: the search box has no Type filter');
      if (sel) {
        ok([...sel.options].some((o) => /^CI \(1\)$/.test(o.textContent)), `cluster type: the filter does not count CI clusters (${[...sel.options].map((o) => o.textContent).join(', ')})`);
        sel.value = 'ci'; sel.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(200);
        const names = [...summary().querySelectorAll('tbody tr[data-cluster]')].map((r) => r.dataset.cluster);
        ok(names.length === 1 && names[0] === target.id, `cluster type: filtering on CI shows ${names.join(', ') || 'nothing'}`);
        const clear = [...summary().querySelectorAll('button')].find((b) => b.textContent === 'Clear');
        press(clear); await settleFor(200);
        ok(summary().querySelectorAll('tbody tr[data-cluster]').length === rows.length, 'cluster type: Clear did not bring every cluster back');
      }
    }

    // Hosted: a Zabbix cluster is edited in the meta part only, through CLUSTER_META_SET.
    sc.setHostedEdition(true);
    ck.setClusterMeta({});
    const live = st.state.config.clusters.find((c) => c.id === target.id);
    const was = { source: live.source, zabbix: live.zabbix };
    live.source = 'zabbix'; live.zabbix = { host: 'zbx-host-1' };
    try {
      await go('overview');
      const item = await menuItem('Edit');
      ok(item && /cluster type/.test(item.textContent), 'cluster type: a Zabbix cluster offers no Edit for its type to an admin (hosted)');
      press(item); await settleFor(300);
      dlg = doc.querySelector('.modal-overlay .modal');
      ok(dlg && dlg.querySelector('#ce-type-di') && !dlg.querySelector('#ce-name') && !dlg.querySelector('#ce-url'),
        'cluster type: a Zabbix cluster’s dialog is not the meta part only');
      if (dlg && dlg.querySelector('#ce-type-di')) {
        press(dlg.querySelector('#ce-type-di')); await settleFor(60);
        dlg.querySelector('#ce-ulm-bucket').value = 'zbx-logs';
        press([...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Save')); await settleFor(400);
        const m = metaSent[metaSent.length - 1];
        ok(m && m.clusterId === target.id && m.meta.type === 'di' && m.meta.ulm.bucket === 'zbx-logs' && m.meta.ulm.enabled === null && m.meta.slm === null,
          `cluster type: CLUSTER_META_SET was not sent as {type: di, ulm: {enabled: null, bucket}, slm: null}: ${JSON.stringify(m)}`);
        ok(!doc.querySelector('.modal-overlay .modal'), 'cluster type: the Zabbix cluster dialog stayed open after a good save');
        await go('overview');
        ok(badgeOf(target) === 'DI', `cluster type: after CLUSTER_META_SET the badge reads "${badgeOf(target)}", expected DI`);
      }
    } finally {
      live.source = was.source; live.zabbix = was.zabbix;
    }
  } finally {
    globalThis.fetch = realFetch;
    sc.setHostedEdition(false);
    ck.setClusterMeta({});
    doc.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
    st.state.caller = before.caller;
    st.state.selected = before.selected;
  }
  await applyConfig({ load, configPath });
  await go('overview');
}

// Config > Volume fields (0.3.45): the section opens and says so when the core is older, the
// fields can be edited and Save writes defaults.volume (and an override for one cluster, only
// what differs), and Check fields sends VOLUME_FIELDS_CHECK and fills the check column. The
// core's VOLUME_* messages are stubbed (the dev bridge may be older); the write is stubbed so
// the fixture is not rewritten.
{
  await go('settings');
  const realFetch = globalThis.fetch;
  let written = null;
  const sent = [];
  let older = true;
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(body.type || '').startsWith('VOLUME_')) {
      sent.push(body);
      if (older) return stubReply({ ok: false, kind: 'bad_message', message: `Unknown message type "${body.type}"` });
      if (body.type === 'VOLUME_SETTINGS') return stubReply({ ok: true, settings: {}, managed: [], source: 'file', overrides: [] });
      return stubReply({ ok: true, indices: { match: 150, skipped: ['metrics-2026.09', '.kibana_1'] }, rows: [
        { key: 'tag', tried: ['tag1'], resolved: 'tag1', type: 'keyword', note: '' },
        { key: 'eventSize', tried: ['event_logsize'], resolved: null, type: null, note: '' },
      ] });
    }
    if (body.type === 'CONFIG_WRITE') { written = body.text; return stubReply({ ok: true, path: body.path, bytes: body.text.length }); }
    if (body.type === 'CONFIG_READ' && written !== null) return stubReply({ ok: true, text: written, size: written.length, lastModified: Date.now() });
    // Every PING says what config.txt manages (managed.js setManaged), and the dev bridge
    // manages nothing — so a PING landing while the managed case below runs (the Config page
    // asks one on open, Save asks one, the side foot every 10 s) undid what it set up, and
    // whether it did was a matter of timing. The bridge's answer, with the case's own list.
    // Decided at reply time (see the Config page's stub above): a PING in flight when the case
    // sets managedNow must not land unpatched after it.
    if (body.type === 'PING') {
      const res = await realFetch(input, init);
      const j = await res.json();
      return stubReply(managedNow ? { ...j, managedDefaults: { ...managedNow }, managedZabbixOptions: {} } : j);
    }
    return realFetch(input, init);
  };
  let managedNow = null;
  // Save is the page's save bar now (Config-Management): "Save" presses it.
  const press = async (label, root = doc.querySelector('#view')) => {
    if (label === 'Save') return saveViaBar(700);
    const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
    if (b) { b.click(); await settleFor(700); }
    return !!b;
  };
  // The write follows the press by a PING and a round trip; wait for it rather than guess.
  const written_ = async () => { for (let i = 0; i < 20 && written === null; i++) await settleFor(250); };
  const type = async (id, value) => {
    const el = doc.getElementById(id);
    if (el) { el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); }
    return !!el;
  };
  try {
    ok(await openSettingsTab('Reports'), 'volume fields: no Reports tab');
    await settleFor(500);
    const view = doc.querySelector('#view');
    ok(!!panel('Volume fields') && !!panel('Same settings in the clusters file') && !!panel('Hosted: config.txt keys'),
      'volume fields: the settings card and the two info cards did not all draw');
    ok(view.textContent.includes('This server does not know Volume fields yet (needs 0.3.45)'),
      'volume fields: an older core was not told apart from a broken page');
    ok(!view.textContent.includes('[object Object]'), 'volume fields: the page prints [object Object]');
    ok(['vf-index', 'vf-tag', 'vf-forwarder', 'vf-sourceHost', 'vf-sourceIp', 'vf-eventSize', 'vf-subSize', 'vf-extra', 'vf-extra-name',
      'vf-basis', 'vf-top', 'vf-keep', 'vf-at'].every((id) => doc.getElementById(id)), 'volume fields: a field of the form is missing');
    ok(doc.getElementById('vf-tag').value === 'tag1, labels.tag1, tags', `volume fields: Tag shows "${doc.getElementById('vf-tag').value}", expected the built-in list`);
    ok(doc.getElementById('vf-day').disabled && doc.getElementById('vf-boundary').disabled, 'volume fields: Day of an index and Day boundary must be fixed');
    ok(/\d+ of \d+ clusters override these fields/.test(view.textContent), 'volume fields: the override count is missing');

    // Check fields: asks the core, and the answer lands in the check column.
    older = false;
    const cluster = doc.getElementById('vf-check-cluster');
    ok(!!cluster && cluster.options.length > 0, 'volume fields: no cluster to check against');
    sent.length = 0;
    ok(await press('Check fields'), 'volume fields: no Check fields button');
    const chk = sent.find((m) => m.type === 'VOLUME_FIELDS_CHECK');
    ok(!!chk && chk.clusterId === cluster.value, `volume fields: Check fields sent ${JSON.stringify(sent)}`);
    ok(doc.getElementById('vf-c-index').textContent.includes('150 match') && doc.getElementById('vf-c-index').textContent.includes('2 skipped'),
      `volume fields: the index check reads "${doc.getElementById('vf-c-index').textContent}"`);
    ok(doc.getElementById('vf-c-tag').textContent.includes('✓'), 'volume fields: a resolved row has no tick');
    ok(doc.getElementById('vf-c-eventSize').textContent.includes('not measured'), 'volume fields: a missing Event size does not say what it costs');

    // Save: edits a field, writes defaults.volume, leaves the rest of defaults alone.
    ok(await type('vf-tag', 'tag1, my.tag'), 'volume fields: no Tag input');
    written = null;
    ok(await press('Save'), 'volume fields: no Save button');
    await written_();
    const file = written ? JSON.parse(written) : null;
    ok(!!file && Array.isArray(file.defaults.volume && file.defaults.volume.tag) && file.defaults.volume.tag.join() === 'tag1,my.tag',
      `volume fields: Save did not write defaults.volume.tag (${written && JSON.stringify(file.defaults)})`);
    ok(!!file && file.defaults.volumeFields === undefined, 'volume fields: the legacy volumeFields was kept');
    ok((doc.location.hash || '').startsWith('#/settings'), 'volume fields: saving left the Config page');

    // A bad value is refused before anything is written.
    await openSettingsTab('Reports');
    await type('vf-index', 'logstash-*');
    written = null;
    await press('Save');
    ok(written === null, 'volume fields: an index format without YYYY.MM.DD was written');
    ok(doc.querySelector('#view').textContent.includes('YYYY.MM.DD'), 'volume fields: no reason given for the refused index format');

    // Override for one cluster: only the key that differs is saved, under overrides[<id>].
    await openSettingsTab('Reports');
    ok(await press('Override for one cluster…'), 'volume fields: no override mode');
    const pick = doc.getElementById('vf-cluster');
    ok(!!pick, 'volume fields: override mode has no cluster picker');
    await type('vf-forwarder', 'fwdtag');
    written = null;
    await press('Save');
    await written_();
    const f2 = written ? JSON.parse(written) : null;
    const ov = f2 && f2.defaults.volume && f2.defaults.volume.overrides && f2.defaults.volume.overrides[pick.value];
    ok(!!ov && JSON.stringify(ov) === JSON.stringify({ forwarder: ['fwdtag'] }), `volume fields: the override saved ${JSON.stringify(ov)}`);

    // A key config.txt manages is locked, says why, and is never written.
    const managed = await load('core/managed.js');
    managedNow = { volumeTopValues: 40 };
    managed.setManaged({ ok: true, managedDefaults: { ...managedNow }, managedZabbixOptions: {} });
    await openSettingsTab('Defaults'); await openSettingsTab('Reports');
    await press('Defaults · all clusters');
    const top = doc.getElementById('vf-top');
    ok(!!top && top.disabled && top.value === '40', `volume fields: a managed value is not shown locked (${top && top.disabled}, ${top && top.value})`);
    ok(doc.querySelector('#view').textContent.includes('managed by config.txt'), 'volume fields: a locked row does not say it is managed by config.txt');
    written = null;
    // The save bar comes up for a change: make one elsewhere, so Save has something to send.
    await type('vf-tag', 'tag1, managed.case1');
    await press('Save');
    await written_();
    ok(written !== null, 'volume fields: Save with a managed value wrote nothing');
    ok(written === null || !/"topValues"\s*:\s*40/.test(written),
      `volume fields: saving wrote a managed value into the file (${written && JSON.stringify((JSON.parse(written).defaults || {}).volume)})`);
    // config.txt lets go of the key while the page is open (the next PING says so) and the
    // field is still drawn locked: Save must not write the value it showed — nobody typed it.
    managedNow = {};
    managed.setManaged({ ok: true, managedDefaults: {}, managedZabbixOptions: {} });
    const stillLocked = doc.getElementById('vf-top');
    ok(!!stillLocked && stillLocked.disabled, 'volume fields: the locked field was redrawn before Save (the case needs it drawn locked)');
    written = null;
    await type('vf-tag', 'tag1, managed.case2');
    await press('Save');
    await written_();
    ok(written === null || !/"topValues"\s*:\s*40/.test(written),
      `volume fields: a locked field's value was written once config.txt let go of the key (${written && JSON.stringify((JSON.parse(written).defaults || {}).volume)})`);
    managedNow = null;
    managed.setManaged({ ok: true, managedDefaults: {}, managedZabbixOptions: {} });
  } finally {
    managedNow = null;
    globalThis.fetch = realFetch;
  }
  await applyConfig({ load, configPath });
  await go('overview');
}

// Config > Volume fields > Volume report by mail and Mail server (SMTP) (0.3.45): both load for
// an admin, a field config.txt manages is locked and left out of Save, Save sends no password
// unless one was typed, "None" security forces "No sign-in", Send test mail shows each step
// (a failed one too), and anybody else is told only an admin sets these. MAIL_* and
// REPORT_SCHEDULE_* are stubbed at fetch with the shapes the core answers.
{
  const st = (await load('core/state.js')).state;
  const realFetch = globalThis.fetch;
  const sent = [];
  let stale = true;     // the stored password was typed for another server
  let noNext = false;   // an older core: no nextPeriod
  const answer = (b) => {
    switch (b.type) {
      case 'MAIL_SETTINGS_GET': return { ok: true, host: 'smtp.example.com', port: 587, security: 'starttls', auth: 'password', user: 'ep',
        from: 'elasticpro@example.com', passwordSet: !stale, passwordStale: stale, passwordFrom: 'stored', managed: ['from'], configured: true, problem: null,
        canStorePassword: true, passwordStoreProblem: null };
      case 'REPORT_SCHEDULE_GET': return { ok: true, enabled: true, to: ['ops@example.com'], cc: [], bcc: [], schedule: 'monthly', at: '07:00',
        clusters: 'all', subject: 'ElasticPro volume report · {period}', sheets: ['daily', 'monthly', 'breakdown'],
        lastSent: { at: Date.now() - 3600000, to: 1, ok: true, error: null }, managed: ['at'], timer: true,
        nextSendAt: Date.now() + 86400000, mailConfigured: true,
        ...(noNext ? {} : { nextPeriod: { from: '2026-10-01', to: '2026-10-31', label: '2026-10' } }) };
      case 'MAIL_SETTINGS_SET': stale = false; return { ok: true };
      case 'REPORT_SCHEDULE_SET': return { ok: true };
      case 'MAIL_TEST': return { ok: false, kind: 'smtp_failed', message: 'auth failed', steps: [
        { step: 'connect', ok: true, detail: '' }, { step: 'tls', ok: true, detail: '' }, { step: 'auth', ok: false, detail: '535 bad credentials' }] };
      case 'REPORT_JOBS': return { ok: true, jobs: [], concurrency: 3, running: 0, queued: 0 };
      default: return { ok: false, kind: 'bad_message', message: `Unknown message type "${b.type}"` };
    }
  };
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (/^(REPORT_|MAIL_)/.test(String(body.type || ''))) { sent.push(body); return stubReply(answer(body)); }
    return realFetch(input, init);
  };
  const byId = (id) => doc.getElementById(id);
  const setVal = (id, v, ev = 'input') => { const el = byId(id); if (el) { el.value = v; el.dispatchEvent(new window.Event(ev, { bubbles: true })); } return !!el; };
  const last = (type) => sent.filter((m) => m.type === type).at(-1);
  try {
    await go('settings');
    ok(await openSettingsTab('Reports'), 'mail: no Reports page');
    await settleFor(300);
    // The config.txt keys (mail ones too) are on Indices & volume fields; the forms on Mail delivery.
    const keysText = (panel('Hosted: config.txt keys') || {}).textContent || '';
    ok(await openSettingsTab('Mail delivery'), 'mail: no Mail delivery tab');
    await waitFor(() => byId('ms-host'), 'mail: the Mail server (SMTP) form did not load');
    ok(!!panel('Volume report by mail') && !!panel('Mail server (SMTP)'), 'mail: the two panels are not both on Mail delivery');
    ok(!!doc.querySelector('.cm-strip') && /Mail server/.test(doc.querySelector('.cm-strip').textContent), 'mail: no status line over the forms');
    ok(!!doc.querySelector('.cm-actions #rm-send-now') && !!doc.querySelector('.cm-actions #rm-download'), 'mail: Send report now and Download .xlsx are not in the page header');
    ok(byId('ms-host').value === 'smtp.example.com' && byId('ms-port').value === '587', 'mail: the mail server form does not show what the core holds');
    ok(byId('ms-password').value === '' && byId('ms-password').placeholder === '' && byId('ms-password').type === 'password',
      'mail: the password box is not empty, or says stored for a password typed for another server');
    // A managed field: locked, says why, and left out of Save.
    ok(byId('ms-from').disabled && panel('Mail server (SMTP)').textContent.includes('managed by config.txt'), 'mail: a managed From is not locked with the reason');
    ok(byId('rm-at').disabled && panel('Volume report by mail').textContent.includes('managed by config.txt'), 'mail: a managed At is not locked with the reason');
    ok(/last sent .+ to 1 address/.test(doc.querySelector('.cm-strip').textContent) && /next send/.test(doc.querySelector('.cm-strip').textContent),
      'mail: the report status does not say when it was last sent and when it goes next');
    ok(keysText.includes('UI_SMTP_HOST=smtp.example.com') && keysText.includes('UI_REPORT_SCHEDULE='),
      'mail: the config.txt card has no UI_SMTP_* / UI_REPORT_* lines');

    ok(byId('ms-pw-stale') && !byId('ms-pw-stale').hidden && byId('ms-pw-stale').textContent === 'The mail server changed: type the password again.',
      'mail: a stale password does not say to type it again');

    // Save, password untouched: no password in what goes.
    setVal('ms-host', 'relay.example.com');
    ok(await saveViaBar(300), 'mail: no save bar for a changed mail server');
    const m1 = last('MAIL_SETTINGS_SET');
    ok(!!m1 && m1.host === 'relay.example.com' && !('password' in m1) && !('from' in m1),
      `mail: Save with the password untouched sent ${JSON.stringify(m1)}`);
    // Typed: it goes.
    setVal('ms-password', 's3cret');
    ok(!doc.getElementById('cm-savebar').textContent.includes('s3cret'), 'mail: the save bar shows a typed password');
    await saveViaBar(300);
    ok(last('MAIL_SETTINGS_SET') && last('MAIL_SETTINGS_SET').password === 's3cret', 'mail: a typed password was not sent');
    ok(byId('ms-pw-stale').hidden, 'mail: the stale-password note stayed after the password was typed and saved');
    ok(byId('ms-password').value === '', 'mail: the typed password stayed in the box after saving');
    // "None" is plain text: no sign-in.
    setVal('ms-security', 'none', 'change');
    await settleFor(20);
    ok(byId('ms-auth').value === 'none' && byId('ms-auth').disabled && byId('ms-user').disabled && byId('ms-port').value === '25',
      'mail: Security "None" did not force No sign-in (and port 25)');
    await saveViaBar(300);
    ok(last('MAIL_SETTINGS_SET').security === 'none' && last('MAIL_SETTINGS_SET').auth === 'none', `mail: "None" saved ${JSON.stringify(last('MAIL_SETTINGS_SET'))}`);

    // Send test mail: every step, the failed one with its reason.
    byId('ms-test').click();
    ok(!byId('ms-test-row').hidden, 'mail: Send test mail did not ask for an address');
    setVal('ms-test-to', 'me@example.com');
    byId('ms-test-send').click();
    await settleFor(300);
    ok(last('MAIL_TEST') && last('MAIL_TEST').to === 'me@example.com', 'mail: the test was not sent to the typed address');
    const steps = byId('ms-steps').textContent;
    ok(steps.includes('✓ connect') && steps.includes('✗ auth: 535 bad credentials'), `mail: the test steps read "${steps}"`);

    // The mailed report: Save sends the lists, and not the managed At.
    setVal('rm-to', 'ops@example.com, lead@example.com');
    setVal('rm-cc', 'boss@example.com');
    byId('rm-sheet-breakdown').checked = false;
    await saveViaBar(300);
    const s1 = last('REPORT_SCHEDULE_SET');
    ok(!!s1 && JSON.stringify(s1.to) === '["ops@example.com","lead@example.com"]' && JSON.stringify(s1.cc) === '["boss@example.com"]'
      && JSON.stringify(s1.sheets) === '["daily","monthly"]' && !('at' in s1) && s1.clusters === 'all',
    `mail: the report Save sent ${JSON.stringify(s1)}`);
    // Download .xlsx: a report job for every cluster, for the core's nextPeriod, no mail.
    ok(byId('rm-download').textContent === 'Download .xlsx · 2026-10', `mail: the button reads "${byId('rm-download').textContent}"`);
    sent.length = 0;
    byId('rm-download').click();
    await settleFor(300);
    const run = last('REPORT_RUN');
    ok(!!run && run.format === 'xlsx' && run.mail === false && run.clusterIds.length === config.clusters.length
      && JSON.stringify(run.period) === '{"from":"2026-10-01","to":"2026-10-31"}',
    `mail: Download .xlsx sent ${JSON.stringify(run)}`);
    // An older core says no period: the button is off, with a title saying why.
    noNext = true;
    setVal('rm-cc', 'boss2@example.com');
    await saveViaBar(300);
    ok(byId('rm-download').disabled && /does not say/.test(byId('rm-download').title), 'mail: Download .xlsx is on without a nextPeriod');
    noNext = false;
    byId('rm-send-now').click();
    await settleFor(300);
    ok(!!last('REPORT_SEND_NOW'), 'mail: Send report now sent nothing');

    // Anybody else: an operator's Config-Management has no Reports page, and nothing is asked.
    st.caller = { name: 'reader', role: 'operator' };
    sent.length = 0;
    await go('overview'); await go('settings');
    await settleFor(300);
    ok(!byId('ms-host') && !doc.querySelector('.cm-nav .cm-item[data-cm-page="reports"]'),
      'mail: an operator reaches the mail server form');
    ok(!sent.some((m) => m.type === 'MAIL_SETTINGS_GET' || m.type === 'REPORT_SCHEDULE_GET'), 'mail: a non-admin page asked for the admin settings');
  } finally {
    st.caller = null;
    globalThis.fetch = realFetch;
  }
  (await load('core/reports.js')).resetReports();
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
// events, and saves what the presets decide; the Request Centre's emergency stop has an end.
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
  const tab = doc.querySelector('.cm-nav .cm-item[data-cm-page="requests"]') ? { click: () => openSettingsTab('Requests') } : null;
  ok(!!tab, 'policy: no Requests page in Config-Management');
  if (tab) {
    const gets = countOf('POLICY_GET');
    await tab.click(); await settleFor(300);
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
        const perWas = per.value;
        per.value = '8'; per.dispatchEvent(new window.Event('change', { bubbles: true }));
        ok(per.value === String(Math.min(8, gate.perCluster)), `policy: typing 8 per cluster left ${per.value} under a gate of ${gate.perCluster}`);
        // Put back: an unsaved change would be asked about when the case leaves the tab.
        per.value = perWas; per.dispatchEvent(new window.Event('change', { bubbles: true }));
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
      await openSettingsTab('Defaults'); await tab.click(); await settleFor(300);
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
      if (client.getAttribute('aria-pressed') === 'true') {
        const cur = await es.policyGet();
        await es.policySet({ ...cur.policy, mode: 'background' });
        // A fresh visit reads the policy again; press only once it shows what was saved.
        await go('overview'); await go('settings'); await openSettingsTab('Requests');
        await waitFor(() => ((doc.getElementById('pol-mode') || {}).value === 'background' ? doc.body : null), 'policy: the saved Background policy did not show');
        await settleFor(200);
      }
      const client2 = [...doc.querySelectorAll('button')].find((b) => b.textContent.startsWith('Client basis'));
      if (client2) client2.click();
      await settleFor(200);
      const pressed = [...doc.querySelectorAll('button')].find((b) => b.textContent.startsWith('Client basis'));
      ok(pressed && pressed.getAttribute('aria-pressed') === 'true', 'policy: the chosen preset is not marked aria-pressed');
      const sets = countOf('POLICY_SET');
      ok(await saveViaBar(500), 'policy: no save bar after choosing a preset');
      const m = lastOf('POLICY_SET');
      ok(countOf('POLICY_SET') === sets + 1 && m && m.policy.mode === 'on-demand' && m.policy.concurrency.perCluster === 1,
        `policy: Save after "Client basis" sent ${JSON.stringify(m && m.policy)}`);
      // The emergency stop is not the form's: Save sends no `paused`, so it can never lift one.
      ok(m && !('paused' in m.policy), `policy: Config › Requests Save sent the stop: ${JSON.stringify(m && m.policy && m.policy.paused)}`);
    }

    // Duplicate requests and While Play runs (2026-11-01): their own sections; the gap and each
    // Play interval are inputs within their bounds, the three kinds a person types are listed and
    // not editable, Save sends them, and a field config.txt locks reads "managed by config.txt".
    const gapSec = doc.getElementById('pol-gap-sec');
    ok(!!gapSec, 'gap: no "Duplicate requests" section on Config › Requests');
    const gapIn = doc.getElementById('pol-gap');
    ok(gapIn && gapIn.min === '30' && gapIn.max === '600', `gap: the gap input allows ${gapIn && gapIn.min}–${gapIn && gapIn.max}, expected 30–600`);
    const gtext = gapSec ? gapSec.textContent : '';
    ok(/Askers waiting on the same request share it — always on/.test(gtext), `gap: in-flight sharing is not said to be always on: "${gtext}"`);
    ok(/REST console/.test(gtext) && !/Indices page search|Snapshots page search/.test(gtext), `gap: the kinds never held are not what goes to a cluster as typed: "${gtext}"`);
    ok(gapSec && gapSec.querySelectorAll('input').length === 1, 'gap: something besides the gap is editable under Duplicate requests');
    const playSec = doc.getElementById('pol-play-sec');
    ok(!!playSec, 'play schedule: no "While Play runs" section on Config › Requests');
    const keys = ['healthSec', 'nodesSec', 'lifecycleSec', 'snapshotsSec', 'indicesSec', 'delayFullSec', 'delayLateSec'];
    const input = (k) => doc.getElementById(`pol-play-${k}`);
    ok(keys.every(input), `play schedule: no input for ${keys.filter((k) => !input(k)).join(', ')}`);
    const now = await es.policyGet();
    ok(now && now.ok && now.policy && now.policy.play && keys.every((k) => input(k) && Number(input(k).value) === now.policy.play[k]),
      `play schedule: the inputs do not show the policy: ${JSON.stringify(now && now.policy && now.policy.play)}`);
    ok(gapIn && Number(gapIn.value) === now.policy.minGapSec, `gap: the input shows ${gapIn && gapIn.value}, the policy ${now.policy.minGapSec}`);
    ok(/full check/.test(playSec ? playSec.textContent : '') && /late devices/.test(playSec ? playSec.textContent : ''), 'play schedule: the log delay\'s two tiers are not both there');
    if (gapIn && input('healthSec') && !gapIn.disabled) {
      const was = { gap: gapIn.value, health: input('healthSec').value };
      gapIn.value = '90'; input('healthSec').value = '600';
      await saveViaBar(500);
      const m = lastOf('POLICY_SET');
      ok(m && m.policy.minGapSec === 90 && m.policy.play && m.policy.play.healthSec === 600 && m.policy.play.delayLateSec === now.policy.play.delayLateSec,
        `gap: Save sent ${JSON.stringify(m && { minGapSec: m.policy.minGapSec, play: m.policy.play })}`);
      const back = await es.policyGet();
      ok(back.policy.minGapSec === 90 && back.policy.play.healthSec === 600, `gap: the core kept ${JSON.stringify({ g: back.policy.minGapSec, h: back.policy.play.healthSec })}`);
      const g2 = doc.getElementById('pol-gap'); const h2 = doc.getElementById('pol-play-healthSec');
      if (g2 && h2) { g2.value = was.gap; h2.value = was.health; await saveViaBar(500); }
    }
    // config.txt locks the gap and Play's health interval: both drawn locked, saying so; the rest stay editable.
    const realFetch = globalThis.fetch;
    const lockedBy = { minGapSec: 'POLL_MIN_GAP_SECONDS', 'play.healthSec': 'POLL_PLAY_HEALTH_SECONDS' };
    globalThis.fetch = async (input2, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      const res = await realFetch(input2, init);
      if (body.type !== 'POLICY_GET') return res;
      const j = await res.json();
      return stubReply({ ...j, managed: lockedBy });
    };
    // A fresh visit to Config › Requests: the policy is read once per visit.
    const revisit = async () => {
      await go('overview'); await go('settings');
      await openSettingsTab('Requests'); await settleFor(400);
    };
    try {
      await revisit();
      const g = doc.getElementById('pol-gap');
      ok(g && g.disabled && /managed by config\.txt \(POLL_MIN_GAP_SECONDS\)/.test(g.closest('label').textContent),
        `gap: a gap config.txt locks is not drawn locked with its key: ${g && g.closest('label').textContent}`);
      const ph = doc.getElementById('pol-play-healthSec');
      ok(ph && ph.disabled && /managed by config\.txt \(POLL_PLAY_HEALTH_SECONDS\)/.test(ph.closest('tr').textContent),
        `play schedule: a locked interval does not say so: ${ph && ph.closest('tr').textContent}`);
      const pn = doc.getElementById('pol-play-nodesSec');
      ok(pn && !pn.disabled, 'play schedule: an interval config.txt does not lock was drawn locked');
    } finally {
      globalThis.fetch = realFetch;
      await revisit();
    }
  }

  await go('requests'); await settleFor(500);
  // What the duplicate-request gap saved, per dataset over the last hour (REQUEST_LOG `asks`).
  {
    const gc = [...doc.querySelectorAll('section.card')].find((x) => (x.querySelector('header h2') || {}).textContent === 'Duplicate requests');
    ok(!!gc && !!gc.querySelector('#rq-gap'), 'gap: the Request Centre has no "Duplicate requests" card');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input2, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      const res = await realFetch(input2, init);
      if (body.type !== 'REQUEST_LOG') return res;
      const j = await res.json();
      return stubReply({ ...j, asks: { windowMinutes: 60, gapSec: 60, since: null, byDataset: {
        health: { asked: 42, sent: 12, recent: 30, shared: 0, held: 0 },
        direct: { asked: 5, sent: 3, recent: 1, shared: 1, held: 0 } } } });
    };
    try {
      await settleFor(2600);
      const t = (doc.getElementById('rq-gap') || {}).textContent || '';
      ok(/health: asked 42 this hour, sent 12, 30 answered from a reading under a minute old/.test(t), `gap: the Request Centre reads "${t}"`);
      ok(/page reads: asked 5 this hour, sent 3, 1 answered from a reading under a minute old, 1 shared one already on its way/.test(t), `gap: page reads read "${t}"`);
      ok(/32 of 47 asks/.test(t), `gap: the total saved reads "${t}"`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  // 0.3.44: no per-cluster pause. The table says how each cluster is being handled on its
  // own instead — normal, slowed, or held — and nothing in it stops a cluster by hand.
  const per = [...doc.querySelectorAll('section.card')].find((x) => (x.querySelector('header h2') || {}).textContent === 'Per cluster');
  ok(!per || !button('Pause', per), 'automation: the per-cluster table still has a Pause button');
  const perHeads = per ? [...per.querySelectorAll('thead th')].map((t) => t.textContent.trim()) : [];
  ok(!per || perHeads[1] === 'Automation', `automation: the per-cluster table has no Automation column: ${JSON.stringify(perHeads)}`);
  ok(!per || !per.querySelector('tbody tr') || [...per.querySelectorAll('tbody tr')].every((tr) => /^(normal|slowed since .+|held: .+)$/.test((tr.children[1] || {}).textContent || '')),
    `automation: a row's Automation cell is not normal / slowed / held: ${per ? [...per.querySelectorAll('tbody tr')].map((tr) => (tr.children[1] || {}).textContent).join(' | ') : ''}`);

  // The emergency stop: its own card, three lengths, each asking first; it ends by itself,
  // and says when, on the card, in the status line and at the top of every page.
  const stopCard = () => doc.querySelector('.rq-stop');
  ok(!!stopCard() && /Emergency stop/.test(stopCard().textContent), 'stop: no "Emergency stop" card on the Request Centre');
  ok(stopCard() && /for 15, 30 or 60 minutes, then starts again by itself/.test(stopCard().textContent), 'stop: the card does not say the stop ends by itself');
  const lengths = stopCard() ? [...stopCard().querySelectorAll('button[data-act="pause-all"]')] : [];
  ok(JSON.stringify(lengths.map((b) => b.textContent)) === JSON.stringify(['15 min', '30 min', '60 min']), `stop: the lengths offered are ${JSON.stringify(lengths.map((b) => b.textContent))}`);
  ok(lengths.every((b) => b.classList.contains('danger')), 'stop: a stop button is not styled as a warning (.btn.danger)');
  ok(!doc.querySelector('.rq-tbl') || ![...doc.querySelectorAll('.rq-tbl button')].some((b) => /pause|stop/i.test(b.textContent)), 'stop: a stop button is among the requests table');
  const thirty = lengths[1];
  if (thirty) {
    const wasAll = !!((before.policy || {}).paused || {}).all;
    ok(!wasAll, 'stop: the policy is already stopped before the test pressed anything');
    // Since the operator may stop the fleet too, the page sends the stop alone (POLICY_PAUSE /
    // POLICY_RESUME), never the whole policy.
    const sets = countOf('POLICY_SET');
    const pauses = countOf('POLICY_PAUSE');
    const resumes = countOf('POLICY_RESUME');
    const dlg = () => doc.querySelector('.modal-overlay .modal');
    thirty.click(); await settleFor(300);
    ok(!!dlg() && /Stop all requests for 30 minutes\?/.test(dlg().textContent), 'stop: "30 min" did not ask first');
    ok(!dlg() || /slows down for those on its own/.test(dlg().textContent), 'stop: the question does not say slow clusters are handled already');
    if (dlg()) { button('No', dlg()).click(); await settleFor(300); }
    ok(countOf('POLICY_PAUSE') === pauses && countOf('POLICY_SET') === sets, 'stop: answering No still stopped');
    thirty.click(); await settleFor(300);
    const yes = dlg() && button('Stop for 30 min', dlg());
    ok(!!yes && yes.classList.contains('danger'), 'stop: the question has no red "Stop for 30 min" answer');
    if (yes) yes.click();
    await settleFor(800);
    let m = lastOf('POLICY_PAUSE');
    ok(countOf('POLICY_PAUSE') === pauses + 1 && m && m.minutes === 30 && !m.policy && countOf('POLICY_SET') === sets,
      `stop: "30 min" sent ${JSON.stringify(m)} (POLICY_SET ${countOf('POLICY_SET') - sets})`);
    const resume = stopCard() && button('Resume now', stopCard());
    ok(!!resume, 'stop: while stopped, the card offers no "Resume now"');
    ok(stopCard() && /It ends by itself at .* \(in (29|30) min\)/.test(stopCard().textContent), `stop: the card does not say when it ends: "${stopCard() && stopCard().textContent}"`);
    const pill = async () => { for (let i = 0; i < 20 && !doc.querySelector('#topbar .paused-btn'); i++) await settleFor(250); return doc.querySelector('#topbar .paused-btn'); };
    const topPill = await pill();
    ok(!!topPill && /^⏸ Emergency stop until .+ · Resume$/.test(topPill.textContent), `stop: the top bar does not say until when (${topPill ? topPill.textContent : 'no button'})`);
    ok(!topPill || /^Emergency stop: no request goes to any cluster since .* It ends by itself at/.test(topPill.title), `stop: the top-bar button does not say since and until when (${topPill && topPill.title})`);
    ok(/^Emergency stop:/.test((doc.querySelector('.rq-status h2') || {}).textContent || ''), `stop: the status line does not say stopped: "${(doc.querySelector('.rq-status h2') || {}).textContent}"`);
    if (resume) {
      resume.click(); await settleFor(800);
      ok(countOf('POLICY_RESUME') === resumes + 1 && countOf('POLICY_SET') === sets, `stop: Resume now sent ${countOf('POLICY_RESUME') - resumes} POLICY_RESUME, ${countOf('POLICY_SET') - sets} POLICY_SET`);
      ok(!!(stopCard() && stopCard().querySelector('button[data-act="pause-all"]')), 'stop: after resuming, the card does not offer the stop again');
      ok(!/^Emergency stop:/.test((doc.querySelector('.rq-status h2') || {}).textContent || ''), 'stop: the status line still says stopped after resuming');
      for (let i = 0; i < 20 && doc.querySelector('#topbar .paused-btn'); i++) await settleFor(250);
      ok(!doc.querySelector('#topbar .paused-btn'), 'stop: the top bar still says stopped after resuming');
    }
  }

  // An operator (roles plan, decision 2): the Requests tab opens on the stop alone — the same
  // three lengths, asking first — with no request log (the top bar is tools/unit/operator-stop).
  // One limited to some clusters sees the stop and why it is not theirs.
  {
    const st = await load('core/state.js');
    const was = st.state.caller;
    try {
      st.state.caller = { name: 'olga', role: 'operator' };
      await go('overview');
      const from = sent.length;   // not emptied: later cases read every REFRESH this run sent
      await go('requests'); await settleFor(600);
      const card = stopCard();
      const mine = sent.slice(from);
      ok(!!card && /Emergency stop/.test(card.textContent), 'operator: no emergency stop on the Request Centre');
      ok(!mine.some((x) => x.type === 'REQUEST_LOG' || x.type === 'HOUSEKEEPING_GET'), `operator: the page asked for the admin's log (${mine.map((x) => x.type).join(',')})`);
      ok(!doc.querySelector('.rq-tbl') && !doc.querySelector('.rq-tiles'), 'operator: the request log is drawn for an operator');
      const opLengths = card ? [...card.querySelectorAll('button[data-act="pause-all"]')].map((b) => b.textContent) : [];
      ok(JSON.stringify(opLengths) === JSON.stringify(['15 min', '30 min', '60 min']), `operator: the lengths offered are ${JSON.stringify(opLengths)}`);
      const q = card && card.querySelector('button[data-act="pause-all"]');
      if (q) {
        const pauses = countOf('POLICY_PAUSE');
        q.click(); await settleFor(300);
        const dlg = doc.querySelector('.modal-overlay .modal');
        ok(!!dlg && /Stop all requests for 15 minutes\?/.test(dlg.textContent), 'operator: "15 min" did not ask first');
        if (dlg) { button('No', dlg).click(); await settleFor(300); }
        ok(countOf('POLICY_PAUSE') === pauses, 'operator: answering No still stopped');
      }
      st.state.caller = { name: 'uma@zabbix', role: 'operator', scoped: true };
      await go('overview'); await go('requests'); await settleFor(600);
      ok(stopCard() && !stopCard().querySelector('button') && /limited to some clusters/.test(stopCard().textContent),
        `operator: a limited operator is offered the stop: "${stopCard() && stopCard().textContent}"`);
    } finally {
      st.state.caller = was;
    }
  }

  // Config → Requests no longer pauses anything; it says what happens on its own instead.
  await go('settings');
  await openSettingsTab('Requests'); await settleFor(300);
  ok(!doc.getElementById('pol-all') && !doc.querySelector('input[data-pol-cluster]'), 'automation: Config → Requests still has pause boxes');
  ok(/handled on their own/.test((doc.getElementById('pol-auto') || {}).textContent || ''), 'automation: Config → Requests does not say slow and busy clusters are handled on their own');
  await go('requests'); await settleFor(300);

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
    const cur = cfgOpen();
    ok(cur.page === 'requests' && cur.tab === 'policy', `status: the mode link did not open Config-Management › Requests › Policy (open: ${JSON.stringify(cur)})`);
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
    // It waits for its answer, but no longer than a person is ever held: 10 s (0.3.44).
    const pageWait = (await load('core/state.js')).PAGE_WAIT_SEC;
    ok(pageWait === 10 && reads.every((m) => m.wait === pageWait), `coverage: a Read all ask did not wait ${pageWait} s for its answer: ${JSON.stringify([...new Set(reads.map((m) => m.wait))])}`);
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
         ilm: { operation_mode: 'RUNNING' }, ilmErrors: { 'logstash-1': { failed_step: 'rollover' }, 'logstash-2': { failed_step: 'rollover' } } },
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
    ok(/^\d+ critical · \d+ high · \d+ warning · in 3 of 4 clusters · 0 acknowledged/.test(sumText()), `alerts: the summary line reads "${sumText()}"`);
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

    // Held from cached data: kestrel-dc's last good answers are in the fleet cache (health
    // yellow, a disk at 95 %, read 12 minutes ago). Its rules run on them — nothing is asked of
    // the cluster — and what they raise is held under its line, "as of" that read, counted
    // nowhere, and can be acknowledged there.
    {
      const sumBefore = [...doc.querySelector('#view .alerts-sum').children].map((x) => x.textContent.trim()).join(' ');
      const openBefore = st.openAlertCounts();
      const readAt = Date.now() - 12 * 60000;
      const ans = (json) => ({ ok: true, status: 200, kind: 'ok', message: '', json, tookMs: 5 });
      const ent = (data, extra = {}) => ({ status: 'ok', fetchedAt: readAt, attemptedAt: readAt, nextDue: Date.now() + 60000,
        tookMs: 5, staleAfterMs: 360000, seq: 1, error: null, data, ...extra });
      const wasMode = st.fleet.mode;
      const wasRaw = st.fleet.raw.get('k');
      const sentBefore = sent.length;
      st.fleet.mode = 'fleet';
      st.fleet.raw.set('k', { reach: { state: 'unreachable', since: Date.now() - 18 * 60000 }, datasets: {
        health: ent({ root: ans({ name: 'k1', cluster_name: 'kestrel', version: { number: '8.13.0' } }), health: ans({ status: 'yellow', unassigned_shards: 2 }) },
          { status: 'error', attemptedAt: Date.now() - 60000, error: { ok: false, kind: 'connect', message: 'ECONNREFUSED' } }),
        nodes: ent({ nodes: ans([{ name: 'k1', master: '*' }]), alloc: ans([{ node: 'k1', 'disk.used': '95', 'disk.total': '100', 'disk.avail': '5', shards: '3' }]) }),
      } });
      st.invalidateAlerts(); await go('alerts');
      const line = () => doc.querySelector('#view .adown .adown-row');
      ok(/3 older alerts held, not current · as of /.test(line() ? line().querySelector('.adown-meta').textContent : ''),
        `alerts: the line does not say what is held from cache, and as of when: "${line() && line().querySelector('.adown-meta').textContent}"`);
      const sumNow = [...doc.querySelector('#view .alerts-sum').children].map((x) => x.textContent.trim()).join(' ');
      ok(sumNow === sumBefore, `alerts: held alerts changed the summary: "${sumBefore}" → "${sumNow}"`);
      ok(JSON.stringify(st.openAlertCounts()) === JSON.stringify(openBefore), 'alerts: held alerts changed the open counts (bell, tab, top bar)');
      ok(![...doc.querySelectorAll('#view .agroup:not(.adown) .arow')].some((r) => /kestrel-dc/.test(r.textContent)), 'alerts: a held alert is listed as a current row');
      line().querySelector('.arow-toggle').click(); await settleFor(80);
      const heldRows = () => [...doc.querySelectorAll('#view .adown .aheld-row')];
      const diskRow = () => heldRows().find((r) => /Disk usage above/.test(r.textContent));
      ok(heldRows().length === 3 && !!diskRow(), `alerts: expected the automation, health and disk held, saw ${heldRows().map((r) => r.textContent.slice(0, 40)).join(' | ')}`);
      ok(diskRow() && /^as of /.test(diskRow().querySelector('.aheld-age').textContent), `alerts: a held disk alert does not say "as of": "${diskRow() && diskRow().querySelector('.aheld-age').textContent}"`);
      ok(sent.length === sentBefore || sent.slice(sentBefore).every((m) => !/kestrel|k\.example/.test(JSON.stringify(m))), 'alerts: evaluating held alerts asked the down cluster for something');
      const ackBtn = diskRow() && diskRow().querySelector('button.aheld-ack');
      ok(ackBtn && ackBtn.textContent === 'Ack', 'alerts: a held alert has no Ack');
      if (ackBtn) {
        ackBtn.click(); await settleFor(150);
        ok(acks.isAcked('k:disk'), 'alerts: Ack on a held alert wrote no acknowledgement under its own key');
        ok(diskRow() && /acknowledged by qa/.test(diskRow().textContent), `alerts: the held row does not say it is acknowledged: "${diskRow() && diskRow().textContent}"`);
        ok(JSON.stringify(st.openAlertCounts()) === JSON.stringify(openBefore), 'alerts: acknowledging a held alert changed the open counts');
        await acks.unacknowledge('k:disk');
      }
      line().querySelector('.arow-toggle').click(); await settleFor(60);
      if (wasRaw) st.fleet.raw.set('k', wasRaw); else st.fleet.raw.delete('k');
      st.fleet.mode = wasMode;
      st.invalidateAlerts(); await go('alerts');
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

    // High (2026-11-01): a node over 85 % heap is a High row — an orange "high" pill — counted on
    // its own in the summary line, and its count filters to it as the others do.
    {
      const cnt = (id) => doc.getElementById(id);
      const levels = () => [...doc.querySelectorAll('#view .arow:not(.adown-row) > .arow-main > .apill')].map((x) => x.textContent);
      const a0 = st.state.data.get('a');
      // Two node readings in a row over 85 % (the rule's hysteresis): each fetch is a new node list.
      for (let i = 0; i < 2; i++) {
        st.state.data.set('a', { ...a0, nodes: [{ name: 'es-hot-1', 'heap.percent': '93' }, { name: 'es-hot-2', 'heap.percent': '40' }] });
        st.alerts();
      }
      await acks.unacknowledge('a:heap');
      st.invalidateAlerts(); await go('alerts');
      const hiRows = [...doc.querySelectorAll('#view .arow')].filter((r) => r.querySelector(':scope > .arow-main > .apill.high'));
      ok(hiRows.length === 1 && /JVM heap above 85%/.test(hiRows[0].textContent) && hiRows[0].querySelector('.apill.high').textContent === 'high',
        `alerts: a node at 93 % heap is not one High row (saw ${hiRows.length}: ${hiRows.map((r) => r.textContent.slice(0, 60)).join(' | ')})`);
      ok(/^\d+ critical · 1 high · \d+ warning · /.test(sumText()), `alerts: the summary line does not count the High alert: "${sumText()}"`);
      ok(levels().indexOf('high') > levels().lastIndexOf('critical') && levels().indexOf('high') < levels().indexOf('warning'),
        `alerts: High is not between critical and warning in its group: ${levels().join(',')}`);
      cnt('alerts-sum-high').click(); await settleFor(60);
      ok(press('High') && press('High').getAttribute('aria-pressed') === 'true' && levels().length === 1 && levels()[0] === 'high' && !doc.querySelector('#view .adown'),
        `alerts: the high count did not show the High alert only: ${levels().join(',')}`);
      cnt('alerts-sum-high').click(); await settleFor(60);
      ok(press('All').getAttribute('aria-pressed') === 'true', 'alerts: pressing the high count again did not show all');
      st.state.data.set('a', a0);
      st.invalidateAlerts(); await go('alerts');
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
    ok(doc.getElementById('alerts-search') === search, 'alerts: typing a search rebuilt the search field (it must be the same element while typed into)');
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
    d.ilm = { operation_mode: 'RUNNING' }; d.ilmErrors = { 'logstash-x-1': {} };
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
  // The four on port 9 are found unreachable when the core's first answer for them lands, which
  // on a busy machine can be after applyConfig returns: wait for it (at most 10 s) before counting.
  for (let i = 0; i < 40 && !all.some((c) => st.healthState(st.state.data.get(c.id)) === 'unreachable'); i++) await settleFor(250);
  const down = all.filter((c) => st.healthState(st.state.data.get(c.id)) === 'unreachable');
  ok(down.length >= 1, `evidence: the fixture has no unreachable cluster (${down.length}) - it would prove nothing about them`);
  const byName = (n) => all.find((c) => c.name.startsWith(n));
  const main = byName('evc-03');
  const other = byName('evc-09');
  const dead = down[0];

  // The chooser lists every cluster by design (0.3.42); what the page SAYS is everything else.
  const text = () => { const c = doc.body.cloneNode(true); c.querySelectorAll('#cluster-select').forEach((x) => x.remove()); return c.textContent; };
  const barText = () => (doc.getElementById('topbar') || { textContent: '' }).textContent;
  const noOthers = (where, mine) => {
    for (const c of all) if (c.id !== mine.id && text().includes(c.name)) problems.push(`evidence ${where}: the page names another cluster, ${c.name}`);
  };
  const noFleetChrome = (where) => {
    const bar = doc.getElementById('topbar');
    ok(!/\d+\s+(green|yellow|red|unreachable|loading)\b/.test(bar.textContent), `evidence ${where}: a fleet status chip is in the top bar: "${bar.textContent}"`);
    ok(![...bar.querySelectorAll('button')].some((b) => /^\d+ alerts?$/.test(b.textContent.trim())), `evidence ${where}: the alerts chip is in the top bar`);
    ok(!bar.querySelector('.bell'), `evidence ${where}: the bell is in the top bar`);
    const pickEl = bar.querySelector('#cluster-select');
    ok(!!pickEl, `evidence ${where}: no cluster chooser in the top bar`);
    ok(!bar.querySelector('#cluster-finder, .cl-find'), `evidence ${where}: the find-box is in the top bar`);
    ok(!pickEl || ![...pickEl.options].some((o) => o.value === 'all'), `evidence ${where}: the chooser offers "All clusters"`);
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

  // Snapshots with "All clusters": picks one cluster by itself (the first, nothing chosen yet),
  // draws no fleet, and the chooser changes it.
  await go('snapshots'); await settleFor(300);
  {
    ok(!doc.getElementById('evidence-pick') && !/Evidence needs one cluster/.test(text()), 'evidence snapshots: with "All clusters" the page asks instead of picking one');
    ok(st.state.selected === all[0].id, `evidence snapshots: arrived on ${st.state.selected}, expected the first cluster ${all[0].id}`);
    const pick = doc.getElementById('cluster-select');
    ok(pick && pick.value === all[0].id, 'evidence snapshots: the chooser does not show the picked cluster');
    ok(!doc.querySelector('#view section.lazy-block, #view .seg') || st.state.selected !== 'all', 'evidence snapshots: a fleet of snapshot lists is drawn');
    noFleetChrome('snapshots (arriving)');
    if (pick) { pick.value = main.id; pick.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(500); }
  }

  for (const [id, label] of [['snapshots', 'Snapshots'], ['console', 'REST'], ['indices', 'Indices']]) {
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
    const chip = doc.getElementById('cluster-select');
    ok(chip && chip.value === main.id, `evidence ${id}: the chooser does not show this cluster: "${chip && chip.value}"`);
    ok([...doc.querySelectorAll('#topbar button')].some((b) => /Refresh/.test(b.textContent)), `evidence ${id}: no Refresh in the top bar`);
    noFleetChrome(id);
    if (id === 'snapshots') {
      // Where the backups are kept (a bucket, an NFS path) is not evidence and must not be in
      // it (user decision, 0.3.23): no Location column and no repository path, in either view.
      // The mock's "daily" repository is an fs repository at /mnt/backups.
      // Both levels: the repositories and policies, then one repository opened.
      { const back = doc.querySelector('#view button[data-act="back-to-repos"]'); if (back) { back.click(); await settleFor(200); } }
      for (const label of ['Repositories', 'Opened repository']) {
        if (label === 'Opened repository') {
          const b = doc.querySelector('#view button[data-act="open-repo"]');
          if (b) { b.click(); await settleFor(300); }
          ok(!!b && !!doc.querySelector('input[aria-label="Search snapshots"]'), 'evidence snapshots: Open did not show the snapshot list');
        }
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

/* ------- 0.3.46: a new cluster that uses the default credential never asks for a password ------- */

// Hosted, driven through the real dialogs. The dev bridge is the portable build, so the
// hosted messages are answered at fetch: CREDENTIAL_* from a small server-side model, PRIME
// passed through with the hosted core's `defaultCredential` added, the config write kept in
// memory. What is checked is what the page sends and what it shows.
{
  const st = await load('core/state.js');
  const sc = await load('core/server-credentials.js');
  const ce = await load('ui/config-editor.js');
  const cd = await load('ui/credential-dialog.js');
  const realFetch = globalThis.fetch;
  const server = { default: { id: '*', user: 'fleet', kind: 'basic', setBy: 'Admin', setAt: 1793000000 }, own: [],
                   promotable: [] };
  const credSent = [];
  const primeSent = [];
  let failWrites = 0;
  let written = null;
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const t = String(body.type || '');
    if (t === 'CREDENTIAL_STATUS') {
      return stubReply({ ok: true, default: server.default, clusters: server.own, promotable: server.default ? [] : server.promotable, problem: null });
    }
    if (t === 'CREDENTIAL_SET' || t === 'CREDENTIAL_CLEAR' || t === 'CREDENTIAL_PROMOTE') {
      credSent.push(body);
      if (t === 'CREDENTIAL_PROMOTE') {
        const p = server.promotable.find((x) => x.id === body.from);
        if (server.default && !body.replace) return stubReply({ ok: false, kind: 'exists', message: 'a default credential is already set' });
        server.default = { id: '*', user: p ? p.user : 'x', kind: 'basic', setBy: 'Admin', setAt: 1793000001 };
        return stubReply({ ok: true, cluster: '*', from: body.from, user: server.default.user, kind: 'basic', replaced: false });
      }
      if (t === 'CREDENTIAL_SET' && body.cluster === '*') {
        if (body.onlyIfAbsent && server.default) return stubReply({ ok: false, kind: 'exists', user: server.default.user, message: 'a default credential is already set' });
        server.default = { id: '*', user: body.username || null, kind: 'basic', setBy: 'Admin', setAt: 1793000002 };
      }
      return stubReply({ ok: true, cluster: body.cluster });
    }
    if (t === 'PRIME') {
      primeSent.push(body);
      const r = await realFetch(input, init);
      const res = JSON.parse(await r.text());
      return stubReply({ ...res, defaultCredential: !!server.default });
    }
    if (t === 'CONFIG_WRITE' && failWrites > 0) { failWrites--; return stubReply({ ok: false, kind: 'io_error', message: 'disk full' }); }
    if (t === 'CONFIG_WRITE') { written = body.text; return stubReply({ ok: true, path: body.path, bytes: body.text.length }); }
    if (t === 'CONFIG_READ' && written !== null) return stubReply({ ok: true, text: written, size: written.length, lastModified: Date.now() });
    return realFetch(input, init);
  };
  const dialog = () => doc.querySelector('.modal-overlay .modal');
  const closeAll = async () => { for (const o of doc.querySelectorAll('.modal-overlay')) o.remove(); await settleFor(50); };
  const press = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const button = (root, re) => root && [...root.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
  const signInButton = () => button(doc.getElementById('topbar'), /^Sign in/);
  // A dialog that never closes (the defect under test) must fail a check, not hang the run.
  const within = (p, ms = 4000) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  try {
    sc.setHostedEdition(true);
    st.state.caller = { name: 'default-check', role: 'admin' };
    // A config file with no credential at all, as on the hosted server.
    const url = config.clusters[0].url;
    await applyConfig({ load, configPath, raw: { version: 2, defaults: { readOnly: true, autoRefresh: false }, clusters: [{ name: 'dc-one', url }] } });
    written = JSON.stringify({ version: 2, defaults: { readOnly: true, autoRefresh: false }, clusters: [{ name: 'dc-one', url }] });
    await go('overview');
    ok(!st.clustersNeedingCredential().length, `default: with a default set, ${st.clustersNeedingCredential().map((c) => c.name).join(', ')} still "need" a credential`);
    ok(!signInButton(), 'default: "Sign in" is in the top bar although the default covers every cluster');

    // Add a cluster: the Default choice is preselected, names the user, and nothing is asked.
    credSent.length = 0;
    const adding = ce.editCluster(null);
    await settleFor(300);
    let dlg = dialog();
    ok(dlg && /Add cluster/.test(dlg.textContent), 'default: the Add cluster dialog did not open');
    if (dlg) {
      const def = dlg.querySelector('#ce-cred-default'), own = dlg.querySelector('#ce-cred-own');
      ok(def && def.checked && own && !own.checked, 'default: a new cluster does not start on the default credential');
      ok(/Default credential \(user fleet\)/.test(dlg.textContent), 'default: the Default choice does not name the default\'s user');
      ok(dlg.querySelector('#ce-cred-ownblock').hidden, 'default: the own-credential fields show although the default is chosen');
      ok(!dlg.querySelector('#ce-du') && !dlg.querySelector('#ce-dp'), 'default: a default is set, yet the dialog offers to set one');
      dlg.querySelector('#ce-name').value = 'dc-two';
      dlg.querySelector('#ce-url').value = url;
      press(button(dlg, /^Add cluster$/));
      await within(adding); await settleFor(600);
      ok(!dialog(), `default: the Add cluster dialog stayed open: ${(doc.querySelector('.modal-msg') || {}).textContent || ''}`);
      ok(!credSent.length, `default: adding a cluster on the default sent ${credSent.map((m) => m.type).join(', ')}`);
      const saved = written ? JSON.parse(written).clusters.find((c) => c.name === 'dc-two') : null;
      ok(saved && !saved.username && !saved.password && !saved.apiKey, `default: the new cluster was written with a credential: ${JSON.stringify(saved)}`);
      ok(st.clusters().some((c) => c.name === 'dc-two') && !st.clustersNeedingCredential().length,
        `default: the new cluster "needs" a credential: ${st.clustersNeedingCredential().map((c) => c.name).join(', ')}`);
      await go('overview');
      ok(!signInButton(), 'default: "Sign in" appeared after adding a cluster on the default');
      // Any way into the sign-in dialog says "using the default" and shows no form.
      cd.showCredentialDialog('startup');
      await settleFor(300);
      ok(!doc.querySelector('.modal.creds'), 'default: the credential dialog opened a form although the default covers every cluster');
      ok(/Using the default credential/.test((doc.querySelector('.toast-wrap') || {}).textContent || ''), 'default: the page did not say it uses the default credential');
    }
    await closeAll();

    // No default, one promotable entry: the Credentials card offers it, and pressing sends PROMOTE.
    server.default = null;
    server.promotable = [{ id: 'Local-ES-Cluster', cluster: 'Local-ES-Cluster', source: 'zabbix', user: 'zabbix', kind: 'basic', setBy: 'zabbix-admin', setAt: 1793000000 }];
    credSent.length = 0;
    await go('settings');
    ok(await openSettingsTab('Credentials'), 'promote: no Credentials tab in Config-Management');
    await settleFor(200);
    const promote = doc.getElementById('kc-promote');
    ok(promote && /Use Local-ES-Cluster’s credential \(user zabbix\) as the default for every cluster without its own/.test(promote.textContent),
      `promote: the Credentials card does not offer the kept credential as the default (${promote ? promote.textContent : 'no button'})`);
    ok(/No default credential/.test((doc.getElementById('kept-cred') || {}).textContent || ''), 'promote: the card does not say there is no default');
    if (promote) {
      promote.click(); await settleFor(600);
      ok(credSent.length === 1 && credSent[0].type === 'CREDENTIAL_PROMOTE' && credSent[0].from === 'Local-ES-Cluster' && !credSent[0].replace,
        `promote: pressing it sent ${JSON.stringify(credSent)}`);
      ok(!doc.getElementById('kc-promote'), 'promote: the offer is still there after the default was set');
    }
    // The Add dialog with no default and a promotable entry: the choice is offered, and taken.
    server.default = null;
    credSent.length = 0;
    const adding2 = ce.editCluster(null);
    await settleFor(300);
    dlg = dialog();
    if (dlg) {
      ok(/Default credential — none set yet/.test(dlg.textContent), 'promote: the Default choice does not say none is set');
      const src = dlg.querySelector('#ce-defsrc');
      ok(src && src.value === 'Local-ES-Cluster', `promote: the dialog does not offer the kept credential as the default (${src && src.value})`);
      ok(dlg.querySelector('#ce-deftype') && dlg.querySelector('#ce-deftype').hidden, 'promote: the type-it-here fields show while a kept one is chosen');
      dlg.querySelector('#ce-name').value = 'dc-three';
      dlg.querySelector('#ce-url').value = url;
      press(button(dlg, /^Add cluster$/));
      await within(adding2); await settleFor(600);
      ok(credSent.some((m) => m.type === 'CREDENTIAL_PROMOTE' && m.from === 'Local-ES-Cluster'), `promote: adding with it chosen sent ${JSON.stringify(credSent)}`);
      ok(!credSent.some((m) => m.type === 'CREDENTIAL_SET'), 'promote: a password was sent although a kept one was chosen');
    } else problems.push('promote: the Add cluster dialog did not open');
    await closeAll();

    // The credential dialog never overwrites the default unless the box is ticked.
    server.default = { id: '*', user: 'fleet', kind: 'basic', setBy: 'Admin', setAt: 1793000000 };
    await go('overview');
    const one = st.clusters().find((c) => c.name === 'dc-one');
    const failAgain = () => { const cl = st.client(one.id); if (cl) cl.state = 'auth_error'; };
    const typeAndConnect = async (tick) => {
      failAgain();
      cd.showCredentialDialog('auth_error');
      await settleFor(300);
      let m = doc.querySelector('.modal.creds');
      ok(m && /The default credential was rejected by dc-one/.test(m.textContent), `rejected: the dialog does not say the default was rejected (${m ? m.textContent.slice(0, 120) : 'none'})`);
      ok(!!button(m, /^Set its own credential…$/), 'rejected: no "Set its own credential…"');
      ok(!m || !m.querySelector('#cd-pass'), 'rejected: a generic sign-in form is the first thing shown');
      press(button(m, /^Type a credential instead/)); await settleFor(100);
      m = doc.querySelector('.modal.creds');
      const box = m && m.querySelector('#cd-replace-default');
      ok(box && !box.checked, 'replace: no "Replace the default credential" box, or it starts ticked');
      if (!m || !box) return;
      if (tick) { box.checked = true; box.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(50); }
      m = doc.querySelector('.modal.creds');
      // The list is exactly what the credential will be kept for (review item 4), not "all N".
      if (!tick) {
        const rows = [...m.querySelectorAll('.cd-targets .cd-row')].map((r) => r.textContent);
        ok(rows.length === 1 && rows[0].includes('dc-one') && /Kept as the own credential of 1 cluster/.test(m.textContent) && /Connect 1 cluster\b/.test(m.textContent),
          `replace: the dialog lists ${rows.length} cluster(s) (${rows.join(' | ')}) for a credential kept for dc-one only`);
      }
      m.querySelector('#cd-user').value = 'typed-user';
      m.querySelector('#cd-pass').value = 'typed-pw';
      credSent.length = 0;
      primeSent.length = 0;
      press(button(m, /^Connect/)); await settleFor(1200);
    };
    await typeAndConnect(false);
    ok(credSent.length && credSent.every((m) => m.type === 'CREDENTIAL_SET' && m.cluster !== '*'),
      `replace: unticked, the dialog sent ${JSON.stringify(credSent.map((m) => ({ type: m.type, cluster: m.cluster })))}`);
    // Review item 1: what was typed is not held by the page, so no PRIME carries it as the
    // shared credential the core would keep as the default.
    {
      const typed = Buffer.from('typed-user:typed-pw').toString('base64');
      await st.reprime();
      ok(primeSent.length > 0 && primeSent.every((p) => !('sharedAuthHeader' in p) && !JSON.stringify(p).includes(typed)),
        `replace: after the unticked dialog a PRIME carried ${JSON.stringify(primeSent.map((p) => p.sharedAuthHeader))}`);
      ok(!st.hasSessionCredential(), 'replace: the page holds the typed credential');
    }
    await closeAll();
    await typeAndConnect(true);
    ok(credSent.some((m) => m.type === 'CREDENTIAL_SET' && m.cluster === '*' && !m.onlyIfAbsent), 'replace: ticked, the default was not replaced');
    await closeAll();
    for (const c of st.clusters()) { const cl = st.client(c.id); if (cl) cl.state = 'unknown'; }

    // Review item 2: the Add dialog sets the default once. A config save that fails leaves it
    // set (and says so); pressing again saves the cluster without setting it a second time.
    server.default = null; server.promotable = []; server.own = [];
    credSent.length = 0;
    failWrites = 1;
    const adding3 = ce.editCluster(null);
    await settleFor(300);
    dlg = dialog();
    if (dlg) {
      dlg.querySelector('#ce-name').value = 'dc-four';
      dlg.querySelector('#ce-url').value = url;
      dlg.querySelector('#ce-du').value = 'set-once';
      dlg.querySelector('#ce-dp').value = 'set-once-pw';
      press(button(dlg, /^Add cluster$/)); await settleFor(500);
      const said = (dlg.querySelector('.modal-msg') || {}).textContent || '';
      ok(/WAS set/.test(said), `retry: a failed save after setting the default does not say it was set ("${said}")`);
      ok(credSent.length === 1 && credSent[0].cluster === '*' && credSent[0].onlyIfAbsent === true, `retry: the default was set with ${JSON.stringify(credSent.map((m) => ({ c: m.cluster, o: m.onlyIfAbsent })))}`);
      press(button(dlg, /^Add cluster$/)); await within(adding3); await settleFor(500);
      ok(!dialog(), `retry: the second press did not save (${(doc.querySelector('.modal-msg') || {}).textContent || ''})`);
      ok(credSent.filter((m) => m.cluster === '*').length === 1, 'retry: the default was set a second time');
      ok(written && JSON.parse(written).clusters.filter((c) => c.name === 'dc-four').length === 1, 'retry: the cluster is not in the file exactly once');
    } else problems.push('retry: the Add cluster dialog did not open');
    await closeAll();

    // Review item 3: switching to the default asks only once the rest of the form is valid.
    server.default = null;
    const two = st.clusters().find((c) => c.name === 'dc-two');
    server.own = two ? [{ id: two.id, user: 'own-two', kind: 'basic', setBy: 'Admin', setAt: 1793000000 }] : [];
    credSent.length = 0;
    const editing = ce.editCluster(ce.rawClusterOf(two));
    await settleFor(300);
    dlg = dialog();
    if (dlg) {
      ok(dlg.querySelector('#ce-cred-own').checked, 'switch: a cluster with its own credential does not start on it');
      const def = dlg.querySelector('#ce-cred-default');
      def.checked = true; def.dispatchEvent(new window.Event('change', { bubbles: true }));
      press(button(dlg, /^Save$/)); await settleFor(300);
      const overlays = doc.querySelectorAll('.modal-overlay').length;
      ok(overlays === 1, `switch: the confirmation was asked before the empty default fields were checked (${overlays} dialogs open)`);
      ok(/Set the default credential once/.test((dlg.querySelector('.modal-msg') || {}).textContent || ''), 'switch: the empty default fields were not reported');
      ok(!credSent.length, `switch: something was sent for an invalid form: ${JSON.stringify(credSent)}`);
      press(button(dlg, /^Cancel$/)); await within(editing); await settleFor(100);
    } else problems.push('switch: the Edit cluster dialog did not open');
    await closeAll();

    // Review item 5: a cluster connected anonymously says so, and choosing the default drops it.
    server.default = { id: '*', user: 'fleet', kind: 'basic', setBy: 'Admin', setAt: 1793000000 };
    server.own = [];
    const anon = st.clusters().find((c) => c.name === 'dc-one');
    anon.anonymous = true;
    const editing2 = ce.editCluster(ce.rawClusterOf(anon));
    await settleFor(300);
    dlg = dialog();
    if (dlg) {
      const none = dlg.querySelector('#ce-cred-none');
      ok(none && none.checked && /No credential \(connected anonymously\)/.test(dlg.textContent), 'anonymous: the dialog does not say the cluster is connected without a credential');
      const def = dlg.querySelector('#ce-cred-default');
      def.checked = true; def.dispatchEvent(new window.Event('change', { bubbles: true }));
      primeSent.length = 0;
      press(button(dlg, /^Save$/)); await within(editing2); await settleFor(500);
      ok(primeSent.some((p) => (p.dropAnonymous || []).includes(anon.id)), `anonymous: choosing the default did not withdraw "anonymous" (${JSON.stringify(primeSent.map((p) => p.dropAnonymous))})`);
    } else problems.push('anonymous: the Edit cluster dialog did not open');
    await closeAll();
  } finally {
    globalThis.fetch = realFetch;
    sc.setHostedEdition(false);
    await closeAll();
  }
}

// Play opens in the browser's full screen (docs/PLAY.md): pressing "▶ Play" asks for it inside
// the click and lands on #/play; the page's ⛶ button and F key toggle it; Esc leaving it keeps
// Play running; leaving Play gives the screen back only if Play took it; a refusal is silent.
{
  const root = doc.documentElement;
  const calls = { req: 0, exit: 0 };
  let refuse = false;
  const change = () => doc.dispatchEvent(new window.Event('fullscreenchange'));
  const setFs = (v) => Object.defineProperty(doc, 'fullscreenElement', { value: v, configurable: true });
  root.requestFullscreen = async () => {
    calls.req++;
    if (refuse) throw new TypeError('refused');
    setFs(root); change();
  };
  doc.exitFullscreen = async () => { calls.exit++; setFs(null); change(); };
  const fsBtn = () => doc.querySelector('.pl-ctl .pl-fs');
  const label = () => (fsBtn() ? fsBtn().getAttribute('aria-label') : null);
  const key = (k) => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  try {
    await go('overview');
    const play = doc.getElementById('play-btn');
    ok(!!play, 'fullscreen: no ▶ Play button in the top bar');
    if (play) {
      play.click(); await settleFor(600);
      ok(calls.req === 1, `fullscreen: ▶ Play asked for full screen ${calls.req} times`);
      ok(/#\/play$/.test(window.location.hash), `fullscreen: ▶ Play landed on "${window.location.hash}"`);
      ok(label() === 'Leave full screen', `fullscreen: the ⛶ button reads "${label()}" while full screen`);
      key('f'); await settleFor(300);
      ok(calls.exit === 1 && label() === 'Full screen', 'fullscreen: F did not leave full screen');
      key('F'); await settleFor(300);
      ok(calls.req === 2, 'fullscreen: F did not enter full screen');
      setFs(null); change();   // Esc
      await settleFor(100);
      ok(/#\/play$/.test(window.location.hash) && label() === 'Full screen', 'fullscreen: Esc leaving full screen did not keep Play running');
      if (fsBtn()) { fsBtn().click(); await settleFor(300); }
      ok(calls.req === 3, 'fullscreen: the ⛶ button did not enter full screen');
      await go('overview');
      ok(calls.exit === 2, `fullscreen: leaving Play exited ${calls.exit - 1} times, expected 1`);
      refuse = true;
      doc.getElementById('play-btn').click(); await settleFor(600);
      ok(/#\/play$/.test(window.location.hash), 'fullscreen: a refused request stopped Play opening');
      refuse = false;
      await go('overview');
      ok(calls.exit === 2, 'fullscreen: leaving Play exited a full screen it never entered');
    }
  } finally {
    delete root.requestFullscreen; delete doc.exitFullscreen;
    try { delete doc.fullscreenElement; } catch (_) { /* own property only */ }
    await go('overview');
  }
}

// Config > Play (0.3.47): the section opens (and says so when the core is older); a new link sends
// the permanent default and shows its URL once; an old link is replaced (revoked, then made again
// with the same settings, the new URL shown once); revoke asks first; an empty reason is refused;
// a field config.txt manages is locked and left out of the watch-rule save; the save payload.
//
// The watch rules and the exclusions go to this real core (PLAY_CONFIG_GET / PLAY_CONFIG_SET,
// wrapped as {settings}), and what it kept is read back. Stubbed, and only these: PLAY_LINK_*
// (display links are the hosted server's; this portable dev bridge answers `unsupported`, and
// tools/play-e2e.mjs drives them against a hosted one), and the config.txt lock laid over the
// real PLAY_CONFIG_GET reply (`managed` / `managedFields`: this bridge was started without one).
{
  await go('settings');
  const realFetch = globalThis.fetch;
  const sent = [];
  let older = true;
  const core = async (msg) => (await realFetch(`${bridgeUrl}/bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })).json();
  const closeAll = async () => { for (const o of doc.querySelectorAll('.modal-overlay')) o.remove(); await settleFor(50); };
  const cid = (await load('core/state.js')).clusters()[0].id;
  // What the core's PLAY_LINK_LIST says of a link: never a URL or a secret.
  let links = [{ id: 'l1', name: 'NOC wall', clusters: 'all', allowFrom: ['10.1.0.0/16'], expires: 'permanent', expiresAt: null, expired: false,
    createdAt: Date.now() - 86400000, createdBy: 'Admin', lastSeen: { at: Date.now() - 120000, from: '10.1.2.3' }, sessions: 1,
    settings: { slides: [{ id: 'alerts', show: true, dwellSec: 30 }], criticalTakesScreen: true, spotlightAll: false, theme: 'dark', sound: 'off', zoom: 1.25 } }];
  let made = 0;
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(body.type || '').startsWith('PLAY_')) {
      sent.push(body);
      if (older) return stubReply({ ok: false, kind: 'bad_message', message: `Unknown message type "${body.type}"` });
      switch (body.type) {
        case 'PLAY_CONFIG_GET': {
          const real = await core({ type: 'PLAY_CONFIG_GET' });
          return stubReply({ ...real, watch: { ...real.watch, delayRedAboveMin: 75 }, managed: ['UI_PLAY_DELAY_RED_MIN'],
            managedFields: { 'watch.delayRedAboveMin': 'UI_PLAY_DELAY_RED_MIN' }, groups: ['Prod'] });
        }
        case 'PLAY_LINK_LIST': return stubReply({ ok: true, enabled: true, links });
        case 'PLAY_LINK_CREATE': {
          made++;
          const link = { id: `n${made}`, name: body.name, clusters: body.clusters, allowFrom: body.allowFrom || [], expires: 'permanent', expiresAt: null,
            lastSeen: null, sessions: 0, settings: body.settings || {} };
          links = [...links, link];
          return stubReply({ ok: true, link: { ...link, url: `https://noc.example/#/play?display=SECRET${made}` }, secret: `SECRET${made}` });
        }
        case 'PLAY_LINK_REVOKE': links = links.filter((l) => l.id !== body.id); return stubReply({ ok: true, id: body.id, sessionsEnded: 1 });
        case 'PLAY_LINK_SET': return stubReply({ ok: true, id: body.id, settings: body.settings });
        default: return realFetch(input, init);
      }
    }
    return realFetch(input, init);
  };
  const view = () => doc.querySelector('#view');
  const type = (id, v) => { const el = doc.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); } return !!el; };
  const pressIn = async (root, re) => { const b = [...root.querySelectorAll('button')].find((x) => re.test(x.textContent.trim())); if (b) { b.click(); await settleFor(500); } return !!b; };
  const modalEl = () => doc.querySelector('.modal');
  try {
    ok(await openSettingsTab('Play'), 'play: no Play tab');
    await settleFor(500);
    ok(view().textContent.includes('This server does not have Play yet (needs 0.3.47)'), 'play: an older core was not told apart from a broken page');
    ok(!/What a display link can do|same rules in config\.txt/i.test(view().textContent), 'play: an explainer box is back');

    older = false;
    // The section loads once per visit: leave the page and come back.
    await go('overview'); await go('settings'); await openSettingsTab('Play'); await settleFor(600);
    ok(!!panel('Displays') && !!panel('Watch rules (server side, every display)') && !!panel('Excluded clusters'), 'play: the three cards did not draw');
    ok(view().textContent.includes('NOC wall') && view().textContent.includes('10.1.2.3'), 'play: the display row (name, last seen address) is missing');
    ok(!view().textContent.includes('[object Object]'), 'play: the page prints [object Object]');
    ok(![...view().querySelectorAll('button')].some((b) => /^Copy link$/.test(b.textContent.trim())), 'play: a listed link offers "Copy link" (the core never hands one back)');

    // Replace link: asks, revokes the old one, makes it again with the same name, clusters,
    // addresses, expiry and settings, and shows the new URL once.
    sent.length = 0;
    ok(await pressIn(view(), /^Replace link/), 'play: no "Replace link…" on a display row');
    ok(!!modalEl() && /Replace the link for "NOC wall"/.test(modalEl().textContent), 'play: replace did not ask first');
    ok(!sent.some((m) => m.type === 'PLAY_LINK_REVOKE'), 'play: replaced before the answer');
    await pressIn(modalEl(), /^Replace the link$/); await settleFor(400);
    const order = sent.filter((m) => /^PLAY_LINK_(REVOKE|CREATE)$/.test(m.type)).map((m) => m.type);
    ok(order.join(',') === 'PLAY_LINK_REVOKE,PLAY_LINK_CREATE', `play: replace sent ${order.join(', ')}`);
    const again = sent.find((m) => m.type === 'PLAY_LINK_CREATE');
    ok(!!again && again.name === 'NOC wall' && again.clusters === 'all' && again.expires === 'permanent' && (again.allowFrom || []).join() === '10.1.0.0/16'
      && again.settings && again.settings.zoom === 1.25 && again.settings.slides[0].id === 'alerts' && again.settings.slides[0].dwellSec === 30,
      `play: the replacement link is not the old one's twin: ${JSON.stringify(again)}`);
    ok((doc.getElementById('pl-url') || {}).value === 'https://noc.example/#/play?display=SECRET1', 'play: the replacement URL is not shown');
    ok(/will not be shown again/.test((modalEl() || {}).textContent || ''), 'play: no one-time note on the replacement');
    await closeAll(); await settleFor(400);
    links = [{ ...links[0], id: 'l1', name: 'NOC wall' }];
    await go('overview'); await go('settings'); await openSettingsTab('Play'); await settleFor(600);

    // Fleet wall order: the row is there with the default, and saving sends what was chosen.
    sent.length = 0;
    ok(await pressIn(view(), /^Edit$/), 'play: no Edit on a display row');
    ok(/Fleet wall order/.test(modalEl().textContent) && /breaks a tie/.test(modalEl().textContent), 'play: no Fleet wall order row');
    ok(/every cluster, in the Fleet wall order below/.test(modalEl().textContent), 'play: the Fleet wall slide has no order note');
    ok([0, 1, 2].map((i) => doc.getElementById(`pl-order-${i}`).value).join() === 'critical,logDelay,volume', 'play: the order does not start at the default');
    type('pl-order-0', 'disk'); type('pl-order-1', 'name'); type('pl-order-2', 'none');
    await pressIn(modalEl(), /^Save$/); await settleFor(300);
    const setOrder = sent.find((m) => m.type === 'PLAY_LINK_SET');
    ok(!!setOrder && JSON.stringify(setOrder.settings.fleetOrder) === '["disk","name"]', `play: the order save sent ${JSON.stringify(setOrder)}`);
    await closeAll(); await settleFor(300);

    // New display link: permanent by default, the URL shown once.
    sent.length = 0;
    ok(await pressIn(view(), /^New display link/), 'play: no New display link button');
    ok(!!modalEl(), 'play: the new link dialog did not open');
    ok(doc.getElementById('pl-expires').value === 'permanent', `play: expiry defaults to ${doc.getElementById('pl-expires').value}`);
    await pressIn(modalEl(), /^Create link$/);
    ok(!sent.some((m) => m.type === 'PLAY_LINK_CREATE'), 'play: a link was made without a name');
    type('pl-name', 'Floor 2');
    await pressIn(modalEl(), /^Create link$/);
    const created = sent.find((m) => m.type === 'PLAY_LINK_CREATE');
    ok(!!created && created.name === 'Floor 2' && created.clusters === 'all' && created.expires === 'permanent' && created.allowFrom === undefined,
      `play: create sent ${JSON.stringify(created)}`);
    ok(/^https:\/\/noc\.example\/#\/play\?display=SECRET\d+$/.test((doc.getElementById('pl-url') || {}).value || ''), 'play: the link URL is not shown');
    ok(/will not be shown again/.test(modalEl().textContent), 'play: no one-time note');
    ok(!!doc.getElementById('pl-copy-url'), 'play: no Copy link on the new link');
    await closeAll(); await settleFor(300);

    // Revoke asks first.
    sent.length = 0;
    ok(await pressIn(view(), /^Revoke$/), 'play: no Revoke button');
    ok(!!modalEl() && /Revoke "NOC wall"/.test(modalEl().textContent), 'play: revoke did not ask');
    ok(!sent.some((m) => m.type === 'PLAY_LINK_REVOKE'), 'play: revoked before the answer');
    await pressIn(modalEl(), /^No$/); await settleFor(300);
    ok(!sent.some((m) => m.type === 'PLAY_LINK_REVOKE'), 'play: "No" still revoked');
    await pressIn(view(), /^Revoke$/);
    await pressIn(modalEl(), /^Revoke the link$/); await settleFor(300);
    ok(sent.some((m) => m.type === 'PLAY_LINK_REVOKE' && m.id === 'l1'), `play: confirmed revoke sent ${JSON.stringify(sent.map((m) => m.type))}`);

    // Exclude refuses an empty reason.
    sent.length = 0;
    type('pl-ex-cluster', cid);
    type('pl-ex-reason', '   ');
    await pressIn(view(), /^Exclude from Play$/);
    ok(!sent.some((m) => m.type === 'PLAY_CONFIG_SET'), 'play: excluded without a reason');
    type('pl-ex-cluster', cid);
    type('pl-ex-reason', 'being rebuilt');
    await pressIn(view(), /^Exclude from Play$/);
    const ex = sent.find((m) => m.type === 'PLAY_CONFIG_SET');
    ok(!!ex && ex.settings && ex.settings.exclude && ex.settings.exclude.add && ex.settings.exclude.add.clusterId === cid
      && ex.settings.exclude.add.reason === 'being rebuilt', `play: exclude sent ${JSON.stringify(ex)}`);
    await settleFor(500);
    const keptEx = await core({ type: 'PLAY_CONFIG_GET' });
    ok((keptEx.exclude || []).some((x) => x.clusterId === cid && x.reason === 'being rebuilt' && x.by),
      `play: the core did not keep the exclusion (with who): ${JSON.stringify(keptEx.exclude)}`);
    ok(/being rebuilt/.test(panel('Excluded clusters').textContent) && /Include again/.test(panel('Excluded clusters').textContent),
      'play: the excluded cluster is not listed back from the core');

    // A managed field is locked and not sent; the rest is.
    const red = doc.getElementById('pl-red');
    ok(!!red && red.disabled && red.value === '75' && red.title === 'managed by config.txt', 'play: a managed field is not shown locked');
    ok(/managed by config\.txt/.test(panel('Watch rules (server side, every display)').textContent), 'play: a locked field does not say why');
    ok(!doc.getElementById('pl-yellow').disabled, 'play: an unmanaged field is locked');
    type('pl-yellow', '20');
    doc.getElementById('pl-when-yellow').checked = true;
    sent.length = 0;
    ok(!doc.getElementById('pl-watch-save'), 'play: the watch rules have a Save of their own beside the save bar');
    await saveViaBar(500);
    const ws0 = sent.find((m) => m.type === 'PLAY_CONFIG_SET');
    const ws = ws0 && ws0.settings;
    ok(!!ws && ws.watch && ws.watch.delayYellowFromMin === 20 && !('delayRedAboveMin' in ws.watch), `play: watch save sent ${JSON.stringify(ws0)}`);
    ok(!!ws && ws.watch.nodeBlink === 'untilBack' && ws.watch.nodeCheckSec === 60 && ws.watch.spotlight.perClusterSec === 13
      && ws.watch.spotlight.leaveAfterMin === 10 && ws.watch.spotlight.whenEmpty === 'skip'
      && ws.watch.spotlight.when.includes('yellow') && ws.watch.spotlight.when.includes('red'), `play: watch payload is ${JSON.stringify(ws && ws.watch)}`);
    await settleFor(400);
    const keptW = (await core({ type: 'PLAY_CONFIG_GET' })).watch || {};
    ok(keptW.delayYellowFromMin === 20 && keptW.delayRedAboveMin === 60 && (keptW.spotlight || {}).when.includes('yellow'),
      `play: the core did not keep the watch rules as saved: ${JSON.stringify(keptW)}`);
    ok(/Saved/.test(panel('Watch rules (server side, every display)').textContent), 'play: the save is not confirmed');
    // Put the core back as it was for the wall below: the shipped watch rules, nothing excluded.
    await core({ type: 'PLAY_CONFIG_SET', settings: { watch: { delayYellowFromMin: 30, spotlight: { when: ['red', 'nodeLeft', 'slmFailed', 'storage', 'unreachable', 'criticalAlert'] } } } });
    await core({ type: 'PLAY_CONFIG_SET', settings: { exclude: { remove: cid } } });
  } finally {
    globalThis.fetch = realFetch;
    await closeAll();
  }
  await go('overview');
}

/* ------- 0.3.47 Play: the wall display — slides, keys, zoom, takeover, exclusion, an older core ------- */

// Against this real core: the exclusion is made with PLAY_CONFIG_SET, the shared delay record and
// backup size are put with PLAY_SHARE_PUT in the very shape the page's measurer sends
// (play/measure.js shareData), and PLAY_STATE / PLAY_SHARE_GET are the core's answers. Stubbed,
// and only these: a node gone from a cluster (laid over the real PLAY_STATE: the mock cluster's
// node list never changes between two polls, so the core's node history never sees one leave);
// VOLUME_DAILY (a fresh data dir has no daily record yet); ACK_LIST, answered with a notes-only
// record of the kind a hosted core keeps, to prove the wall does not read presence as an
// acknowledgement (this portable bridge keeps acknowledgements in the browser, acks.js). Then the
// same page against "Unknown message type", which is what an older core says.
{
  await applyConfig({ load, configPath });
  await settleFor(1500);
  const st = await load('core/state.js');
  const pPlay = await load('pages/play.js');
  const M = await load('play/measure.js');
  const acksMod = await load('core/acks.js');
  const realFetch = globalThis.fetch;
  const core = async (msg) => (await realFetch(`${bridgeUrl}/bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })).json();
  const list = st.clusters();
  ok(list.length >= 2, `play: the fixture needs two clusters, has ${list.length}`);
  const [shown, hidden] = list;
  const sent = [];
  const play = { older: false, notesOnly: null };
  const older = { ok: false, kind: 'bad_message', message: 'Unknown message type (EP-202)' };
  // The core, set up as a wall would find it.
  const exAdd = await core({ type: 'PLAY_CONFIG_SET', settings: { exclude: { add: { clusterId: hidden.id, reason: 'behaviour-check' } } } });
  ok(exAdd.ok, `play: the core did not take the exclusion: ${JSON.stringify(exAdd)}`);
  const devices = [
    { device: 'fw-edge-01', delayMinutes: 55, arrival: Date.now() - 60000, peak24: { value: 80, at: Date.now() - 3600000 } },
    { device: 'fw-edge-02', delayMinutes: 42, arrival: Date.now() - 60000 },
    { device: 'fw-edge-03', delayMinutes: 2, arrival: Date.now() - 60000 }];
  const putD = await core({ type: 'PLAY_SHARE_PUT', kind: 'delay', clusterId: shown.id, measuredAt: Date.now() - 60000,
    data: M.shareData({ records: devices, truncated: 0 }) });
  ok(putD.ok && putD.kept, `play: the core refused the page's own delay payload: ${JSON.stringify(putD)}`);
  const putR = await core({ type: 'PLAY_SHARE_PUT', kind: 'repoSize', clusterId: shown.id, measuredAt: Date.now() - 600000, data: { bytes: 5 * 1024 ** 3 } });
  ok(putR.ok, `play: the core refused a repository size: ${JSON.stringify(putR)}`);
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const t = String(body.type || '');
    if (/^(PLAY_|ACK_)/.test(t)) {
      sent.push(body);
      if (play.older) return stubReply(older);
      if (t === 'PLAY_STATE') {
        const real = await core(body);
        return stubReply({ ...real, nodes: { ...(real.nodes || {}),
          [shown.id]: { expected: ['node-1', 'node-2'], present: ['node-1'], left: [{ node: 'node-2', since: Date.now() - 120000 }], answering: true } } });
      }
      if (t === 'ACK_LIST') return stubReply({ ok: true, acks: play.notesOnly || {} });
      return realFetch(input, init);
    }
    if (t === 'VOLUME_DAILY') {
      sent.push(body);
      const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      return stubReply({ ok: true, settings: { sizeBasis: 'primary' }, status: {},
        cards: { yesterday: { day: day(1), value: 2e10, changeVsAvgPct: 12 }, average: { days: 7, value: 1.8e10 }, monthSoFar: { value: 5e11 } },
        days: Array.from({ length: 31 }, (_, n) => ({ day: day(n), indices: 3, docs: 1e6, priBytes: 1.5e10 + n * 1e8, avg: 1.7e10, live: true, final: n > 0 })) });
    }
    return realFetch(input, init);
  };
  const root = () => doc.querySelector('.pl-root');
  const titleText = () => (doc.querySelector('.pl-title') || {}).textContent || '';
  const key = (k) => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const viewText = () => (doc.getElementById('view') || {}).textContent || '';
  try {
    // No warm-up here: the check drives the takeover a few seconds after opening.
    pPlay.configure({ display: false, onExit: () => app.go('overview'), warmMs: 0 });
    await go('overview');
    ok(!!doc.getElementById('play-btn'), 'play: no "▶ Play" button in the top bar');
    try { localStorage.removeItem('elasticpro.play.zoom'); } catch (_) { /* none */ }
    doc.getElementById('play-btn').click();
    await settleFor(5500);     // the shared delay record is read a few seconds after opening
    ok(doc.documentElement.classList.contains('play'), 'play: html.play is not set (the chrome would show)');
    ok(!!root(), 'play: the wall did not draw');
    ok(titleText() === 'Fleet', `play: opens on "${titleText()}", not the fleet wall`);
    ok(sent.some((m) => m.type === 'PLAY_STATE'), 'play: PLAY_STATE was not asked');
    ok(sent.some((m) => m.type === 'PLAY_SHARE_GET' && m.kind === 'delay'), 'play: the shared delay record was not asked');
    // exclusion: left out of every slide
    const tiles = [...doc.querySelectorAll('.pl-tile[data-cluster]')];
    ok(tiles.length === list.length - 1, `play: ${tiles.length} tiles for ${list.length} clusters with one excluded`);
    ok(!tiles.some((t) => t.dataset.cluster === hidden.id), 'play: the excluded cluster has a tile');
    // node left: blinks
    const mine = tiles.find((t) => t.dataset.cluster === shown.id);
    ok(mine && mine.classList.contains('pl-blink'), 'play: a cluster with a node that left does not blink');
    ok(/node left on node-2|node-2/.test(viewText()), 'play: the node that left is not named');
    // the shared delay record: three devices — two at 30–60 min (55, 42), one under 30
    ok(/2 at 30–60 min/.test(viewText()) && /0 over 60 min/.test(viewText()), `play: delayed devices from the shared record are not on the strip: ${viewText().slice(0, 300)}`);
    // keys: → turns, Space pauses, + / − zoom
    const seen = new Set([titleText()]);
    for (let i = 0; i < 6; i++) {
      key('ArrowRight'); await settleFor(150);
      seen.add(titleText());
      ok(!/could not be drawn/.test(viewText()), `play: slide "${titleText()}" could not be drawn: ${viewText().slice(0, 200)}`);
      ok(!excludedNamed(), `play: slide "${titleText()}" names the excluded cluster`);
    }
    for (const t of ['Fleet', 'Alerts', 'Log delay', 'Backups', 'Volume and capacity']) ok(seen.has(t), `play: → never reached "${t}" (saw ${[...seen].join(', ')})`);
    // Bounded: a slide skipped as empty would otherwise turn forever.
    for (let i = 0; i < 14 && titleText() !== 'Log delay'; i++) { key('ArrowRight'); await settleFor(100); }
    ok(/fw-edge-01/.test(viewText()) && /55 min/.test(viewText()) && /1 h 20/.test(viewText()), 'play: Log delay does not list the worst device with its 24 h peak');
    for (let i = 0; i < 14 && titleText() !== 'Backups'; i++) { key('ArrowRight'); await settleFor(100); }
    ok(/5\.00 GB/.test(viewText()), 'play: Backups does not show the shared backup size');
    ok(/not measured/.test(viewText()) || list.length - 1 === 1, 'play: a cluster with no shared size should read "not measured"');
    for (let i = 0; i < 14 && titleText() !== 'Volume and capacity'; i++) { key('ArrowRight'); await settleFor(100); }
    ok(sent.some((m) => m.type === 'VOLUME_DAILY' && m.days === 30 && m.avgDays === 7), 'play: the volume record was not asked (30 days, 7-day average)');
    ok(/Yesterday · all clusters/.test(viewText()) && /\+12\.0 %/.test(viewText()), 'play: Volume does not show yesterday against the 7-day average');
    key('ArrowLeft'); await settleFor(150);
    ok(titleText() === 'Backups', `play: ← went to "${titleText()}"`);
    key(' '); await settleFor(150);
    ok(pPlay._debug().engine.paused && /paused/.test(doc.querySelector('.pl-hchips').textContent), 'play: Space did not pause');
    key(' '); await settleFor(100);
    ok(!pPlay._debug().engine.paused, 'play: Space did not resume');
    const zl = () => doc.querySelector('.pl-zl').textContent;
    key('+'); await settleFor(100);
    ok(zl() === '110 %' && doc.querySelector('.pl-body').style.getPropertyValue('--pz') === '1.1', `play: + made the zoom ${zl()}`);
    key('+'); key('+'); key('+'); key('+'); await settleFor(100);
    ok(zl() === '150 %', `play: zoom went past 150 % (${zl()})`);
    let remembered = null;
    try { remembered = localStorage.getItem('elasticpro.play.zoom'); } catch (_) { /* none */ }
    ok(remembered === '1.5', `play: a person's zoom is not remembered in this browser (${remembered})`);
    for (let i = 0; i < 8; i++) key('-');
    await settleFor(100);
    ok(zl() === '80 %', `play: zoom went below 80 % (${zl()})`);
    key('+'); key('+'); await settleFor(100);

    // critical takeover: a new critical alert takes the screen; an acknowledgement lets go
    const before = st.state.data.get(shown.id);
    st.state.data.set(shown.id, { ...before, health: { ...(before.health || {}), status: 'red', unassigned_shards: 4 } });
    st.bus.emit('data', shown.id);
    await settleFor(2300);
    const dbg = pPlay._debug();
    ok(dbg.take && dbg.take.active && root().classList.contains('takeover') && titleText() === 'Alerts',
      `play: a new critical alert did not take the screen (title "${titleText()}", active ${JSON.stringify(dbg.take && dbg.take.active)})`);
    const hot = dbg.take && dbg.take.active && dbg.take.active.key;
    ok(hot && !!doc.querySelector(`.pl-arow.hot[data-key="${hot}"]`), 'play: the alert that took the screen is not at the top');
    // The open alerts go to the core with PLAY_STATE, so "open for" survives a reload.
    sent.length = 0;
    await pPlay._poll(); await settleFor(200);
    const asked = sent.find((m) => m.type === 'PLAY_STATE');
    ok(asked && Array.isArray(asked.open) && asked.open.includes(hot), `play: PLAY_STATE did not carry the open alert keys: ${JSON.stringify(asked)}`);
    ok(Number(pPlay._debug().ps.openSince[hot]) > 0, 'play: the core did not keep when the alert was first open');
    // A record kept only for its notes (acked: false) is not an acknowledgement.
    play.notesOnly = { [hot]: { by: 'qa', at: Date.now(), note: 'looking', record: { acked: false, ackedBy: '', ackedAt: 0, notes: [{ text: 'looking', by: 'qa', ts: Date.now() }] } } };
    // Not awaited: the record is in acks.js's cache at once; the shim's IndexedDB never says it is written.
    acksMod.addNote(hot, 'looking', 'qa');
    await pPlay._poll(); await settleFor(1500);
    ok(pPlay._debug().take.active && root().classList.contains('takeover'), 'play: a note alone let the screen go (it is not an acknowledgement)');
    acksMod.acknowledge(hot, { by: 'qa' });
    await settleFor(1500);
    ok(!pPlay._debug().take.active && !root().classList.contains('takeover'), 'play: an acknowledgement did not let the screen go');
    acksMod.unacknowledge(hot);
    st.state.data.set(shown.id, before);
    st.bus.emit('data', shown.id);
    await settleFor(300);

    // High (2026-11-01): a node over 85 % heap is a HIGH row on the Alerts slide, counted under
    // Open now, and never takes the screen; on the wall the node-left blink still wins its tile.
    {
      const was = st.state.data.get(shown.id);
      const nodes = (was.nodes && was.nodes.length ? was.nodes : [{ name: 'node-1' }]).map((n, i) => (i === 0 ? { ...n, 'heap.percent': '93' } : n));
      for (let i = 0; i < 2; i++) { st.state.data.set(shown.id, { ...was, nodes: nodes.map((x) => ({ ...x })) }); st.alerts(); }
      st.invalidateAlerts(); st.bus.emit('data', shown.id);
      await settleFor(1500);
      ok(!pPlay._debug().take.active, 'play: a High alert took the screen (only critical does)');
      for (let i = 0; i < 14 && titleText() !== 'Alerts'; i++) { key('ArrowRight'); await settleFor(120); }
      const hi = [...doc.querySelectorAll('.pl-arow.high')];
      ok(hi.length >= 1 && hi.every((r) => r.querySelector('.pl-sev').textContent === 'HIGH') && hi.some((r) => /JVM heap/.test(r.textContent)),
        `play: the Alerts slide has no HIGH row for the heap alert (${hi.length} high rows)`);
      const kv = [...doc.querySelectorAll('.pl-aside .pl-kpi')].find((k) => k.querySelector('.pl-k').textContent === 'High');
      ok(kv && Number(kv.querySelector('.pl-v').textContent) >= 1, `play: Open now does not count High (${kv && kv.textContent})`);
      for (let i = 0; i < 14 && titleText() !== 'Fleet'; i++) { key('ArrowRight'); await settleFor(120); }
      const t = doc.querySelector(`.pl-tile[data-cluster="${shown.id}"]`);
      ok(t && t.classList.contains('pl-blink') && !t.classList.contains('blink-high') && !t.classList.contains('blink-crit'),
        `play: the node-left blink does not win over High on its tile (${t && t.className})`);
      st.state.data.set(shown.id, was);
      st.invalidateAlerts(); st.bus.emit('data', shown.id);
      await settleFor(300);
    }

    // a display link: no Exit, Escape stays
    pPlay.configure({ display: true, onExit: () => { problems.push('play: a display link left Play'); } });
    await go('play'); await settleFor(600);
    ok(!doc.querySelector('.pl-exit'), 'play: a display link offers Exit');
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settleFor(200);
    ok(doc.documentElement.classList.contains('play'), 'play: Escape left Play on a display link');
    pPlay.configure({ display: false, onExit: () => app.go('overview') });

    // an older core: no PLAY_* at all — still draws, says what is missing, never throws
    play.older = true;
    await go('overview'); await go('play'); await settleFor(2500);
    ok(!!root() && titleText() === 'Fleet', 'play: against an older core the wall did not draw');
    ok(/older server/.test(doc.querySelector('.pl-hchips').textContent), 'play: an older core is not said to be one');
    ok(doc.querySelectorAll('.pl-tile[data-cluster]').length === list.length, 'play: an older core has no exclusions, so every cluster has a tile');
    for (let i = 0; i < 6; i++) { key('ArrowRight'); await settleFor(120); ok(!/could not be drawn/.test(viewText()), `play (older core): "${titleText()}" could not be drawn`); }

    // Escape leaves for a person, and every timer and listener goes with it
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settleFor(300);
    ok(!doc.documentElement.classList.contains('play'), 'play: Escape did not leave Play');
    const after = pPlay._debug();
    ok(after.timers === 0 && after.listeners === 0, `play: leaving kept ${after.timers} timer(s) and ${after.listeners} listener(s)`);
  } finally {
    globalThis.fetch = realFetch;
    if (doc.documentElement.classList.contains('play')) await go('overview');
    await core({ type: 'PLAY_CONFIG_SET', settings: { exclude: { remove: hidden.id } } });
  }

  function excludedNamed() {
    return hidden.name !== shown.name && !shown.name.includes(hidden.name) && viewText().includes(hidden.name);
  }
}


// Reports (0.3.53): Planning recalculates as it is typed in, the backup target hides the /backup
// column, "Based on" fills the volume from the 7-day event_logsize, Export CSV hands over the bill
// of materials; Config › Reports › Plan templates saves with PLAN_TEMPLATES_SET, and "Which indices
// count" previews through VOLUME_PATTERN_CHECK and locks a key config.txt manages. The volume
// messages are stubbed (the dev bridge may be older); PLAN_TEMPLATES_GET is the real core's.
{
  const realFetch = globalThis.fetch;
  const DAY = 86400000;
  const sentP = [];
  const days = Array.from({ length: 10 }, (_, i) => ({ day: new Date(Date.now() - (i + 1) * DAY).toISOString().slice(0, 10), final: true, eventBytes: 4e11 }));
  let tplStore = null;
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const t = String(body.type || '');
    if (t === 'VOLUME_DAILY') { sentP.push(body); return stubReply({ ok: true, settings: { sizeBasis: 'eventSize' }, days, cards: {}, status: {} }); }
    if (t === 'VOLUME_PATTERN_CHECK') {
      sentP.push(body);
      return stubReply({ ok: true, matched: 412, dated: 398, undated: 14, datedExample: 'logstash-fw-2026.11.02', undatedExample: 'logstash-000014' });
    }
    if (t === 'VOLUME_SETTINGS') return stubReply({ ok: true, settings: {}, managed: ['UI_VOLUME_INDEX_PATTERN'], patternSource: 'pattern', source: 'file', overrides: [] });
    if (t === 'VOLUME_FIELDS_CHECK') return stubReply({ ok: true, indices: { match: 1, skipped: [] }, rows: [] });
    if (t === 'PLAN_TEMPLATES_SET') { sentP.push(body); tplStore = body.templates; return stubReply({ ok: true, templates: body.templates, custom: true }); }
    if (t === 'PLAN_TEMPLATES_GET' && tplStore) return stubReply({ ok: true, templates: tplStore, custom: true });
    if (body.type === 'CONFIG_WRITE') return stubReply({ ok: true, path: body.path, bytes: body.text.length });
    return realFetch(input, init);
  };
  const hostEl = doc.createElement('div');
  const txt = (id) => (doc.getElementById(id) || { textContent: '' }).textContent;
  const fire = (el, type = 'input') => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  const firstCell = (name) => [...doc.querySelectorAll('#pn-bom tbody tr')].find((r) => r.cells[0].textContent === name);
  try {
    // ---- Planning ----
    await go('overview');
    doc.body.append(hostEl);
    const planning = await load('reports/planning.js');
    hostEl.append(planning.planningSection());
    await waitFor(() => doc.getElementById('pn-bom') && firstCell('Forwarder'), 'planning: the bill of materials did not draw');
    ok(txt('pn-servers') === '15 +3', `planning: Servers reads "${txt('pn-servers')}", expected "15 +3" (3 roles without a count)`);
    ok(/without a CPU spec/.test(txt('pn-cpu') + doc.querySelector('#pn-cpu + .d')?.textContent), 'planning: the CPU tile does not say how many roles it left out');
    ok(/\[set/.test(firstCell('Other servers')?.textContent || ''), 'planning: an unset value is not shown as [set]');
    ok(!!doc.querySelector('#pn-bom thead')?.textContent.includes('/backup disk'), 'planning: disk backups should show the /backup disk column');

    const pd = doc.getElementById('pn-pd');
    pd.value = '1000'; fire(pd);
    await settleFor(50);
    ok(firstCell('Forwarder').cells[2].textContent === '7', `planning: 1000 GB a day should need 7 forwarders, the row reads "${firstCell('Forwarder').cells[2].textContent}"`);
    ok(doc.getElementById('pn-pd') === pd && doc.activeElement !== null, 'planning: typing redrew the input it was typed in');

    for (const [id, label, hasCol] of [['pn-bk-s3', 'S3', false], ['pn-bk-ulm', 'ULM', false], ['pn-bk-disk', 'disk', true]]) {
      doc.getElementById(id).click();
      await settleFor(50);
      const has = doc.querySelector('#pn-bom thead').textContent.includes('/backup disk');
      ok(has === hasCol, `planning: with backups to ${label} the /backup disk column is ${has ? 'shown' : 'hidden'}`);
    }
    doc.getElementById('pn-bk-s3').click();
    await settleFor(50);
    ok(/bucket/.test(firstCell('S3 backup')?.textContent || ''), 'planning: the S3 backup row does not say it is a bucket');
    doc.getElementById('pn-bk-disk').click();

    // Based on an existing cluster: daily volume from the 7-day mean of event_logsize.
    const cl = doc.getElementById('pn-cl');
    cl.value = cl.options[1].value; fire(cl, 'change');
    await waitFor(() => (/Filled/.test(doc.getElementById('pn-based-hint')?.textContent || '') ? doc.body : null), 'planning: "Based on" a cluster filled nothing');
    ok(doc.getElementById('pn-pd').value === '400', `planning: daily volume from the cluster reads ${doc.getElementById('pn-pd').value}, expected 400 (4e11 bytes a day)`);

    // Export CSV: the bill of materials, [set] kept as [set].
    doc.getElementById('pn-csv').click();
    const csv = files.at(-1);
    ok(csv && /^plan-standard\.csv$/.test(csv.name), `planning: the export is named "${csv && csv.name}"`);
    ok(csv && csv.text.split('\n')[0].startsWith('role,sizing_rule,count') && /\n"?Total/.test(csv.text) && /Other servers,fixed count,\[set\]/.test(csv.text),
      'planning: the CSV is not the bill of materials with a Total row and [set] kept');
    hostEl.remove();

    // ---- Config > Reports: Which indices count, Plan templates ----
    sentP.length = 0;
    await go('settings');
    ok(await openSettingsTab('Plan templates'), 'reports config: no Reports › Plan templates tab');
    await waitFor(() => doc.getElementById('pt-list') && doc.getElementById('pt-list').children.length >= 2, 'plan templates: the template list did not load');
    const names = [...doc.querySelectorAll('#pt-list .pt-item b')].map((b) => b.textContent);
    ok(names[0] === 'Standard' && names.includes('Small / lab'), `plan templates: the list reads ${names.join(' | ')}`);
    ok(doc.querySelectorAll('.pt-table input.unset').length > 10, 'plan templates: values not set yet are not amber');
    ok(!doc.getElementById('pt-save'), 'plan templates: a Save of its own is back beside the save bar');
    ok(await openSettingsTab('Reports'), 'reports config: no Reports › Indices & volume fields tab');
    await settleFor(200);
    ok(!!doc.getElementById('vf-pattern') && doc.getElementById('vf-pattern').disabled, 'which indices: UI_VOLUME_INDEX_PATTERN is managed but its input is not locked');
    ok(/config\.txt: UI_VOLUME_INDEX_PATTERN/.test(doc.querySelector('#view').textContent), 'which indices: no "config.txt: UI_VOLUME_INDEX_PATTERN" pill');
    await waitFor(() => (/In force: the index pattern/.test(txt('vf-source')) ? doc.body : null), 'which indices: the card does not say which source is in force (patternSource)');
    await waitFor(() => (/Dated by name/.test(txt('vf-pv')) ? doc.body : null), 'which indices: the preview never showed');
    ok(/398 · e\.g\. logstash-fw-2026\.11\.02/.test(txt('vf-pv')) && /Split by @timestamp/.test(txt('vf-pv')), `which indices: the preview reads "${txt('vf-pv')}"`);
    const pcheck = sentP.find((m) => m.type === 'VOLUME_PATTERN_CHECK');
    ok(pcheck && pcheck.indexPattern === 'logstash-*' && pcheck.dayFrom === 'name', `which indices: the preview sent ${JSON.stringify(pcheck)}`);

    // New, rename, backups to S3, Save (the save bar): the whole list is sent.
    ok(await openSettingsTab('Plan templates'), 'plan templates: the tab did not open again');
    await settleFor(200);
    doc.getElementById('pt-new').click();
    await settleFor(100);
    const nm = doc.getElementById('pt-name');
    nm.value = 'Edge site'; fire(nm);
    const s3 = doc.querySelector('input[name="pt-bt"][value="s3"]');
    s3.checked = true; fire(s3, 'change');
    ok(/Plan template "Edge site" added/.test((doc.getElementById('cm-savebar') || {}).textContent || ''), `plan templates: the save bar does not name the new template: ${(doc.getElementById('cm-savebar') || {}).textContent}`);
    await saveViaBar(300);
    await waitFor(() => sentP.find((m) => m.type === 'PLAN_TEMPLATES_SET'), 'plan templates: Save template did not send PLAN_TEMPLATES_SET');
    const set = sentP.find((m) => m.type === 'PLAN_TEMPLATES_SET');
    ok(set && set.templates.length === 3 && set.templates[2].name === 'Edge site' && set.templates[2].backup === 's3',
      `plan templates: Save sent ${set && JSON.stringify(set.templates.map((t) => [t.name, t.backup]))}`);
    ok(set && set.templates[0].roles[3].nodeTB === null, 'plan templates: an empty value was sent as something other than null');

    // Delete asks first, then sends the list without it.
    sentP.length = 0;
    doc.getElementById('pt-del').click();
    const yes = await waitFor(() => [...doc.querySelectorAll('.modal button')].find((b) => b.textContent === 'Delete'), 'plan templates: Delete did not ask');
    if (yes) { yes.click(); await waitFor(() => sentP.find((m) => m.type === 'PLAN_TEMPLATES_SET'), 'plan templates: confirmed Delete sent nothing'); }
    ok((sentP.find((m) => m.type === 'PLAN_TEMPLATES_SET') || { templates: [] }).templates.length === 2, 'plan templates: Delete did not send the list without the template');
  } finally {
    globalThis.fetch = realFetch;
    hostEl.remove();
    try { localStorage.removeItem('elasticpro.planTemplates'); } catch { /* none */ }
  }
  await applyConfig({ load, configPath });
  await go('overview');
}


/* ------- 0.3.54: Indices report and Volume by host — Exports & schedules, and the host view ------- */

// The core's REPORT_SCHEDULE_* / REPORT_RUN / HOSTS_QUERY answers as docs/REPORT-TYPES.md gives
// them, stubbed at fetch. Proves: a tab per kind with each kind's defaults and its size basis, a
// schedule save and Run now send the kind (and collectAgain for hosts), too_many_clusters is said
// as the core says it, and the host view pages, sorts and searches on the server, shows an absent
// figure as amber "not measured" (never 0), flags incomplete days and names unmapped fields.
{
  const realFetch = globalThis.fetch;
  const sentK = [];
  const saved = {};
  let refuseRun = null;
  const rowsAll = Array.from({ length: 450 }, (_, i) => ({ day: '2026-11-01', index: `app-2026.11.01-${i}`, source: 'app', host: `h${i}`,
    docs: 10 + i, eventBytes: i === 0 ? null : 1000 + i, subBytes: 500 + i, eventMissingDocs: i === 1 ? 7 : 0,
    clientId: 'C-1', branch: 'DC', incomplete: i === 0, meta: { zone: 'dmz', ClientID: 'C-1' } }));
  const answerK = (b) => {
    switch (b.type) {
      case 'REPORT_JOBS': return { ok: true, jobs: [], concurrency: 3, running: 0, queued: 0 };
      case 'REPORT_SCHEDULE_GET': return { ok: true, kind: b.kind, enabled: false, to: [], cc: [], bcc: [], managed: b.kind === 'hosts' ? ['UI_REPORT_HOSTS_AT'] : [],
        mailConfigured: true, lastSent: null, ...(saved[b.kind] || {}),
        ...(b.kind === 'hosts' ? { config: { fields: ['zone'], clientIdField: 'ClientID', keepMonths: 3, managed: ['UI_REPORT_HOSTS_KEEP_MONTHS'] } } : {}) };
      case 'REPORT_SCHEDULE_SET': saved[b.kind] = { ...b }; return { ok: true };
      case 'REPORT_SEND_NOW': return { ok: true, job: { id: 'j1' } };
      case 'REPORT_RUN': return refuseRun || { ok: true, jobs: (b.clusterIds || []).map((id) => ({ id: `k${id}` })), refused: [] };
      case 'HOSTS_QUERY': {
        const q = (b.q || '').toLowerCase();
        let rows = rowsAll.filter((r) => !q || r.host.includes(q) || r.index.includes(q));
        const [col, dir] = String(b.sort || 'day:asc').split(':');
        if (col === 'docs') rows = [...rows].sort((a, c) => (dir === 'desc' ? c.docs - a.docs : a.docs - c.docs));
        return { ok: true, rows: rows.slice(b.offset, b.offset + b.limit), total: rows.length, totals: { docs: rows.reduce((n, r) => n + r.docs, 0), eventBytes: null, subBytes: 123456 },
          incompleteDays: ['2026-11-02'], fields: ['zone', 'ClientID'], notInMapping: ['tag1'], fill: { clientId: 'C-1', branchDefault: 'DC' },
          days: [{ day: '2026-11-01', held: true, incomplete: false, rows: 450, notes: [], failed: null },
            { day: '2026-11-02', held: true, incomplete: true, rows: 0, notes: [], failed: null },
            { day: '2026-11-03', held: false, incomplete: false, rows: null, notes: [], failed: 'HTTP 503 after 3 tries', collecting: false }] };
      }
      default: return { ok: false, kind: 'bad_message', message: `Unknown message type "${b.type}"` };
    }
  };
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (/^(REPORT_|MAIL_|HOSTS_)/.test(String(body.type || ''))) { sentK.push(body); return stubReply(answerK(body)); }
    return realFetch(input, init);
  };
  const fire = (el, type = 'change') => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  try {
    await go('reports');
    press(doc.querySelector('.rp-nav a[data-section="exports"]'));
    const tab = (id) => doc.getElementById(`rt-tab-${id}`);
    await waitFor(() => tab('hosts'), 'report types: no Volume by host tab on Exports & schedules');
    ok(['volume', 'indices', 'hosts'].every((k) => !!tab(k)), 'report types: a kind has no tab');
    // Indices: its own defaults and the size basis, said plainly.
    press(tab('indices'));
    await waitFor(() => doc.getElementById('rt-indices-at'), 'report types: the Indices schedule did not draw');
    ok(doc.getElementById('rt-indices-at').value === '08:00', `report types: Indices opens at ${doc.getElementById('rt-indices-at').value}, want 08:00`);
    ok(doc.getElementById('rt-indices-period').value === 'monthSoFar', 'report types: Indices does not default to Month so far');
    ok(doc.getElementById('rt-indices-schedule').value === 'daily', 'report types: Indices does not default to daily');
    ok(/index store size/.test(doc.getElementById('rt-sizes').textContent), 'report types: the Indices report does not say its sizes are index store size');
    ok(doc.getElementById('rt-indices-enabled').checked === false, 'report types: Indices is on before an admin turned it on');
    // Turning it on without a recipient is refused here, and says why.
    doc.getElementById('rt-indices-enabled').checked = true; fire(doc.getElementById('rt-indices-enabled'));
    sentK.length = 0;
    doc.getElementById('rt-indices-save').click(); await settleFor(100);
    ok(!sentK.some((m) => m.type === 'REPORT_SCHEDULE_SET'), 'report types: an enabled schedule with nobody to send to was sent');
    ok(/at least one address/.test((doc.getElementById('rt-note') || { textContent: '' }).textContent), 'report types: no word about the missing recipient');
    const to = doc.getElementById('rt-indices-to');
    to.value = 'ops@example.com, lead@example.com'; fire(to, 'input');
    doc.getElementById('rt-indices-save').click();
    await waitFor(() => sentK.find((m) => m.type === 'REPORT_SCHEDULE_SET'), 'report types: Save sent nothing');
    const set = sentK.find((m) => m.type === 'REPORT_SCHEDULE_SET');
    ok(set && set.kind === 'indices' && set.enabled === true && set.at === '08:00' && set.period === 'monthSoFar' && set.to.length === 2,
      `report types: Save sent ${JSON.stringify(set)}`);
    // Volume by host: sizes basis, locked time, Run now with its two options.
    press(tab('hosts'));
    await waitFor(() => doc.getElementById('rt-hosts-at'), 'report types: the Volume by host schedule did not draw');
    ok(doc.getElementById('rt-hosts-at').value === '06:00', 'report types: Volume by host does not open at 06:00');
    ok(doc.getElementById('rt-hosts-at').disabled && /managed by config\.txt/.test(doc.querySelector('.rt-sched').textContent), 'report types: a locked time is not shown locked');
    ok(/event_logsize/.test(doc.getElementById('rt-sizes').textContent), 'report types: Volume by host does not say its sizes are event_logsize');
    ok(doc.getElementById('rt-hosts-run-period').value === 'monthSoFar', 'report types: Run now does not default to Month so far');
    ok(!!doc.getElementById('rt-hosts-again') && !!doc.getElementById('rt-hosts-run-mail'), 'report types: Collect again or Mail it is missing');
    doc.getElementById('rt-hosts-again').checked = true; fire(doc.getElementById('rt-hosts-again'));
    sentK.length = 0;
    doc.getElementById('rt-hosts-run').click();
    await waitFor(() => sentK.find((m) => m.type === 'REPORT_RUN'), 'report types: Run now sent nothing');
    const rr = sentK.find((m) => m.type === 'REPORT_RUN');
    ok(rr && rr.kind === 'hosts' && rr.collectAgain === true && rr.mail === false && rr.period === 'monthSoFar' && rr.clusterIds.length >= 1,
      `report types: Run now sent ${JSON.stringify(rr)}`);
    // The core's own refusal is said as it says it.
    refuseRun = { ok: false, kind: 'too_many_clusters', message: 'Volume by host takes at most 5 clusters; nothing was queued' };
    doc.getElementById('rt-hosts-run').click();
    await waitFor(() => /nothing was queued/.test((doc.getElementById('rt-note') || { textContent: '' }).textContent), 'report types: too_many_clusters was not said');
    // The report worker is down: the core's words, amber (banner warn), never the red of a refusal.
    refuseRun = { ok: false, kind: 'worker_unavailable', message: 'the report worker is not running — reports and collection resume when it is back' };
    doc.getElementById('rt-hosts-run').click();
    await waitFor(() => /report worker is not running/.test((doc.getElementById('rt-note') || { textContent: '' }).textContent), 'report types: worker_unavailable was not said');
    ok(doc.getElementById('rt-note').classList.contains('warn') && !doc.getElementById('rt-note').classList.contains('err'), `report types: worker_unavailable is not amber (${doc.getElementById('rt-note').className})`);
    refuseRun = null;

    // The view.
    await go('reports');
    press(doc.querySelector('.rp-nav a[data-section="hosts"]'));
    await waitFor(() => doc.querySelector('#hv-table table.hv-tbl'), 'volume by host: no table');
    const heads = () => [...doc.querySelectorAll('#hv-table thead th')].map((t) => t.textContent.replace(/[▲▼]/g, '').trim());
    ok(JSON.stringify(heads()) === JSON.stringify(['Day', 'Index', 'Source', 'Host', 'Documents', 'Event size', 'Forwarded size', 'zone', 'ClientID']), `volume by host: columns ${heads().join(' | ')}`);
    // The ClientID column is the core's filled value and sorts on it (clientId), not on the raw field.
    ok(!!doc.querySelector('#hv-table th[data-col="clientId"]'), 'volume by host: the ClientID column does not sort on the filled clientId');
    ok(/incomplete/.test(doc.querySelector('#hv-table tbody tr').textContent), 'volume by host: an incomplete row is not marked');
    ok(/7 without/.test(doc.querySelectorAll('#hv-table tbody tr')[1].textContent), 'volume by host: documents without an event size are not said');
    ok(/2026-11-03 \(HTTP 503 after 3 tries\)/.test(doc.querySelector('.hv-failed') ? doc.querySelector('.hv-failed').textContent : ''), 'volume by host: a day not held is not named with why');
    ok(doc.querySelectorAll('#hv-table tbody tr').length === 201, `volume by host: ${doc.querySelectorAll('#hv-table tbody tr').length - 1} rows on a page of 200`);
    ok(/not measured/.test(doc.querySelector('#hv-table tbody tr').textContent) && doc.querySelector('#hv-table tbody tr .rp-na'), 'volume by host: an absent event size is not amber "not measured"');
    const tot = doc.querySelector('#hv-table tr.hv-totals');
    ok(tot && /Total/.test(tot.textContent) && /not measured/.test(tot.textContent), 'volume by host: no totals row, or its absent figure reads as a number');
    ok(/2026-11-02/.test(doc.querySelector('.hv-incomplete') ? doc.querySelector('.hv-incomplete').textContent : ''), 'volume by host: the incomplete day is not flagged');
    ok(/tag1/.test(doc.querySelector('.hv-nomap') ? doc.querySelector('.hv-nomap').textContent : ''), 'volume by host: the field not in the mapping is not named');
    ok(/1–200 of 450/.test(doc.querySelector('.hv-pager').textContent), `volume by host: pager reads "${doc.querySelector('.hv-pager').textContent}"`);
    sentK.length = 0;
    doc.getElementById('hv-next').click();
    await waitFor(() => sentK.find((m) => m.type === 'HOSTS_QUERY' && m.offset === 200), 'volume by host: Next did not ask for offset 200');
    ok(sentK.every((m) => m.limit === 200), 'volume by host: a page is not 200 rows');
    sentK.length = 0;
    doc.querySelector('#hv-table th[data-col="docs"] button').click();
    await waitFor(() => sentK.find((m) => m.type === 'HOSTS_QUERY' && m.sort === 'docs:asc' && m.offset === 0), 'volume by host: sorting by Documents did not ask the server');
    sentK.length = 0;
    const q = doc.getElementById('hv-q'); q.value = 'h42'; fire(q, 'input');
    await waitFor(() => sentK.find((m) => m.type === 'HOSTS_QUERY' && m.q === 'h42'), 'volume by host: the search did not reach the server', 3000);
    await settleFor(150);
    ok(doc.querySelectorAll('#hv-table tbody tr').length < 201, 'volume by host: the search left every row');
  } finally {
    globalThis.fetch = realFetch;
  }
  await applyConfig({ load, configPath });
  await go('overview');
}


/* ------------------------------- Config › System › Backup & restore ------------------------------- */
// The dev bridge is the portable edition: it takes a backup, previews and restores, but keeps none and
// has no timer. So the first half runs against the real core (create → download → preview → Merge →
// the result), and the second half stubs the hosted answers (schedule, kept backups, Delete) at fetch.
await go('settings');
await settleFor(300);
{
  const sentBk = () => sent.filter((m) => /^BACKUP_/.test(m.type));
  const modalOf = (re) => [...doc.querySelectorAll('.modal')].find((m) => re.test(m.textContent));
  const modalBtn = (m, label) => m && [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const headerBtn = (label) => [...doc.querySelectorAll('.cm-actions button, .cm-actions label')].find((b) => b.textContent.trim() === label);
  const fakeFile = (name, text) => ({ name, size: text.length, text: async () => text });
  const chooseFile = async (f) => {
    const input = doc.querySelector('.cm-actions input[type="file"]');
    Object.defineProperty(input, 'files', { value: [f], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  ok(await openCfg('system', 'backup'), 'backup: the System › Backup & restore tab is not offered although PING says backup.supported');
  await waitFor(() => doc.getElementById('bk-root'), 'backup: the tab did not draw');
  const titles = [...doc.querySelectorAll('#bk-root section.card h2')].map((e) => e.textContent);
  ok(titles.includes('What a backup holds') && titles.includes('Restore'), `backup: cards are ${titles.join(' | ')}`);
  ok(sentBk().some((m) => m.type === 'BACKUP_STATUS'), 'backup: the tab did not ask BACKUP_STATUS');
  const ticks = [...doc.querySelectorAll('#bk-root input[data-section]')];
  ok(ticks.length === 9, `backup: ${ticks.length} sections in the tick list, expected 9`);
  ok(ticks.filter((t) => t.checked).length === 8 && !doc.querySelector('input[data-section="versions"]').checked, 'backup: the earlier config versions should start unticked and the other eight ticked');
  ok(/32|\d+ cluster/.test(doc.querySelector('input[data-section="clusters"]').closest('label').textContent), 'backup: the clusters row carries no count');
  ok(!!headerBtn('Restore from a file…') && !!headerBtn('Download backup now'), 'backup: the page header lacks Restore from a file… or Download backup now');
  ok(/Never in a backup/.test(doc.getElementById('bk-root').textContent), 'backup: no "never in a backup" note');
  ok(!doc.querySelector('#bk-root [data-track="backup-schedule"]') && /nothing to schedule/.test(doc.getElementById('bk-root').textContent),
    'backup: a portable core (keeps nothing) should say there is nothing to schedule, not draw a schedule form');

  // Download: the password rules first — nothing is sent until they hold.
  const before = sentBk().length;
  headerBtn('Download backup now').click(); await settleFor(120);
  ok(sentBk().length === before && /backup password/.test((doc.getElementById('bk-problem') || {}).textContent || ''), 'backup: Download with credentials on and no password was sent, or said nothing');
  const set = (id, v) => { const e = doc.getElementById(id); e.value = v; e.dispatchEvent(new window.Event('input', { bubbles: true })); };
  set('bk-pw', 'short'); set('bk-pw2', 'short');
  headerBtn('Download backup now').click(); await settleFor(120);
  ok(sentBk().length === before && /At least 12/.test((doc.getElementById('bk-problem') || {}).textContent || ''), 'backup: a 5-character password was not refused in words');
  set('bk-pw', 'correct-horse-battery'); set('bk-pw2', 'correct-horse-batterY');
  headerBtn('Download backup now').click(); await settleFor(120);
  ok(sentBk().length === before && /differ/.test((doc.getElementById('bk-problem') || {}).textContent || ''), 'backup: two different passwords were not refused');

  // A real backup: two sections, password-sealed.
  for (const t of doc.querySelectorAll('#bk-root input[data-section]')) {
    const want = ['play', 'requests'].includes(t.dataset.section);
    if (t.checked !== want) { t.checked = want; t.dispatchEvent(new window.Event('change', { bubbles: true })); }
  }
  set('bk-pw', 'correct-horse-battery'); set('bk-pw2', 'correct-horse-battery');
  const nFiles = files.length;
  headerBtn('Download backup now').click();
  await waitFor(() => files.length > nFiles, 'backup: Download backup now saved no file', 90000);
  const made = files.at(-1);
  ok(made && /^elasticpro-backup-.*\.epbak$/.test(made.name), `backup: the file is named ${made && made.name}`);
  const create = sentBk().filter((m) => m.type === 'BACKUP_CREATE').at(-1);
  ok(create && create.password === 'correct-horse-battery' && JSON.stringify(create.sections) === JSON.stringify(['requests', 'play']),
    `backup: BACKUP_CREATE carried ${JSON.stringify(create && { ...create, password: create.password && '<set>' })}`);
  ok(made && !made.text.includes('correct-horse-battery'), 'backup: the password is inside the downloaded file');
  ok(doc.getElementById('bk-pw').value === '' && doc.getElementById('bk-pw2').value === '', 'backup: the password boxes were not emptied after the download');
  ok(!/correct-horse-battery/.test(doc.body.textContent) && /Downloaded elasticpro-backup/.test((doc.getElementById('bk-made') || {}).textContent || ''),
    'backup: the page does not say what was downloaded, or it echoes the password');

  // Restore from that file: the preview needs the password (sealed), asks for it, then shows the table.
  await chooseFile(fakeFile('mine.epbak', made.text));
  await waitFor(() => doc.getElementById('bk-restore'), 'backup: choosing a file opened no Restore card', 90000);
  await waitFor(() => doc.getElementById('bk-rs-check'), 'backup: a password-sealed file did not ask for its password', 90000);
  ok(/unverified/.test((doc.getElementById('bk-says') || {}).textContent || '') && /taken by local/.test((doc.getElementById('bk-says') || {}).textContent || ''), 'backup: the file\'s own claims are not shown as "says … unverified"');
  const pv1 = sentBk().filter((m) => m.type === 'BACKUP_PREVIEW');
  ok(pv1.length === 1 && pv1[0].file === made.text && !('password' in pv1[0]), 'backup: the first preview should carry the file and no password');
  doc.getElementById('bk-rs-pw').value = 'wrong-password-here';
  doc.getElementById('bk-rs-check').click();
  await waitFor(() => /not the password/.test((doc.getElementById('bk-rs-error') || {}).textContent || ''), 'backup: a wrong password was not said in plain words', 90000);
  ok(/EP-309/.test(doc.getElementById('bk-rs-error').textContent), 'backup: the wrong-password message has no code');
  ok(doc.getElementById('bk-rs-pw').value === '', 'backup: the restore password box was not emptied after use');
  doc.getElementById('bk-rs-pw').value = 'correct-horse-battery';
  doc.getElementById('bk-rs-check').click();
  await waitFor(() => doc.querySelector('#bk-restore table tbody tr[data-section]'), 'backup: the right password drew no preview table', 90000);
  const rows = [...doc.querySelectorAll('#bk-restore tr[data-section]')].map((r) => r.dataset.section);
  ok(rows.join() === 'requests,play', `backup: the preview rows are ${rows.join()}`);
  ok(/Merge/.test(doc.getElementById('bk-restore').textContent) && /Replace everything/.test(doc.getElementById('bk-restore').textContent), 'backup: no Merge / Replace everything choice');
  ok(doc.querySelector('#bk-restore input[name="bk-mode"][value="merge"]').checked, 'backup: Merge is not the default');

  // Merge: behind a confirm, one BACKUP_RESTORE with mode merge and the password.
  const nRestore = sentBk().filter((m) => m.type === 'BACKUP_RESTORE').length;
  doc.getElementById('bk-restore-go').click();
  const dlgM = await waitFor(() => modalOf(/Merge this backup/), 'backup: Restore… opened no confirm');
  ok(sentBk().filter((m) => m.type === 'BACKUP_RESTORE').length === nRestore, 'backup: Restore went to the core before the confirm was answered');
  if (dlgM) { modalBtn(dlgM, 'Cancel').click(); await settleFor(100); }
  ok(sentBk().filter((m) => m.type === 'BACKUP_RESTORE').length === nRestore, 'backup: Cancel on the confirm still restored');
  doc.getElementById('bk-rs-pw').value = 'correct-horse-battery';
  doc.getElementById('bk-restore-go').click();
  const dlgM2 = await waitFor(() => modalOf(/Merge this backup/), 'backup: second Restore… opened no confirm');
  ok(dlgM2 && /Merge/.test(modalBtn(dlgM2, 'Merge') ? 'Merge' : ''), 'backup: the confirm has no Merge button');
  if (dlgM2) modalBtn(dlgM2, 'Merge').click();
  await waitFor(() => doc.getElementById('bk-rs-result'), 'backup: the restore showed no result', 90000);
  const rmsg = sentBk().filter((m) => m.type === 'BACKUP_RESTORE').at(-1);
  ok(rmsg && rmsg.mode === 'merge' && rmsg.password === 'correct-horse-battery' && rmsg.file === made.text && !rmsg.skipCredentials,
    `backup: BACKUP_RESTORE carried ${JSON.stringify(rmsg && { ...rmsg, file: '…', password: rmsg.password && '<set>' })}`);
  ok(/Restored \(merge\)/.test(doc.getElementById('bk-rs-result').textContent) && /Request policy and Defaults/.test(doc.getElementById('bk-rs-result').textContent), 'backup: the result does not list applied sections');
  ok(((doc.getElementById('bk-rs-pw') || { value: '' }).value) === '', 'backup: the password box kept the password after the restore');
  press(doc.getElementById('bk-rs-close')); await settleFor(100);

  // Errors in words: a file that is not a backup, and one that was edited.
  await chooseFile(fakeFile('notes.txt', '{"hello": 1}'));
  await waitFor(() => /not an ElasticPro backup/.test((doc.getElementById('bk-rs-error') || {}).textContent || ''), 'backup: a non-backup file was not refused in words');
  ok(/EP-312/.test(doc.getElementById('bk-rs-error').textContent), 'backup: not_a_backup carries no code');
  ok(!doc.getElementById('bk-restore-go'), 'backup: Restore… is offered for a file that did not preview');
  await chooseFile(fakeFile('edited.epbak', made.text.replace('"play"', '"plax"')));
  await waitFor(() => /EP-31[24]/.test((doc.getElementById('bk-rs-error') || {}).textContent || ''), 'backup: an edited file was not refused');
  press(doc.getElementById('bk-rs-close')); await settleFor(100);

  // A name from a file is text, never markup.
  const evil = made.text.replace('"takenBy": "local"', '"takenBy": "<img src=x onerror=window.__pwned=1>"');
  await chooseFile(fakeFile('<b>x</b>.epbak', evil));
  await settleFor(8000);
  ok(!doc.querySelector('#bk-restore img') && !window.__pwned, 'backup: takenBy from the file was drawn as markup');
  press(doc.getElementById('bk-rs-close')); await settleFor(100);

  // Passwords do not outlive the tab: typed, then left for another tab and come back, the boxes are empty.
  set('bk-pw', 'left-behind-password'); set('bk-pw2', 'left-behind-password');
  ok(await openCfg('system', 'defaults'), 'backup: could not leave for System › Defaults');
  ok(await openCfg('system', 'backup'), 'backup: could not come back to Backup & restore');
  await waitFor(() => doc.getElementById('bk-pw'), 'backup: the tab did not come back with its password box');
  ok(doc.getElementById('bk-pw') && doc.getElementById('bk-pw').value === '' && doc.getElementById('bk-pw2').value === '', 'backup: a typed backup password survived leaving the tab');
}

// The hosted half, stubbed: schedule through the save bar, the kept list, Restore… and Delete on a kept backup.
{
  const realFetch = globalThis.fetch;
  const modalOf = (re) => [...doc.querySelectorAll('.modal')].find((m) => re.test(m.textContent));
  const modalBtn = (m, label) => m && [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const hsent = [];
  const now = Date.now();
  const sections = ['clusters', 'trust', 'alerts', 'requests', 'zabbix', 'reports', 'play', 'data', 'versions'];
  let status = {
    ok: true, supported: true, keeps: true, dir: '/data/backups', serverSealing: true, minPassword: 12,
    sections: sections.map((id) => ({ id, label: id })),
    schedule: { enabled: true, every: 'day', at: '02:00', keep: 14, keepMax: 90, sections, last: { at: now - 3600e3, ok: true, name: 's.epbak', bytes: 421888, localDay: '' }, next: now + 3600e3 * 20 },
    kept: [
      { name: 'a-scheduled.epbak', bytes: 421888, takenAt: now - 3600e3, takenBy: 'schedule', kind: 'scheduled', kindLabel: 'scheduled', sections, credentials: 'server', credentialsCount: 3, coreVersion: '0.3.54', readable: true },
      { name: 'b-hand.epbak', bytes: 405504, takenAt: now - 7200e3, takenBy: '<i>admin</i>', kind: 'manual', kindLabel: 'by hand', sections: ['clusters', 'play'], credentials: 'none', credentialsCount: 0, coreVersion: '0.3.54', readable: true },
      { name: 'c-before.epbak', bytes: 1000, takenAt: now - 9000e3, takenBy: 'admin', kind: 'before-restore', kindLabel: 'before a restore', sections, credentials: 'server', credentialsCount: 1, coreVersion: '0.3.54', readable: false, problem: 'damaged' },
    ],
  };
  const preview = (name) => ({
    ok: true, name, formatVersion: 1,
    backup: { formatVersion: 1, coreVersion: '0.3.54', takenAt: now - 3600e3, takenBy: 'schedule', kind: 'scheduled', kindLabel: 'scheduled', sections: ['clusters', 'requests'], unknownSections: [], credentials: { count: 3, scheme: 'server' }, bytes: 421888,
      says: { takenBy: 'schedule', takenAt: now - 3600e3, coreVersion: '0.3.54', verified: false } },
    credentials: { state: 'opened', count: 3 },
    preview: [
      { id: 'clusters', label: 'Clusters and their settings', present: true, add: ['new-1', 'new-2'], change: ['old-1'], same: 4, onlyHere: ['mine-1', 'mine-2', 'mine-3'], keptAnyway: [] },
      { id: 'requests', label: 'Request policy and Defaults', present: true, add: [], change: [], same: 1, onlyHere: [], keptAnyway: ['policy'] },
      { id: 'play', label: 'Play', present: false, add: [], change: [], same: 0, onlyHere: [], keptAnyway: [] },
    ],
  });
  globalThis.fetch = async (input, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(body.type || '').startsWith('BACKUP_')) {
      hsent.push(body);
      switch (body.type) {
        case 'BACKUP_STATUS': return stubReply(status);
        case 'BACKUP_SCHEDULE_SET': status = { ...status, schedule: { ...status.schedule, ...body.schedule } }; return stubReply(status);
        case 'BACKUP_DELETE': status = { ...status, kept: status.kept.filter((k) => k.name !== body.name) }; return stubReply(status);
        case 'BACKUP_DOWNLOAD': return stubReply({ ok: true, name: body.name, bytes: 5, file: 'FILE!' });
        case 'BACKUP_PREVIEW': return stubReply(preview(body.name));
        case 'BACKUP_RESTORE':
          return stubReply({ ok: true, mode: body.mode, name: body.name, beforeRestore: 'x-before-restore.epbak', credentials: 'opened', backup: preview(body.name).backup,
            applied: [{ id: 'clusters', label: 'Clusters and their settings', added: 2, changed: 1, removed: body.mode === 'replace' ? 3 : 0, notes: ['<b>one</b> pin skipped'] }] });
        default: return stubReply({ ok: false, kind: 'bad_message', message: 'unknown' });
      }
    }
    return realFetch(input, init);
  };
  try {
    await go('overview');
    await go('settings');
    await settleFor(300);
    ok(await openCfg('system', 'backup'), 'backup (hosted stub): tab not offered');
    await waitFor(() => doc.querySelector('#bk-root [data-track="backup-schedule"]'), 'backup (hosted stub): no schedule card');
    const g = (id) => doc.getElementById(id);
    ok(g('bk-sch-enabled').checked && g('bk-sch-every').value === 'day' && g('bk-sch-at').value === '02:00' && g('bk-sch-keep').value === '14', 'backup (hosted stub): the schedule form does not show the saved schedule');
    ok(/Last:\s*ok/.test(g('bk-sch-line').textContent) && /next/.test(g('bk-sch-line').textContent), `backup (hosted stub): the schedule line reads "${g('bk-sch-line').textContent}"`);
    ok(![...doc.querySelectorAll('[data-track="backup-schedule"] button')].some((b) => /save/i.test(b.textContent)), 'backup (hosted stub): the schedule card has its own Save button');
    // The kept table.
    const rowsK = [...doc.querySelectorAll('#bk-root tr[data-backup]')];
    ok(rowsK.length === 3, `backup (hosted stub): ${rowsK.length} kept rows`);
    ok(/<i>admin<\/i>/.test(rowsK[1].textContent) && !rowsK[1].cells[1].querySelector('*'), 'backup (hosted stub): takenBy is not shown as plain text');
    ok(/everything · credentials encrypted/.test(rowsK[0].textContent) && /clusters|Clusters/.test(rowsK[1].textContent) && /no credentials/.test(rowsK[1].textContent), 'backup (hosted stub): the Holds column is wrong');
    ok(/412 KB/.test(rowsK[0].textContent) && /scheduled/.test(rowsK[0].textContent) && /by hand/.test(rowsK[1].textContent), 'backup (hosted stub): size or kind columns wrong');
    ok(rowsK[2].querySelector('[data-act="restore"]').disabled && /damaged/.test(rowsK[2].textContent), 'backup (hosted stub): an unreadable backup can be restored');
    ok(rowsK.every((r) => r.querySelector('[data-act="delete"].danger') && r.querySelector('[data-act="restore"].danger')), 'backup (hosted stub): Restore… and Delete are not red');
    // Save the schedule through the one bar.
    g('bk-sch-every').value = 'week'; g('bk-sch-keep').value = '30'; g('bk-sch-at').value = '03:15';
    ok(await saveViaBar(200), 'backup (hosted stub): editing the schedule brought no save bar');
    const sch = hsent.filter((m) => m.type === 'BACKUP_SCHEDULE_SET').at(-1);
    ok(sch && JSON.stringify(sch.schedule) === JSON.stringify({ enabled: true, every: 'week', at: '03:15', keep: 30 }), `backup (hosted stub): BACKUP_SCHEDULE_SET carried ${JSON.stringify(sch)}`);
    ok(g('bk-sch-every').value === 'week' && g('bk-sch-keep').value === '30', 'backup (hosted stub): the saved schedule is not shown');
    // Typing elsewhere does not lose an unsaved schedule edit.
    g('bk-sch-keep').value = '9'; g('bk-sch-keep').dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.querySelector('input[data-section="alerts"]').click(); await settleFor(100);
    const credsSw = g('bk-creds'); credsSw.checked = false; credsSw.dispatchEvent(new window.Event('change', { bubbles: true })); await settleFor(100);
    ok(g('bk-sch-keep').value === '9', 'backup (hosted stub): flipping the credentials switch dropped an unsaved schedule edit');
    ok(!g('bk-pw'), 'backup (hosted stub): the password boxes stay with credentials off');
    const disc = doc.querySelector('#cm-savebar button[data-act="discard"]'); if (disc) { disc.click(); await settleFor(150); }
    // Download with credentials off: no password key, keep: true (this server keeps copies).
    [...doc.querySelectorAll('.cm-actions button')].find((b) => b.textContent.trim() === 'Download backup now').click();
    await waitFor(() => hsent.some((m) => m.type === 'BACKUP_CREATE'), 'backup (hosted stub): credentials-off download sent nothing');
    // (the stub does not answer BACKUP_CREATE: the page must say so, not hang)
    await settleFor(200);
    // Restore… on a kept backup: preview by name, Replace names what it removes, red, confirm.
    const row0 = () => doc.querySelector('tr[data-backup="a-scheduled.epbak"]');
    row0().querySelector('[data-act="restore"]').click();
    await waitFor(() => doc.querySelector('#bk-restore tr[data-section]'), 'backup (hosted stub): Restore… on a kept backup drew no preview');
    const pv = hsent.filter((m) => m.type === 'BACKUP_PREVIEW').at(-1);
    ok(pv && pv.name === 'a-scheduled.epbak' && !('file' in pv), `backup (hosted stub): the preview of a kept backup carried ${JSON.stringify(pv)}`);
    const cells = [...doc.querySelector('#bk-restore tr[data-section="clusters"]').cells].map((c) => c.textContent.trim());
    ok(cells[1] === '2' && cells[2] === '1' && cells[3].startsWith('3'), `backup (hosted stub): clusters row reads ${cells.join(' | ')}`);
    ok(/\+1 kept anyway/.test(doc.querySelector('#bk-restore tr[data-section="requests"]').textContent), 'backup (hosted stub): keptAnyway is not listed as "kept anyway"');
    ok(/the 3 items only here now are removed/.test(doc.getElementById('bk-restore').textContent), 'backup (hosted stub): the Replace caption lacks the preview count');
    ok(/Not in the file/.test(doc.getElementById('bk-restore').textContent) && /unverified/.test(doc.getElementById('bk-says').textContent), 'backup (hosted stub): missing sections or the says line are not stated');
    ok(doc.getElementById('bk-restore-go').classList.contains('danger'), 'backup (hosted stub): Restore… is not red');
    doc.querySelector('#bk-restore input[value="replace"]').click(); doc.querySelector('#bk-restore input[value="replace"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    const nRs = hsent.filter((m) => m.type === 'BACKUP_RESTORE').length;
    doc.getElementById('bk-restore-go').click();
    doc.getElementById('bk-restore-go').click();
    await settleFor(150);
    ok([...doc.querySelectorAll('.modal')].filter((m) => /Replace everything\?/.test(m.textContent)).length === 1, 'backup (hosted stub): two clicks on Restore… opened two confirms');
    const dR = await waitFor(() => modalOf(/Replace everything\?/), 'backup (hosted stub): Replace asked no confirm');
    ok(dR && /Clusters and their settings: 3 removed \(mine-1, mine-2, mine-3\)/.test(dR.textContent) && /kept anyway/.test(dR.textContent) && /before a restore/.test(dR.textContent), `backup (hosted stub): the Replace confirm reads "${dR && dR.textContent.replace(/\s+/g, ' ').slice(0, 300)}"`);
    ok(dR && modalBtn(dR, 'Replace everything') && modalBtn(dR, 'Replace everything').classList.contains('danger'), 'backup (hosted stub): the Replace confirm button is not red');
    ok(dR && /Credentials|credential/.test(dR.textContent), 'backup (hosted stub): the confirm says nothing about credentials');
    if (dR) modalBtn(dR, 'Replace everything').click();
    await waitFor(() => g('bk-rs-result'), 'backup (hosted stub): Replace showed no result');
    ok(hsent.filter((m) => m.type === 'BACKUP_RESTORE').length === nRs + 1, 'backup (hosted stub): two clicks sent more than one BACKUP_RESTORE');
    const rr = hsent.filter((m) => m.type === 'BACKUP_RESTORE').at(-1);
    ok(rr && rr.mode === 'replace' && rr.name === 'a-scheduled.epbak', `backup (hosted stub): BACKUP_RESTORE carried ${JSON.stringify(rr)}`);
    const rt = g('bk-rs-result').textContent;
    ok(/2 added, 1 changed, 3 removed/.test(rt) && /x-before-restore\.epbak/.test(rt) && /<b>one<\/b> pin skipped/.test(rt) && !g('bk-rs-result').querySelector('b b'), `backup (hosted stub): the result reads "${rt}"`);
    press(g('bk-rs-close')); await settleFor(100);
    // Delete: a confirm, then BACKUP_DELETE, then the row is gone.
    doc.querySelector('tr[data-backup="b-hand.epbak"] [data-act="delete"]').click();
    const dD = await waitFor(() => modalOf(/Delete b-hand\.epbak\?/), 'backup (hosted stub): Delete asked no confirm');
    ok(!hsent.some((m) => m.type === 'BACKUP_DELETE'), 'backup (hosted stub): Delete went to the core before the confirm');
    if (dD) modalBtn(dD, 'Delete').click();
    await waitFor(() => !doc.querySelector('tr[data-backup="b-hand.epbak"]'), 'backup (hosted stub): the deleted backup is still listed');
    ok(hsent.some((m) => m.type === 'BACKUP_DELETE' && m.name === 'b-hand.epbak'), 'backup (hosted stub): no BACKUP_DELETE for the named file');
    // Download a kept one.
    const nf = files.length;
    doc.querySelector('tr[data-backup="a-scheduled.epbak"] [data-act="download"]').click();
    await waitFor(() => files.length > nf, 'backup (hosted stub): Download on a kept backup saved no file');
    ok(files.at(-1).name === 'a-scheduled.epbak' && files.at(-1).text === 'FILE!', 'backup (hosted stub): the kept download is not the core\'s file');
    // Find a setting reaches the new labels.
    const find = g('cm-find');
    find.value = 'backup password'; find.dispatchEvent(new window.Event('input', { bubbles: true })); await settleFor(150);
    ok(/Backup password/.test((g('cm-find-results') || {}).textContent || ''), 'backup (hosted stub): Find a setting does not index "Backup password"');
  } finally {
    globalThis.fetch = realFetch;
  }
  await go('overview');
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('ok: strip, console, shards, the Clusters page (columns, name menu, unreachable rows, expand chevron, alerts link), Reports (sections, Columns menu, Storage plan, Measure size, exports), Indices without Summary, hand-off, refresh, snapshots, tasks, toasts, accounts split and pinned Zabbix roles, the log-delay preflight, a quiet Config page, Config › Volume fields, report jobs and the Reports pill, the mailed report and the mail server, the Request Centre and the redraw gate, the request policy, the coverage bar, the Tasks panel and the console tabs, template management, the Alerts page grouped by cluster with merged repeats, cluster type (badge, Type filter, edit dialog to file keys and CLUSTER_META_SET), Go to, playbooks and the bell, and the default credential (no password asked for a new cluster, promote, never replaced unticked), and Config › Play (links, revoke, exclusion, locked fields, watch rules), and Config › History store (gated switch, test, arm, delay destination), and Play (slides, keys, zoom, takeover, exclusion, display link, an older core), and Reports (Planning recalculates, the backup target, Based on a cluster, CSV; plan templates save and delete; which indices count)');
// The pages leave auto-refresh timers and a live tail running; nothing here waits on them.
process.exit(0);
