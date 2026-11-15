/**
 * Clusters › Overview — one cluster's dashboard on ONE screen (the owner, 2026-11-14: "single page
 * view, no need to scroll anywhere"). The approved board, top to bottom:
 *
 *   1  the cluster (name, type · tags, Elasticsearch version, its URL, uuid; at the right the open
 *      alerts badge, the health pill and "68 of 69 shards placed") · the Nodes card · the Indices card
 *   2  four gauges — CPU, Disk, JVM heap, Shards — each saying which node is highest, a ring at the right
 *   3  Search (with the searches running over a minute) · Indexing · Latency and pressure
 *      (core/node-rates.js: two readings of _nodes/stats)
 *   4  SLM and ILM, one status line each, from what the Clusters page's expanded row already has
 *   5  Nodes (busiest first) beside Indices (unhealthy first, then by size): the rest of the height,
 *      each scrolling inside itself — the page never scrolls at 1280×720 and above (app.css .ov-*)
 *
 * It is a section of the Clusters page (pages/overview.js hands over here for #/clusters/overview);
 * the top bar's chooser is the one cluster choice. Arriving with "All clusters" the shell picks the
 * cluster last chosen, as the evidence pages do (app.js resolveSelection, this page's
 * `singleCluster`); an address that names a cluster moves the chooser (the shell's 'select-cluster').
 *
 * Everything is drawn from what the app already holds for the cluster (state.data: health, nodes,
 * allocation, settings, policies, snapshots; state.indices; state.shards when the Nodes & shards
 * page read it; the alert list). The page asks for the index list (the Indices panel) and, on its
 * own timer, the rate counters and — when the Tasks panel has not — the task list. Pieces are kept
 * between redraws (lib/keyed.js): a push that changed nothing leaves what is under the mouse alone.
 * The page's name is in the menu, once; this page draws no heading of its own.
 */

import { h, mount } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, compact, num, dur, dt, ago } from '../lib/fmt.js';
import { ringGauge, STATUS } from '../lib/charts.js';
import { state, clusters, client, healthState, openAlertsNow, askForPage, fetchIndices, fetchedAt, refreshAll, bus } from '../core/state.js';
import { clusterKind } from '../core/cluster-kind.js';
import { navigateTo, canOpenPage } from '../core/intent.js';
import { openClusterAlerts } from '../core/alert-goto.js';
import { watermarks } from '../core/disk-balance.js';
import { unassignedByIndex, reasonWords } from '../core/cluster-boxes.js';
import { unreachableReason } from '../core/alert-groups.js';
import { LEVEL_TONE } from '../core/alert-levels.js';
import { nodeRates, recordReading } from '../core/node-rates.js';
import { ldSummary, periodQuery, whenText, countText, LD_COLOURS } from '../core/logdelay-report.js';
import { empty, usageBar } from './common.js';
import {
  OVERVIEW, LIST, overviewClusterOf, overviewHash, listHash, highestNode, heapFigures, gaugeLevel,
  busiestFirst, nodeCounts, shardFigures, placedText, unhealthyFirst, indexHealthCounts, indexTotals,
  indexShards, clusterAlerts, rateText, measured, longRunningSearches, slmSummary, ilmSummary, devicesDelay,
} from '../core/cluster-overview.js';

let host = null;
const P = nodeCache();
let offIndices = null;

/** The one cluster: the top bar's chooser, when it names a configured cluster. */
const pick = () => (state.selected && state.selected !== 'all' ? clusters().find((c) => c.id === state.selected) || null : null);

/* ------------------------------------ the tab row ------------------------------------ */

/**
 * List · Overview, under the page's title (the menu's). Shared with the List (pages/overview.js
 * draws the same row) so the two sections cannot disagree about where the other one is.
 */
export function clustersTabs(current) {
  return h('nav.rp-nav.cl-tabs', { 'aria-label': 'Clusters views' },
    h('a', { href: listHash(), dataset: { section: LIST }, 'aria-current': current === LIST ? 'page' : null, title: 'Every cluster, one row each' }, 'List'),
    h('a', { href: overviewHash(), dataset: { section: OVERVIEW }, 'aria-current': current === OVERVIEW ? 'page' : null, title: 'One cluster on one screen' }, 'Overview'));
}

/* ------------------------------------ the page ------------------------------------ */

export function render(el) {
  host = el;
  el.classList.add('dense', 'ov-page');
  // The whole window is the board: html/body stop scrolling, the two bottom panels scroll inside.
  document.documentElement.classList.add('ov-fit');
  if (!offIndices) offIndices = bus.on('indices', () => { if (host && host.isConnected) draw(); });
  // An address that names a cluster (a link, a bookmark) is the choice: the chooser follows it.
  const named = overviewClusterOf(location.hash);
  if (named && named !== state.selected && clusters().some((c) => c.id === named)) bus.emit('select-cluster', named);
  ask();
  draw();
}

export function onData() { if (host && host.isConnected) { ask(); draw(); } }

export function onLeave() {
  document.documentElement.classList.remove('ov-fit');
  if (host) host.classList.remove('ov-page');
  if (offIndices) { offIndices(); offIndices = null; }
  stopPoll();
  P.clear();
  host = null;
}

/* ------------------------------------ Refresh, every N ------------------------------------ */

/**
 * The owner (2026-11-14): "Create Refresh button and show refresh interval: 10 s, 30 s, 1 m, 5 m".
 * At the right of the tab row: ↻ Refresh (now), "every <select>" — remembered per browser — and
 * "refreshed N s ago", whose text ticks once a second (the text node alone is touched). The timer
 * runs only while this board is on screen and the tab is visible; a tick that finds a refresh
 * still in flight is skipped. It refreshes THIS cluster: the poller's figures through the app's
 * own path (refreshAll for the chosen cluster — what the top bar's Refresh does for the selection)
 * and the page's own reads (readOwn). The top bar's Refresh is untouched.
 */
export const REFRESH_KEY = 'elasticpro.overview.refreshSec';
export const REFRESH_STEPS = [[10, '10 s'], [30, '30 s'], [60, '1 m'], [300, '5 m']];
export const REFRESH_DEFAULT = 30;
function readEvery() {
  try { const v = Number(localStorage.getItem(REFRESH_KEY)); return REFRESH_STEPS.some(([s]) => s === v) ? v : REFRESH_DEFAULT; } catch (_) { return REFRESH_DEFAULT; }
}
let every = REFRESH_DEFAULT;
let everyRead = false;
function setEvery(v) {
  every = v;
  try { localStorage.setItem(REFRESH_KEY, String(v)); } catch (_) { /* kept for this visit */ }
  schedule();
}
let refreshedAt = 0;
let refreshing = false;
let tickTimer = null;
let ageTimer = null;
function schedule() {
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = setTimeout(tick, every * 1000);
}
async function tick() {
  tickTimer = null;
  if (!host || !host.isConnected) return;
  if (document.visibilityState === 'visible') await refreshNow();
  if (host && host.isConnected) schedule();
}
/** Refresh this cluster's figures now; a refresh still in flight is not doubled. */
async function refreshNow() {
  const c = pick();
  if (!c || refreshing || state.mode === 'snapshot') return;
  refreshing = true;
  paintAge();
  try { await Promise.allSettled([refreshAll({ force: true, selected: true }), readOwn(c)]); }
  finally {
    refreshing = false;
    refreshedAt = Date.now();
    paintAge();
    if (host && host.isConnected) draw();
  }
}
/** "refreshed N s ago": the button's title, ticking (the owner: the icon and the interval alone are shown). */
function ageText() {
  if (refreshing) return 'refreshing…';
  if (!refreshedAt) return 'not refreshed yet';
  const s = Math.round((Date.now() - refreshedAt) / 1000);
  return `refreshed ${s < 5 ? 'just now' : s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`}`;
}
function paintAge() {
  const el = host && host.querySelector('#ov-refresh');
  if (!el) return;
  const t = `Refresh now · ${ageText()}`;
  if (el.title !== t) { el.title = t; el.dataset.age = ageText(); }
}
/** The control, built once per visit: ↻ (refresh now) joined to the interval; the select shows the remembered one. */
function refreshControl() {
  return P.get('refresh', '', () => {
    const sel = h('select#ov-every', { 'aria-label': 'Refresh every', title: 'How often this board refreshes while it is on screen',
      onchange: (e) => setEvery(Number(e.target.value)) },
    ...REFRESH_STEPS.map(([s, label]) => h('option', { value: String(s) }, label.replace(' ', ''))));
    sel.value = String(every);
    return h('div.ov-refresh', { role: 'group', 'aria-label': 'Refresh' },
      h('button#ov-refresh.btn.sm', { type: 'button', 'aria-label': 'Refresh now', title: `Refresh now · ${ageText()}`, onclick: () => { refreshNow(); } }, '↻'),
      sel);
  });
}

/* ------------------------------------ asking ------------------------------------ */

/** The board's datasets, under a policy that fetches nothing unasked; and the index list, which no poller reads. */
const DATASETS = ['health', 'nodes', 'policies', 'snapshots'];
const asked = new Map();
function ask() {
  const c = pick();
  if (!c || state.mode === 'snapshot') return;
  const last = asked.get(c.id) || 0;
  if (Date.now() - last < 30000) return;
  asked.set(c.id, Date.now());
  askForPage([c.id], DATASETS).catch(() => {});
}

/**
 * The page's own reads, on the refresh interval: the rate counters for core/node-rates.js (two
 * readings make a measurement, so the first rate appears one interval after opening — the cards
 * say "measuring · next poll" until then), the index list when it is over a minute old, and the
 * task list for the long-running searches when the Nodes & shards page has not read it
 * (state.shards `tasks` is the Tasks panel's; it is used as it is when there). An answer that
 * does not arrive leaves the cards saying "measuring" / "not readable". Never under a snapshot file.
 */
let polled = null;
/** cluster id → { rows: _cat/tasks rows | null (not readable), at } read by this page. */
const tasksRead = new Map();
function stopPoll() {
  if (tickTimer) clearTimeout(tickTimer);
  if (ageTimer) clearInterval(ageTimer);
  tickTimer = null; ageTimer = null; polled = null; refreshedAt = 0; refreshing = false;
}
/** Arriving, or the chooser moved: the first own reading at once, then the interval. */
function pollFor(c) {
  if (polled === c.id) return;
  polled = c.id;
  if (!everyRead) { everyRead = true; every = readEvery(); }
  refreshedAt = 0;
  if (!ageTimer) ageTimer = setInterval(() => { if (host && host.isConnected) paintAge(); else stopPoll(); }, 1000);
  readOwn(c).then(() => { if (host && host.isConnected && polled === c.id) { if (!refreshedAt) refreshedAt = Date.now(); paintAge(); draw(); } });
  schedule();
}
/** The task rows the Search card reads: the Tasks panel's when it has them, else this page's own reading. */
function tasksFor(c) {
  const sh = state.shards.get(c.id);
  if (sh && Array.isArray(sh.tasks)) return { rows: sh.tasks, source: 'panel' };
  const own = tasksRead.get(c.id);
  return own ? { rows: own.rows, source: 'own' } : { rows: undefined, source: 'none' };
}
/** cluster id → the last LOGDELAY_SUMMARY answer for it (the Devices & log delay card), or null before one. */
const ldRead = new Map();
let reading = false;
async function readOwn(c) {
  if (reading || state.mode === 'snapshot') return;
  const cl = client(c.id);
  if (!cl) return;
  reading = true;
  try {
    const wantTasks = tasksFor(c).source !== 'panel' && typeof cl.tasks === 'function';
    const at = fetchedAt(c.id, 'indices') || 0;
    const [rates, tasks, , ld] = await Promise.allSettled([
      typeof cl.nodesRates === 'function' ? cl.nodesRates() : Promise.reject(new Error('no client')),
      wantTasks ? cl.tasks() : Promise.resolve(undefined),
      !state.indices.has(c.id) || Date.now() - at > 60000 ? fetchIndices(c.id) : Promise.resolve(),
      // The Log Delay Dashboard's own answer for this cluster, today: one call per refresh.
      ldSummary({ ...periodQuery('today'), clusterIds: [c.id], maxDevices: 2000 }),
    ]);
    if (rates.status === 'fulfilled') recordReading(c.id, rates.value, Date.now());
    if (wantTasks) tasksRead.set(c.id, { rows: tasks.status === 'fulfilled' && Array.isArray(tasks.value) ? tasks.value : null, at: Date.now() });
    ldRead.set(c.id, ld.status === 'fulfilled' ? ld.value : { ok: false, message: (ld.reason && ld.reason.message) || 'not read' });
  } finally { reading = false; }
}

/** The address names the cluster on screen, so a bookmark or a shared link opens on it. */
function syncAddress(c) {
  const want = overviewHash(c.id);
  if (location.hash === want) return;
  try { history.replaceState(null, '', want); } catch (_) { location.hash = want; }
}

function draw() {
  if (!host || !host.isConnected) return;
  const c = pick();
  P.begin();
  try {
      // The tab row and, at its right, Refresh · every · refreshed N s ago — one bar, kept for the visit.
    const tabs = P.get('bar', OVERVIEW, () => h('div.ov-bar', clustersTabs(OVERVIEW), refreshControl()));
    if (!c) { mount(host, tabs, P.get('none', '', () => empty(clusters().length ? 'Pick a cluster in the top bar' : 'No clusters configured'))); return; }
    syncAddress(c);
    pollFor(c);
    paintAge();
    const d = state.data.get(c.id) || {};
    const idx = state.indices.has(c.id) ? state.indices.get(c.id) : null;
    const sh = state.shards.get(c.id) || null;
    const alerts = clusterAlerts(openAlertsNow(), c.id);
    const rates = nodeRates(c.id);
    const tasks = tasksFor(c);
    // Keyed on the data objects the cards read, not on the cluster's revision: a fleet-wide push that
    // changed nothing of this cluster leaves every card where it is. The snapshot listing is filled in
    // place (fetchSnapshotsDirect), so the SLM card keys on its shape as well.
    const rev = `${objId(d)}`;
    const snapSig = Object.entries(d.snapshots || {}).map(([k, v]) => `${k}:${(v || []).length}:${v && v[0] ? v[0].id : ''}`).join(',');
    mount(host, tabs, h('div.ov-board',
      h('div.ov-row.ov-top',
        P.get('head', `${rev}|${objId(sh)}|${objId(c)}|${healthState(d)}|${alerts.count}|${alerts.worst}|${alerts.titles.join('|')}`, () => headerCard(c, d, sh, alerts)),
        P.get('nodes', `${rev}|${objId(d.nodes)}`, () => nodesCard(d)),
        P.get('indices', `${rev}|${objId(idx)}`, () => indicesCard(idx))),
      h('div.ov-row.ov-gauges',
        P.get('g-cpu', `${rev}|${objId(d.nodes)}`, () => cpuGauge(d)),
        P.get('g-disk', `${rev}|${objId(d.nodes)}|${objId(d.clusterSettings)}`, () => diskGauge(d)),
        P.get('g-heap', `${rev}|${objId(d.nodes)}`, () => heapGauge(d)),
        P.get('g-shards', `${rev}|${objId(d.health)}`, () => shardsGauge(d))),
      h('div.ov-row.ov-rates',
        P.get('r-search', `${rateSig(rates, 'searchPerSec', 'sinceMs')}|${tasks.source}|${objId(tasks.rows)}|${c.id}`, () => searchCard(c, rates, tasks)),
        P.get('r-devices', `${objId(ldRead.get(c.id))}|${c.id}|${Math.floor(Date.now() / 60000)}`, () => devicesCard(c, ldRead.get(c.id) || null)),
        P.get('r-pressure', rateSig(rates, 'searchLatencyMs', 'rejected', 'breakerTrips'), () => pressureCard(rates))),
      h('div.ov-row.ov-lifecycle',
        P.get('slm', `${rev}|${objId(d.slm)}|${objId(d.slmStatus)}|${snapSig}|${objId(c)}|${objId(state.defaults)}`, () => slmCardEl(c, d)),
        P.get('ilm', `${rev}|${objId(c)}|${objId(idx)}|${objId(state.defaults)}|${Math.floor(Date.now() / 3600000)}`, () => ilmCardEl(c, d, idx))),
      h('div.ov-row.ov-bottom',
        nodesPanel(c, d),
        indicesPanel(c, idx))));
  } finally { P.end(); }
}

const rateSig = (r, ...keys) => (!r ? 'none' : `${measured(r)}|${keys.map((k) => r[k]).join('|')}`);

/* ------------------------------------ row 1 ------------------------------------ */

const HEALTH_PILL = { green: 'green', yellow: 'yellow', red: 'red', unreachable: 'red', loading: 'grey' };
const HEALTH_WORD = { green: 'Green', yellow: 'Yellow', red: 'Red', unreachable: 'Unreachable', loading: 'loading' };

/** "1 replica unassigned · a node left the cluster": from the shard table when the Nodes & shards page read it; else says what would tell. */
function unassignedLine(d, sh) {
  const f = shardFigures(d.health);
  if (!f || !f.unassigned) return null;
  const rows = sh && Array.isArray(sh.rows) ? sh.rows : null;
  if (!rows) return h('span.muted', { title: 'The reason is in _cat/shards, which the Nodes & shards page reads.' }, `${f.unassigned} unassigned · reason not read yet`);
  let primaries = 0, replicas = 0;
  const codes = new Set();
  for (const u of unassignedByIndex(rows).values()) { primaries += u.primaries; replicas += u.replicas; u.codes.forEach((k) => codes.add(k)); }
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : null);
  const what = [part(primaries, 'primary', 'primaries'), part(replicas, 'replica', 'replicas')].filter(Boolean).join(', ') || `${f.unassigned}`;
  return h('span', `${what} unassigned${codes.size ? ` · ${[...codes].map(reasonWords).join(', ')}` : ''}`);
}

/**
 * The open alerts for this cluster as a badge in the card's corner (the owner: "only corner side,
 * not full row"): amber for warnings, red when any is critical, nothing when there are none; the
 * titles on hover; a click opens the Alerts page showing this cluster alone.
 */
function alertsBadge(c, a) {
  if (!a.count) return null;
  const tone = a.worst === 'critical' ? 'red' : a.worst === 'high' ? 'high' : LEVEL_TONE[a.worst] || 'yellow';
  const label = `${a.count} open alert${a.count === 1 ? '' : 's'} for ${c.name}`;
  const title = `${label}:\n${a.titles.join('\n')}${a.count > a.titles.length ? `\n…and ${a.count - a.titles.length} more` : ''}`;
  if (!canOpenPage('alerts')) return h(`span.pill.${tone}.ov-alerts`, { title, dataset: { card: 'alerts' } }, `⚠ ${a.count} alert${a.count === 1 ? '' : 's'}`);
  return h(`a.pill.${tone}.ov-alerts`, { href: '#/alerts', title: `${title}\n\nOpen the Alerts page, showing ${c.name} only`, 'aria-label': label, dataset: { card: 'alerts' },
    onclick: (e) => { e.preventDefault(); openClusterAlerts(c.id); } }, `⚠ ${a.count} alert${a.count === 1 ? '' : 's'}`);
}

function headerCard(c, d, sh, alerts) {
  const st = healthState(d);
  const kind = clusterKind(c);
  const meta = [kind.label, ...(c.tags || [])].filter(Boolean).join(' · ');
  const version = d.info && d.info.version && d.info.version.number;
  const uuid = d.info && d.info.cluster_uuid;
  const why = st === 'unreachable' ? unreachableReason(state.clients.get(c.id)).label : '';
  const un = unassignedLine(d, sh);
  return h('section.card.ov-card.ov-head', { dataset: { card: 'cluster' } },
    h('div.ov-head-main',
      h('h2.ov-name', c.name),
      h('span.ov-meta', meta),
      h('span.ov-version', version ? `Elasticsearch ${version}` : h('span.muted', 'Elasticsearch version not read')),
      h('span.ov-url.mono', { title: 'the cluster’s address, as configured' }, c.url || h('span.muted', 'no address')),
      h('span.ov-uuid.mono', { title: 'cluster uuid' }, uuid || '–')),
    h('div.ov-head-side',
      h('div.ov-head-pills', alertsBadge(c, alerts), h(`span.pill.${HEALTH_PILL[st]}.ov-health`, { title: why || null }, h('i.dot'), HEALTH_WORD[st])),
      h('span.ov-placed.muted', placedText(shardFigures(d.health)) || (st === 'loading' ? 'health not read yet' : why || ''), un ? [h('br'), un] : null)));
}

function nodesCard(d) {
  const n = nodeCounts(d.nodes);
  return h('section.card.ov-card.ov-fact', { dataset: { card: 'nodes' } },
    h('b.ov-fact-t', '☷ ', n ? `${n.total} node${n.total === 1 ? '' : 's'}` : 'Nodes'),
    n ? h('span', `${n.data} data`) : h('span.muted', 'node list not read yet'),
    n ? h('span', `${n.masterEligible} master-eligible${n.masterName ? ` · master ${n.masterName}` : ''}`) : null,
    n ? h('span.muted.ov-fact-s', n.uptime ? `up ${n.uptime}` : 'uptime not reported') : null);
}

function indicesCard(idx) {
  const t = indexTotals(idx), hc = indexHealthCounts(idx);
  const unhealthy = idx ? [hc.red ? `${hc.red} red` : null, hc.yellow ? `${hc.yellow} yellow` : null].filter(Boolean).join(' · ') : '';
  return h('section.card.ov-card.ov-fact', { dataset: { card: 'indices' } },
    h('b.ov-fact-t', '≡ ', idx ? `${num(idx.length)} ${idx.length === 1 ? 'index' : 'indices'}` : 'Indices'),
    idx ? h('span', `${compact(t.docs)} documents`) : h('span.muted', 'index list not read yet'),
    idx ? h('span', `${bytes(t.size)} on disk`) : null,
    idx ? h('span.muted.ov-fact-s', unhealthy || (idx.length ? 'all green' : 'none')) : null);
}

/* ------------------------------------ row 2: gauges ------------------------------------ */

const LEVEL_COLOUR = { ok: 'var(--chart-info)', warn: STATUS.warning, crit: STATUS.critical };

/**
 * One gauge card: the title, "Highest on <node>", a caption, and the ring (lib/charts.js
 * ringGauge — the one ring) at the right. No reading: the ring is empty and the caption says why.
 */
function gaugeCard(id, title, best, caption, ring) {
  return h('section.card.ov-card.ov-gauge', { dataset: { card: id } },
    h('div.ov-gauge-text',
      h('b.ov-fact-t', title),
      h('span.muted.ov-gauge-k', 'Highest on'),
      h('span.ov-gauge-node', { title: best ? best.name : null }, best ? best.name : h('span.muted', 'not read yet')),
      h('span.muted.ov-gauge-c', { title: caption }, caption)),
    ring);
}

const pctRing = (value, kind, label) => ringGauge(
  value === null ? [] : [{ value, color: LEVEL_COLOUR[gaugeLevel(value, kind)] || LEVEL_COLOUR.ok, label }],
  { total: 100, size: 82, stroke: 10, centre: value === null ? '–' : `${Math.round(value)}%`, label: value === null ? `${label}: not known` : `${label} ${Math.round(value)} percent` });

function cpuGauge(d) {
  const best = highestNode(d.nodes, 'cpu');
  const load = best && best.node.load_1m ? `load ${best.node.load_1m} (1 m)` : (best ? 'load not reported' : 'the node list says which');
  return gaugeCard('cpu', 'CPU', best, load, pctRing(best ? best.value : null, 'disk', 'CPU'));
}

function diskGauge(d) {
  const best = highestNode(d.nodes, 'disk.used_percent');
  const w = d.clusterSettings ? watermarks(d.clusterSettings) : null;
  const marks = !w ? 'watermarks not known' : w.assumed ? 'watermarks not set: 85 % / 90 % / 95 % assumed' : `Watermarks ${w.low} % / ${w.high} % / ${w.flood === null ? '?' : w.flood} %`;
  return gaugeCard('disk', 'Disk', best, marks, pctRing(best ? best.value : null, 'disk', 'Disk'));
}

function heapGauge(d) {
  const best = highestNode(d.nodes, 'heap.percent');
  const hf = heapFigures(best && best.node);
  const used = hf.current !== null && hf.max !== null ? `${bytes(hf.current)} / ${bytes(hf.max)}` : (best ? 'heap size not reported' : 'the node list says which');
  return gaugeCard('heap', 'JVM heap', best, used, pctRing(best ? best.value : null, 'heap', 'JVM heap'));
}

function shardsGauge(d) {
  const f = shardFigures(d.health);
  const ring = ringGauge(f ? [
    { value: f.assigned, color: 'var(--chart-info)', label: 'assigned' },
    { value: f.moving, color: 'var(--chart-good)', label: 'moving' },
    { value: f.unassigned, color: STATUS.critical, label: 'unassigned' },
  ] : [], { total: f ? f.total : 0, size: 82, stroke: 10, centre: f && f.pct !== null ? `${Math.round(f.pct)}%` : '–',
    label: f && f.pct !== null ? `${Math.round(f.pct)} percent of shards assigned` : 'shards: not known' });
  const dot = (colour, n, what) => h('span', { title: `${n} ${what}` }, h('i.ov-dot', { style: { background: colour } }), ` ${n}`);
  return h('section.card.ov-card.ov-gauge', { dataset: { card: 'shards' } },
    h('div.ov-gauge-text',
      h('b.ov-fact-t', 'Shards'),
      f ? h('span.ov-gauge-node', f.primary === null ? 'primaries not known' : `${num(f.primary)} primary`) : h('span.muted', 'health not read yet'),
      f ? h('span.ov-gauge-node', `${num(f.total)} total`) : null,
      f ? h('span.muted.ov-gauge-c.ov-split', dot('var(--chart-info)', f.assigned, 'assigned'), ' · ', dot('var(--chart-good)', f.moving, 'moving'), ' · ', dot(STATUS.critical, f.unassigned, 'unassigned')) : null),
    ring);
}

/* ------------------------------------ row 3: rates ------------------------------------ */

/** A rate card: the title, the big figure with its unit, a line under it, anything more after that. */
function rateCard(id, title, big, unit, sub, ...more) {
  return h('section.card.ov-card.ov-rate', { dataset: { card: id } },
    h('b.ov-fact-t', title),
    h('span.ov-rate-v', h('b', big), ' ', h('span.muted', unit)),
    h('span.muted.ov-fact-s', sub),
    ...more);
}
const MEASURING = 'measuring · next poll';
const sinceText = (r) => (r && r.sinceMs ? ` (${Math.round(r.sinceMs / 60000) || '<1'} min)` : '');

/**
 * The searches running longer than a minute (the owner: "show long running query name and query
 * time"): a pill with the count — amber when there are any — then each one's description as the
 * cluster reports it, its node and its running time, and a link to the Tasks panel. The task list
 * not readable says so (unknown is not zero).
 */
function longRunning(c, tasks) {
  const list = tasks.rows === undefined ? undefined : longRunningSearches(tasks.rows);
  const link = canOpenPage('shards')
    ? h('a.ov-link', { href: '#/shards', title: 'The Tasks panel on Nodes & shards', onclick: (e) => { e.preventDefault(); navigateTo('shards', null, { cluster: c.id }); } }, 'Tasks')
    : null;
  if (list === undefined) return h('div.ov-long', h('span.pill.grey.ov-long-pill', { title: 'The task list is read with the rates, shortly after the page opens.' }, 'tasks: reading…'), link);
  if (list === null) return h('div.ov-long', h('span.pill.grey.ov-long-pill', { title: '_cat/tasks could not be read for this cluster (it needs the monitor privilege).' }, 'tasks not readable'), link);
  if (!list.length) return h('div.ov-long', h('span.pill.grey.ov-long-pill', 'none over 1 min'), link);
  return h('div.ov-long',
    h('span.pill.yellow.ov-long-pill', { title: `${list.length} search${list.length === 1 ? '' : 'es'} running for over a minute` }, `${list.length} long-running`),
    ...list.slice(0, 2).map((t) => [
      h('span.mono.ov-long-q', { title: `${t.description || '(no description)'}\non ${t.node || '?'} · running ${dur(t.ms)}` }, `${t.description || '(no description)'}${t.node ? ` · ${t.node}` : ''}`),
      h('span.ov-long-t', dur(t.ms))]),
    list.length > 2 ? h('span.muted', `+${list.length - 2} more`) : null,
    link);
}

function searchCard(c, r, tasks) {
  const lr = longRunning(c, tasks);
  if (!measured(r)) return rateCard('search', 'Search', '–', 'req/s', MEASURING, lr);
  return rateCard('search', 'Search', rateText(r.searchPerSec), 'req/s', `average between the last two polls${sinceText(r)}`, lr);
}
/**
 * Devices & log delay (the owner, 2026-11-14: in place of Indexing — docs/s stays in nodeRates()):
 * the devices in this cluster's last scheduled run, how many of them are late by the configured
 * levels (the Log Delay tiles' own figures and colours), when it was last measured and when the
 * next run is due, and the Dashboard's words for a cluster not measured. A Log Delay link opens
 * the cluster's board.
 */
function devicesCard(c, res) {
  const d = devicesDelay(res, c.id);
  const link = canOpenPage('log-delay')
    ? h('a.ov-link', { href: '#/log-delay', title: `${c.name}’s log delay board`, onclick: (e) => { e.preventDefault(); navigateTo('log-delay', { view: 'cluster', cluster: c.id }, { cluster: c.id }); } }, 'Log Delay')
    : null;
  const head = h('span.ov-lc-h', h('b.ov-fact-t', 'Devices & log delay'), h('span.ov-spacer'), link);
  if (!res) return h('section.card.ov-card.ov-rate', { dataset: { card: 'devices', state: 'reading' } }, head, h('span.ov-rate-v', h('b', '–'), ' ', h('span.muted', 'devices')), h('span.muted.ov-fact-s', 'reading the last run…'));
  if (d.state !== 'ok' && d.state !== 'off') {
    return h('section.card.ov-card.ov-rate', { dataset: { card: 'devices', state: d.state } }, head,
      h('span.ov-rate-v', h('b', '–'), ' ', h('span.muted', 'devices')),
      h('span.muted.ov-fact-s', { title: d.message || null }, d.state === 'never' ? d.message : d.state === 'error' ? `log delay not readable: ${d.message}` : d.message));
  }
  const dot = (colour) => h('i.ov-dot', { style: { background: colour } });
  const n = (v) => (v === null ? '–' : countText(v));
  return h('section.card.ov-card.ov-rate', { dataset: { card: 'devices', state: d.state } }, head,
    h('span.ov-rate-v', h('b', n(d.inLastRun)), ' ', h('span.muted', 'devices in the last run')),
    h('span.ov-fact-s.ov-ld-line', h('b', n(d.late)), ` delayed ${d.bands.lateShort === 'late' ? '' : `over ${d.bands.lateShort.replace('+ min', ' min')} `}· `,
      dot(LD_COLOURS.delay), ` ${n(d.delay)} ${d.bands.mid.toLowerCase()} · `, dot(LD_COLOURS.crit), ` ${n(d.critical)} ${d.bands.high.toLowerCase()}`),
    h('span.muted.ov-fact-s', { title: d.message || null }, d.state === 'off' ? d.message : `last measured ${whenText(d.lastRunAt)} · next ${whenText(d.nextDueAt)}`));
}
function pressureCard(r) {
  if (!measured(r)) return rateCard('pressure', 'Latency and pressure', '–', 'per search', MEASURING);
  const ms = r.searchLatencyMs === null || r.searchLatencyMs === undefined ? '–' : `${Math.round(r.searchLatencyMs)} ms`;
  const n = (v) => (v === null || v === undefined ? '–' : num(v));
  return rateCard('pressure', 'Latency and pressure', ms, 'per search', `${n(r.rejected)} rejected, ${n(r.breakerTrips)} breaker trips${r.writeQueue ? ` · write queue ${num(r.writeQueue)}` : ''}`);
}

/* ------------------------------------ row 4: SLM and ILM ------------------------------------ */

/** A lifecycle card: one heading line (the name, the operation pill, a note, a link) and ONE status line. */
function lifecycleCard(id, name, pill, note, link, line) {
  return h('section.card.ov-card.ov-lc', { dataset: { card: id } },
    h('div.ov-lc-h', h('b.ov-fact-t', name), h(`span.pill.${pill.tone}`, h('i.dot'), pill.word), note ? h('span.muted.ov-lc-note', note) : null, h('span.ov-spacer'), link),
    h('div.ov-lc-line', line));
}
const statusDot = (tone, text) => h(`span.q.${tone}.dotted`, h('i.qdot', { 'aria-hidden': 'true' }), text);

function slmCardEl(c, d) {
  const s = slmSummary(d, c, state.defaults);
  const link = canOpenPage('snapshots')
    ? h('a.ov-link', { href: '#/snapshots', onclick: (e) => { e.preventDefault(); navigateTo('snapshots', { view: 'summary' }, { cluster: c.id }); } }, 'Snapshots') : null;
  let line;
  if (s.kind === 'unused') line = h('span.muted', { title: s.why || null }, s.note || 'Logs archived by ULM');
  else if (s.kind === 'unknown' || s.kind === 'unread') line = h('span.muted', { title: s.why || null }, s.kind === 'unread' ? 'policies not readable' : (s.why || 'not readable'));
  else if (s.kind === 'stopped') line = statusDot('bad', 'SLM is stopped: nothing is snapshotted until it is started again');
  else if (s.kind === 'none') line = h('span', statusDot('bad', 'no policy'), h('span.muted', ` for ${s.note || 'the log indices'}`));
  else if (!s.status) line = h('span.muted', 'never ran');
  else {
    const bits = [s.at ? whenText(s.at) : null, s.durationMs !== null ? dur(s.durationMs) : null, s.indices !== null ? `${num(s.indices)} ${s.indices === 1 ? 'index' : 'indices'}` : null].filter(Boolean);
    line = h('span', statusDot(s.status === 'Success' ? 'ok' : 'bad', s.status.toLowerCase()), ' ', h('span', { title: s.at ? `${ago(s.at)} · ${dt(s.at)}` : null }, bits.join(' · ')));
  }
  return lifecycleCard('slm', 'SLM', s.pill, s.policy, link, line);
}

function ilmCardEl(c, d, idx) {
  const s = ilmSummary(d, c, state.defaults, idx);
  const link = canOpenPage('indices')
    ? h('a.ov-link', { href: '#/indices', onclick: (e) => { e.preventDefault(); navigateTo('indices', null, { cluster: c.id }); } }, 'Indices') : null;
  const note = s.managed === null ? null : `${num(s.managed)} ${s.managed === 1 ? 'index' : 'indices'} managed`;
  let line;
  if (!s.known) line = h('span.muted', { title: s.why || null }, s.pill.word === 'not read' ? 'not readable' : (s.why || 'not readable'));
  else if (s.state === 'none') line = h('span', statusDot('bad', 'no policy'), h('span.muted', ' for the log indices'));
  else {
    const stale = !s.stale.known ? h('span.muted', { title: s.stale.policy ? 'The index list has not been read yet.' : 'No live retention is set on this cluster (Edit cluster › Live retention).' }, s.stale.policy ? 'past retention: index list not read' : 'no retention set')
      : s.stale.count ? statusDot('warn', `${num(s.stale.count)} past ${s.stale.policy} retention`) : statusDot('ok', `none past ${s.stale.policy} retention`);
    const size = s.stale.known && s.stale.count ? h('span.muted', ` (${bytes(s.stale.bytes)})`) : null;
    const errs = s.errors === null ? h('span.muted', 'errors not known') : s.errors ? statusDot('bad', `${num(s.errors)} in error`) : h('span', `${num(s.errors)} in error`);
    line = h('span', stale, size, ' · ', errs);
  }
  return lifecycleCard('ilm', 'ILM', s.pill, note, link, line);
}

/* ------------------------------------ row 5: the two panels ------------------------------------ */

/** A panel's shell, kept for the visit: the title (the order on hover), a link at the right, and the scroll box the table goes in. */
function panelShell(key, link) {
  return P.get(`${key}:shell`, link ? 1 : 0, () => h('section.card.ov-card.ov-panel', { dataset: { card: key } },
    h('div.ov-panel-h', h('h2'), h('span.ov-spacer'), link),
    h('div.ov-panel-s')));
}
function fillPanel(shell, title, order, table) {
  const [head, scroll] = shell.children;
  if (head.firstChild.textContent !== title) head.firstChild.textContent = title;
  if (head.firstChild.title !== order) head.firstChild.title = order;
  mount(scroll, table);
}
const pageLink = (text, page, c) => (canOpenPage(page)
  ? h('a.ov-link', { href: `#/${page}`, onclick: (e) => { e.preventDefault(); navigateTo(page, null, { cluster: c.id }); } }, text)
  : null);

function nodesPanel(c, d) {
  const shell = panelShell('nodes-table', pageLink('All nodes', 'shards', c));
  const nodes = busiestFirst(d.nodes);
  const sig = `${objId(d.nodes)}|${objId(d.clusterSettings)}`;
  const table = P.get('nodes-table:tbl', `${sig}|${nodes.length}`, () => (!nodes.length
    ? empty('No node list yet')
    : h('table.tbl.ov-tbl',
      h('thead', h('tr', h('th', 'Name'), h('th', 'IP'), h('th.ov-bar-th', 'CPU'), h('th.ov-bar-th', 'Heap'), h('th.ov-bar-th', 'Disk'))),
      h('tbody', ...nodes.map((n) => P.get(`node:${n.name}`, `${sig}|${n.ip}|${n.cpu}|${n['heap.percent']}|${n['disk.used_percent']}|${n.master}`, () => nodeRow(n)))))));
  fillPanel(shell, `Nodes (${nodes.length})`, 'Busiest first: by CPU, then heap', table);
  return shell;
}
function nodeRow(n) {
  const isMaster = String(n.master || '').trim() === '*';
  const p = (v) => { const x = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(x) ? NaN : x; };
  const hf = heapFigures(n);
  return h('tr', { dataset: { node: n.name } },
    h('td.ov-node-name', h('span.mono', n.name), isMaster ? h('span.ov-master', { title: 'Elected master' }, 'master') : null),
    h('td.mono.ov-ip', n.ip || h('span.muted', '–')),
    h('td', usageBar(p(n.cpu), 'disk', `CPU ${n.cpu}%${n.load_1m ? ` · load ${n.load_1m} (1 m)` : ''}`)),
    h('td', usageBar(p(n['heap.percent']), 'heap', hf.current !== null && hf.max !== null ? `heap ${bytes(hf.current)} of ${bytes(hf.max)}` : `heap ${n['heap.percent']}%`)),
    h('td', usageBar(p(n['disk.used_percent']), 'disk', n['disk.used'] && n['disk.total'] ? `disk ${bytes(Number(n['disk.used']))} of ${bytes(Number(n['disk.total']))}` : `disk ${n['disk.used_percent']}%`)));
}

/** More rows than this are counted, not drawn: the panel is a glance, All indices is the list. */
const INDEX_ROWS = 300;
const HEALTH_CLASS = { red: 'bad', yellow: 'warn', green: 'ok' };
function indicesPanel(c, idx) {
  const shell = panelShell('indices-table', pageLink('All indices', 'indices', c));
  const rows = unhealthyFirst(idx);
  const sig = objId(idx);
  const table = P.get('indices-table:tbl', `${sig}|${rows.length}`, () => (!idx
    ? empty('The index list has not been read yet')
    : !rows.length ? empty('No indices')
    : h('table.tbl.ov-tbl',
      h('thead', h('tr', h('th', 'Index'), h('th', 'Health'), h('th.num', 'Docs'), h('th.num', 'Size'), h('th.num', 'Shards'))),
      h('tbody', ...rows.slice(0, INDEX_ROWS).map((r) => P.get(`idx:${r.index}`, `${sig}|${r.health}|${r.docs}|${r.size}|${r.pri}|${r.rep}`, () => indexRow(r))),
        rows.length > INDEX_ROWS ? h('tr.ov-more', h('td', { colspan: 5 }, h('span.muted', `…and ${num(rows.length - INDEX_ROWS)} more — All indices lists them`))) : null))));
  fillPanel(shell, `Indices (${idx ? num(idx.length) : '–'})`, 'Unhealthy first (red, then yellow), then by size', table);
  return shell;
}
function indexRow(r) {
  const hk = String(r.health || '').toLowerCase();
  const sh = indexShards(r);
  return h('tr', { dataset: { index: r.index } },
    h('td.mono.ov-idx-name', { title: r.index }, r.index),
    h('td', h(`span.q.${HEALTH_CLASS[hk] || 'ok'}`, hk ? hk[0].toUpperCase() + hk.slice(1) : h('span.muted', 'unknown'))),
    h('td.num', compact(r.docs)),
    h('td.num', bytes(r.size)),
    h('td.num', sh === null ? h('span.muted', '–') : num(sh)));
}
