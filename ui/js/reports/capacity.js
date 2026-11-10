/**
 * Reports › Capacity & retention (docs/REPORTS.md, board 4): the Storage plan, one row per
 * cluster, and — behind the Plan / Every parameter / Client plan switch — the full sheet and
 * the client plan the Volume report page used to show.
 *
 * The plan row is core/volume.js storagePlanRow, fed perDayEventBytes (core/volume-daily.js)
 * and dataNodeDisk (core/volume.js) through reports/record.js clusterFigures — the same row
 * the Overview reads its "fits / short by" from. The sheet views are volumeReport() with the
 * same two figures, so every size here is event_logsize and every disk is data nodes.
 */

import { h, mount, $ } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, toCsv, download, plural } from '../lib/fmt.js';
import { state, client, fetchIndices, ensureFullSnapshots, demandDataset, fleetMode, isOnDemand, clusterRev } from '../core/state.js';
import { runBounded } from '../core/fleet.js';
import { card, snapshotStatusByKey } from '../pages/common.js';
import { volumeReport, reportRows, SHEET_COLUMNS, CLIENT_COLUMNS, sheetCell, measureRepoBytes, liveHeldDays, parseRetention } from '../core/volume.js';
import { utcDay } from '../core/volume-daily.js';
import { popover } from '../ui/menu.js';
import { repoSizeCache } from '../lib/idb.js';
import { sharePut } from '../play/api.js';
import { columnsMenu } from '../lib/columns.js';
import { clusterFigures, repoBytes, RATE_DAYS, recordState } from './record.js';
import { layoutOf, setLocalLayout, layoutNote, canShare, shareWhy, shareLayout } from './layouts.js';
import { layoutTable, layoutCsv, layoutSortCols } from './table.js';
import { tableSort, sortTh } from '../lib/table-sort.js';
import { amber, muted, tag, loading, diskBar, gbCell } from './cells.js';

const TABLE = 'capacity';
const ui = { view: 'plan', measuring: new Set() };
let redraw = () => {};
// The Storage plan opens in the order the clusters are picked in; the two sheets by cluster name.
const PLAN_SORT = tableSort('reports.capacity.plan', { onChange: () => redraw() });
const SHEET_SORT = tableSort('reports.capacity.sheet', { initial: { key: 'Cluster name', dir: 1 }, onChange: () => redraw() });

/* ----------------------------------- the data ----------------------------------- */

/**
 * The Storage plan's Live retention column needs the index list, and the sheet views the
 * snapshot listing with index names. Bounded, as the Volume report page asked for them.
 */
async function ensureIndices(list) {
  if (fleetMode() && list.length > 1 && isOnDemand('indices')) return;
  if (list.length > 2) {
    const ids = list.map((c) => c.id);
    const [a, b] = await Promise.all([
      demandDataset(ids, 'snapshots_full').catch(() => false),
      demandDataset(ids, 'indices').catch(() => false),
    ]);
    if (a && b) return;
  }
  await runBounded(list, async (c) => {
    await ensureFullSnapshots(c.id).catch(() => {});
    if (state.indices.get(c.id)) return;
    try { await fetchIndices(c.id, '*'); } catch (_) { /* the row says it has no data */ }
  }, { limit: 6 });
  redraw();
}
let asked = '';
/** Called when the section is shown; asks once per visit and set of clusters. */
export function capacityArrive(list, redrawFn) {
  redraw = redrawFn || redraw;
  const sig = list.map((c) => c.id).join(',');
  if (sig === asked) return;
  asked = sig;
  ensureIndices(list);
}
export function capacityReset() { asked = ''; }

/**
 * Repository size is not a number Elasticsearch reports: the sum of each snapshot's
 * incremental bytes, one _status call per snapshot, behind a button and cached per snapshot
 * (core/volume.js measureRepoBytes, the Clusters page's same figure).
 */
async function measureRepos(c) {
  const cl = client(c.id);
  const d = state.data.get(c.id) || {};
  ui.measuring.add(c.id); redraw();
  let counted = 0, failed = 0;
  const cache = repoSizeCache(c.id);
  try {
    await cache.ready;
    const m = await measureRepoBytes(cl, d, { cache: cache.map });
    ({ counted, failed } = m);
    if (m.total !== null) repoBytes.set(c.id, m.total);
    if (m.total !== null) sharePut('repoSize', c.id, Date.now(), { bytes: m.total, counted: m.counted, failed: m.failed }).catch(() => {});
    await cache.flush((key) => snapshotStatusByKey(d, key));
  } finally {
    ui.measuring.delete(c.id);
    redraw();
  }
  if (failed) {
    const el = $('#rp-cap-msg');
    if (el) mount(el, h('div.banner.warn', `${c.name}: ${counted} snapshot(s) measured, ${failed} could not be read.`));
  }
}

/* --------------------------------- the storage plan --------------------------------- */

function rowOf(c) {
  const f = clusterFigures(c);
  const indices = state.indices.get(c.id);
  return { ...f, held: indices ? liveHeldDays(indices, f.data) : undefined };
}

const GROUP_LIVE = 'Live';
const GROUP_BACKUP = 'Archival / snapshot / backup';

/** The headroom in the "30% buffer" heading: per cluster, so a mixed selection says "+ buffer". */
function bufferLabel(rows) {
  const pcts = [...new Set(rows.map((r) => r.plan.headroomPercent))];
  return pcts.length === 1 ? `${pcts[0]}% buffer` : '+ buffer';
}

const waitingSize = (r) => (r.record ? amber('not measured', 'No event_logsize in the record for the last 7 days') : loading());

/** The Storage plan columns (docs/REPORTS.md table). Keys are what VOLUME_LAYOUT_SET table `capacity` stores. */
export function capacityDefs(rows = []) {
  const gb = (n) => `${n} (GB)`;
  return [
    { key: 'cluster', label: 'Cluster', locked: true, cell: (r) => h('b', r.cluster.name), csv: (r) => r.cluster.name },
    { key: 'perDay', label: 'Per day', num: true, title: `event_logsize per day, ${RATE_DAYS}-day average`,
      cell: (r) => (r.plan.perDay === null ? waitingSize(r) : bytes(r.plan.perDay)), csv: (r) => gbCell(r.plan.perDay), csvLabel: gb },
    { key: 'buffered', label: bufferLabel(rows), num: true, title: 'Per day × (1 + volumeHeadroomPercent ÷ 100)',
      cell: (r) => (r.plan.buffered === null ? waitingSize(r) : h('span', { title: `+${r.plan.headroomPercent}%` }, bytes(r.plan.buffered))),
      csv: (r) => gbCell(r.plan.buffered), csvLabel: gb },
    { key: 'liveRetention', label: 'Live retention', group: GROUP_LIVE, title: 'Days of live indices held now: from the oldest live index, or the ILM delete age',
      cell: (r) => (r.held === undefined ? loading()
        : r.held === null ? amber('not measured', 'No index name carries a date and no ILM delete phase applies')
          : h('span', { title: r.held.source === 'ILM' ? 'ILM delete age' : `oldest live index day ${r.held.from}` }, `${plural(Math.round(r.held.days), 'day')}${r.held.source === 'ILM' ? ' (ILM)' : ''}`)),
      csv: (r) => (r.held ? Math.round(r.held.days) : null), csvLabel: (n) => `${n} (days)`, sortType: 'number' },
    { key: 'livePolicy', label: 'Live retention policy', group: GROUP_LIVE, title: 'Set on the cluster by a person (Edit cluster › Live retention)',
      cell: (r) => (r.plan.livePolicy ? String(r.cluster.liveRetention) : amber('not set', 'Set liveRetention on the cluster')),
      csv: (r) => (r.plan.livePolicy ? String(r.cluster.liveRetention) : 'not set') },
    { key: 'liveDisk', label: 'Live disk (data nodes)', group: GROUP_LIVE, title: 'Disk on data nodes only: used of total',
      cell: (r) => (r.disk.measured ? diskBar(r.disk.used, r.disk.total, { what: 'Live disk on data nodes' }) : amber('not measured', r.disk.reason)),
      csv: (r) => (r.disk.measured ? `${gbCell(r.disk.used)} of ${gbCell(r.disk.total)} GB, ${gbCell(r.disk.avail)} GB avail` : 'not measured'),
      sortType: 'percent', sortValue: (r) => (r.disk.measured && r.disk.total ? (r.disk.used / r.disk.total) * 100 : null) },
    { key: 'liveRequired', label: 'Required live disk', num: true, group: GROUP_LIVE, title: 'Per day × live retention policy × buffer',
      cell: (r) => (r.plan.liveRequired !== null ? bytes(r.plan.liveRequired)
        : r.plan.livePolicy ? waitingSize(r) : amber('needs a policy', 'Set liveRetention on the cluster')),
      csv: (r) => gbCell(r.plan.liveRequired), csvLabel: gb },
    { key: 'liveShortfall', label: 'Live disk shortfall', group: GROUP_LIVE, title: 'Required live disk minus live disk total; none when it fits',
      cell: (r) => (r.plan.liveShortfall === null ? amber(r.plan.liveWhy === 'disk not measured' ? 'disk not measured' : r.plan.liveWhy || 'not measured', r.plan.liveWhy === 'disk not measured' ? r.disk.reason : null)
        : r.plan.liveShortfall > 0 ? h('b.rp-short', bytes(r.plan.liveShortfall)) : h('span.rp-none', 'none')),
      csv: (r) => (r.plan.liveShortfall === null ? r.plan.liveWhy : gbCell(r.plan.liveShortfall)), csvLabel: gb,
      sortType: 'bytes', sortValue: (r) => r.plan.liveShortfall },
    { key: 'backupPolicy', label: 'Backup policy', group: GROUP_BACKUP, title: 'Set on the cluster by a person: where backups go and how long they are kept',
      cell: (r) => backupPolicyText(r).node, csv: (r) => backupPolicyText(r).text },
    { key: 'backupDisk', label: 'Backup disk (repository)', group: GROUP_BACKUP, title: 'The snapshot repository: its size now against its capacity (backupCapacity)',
      cell: (r) => backupDiskCell(r),
      csv: (r) => (r.plan.ulm ? 'in S3' : r.plan.backupCapacity === null ? 'not measured · set backupCapacity'
        : r.plan.repoBytes === null ? `size not measured of ${gbCell(r.plan.backupCapacity)} GB`
          : `${gbCell(r.plan.repoBytes)} of ${gbCell(r.plan.backupCapacity)} GB`),
      sortType: 'bytes', sortValue: (r) => (r.plan.ulm ? null : r.plan.repoBytes) },
    { key: 'backupRequired', label: 'Required backup disk', num: true, group: GROUP_BACKUP, title: 'Per day × backup retention × buffer',
      cell: (r) => (r.plan.ulm ? muted('—', 'Archived to S3 by ULM') : r.plan.backupRequired !== null ? bytes(r.plan.backupRequired)
        : r.plan.backupPolicy ? waitingSize(r) : amber('needs a policy', 'Set snapshotRetention on the cluster')),
      csv: (r) => gbCell(r.plan.backupRequired), csvLabel: gb },
    { key: 'backupShortfall', label: 'Backup disk shortfall', group: GROUP_BACKUP, title: 'Required backup disk minus backup disk total; none when it fits',
      cell: (r) => (r.plan.ulm ? tag('ULM · S3') : r.plan.backupShortfall === null
        ? amber(r.plan.backupWhy === 'not measured' ? 'not measured' : 'not set', r.plan.backupWhy === 'no capacity' ? 'Set backupCapacity on the cluster' : r.plan.backupWhy === 'not set' ? 'Set snapshotRetention on the cluster' : null)
        : r.plan.backupShortfall > 0 ? h('b.rp-short', bytes(r.plan.backupShortfall)) : h('span.rp-none', 'none')),
      csv: (r) => (r.plan.ulm ? 'ULM · S3' : r.plan.backupShortfall === null ? (r.plan.backupWhy === 'not measured' ? 'not measured' : 'not set') : gbCell(r.plan.backupShortfall)),
      csvLabel: gb, sortType: 'bytes', sortValue: (r) => (r.plan.ulm ? null : r.plan.backupShortfall) },
  ];
}

/** Keys of the Storage plan, in their default order: what the core must accept for `capacity`. */
export const CAPACITY_KEYS = capacityDefs().map((d) => d.key);

function backupPolicyText(r) {
  const snap = parseRetention(r.cluster.snapshotRetention);
  if (r.plan.ulm) {
    const t = `ULM · S3 · ${snap ? String(r.cluster.snapshotRetention) : 'retention not set'}`;
    return { text: t, node: h('span', { title: r.kind.ulm.bucket ? `bucket ${r.kind.ulm.bucket}` : 'bucket not named' }, t) };
  }
  return snap ? { text: `Snapshot · ${r.cluster.snapshotRetention}`, node: `Snapshot · ${r.cluster.snapshotRetention}` }
    : { text: 'not set', node: amber('not set', 'Set snapshotRetention on the cluster') };
}

function backupDiskCell(r) {
  if (r.plan.ulm) return tag('in S3', 'grey', 'Archived to S3 by ULM: nothing here measures S3');
  if (r.plan.backupCapacity === null) return amber('not measured · set backupCapacity', 'Elasticsearch cannot say how big a repository is: set backupCapacity on the cluster, e.g. "8TB"');
  if (r.plan.repoBytes !== null) return diskBar(r.plan.repoBytes, r.plan.backupCapacity, { what: 'Backup repository' });
  const repos = (r.data && r.data.repos) || [];
  const measuring = ui.measuring.has(r.cluster.id);
  return h('span.rp-measure', amber(`size not measured · of ${bytes(r.plan.backupCapacity)}`),
    ' ', h('button.linkish', { type: 'button', disabled: measuring || !repos.length,
      title: repos.length ? 'Sum the incremental bytes of every snapshot — one call per snapshot' : 'No repository registered on this cluster',
      onclick: () => measureRepos(r.cluster) }, measuring ? 'Measuring…' : 'Measure'));
}

let menuState = null;
let menuBtn = null;

function planView(ctx, all) {
  const defs = capacityDefs(all);
  const rows = PLAN_SORT.apply(all, layoutSortCols(defs));
  const layout = layoutOf(TABLE);
  if (!menuState) {
    menuState = { id: 'rp-cols-capacity',
      onChange: (next) => setLocalLayout(TABLE, menuState.defs, next),
      onSave: (l) => shareLayout(TABLE, menuState.defs, l) };
  }
  Object.assign(menuState, { defs, layout, note: layoutNote(TABLE), canSave: canShare(TABLE), saveWhy: shareWhy(TABLE) });
  return card('Storage plan', `${plural(rows.length, 'cluster')} · daily rate from the ${RATE_DAYS}-day average of event_logsize`,
    layoutTable({ defs, layout, rows, band: true, cls: 'rp-plan', emptyText: 'No cluster is selected', sort: PLAN_SORT }),
    [menuBtn || (menuBtn = columnsMenu(menuState)),
      h('button#rp-capacity-csv.btn.sm', { type: 'button', onclick: () => exportPlan(defs, layout, rows) }, 'Export CSV')]);
}

function exportPlan(defs, layout, rows) {
  const { headers, rows: out } = layoutCsv(defs, layout, rows);
  download(`reports-storage-plan-${utcDay()}.csv`, toCsv(out, headers), 'text/csv');
}

/** The Storage plan as CSV for these clusters, as the layout has it (Exports). */
export function storagePlanCsv(clusters) {
  const rows = clusters.map(rowOf);
  return layoutCsv(capacityDefs(rows), layoutOf(TABLE), rows);
}

/* --------------------------------- the sheet views --------------------------------- */

const VIEWS = {
  sheet: { cols: () => SHEET_COLUMNS, title: 'Every parameter', file: 'reports-every-parameter' },
  client: { cols: () => CLIENT_COLUMNS, title: 'Client storage plan', file: 'reports-client-plan' },
};

/** volumeReport() on the Reports figures: the event_logsize rate and the data-node disk. */
export function reportsOf(clusters) {
  return clusters.map((c) => {
    const f = clusterFigures(c);
    return volumeReport(c, f.data, state.indices.get(c.id) || [], repoBytes.has(c.id) ? repoBytes.get(c.id) : null,
      { perDayBytes: f.perDay, disk: f.disk });
  });
}

/** The sheet's columns as sort columns (core/sort.js), by label: numbers as numbers, YES/NO as 1/0. */
const sheetSortCols = (col) => Object.fromEntries(col.map((c) => [c.label, { type: c.kind === 'text' ? 'text' : 'number', value: c.get }]));

function sortReports(reports, col) {
  return SHEET_SORT.apply(reports, sheetSortCols(col));
}

/** Each band label centred on the visible part of its section (see pages/volume.js history). */
function bandCentred(wrap) {
  const place = () => {
    if (!wrap.isConnected) { window.removeEventListener('resize', place); return; }
    const w = wrap.getBoundingClientRect();
    const frozen = wrap.querySelector('thead tr:not(.group-head) th.stick');
    const left = frozen ? frozen.getBoundingClientRect().right : w.left;
    for (const lab of wrap.querySelectorAll('.glabel')) {
      lab.style.transform = '';
      const cell = lab.parentElement.getBoundingClientRect();
      const lo = Math.max(cell.left, left), hi = Math.min(cell.right, w.right);
      if (hi <= lo) continue;
      const r = lab.getBoundingClientRect();
      const want = Math.min(Math.max((lo + hi) / 2 - r.width / 2, cell.left + 4), cell.right - r.width - 4);
      lab.style.transform = `translateX(${Math.round(want - r.left)}px)`;
    }
  };
  wrap.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', place);
  requestAnimationFrame(place);
  return wrap;
}

function columnInfo(c) {
  if (!c.help) return null;
  const mark = h('button.colinfo', {
    title: `What is "${c.label}"?`, type: 'button',
    onclick: (e) => {
      e.stopPropagation();
      mark.classList.add('on');
      popover(mark, () => [
        h('div', { style: { fontSize: '12px', lineHeight: '1.6' } }, c.help),
        c.note ? h('div.muted', { style: { fontSize: '11px', paddingTop: '5px', borderTop: '1px solid var(--border)' } },
          'Each cell also carries its own note on hover — what that particular number was built from.') : null,
      ], { title: c.label, sub: c.unit ? `in ${c.unit}` : '', width: '320px', onClose: () => mark.classList.remove('on') });
    },
  }, 'i');
  return mark;
}

function sheetView(reports, view) {
  const col = view.cols();
  const sorted = sortReports(reports, col);
  const groups = [];
  for (const c of col) {
    const last = groups[groups.length - 1];
    if (last && last.name === c.group) last.span++;
    else groups.push({ name: c.group, span: 1 });
  }
  const starts = new Set();
  groups.reduce((at, g) => { starts.add(at); return at + g.span; }, 0);
  const groupCells = [];
  groups.forEach((g, gi) => {
    if (gi > 0) { groupCells.push(h('th.gstart', { colspan: g.span }, h('span.glabel', g.name))); return; }
    groupCells.push(h('th.stick', { colspan: 1 }, g.name));
    if (g.span > 1) groupCells.push(h('th', { colspan: g.span - 1 }));
  });
  const head = h('thead',
    h('tr.group-head', ...groupCells),
    h('tr', ...col.map((c, i) => sortTh(SHEET_SORT, c.label, c.label, {
      cls: [i === 0 ? 'stick' : '', i > 0 && starts.has(i) ? 'gstart' : ''],
      title: `${c.group} — click to sort by this column`,
      after: [columnInfo(c), c.unit ? h('span.unit', c.unit) : null],
    }))));
  const body = h('tbody', ...sorted.map((r) => h('tr', ...col.map((c, i) => {
    const text = sheetCell(c, r);
    const cls = [i === 0 ? 'stick' : '', i > 0 && starts.has(i) ? 'gstart' : '', c.kind === 'num' ? 'num' : '',
                 c.kind === 'bool' ? (text === 'YES' ? 'yes' : text === 'NO' ? 'no' : 'unknown') : ''].filter(Boolean).join('.');
    const tip = (c.note && c.note(r)) || (text.length > 24 ? text : null);
    return h(cls ? `td.${cls}` : 'td', { title: tip }, text);
  }))));
  return card(view.title, `${plural(reports.length, 'cluster')} · one row each · click a header to sort · sizes are event_logsize, disk is data nodes`,
    bandCentred(h('div.sheet-wrap', h('table.sheet', head, body))),
    [h('button.btn.sm.primary', { type: 'button', onclick: () => exportWide(reports, view) }, 'Export CSV'),
      h('button.btn.sm', { type: 'button', title: 'One row per parameter, a column per cluster', onclick: () => exportTall(reports) }, 'Export as report layout')]);
}

/** The report layout: one row per parameter, a column per cluster. */
export function exportTall(reports) {
  if (!reports.length) return;
  const labels = reportRows(reports[0]).map(([l]) => l);
  const cols = reports.map((r) => {
    const m = new Map(reportRows(r).map(([l, v]) => [l, v]));
    return { name: r.cluster.name, get: (l) => m.get(l) };
  });
  const rows = labels.map((label) => {
    const out = { Parameter: label };
    for (const c of cols) out[c.name] = String(c.get(label) ?? '');
    return out;
  });
  download(`reports-storage-by-parameter-${utcDay()}.csv`, toCsv(rows), 'text/csv');
}

/** One row per cluster, one column per parameter of the view. */
export function exportWide(reports, view = VIEWS.sheet) {
  const rows = reports.map((r) => {
    const o = {};
    for (const c of view.cols()) o[c.unit ? `${c.label} (${c.unit})` : c.label] = sheetCell(c, r);
    o['Generated at'] = new Date().toISOString();
    return o;
  });
  download(`${view.file}-${utcDay()}.csv`, toCsv(rows), 'text/csv');
}
export { VIEWS as SHEET_VIEWS };

/* ------------------------------------- section ------------------------------------- */

/** @param ctx { clusters, redraw } */
export function capacitySection(ctx) {
  redraw = ctx.redraw || redraw;
  capacityArrive(ctx.clusters, ctx.redraw);
  const btn = (id, label, title) => h('button.btn.sm', {
    type: 'button', title, 'aria-pressed': ui.view === id ? 'true' : 'false',
    onclick: () => { if (ui.view !== id) { ui.view = id; redraw(); } },
  }, label);
  const seg = h('div.seg', { role: 'group', 'aria-label': 'Table' },
    btn('plan', 'Plan', 'The storage plan: what each cluster needs against what it has'),
    btn('sheet', `Every parameter (${SHEET_COLUMNS.length})`, `Every parameter — ${SHEET_COLUMNS.length} columns`),
    btn('client', `Client plan (${CLIENT_COLUMNS.length})`, `The client storage plan — ${CLIENT_COLUMNS.length} columns`));
  // Kept while nothing it is drawn from changed: the page redraws on every push from the
  // core, and a rebuilt sheet would close a column note open on its header (a popover closes
  // when its trigger leaves the page) and lose the sheet's scroll position.
  built.begin();
  const body = built.get(`view:${ui.view}`, dataSig(ctx.clusters), () => (ui.view === 'plan'
    ? planView(ctx, ctx.clusters.map(rowOf))
    : sheetView(reportsOf(ctx.clusters), VIEWS[ui.view] || VIEWS.sheet)));
  built.end();
  return h('div.rp-section', h('div.toolbar.rp-bar', seg), h('div#rp-cap-msg'), body);
}

const built = nodeCache();
/** Everything a view is drawn from, so a redraw with nothing new reuses the drawn table. */
function dataSig(list) {
  return [JSON.stringify(PLAN_SORT.sort), JSON.stringify(SHEET_SORT.sort), recordState.rev, layoutNote(TABLE), JSON.stringify(layoutOf(TABLE)), [...ui.measuring].join(','),
    ...list.map((c) => [c.id, clusterRev(c.id), objId(state.data.get(c.id)), objId(state.indices.get(c.id)), objId(c),
      repoBytes.has(c.id) ? repoBytes.get(c.id) : '-'].join(':')), new Date().toISOString().slice(0, 10)].join('|');
}
