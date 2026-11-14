/**
 * The device row of the Log Delay page: one definition of how a device is drawn, used by every
 * table that lists devices — the fleet's Devices, a cluster's devices, the late devices of
 * Recommended fixes and Live Watch. A board row (docs/LOGDELAY.md DeviceRow) and a device Live
 * Watch measured (core/logdelay-report.js liveDeviceRow) are the same shape, so they are the same
 * row; a figure a row does not carry reads unknown, never 0.
 *
 * Every table shows zone and tag1 (the device's own, from its latest log), and every row can
 * open its logs: Live logs narrowed to the device over the page's time range.
 */

import { h } from '../lib/dom.js';
import { sortTh } from '../lib/table-sort.js';
import { clusters } from '../core/state.js';
import {
  ldHash, stateText, stateTone, nowText, minutesText, durationText, countText, docsText, startedSolvedText, whenText, extraOf,
} from '../core/logdelay-report.js';
import { deviceZoneText, delaySumText } from '../core/log-tz.js';
import { fixButton, fixesFor } from './fix-popover.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nameOf = (id) => { const c = clusters().find((x) => x.id === id); return c ? c.name : id; };
const link = (href, text, title) => h('a', { href, title: title || null }, text);
const muted = (t = '—') => h('span.muted', t);

/** How bad a state is, for sorting "Now": worst highest; can't measure and unknown are unknown. */
const STATE_RANK = { critical: 5, delay: 4, clock_ahead: 3, other_tz: 2.5, silent: 2, little: 0, no_delay: 0 };
export const stateRank = (s) => (s in STATE_RANK ? STATE_RANK[s] : null);
/** When the last delay (or silence) began: what "Last delay: started → solved" sorts on. */
export const lastDelayAt = (r) => (r.state === 'silent' && finite(r.silentSince) ? r.silentSince : finite(r.lateSince) ? r.lateSince : finite(r.lastStarted) ? r.lastStarted : null);

export const statePill = (state, text) => h(`span.pill.ld-pill.${stateTone(state)}`, h('i.dot'), text || stateText(state));

/**
 * The columns: `[label, num?, cell(row, ctx), sort {type, value}]`. `extras` columns (a
 * cluster's own context fields) are added by `extraCols`.
 */
const COLS = {
  device: ['Device', false, (r) => h('td.mono', link(ldHash('device', r.cluster, r.device), r.device, `${r.device} · delay over time and every delay`)),
    { type: 'text', value: (r) => r.device }],
  cluster: ['Cluster', false, (r) => h('td', link(ldHash('cluster', r.cluster), r.clusterName || nameOf(r.cluster), `${r.clusterName || r.cluster} · log delay details`)),
    { type: 'text', value: (r) => r.clusterName || nameOf(r.cluster) }],
  zone: ['zone', false, (r) => { const v = extraOf(r, 'zone'); return h('td', v === null ? muted() : String(v)); },
    { type: 'text', value: (r) => extraOf(r, 'zone') }],
  tag1: ['tag1', false, (r) => { const v = extraOf(r, 'tag1'); return h('td', v === null ? muted() : String(v)); },
    { type: 'text', value: (r) => extraOf(r, 'tag1') }],
  state: ['Now', false, (r) => h('td', r.state === 'other_tz'
    ? h('span', { title: `Its logs are stamped in another time zone (${deviceZoneText(r)}) than the cluster’s: the gap sits at that offset run after run. Not late.` }, statePill(r.state))
    : statePill(r.state)), { type: 'number', value: (r) => stateRank(r.state), start: -1 }],
  // The figure after the zone step; its title spells the sum out (docs/LOGDELAY.md "Time zones").
  now: ['Delay now', true, (r, ctx) => h('td.num', { title: delaySumText(r, (ms) => whenText(ms, ctx.now || Date.now(), { seconds: true })) || null }, nowText(r)),
    { type: 'number', value: (r) => r.nowMinutes }],
  rawGap: ['Raw gap', true, (r) => h('td.num.muted', { title: 'arrival − event as measured, before the time zone is taken out' },
    finite(r.rawGapMinutes) ? minutesText(r.rawGapMinutes) : '—'), { type: 'number', value: (r) => r.rawGapMinutes }],
  deviceTz: ['Device time zone', false, (r) => h('td', { title: 'the real UTC offset the device’s gap sits at, against the cluster’s zone' },
    r.state === 'other_tz' ? statePill('other_tz', deviceZoneText(r)) : deviceZoneText(r) === '—' ? muted() : deviceZoneText(r)),
    { type: 'text', value: (r) => deviceZoneText(r) }],
  max: ['Max', true, (r) => h('td.num', minutesText(r.maxMinutes)), { type: 'number', value: (r) => r.maxMinutes }],
  episodes: ['Delays', true, (r) => h('td.num', countText(r.episodes)), { type: 'number', value: (r) => r.episodes }],
  lateMs: ['Time late', true, (r) => h('td.num', durationText(r.lateMs)), { type: 'duration', value: (r) => r.lateMs }],
  last: ['Last delay: started → solved', false, (r, ctx) => h('td', r.live ? muted('not in one measurement') : startedSolvedText(r, ctx.now)),
    { type: 'date', value: lastDelayAt }],
  docs: ['Logs a day', true, (r) => h('td.num', docsText(r.docsPerDay)), { type: 'number', value: (r) => r.docsPerDay }],
  docsIn: ['Logs in range', true, (r) => h('td.num', countText(r.docs)), { type: 'number', value: (r) => r.docs }],
  arrival: ['Last arrival', false, (r, ctx) => h('td.mono', whenText(r.lastArrival, ctx.now, { seconds: true })), { type: 'date', value: (r) => r.lastArrival }],
  event: ['Event time', false, (r, ctx) => h('td.mono', whenText(r.lastEvent, ctx.now, { seconds: true })), { type: 'date', value: (r) => r.lastEvent }],
  pattern: ['Looks like', false, (r) => h('td', r.pattern ? h('span', { title: r.patternNote || null }, statePill('clock_ahead', r.pattern)) : muted()),
    { type: 'text', value: (r) => r.pattern }],
};

/** A cluster's own context fields as columns (`x:<name>`), zone and tag1 left out: they always have their own. */
export function extraCols(extras) {
  const out = {};
  for (const x of extras || []) {
    if (['zone', 'tag1'].includes(String(x).toLowerCase())) continue;
    out[`x:${x}`] = [x, false, (r) => { const v = r.extras ? r.extras[x] : null; return h('td', v === null || v === undefined || v === '' ? muted() : String(v)); },
      { type: 'text', value: (r) => (r.extras ? r.extras[x] : null) }];
  }
  return out;
}

/** The sort columns of `keys` (core/sort.js), on the figures rather than the text. */
export function sortCols(keys, extra = {}) {
  const all = { ...COLS, ...extra };
  return Object.fromEntries(keys.filter((k) => all[k]).map((k) => [k, all[k][3]]));
}

/** The head row: a sortable head per column, then the actions column (no sort). */
export function deviceHead(sort, keys, extra = {}, { labels = {}, actions = 'Open' } = {}) {
  const all = { ...COLS, ...extra };
  return h('thead', h('tr', ...keys.filter((k) => all[k]).map((k) => sortTh(sort, k, labels[k] || all[k][0], { num: !!all[k][1] })),
    actions ? h('th', actions) : null));
}

/**
 * One device. `ctx`: `now` (the answer's), `mode: 'watch'` for Live Watch (the row is not
 * clickable; actions are "i", Details, Open in logs) and `graph` false to leave out the device
 * board link (the device board itself). Otherwise a click on the row opens the device, except on
 * a button or a link inside it; the last column is "i" and Open in logs.
 */
export function deviceRow(r, keys, ctx = {}, extra = {}) {
  const all = { ...COLS, ...extra };
  const watch = ctx.mode === 'watch';
  const device = ldHash('device', r.cluster, r.device);
  const logs = ldHash('live', r.cluster, r.device);
  const acts = [
    fixButton({ kind: 'device', id: r.device, items: () => fixesFor(r, 'device') }),
    watch ? h('button.btn.sm.ld-details', { type: 'button', dataset: { href: ldHash('devices', r.cluster) }, title: `${r.device}: delay over time and every delay`, onclick: () => { location.hash = ldHash('devices', r.cluster); } }, 'Details') : null,
    h('button.btn.sm.ld-open-logs', { type: 'button', dataset: { href: logs }, title: `${r.device}: its logs over the page's time range (Live logs)`, onclick: () => { location.hash = logs; } }, 'Open in logs'),
  ].filter(Boolean);
  const open = !watch && ctx.graph !== false;
  const cls = `${r.state === 'critical' || r.state === 'delay' ? '.ld-late' : ''}${open ? '.ld-rowlink' : ''}`;
  return h(`tr${cls}`, {
    dataset: { device: r.device, cluster: r.cluster },
    onclick: open ? (e) => { if (!e.target.closest('a, button')) location.hash = device; } : null,
  },
  ...keys.filter((k) => all[k]).map((k) => all[k][2](r, ctx)),
  h('td.ld-acts', ...acts));
}

/** A device table: `id`, its sort, the rows in order, the columns, and what an empty one says. */
export function deviceTable({ id, sort, rows, keys, ctx = {}, extra = {}, labels = {}, emptyText = 'No device.' }) {
  const n = keys.filter((k) => ({ ...COLS, ...extra })[k]).length + 1;
  return h('div.tbl-wrap', h(`table.tbl#${id}`,
    deviceHead(sort, keys, extra, { labels }),
    h('tbody', ...(rows.length ? rows.map((r) => deviceRow(r, keys, ctx, extra)) : [h('tr', h('td', { colspan: n }, h('div.tbl-empty', emptyText)))]))));
}
