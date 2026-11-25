/**
 * Slide 5, Backups (docs/PLAY.md): one donut of the clusters by backup state
 * (play/snapshots.js backupState), the good and failed clusters per day, and per cluster the
 * last 14 days (the same days the Snapshots page draws), the age of the last good snapshot
 * against the stale window (snapshotStaleHours, 26 h, the window the snapshot alert uses), the
 * day its data reaches to and the backup size (the last measureRepoBytes result shared through
 * the core). A ULM cluster with SLM not used is its own group, not a missing backup
 * (core/cluster-kind.js); so is a cluster with no repository.
 */

import { h } from '../lib/dom.js';
import { bytes, ago } from '../lib/fmt.js';
import { clusterKind, slmExempt } from '../core/cluster-kind.js';
import { donut, pageAt, unknown, fitRows } from './parts.js';
import { lastGood, backupState, backupDays, endOf } from './snapshots.js';
import { dwellMs } from './engine.js';

export const id = 'backups';
export const title = 'Backups';
export const DATASETS = ['policies', 'snapshots'];

export const DAYS = 14;
const PER_PAGE = 14;
/** The bar's full width, in stale windows: the line at one window stands just past the middle. */
const BAR_WINDOWS = 48 / 26;

export const isEmpty = (ctx) => !ctx.clusters.length;

const ORDER = ['failed', 'late', 'unread', 'norepo', 'good', 'ulm'];

/** Each cluster with the one group it is counted in, problems first, then by name. */
export function backupRows(ctx) {
  return ctx.clusters.map((c) => {
    const d = ctx.data(c.id);
    return { c, d, ...(slmExempt(c) ? { state: 'ulm', why: 'SLM not used' } : backupState(d, ctx.staleMs, ctx.now)) };
  }).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)
    || a.c.name.localeCompare(b.c.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** How many clusters are in each group. */
export function backupCounts(rows) {
  const n = { failed: 0, late: 0, unread: 0, norepo: 0, good: 0, ulm: 0 };
  for (const r of rows) n[r.state]++;
  return n;
}

/** Per day over the clusters whose listing was read: how many good, failed, none, not read. */
export function daysTogether(strips) {
  if (!strips.length) return [];
  return strips[0].map((x, i) => {
    const n = { ok: 0, bad: 0, none: 0, today: 0, notread: 0 };
    for (const s of strips) n[s[i].state]++;
    return { date: x.date, ...n };
  });
}

const tzOf = (ctx) => ctx.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const DAY_WORD = { ok: 'good', bad: 'failed', none: 'none listed', notread: 'not read', today: 'today, none yet' };
/** "25 Nov" of a YYYY-MM-DD day. */
const shortDay = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

const pageNow = (ctx, total) => pageAt(ctx.elapsed || 0, total, PER_PAGE,
  dwellMs(id, { dwellSec: ctx.display.dwellSec, slideDwell: ctx.display.slideDwell }));

export const phaseKey = (ctx) => String(pageNow(ctx, ctx.clusters.length).index);

function row(ctx, r, strip) {
  const { c, d, state } = r;
  const repo = ctx.repoSize.get(c.id);
  const size = repo && repo.bytes !== null && repo.bytes !== undefined ? bytes(repo.bytes)
    : unknown('not measured', 'Measured from the Volume report (Measure size) or the scraper');
  if (state === 'ulm') {
    const k = clusterKind(c);
    return h('div.pl-bkrow', { dataset: { cluster: c.id } }, h('b', c.name), h('span.pl-bkwide', h('span.pl-pill.blue', `ULM${k.ulm.bucket ? ` · s3 ${k.ulm.bucket}` : ''}`),
      h('span.pl-dim', ' SLM not used')), h('span.num', size));
  }
  const good = lastGood(d);
  const age = good ? Math.max(0, ctx.now - endOf(good)) : null;
  const tone = state === 'failed' ? 'red' : state === 'late' ? 'yellow' : state === 'good' ? 'green' : 'grey';
  const text = state === 'failed' ? `${r.why} · ${good ? `good ${ago(endOf(good))}` : 'none good'}`
    : state === 'late' ? (good ? `late · ${ago(endOf(good))}` : 'no good snapshot')
      : state === 'good' ? ago(endOf(good))
        : state === 'norepo' ? 'no repository set up'
          : `${r.why}${good ? ` · good ${ago(endOf(good))}` : ''}`;
  const width = age === null ? 0 : Math.min(100, (age / (ctx.staleMs * BAR_WINDOWS)) * 100);
  return h('div.pl-bkrow', { dataset: { cluster: c.id } },
    h('b', c.name),
    strip ? h('span.pl-strip', { role: 'img', 'aria-label': strip.map((x) => `${shortDay(x.date)} ${DAY_WORD[x.state]}`).join(', ') },
      ...strip.map((x) => h(`i.${x.state}`))) : h('span.pl-dim', state === 'norepo' ? '–' : 'not read'),
    h('span.pl-age', h('span.pl-bar', good ? h(`i.${tone}`, { style: { width: `${width}%` } }) : null,
      h('u', { style: { left: `${100 / BAR_WINDOWS}%` } })), h(`span.pl-agetxt.${tone}`, text)),
    // What can be restored up to: the cover days are those of restorable indices only (snapshot-restorable.js).
    h('span', good ? (good.coverTo || unknown(good.indexNames === null ? 'index names not listed' : 'no dated index',
      'The snapshot listing came from _cat/snapshots, which does not name the indices; the full listing (snapshots_full) does')) : '–'),
    h('span.num', state === 'norepo' ? '–' : size));
}

export function render(ctx) {
  const all = backupRows(ctx);
  const n = backupCounts(all);
  const hrs = Math.round(ctx.staleMs / 3600000);
  const tz = tzOf(ctx);
  const strips = new Map();
  for (const r of all) {
    const s = r.state === 'ulm' ? null : backupDays(r.d, { days: DAYS, tz, now: ctx.now });
    if (s) strips.set(r.c.id, s);
  }
  const page = pageNow(ctx, all.length);
  const rows = all.slice(page.from, page.to).map((r) => row(ctx, r, strips.get(r.c.id)));
  const together = daysTogether([...strips.values()]);
  const of = strips.size;
  const pct = (x) => `${(x / of) * 100}%`;
  const list = h('div.pl-bklist',
    h('div.pl-bkrow.head', h('span', 'Cluster'), h('span', `Last ${DAYS} days`), h('span', `Last good backup, line = ${hrs} h`),
      h('span', 'Data inside up to'), h('span.num', 'Size')), ...rows);
  ctx.afterMount(() => fitRows(list, rows, (k) => h('div.pl-more', `+${k} more clusters`)));
  return h('div.pl-slide.pl-backups', h('div.pl-bk',
    h('div.pl-bkside',
      h('div.pl-panel.pl-bkdonut', h('div.pl-ph', 'Clusters by backup state'),
        donut([
          { n: n.failed, label: 'Last run failed or partial', tone: 'red' },
          { n: n.late, label: `Late, over ${hrs} h`, tone: 'yellow' },
          { n: n.norepo, label: 'No repository set up', tone: 'grey' },
          { n: n.unread, label: 'Not read', tone: 'grey' },
          ...(n.ulm ? [{ n: n.ulm, label: 'ULM, archived to S3', tone: 'blue' }] : []),
          { n: n.good, label: `Good, under ${hrs} h`, tone: 'green' },
        ], { total: all.length, label: all.length === 1 ? 'cluster' : 'clusters', size: 'big' })),
      h('div.pl-panel', h('div.pl-ph', `Good backups per day, ${DAYS} days`, h('small', of ? `${of} of ${all.length} clusters read` : '')),
        of ? h('div.pl-days', ...together.map((x) => h('div.pl-day', { title: `${x.date}: ${x.ok} good, ${x.bad} failed, ${x.none} none listed, ${x.notread} not read` },
          h('i.none', { style: { height: pct(x.none + x.notread + x.today) } }), h('i.bad', { style: { height: pct(x.bad) } }), h('i.ok', { style: { height: pct(x.ok) } })))) : unknown('no snapshot list read'),
        of ? h('div.pl-axis', h('span', shortDay(together[0].date)), h('span', shortDay(together[Math.floor(DAYS / 2)].date)), h('span', 'today')) : null)),
    h('div.pl-panel.pl-bkmain', list,
      h('div.pl-bkfoot', h('i.ok'), 'good that day', h('i.bad'), 'failed or partial only', h('i.none'), 'none listed (no run, or removed by retention) or not read',
        page.pages > 1 ? h('span.pl-page', `${page.from + 1}–${page.to} of ${all.length} clusters`) : null))));
}
