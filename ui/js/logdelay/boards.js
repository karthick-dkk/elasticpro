/**
 * The Log Delay page's boards (0.3.57 as Reports › Log delay; on the Log Delay page since 0.3.60,
 * docs/LOGDELAY.md): the fleet, one cluster, one device and the recommended fixes — boards Main,
 * Cluster, Device and Fix. Everything shown is the core's built-in store, read with LOGDELAY_*;
 * the arithmetic and the routes are core/logdelay-report.js, the device row logdelay/rows.js.
 *
 * Drawn card by card (lib/keyed.js): each card is kept until what it shows changed, so an answer
 * arriving, a push from the core or a press elsewhere never rebuilds the card under the mouse.
 * Each view's questions carry an AbortController; leaving the view lets go of them, and an
 * answer for a view no longer shown redraws nothing.
 *
 * Unknown is not zero: a device that is silent or whose delay cannot be read says so, a day
 * without totals is a gap in a chart, and a cluster never measured says "never measured".
 * Charts use light green, blue, pink and orange only.
 */

import { h, svg, mount } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { card, keptCard, empty } from '../pages/common.js';
import { sortTh, tableSort } from '../lib/table-sort.js';
import { toast } from '../ui/menu.js';
import { confirmDialog } from '../ui/modal.js';
import { clusters } from '../core/state.js';
import { navigateTo } from '../core/intent.js';
import { refreshReports } from '../core/reports.js';
import { rememberLevels } from '../core/delay-levels.js';
import {
  LD_COLOURS as C, ldSummary, ldCluster, ldDevice, ldSearch, ldFixes, ldReportRun, ldHash,
  PERIODS, periodQuery, periodDays, minutesText, durationText, whenText, dayText, docsText, pctText, countText,
  stateText, nowText, byTimeLate, filterRows, ringsOrder, ringDash, dayBars, dayTitle,
  sparkSegments, reducedBars, deviceGraph, periodBand, lateSplitText, STEP_TONE, stepLabel, evidenceText, extraOf, valuesText,
} from '../core/logdelay-report.js';
import { deviceTable, sortCols, extraCols, statePill, stateRank } from './rows.js';

const PAGE_ROWS = 50;

/** What the boards keep between draws: the choices made and the answers read. */
const S = {
  period: 'last30',
  reportPeriod: 'shown',
  clusterPick: 'all',
  devFilter: '', devAll: false,
  cdFilter: '', cdAll: false,
  fixFilter: '', fixAll: false,
  q: { name: '', field: '', value: '', cluster: '', from: '', to: '' },
  qFor: '',
  range: null,           // {from, to} the device page was narrowed to by Show
  search: null,          // {state, res}
  cache: new Map(),      // key → {state: 'loading'|'ok'|'error', res, seq}
};
let seq = 0;
/** The page's redraw: every answer and every choice goes through it. */
let repaint = () => {};
/** The current view's questions: aborted when the view is left. */
let ctl = null;
let ctlFor = '';

/** The built cards, kept between draws (lib/keyed.js). */
const B = nodeCache();

/** A new visit: everything read before is read again. */
export function boardsReset() {
  boardsLeave();
  S.cache.clear(); S.search = null; S.range = null; S.devFilter = ''; S.cdFilter = ''; S.fixFilter = '';
  S.devAll = false; S.cdAll = false; S.fixAll = false;
  for (const el of inputs.values()) el.value = '';
  B.clear();
}

/** The boards are left (another tab, another page): what they still wait for is let go of. */
export function boardsLeave() {
  if (ctl) ctl.abort();
  ctl = null; ctlFor = '';
  // An answer that was cut off is asked again next time, not kept as an error.
  for (const [k, e] of S.cache) if (e.state === 'loading') S.cache.delete(k);
}

/** Forget every answer (a Fetch Now finished: the store has a new measurement). */
export function boardsForget() {
  if (ctl) ctl.abort();
  ctl = null; ctlFor = '';
  S.cache.clear();
}

/** Whether the view on screen is still waiting for an answer (the page's loading line). */
export function boardsLoading() {
  for (const e of S.cache.values()) if (e.state === 'loading') return true;
  return false;
}

/* ------------------------------ the tables' column sort ------------------------------ */

/** A head row from `[key | null, label, num]`: a key sorts with `sort` (lib/table-sort.js). */
const sortHead = (sort, cols) => h('thead', h('tr', ...cols.map(([key, label, num]) => (key ? sortTh(sort, key, label, { num: !!num }) : h(num ? 'th.num' : 'th', label)))));
const sorted = () => repaint();
/** Each table's order: none remembered, the order the page gives (worst first, newest first). */
const sorts = {
  clusters: tableSort('logdelay.clusters', { onChange: sorted }),
  devices: tableSort('logdelay.devices', { onChange: sorted }),
  clusterDevices: tableSort('logdelay.cluster-devices', { onChange: sorted }),
  periods: tableSort('logdelay.periods', { onChange: sorted }),
  fixDevices: tableSort('logdelay.fix-devices', { onChange: sorted }),
  rules: tableSort('logdelay.rules', { onChange: sorted }),
};
const sortSig = (s) => (s.sort ? `${s.sort.key}:${s.sort.dir}` : '-');

/**
 * Read `key` once with `fn(signal)`. The answer redraws the page; one for a view that has been
 * left (aborted) is dropped and asked again on the next visit.
 */
function need(key, fn) {
  const hit = S.cache.get(key);
  if (hit) return hit;
  const ent = { state: 'loading', res: null, seq: ++seq };
  S.cache.set(key, ent);
  const signal = ctl ? ctl.signal : undefined;
  Promise.resolve().then(() => fn(signal)).then((res) => {
    if (res && res.kind === 'aborted') { if (S.cache.get(key) === ent) S.cache.delete(key); return; }
    ent.res = res;
    ent.state = res && res.ok ? 'ok' : 'error';
    ent.seq = ++seq;
    if (res && res.ok) rememberLevels(res);
    if (S.cache.get(key) === ent) repaint();
  }, (e) => { ent.state = 'error'; ent.res = { ok: false, message: e.message || String(e) }; ent.seq = ++seq; repaint(); });
  return ent;
}
const entSig = (ent) => `${ent.state}:${ent.seq}`;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nameOf = (id) => { const c = clusters().find((x) => x.id === id); return c ? c.name : id; };

/* --------------------------------- small pieces --------------------------------- */

const link = (href, text, o = {}) => h('a', { href, title: o.title || null, class: o.cls || null }, text);
const clusterHref = (id) => ldHash('cluster', id);
const crumbs = (...parts) => h('div.ld-crumbs', ...parts.filter(Boolean).flatMap((p, i) => (i ? [' › ', p] : [p])));
const kpi = (value, label, o = {}) => h(`div.ld-kpi${o.wide ? '.ld-wide' : ''}`, { dataset: o.key ? { kpi: o.key } : null },
  h(`b${o.tone ? `.ld-${o.tone}` : ''}`, value), ...(Array.isArray(label) ? label : [h('span', label)]));
const key = (colour, text) => h('span.ld-key', h('i', { style: { background: colour } }), text);
const legend = (...k) => h('span.ld-legend', ...k);
const footer = (...kids) => h('div.ld-foot', ...kids);

/** The filter boxes: one element each for the whole visit, so typing never loses its box. */
const inputs = new Map();
function filterBox(id, get, set) {
  let el = inputs.get(id);
  if (!el) {
    el = h(`input#${id}`, { type: 'search', placeholder: 'Filter devices', 'aria-label': 'Filter devices',
      oninput: (e) => { set(e.target.value); repaint(); } });
    inputs.set(id, el);
  }
  if (el.value !== get()) el.value = get();
  return el;
}

function problem(ent, what) {
  if (ent.state === 'loading') return h('div.tbl-empty.ld-loading', h('span.spin'), ` Reading ${what}…`);
  const r = ent.res || {};
  if (r.unsupported) return h('div.banner.warn', r.message);
  if (r.kind === 'no_store') return h('div.banner.warn', 'The log delay report needs ElasticPro’s data directory, and this server has none.');
  if (r.kind === 'not_found') return empty(`${what} is not in the store.`, { detail: r.message || 'A device not seen for 7 days is forgotten.' });
  return h('div.banner.err', `${what} could not be read: ${r.message || r.kind || 'no answer'}`);
}

/** The band names on the cluster's levels: "Below 30 min", "30–60 min", "Above 60 min". */
function bands(levels) {
  const l = levels || {};
  const a = finite(l.delayFrom) ? l.delayFrom : null; const b = finite(l.criticalOver) ? l.criticalOver : null;
  return {
    below: a === null ? 'On time' : `Below ${a} min`,
    mid: a === null || b === null ? 'Delayed' : `${a}–${b} min`,
    high: b === null ? 'Critical' : `Above ${b} min`,
    late: a === null ? 'late' : `${a} minutes or more`,
  };
}

/** The levels every cluster in a summary shares, or null when they differ (then each cluster's own). */
function sharedLevels(byCluster) {
  const ls = (byCluster || []).map((c) => c.levels).filter(Boolean);
  if (!ls.length) return null;
  const k = (l) => `${l.noDelayUnder}|${l.delayFrom}|${l.criticalOver}`;
  return ls.every((l) => k(l) === k(ls[0])) ? ls[0] : null;
}

function periodSelect(id) {
  const s = h(`select#${id}`, { 'aria-label': 'Period', onchange: (e) => { S.period = e.target.value; S.range = null; repaint(); } },
    ...PERIODS.map(([v, label]) => h('option', { value: v }, label)));
  s.value = S.period;
  return h('label.ld-inline', 'Period', s);
}

/** "Build report" and "Send now" cover the period shown, or the whole hour before now (docs/LOGDELAY.md `lastHour`). */
function reportPeriodSelect() {
  const s = h('select#ld-report-period', { 'aria-label': 'Report covers', onchange: (e) => { S.reportPeriod = e.target.value; } },
    h('option', { value: 'shown' }, 'Period shown'), h('option', { value: 'lastHour' }, 'Last hour'));
  s.value = S.reportPeriod;
  return h('label.ld-inline', { title: 'What Build report and Send now cover: the period shown above, or the whole hour before now' }, 'Report covers', s);
}
const reportPeriod = (res, fallback) => (S.reportPeriod === 'lastHour' ? 'lastHour' : res && res.from ? { from: res.from, to: res.to } : fallback);

async function exportXlsx(btn, clusterIds, res) {
  btn.disabled = true;
  const r = await ldReportRun({ clusterIds, period: reportPeriod(res, 'last7'), mail: false });
  btn.disabled = false;
  if (r && r.ok) { toast('The log delay report is building: Reports › Exports & schedules has it when it is done.', 'ok', 6000); refreshReports(); }
  else toast(`Not started: ${(r && (r.message || r.kind)) || 'no answer'}`, 'err', 6000);
}

async function mailNow(btn, clusterIds, res) {
  const yes = await confirmDialog('Mail the log delay report now?',
    `It goes to the log delay schedule’s recipients, covering ${S.reportPeriod === 'lastHour' ? 'the whole hour before now' : (res && res.label) || 'the period shown'}, with its .xlsx and .csv.`, { yes: 'Mail now' });
  if (!yes) return;
  btn.disabled = true;
  const r = await ldReportRun({ clusterIds, period: reportPeriod(res, 'yesterday'), mail: true });
  btn.disabled = false;
  if (r && r.ok) { toast('The log delay report is being built and mailed.', 'ok', 6000); refreshReports(); }
  else toast(`Not sent: ${(r && (r.message || r.kind)) || 'no answer'}`, 'err', 6000);
}

/* --------------------------- which devices, and how the run read them --------------------------- */

const COUNT_HINT = 'last run = devices that sent a document in the last run’s window (what a live check sees) · '
  + 'now = every device the tracker holds, silent ones included · in range = devices measured at any time in the period shown';
const capSetting = 'Config-Management › Scheduled log delay › Max devices per run';

/** How the last run read one cluster, in words; unknown is said, not 0. */
function lastReadText(lr) {
  if (!lr) return 'not read yet';
  const parts = [`${countText(lr.pages)} page${lr.pages === 1 ? '' : 's'}`, lr.complete ? 'complete' : 'incomplete'];
  if (lr.truncated) parts.push(`stopped at the device cap${finite(lr.maxDevices) ? ` (${countText(lr.maxDevices)})` : ''}`);
  if (lr.error) parts.push(String(lr.error));
  return parts.join(' · ');
}
const noDeviceText = (lr) => (!lr ? '—' : finite(lr.noDevice) ? countText(lr.noDevice) : 'not reported');

/** A cluster whose last run was cut or failed, or whose documents had no device name: said above the figures. */
function readNotes(items) {
  const bad = items.filter((x) => x.lastRead && (x.lastRead.truncated || x.lastRead.complete === false || x.lastRead.error));
  const lost = items.filter((x) => x.lastRead && finite(x.lastRead.noDevice) && x.lastRead.noDevice > 0);
  if (!bad.length && !lost.length) return null;
  return h('div.banner.warn.ld-flat',
    bad.map((x) => h('div', `${x.name}: the last run ${x.lastRead.truncated ? 'stopped at the device cap, so the devices after it are not in the figures; raise ' : 'did not read every device'}`,
      x.lastRead.truncated ? [h('b', capSetting), '.'] : '.')),
    lost.map((x) => h('div', `${x.name}: ${countText(x.lastRead.noDevice)} document${x.lastRead.noDevice === 1 ? ' has' : 's have'} no device name and ${x.lastRead.noDevice === 1 ? 'is' : 'are'} in no device’s figures.`)));
}

/** One cluster's three counts, one line, with what each means. */
function countsLine(counts) {
  if (!counts) return null;
  return h('div.muted.ld-note#ld-counts', { title: COUNT_HINT },
    h('span', h('b', countText(counts.inLastRun)), ' in the last run'), ' · ',
    h('span', h('b', countText(counts.now)), ' now'), ' · ',
    h('span', h('b', countText(counts.inRange)), ' in range'), ` — ${COUNT_HINT}`);
}

/* ------------------------------------ charts ------------------------------------ */

/** Day-by-day stacked bars with five date labels. `withOk` adds on time and silent/can't measure. */
function dayChart(days, { height = 160, withOk = true, label = 'Devices per day' } = {}) {
  const list = days || [];
  const bars = dayBars(list, height, { withOk });
  const seg = (px, colour, kind) => (px ? h('i', { dataset: { seg: kind }, style: { height: `${px}px`, background: colour } }) : null);
  const late = list.filter((d) => d && finite(d.devices) && d.devices > 0).map((d) => (d.delayed || 0) + (d.critical || 0));
  const aria = late.length ? `${label}: between ${Math.min(...late)} and ${Math.max(...late)} late` : `${label}: no day measured`;
  const ticks = list.length ? [0, 0.25, 0.5, 0.75, 1].map((f) => list[Math.round(f * (list.length - 1))]).map((d) => dayText(d && d.day)) : [];
  return h('div.ld-chart',
    h('div.ld-days', { role: 'img', 'aria-label': aria, style: { height: `${height}px` } },
      ...bars.map((b, i) => h(`span.ld-day${b.gap ? '.ld-gap' : ''}`, { title: dayTitle(list[i]) },
        seg(b.ok, C.green, 'ok'), seg(b.unk, C.orange, 'unknown'), seg(b.del, C.blue, 'delayed'), seg(b.crit, C.pink, 'critical')))),
    h('div.ld-ticks', ...ticks.map((t) => h('span', t))));
}

function sparkline(values, title, href) {
  const segs = sparkSegments(values, 120, 24);
  const pic = svg('svg', { width: 120, height: 24, viewBox: '0 0 120 24', role: 'img', 'aria-label': title },
    ...segs.map((p) => svg('polyline', { points: p, fill: 'none', stroke: C.line, 'stroke-width': 1.6 })));
  return segs.length ? h('a.ld-spark', { href, title }, pic) : h('span.muted', { title: 'no day measured' }, 'not measured');
}

function ring(late, devices, { title, href, name, all = false }) {
  const { dash, share } = ringDash(late, devices);
  const circle = (stroke, extra = {}) => svg('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', stroke, 'stroke-width': 5, ...extra });
  return h(`a.ld-ring${all ? '.ld-all' : ''}`, { href, title },
    h('span.ld-ring-pic',
      svg('svg', { width: 104, height: 104, viewBox: '0 0 42 42', role: 'img', 'aria-label': title },
        circle(share === null ? 'var(--surface-3)' : C.green),
        share ? circle(C.pink, { 'stroke-dasharray': dash, 'stroke-linecap': 'round' }) : null),
      h('span.ld-ring-mid', h('b', share === null ? '—' : pctText(share * 100)), h('span', share === null ? 'not measured' : 'delayed'))),
    h('span.ld-ring-name', name),
    h('span.ld-ring-sub', finite(late) && finite(devices) ? [h('b', countText(late)), ` of ${countText(devices)} devices`] : 'never measured'));
}

/* ------------------------------------ the fleet ------------------------------------ */

/** The device columns of the fleet's Devices table. */
const FLEET_COLS = ['device', 'cluster', 'zone', 'tag1', 'state', 'now', 'max', 'episodes', 'lateMs', 'last', 'docs'];

function fleetView() {
  const ids = S.clusterPick === 'all' ? [] : [S.clusterPick];
  const q = periodQuery(S.period);
  const ent = need(`sum|${S.period}|${ids.join(',')}`, (signal) => ldSummary({ ...q, clusterIds: ids, maxDevices: 2000, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const all = clusters();
  const head = B.get('fleet:head', `${S.period}|${S.clusterPick}|${all.length}|${entSig(ent)}`, () => {
    const pick = h('select#ld-clusters', { 'aria-label': 'Clusters', onchange: (e) => { S.clusterPick = e.target.value; S.devAll = false; repaint(); } },
      h('option', { value: 'all' }, `All ${all.length}`), ...all.map((c) => h('option', { value: c.id }, c.name)));
    pick.value = S.clusterPick;
    const lv = res ? sharedLevels(res.byCluster) : null;
    const b = bands(lv);
    const every = res && finite(res.everyHours) ? res.everyHours : null;
    const exportBtn = h('button.btn#ld-export', { type: 'button', disabled: !res, onclick: (e) => exportXlsx(e.currentTarget, ids, res) }, 'Build report (.xlsx)');
    const mailBtn = h('button.btn.primary#ld-mail', { type: 'button', disabled: !res, onclick: (e) => mailNow(e.currentTarget, ids, res) }, 'Send now…');
    return h('div.ld-head',
      h('div.ld-title',
        h('h2', 'Every cluster'),
        h('p.sub', 'Every device that sends logs: how late it is, when each delay started and when it was solved. ',
          every ? `Measured on the server every ${every} hour${every === 1 ? '' : 's'}; ` : 'Measured on the server on a timer; ',
          lv ? `late means ${b.late}.` : 'late means each cluster’s own delay level.')),
      h('div.ld-actions', periodSelect('ld-period'), h('label.ld-inline', 'Clusters', pick), reportPeriodSelect(), exportBtn, mailBtn));
  });
  if (!res) return [head, B.get('fleet:problem', entSig(ent), () => problem(ent, 'The log delay summary'))];

  const lv = sharedLevels(res.byCluster);
  const b = bands(lv);
  const rid = objId(res);
  const t = res.totals || {};
  const n = periodDays(res.from, res.to) || 30;

  const notice = B.get('fleet:notice', rid, () => (!res.schedule || res.schedule.supported === false
    ? h('div.banner.warn', 'This server does not run the scheduled measurement (hosted edition only): nothing new is measured.')
    : res.schedule.enabled === false
      ? h('div.banner.warn', 'The scheduled measurement is switched off; the figures stop at its last run. ',
        h('button.linkish', { type: 'button', onclick: () => navigateTo('settings', { section: 'schedule' }) }, 'Config-Management › Data › Scheduled log delay'))
      : null));

  const tiles = B.get('fleet:tiles', rid, () => {
    const red = reducedBars(res.reduced, 44);
    const reducedTitle = red.map((r) => `${r.n === null ? 'unknown' : r.n} in the last ${r.label}`).join(', ');
    return h('div.ld-kpis.ld-6',
      kpi(countText(t.devices), 'total devices', { key: 'devices' }),
      kpi(countText(t.late), `devices with delay now · ${lateSplitText(t)}`, { tone: t.late ? 'pink' : null, key: 'late' }),
      kpi(countText(t.onTime), `devices with no delay · ${pctText(t.pctOnTime)} on time`, { tone: 'green', key: 'onTime' }),
      kpi(pctText(t.pctOnTime), [h('span', 'without delay'),
        h('span.ld-small', h('span.ld-pink', `${pctText(t.pctLate)} delayed`), ` · ${pctText(t.pctSilent)} silent`,
          finite(t.unmeasured) && t.unmeasured ? ` · ${pctText(t.pctUnmeasured)} can’t measure` : '')], { tone: 'green', key: 'pct' }),
      h('div.ld-kpi.ld-wide', { dataset: { kpi: 'reduced' } },
        h('span', `Delay reduced · devices back under ${lv ? `${lv.delayFrom} min` : 'their delay level'} in the last`),
        h('div.ld-reduced', { role: 'img', 'aria-label': `Devices back on time: ${reducedTitle}` },
          ...red.map((r) => h('span.ld-red', { title: `${r.n === null ? 'not known' : r.n} devices back under the delay level in the last ${r.label}` },
            h('b', r.n === null ? '—' : String(r.n)), h('i', { style: { height: `${r.px}px`, background: C.green } })))),
        h('div.ld-red-labels', ...red.map((r) => h('span', r.label)))));
  });

  const dayCard = B.get('fleet:days', rid, () => card('Day by day', null, dayChart(res.days, { height: 160, label: 'Devices per day' }),
    [legend(key(C.green, 'On time'), key(C.blue, b.mid), key(C.pink, b.high), key(C.orange, 'Silent or can’t measure'))]));

  const ringCard = B.get('fleet:rings', rid, () => {
    const rings = ringsOrder(res.byCluster);
    return card('Delayed devices by cluster', `share of each cluster’s devices delayed ${b.late}, now · worst first · a cluster opens its details`,
      h('div.ld-rings',
        ring(t.late, t.devices, { all: true, name: 'All clusters', href: ldHash('fleet'),
          title: `All clusters: ${t.late ?? '?'} of ${t.devices ?? '?'} devices delayed` }),
        ...rings.map((c) => ring(c.lateNow, c.lastRunAt === null ? null : c.devices, {
          name: c.name || nameOf(c.id), href: clusterHref(c.id),
          title: c.lastRunAt === null ? `${c.name}: never measured` : `${c.name}: ${c.lateNow} of ${c.devices} devices delayed (${pctText(c.latePct)})`,
        }))),
      [legend(key(C.pink, `Delayed (${b.late})`), key(C.green, b.below))]);
  });

  const clusterCard = B.get('fleet:clusters', `${rid}|${sortSig(sorts.clusters)}`, () => {
    // A cluster never measured has no figures: unknown, so it sorts last either way.
    const seen = (f) => (c) => (c.lastRunAt === null || c.lastRunAt === undefined ? null : f(c));
    const devsOf = (id) => (res.devices || []).filter((d) => d.cluster === id);
    const cl = sorts.clusters.apply(res.byCluster || [], {
      name: { type: 'text', value: (c) => c.name || nameOf(c.id) },
      devices: { type: 'number', value: (c) => c.devices },
      lastRun: { type: 'number', value: seen((c) => (c.counts ? c.counts.inLastRun : null)) },
      inRange: { type: 'number', value: seen((c) => (c.counts ? c.counts.inRange : null)) },
      zone: { type: 'text', value: (c) => valuesText(devsOf(c.id), 'zone') },
      tag1: { type: 'text', value: (c) => valuesText(devsOf(c.id), 'tag1') },
      lateNow: { type: 'number', value: seen((c) => c.lateNow) },
      newToday: { type: 'number', value: seen((c) => c.newToday) },
      below: { type: 'number', value: seen((c) => c.below) },
      delay: { type: 'number', value: seen((c) => c.delay) },
      critical: { type: 'number', value: seen((c) => c.critical) },
      previous: { type: 'percent', value: seen((c) => c.belowPctPrevious) },
      worst: { type: 'number', value: seen((c) => (c.worst && c.worst.device ? c.worst.minutes : null)) },
    }).map((c) => {
      const cb = bands(c.levels);
      const neverRun = c.lastRunAt === null || c.lastRunAt === undefined;
      const devs = devsOf(c.id);
      return h('tr', { dataset: { cluster: c.id } },
        h('td', link(clusterHref(c.id), c.name || nameOf(c.id), { title: `${c.name} · log delay details` })),
        h('td.num', countText(c.devices)),
        h('td.num', { title: COUNT_HINT }, neverRun ? '—' : countText(c.counts && c.counts.inLastRun)),
        h('td.num', { title: COUNT_HINT }, neverRun ? '—' : countText(c.counts && c.counts.inRange)),
        h('td', { title: 'zones of the devices listed below' }, valuesText(devs, 'zone')),
        h('td', { title: 'tag1 of the devices listed below' }, valuesText(devs, 'tag1')),
        neverRun ? h('td', { colspan: 8 }, h('span.muted', 'never measured: not in the scheduled measurement yet'))
          : [h(`td.num${c.lateNow ? '.ld-pink' : ''}`, countText(c.lateNow)),
            h(`td.num${c.newToday ? '.ld-pink' : ''}`, { title: `devices that reached ${cb.late} today and were not late before` }, countText(c.newToday)),
            h('td.num', { title: `devices under ${cb.late} now` }, `${countText(c.below)} · ${pctText(c.belowPct)}`),
            h(`td.num${c.delay ? '.ld-blue' : ''}`, countText(c.delay)),
            h(`td.num${c.critical ? '.ld-pink' : ''}`, countText(c.critical)),
            h('td.num', pctText(c.belowPctPrevious)),
            h('td', sparkline(c.sparkline, `${c.name}: late devices per day over ${n} days`, clusterHref(c.id))),
            h('td.mono', c.worst && c.worst.device
              ? [link(ldHash('device', c.id, c.worst.device), c.worst.device, { title: `${c.worst.device} · delay details` }), h('span.muted', ` ${minutesText(c.worst.minutes)}`)]
              : h('span.muted', '—'))]);
    });
    return card('By cluster', `${b.below.toLowerCase()} = devices under ${b.late} of delay now, and their share in the ${n} days before · ${COUNT_HINT} · a cluster name or its line opens the cluster`,
      h('div.tbl-wrap', h('table.tbl.ld-ctr#ld-by-cluster',
        sortHead(sorts.clusters, [['name', 'Cluster'], ['devices', 'Devices now', 1], ['lastRun', 'In last run', 1], ['inRange', 'In range', 1], ['zone', 'zone'], ['tag1', 'tag1'], ['lateNow', 'Late now', 1], ['newToday', 'Today', 1], ['below', b.below, 1],
          ['delay', b.mid, 1], ['critical', b.high, 1], ['previous', `${b.below}, previous ${n} days`, 1], [null, `Last ${n} days`], ['worst', 'Worst device']]),
        h('tbody', ...(cl.length ? cl : [h('tr', h('td', { colspan: 14 }, empty('No cluster you can see is measured.')))])))));
  });

  const readCard = B.get('fleet:read', rid, () => card('How the last run read each cluster', 'pages asked, whether the list is complete, and documents with no device name',
    h('div.tbl-wrap', h('table.tbl.ld-ctr#ld-last-read',
      h('thead', h('tr', h('th', 'Cluster'), h('th', 'Read'), h('th.num', 'Devices read'), h('th.num', 'Without a device name'))),
      h('tbody', ...(res.byCluster || []).filter((c) => c.lastRunAt !== null && c.lastRunAt !== undefined).map((c) => h('tr', { dataset: { cluster: c.id } },
        h('td', link(clusterHref(c.id), c.name || nameOf(c.id))),
        h('td', { class: c.lastRead && (c.lastRead.truncated || !c.lastRead.complete) ? 'ld-pink' : null }, lastReadText(c.lastRead)),
        h('td.num', c.lastRead ? countText(c.lastRead.devices) : '—'),
        h('td.num', { title: 'documents in the last run’s window with no device name: in no device’s figures' }, noDeviceText(c.lastRead)))))))));
  const readNote = B.get('fleet:readnote', rid, () => readNotes((res.byCluster || []).map((c) => ({ name: c.name || nameOf(c.id), lastRead: c.lastRead }))));
  const totalsLine = B.get('fleet:counts', rid, () => h('div.muted.ld-note#ld-fleet-counts', { title: COUNT_HINT },
    h('b', countText(res.devicesInLastRun)), ' devices in the last run · ', h('b', countText(res.devicesTotal)), ' now · ',
    h('b', countText(res.devicesInRange)), ` in the period shown — ${COUNT_HINT}`));
  const devCard = devicesCard(res);
  const never = (res.byCluster || []).filter((c) => c.lastRunAt === null || c.lastRunAt === undefined);
  const neverNote = B.get('fleet:never', rid, () => (never.length && never.length < (res.byCluster || []).length
    ? h('div.muted.ld-note', `${never.length} cluster${never.length === 1 ? ' is' : 's are'} not measured yet: ${never.map((c) => c.name).join(', ')}.`) : null));
  return [head, notice, readNote, totalsLine, tiles, dayCard, ringCard, clusterCard, readCard, devCard, neverNote];
}

function devicesCard(res) {
  const rows = res.devices;
  const total = res.devicesTotal; const truncated = res.devicesTruncated;
  // Filter, then the header's order (time spent late until one is chosen), then the page.
  const ordered = sorts.devices.apply(byTimeLate(filterRows(rows, S.devFilter)), sortCols(FLEET_COLS));
  const shown = S.devAll ? ordered : ordered.slice(0, PAGE_ROWS);
  const body = B.get('fleet:dev:body', `${objId(res)}|${S.devFilter}|${S.devAll}|${sortSig(sorts.devices)}`, () => [
    deviceTable({ id: 'ld-devices', sort: sorts.devices, rows: shown, keys: FLEET_COLS, ctx: { now: res.now },
      emptyText: S.devFilter ? 'No device matches the filter.' : 'No device measured in this period.' }),
    footer(`Showing ${countText(shown.length)} of ${countText(ordered.length)}`,
      ordered.length > shown.length ? [' · ', h('button.linkish#ld-dev-all', { type: 'button', onclick: () => { S.devAll = true; repaint(); } }, 'Show all')] : null,
      truncated ? ` · the server sent the first ${countText((rows || []).length)} of ${countText(total)}` : null)]);
  return keptCard(B, 'fleet:dev', 'Devices',
    `${countText(total ?? (rows || []).length)} · ${sorts.devices.sort ? 'sorted by the marked column' : 'sorted by time spent late'}`,
    body, [filterBox('ld-dev-filter', () => S.devFilter, (v) => { S.devFilter = v; S.devAll = false; })]);
}

/* ------------------------------------ one cluster ------------------------------------ */

function clusterKey(id, q) { return `cl|${id}|${JSON.stringify(q)}`; }

function clusterView(id) {
  const q = periodQuery(S.period);
  const ent = need(clusterKey(id, q), (signal) => ldCluster({ clusterId: id, ...q, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const name = (res && res.name) || nameOf(id);
  const lv = res && res.levels; const b = bands(lv);
  const head = B.get('cl:head', `${id}|${S.period}|${entSig(ent)}`, () => {
    const exportBtn = h('button.btn#ld-export', { type: 'button', disabled: !res, onclick: (e) => exportXlsx(e.currentTarget, [id], res) }, 'Build report (.xlsx)');
    return h('div.ld-head',
      h('div.ld-title',
        crumbs(link(ldHash('fleet'), 'Log Delay'), 'cluster'),
        h('h2', name, h('span.ld-h-sub', ` · ${(res && res.label) || PERIODS.find((p) => p[0] === S.period)[1].toLowerCase()}`)),
        h('p.sub', `Every device in this cluster that sends logs, day by day. Late means ${b.late}.`)),
      h('div.ld-actions', periodSelect('ld-period'), link(ldHash('fixes', id), 'Recommended fixes ›', { cls: 'btn' }), reportPeriodSelect(), exportBtn));
  });
  if (!res) return [head, B.get('cl:problem', entSig(ent), () => problem(ent, `${name}’s log delay`))];
  const rid = objId(res);
  const t = res.totals || {};
  const n = periodDays(res.from, res.to) || 30;
  const tiles = B.get('cl:tiles', rid, () => h('div.ld-kpis.ld-5',
    kpi(countText(t.devices), 'devices measured', { key: 'devices' }),
    kpi(countText(t.late), `late now · ${countText(t.delay)} delayed, ${countText(t.critical)} critical`, { tone: t.late ? 'pink' : null, key: 'late' }),
    kpi(pctText(t.pctOnTime), 'on time now', { tone: 'green', key: 'pct' }),
    kpi(countText(res.started), `delays started · ${countText(res.solved)} solved`, { key: 'started' }),
    kpi(minutesText(res.medianNow, 'not measured'), `median delay · ${minutesText(res.medianPrevious, 'not measured')} in the previous ${n} days`, { key: 'median' })));
  const never = res.lastRunAt === null || res.lastRunAt === undefined;
  const lr = res.lastRead || (res.counts && res.counts.lastRead);
  const readNote = B.get('cl:readnote', rid, () => readNotes([{ name, lastRead: lr }]));
  const countsNote = B.get('cl:counts', rid, () => h('div.ld-note', countsLine(res.counts),
    h('div.muted#ld-last-read-line', `Last run read: ${lastReadText(lr)} · documents with no device name: ${noDeviceText(lr)}`)));
  const neverNote = B.get('cl:never', rid, () => (never ? h('div.banner.warn', `${name} has never been measured: it is not in the scheduled measurement yet.`) : null));
  const dayCard = B.get('cl:days', rid, () => card('Day by day', 'late devices at the end of each day', dayChart(res.days, { height: 150, withOk: false, label: `Late devices per day in ${name}` }),
    [legend(key(C.blue, b.mid), key(C.pink, b.high))]));

  const f = res.fields || {};
  const extras = Array.isArray(f.extras) ? f.extras : [];
  const arrival = f.arrival || 'arrival';
  const event = (Array.isArray(f.eventTime) && f.eventTime[0]) || 'event time';
  const xc = extraCols(extras);
  const keys = ['device', 'zone', 'tag1', 'state', 'now', 'median', 'max', 'episodes', 'lateMs', 'last', ...Object.keys(xc), 'arrival', 'event'];
  const ordered = sorts.clusterDevices.apply(byTimeLate(filterRows(res.devices, S.cdFilter)), sortCols(keys, xc));
  const shown = S.cdAll ? ordered : ordered.slice(0, PAGE_ROWS);
  const body = B.get('cl:dev:body', `${rid}|${S.cdFilter}|${S.cdAll}|${sortSig(sorts.clusterDevices)}`, () => [
    deviceTable({ id: 'ld-cluster-devices', sort: sorts.clusterDevices, rows: shown.map((r) => ({ ...r, cluster: r.cluster || id })), keys, extra: xc,
      labels: { arrival, event }, ctx: { now: res.now }, emptyText: S.cdFilter ? 'No device matches the filter.' : 'No device measured in this period.' }),
    footer(`ECS fields from the device’s latest log: ${[...extras, `${arrival} (arrival)`, `${event} (event time)`].join(', ')} · delay = ${arrival} − ${event}`
      + (f.device ? ` · device field ${f.device}` : '') + (f.pattern ? ` · indices ${f.pattern}` : ''),
      ` · Showing ${countText(shown.length)} of ${countText(ordered.length)}`,
      ordered.length > shown.length ? [' · ', h('button.linkish#ld-cd-all', { type: 'button', onclick: () => { S.cdAll = true; repaint(); } }, 'Show all')] : null)]);
  const devCard = keptCard(B, 'cl:dev', 'Devices in this cluster',
    `${countText((res.devices || []).length)} · ${sorts.clusterDevices.sort ? 'sorted by the marked column' : 'sorted by time spent late'} · a device opens its delay details`,
    body, [filterBox('ld-cd-filter', () => S.cdFilter, (v) => { S.cdFilter = v; S.cdAll = false; })]);
  return [head, neverNote, readNote, tiles, countsNote, dayCard, devCard];
}

/* ------------------------------------ one device ------------------------------------ */

function deviceQuery() {
  return S.range ? { from: S.range.from, to: S.range.to } : periodQuery(S.period);
}

/**
 * One device, and only that device: its figures, its recommendation, its graph and its delays.
 * The other late devices and the per-cluster summary are not on this page — a device board is
 * read about the one device it is about.
 */
function deviceView(clusterId, device) {
  const q = deviceQuery();
  const ent = need(`dev|${clusterId}|${device}|${JSON.stringify(q)}`, (signal) => ldDevice({ clusterId, device, ...q, signal }));
  const cent = need(clusterKey(clusterId, periodQuery(S.period)), (signal) => ldCluster({ clusterId, ...periodQuery(S.period), signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const cres = cent.state === 'ok' ? cent.res : null;
  const f = (cres && cres.fields) || {};
  const devField = String(f.device || 'src_hostname').replace(/\.keyword$/, '');
  const every = res && finite(res.everyHours) ? res.everyHours : null;
  const cname = (res && res.clusterName) || nameOf(clusterId);
  const late = res && (res.state === 'delay' || res.state === 'critical');
  const head = B.get('dev:head', `${clusterId}|${device}|${S.period}|${JSON.stringify(S.range)}|${entSig(ent)}|${entSig(cent)}`, () => h('div.ld-head',
    h('div.ld-title',
      crumbs(link(ldHash('fleet'), 'Log Delay'), link(clusterHref(clusterId), cname)),
      h('h2.ld-dev-h', h('span.mono', device),
        res ? statePill(res.state, late && finite(res.lateSince) ? `${stateText(res.state)} · late since ${whenText(res.lateSince, res.now).replace(/^today /, '')}`
          : res.state === 'silent' && finite(res.silentSince) ? `silent · no logs since ${whenText(res.silentSince, res.now)}` : stateText(res.state)) : null),
      h('p.sub', [`Device field ${devField}`, `arrival ${f.arrival || '@timestamp'}`,
        `event time ${Array.isArray(f.eventTime) && f.eventTime.length ? f.eventTime.join(' / ') : 'not known'}`,
        res && extraOf(res, 'zone') !== null ? `zone ${extraOf(res, 'zone')}` : 'zone not known',
        res && extraOf(res, 'tag1') !== null ? `tag1 ${extraOf(res, 'tag1')}` : 'tag1 not known',
        every ? `measured every ${every} hour${every === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '))),
    h('div.ld-actions', S.range ? h('span.muted.ld-range', `${S.range.from} → ${S.range.to}`) : periodSelect('ld-period'),
      h('a.btn#ld-open-logs', { href: ldHash('live', clusterId, device), title: `${device}: its logs over the page's time range` }, 'Open in logs ›'))));

  const bar = searchBar(clusterId, device, devField, f.extras || [], res);
  if (!res) return [head, bar, B.get('dev:problem', entSig(ent), () => problem(ent, device))];
  const rid = objId(res);
  const lv = res.levels || {};
  const tiles = B.get('dev:tiles', rid, () => h('div.ld-kpis.ld-6',
    h('div.ld-kpi', { dataset: { kpi: 'now' } }, h(`b${late ? '.ld-pink' : ''}`, res.state === 'unmeasured' ? 'can’t measure' : res.state === 'silent' ? 'silent' : minutesText(res.nowMinutes)), h('span', 'delay now')),
    kpi(minutesText(res.medianMinutes), 'median', { key: 'median' }),
    kpi(minutesText(res.worst && res.worst.minutes), `worst · ${res.worst && finite(res.worst.at) ? whenText(res.worst.at, res.now) : 'not known'}`, { key: 'worst' }),
    kpi(countText(res.episodes), `delays · ${countText(res.solved)} solved`, { key: 'episodes' }),
    kpi(durationText(res.lateMs), `time late · ${pctText(res.latePct)} of the period`, { key: 'lateMs' }),
    kpi(docsText(res.docsPerDay), `logs a day · ${finite(res.lastSilence) ? `${whenText(res.lastSilence, res.now)} last silence` : 'no silence'}`, { key: 'docs' })));

  const rec = B.get('dev:rec', rid, () => {
    const fnd = res.finding;
    return h('section.card.ld-rec#ld-recommendation',
      h('header', h('h2', 'Recommendation'),
        fnd ? h(`span.pill.ld-pill.${STEP_TONE[fnd.step] || 'grey'}`, h('i.dot'), stepLabel(fnd)) : null,
        h('span.sub', fnd ? 'likely · from the delay pattern' : 'nothing matched'),
        h('div', { style: { marginLeft: 'auto' } }, link(ldHash('fixes', clusterId), 'All recommendations ›'))),
      h('div.body.ld-rec-body', fnd
        ? [h('div', h('b', fnd.step === 'unknown' ? 'Not known yet: ' : 'Why: '), fnd.why || '—'),
          fnd.fix ? h('div', h('b', 'Fix: '), fnd.fix) : null,
          fnd.group ? h('div.muted', `Group: ${fnd.group[0]} ${fnd.group[1]}`) : null,
          evidenceText(fnd.evidence) ? h('div.muted', `Evidence: ${evidenceText(fnd.evidence)}`) : null,
          Array.isArray(fnd.missing) && fnd.missing.length ? h('div.muted', `Would decide it: ${fnd.missing.join(', ')}`) : null]
        : h('div.muted', 'No recommendation: this device was not late in the stored delay periods of the last 7 days, or no rule matched yet.')));
  });

  return [head, bar, tiles, rec, B.get('dev:graph', rid, () => graphCard(res, lv, every)), periodsCard(res, every)];
}

function searchBar(clusterId, device, devField, extras, res) {
  if (S.qFor !== `${clusterId}|${device}`) {
    S.qFor = `${clusterId}|${device}`;
    S.q = { name: device, field: devField, value: '', cluster: clusterId,
      from: (S.range && S.range.from) || (res && res.from) || '', to: (S.range && S.range.to) || (res && res.to) || '' };
    S.search = null;
  }
  if (!S.q.from && res) { S.q.from = res.from; S.q.to = res.to; }
  // Built once per device and kept: the answer arriving (which fills From and To) or a search
  // finishing changes the fields' values and the matches line in place, never the box being typed in.
  const form = B.get('dev:search', `${S.qFor}|${devField}|${(extras || []).join(',')}|${clusters().length}`, () => {
    const set = (k) => (e) => { S.q[k] = e.target.value; };
    const inp = (id, k, o = {}) => h(`input#${id}`, { type: o.type || 'search', value: S.q[k] || '', placeholder: o.ph || null, oninput: set(k), onchange: set(k), dataset: { untracked: '' } });
    const fields = [...new Set([devField, 'src_hostname', 'src_device', ...extras].filter(Boolean))];
    const fieldSel = h('select#ld-q-field', { onchange: set('field') }, ...fields.map((x) => h('option', { value: x }, x)));
    fieldSel.value = S.q.field || devField;
    const all = clusters();
    const clSel = h('select#ld-q-cluster', { onchange: set('cluster') }, h('option', { value: '' }, 'All clusters'), ...all.map((c) => h('option', { value: c.id }, c.name)));
    clSel.value = S.q.cluster || '';
    const show = async () => {
      const q = { ...S.q };
      if (q.from && q.to && q.from > q.to) { toast('From must be on or before To', 'warn'); return; }
      if (q.from && q.to) S.range = { from: q.from, to: q.to };
      S.search = { state: 'loading', res: null };
      repaint();
      const r = await ldSearch({ name: q.name || undefined, field: q.value ? q.field : undefined, value: q.value || undefined,
        clusterIds: q.cluster ? [q.cluster] : [], from: q.from || undefined, to: q.to || undefined, max: 50, signal: ctl ? ctl.signal : undefined });
      if (r && r.kind === 'aborted') return;
      S.search = { state: r && r.ok ? 'ok' : 'error', res: r };
      const m = r && r.ok ? r.devices || [] : [];
      if (m.length === 1 && (m[0].device !== device || m[0].cluster !== clusterId)) location.hash = ldHash('device', m[0].cluster, m[0].device);
      repaint();
    };
    const lab = (text, node) => h('label.ld-q', text, node);
    return h('section.card.ld-search', { 'aria-label': 'Find a device', dataset: { untracked: '' } },
      h('form.ld-q-row', { onsubmit: (e) => { e.preventDefault(); show(); } },
        lab('Device name', inp('ld-q-name', 'name')),
        lab('Search by', fieldSel),
        lab('Value', inp('ld-q-value', 'value', { ph: 'e.g. fw-dc1-*' })),
        lab('Cluster', clSel),
        lab('From', inp('ld-q-from', 'from', { type: 'date' })),
        lab('To', inp('ld-q-to', 'to', { type: 'date' })),
        h('button.btn.primary#ld-q-show', { type: 'submit' }, 'Show'),
        h('span.ld-q-found')));
  });
  for (const [sel, k] of [['#ld-q-from', 'from'], ['#ld-q-to', 'to']]) {
    const el = form.querySelector(sel);
    if (el && el !== document.activeElement && el.value !== (S.q[k] || '')) el.value = S.q[k] || '';
  }
  const found = form.querySelector('.ld-q-found');
  const searchSig = S.search ? `${S.search.state}:${objId(S.search.res)}` : '-';
  if (found && found.dataset.sig !== searchSig) {
    found.dataset.sig = searchSig;
    const r = S.search && S.search.res;
    mount(found, !S.search ? null
      : S.search.state === 'loading' ? h('span.muted', 'Searching…')
        : S.search.state === 'error' ? h('span.ld-pink', `Search failed: ${(r && (r.message || r.kind)) || 'no answer'}`)
          : h('span.muted#ld-matches', `Matches ${countText(r.matches ?? (r.devices || []).length)} device${(r.matches ?? (r.devices || []).length) === 1 ? '' : 's'}`,
            ...(r.devices || []).slice(0, 12).flatMap((d) => [' · ', link(ldHash('device', d.cluster, d.device), d.device, { title: `${d.device} on ${d.clusterName || d.cluster}` })]),
            r.truncated ? ' · more not shown: narrow the search' : ''));
  }
  return form;
}

function graphCard(res, lv, every) {
  const lo = Date.parse(`${res.from}T00:00:00`); const hi = Math.min(Date.parse(`${res.to}T23:59:59`), res.now || Date.now());
  const H = 220;
  const g = deviceGraph(res.points, { fromMs: lo, toMs: hi, height: H, levels: lv });
  const y = (m) => g.Y(m);
  const line = (m, colour) => (finite(m) && m <= g.scaleMax ? h('div.ld-hline', { style: { top: `${y(m)}px`, borderTopColor: colour } }) : null);
  const bandsEls = (res.periods || []).map((p) => {
    const b = periodBand(p, g.lo, g.hi, res.now);
    if (!b) return null;
    return h(`div.ld-band${b.critical ? '.ld-band-crit' : ''}`, { title: `${whenText(p.started, res.now)} → ${p.solved ? whenText(p.solved, res.now) : 'still late'}, worst ${minutesText(p.worstMinutes)}`,
      style: { left: `${b.left}%`, width: `${b.width}%` } });
  });
  const unknown = (res.points || []).filter((p) => p && !finite(p.m) && finite(p.t));
  const pic = svg('svg', { viewBox: `0 0 1000 ${H}`, preserveAspectRatio: 'none', role: 'img', class: 'ld-graph-svg',
    'aria-label': `Delay of ${res.device} over the period: ${(res.points || []).length} measurements, ${(res.periods || []).length} delays, worst ${minutesText(res.worst && res.worst.minutes)}` },
  ...g.segments.map((p) => svg('polyline', { points: p, fill: 'none', stroke: C.line, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' })),
  ...unknown.map((p) => svg('rect', { x: g.X(p.t) - 2, y: H - 6, width: 4, height: 6, fill: C.orange })));
  const marks = [];
  for (const p of res.periods || []) {
    if (finite(p.started) && p.started >= g.lo) marks.push(h('span.ld-mark.ld-mark-start', { title: `delay started ${whenText(p.started, res.now)}`, style: { left: `calc(${((p.started - g.lo) / (g.hi - g.lo || 1)) * 100}% - 5px)` } }, '▲'));
    if (finite(p.solved)) marks.push(h('span.ld-mark.ld-mark-solved', { title: `solved ${whenText(p.solved, res.now)}`, style: { left: `calc(${((p.solved - g.lo) / (g.hi - g.lo || 1)) * 100}% - 4px)` } }, '●'));
    else marks.push(h('span.ld-mark.ld-mark-open', { title: 'still late', style: { left: 'calc(100% - 10px)' } }, '◆'));
  }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => g.lo + f * (g.hi - g.lo)).map((ms) => whenText(ms, 0).replace(/ \d\d:\d\d$/, ''));
  const ins = res.insights || {};
  const cell = (label, value, sub) => h('div.ld-ins', h('div.muted', label), h('b', value), sub ? h('span', ` ${sub}`) : null);
  const scale = [[g.scaleMax, `${g.scaleMax} min`], [lv.criticalOver, String(lv.criticalOver)], [lv.delayFrom, String(lv.delayFrom)], [0, '0']]
    .filter(([m]) => finite(m) && m <= g.scaleMax);
  return card('Delay over time', `each point is one ${every ? `${every}-hour ` : ''}measurement · shaded bands are delays, from start to solve`,
    [h('div.ld-graph',
      h('div.ld-yaxis', { style: { height: `${H}px` } }, ...scale.map(([m, t]) => h('span', { style: { top: `${y(m) - 7}px` } }, t))),
      h('div.ld-plot#ld-graph', { style: { height: `${H}px` } }, ...bandsEls, line(lv.criticalOver, C.pink), line(lv.delayFrom, C.blue), pic)),
    h('div.ld-marks', { 'aria-label': 'Delay starts and solves' }, ...marks),
    h('div.ld-ticks.ld-indent', ...ticks.map((t) => h('span', t))),
    h('div.muted.ld-indent.ld-tiny', '▲ delay started · ● solved · ◆ still late · ', h('i.ld-sq', { style: { background: C.orange } }), ' silent or can’t measure (no dot, never 0 min)'),
    h('div.ld-insights',
      cell('Peak', minutesText(ins.peak && ins.peak.minutes, 'not known'), ins.peak && finite(ins.peak.at) ? whenText(ins.peak.at, res.now) : null),
      cell('Average delay', minutesText(ins.average && ins.average.minutes, 'not known'), ins.average ? `over ${countText(ins.average.measurements)} measurements` : null),
      cell('Longest delay', ins.longest ? durationText(ins.longest.lastedMs) : 'not known', ins.longest && finite(ins.longest.started) ? `${whenText(ins.longest.started, res.now)} → ${finite(ins.longest.solved) ? whenText(ins.longest.solved, res.now) : 'still late'}` : null),
      cell('Solved in, on average', ins.solvedIn ? durationText(ins.solvedIn.averageMs) : 'not known', ins.solvedIn ? `${countText(ins.solvedIn.solved)} delays solved` : 'no delay solved yet'),
      cell('Late most often', ins.lateMostOften ? ins.lateMostOften.label : 'not known', ins.lateMostOften ? `${ins.lateMostOften.count} of ${ins.lateMostOften.of} delays began then` : null))],
    [legend(key(C.line, 'Delay'), key(C.blue, `${lv.delayFrom ?? '?'} min`), key(C.pink, `${lv.criticalOver ?? '?'} min`))]);
}

function periodsCard(res, every) {
  return B.get('dev:periods', `${objId(res)}|${sortSig(sorts.periods)}`, () => {
    const rows = sorts.periods.apply((res.periods || []).slice().sort((a, b) => (b.started || 0) - (a.started || 0)), {
      started: { type: 'date', value: (p) => p.started },
      solved: { type: 'date', value: (p) => p.solved },
      lasted: { type: 'duration', value: (p) => p.lastedMs },
      worst: { type: 'number', value: (p) => p.worstMinutes },
      state: { type: 'number', value: (p) => stateRank(p.worstState), start: -1 },
      pattern: { type: 'text', value: (p) => p.pattern },
      zone: { type: 'text', value: (p) => extraOf(p, 'zone') ?? extraOf(res, 'zone') },
      tag1: { type: 'text', value: (p) => extraOf(p, 'tag1') ?? extraOf(res, 'tag1') },
      measurements: { type: 'number', value: (p) => p.measurements },
    }).map((p) => {
      const zone = extraOf(p, 'zone') ?? extraOf(res, 'zone'); const tag1 = extraOf(p, 'tag1') ?? extraOf(res, 'tag1');
      return h(`tr${p.solved ? '' : '.ld-open'}`,
        h('td', whenText(p.started, res.now)),
        h('td', p.solved ? whenText(p.solved, res.now) : statePill('critical', 'still late')),
        h('td.num', `${durationText(p.lastedMs)}${p.solved ? '' : ' so far'}`),
        h('td.num', minutesText(p.worstMinutes)), h('td', stateText(p.worstState)),
        h('td', p.pattern ? p.pattern : h('span.muted', '—')),
        h('td', zone === null ? h('span.muted', '—') : String(zone)), h('td', tag1 === null ? h('span.muted', '—') : String(tag1)),
        h('td.num', countText(p.measurements)));
    });
    const sil = (res.silences || []).map((s) => `${whenText(s.from, res.now)} → ${finite(s.to) ? whenText(s.to, res.now) : 'still silent'}${finite(s.burstDocs) ? ` (then ${countText(s.burstDocs)} logs${finite(s.burstMinutes) ? `, ${minutesText(s.burstMinutes)} late` : ''})` : ''}`);
    return card('Every delay', 'started = first measurement at the delay level or later · solved = first measurement back under it',
      [h('div.tbl-wrap', h('table.tbl#ld-periods',
        sortHead(sorts.periods, [['started', 'Started'], ['solved', 'Solved'], ['lasted', 'Lasted', 1], ['worst', 'Worst delay', 1], ['state', 'Worst state'], ['pattern', 'Looks like'],
          ['zone', 'zone'], ['tag1', 'tag1'], ['measurements', 'Measurements', 1]]),
        h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: 9 }, empty('No delay in this period.')))])))),
      footer(`A start or solve time is accurate to the ${every ? `${every}-hour ` : ''}measurement. `,
        sil.length ? `Silences (no logs at all) are listed separately: ${sil.join('; ')}.` : 'No silence in this period.',
        Array.isArray(res.olderMeasurements) && res.olderMeasurements.length ? ` ${countText(res.olderMeasurements.length)} older measurements read from the day files${res.olderTruncated ? ' (the first 20,000)' : ''}.` : '')]);
  });
}

/* ------------------------------------ the fixes ------------------------------------ */

function fixesView(clusterId) {
  const ids = clusterId ? [clusterId] : [];
  const ent = need(`fix|${ids.join(',')}`, (signal) => ldFixes({ clusterIds: ids, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const head = B.get('fix:head', `${clusterId}|${clusters().length}`, () => {
    const all = clusters();
    const pick = h('select#ld-fix-cluster', { 'aria-label': 'Cluster', onchange: (e) => { location.hash = ldHash('fixes', e.target.value || null); } },
      h('option', { value: '' }, 'All clusters'), ...all.map((c) => h('option', { value: c.id }, c.name)));
    pick.value = clusterId || '';
    return h('div.ld-head',
      h('div.ld-title',
        crumbs(link(ldHash('fleet'), 'Log Delay'), clusterId ? link(clusterHref(clusterId), nameOf(clusterId)) : null, 'Recommended fixes'),
        h('h2', 'Why it was late, and how to fix it'),
        h('p.sub.ld-wide-p', 'After each measurement the core looks at the delay periods it stored and matches them against the patterns below. '
          + 'Each match becomes one short recommendation: why, where on the path, what to do, and the evidence. It says “likely” because it is read '
          + 'from timings, not seen; when the evidence is not enough it says so instead of guessing.')),
      h('div.ld-actions', h('label.ld-inline', 'Cluster', pick)));
  });
  const step = (n, title, sub) => h('span.ld-step', h('b', `${n} · ${title}`), h('span', sub));
  const path = B.get('fix:path', '', () => card('Where a log can be delayed', 'the path every log takes; each fix names the step',
    h('div.ld-path', step(1, 'Device', 'clock, buffering, export settings'), h('span.ld-arrow', '→'),
      step(2, 'Forwarder', 'syslog / collector, queue, link (fwd_tag, Zone)'), h('span.ld-arrow', '→'),
      step(3, 'Parser', 'Logstash pipeline and filters (parser_tag)'), h('span.ld-arrow', '→'),
      step(4, 'Elasticsearch', 'indexing, write queue, disk, read-only index'))));
  if (!res) return [head, path, B.get('fix:problem', entSig(ent), () => problem(ent, 'The recommended fixes'))];
  const rid = objId(res);

  const fixCard = B.get('fix:findings', rid, () => {
    const findings = (res.findings || []).map((f) => {
      const n = Array.isArray(f.devices) ? f.devices.length : 0;
      const what = f.group ? h('span.muted', h('span.mono', f.group[0]), ` ${f.group[1]}`)
        : h('span.muted', (f.devices || []).slice(0, 3).join(', ') + (n > 3 ? ` +${n - 3}` : ''));
      return h('div.ld-fix', { dataset: { step: f.step } },
        h('div.ld-fix-l', h(`span.pill.ld-pill.${STEP_TONE[f.step] || 'grey'}`, h('i.dot'), stepLabel(f)),
          h('b', `${n} device${n === 1 ? '' : 's'}`), what, f.clusterName && !clusterId ? h('span.muted', f.clusterName) : null),
        h('div.ld-fix-r',
          h('div', h('b', f.step === 'unknown' ? 'Not known yet: ' : 'Likely why: '), f.why || '—'),
          f.fix ? h('div', h('b', 'Fix: '), f.fix) : null,
          evidenceText(f.evidence) ? h('div.muted', `Evidence: ${evidenceText(f.evidence)}`) : null,
          Array.isArray(f.missing) && f.missing.length ? h('div.muted', `Would let the next run decide: ${f.missing.join(', ')}`) : null));
    });
    const scope = clusterId ? nameOf(clusterId) : 'all clusters';
    return card(`Recommended fixes · ${scope} · ${res.from} → ${res.to}`, 'most devices affected first',
      findings.length ? h('div.ld-fixes', ...findings) : empty('No recommendation: nothing was late in the stored delay periods of this range.'));
  });

  const fixKeys = ['device', 'cluster', 'zone', 'tag1', 'now'];
  const stepCols = {
    step: ['Step', false, (d) => h('td', h(`span.pill.ld-pill.${STEP_TONE[d.step] || 'grey'}`, h('i.dot'), stepLabel(d))), { type: 'text', value: (d) => stepLabel(d) }],
    why: ['Likely why', false, (d) => h('td.ld-wrap', d.why || '—'), { type: 'text', value: (d) => d.why }],
    fix: ['Fix', false, (d) => h('td.ld-wrap', d.fix || h('span.muted', '—')), { type: 'text', value: (d) => d.fix }],
  };
  const keys = [...fixKeys, 'step', 'why', 'fix'];
  const devs = sorts.fixDevices.apply(filterRows(res.devices, S.fixFilter), sortCols(keys, stepCols));
  const shown = S.fixAll ? devs : devs.slice(0, PAGE_ROWS);
  const body = B.get('fix:dev:body', `${rid}|${S.fixFilter}|${S.fixAll}|${sortSig(sorts.fixDevices)}`, () => [
    deviceTable({ id: 'ld-fix-devices', sort: sorts.fixDevices, rows: shown, keys, extra: stepCols, ctx: { now: res.now },
      emptyText: S.fixFilter ? 'No device matches the filter.' : 'No late device in this range.' }),
    footer(`Showing ${countText(shown.length)} of ${countText(devs.length)} late devices`,
      devs.length > shown.length ? [' · ', h('button.linkish#ld-fix-all', { type: 'button', onclick: () => { S.fixAll = true; repaint(); } }, 'Show all')] : null,
      ' · the same column is in the .xlsx (Devices sheet: Step, Likely why, Fix)')]);
  const devCard = keptCard(B, 'fix:dev', 'Each device', 'every late device with its own recommendation · worst first · a device opens its page',
    body, [filterBox('ld-fix-filter', () => S.fixFilter, (v) => { S.fixFilter = v; S.fixAll = false; })]);

  const rules = B.get('fix:rules', `${rid}|${sortSig(sorts.rules)}`, () => card('How a pattern is matched', 'plain rules on stored data; each one names its step on the path',
    h('div.tbl-wrap', h('table.tbl#ld-rules',
      sortHead(sorts.rules, [['pattern', 'Pattern in the delays'], ['step', 'Step'], ['readFrom', 'Read from'], ['recommendation', 'Recommendation']]),
      h('tbody', ...sorts.rules.apply(res.rules || [], {
        pattern: { type: 'text', value: (r) => r.pattern },
        step: { type: 'text', value: (r) => stepLabel(r) },
        readFrom: { type: 'text', value: (r) => r.readFrom },
        recommendation: { type: 'text', value: (r) => r.recommendation },
      }).map((r) => h('tr', h('td.ld-wrap', r.pattern), h('td', stepLabel(r)), h('td.ld-wrap', r.readFrom), h('td.ld-wrap', r.recommendation))))))));
  return [head, path, fixCard, devCard, rules];
}

/* ------------------------------------ the boards ------------------------------------ */

/**
 * The board a route names, as the nodes of its section: kept between draws, rebuilt card by
 * card. `ctx.repaint` redraws the page. Leaving a view (another route) lets go of its questions.
 */
export function boardsNode(r, ctx) {
  repaint = ctx.repaint || repaint;
  const vk = `${r.view}|${r.clusterId}|${r.device}`;
  if (vk !== ctlFor) {
    boardsLeave();
    ctl = typeof AbortController === 'undefined' ? null : new AbortController();
    ctlFor = vk;
  }
  B.begin();
  try {
    const wrap = B.get(`wrap:${r.view}`, r.view, () => h('div.rp-section.ld', { dataset: { ld: r.view } }));
    const kids = r.view === 'cluster' ? clusterView(r.clusterId)
      : r.view === 'device' ? deviceView(r.clusterId, r.device)
        : r.view === 'fixes' ? fixesView(r.clusterId)
          : fleetView();
    mount(wrap, ...kids.flat().filter(Boolean));
    return wrap;
  } finally { B.end(); }
}

/** What Fetch Now measures for the board on screen: the clusters, and one device on a device board. */
export function boardsScope(r) {
  if (r.view === 'device') return { clusterIds: [r.clusterId], device: r.device, label: r.device };
  if (r.view === 'cluster') return { clusterIds: [r.clusterId], label: nameOf(r.clusterId) };
  const id = r.view === 'fixes' ? r.clusterId : r.view === 'fleet' && S.clusterPick !== 'all' ? S.clusterPick : null;
  if (id) return { clusterIds: [id], label: nameOf(id) };
  return { clusterIds: [], label: 'every cluster' };
}
