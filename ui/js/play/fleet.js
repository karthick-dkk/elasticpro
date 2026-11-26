/**
 * Slide 1, Fleet (docs/PLAY.md): what is wrong now, whatever the number of clusters. Four figures
 * (clusters with a Critical or High problem, open Critical and High alerts, devices by log delay,
 * the fullest disks past the High line), then the clusters with a problem, worst first, with what
 * it is, why it matters and since when, then every other cluster. Nothing blinks.
 *
 * Every figure is one the rest of ElasticPro shows: the problems play/status.js, the alert counts
 * mergedAlerts, the disk lines core/alert-tuning.js, the devices the Log delay slide's rows.
 */

import { h } from '../lib/dom.js';
import { bytes } from '../lib/fmt.js';
import { diskLevel } from '../core/alert-tuning.js';
import { countLevels } from '../core/alert-levels.js';
import { heldLine } from '../core/alert-groups.js';
import { FLEET_KEYS, readFleetOrder } from '../core/play-config.js';
import { donut, unknown, fitRows, openFor, clockText } from './parts.js';
import { HEALTH_WORD } from './status.js';
import { ownStart } from './opened.js';
import { delayRows, delayTotals, levelWords, delayParts, measuredRow } from './logdelay.js';
import { cardsOf } from './volume.js';

export const id = 'fleet';
export const title = 'Fleet';
/** What the slide is drawn from: "last fetched" is the oldest of these. */
export const DATASETS = ['health', 'nodes'];

/** Clusters with a problem drawn large, and drawn half as high; the rest are among the small tiles. */
export const BIG = 3;
export const HALF = 4;
export const FULLEST = 5;

export const isEmpty = (ctx) => !ctx.clusters.length;

export const LEVEL_WORD = { critical: 'Critical', high: 'High' };

/** How many clusters are at each level: `{critical, high, none, nodata}`. */
export function levelCounts(ctx) {
  const n = { critical: 0, high: 0, none: 0, nodata: 0 };
  for (const c of ctx.clusters) {
    const s = ctx.st.get(c.id);
    n[s.level || (s.state === 'loading' ? 'nodata' : 'none')]++;
  }
  return n;
}

/** From where a disk counts as full: the High line, or Critical when the settings leave no room for High. */
const fullFrom = (lines) => (Number.isFinite(lines.high) ? lines.high : lines.critical);

/** The clusters whose fullest data node is at or past the High line, fullest first; `read` how many have a disk figure. */
export function fullDisks(ctx) {
  const all = ctx.clusters.map((c) => ({ c, f: ctx.st.get(c.id).fullest })).filter((x) => x.f);
  const list = all.filter((x) => x.f.pct >= fullFrom(ctx.lines)).sort((a, b) => b.f.pct - a.f.pct || byName(a.c, b.c));
  const top = all.length ? all.reduce((m, x) => (x.f.pct > m.f.pct ? x : m)) : null;
  return { list, read: all.length, top };
}

/**
 * The delay a cluster is ordered by (the median of its measured devices), or null when not
 * measured: the `logDelay` order key.
 */
export function tileDelayMinutes(ctx, c) {
  const del = ctx.delay.get(c.id);
  const sum = del && del.summary;
  return sum && typeof sum.median === 'number' ? sum.median : null;
}

/**
 * A down cluster's held alerts (alert-groups.js holdUnreachable): one dimmed line, the same
 * words as the Alerts page's unreachable line, in no count.
 */
export function heldNote(ctx, id) {
  const held = (ctx.heldBy && ctx.heldBy.get(id)) || [];
  if (!held.length) return null;
  return h('div.pl-theld', { title: held.map((m) => m.title).join(' · ') },
    heldLine(held, (t) => clockText(t, ctx.tz, { seconds: false })));
}

/**
 * A cluster's figure for one order key, or null when it is not known (never 0): `critical` the
 * status rank (status.js), `logDelay` the median delay, `volume` yesterday's volume (the Volume
 * slide's figure), `disk` the fullest disk, `alerts` the open count.
 */
export function fleetFigure(ctx, c, key) {
  const s = ctx.st.get(c.id);
  switch (key) {
    case 'critical': return s.rank;
    case 'logDelay': return tileDelayMinutes(ctx, c);
    case 'volume': {
      const v = ctx.volume && ctx.volume.get(c.id);
      return v && v.reply ? cardsOf(v.reply).yesterday : null;
    }
    case 'disk': return s.fullest ? s.fullest.pct : null;
    case 'alerts': return countLevels(ctx.openBy.get(c.id) || []).total;
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

/**
 * The clusters with a problem (the one that took the screen first, then Critical, then High,
 * each in the wall's order) and every other cluster.
 */
export function splitFleet(ctx) {
  const list = orderFleet(ctx, ctx.clusters, ctx.display && ctx.display.fleetOrder);
  const hot = ctx.takeover ? ctx.takeover.key : null;
  const isHot = (c) => ctx.st.get(c.id).problems.some((p) => p.key === hot);
  const rank = (c) => (hot && isHot(c) ? 0 : ctx.st.get(c.id).level === 'critical' ? 1 : 2);
  const bad = list.filter((c) => ctx.st.get(c.id).level);
  return { bad: bad.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c),
    rest: list.filter((c) => !ctx.st.get(c.id).level), hot };
}

const SHORT = { critical: 'critical', logDelay: 'delay', volume: 'volume', disk: 'disk', alerts: 'alerts', name: 'name' };
/** "critical › delay › volume", for the slide header chip. */
export const orderText = (order) => readFleetOrder(order).map((k) => SHORT[k]).join(' › ');
/** The full wording, for the chip's title. */
export const orderTitle = (order) => readFleetOrder(order).map((k) => FLEET_KEYS.find(([id]) => id === k)[1]).join(' › ');

/** Since when a problem has been open, as words: how long, or that nobody knows. */
export function sinceText(ctx, p) {
  // Server times against the server's clock: this screen's own may be wrong.
  const now = ctx.serverNow ? ctx.serverNow() : ctx.now;
  const long = (at) => openFor(Math.max(0, now - at));
  const own = p.alert ? ownStart(p.alert) : null;
  if (own) return `failing ${long(own)}`;
  const at = p.since || ctx.openSince(p);
  return at ? long(at) : 'since: not known';
}

const pct = (n) => `${Math.floor(n)} %`;
/** A disk's colour: its level; below every line, green. */
const diskTone = (p, lines) => ({ critical: 'red', high: 'orange', warning: 'yellow' })[diskLevel(p, null, lines)] || 'green';
const track = (p, tone, line) => h('span.pl-trk', h(`i.${tone}`, { style: { width: `${Math.min(100, Math.max(0, p))}%` } }),
  Number.isFinite(line) ? h('u', { style: { left: `${line}%` } }) : null);

function pill(ctx, p) {
  const text = `${LEVEL_WORD[p.level]} · ${sinceText(ctx, p)}`;
  return h(`span.pl-lvl.${p.level}`, { title: text }, text);
}
const ackText = (p) => (p.acked && p.alert ? `Acknowledged${p.alert.ackedBy ? ` by ${p.alert.ackedBy}` : ''}.` : '');
const whyText = (p) => [p.why, ackText(p)].filter(Boolean).join(/[.…]$/.test(p.why) ? ' ' : '. ');
/** A cluster's name; a long one takes two lines rather than be cut. */
const nameEl = (c) => h(`b.pl-ftn${c.name.length > 16 ? '.long' : ''}`, { title: c.name }, c.name);
const alsoText = (s) => (s.problems.length > 1 ? `+${s.problems.length - 1} more` : '');

function bigTile(ctx, c, dev, hot) {
  const s = ctx.st.get(c.id);
  const p = s.problems[0];
  const total = dev && dev.state === 'ok' ? dev.devices : 0;
  const w = (n) => (total ? `${(n / total) * 100}%` : '0%');
  return h(`div.pl-ft.big.${s.level}${hot ? '.hot' : ''}`, { dataset: { cluster: c.id } },
    h('div.pl-fth', nameEl(c), h('span.pl-hp', h(`i.${s.state}`), HEALTH_WORD[s.state] || s.state), pill(ctx, p)),
    h('div.pl-ftw', p.what, alsoText(s) ? h('small', { title: s.problems.slice(1).map((x) => `${LEVEL_WORD[x.level]}: ${x.what}`).join(' · ') }, ` ${alsoText(s)}`) : null),
    h('div.pl-fty', whyText(p)),
    heldNote(ctx, c.id),
    h('div.pl-ftf',
      h('span.pl-dim', 'Disk'), s.fullest ? track(s.fullest.pct, diskTone(s.fullest.pct, ctx.lines), fullFrom(ctx.lines)) : h('span'),
      s.fullest ? h('span', `${pct(s.fullest.pct)} · fullest of ${s.fullest.of}`) : unknown('not read'),
      h('span.pl-dim', 'Devices'), total ? h('span.pl-fbar', dev.onTime === null ? null : h('i.green', { style: { width: w(dev.onTime + dev.partDelayed) } }), h('i.yellow', { style: { width: w(dev.delay) } }), h('i.red', { style: { width: w(dev.critical) } })) : h('span'),
      dev && dev.state === 'ok' ? h('span', devText(dev, ctx)) : unknown('delay not read')));
}

/** A card's devices: on time and late; of a reading that counts only the late ones (onTime null), late of all. */
export function devText(dev, ctx) {
  const at = dev.at ? ` · checked ${clockText(dev.at, ctx.tz, { seconds: false })}` : '';
  return dev.onTime === null ? `${dev.late} late of ${dev.devices}${at}` : `${dev.onTime + dev.partDelayed} on time · ${dev.late} late${at}`;
}

function halfTile(ctx, c, hot) {
  const s = ctx.st.get(c.id);
  const p = s.problems[0];
  return h(`div.pl-ft.half.${s.level}${hot ? '.hot' : ''}`, { dataset: { cluster: c.id } },
    h('div.pl-fth', nameEl(c), pill(ctx, p)),
    h('div.pl-ftw', p.what, alsoText(s) ? h('small', ` ${alsoText(s)}`) : null),
    h('div.pl-fty', { title: p.why }, whyText(p)));
}

function smallTile(ctx, c, dev) {
  const s = ctx.st.get(c.id);
  if (s.level) {
    const p = s.problems[0];
    return h(`div.pl-ft.small.${s.level}`, { dataset: { cluster: c.id } },
      nameEl(c), h('div.pl-fth', h(`span.pl-lvl.${s.level}`, LEVEL_WORD[s.level]), h('div.pl-fty', { title: p.why }, p.what)));
  }
  const ok = dev && dev.state === 'ok';
  const late = ok && dev.devices ? (dev.late / dev.devices) * 100 : 0;
  return h('div.pl-ft.small', { dataset: { cluster: c.id } }, nameEl(c),
    s.state === 'loading' ? h('div.pl-fty', unknown('no data yet')) : h('div.pl-ftm',
      h('span', 'Disk'), s.fullest ? track(s.fullest.pct, diskTone(s.fullest.pct, ctx.lines)) : h('span'), s.fullest ? h('span', pct(s.fullest.pct)) : unknown('not read'),
      h('span', 'Late'), ok ? track(late, 'yellow') : h('span'), ok ? h('span', `${dev.late}/${dev.devices}`) : unknown('not read')));
}

function top(ctx, rows) {
  const n = levelCounts(ctx);
  const a = countLevels(ctx.open);
  const t = delayTotals(rows);
  const words = levelWords(rows, { delayFrom: ctx.watch.delayYellowFromMin, criticalOver: ctx.watch.delayRedAboveMin });
  const one = /^(\d+)–/.exec(words.delay);
  const total = ctx.clusters.length;
  const disks = fullDisks(ctx);
  const shown = disks.list.slice(0, FULLEST);
  return h('div.pl-ftop',
    h('div.pl-panel', h('div.pl-ph', 'Clusters with a Critical or High problem'),
      donut([{ n: n.critical, label: 'Critical', tone: 'red' }, { n: n.high, label: 'High', tone: 'orange' }, { n: n.none, label: 'None of them', tone: 'green' },
        ...(n.nodata ? [{ n: n.nodata, label: 'No data yet', tone: 'grey' }] : [])], { total: n.critical + n.high, label: `of ${total}` })),
    h('div.pl-panel', h('div.pl-ph', 'Open Critical and High alerts'),
      donut([{ n: a.critical, label: 'Critical', tone: 'red' }, { n: a.high, label: 'High', tone: 'orange' }], { total: a.critical + a.high, label: 'open' })),
    h('div.pl-panel', h('div.pl-ph', 'Devices by log delay', h('small', `${t.clusters} of ${total} clusters`)),
      t.clusters ? donut(delayParts(t, words, { oneLate: one ? `Late, ${one[1]} min or more` : 'Late' }),
      { total: t.devices, label: t.devices === 1 ? 'device' : 'devices' }) : unknown('not measured')),
    h('div.pl-panel', h('div.pl-ph', `Disk at ${fullFrom(ctx.lines)} % or more, ${FULLEST} fullest clusters`,
      h('small', disks.read < total ? `${disks.list.length} of ${disks.read} read, ${total - disks.read} not read` : `${disks.list.length} of ${total}`)),
    shown.length ? h('div.pl-fdisk', ...shown.map(({ c, f }) => h('div.pl-fdr', h('b', c.name), h('span.pl-dim', f.name), track(f.pct, diskTone(f.pct, ctx.lines), fullFrom(ctx.lines)),
      h(`b.num.${diskTone(f.pct, ctx.lines)}`, pct(f.pct)), h('span', `${bytes(f.avail)} free`))))
      : disks.read ? h('div.pl-fnone', `None. Fullest: ${pct(disks.top.f.pct)} on ${disks.top.f.name}, ${disks.top.c.name}`) : unknown('no disk read yet')));
}

/** Columns of the small tiles, so a fleet of any size fits one screen. */
const columns = (n) => (n <= 6 ? 6 : n <= 27 ? 9 : n <= 50 ? 10 : n <= 72 ? 12 : 14);

/**
 * Each cluster's devices for its card: its row of the scheduled record (delayRows), or, where that
 * has none read lately, the reading the cluster's log-delay alert rests on (state.js
 * delayReadingOf), with its time: a card never says "not read" beside an alert that read it.
 */
export function cardDevices(ctx, rows) {
  const dev = new Map(rows.map((r) => [r.id, r]));
  for (const c of ctx.clusters) {
    const r = dev.get(c.id);
    if (r && r.state === 'ok') continue;
    const read = ctx.delayReading ? ctx.delayReading(c.id) : null;
    if (read && read.summary) dev.set(c.id, { ...measuredRow(c, read.summary), at: read.at });
  }
  return dev;
}

export function render(ctx) {
  const rows = delayRows(ctx);
  const dev = cardDevices(ctx, rows);
  const { bad, rest, hot } = splitFleet(ctx);
  const isHot = (c) => !!hot && ctx.st.get(c.id).problems.some((p) => p.key === hot);
  const big = bad.slice(0, BIG), half = bad.slice(BIG, BIG + HALF), over = bad.slice(BIG + HALF);
  const nodata = rest.filter((c) => ctx.st.get(c.id).state === 'loading').length;
  const small = [...over, ...rest];
  const tiles = small.map((c) => smallTile(ctx, c, dev.get(c.id)));
  const cols = columns(small.length);
  const grid = h(`div.pl-fgrid${cols > 10 ? '.dense' : ''}`, { style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } }, tiles);
  ctx.afterMount(() => fitRows(grid, tiles, (n) => h('div.pl-ft.small.pl-more', `+${n} more`)));
  const head = [over.length ? `${over.length} more with a Critical or High problem, then the others` : bad.length ? 'Other clusters: no Critical or High problem' : 'All clusters', nodata ? `${nodata} with no data yet` : ''].filter(Boolean).join(', ');
  return h('div.pl-slide.pl-fleet', top(ctx, rows),
    big.length ? h('div.pl-frow', ...big.map((c) => bigTile(ctx, c, dev.get(c.id), isHot(c))))
      : h('div.pl-fclear', nodata === ctx.clusters.length ? 'No cluster has answered yet' : `No Critical or High problem on ${ctx.clusters.length - nodata} cluster${ctx.clusters.length - nodata === 1 ? '' : 's'}`),
    half.length ? h('div.pl-frow', ...half.map((c) => halfTile(ctx, c, isHot(c)))) : null,
    small.length ? h('div.pl-ph.pl-fhead', head, h('small', `${small.length} of ${ctx.clusters.length} · Late = devices over the delay line, of all its devices`)) : null,
    small.length ? grid : null);
}
