/**
 * Slide 4, Log delay: the Logs page's measurement (core/log-delay.js measureDelay), every
 * device of every cluster on this display put together and rolled up by `summarise` — the
 * same merge the Logs page makes for "All clusters" — with each delay classified by
 * `classify` against Play's watch rules (Config › Play, default 30 / 60 min).
 *
 * "Peak 24 h" is the one figure no other page has: the highest delay a device showed in the
 * measurements of the last 24 h (play/measure.js carries it from one measurement to the
 * next, shared through the core so every display shows the same).
 *
 * The measurement has two tiers (play/measure.js): a full check of every device every 2 h,
 * and the late list re-checked every 15 min. The slide says when each last ran — "last full
 * check 14:00 · late devices re-checked 14:45" — the oldest across its clusters, so a device
 * that went quiet since the full check is not read as measured a minute ago.
 */

import { h } from '../lib/dom.js';
import { summarise, STATUS } from '../core/log-delay.js';
import { statusFor } from '../core/delay-levels.js';
import { kpi, unknown, minutes, fitRows, clockText } from './parts.js';
import { tierLine } from './measure.js';

export const id = 'delay';
export const title = 'Log delay';
export const DATASETS = [];

/**
 * The class a cluster's row in "Top 10 clusters by delay" takes: it blinks when its median
 * delay is red — classify's CRITICAL, over the red line (60 min unless Config › Play moves it).
 */
export const delayRowBlink = (median, t) => (median !== null && median !== undefined && statusFor(median, t) === 'CRITICAL' ? '.blink-crit' : '');

const measured = (ctx) => ctx.clusters.filter((c) => { const x = ctx.delay.get(c.id); return x && x.records; });
export const isEmpty = (ctx) => !measured(ctx).length;

/** Every measured device on the display, classified on Play's thresholds, with its cluster. */
export function fleetRecords(ctx) {
  const out = [];
  for (const c of measured(ctx)) {
    for (const r of ctx.delay.get(c.id).records) out.push({ ...r, status: statusFor(r.delayMinutes, ctx.delayT), cluster: c.name, clusterId: c.id });
  }
  return out;
}

/** Biggest delay first; a device whose delay could not be read goes last, never as 0. */
const byDelay = (a, b) => (b.delayMinutes ?? -Infinity) - (a.delayMinutes ?? -Infinity);

export function render(ctx) {
  const all = fleetRecords(ctx);
  const s = summarise(all);
  const t = ctx.watch;
  const done = measured(ctx);
  const tone = (st) => (STATUS[st] || STATUS.ERROR).cls;
  const devRows = [...all].sort(byDelay).slice(0, 10).map((r) => h('tr',
    h('td.pl-dname', r.device),
    h('td', r.cluster),
    h(`td.num.${tone(r.status)}`, minutes(r.delayMinutes)),
    h('td.num', r.arrival ? clockText(r.arrival, ctx.tz, { seconds: false }) : unknown('–')),
    h('td.num', r.peak24 && r.peak24.value !== null && r.peak24.value !== undefined ? minutes(r.peak24.value) : unknown('–')),
    h('td', h(`span.pl-pill.${tone(r.status)}`, (STATUS[r.status] || STATUS.ERROR).label))));
  const per = done.map((c) => ({ c, sum: ctx.delay.get(c.id).summary }))
    .sort((a, b) => (b.sum.median ?? -Infinity) - (a.sum.median ?? -Infinity)).slice(0, 10);
  const clRows = per.map(({ c, sum }) => h(`tr${delayRowBlink(sum.median, ctx.delayT)}`,
    h('td', c.name),
    h(`td.num.${sum.median === null ? 'grey' : tone(statusFor(sum.median, ctx.delayT))}`, sum.median === null ? unknown('–') : minutes(sum.median)),
    h('td.num', String((sum.by.DELAYED || 0) + (sum.by.CRITICAL || 0)))));
  const devBox = h('div.pl-half', h('div.pl-ahead', 'Top 10 devices by delay'),
    h('table.pl-tbl', h('thead', h('tr', h('th', 'Device'), h('th', 'Cluster'), h('th.num', 'Delay'), h('th.num', 'Last event'),
      h('th.num', 'Peak 24 h'), h('th', 'Status'))), h('tbody', devRows)));
  const clBox = h('div.pl-half.narrow', h('div.pl-ahead', 'Top 10 clusters by delay'),
    h('table.pl-tbl', h('thead', h('tr', h('th', 'Cluster'), h('th.num', 'Median delay'), h('th.num', `Devices > ${t.delayYellowFromMin} min`))), h('tbody', clRows)));
  ctx.afterMount(() => { fitRows(devBox, devRows, () => null); fitRows(clBox, clRows, () => null); });
  const truncated = done.reduce((n, c) => n + (ctx.delay.get(c.id).truncated || 0), 0);
  const tiers = tierLine(done.map((c) => ctx.delay.get(c.id)), (ms) => clockText(ms, ctx.tz, { seconds: false }));
  return h('div.pl-slide.pl-logdelay',
    tiers ? h('div.pl-s.pl-tiers', tiers) : null,
    h('div.pl-kpis',
      kpi('Devices sending logs', String(s.devices), `${done.length} of ${ctx.clusters.length} clusters measured${truncated ? ' · list capped' : ''}`),
      kpi(`Under ${t.delayYellowFromMin} min`, String(s.by.OK || 0), null, 'green'),
      kpi(`${t.delayYellowFromMin}–${t.delayRedAboveMin} min`, String(s.by.DELAYED || 0), null, s.by.DELAYED ? 'yellow' : ''),
      kpi(`Over ${t.delayRedAboveMin} min`, String(s.by.CRITICAL || 0), null, s.by.CRITICAL ? 'red' : ''),
      kpi('Worst device', s.worst && s.worst.delayMinutes !== null ? minutes(s.worst.delayMinutes) : unknown('none'),
        s.worst && s.worst.delayMinutes !== null ? `${s.worst.device} · ${s.worst.cluster}` : null,
        s.worst ? tone(statusFor(s.worst.delayMinutes, ctx.delayT)) : '')),
    h('div.pl-split', devBox, clBox));
}
