/** Page — capacity: what each cluster ingests per day, and whether its storage matches
 *  the retention it promises. Exportable for the whole fleet. */

import { h, mount, $, activatable } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { bytes, num, ago, dt, toCsv, download, plural } from '../lib/fmt.js';
import { state, clusters, activeClusters, client, refreshAll, fetchIndices, ensureFullSnapshots, demandDataset, clusterRev } from '../core/state.js';
import { runBounded } from '../core/fleet.js';
import { card, collapsible, pill, table, empty, snapshotStatusByKey } from './common.js';
import { hbarList, capacityChart, usageMeter } from '../lib/charts.js';
import { volumeReport, reportRows, SHEET_COLUMNS, CLIENT_COLUMNS, sheetCell, gb, days as fmtDays, yesNo, measureRepoBytes } from '../core/volume.js';
import { navigateTo } from '../core/intent.js';
import { popover } from '../ui/menu.js';
import { repoSizeCache } from '../lib/idb.js';

let host = null;
const ui = { measuring: new Set(), view: 'summary', sort: 'name', dir: 1 };
/** Measured repository sizes, per cluster. Elasticsearch does not report this cheaply. */
const repoBytes = new Map();

/**
 * The grid views.
 *
 * Both render the same table from the same column definitions and differ only in which
 * columns they take, so a new view is an entry here rather than another renderer. The
 * CSV is generated from whichever list is on screen — the file a person gets is the
 * sheet they were looking at, not a second layout they have to reconcile with it.
 */
const VIEWS = {
  sheet: { cols: () => SHEET_COLUMNS, title: 'Volume resource report', file: 'volume-resource-report' },
  client: { cols: () => CLIENT_COLUMNS, title: 'Client storage plan', file: 'client-storage-plan' },
};
/** The summary table is its own renderer; its export is the full sheet. */
const activeView = () => VIEWS[ui.view] || VIEWS.sheet;

export function render(el) {
  host = el;
  el.classList.add('dense');
  // Values centred in every table on this page; see .vol-report in app.css.
  el.classList.add('vol-report');
  ensureIndices();
  draw();
}
export function onData() { if (host && host.isConnected) draw(); }

/**
 * The report needs the index list, which only the Indices page fetches otherwise, and the
 * snapshot listing WITH index names — the days of data a backup holds are read from them,
 * and the fleet cache's background listing (_cat) does not carry them. Bounded: on "All
 * clusters" this is every cluster, and each answer can be a fetch the core has to make.
 */
async function ensureIndices() {
  const list = activeClusters();
  // With the fleet cache and more than a couple of clusters: two messages for the whole
  // fleet rather than two held requests per cluster (see demandDataset in core/state.js).
  // The rows fill in as the core's answers are pushed; until then they say unknown.
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
    try { await fetchIndices(c.id, '*'); } catch (_) { /* the row will say it has no data */ }
  }, { limit: 6 });
  if (host && host.isConnected) draw();
}

/**
 * Everything one cluster's report is computed from. The report walks the cluster's whole
 * index list, and the page redraws on every push from the core: a hundred-odd reports
 * recomputed for each one that changed. Kept per cluster, recomputed when this changes.
 */
function reportSig(c) {
  return [clusterRev(c.id), objId(state.data.get(c.id)), objId(state.indices.get(c.id)), objId(c),
    repoBytes.has(c.id) ? repoBytes.get(c.id) : 'none', ui.measuring.has(c.id), new Date().toDateString()].join('|');
}
const reportCache = new Map();
function reportFor(c) {
  const sig = reportSig(c);
  const hit = reportCache.get(c.id);
  if (hit && hit.sig === sig) return hit.r;
  const r = volumeReport(c, state.data.get(c.id) || {}, state.indices.get(c.id) || [],
    repoBytes.has(c.id) ? repoBytes.get(c.id) : null);
  reportCache.set(c.id, { sig, r });
  return r;
}
/** Parts of the page kept between redraws (lib/keyed.js). */
const built = nodeCache();

function draw() {
  const list = activeClusters();
  if (!list.length) return mount(host, empty('No cluster selected'));
  const reports = list.map(reportFor);
  const sigs = list.map((c) => reportCache.get(c.id).sig);
  const allSig = sigs.join(',');
  built.begin();

  const viewBtn = (id, label, title) => h(`button.btn.sm${ui.view === id ? '.primary' : ''}`, {
    title, onclick: () => { ui.view = id; draw(); },
  }, label);

  mount(host,
    h('div.toolbar',
      h('span.muted', { style: { fontSize: '11.5px' } },
        `updated ${ago(state.lastRefresh)} · per-day volume from the dated indices, today excluded`),
      // Three buttons rather than a dropdown: there are three views, one is always on, and
      // which one is showing is then visible without opening anything.
      h('div', { style: { display: 'flex', gap: '4px' } },
        viewBtn('summary', 'Summary', 'One line per cluster — the figures that get asked for'),
        viewBtn('sheet', 'Full report', `Every parameter — ${SHEET_COLUMNS.length} columns`),
        viewBtn('client', 'Client plan', `The storage plan — ${CLIENT_COLUMNS.length} columns`)),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
        h('button.btn.sm', { onclick: () => refreshAll({ force: true, selected: true }) }, '↻ Refresh'),
        h('button.btn.sm.primary', {
          title: ui.view === 'summary'
            ? 'One row per cluster, every parameter as a column — the full report, not the summary above'
            : `One row per cluster, the ${activeView().cols().length} columns of this view`,
          onclick: () => exportWide(reports, activeView()),
        }, 'Export CSV'),
        h('button.btn.sm', {
          title: 'One row per parameter, a column per cluster — the report as it reads on screen',
          onclick: () => exportTall(reports),
        }, 'Export as report layout'))),

    built.get('grid', [ui.view, ui.sort, ui.dir, allSig].join('|'),
      () => (ui.view === 'summary' ? fleetTable(reports) : sheetView(reports, activeView()))),

    built.get('charts', allSig, () => h('div', 
      h('div.grid.c2', { style: { marginTop: '10px' } },
        collapsible('Daily volume by cluster', 'the figure every other number is built on',
          () => volumeChart(reports), { key: 'vol-chart', open: true }),
        collapsible('How long the free disk lasts', 'at each cluster\'s current daily rate',
          () => runwayChart(reports), { key: 'vol-runway', open: true })),
      h('div', { style: { marginTop: '10px' } },
        collapsible('Disk in use across the fleet', 'used against total, per cluster',
          () => usageList(reports), { key: 'vol-usage', open: true })))),

    ...reports.map((r, i) => built.get(`detail:${r.cluster.id}`, `${sigs[i]}|${reports.length === 1}`,
      () => h('div', { style: { marginTop: '10px' } },
        collapsible(`Volume resource report — ${r.cluster.name}`, r.cluster.url,
          () => clusterCardBody(r), { key: `vol-detail-${r.cluster.id}`, open: reports.length === 1 })))));
  built.end();
}

/* ------------------------------- fleet overview ------------------------------- */

function fleetTable(reports) {
  const trs = reports.map((r) => {
    const risk = r.liveRetentionMet === false ? 'red'
      : r.liveSufficientDays !== null && r.liveSufficientDays < 14 ? 'yellow' : 'green';
    return h('tr',
      h('td', h('div', { style: { fontWeight: 640 } }, r.cluster.name),
        h('div.mono.muted', { style: { fontSize: '10.5px' } }, r.cluster.url)),
      // No index list yet (it is still on its way from the core): the per-day figure is
      // unknown, and 0 GB/day would read as a cluster that ingests nothing.
      state.indices.has(r.cluster.id) ? h('td.num', gb(r.perDayGB)) : h('td.num', h('span.muted', { title: 'The index list has not arrived yet' }, 'Loading…')),
      state.indices.has(r.cluster.id) ? h('td.num', gb(r.bufferedGB)) : h('td.num', h('span.muted', '–')),
      h('td.num', gb(r.liveTotalGB)),
      h('td.num', r.livePct === null ? '–' : `${r.livePct.toFixed(1)}%`),
      h('td.num', h('span', { style: { color: risk === 'red' ? 'var(--critical)' : risk === 'yellow' ? 'var(--warning)' : 'inherit' } },
        fmtDays(r.liveSufficientDays))),
      h('td', r.liveRetention ? r.liveRetention.label : h('span.muted', 'not set')),
      h('td', r.liveRetentionMet === null ? h('span.muted', 'unknown')
        : pill(yesNo(r.liveRetentionMet), r.liveRetentionMet ? 'green' : 'red')),
      h('td.num', r.repoGB === null ? h('span.muted', 'not measured') : gb(r.repoGB)),
      h('td', r.snapshotRetention ? r.snapshotRetention.label : h('span.muted', 'not set')));
  });
  return card('Capacity by cluster', `${reports.length} cluster${reports.length === 1 ? '' : 's'}`,
    // Every numeric column is marked here as well as on the cell. The cells were already
    // td.num and right-aligned; the headers were plain strings, so each number sat under
    // the left edge of its own title and the whole table read as if the columns had
    // slipped. Marking one side only is the bug — table() aligns whatever it is told.
    table(['Cluster',
           { label: 'Per day', num: true },
           { label: '+30%', num: true },
           { label: 'Live total', num: true },
           { label: 'Used', num: true },
           { label: 'Lasts', num: true },
           'Live policy', 'Within policy',
           { label: 'Repo size', num: true },
           'Snapshot policy'],
      trs, {
        emptyText: empty('No cluster is selected, so there is nothing to report on.', {
          actions: [h('button.btn.sm', { onclick: () => navigateTo('settings') }, 'Add a cluster')],
        }),
      }));
}

/**
 * How long the free disk lasts, per cluster.
 *
 * The most actionable number on the page: it says which cluster needs attention first,
 * and roughly when. Coloured against the same thresholds the alerts use.
 */
function runwayChart(reports) {
  const items = reports
    .filter((r) => r.liveSufficientDays !== null && isFinite(r.liveSufficientDays))
    .map((r) => ({
      key: r.cluster.id, label: r.cluster.name, value: Math.floor(r.liveSufficientDays),
      color: r.liveSufficientDays < 14 ? 'var(--critical)'
        : r.liveSufficientDays < 45 ? 'var(--warning)' : 'var(--good)',
      sub: `${gb(r.liveFreeGB)} free at ${gb(r.perDayGB)}/day`,
    }));
  return items.length
    ? h('div', hbarList(items, { format: (v) => `${v} days`, topN: 20, labelWidth: 150, showOther: false }),
        legendFor([['var(--critical)', 'under 2 weeks'], ['var(--warning)', 'under 6 weeks'], ['var(--good)', 'comfortable']]))
    : empty('No disk figures yet — the clusters have not reported allocation.');
}

/** Used against total for every cluster, so a full one stands out without reading digits. */
function usageList(reports) {
  const withDisk = reports.filter((r) => r.liveTotalGB > 0);
  if (!withDisk.length) return empty('No disk figures yet.');
  return h('div', { style: { display: 'grid', gap: '10px' } },
    ...withDisk.map((r) => h('div', { style: { display: 'grid', gap: '3px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
        h('b', r.cluster.name),
        h('span.muted', `${gb(r.liveUsedGB)} of ${gb(r.liveTotalGB)} · ${gb(r.liveFreeGB)} free`)),
      usageMeter(r.liveUsedGB, r.liveTotalGB, { label: '', thick: true, format: gb,
        warn: state.defaults.diskWarnPercent, crit: state.defaults.diskCritPercent }))));
}

function legendFor(pairs) {
  return h('div.legend', ...pairs.map(([color, label]) => h('span', h('i', { style: { background: color } }), label)));
}

/**
 * Everything the cluster's disk has to hold, against the disk it has. The capacity marker
 * is the total; a bar past it is the amount of disk that would have to be bought.
 */
function liveFitChart(r) {
  if (!(r.liveTotalGB > 0)) return empty('No allocation data for this cluster.');
  const needs = [
    { label: 'Used right now', value: r.liveUsedGB, sub: 'what the indices occupy today' },
    r.requiredLiveGB
      ? { label: `Retention policy (${r.liveRetention.label})`, value: r.requiredLiveGB,
          sub: 'the stated policy at the buffered daily rate' }
      : null,
    { label: '30 days of indices', value: r.required30GB, sub: 'at the buffered daily rate' },
    { label: '90 days of indices', value: r.required90GB, sub: 'at the buffered daily rate' },
  ].filter(Boolean);
  return capacityChart({ value: r.liveTotalGB, label: 'disk on this cluster' }, needs, { format: gb, labelWidth: 190 });
}

/**
 * The same question for the repository. Its size is only known once measured, so until
 * then the bars are drawn without a capacity line rather than against a guess.
 */
function backupFitChart(r) {
  const needs = [
    r.repoGB === null ? null : { label: 'Used right now', value: r.repoGB, sub: 'sum of incremental snapshot bytes' },
    r.requiredSnapshotGB === null
      ? null
      : { label: `Retention policy (${r.snapshotRetention.label})`, value: r.requiredSnapshotGB,
          sub: `(per day + 30%) × ${r.snapshotRetention.days} days — an upper bound, snapshots are incremental` },
    { label: '365 days of backups', value: r.required365GB, sub: '(per day + 30%) × 365 — an upper bound' },
  ].filter(Boolean);
  if (!needs.length) return empty('Nothing to compare yet.');
  // The capacity is the repository's total size, which only the config knows. Without it
  // the requirements are still worth seeing — just not against a line that was invented.
  return capacityChart(
    { value: r.backupCapacityGB || 0, label: 'repository space' },
    needs,
    { format: gb, labelWidth: 190, capacityUnknown: r.backupCapacityGB === null });
}

function volumeChart(reports) {
  const items = reports.filter((r) => r.perDayGB > 0).map((r) => ({
    key: r.cluster.id, label: r.cluster.name, value: r.perDayGB,
    sub: `${r.vol.basis} · ${r.vol.daysCovered} days of data`,
  }));
  return items.length
    ? hbarList(items, { format: (v) => `${v.toFixed(1)} GB`, topN: 20, labelWidth: 160 })
    : empty('No dated indices found — the volume report needs indices with a date in the name.');
}

/* ------------------------------- per cluster ---------------------------------- */

function clusterCardBody(r) {
  const c = r.cluster;
  const rows = reportRows(r).map(([label, value, note]) => h('tr',
    h('td', { style: { width: '46%' } }, label),
    h('td', { style: { fontWeight: 620, fontVariantNumeric: 'tabular-nums' } }, String(value)),
    h('td.muted', { style: { fontSize: '11px' } }, note || '')));

  const measuring = ui.measuring.has(c.id);
  const repos = (state.data.get(c.id) || {}).repos || [];

  return h('div', { style: { display: 'grid', gap: '10px' } },
    r.vol.daysCovered === 0
      ? h('div.banner.warn', { style: { margin: 0 } },
          h('div', h('div.ttl', 'No dated indices'),
            h('div', 'Per-day volume is measured from indices whose name carries a date. This cluster has none ' +
                     'that match the pattern, so every figure derived from it is 0. Check indexNameRegex for this cluster.')))
      : null,

    // The comparison the table makes you do in your head, drawn.
    h('div.grid.c2',
      card('Will the indices fit on disk?', 'each requirement against the disk this cluster has',
        liveFitChart(r)),
      card('Will the backups fit?',
        r.backupCapacityGB === null
          ? 'set backupCapacity on this cluster to compare against the space you have'
          : `against the ${r.backupCapacityLabel} the repository has`,
        backupFitChart(r))),

    h('div.tbl-wrap', h('table.tbl', h('tbody', ...rows))),
    h('div', { style: { display: 'flex', gap: '6px', paddingTop: '4px' } },
      h('button.btn.sm', {
        disabled: measuring || !repos.length,
        title: repos.length ? 'Sum the incremental bytes of every snapshot — one call per snapshot'
                            : 'No repository registered on this cluster',
        onclick: () => measureRepos(c),
      }, measuring ? 'Measuring…' : r.repoGB === null ? 'Measure repo size' : 'Re-measure'),
      h('button.btn.sm', { onclick: () => exportWide([r], VIEWS.sheet) }, 'Export this cluster'),
      h('button.btn.sm.ghost', { onclick: () => navigateTo('indices') }, 'Indices')));
}

/* ------------------------------ spreadsheet view ------------------------------ */

/**
 * One row per cluster, every parameter a column — read like a spreadsheet, with the
 * cluster column and the header pinned so a wide row stays identifiable while scrolling.
 * Column headers sort; YES/NO is coloured because that is what the eye goes to.
 */
function sheetView(reports, view) {
  const col = view.cols();
  return wideSheet(reports, view, col, sortReports(reports, col));
}

function sortReports(reports, col) {
  return [...reports].sort((a, b) => {
    const c = col.find((x) => x.label === ui.sort) || col[0];
    const av = c.get(a), bv = c.get(b);
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * ui.dir;
    return String(av).localeCompare(String(bv)) * ui.dir;
  });
}

/**
 * Each section's label, centred on the part of its section that is on screen.
 *
 * Centred over the whole section, a label for nine columns sat over the eighth, and one for
 * a section running past the right edge was off screen entirely. So the centre is taken
 * of what is visible — between the frozen first column and the window's edge — and moved
 * as the sheet scrolls or the window changes size.
 */
function bandCentred(wrap) {
  const place = () => {
    // A sheet from an earlier draw: stop listening, or every redraw leaves one more
    // resize listener holding one more detached sheet.
    if (!wrap.isConnected) { window.removeEventListener('resize', place); return; }
    const w = wrap.getBoundingClientRect();
    const frozen = wrap.querySelector('thead tr:not(.group-head) th.stick');
    const left = frozen ? frozen.getBoundingClientRect().right : w.left;
    for (const lab of wrap.querySelectorAll('.glabel')) {
      lab.style.transform = '';
      const cell = lab.parentElement.getBoundingClientRect();
      const lo = Math.max(cell.left, left), hi = Math.min(cell.right, w.right);
      if (hi <= lo) continue;                              // this section is not in view
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

function wideSheet(reports, view, col, sorted) {
  // A banded row above the header naming what each block of columns is about.
  const groups = [];
  for (const c of col) {
    const last = groups[groups.length - 1];
    if (last && last.name === c.group) last.span++;
    else groups.push({ name: c.group, span: 1 });
  }

  // The frozen column is the first COLUMN, but the first group spans three of them.
  // Pinning the whole group cell froze all three, so the band sat still while the
  // columns under it scrolled. The band is split: one pinned cell exactly as wide as
  // the frozen column, and the rest of that group scrolling with everything else.
  // Where each section starts, so a divider can run down every row at that column. A
  // label centred over nine columns sat over the eighth, and the columns before it looked
  // as if they belonged to nothing; the label now starts where its section does.
  const starts = new Set();
  groups.reduce((at, g) => { starts.add(at); return at + g.span; }, 0);
  const groupCells = [];
  groups.forEach((g, gi) => {
    // The label rides along while its section is on screen (see .glabel), so a section
    // scrolled halfway past the frozen column still says what it is.
    if (gi > 0) { groupCells.push(h('th.gstart', { colspan: g.span }, h('span.glabel', g.name))); return; }
    groupCells.push(h('th.stick', { colspan: 1 }, g.name));
    if (g.span > 1) groupCells.push(h('th', { colspan: g.span - 1 }));
  });

  const head = h('thead',
    h('tr.group-head', ...groupCells),
    h('tr', ...col.map((c, i) => h('th', {
      id: `vol-th-${i}`,          // so mount() can restore focus after a re-sort
      class: [i === 0 ? 'stick' : '', i > 0 && starts.has(i) ? 'gstart' : ''].filter(Boolean).join(' '),
      style: { cursor: 'pointer' },
      title: `${c.group} \u2014 click to sort by this column`,
      'aria-sort': ui.sort === c.label ? (ui.dir === 1 ? 'ascending' : 'descending') : 'none',
      ...activatable(() => { ui.dir = ui.sort === c.label ? -ui.dir : 1; ui.sort = c.label; draw(); }, { role: null }),
    }, c.label + (ui.sort === c.label ? (ui.dir === 1 ? ' ▲' : ' ▼') : ''),
       columnInfo(c),
       c.unit ? h('span.unit', c.unit) : null))));

  const body = h('tbody', ...sorted.map((r) => h('tr', ...col.map((c, i) => {
    const text = sheetCell(c, r);
    const cls = [i === 0 ? 'stick' : '', i > 0 && starts.has(i) ? 'gstart' : '', c.kind === 'num' ? 'num' : '',
                 c.kind === 'bool' ? (text === 'YES' ? 'yes' : text === 'NO' ? 'no' : 'unknown') : '']
      .filter(Boolean).join('.');
    // The explanation the card shows beside the value is the grid's hover text.
    const tip = (c.note && c.note(r)) || (text.length > 24 ? text : null);
    return h(cls ? `td.${cls}` : 'td', { title: tip }, text);
  }))));

  return card(view.title, `${reports.length} cluster${reports.length === 1 ? '' : 's'} · one row each · click a header to sort`,
    bandCentred(h('div.sheet-wrap', h('table.sheet', head, body))),
    [h('button.btn.sm.primary', { onclick: () => exportWide(reports, view) }, 'Export CSV')]);
}

/* ---------------------------------- what it all means ---------------------------- */

/**
 * A column, explained — the mark in its header and the panel it opens.
 *
 * The report is thirty-odd columns of arithmetic, and someone seeing it for the first time
 * has no way to tell a measurement from an estimate, or which of two similar names means
 * which. One panel listing every column was not the answer: the explanation you want is
 * for the column you are looking at, and reading it meant scrolling past thirty you were
 * not. So the mark belongs to the column, and only shows on the one under the pointer.
 *
 * The text lives on the column definition, so a column cannot be added without one.
 */
function columnInfo(c) {
  if (!c.help) return null;
  const mark = h('button.colinfo', {
    title: `What is "${c.label}"?`,
    type: 'button',
    onclick: (e) => {
      // The header itself sorts. Explaining a column is not asking to sort by it.
      e.stopPropagation();
      mark.classList.add('on');
      popover(mark, () => [
        h('div', { style: { fontSize: '12px', lineHeight: '1.6' } }, c.help),
        c.note ? h('div.muted', { style: { fontSize: '11px', paddingTop: '5px', borderTop: '1px solid var(--border)' } },
          'Each cell also carries its own note on hover — what that particular number was built from.') : null,
      ], {
        title: c.label,
        sub: c.unit ? `in ${c.unit}` : '',
        width: '320px',
        onClose: () => mark.classList.remove('on'),
      });
    },
  }, 'i');
  return mark;
}

/**
 * Repository size is not a number Elasticsearch reports. The closest honest answer is the
 * sum of each snapshot's INCREMENTAL bytes, which is what the repository actually holds —
 * one _status call per snapshot, so it stays behind a button and is capped.
 *
 * A finished snapshot never changes size, so a persistent, per-cluster cache (lib/idb.js)
 * means pressing this again only asks about snapshots taken since the last time — the same
 * cache the Clusters page's own "Measure size" button (overview.js) fills, since both are
 * the one definition of this figure (core/volume.js's measureRepoBytes).
 */
async function measureRepos(c) {
  const cl = client(c.id);
  const d = state.data.get(c.id) || {};
  ui.measuring.add(c.id); draw();
  let counted = 0, failed = 0;
  const cache = repoSizeCache(c.id);
  try {
    await cache.ready;
    const m = await measureRepoBytes(cl, d, { cache: cache.map });
    ({ counted, failed } = m);
    // Every read failing is unknown, not an empty repository.
    if (m.total !== null) repoBytes.set(c.id, m.total);
    await cache.flush((key) => snapshotStatusByKey(d, key));
  } finally {
    ui.measuring.delete(c.id);
    draw();
  }
  if (failed) {
    // Say so rather than presenting a short total as if it were complete.
    const el = $('#vol-msg');
    if (el) mount(el, h('div.banner.warn', `${c.name}: ${counted} snapshot(s) measured, ${failed} could not be read.`));
  }
}

/* ---------------------------------- export ------------------------------------ */

/** The report layout: one row per parameter, a column per cluster — what the table shows. */
function exportTall(reports) {
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
  const stamp = new Date().toISOString().slice(0, 10);
  download(`volume-resource-report-by-parameter-${stamp}.csv`, toCsv(rows), 'text/csv');
}

/**
 * One row per cluster, one column per parameter — sortable and chartable in a
 * spreadsheet, and the default export.
 */
function exportWide(reports, view = VIEWS.sheet) {
  const cols = view.cols();
  // Same column definitions the grid uses, so the file and the screen cannot diverge.
  //
  // The header is the column's own name and nothing else. It used to carry the group as a
  // prefix joined by an em dash — "Backups (snapshots) — Backup space used (GB)" — which
  // made every header long, and the dash arrives mangled in a spreadsheet that reads the
  // file as anything but UTF-8. The group is a heading for the screen; a CSV is flat, and
  // the labels are unique on their own in either view.
  const rows = reports.map((r) => {
    const o = {};
    for (const c of cols) {
      o[c.unit ? `${c.label} (${c.unit})` : c.label] = sheetCell(c, r);
    }
    o['Generated at'] = new Date().toISOString();
    return o;
  });
  const stamp = new Date().toISOString().slice(0, 10);
  download(`${view.file}-${stamp}.csv`, toCsv(rows), 'text/csv');
}
