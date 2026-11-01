/**
 * Slide 6, Volume and capacity: from the daily volume record (0.3.45, VOLUME_DAILY — the
 * cards the Indices › Summary tab shows) and the volume report's days of disk left
 * (core/volume.js volumeReport().liveSufficientDays, as the Volume page shows it — pages/
 * play.js keeps one report per cluster, `ctx.report`).
 *
 * Two figures exist only here, because no other page shows the fleet as one: the sums of
 * the per-cluster cards (yesterday, average per day, month so far) over the clusters that
 * have a record, and the change of the first against the second. Both are said with how
 * many clusters they cover. Total events (spotlight) is Σ docs of the record's live days,
 * as docs/PLAY.md defines it.
 */

import { h } from '../lib/dom.js';
import { bytes } from '../lib/fmt.js';
import { signedPct } from '../lib/charts.js';
import { gb, days as fmtDays } from '../core/volume.js';
import { cardValue, dayBasis, basisOf, utcDay, NEEDS_VERSION } from '../core/volume-daily.js';
import { kpi, unknown, fitRows } from './parts.js';

export const id = 'volume';
export const title = 'Volume and capacity';
export const DATASETS = ['nodes', 'indices'];

export const isEmpty = (ctx) => !ctx.clusters.length;

/** Σ docs of the record's live days; null when no live day carries a count. */
export function totalEvents(reply) {
  const live = ((reply && reply.days) || []).filter((d) => d.live === true && typeof d.docs === 'number');
  return live.length ? live.reduce((s, d) => s + d.docs, 0) : null;
}

/** Yesterday's DailyRow as `{day, indices, size}` (size on the record's basis), or null. */
export function yesterdayRow(reply, now = Date.now()) {
  const want = (reply && reply.cards && reply.cards.yesterday && reply.cards.yesterday.day) || utcDay(now - 86400000);
  const r = ((reply && reply.days) || []).find((d) => d.day === want);
  if (!r) return null;
  return { day: r.day, indices: typeof r.indices === 'number' ? r.indices : null, size: dayBasis(r, basisOf(reply.settings)) };
}

/** The per-cluster cards a fleet sum is made of: `{yesterday, average, month, change}` (null each when not sent). */
export function cardsOf(reply) {
  const cards = (reply && reply.cards) || {};
  const y = cards.yesterday || null;
  return {
    yesterday: cardValue(y),
    average: cardValue(cards.average || cards.avgPerDay),
    month: cardValue(cards.monthSoFar || cards.month),
    change: y && typeof y.changeVsAvgPct === 'number' ? y.changeVsAvgPct : null,
  };
}

/**
 * The fleet's sums over the clusters whose record has the figure: `{value, of}` each, value
 * null when none has it — and the fleet's yesterday against its average, only over clusters
 * that have both (so a cluster missing one does not tilt the change).
 */
export function fleetVolume(cardList) {
  const sum = (k) => {
    const have = cardList.filter((x) => x && x[k] !== null && x[k] !== undefined);
    return { value: have.length ? have.reduce((s, x) => s + x[k], 0) : null, of: have.length };
  };
  const both = cardList.filter((x) => x && x.yesterday !== null && x.average !== null && x.average > 0);
  const ySum = both.reduce((s, x) => s + x.yesterday, 0), aSum = both.reduce((s, x) => s + x.average, 0);
  return {
    yesterday: sum('yesterday'), average: sum('average'), month: sum('month'),
    change: aSum > 0 ? ((ySum - aSum) / aSum) * 100 : null,
  };
}

export function render(ctx) {
  const rows = ctx.clusters.map((c) => {
    const v = ctx.volume.get(c.id);
    const r = ctx.report(c);
    return { c, v, cards: v && v.reply ? cardsOf(v.reply) : null, r };
  });
  const fleet = fleetVolume(rows.map((x) => x.cards));
  const n = ctx.clusters.length;
  const unsupported = rows.some((x) => x.v && x.v.unsupported);
  const noRec = unsupported ? `needs ${NEEDS_VERSION}` : 'no record yet';
  const cover = (f) => (f.of && f.of < n ? `${f.of} of ${n} clusters` : f.of ? `all ${n} clusters` : null);
  const runway = rows.filter((x) => x.r.liveSufficientDays !== null && isFinite(x.r.liveSufficientDays))
    .sort((a, b) => a.r.liveSufficientDays - b.r.liveSufficientDays)[0] || null;

  const list = [...rows].sort((a, b) => ((b.cards && b.cards.yesterday) ?? -1) - ((a.cards && a.cards.yesterday) ?? -1)
    || a.c.name.localeCompare(b.c.name, undefined, { numeric: true, sensitivity: 'base' }));
  const trs = list.map((x) => h('tr',
    h('td.pl-cname', x.c.name),
    h('td.num', x.cards && x.cards.yesterday !== null ? bytes(x.cards.yesterday) : unknown(x.v && x.v.unsupported ? noRec : 'no data')),
    h('td.num', x.cards && x.cards.average !== null ? bytes(x.cards.average) : unknown('–')),
    h(`td.num${x.cards && x.cards.change > 25 ? '.yellow' : ''}`, x.cards && x.cards.change !== null ? signedPct(x.cards.change) : unknown('–')),
    h(`td.num${x.r.liveSufficientDays !== null && x.r.liveSufficientDays < 7 ? '.red' : x.r.liveSufficientDays !== null && x.r.liveSufficientDays < 30 ? '.yellow' : ''}`,
      x.r.liveSufficientDays !== null && isFinite(x.r.liveSufficientDays) ? fmtDays(x.r.liveSufficientDays) : unknown('no data', 'Needs the index list and the disk figures')),
    h('td.num', x.r.liveTotalGB ? gb(x.r.liveTotalGB) : unknown('–'))));
  const body = h('tbody', trs);
  const box = h('div.pl-vtable', h('table.pl-tbl',
    h('thead', h('tr', h('th', 'Cluster'), h('th.num', 'Yesterday'), h('th.num', '7-day avg'), h('th.num', 'Change'),
      h('th.num', 'Days of disk left'), h('th.num', 'Total size'))), body));
  ctx.afterMount(() => fitRows(box, trs, (k) => h('div.pl-more', `+${k} more clusters`)));

  return h('div.pl-slide.pl-volume',
    h('div.pl-kpis',
      kpi('Yesterday · all clusters', fleet.yesterday.value === null ? unknown(noRec) : bytes(fleet.yesterday.value),
        fleet.change === null ? cover(fleet.yesterday) : `${signedPct(fleet.change)} vs 7-day avg · ${cover(fleet.yesterday)}`,
        fleet.change !== null && fleet.change > 25 ? 'yellow' : ''),
      kpi('Average per day', fleet.average.value === null ? unknown(noRec) : bytes(fleet.average.value), cover(fleet.average) ? `7 days · ${cover(fleet.average)}` : null),
      kpi('Month so far', fleet.month.value === null ? unknown(noRec) : bytes(fleet.month.value), cover(fleet.month)),
      kpi('Shortest disk runway', runway ? fmtDays(runway.r.liveSufficientDays) : unknown('no data', 'Needs the index list and the disk figures'),
        runway ? runway.c.name : null, runway && runway.r.liveSufficientDays < 7 ? 'red' : runway && runway.r.liveSufficientDays < 30 ? 'yellow' : '')),
    box);
}
