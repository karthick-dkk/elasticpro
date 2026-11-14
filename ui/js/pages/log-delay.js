/**
 * Page — Log Delay (was "Logs & Delay" until 0.3.60, and its boards were Reports › Log delay):
 * how late each device's logs arrive, and the logs themselves. docs/LOGDELAY.md is the contract.
 *
 *   Dashboard          the core's store: the fleet, a cluster, a device (logdelay/boards.js)
 *   Recommended fixes  why it was late and what to do (logdelay/boards.js)
 *   Live Watch         every cluster measured now, the delayed devices, one device live (logdelay/watch.js)
 *   Live logs          the documents over the time range, one device at a time if asked (logdelay/live-logs.js)
 *
 * The routes are core/logdelay-report.js (ldRoute, ldHash); #/logs and #/reports/log-delay/… still
 * open here (reports/route.js movedPath). The time range above Live Watch and Live logs is one
 * setting for both (core/log-range.js), and every time on the page is in the server's zone.
 *
 * The page is drawn piece by piece (lib/keyed.js): the header, the tabs, the bar and each card
 * are kept until what they show changed, so an answer arriving or a push from the core never
 * rebuilds what is under the mouse, and the tabs and links work while anything is still loading.
 * Leaving a view lets go of what it asked (each view's AbortController).
 */

import { h, mount } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { takeFocus } from '../core/focus.js';
import { intent } from '../core/intent.js';
import { serverZoneName } from '../core/es.js';
import { ldRoute, ldHash, ldTab, setDisplayZone, LD_PAGE } from '../core/logdelay-report.js';
import { RANGES, normaliseRange, browserZone, zonedInputValue, fromZonedInput, offsetText, zoneOffsetMinutes } from '../core/log-range.js';
import { boardsNode, boardsReset, boardsLeave, boardsForget, boardsLoading, boardsScope } from '../logdelay/boards.js';
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
  ['fleet', 'Dashboard', 'The core’s measurements: every cluster, one cluster, one device'],
  ['fixes', 'Recommended fixes', 'Why devices were late, and what to do about it'],
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

const viewCtx = () => ({ repaint: draw, range: () => range, zone });

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
 * An old address (#/reports/log-delay/…, #/logs) that reached this page reads as the view's own
 * from here on, without a history entry of its own: Back goes where it went before.
 */
function canonical() {
  const first = String(location.hash || '').replace(/^#\/?/, '').split(/[/?]/)[0];
  if (first === LD_PAGE) return;
  const want = ldHash(route.view, route.clusterId, route.device);
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
  if (tab === 'fleet' || tab === 'fixes') boardsLeave();
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

function header() {
  const b = busy();
  return P.get('head', `${b}`, () => h('div.rp-head',
    h('div', h('h1', 'Log Delay'),
      h('p.sub', 'How late each device’s logs arrive, why, and the logs themselves.')),
    b ? h('span.muted.ld-busy', { role: 'status' }, h('span.spin'), ' Loading…') : h('span.ld-busy', { role: 'status' })));
}

function tabs() {
  const cur = ldTab(route.view);
  return P.get('tabs', cur, () => h('nav.rp-nav.ld-tabs', { 'aria-label': 'Log Delay views' },
    ...TABS.map(([id, label, title]) => h('a', { href: ldHash(id), title, dataset: { tab: id }, 'aria-current': cur === id ? 'page' : null }, label))));
}

/** Above Live Watch and Live logs: the range both read, and the zone every time is written in. */
function rangeBar() {
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
    return h('div.toolbar.ld-range-bar',
      h('label.field', 'Time range', sel),
      custom ? h('label.field', 'From', from) : null,
      custom ? h('label.field', 'To', to) : null,
      apply,
      h('span.muted.ld-zone', { title: serverZoneName() ? 'The server’s time zone' : 'The server has not said its time zone: this browser’s is used' },
        `Times in ${tz} (${off})`));
  });
}

/** Above the boards: Fetch Now for what is on screen. */
function fetchBar() {
  const fc = fetchNowControl(boardsScope(route), { repaint: draw, done: () => { boardsForget(); draw(); } });
  return P.get('fetch', fc.sig, fc.build);
}

function body() {
  const tab = ldTab(route.view);
  if (tab === 'watch') return watchNodes();
  if (tab === 'live') return liveNodes();
  return boardsNode(route, { repaint: draw });
}

function draw() {
  if (!host || !host.isConnected || isSnapshotMode()) return;
  const tab = ldTab(route.view);
  P.begin();
  try {
    mount(host, header(), tabs(), tab === 'watch' || tab === 'live' ? rangeBar() : fetchBar(), body());
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
