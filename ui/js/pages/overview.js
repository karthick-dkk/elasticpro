/** Page 1 — cluster overview: URL, name, disk, ILM/SLM, repositories and last snapshot. */

import { h, svg, mount, reconcile } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, num, pct, ago, dt, toCsv, download } from '../lib/fmt.js';
import { state, activeClusters, client, healthState, refreshAll, openAlertsNow, requestsFor, requestLoad, jvmSummary, clusterRev, fleetMode, coverage, askFleetDataset, askForPage } from '../core/state.js';
import { coverageBar } from '../lib/freshness.js';
import { readAllState, startReadAll } from '../lib/read-all.js';
import { card, table, diskCell, lastSnapshotOf, snapshotCell, empty } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { navigateTo, canOpenPage } from '../core/intent.js';
import { repoSizeCache } from '../lib/idb.js';
import { compareNames } from '../lib/cluster-order.js';
import { readPrefs, writePrefs, resolveColumns, visibleColumns, setColumnShown, moveColumn, moveColumnBy,
         renameColumn, resetColumns, MAX_NAME, DETAIL_GROUPS, detailItems, detailShown, setDetailShown,
         expandByDefault, setExpandByDefault } from '../core/cluster-view.js';
import { nodeRoles, nodeTier, roleKind, shardAllocation, taskSummary, statsCounters, rateBetween, slmForRepo,
         repoSizeFromCache, refreshAge, healthCounts } from '../core/cluster-detail.js';
import { privilegeHint } from '../core/es-tasks.js';
import { restoreSnapshotDialog } from '../ui/snapshot-dialogs.js';
import { rowMenu, popover, ICON, toast } from '../ui/menu.js';
import { roleMayWrite } from '../core/writes.js';
import { editCluster, rawClusterOf } from '../ui/config-editor.js';
import { takeFocus, revealFocus } from '../core/focus.js';
import { openClusterAlerts } from '../core/alert-goto.js';
import { diskAgainstWatermarks } from '../core/disk-balance.js';
// Why a cluster cannot be reached: one definition, shared with the Alerts page's unreachable lines.
import { unreachableReason } from '../core/alert-groups.js';

let host = null;
/** Rows the operator opened or closed by hand; what the rest show is the preference. */
const openedByHand = new Set();
const closedByHand = new Set();
const isOpen = (id) => (expandByDefault(prefs) ? !closedByHand.has(id) : openedByHand.has(id));
function toggleRow(id) {
  if (expandByDefault(prefs)) { closedByHand.has(id) ? closedByHand.delete(id) : closedByHand.add(id); }
  else { openedByHand.has(id) ? openedByHand.delete(id) : openedByHand.add(id); }
}

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
  ilm:      { label: 'ILM',           get: (r) => (r.d.ilm && r.d.ilm.operation_mode) || null },
  slm:      { label: 'SLM',           get: (r) => (r.d.slmStatus && r.d.slmStatus.operation_mode) || null },
  repo:     { label: 'Repository',    get: (r) => (Array.isArray(r.d.repos) ? r.d.repos.map((x) => x.name).join(', ') : null) },
  reqs:     { label: 'Our reqs/5m',   get: (r) => ((requestLoad.clusters[r.c.id] || {}).last5m || 0) },
};
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
  return rows.map((r) => ({ r, v: get(r) })).sort((a, b) => {
    const an = a.v === null || a.v === undefined, bn = b.v === null || b.v === undefined;
    if (an || bn) return an && bn ? byName(a, b) : an ? 1 : -1;
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : compareNames(a.v, b.v);
    return c * dir || tie(a, b);
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
const ui = { text: '', sort: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir, only: 'all', search: false };
const filtered = () => !!(ui.text || ui.only !== 'all' || ui.sort !== DEFAULT_SORT.key || ui.dir !== DEFAULT_SORT.dir);
const resetFilter = () => { ui.text = ''; ui.only = 'all'; ui.sort = DEFAULT_SORT.key; ui.dir = DEFAULT_SORT.dir; };

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
 * for the alert headline, policies for ILM/SLM and repositories, snapshots for the last
 * backup. What "read" means in the coverage line, and what Read all asks for.
 */
const DATASETS = ['health', 'nodes', 'ilm_errors', 'policies', 'snapshots'];
/** The Read all run, kept across redraws. */
const reading = readAllState();

/**
 * The coverage line (lib/freshness.js coverageBar). Only with the fleet cache — the direct
 * path reads on open as it always has. It says how much of what the page shows has been
 * read, and "Read all" reads the rest one request at a time. Under Client basis (the
 * shipped policy) the page also asks the core for the missing datasets when it opens
 * (askOnOpen below), so the bar is what is left while the answers are still on their way.
 */
function coverageLine() {
  if (!fleetMode()) return null;
  const ids = activeClusters().map((c) => c.id);
  return coverageBar({
    cov: coverage(ids, DATASETS), datasets: DATASETS, state: reading,
    // Each step repaints the bar alone: the page may be holding its own redraws (quiet UI).
    onReadAll: () => startReadAll(reading, { clusterIds: ids, datasets: DATASETS, ask: askFleetDataset,
      onChange: () => { if (host && host.isConnected) coverageLine(); } }),
  });
}

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
  host = el; el.classList.add('dense'); trackHeadHeight();
  // "Go to" from an unreachable alert (core/alert-goto.js): that cluster's row, in view.
  const f = takeFocus('overview');
  focusDown = f && f.section === 'unreachable' ? { cluster: f.cluster || null, prepared: false } : null;
  askOnOpen();
  draw();
  // The Refresh badge counts minutes; nothing else on the page moves on its own.
  if (!ageTimer) ageTimer = setInterval(() => { if (host && host.isConnected) paintAges(); else onLeave(); }, 30000);
}
export function onData() { if (host && host.isConnected) { askOnOpen(); draw(); } }
/** The page's own timers stop with it: the badge tick and every open row's live readings. */
export function onLeave() {
  if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
  for (const L of live.values()) if (L.timer) { clearTimeout(L.timer); L.timer = null; }
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
      const hay = `${c.name} ${c.url} ${(c.tags || []).join(' ')} ${c.via || ''} ${version} ${repos}`;
      return hay.toLowerCase().includes(t);
    });
  }

  // One health state, as the Health column classifies it (core/state.js healthState).
  if (ui.only !== 'all') rows = rows.filter((r) => healthState(r.d) === ui.only);

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
      if (open && filtered()) { resetFilter(); ui.search = false; }
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
      h('span.muted', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } },
        shown.length === all.length ? `${all.length} cluster${all.length === 1 ? '' : 's'}` : `${shown.length} of ${all.length} shown`),
      filtered() ? h('button.btn.sm.ghost', { type: 'button', title: 'Clear the search, sort and filter',
        onclick: () => { resetFilter(); draw(); } }, 'Clear') : null));
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
  const L = live.get(r.c.id);
  return [clusterRev(r.c.id), objId(r.d), objId(r.cl), r.cl && r.cl.state, objId(r.c), isOpen(r.c.id), L ? L.at : 0,
    objId(prefs && prefs.details), (sizeCaches.get(r.c.id) || {}).size || 0,
    (alertCounts && alertCounts.get(r.c.id)) || 0, q.last5m, q.perMinute.toFixed(1), minute(), objId(state.defaults),
    objId(state.indices.get(r.c.id))].join('|');
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
  // A row is rebuilt when its live readings land; the keyboard on its chevron stays there.
  const act = document.activeElement;
  const keepChevron = act && host.contains(act) && act.matches('button.cl-chev') ? act.closest('tr').dataset.cluster : null;
  built.begin();

  mount(host,
    coverageLine(),
    downNote(unreachableRows(rows).length),
    summaryCard(rows, all),
  );
  built.end();
  stopLiveForClosed();
  scheduleHeadSync();
  revealFocused();
  if (keepChevron && !act.isConnected) {
    const again = host.querySelector(`tr[data-cluster="${cssId(keepChevron)}"] button.cl-chev`);
    if (again) again.focus({ preventScroll: true });
  }
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

/** Who may change a cluster at all: the same rule the core enforces (writes.js). */
const mayEdit = () => roleMayWrite() && !isSnapshotMode();
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
      : c.source === 'zabbix' ? { label: 'Edit', icon: ICON.edit, note: 'in Zabbix', disabled: true,
          title: `Managed in Zabbix — host ${(c.zabbix && c.zabbix.host) || ''}` }
      : !rawClusterOf(c) ? { label: 'Edit', icon: ICON.edit, note: 'cluster settings', disabled: true, title: 'Not in the config file' }
      : { label: 'Edit', icon: ICON.edit, note: 'cluster settings', onClick: () => openEditor(c) };
    return [
      { hint: c.name },
      edit,
      canOpenPage('shards') ? { label: 'Nodes', icon: '☷', note: 'Nodes & shards', onClick: () => navigateTo('shards', null, { cluster: c.id }) } : null,
      canOpenPage('snapshots') ? { label: 'Repo', icon: '↻', note: 'Snapshots', onClick: () => navigateTo('snapshots', { view: 'summary' }, { cluster: c.id }) } : null,
      canOpenPage('logs') ? { label: 'Live log', icon: '▶', note: 'Live logs', onClick: () => navigateTo('logs', null, { cluster: c.id }) } : null,
    ];
  };
  return rowMenu(items, {
    trigger: 'button.cl-name',
    label: [h('span.cl-name-t', c.name), h('span.cl-caret', { 'aria-hidden': 'true' }, '▾')],
    title: `${c.url}${c.tags && c.tags.length ? '\n' + c.tags.join(', ') : ''}`,
    menuLabel: `Actions for ${c.name}`,
  });
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
  name: (r) => h('td.cl-name-td', nameMenu(r.c)),
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
  nodes: (r) => h('td.num', r.d.health ? `${r.d.health.number_of_nodes} (${r.d.health.number_of_data_nodes} data)` : '–'),
  size: (r) => h('td.num', { title: 'Store size of the indices on this cluster' },
    clusterSize(r) >= 0 ? bytes(clusterSize(r)) : h('span.muted', '–')),
  disk: (r) => h('td.cl-disk-td', isDown(r)
    // Not answering: what the disk held at the last answer is not what it holds now. No bar,
    // no tick, no threshold colour — and it says why.
    ? h('span.muted', { title: 'The cluster is not answering, so its disk use is not known now.' }, 'unknown while unreachable')
    : diskCell(r.d.disk, r.d.clusterSettings, { dataNodes: true })),
  // The mode on top (running, or stopped/stopping), the error count under it in red with
  // each index's policy, step and reason on hover — the same ilmErrors the alert reads.
  ilm: (r) => {
    const { d } = r;
    if (!d.ilm) return h('td', h('span.muted', '\u2013'));
    const mode = String(d.ilm.operation_mode || '').toLowerCase() || 'unknown';
    const errs = d.ilmErrorCount || 0;
    return h('td', h('div.cl-two',
      mode === 'running' ? h('span.q.ok', 'running') : flag(mode, 'warn'),
      errs ? h('span.q.bad.cl-sub', { title: ilmErrorText(d), 'aria-label': `${errs} ILM error${errs === 1 ? '' : 's'}: ${ilmErrorText(d)}` },
        h('i.qdot', { 'aria-hidden': 'true' }), `${errs} error${errs === 1 ? '' : 's'}`) : null));
  },
  slm: (r) => {
    const { d } = r;
    const n = (d.slm || []).length;
    const policies = n ? h('span.muted.cl-sub', `${n} polic${n > 1 ? 'ies' : 'y'}`) : null;
    if (!d.slmStatus) return h('td', h('div.cl-two', h('span.muted', d.slmSupported === false ? 'n/a' : '\u2013'), policies));
    const mode = String(d.slmStatus.operation_mode || '');
    return h('td', h('div.cl-two', mode === 'RUNNING' ? h('span.q.ok', 'running') : flag(mode.toLowerCase() || 'unknown', 'warn'), policies));
  },
  repo: (r) => {
    const names = (r.d.repos || []).map((x) => x.name);
    return h('td', names.length
      ? h('div', { style: { display: 'grid', gap: '2px' } }, ...names.slice(0, 3).map((n) => h('span.mono', { style: { fontSize: '11.5px' } }, n)),
          names.length > 3 ? h('span.muted', { style: { fontSize: '11px' } }, `+${names.length - 3} more`) : null)
      : h('span.muted', Array.isArray(r.d.repos) ? 'none' : '–'));
  },
  snapshot: (r) => h('td', snapshotCell(lastSnapshotOf(r.d), state.defaults.snapshotStaleHours)),
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

/** Every index in an ILM error step, one line each: index, policy, phase, step, reason. */
function ilmErrorText(d) {
  const e = d.ilmErrors || {};
  const lines = Object.entries(e).slice(0, 8).map(([index, x]) => {
    const where = [x.policy, x.phase, x.step].filter(Boolean).join(' \u00b7 ');
    const why = x.step_info && (x.step_info.reason || x.step_info.type);
    return `${index}${where ? ` \u2014 ${where}` : ''}${why ? `: ${why}` : ''}`;
  });
  const more = Object.keys(e).length - lines.length;
  return lines.join('\n') + (more > 0 ? `\n+${more} more` : '');
}

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
  ilm: [['', (r) => (r.d.ilm && r.d.ilm.operation_mode) || ''], ['in error', (r) => (r.d.ilm ? r.d.ilmErrorCount || 0 : '')]],
  slm: [['', (r) => (r.d.slmStatus && r.d.slmStatus.operation_mode) || (r.d.slmSupported === false ? 'n/a' : '')],
    ['policies', (r) => (r.d.slmStatus ? (r.d.slm || []).length : '')]],
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
    trs.push(...built.get(`row:${r.c.id}`, `${r.sig || rowSig(r)}|${colSig}|${mayEdit()}`, () => rowNodes(r, byCluster, cols)));
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
  const shell = built.get('summary', String(isSnapshotMode()), () => buildCard());
  const counts = healthCounts(all, (r) => healthState(r.d));
  const box = built.get('searchbox', [ui.search, filtered(), !!ui.text, ui.sort, ui.dir, ui.only, all.length, rows.length,
    counts.green, counts.yellow, counts.red, counts.unreachable].join('|'), () => searchBox(all, rows));
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
        h('button#cl-columns.btn.sm', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
          title: 'Show or hide the columns, the tiles and the sections of an open row', onclick: (e) => openColumns(e.currentTarget) }, 'Columns \u25be'),
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
  const arrow = (col) => (sort === col.id ? (dir === 1 ? ' ▲' : ' ▼') : null);
  const ariaSort = (col) => (sort === col.id ? (dir === 1 ? 'ascending' : 'descending') : 'none');
  // The first column is the expand chevron: no name, nothing to sort by.
  const thead = h('thead.cl-thead', h('tr',
    h('th.cl-xth', { 'aria-label': 'Expand' }, h('span.cl-th-in', '')),
    ...cols.map((col) => h(`th.sortable${col.num ? '.num' : ''}`, {
      scope: 'col', 'data-col': col.id, 'aria-sort': ariaSort(col),
      // No tab stop — the strip above is what the keyboard uses — but a screen reader's
      // own "click" on a head still sorts.
      onclick: () => onSort(col.id),
    }, h('span.cl-th-in', col.name, arrow(col))))));
  const tbody = h('tbody');
  if (!trs.length) tbody.append(h('tr', h('td', { colspan: cols.length + 1 }, empty(emptyText))));
  trs.forEach((r) => tbody.append(r));
  const tbl = h('table.tbl.cl-tbl', thead, tbody);
  const scroller = h('div.tbl-wrap.cl-scroll', tbl);

  const strip = h('div.cl-head', { role: 'group', 'aria-label': 'Sort the cluster summary' },
    h('div.cl-head-row',
      h('span.cl-hcell.cl-hcell-x', { 'aria-hidden': 'true' }),
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
  // How much of the table is in view: an open details row is held to it (app.css .cl-detail),
  // so a table wider than the window scrolls its columns and never the details.
  if (scroller && scroller.clientWidth) shell.style.setProperty('--cl-view-w', `${scroller.clientWidth}px`);
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
 * One cluster's row, and its details row when it is expanded. The chevron at the start of the
 * row opens the details; a cluster that is not answering has none to open (what is wrong, and
 * Retry and Diagnose, are on the Alerts page), and its figures are dashes.
 */
function rowNodes(r, byCluster, cols) {
  const out = [];
  const { c, d } = r;
  const down = isDown(r);
  const open = !down && isOpen(c.id);
  const cell = (col) => (!down || col.id === 'name' || DOWN_KEEPS.has(col.id) || col.id === 'disk'
    ? CELLS[col.id](r, byCluster)
    : h(`td${col.num ? '.num' : ''}`, h('span.muted', { 'aria-label': 'not known' }, '\u2014')));
  const flip = () => {
    toggleRow(c.id);
    draw();
    // The row was rebuilt, so the keyboard would be left on nothing: put it back.
    const again = host && host.querySelector(`tr[data-cluster="${cssId(c.id)}"] button.cl-chev`);
    if (again) again.focus({ preventScroll: true });
  };
  const chevron = down ? h('td.cl-xtd')
    : h('td.cl-xtd', h('button.cl-chev', {
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
      'aria-label': `${open ? 'Hide' : 'Show'} details for ${c.name}`,
      title: open ? `Collapse ${c.name}` : `Expand ${c.name} \u2014 nodes, disk, repositories`,
      onclick: flip,
    }, h('span', { 'aria-hidden': 'true' }, open ? '\u25be' : '\u25b8')));
  // The whole row is the handle: a click on any plain cell opens or closes it. Its own
  // controls — the name menu, the alerts link, the chevron — keep their meaning.
  out.push(h(`tr${down ? '.cl-row-down' : '.cl-row'}${open ? '.open' : ''}`, { 'data-cluster': c.id,
    title: down ? null : (open ? 'Click to collapse' : 'Click to expand'),
    onclick: (e) => {
      if (down) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && t.closest('button, a, input, select, label, .menu-pop')) return;
      toggleRow(c.id); draw();
    } }, chevron, ...cols.map(cell)));
  if (open) out.push(h('tr.cl-detail-row', h('td', { colspan: cols.length + 1, style: { background: 'var(--surface-2)' } }, detail(r))));
  return out;
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

  // The three other groups are plain show/hide: what an open row carries across the top,
  // which sections it has, and the columns of each section's table.
  const group = (g, title) => h('fieldset.cl-cols-group',
    h('legend', title),
    ...detailItems(prefs, g).map((it) => h(`label.cl-col-ck${it.fixed ? '.fixed' : ''}`,
      h(`input#cl-dvis-${g}-${it.id}`, { type: 'checkbox', checked: it.visible, disabled: it.fixed,
        'aria-label': it.fixed ? `${it.label} is always shown` : `Show ${it.label}`,
        onchange: (e) => apply(setDetailShown(prefs, g, it.id, e.currentTarget.checked), `cl-dvis-${g}-${it.id}`) }),
      it.label, it.fixed ? h('span.cl-col-note', 'always') : null)));
  const sections = detailItems(prefs, 'sections');
  return h('div.cl-cols-panel',
    h('label.cl-col-ck.cl-expand', h('input#cl-expand-default', { type: 'checkbox', checked: expandByDefault(prefs),
      onchange: (e) => apply(setExpandByDefault(prefs, e.currentTarget.checked), 'cl-expand-default') }),
      'Expand details by default'),
    h('div.cl-cols-grid',
      h('fieldset.cl-cols-group', h('legend', 'Cluster table'),
        h('ul.cl-cols-list', { 'aria-label': 'Columns, in order' }, ...cols.map(rowFor)),
        h('div.muted.cl-cols-hint', 'drag to reorder \u00b7 click a name to rename')),
      h('fieldset.cl-cols-group', h('legend', 'Cluster details'),
        ...detailItems(prefs, 'tiles').map((it) => h('label.cl-col-ck',
          h(`input#cl-dvis-tiles-${it.id}`, { type: 'checkbox', checked: it.visible, 'aria-label': `Show ${it.label}`,
            onchange: (e) => apply(setDetailShown(prefs, 'tiles', it.id, e.currentTarget.checked), `cl-dvis-tiles-${it.id}`) }), it.label)),
        h('div.cl-cols-rule'),
        ...sections.map((it) => h('label.cl-col-ck.strong',
          h(`input#cl-dvis-sections-${it.id}`, { type: 'checkbox', checked: it.visible, 'aria-label': `Show the ${it.label}`,
            onchange: (e) => apply(setDetailShown(prefs, 'sections', it.id, e.currentTarget.checked), `cl-dvis-sections-${it.id}`) }), it.label))),
      group('repo', 'Repository / Snapshot'),
      group('nodes', 'Nodes')),
    h('div.cl-cols-foot',
      h('span.muted', { style: { fontSize: '11.5px' } }, 'Changes apply to every cluster row.'),
      h('span.cl-sp'),
      h('button#cl-cols-reset.btn.sm', { type: 'button', onclick: () => apply(resetColumns(prefs), 'cl-cols-reset') }, 'Reset to default'),
      h('span.muted', { style: { fontSize: '11.5px' } }, prefsSaved ? 'saved for you' : 'not saved \u2014 this browser keeps no storage')));
}

/* ---------------------------------- details ---------------------------------- */

/**
 * The live readings an open row makes for itself: how many tasks the cluster is running
 * and its search/index rate. Not part of the refresh — a row is opened by hand, and these
 * two calls are made for that row only, again every 30 s while it stays open (the rate
 * needs a second reading, 10 s after the first). Closed rows and a left page stop them.
 */
const live = new Map();
const LIVE_EVERY = 30000, LIVE_SECOND = 10000;
function ensureLive(c) {
  let L = live.get(c.id);
  if (!L) { L = { tasks: null, tasksError: null, counters: null, rate: null, rateError: null, at: 0, due: 0, busy: false, timer: null }; live.set(c.id, L); }
  if (L.busy || Date.now() < L.due) return L;
  L.busy = true;
  const cl = client(c.id);
  Promise.allSettled([cl.taskCounts(), cl.rateCounters()]).then(([t, s]) => {
    L.busy = false; L.at = Date.now();
    if (t.status === 'fulfilled') { L.tasks = taskSummary(t.value); L.tasksError = null; }
    else L.tasksError = privilegeHint(t.reason && t.reason.res && t.reason.res.status, 'list') || (t.reason && t.reason.message) || 'not readable';
    if (s.status === 'fulfilled') {
      const now = statsCounters(s.value, L.at);
      L.rate = rateBetween(L.counters, now) || (L.counters ? L.rate : null);
      L.counters = now; L.rateError = null;
    } else L.rateError = (s.reason && s.reason.message) || 'not readable';
    L.due = L.at + (L.counters && !L.rate ? LIVE_SECOND : LIVE_EVERY);
    if (L.timer) clearTimeout(L.timer);
    L.timer = setTimeout(() => { L.timer = null; if (host && host.isConnected && isOpen(c.id)) draw(); }, L.due - L.at);
    if (host && host.isConnected) draw();
  });
  return L;
}
/** A row that closed stops reading; the next open starts afresh after LIVE_EVERY. */
function stopLiveForClosed() {
  for (const [id, L] of live) if (!isOpen(id) && L.timer) { clearTimeout(L.timer); L.timer = null; }
}

/**
 * The per-snapshot size cache (lib/idb.js) the Volume report and the Snapshots page fill:
 * an open row reads a repository's size from it and never measures on its own.
 */
const sizeCaches = new Map();
function sizeCacheFor(c) {
  let cache = sizeCaches.get(c.id);
  if (!cache) {
    cache = repoSizeCache(c.id);
    cache.size = 0;
    sizeCaches.set(c.id, cache);
    cache.ready.then(() => { cache.size = cache.map.size; if (host && host.isConnected && cache.size) draw(); });
  }
  return cache;
}

/** Where a jump-host cluster's tunnel goes: the host as the config file names it. */
function jumpTitle(c) {
  const raw = state.config && state.config.raw;
  const jh = raw && raw.jump_hosts;
  const j = !jh ? null : Array.isArray(jh) ? jh.find((x) => (x.id || x.name) === c.via) : jh[c.via];
  if (!j) return `SSH tunnel via ${c.via}`;
  return `SSH ${j.host || '?'}:${j.port || 22}${j.user ? ` · user ${j.user}` : ''} → ${c.url}`;
}

/** http or https, parsed — never a scheme that would run something when followed. */
function isWebUrl(u) {
  try { const p = new URL(String(u)).protocol; return p === 'http:' || p === 'https:'; } catch (_) { return false; }
}

function tile(label, value, opts = {}) {
  return h(`div.cl-tile${opts.wide ? '.wide' : ''}`, { 'data-tile': opts.id || null },
    h('div.k', label),
    h('div.v', opts.title ? { title: opts.title } : null, value));
}

/** The shard allocation gauge: a half ring for the active share, a stacked bar for the counts. */
function shardTile(d) {
  const a = shardAllocation(d.health);
  if (!a) return tile('Shard allocation', h('span.muted', '–'), { id: 'shards' });
  const R = 36, len = Math.PI * R;
  const share = a.pct === null ? 0 : Math.max(0, Math.min(1, a.pct / 100));
  const gauge = svg('svg', { class: `cl-gauge ${a.level}`, width: 84, height: 46, viewBox: '0 0 84 46', role: 'img',
    'aria-label': a.pct === null ? 'active share unknown' : `${a.pct.toFixed(1)} % of shards active` },
    svg('path', { d: `M6 42 A${R} ${R} 0 0 1 78 42`, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 8, 'stroke-linecap': 'round' }),
    svg('path', { d: `M6 42 A${R} ${R} 0 0 1 78 42`, fill: 'none', stroke: 'currentColor', 'stroke-width': 8, 'stroke-linecap': 'round',
      'stroke-dasharray': `${(share * len).toFixed(1)} ${len.toFixed(1)}` }));
  const seg = (k, n) => (a.total ? h(`i.cl-seg.${k}`, { style: { width: `${(n / a.total) * 100}%` } }) : null);
  const leg = (k, label, n) => h('span.cl-leg', h(`i.cl-seg.${k}`), `${label} `, h('b', String(n)));
  return h('div.cl-tile.wide', { 'data-tile': 'shards' },
    h('div.k', `Shard allocation · ${a.total} total`),
    h('div.cl-shards',
      h('div.cl-gauge-box', gauge, h('div.cl-gauge-n', a.pct === null ? '–' : `${a.pct.toFixed(1)}%`), h('div.cl-gauge-t', 'active')),
      h('div.cl-shards-r',
        h('div.cl-stack', { role: 'img', 'aria-label': `${a.active} active, ${a.relocating} relocating, ${a.initializing} initializing, ${a.unassigned} unassigned` },
          seg('active', a.active), seg('reloc', a.relocating), seg('init', a.initializing), seg('unas', a.unassigned)),
        h('div.cl-legs', leg('active', 'Active', a.active), leg('reloc', 'Relocating', a.relocating),
          leg('init', 'Initializing', a.initializing), leg('unas', 'Unassigned', a.unassigned)))));
}

function detail(r) {
  const { c, d } = r;
  const box = h('div.cl-detail');
  const shown = new Set(detailShown(prefs, 'tiles').map((x) => x.id));
  const sections = new Set(detailShown(prefs, 'sections').map((x) => x.id));
  const L = shown.has('tasks') || shown.has('rate') ? ensureLive(c) : null;

  const tiles = [];
  if (shown.has('url')) {
    // A link only for a web scheme: the address is operator-written config, and a cluster
    // that reached the list through Zabbix is still text somebody typed somewhere.
    const uuid = `Cluster UUID: ${(d.info && d.info.cluster_uuid) || 'unknown'}`;
    tiles.push(tile('Cluster URL', h('span.cl-url',
      isWebUrl(c.url)
        ? h('a.mono', { href: c.url, target: '_blank', rel: 'noopener', title: uuid }, c.url)
        : h('span.mono', { title: uuid }, c.url),
      h('button.btn.sm.ghost.cl-copy', { type: 'button', 'aria-label': 'Copy cluster URL', title: 'Copy URL',
        onclick: async () => {
          try { await navigator.clipboard.writeText(c.url); toast('URL copied', 'ok', 1800, { key: 'cl-copy' }); }
          catch (_) { toast('The browser would not copy — select the URL and copy it', 'warn', 3000, { key: 'cl-copy' }); }
        } }, svg('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' },
        svg('rect', { x: 5, y: 5, width: 9, height: 9, rx: 1.5 }), svg('path', { d: 'M3 11V3h8' })))), { id: 'url' }));
  }
  if (shown.has('jump')) {
    tiles.push(tile('Jump host', c.via ? h('span.mono', { title: jumpTitle(c) }, c.via) : h('span.muted', { title: 'Reached directly, no SSH tunnel' }, 'direct'), { id: 'jump' }));
  }
  if (shown.has('ilm')) {
    const errs = d.ilmErrorCount || 0;
    tiles.push(tile('ILM', !d.ilm ? h('span.muted', 'unknown')
      : h('span.mono', String(d.ilm.operation_mode || 'unknown'),
          errs ? [' · ', h('span.q.bad', { title: ilmErrorText(d), style: { cursor: 'help' } }, `${errs} error${errs === 1 ? '' : 's'}`)] : null), { id: 'ilm' }));
  }
  if (shown.has('slm')) {
    const n = (d.slm || []).length;
    tiles.push(tile('SLM', h('span.mono', d.slmStatus ? `${d.slmStatus.operation_mode} · ${n} polic${n === 1 ? 'y' : 'ies'}`
      : d.slmSupported === false ? 'not supported' : 'unknown'), { id: 'slm' }));
  }
  if (shown.has('shards')) tiles.push(shardTile(d));
  if (shown.has('tasks')) {
    const t = L && L.tasks;
    tiles.push(tile('ES tasks', t ? h('span.mono', `${t.running} running`, t.slow ? [' · ', h('span.q.warn', `${t.slow} > 60s`)] : null)
      : L && L.tasksError ? h('span.muted', { title: L.tasksError }, 'not readable')
      : h('span.muted', 'Loading…'),
      { id: 'tasks', title: 'GET _tasks — tasks running on every node right now; "> 60s" counts the ones running longer than a minute' }));
  }
  if (shown.has('rate')) {
    const rt = L && L.rate;
    tiles.push(tile('Search / index rate', rt ? h('span.mono', `${rt.qps.toFixed(1)} q/s · ${rt.dps >= 100 ? Math.round(rt.dps) : rt.dps.toFixed(1)} docs/s`)
      : L && L.rateError ? h('span.muted', { title: L.rateError }, 'not readable')
      : h('span.muted', { title: 'Two readings of _nodes/stats, ten seconds apart, make a rate' }, 'measuring…'),
      { id: 'rate', title: 'The change in _nodes/stats search.query_total and indexing.index_total between two readings, per second. query_total counts once per shard, so this is shard-level.' }));
  }
  if (shown.has('bucket')) {
    tiles.push(tile('S3 log bucket', c.logBucket ? h('span.mono', { title: 'Enriched and raw logs share this bucket' }, c.logBucket)
      : h('span.muted', { title: 'Set it on the cluster: Config → edit cluster → S3 log bucket' }, 'not set'), { id: 'bucket' }));
  }
  if (tiles.length) box.append(h('div.cl-tiles', ...tiles));

  if (sections.has('repo')) box.append(repoSection(c, d));
  if (sections.has('nodes')) box.append(nodesSection(d));
  return box;
}

/** Last snapshot status as a pill: Success, Partial, Failed, In progress. */
function statusPill(s) {
  if (!s) return h('span.muted', 'none');
  const st = String(s.status || '').toUpperCase();
  const cls = st === 'SUCCESS' ? 'green' : st === 'PARTIAL' ? 'yellow' : st === 'FAILED' ? 'red' : 'grey';
  const word = st === 'IN_PROGRESS' ? 'In progress' : st ? st[0] + st.slice(1).toLowerCase() : 'unknown';
  return h(`span.pill.${cls}`, { title: `Latest snapshot ${s.id} · ${st || 'state unknown'}` }, h('i.dot'), word);
}

function repoSection(c, d) {
  const repos = d.repos || [];
  if (!repos.length) return card('Repository/Snapshot', '', empty('No repositories registered on this cluster'));
  const cols = detailShown(prefs, 'repo');
  const cache = sizeCacheFor(c);
  const mayRestore = roleMayWrite() && !isSnapshotMode();
  const trs = repos.map((rp) => {
    const snaps = (d.snapshots && d.snapshots[rp.name]) || [];
    const newest = snaps[0], oldest = snaps[snaps.length - 1];
    const policies = slmForRepo(d.slm, rp.name);
    const size = repoSizeFromCache(rp.name, snaps, cache.map);
    const cell = {
      name: () => h('td', h('span.mono', rp.name)),
      type: () => h('td', h(`span.pill.${rp.type === 's3' ? 'orange' : 'grey'}`, { title: `Repository type ${rp.type || 'unknown'}` }, rp.type || '?')),
      location: () => h('td.mono.cl-detail-loc', { title: rp.location }, rp.location || '–'),
      policy: () => h('td', policies.length
        ? h('div.cl-two', ...policies.slice(0, 2).map((p) => h('span', h('span.mono', p.id),
            h('span.muted.cl-sub', { title: p.lastAt ? `last run ${dt(p.lastAt)}` : 'never run' }, `${p.pattern || ''}${p.lastSnapshot ? ` → ${p.lastSnapshot}` : ''}`))),
            policies.length > 2 ? h('span.muted.cl-sub', `+${policies.length - 2} more`) : null)
        : h('span.muted', { title: 'No SLM policy writes to this repository' }, 'none')),
      count: () => h('td.num', { title: snaps.slice(0, 12).map((x) => x.id).join('\n') + (snaps.length > 12 ? `\n+${snaps.length - 12} more` : '') }, num(snaps.length)),
      oldest: () => h('td', oldest ? h('span', { title: dt(oldest.start) }, dt(oldest.start).slice(0, 12)) : h('span.muted', '–')),
      newest: () => h('td', newest ? h('span', { title: dt(newest.start) }, `${dt(newest.start).slice(0, 12)} (${ago(newest.start)})`) : h('span.muted', '–')),
      status: () => h('td', statusPill(newest)),
      // Unknown is not a figure: a size is shown only once every snapshot has been measured.
      size: () => h('td', size !== null ? h('span.mono', { title: `Sum of the incremental bytes of ${snaps.length} snapshot(s), measured on the Volume report` }, bytes(size))
        : h('div.cl-two', h('span.muted', '—'), h('span.muted.cl-sub', { title: 'Sizing a repository is an expensive call: the Volume report measures it on demand, and this reads that measurement' }, 'not measured yet'))),
      actions: () => h('td', h('div.cl-acts',
        canOpenPage('snapshots')
          ? h('a.btn.sm.primary', { href: '#/snapshots', title: 'Open Snapshots: list, take, restore, delete, SLM policies',
              onclick: (e) => { e.preventDefault(); navigateTo('snapshots', { view: 'snapshots' }, { cluster: c.id }); } }, 'Manage')
          : null,
        mayRestore && newest
          ? h('button.btn.sm', { type: 'button', title: `Restore indices from ${newest.id}`,
              onclick: () => restoreSnapshotDialog(c, rp.name, newest.id, { onChanged: () => refreshAll({ force: true, selected: true }) }) }, 'Restore…')
          : null)),
    };
    return h('tr', ...cols.map((col) => cell[col.id]()));
  });
  return card('Repository/Snapshot', '', table(cols.map((col) => ({ label: col.label, num: col.num })), trs));
}

/** The chip a node role takes: Elasticsearch's own name, coloured by what it does. */
const roleChip = (role) => h(`span.cl-role.${roleKind(role)}`, role);
const TIER_PILL = { hot: 'red', warm: 'yellow', cold: 'blue', frozen: 'blue', data: 'grey' };

function nodesSection(d) {
  const nodes = d.nodes || [];
  if (!nodes.length) return card('Nodes', '', empty('No node list yet'));
  const cols = detailShown(prefs, 'nodes').filter((x) => x.id !== 'legend');
  const legend = detailShown(prefs, 'nodes').some((x) => x.id === 'legend');
  const shardsOf = new Map(((d.disk && d.disk.nodes) || []).map((x) => [x.node, Number(x.shards)]));
  const bar = (p, cls) => h('div.cl-mini', { role: 'img', 'aria-label': `${Math.round(p)} percent` },
    h(`i.${cls}`, { style: { width: `${Math.max(1.5, Math.min(100, p))}%` } }));
  const level = (p, warn, crit) => (p >= crit ? 'high' : p >= warn ? 'low' : 'ok');
  const pctCell = (p, sub, warn, crit) => (isFinite(p)
    ? h('div.cl-two', h('span', `${Math.round(p)} %`, sub ? h('span.muted.cl-sub', ` · ${sub}`) : null), bar(p, level(p, warn, crit)))
    : h('span.muted', '–'));
  const trs = nodes.map((n) => {
    const roles = nodeRoles(n['node.role']);
    const tier = nodeTier(roles);
    const isMaster = String(n.master || '').trim() === '*';
    const cell = {
      name: () => h('td', h('span.mono', n.name), isMaster ? h('span.cl-star', { title: 'Elected master', 'aria-label': 'elected master' }, ' ★') : null),
      ip: () => h('td.mono', n.ip || '–'),
      id: () => h('td.mono', { title: n.id || '' }, n.id ? String(n.id).slice(0, 8) : '–'),
      tier: () => h('td', tier ? h(`span.pill.${TIER_PILL[tier] || 'grey'}`, { title: tier === 'data' ? 'A data node with no tier role: every tier at once' : `Tier from node.roles (data_${tier}); ILM allocates the ${tier} phase here` }, tier[0].toUpperCase() + tier.slice(1))
        : h('span.muted', { title: 'No data role' }, '–')),
      roles: () => h('td', h('div.cl-roles', roles.length ? roles.map(roleChip) : h('span.cl-role.other', { title: 'node.roles: [] — coordinating-only' }, 'coordinating'))),
      version: () => h('td.mono', n.version || '–'),
      jdk: () => h('td.mono', n.jdk || '–'),
      cpu: () => h('td', pctCell(Number(n.cpu), '', 80, 90)),
      heap: () => h('td', pctCell(Number(n['heap.percent']), n['heap.current'] && n['heap.max'] ? `${bytes(Number(n['heap.current']))} / ${bytes(Number(n['heap.max']))}` : '', 75, 90)),
      disk: () => h('td', pctCell(Number(n['disk.used_percent']), n['disk.used'] && n['disk.total'] ? `${bytes(Number(n['disk.used']))} / ${bytes(Number(n['disk.total']))}` : '', 85, 90)),
      load: () => h('td.num.mono', n.load_1m ?? '–'),
      shards: () => h('td.num', shardsOf.has(n.name) ? num(shardsOf.get(n.name)) : h('span.muted', { title: 'Not in _cat/allocation: no shards here' }, '–')),
      uptime: () => h('td.mono', n.uptime || '–'),
    };
    return h('tr', ...cols.map((col) => cell[col.id]()));
  });
  const body = [table(cols.map((col) => ({ label: col.label, num: col.num })), trs)];
  if (legend) {
    body.push(h('div.cl-legend', { 'aria-label': 'Role colours' }, h('span.muted', 'node.roles:'),
      ...['master', 'data_hot', 'data_warm', 'data_cold', 'data_frozen', 'data_content', 'ingest', 'ml', 'transform', 'remote_cluster_client'].map(roleChip),
      h('span.cl-role.other', { title: 'node.roles: [] — coordinating-only node' }, '[] coordinating-only')));
  }
  return card('Nodes', `${nodes.length} node(s)`, body);
}
