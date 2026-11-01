/**
 * Slide 1, the fleet wall: a tile per cluster, worst first, and a strip of fleet figures
 * above them. Every figure is one the rest of ElasticPro already shows — health
 * (healthState), the status line (play/status.js), open alerts (mergedAlerts), the fullest
 * disk (diskBalance), log delay (measureDelay + summarise + classify).
 */

import { h } from '../lib/dom.js';
import { alertCounts } from '../core/alert-tuning.js';
import { classify, STATUS } from '../core/log-delay.js';
import { kpi, unknown, minutes, fitRows, openFor, clockText } from './parts.js';
import { heldLine } from '../core/alert-groups.js';
import { toneOfCounts } from '../core/alert-levels.js';
import { tileBlink, nodeDiskCritical } from './status.js';
import { FLEET_KEYS, readFleetOrder } from '../core/play-config.js';
import { cardsOf } from './volume.js';

export const id = 'fleet';
export const title = 'Fleet';
/** What the slide is drawn from: "last fetched" is the oldest of these. */
export const DATASETS = ['health', 'nodes'];

export const isEmpty = (ctx) => !ctx.clusters.length;

/**
 * Clusters by the colour their tile shows (play/status.js tone): red, not answering, high,
 * yellow, green, no data — so the strip and the wall below it cannot disagree.
 */
export const statusCounts = (ctx) => {
  const n = { red: 0, unreachable: 0, high: 0, yellow: 0, green: 0, loading: 0 };
  for (const c of ctx.clusters) {
    const s = ctx.st.get(c.id);
    const k = s.state === 'unreachable' || s.state === 'loading' ? s.state
      : s.tone === 'orange' ? 'high' : s.tone === 'grey' ? 'loading' : s.tone;
    n[k in n ? k : 'loading']++;
  }
  return n;
};

/** The newest node that left, across the wall: {node, since, cluster}. */
function newestLeft(ctx) {
  let best = null;
  for (const c of ctx.clusters) {
    for (const l of ctx.st.get(c.id).left) {
      const since = Number(l.since) || Date.parse(l.since) || 0;
      if (!best || since > best.since) best = { node: l.node, since, cluster: c.name };
    }
  }
  return best;
}

function strip(ctx) {
  const n = statusCounts(ctx);
  const a = alertCounts(ctx.open);
  const left = ctx.clusters.reduce((s, c) => s + ctx.st.get(c.id).left.length, 0);
  const newest = newestLeft(ctx);
  const measured = ctx.clusters.filter((c) => ctx.delay.get(c.id) && ctx.delay.get(c.id).summary);
  const mid = measured.reduce((s, c) => s + (ctx.delay.get(c.id).summary.by.DELAYED || 0), 0);
  const high = measured.reduce((s, c) => s + (ctx.delay.get(c.id).summary.by.CRITICAL || 0), 0);
  let full = null;
  for (const c of ctx.clusters) {
    const f = ctx.st.get(c.id).fullest;
    if (f && (!full || f.pct > full.pct)) full = { ...f, cluster: c.name };
  }
  const part = (k, cls) => (n[k] ? h(`span.pl-c.${cls}`, `${n[k]} ${k === 'unreachable' ? 'not answering' : k === 'loading' ? 'no data' : k}`) : null);
  return h('div.pl-strip',
    kpi('Clusters by status', h('span.pl-parts', part('red', 'red'), part('unreachable', 'red'), part('high', 'orange'), part('yellow', 'yellow'),
      part('green', 'green'), part('loading', 'grey')), `${ctx.clusters.length} on this display`),
    kpi('Open alerts', h('span.pl-parts', h(`span.pl-c.${a.critical ? 'red' : 'grey'}`, `${a.critical} critical`),
      h(`span.pl-c.${a.high ? 'orange' : 'grey'}`, `${a.high} high`),
      h(`span.pl-c.${a.warning ? 'yellow' : 'grey'}`, `${a.warning} warning`)), null, toneOfCounts(a) || 'green'),
    kpi('Node left', ctx.nodeHistory ? String(left) : unknown('not tracked', 'This server does not keep node-name history yet (needs 0.3.47)'),
      newest ? `${newest.node} · ${newest.cluster} · ${openFor(ctx.now - newest.since)} ago` : ctx.nodeHistory ? 'none in 24 h' : 'needs 0.3.47',
      left ? 'red' : ''),
    kpi('Delayed devices', measured.length ? h('span.pl-parts', h(`span.pl-c.${mid ? 'yellow' : 'grey'}`, `${mid} at ${ctx.watch.delayYellowFromMin}–${ctx.watch.delayRedAboveMin} min`),
      h(`span.pl-c.${high ? 'red' : 'grey'}`, `${high} over ${ctx.watch.delayRedAboveMin} min`)) : unknown('not measured'),
    measured.length ? `${measured.length} of ${ctx.clusters.length} clusters measured` : ctx.delayNote),
    kpi('Fullest disk', full ? `${Math.round(full.pct)} %` : unknown(),
      full ? `${full.name} · ${full.cluster}` : null, full ? (nodeDiskCritical(full.pct, full) ? 'red' : full.pct >= full.low ? 'yellow' : '') : ''));
}

function tile(ctx, c) {
  const s = ctx.st.get(c.id);
  const d = ctx.data(c.id) || {};
  const nodes = ctx.nodes(c.id);
  const open = ctx.openBy.get(c.id) || [];
  const a = alertCounts(open);
  const del = ctx.delay.get(c.id);
  const sum = del && del.summary;
  const present = nodes && Array.isArray(nodes.present) ? nodes.present.length : (d.health ? d.health.number_of_nodes : null);
  const expected = nodes && Array.isArray(nodes.expected) && nodes.expected.length ? nodes.expected.length : null;
  const delayTone = sum && sum.median !== null ? STATUS[classify(sum.median, ctx.delayT)].cls : 'grey';
  const blink = tileBlink(s, ctx.blink(c.id));
  return h(`div.pl-tile.${s.tone}${blink ? `.${blink}` : ''}`, { dataset: { cluster: c.id } },
    h('div.pl-tname', { title: c.name }, c.name),
    h(`div.pl-tline.${s.tone}`, s.line),
    h('div.pl-tfig',
      h('span', h('b', present === null || present === undefined ? '–' : String(present)), expected ? `/${expected}` : '', ' nodes'),
      h('span', s.fullest ? h('b', `${Math.round(s.fullest.pct)} %`) : unknown('–'), ' disk'),
      h('span', sum && sum.median !== null ? h(`b.${delayTone}`, minutes(sum.median)) : unknown(del && del.error ? 'not measurable' : 'not measured', del && del.error ? del.error : ''), ' delay'),
      h('span', h(`b${toneOfCounts(a) ? `.${toneOfCounts(a)}` : ''}`, String(a.total)), ' alerts')),
    h('div.pl-tdev', { title: `Devices by delay: under ${ctx.watch.delayYellowFromMin} min, ${ctx.watch.delayYellowFromMin}–${ctx.watch.delayRedAboveMin} min, over ${ctx.watch.delayRedAboveMin} min` },
      sum ? [h('span.pl-dev.green', String(sum.by.OK || 0)), h('span.pl-dev.yellow', String(sum.by.DELAYED || 0)), h('span.pl-dev.red', String(sum.by.CRITICAL || 0))]
        : h('span.pl-unk', 'devices not measured')),
    heldNote(ctx, c.id));
}

/**
 * A down cluster's held alerts (alert-groups.js holdUnreachable): one dimmed line, the same
 * words as the Alerts page's unreachable line, in no count on the tile or the strip.
 */
export function heldNote(ctx, id) {
  const held = (ctx.heldBy && ctx.heldBy.get(id)) || [];
  if (!held.length) return null;
  return h('div.pl-theld', { title: held.map((m) => m.title).join(' · ') },
    heldLine(held, (t) => clockText(t, ctx.tz, { seconds: false })));
}

/** Smaller tiles for a bigger wall, so a fleet fits one screen. */
const density = (n) => (n <= 8 ? 'xl' : n <= 15 ? 'l' : n <= 30 ? 'm' : n <= 60 ? 's' : 'xs');

/**
 * A cluster's figure for one order key, or null when it is not known (never 0). Each is the
 * figure the rest of Play already shows: `critical` is the status rank (status.js, the one
 * definition of "what is wrong"), `logDelay` the worst device's delay of the cluster (the
 * Log delay slide's "Worst device", per cluster), `volume` yesterday's volume (the Volume
 * slide's figure), `disk` the fullest disk (status.fullest), `alerts` the open count on the tile.
 */
export function fleetFigure(ctx, c, key) {
  const s = ctx.st.get(c.id);
  switch (key) {
    case 'critical': return s.rank;
    case 'logDelay': {
      const del = ctx.delay.get(c.id);
      const w = del && del.summary && del.summary.worst;
      return w && typeof w.delayMinutes === 'number' ? w.delayMinutes : null;
    }
    case 'volume': {
      const v = ctx.volume && ctx.volume.get(c.id);
      return v && v.reply ? cardsOf(v.reply).yesterday : null;
    }
    case 'disk': return s.fullest ? s.fullest.pct : null;
    case 'alerts': return alertCounts(ctx.openBy.get(c.id) || []).total;
    default: return null;
  }
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The wall's order: the keys in turn, each largest first (name A to Z); a cluster with no
 * figure for a key goes after every cluster that has one; the cluster name breaks a final tie.
 */
export function orderFleet(ctx, clusters, order) {
  const keys = readFleetOrder(order);
  const fig = new Map(clusters.map((c) => [c.id, keys.map((k) => (k === 'name' ? null : fleetFigure(ctx, c, k)))]));
  return [...clusters].sort((x, y) => {
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === 'name') { const n = byName(x, y); if (n) return n; continue; }
      const a = fig.get(x.id)[i], b = fig.get(y.id)[i];
      if (a === null || b === null) { if (a === b) continue; return a === null ? 1 : -1; }
      if (a !== b) return b - a;
    }
    return byName(x, y);
  });
}

/** "Critical problems › Log delay › Volume used yesterday", for the slide header. */
export const orderText = (order) => readFleetOrder(order).map((k) => FLEET_KEYS.find(([id]) => id === k)[1]).join(' › ');

export function render(ctx) {
  const list = orderFleet(ctx, ctx.clusters, ctx.display && ctx.display.fleetOrder);
  const tiles = list.map((c) => tile(ctx, c));
  const grid = h(`div.pl-tiles.${density(list.length)}`, tiles);
  ctx.afterMount(() => fitRows(grid, tiles, (n) => h('div.pl-tile.pl-more', `+${n} more`)));
  return h('div.pl-slide.pl-fleet', strip(ctx), grid);
}
