/**
 * Page — Log Delay (was "Logs & Delay" until 0.3.60, and its boards were Reports › Log delay):
 * how late each device's logs arrive, and the logs themselves. docs/LOGDELAY.md is the contract.
 *
 *   Dashboard   the core's store: the fleet's count tiles, Devices behind, the cluster × time
 *               heat map, By cluster; one cluster (logdelay/boards.js)
 *   Devices     every device, searched and filtered by level, each with its fix ("i") and its
 *               logs; one device beside the list (logdelay/boards.js)
 *   Live Watch  every cluster measured now from this browser, the delayed devices, one device
 *               live (logdelay/watch.js)
 *   Live logs   the documents over the time range, one device at a time if asked (logdelay/live-logs.js)
 *
 * The title bar carries the tabs and, at the right end, Fetch now (logdelay/fetch-now.js): one
 * cluster at a time, its late devices by default, the whole cluster from its ▾ menu. Under it
 * one tools row: the cluster, the period (the boards) or the time range (Live Watch, Live logs),
 * and the cluster's log time zone as a chip. Every time on the page is in the server's zone.
 *
 * The routes are core/logdelay-report.js (ldRoute, ldHash); #/logs, #/reports/log-delay/… and
 * #/log-delay/fixes still open here (reports/route.js movedPath; fixes went to Devices in 0.3.62).
 *
 * The page is drawn piece by piece (lib/keyed.js): the bar, the tools and each card are kept
 * until what they show changed, so an answer arriving or a push from the core never rebuilds
 * what is under the mouse, and the tabs and links work while anything is still loading.
 * Leaving a view lets go of what it asked (each view's AbortController).
 */

import { h, mount } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { takeFocus } from '../core/focus.js';
import { intent } from '../core/intent.js';
import { serverZoneName } from '../core/es.js';
import { clusters } from '../core/state.js';
import { ldRoute, ldHash, ldTab, setDisplayZone, LD_PAGE, PERIODS, timeZoneChipText, devicesByZone, countText } from '../core/logdelay-report.js';
import { RANGES, normaliseRange, browserZone, zonedInputValue, fromZonedInput, offsetText, zoneOffsetMinutes } from '../core/log-range.js';
import { offsetLabel } from '../core/log-tz.js';
import {
  boardsNode, boardsReset, boardsLeave, boardsForget, boardsLoading, boardsScope, boardsScopeId,
  boardsPick, boardsSetPick, boardsPeriod, boardsSetPeriod, boardsInfo, boardsZoneRows, boardsMajorityPercent,
} from '../logdelay/boards.js';
import { watchNodes, watchEnter, watchLeave, watchBusy, watchStart } from '../logdelay/watch.js';
import { liveNodes, liveEnter, liveLeave, liveBusy, liveRangeChanged } from '../logdelay/live-logs.js';
import { fetchNowControl, fetchNowLeave, fetchNowBusy } from '../logdelay/fetch-now.js';

let host = null;
let visiting = false;
let route = ldRoute('');
/** The tab whose view was last entered: leaving it lets go of what it asked. */
let entered = '';
const P = nodeCache();

const TABS = [
  ['fleet', 'Dashboard', 'The core’s measurements: every cluster, or one cluster'],
  ['devices', 'Devices', 'Every device, by level, with its fix and its logs; one device in detail'],
  ['watch', 'Live Watch', 'Live check from this browser (500 devices per cluster at most): the delayed devices, and one device live'],
  ['live', 'Live logs', 'The log documents over the time range, with each one’s delay'],
];

/* ------------------------------------ the range ------------------------------------ */

const RANGE_KEY = 'elasticpro.logdelay.range';
function readRange() {
  try { const raw = localStorage.getItem(RANGE_KEY); return normaliseRange(raw ? JSON.parse(raw) : null); } catch (_) { return normaliseRange(null); }
}
let range = readRange();
function setRange(r) {
  range = normaliseRange(r);
  try { localStorage.setItem(RANGE_KEY, JSON.stringify(range)); } catch (_) { /* kept for this visit */ }
  if (ldTab(route.view) === 'live') liveRangeChanged();
  draw();
}

/** The zone every time on the page is written in: the server's when it said it, else this browser's. */
const zone = () => serverZoneName() || browserZone();

/** What the views read from the page: the redraw, the time range, the zone times are written in, the time-zone filter. */
const viewCtx = () => ({ repaint: draw, range: () => range, zone, tz: () => route.tz });

/* ------------------------------------ the page ------------------------------------ */

export function render(el) {
  host = el;
  el.classList.add('dense', 'rp-page', 'ld-page');
  if (isSnapshotMode()) { mount(host, snapshotNotice()); return; }
  if (!visiting) { visiting = true; boardsReset(); P.clear(); }
  setDisplayZone(zone());
  // From a "logs arriving late" alert or its playbook (core/focus.js): Live Watch, checking the
  // fleet. From a link that named a view (navigateTo('log-delay', {view, cluster, device})): that view.
  const f = takeFocus('log-delay') || takeFocus('logs');
  const asked = intent.logDelay;
  intent.logDelay = null;
  let want = null;
  if (f && f.view === 'delay') want = ldHash('watch');
  if (asked && asked.view) want = ldHash(asked.view, asked.cluster, asked.device);
  if (want && location.hash !== want) { try { history.replaceState(null, '', want); } catch (_) { location.hash = want; } }
  route = ldRoute(location.hash);
  canonical();
  enter(route);
  if (f && f.view === 'delay') watchStart();
  draw();
}

/**
 * An old address (#/reports/log-delay/…, #/logs, #/log-delay/fixes) that reached this page reads
 * as the view's own from here on, without a history entry of its own: Back goes where it went before.
 */
function canonical() {
  const first = String(location.hash || '').replace(/^#\/?/, '').split(/[/?]/)[0];
  const want = ldHash(route.view, route.clusterId, route.device, route);
  if (first === LD_PAGE && location.hash === want) return;
  try { history.replaceState(null, '', want); } catch (_) { location.hash = want; }
}

/** The shell saw the hash move within this page (another view, another device). */
export function onRoute() {
  route = ldRoute(location.hash);
  canonical();
  enter(route);
  draw();
}

/** Nothing on this page is drawn from the poller's data: each view asks its own questions. */
export function onData() {}

export function onLeave() {
  visiting = false;
  leave(entered);
  entered = '';
  fetchNowLeave();
}

function leave(tab) {
  if (tab === 'fleet' || tab === 'devices') boardsLeave();
  if (tab === 'watch') watchLeave();
  if (tab === 'live') liveLeave();
}

function enter(r) {
  const tab = ldTab(r.view);
  if (entered && entered !== tab) leave(entered);
  entered = tab;
  if (tab === 'watch') watchEnter(viewCtx());
  if (tab === 'live') liveEnter(viewCtx(), r);
}

function busy() {
  const tab = ldTab(route.view);
  return fetchNowBusy() || (tab === 'watch' ? watchBusy() : tab === 'live' ? liveBusy() : boardsLoading());
}

/* ------------------------------------ the bar ------------------------------------ */

function tabs() {
  const cur = ldTab(route.view);
  return P.get('tabs', `${cur}|${route.tz}`, () => h('nav.rp-nav.ld-tabs', { 'aria-label': 'Log Delay views' },
    ...TABS.map(([id, label, title]) => h('a', { href: ldHash(id, null, null, route), title, dataset: { tab: id }, 'aria-current': cur === id ? 'page' : null }, label))));
}

/** Fetch now, at the right end of the title bar: the cluster on screen, its late devices; ▾ for the whole cluster. */
function fetchControl() {
  const info = boardsInfo();
  const fc = fetchNowControl(boardsScope(route), { repaint: draw, done: () => { boardsForget(); draw(); } }, info);
  return P.get('fetch', `${fc.sig}|${info.sig || ''}`, fc.build);
}

/**
 * The title bar: the name, the tabs, the loading line and Fetch now. One row that wraps on a
 * narrow window; the shell is kept for the visit and its two slots are filled in place.
 */
function bar() {
  const b = busy();
  const status = P.get('busy', `${b}`, () => (b ? h('span.muted.ld-busy', { role: 'status' }, h('span.spin'), ' Loading…') : h('span.ld-busy', { role: 'status' })));
  const top = P.get('bar', '', () => h('div.rp-head.ld-bar', h('h1', 'Log Delay'), h('div.ld-bar-tabs'), h('div.ld-bar-right')));
  mount(top.children[1], tabs());
  mount(top.children[2], status, fetchControl());
  return top;
}

/* ------------------------------------ the tools row ------------------------------------ */

/** The cluster the boards show: all, or one; a cluster or device address names its own. */
function clusterPick() {
  const all = clusters();
  const tab = ldTab(route.view);
  const fixed = route.view === 'cluster' || route.view === 'device' ? route.clusterId : null;
  const cur = fixed || boardsPick();
  return P.get('pick', `${tab}|${cur}|${route.tz}|${all.map((c) => c.id).join(',')}`, () => {
    const sel = h('select#ld-clusters', { 'aria-label': 'Cluster', onchange: (e) => {
      const id = e.target.value;
      boardsSetPick(id);
      // The tab's own list for that cluster: the fleet or the cluster board, the devices of all or of one.
      location.hash = tab === 'devices' ? ldHash('devices', id === 'all' ? null : id, null, route) : id === 'all' ? ldHash('fleet', null, null, route) : ldHash('cluster', id, null, route);
    } }, h('option', { value: 'all' }, `All clusters (${all.length})`), ...all.map((c) => h('option', { value: c.id }, c.name)));
    sel.value = all.some((c) => c.id === cur) ? cur : 'all';
    return h('label.field.ld-tool', 'Cluster', sel);
  });
}

/** The boards' period (the store's days; Today is its measurement windows). */
function periodPick() {
  const cur = boardsPeriod();
  return P.get('period', cur, () => {
    const s = h('select#ld-period', { 'aria-label': 'Period', onchange: (e) => { boardsSetPeriod(e.target.value); draw(); } },
      ...PERIODS.map(([v, label]) => h('option', { value: v }, label)));
    s.value = cur;
    return h('label.field.ld-tool', 'Period', s);
  });
}

/* ------------------------------------ the time zone ------------------------------------ */

/** Whether the Expand panel is open; Esc and a click outside close it (wired once). */
let tzOpen = false;
let tzWired = false;
function wireTz() {
  if (tzWired) return;
  tzWired = true;
  document.addEventListener('click', (e) => {
    if (!tzOpen) return;
    if (e.target.closest && e.target.closest('.ld-tz-tools')) return;
    tzOpen = false; draw();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !tzOpen) return;
    e.stopPropagation(); tzOpen = false; draw();
    const b = document.getElementById('ld-tz-chip'); if (b) b.focus();
  }, true);
}

/** Go to the same view with the time-zone filter `tz` (an offset, 'none', or null for every zone). */
function setTz(tz) {
  tzOpen = false;
  location.hash = ldHash(route.view, route.clusterId, route.device, { tz });
}

/**
 * The time zone (docs/LOGDELAY.md "Time zones"; the owner's rule: no chooser, no counts in the
 * chip): "Time zone +05:30" — the majority zone of the devices in view — or "not detected"; with
 * the filter on, "+08:00 · only these devices". The chip is the button: it opens the zones with
 * their device counts, majority first; a zone filters every view (the filter lives in the
 * address, `?tz=`), and "Show all time zones" lets go of it.
 */
function tzTools() {
  wireTz();
  const rows = boardsZoneRows(route);
  const zones = devicesByZone(rows);
  const tz = route.tz;
  const pct = boardsMajorityPercent();
  const text = timeZoneChipText(zones, tz, offsetLabel);
  const sig = `${tz}|${tzOpen}|${zones.map((z) => `${z.key}:${z.devices}`).join(',')}|${pct}`;
  return P.get('tz', sig, () => {
    // The chip is the button (prototype v23): "Time zone +05:30 ▾" opens the per-zone counts.
    const mode = tz !== null ? 'filter' : zones.some((z) => z.offsetMinutes !== null) ? 'detected' : 'none';
    const canOpen = rows.length > 0 || tz !== null;
    const chip = h('button.ld-chip.ld-tz-chip#ld-tz-chip', { type: 'button', disabled: !canOpen,
      title: tz === null ? 'The zone the majority of the devices in view fall in. Opens every zone with its devices; a zone filters every view.' : 'Only the devices in this time zone are shown, on every view. Show all time zones lets go of the filter.',
      'aria-haspopup': 'menu', 'aria-expanded': String(tzOpen && canOpen), 'aria-controls': 'ld-tz-panel', dataset: { mode },
      onclick: () => { if (!canOpen) return; tzOpen = !tzOpen; draw(); if (tzOpen) { const first = document.querySelector('#ld-tz-panel .ld-tz-entry'); if (first) first.focus(); } },
    }, h('b', 'Time zone'), ' ', text, h('span.ld-tz-caret', { 'aria-hidden': 'true' }, ' ▾'));
    if (!canOpen) return h('div.ld-tz-tools', chip);
    const entries = zones.map((z, i) => {
      const key = z.offsetMinutes === null ? 'none' : z.offsetMinutes;
      const on = tz !== null && String(tz) === String(key);
      const words = z.offsetMinutes === null
        ? `not detected · ${countText(z.devices)} device${z.devices === 1 ? '' : 's'} · under ${pct} % agree, no correction`
        : `${offsetLabel(z.offsetMinutes)} · ${countText(z.devices)} device${z.devices === 1 ? '' : 's'}${i === 0 ? ' · majority' : ''}`;
      return h('button.ld-tz-entry', { type: 'button', role: 'menuitemradio', 'aria-checked': String(on), dataset: { zone: String(key) }, onclick: () => setTz(key) }, words);
    });
    const panel = h('div.ld-tz-panel#ld-tz-panel', { role: 'menu', 'aria-label': 'Devices by time zone', hidden: !tzOpen },
      h('div.ld-tz-panel-h', 'Devices by time zone', h('span.muted', ' · in view')),
      ...entries,
      tz !== null ? h('button.ld-tz-entry.ld-tz-all', { type: 'button', role: 'menuitem', onclick: () => setTz(null) }, 'Show all time zones') : null);
    return h('div.ld-tz-tools', chip, panel);
  });
}

/** Live Watch and Live logs: the range both read, and the zone every time is written in. */
function rangePick() {
  const tz = zone();
  const off = offsetText(zoneOffsetMinutes(tz));
  return P.get('range', `${JSON.stringify(range)}|${tz}|${off}`, () => {
    const sel = h('select#ld-range', { 'aria-label': 'Time range', onchange: (e) => {
      const id = e.target.value;
      if (id !== 'custom') { setRange({ id }); return; }
      // A custom range opens on the last hour, so both fields start filled.
      const now = Date.now();
      setRange({ id: 'custom', from: range.id === 'custom' && range.from ? range.from : now - 3600000, to: range.id === 'custom' && range.to ? range.to : now });
    } }, ...RANGES.map(([id, label]) => h('option', { value: id }, label)));
    sel.value = range.id;
    const custom = range.id === 'custom';
    const from = custom ? h('input#ld-range-from', { type: 'datetime-local', value: zonedInputValue(range.from, tz), 'aria-label': 'From' }) : null;
    const to = custom ? h('input#ld-range-to', { type: 'datetime-local', value: zonedInputValue(range.to, tz), 'aria-label': 'To' }) : null;
    const apply = custom ? h('button.btn.sm#ld-range-apply', { type: 'button', onclick: () => {
      const a = fromZonedInput(from.value, tz); const b = fromZonedInput(to.value, tz);
      if (a === null || b === null) { from.reportValidity && from.reportValidity(); return; }
      if (a > b) { to.setCustomValidity('To must be after From'); to.reportValidity && to.reportValidity(); to.setCustomValidity(''); return; }
      setRange({ id: 'custom', from: a, to: b });
    } }, 'Apply') : null;
    // One element (display: contents), so the cache keeps one node per draw.
    return h('div.ld-tools-range',
      h('label.field.ld-tool', 'Time range', sel),
      custom ? h('label.field.ld-tool', 'From', from) : null,
      custom ? h('label.field.ld-tool', 'To', to) : null,
      apply,
      h('span.muted.ld-zone', { title: serverZoneName() ? 'The server’s time zone' : 'The server has not said its time zone: this browser’s is used' },
        `Times in ${tz} (${off})`));
  });
}

/** One tools row for every tab: the cluster and period above the boards, the range above Live Watch and Live logs. */
function tools() {
  const tab = ldTab(route.view);
  const row = P.get('tools', '', () => h('div.toolbar.ld-tools'));
  if (tab === 'watch' || tab === 'live') mount(row, rangePick());
  else mount(row, clusterPick(), periodPick(), tzTools());
  return row;
}

function body() {
  const tab = ldTab(route.view);
  if (tab === 'watch') return watchNodes();
  if (tab === 'live') return liveNodes();
  return boardsNode(route, { repaint: draw });
}

function draw() {
  if (!host || !host.isConnected || isSnapshotMode()) return;
  P.begin();
  try {
    mount(host, bar(), tools(), body());
  } finally { P.end(); }
}

function snapshotNotice() {
  return h('div.banner.warn', { style: { margin: 0 } },
    h('div',
      h('div.ttl', 'Log Delay needs a live connection'),
      h('div', 'You are viewing a snapshot file collected elsewhere, so there is no cluster to query. ',
        'Everything that was collected — cluster health, disk, indices, nodes, snapshots and SLM — is on the other pages.'),
      h('div.sec', { style: { fontSize: '12px', marginTop: '5px' } },
        'To use this page, load clusters.yaml instead (Config-Management › System › Config file › Pick another file) and connect directly.')));
}
