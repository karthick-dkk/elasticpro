/**
 * Page — Log Delay (was "Logs & Delay" until 0.3.60, and its boards were Reports › Log delay):
 * how late each device's logs arrive, and the logs themselves. docs/LOGDELAY.md is the contract.
 *
 *   Dashboard   the core's store: the fleet's count tiles, Devices behind, the cluster × time
 *               heat map, By cluster; one cluster (logdelay/boards.js)
 *   Summary     the fleet view of Reports › Log delay before 0.3.60, back on the owner's word: four
 *               tiles, Delay reduced, Day by day, a ring per cluster worst first (logdelay/summary.js)
 *   Devices     every device, searched and filtered by level, each with its fix ("i") and its
 *               logs; one device beside the list (logdelay/boards.js)
 *   Live Watch  every cluster measured now from this browser, the delayed devices, one device
 *               live (logdelay/watch.js)
 *   Live logs   the documents over the time range, one device at a time if asked (logdelay/live-logs.js)
 *
 * The title bar carries the tabs and, at the right end, Fetch now (logdelay/fetch-now.js): one
 * cluster at a time, its late devices by default, the whole cluster from its ▾ menu. Under it
 * one tools row: the time range (one button group; the boards 30m to 12h with 1d to 60d in a More
 * menu, the live tabs 5m to 12h, each set keeping its own choice; or custom) and the
 * cluster's log time zone as a chip (not on Summary, whose figures are the core's totals for every
 * zone). Every time on the page is in the server's zone.
 *
 * The cluster is the app's one chooser, in the top bar (the owner, 2026-11-14: the page had a
 * second one of its own, and two controls for one choice is one too many). `reconcile()` keeps
 * the two in step: the chooser moves the address (All clusters → the fleet / every device, one
 * cluster → that cluster's board / its devices), and an address that names a cluster — a link
 * in the By cluster table, an alert, a bookmark — moves the chooser (the shell's 'select-cluster').
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
import { bus, clusters } from '../core/state.js';
import { ldRoute, ldHash, ldTab, setDisplayZone, LD_PAGE, timeZoneChipText, devicesByZone, countText } from '../core/logdelay-report.js';
import { BOARD_RANGES, LIVE_RANGES, BOARD_MAX_DAYS, rangeLabel, rangeDays, normaliseRange, browserZone, zonedParts, zonedInputValue, fromZonedInput, offsetText, zoneOffsetMinutes } from '../core/log-range.js';
import { offsetLabel } from '../core/log-tz.js';
import {
  boardsNode, boardsReset, boardsLeave, boardsForget, boardsLoading, boardsScope,
  pickId, boardsSetWindow, boardsInfo, boardsZoneRows, boardsMajorityPercent,
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
  ['summary', 'Summary', 'Every device in four figures, delays reduced, day by day, and a ring per cluster worst first'],
  ['devices', 'Devices', 'Every device, by level, with its fix and its logs; one device in detail'],
  ['watch', 'Live Watch', 'Live check from this browser (500 devices per cluster at most): the delayed devices, and one device live'],
  ['live', 'Live logs', 'The log documents over the time range, with each one’s delay'],
];

/* ------------------------------------ the range ------------------------------------ */

/*
 * Two ranges, kept apart (core/log-range.js): the boards' (Dashboard, Summary, Devices and the
 * cluster and device views; 30m to 60d) and the live tabs' (Live Watch, Live logs; 5m to 12h), so
 * a 30-day board never becomes a 30-day measurement from this browser. Both live in one
 * localStorage entry, `{boards, live}`; the single range kept before there were two seeds both, each
 * normalised to its own set (a 5m board is 30m, nothing said).
 */
const RANGE_KEY = 'elasticpro.logdelay.range';
function readRanges() {
  let raw = null;
  try { const s = localStorage.getItem(RANGE_KEY); raw = s ? JSON.parse(s) : null; } catch (_) { raw = null; }
  const old = raw && typeof raw === 'object' && !('boards' in raw) && !('live' in raw) ? raw : null;
  return {
    boards: normaliseRange(old || (raw && raw.boards), BOARD_RANGES),
    live: normaliseRange(old || (raw && raw.live), LIVE_RANGES),
  };
}
/** Read again on every visit (render, arriving): another browser tab may have chosen since. */
let ranges = readRanges();
/** Which of the two ranges a tab reads. */
const rangeKind = (tab = ldTab(route.view)) => (tab === 'watch' || tab === 'live' ? 'live' : 'boards');
function setRange(r) {
  const kind = rangeKind();
  ranges[kind] = normaliseRange(r, kind === 'live' ? LIVE_RANGES : BOARD_RANGES);
  try { localStorage.setItem(RANGE_KEY, JSON.stringify(ranges)); } catch (_) { /* kept for this visit */ }
  if (ldTab(route.view) === 'live') liveRangeChanged();
  draw();
}

/** The zone every time on the page is written in: the server's when it said it, else this browser's. */
const zone = () => serverZoneName() || browserZone();

/** What the live views read from the page: the redraw, their time range, the zone times are written in, the time-zone filter. */
const viewCtx = () => ({ repaint: draw, range: () => ranges.live, zone, tz: () => route.tz });

/* ------------------------------------ the page ------------------------------------ */

export function render(el) {
  host = el;
  el.classList.add('dense', 'rp-page', 'ld-page');
  if (isSnapshotMode()) { mount(host, snapshotNotice()); return; }
  const arriving = !visiting;
  if (arriving) { visiting = true; boardsReset(); P.clear(); ranges = readRanges(); moreOpen = false; }
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
  // Arriving, an address that names a cluster is the explicit choice; otherwise, and whenever
  // the shell draws the page again because the chooser moved, the chooser is.
  reconcile(arriving && route.clusterId ? 'address' : 'chooser');
  enter(route);
  if (f && f.view === 'delay') watchStart();
  draw();
}

/**
 * One cluster choice (the top bar's chooser) and one address, kept in step. `lead` says which
 * one just moved: 'address' (a link, a tab, Back, a bookmark) moves the chooser to the cluster
 * it names, or to All clusters when it names none; 'chooser' moves the address to the same tab
 * for the cluster chosen — the cluster board, its summary or its devices; the fleet, the fleet's
 * summary or every device for All.
 * Live Watch and Live logs read the chooser themselves (activeClusters), so they are left alone.
 */
function reconcile(lead) {
  const tab = ldTab(route.view);
  if (tab === 'watch' || tab === 'live') return;
  const named = route.clusterId && clusters().some((c) => c.id === route.clusterId) ? route.clusterId : null;
  const sel = pickId();
  if (named === sel) return;
  if (lead === 'address') { bus.emit('select-cluster', named || 'all'); return; }
  const want = tab === 'devices' || tab === 'summary' ? ldHash(tab, sel, null, route) : sel ? ldHash('cluster', sel, null, route) : ldHash('fleet', null, null, route);
  if (location.hash !== want) { try { history.replaceState(null, '', want); } catch (_) { location.hash = want; } }
  route = ldRoute(location.hash);
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
  reconcile('address');
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
  if (tab === 'fleet' || tab === 'summary' || tab === 'devices') boardsLeave();
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

/** The tabs, each for the cluster chosen: Dashboard is the cluster's board (the fleet for All), Summary and Devices its own. */
function tabs() {
  const cur = ldTab(route.view);
  const sel = pickId();
  const hrefOf = (id) => (id === 'fleet' && sel ? ldHash('cluster', sel, null, route) : id === 'devices' || id === 'summary' ? ldHash(id, sel, null, route) : ldHash(id, null, null, route));
  return P.get('tabs', `${cur}|${route.tz}|${sel}`, () => h('nav.rp-nav.ld-tabs', { 'aria-label': 'Log Delay views' },
    ...TABS.map(([id, label, title]) => h('a', { href: hrefOf(id), title, dataset: { tab: id }, 'aria-current': cur === id ? 'page' : null }, label))));
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
  // No "Log Delay" heading: the page's name is in the menu, once (the owner, 2026-11-14).
  const top = P.get('bar', '', () => h('div.rp-head.ld-bar', h('div.ld-bar-tabs'), h('div.ld-bar-right')));
  mount(top.children[0], tabs());
  mount(top.children[1], status, fetchControl());
  return top;
}

/* ------------------------------------ the tools row ------------------------------------ */

/* ------------------------------------ the time zone ------------------------------------ */

/**
 * Whether the time-zone panel (tzOpen) or the boards range's More menu (moreOpen) is open; Esc
 * and a click outside close either, and Esc gives the focus back to the button (wired once).
 */
let tzOpen = false;
let moreOpen = false;
let popWired = false;
function wirePopups() {
  if (popWired) return;
  popWired = true;
  document.addEventListener('click', (e) => {
    const inside = (sel) => e.target.closest && e.target.closest(sel);
    let changed = false;
    if (tzOpen && !inside('.ld-tz-tools')) { tzOpen = false; changed = true; }
    if (moreOpen && !inside('.ld-range-wrap')) { moreOpen = false; changed = true; }
    if (changed) draw();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!tzOpen && !moreOpen)) return;
    e.stopPropagation();
    const back = tzOpen ? 'ld-tz-chip' : 'ld-range-more';
    tzOpen = false; moreOpen = false; draw();
    const b = document.getElementById(back); if (b) b.focus();
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
  wirePopups();
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

/**
 * The tab's time range as one button group (core/log-range.js). On the boards (BOARD_RANGES):
 * 30m · 1h · 2h · 4h · 8h · 12h, then More ▾ — a menu of 1d · 3d · 7d · 15d · 30d · 60d; with one
 * of those chosen the button reads it ("7d ▾") and is pressed — then Custom. On Live Watch and
 * Live logs (LIVE_RANGES): 5m · 10m · 30m · 1h · 3h · 12h · Custom. Each set keeps its own choice.
 * Custom opens From and To in the server's zone and Apply. The boards read their range as the
 * days it touches (boards.js boardsSetWindow), the live tabs theirs as minutes. `withZone` adds
 * the zone every time is written in (the boards have the chip instead).
 */
function rangePick(withZone) {
  wirePopups();
  const tz = zone();
  const off = offsetText(zoneOffsetMinutes(tz));
  const kind = rangeKind();
  const range = ranges[kind];
  return P.get('range', `${kind}|${JSON.stringify(range)}|${tz}|${off}|${withZone}|${kind === 'boards' && moreOpen}`, () => {
    const pick = (id) => {
      moreOpen = false;
      if (id !== 'custom') { setRange({ id }); return; }
      // A custom range opens on the last hour, so both fields start filled.
      const now = Date.now();
      setRange({ id: 'custom', from: range.id === 'custom' && range.from ? range.from : now - 3600000, to: range.id === 'custom' && range.to ? range.to : now });
    };
    const btn = (id) => h('button.seg-btn', { type: 'button', dataset: { range: id }, title: rangeLabel(id), 'aria-pressed': String(range.id === id), onclick: () => pick(id) }, id === 'custom' ? 'Custom' : id);
    const set = kind === 'live' ? LIVE_RANGES : BOARD_RANGES;
    const days = set.filter((id) => rangeDays(id) !== null);
    let group; let menu = null;
    if (!days.length) group = h('div.seg-group#ld-range', { role: 'group', 'aria-label': 'Time range' }, ...set.map(btn));
    else {
      const onDay = days.includes(range.id);
      const open = moreOpen;
      const more = h('button.seg-btn.ld-range-more#ld-range-more', {
        type: 'button', title: onDay ? `${rangeLabel(range.id)} — longer ranges, in whole local days (today included)` : 'Longer ranges, in whole local days (today included)',
        'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-controls': 'ld-range-menu', 'aria-pressed': String(onDay),
        onclick: () => { moreOpen = !moreOpen; draw(); if (moreOpen) { const f = document.querySelector('#ld-range-menu [aria-checked="true"]') || document.querySelector('#ld-range-menu .ld-range-entry'); if (f) f.focus(); } },
      }, onDay ? range.id : 'More', h('span.ld-tz-caret', { 'aria-hidden': 'true' }, ' ▾'));
      group = h('div.seg-group#ld-range', { role: 'group', 'aria-label': 'Time range' },
        ...set.filter((id) => id !== 'custom' && !days.includes(id)).map(btn), more, ...(set.includes('custom') ? [btn('custom')] : []));
      menu = h('div.ld-range-menu#ld-range-menu', { role: 'menu', 'aria-label': 'Longer ranges', hidden: !open },
        ...days.map((id) => h('button.ld-range-entry', { type: 'button', role: 'menuitemradio', 'aria-checked': String(range.id === id), dataset: { range: id }, title: rangeLabel(id), onclick: () => pick(id) },
          h('b', id), h('span.muted', ` ${rangeLabel(id)}`))));
    }
    const wrap = h('div.ld-range-wrap', group, menu);
    const custom = range.id === 'custom';
    const from = custom ? h('input#ld-range-from', { type: 'datetime-local', value: zonedInputValue(range.from, tz), 'aria-label': 'From' }) : null;
    const to = custom ? h('input#ld-range-to', { type: 'datetime-local', value: zonedInputValue(range.to, tz), 'aria-label': 'To' }) : null;
    const apply = custom ? h('button.btn.sm#ld-range-apply', { type: 'button', onclick: () => {
      const a = fromZonedInput(from.value, tz); const b = fromZonedInput(to.value, tz);
      if (a === null || b === null) { from.reportValidity && from.reportValidity(); return; }
      const refuse = (msg) => { to.setCustomValidity(msg); to.reportValidity && to.reportValidity(); to.setCustomValidity(''); };
      if (a > b) { refuse('To must be after From'); return; }
      // The core takes at most BOARD_MAX_DAYS local days in one question: said here, not sent to be refused.
      const dayNo = (ms) => { const p = zonedParts(ms, tz); return Date.UTC(p.year, p.month - 1, p.day) / 86400000; };
      if (kind === 'boards' && dayNo(b) - dayNo(a) > BOARD_MAX_DAYS) { refuse(`At most ${BOARD_MAX_DAYS} days in one range`); return; }
      setRange({ id: 'custom', from: a, to: b });
    } }, 'Apply') : null;
    // One element (display: contents), so the cache keeps one node per draw.
    return h('div.ld-tools-range', wrap,
      custom ? h('label.ld-tool', 'From', from) : null,
      custom ? h('label.ld-tool', 'To', to) : null,
      apply,
      withZone ? h('span.muted.ld-zone', { title: serverZoneName() ? 'The server’s time zone' : 'The server has not said its time zone: this browser’s is used' },
        `Times in ${tz} (${off})`) : null);
  });
}

/**
 * One tools row for every tab: the time range, then the time-zone chip (Dashboard, Devices) or the
 * zone's name (Live Watch, Live logs); Summary has the range alone. The cluster is the top bar's chooser.
 */
function tools() {
  const tab = ldTab(route.view);
  const row = P.get('tools', '', () => h('div.toolbar.ld-tools'));
  if (tab === 'watch' || tab === 'live') mount(row, rangePick(true));
  else if (tab === 'summary') mount(row, rangePick(false));
  else mount(row, rangePick(false), tzTools());
  return row;
}

function body() {
  const tab = ldTab(route.view);
  if (tab === 'watch') return watchNodes();
  if (tab === 'live') return liveNodes();
  boardsSetWindow(ranges.boards, zone());
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
