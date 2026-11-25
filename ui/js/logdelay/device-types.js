/**
 * Log types on the Log Delay boards (0.3.90): the device graph with a line per log type, the table
 * "Log types of this device", the Log type column of Every delay, and a cluster's card "By log type".
 * The words, the slots and the arithmetic are core/log-types.js; the state rule delay-levels.js.
 *
 * A line's colour says which log type it is, never how bad it is (the states' red and yellow are
 * the level lines' and the pills'). Log types are untrusted text: text nodes only.
 */

import { h, svg, tooltip } from '../lib/dom.js';
import { card, empty } from '../pages/common.js';
import { sortTh } from '../lib/table-sort.js';
import { toast } from '../ui/menu.js';
import {
  LD_COLOURS as C, ldHash, minutesText, durationText, whenText, countText, stateText, periodBands, axisTicks, staleText, startedSolvedText, deviceGraph,
} from '../core/logdelay-report.js';
import {
  LINES_MAX, LINE_DASHES, deviceSeries, lineColour, lineSlots, toggleLine, seriesGraph, typeKey, typeLabel, seriesLate, seriesNow, seriesStateText, delaysAt, delaysAtText, lastEpisode,
} from '../core/log-types.js';
import { fromZonedInput } from '../core/log-range.js';
import { LATE_ABOUT, statePill, stateRank } from './rows.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const GRAPH_H = 220;
/** The rows of "By log type" before Show all. */
const BY_TYPE_TOP = 10;
/** The most log types an answer carries (the core's MAX_LOG_TYPES). */
const BY_TYPE_MAX = 500;

/** An element in part delayed's fill: the yellow let through, with a yellow outline. */
export const partFill = (tag) => h(`${tag}.ld-part-fill`, { style: { background: C.part } });

/** A line's swatch: its colour and dash, or an empty one when it is not drawn. */
const swatch = (slot) => svg('svg', { class: 'ld-line-sw', viewBox: '0 0 18 8', width: 18, height: 8, 'aria-hidden': 'true' },
  svg('line', { x1: 1, x2: 17, y1: 4, y2: 4, stroke: slot === undefined ? 'var(--text-muted)' : lineColour(slot), 'stroke-width': slot === undefined ? 1 : 3,
    'stroke-dasharray': slot === undefined ? '1 3' : LINE_DASHES[slot] || null }));

/** A log type's tone for its figure: late red or yellow ink, anything else plain. */
const lateTone = (s) => (seriesLate(s) ? (s.state === 'critical' ? '.ld-crit' : '.ld-delay') : '');

/**
 * The graph of a device's log types: one line each (six at most, worst first), a chip per log type
 * that draws or drops its line, the rest behind "+N"; every measurement's delays on hover or with
 * the arrow keys, each log type named. Shaded bands are the whole device's delays (every log type
 * late); the marks are the drawn log types' own. Measurements before the first one with log types
 * are the whole device's, in grey.
 */
const OF_DEVICE = Object.freeze({ title: 'Delay over time, per log type', one: 'log type', many: 'log types', tail: ' · shaded: the whole device late, where it was measured' });
const OF_TYPE = Object.freeze({ title: 'Delay over time, per device', one: 'device', many: 'devices', tail: '' });
export function typesGraphCard(res, { lv = {}, every, age, zone, slots: chosen, more, onSlots, onMore, insights, of = OF_DEVICE }) {
  tooltip.hide();   // a rebuilt graph is no longer under the pointer it was drawn for
  const H = GRAPH_H;
  const series = res.series;
  const lo = fromZonedInput(`${res.from}T00:00`, zone); const hi = Math.min(fromZonedInput(`${res.to}T23:59:59`, zone), res.now || Date.now());
  const until = age.at !== null ? age.at : res.now;
  const openText = age.stale && age.at !== null ? staleText(age.at, res.now) : age.at !== null ? `still late at ${whenText(age.at, res.now)}` : 'still late';
  const slots = lineSlots(series, chosen);
  const drawn = series.filter((s) => slots.has(typeKey(s)));
  const firstAt = series.reduce((m, s) => (s.points || []).reduce((n, p) => (p && finite(p.t) && p.t < n ? p.t : n), m), Infinity);
  const before = (res.points || []).filter((p) => p && finite(p.t) && p.t >= lo && p.t < firstAt - 60000);
  const g = seriesGraph([...drawn, ...(before.length ? [{ points: before }] : [])], { fromMs: lo, toMs: hi, height: H, levels: lv, gapMs: res.staleAfterMs });
  const gBefore = before.length ? deviceGraph(before, { fromMs: lo, toMs: hi, height: H, levels: lv, scaleMax: g.scaleMax, gapMs: res.staleAfterMs }) : null;
  const pos = (t) => Math.min(100, Math.max(0, ((t - g.lo) / (g.hi - g.lo || 1)) * 100));
  const y = (m) => g.Y(m);
  const line = (m, colour) => (finite(m) && m <= g.scaleMax ? h('div.ld-hline', { style: { top: `${y(m)}px`, borderTopColor: colour } }) : null);
  const bandsEls = (res.periods || []).flatMap((p) => periodBands(p, g.lo, g.hi, until).map((b) => {
    return h(`div.ld-band${b.critical ? '.ld-band-crit' : ''}`, { title: `whole device: ${whenText(p.started, res.now)} → ${p.solved ? whenText(p.solved, res.now) : finite(p.ended) ? `${whenText(p.ended, res.now)} (${p.endedWhy || 'ended'})` : openText}, worst ${minutesText(p.worstMinutes)}`, style: { left: `${b.left}%`, width: `${b.width}%` } });
  }));
  const tail = age.stale && age.at !== null && age.at < g.hi ? h('div.ld-tail', { title: `not measured after ${whenText(age.at, res.now)}`, style: { left: `${pos(age.at)}%` } }) : null;
  const poly = (points, stroke, dash, width = 1.8) => svg('polyline', { points, fill: 'none', stroke, 'stroke-width': width, 'stroke-dasharray': dash || null, 'vector-effect': 'non-scaling-stroke' });
  const dot = (p, stroke, w) => svg('path', { d: `M${p.x.toFixed(1)},${p.y.toFixed(1)}h0.01`, class: 'ld-dot', fill: 'none', stroke, 'stroke-width': w, 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' });
  const lines = drawn.map((s, i) => ({ s, slot: slots.get(typeKey(s)), g: g.lines[i] }));
  // The worst first in the list is drawn last, so it is on top.
  const paths = [...lines].reverse().map(({ s, slot, g: l }) => svg('g', { class: 'ld-type-line', 'data-type': typeKey(s) },
    ...l.segments.map((p) => poly(p, lineColour(slot), LINE_DASHES[slot])),
    ...l.dots.map((p) => dot(p, lineColour(slot), l.dots.length > 120 ? 3 : 6))));
  const gaps = lines.flatMap(({ s }) => (s.points || []).filter((p) => p && finite(p.t) && !finite(p.m)));
  const pic = svg('svg', { viewBox: `0 0 1000 ${H}`, preserveAspectRatio: 'none', role: 'img', class: 'ld-graph-svg',
    'aria-label': `Delay of ${res.device || typeLabel(res)} per ${of.one} over the period: ${lines.map(({ s }) => `${typeLabel(s)} ${seriesNow(s, res.now)}`).join(', ') || `no ${of.one} drawn`}` },
  ...(gBefore ? [svg('g', { class: 'ld-type-before' }, ...gBefore.segments.map((p) => poly(p, C.silent, '', 1.4)), ...gBefore.dots.map((p) => dot(p, C.silent, 3)))] : []),
  ...paths, ...gaps.map((p) => svg('rect', { x: g.X(p.t) - 2, y: H - 6, width: 4, height: 6, fill: C.silent })));

  // The hover and the arrow keys: the measurement nearest the pointer, every log type's delay at it.
  const cursor = h('div.ld-cursor', { hidden: true });
  let at = -1;
  // A log type can have more devices than a tip has room for: those drawn.
  const told = of === OF_TYPE ? drawn : series;
  const tip = (t) => h('div.ld-tip', h('b', whenText(t, res.now)), ...delaysAt(told, t).map((x) => h('div.ld-tip-row', swatch(slots.get(x.key)), h('span', x.label), h('b', x.text))),
    g.lines.length > drawn.length && t < firstAt - 60000 ? h('div.muted', 'before the first measurement with log types: the whole device’s delay') : null);
  const show = (i, cx, cy) => {
    if (i < 0 || i >= g.times.length) return;
    at = i;
    const t = g.times[i];
    cursor.hidden = false; cursor.style.left = `${pos(t)}%`;
    plot.setAttribute('aria-valuenow', String(i)); plot.setAttribute('aria-valuetext', `${whenText(t, res.now)} · ${delaysAtText(told, t)}`);
    tooltip.show(tip(t), cx, cy);
  };
  const hide = () => { cursor.hidden = true; tooltip.hide(); };
  const nearest = (t) => g.times.reduce((best, x, i) => (best < 0 || Math.abs(x - t) < Math.abs(g.times[best] - t) ? i : best), -1);
  const plot = h('div.ld-plot.ld-plot-types#ld-graph', { style: { height: `${H}px` }, tabindex: 0, role: 'slider', 'aria-label': 'The measurement read out: left and right arrow keys', 'aria-valuemin': 0, 'aria-valuemax': Math.max(0, g.times.length - 1), 'aria-valuenow': Math.max(0, g.times.length - 1),
    'aria-valuetext': g.times.length ? `${whenText(g.times[g.times.length - 1], res.now)} · ${delaysAtText(told, g.times[g.times.length - 1])}` : 'no measurement',
    onmousemove: (e) => { const r = plot.getBoundingClientRect(); show(nearest(g.lo + ((e.clientX - r.left) / (r.width || 1)) * (g.hi - g.lo)), e.clientX, e.clientY); },
    onmouseleave: hide, onblur: hide,
    onkeydown: (e) => {
      const last = g.times.length - 1; const from = at < 0 ? last : at;
      const to = e.key === 'ArrowLeft' ? (at < 0 ? last : Math.max(0, from - 1)) : e.key === 'ArrowRight' ? Math.min(last, from + 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
      if (e.key === 'Escape') { hide(); return; }
      if (to === null || last < 0) return;
      e.preventDefault();
      const r = plot.getBoundingClientRect();
      show(to, r.left + (pos(g.times[to]) / 100) * r.width, r.top + 20);
    } },
  ...bandsEls, tail, line(lv.criticalOver, C.critLine), line(lv.delayFrom, C.delayLine), pic, cursor);

  const marks = lines.flatMap(({ s, slot }) => (s.episodes || []).flatMap((p) => {
    const ink = `color-mix(in srgb, ${lineColour(slot)} 60%, var(--text-primary))`;
    const name = typeLabel(s);
    const mark = (cls, t, off, title, glyph) => h(`span.ld-mark${cls}`, { title, style: { left: `calc(${pos(t)}% - ${off}px)`, color: ink } }, glyph);
    const sAt = finite(s.lastMeasuredMs) ? s.lastMeasuredMs : until;
    return [finite(p.started) && p.started >= g.lo ? mark('.ld-mark-start', p.started, 5, `${name}: delay started ${whenText(p.started, res.now)}`, '▲') : null,
      finite(p.solved) ? (p.solved >= g.lo ? mark('.ld-mark-solved', p.solved, 4, `${name}: solved ${whenText(p.solved, res.now)}`, '●') : null)
        : !finite(p.ended) ? mark('.ld-mark-open', sAt, 5, s.stale ? `${name}: ${staleText(sAt, res.now)}` : `${name}: still late at ${whenText(sAt, res.now)}`, '◆') : null].filter(Boolean);
  }));

  // A chip per log type: pressed = drawn. The first LINES_MAX and every drawn one; the others behind "+N".
  const inView = (s, i) => more || i < LINES_MAX || slots.has(typeKey(s));
  const rest = series.filter((s, i) => !(i < LINES_MAX || slots.has(typeKey(s))));
  const chip = (s) => {
    const k = typeKey(s); const on = slots.has(k);
    return h('button.ld-type-chip', { type: 'button', 'aria-pressed': String(on), dataset: { type: k }, title: `${typeLabel(s)}: ${seriesStateText(s, res.now)} · ${on ? 'press to drop its line' : 'press to draw its line'}`,
      onclick: () => {
        if (!on && slots.size >= LINES_MAX) { toast(`${LINES_MAX} lines at most: switch one off first`, 'warn'); return; }
        onSlots(toggleLine(slots, k));
      } }, swatch(slots.get(k)), h('span.ld-type-chip-n', typeLabel(s)), h(`b${lateTone(s)}`, seriesNow(s, res.now)));
  };
  const chips = h('div.ld-type-chips#ld-type-chips', { role: 'group', 'aria-label': `${of.many[0].toUpperCase()}${of.many.slice(1)} drawn` }, ...series.filter(inView).map(chip),
    rest.length ? h('button.ld-type-chip.ld-type-more#ld-type-more', { type: 'button', 'aria-expanded': String(!!more), title: more ? `Hide the ${of.many} that are not drawn` : `${rest.length} more ${rest.length === 1 ? of.one : of.many}`, onclick: onMore }, more ? 'Fewer' : `+${countText(rest.length)}`) : null);
  const scale = [[g.scaleMax, `${g.scaleMax} min`], [lv.criticalOver, String(lv.criticalOver)], [lv.delayFrom, String(lv.delayFrom)], [0, '0']].filter(([m]) => finite(m) && m <= g.scaleMax);
  const key = (colour, text, dash) => h('span.ld-key', h(`i${dash ? '.ld-ln.ld-dash' : '.ld-ln'}`, { style: dash ? { borderTopColor: colour } : { background: colour } }), text);
  return card(of.title, `each point is one ${every ? `${every}-hour ` : ''}measurement of one ${of.one}${of.tail}`,
    [chips,
      h('div.ld-graph', h('div.ld-yaxis', { style: { height: `${H}px` } }, ...scale.map(([m, t]) => h('span', { style: { top: `${y(m) - 7}px` } }, t))), plot),
      h('div.ld-marks', { 'aria-label': `Delay starts and solves per ${of.one}` }, ...marks),
      h('div.ld-ticks.ld-indent', ...axisTicks(g.lo, g.hi).map((t) => h('span', t))),
      h('div.muted.ld-indent.ld-tiny', `▲ delay started · ● solved · ◆ late at the last measurement, in the ${of.one}’s colour${tail ? ' · hatched: not measured' : ''} · `, h('i.ld-sq', { style: { background: C.silent } }), ' silent or can’t measure (no dot, never 0 min)'),
      finite(res.seriesFromMs) ? h('div.muted.ld-tiny.ld-indent#ld-series-from', of === OF_TYPE ? `A log type’s measurements are kept ${res.typeDays} days: nothing before ${whenText(res.seriesFromMs, res.now)} is drawn.` : `The log types’ measurements before ${whenText(res.seriesFromMs, res.now)} were not read: not all of the period is drawn.`) : null,
      of === OF_TYPE ? null : h('div.muted.ld-tiny.ld-whole-note', 'Peak: the highest measurement, whichever log type. Longest delay and Late most often: the whole device’s (every log type late).'),
      insights ? insights(res, age, openText) : null],
    [h('span.ld-legend', before.length ? key(C.silent, 'whole device, before the first measurement with log types') : null, key(C.delayLine, `${lv.delayFrom ?? '?'} min`, true), key(C.critLine, `${lv.criticalOver ?? '?'} min`, true))]);
}

/** A log type's graph: a line per device, worst first (0.3.92). */
export const logTypeGraphCard = (res, o) => typesGraphCard({ ...res, points: [], periods: [], series: deviceSeries(res) }, { ...o, of: OF_TYPE });

/** A log type's devices, as a CSV's rows: blank is not measured, never 0. */
export function logTypeCsv(res) {
  const iso = (t) => (finite(t) ? new Date(t).toISOString() : '');
  return res.devices.map((s) => {
    const e = lastEpisode(s);
    return { device: s.device, cluster: res.clusterName, zone: s.zone ?? '', tag1: s.tag1 ?? '', log_type: typeLabel(res), state: seriesStateText(s, res.now),
      delay_minutes: finite(s.delayMinutes) ? s.delayMinutes.toFixed(2) : '', current: s.stale ? 'no' : 'yes', event_time: iso(s.lastEvent), arrival: iso(s.lastArrival), last_measured: iso(s.lastMeasuredMs), event_field: s.eventField || '',
      logs_in_last_run: finite(s.docs) ? s.docs : '', delays: Array.isArray(s.episodes) ? s.episodes.length : '', late_ms: finite(s.lateMs) ? s.lateMs : '', late_ms_about: s.lateAbout ? 'yes' : '',
      last_delay_started: e ? iso(e.started) : '', last_delay_solved: e ? iso(e.solved) : '', last_delay_ended: e ? iso(e.ended) : '', last_delay_ended_why: e ? e.endedWhy || '' : '' };
  });
}

/** A log type's devices: one row each, worst first until a column is chosen. A device name opens its page. */
export const logTypeDevicesCard = (res, { sort, shown, onAll, csv }) => rowsCard({ ...res, series: res.devices }, {
  sort, id: 'ld-type-devices', title: 'Devices with this log type', sub: `${countText(res.devicesTotal)} · each with its own delay of ${typeLabel(res)}`,
  first: ['device', 'Device', (s) => h('td.mono', h('a', { href: ldHash('device', res.cluster, s.device), title: `${s.device} · delay over time and every delay` }, s.device)), { type: 'text', value: (s) => s.device }],
  extra: [['zone', 'zone', (s) => h('td', s.zone || h('span.muted', '—')), { type: 'text', value: (s) => s.zone }], ['tag1', 'tag1', (s) => h('td', s.tag1 || h('span.muted', '—')), { type: 'text', value: (s) => s.tag1 }]],
  href: (s) => ldHash('live', res.cluster, s.device, res.noType ? { noType: true } : { logType: res.logType }), who: (s) => `${s.device} · ${typeLabel(res)}`,
  rowData: (s) => ({ device: s.device }), shown,
  actions: [h('button.btn.sm#ld-type-csv', { type: 'button', onclick: csv }, 'CSV')],
  foot: (n) => h('div.ld-foot.muted', `Showing ${countText(n)} of ${countText(res.devicesTotal)}. A device that has sent no ${res.noType ? 'documents without log_type' : 'log of this type'} for a week is not listed.`,
    n < res.devices.length ? [' · ', h('button.linkish#ld-type-all', { type: 'button', onclick: onAll }, 'Show all')] : null,
    res.devices.length < res.devicesTotal ? ` · the server sent the first ${countText(res.devices.length)}` : null,
    finite(res.seriesFromMs) ? ` Time late before ${whenText(res.seriesFromMs, res.now)} is counted from each delay’s start to its end ("about"); the device’s page has what was measured.` : null),
});

/** Log types of this device: one row per log type, worst first until a column is chosen. */
export const typesTableCard = (res, { clusterId, device, sort }) => rowsCard(res, {
  sort, id: 'ld-log-types', title: 'Log types of this device', sub: `${countText(res.series.length)}${res.types && res.types.truncated ? ' read, the device has more' : ''} · each with its own delay, by the same levels`,
  first: ['logType', 'Log type', (s) => h('td.ld-type-name', { title: s.noType ? 'documents without the log_type field' : typeLabel(s) }, typeLabel(s)), { type: 'text', value: typeLabel }],
  extra: [], href: (s) => ldHash('live', clusterId, device, s.noType ? { noType: true } : { logType: s.logType }), who: (s) => `${device} · ${typeLabel(s)}`,
  rowData: (s) => ({ type: typeKey(s) }),
});

/** The rows of both: a series' state, delay now, newest document, delays and time late. */
function rowsCard(res, { sort, id, title, sub, first, extra, href: hrefOf, who, rowData, shown, actions, foot }) {
  const now = res.now;
  const muted = (t = '—') => h('span.muted', t);
  const asRow = (s) => { const e = lastEpisode(s); return { state: s.state, silentSince: s.state === 'silent' ? s.lastArrival : null, lastStarted: e ? e.started : null, lastSolved: e && finite(e.solved) ? e.solved : null,
    lateSince: e && !finite(e.solved) && !finite(e.ended) ? e.started : null, stale: s.stale, lastMeasuredMs: s.lastMeasuredMs, ended: e && finite(e.ended) && !finite(e.solved) ? e : null }; };
  const lastText = (s) => { const r = asRow(s); return r.ended ? `${whenText(r.ended.started, now)} → ${whenText(r.ended.ended, now)} (${r.ended.endedWhy || 'ended, not solved'})` : startedSolvedText(r, now); };
  const list = sort.apply(res.series, {
    [first[0]]: first[3], ...Object.fromEntries(extra.map((x) => [x[0], x[3]])),
    state: { type: 'number', value: (s) => (s.stale ? null : stateRank(s.state)), start: -1 },
    now: { type: 'number', value: (s) => s.delayMinutes, start: -1 },
    event: { type: 'date', value: (s) => s.lastEvent },
    arrival: { type: 'date', value: (s) => s.lastArrival },
    docs: { type: 'number', value: (s) => s.docs },
    delays: { type: 'number', value: (s) => (s.episodes || []).length, start: -1 },
    lateMs: { type: 'duration', value: (s) => s.lateMs, start: -1 },
    last: { type: 'date', value: (s) => { const e = lastEpisode(s); return e ? e.started : null; } },
  });
  const cols = [[first[0], first[1]], ...extra.map((x) => [x[0], x[1]]), ['state', 'Now'], ['now', 'Delay now', 1], ['event', 'Event time'], ['arrival', 'Arrived'], ['docs', 'Logs', 1], ['delays', 'Delays', 1], ['lateMs', 'Time late', 1], ['last', 'Last delay: started → solved']];
  const row = (s) => {
    const href = hrefOf(s);
    const stale = s.stale && finite(s.lastMeasuredMs);
    return h('tr', { dataset: rowData(s) },
      first[2](s), ...extra.map((x) => x[2](s)),
      h('td', { title: seriesStateText(s, now) }, statePill(stale ? 'unmeasured' : s.state, stale ? 'not measured since' : stateText(s.state))),
      h(`td.num${stale ? '.muted' : ''}`, { title: [finite(s.rawGap) ? `raw gap ${minutesText(s.rawGap)}` : '', stale ? `last measured ${whenText(s.lastMeasuredMs, now)}, not measured since` : ''].filter(Boolean).join(' · ') || null }, seriesNow(s, now)),
      h('td.mono', { title: s.eventField ? `from ${s.eventField}` : null }, whenText(s.lastEvent, now, { seconds: true }).replace(/^today /, '')),
      h('td.mono', whenText(s.lastArrival, now, { seconds: true }).replace(/^today /, '')),
      h('td.num', { title: 'its documents in the last measurement’s window' }, countText(s.docs)),
      h('td.num', Array.isArray(s.episodes) ? countText(s.episodes.length) : muted()),
      h('td.num', { title: s.lateAbout ? LATE_ABOUT : null }, s.lateAbout ? 'about ' : '', durationText(s.lateMs)),
      h('td', lastText(s)),
      h('td.ld-acts', h('button.btn.sm.ld-open-logs', { type: 'button', dataset: { href }, title: `${who(s)}: its logs (Log Delay › Live)`, onclick: () => { location.hash = href; } }, 'Open in logs')));
  };
  const cut = finite(shown) ? list.slice(0, shown) : list;
  return card(title, sub, [
    h('div.tbl-wrap', h('table.tbl', { id }, h('thead', h('tr', ...cols.map(([k, label, num]) => sortTh(sort, k, label, { num: !!num })), h('th', 'Open'))), h('tbody', ...cut.map(row)))),
    foot ? foot(cut.length) : null], actions);
}

/**
 * Every delay with its log type: the whole device's periods (every log type late) and each log
 * type's own. A device of one log type has the same delays twice: listed once.
 */
export function typeDelays(res, age) {
  const whole = (res.periods || []).map((p) => ({ ...p, whole: true, age, typeLabel: p.beforeLogTypes === true ? 'whole device, before log types were measured' : 'whole device' }));
  const only = (res.series || []).length === 1 ? new Set(whole.map((p) => p.started)) : null;
  return [...whole, ...(res.series || []).flatMap((s) => (s.episodes || []).filter((p) => p && !(only && only.has(p.started)))
    .map((p) => ({ ...p, typeLabel: typeLabel(s), age: { at: finite(s.lastMeasuredMs) ? s.lastMeasuredMs : null, stale: !!s.stale } })))];
}

/** The log types the core had no room to keep, in words; null when it kept them all. */
const notKept = (res) => (finite(res.logTypesNotKept) && res.logTypesNotKept > 0 ? h('div.ld-foot.muted#ld-types-not-kept', `${countText(res.logTypesNotKept)} more log types were read and not kept: they count in their devices’ states and have no history here.`) : null);

/** A cluster's log types, worst first: devices, late, above the critical line, with no logs, the worst delay. */
export function byLogTypeCard(res, { b, sort, all, onAll, hrefOf }) {
  if (res.logTypeField === null) return h('div.muted.ld-note#ld-types-off', `Not measured per log type: ${res.logTypeWhy || 'log_type is not in the mapping'}.`);
  if (!Array.isArray(res.byLogType)) return null;
  const list = sort.apply(res.byLogType, {
    logType: { type: 'text', value: typeLabel }, devices: { type: 'number', value: (x) => x.devices, start: -1 }, late: { type: 'number', value: (x) => x.late, start: -1 },
    above: { type: 'number', value: (x) => x.above, start: -1 }, silent: { type: 'number', value: (x) => x.silent, start: -1 }, worst: { type: 'number', value: (x) => x.worstMinutes, start: -1 },
  });
  const shown = all ? list : list.slice(0, BY_TYPE_TOP);
  const cols = [['logType', 'Log type'], ['devices', 'Devices', 1], ['late', 'Late', 1], ['above', b.high, 1], ['silent', 'No logs', 1], ['worst', 'Worst delay', 1]];
  const el = card('By log type', `devices per log type, worst first · field ${res.logTypeField || 'log_type'}${hrefOf ? ' · a log type opens its devices and their graph' : ''}`,
    list.length ? [h('div.tbl-wrap', h('table.tbl#ld-by-type', h('thead', h('tr', ...cols.map(([k, label, num]) => sortTh(sort, k, label, { num: !!num })))),
      h('tbody', ...shown.map((x) => h('tr', { dataset: { type: typeKey(x) } },
        h('td.ld-type-name', { title: `${x.noType ? 'documents without the log_type field' : typeLabel(x)} · its devices and their delay over time` },
          hrefOf ? h('a', { href: hrefOf(x) }, typeLabel(x)) : typeLabel(x)),
        h('td.num', countText(x.devices)), h(`td.num${x.late ? '.ld-delay' : ''}`, { title: 'devices this log type is late on' }, countText(x.late)),
        h(`td.num${x.above ? '.ld-crit' : ''}`, countText(x.above)), h('td.num', { title: 'devices with no documents of this log type now' }, countText(x.silent)),
        h('td.num', minutesText(x.worstMinutes))))))),
    list.length > BY_TYPE_TOP ? h('div.ld-foot', `Showing ${countText(shown.length)} of ${countText(list.length)} · `, h('button.linkish#ld-by-type-all', { type: 'button', onclick: onAll }, all ? `Show the top ${BY_TYPE_TOP} only` : 'Show all')) : null,
    list.length >= BY_TYPE_MAX ? h('div.ld-foot.muted', `The worst ${countText(BY_TYPE_MAX)} log types: the cluster may have more.`) : null,
    notKept(res)]
      : [empty('No log type read yet.'), notKept(res)]);
  el.id = 'ld-by-type-card';
  return el;
}
