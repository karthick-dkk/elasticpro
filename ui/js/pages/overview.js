/** Page 1 — cluster overview: URL, name, disk, ILM/SLM, repositories and last snapshot. */

import { h, mount, clear, reconcile } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, num, compact, pct, ago, dt, toCsv, download, healthClass } from '../lib/fmt.js';
import { state, bus, clusters, activeClusters, client, fetchOverview, healthState, refreshAll, alerts, cachedAlerts, requestsFor, requestLoad, jvmSummary, clusterRev } from '../core/state.js';
import { hbarList, usageMeter } from '../lib/charts.js';
import { card, collapsible, pill, statTile, table, connectionBanner, diskCell, lastSnapshotOf, snapshotPill, snapshotStatusByKey, empty } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { navigateTo } from '../core/intent.js';
import { inZabbix } from '../core/embed.js';
import { measureRepoBytes } from '../core/volume.js';
import { repoSizeCache } from '../lib/idb.js';

let host = null;
const expanded = new Set();

/** Sort keys, each pulling one comparable value out of a {c, d, cl} row. */
const SORTS = {
  name:     { label: 'Cluster name',  get: (r) => r.c.name.toLowerCase() },
  size:     { label: 'Cluster size',  get: (r) => clusterSize(r) },
  health:   { label: 'Health',        get: (r) => healthRank(r) },
  disk:     { label: 'Disk used %',   get: (r) => (r.d.disk && isFinite(r.d.disk.percent) ? r.d.disk.percent : -1) },
  diskFree: { label: 'Disk free',     get: (r) => (r.d.disk ? (r.d.disk.total || 0) - (r.d.disk.used || 0) : -1) },
  nodes:    { label: 'Nodes',         get: (r) => (r.d.health && r.d.health.number_of_nodes) || -1 },
  shards:   { label: 'Shards',        get: (r) => (r.d.health && r.d.health.active_shards) || -1 },
  unassign: { label: 'Unassigned',    get: (r) => (r.d.health && r.d.health.unassigned_shards) || 0 },
  version:  { label: 'Version',       get: (r) => versionKey(r) },
  jdk:      { label: 'JDK',           get: (r) => jvmSummary(r.d.nodes).text },
  snapshot: { label: 'Last snapshot', get: (r) => { const s = lastSnapshotOf(r.d); return s ? s.start : 0; } },
  alerts:   { label: 'Open alerts',   get: (r) => (alertCounts || alertsByCluster()).get(r.c.id) || 0 },
  ilm:      { label: 'ILM',           get: (r) => String((r.d.ilm && r.d.ilm.operation_mode) || 'zz') },
  slm:      { label: 'SLM',           get: (r) => String((r.d.slmStatus && r.d.slmStatus.operation_mode) || 'zz') },
  repo:     { label: 'Repository',    get: (r) => ((r.d.repos || []).map((x) => x.name).join(', ') || 'zz') },
  reqs:     { label: 'Our reqs/5m',   get: (r) => ((requestLoad.clusters[r.c.id] || {}).last5m || 0) },
};

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

/** "8.13.4" -> 8.000013.000004, so 8.9 sorts below 8.13. */
function versionKey(r) {
  const v = (r.d.info && r.d.info.version && r.d.info.version.number) || '';
  const p = v.split('.').map((x) => parseInt(x, 10) || 0);
  return (p[0] || 0) * 1e12 + (p[1] || 0) * 1e6 + (p[2] || 0);
}

/** Per-cluster alert counts for the draw in progress — one walk, not one per comparison. */
let alertCounts = null;
function alertsByCluster() {
  const m = new Map();
  cachedAlerts().forEach((a) => { if (a.cluster) m.set(a.cluster.id, (m.get(a.cluster.id) || 0) + 1); });
  return m;
}

export function render(el) { host = el; el.classList.add('dense'); draw(); }
export function onData() { if (host && host.isConnected) draw(); }

/** Search and sort are applied to the table and charts alike, so they stay in step. */
function visibleRows(all) {
  let rows = all;

  const t = ui.text.trim().toLowerCase();
  if (t) {
    rows = rows.filter(({ c, d }) => {
      const version = (d.info && d.info.version && d.info.version.number) || '';
      const repos = (d.repos || []).map((r) => r.name).join(' ');
      const hay = `${c.name} ${c.url} ${(c.tags || []).join(' ')} ${c.via || ''} ${version} ${repos}`;
      return hay.toLowerCase().includes(t);
    });
  }

  if (ui.only === 'problems') rows = rows.filter((r) => !r.d.reachable || (r.d.health && r.d.health.status !== 'green'));
  else if (ui.only === 'offline') rows = rows.filter((r) => r.d.updatedAt && !r.d.reachable);
  else if (ui.only === 'online') rows = rows.filter((r) => r.d.reachable);

  const get = (SORTS[ui.sort] || SORTS.name).get;
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * ui.dir;
    return String(av).localeCompare(String(bv)) * ui.dir;
  });
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
/** The rows on screen, for the buttons of a card kept from an earlier draw. */
let lastRows = [];

/** Everything a cluster's row is drawn from. */
function rowSig(r) {
  const q = requestsFor(r.c.id);
  return [clusterRev(r.c.id), objId(r.d), objId(r.cl), r.cl && r.cl.state, objId(r.c), expanded.has(r.c.id),
    (alertCounts && alertCounts.get(r.c.id)) || 0, q.last5m, q.perMinute.toFixed(1), minute(), objId(state.defaults),
    objId(state.indices.get(r.c.id))].join('|');
}

function draw() {
  alertCounts = alertsByCluster();
  const list = activeClusters();
  const all = list.map((c) => ({ c, d: state.data.get(c.id) || {}, cl: client(c.id) }));
  const rows = visibleRows(all);
  lastRows = rows;
  for (const r of all) r.sig = rowSig(r);
  built.begin();

  const shownSig = rows.map((r) => `${r.c.id}:${r.sig}`).join(',');
  mount(host,
    alertsSummary(),
    tiles(all),
    built.get('toolbar', [!!ui.text, ui.sort, ui.dir, ui.only, all.length, rows.length].join('|'), () => toolbar(all, rows)),
    summaryCard(rows, all),
    built.get('charts', `${shownSig}|${minute()}`,
      () => h('div.grid.c2', { style: { marginTop: '14px' } }, diskCard(rows), repoCard(rows))),
    built.get('unreachable', unreachableRows(rows).map((r) => `${r.c.id}:${r.sig}`).join(','),
      () => unreachableCard(rows))
  );
  built.end();
}

/**
 * Every unreachable cluster, one card instead of one banner each.
 *
 * A fleet of any size has a few clusters down at any given moment, and stacking a full
 * connectionBanner — certificate details, tunnel state, a Diagnose button that builds its
 * own panel — for each of them used to mean scrolling past a wall of red before reaching
 * the disk and repository charts below. The alert banner at the top of the page already
 * says a cluster is down; this is where you come to do something about ONE of them, so it
 * starts folded (see collapsible()'s own reasoning: a panel of controls is gone looking
 * for, not glanced at) and reuses connectionBanner's own Retry/Diagnose wiring unchanged.
 */
function unreachableCard(rows) {
  const bad = unreachableRows(rows);
  if (!bad.length) return null;
  const sub = nameList(bad.map((r) => r.c.name), 4);
  return h('div', { style: { marginTop: '14px' } },
    collapsible(`${bad.length} unreachable`, sub,
      () => h('div', { style: { display: 'grid', gap: '10px' } },
        ...bad.map((r) => connectionBanner(r.c, () => fetchOverview(r.c.id)))),
      { key: 'clusters-unreachable' }));
}

/**
 * A headline only — the full list, with its own filters and export, is the Alerts page.
 * The three most serious ones are shown so this page still says what is wrong.
 */
function alertsSummary() {
  // Inside Zabbix the problems are Zabbix's to show — Monitoring → Problems, the dashboard.
  if (inZabbix()) return null;
  const a = cachedAlerts();
  if (!a.length) return null;
  const crit = a.filter((x) => x.level === 'critical');
  const warn = a.filter((x) => x.level !== 'critical');
  const top = [...crit, ...warn].slice(0, 3);

  return h(`div.banner.${crit.length ? 'err' : 'warn'}`, { style: { marginBottom: '14px' } },
    h('div', { style: { minWidth: 0 } },
      h('div.ttl', `${a.length} open alert${a.length === 1 ? '' : 's'} — ${crit.length} critical, ${warn.length} warning`),
      h('div', { style: { display: 'grid', gap: '2px', marginTop: '3px' } },
        ...top.map((x) => h('div', { style: { fontSize: '12px' } },
          h('b', x.cluster ? `${x.cluster.name}: ` : ''), x.title,
          x.detail ? h('span.muted', ` — ${x.detail}`) : null)),
        a.length > top.length
          ? h('div.muted', { style: { fontSize: '11.5px' } }, `…and ${a.length - top.length} more`)
          : null)),
    h('div.acts', h('button.btn.sm.primary', { onclick: () => navigateTo('alerts') }, 'Open Alerts')));
}

/** Reachable was answered as "no": the one definition, shared with the unreachable card. */
function unreachableRows(rows) {
  return rows.filter((r) => healthState(r.d) === 'unreachable');
}

/** "a, b, c, +4 more" — every name when there are few, so a red cluster is named, not counted. */
function nameList(names, max = 6) {
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')}, +${names.length - max} more`;
}

/**
 * The fleet's health at a glance: how many clusters are in each state, which ones are red,
 * which ones cannot be reached, and what is going wrong most often. Disk, shards and
 * repositories are per-cluster detail — they are in the table and the charts below.
 *
 * A cluster whose health has not been read yet is "loading", never counted as green.
 */
function tiles(rows) {
  const down = unreachableRows(rows);
  const downIds = new Set(down.map((r) => r.c.id));
  const by = { green: [], yellow: [], red: [], unknown: [] };
  for (const r of rows) {
    if (downIds.has(r.c.id)) continue;
    const st = healthState(r.d);
    (by[st] || by.unknown).push(r);
  }
  const online = rows.length - down.length - by.unknown.length;

  // Most frequent problems first, grouped by what they are, so twenty clusters with the same
  // fault read as one line with a count rather than twenty lines.
  const groups = new Map();
  for (const a of cachedAlerts()) {
    const g = groups.get(a.title) || { title: a.title, critical: false, clusters: new Set() };
    g.critical = g.critical || a.level === 'critical';
    if (a.cluster) g.clusters.add(a.cluster.name);
    groups.set(a.title, g);
  }
  const top = [...groups.values()]
    .sort((x, y) => (y.critical - x.critical) || (y.clusters.size - x.clusters.size))
    .slice(0, 3);

  const healthLine = [
    `${by.green.length} green`, `${by.yellow.length} yellow`, `${by.red.length} red`,
    by.unknown.length ? `${by.unknown.length} loading` : null,
  ].filter(Boolean).join(' · ');

  return h('div.grid.c4.health-tiles', { style: { marginBottom: '14px' } },
    h(`div.stat${by.red.length || down.length ? '.bad' : ''}`,
      h('div.k', 'Cluster health'),
      h('div.v', `${online} / ${rows.length}`),
      h('div.d', healthLine)),
    h(`div.stat${by.red.length ? '.bad' : ''}`,
      h('div.k', 'Red clusters'),
      h('div.v', String(by.red.length)),
      h('div.d.names', by.red.length ? nameList(by.red.map((r) => r.c.name)) : 'none')),
    h(`div.stat${down.length ? '.bad' : ''}`,
      h('div.k', 'Unreachable'),
      h('div.v', String(down.length)),
      h('div.d.names', down.length ? nameList(down.map((r) => r.c.name)) : 'all reachable')),
    h(`div.stat${top.some((g) => g.critical) ? '.bad' : ''}`,
      h('div.k', 'Top errors'),
      top.length
        ? h('div.top-errs', ...top.map((g) => h('div',
            h(`span.dot.${g.critical ? 'crit' : 'warn'}`),
            h('span.t', g.title),
            g.clusters.size ? h('span.muted', ` · ${g.clusters.size} cluster${g.clusters.size === 1 ? '' : 's'}`) : null)))
        : h('div.d', 'no open alerts')));
}

function summaryCard(rows, all) {
  // Every column that means something sorts. Clicking the active one reverses it.
  const headers = [
    { label: 'Cluster', sort: 'name' },
    { label: 'Version', sort: 'version' },
    { label: 'JDK', sort: 'jdk' },
    { label: 'Health', sort: 'health' },
    { label: 'Nodes', sort: 'nodes' },
    { label: 'Size', num: true, sort: 'size' },
    { label: 'Disk usage', sort: 'disk' },
    { label: 'ILM', sort: 'ilm' },
    { label: 'SLM', sort: 'slm' },
    { label: 'Repository', sort: 'repo' },
    { label: 'Last snapshot', sort: 'snapshot' },
    { label: 'Alerts', sort: 'alerts' },
    { label: 'Our reqs/5m', num: true, sort: 'reqs' },
    '',
  ];
  const sortSpec = {
    key: ui.sort, dir: ui.dir,
    on: (key) => { ui.dir = ui.sort === key ? -ui.dir : 1; ui.sort = key; draw(); },
  };
  const byCluster = alertCounts || alertsByCluster();
  const trs = [];
  rows.forEach((r) => {
    trs.push(...built.get(`row:${r.c.id}`, r.sig || rowSig(r), () => rowNodes(r, byCluster, headers.length)));
  });

  const total = (all || rows).length;
  const scope = rows.length === total
    ? `${total} cluster${total === 1 ? '' : 's'}`
    : `${rows.length} of ${total} clusters`;
  const sub = `${scope} · sorted by ${(SORTS[ui.sort] || SORTS.name).label.toLowerCase()} · ` +
    (isSnapshotMode() ? `collected ${ago(state.lastRefresh)}` : `updated ${ago(state.lastRefresh)}`);
  // Its own height-limited scroll box (see .cluster-tbl-scroll in app.css): at a hundred-
  // odd rows this table is taller than the window, and without this its horizontal
  // scrollbar and its sticky <th> both end up below the fold — the exact controls you need
  // to deal with a table too big to see at once, hidden by that same bigness.
  //
  // The card, its header row and its scroll box are kept between draws (they change only
  // with the sort or the row count); the rows are put into the kept <tbody> as they are.
  let fresh = false;
  const shell = built.get('summary', [ui.sort, ui.dir, total, rows.length === 0, isSnapshotMode()].join('|'), () => {
    fresh = true;
    const wrap = table(headers, trs, { emptyText: total ? 'No cluster matches the search' : 'No clusters configured', sort: sortSpec });
    wrap.classList.add('cluster-tbl-scroll');
    return card('Cluster summary', sub, wrap,
      [h('button.btn.sm', { onclick: () => exportSummary(lastRows) }, 'Export CSV'),
       isSnapshotMode() ? null : h('button.btn.sm', { onclick: () => refreshAll({ force: true, selected: true }) }, 'Refresh')]);
  });
  if (!fresh) {
    if (rows.length) reconcile(shell.querySelector('tbody'), trs);
    const subEl = shell.firstChild && shell.firstChild.querySelector('.sub');
    if (subEl && subEl.textContent !== sub) subEl.textContent = sub;
  }
  return shell;
}

/** One cluster's row, and its details row when it is expanded. */
function rowNodes(r, byCluster, colspan) {
    const out = [];
    const { c, d, cl } = r;
    const snap = lastSnapshotOf(d);
    const repoNames = (d.repos || []).map((x) => x.name);
    const stateLbl = !d.updatedAt ? 'loading' : d.reachable ? (d.health && d.health.status) || 'unknown'
      : cl && cl.state === 'auth_error' ? 'auth error' : cl && cl.state === 'tls_error' ? 'cert/TLS' : cl && cl.state === 'tunnel_error' ? 'jump host' : 'offline';

    out.push(h('tr',
      // One line per cluster, not three: the URL and the tags used to each get their own
      // row under the name, which was the single biggest thing making this table taller
      // than the window on a real fleet. Both are still here — in the tooltip — rather
      // than gone; a click still gets you there, it just does not cost vertical space
      // every row pays whether or not anyone is reading it.
      h('td.trunc', {
        style: { maxWidth: '220px', fontWeight: 650, cursor: 'help' },
        title: `${c.url}${c.tags && c.tags.length ? '\n' + c.tags.join(', ') : ''}`,
      }, c.name),
      h('td.mono', (d.info && d.info.version && d.info.version.number) || '–'),
      // The JVM the nodes run on. A cluster mid-upgrade has more than one, and saying
      // "mixed" with the breakdown on hover beats picking whichever node answered first.
      (() => {
        const j = jvmSummary(d.nodes);
        return h('td.mono', { title: j.detail, style: { fontSize: '11.5px' } },
          j.text === 'unknown' ? h('span.muted', 'unknown')
            : j.mixed ? pill(j.text, 'yellow')
            : j.text);
      })(),
      h('td', pill(stateLbl, d.reachable ? healthClass(d.health && d.health.status) : 'red'),
        // Where the figure came from, when it is Zabbix's measurement rather than this tab's.
        d.fromZabbix && d.fromZabbix.parts.includes('health')
          ? h('div.muted', { style: { fontSize: '10.5px' }, title: 'Measured by Zabbix, not by this app — so Elasticsearch is not asked again' },
              `via Zabbix \u00b7 ${d.fromZabbix.healthAge === null ? 'age unknown' : `${Math.round(d.fromZabbix.healthAge)}s ago`}`)
          : null),
      h('td.num', d.health ? `${d.health.number_of_nodes} (${d.health.number_of_data_nodes} data)` : '–'),
      h('td.num', { title: 'Store size of the indices on this cluster' },
        clusterSize({ c, d }) >= 0 ? bytes(clusterSize({ c, d })) : h('span.muted', '–')),
      h('td', diskCell(d.disk)),
      h('td', d.ilm ? pill(d.ilm.operation_mode, d.ilm.operation_mode === 'RUNNING' ? (d.ilmErrorCount ? 'yellow' : 'green') : 'yellow') : h('span.muted', '–'),
        d.ilmErrorCount ? h('div.muted', { style: { fontSize: '11px' } }, `${d.ilmErrorCount} in error`) : null),
      h('td', d.slmStatus ? pill(d.slmStatus.operation_mode, d.slmStatus.operation_mode === 'RUNNING' ? 'green' : 'yellow') : h('span.muted', d.slmSupported === false ? 'n/a' : '–'),
        (d.slm || []).length ? h('div.muted', { style: { fontSize: '11px' } }, `${d.slm.length} polic${d.slm.length > 1 ? 'ies' : 'y'}`) : null),
      h('td', repoNames.length
        ? h('div', { style: { display: 'grid', gap: '2px' } }, ...repoNames.slice(0, 3).map((n) => h('span.mono', { style: { fontSize: '11.5px' } }, n)),
            repoNames.length > 3 ? h('span.muted', { style: { fontSize: '11px' } }, `+${repoNames.length - 3} more`) : null)
        : h('span.muted', 'none')),
      h('td', snapshotPill(snap)),
      h('td', byCluster.get(c.id)
        ? h('button.btn.sm.ghost', { title: 'Show these on the Alerts page', onclick: () => navigateTo('alerts') },
            pill(String(byCluster.get(c.id)), 'yellow'))
        : h('span.muted', '–')),
      // Requests THIS app sent to the cluster — its share of the cluster's load.
      h('td.num', { title: `${requestsFor(c.id).perMinute.toFixed(1)} per minute · ${requestsFor(c.id).perSecond.toFixed(2)} per second, over the last ${Math.round(requestLoad.windowSec / 60)} minutes` },
        h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, String(requestsFor(c.id).last5m)),
        h('span.muted', { style: { fontSize: '10.5px' } }, ` · ${requestsFor(c.id).perMinute.toFixed(1)}/min`)),
      // A real button, not a ghost that reads as a label: this is the control people go
      // looking for when a row raises a question, and it was the quietest thing in the
      // row. The chevron says which way it goes; aria-expanded says it to a reader.
      h('td', h('button.btn.sm', {
        'aria-expanded': expanded.has(c.id) ? 'true' : 'false',
        title: expanded.has(c.id) ? `Collapse ${c.name}` : `Expand ${c.name} — nodes, disk, repositories`,
        onclick: () => { expanded.has(c.id) ? expanded.delete(c.id) : expanded.add(c.id); draw(); },
      }, h('span', { style: { marginRight: '5px' } }, expanded.has(c.id) ? '\u25be' : '\u25b8'),
         expanded.has(c.id) ? 'Hide details' : 'Details'))));

    if (expanded.has(c.id)) out.push(h('tr', h('td', { colspan, style: { background: 'var(--surface-2)' } }, detail(c, d))));
    return out;
}

function detail(c, d) {
  const repos = d.repos || [];
  const box = h('div', { style: { display: 'grid', gap: '12px', padding: '4px 0' } });

  // JDK, SLM and our own request rate live in the summary table too, but that table hides
  // those three columns below 1500px (app.css) to stay narrow enough to read without a
  // horizontal scroll — this is where they land instead, so the figure is never gone,
  // only moved. Same jvmSummary/requestsFor calls the column uses, so the two cannot
  // disagree about what "mixed" or "12/min" means.
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

function diskCard(rows) {
  const items = rows.filter((r) => r.d.disk).map((r) => ({
    key: r.c.id, label: r.c.name, value: r.d.disk.used,
    sub: `${pct(r.d.disk.percent)} of ${bytes(r.d.disk.total)}`,
    // Same thresholds and the same meaning as the DISK USAGE meter in the table above,
    // so the same colours. This used to fall back to --series-1 (a categorical chart hue)
    // for "normal", which put green in the table and blue in the chart for one measure.
    color: r.d.disk.percent >= state.defaults.diskCritPercent ? 'var(--critical)'
      : r.d.disk.percent >= state.defaults.diskWarnPercent ? 'var(--warning)' : 'var(--good)',
  }));
  const body = items.length
    ? h('div', hbarList(items, { format: bytes, topN: 14, labelWidth: 140 }),
        h('div.legend',
          h('span', h('i', { style: { background: 'var(--good)' } }), 'normal'),
          h('span', h('i', { style: { background: 'var(--warning)' } }), `≥ ${state.defaults.diskWarnPercent}% used`),
          h('span', h('i', { style: { background: 'var(--critical)' } }), `≥ ${state.defaults.diskCritPercent}% used`)))
    : empty('No allocation data');
  return card('Disk used by cluster', 'from _cat/allocation', body);
}

function repoCard(rows) {
  const items = [];
  rows.forEach((r) => (r.d.repos || []).forEach((rp) => {
    const snaps = (r.d.snapshots && r.d.snapshots[rp.name]) || [];
    items.push({ key: `${r.c.id}/${rp.name}`, label: `${r.c.name} / ${rp.name}`, value: snaps.length,
      sub: `${rp.type} · ${rp.location || 'n/a'}` });
  }));
  return card('Snapshots per repository', 'count of snapshots currently in each repository',
    items.length ? hbarList(items, { format: num, topN: 12, labelWidth: 190 }) : empty('No repositories'));
}

function exportSummary(rows) {
  const data = rows.map(({ c, d }) => {
    const s = lastSnapshotOf(d);
    return {
      cluster: c.name, url: c.url, version: (d.info && d.info.version && d.info.version.number) || '',
      // Same definition the column uses, so the file and the screen cannot disagree
      // about whether a cluster is mid-upgrade.
      jdk: jvmSummary(d.nodes).text,
      jdk_detail: jvmSummary(d.nodes).detail,
      health: (d.health && d.health.status) || 'offline',
      nodes: (d.health && d.health.number_of_nodes) || 0,
      cluster_size_bytes: Math.max(0, clusterSize({ c, d })),
      our_requests_last_5m: requestsFor(c.id).last5m,
      disk_used_bytes: (d.disk && d.disk.used) || 0,
      disk_total_bytes: (d.disk && d.disk.total) || 0,
      disk_percent: d.disk && isFinite(d.disk.percent) ? d.disk.percent.toFixed(2) : '',
      ilm: (d.ilm && d.ilm.operation_mode) || '',
      slm: (d.slmStatus && d.slmStatus.operation_mode) || '',
      repositories: (d.repos || []).map((r) => r.name).join('|'),
      repo_locations: (d.repos || []).map((r) => r.location).join('|'),
      last_snapshot: s ? s.id : '', last_snapshot_status: s ? s.status : '',
      last_snapshot_at: s ? new Date(s.start).toISOString() : '',
    };
  });
  download(`es-cluster-summary-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(data), 'text/csv');
}
