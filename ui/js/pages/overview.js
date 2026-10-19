/** Page 1 — cluster overview: URL, name, disk, ILM/SLM, repositories and last snapshot. */

import { h, mount, reconcile } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, num, pct, ago, dt, dur, toCsv, download, healthClass } from '../lib/fmt.js';
import { state, activeClusters, client, fetchOverview, healthState, refreshAll, openAlertsNow, requestsFor, requestLoad, jvmSummary, clusterRev, fleetMode, coverage, askFleetDataset } from '../core/state.js';
import { coverageBar } from '../lib/freshness.js';
import { readAllState, startReadAll } from '../lib/read-all.js';
import { nameList } from '../core/fleet-summary.js';
import { hbarList } from '../lib/charts.js';
import { card, pill, table, diskCell, lastSnapshotOf, snapshotPill, snapshotStatusByKey, empty,
         connectionProblem, diagnose, diagnosisPanel, act } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { navigateTo, canOpenPage } from '../core/intent.js';
import { measureRepoBytes } from '../core/volume.js';
import { repoSizeCache } from '../lib/idb.js';
import { compareNames, sortByName } from '../lib/cluster-order.js';
import { readPrefs, writePrefs, resolveColumns, visibleColumns, setColumnShown, moveColumn, moveColumnBy,
         renameColumn, resetColumns, hideUnreachable, showUnreachable, foldUnreachable, MAX_NAME } from '../core/cluster-view.js';
import { rowMenu, popover, ICON } from '../ui/menu.js';
import { roleMayWrite } from '../core/writes.js';
import { editCluster, rawClusterOf } from '../ui/config-editor.js';

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

/**
 * Rows in `key` order (`dir` 1 ascending, -1 descending). Numbers compare as numbers and
 * text in the one cluster-name order (lib/cluster-order.js), so "es-node-10" and "8.13"
 * land where a person expects. Ties, and the unknowns at the end, go A–Z by name.
 */
export function sortRows(rows, key, dir = 1) {
  const get = (SORTS[key] || SORTS.name).get;
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

/**
 * Why a cluster cannot be reached, in the words of its pill: one definition for the
 * Health cell, the unreachable cards and the CSV. `cls` is the pill colour; a certificate
 * is amber because it is a decision to take rather than an outage.
 */
export function unreachableReason(cl) {
  const st = cl && cl.state;
  if (st === 'auth_error') return { label: 'Auth error', cls: 'red' };
  if (st === 'tls_error') return { label: 'Certificate', cls: 'yellow' };
  if (st === 'tunnel_error') return { label: 'Jump host down', cls: 'red' };
  return { label: 'Offline', cls: 'red' };
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
 * path reads on open as it always has. Nothing here reads by itself: under any policy,
 * opening the page shows what the core holds and says how much of it there is.
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

export function render(el) { host = el; el.classList.add('dense'); trackHeadHeight(); draw(); }
export function onData() { if (host && host.isConnected) draw(); }

/* ------------------------------ per-user layout ------------------------------ */

/**
 * The signed-in person's layout (core/cluster-view.js): columns, their order and names,
 * and the unreachable fold. Read again when somebody else signs in on this tab.
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
/** What is on screen, for the buttons of a card kept from an earlier draw. */
let lastUp = [];
let lastDown = [];
/** Every cluster unreachable right now, filter or not: what folding the section agrees to. */
let lastAllDown = [];

/** Everything a cluster's row is drawn from. */
function rowSig(r) {
  const q = requestsFor(r.c.id);
  return [clusterRev(r.c.id), objId(r.d), objId(r.cl), r.cl && r.cl.state, objId(r.c), expanded.has(r.c.id),
    (alertCounts && alertCounts.get(r.c.id)) || 0, q.last5m, q.perMinute.toFixed(1), minute(), objId(state.defaults),
    objId(state.indices.get(r.c.id))].join('|');
}

/** Reachable was answered as "no": the one definition, shared with the unreachable cards. */
export function unreachableRows(rows) {
  return rows.filter((r) => healthState(r.d) === 'unreachable');
}

/**
 * The page, split: unreachable clusters first, as cards, A–Z whatever the table is sorted
 * by (they have no figures to sort on); every other cluster in the table, in its order.
 */
export function splitRows(rows) {
  const down = sortByName(unreachableRows(rows), (r) => r.c.name);
  const ids = new Set(down.map((r) => r.c.id));
  return { down, up: rows.filter((r) => !ids.has(r.c.id)) };
}

function draw() {
  alertCounts = alertsByCluster();
  currentPrefs();
  const list = activeClusters();
  const all = list.map((c) => ({ c, d: state.data.get(c.id) || {}, cl: client(c.id) }));
  updateFold(all);
  const rows = visibleRows(all);
  const { down, up } = splitRows(rows);
  lastUp = up; lastDown = down;
  for (const r of all) r.sig = rowSig(r);
  built.begin();

  mount(host,
    coverageLine(),
    built.get('toolbar', [!!ui.text, ui.sort, ui.dir, ui.only, all.length, rows.length].join('|'), () => toolbar(all, rows)),
    unreachableSection(down),
    summaryCard(up, down, all),
  );
  built.end();
  scheduleHeadSync();
}

/* ---------------------------- the unreachable cards ---------------------------- */

/** Cards opened with ▾, and the diagnosis each one last ran: kept across redraws. */
const cardOpen = new Set();
const diag = new Map();

/** Bring the fold up to date (core/cluster-view.js foldUnreachable), saving what changed. */
function updateFold(all) {
  const downIds = [], upIds = [];
  for (const r of all) {
    const s = healthState(r.d);
    if (s === 'unreachable') downIds.push(r.c.id);
    else if (s === 'green' || s === 'yellow' || s === 'red') upIds.push(r.c.id);
  }
  lastAllDown = downIds;
  const f = foldUnreachable(prefs.unreachable, downIds, upIds);
  if (f.changed) savePrefs({ ...prefs, unreachable: { hidden: f.hidden, seen: f.seen } });
}

/**
 * Every unreachable cluster, above the table, one compact card each — or, folded, one line.
 *
 * They used to be rows in the table with dashes for every figure, plus a folded panel of
 * full banners under it. A cluster that cannot answer has nothing to put in a column; what
 * it has is a reason, a time, an error and two things to try, which is what a card holds.
 * Above the table, because a cluster that is down is the first thing to know about.
 */
function unreachableSection(down) {
  if (!down.length) return null;
  const hidden = prefs.unreachable.hidden;
  const sig = [hidden, mayEdit(), down.map((r) => `${r.c.id}:${r.sig}:${cardOpen.has(r.c.id)}:${objId(diag.get(r.c.id) || null)}`).join(',')].join('|');
  return built.get('unreachable', sig, () => (hidden ? foldedLine(down) : downBoard(down)));
}

function foldToggle(hidden) {
  return h('button#cl-down-toggle.btn.sm', {
    type: 'button', 'aria-expanded': hidden ? 'false' : 'true', 'aria-controls': 'cl-down-cards',
    title: hidden ? 'Show the unreachable clusters again' : 'Fold this away. A cluster that newly goes down opens it again.',
    onclick: () => {
      savePrefs(hidden ? showUnreachable(prefs) : hideUnreachable(prefs, lastAllDown));
      draw();
    },
  }, hidden ? 'Show ▾' : 'Hide ▴');
}

function foldedLine(down) {
  return h('section.cl-down.folded', { 'aria-label': `${down.length} unreachable, hidden` },
    h('i.cl-dot', { 'aria-hidden': 'true' }),
    h('b', `${down.length} unreachable`),
    h('span.muted.cl-down-names', `hidden · ${nameList(down.map((r) => r.c.name), 4)}`),
    h('span.cl-sp'),
    foldToggle(true));
}

function downBoard(down) {
  return h('section.cl-down', { 'aria-labelledby': 'cl-down-h' },
    h('div.cl-down-head',
      h('i.cl-dot', { 'aria-hidden': 'true' }),
      h('h2#cl-down-h', `${down.length} unreachable`),
      h('span.muted', 'shown first, A–Z'),
      h('span.cl-sp'),
      h('button.btn.sm', {
        type: 'button', title: 'Ask every unreachable cluster again now',
        onclick: (e) => act(e.currentTarget, () => Promise.all(lastDown.map((r) => fetchOverview(r.c.id)))),
      }, 'Retry all'),
      foldToggle(false)),
    h('div#cl-down-cards.cl-down-grid', ...down.map(downCard)));
}

const HM = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
/** "14:02" today, the full date and time before that. */
function clock(ts) {
  return Date.now() - ts < 20 * 3600 * 1000 ? HM.format(new Date(ts)) : dt(ts);
}

/** "since 14:02 · 18 min", or that the start of the outage is not known. */
function sinceText(since) {
  if (!since) return 'since: not known';
  const age = Date.now() - since;
  return `since ${clock(since)} · ${age < 60000 ? 'under a minute' : dur(age)}`;
}

function errorCode(err) {
  if (err.errorCode) return err.errorCode;
  const m = String(err.message || '').match(/EP-\d{3}/);
  return m ? m[0] : '';
}

function downCard(r) {
  const { c, d, cl } = r;
  const reason = unreachableReason(cl);
  const err = (cl && cl.lastError) || {};
  const msg = err.message || 'No response from the cluster.';
  const open = cardOpen.has(c.id);
  const result = diag.get(c.id);
  const retry = () => fetchOverview(c.id);
  return h(`article.cl-down-card${open || result ? '.wide' : ''}`, { 'data-cluster': c.id, 'aria-label': `${c.name}: ${reason.label}` },
    h('div.cl-l1',
      h('b.cl-nm', { title: c.name }, c.name),
      pill(reason.label, reason.cls),
      h('span.cl-sp'),
      h('span.muted.cl-since', { title: sinceText(d.reach && d.reach.since) }, sinceText(d.reach && d.reach.since))),
    h('div.cl-l2',
      h('span.cl-err', { title: msg }, msg),
      h('button.btn.sm.primary', { type: 'button', title: `Ask ${c.name} again now`, onclick: (e) => act(e.currentTarget, retry) }, 'Retry'),
      h('button.btn.sm', {
        type: 'button', title: 'Walk the connection step by step and say where it stops',
        onclick: (e) => act(e.currentTarget, async () => { diag.set(c.id, await diagnose(c)); draw(); }),
      }, 'Diagnose'),
      h('button.btn.sm.ghost.cl-exp', {
        type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-label': `Details for ${c.name}`,
        title: open ? 'Fold the details' : 'Address, jump host, last answer, error code, next try',
        onclick: () => { if (open) { cardOpen.delete(c.id); diag.delete(c.id); } else cardOpen.add(c.id); draw(); },
      }, open ? '▴' : '▾')),
    open ? downDetails(r, retry) : null,
    result ? diagnosisPanel(result, retry) : null);
}

/** A card opened with ▾: where it is, how it is reached, when it last answered, what next. */
function downDetails(r, retry) {
  const { c, d, cl } = r;
  const err = (cl && cl.lastError) || {};
  const prob = connectionProblem(c, retry);
  const code = errorCode(err);
  const next = (d.reach && d.reach.nextProbeAt) || (cl && cl.nextRetryAt) || 0;
  const last = cl && cl.lastOkAt;
  const then = d.health && d.health.status ? ` · ${d.health.status}, ${d.health.number_of_nodes} node${d.health.number_of_nodes === 1 ? '' : 's'}` : '';
  const row = (k, v, mono) => [h('dt', k), h(mono ? 'dd.mono' : 'dd', v)];
  return h('div.cl-down-more',
    h('dl.cl-dl',
      ...row('Address', c.url, true),
      ...row('Through', c.via ? `${c.via} (SSH jump host)` : 'direct — no jump host'),
      ...row('Last answer', last ? `${clock(last)} · ${ago(last)}${then}` : 'none since the app started'),
      ...row('Problem', prob.title),
      ...row('Error', err.message || 'No response from the cluster.'),
      ...row('Error code', code || 'none given'),
      ...row('Next try', !next ? 'not known' : next <= Date.now() ? 'due now'
        : `in ${dur(next - Date.now())}${cl && cl.failures > 1 ? ' (backing off)' : ''}`)),
    prob.body,
    h('div.cl-down-acts', ...prob.actions,
      mayEditCluster(c) ? h('button.btn.sm.ghost', { type: 'button', onclick: () => openEditor(c) }, 'Edit cluster') : null));
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
      j.text === 'unknown' ? h('span.muted', 'unknown') : j.mixed ? pill(j.text, 'yellow') : j.text);
  },
  health: (r) => {
    const { d } = r;
    return h('td', pill(stateLabel(r), d.reachable ? healthClass(d.health && d.health.status) : d.updatedAt ? unreachableReason(r.cl).cls : 'grey'),
      // Where the figure came from, when it is Zabbix's measurement rather than this tab's.
      d.fromZabbix && d.fromZabbix.parts.includes('health')
        ? h('div.muted', { style: { fontSize: '10.5px' }, title: 'Measured by Zabbix, not by this app — so Elasticsearch is not asked again' },
            `via Zabbix · ${d.fromZabbix.healthAge === null ? 'age unknown' : `${Math.round(d.fromZabbix.healthAge)}s ago`}`)
        : null);
  },
  nodes: (r) => h('td.num', r.d.health ? `${r.d.health.number_of_nodes} (${r.d.health.number_of_data_nodes} data)` : '–'),
  size: (r) => h('td.num', { title: 'Store size of the indices on this cluster' },
    clusterSize(r) >= 0 ? bytes(clusterSize(r)) : h('span.muted', '–')),
  disk: (r) => h('td', diskCell(r.d.disk)),
  ilm: (r) => {
    const { d } = r;
    return h('td', d.ilm ? pill(d.ilm.operation_mode, d.ilm.operation_mode === 'RUNNING' ? (d.ilmErrorCount ? 'yellow' : 'green') : 'yellow') : h('span.muted', '–'),
      d.ilmErrorCount ? h('div.muted', { style: { fontSize: '11px' } }, `${d.ilmErrorCount} in error`) : null);
  },
  slm: (r) => {
    const { d } = r;
    return h('td', d.slmStatus ? pill(d.slmStatus.operation_mode, d.slmStatus.operation_mode === 'RUNNING' ? 'green' : 'yellow') : h('span.muted', d.slmSupported === false ? 'n/a' : '–'),
      (d.slm || []).length ? h('div.muted', { style: { fontSize: '11px' } }, `${d.slm.length} polic${d.slm.length > 1 ? 'ies' : 'y'}`) : null);
  },
  repo: (r) => {
    const names = (r.d.repos || []).map((x) => x.name);
    return h('td', names.length
      ? h('div', { style: { display: 'grid', gap: '2px' } }, ...names.slice(0, 3).map((n) => h('span.mono', { style: { fontSize: '11.5px' } }, n)),
          names.length > 3 ? h('span.muted', { style: { fontSize: '11px' } }, `+${names.length - 3} more`) : null)
      : h('span.muted', Array.isArray(r.d.repos) ? 'none' : '–'));
  },
  snapshot: (r) => h('td', snapshotPill(lastSnapshotOf(r.d))),
  alerts: (r, byCluster) => h('td.num', byCluster.get(r.c.id)
    ? h('button.btn.sm.ghost', { type: 'button', title: 'Show these on the Alerts page', onclick: () => navigateTo('alerts') },
        pill(String(byCluster.get(r.c.id)), 'yellow'))
    : h('span.muted', '–')),
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
    ['total bytes', (r) => (r.d.disk && isFinite(r.d.disk.total) ? r.d.disk.total : '')]],
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
  const { headers, data } = csvTable([...lastDown, ...lastUp], visibleColumns(prefs));
  download(`es-cluster-summary-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(data, headers), 'text/csv');
}

function summaryCard(up, down, all) {
  const cols = visibleColumns(prefs);
  const colSig = cols.map((c) => `${c.id}:${c.name}`).join(',');
  const onSort = (key) => { ui.dir = ui.sort === key ? -ui.dir : 1; ui.sort = key; draw(); };
  const byCluster = alertCounts || alertsByCluster();
  const trs = [];
  up.forEach((r) => {
    trs.push(...built.get(`row:${r.c.id}`, `${r.sig || rowSig(r)}|${colSig}|${mayEdit()}`, () => rowNodes(r, byCluster, cols)));
  });

  const total = all.length;
  const shownTotal = up.length + down.length;
  const hiddenDown = prefs.unreachable.hidden;
  const scope = shownTotal === total
    ? `${up.length} reachable cluster${up.length === 1 ? '' : 's'}`
    : `${up.length} reachable of ${total} clusters`;
  const sub = [scope,
    down.length ? `${down.length} unreachable ${hiddenDown ? 'hidden above' : 'shown above'}` : null,
    `sorted by ${(SORTS[ui.sort] || SORTS.name).label.toLowerCase()}${ui.sort === 'name' ? (ui.dir === 1 ? ' A–Z' : ' Z–A') : ui.dir === 1 ? ', ascending' : ', descending'}`,
    isSnapshotMode() ? `collected ${ago(state.lastRefresh)}` : `updated ${ago(state.lastRefresh)}`].filter(Boolean).join(' · ');
  const end = shownTotal === 0 ? '' : `End of the list · ${shownTotal} cluster${shownTotal === 1 ? '' : 's'}`
    + (down.length ? ` (${up.length} here, ${down.length} unreachable at the top${hiddenDown ? ', hidden' : ''})` : '');
  const emptyText = !total ? 'No clusters configured'
    : down.length && !up.length ? 'Every cluster that matches is unreachable — see above'
    : 'No cluster matches the search';

  // The card and its buttons are kept for as long as the page is open: the Columns panel is
  // anchored to its button, and a button replaced under an open panel would leave it
  // anchored to nothing. The table inside (heads and scroll box) is rebuilt with the sort,
  // the columns or the row count; the rows are put into its kept <tbody> as they are.
  const shell = built.get('summary', String(isSnapshotMode()), () => buildCard(sub));
  let fresh = false;
  const block = built.get('summary-table', [ui.sort, ui.dir, colSig, up.length === 0, emptyText].join('|'), () => {
    fresh = true;
    return buildTable(cols, trs, { sort: ui.sort, dir: ui.dir, onSort, emptyText });
  });
  const holder = shell.querySelector('.cl-tbl-holder');
  if (holder.firstChild !== block) { holder.replaceChildren(block); watchHeads(block); }
  if (!fresh && up.length) reconcile(block.querySelector('tbody'), trs);
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
  const thead = h('thead.cl-thead', h('tr',
    ...cols.map((col) => h(`th.sortable${col.num ? '.num' : ''}`, {
      scope: 'col', 'data-col': col.id, 'aria-sort': ariaSort(col),
      // No tab stop — the strip above is what the keyboard uses — but a screen reader's
      // own "click" on a head still sorts.
      onclick: () => onSort(col.id),
    }, h('span.cl-th-in', col.name, arrow(col)))),
    h('th', { 'aria-label': 'Details' }, h('span.cl-th-in', ''))));
  const tbody = h('tbody');
  if (!trs.length) tbody.append(h('tr', h('td', { colspan: cols.length + 1 }, empty(emptyText))));
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
      }, h('span.cl-th-in', col.name, arrow(col)))),
      h('span.cl-hcell.cl-hcell-x', { 'aria-hidden': 'true' })));
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
  followScroll(strip, shell.querySelector('.cl-scroll'));
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

/** One cluster's row, and its details row when it is expanded. */
function rowNodes(r, byCluster, cols) {
  const out = [];
  const { c, d } = r;
  out.push(h('tr', ...cols.map((col) => CELLS[col.id](r, byCluster)),
    // A real button, not a ghost that reads as a label: this is the control people go
    // looking for when a row raises a question, and it was the quietest thing in the
    // row. The chevron says which way it goes; aria-expanded says it to a reader.
    h('td', h('button.btn.sm', {
      type: 'button',
      'aria-expanded': expanded.has(c.id) ? 'true' : 'false',
      title: expanded.has(c.id) ? `Collapse ${c.name}` : `Expand ${c.name} — nodes, disk, repositories`,
      onclick: () => { expanded.has(c.id) ? expanded.delete(c.id) : expanded.add(c.id); draw(); },
    }, h('span', { style: { marginRight: '5px' } }, expanded.has(c.id) ? '▾' : '▸'),
       expanded.has(c.id) ? 'Hide details' : 'Details'))));

  if (expanded.has(c.id)) out.push(h('tr', h('td', { colspan: cols.length + 1, style: { background: 'var(--surface-2)' } }, detail(c, d))));
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
  const box = h('div', { style: { display: 'grid', gap: '12px', padding: '4px 0' } });

  // JDK, SLM and our own request rate are summary columns too, but JDK and the request
  // count start hidden (Columns turns them on) and anyone may hide SLM — this is where
  // they stay, so the figure is never gone, only moved. Same jvmSummary/requestsFor calls
  // the column uses, so the two cannot disagree about what "mixed" or "12/min" means.
  const jdk = jvmSummary(d.nodes);
  const req = requestsFor(c.id);
  box.append(h('div.grid.c3',
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
        h('td.mono', rp.name),
        h('td', h('span.pill.grey', rp.type)),
        h('td.mono.trunc', { title: rp.location }, rp.location || '–'),
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
        h('td', h('button.btn.sm', { onclick: (e) => measureRepo(c, rp, snaps, e.target) }, 'Measure size')),
        h('td.mono', { id: `repo-size-${c.id}-${rp.name}`.replace(/[^a-z0-9-]/gi, '_') }, ''));
    });
    box.append(card('Snapshot repositories', 'size measurement is an on-demand, expensive call',
      table(['Repository', 'Type', 'Location / bucket', 'Settings', 'Snapshots', 'Oldest', 'Newest', 'Non-success', '', 'Measured size'], trs)));
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
    h('div.mono', { style: { fontSize: '12px', wordBreak: 'break-all' } }, String(v)));
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

