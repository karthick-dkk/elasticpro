/**
 * Log Delay › Summary: the fleet view Reports › Log delay drew until 0.3.59, back next to
 * Dashboard on the owner's word (2026-11-17). docs/LOGDELAY.md "The Log Delay page" is the contract.
 *
 *   four tiles      total devices · with delay now (the delay band and above the critical line) ·
 *                   with no delay (on time %) · the shares: without delay, delayed, silent, can't measure
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
import {
  LD_COLOURS as C, LD_NEVER_MEASURED, ldHash, bands, sharedLevels, countText, pctText,
  lateSplitText, reducedBars, ringsOrder, ringArcs, dayBars, dayTitle, dayTicks, dayChartWords,
  LD_RING_RED_PCT, ringAlert,
} from '../core/logdelay-report.js';

/** A ring above LD_RING_RED_PCT: the theme's critical red, the delay band a lighter mix of it. */
const RED = 'var(--level-crit)';
const RED_SOFT = 'color-mix(in srgb, var(--level-crit) 55%, var(--surface-1))';

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
  const late = finite(t.late) ? t.late : finite(t.delay) && finite(t.critical) ? t.delay + t.critical : null;
  return h('div.ld-kpis.ld-6#ld-sum-tiles',
    kpi('devices', countText(t.devices), 'total devices'),
    kpi('late', countText(late), `devices with delay now · ${lateSplitText(t, b)}`, late ? 'ld-crit' : null),
    kpi('onTime', countText(t.onTime), `devices with no delay · ${pctText(t.pctOnTime)} on time`, 'ld-ok'),
    kpi('pct', pctText(t.pctOnTime), [h('span', 'without delay'),
      h('span.ld-small', `${pctText(t.pctLate)} delayed · ${pctText(t.pctSilent)} silent · ${pctText(t.pctUnmeasured)} can’t measure`,
        finite(t.otherTz) && t.otherTz ? ` · ${countText(t.otherTz)} in another time zone` : '')], 'ld-ok'),
    h('div.ld-kpi.ld-wide', { dataset: { kpi: 'reduced' } },
      h('span', `Delay reduced · devices back under ${back} in the last`),
      h('div.ld-reduced#ld-sum-reduced', { role: 'img', 'aria-label': `Devices back under ${back}: ${red.map((r) => `${r.n === null ? 'not known' : r.n} in the last ${r.label}`).join(', ')}` },
        ...red.map((r) => h('span.ld-red', { dataset: { hours: String(r.hours) }, title: `${r.n === null ? 'Not known' : countText(r.n)} device${r.n === 1 ? '' : 's'} back under ${back} in the last ${r.label}` },
          h('b', r.n === null ? '—' : countText(r.n)), r.px ? h('i', { style: { height: `${r.px}px`, background: C.ok } }) : null))),
      h('div.ld-red-labels', ...red.map((r) => h('span', r.label)))));
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
  const seg = (px, colour, kind) => (px ? h('i', { dataset: { seg: kind }, style: { height: `${px}px`, background: colour } }) : null);
  const late = measured.map((d) => (d.delayed || 0) + (d.critical || 0));
  const anyTz = measured.some((d) => finite(d.otherTz) && d.otherTz > 0);
  const chart = h('div.ld-chart.ld-sum-days',
    h('div.ld-days#ld-sum-days', { role: 'img', 'aria-label': `Devices per day, ${covered}: between ${Math.min(...late)} and ${Math.max(...late)} delayed`, style: { height: `${H}px` } },
      ...bars.map((x, i) => h(`span.ld-day${x.gap ? '.ld-gap' : ''}`, { title: dayTitle(list[i], b), dataset: { day: x.day || '' } },
        seg(x.ok, C.ok, 'ok'), seg(x.tz, C.tz, 'tz'), seg(x.unk, C.silent, 'unknown'), seg(x.delay, C.delay, 'delay'), seg(x.critical, C.crit, 'critical')))),
    h('div.ld-ticks#ld-sum-ticks', ...ticks.map((t) => h('span', t))));
  return card('Day by day', sub, chart,
    [legend(key(C.ok, b.below), key(C.delay, b.mid), key(C.crit, b.high), anyTz ? key(C.tz, 'Other time zone') : null, key(C.silent, 'Silent or can’t measure'))]);
}

/**
 * One ring: the late share as two arcs (above the critical line, then the delay band); unknown is
 * an empty ring with "—". Above LD_RING_RED_PCT delayed both arcs are red (`data-alert`), the
 * delay band a lighter red: the ring has no other warm colour, so never red with yellow.
 */
function ring(o) {
  const arcs = o.never ? null : ringArcs(o.delay, o.critical, o.devices);
  const known = arcs !== null && finite(o.pct);
  const alert = known && ringAlert(o.pct);
  const arcColour = (kind) => (alert ? (kind === 'critical' ? RED : RED_SOFT) : kind === 'critical' ? C.crit : C.delay);
  const title = o.never ? `${o.name}: ${LD_NEVER_MEASURED}`
    : known ? `${o.name}: ${countText(o.late)} of ${countText(o.devices)} devices delayed (${pctText(o.pct)}) · opens ${o.all ? 'Dashboard' : 'the cluster'}`
      : `${o.name}: no device measured`;
  const circle = (stroke, extra = {}) => svg('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', stroke, 'stroke-width': 5, ...extra });
  return h(`a.ld-ring${o.all ? '.ld-all' : ''}`, { href: o.href, title: alert ? `${title} · above ${LD_RING_RED_PCT} % delayed` : title, dataset: { ring: o.all ? 'all' : o.id, known: String(known), alert: String(alert) } },
    h('span.ld-ring-pic',
      svg('svg', { width: 84, height: 84, viewBox: '0 0 42 42', role: 'img', 'aria-label': title },
        circle('var(--surface-3)'),
        ...(arcs || []).map((a) => circle(arcColour(a.kind), { class: `ld-arc ld-arc-${a.kind}`, 'stroke-dasharray': a.dash, 'stroke-dashoffset': a.offset }))),
      h('span.ld-ring-mid', h('b', known ? pctText(o.pct) : '—'), h('span', known ? 'delayed' : 'not measured'))),
    h('span.ld-ring-name', o.name),
    h('span.ld-ring-sub', o.never ? 'never measured' : known ? [h('b', countText(o.late)), ` of ${countText(o.devices)} devices`] : 'no device measured'));
}

/** Delayed devices by cluster: All clusters first (when every cluster is in view), then each cluster worst first. */
function ringsCard(res, b, clusterId, nameOf) {
  const t = res.totals || {};
  const late = (x, y) => (finite(x) && finite(y) ? x + y : null);
  const rings = [];
  if (!clusterId) {
    rings.push(ring({ all: true, name: 'All clusters', href: ldHash('fleet'), delay: t.delay, critical: t.critical, devices: t.devices,
      late: finite(t.late) ? t.late : late(t.delay, t.critical), pct: t.pctLate, never: false }));
  }
  for (const c of ringsOrder(res.byCluster)) {
    rings.push(ring({ id: c.id, name: c.name || nameOf(c.id), href: ldHash('cluster', c.id), delay: c.delay, critical: c.critical, devices: c.devices,
      late: finite(c.lateNow) ? c.lateNow : late(c.delay, c.critical), pct: c.latePct, never: never(c) }));
  }
  return card('Delayed devices by cluster', `share of each cluster’s devices at ${b.late} now · worst first · a ring opens the cluster`,
    rings.length ? h('div.ld-rings#ld-rings', ...rings) : empty('No cluster you can see is measured.'),
    [legend(key(C.crit, b.high), key(C.delay, b.mid), key('var(--surface-3)', 'not delayed now'), key(RED, `Above ${LD_RING_RED_PCT} % delayed`))]);
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
