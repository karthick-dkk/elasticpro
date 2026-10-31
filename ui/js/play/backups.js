/**
 * Slide 5, Backups: from each cluster's snapshot rows (play/snapshots.js filters them by
 * status and end time) — backed up within the stale window (snapshotStaleHours, 26 h, the
 * window the snapshot alert uses), the FAILED / PARTIAL snapshots of the last 24 h, and per
 * cluster the last good snapshot, the days of data it holds and the backup size (the last
 * measureRepoBytes result shared through the core). A ULM cluster with SLM not used reads
 * "ULM · s3 <bucket>" and is not counted as missing a backup (core/cluster-kind.js).
 */

import { h } from '../lib/dom.js';
import { bytes, ago } from '../lib/fmt.js';
import { clusterKind, slmExempt } from '../core/cluster-kind.js';
import { kpi, unknown, fitRows, clockText } from './parts.js';
import { lastGood, failuresSince, backedUpWithin, listingState, endOf } from './snapshots.js';

export const id = 'backups';
export const title = 'Backups';
export const DATASETS = ['policies', 'snapshots'];

export const isEmpty = (ctx) => !ctx.clusters.length;

/** Counts for the top of the slide. */
export function backupCounts(ctx) {
  let ok = 0, old = 0, unk = 0, ulm = 0;
  for (const c of ctx.clusters) {
    if (slmExempt(c)) { ulm++; continue; }
    const b = backedUpWithin(ctx.data(c.id), ctx.staleMs, ctx.now);
    if (b === true) ok++; else if (b === false) old++; else unk++;
  }
  return { ok, old, unk, ulm, expected: ctx.clusters.length - ulm };
}

export function render(ctx) {
  const n = backupCounts(ctx);
  const hrs = Math.round(ctx.staleMs / 3600000);
  const fails = [];
  for (const c of ctx.clusters) {
    for (const s of failuresSince(ctx.data(c.id), ctx.now - 86400000)) fails.push({ c, s });
  }
  fails.sort((a, b) => endOf(b.s) - endOf(a.s));
  const failRows = fails.map(({ c, s }) => h('tr',
    h('td', c.name),
    h('td.num', clockText(endOf(s), ctx.tz, { seconds: false })),
    h('td', h(`span.pl-pill.${String(s.status).toUpperCase() === 'FAILED' ? 'red' : 'yellow'}`, String(s.status).toUpperCase()),
      ` ${s.repo}/${s.id}`, s.total ? h('span.pl-dim', ` · ${s.failed} of ${s.total} shards failed`) : null)));
  const failBox = h('div.pl-half.narrow', h('div.pl-ahead', 'Snapshot failures · 24 h'),
    failRows.length ? h('table.pl-tbl', h('thead', h('tr', h('th', 'Cluster'), h('th.num', 'Time'), h('th', 'What'))), h('tbody', failRows))
      : h('div.pl-none', 'None'));

  const list = [...ctx.clusters].sort((a, b) => {
    const ra = slmExempt(a) ? 3 : backedUpWithin(ctx.data(a.id), ctx.staleMs, ctx.now) === false ? 0 : backedUpWithin(ctx.data(a.id), ctx.staleMs, ctx.now) === null ? 1 : 2;
    const rb = slmExempt(b) ? 3 : backedUpWithin(ctx.data(b.id), ctx.staleMs, ctx.now) === false ? 0 : backedUpWithin(ctx.data(b.id), ctx.staleMs, ctx.now) === null ? 1 : 2;
    return ra - rb || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  const rows = list.map((c) => {
    const d = ctx.data(c.id);
    const repo = ctx.repoSize.get(c.id);
    const size = repo && repo.bytes !== null && repo.bytes !== undefined ? h('span', bytes(repo.bytes))
      : unknown('not measured', 'Measured from the Volume report (Measure size) or the scraper');
    if (slmExempt(c)) {
      const k = clusterKind(c);
      return h('tr', h('td', c.name), h('td', { colSpan: 2 }, h('span.pl-pill.blue', `ULM${k.ulm.bucket ? ` · s3 ${k.ulm.bucket}` : ''}`),
        h('span.pl-dim', ' SLM not used')), h('td.num', size));
    }
    const g = lastGood(d);
    const st = listingState(d);
    const within = backedUpWithin(d, ctx.staleMs, ctx.now);
    return h('tr',
      h('td', c.name),
      h(`td${within === false ? '.red' : ''}`, g ? `${ago(endOf(g))} · ${clockText(endOf(g), ctx.tz, { seconds: false })}`
        : unknown(st === 'none' ? 'no repository' : st === 'read' ? 'none' : 'no data')),
      h('td', g ? (g.coverTo ? g.coverTo : unknown(g.indexNames === null ? 'index names not listed' : '–',
        'The snapshot listing came from _cat/snapshots, which does not name the indices; the full listing (snapshots_full) does')) : unknown('–')),
      h('td.num', size));
  });
  const tblBox = h('div.pl-half', h('div.pl-ahead', 'Per cluster'),
    h('table.pl-tbl', h('thead', h('tr', h('th', 'Cluster'), h('th', 'Last good snapshot'), h('th', 'Holds data up to'), h('th.num', 'Backup size'))),
      h('tbody', rows)));
  ctx.afterMount(() => {
    fitRows(tblBox, rows, (k) => h('div.pl-more', `+${k} more clusters`));
    if (failRows.length) fitRows(failBox, failRows, (k) => h('div.pl-more', `+${k} more`));
  });
  return h('div.pl-slide.pl-backups',
    h('div.pl-kpis',
      kpi(`Backed up in ${hrs} h`, `${n.ok} of ${n.expected}`, n.unk ? `${n.unk} not read yet` : null, n.old ? 'yellow' : n.ok === n.expected ? 'green' : ''),
      kpi(`Older than ${hrs} h`, String(n.old), null, n.old ? 'red' : 'green'),
      kpi('Failures · 24 h', String(fails.length), null, fails.length ? 'red' : 'green'),
      kpi('ULM, SLM not used', String(n.ulm), n.ulm ? 'archived to S3' : null)),
    h('div.pl-split', tblBox, failBox));
}
