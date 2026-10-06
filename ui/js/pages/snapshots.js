/** Page 5 — snapshots, SLM policies and repositories: what exists, and managing it. */

import { h, mount, $ } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { spanDays, spanDaysIso } from '../core/volume.js';
import { num, dt, dur, ago, bytes, eachDay, ymdDots, toCsv, download, plural } from '../lib/fmt.js';
import { state, client, activeClusters, fetchSnapshots, fetchOverview, ensureFullSnapshots, expectChange,
         fleetMode, datasetFreshness, demandDataset, clusterRev } from '../core/state.js';
import { freshnessBar } from '../lib/freshness.js';
import { coverageStrip } from '../lib/charts.js';
import { card, collapsible, pill, statTile, table, empty } from './common.js';
import { navigateTo } from '../core/intent.js';
import { confirmDialog } from '../ui/modal.js';
import { writesAllowed, syncWrites, writeToggle, ensureWrites } from '../core/writes.js';
import { rowMenu, ICON, toast } from '../ui/menu.js';
import { trackTask, snapshotPoll } from '../ui/tasks.js';
import {
  createSnapshotDialog, snapshotDetailsDialog, restoreSnapshotDialog, deleteSnapshot,
  deleteIndicesDialog, createRepositoryDialog, deleteRepository, verifyRepository, cleanupRepository,
  snapshotIndicesDialog,
} from '../ui/snapshot-dialogs.js';
import { pagerBar } from '../lib/pager.js';
import { SNAPSHOT_PAGE_SIZES, snapshotPage, snapshotCsvRows, filterSnapshots, newestFirst } from '../core/snapshot-list.js';

let host = null;
/**
 * Page state, kept for as long as the tab is open (like the Indices page's): which view,
 * which repository per cluster, the page and search per cluster, and rows per page.
 */
const ui = { repo: {}, days: 60, view: 'snapshots', page: {}, q: {}, perPage: SNAPSHOT_PAGE_SIZES[0] };

export function render(el) {
  host = el;
  el.classList.add('dense');   // long tables: fit more on one screen
  syncWrites().then(draw).catch(() => {});
  draw();
  loadFull();
}
export function onData() { if (host && host.isConnected) draw(); }

/**
 * The verbose listing, for the clusters on screen. The overview's own listing is the light
 * _cat one, which counts snapshots but cannot say which days of indices they hold — and
 * that is most of what this page is for. A no-op without the fleet cache, whose refresh
 * already reads the verbose one.
 */
async function loadFull() {
  const list = activeClusters();
  // Many clusters: one message to the core for all of them, answers arriving as pushes.
  // Holding a request open per cluster queued a hundred of them in front of every click.
  // One or two: asked and waited for, so the page fills in without a round of pushes.
  if (list.length > 2 && await demandDataset(list.map((c) => c.id), 'snapshots_full').catch(() => false)) return;
  await Promise.all(list.map((c) => ensureFullSnapshots(c.id).catch(() => {})));
  if (host && host.isConnected) draw();
}

/**
 * Each cluster's block, kept between redraws and rebuilt only when its cluster or this
 * page's settings changed (lib/keyed.js). On "All clusters" that is a hundred-odd blocks of
 * tiles, tables and a coverage strip; rebuilding every one of them on every push from the
 * core held the window for seconds at a time. A redraw also builds for at most BUILD_MS
 * and shows the rest as placeholders, filled in on the ticks that follow — so opening the
 * page or a refresh landing never holds the window for the whole fleet at once.
 */
const BUILD_MS = 40;
const built = nodeCache({ budgetMs: BUILD_MS });
let moreTimer = null;
const minute = () => Math.floor(Date.now() / 60000);

function blockSig(c) {
  // The page and the search are not here: moving through pages or typing redraws only the
  // table under them (see snapshotsCard), and a rebuild reads them from `ui` anyway.
  return [clusterRev(c.id), objId(state.data.get(c.id)), objId(client(c.id)), ui.repo[c.id] || '', ui.days, ui.view,
    ui.perPage, writesAllowed(), fleetMode(), minute()].join('|');
}

function placeholder(c) {
  return h('section.lazy-block', { style: { marginBottom: '22px', minHeight: '360px' } },
    h('h2', { style: { fontSize: '14px', margin: '0 0 8px' } }, c.name),
    h('div.muted', 'Loading…'));
}

function draw() {
  const list = activeClusters();
  built.begin();
  const blocks = list.map((c) => built.get(c.id, blockSig(c), () => clusterBlock(c), () => placeholder(c)));
  mount(host, viewTabs(), ...blocks, list.length ? null : empty('No cluster selected'));
  built.end();
  if (built.incomplete && !moreTimer) {
    moreTimer = setTimeout(() => { moreTimer = null; if (host && host.isConnected) draw(); }, 0);
  }
}

/**
 * Snapshots / Snapshot Summary — the same switch, and the same look, as the Indices page.
 *
 * "Snapshots" is the working view: find a snapshot, look inside it, take or restore one.
 * It is what the page opens on. "Snapshot Summary" is everything that describes the
 * backups rather than acts on one: the tiles, the repositories, SLM, the availability
 * strip. Stacked, the list everybody came for started a screen and a half down.
 */
function viewTabs() {
  const tab = (id, label, title) => h('button.btn.sm', {
    'aria-pressed': ui.view === id ? 'true' : 'false',
    title,
    onclick: () => { if (ui.view !== id) { ui.view = id; draw(); } },
  }, label);
  return h('div.seg', { role: 'group', 'aria-label': 'Snapshots view', style: { marginBottom: '12px' } },
    tab('snapshots', 'Snapshots', 'Search the snapshots, look inside one, take or restore'),
    tab('summary', 'Snapshot Summary', 'Coverage, repositories, SLM policies and snapshot availability'));
}

/**
 * Re-read repositories and snapshots after something changed them.
 *
 * With the fleet cache there is nothing to ask: the core re-reads the snapshot datasets 3 s
 * after any write through it succeeds, and the answer arrives here as a data event — the
 * page redraws with it. Without it, the overview (repositories) now and the listing once
 * more when the snapshot has had time to register.
 */
async function reload(c) {
  if (fleetMode()) { draw(); return; }
  await fetchOverview(c.id);
  expectChange(c.id, 'snapshots');
  draw();
}

/** Which dataset the listing on screen came from, for its freshness line. */
function listingFreshness(c, d, repo) {
  const src = (d.snapshotsSource || {})[repo];
  return datasetFreshness(c.id, src === 'verbose' || src === 'mixed' ? 'snapshots_full' : 'snapshots');
}

function clusterBlock(c) {
  const d = state.data.get(c.id) || {};
  const repos = d.repos || [];
  const selected = ui.repo[c.id] || (repos[0] && repos[0].name);
  const snaps = (d.snapshots && d.snapshots[selected]) || [];

  return h('section.lazy-block', { style: { marginBottom: '22px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' } },
      h('h2', { style: { fontSize: '14px', margin: 0 } }, c.name),
      h('span.mono.muted', { style: { fontSize: '11.5px' } }, c.url),
      d.slmStatus ? pill(`SLM ${d.slmStatus.operation_mode}`, d.slmStatus.operation_mode === 'RUNNING' ? 'green' : 'yellow') : null,
      d.ilm ? pill(`ILM ${d.ilm.operation_mode}`, d.ilm.operation_mode === 'RUNNING' ? 'green' : 'yellow') : null,
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'center' } },
        writeToggle(draw),
        // The listing's own age and a Refresh that re-reads it now (the verbose one).
        freshnessBar(selected ? listingFreshness(c, d, selected) : 0, () => fetchSnapshots(c.id), { label: 'snapshots', dense: true }))),
    ui.view === 'summary'
      ? summaryView(c, d, repos, selected, snaps)
      : snapshotsView(c, repos, selected, snaps));
}

function repoSelect(c, repos, selected) {
  const s = h('select', { 'aria-label': 'Repository',
    onchange: (e) => { ui.repo[c.id] = e.target.value; ui.page[c.id] = 0; draw(); } },
    ...repos.map((r) => h('option', { value: r.name }, `${r.name} (${r.type})`)));
  s.value = selected || '';
  return s;
}

/* ------------------------------- Snapshots view -------------------------------- */

/** The search bar and the snapshot list, and nothing else. */
function snapshotsView(c, repos, selected, snaps) {
  const holder = h('div');
  const sub = h('span', '');
  const repaint = () => {
    const { rows, slice } = snapshotPage(snaps, { text: ui.q[c.id] || '', page: ui.page[c.id] || 0, perPage: ui.perPage });
    // Written back clamped: a search that shrank the list must not leave the page pointing
    // past its end, where Previous would appear to do nothing.
    ui.page[c.id] = slice.page;
    const q = (ui.q[c.id] || '').trim();
    sub.textContent = !snaps.length ? '' : q
      ? `${num(rows.length)} of ${num(snaps.length)} match · newest first`
      : `${num(snaps.length)} total · newest first`;
    mount(holder,
      snapTable(c, selected, slice.rows, { searching: !!q }),
      snaps.length ? pagerBar(slice, (p) => { ui.page[c.id] = p; repaint(); }, {
        label: 'snapshots', numbers: true,
        sizes: SNAPSHOT_PAGE_SIZES, perPage: ui.perPage,
        onSize: (n) => { ui.perPage = n; ui.page = {}; draw(); },
      }) : null);
  };
  repaint();

  const search = h('input', {
    type: 'search', value: ui.q[c.id] || '', 'aria-label': 'Search snapshots',
    placeholder: 'snapshot name, status, or an index it holds…',
    style: { minWidth: '280px' },
    oninput: (e) => { ui.q[c.id] = e.target.value; ui.page[c.id] = 0; repaint(); },
  });

  return h('div',
    h('div.toolbar', { style: { marginBottom: '10px', display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
      repos.length ? h('label.field', 'Repository', repoSelect(c, repos, selected)) : null,
      h('label.field', { style: { flex: '1', maxWidth: '520px' } }, 'Search snapshots', search)),
    card(`Snapshots in ${selected || '—'}`, sub, holder,
      [
        h('button.btn.sm.primary', {
          disabled: !repos.length,
          title: repos.length ? 'Start a snapshot now' : 'Register a repository first (Snapshot Summary → Repositories)',
          onclick: async () => {
            const made = await createSnapshotDialog(c, repos, selected);
            if (made) await reload(c);
          },
        }, '+ Create snapshot'),
        h('button.btn.sm', {
          disabled: !snaps.length,
          title: 'Every snapshot that matches the search — all pages, not just this one',
          onclick: () => download(`snapshots-${c.id}-${selected}.csv`,
            toCsv(snapshotCsvRows(newestFirst(filterSnapshots(snaps, ui.q[c.id] || '')))), 'text/csv'),
        }, 'Export CSV'),
      ]));
}

/* ---------------------------- Snapshot Summary view ---------------------------- */

function summaryView(c, d, repos, selected, snaps) {
  const policies = d.slm || [];
  const cov = coverage(snaps, ui.days);
  const dataRange = recoverableRange(snaps);
  // Rows from the _cat listing do not name their indices: the recoverable range is then
  // unknown, and the tile says so instead of "no dated indices".
  const unnamed = snaps.some((s) => s.indexNames == null);
  const oldest = snaps.length ? snaps[snaps.length - 1] : null;
  const newest = snaps.length ? snaps[0] : null;

  return h('div',
    h('div.grid.c4', { style: { marginBottom: '14px' } },
      statTile('Snapshots available', num(snaps.length), selected ? `in ${selected}` : 'no repository'),
      statTile('Newest snapshot taken', newest ? dt(newest.start).slice(0, 12) : '–', newest ? ago(newest.start) : ''),
      // The two questions are different: when snapshots ran, and which days of indices
      // they hold. A snapshot taken this morning can contain ninety days of daily indices.
      statTile('Index data recoverable from', dataRange.from || '–',
        dataRange.from ? `through ${dataRange.to} · ${dataRange.days} days${unnamed ? ' (some snapshots not yet read in full)' : ''}`
          : unnamed ? 'unknown — the listing has no index names yet' : 'no dated indices in these snapshots'),
      statTile('Snapshot runs cover', oldest && newest ? plural(spanDays(oldest.start, newest.start), 'day') : '–',
        cov.missing.length ? `${cov.missing.length} day(s) with no snapshot run` : 'a run every day in the window')),

    collapsible('Repositories', repos.length ? `${repos.length} registered · add or manage` : 'none registered',
      () => h('div',
        repoTable(c, d, repos),
        h('div', { style: { paddingTop: '8px' } },
          h('button.btn.sm.primary', {
            onclick: async () => { if (await createRepositoryDialog(c, d.pathRepo || [])) await reload(c); },
          }, '+ Add repository'))),
      { key: 'snap-repos' }),

    h('div', { style: { marginTop: '10px' } },
      collapsible('SLM policies', policies.length ? `${policies.length} configured` : 'none configured',
        () => (policies.length ? slmTable(c, policies) : empty(d.slmSupported === false ? 'SLM API not available on this cluster' : 'No SLM policies configured')),
        { key: 'snap-slm', open: policies.some((p) => { const lf = p.last_failure, ls = p.last_success; return lf && (!ls || lf.time > ls.time); }) })),

    h('div', { style: { marginTop: '10px' } },
      collapsible('Snapshot availability', `last ${ui.days} days in ${selected || '—'}`, () =>
        h('div', { style: { display: 'grid', gap: '10px' } },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
            h('label.field', 'Repository', repoSelect(c, repos, selected)),
            h('label.field', 'Window', (() => {
              const s = h('select', { onchange: (e) => { ui.days = Number(e.target.value); draw(); } },
                ...[14, 30, 60, 90, 180, 365].map((n) => h('option', { value: String(n) }, `${n} days`)));
              s.value = String(ui.days); return s;
            })())),
          repos.length ? coverageStrip(cov.days, { perRow: 62 }) : empty('No repositories'),
          cov.missing.length
            ? h('div.banner.warn', h('div', h('div.ttl', `${cov.missing.length} day(s) without a successful snapshot`),
                h('div.mono', { style: { fontSize: '11.5px' } }, cov.missing.slice(0, 12).join(', ') + (cov.missing.length > 12 ? ` … +${cov.missing.length - 12}` : ''))))
            : repos.length ? h('div.sec', { style: { fontSize: '12px' } }, `Every day in the window has at least one successful snapshot.`) : null),
        { key: 'snap-coverage', open: true })));
}

/* --------------------------------- repositories -------------------------------- */

function repoTable(c, d, repos) {
  const can = writesAllowed();
  const trs = repos.map((r) => {
    const count = ((d.snapshots || {})[r.name] || []).length;
    return h('tr',
      h('td', h('div', { style: { fontWeight: 640 } }, r.name), r.error
        ? h('div.muted', { style: { fontSize: '11px', color: 'var(--critical)' }, title: r.error }, 'unreadable') : null),
      h('td', pill(r.type || '?', 'grey')),
      h('td.mono.trunc', { style: { fontSize: '11px', maxWidth: '320px' }, title: r.location || '' }, r.location || '–'),
      h('td.num', num(count)),
      h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
        h('button.btn.sm', { title: 'Check that every node can reach this repository',
          onclick: () => verifyRepository(c, r.name) }, 'Verify'),
        rowMenu([
          { label: 'Clean up…', icon: ICON.cleanup,
            title: 'Delete repository data no snapshot references any more',
            onClick: () => cleanupRepository(c, r.name, { onChanged: () => reload(c) }) },
          { sep: true },
          { label: 'Remove repository…', icon: ICON.delete, danger: true,
            title: can ? 'Unregister this repository' : 'Allow writes first',
            onClick: () => deleteRepository(c, r.name, { onChanged: () => reload(c) }) },
        ], { title: `Actions for ${r.name}` }))));
  });
  return table(['Repository', 'Type', 'Location', 'Snapshots', ''], trs, {
    emptyText: empty('This cluster has no snapshot repository, so nothing can be backed up.', {
      detail: h('span', 'A repository is registered on the cluster itself — ',
        h('code.inline', 'PUT _snapshot/<name>'), ' — and needs a path in ',
        h('code.inline', 'path.repo'), '.'),
      actions: [h('button.btn.sm', { onclick: () => navigateTo('console') }, 'Open REST console')],
    }),
  });
}

/* ------------------------------------ coverage ---------------------------------- */

/**
 * Across every snapshot in the repository, the span of log days they hold between them.
 *
 * Distinct from when the snapshots ran: this is what could actually be restored, read
 * from the dates in the index names each snapshot carries.
 */
function recoverableRange(snaps) {
  let from = null, to = null;
  for (const s of snaps) {
    if (s.coverFrom && (from === null || s.coverFrom < from)) from = s.coverFrom;
    if (s.coverTo && (to === null || s.coverTo > to)) to = s.coverTo;
  }
  return { from, to, days: spanDaysIso(from, to) };
}

function coverage(snaps, days) {
  const today = new Date();
  const start = new Date(today.getTime() - (days - 1) * 86400000);
  const byDay = new Map();
  snaps.forEach((s) => {
    if (!s.start) return;
    const k = ymdDots(new Date(s.start), '-');
    const v = byDay.get(k) || { count: 0, ok: 0, bad: 0 };
    v.count++;
    if (String(s.status).toUpperCase() === 'SUCCESS') v.ok++; else v.bad++;
    byDay.set(k, v);
  });
  const out = [], missing = [];
  eachDay(ymdDots(start, '-'), ymdDots(today, '-')).forEach((d) => {
    const k = ymdDots(d, '-');
    const v = byDay.get(k);
    const ok = !!(v && v.ok);
    if (!ok) missing.push(k);
    out.push({ date: k, ok: !!v, partial: !!(v && !v.ok), count: v ? v.count : 0,
      detail: v ? `${v.ok} success, ${v.bad} other` : 'no snapshot' });
  });
  return { days: out, missing };
}

/* -------------------------------------- SLM ------------------------------------- */

function slmTable(c, policies) {
  const trs = policies.map((p) => {
    const pol = p.policy || {};
    const ls = p.last_success, lf = p.last_failure;
    const failedLast = lf && (!ls || lf.time > ls.time);
    return h('tr',
      h('td', h('div', { style: { fontWeight: 640 } }, p.id),
        h('div.mono.muted', { style: { fontSize: '11px' } }, pol.name || '')),
      h('td.mono', { style: { fontSize: '11.5px' } }, pol.schedule || '–'),
      h('td.mono', { style: { fontSize: '11.5px' } }, pol.repository || '–'),
      h('td.mono.trunc', { style: { fontSize: '11px', maxWidth: '180px' },
        title: JSON.stringify((pol.config && pol.config.indices) || '') }, ((pol.config && pol.config.indices) || ['*']).toString()),
      h('td.mono', { style: { fontSize: '11px' } }, pol.retention
        ? [pol.retention.expire_after ? `expire ${pol.retention.expire_after}` : null,
           pol.retention.min_count !== undefined ? `min ${pol.retention.min_count}` : null,
           pol.retention.max_count !== undefined ? `max ${pol.retention.max_count}` : null].filter(Boolean).join(' · ')
        : 'none'),
      h('td', ls ? h('div', pill('success', 'green'), h('div.muted', { style: { fontSize: '11px' }, title: dt(ls.time) }, ago(ls.time)))
              : h('span.muted', 'never')),
      h('td', failedLast ? h('div', pill('failed', 'red'), h('div.muted.trunc', { style: { fontSize: '11px', maxWidth: '200px' }, title: String(lf.details || '') }, ago(lf.time)))
              : lf ? h('div.muted', { style: { fontSize: '11px' }, title: String(lf.details || '') }, `older: ${ago(lf.time)}`)
              : h('span.muted', 'none')),
      h('td.nowrap', { style: { fontSize: '11.5px' } }, p.next_execution_millis ? dt(p.next_execution_millis) : '–'),
      h('td', h('button.btn.sm', { onclick: () => execute(c, p.id, pol.repository) }, 'Run now')));
  });
  return table(['Policy', 'Schedule', 'Repository', 'Indices', 'Retention', 'Last success', 'Last failure', 'Next run', ''], trs);
}

async function execute(c, id, repo) {
  if (!(await ensureWrites())) return;
  const ok = await confirmDialog(`Run SLM policy ${id} now?`,
    `On ${c.name}. This starts a real snapshot immediately, outside the policy's schedule.`,
    { yes: 'run it' });
  if (!ok) return;
  try {
    const r = await client(c.id).executeSlmPolicy(id);
    const snap = r && r.snapshot_name;
    trackTask({ title: 'SLM snapshot started', cluster: c,
      detail: [`policy ${id}`, snap ? `${repo || '?'} / ${snap}` : ''],
      poll: snap && repo ? snapshotPoll(c, repo, snap) : null, everyMs: 5000, timeoutMs: 6 * 3600e3 });
    // The core maps a write to `_slm` onto the policies, not the snapshot it started.
    expectChange(c.id, 'snapshots', { coreCovers: false });
  } catch (e) {
    toast(`SLM policy ${id} failed to start`, 'err', 12000, { meta: c.name, detail: [e.message] });
  }
}

/* ----------------------------------- snapshots ---------------------------------- */

function snapTable(c, repo, snaps, { searching = false } = {}) {
  const refresh = { onChanged: () => reload(c) };
  const trs = snaps.map((s) => {
    const st = String(s.status || '').toUpperCase();
    const cls = st === 'SUCCESS' ? 'green' : st === 'PARTIAL' || st === 'IN_PROGRESS' ? 'yellow' : st === 'FAILED' ? 'red' : 'grey';
    const running = st === 'IN_PROGRESS';
    return h('tr',
      h('td.mono', { style: { fontSize: '11.5px' } },
        h('a', { href: '#', style: { color: 'var(--accent)', textDecoration: 'none' },
          onclick: (e) => { e.preventDefault(); snapshotDetailsDialog(c, repo, s.id, refresh).then((changed) => { if (changed) reload(c); }); } }, s.id)),
      h('td', pill(st || '?', cls)),
      h('td.nowrap', { style: { fontSize: '11.5px' } }, dt(s.start)),
      h('td.nowrap.muted', { style: { fontSize: '11.5px' } }, s.end ? dt(s.end) : '–'),
      h('td.num', typeof s.duration === 'string' ? s.duration : dur(s.duration)),
      // What is in it, not just how many: the button opens a searchable list.
      h('td', h('button.btn.sm.ghost', {
        style: { fontVariantNumeric: 'tabular-nums' },
        title: 'Every index this snapshot holds, dated by the data inside — as audit evidence',
        onclick: () => snapshotIndicesDialog(c, repo, s),
      }, `${num(s.indices)} ▸`)),
      // The days of data inside the snapshot — a snapshot taken this morning can hold
      // ninety days of daily indices, and that span is what says how far back it reaches.
      h('td.nowrap', { style: { fontSize: '11.5px' } },
        s.coverFrom
          ? h('span', { title: `${s.coverDays} day(s) of dated indices` }, `${s.coverFrom} → ${s.coverTo}`)
          : s.indexNames === null
            ? h('span.muted', { title: 'This repository was read with _cat, which does not name the indices' }, 'unknown')
            : h('span.muted', { title: 'No index in this snapshot carries a date in its name' }, '–')),
      h('td.num', `${num(s.successful)}/${num(s.total)}`),
      h('td.num', s.failed ? h('span.pill.red', h('i.dot'), num(s.failed)) : h('span.muted', '0')),
      h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
        h('button.btn.sm', { title: 'Indices, shards and failures in this snapshot',
          onclick: () => snapshotDetailsDialog(c, repo, s.id, refresh).then((changed) => { if (changed) reload(c); }) }, 'Details'),
        rowMenu([
          { label: 'Restore…', icon: ICON.restore, disabled: running,
            title: running ? 'Still running' : 'Restore indices from this snapshot',
            onClick: () => restoreSnapshotDialog(c, repo, s.id, refresh) },
          { label: 'Free live indices…', icon: ICON.free, disabled: running,
            title: 'Delete the live indices this snapshot holds — the snapshot itself is kept',
            onClick: () => deleteIndicesDialog(c, repo, s.id, refresh) },
          { sep: true },
          { label: 'Delete snapshot…', icon: ICON.delete, danger: true, disabled: running,
            title: running ? 'Still running' : 'Delete this snapshot',
            onClick: () => deleteSnapshot(c, repo, s.id, refresh) },
        ], { title: `Actions for ${s.id}` }))));
  });
  return table(['Snapshot', 'Status', 'Taken', 'Ended', 'Duration', 'Indices', 'Data inside covers',
                'Shards ok', 'Failed', ''], trs,
    { emptyText: searching ? 'No snapshot matches that search' : 'No snapshots in this repository' });
}
