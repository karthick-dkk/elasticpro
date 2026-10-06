/**
 * Page — live indices, with a source picker driven by the index naming pattern.
 *
 * "Source" is the tenant inside an index name (logstash-<source>-YYYY.MM.DD). It is NOT
 * a client: in this app a client is a whole cluster with its own Elasticsearch URL, and
 * one cluster holds many sources.
 */

import { h, mount, $, clear, activatable } from '../lib/dom.js';
import { bytes, num, compact, dt, ago, toCsv, download } from '../lib/fmt.js';
import { state, client, fetchIndices, activeClusters, datasetFreshness } from '../core/state.js';
import { card, collapsible, pill, statTile, table, empty, connectionBanner } from './common.js';
import { navigateTo } from '../core/intent.js';
import { syncWrites, writeToggle } from '../core/writes.js';
import {
  openIndices, closeIndices, deleteIndices, moveShardDialog, indexSettingsDialog,
  maintenance, MAINTENANCE_KINDS,
} from '../ui/index-actions.js';
import { rowMenu, ICON, closeMenus } from '../ui/menu.js';
import { findIndexEverywhere } from '../core/snapshot-verify.js';
import { restoreIndicesDialog, restoreSourceOf } from '../ui/snapshot-dialogs.js';
import { pageSlice, pagerBar } from '../lib/pager.js';
import { freshnessBar } from '../lib/freshness.js';
import { sourceSizeChart, perDayChart, volumeAnalysisCard } from '../ui/index-metrics.js';

let host = null;
const ui = { sourceFilter: 'all', text: '', status: 'all', sort: 'size', dir: -1, from: '', to: '', loading: false, error: null, page: 0, view: 'indices' };
/** Index names ticked in the table, for the bulk actions. Cleared when the data reloads. */
const selected = new Set();
/** Volume-analysis UI state: which field, how far back, and whether a run is in flight. */
const va = { field: null, days: 14, topN: 12, running: false, error: null, byTerm: null, selectedTerm: null };
/** The everywhere-search: live indices AND every snapshot, for "does this still exist". */
/**
 * Where to search. `live` filters the table and costs nothing; the other two reach into
 * every snapshot repository, which is a request per repository, so they run on the
 * button rather than as you type.
 */
const SCOPES = [
  { id: 'live', label: 'Live', title: 'Only indices that exist on the cluster now' },
  { id: 'snapshot', label: 'Snapshot', title: 'Only indices held in a snapshot repository' },
  { id: 'both', label: 'Live + Snapshot', title: 'Both at once — where does this index exist, anywhere' },
];
const ev = { scope: 'live', term: '', running: false, result: null, error: null, picked: new Set() };

export function render(el) {
  host = el;
  el.classList.add('dense');   // long tables: fit more on one screen
  selected.clear();
  syncWrites().then(draw).catch(() => {});
  draw();
  load();
}
export function onData() { if (host && host.isConnected) draw(); }

function cluster() { return activeClusters()[0] || null; }

async function load(force) {
  const c = cluster();
  if (!c) return;
  if (!force && state.indices.get(c.id)) { draw(); return; }
  ui.loading = true; ui.error = null; draw();
  // `force` asks for the list now; otherwise the core's copy serves while it is fresh.
  try { await fetchIndices(c.id, '*', { force: !!force }); selected.clear(); }
  catch (e) { ui.error = e.message; }
  ui.loading = false; draw();
}

function rowsFor(c) {
  let rows = state.indices.get(c.id) || [];
  if (ui.sourceFilter === '__none') rows = rows.filter((r) => !r.source);
  else if (ui.sourceFilter !== 'all') rows = rows.filter((r) => r.source === ui.sourceFilter);
  if (ui.status !== 'all') rows = rows.filter((r) => (ui.status === 'open' || ui.status === 'close') ? r.status === ui.status : r.health === ui.status);
  if (ui.from) rows = rows.filter((r) => !r.day || r.day >= ui.from);
  if (ui.to) rows = rows.filter((r) => !r.day || r.day <= ui.to);
  if (ui.text.trim()) {
    const t = ui.text.trim().toLowerCase();
    rows = rows.filter((r) => r.index.toLowerCase().includes(t));
  }
  const key = ui.sort;
  rows = [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * ui.dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * ui.dir;
  });
  return rows;
}

function draw() {
  const c = cluster();
  if (!c) return mount(host, empty('No cluster selected'));
  const all = state.indices.get(c.id) || [];
  const rows = rowsFor(c);

  const sourcesMap = new Map();
  all.forEach((r) => {
    const k = r.source || '__none';
    const cur = sourcesMap.get(k) || { key: k, indices: 0, docs: 0, size: 0 };
    cur.indices++; cur.docs += r.docs; cur.size += r.size;
    sourcesMap.set(k, cur);
  });
  const sourceList = [...sourcesMap.values()].sort((a, b) => b.size - a.size);

  const totals = rows.reduce((s, r) => ({ docs: s.docs + r.docs, size: s.size + r.size, pri: s.pri + r.pri, shards: s.shards + r.pri * (1 + r.rep) }),
    { docs: 0, size: 0, pri: 0, shards: 0 });

  mount(host,
    sourceBar(c, sourceList, all.length),
    ui.error ? h('div.banner.err', h('div', h('div.ttl', 'Could not list indices'), h('div.mono', ui.error))) : null,
    viewTabs(),
    // The picker is on Summary, so an active filter has to announce itself here — a
    // filtered table with no visible control is a table that looks like it lost rows.
    ui.view === 'indices' && ui.sourceFilter !== 'all'
      ? h('div.muted', { style: { fontSize: '11.5px', marginBottom: '8px' } },
          `Source: ${ui.sourceFilter === '__none' ? '(no source)' : ui.sourceFilter}`,
          h('button.btn.sm.ghost', { style: { marginLeft: '6px' },
            title: 'Show every source again',
            onclick: () => { ui.sourceFilter = 'all'; ui.page = 0; draw(); } }, 'clear'))
      : null,

    ui.view === 'summary' ? summaryView(c, rows, all, totals) : null,
    ui.view === 'summary' ? null :
    tableCard(c, rows, all));
}

/**
 * Indices / Summary.
 *
 * Two jobs, one page. "Indices" is the working view — find an index, open it, close it,
 * delete it — and it is what the page opens on, because that is what people come here to
 * do. "Summary" is how much there is and where it came from: the same numbers, read
 * rather than acted on. They were stacked on top of each other, so the table everyone
 * wanted started four charts down the page.
 */
function viewTabs() {
  const tab = (id, label, title) => h('button.btn.sm', {
    'aria-pressed': ui.view === id ? 'true' : 'false',
    title,
    onclick: () => { if (ui.view !== id) { ui.view = id; draw(); } },
  }, label);
  return h('div.seg', { role: 'group', 'aria-label': 'Indices view', style: { marginBottom: '10px' } },
    tab('indices', 'Indices', 'The index list, and the actions that manage it'),
    tab('summary', 'Summary', 'Store size, sources, indices per day, and daily volume by field'));
}

function summaryView(c, rows, all, totals) {
  return h('div',
    h('div.toolbar', { style: { marginBottom: '12px' } },
      h('label.field', 'Source', sourcePicker(
        [...new Map(all.map((r) => [r.source || '__none', null])).keys()].length
          ? [...all.reduce((m, r) => {
              const k = r.source || '__none';
              const cur = m.get(k) || { key: k, indices: 0, docs: 0, size: 0 };
              cur.indices++; cur.docs += r.docs; cur.size += r.size;
              return m.set(k, cur);
            }, new Map()).values()].sort((a, b) => b.size - a.size)
          : [], all.length))),

    h('div.grid.c4', { style: { marginBottom: '14px' } },
      statTile('Indices shown', `${num(rows.length)}`, `of ${num(all.length)} on ${c.name}`),
      statTile('Documents', compact(totals.docs), `${num(totals.docs)} docs`),
      statTile('Store size', bytes(totals.size), `${num(totals.shards)} shards`),
      statTile('Sources detected',
        String(new Set(all.map((r) => r.source).filter(Boolean)).size), 'parsed from index names')),

    h('div.grid.c2', { style: { marginBottom: '10px' } },
      collapsible('Store size by source', 'click a bar to filter the table', () =>
        // Selecting a bar filters the table, so it also returns to the view that has one.
        sourceSizeChart(all, { onSelect: (r) => { ui.sourceFilter = r.key; ui.page = 0; ui.view = 'indices'; draw(); } }),
        { key: 'idx-by-source', open: true }),
      collapsible('Indices per day', 'daily indices detected from the naming pattern', () =>
        perDayChart(rows, { onSelect: (r) => { ui.from = r.key; ui.to = r.key; ui.page = 0; ui.view = 'indices'; draw(); } }),
        { key: 'idx-per-day', open: true })),

    volumeAnalysisCard(c, draw));
}

/* ----------------------------- volume analysis ------------------------------ */

/**
 * Daily volume split by an ECS field — tag1, src_hostname — rather than by index.
 *
 * The index list answers "how much did this cluster take yesterday". This answers "which
 * device or tag was responsible", which is the question asked when the first number moves.
 * It costs one aggregation per field, so it runs on demand rather than on every render.
 */
/**
 * The source picker.
 *
 * Lives on the Summary view, not in the Indices toolbar. "Which source" is a question
 * about where the volume came from — the thing Summary is for — while the Indices
 * toolbar is for finding one index: a name, a date range, a status. Choosing a source
 * still filters the table, and still drops you back on the Indices view so the filter
 * you just applied is visible where it applies.
 */
function sourcePicker(sourceList, total) {
  const sel = h('select', { onchange: (e) => {
    ui.sourceFilter = e.target.value; ui.page = 0; ui.view = 'indices'; draw();
  } },
    h('option', { value: 'all' }, `All sources (${total} indices)`),
    ...sourceList.filter((x) => x.key !== '__none').map((x) => h('option', { value: x.key }, `${x.key} — ${x.indices} idx · ${bytes(x.size)}`)),
    sourceList.some((x) => x.key === '__none') ? h('option', { value: '__none' }, '(indices without a source)') : null);
  sel.value = ui.sourceFilter;
  return sel;
}

function sourceBar(c, sourceList, total) {
  return h('div.toolbar',
    h('label.field', 'Search index', h('input#idx-search', { type: 'search', placeholder: 'substring…', value: ui.text, style: { minWidth: '200px' },
      oninput: (e) => { ui.text = e.target.value; ui.page = 0; syncSearchBoxes(e.target); redrawTable(); } })),
    h('label.field', 'From day', h('input', { type: 'date', value: ui.from, onchange: (e) => { ui.from = e.target.value; draw(); } })),
    h('label.field', 'To day', h('input', { type: 'date', value: ui.to, onchange: (e) => { ui.to = e.target.value; draw(); } })),
    h('label.field', 'Status', (() => {
      const s = h('select', { onchange: (e) => { ui.status = e.target.value; ui.page = 0; draw(); } },
        h('option', { value: 'all' }, 'Any'), h('option', { value: 'green' }, 'green'),
        h('option', { value: 'yellow' }, 'yellow'), h('option', { value: 'red' }, 'red'),
        h('option', { value: 'open' }, 'open'), h('option', { value: 'close' }, 'closed'));
      s.value = ui.status; return s;
    })()),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'flex-end' } },
      // This list's own age, not the last global refresh — the page serves what was
      // already fetched, so how old that is decides whether it is still true.
      freshnessBar(datasetFreshness(c.id, 'indices'), () => load(true), { label: 'Indices', busy: ui.loading }),
      writeToggle(draw),
      h('button.btn.sm', { onclick: () => { ui.sourceFilter = 'all'; ui.text = ''; ui.status = 'all'; ui.from = ''; ui.to = ''; ui.page = 0; draw(); } }, 'Clear'),
      h('button.btn.sm', { onclick: () => load(true) }, '↻ Reload')));
}

function th(label, key, numeric) {
  const sort = () => { ui.dir = ui.sort === key ? -ui.dir : -1; ui.sort = key; ui.page = 0; redrawTable(); };
  const active = ui.sort === key;
  return h('th', {
    // mount() restores focus across a rebuild by id, and sorting rebuilds the whole table.
    // Without an id a keyboard user is thrown back to the top of the page on every sort.
    id: `idx-th-${key}`,
    class: `${numeric ? 'num ' : ''}sortable`,
    // role stays columnheader; aria-sort is what tells a screen reader the direction.
    'aria-sort': active ? (ui.dir === 1 ? 'ascending' : 'descending') : 'none',
    ...activatable(sort, { role: null }),
  }, label + (active ? (ui.dir === 1 ? ' ▲' : ' ▼') : ''));
}

function redrawTable() {
  const c = cluster(); if (!c) return;
  const holder = $('#idx-table');
  if (!holder) return draw();
  const rows = rowsFor(c);
  const slice = pageSlice(rows, ui.page, perPage(c));
  // Write the clamped page back: a filter that shrank the list below the current page
  // would otherwise leave ui.page pointing past the end, and the next Previous click
  // would appear to do nothing while it walked back through pages that do not exist.
  ui.page = slice.page;
  const meta = $('#idx-meta');
  if (meta) meta.textContent = `${num(slice.first)}–${num(slice.last)} of ${num(rows.length)} matching`;
  mount(holder, buildTable(c, slice.rows, rows), pagerBar(slice, goToPage));
}

/** Rows per page for this cluster — config, with the shared default as the floor. */
function perPage(c) {
  const n = Math.floor(Number(c && c.tableRowsPerPage));
  return isFinite(n) && n > 0 ? n : 50;
}

function goToPage(p) {
  ui.page = p;
  redrawTable();
  // The table can be taller than the viewport, so a page change that leaves the scroll
  // position where it was drops the operator into the middle of the new page.
  const holder = $('#idx-table');
  if (holder && holder.scrollIntoView) holder.scrollIntoView({ block: 'start' });
}

/** Reload after an action changed the cluster, keeping the operator's filters. */
async function afterChange(c) {
  selected.clear();
  await load(true);
}

/** The bar that appears once indices are ticked. Everything on it is an operator action. */
function bulkBar(c, rows) {
  const names = [...selected];
  const chosen = rows.filter((r) => selected.has(r.index));
  const size = chosen.reduce((s, r) => s + (r.size || 0), 0);
  const anyClosed = chosen.some((r) => r.status !== 'open');
  const anyOpen = chosen.some((r) => r.status === 'open');
  const refresh = { onChanged: () => afterChange(c) };

  if (!names.length) {
    return h('div.muted', { style: { fontSize: '11.5px' } },
      'Tick indices to open, close, delete or reconfigure them.');
  }

  return h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
    h('span', { style: { fontWeight: 640, fontSize: '12px' } },
      `${num(names.length)} selected`, size ? h('span.muted', { style: { fontWeight: 400 } }, ` · ${bytes(size)}`) : null),
    h('button.btn.sm', { disabled: !anyClosed, title: anyClosed ? 'Open the selected indices' : 'All selected indices are already open',
      onclick: () => openIndices(c, chosen.filter((r) => r.status !== 'open').map((r) => r.index), refresh) }, 'Open'),
    h('button.btn.sm', { disabled: !anyOpen, title: anyOpen ? 'Close the selected indices' : 'All selected indices are already closed',
      onclick: () => closeIndices(c, chosen.filter((r) => r.status === 'open').map((r) => r.index), refresh) }, 'Close'),
    rowMenu([
      { label: 'Settings…', icon: ICON.settings, onClick: () => indexSettingsDialog(c, names, refresh) },
      { sep: true },
      ...MAINTENANCE_KINDS.map(([k, label]) => ({
        label, icon: ICON.refresh, onClick: () => maintenance(c, names, k, refresh),
      })),
      { sep: true },
      { label: `Delete ${num(names.length)} indices…`, icon: ICON.delete, danger: true,
        onClick: () => deleteIndices(c, names, refresh) },
    ], { label: '⋮ Actions', title: 'Actions for the selection' }),
    h('button.btn.sm.ghost', { onclick: () => { selected.clear(); redrawTable(); } }, 'Clear selection'));
}

function buildTable(c, rows, allRows = rows) {
  // `rows` is the current page; `allRows` is everything the filters matched. Counts and
  // the bulk bar speak about the filtered set, the tbody only about the page.
  const shown = rows;
  const refresh = { onChanged: () => afterChange(c) };
  const allShownTicked = shown.length > 0 && shown.every((r) => selected.has(r.index));

  const tick = (r) => h('input', {
    type: 'checkbox', checked: selected.has(r.index), style: { cursor: 'pointer' },
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { if (e.target.checked) selected.add(r.index); else selected.delete(r.index); redrawBulk(c); },
  });

  const trs = shown.map((r) => h('tr',
    h('td', tick(r)),
    h('td', pill(r.health || '?', r.health)),
    h('td.mono', { style: { maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: r.index }, r.index),
    h('td', r.source ? h('button.btn.sm.ghost', { onclick: () => { ui.sourceFilter = r.source; ui.page = 0; draw(); } }, r.source) : h('span.muted', '–')),
    h('td.mono', r.day || '–'),
    h('td', r.status === 'open' ? h('span.pill.green', h('i.dot'), 'open') : h('span.pill.grey', h('i.dot'), r.status || '?')),
    h('td.num', `${r.pri}/${r.rep}`),
    h('td.num', { title: num(r.docs) }, compact(r.docs)),
    h('td.num.muted', compact(r.deleted)),
    h('td.num', bytes(r.size)),
    h('td.num.muted', bytes(r.priSize)),
    h('td.muted', { style: { fontSize: '11.5px' } }, r.created ? dt(r.created).slice(0, 12) : '–'),
    h('td', h('div', { style: { display: 'flex', gap: '3px', justifyContent: 'flex-end' } },
      // Only the reversible action stays in the row; the rest need the menu.
      r.status === 'open'
        ? h('button.btn.sm', { title: 'Close this index — the data stays on disk', onclick: () => closeIndices(c, [r.index], refresh) }, 'Close')
        : h('button.btn.sm', { title: 'Open this index again', onclick: () => openIndices(c, [r.index], refresh) }, 'Open'),
      rowMenu([
        { label: 'Open in REST console', icon: ICON.console,
          onClick: () => navigateTo('console', { method: 'GET', path: `/${r.index}/_settings`, body: '' }) },
        { label: 'Settings…', icon: ICON.settings, title: 'Replicas, refresh interval, allocation',
          onClick: () => indexSettingsDialog(c, [r.index], refresh) },
        { label: 'Move a shard…', icon: ICON.move, disabled: r.status !== 'open',
          title: r.status === 'open' ? 'Relocate a shard to another node' : 'The index must be open to move a shard',
          onClick: () => moveShardDialog(c, r.index, refresh) },
        { sep: true },
        ...MAINTENANCE_KINDS.map(([k, label]) => ({
          label, icon: ICON.refresh, onClick: () => maintenance(c, [r.index], k, refresh),
        })),
        { sep: true },
        { label: 'Delete index…', icon: ICON.delete, danger: true,
          onClick: () => deleteIndices(c, [r.index], refresh) },
      ], { title: `Actions for ${r.index}` })))));

  const selectAll = h('input', {
    type: 'checkbox', checked: allShownTicked, style: { cursor: 'pointer' },
    title: 'Select every index shown',
    onchange: (e) => {
      shown.forEach((r) => { if (e.target.checked) selected.add(r.index); else selected.delete(r.index); });
      redrawTable();
    },
  });

  const t = h('div.tbl-wrap', h('table.tbl',
    h('thead', h('tr',
      h('th', { style: { width: '28px' } }, selectAll),
      th('H', 'health'), th('Index', 'index'), th('Source', 'source'), th('Day', 'day'), th('State', 'status'),
      th('P/R', 'pri', true), th('Docs', 'docs', true), th('Deleted', 'deleted', true),
      th('Size', 'size', true), th('Primary', 'priSize', true), th('Created', 'created'), h('th', ''))),
    h('tbody', ...(trs.length ? trs : [h('tr', h('td', { colspan: 13 }, empty('No indices match the filter')))]))));

  return h('div',
    // The toolbar search sits above the charts; with them folded away it is still a
    // scroll from the table, so the filter is repeated where the rows actually are.
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '0 0 8px', flexWrap: 'wrap' } },
      h('input#idx-search2', { type: 'search', value: ui.text, placeholder: 'filter the table, or search live + snapshots…',
        style: { flex: '1', minWidth: '220px' },
        oninput: (e) => { ui.text = e.target.value; ui.page = 0; syncSearchBoxes(e.target); redrawTable(); },
        onkeydown: (e) => { if (e.key === 'Enter' && ev.scope !== 'live' && ui.text.trim()) searchEverywhere(c); } }),
      // One result set, three ways of reading it. findIndexEverywhere always answers
      // "live, in a snapshot, or both"; the scope decides which part of that answer is
      // shown, rather than which question gets asked — asking a narrower question would
      // mean re-running it when the operator widens the scope.
      h('div.seg', { style: { flexShrink: '0' }, role: 'group', 'aria-label': 'Where to search' },
        ...SCOPES.map((sc) => h('button.btn.sm', {
          'aria-pressed': ev.scope === sc.id ? 'true' : 'false',
          title: sc.title,
          onclick: () => { if (ev.scope !== sc.id) { ev.scope = sc.id; draw(); } },
        }, sc.label))),
      ev.scope === 'live' ? null : h('button.btn.sm', {
        class: 'btn sm primary',
        disabled: ev.running || !ui.text.trim(),
        title: ui.text.trim() ? 'Look inside every snapshot repository' : 'Type an index name first',
        onclick: () => searchEverywhere(c),
      }, ev.running ? 'Searching…' : 'Search'),
      h('span.muted', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } },
        `${num(allRows.length)} of ${num((state.indices.get(c.id) || []).length)} indices`),
      ui.text || ui.sourceFilter !== 'all' || ui.status !== 'all' || ui.from || ui.to
        ? h('button.btn.sm.ghost', { onclick: () => {
            ui.text = ''; ui.sourceFilter = 'all'; ui.status = 'all'; ui.from = ''; ui.to = ''; ui.page = 0; draw();
          } }, 'Clear filters')
        : null),
    (ev.result || ev.error) ? h('div', { style: { padding: '0 0 9px' } }, everywherePanel(c)) : null,
    h('div#idx-bulk', { style: { padding: '0 0 9px' } }, bulkBar(c, allRows)),
    t);
}

/** The toolbar and the over-table search are the same filter; keep them in step. */
function syncSearchBoxes(source) {
  for (const el of [$('#idx-search'), $('#idx-search2')]) {
    if (el && el !== source && el.value !== ui.text) el.value = ui.text;
  }
}

function redrawBulk(c) {
  const el = $('#idx-bulk');
  if (el) mount(el, bulkBar(c, rowsFor(c)));
}

function tableCard(c, rows, all) {
  const slice = pageSlice(rows, ui.page, perPage(c));
  return card(`Indices on ${c.name}`, `${num(rows.length)} matching of ${num(all.length)} on the cluster`,
    h('div#idx-table', buildTable(c, slice.rows, rows), pagerBar(slice, goToPage)),
    [h('span#idx-meta.muted', { style: { fontSize: '11.5px' } },
       `${num(slice.first)}–${num(slice.last)} of ${num(rows.length)} matching`),
     h('button.btn.sm', { onclick: () => download(`indices-${c.id}-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(rows.map((r) => ({ index: r.index, source: r.source || '', day: r.day || '', health: r.health, status: r.status,
          pri: r.pri, rep: r.rep, docs: r.docs, deleted: r.deleted, size_bytes: r.size, primary_bytes: r.priSize,
          created: r.created ? new Date(r.created).toISOString() : '' }))), 'text/csv') }, 'Export CSV')]);
}

/* ------------------------- live + snapshot search ------------------------- */

async function searchEverywhere(c) {
  const term = ui.text.trim();
  if (!term) return;
  ev.running = true; ev.error = null; ev.term = term; ev.picked.clear(); draw();
  try { ev.result = await findIndexEverywhere(c, term); }
  catch (e) { ev.error = e.message || String(e); ev.result = null; }
  ev.running = false;
  draw();
}

/**
 * Where an index exists: live on the cluster, held in a snapshot, or both. Answers the
 * question "was it deleted, and can it come back" in one place.
 */
function everywherePanel(c) {
  if (ev.error) return h('div.banner.err', { style: { margin: 0 } }, h('div', h('div.ttl', 'Search failed'), h('div.mono', ev.error)));
  const r = ev.result;
  const liveOnly = r.live.filter((x) => !r.snapshotted.some((s) => s.index === x.index));
  const gone = r.snapshotted.filter((s) => !s.alsoLive);
  const both = r.snapshotted.filter((s) => s.alsoLive);

  const canRestore = (s) => !!restoreSourceOf(s);
  const listed = [...gone, ...both].slice(0, 200);
  const pickable = listed.filter(canRestore);
  for (const k of [...ev.picked]) if (!pickable.some((s) => s.index === k)) ev.picked.delete(k);
  const redraw = () => draw();
  const restore = (items) => restoreIndicesDialog(c, items, { onChanged: () => { ev.picked.clear(); return searchEverywhere(c); } });

  const snapRow = (s) => h('tr',
    h('td', { style: { width: '28px' } }, h('input', {
      type: 'checkbox', disabled: !canRestore(s), checked: ev.picked.has(s.index),
      title: canRestore(s) ? 'Select to restore' : 'No successful snapshot holds this index',
      'aria-label': `Select ${s.index}`,
      onchange: (e) => { if (e.target.checked) ev.picked.add(s.index); else ev.picked.delete(s.index); redraw(); },
    })),
    h('td.mono', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } }, s.index),
    h('td', s.alsoLive ? pill('live + snapshot', 'green') : pill('snapshot only', 'yellow')),
    h('td.num', String(s.snapshots.length)),
    h('td', s.successful ? pill(`${s.successful} successful`, 'green') : pill('none successful', 'red')),
    h('td.mono.muted', { style: { fontSize: '11px' } },
      s.snapshots[0] ? `${s.snapshots[0].repo} / ${s.snapshots[0].snapshot} (${s.snapshots[0].state})` : '–'),
    h('td', { style: { textAlign: 'right' } }, canRestore(s)
      ? h('button.btn.sm', { onclick: () => restore([s]), title: `Restore from ${restoreSourceOf(s).snapshot}` }, 'Restore')
      : null));

  const allPicked = pickable.length > 0 && pickable.every((s) => ev.picked.has(s.index));
  const selectAll = h('input', {
    type: 'checkbox', checked: allPicked, disabled: !pickable.length, 'aria-label': 'Select every restorable index',
    onchange: (e) => { ev.picked.clear(); if (e.target.checked) pickable.forEach((s) => ev.picked.add(s.index)); redraw(); },
  });
  const picked = listed.filter((s) => ev.picked.has(s.index));
  const restoreBar = pickable.length
    ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        h('span.muted', { style: { fontSize: '12px' } },
          picked.length ? `${picked.length} selected` : `Tick indices to restore them — ${pickable.length} can be restored`),
        picked.length ? h('button.btn.sm.primary', { onclick: () => restore(picked) }, `Restore ${picked.length} selected…`) : null,
        picked.length ? h('button.btn.sm.ghost', { onclick: () => { ev.picked.clear(); redraw(); } }, 'Clear selection') : null)
    : null;

  // Snapshot scope hides the live-only list: the operator asked what is in the
  // repositories, and answering with cluster indices as well is answering a question
  // they did not ask. The counts stay complete so the scope narrows what is shown,
  // never what was measured.
  const showLive = ev.scope !== 'snapshot';
  return card(
    `"${ev.term}" — ${ev.scope === 'snapshot' ? 'in snapshots' : ev.scope === 'live' ? 'live' : 'live and in snapshots'}`,
    `${r.live.length} live · ${r.snapshotted.length} in snapshots · ${gone.length} only in snapshots`,
    h('div', { style: { display: 'grid', gap: '8px' } },
      r.unverified.length
        ? h('div.banner.warn', { style: { margin: 0 } }, h('div', `Could not read: ${r.unverified.join('; ')}`))
        : null,
      liveOnly.length && showLive
        ? h('div', { style: { fontSize: '12px' } },
            h('b', `${liveOnly.length} live only`), h('span.muted', ' — on the cluster, in no snapshot: '),
            h('span.mono', liveOnly.slice(0, 8).map((x) => x.index).join(', ')), liveOnly.length > 8 ? ` …+${liveOnly.length - 8}` : '')
        : null,
      r.snapshotted.length
        ? h('div', { style: { display: 'grid', gap: '8px' } }, restoreBar,
            table([{ label: selectAll, width: '28px' }, 'Index', 'Where', { label: 'Snapshots', num: true }, 'Good copies', 'Newest', ''],
              listed.map(snapRow)))
        : empty(r.live.length ? 'Nothing matching is held in any snapshot.' : 'Nothing matching, live or in snapshots.')),
    [h('button.btn.sm.ghost', { onclick: () => { ev.result = null; draw(); } }, 'Clear')]);
}
