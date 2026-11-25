/**
 * Slide 4, Volume and capacity (docs/PLAY.md): the daily volume record of every cluster on this
 * display put together (VOLUME_DAILY, the days the Reports page draws), finished days only, and
 * the disk each cluster uses. What exists only here, because no other page shows the fleet as
 * one: the sums per day and their change against the day before.
 *
 * A day a cluster has no figure for is in no sum and no change: a sum says how many clusters it
 * covers, a change is only over clusters with both days. A day read less than 24 hours after it
 * ended (yesterday) is drawn as the Reports page draws it and is said to be not final.
 */

import { h, svg } from '../lib/dom.js';
import { bytes } from '../lib/fmt.js';
import { diskLevel } from '../core/alert-tuning.js';
import { cardValue, dayBasis, basisOf, shortDay, utcDay, finishedDays, BASIS_LABEL, NEEDS_VERSION } from '../core/volume-daily.js';
import { unknown } from './parts.js';

export const id = 'volume';
export const title = 'Volume and capacity';
export const DATASETS = ['nodes'];

export const DAYS = 14;
export const TOP_DISK = 8;
export const TOP_CHANGE = 7;
const TOP_SHARE = 4;

export const isEmpty = (ctx) => !ctx.clusters.length;

/** The per-cluster cards: `{yesterday, average, month, change}` (null each when not sent). */
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

const addDays = (ymd, n) => utcDay(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000);
/** Percent change, null when it cannot be one. */
export const change = (now, was) => (typeof now === 'number' && typeof was === 'number' && was > 0 ? (now / was - 1) * 100 : null);

/** One cluster's finished days as a Map day → {value, avg, notFinal}, from its record; null with no record. */
export function seriesOf(reply, today = utcDay()) {
  if (!reply) return null;
  const basis = basisOf(reply.settings);
  const out = new Map();
  for (const d of finishedDays(reply, today)) {
    const value = dayBasis(d, basis);
    if (value !== null) out.set(d.day, { value, avg: typeof d.avg === 'number' ? d.avg : null, notFinal: d.final === false });
  }
  return out;
}

/**
 * The last `DAYS` finished days together, oldest first: `{day, value, of, notFinal, avg, pct,
 * pctOf}`. `notFinal`: how many of the figures are not final; `value` sums the clusters with that day (null when none), `avg` their 7-day averages (null
 * unless every one of them has it), `pct` the change against the day before over the `pctOf`
 * clusters with both days.
 */
export function fleetDays(series, today = utcDay()) {
  const last = addDays(today, -1);
  return Array.from({ length: DAYS }, (_, i) => addDays(last, i - DAYS + 1)).map((day) => {
    const have = series.map((s) => s.get(day)).filter(Boolean);
    const both = series.filter((s) => s.has(day) && s.has(addDays(day, -1)));
    const sum = (f) => both.reduce((a, s) => a + f(s), 0);
    return { day, of: have.length, notFinal: have.filter((x) => x.notFinal).length, value: have.length ? have.reduce((a, x) => a + x.value, 0) : null,
      avg: have.length && have.every((x) => x.avg !== null) ? have.reduce((a, x) => a + x.avg, 0) : null,
      pctOf: both.length, pct: both.length ? change(sum((s) => s.get(day).value), sum((s) => s.get(addDays(day, -1)).value)) : null };
  });
}

/** Each cluster's change of the last finished day, biggest in bytes first; `unknown` how many have not both days. */
export function changeList(rows, today = utcDay()) {
  const day = addDays(today, -1), before = addDays(day, -1);
  const list = [];
  let missing = 0;
  for (const r of rows) {
    const a = r.series && r.series.get(before), b = r.series && r.series.get(day);
    if (!a || !b) { missing++; continue; }
    list.push({ name: r.c.name, was: a.value, now: b.value, diff: b.value - a.value, pct: change(b.value, a.value) });
  }
  list.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff) || x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { day, before, list, unknown: missing, notFinal: rows.some((r) => r.series && r.series.has(day) && r.series.get(day).notFinal) };
}

/** Who sent most on the last finished day: the top clusters and the rest, of the sum. */
export function shareList(rows, today = utcDay()) {
  const day = addDays(today, -1);
  const have = rows.map((r) => ({ name: r.c.name, n: r.series && r.series.get(day) ? r.series.get(day).value : null })).filter((x) => x.n !== null).sort((a, b) => b.n - a.n);
  const total = have.reduce((a, x) => a + x.n, 0);
  const rest = have.slice(TOP_SHARE);
  return { total, of: have.length, top: have.slice(0, TOP_SHARE), others: rest.length, rest: rest.reduce((a, x) => a + x.n, 0) };
}

/** Clusters by the share of their whole disk in use, fullest first, and the sum over the ones read. */
export function diskList(ctx) {
  const all = ctx.clusters.map((c) => ({ c, d: (ctx.data(c.id) || {}).disk })).filter((x) => x.d && Number.isFinite(x.d.percent) && x.d.total > 0 && Number.isFinite(x.d.used))
    .sort((a, b) => b.d.percent - a.d.percent || a.c.name.localeCompare(b.c.name));
  return { list: all.slice(0, TOP_DISK), read: all.length, used: all.reduce((s, x) => s + x.d.used, 0), total: all.reduce((s, x) => s + x.d.total, 0) };
}

const signed = (p) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)}`;
const signedBytes = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${bytes(Math.abs(n))}`;
const wholePct = (p) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.round(Math.abs(p))} %`;
const tone = (n) => (n > 0 ? 'yellow' : n < 0 ? 'blue' : '');
const dayNo = (ymd) => String(Number(ymd.slice(8)));

/** A round top for an axis of bytes, in five steps. */
export function byteTop(max) {
  if (!(max > 0)) return 1;
  const unit = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
  const x = max / unit;
  const mag = 10 ** Math.floor(Math.log10(x / 5));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s * 5 >= x);
  return step * 5 * unit;
}

function perDay(days, all, basisWord) {
  const top = byteTop(Math.max(0, ...days.map((d) => Math.max(d.value || 0, d.avg || 0))));
  const last = days[days.length - 1];
  const full = Math.max(0, ...days.map((d) => d.of));
  const y = (n) => 100 - (n / top) * 100;
  const x = (i) => ((i + 0.5) / days.length) * 100;
  // The average breaks where it is not known: no line is drawn over a gap.
  const runs = [[]];
  days.forEach((d, i) => { if (d.avg === null) runs.push([]); else runs[runs.length - 1].push(`${x(i).toFixed(2)},${y(d.avg).toFixed(2)}`); });
  const s = svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  for (const r of runs) if (r.length > 1) s.append(svg('polyline', { points: r.join(' '), fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
  const said = days.map((d) => `${shortDay(d.day)} ${d.value === null ? 'not known' : bytes(d.value)}`).join(', ');
  return h('div.pl-panel.pl-vdays', h('div.pl-ph', 'Logs per day, all clusters',
    h('small', last.value === null ? `${shortDay(last.day)}: not known` : [`${shortDay(last.day)}: `, h('b', bytes(last.value)), last.of < all || last.notFinal ? ` (${[last.of < all ? `${last.of} of ${all} clusters` : '', last.notFinal ? 'not final' : ''].filter(Boolean).join(', ')})` : '',
      last.pct === null ? '' : [', ', h(`b.${tone(last.pct) || 'grey'}`, `${signed(last.pct)} %`), ' on the day before']])),
  h('div.pl-vplot',
    h('div.pl-vaxis', ...[5, 4, 3, 2, 1].map((k) => h('span', bytes((top / 5) * k))), h('span', '0')),
    h('div.pl-vbars', { role: 'img', 'aria-label': `${basisWord} per day: ${said}` },
      ...days.map((d) => h(`div.pl-vb${d.value === null ? '.none' : d.of < full ? '.part' : ''}`, { style: { height: d.value === null ? '100%' : `${(d.value / top) * 100}%` },
        title: `${shortDay(d.day)}: ${d.value === null ? 'not known' : `${bytes(d.value)}, ${d.of} of ${all} clusters${d.notFinal ? ', not final' : ''}`}` }, h('span', d.value === null ? 'not known' : bytes(d.value)))), s)),
  h('div.pl-vx', ...days.map((d, i) => h('span', i === 0 || i === days.length - 1 ? shortDay(d.day) : dayNo(d.day)))),
  h('div.pl-vleg', h('span', h('i.blue'), ` ${basisWord}`), h('span', h('i.line'), ' 7-day average'),
    days.some((d) => d.value !== null && d.of < full) ? h('span', h('i.part'), ' fewer clusters that day') : null, h('span.pl-dim', `Finished days only, not today${last.notFinal ? `. ${shortDay(last.day)} is not final: logs may still arrive` : ''}`)));
}

function diskPanel(ctx) {
  const disk = diskList(ctx);
  const line = ctx.lines.warning;
  // The level of a disk is its fullest node's, on every page; the bar is the whole cluster.
  const nodeOf = (c, d) => { const s = ctx.st && ctx.st.get(c.id); return s && s.fullest ? s.fullest.pct : d.percent; };
  return h('div.pl-panel', h('div.pl-ph', 'Top clusters by disk used', h('small', disk.read ? `${disk.read < ctx.clusters.length ? `${disk.read} of ${ctx.clusters.length} read` : 'all'}: ${Math.round((disk.used / disk.total) * 100)} %, ${bytes(disk.used)} of ${bytes(disk.total)}` : '')),
    disk.read ? h('div.pl-vlist', ...disk.list.map(({ c, d }) => {
      const t = ({ critical: 'red', high: 'orange', warning: 'yellow' })[diskLevel(nodeOf(c, d), null, ctx.lines)];
      return h('div.pl-vdr', h('b', c.name), h('span.pl-trk', h(`i.${t || 'green'}`, { style: { width: `${Math.min(100, d.percent)}%` } }), Number.isFinite(line) ? h('u', { style: { left: `${line}%` } }) : null),
        h(`b.num${t ? `.${t}` : ''}`, `${Math.floor(d.percent)} %`), h('span', `${bytes(d.used)} of ${bytes(d.total)}`));
    })) : unknown('no disk read yet'),
    h('div.pl-vnote', `${Number.isFinite(line) ? `White line: ${line} %. ` : ''}Used share of the whole cluster's disk; colour: its fullest node`));
}

function changePanel(days) {
  const max = Math.max(5, ...days.map((d) => Math.abs(d.pct || 0)));
  const up = Math.max(0, ...days.map((d) => d.pct || 0)), down = Math.max(0, ...days.map((d) => -(d.pct || 0)));
  // The zero line sits where both sides fit, with room for a figure above and below.
  const zero = 14 + 72 * (up + down > 0 ? up / (up + down) : 0.5);
  const scale = 72 / Math.max(up + down, 0.001);
  const said = days.map((d) => `${shortDay(d.day)} ${d.pct === null ? 'not known' : `${signed(d.pct)} %`}`).join(', ');
  return h('div.pl-panel', h('div.pl-ph', 'Volume change per day, all clusters', h('small', 'against the day before')),
    h('div.pl-vchg', { role: 'img', 'aria-label': `Change per day: ${said}`, dataset: { max: String(max) } }, ...days.map((d) => {
      const hgt = d.pct === null ? 0 : Math.abs(d.pct) * scale;
      const upw = (d.pct || 0) >= 0;
      return h('div.pl-vc', { title: `${shortDay(d.day)}: ${d.pct === null ? 'not known' : `${signed(d.pct)} %, ${d.pctOf} clusters with both days`}` },
        h('div.pl-vcp', h('u', { style: { top: `${zero}%` } }),
          d.pct === null ? h('span.pl-vcn', { style: { top: `calc(${zero}% - 1.4em)` } }, '–')
            : [h(`i.${upw ? 'yellow' : 'blue'}`, { style: { top: `${upw ? zero - hgt : zero}%`, height: `${hgt}%` } }),
              h('span', { style: { top: upw ? `calc(${zero - hgt}% - 1.4em)` : `calc(${zero + hgt}% + .1em)` } }, signed(d.pct))]),
        h('span.pl-vcd', dayNo(d.day)));
    })),
    h('div.pl-vleg', h('span', h('i.yellow'), ' more than the day before, %'), h('span', h('i.blue'), ' less, %'), days.some((d) => d.pct === null) ? h('span.pl-dim', '– not known') : null));
}

function topChanges(rows, today) {
  const ch = changeList(rows, today);
  const shown = ch.list.slice(0, TOP_CHANGE);
  return h('div.pl-panel', h('div.pl-ph', 'Top cluster volume changes', h('small', `${shortDay(ch.day)}${ch.notFinal ? ' (not final)' : ''} against ${shortDay(ch.before)}`)),
    shown.length ? h('div.pl-vlist', ...shown.map((x) => h('div.pl-vcr', h('b', x.name), h('span.pl-dim', `${bytes(x.was)} → ${bytes(x.now)}`),
      h('span.num', signedBytes(x.diff)), h(`b.num${tone(x.diff) ? `.${tone(x.diff)}` : ''}`, x.pct === null ? '–' : wholePct(x.pct))))) : unknown('not known: no cluster has both days'),
    h('div.pl-vnote', `Biggest change in size first${ch.unknown ? `. ${ch.unknown} of ${rows.length} clusters: not known (one of the days is missing)` : ''}`));
}

const SHARE_TONES = ['blue', 'red', 'yellow', 'green'];
function sharePanel(rows, today) {
  const s = shareList(rows, today);
  const parts = [...s.top.map((x, i) => ({ ...x, tone: SHARE_TONES[i] })), ...(s.others ? [{ name: `${s.others} other${s.others === 1 ? '' : 's'}`, n: s.rest, tone: 'grey' }] : [])];
  const share = (n) => (s.total > 0 ? (n / s.total) * 100 : 0);
  let at = 0;
  const stops = parts.filter((p) => p.n > 0).map((p) => { const from = at; at += share(p.n); return `var(--pl-${p.tone}) ${from.toFixed(2)}% ${Math.max(from, at - 0.4).toFixed(2)}%, var(--tv-panel) ${Math.max(from, at - 0.4).toFixed(2)}% ${at.toFixed(2)}%`; });
  return h('div.pl-panel', h('div.pl-ph', `Who sends most, ${shortDay(addDays(today, -1))}`, h('small', s.of ? `of ${bytes(s.total)}${s.of < rows.length ? `, ${s.of} of ${rows.length} clusters` : ''}` : '')),
    s.of && s.total > 0 ? h('div.pl-vshare',
      h('div.pl-donut.big', { role: 'img', 'aria-label': parts.map((p) => `${p.name} ${Math.round(share(p.n))} percent`).join(', '), style: { background: `conic-gradient(${stops.join(', ')})` } },
        h('div.pl-dhole', h('b.pl-vsum', bytes(s.total)))),
      h('div.pl-vsl', ...parts.flatMap((p) => [h(`i.${p.tone}`), h('span', p.name), h('b.num', bytes(p.n)), h('span.num.pl-dim', `${Math.round(share(p.n))} %`)]))) : unknown('not known'));
}

/** The header's line in place of "last fetched": the last finished day the record has. */
export function headText(ctx) {
  let last = '';
  for (const v of ctx.volume.values()) { const s = v && seriesOf(v.reply, utcDay(ctx.now)); if (s) for (const d of s.keys()) if (d > last) last = d; }
  return last ? `last finished day ${shortDay(last)}` : '';
}

export function render(ctx) {
  const today = utcDay(ctx.now);
  const rows = ctx.clusters.map((c) => { const v = ctx.volume.get(c.id); return { c, v, series: v ? seriesOf(v.reply, today) : null }; });
  const days = fleetDays(rows.map((r) => r.series).filter(Boolean), today);
  const bases = new Set(rows.filter((r) => r.v && r.v.reply).map((r) => basisOf(r.v.reply.settings)));
  const basisWord = bases.size === 1 ? BASIS_LABEL[[...bases][0]] : bases.size ? 'Size (clusters count different sizes)' : 'Size';
  const why = rows.some((r) => r.v && r.v.unsupported) ? `needs ${NEEDS_VERSION}` : rows.every((r) => !r.v) ? 'loading' : 'no record yet';
  const any = days.some((d) => d.value !== null);
  const none = (t) => h('div.pl-panel', h('div.pl-ph', t), unknown(why));
  return h('div.pl-slide.pl-volume',
    h('div.pl-vrow.up', any ? perDay(days, ctx.clusters.length, basisWord) : none('Logs per day, all clusters'), diskPanel(ctx)),
    h('div.pl-vrow.low', any ? changePanel(days) : none('Volume change per day, all clusters'), topChanges(rows, today), sharePanel(rows, today)));
}
