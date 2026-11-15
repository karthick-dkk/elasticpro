/** Page 1 — cluster overview: URL, name, disk, ILM/SLM, repositories and last snapshot. */

import { h, svg, mount, reconcile } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, num, pct, ago, dt, toCsv, download } from '../lib/fmt.js';
import { state, activeClusters, client, healthState, refreshAll, openAlertsNow, requestsFor, requestLoad, jvmSummary, clusterRev, askForPage } from '../core/state.js';
import { card, table, diskCell, lastSnapshotOf, snapshotCellFor, empty } from './common.js';
import { CLUSTER_TYPES, clusterKind, clusterKindRev } from '../core/cluster-kind.js';
import { heapOverHigh, HEAP_HIGH_PERCENT, HEAP_CLEAR_PERCENT, HEAP_RAISE_READINGS } from '../core/alert-rules.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { navigateTo, canOpenPage } from '../core/intent.js';
import { compareNames } from '../lib/cluster-order.js';
import { compareSortValues, ariaSort as ariaSortOf, sortArrow } from '../core/sort.js';
import { tableSort } from '../lib/table-sort.js';
import { readPrefs, writePrefs, resolveColumns, visibleColumns, setColumnShown, moveColumn, moveColumnBy, renameColumn, resetColumns, MAX_NAME } from '../core/cluster-view.js';
import { refreshAge, healthCounts } from '../core/cluster-detail.js';
import { rowMenu, popover, ICON } from '../ui/menu.js';
import { roleMayManageClusters } from '../core/writes.js';
import { editCluster, editZabbixCluster, rawClusterOf } from '../ui/config-editor.js';
import { credentialsKeptOnServer } from '../core/server-credentials.js';
import { takeFocus, revealFocus } from '../core/focus.js';
import { openClusterAlerts } from '../core/alert-goto.js';
import { diskAgainstWatermarks } from '../core/disk-balance.js';
// Why a cluster cannot be reached: one definition, shared with the Alerts page's unreachable lines.
import { unreachableReason } from '../core/alert-groups.js';
import { ilmErrorsOf, slmErrorsOf, ilmErrorTitle, slmErrorTitle, lifecycleView, logPatternOf, NOT_KNOWN } from '../core/lifecycle-errors.js';
// Clusters › Overview, the page's other section (#/clusters/overview): one cluster on one screen.
import * as board from './cluster-overview.js';
import { clustersSection, overviewHash, OVERVIEW, LIST } from '../core/cluster-overview.js';

let host = null;
/** The section on screen: the List (this file) or the Overview (pages/cluster-overview.js). */
let section = LIST;
/**
 * Whether the page is showing one cluster: the Overview section. The shell reads it (app.js
 * resolveSelection, renderTopbar, the hashchange listener) to pick a cluster as the evidence pages
 * do, to offer no "All clusters", and to draw the page again when the address moves between sections.
 */
export const singleCluster = () => clustersSection(location.hash) === OVERVIEW;

/**
 * Sort keys, each pulling one comparable value out of a {c, d, cl} row. `null` is "not
 * known" — never read, or not reported — and sorts after every known value whichever way
 * the column is sorted: unknown is not zero, and is not the smallest figure either.
 * Every summary column's id is one of these keys (core/cluster-view.js SUMMARY_COLUMNS).
 */
export const SORTS = {
  name:     { label: 'Cluster name',  get: (r) => r.c.name },
  size:     { label: 'Cluster size',  get: (r) => known(clusterSize(r)) },
  health:   { label: 'Health',        get: (r) => healthRank(r) },
  disk:     { label: 'Disk used %',   get: (r) => (r.d.disk && isFinite(r.d.disk.percent) ? r.d.disk.percent : null) },
  diskFree: { label: 'Disk free',     get: (r) => (r.d.disk && isFinite(r.d.disk.total) ? (r.d.disk.total || 0) - (r.d.disk.used || 0) : null) },
  nodes:    { label: 'Nodes',         get: (r) => (r.d.health && isFinite(r.d.health.number_of_nodes) ? r.d.health.number_of_nodes : null) },
  shards:   { label: 'Shards',        get: (r) => (r.d.health && isFinite(r.d.health.active_shards) ? r.d.health.active_shards : null) },
  unassign: { label: 'Unassigned',    get: (r) => (r.d.health && isFinite(r.d.health.unassigned_shards) ? r.d.health.unassigned_shards : null) },
  version:  { label: 'Version',       get: (r) => versionKey(r) },
  jdk:      { label: 'JDK',           get: (r) => { const j = jvmSummary(r.d.nodes).text; return j === 'unknown' ? null : j; } },
  snapshot: { label: 'Last snapshot', get: (r) => { const s = lastSnapshotOf(r.d); return s ? s.start : null; } },
  alerts:   { label: 'Open alerts',   get: (r) => (alertCounts || alertsByCluster()).get(r.c.id) || 0 },
  ilm:      { label: 'ILM',           get: (r) => lifecycleSortKey(lifecycleView('ILM', r.d, logPattern(r)), ilmErrorsOf(r.d, logPattern(r)).count) },
  slm:      { label: 'SLM',           get: (r) => lifecycleSortKey(lifecycleView('SLM', r.d, logPattern(r), r.c), slmErrorsOf(r.d, logPattern(r)).count) },
  repo:     { label: 'Repository',    get: (r) => (Array.isArray(r.d.repos) ? r.d.repos.map((x) => x.name).join(', ') : null) },
  reqs:     { label: 'Our reqs/5m',   get: (r) => ((requestLoad.clusters[r.c.id] || {}).last5m || 0) },
};
/** The cluster's own log index pattern (logstash-* unless it says otherwise). */
export const logPattern = (r) => logPatternOf(r.c, state.defaults);
/** The pill's word, then red (not looking after the logs) ahead of green, then errors ahead of clean. */
const lifecycleSortKey = (v, errs) => (v.word === NOT_KNOWN ? null : `${v.word}|${v.tone === 'red' ? 0 : v.tone === 'grey' ? 1 : 2}|${errs ? 0 : 1}`);
const known = (v) => (typeof v === 'number' && v >= 0 ? v : null);
/** The sort keys that still mean something for a cluster that is not answering. */
const DOWN_KEEPS = new Set(['name', 'health', 'alerts']);
/** Reachable was answered as "no". */
const isDown = (r) => healthState(r.d) === 'unreachable';

/**
 * Rows in `key` order (`dir` 1 ascending, -1 descending). Numbers compare as numbers and
 * text in the one cluster-name order (lib/cluster-order.js), so "es-node-10" and "8.13"
 * land where a person expects. Ties, and the unknowns at the end, go A–Z by name.
 */
export function sortRows(rows, key, dir = 1) {
  const own = (SORTS[key] || SORTS.name).get;
  // An unreachable cluster has no figures to sort on — whatever its last answer said is not a
  // measurement now — so they sort as unknown, after the rest, A–Z. Its name, its health
  // (the worst there is) and the alerts raised for it are still true.
  const get = (r) => (isDown(r) && !DOWN_KEEPS.has(key) ? null : own(r));
  const byName = (a, b) => compareNames(a.r.c.name, b.r.c.name);
  // Within one health state the fullest disk comes first: that is the row to look at.
  // Unreachable clusters have no disk figure now, so among themselves they go A–Z.
  const diskOf = (x) => (isDown(x.r) ? null : SORTS.disk.get(x.r));
  const byDisk = (a, b) => {
    const ad = diskOf(a), bd = diskOf(b);
    if (ad === null && bd === null) return 0;
    if (ad === null) return 1;
    if (bd === null) return -1;
    return bd - ad;
  };
  const tie = key === 'health' ? (a, b) => byDisk(a, b) || byName(a, b) : byName;
  // core/sort.js: unknown last whichever way it runs, numbers as numbers, text natural.
  const unknown = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
  return rows.map((r) => ({ r, v: get(r) })).sort((a, b) => {
    if (unknown(a.v) && unknown(b.v)) return byName(a, b);
    return compareSortValues(unknown(a.v) ? null : a.v, unknown(b.v) ? null : b.v, dir) || tie(a, b);
  }).map((x) => x.r);
}

/**
 * How much data the cluster actually holds — the store size of its indices, which is
 * what "size" means to an operator. Disk usage is a different question (it counts
 * everything on the filesystem) and has its own sort.
 */
function clusterSize(r) {
  const d = r.d;
  if (d.disk && d.disk.indicesBytes) return d.disk.indicesBytes;
  // Before allocation data arrives, fall back to the index list if that page has run.
  const idx = state.indices.get(r.c.id);
  if (idx && idx.length) return idx.reduce((s, x) => s + (x.size || 0), 0);
  return -1;
}

// The search, sort and health filter live behind the 🔍 beside the title; `search` is whether
// that box is open. A filter that is set keeps it open: a filtered list must say so.
/**
 * The order the page opens in: worst health first (unreachable, red, yellow, then green),
 * the fullest disk first within a state (sortRows's tie-break) — the clusters to look at
 * are at the top. Until the operator says otherwise.
 */
export const DEFAULT_SORT = { key: 'health', dir: -1 };
// `type`: CI / DI / On-Prem, or 'all' (core/cluster-kind.js).
const ui = { text: '', sort: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir, only: 'all', type: 'all', search: false };
/**
 * Whether the list is narrowed: search text, a health or a type filter. The order is not a
 * filter — it is remembered per browser, and a list in another order still shows every
 * cluster — so a sort alone neither keeps the search box open nor shows Clear.
 */
export const isFiltered = (u) => !!(u.text || u.only !== 'all' || u.type !== 'all');
const filtered = () => isFiltered(ui);
/** The filters only: what closing the 🔍 box drops. */
const clearFilters = () => { ui.text = ''; ui.only = 'all'; ui.type = 'all'; };
/** Clear, pressed: the filters and the order back to the page's own. */
const resetFilter = () => { clearFilters(); ui.sort = DEFAULT_SORT.key; ui.dir = DEFAULT_SORT.dir; };

/**
 * The summary's order, remembered per browser (lib/table-sort.js). `ui.sort`/`ui.dir` are the
 * working copy every control (headers, the Sort select, its direction button, Clear) changes;
 * the first draw reads the remembered one, and every draw after writes it back if it changed.
 */
const CL_SORT = tableSort('overview.clusters', { initial: DEFAULT_SORT });
let orderRead = false;
function rememberOrder() {
  const s = CL_SORT.sort;
  if (!orderRead) {
    orderRead = true;
    if (s && SORTS[s.key]) { ui.sort = s.key; ui.dir = s.dir; }
    return;
  }
  if (!s || s.key !== ui.sort || s.dir !== ui.dir) CL_SORT.set({ key: ui.sort, dir: ui.dir });
}

/** offline worst, then red > yellow > green — so "sort by health" surfaces trouble. */
function healthRank(r) {
  if (!r.d.updatedAt) return 1;
  if (!r.d.reachable) return 4;
  return { red: 3, yellow: 2, green: 0 }[(r.d.health && r.d.health.status)] ?? 1;
}

/** "8.13.4" -> 8.000013.000004, so 8.9 sorts below 8.13. Not known: null. */
function versionKey(r) {
  const v = versionOf(r.d);
  if (!v) return null;
  const p = v.split('.').map((x) => parseInt(x, 10) || 0);
  return (p[0] || 0) * 1e12 + (p[1] || 0) * 1e6 + (p[2] || 0);
}
const versionOf = (d) => (d.info && d.info.version && d.info.version.number) || '';

/** Per-cluster alert counts for the draw in progress — one walk, not one per comparison. */
let alertCounts = null;
function alertsByCluster() {
  const m = new Map();
  openAlertsNow().forEach((a) => { if (a.cluster) m.set(a.cluster.id, (m.get(a.cluster.id) || 0) + 1); });
  return m;
}

/** What a row's Health says: loading, the health colour, or why it cannot be reached. */
function stateLabel(r) {
  const { d, cl } = r;
  if (!d.updatedAt) return 'loading';
  if (d.reachable) return (d.health && d.health.status) || 'unknown';
  return unreachableReason(cl).label.toLowerCase();
}

/**
 * The datasets this page is drawn from: health and nodes for the tiles and disk, ILM errors
 * for the alert headline, policies for ILM/SLM and repositories, the ILM assignment for
 * whether ILM looks after the log indices (the ILM pill's colour), snapshots for the last
 * backup. What "read" means in the coverage line, and what Read all asks for.
 */
const DATASETS = ['health', 'nodes', 'ilm_errors', 'policies', 'ilm_assign', 'snapshots'];
// The "Showing cached data … Read all" line this page used to open with is gone (board of
// 2026-10-25): the page asks for what is missing when it opens (askOnOpen), Refresh reads
// every cluster on screen again, and the Alerts page keeps the coverage bar and Read all.

/**
 * Under a policy that fetches nothing on its own, opening the page is the ask: one message
 * per dataset for every cluster on screen that has none or an old one. Throttled, because
 * every push redraws the page and lands here too; demandDataset does not ask twice in 30 s.
 */
let askedOpenAt = 0;
function askOnOpen() {
  if (Date.now() - askedOpenAt < 1000) return;
  askedOpenAt = Date.now();
  askForPage(activeClusters().map((c) => c.id), DATASETS).catch(() => {});
}

export function render(el) {
  section = clustersSection(location.hash);
  if (section === OVERVIEW) { listLeave(); board.render(el); return; }
  board.onLeave();
  host = el; el.classList.add('dense'); trackHeadHeight();
  // "Go to" from an unreachable alert (core/alert-goto.js): that cluster's row, in view.
  const f = takeFocus('overview');
  focusDown = f && f.section === 'unreachable' ? { cluster: f.cluster || null, prepared: false } : null;
  askOnOpen();
  draw();
  // The Refresh badge counts minutes; nothing else on the page moves on its own.
  if (!ageTimer) ageTimer = setInterval(() => { if (host && host.isConnected) paintAges(); else onLeave(); }, 30000);
}
export function onData() {
  if (section === OVERVIEW) { board.onData(); return; }
  if (host && host.isConnected) { askOnOpen(); draw(); }
}
/** The page's own timers stop with it: the badge tick — and the Overview's poll. */
export function onLeave() {
  board.onLeave();
  listLeave();
}
function listLeave() {
  if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
}
let ageTimer = null;

/* ------------------------------ per-user layout ------------------------------ */

/**
 * The signed-in person's layout (core/cluster-view.js): columns, their order and names.
 * Read again when somebody else signs in on this tab.
 */
let prefs = null;
let prefsUser = null;
const who = () => (state.caller && state.caller.name) || 'local';
function store() { try { return window.localStorage; } catch (_) { return null; } }
function currentPrefs() {
  if (!prefs || prefsUser !== who()) { prefsUser = who(); prefs = readPrefs(store(), prefsUser); }
  return prefs;
}
/** Whether the last save stuck — a private window may refuse; the Columns panel says so. */
let prefsSaved = true;
function savePrefs(next) {
  prefs = next;
  prefsSaved = writePrefs(store(), who(), next);
}

/* ---------------------------------- the page ---------------------------------- */

/** Search and sort are applied to the table and charts alike, so they stay in step. */
function visibleRows(all) {
  let rows = all;

  const t = ui.text.trim().toLowerCase();
  if (t) {
    rows = rows.filter(({ c, d }) => {
      const version = versionOf(d);
      const repos = (d.repos || []).map((r) => r.name).join(' ');
      const hay = `${c.name} ${c.url} ${(c.tags || []).join(' ')} ${c.via || ''} ${version} ${repos} ${clusterKind(c).label}`;
      return hay.toLowerCase().includes(t);
    });
  }

  // One health state, as the Health column classifies it (core/state.js healthState).
  if (ui.only !== 'all') rows = rows.filter((r) => healthState(r.d) === ui.only);
  // One cluster type, as the badge beside the name says it.
  if (ui.type !== 'all') rows = rows.filter((r) => clusterKind(r.c).type === ui.type);

  rememberOrder();
  return sortRows(rows, ui.sort, ui.dir);
}

/**
 * Search, sort and the health filter, behind a 🔍 beside the card's title: the list is read
 * far more often than it is searched, so the controls take no room until they are wanted.
 * Opening the box puts the caret in the search field. A filter that is set keeps the box
 * open and the button lit, so a shortened list never looks like the whole fleet.
 */
let focusSearch = false;
function searchBox(all, shown) {
  const open = ui.search || filtered();
  const counts = healthCounts(all, (r) => healthState(r.d));
  const btn = h(`button#clusters-search-btn.btn.sm.ghost.cl-search-btn${open ? '.on' : ''}`, {
    type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'clusters-search-box',
    'aria-label': 'Search, sort and filter clusters', title: 'Search / sort / filter',
    onclick: () => {
      if (open && filtered()) { clearFilters(); ui.search = false; }
      else { ui.search = !ui.search; focusSearch = ui.search; }
      draw();
    },
  }, svg('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    svg('circle', { cx: 7, cy: 7, r: 4.5 }), svg('path', { d: 'M10.5 10.5 14 14' })));
  if (!open) return h('span.cl-searchbox', btn);

  const sortSel = h('select#clusters-sort', { 'aria-label': 'Sort by', onchange: (e) => { ui.sort = e.target.value; draw(); } },
    ...Object.entries(SORTS).map(([k, v]) => h('option', { value: k }, v.label)));
  sortSel.value = ui.sort;
  const n = (k) => counts[k] || 0;
  const onlySel = h('select#clusters-only', { 'aria-label': 'Health', onchange: (e) => { ui.only = e.target.value; draw(); } },
    h('option', { value: 'all' }, `All health (${all.length})`),
    h('option', { value: 'green' }, `Green (${n('green')})`),
    h('option', { value: 'yellow' }, `Yellow (${n('yellow')})`),
    h('option', { value: 'red' }, `Red (${n('red')})`),
    n('unreachable') ? h('option', { value: 'unreachable' }, `Unreachable (${n('unreachable')})`) : null);
  onlySel.value = ui.only;
  const byType = new Map();
  for (const r of all) { const t = clusterKind(r.c).type; byType.set(t, (byType.get(t) || 0) + 1); }
  const typeSel = h('select#clusters-type', { 'aria-label': 'Cluster type', onchange: (e) => { ui.type = e.target.value; draw(); } },
    h('option', { value: 'all' }, `All types (${all.length})`),
    ...CLUSTER_TYPES.map((t) => h('option', { value: t.id }, `${t.label} (${byType.get(t.id) || 0})`)));
  typeSel.value = ui.type;
  return h('span.cl-searchbox', btn,
    h('span#clusters-search-box.cl-search', { role: 'group', 'aria-label': 'Search, sort and filter' },
      h('input#clusters-search', { type: 'search', value: ui.text, 'aria-label': 'Search clusters',
        placeholder: 'name, URL, tag, jump host, version, repository',
        oninput: (e) => { ui.text = e.target.value; draw(); } }),
      sortSel,
      h('button.btn.sm', { type: 'button', style: { minWidth: '72px' },
        title: ui.sort === 'health' ? (ui.dir === -1 ? 'Worst first \u2014 click for best first' : 'Best first \u2014 click for worst first')
          : ui.dir === 1 ? 'Ascending \u2014 click for descending' : 'Descending \u2014 click for ascending',
        onclick: () => { ui.dir = -ui.dir; draw(); } }, ui.sort === 'health' ? (ui.dir === -1 ? '\u25bc worst first' : '\u25b2 best first') : ui.dir === 1 ? '\u25b2 asc' : '\u25bc desc'),
      onlySel,
      typeSel,
      h('span.muted.cl-shown', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } }, shownText(all, shown)),
      h('button.btn.sm.ghost.cl-clear', { type: 'button', title: 'Clear the search, sort and filter', hidden: !filtered(),
        onclick: () => { resetFilter(); draw(); } }, 'Clear')));
}

const shownText = (all, shown) => (shown.length === all.length ? `${all.length} cluster${all.length === 1 ? '' : 's'}` : `${shown.length} of ${all.length} shown`);

/**
 * What typing changes in the box — the count shown and whether Clear is offered — changed in
 * place. The box itself is rebuilt only with the controls' own choices: rebuilt on the first
 * character typed (the box was keyed on the text and the count), it took the field being typed
 * into with it, and the rest of the search went to the page.
 */
function paintSearchBox(box, all, shown) {
  const t = box.querySelector('.cl-shown');
  const text = shownText(all, shown);
  if (t && t.textContent !== text) t.textContent = text;
  const clear = box.querySelector('.cl-clear');
  if (clear && clear.hidden !== !filtered()) clear.hidden = !filtered();
}

/**
 * What this page built last time, kept by signature (lib/keyed.js). The page redraws on
 * every push from the core; a row, chart or card whose cluster did not change is the same
 * element as before, and mount() leaves it where it is.
 */
const built = nodeCache();
/** Anything showing "5 min ago" is rebuilt at least once a minute. */
const minute = () => Math.floor(Date.now() / 60000);
/** The rows on screen, in table order: what Export CSV writes. */
let lastRows = [];

/** Everything a cluster's row is drawn from. */
function rowSig(r) {
  const q = requestsFor(r.c.id);
  return [clusterRev(r.c.id), objId(r.d), objId(r.cl), r.cl && r.cl.state, objId(r.c),
    (alertCounts && alertCounts.get(r.c.id)) || 0, q.last5m, q.perMinute.toFixed(1), minute(), objId(state.defaults),
    objId(state.indices.get(r.c.id)), clusterKindRev()].join('|');
}

/** Reachable was answered as "no": the one definition: the rows marked red, the pointer line above the table. */
export function unreachableRows(rows) {
  return rows.filter((r) => healthState(r.d) === 'unreachable');
}

/* ------------------------------ focus from an alert ------------------------------ */

/**
 * The cluster an unreachable alert's "Go to" asked for, until it has been shown. Kept across
 * draws: the page may open before the cluster's state has arrived.
 */
let focusDown = null;
const cssId = (id) => String(id).replace(/["\\]/g, '\\$&');

/**
 * Make the asked-for cluster visible before drawing: a search or "Show" filter that would
 * hide its row is cleared. Done once; if the cluster is not loaded yet, the next draw tries.
 */
function prepareFocus(all) {
  if (!focusDown || focusDown.prepared) return;
  const id = focusDown.cluster;
  const row = id ? all.find((r) => r.c.id === id) : null;
  if (id && !row) return;   // not loaded yet: try again on the next draw
  focusDown.prepared = true;
  if (!visibleRows(all).some((r) => !id || r.c.id === id)) { ui.text = ''; ui.only = 'all'; }
}

/** After the draw: scroll to its row (or the pointer line) and flash it, then forget the hint. */
function revealFocused() {
  if (!focusDown || !focusDown.prepared) return;
  const id = focusDown.cluster;
  const sel = id ? `tr[data-cluster="${cssId(id)}"]` : '.cl-down-note';
  if (revealFocus(host, sel)) focusDown = null;
}

function draw() {
  alertCounts = alertsByCluster();
  currentPrefs();
  const list = activeClusters();
  const all = list.map((c) => ({ c, d: state.data.get(c.id) || {}, cl: client(c.id) }));
  prepareFocus(all);
  const rows = visibleRows(all);
  lastRows = rows;
  for (const r of all) r.sig = rowSig(r);
  built.begin();

  mount(host,
    // List · Overview, under the page's title: the same row the Overview draws (one definition of where the other is).
    built.get('cl-tabs', LIST, () => board.clustersTabs(LIST)),
    downNote(unreachableRows(rows).length),
    summaryCard(rows, all),
  );
  built.end();
  scheduleHeadSync();
  revealFocused();
  if (focusSearch) {
    focusSearch = false;
    const i = document.getElementById('clusters-search');
    if (i) i.focus({ preventScroll: true });
  }
}

/**
 * One line above the table when any cluster in it is unreachable. They are rows like any
 * other, in their A–Z place; what is wrong with each, Retry and Diagnose are on the Alerts
 * page, and this says so and links there.
 */
function downNote(n) {
  if (!n) return null;
  const link = canOpenPage('alerts')
    ? h('a.cl-alink', { href: '#/alerts', onclick: (e) => { e.preventDefault(); navigateTo('alerts'); } }, 'Alerts \u2192')
    : 'Alerts';
  return h('div.cl-down-note', { role: 'note' },
    h('i.cl-dot', { 'aria-hidden': 'true' }),
    h('span', h('b', `${n} unreachable`), `: listed in the table${ui.sort === 'name' && ui.dir === 1 ? ' in A\u2013Z order' : ''}. Reasons, Retry and Diagnose are at the top of `, link));
}

/* ------------------------------- editing a cluster ------------------------------- */

/**
 * Who may add or change a cluster here: an operator or an admin, the rule the core
 * enforces (writes.js, CLUSTER_SAVE). Removing one and its credential stay on the Config
 * page, an admin's.
 */
const mayEdit = () => roleMayManageClusters() && !isSnapshotMode();
/** …and this one: it must be in the config file, not a Zabbix host (edited there). */
const mayEditCluster = (c) => mayEdit() && c.source !== 'zabbix' && !!rawClusterOf(c);

async function openEditor(c) {
  const raw = rawClusterOf(c);
  if (raw && await editCluster(raw)) draw();
}

/* -------------------------------- the name menu -------------------------------- */

/**
 * A cluster's name opens what you can do with it: edit it, or go to its nodes, its
 * repositories or its live log with it already selected (ep:navigate with the cluster, so
 * a single-cluster page opens on THIS one, not on whichever is first).
 */
function nameMenu(c) {
  const items = () => {
    const edit = !mayEdit() ? null
      // A Zabbix cluster (hosted): everything but its address is set here and kept in ElasticPro.
      : c.source === 'zabbix' && credentialsKeptOnServer()
        ? { label: 'Edit', icon: ICON.edit, note: 'cluster settings', title: `From Zabbix — host ${(c.zabbix && c.zabbix.host) || ''}; the address stays Zabbix's`,
            onClick: async () => { if (await editZabbixCluster(c)) draw(); } }
      : c.source === 'zabbix' ? { label: 'Edit', icon: ICON.edit, note: 'in Zabbix', disabled: true,
          title: `Managed in Zabbix — host ${(c.zabbix && c.zabbix.host) || ''}` }
      : !rawClusterOf(c) ? { label: 'Edit', icon: ICON.edit, note: 'cluster settings', disabled: true, title: 'Not in the config file' }
      : { label: 'Edit', icon: ICON.edit, note: 'cluster settings', onClick: () => openEditor(c) };
    return [
      { hint: c.name },
      edit,
      canOpenPage('shards') ? { label: 'Nodes', icon: '☷', note: 'Nodes & shards', onClick: () => navigateTo('shards', null, { cluster: c.id }) } : null,
      canOpenPage('snapshots') ? { label: 'Repo', icon: '↻', note: 'Snapshots', onClick: () => navigateTo('snapshots', { view: 'summary' }, { cluster: c.id }) } : null,
      canOpenPage('log-delay') ? { label: 'Live logs', icon: '▶', note: 'Log Delay › Live logs', onClick: () => navigateTo('log-delay', { view: 'live', cluster: c.id }, { cluster: c.id }) } : null,
    ];
  };
  return rowMenu(items, {
    trigger: 'button.cl-name',
    label: [h('span.cl-name-t', c.name), h('span.cl-caret', { 'aria-hidden': 'true' }, '▾')],
    title: `${c.url}${c.tags && c.tags.length ? '\n' + c.tags.join(', ') : ''}`,
    menuLabel: `Actions for ${c.name}`,
  });
}

/** Clusters › Overview, on this cluster: the address names it, and the page and its chooser follow. */
function openOverview(id) { location.hash = overviewHash(id); }

/**
 * The way into a cluster's detail: "Overview →" beside its name, shown only while the pointer is
 * on the name cell or the keyboard is inside it (app.css .cl-ov), so a hundred rows do not carry a
 * hundred buttons. It keeps its place when hidden: nothing moves as the pointer passes.
 */
function overviewButton(c) {
  return h('button.btn.sm.ghost.cl-ov', { type: 'button', title: `Open the Overview of ${c.name}`,
    'aria-label': `Overview of ${c.name}`, onclick: () => openOverview(c.id) }, 'Overview \u2192');
}

/**
 * CI / DI / On-Prem beside the name (core/cluster-kind.js — the one definition the alert
 * rules read too): what the cluster is, and so whether "no snapshot" means anything.
 */
function typeBadge(c) {
  const k = clusterKind(c);
  const how = k.slmExpected ? 'SLM snapshots expected' : 'no SLM snapshots expected';
  const ulm = k.ulm.enabled ? `ULM archives its logs to S3${k.ulm.bucket ? ` (${k.ulm.bucket})` : ''}` : 'no ULM archive';
  return h(`span.cl-type.cl-type-${k.type}`, { title: `${k.label} cluster · ${ulm} · ${how}${k.set.type ? '' : ' (type not set: On-Prem defaults)'}` }, k.label);
}

/* ------------------------------- the summary table ------------------------------- */

/**
 * Normal is quiet, a problem is loud. A state that is as it should be is plain text; one
 * that is not is coloured text with a dot in front, so it is never told by hue alone.
 * `kind`: 'warn' (amber) or 'bad' (red). Health is the one state that keeps its dot all the
 * time (healthFlag); everything else gets it only when something is wrong.
 */
function flag(text, kind, title) {
  return h(`span.q.${kind}`, title ? { title } : null, h('i.qdot', { 'aria-hidden': 'true' }), text);
}

/**
 * A row's Health: a pill in the state's own colour (green, yellow, red; grey while loading),
 * the state as its word. The reason — unassigned shards, why it cannot be reached — is on
 * hover and read out, not in the cell: the list reads at a glance, the detail when asked.
 */
const HEALTH_PILL = { green: 'green', yellow: 'yellow', red: 'red', unreachable: 'red', loading: 'grey' };
function healthFlag(r) {
  const { d } = r;
  const st = healthState(d);
  let title = '';
  if (st === 'unreachable') {
    const why = unreachableReason(r.cl).label;
    const err = (r.cl && r.cl.lastError && r.cl.lastError.message) || '';
    title = `${err ? `${why}: ${err}` : why} \u2014 see Alerts`;
  } else if (st === 'yellow' || st === 'red') {
    const un = d.health ? d.health.unassigned_shards : null;
    title = isFinite(un) && un > 0 ? `${un} unassigned shard${un === 1 ? '' : 's'}` : '';
  }
  const word = st === 'loading' ? 'loading' : st === 'unreachable' ? 'Unreachable' : st[0].toUpperCase() + st.slice(1);
  return h(`span.pill.${HEALTH_PILL[st]}.cl-health`, { title: title || null, 'aria-label': title ? `${word}: ${title}` : null },
    h('i.dot'), word);
}

/**
 * One function per column id, drawing that column's cell. The header, the CSV and the
 * Columns panel all come from the same column list, so a column cannot be on screen and
 * missing from the file, or the other way round.
 */
const CELLS = {
  name: (r) => h('td.cl-name-td', nameMenu(r.c), typeBadge(r.c), overviewButton(r.c)),
  version: (r) => h('td.mono', versionOf(r.d) || '–'),
  // The JVM the nodes run on. A cluster mid-upgrade has more than one, and saying "mixed"
  // with the breakdown on hover beats picking whichever node answered first.
  jdk: (r) => {
    const j = jvmSummary(r.d.nodes);
    return h('td.mono', { title: j.detail, style: { fontSize: '11.5px' } },
      j.text === 'unknown' ? h('span.muted', 'unknown') : j.mixed ? flag(j.text, 'warn') : j.text);
  },
  health: (r) => {
    const { d } = r;
    const via = d.fromZabbix && d.fromZabbix.parts.includes('health')
      // Where the figure came from, when it is Zabbix's measurement rather than this tab's.
      ? h('div.muted', { style: { fontSize: '10.5px' }, title: 'Measured by Zabbix, not by this app \u2014 so Elasticsearch is not asked again' },
          `via Zabbix \u00b7 ${d.fromZabbix.healthAge === null ? 'age unknown' : `${Math.round(d.fromZabbix.healthAge)}s ago`}`)
      : null;
    return h('td', healthFlag(r), via);
  },
  // Centred, and every cell below clips to its column (.cl-clip): nothing overlaps its neighbour.
  nodes: (r) => h('td.num', h('span.cl-clip', r.d.health ? `${r.d.health.number_of_nodes} (${r.d.health.number_of_data_nodes} data)` : '–')),
  // The disk used % large, coloured against the cluster's OWN watermarks like the bar beside it (diskAgainstWatermarks; none while its settings are unread), the index size small after it.
  size: (r) => {
    const sz = clusterSize(r), p = r.d.disk && r.d.disk.percent;
    const lvl = diskAgainstWatermarks(r.d.disk, r.d.clusterSettings).level;
    const pct = !(isFinite(p) && p !== null) ? null : h(`span.cl-size-pct${lvl === 'high' ? '.bad' : lvl === 'low' ? '.warn' : ''}`, `${Math.round(p)} %`);
    const idx = sz >= 0 ? h('span.cl-size-idx', bytes(sz)) : null;
    return h('td.num', { title: `${pct ? `Disk used ${Math.round(p)} %, ` : ''}${sz >= 0 ? `index size ${bytes(sz)} (store size of the indices on this cluster)` : 'index size not known'}` },
      h('span.cl-clip', pct || idx ? [pct, idx] : h('span.muted', '–')));
  },
  disk: (r) => h('td.cl-disk-td', isDown(r)
    // Not answering: what the disk held at the last answer is not what it holds now. No bar,
    // no tick, no threshold colour — and it says why.
    ? h('span.muted', { title: 'The cluster is not answering, so its disk use is not known now.' }, 'unknown while unreachable')
    : h('span.cl-clip', diskCell(r.d.disk, r.d.clusterSettings, { dataNodes: true, compact: true }))),
  // A button, as in 0.3.2: Running in green only when it looks after the log indices, red
  // otherwise (0.3.44), a red dot beside it when a log index is in an ILM error step
  // (lifecycle-errors.js — the one definition). Click opens the cluster's Overview.
  ilm: (r) => {
    const { d } = r;
    return h('td', d.ilm
      ? lifecycleButton(r, 'ILM', lifecycleView('ILM', d, logPattern(r)), ilmErrorsOf(d, logPattern(r)), ilmErrorTitle)
      : h('span.muted', '\u2013'));
  },
  slm: (r) => {
    const { d } = r;
    if (!d.slmStatus) return h('td', h('span.muted', d.slmSupported === false ? 'n/a' : '\u2013'));
    return h('td', lifecycleButton(r, 'SLM', lifecycleView('SLM', d, logPattern(r), r.c), slmErrorsOf(d, logPattern(r)), slmErrorTitle));
  },
  repo: (r) => {
    const names = (r.d.repos || []).map((x) => x.name);
    return h('td', names.length
      ? h('div', { style: { display: 'grid', gap: '2px' } }, ...names.slice(0, 3).map((n) => h('span.mono', { style: { fontSize: '11.5px' } }, n)),
          names.length > 3 ? h('span.muted', { style: { fontSize: '11px' } }, `+${names.length - 3} more`) : null)
      : h('span.muted', Array.isArray(r.d.repos) ? 'none' : '–'));
  },
  snapshot: (r) => h('td', snapshotCellFor(r.c, r.d, state.defaults.snapshotStaleHours)),
  // A link to that cluster's alerts, not a button that opens all of them; nothing to open, no link.
  alerts: (r, byCluster) => {
    const n = byCluster.get(r.c.id) || 0;
    if (!n) return h('td.num', h('span.muted', { 'aria-label': 'no open alerts' }, '\u2014'));
    const label = `${n} open alert${n === 1 ? '' : 's'} for ${r.c.name}`;
    return h('td.num', canOpenPage('alerts')
      ? h('a.cl-alink', { href: '#/alerts', title: `Open the Alerts page, showing ${r.c.name} only`, 'aria-label': label,
          onclick: (e) => { e.preventDefault(); openClusterAlerts(r.c.id); } }, `${n} \u2192`)
      : h('span', { title: label }, String(n)));
  },
  // Requests THIS app sent to the cluster — its share of the cluster's load.
  reqs: (r) => {
    const q = requestsFor(r.c.id);
    return h('td.num', { title: `${q.perMinute.toFixed(1)} per minute · ${q.perSecond.toFixed(2)} per second, over the last ${Math.round(requestLoad.windowSec / 60)} minutes` },
      h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, String(q.last5m)),
      h('span.muted', { style: { fontSize: '10.5px' } }, ` · ${q.perMinute.toFixed(1)}/min`));
  },
};

/**
 * The ILM/SLM button: the pill lifecycleView decides (Running green / red, Stopped red,
 * Running ? grey), why in its tooltip; a red dot (never a count) when `errs` has any.
 */
export function lifecycleButton(r, label, view, errs, titleOf) {
  const title = [view.why, errs.count ? titleOf(errs) : '', 'Click for the cluster\u2019s Overview.'].filter(Boolean).join('\n\n');
  return h('span.cl-lc', h(`button.pill.cl-pillbtn.${view.tone}`, {
    type: 'button', title, 'aria-label': `${label} ${view.word}${view.covered === false ? ', not looking after the log indices' : ''}${errs.count ? ', has errors' : ''} \u2014 open the Overview of ${r.c.name}`,
    onclick: () => openOverview(r.c.id),
  }, view.word), errs.count ? h('i.cl-errdot', { title: titleOf(errs), role: 'img', 'aria-label': 'errors' }) : null);
}

/** The CSV's yes / no / empty (unknown) for "looks after the log indices". */
const coveredCsv = (v) => (v.covered === true ? 'yes' : v.covered === false ? 'no' : '');

/**
 * The CSV's fields per column: [suffix, value]. The header is the column's name as this
 * person sees it, with the suffix in brackets for a column that exports more than one
 * figure. Raw values — bytes, ISO dates, plain counts — and empty for "not known".
 */
const CSV = {
  name: [['', (r) => r.c.name], ['URL', (r) => r.c.url]],
  version: [['', (r) => versionOf(r.d)]],
  jdk: [['', (r) => jvmSummary(r.d.nodes).text], ['detail', (r) => jvmSummary(r.d.nodes).detail]],
  health: [['', (r) => stateLabel(r)]],
  nodes: [['', (r) => (r.d.health ? r.d.health.number_of_nodes : '')], ['data', (r) => (r.d.health ? r.d.health.number_of_data_nodes : '')]],
  size: [['bytes', (r) => (clusterSize(r) >= 0 ? clusterSize(r) : '')]],
  disk: [['%', (r) => (r.d.disk && isFinite(r.d.disk.percent) ? r.d.disk.percent.toFixed(2) : '')],
    ['used bytes', (r) => (r.d.disk && isFinite(r.d.disk.used) ? r.d.disk.used : '')],
    ['total bytes', (r) => (r.d.disk && isFinite(r.d.disk.total) ? r.d.disk.total : '')],
    // Where it stands against the cluster's own watermarks: the same answer as the bar.
    ['watermark', (r) => diskAgainstWatermarks(r.d.disk, r.d.clusterSettings).label],
    ['high watermark %', (r) => { const w = diskAgainstWatermarks(r.d.disk, r.d.clusterSettings); return w.known ? w.high : ''; }]],
  ilm: [['', (r) => (r.d.ilm && r.d.ilm.operation_mode) || ''],
    ['covers log indices', (r) => coveredCsv(lifecycleView('ILM', r.d, logPattern(r)))],
    ['log indices in error', (r) => { const e = ilmErrorsOf(r.d, logPattern(r)); return e.known ? e.count : ''; }]],
  slm: [['', (r) => (r.d.slmStatus && r.d.slmStatus.operation_mode) || (r.d.slmSupported === false ? 'n/a' : '')],
    ['covers log indices', (r) => (r.d.slmStatus ? coveredCsv(lifecycleView('SLM', r.d, logPattern(r), r.c)) : '')],
    ['policies failing', (r) => { const e = slmErrorsOf(r.d, logPattern(r)); return e.known ? e.count : ''; }]],
  repo: [['', (r) => (r.d.repos || []).map((x) => x.name).join('|')], ['locations', (r) => (r.d.repos || []).map((x) => x.location).join('|')]],
  snapshot: [['', (r) => { const s = lastSnapshotOf(r.d); return s ? s.id : ''; }],
    ['status', (r) => { const s = lastSnapshotOf(r.d); return s ? s.status : ''; }],
    ['at', (r) => { const s = lastSnapshotOf(r.d); return s ? new Date(s.start).toISOString() : ''; }]],
  alerts: [['', (r) => (alertCounts || alertsByCluster()).get(r.c.id) || 0]],
  reqs: [['', (r) => requestsFor(r.c.id).last5m]],
};

/**
 * The CSV for `rows` under `cols` (visible columns, in order, with their names): the
 * headers, and one object per row keyed by them. Two columns renamed alike stay two.
 */
export function csvTable(rows, cols) {
  const headers = [], getters = [];
  for (const col of cols) {
    for (const [suffix, get] of CSV[col.id] || []) {
      const base = suffix ? `${col.name} (${suffix})` : col.name;
      let name = base;
      for (let n = 2; headers.includes(name); n++) name = `${base} ${n}`;
      headers.push(name); getters.push(get);
    }
  }
  return { headers, data: rows.map((r) => Object.fromEntries(headers.map((k, i) => [k, getters[i](r)]))) };
}

function exportSummary() {
  const { headers, data } = csvTable(lastRows, visibleColumns(prefs));
  download(`es-cluster-summary-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(data, headers), 'text/csv');
}

function summaryCard(rows, all) {
  const cols = visibleColumns(prefs);
  const colSig = cols.map((c) => `${c.id}:${c.name}`).join(',');
  const onSort = (key) => { ui.dir = ui.sort === key ? -ui.dir : 1; ui.sort = key; draw(); };
  const byCluster = alertCounts || alertsByCluster();
  const trs = [];
  rows.forEach((r) => {
    trs.push(built.get(`row:${r.c.id}`, `${r.sig || rowSig(r)}|${colSig}|${mayEdit()}`, () => rowNodes(r, byCluster, cols)));
  });

  const total = all.length;
  // Unknown is not reachable: a cluster whose health was never read (Client basis, before
  // the page's ask is answered) is counted apart rather than passed off as fine.
  const unread = rows.filter((r) => !isDown(r) && (!r.d || r.d.healthUnknown || !r.d.updatedAt)).length;
  const end = rows.length === 0 ? '' : `End of the list \u00b7 ${rows.length} cluster${rows.length === 1 ? '' : 's'}`
    + (unread ? ` \u00b7 ${unread} not read yet` : '');
  const emptyText = !total ? 'No clusters configured' : 'No cluster matches the search';

  // The card and its buttons are kept for as long as the page is open: the Columns panel is
  // anchored to its button, and a button replaced under an open panel would leave it
  // anchored to nothing. The table inside (heads and scroll box) is rebuilt with the sort,
  // the columns or the row count; the rows are put into its kept <tbody> as they are.
  // …and with who is looking: "+ Add cluster" is in the shell, and only for a role that may.
  const shell = built.get('summary', `${isSnapshotMode()}|${mayEdit()}`, () => buildCard());
  const counts = healthCounts(all, (r) => healthState(r.d));
  const box = built.get('searchbox', [ui.search || filtered(), ui.sort, ui.dir, ui.only, ui.type, clusterKindRev(), all.map((r) => clusterKind(r.c).type).join(','), all.length,
    counts.green, counts.yellow, counts.red, counts.unreachable].join('|'), () => searchBox(all, rows));
  paintSearchBox(box, all, rows);
  const boxAt = shell.querySelector('.cl-searchbox');
  if (boxAt !== box) boxAt.replaceWith(box);
  paintAges();
  let fresh = false;
  const block = built.get('summary-table', [ui.sort, ui.dir, colSig, rows.length === 0, emptyText].join('|'), () => {
    fresh = true;
    return buildTable(cols, trs, { sort: ui.sort, dir: ui.dir, onSort, emptyText });
  });
  const holder = shell.querySelector('.cl-tbl-holder');
  if (holder.firstChild !== block) { holder.replaceChildren(block); watchHeads(block); }
  if (!fresh && rows.length) reconcile(block.querySelector('tbody'), trs);
  const endEl = shell.querySelector('.cl-end');
  if (endEl && endEl.textContent !== end) endEl.textContent = end;
  if (endEl) endEl.hidden = !end;
  return shell;
}

/**
 * The card: the title, the search box beside it, and at the right the table's tools —
 * Columns, Export CSV, Refresh with its minutes badge. The tools stay out of sight until
 * the pointer is over that corner or the keyboard reaches them (app.css .cl-tools): read
 * a hundred times for every time a column is hidden.
 */
function buildCard() {
  const shell = h('section.card.cl-summary',
    h('header',
      h('h2', 'Cluster summary'),
      h('span.cl-searchbox'),
      h('div.cl-tools', { title: 'Table options' },
        // Adding a cluster is an operator's job as much as an admin's (core: CLUSTER_SAVE);
        // the Config page, where an admin also adds one, is not offered to operators.
        mayEdit() ? h('button#cl-add.btn.sm', { type: 'button', title: 'Add a cluster to the config',
          onclick: async () => { if (await editCluster(null)) draw(); } }, '+ Add cluster') : null,
        h('button#cl-columns.btn.sm', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
          title: 'Show, hide, reorder or rename the columns', onclick: (e) => openColumns(e.currentTarget) }, 'Columns \u25be'),
        h('button.btn.sm', { type: 'button', onclick: exportSummary, title: 'The rows on screen, in the columns on screen' }, 'Export CSV'),
        isSnapshotMode() ? null : h('button.btn.sm', { type: 'button', onclick: () => refreshAll({ force: true, selected: true }),
          title: 'Read every cluster on screen again' }, 'Refresh', h('span.age', { 'aria-live': 'off' })))),
    h('div.body', h('div.cl-tbl-holder'), h('div.cl-end')));
  return shell;
}

/** The minutes badge on Refresh: whole minutes since the last refresh, the time on hover. */
function paintAges() {
  const el = host && host.querySelector('.cl-tools .age');
  if (!el) return;
  const t = refreshAge(state.lastRefresh);
  if (el.textContent !== t) el.textContent = t;
  el.hidden = !t;
  el.title = state.lastRefresh ? `Last refreshed ${dt(state.lastRefresh)}` : '';
  const btn = el.parentElement;
  if (btn) btn.setAttribute('aria-label', state.lastRefresh ? `Refresh \u2014 last refreshed ${ago(state.lastRefresh)}` : 'Refresh');
}

/**
 * The summary table.
 *
 * The table is part of the page: every row is in it and the page scrolls, with no box of
 * its own. Its column heads stay pinned under the top bar while the page scrolls. Two
 * things fight over that: a table wider than the window needs a horizontal scroll box, and
 * any box that scrolls (overflow-x: auto) is where position: sticky sticks — so a sticky
 * <th> inside it pins to the box, which does not scroll vertically, and never pins at all.
 *
 * So the heads people see are a strip OUTSIDE the scroll box, sticky to the page, and the
 * table keeps its real <thead> for meaning (scope, aria-sort, what a screen reader reads
 * and the column widths) but folded to no height. The strip copies the real heads' widths
 * whenever they change (ResizeObserver) and follows the box's horizontal scroll, so it
 * lines up with its columns at any width; a sideways wheel over the strip scrolls the box.
 */
function buildTable(cols, trs, { sort, dir, onSort, emptyText }) {
  // The arrow and aria-sort every sortable head uses (core/sort.js); this strip is its own
  // shape only because it is pinned outside the scroll box.
  const st = { key: sort, dir };
  const arrow = (col) => (sortArrow(st, col.id) ? ` ${sortArrow(st, col.id)}` : null);
  const ariaSort = (col) => ariaSortOf(st, col.id);
  const thead = h('thead.cl-thead', h('tr',
    ...cols.map((col) => h(`th.sortable${col.num ? '.num' : ''}`, {
      scope: 'col', 'data-col': col.id, 'aria-sort': ariaSort(col),
      // No tab stop — the strip above is what the keyboard uses — but a screen reader's
      // own "click" on a head still sorts.
      onclick: () => onSort(col.id),
    }, h('span.cl-th-in', col.name, arrow(col))))));
  const tbody = h('tbody');
  if (!trs.length) tbody.append(h('tr', h('td', { colspan: cols.length }, empty(emptyText))));
  trs.forEach((r) => tbody.append(r));
  const tbl = h('table.tbl.cl-tbl', thead, tbody);
  const scroller = h('div.tbl-wrap.cl-scroll', tbl);

  const strip = h('div.cl-head', { role: 'group', 'aria-label': 'Sort the cluster summary' },
    h('div.cl-head-row',
      ...cols.map((col) => h(`button.cl-hcell${col.num ? '.num' : ''}`, {
        type: 'button', 'data-col': col.id, 'aria-sort': ariaSort(col),
        'aria-label': `Sort by ${col.name}${sort === col.id ? `, sorted ${ariaSort(col)}` : ''}`,
        title: sort === col.id ? `Sorted by ${col.name} — click to reverse` : `Sort by ${col.name}`,
        onclick: () => onSort(col.id),
      }, h('span.cl-th-in', col.name, arrow(col))))));
  scroller.addEventListener('scroll', () => followScroll(strip, scroller), { passive: true });
  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || scroller.scrollWidth <= scroller.clientWidth) return;
    scroller.scrollLeft += e.deltaX;
    e.preventDefault();
  }, { passive: false });

  return h('div.cl-tbl-block', strip, scroller);
}

/* ------------------------- keeping the pinned heads in line ------------------------- */

function followScroll(strip, scroller) {
  const row = strip.firstChild;
  if (row) row.style.transform = scroller.scrollLeft ? `translateX(${-scroller.scrollLeft}px)` : '';
}

/** Copy the real heads' widths onto the strip. Reads first, then writes: one layout. */
function syncHeads(shell) {
  const tbl = shell.querySelector('table.cl-tbl');
  const strip = shell.querySelector('.cl-head');
  if (!tbl || !strip || !tbl.tHead) return;
  const ths = [...tbl.tHead.rows[0].cells];
  const tw = tbl.getBoundingClientRect().width;
  if (!tw) return;
  const ws = ths.map((th) => th.getBoundingClientRect().width);
  const row = strip.firstChild;
  row.style.width = `${tw}px`;
  [...row.children].forEach((cell, i) => { if (ws[i] !== undefined) cell.style.width = `${ws[i]}px`; });
  const scroller = shell.querySelector('.cl-scroll');
  followScroll(strip, scroller);
}

let headsRO = null;
let headsShell = null;
function watchHeads(shell) {
  headsShell = shell;
  if (typeof ResizeObserver !== 'function') return;
  if (!headsRO) headsRO = new ResizeObserver(() => { if (headsShell && headsShell.isConnected) syncHeads(headsShell); });
  headsRO.disconnect();
  const tbl = shell.querySelector('table.cl-tbl');
  headsRO.observe(tbl);
  for (const th of tbl.tHead.rows[0].cells) headsRO.observe(th);
}

let headSyncQueued = false;
function scheduleHeadSync() {
  if (headSyncQueued || typeof requestAnimationFrame !== 'function') return;
  headSyncQueued = true;
  requestAnimationFrame(() => { headSyncQueued = false; if (headsShell && headsShell.isConnected) syncHeads(headsShell); });
}

/**
 * The top bar's height, as --head-fix-h on the root, for the strip's `top`. The bar wraps
 * onto a second line in a narrow window or a Zabbix frame, so it is measured, not assumed.
 */
let headWatch = null;
function trackHeadHeight() {
  const head = document.querySelector('.head-fix');
  if (!head || typeof ResizeObserver !== 'function' || (headWatch && headWatch.el === head)) return;
  if (headWatch) headWatch.ro.disconnect();
  const ro = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--head-fix-h', `${head.getBoundingClientRect().height}px`);
  });
  ro.observe(head);
  headWatch = { el: head, ro };
}

/* ---------------------------------- the rows ---------------------------------- */

/**
 * One cluster's row. A cluster that is not answering keeps its name, health and alerts; its
 * other figures are dashes (what is wrong, and Retry and Diagnose, are on the Alerts page).
 * One row per cluster: what a cluster holds in detail is its Overview (the button on the name).
 */
function rowNodes(r, byCluster, cols) {
  const down = isDown(r);
  const cell = (col) => (!down || col.id === 'name' || DOWN_KEEPS.has(col.id) || col.id === 'disk'
    ? CELLS[col.id](r, byCluster)
    : h(`td${col.num ? '.num' : ''}`, h('span.muted', { 'aria-label': 'not known' }, '\u2014')));
  return h(`tr${down ? '.cl-row-down' : '.cl-row'}`, { 'data-cluster': r.c.id }, ...cols.map(cell));
}

/* ------------------------------- the Columns panel ------------------------------- */

/** The column whose name is being edited in the panel, if any. */
let renaming = null;
/** The column being dragged. */
let dragging = null;

function openColumns(btn) {
  renaming = null;
  popover(btn, (ctx) => columnsPanel(ctx), {
    title: 'Show / hide', sub: 'applies to every cluster row \u00b7 saved for you', cls: 'cl-cols',
    onClose: () => {
      renaming = null; dragging = null;
      // Escape from inside the panel leaves the keyboard on its button, not on the page.
      if (!document.activeElement || document.activeElement === document.body) btn.focus({ preventScroll: true });
    },
  });
}

function columnsPanel(ctx) {
  const cols = resolveColumns(prefs);
  const movable = cols.filter((c) => !c.fixed);
  const apply = (next, focusId) => {
    savePrefs(next);
    draw();
    ctx.rebuild();
    const f = focusId && document.getElementById(focusId);
    if (f && !f.disabled) f.focus();
  };

  const rowFor = (col) => {
    const at = movable.findIndex((m) => m.id === col.id);
    const label = renaming === col.id
      ? h(`input#cl-colname-${col.id}.cl-col-input`, {
          type: 'text', value: col.renamed ? col.name : '', placeholder: col.label, maxLength: MAX_NAME,
          'aria-label': `New name for ${col.label} (empty for the default)`, 'data-own-escape': '',
          onkeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.dataset.done = '1'; renaming = null; apply(renameColumn(prefs, col.id, e.currentTarget.value), `cl-colnm-${col.id}`); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.dataset.done = '1'; renaming = null; ctx.rebuild(); const b = document.getElementById(`cl-colnm-${col.id}`); if (b) b.focus(); }
          },
          onblur: (e) => { if (e.currentTarget.dataset.done) return; renaming = null; apply(renameColumn(prefs, col.id, e.currentTarget.value)); },
        })
      : h(`button#cl-colnm-${col.id}.cl-col-name`, {
          type: 'button', title: 'Click to rename', 'aria-label': `Rename ${col.name}`,
          onclick: () => {
            renaming = col.id; ctx.rebuild();
            const i = document.getElementById(`cl-colname-${col.id}`);
            if (i) { i.focus(); i.select(); }
          },
        }, col.name);
    const note = col.fixed ? 'always shown' : col.renamed ? `was ${col.label}` : col.visible ? '' : 'hidden';
    const li = h(`li.cl-col${col.visible ? '' : '.off'}`, { 'data-col': col.id, draggable: col.fixed ? null : 'true' },
      h('span.cl-grip', { 'aria-hidden': 'true' }, col.fixed ? '' : '⠿'),
      h(`input#cl-colvis-${col.id}`, {
        type: 'checkbox', checked: col.visible, disabled: col.fixed,
        'aria-label': col.fixed ? `${col.name} is always shown` : `Show ${col.name}`,
        onchange: (e) => apply(setColumnShown(prefs, col.id, e.currentTarget.checked), `cl-colvis-${col.id}`),
      }),
      label,
      h('span.cl-col-note', note),
      col.fixed ? h('span.cl-col-mv') : h('span.cl-col-mv',
        h(`button#cl-colup-${col.id}.btn.sm.ghost`, { type: 'button', disabled: at <= 0, 'aria-label': `Move ${col.name} up`, title: 'Move up',
          onclick: () => apply(moveColumnBy(prefs, col.id, -1), at - 1 <= 0 ? `cl-coldn-${col.id}` : `cl-colup-${col.id}`) }, '↑'),
        h(`button#cl-coldn-${col.id}.btn.sm.ghost`, { type: 'button', disabled: at >= movable.length - 1, 'aria-label': `Move ${col.name} down`, title: 'Move down',
          onclick: () => apply(moveColumnBy(prefs, col.id, 1), at + 1 >= movable.length - 1 ? `cl-colup-${col.id}` : `cl-coldn-${col.id}`) }, '↓')));
    if (!col.fixed) {
      li.addEventListener('dragstart', (e) => {
        if (renaming) { e.preventDefault(); return; }
        dragging = col.id;
        try { e.dataTransfer.setData('text/plain', col.id); e.dataTransfer.effectAllowed = 'move'; } catch (_) { /* jsdom */ }
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => { dragging = null; li.classList.remove('dragging'); });
    }
    // Every row, the fixed one included, is somewhere to drop: on its top half "before
    // this", on its bottom half "after this".
    li.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const after = col.fixed || e.clientY > r.top + r.height / 2;
      li.classList.toggle('drop-before', !after);
      li.classList.toggle('drop-after', after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const after = li.classList.contains('drop-after');
      li.classList.remove('drop-before', 'drop-after');
      const ids = movable.map((m) => m.id).filter((id) => id !== dragging);
      const target = col.fixed ? 0 : ids.indexOf(col.id) + (after ? 1 : 0);
      const moved = dragging;
      dragging = null;
      apply(moveColumn(prefs, moved, Math.max(0, target)));
    });
    return li;
  };

  return h('div.cl-cols-panel',
    h('fieldset.cl-cols-group', h('legend', 'Cluster table'),
      h('ul.cl-cols-list', { 'aria-label': 'Columns, in order' }, ...cols.map(rowFor)),
      h('div.muted.cl-cols-hint', 'drag to reorder \u00b7 click a name to rename')),
    h('div.cl-cols-foot',
      h('span.muted', { style: { fontSize: '11.5px' } }, 'Changes apply to every cluster row.'),
      h('span.cl-sp'),
      h('button#cl-cols-reset.btn.sm', { type: 'button', onclick: () => apply(resetColumns(prefs), 'cl-cols-reset') }, 'Reset to default'),
      h('span.muted', { style: { fontSize: '11.5px' } }, prefsSaved ? 'saved for you' : 'not saved \u2014 this browser keeps no storage')));
}

/**
 * Where a node's CPU, heap and disk turn amber ('low') and red ('high'). One definition: the node
 * table here and Play's spotlight colour the same reading the same way.
 */
export const NODE_LOAD_LEVELS = { cpu: { warn: 80, crit: 90 }, heap: { warn: 75, crit: 90 }, disk: { warn: 85, crit: 90 } };
export function nodeLoadLevel(p, which) {
  const t = NODE_LOAD_LEVELS[which] || NODE_LOAD_LEVELS.cpu;
  return p >= t.crit ? 'high' : p >= t.warn ? 'low' : 'ok';
}

/**
 * A node's heap: 'over' (orange, the High alert's colour) past the heap rule's line
 * (alert-rules.js heapOverHigh, 85 %), else amber or fine as NODE_LOAD_LEVELS says — so a cell
 * never shows amber for a node the Alerts page calls High. The node table and Play read it.
 */
export function heapLevel(p) {
  return heapOverHigh(p) ? 'over' : nodeLoadLevel(p, 'heap') === 'ok' ? 'ok' : 'low';
}
/** The heap column's tooltip: the line it is coloured by. */
export const HEAP_TITLE = `JVM heap used. Amber from ${NODE_LOAD_LEVELS.heap.warn} %; orange over ${HEAP_HIGH_PERCENT} %, where a High alert is raised (after ${HEAP_RAISE_READINGS} readings in a row; it clears below ${HEAP_CLEAR_PERCENT} %).`;
