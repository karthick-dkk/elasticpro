/** Page 1 — cluster overview: URL, name, disk, ILM/SLM, repositories and last snapshot. */

import { h, mount, reconcile } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, num, pct, ago, dt, toCsv, download } from '../lib/fmt.js';
import { state, activeClusters, client, healthState, refreshAll, openAlertsNow, requestsFor, requestLoad, jvmSummary, clusterRev, fleetMode, coverage, askFleetDataset, askForPage } from '../core/state.js';
import { coverageBar } from '../lib/freshness.js';
import { readAllState, startReadAll } from '../lib/read-all.js';
import { hbarList } from '../lib/charts.js';
import { card, table, diskCell, lastSnapshotOf, snapshotCell, snapshotStatusByKey, empty } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { navigateTo, canOpenPage } from '../core/intent.js';
import { measureRepoBytes } from '../core/volume.js';
import { repoSizeCache } from '../lib/idb.js';
import { compareNames } from '../lib/cluster-order.js';
import { readPrefs, writePrefs, resolveColumns, visibleColumns, setColumnShown, moveColumn, moveColumnBy,
         renameColumn, resetColumns, MAX_NAME } from '../core/cluster-view.js';
import { rowMenu, popover, ICON } from '../ui/menu.js';
import { roleMayWrite } from '../core/writes.js';
import { editCluster, rawClusterOf } from '../ui/config-editor.js';
import { takeFocus, revealFocus } from '../core/focus.js';
import { openClusterAlerts } from '../core/alert-goto.js';
import { diskAgainstWatermarks } from '../core/disk-balance.js';
// Why a cluster cannot be reached: one definition, shared with the Alerts page's unreachable lines.
import { unreachableReason } from '../core/alert-groups.js';

let host = null;
const expanded = new Set();

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
  return rows.map((r) => ({ r, v: get(r) })).sort((a, b) => {
    const an = a.v === null || a.v === undefined, bn = b.v === null || b.v === undefined;
    if (an || bn) return an && bn ? byName(a, b) : an ? 1 : -1;
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : compareNames(a.v, b.v);
    return c * dir || byName(a, b);
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

// Sorted by cluster name, ascending, until the operator says otherwise.
const ui = { text: '', sort: 'name', dir: 1, only: 'all' };

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
}
export function onData() { if (host && host.isConnected) { askOnOpen(); draw(); } }

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

  if (ui.only === 'problems') rows = rows.filter((r) => !r.d.reachable || (r.d.health && r.d.health.status !== 'green'));
  else if (ui.only === 'offline') rows = rows.filter((r) => r.d.updatedAt && !r.d.reachable);
  else if (ui.only === 'online') rows = rows.filter((r) => r.d.reachable);

  return sortRows(rows, ui.sort, ui.dir);
}

function toolbar(all, shown) {
  const sortSel = h('select', { onchange: (e) => { ui.sort = e.target.value; draw(); } },
    ...Object.entries(SORTS).map(([k, v]) => h('option', { value: k }, v.label)));
  sortSel.value = ui.sort;

  const onlySel = h('select', { onchange: (e) => { ui.only = e.target.value; draw(); } },
    h('option', { value: 'all' }, `All (${all.length})`),
    h('option', { value: 'problems' }, 'Needs attention'),
    h('option', { value: 'online' }, 'Reachable'),
    h('option', { value: 'offline' }, 'Unreachable'));
  onlySel.value = ui.only;

  return h('div.toolbar', { style: { marginBottom: '14px' } },
    h('label.field', 'Search clusters',
      h('input#clusters-search', { type: 'search', value: ui.text, style: { minWidth: '260px' },
        placeholder: 'name, URL, tag, jump host, version, repository…',
        oninput: (e) => { ui.text = e.target.value; draw(); } })),
    h('label.field', 'Sort by', sortSel),
    h('label.field', 'Direction',
      h('button.btn.sm', { style: { minWidth: '104px' },
        title: ui.dir === 1 ? 'Ascending — click for descending' : 'Descending — click for ascending',
        onclick: () => { ui.dir = -ui.dir; draw(); } }, ui.dir === 1 ? '▲ ascending' : '▼ descending')),
    h('label.field', 'Show', onlySel),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'flex-end' } },
      h('span.muted', { style: { fontSize: '11.5px' } },
        shown.length === all.length ? `${all.length} cluster${all.length === 1 ? '' : 's'}` : `${shown.length} of ${all.length} shown`),
      (ui.text || ui.only !== 'all' || ui.sort !== 'name' || ui.dir !== 1)
        ? h('button.btn.sm', { onclick: () => { ui.text = ''; ui.only = 'all'; ui.sort = 'name'; ui.dir = 1; draw(); } }, 'Clear')
        : null));
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
  return [clusterRev(r.c.id), objId(r.d), objId(r.cl), r.cl && r.cl.state, objId(r.c), expanded.has(r.c.id),
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
  built.begin();

  mount(host,
    coverageLine(),
    built.get('toolbar', [!!ui.text, ui.sort, ui.dir, ui.only, all.length, rows.length].join('|'), () => toolbar(all, rows)),
    downNote(unreachableRows(rows).length),
    summaryCard(rows, all),
  );
  built.end();
  scheduleHeadSync();
  revealFocused();
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
 * A row's Health: a small dot and the state. Green is quiet text; yellow and red are coloured
 * text with the reason when it is known ("yellow \u00b7 2 unassigned"); a cluster that is not
 * answering is red and points at the Alerts page, with why in the tooltip.
 */
function healthFlag(r) {
  const { d } = r;
  if (!d.updatedAt) return h('span.muted', 'loading');
  if (!d.reachable) {
    const why = unreachableReason(r.cl).label;
    const err = (r.cl && r.cl.lastError && r.cl.lastError.message) || '';
    return flag('unreachable \u00b7 see Alerts', 'bad', err ? `${why}: ${err}` : why);
  }
  const st = (d.health && d.health.status) || 'unknown';
  if (st === 'green') return h('span.q.ok.dotted', h('i.qdot', { 'aria-hidden': 'true' }), 'green');
  const un = d.health ? d.health.unassigned_shards : null;
  const text = (st === 'yellow' || st === 'red') && isFinite(un) && un > 0 ? `${st} \u00b7 ${un} unassigned` : st;
  return st === 'yellow' ? flag(text, 'warn') : st === 'red' ? flag(text, 'bad') : h('span.muted', text);
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
  disk: (r) => h('td', isDown(r)
    // Not answering: what the disk held at the last answer is not what it holds now. No bar,
    // no tick, no threshold colour — and it says why.
    ? h('span.muted', { title: 'The cluster is not answering, so its disk use is not known now.' }, 'unknown while unreachable')
    : diskCell(r.d.disk, r.d.clusterSettings)),
  ilm: (r) => {
    const { d } = r;
    if (!d.ilm) return h('td', h('span.muted', '\u2013'));
    const mode = String(d.ilm.operation_mode || '');
    const errs = d.ilmErrorCount || 0;
    const bits = [];
    if (mode !== 'RUNNING') bits.push(mode.toLowerCase());
    if (errs) bits.push(`${errs} ILM error${errs === 1 ? '' : 's'}`);
    return h('td', bits.length ? flag(bits.join(' \u00b7 '), 'warn') : h('span.q.ok', 'running'));
  },
  slm: (r) => {
    const { d } = r;
    const n = (d.slm || []).length;
    const policies = n ? h('div.muted', { style: { fontSize: '11px' } }, `${n} polic${n > 1 ? 'ies' : 'y'}`) : null;
    if (!d.slmStatus) return h('td', h('span.muted', d.slmSupported === false ? 'n/a' : '\u2013'), policies);
    const mode = String(d.slmStatus.operation_mode || '');
    return h('td', mode === 'RUNNING' ? h('span.q.ok', 'running') : flag(mode.toLowerCase() || 'unknown', 'warn'), policies);
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
  const scope = rows.length === total
    ? `${total} cluster${total === 1 ? '' : 's'}`
    : `${rows.length} of ${total} clusters`;
  // Unknown is not reachable: a cluster whose health was never read (Client basis, before
  // the page's ask is answered) is counted apart rather than passed off as fine.
  const unread = rows.filter((r) => !isDown(r) && (!r.d || r.d.healthUnknown || !r.d.updatedAt)).length;
  const sub = [scope,
    unread ? `${unread} not read yet` : null,
    ui.sort === 'name' ? (ui.dir === 1 ? 'A\u2013Z by name' : 'Z\u2013A by name')
      : `sorted by ${(SORTS[ui.sort] || SORTS.name).label.toLowerCase()}${ui.dir === 1 ? ', ascending' : ', descending'}`,
    isSnapshotMode() ? `collected ${ago(state.lastRefresh)}` : `updated ${ago(state.lastRefresh)}`].filter(Boolean).join(' \u00b7 ');
  const end = rows.length === 0 ? '' : `End of the list \u00b7 ${rows.length} cluster${rows.length === 1 ? '' : 's'}`;
  const emptyText = !total ? 'No clusters configured' : 'No cluster matches the search';

  // The card and its buttons are kept for as long as the page is open: the Columns panel is
  // anchored to its button, and a button replaced under an open panel would leave it
  // anchored to nothing. The table inside (heads and scroll box) is rebuilt with the sort,
  // the columns or the row count; the rows are put into its kept <tbody> as they are.
  const shell = built.get('summary', String(isSnapshotMode()), () => buildCard(sub));
  let fresh = false;
  const block = built.get('summary-table', [ui.sort, ui.dir, colSig, rows.length === 0, emptyText].join('|'), () => {
    fresh = true;
    return buildTable(cols, trs, { sort: ui.sort, dir: ui.dir, onSort, emptyText });
  });
  const holder = shell.querySelector('.cl-tbl-holder');
  if (holder.firstChild !== block) { holder.replaceChildren(block); watchHeads(block); }
  if (!fresh && rows.length) reconcile(block.querySelector('tbody'), trs);
  const subEl = shell.firstChild && shell.firstChild.querySelector('.sub');
  if (subEl && subEl.textContent !== sub) subEl.textContent = sub;
  const endEl = shell.querySelector('.cl-end');
  if (endEl && endEl.textContent !== end) endEl.textContent = end;
  if (endEl) endEl.hidden = !end;
  return shell;
}

function buildCard(sub) {
  const shell = card('Cluster summary', sub, [h('div.cl-tbl-holder'), h('div.cl-end')],
    [h('button#cl-columns.btn.sm', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
       title: 'Show, hide, reorder or rename the columns', onclick: (e) => openColumns(e.currentTarget) }, 'Columns \u25be'),
     h('button.btn.sm', { type: 'button', onclick: exportSummary, title: 'The rows on screen, in the columns on screen' }, 'Export CSV'),
     isSnapshotMode() ? null : h('button.btn.sm', { type: 'button', onclick: () => refreshAll({ force: true, selected: true }) }, 'Refresh')]);
  shell.classList.add('cl-summary');
  return shell;
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
  const open = !down && expanded.has(c.id);
  const cell = (col) => (!down || col.id === 'name' || DOWN_KEEPS.has(col.id) || col.id === 'disk'
    ? CELLS[col.id](r, byCluster)
    : h(`td${col.num ? '.num' : ''}`, h('span.muted', { 'aria-label': 'not known' }, '\u2014')));
  const chevron = down ? h('td.cl-xtd')
    : h('td.cl-xtd', h('button.cl-chev', {
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
      'aria-label': `${open ? 'Hide' : 'Show'} details for ${c.name}`,
      title: open ? `Collapse ${c.name}` : `Expand ${c.name} \u2014 nodes, disk, repositories`,
      onclick: () => {
        expanded.has(c.id) ? expanded.delete(c.id) : expanded.add(c.id);
        draw();
        // The row was rebuilt, so the keyboard would be left on nothing: put it back.
        const again = host && host.querySelector(`tr[data-cluster="${cssId(c.id)}"] button.cl-chev`);
        if (again) again.focus({ preventScroll: true });
      },
    }, h('span', { 'aria-hidden': 'true' }, open ? '\u25be' : '\u25b8')));
  out.push(h(`tr${down ? '.cl-row-down' : ''}`, { 'data-cluster': c.id }, chevron, ...cols.map(cell)));
  if (open) out.push(h('tr.cl-detail-row', h('td', { colspan: cols.length + 1, style: { background: 'var(--surface-2)' } }, detail(c, d))));
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
    title: 'Columns', sub: 'drag to reorder · click a name to rename', cls: 'cl-cols', width: '320px',
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
    h('ul.cl-cols-list', { 'aria-label': 'Columns, in order' }, ...cols.map(rowFor)),
    h('div.cl-cols-foot',
      h('button#cl-cols-reset.btn.sm', { type: 'button', onclick: () => apply(resetColumns(prefs), 'cl-cols-reset') }, 'Reset to default'),
      h('span.cl-sp'),
      h('span.muted', { style: { fontSize: '11.5px' } }, prefsSaved ? 'saved for you' : 'not saved — this browser keeps no storage')));
}

/* ---------------------------------- details ---------------------------------- */

function detail(c, d) {
  const repos = d.repos || [];
  // .cl-detail is exactly as wide as the table and never makes it wider (app.css): the
  // details wrap inside the columns the rows already set, at any window width.
  const box = h('div.cl-detail');

  // JDK, SLM and our own request rate are summary columns too, but JDK and the request
  // count start hidden (Columns turns them on) and anyone may hide SLM — this is where
  // they stay, so the figure is never gone, only moved. Same jvmSummary/requestsFor calls
  // the column uses, so the two cannot disagree about what "mixed" or "12/min" means.
  const jdk = jvmSummary(d.nodes);
  const req = requestsFor(c.id);
  box.append(h('div.cl-detail-kv',
    kv('Cluster UUID', (d.info && d.info.cluster_uuid) || '–'),
    kv('Lucene', (d.info && d.info.version && d.info.version.lucene_version) || '–'),
    kv('Credential', c.credSource === 'shared' ? `shared (${c.username || 'api key'})` : c.credSource === 'cluster' ? `per-cluster (${c.username})` : 'none'),
    kv('path.repo', (d.pathRepo && d.pathRepo.join(', ')) || 'not configured'),
    kv('Active shards', d.health ? `${num(d.health.active_shards)} (${pct(d.health.active_shards_percent_as_number)})` : '–'),
    kv('Relocating / initializing', d.health ? `${d.health.relocating_shards} / ${d.health.initializing_shards}` : '–'),
    kv('JDK', jdk.text === 'unknown' ? 'unknown' : jdk.mixed ? `${jdk.text} — ${jdk.detail}` : jdk.text),
    kv('SLM', d.slmStatus ? `${d.slmStatus.operation_mode} · ${(d.slm || []).length} polic${(d.slm || []).length === 1 ? 'y' : 'ies'}` : d.slmSupported === false ? 'not supported' : 'unknown'),
    kv('Our requests', `${req.last5m} in 5m · ${req.perMinute.toFixed(1)}/min`)));

  if (repos.length) {
    const trs = repos.map((rp) => {
      const snaps = (d.snapshots && d.snapshots[rp.name]) || [];
      const newest = snaps[0], oldest = snaps[snaps.length - 1];
      const failed = snaps.filter((s) => String(s.status).toUpperCase() !== 'SUCCESS').length;
      return h('tr',
        h('td', h('div.mono', rp.name), h('span.pill.grey', rp.type)),
        h('td.mono.cl-detail-loc', { title: rp.location }, rp.location || '–'),
        h('td.mono', { style: { fontSize: '11px' } },
          [rp.settings.compress !== undefined ? `compress=${rp.settings.compress}` : null,
           rp.settings.chunk_size ? `chunk=${rp.settings.chunk_size}` : null,
           rp.settings.readonly ? 'readonly' : null,
           rp.settings.max_snapshot_bytes_per_sec ? `snap≤${rp.settings.max_snapshot_bytes_per_sec}` : null,
           rp.settings.max_restore_bytes_per_sec ? `restore≤${rp.settings.max_restore_bytes_per_sec}` : null,
          ].filter(Boolean).join(' · ') || '–'),
        h('td.num', num(snaps.length)),
        h('td', oldest ? h('span', { title: dt(oldest.start) }, dt(oldest.start).slice(0, 12)) : h('span.muted', '–')),
        h('td', newest ? h('span', { title: dt(newest.start) }, `${dt(newest.start).slice(0, 12)} (${ago(newest.start)})`) : h('span.muted', '–')),
        h('td.num', failed ? h('span.pill.yellow', h('i.dot'), String(failed)) : h('span.muted', '0')),
        // The button and what it measured share a cell: one column fewer, so the table fits.
        h('td', h('button.btn.sm', { onclick: (e) => measureRepo(c, rp, snaps, e.target) }, 'Measure size'),
          h('div.mono', { id: `repo-size-${c.id}-${rp.name}`.replace(/[^a-z0-9-]/gi, '_') }, '')));
    });
    box.append(card('Snapshot repositories', 'size measurement is an on-demand, expensive call',
      table(['Repository', 'Location / bucket', 'Settings', 'Snapshots', 'Oldest', 'Newest', 'Non-success', 'Size'], trs)));
  } else {
    box.append(card('Snapshot repositories', '', empty('No repositories registered on this cluster')));
  }

  if (d.nodes && d.nodes.length) {
    box.append(card('Nodes', `${d.nodes.length} node(s)`,
      hbarList(d.nodes.map((n) => ({ key: n.name, label: n.name, value: Number(n['disk.used']) || 0,
        sub: `${n['node.role'] || ''} · heap ${n['heap.percent']}% · cpu ${n.cpu}%` })),
        { format: bytes, topN: 12, labelWidth: 170 })));
  }
  return box;
}

function kv(k, v) {
  return h('div', h('div.k', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)' } }, k),
    h('div.mono.v', { style: { fontSize: '12px' } }, String(v)));
}

/**
 * Repository size is not exposed as a single number by Elasticsearch. The closest
 * honest answer is the sum of each snapshot's INCREMENTAL bytes, which is what the
 * repository actually holds. That needs one _status call per snapshot, so it stays
 * behind a button and is capped — and now shared with the Volume report's version of the
 * same figure (core/volume.js's measureRepoBytes) instead of this page keeping its own
 * copy of the loop: the two used to drift, one counting a repository's size one way here
 * and another way there, which is exactly the class of bug CLAUDE.md calls out by name.
 *
 * A snapshot that has finished never changes size, so a persistent, per-cluster,
 * per-snapshot cache (lib/idb.js) means only NEW snapshots since the last measurement are
 * ever asked for again — this used to re-measure the full history, cap and all, every
 * single time the button was pressed.
 */
async function measureRepo(c, repo, snaps, btn) {
  const cl = client(c.id);
  const out = document.getElementById(`repo-size-${c.id}-${repo.name}`.replace(/[^a-z0-9-]/gi, '_'));
  const cap = 60;
  if (!snaps.length) { out.textContent = 'no snapshots'; return; }
  btn.disabled = true;
  out.textContent = 'measuring…';
  const scoped = { repos: [repo], snapshots: { [repo.name]: snaps } };
  const cache = repoSizeCache(c.id);
  try {
    await cache.ready;
    const m = await measureRepoBytes(cl, scoped, { cap, cache: cache.map });
    out.textContent = m.total !== null
      ? `${bytes(m.total)}${snaps.length > cap ? ` (last ${cap} of ${snaps.length})` : ''}`
      : 'unknown — every call failed';
    out.title = `Sum of incremental snapshot bytes across ${m.counted} snapshot(s), ${m.failed} call(s) failed. `
      + 'Snapshots already measured before are read from a local cache, not asked again.';
    await cache.flush((key) => snapshotStatusByKey(scoped, key));
  } finally {
    btn.disabled = false;
  }
}

