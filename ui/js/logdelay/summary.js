/**
 * Log Delay › Summary: the fleet view Reports › Log delay drew until 0.3.59, back next to
 * Dashboard on the owner's word (2026-11-17). docs/LOGDELAY.md "The Log Delay page" is the contract.
 *
 *   four tiles      (five with Part delayed, 0.3.90) total devices · with delay now (the delay band and above the critical line) ·
 *                   No delay (noDelayOf: on time + silent + can't measure) · its share with the split
 *   Delay reduced   devices back under the delay line in the last 2 / 4 / 6 / 12 / 24 h
 *   Day by day      one stacked bar per day, each tick its own date — at least the last 7 days
 *                   (dayChartDays): a shorter page range widens this card only, from its own answer
 *   Delayed devices by cluster   All clusters first, then a ring per cluster, worst first; a ring
 *                   opens that cluster on Dashboard
 *
 * Every figure is the core's LOGDELAY_SUMMARY (`totals`, `reduced`, `days`, `byCluster`), the same
 * answer the Dashboard reads (logdelay/boards.js asks it and keeps it); the arithmetic is
 * core/logdelay-report.js, the level names its bands(), the colours LD_COLOURS. Unknown is not
 * zero: a day without totals is a hatched gap, a cluster never measured an empty ring that says so.
 */

import { h, svg } from '../lib/dom.js';
import { card, empty } from '../pages/common.js';
import { partFill } from './device-types.js';
import {
  LD_COLOURS as C, LD_NEVER_MEASURED, noDelayOf, noDelaySplit, noDelayOfText, shareText, ldHash, bands, sharedLevels, countText,
  lateSplitText, reducedBars, ringsOrder, ringArcs, dayBars, dayTitle, dayTicks, dayChartWords, partOf, partText, partShareText,
} from '../core/logdelay-report.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const never = (c) => !c || c.lastRunAt === null || c.lastRunAt === undefined;
const key = (colour, text) => h('span.ld-key', h('i', { style: { background: colour } }), text);
const legend = (...k) => h('span.ld-legend', ...k.filter(Boolean));
const kpi = (k, value, label, tone) => h('div.ld-kpi', { dataset: { kpi: k } },
  h(`b${tone ? `.${tone}` : ''}`, value), ...(Array.isArray(label) ? label : [h('span', label)]));

/** The four tiles and Delay reduced, one row. */
function tiles(res, b, lv) {
  const t = res.totals || {};
  const red = reducedBars(res.reduced, 44);
  const back = lv && finite(lv.delayFrom) ? `${lv.delayFrom} min` : 'the delay line';
  const list = res.byCluster || [];
  const none = list.length > 0 && list.every(never);
  const nd = noDelayOf(t, { why: none ? 'never measured' : '' });
  const n = (v) => (none ? '—' : countText(v));
  const late = nd.late;
  const pc = nd.pct || {};
  // Part delayed (0.3.90): null for a core that does not measure log types, then the row is as it was.
  const part = partOf(none ? (t.partDelayed === undefined ? {} : { partDelayed: null }) : t, list);
  const partBox = part ? kpi('part', part.count === null ? '—' : n(part.count), [h('span', partFill('i.ld-sw'), ' part delayed'), h('span.ld-small', none ? 'never measured' : partText(part))]) : null;
  return h(`div.ld-kpis.${partBox ? 'ld-7' : 'ld-6'}#ld-sum-tiles`,
    kpi('devices', n(t.devices), none ? 'never measured' : 'total devices'),
    kpi('late', n(late), none ? 'never measured' : `devices with delay at the last run · ${lateSplitText(t, b)}`, none || !late ? null : t.critical ? 'ld-crit' : 'ld-delay'),
    partBox,
    kpi('onTime', n(nd.count), none ? 'never measured' : [h('span', 'No delay'), h('span.ld-small', noDelaySplit(nd, { counts: true }))], none ? null : 'ld-ok'),
    kpi('pct', shareText(pc.noDelay), [h('span', 'No delay'),
      h('span.ld-small', nd.pct ? `${noDelaySplit(nd)} · ${shareText(pc.late)} delayed${partShareText(pc) ? ` · ${partShareText(pc)}` : ''}` : `no percentage: ${nd.why}`,
        nd.pct && nd.of ? ` · ${noDelayOfText(nd)}` : '',
        !none && finite(t.otherTz) && t.otherTz ? ` · ${countText(t.otherTz)} in another time zone` : '')], nd.pct ? 'ld-ok' : null),
    h('div.ld-kpi.ld-wide', { dataset: { kpi: 'reduced' } },
      h('span', `Delay reduced · devices back under ${back} in the last`),
      h('div.ld-reduced#ld-sum-reduced', { role: 'img', 'aria-label': `Devices back under ${back}: ${red.map((r) => `${r.n === null ? 'not known' : r.n} in the last ${r.label}`).join(', ')}` },
        ...red.map((r) => h('span.ld-red', { dataset: { hours: String(r.hours) }, title: `${r.n === null ? 'Not known' : countText(r.n)} device${r.n === 1 ? '' : 's'} back under ${back} in the last ${r.label}` },
          h('b', r.n === null ? '—' : countText(r.n)), r.px ? h('i', { style: { height: `${r.px}px`, background: C.ok } }) : null))),
      h('div.ld-red-labels', ...red.map((r) => h('span', r.label)))));
}

/**
 * The figures written on a day's bar (the owner, 0.3.101): devices delayed (the 30–60 min band and
 * above 60 min, the yellow and red) and No delay (the green: on time, silent and can't measure — the
 * same count as the tooltip and the legend). Part delayed and another time zone stay in the tooltip.
 * A bar too narrow for the words (a long range) hides them (app.css container query).
 */
function dayLabel(d) {
  const late = (finite(d.delayed) ? d.delayed : 0) + (finite(d.critical) ? d.critical : 0);
  return h('span.ld-day-lab', { 'aria-hidden': 'true' },
    h('span', { dataset: { lab: 'delay' } }, `Delay ${countText(late)}`),
    h('span', { dataset: { lab: 'nodelay' } }, `No delay ${countText(noDelayOf(d).count)}`));
}

/**
 * Day by day over `win` (dayChartDays: at least the last 7 days) from `daysRes`, its own answer;
 * `pending` is drawn instead while that answer is read or could not be. Nothing measured says so,
 * never an empty chart read as 0.
 */
function dayCard(daysRes, win, b, pending) {
  const sub = `${dayChartWords(win)} · a bar’s figures on hover`;
  if (!daysRes) return card('Day by day', sub, pending);
  const list = daysRes.days || [];
  const H = 132;
  const measured = list.filter((d) => d && finite(d.devices) && d.devices > 0);
  const covered = dayChartWords(win);
  if (!measured.length) {
    return card('Day by day', sub, empty(`No day in ${covered.split(' · ').pop()} has totals: nothing was measured.`, { detail: 'A day appears here once the scheduled measurement has run on it.' }));
  }
  const bars = dayBars(list, H);
  const ticks = dayTicks(list);
  const anyPart = measured.some((d) => finite(d.partDelayed) && d.partDelayed > 0);
  const seg = (px, colour, kind) => (px ? h(`i${kind === 'part' ? '.ld-part-fill' : ''}`, { dataset: { seg: kind }, style: { height: `${px}px`, background: colour } }) : null);
  const late = measured.map((d) => (d.delayed || 0) + (d.critical || 0));
  const anyTz = measured.some((d) => finite(d.otherTz) && d.otherTz > 0);
  const chart = h('div.ld-chart.ld-sum-days',
    h('div.ld-days#ld-sum-days', { role: 'img', 'aria-label': `Devices per day, ${covered}: between ${Math.min(...late)} and ${Math.max(...late)} delayed`, style: { height: `${H}px` } },
      ...bars.map((x, i) => h(`span.ld-day${x.gap ? '.ld-gap' : ''}`, { title: dayTitle(list[i], b), dataset: { day: x.day || '' } },
        seg(x.ok, C.ok, 'ok'), seg(x.tz, C.tz, 'tz'), seg(x.part, C.part, 'part'), seg(x.delay, C.delay, 'delay'), seg(x.critical, C.crit, 'critical'),
        x.gap ? null : dayLabel(list[i])))),
    h('div.ld-ticks#ld-sum-ticks', ...ticks.map((t) => h('span', t))));
  return card('Day by day', sub, chart,
    [legend(key(C.ok, 'No delay (silent and can’t measure included)'), key(C.delay, b.mid), key(C.crit, b.high), anyPart ? h('span.ld-key', partFill('i'), 'Part delayed') : null, anyTz ? key(C.tz, 'Other time zone') : null)]);
}

/**
 * One ring: red above the critical line, yellow the delay band, light yellow part delayed where counted, green No delay (what is left is another
 * time zone); the late share is its figure. Unknown is an empty ring with "—".
 */
function ring(o) {
  const arcs = o.never ? null : o.why ? null : ringArcs(o.delay, o.critical, o.devices, o.nd && o.nd.count, o.nd && o.nd.part);
  const known = arcs !== null && finite(o.pct);
  const arcColour = (kind) => ({ critical: C.crit, delay: C.delay, part: C.part, ok: C.ok }[kind]);
  const nd = o.nd;
  const title = o.never ? `${o.name}: ${LD_NEVER_MEASURED}`
    : o.why ? `${o.name}: no percentage — ${o.why}`
    : known ? `${o.name}: ${countText(o.late)} of ${countText(o.devices)} devices delayed (${shareText(o.pct)})${nd && nd.pct ? ` · No delay ${shareText(nd.pct.noDelay)} (${noDelaySplit(nd)})` : ''}${nd && nd.part !== undefined ? ` · ${countText(nd.part)} part delayed` : ''} · opens ${o.all ? 'Dashboard' : 'the cluster'}`
      : `${o.name}: no device measured`;
  const circle = (stroke, extra = {}) => svg('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', stroke, 'stroke-width': 5, ...extra });
  return h(`a.ld-ring${o.all ? '.ld-all' : ''}`, { href: o.href, title, dataset: { ring: o.all ? 'all' : o.id, known: String(known) } },
    h('span.ld-ring-pic',
      svg('svg', { width: 84, height: 84, viewBox: '0 0 42 42', role: 'img', 'aria-label': title },
        circle('var(--surface-3)'),
        ...(arcs || []).map((a) => circle(arcColour(a.kind), { class: `ld-arc ld-arc-${a.kind}`, 'stroke-dasharray': a.dash, 'stroke-dashoffset': a.offset }))),
      h('span.ld-ring-mid', h('b', known ? shareText(o.pct) : '—'), h('span', known ? 'delayed' : 'not measured'))),
    h('span.ld-ring-name', o.name),
    h('span.ld-ring-sub', o.never ? 'never measured' : known ? [h('b', countText(o.late)), ` of ${countText(o.devices)} devices`] : o.why ? 'last run failed' : 'no device measured'));
}

/** Delayed devices by cluster: All clusters first (when every cluster is in view), then each cluster worst first. */
function ringsCard(res, b, clusterId, nameOf) {
  const t = res.totals || {};
  const late = (x, y) => (finite(x) && finite(y) ? x + y : null);
  const rings = [];
  if (!clusterId) {
    rings.push(ring({ all: true, name: 'All clusters', href: ldHash('fleet'), delay: t.delay, critical: t.critical, devices: t.devices,
      late: finite(t.late) ? t.late : late(t.delay, t.critical), pct: t.pctLate, nd: noDelayOf(t), why: '', never: (res.byCluster || []).length > 0 && res.byCluster.every(never) }));
  }
  for (const c of ringsOrder(res.byCluster)) {
    rings.push(ring({ id: c.id, name: c.name || nameOf(c.id), href: ldHash('cluster', c.id), delay: c.delay, critical: c.critical, devices: c.devices,
      late: finite(c.lateNow) ? c.lateNow : late(c.delay, c.critical), pct: c.latePct, nd: noDelayOf(c), why: !never(c) && c.notMeasured ? c.notMeasured : '', never: never(c) }));
  }
  return card('Delayed devices by cluster', `share of each cluster’s devices at ${b.late} at its last run · worst first · a ring opens the cluster`,
    rings.length ? h('div.ld-rings#ld-rings', ...rings) : empty('No cluster you can see is measured.'),
    [legend(key(C.crit, b.high), key(C.delay, b.mid), (res.byCluster || []).some((c) => finite(c.partDelayed) && c.partDelayed) ? h('span.ld-key', partFill('i'), 'Part delayed') : null, key(C.ok, 'No delay'))]);
}

/**
 * The Summary's cards: `res` is the LOGDELAY_SUMMARY answer for the page's range (the tiles, Delay
 * reduced, the rings), `daysRes` the one for Day by day's days `win` (the same answer when the
 * range already covers them; null while it is read, then `daysPending` is drawn). `clusterId`
 * names the one cluster in view (its tiles, its days, its own ring), null for every cluster.
 */
export function summaryCards(res, { clusterId = null, nameOf = (id) => id, daysRes = res, win = null, daysPending = null } = {}) {
  const lv = sharedLevels(res.byCluster);
  const b = bands(lv);
  const w = win || { from: res.from, to: res.to, days: (res.days || []).length, widened: false };
  return [tiles(res, b, lv), dayCard(daysRes, w, b, daysPending), ringsCard(res, b, clusterId, nameOf)];
}
