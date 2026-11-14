/**
 * Clusters › Overview — one cluster's dashboard on ONE screen (the owner, 2026-11-14: "single page
 * view, no need to scroll anywhere"). The approved board, top to bottom:
 *
 *   1  the cluster (name, type · tags, Elasticsearch version, uuid; its health pill and
 *      "68 of 69 shards placed") · the Nodes card · the Indices card
 *   2  four gauges — CPU, Disk, JVM heap, Shards — each saying which node is highest, a ring at the right
 *   3  the open alerts for this cluster, with a way to the Alerts page showing it alone
 *   4  Search · Indexing · Latency and pressure (core/node-rates.js: two polls of _nodes/stats)
 *   5  Nodes (busiest first) beside Indices (unhealthy first, then by size): the rest of the height,
 *      each scrolling inside itself — the page never scrolls at 1280×720 and above (app.css .ov-*)
 *
 * It is a section of the Clusters page (pages/overview.js hands over here for #/clusters/overview);
 * the top bar's chooser is the one cluster choice. Arriving with "All clusters" the shell picks the
 * cluster last chosen, as the evidence pages do (app.js resolveSelection, this page's
 * `singleCluster`); an address that names a cluster moves the chooser (the shell's 'select-cluster').
 *
 * Everything is drawn from what the app already holds for the cluster (state.data: health, nodes,
 * allocation, settings; state.indices; state.shards when the Nodes & shards page read it; the alert
 * list). The one thing it asks for itself is the index list, which the Indices panel is. Pieces
 * are kept between redraws (lib/keyed.js): a push that changed nothing leaves what is under the
 * mouse alone.
 */

import { h, mount } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, compact, num } from '../lib/fmt.js';
import { ringGauge, STATUS } from '../lib/charts.js';
import { state, clusters, healthState, clusterRev, openAlertsNow, askForPage, fetchIndices, fetchedAt, bus } from '../core/state.js';
import { clusterKind } from '../core/cluster-kind.js';
import { navigateTo, canOpenPage } from '../core/intent.js';
import { openClusterAlerts } from '../core/alert-goto.js';
import { watermarks } from '../core/disk-balance.js';
import { unassignedByIndex, reasonWords } from '../core/cluster-boxes.js';
import { unreachableReason } from '../core/alert-groups.js';
import { LEVEL_TONE } from '../core/alert-levels.js';
import { nodeRates } from '../core/node-rates.js';
import { empty, usageBar } from './common.js';
import {
  OVERVIEW, LIST, overviewClusterOf, overviewHash, listHash, highestNode, heapFigures, gaugeLevel,
  busiestFirst, nodeCounts, shardFigures, placedText, unhealthyFirst, indexHealthCounts, indexTotals,
  indexShards, clusterAlerts, rateText, measured,
} from '../core/cluster-overview.js';

let host = null;
const P = nodeCache();
let offIndices = null;

/** The one cluster: the top bar's chooser, when it names a configured cluster. */
const pick = () => (state.selected && state.selected !== 'all' ? clusters().find((c) => c.id === state.selected) || null : null);

/* ------------------------------------ the tab row ------------------------------------ */

/**
 * List · Overview, under the page's title (the top bar's). Shared with the List (pages/overview.js
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
  P.clear();
  host = null;
}

/* ------------------------------------ asking ------------------------------------ */

/** The board's datasets, under a policy that fetches nothing unasked; and the index list, which no poller reads. */
const DATASETS = ['health', 'nodes', 'policies'];
const asked = new Map();
function ask() {
  const c = pick();
  if (!c || state.mode === 'snapshot') return;
  const last = asked.get(c.id) || 0;
  if (Date.now() - last < 30000) return;
  asked.set(c.id, Date.now());
  askForPage([c.id], DATASETS).catch(() => {});
  // The Indices panel: read when the page opens and when its list is over a minute old.
  const at = fetchedAt(c.id, 'indices') || 0;
  if (!state.indices.has(c.id) || Date.now() - at > 60000) fetchIndices(c.id).catch(() => {});
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
    const tabs = P.get('tabs', OVERVIEW, () => clustersTabs(OVERVIEW));
    if (!c) { mount(host, tabs, P.get('none', '', () => empty(clusters().length ? 'Pick a cluster in the top bar' : 'No clusters configured'))); return; }
    syncAddress(c);
    const d = state.data.get(c.id) || {};
    const idx = state.indices.has(c.id) ? state.indices.get(c.id) : null;
    const sh = state.shards.get(c.id) || null;
    const alerts = clusterAlerts(openAlertsNow(), c.id);
    const rates = nodeRates(c.id);
    const rev = `${clusterRev(c.id)}|${objId(d)}`;
    mount(host, tabs, h('div.ov-board',
      h('div.ov-row.ov-top',
        P.get('head', `${rev}|${objId(sh)}|${objId(c)}|${healthState(d)}`, () => headerCard(c, d, sh)),
        P.get('nodes', `${rev}|${objId(d.nodes)}`, () => nodesCard(d)),
        P.get('indices', `${rev}|${objId(idx)}`, () => indicesCard(idx))),
      h('div.ov-row.ov-gauges',
        P.get('g-cpu', `${rev}|${objId(d.nodes)}`, () => cpuGauge(d)),
        P.get('g-disk', `${rev}|${objId(d.nodes)}|${objId(d.clusterSettings)}`, () => diskGauge(d)),
        P.get('g-heap', `${rev}|${objId(d.nodes)}`, () => heapGauge(d)),
        P.get('g-shards', `${rev}|${objId(d.health)}`, () => shardsGauge(d))),
      P.get('alerts', `${alerts.count}|${alerts.worst}|${alerts.titles.join('|')}|${c.id}`, () => alertsLine(c, alerts)),
      h('div.ov-row.ov-rates',
        P.get('r-search', rateSig(rates, 'searchPerSec', 'sinceMs'), () => searchCard(rates)),
        P.get('r-index', rateSig(rates, 'indexPerSec', 'deletesPerSec'), () => indexingCard(rates)),
        P.get('r-pressure', rateSig(rates, 'searchLatencyMs', 'rejected', 'breakerTrips'), () => pressureCard(rates))),
      h('div.ov-row.ov-bottom',
        nodesPanel(c, d),
        indicesPanel(c, idx))));
  } finally { P.end(); }
}

const rateSig = (r, ...keys) => (!r ? 'none' : `${measured(r)}|${keys.map((k) => r[k]).join('|')}`);

/* ------------------------------------ row 1 ------------------------------------ */

const HEALTH_PILL = { green: 'green', yellow: 'yellow', red: 'red', unreachable: 'red', loading: 'grey' };
const HEALTH_WORD = { green: 'Green', yellow: 'Yellow', red: 'Red', unreachable: 'Unreachable', loading: 'loading' };

/** "1 replica unassigned · node left": from the shard table when the Nodes & shards page read it; else says what would tell. */
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

function headerCard(c, d, sh) {
  const st = healthState(d);
  const kind = clusterKind(c);
  const meta = [kind.label, ...(c.tags || [])].filter(Boolean).join(' · ');
  const version = d.info && d.info.version && d.info.version.number;
  const uuid = d.info && d.info.cluster_uuid;
  const why = st === 'unreachable' ? unreachableReason(state.clients.get(c.id)).label : '';
  return h('section.card.ov-card.ov-head', { dataset: { card: 'cluster' } },
    h('div.ov-head-main',
      h('h2.ov-name', { title: c.url }, c.name),
      h('span.ov-meta', meta),
      h('span.ov-version', version ? `Elasticsearch ${version}` : h('span.muted', 'Elasticsearch version not read')),
      h('span.ov-uuid.mono', { title: 'cluster uuid' }, uuid || '–')),
    h('div.ov-head-side',
      h(`span.pill.${HEALTH_PILL[st]}.ov-health`, { title: why || null }, h('i.dot'), HEALTH_WORD[st]),
      h('span.ov-placed.muted', placedText(shardFigures(d.health)) || (st === 'loading' ? 'health not read yet' : why || ''), unassignedLine(d, sh) ? [h('br'), unassignedLine(d, sh)] : null)));
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
      h('span.muted.ov-gauge-k', best ? 'Highest on' : 'Highest on'),
      h('span.ov-gauge-node', { title: best ? best.name : null }, best ? best.name : h('span.muted', 'not read yet')),
      h('span.muted.ov-gauge-c', caption)),
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

/* ------------------------------------ row 3: alerts ------------------------------------ */

function alertsLine(c, a) {
  const tone = a.worst ? LEVEL_TONE[a.worst] || 'yellow' : 'green';
  const link = a.count && canOpenPage('alerts')
    ? h('a.ov-link', { href: '#/alerts', title: `Open the Alerts page, showing ${c.name} only`, onclick: (e) => { e.preventDefault(); openClusterAlerts(c.id); } }, 'Open in Alerts')
    : null;
  return h('section.card.ov-card.ov-alerts', { dataset: { card: 'alerts', tone }, role: 'status' },
    h(`i.ov-alert-dot.${tone}`, { 'aria-hidden': 'true' }),
    h('b.ov-alerts-n', a.count ? `${a.count} open alert${a.count === 1 ? '' : 's'}` : 'No open alerts'),
    h('span.ov-alerts-t.sec', a.titles.join(' · ')),
    h('span.ov-spacer'),
    link);
}

/* ------------------------------------ row 4: rates ------------------------------------ */

/** A rate card: the title, the big figure with its unit, a line under it. Before two polls: "measuring" and when the next one lands. */
function rateCard(id, title, big, unit, sub) {
  return h('section.card.ov-card.ov-rate', { dataset: { card: id } },
    h('b.ov-fact-t', title),
    h('span.ov-rate-v', h('b', big), ' ', h('span.muted', unit)),
    h('span.muted.ov-fact-s', sub));
}
const MEASURING = 'measuring · next poll';
const sinceText = (r) => (r && r.sinceMs ? ` (${Math.round(r.sinceMs / 60000) || '<1'} min)` : '');

function searchCard(r) {
  if (!measured(r)) return rateCard('search', 'Search', '–', 'req/s', MEASURING);
  return rateCard('search', 'Search', rateText(r.searchPerSec), 'req/s', `Average between the last two polls${sinceText(r)}`);
}
function indexingCard(r) {
  if (!measured(r)) return rateCard('indexing', 'Indexing', '–', 'docs/s', MEASURING);
  return rateCard('indexing', 'Indexing', rateText(r.indexPerSec), 'docs/s', `${rateText(r.deletesPerSec)} deletes/s`);
}
function pressureCard(r) {
  if (!measured(r)) return rateCard('pressure', 'Latency and pressure', '–', 'per search', MEASURING);
  const ms = r.searchLatencyMs === null || r.searchLatencyMs === undefined ? '–' : `${Math.round(r.searchLatencyMs)} ms`;
  const n = (v) => (v === null || v === undefined ? '–' : num(v));
  return rateCard('pressure', 'Latency and pressure', ms, 'per search', `${n(r.rejected)} rejected, ${n(r.breakerTrips)} breaker trips${r.writeQueue ? ` · write queue ${num(r.writeQueue)}` : ''}`);
}

/* ------------------------------------ row 5: the two panels ------------------------------------ */

/** A panel's shell, kept for the visit: the title, a link at the right, the caption, and the scroll box the table goes in. */
function panelShell(key, link) {
  return P.get(`${key}:shell`, link ? 1 : 0, () => h('section.card.ov-card.ov-panel', { dataset: { card: key } },
    h('div.ov-panel-h', h('h2'), h('span.ov-spacer'), link),
    h('div.ov-panel-c.muted'),
    h('div.ov-panel-s')));
}
function fillPanel(shell, title, caption, table) {
  const [head, cap, scroll] = shell.children;
  if (head.firstChild.textContent !== title) head.firstChild.textContent = title;
  if (cap.textContent !== caption) cap.textContent = caption;
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
      h('thead', h('tr', h('th', 'Name'), h('th.ov-bar-th', 'CPU'), h('th.ov-bar-th', 'Heap'), h('th.ov-bar-th', 'Disk'))),
      h('tbody', ...nodes.map((n) => P.get(`node:${n.name}`, `${sig}|${n.cpu}|${n['heap.percent']}|${n['disk.used_percent']}|${n.master}`, () => nodeRow(n)))))));
  fillPanel(shell, `Nodes (${nodes.length})`, nodes.length ? `All ${nodes.length}, busiest first.` : 'The node list has not been read.', table);
  return shell;
}
function nodeRow(n) {
  const isMaster = String(n.master || '').trim() === '*';
  const p = (v) => { const x = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(x) ? NaN : x; };
  const hf = heapFigures(n);
  return h('tr', { dataset: { node: n.name } },
    h('td.ov-node-name', h('span.mono', n.name), isMaster ? h('span.ov-master', { title: 'Elected master' }, 'master') : null),
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
  fillPanel(shell, `Indices (${idx ? num(idx.length) : '–'})`, idx ? (rows.length ? `All ${num(rows.length)}, unhealthy first, then by size.` : 'This cluster has no indices.') : 'The index list has not been read yet.', table);
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
