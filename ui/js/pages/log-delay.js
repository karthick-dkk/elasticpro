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
 *   Live        Live Watch and Live logs as one tab: "Delayed now" — the chosen cluster measured
 *               from this browser on Fetch, one device watched (logdelay/watch.js) — and "Logs",
 *               its documents on Search (logdelay/live-logs.js). Nothing runs until pressed.
 *
 * The title bar is one row: the tabs, and at the right end the time range then Fetch now
 * (the owner, 0.3.78: period and Fetch on one row). The time range is one button group (the
 * boards 30m to 12h with 1d to 60d in a More menu, the live tabs 5m to 12h, each set keeping its
 * own choice; or custom) behind its toggle ("⏱ 1h ▾"), which folds the group away, kept per
 * browser. Fetch now (logdelay/fetch-now.js; not on Live, which has its own Fetch from the
 * browser): one cluster at a time, its late devices by default, the whole cluster from its ▾ menu.
 * Under the bar a tools row only when it has something to say: the cluster's log time zone as a
 * chip (Dashboard and Devices, and only when a zone is set or detected in view: "not detected"
 * everywhere said nothing, 0.3.77), or on Live the zone's name. Every time on the page is in the
 * server's zone.
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

import { h, mount, svg } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { takeFocus } from '../core/focus.js';
import { intent } from '../core/intent.js';
import { serverZoneName } from '../core/es.js';
import { bus, clusters } from '../core/state.js';
import { isOff, offText } from '../core/collection.js';
import { ldRoute, ldHash, ldTab, setDisplayZone, LD_PAGE, timeZoneChipText, zoneChipShown, devicesByZone, countText } from '../core/logdelay-report.js';
import { BOARD_RANGES, LIVE_RANGES, BOARD_MAX_DAYS, rangeLabel, rangeDays, normaliseRange, browserZone, zonedParts, zonedInputValue, fromZonedInput, offsetText, zoneOffsetMinutes } from '../core/log-range.js';
import { offsetLabel } from '../core/log-tz.js';
import {
  boardsNode, boardsReset, boardsLeave, boardsForget, boardsLoading, boardsScope,
  pickId, boardsSetWindow, boardsInfo, boardsZoneRows, boardsMajorityPercent,
} from '../logdelay/boards.js';
import { watchCard, watchStrip, watchEnter, watchLeave, watchBusy } from '../logdelay/watch.js';
import { liveCard, liveEnter, liveLeave, liveBusy, liveRangeChanged } from '../logdelay/live-logs.js';
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
  ['live', 'Live', 'Measured now from this browser on Fetch, one device watched, and its logs on Search: nothing runs until pressed'],
];

/* ------------------------------------ the range ------------------------------------ */

/*
 * Two ranges, kept apart (core/log-range.js): the boards' (Dashboard, Summary, Devices and the
 * cluster and device views; 30m to 60d) and Live's (5m to 12h), so
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
const rangeKind = (tab = ldTab(route.view)) => (tab === 'live' ? 'live' : 'boards');
function setRange(r) {
  const kind = rangeKind();
  ranges[kind] = normaliseRange(r, kind === 'live' ? LIVE_RANGES : BOARD_RANGES);
  try { localStorage.setItem(RANGE_KEY, JSON.stringify(ranges)); } catch (_) { /* kept for this visit */ }
  if (ldTab(route.view) === 'live') liveRangeChanged();
  draw();
}

/**
 * Whether the range group is shown, or folded to its toggle ("⏱ 1h ▾") at the right end of the
 * tools row (the owner, 0.3.77): one choice for every tab, kept per browser; shown until folded.
 */
const RANGE_OPEN_KEY = 'elasticpro.logdelay.rangeShown';
const readRangeOpen = () => { try { return localStorage.getItem(RANGE_OPEN_KEY) !== '0'; } catch (_) { return true; } };
let rangeOpen = readRangeOpen();
function setRangeOpen(open) {
  rangeOpen = !!open;
  if (!rangeOpen) moreOpen = false;
  try { localStorage.setItem(RANGE_OPEN_KEY, rangeOpen ? '1' : '0'); } catch (_) { /* kept for this visit */ }
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
  if (arriving) { visiting = true; boardsReset(); P.clear(); ranges = readRanges(); rangeOpen = readRangeOpen(); moreOpen = false; }
  setDisplayZone(zone());
  // From a "logs arriving late" alert or its playbook (core/focus.js): Live, ready to Fetch (nothing
  // starts on its own). From a link that named a view (navigateTo('log-delay', {view, cluster, device})): that view.
  const f = takeFocus('log-delay') || takeFocus('logs');
  const asked = intent.logDelay;
  intent.logDelay = null;
  let want = null;
  if (f && f.view === 'delay') want = ldHash('live');
  if (asked && asked.view) want = ldHash(asked.view, asked.cluster, asked.device);
  if (want && location.hash !== want) { try { history.replaceState(null, '', want); } catch (_) { location.hash = want; } }
  route = ldRoute(location.hash);
  canonical();
  // Arriving, an address that names a cluster is the explicit choice; otherwise, and whenever
  // the shell draws the page again because the chooser moved, the chooser is.
  reconcile(arriving && route.clusterId ? 'address' : 'chooser');
  enter(route);
  draw();
}

/**
 * One cluster choice (the top bar's chooser) and one address, kept in step. `lead` says which
 * one just moved: 'address' (a link, a tab, Back, a bookmark) moves the chooser to the cluster
 * it names, or to All clusters when it names none; 'chooser' moves the address to the same tab
 * for the cluster chosen — the cluster board, its summary or its devices; the fleet, the fleet's
 * summary or every device for All.
 * Live reads the chooser itself (pickId, activeClusters), so it is left alone.
 */
function reconcile(lead) {
  const tab = ldTab(route.view);
  if (tab === 'live') return;
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
  if (tab === 'live') { watchLeave(); liveLeave(); }
}

function enter(r) {
  const tab = ldTab(r.view);
  if (entered && entered !== tab) leave(entered);
  entered = tab;
  if (tab === 'live') { watchEnter(viewCtx()); liveEnter(viewCtx(), r); }
}

function busy() {
  const tab = ldTab(route.view);
  return fetchNowBusy() || (tab === 'live' ? watchBusy() || liveBusy() : boardsLoading());
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
 * The title bar: the tabs, the loading line, the time range and Fetch now. One row that wraps on a
 * narrow window; the shell is kept for the visit and its two slots are filled in place.
 */
function bar() {
  const b = busy();
  const status = P.get('busy', `${b}`, () => (b ? h('span.muted.ld-busy', { role: 'status' }, h('span.spin'), ' Loading…') : h('span.ld-busy', { role: 'status' })));
  // No "Log Delay" heading: the page's name is in the menu, once (the owner, 2026-11-14).
  const top = P.get('bar', '', () => h('div.rp-head.ld-bar', h('div.ld-bar-tabs'), h('div.ld-bar-right')));
  mount(top.children[0], tabs());
  // Live has its own Fetch, from the browser: the core's Fetch now beside it would be a second button for a different thing.
  mount(top.children[1], status, rangePick(), ldTab(route.view) === 'live' ? null : fetchControl());
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
  location.hash = ldHash(route.view, route.clusterId, route.device, { ...route, tz });
}

/**
 * The time zone (docs/LOGDELAY.md "Time zones"; the owner's rule: no chooser, no counts in the
 * chip): "Time zone +05:30" — the majority zone of the devices in view — or "not detected"; with
 * the filter on, "+08:00 · only these devices". The chip is the button: it opens the zones with
 * their device counts, majority first; a zone filters every view (the filter lives in the
 * address, `?tz=`), and "Show all time zones" lets go of it. Not drawn at all while no device in
 * view has a zone and no filter is on (zoneChipShown): every cluster "not detected" is the normal
 * state of logs stamped in UTC, and a chip that always says it is noise (the owner, 0.3.77).
 */
function tzTools() {
  wirePopups();
  const rows = boardsZoneRows(route);
  const zones = devicesByZone(rows);
  const tz = route.tz;
  // Drawn only when it can say something (zoneChipShown): a zone set or detected in view, or the filter on.
  if (!zoneChipShown(zones, tz)) { tzOpen = false; return null; }
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
 * The tab's time range as one button group (core/log-range.js), at the right end of the tools
 * row behind its toggle — a clock and the range chosen ("1h ▾", `aria-expanded`), which folds the
 * group away and shows it again (rangeOpen, kept per browser). On the boards (BOARD_RANGES):
 * 30m · 1h · 2h · 4h · 8h · 12h, then More ▾ — a menu of 1d · 3d · 7d · 15d · 30d · 60d; with one
 * of those chosen the button reads it ("7d ▾") and is pressed — then Custom. On Live
 * (LIVE_RANGES): 5m · 10m · 30m · 1h · 3h · 12h · Custom. Each set keeps its own choice.
 * Custom opens From and To in the server's zone and Apply. The boards read their range as the
 * days it touches (boards.js boardsSetWindow), the live tabs theirs as minutes.
 */
function rangePick() {
  wirePopups();
  const tz = zone();
  const kind = rangeKind();
  const range = ranges[kind];
  return P.get('range', `${kind}|${JSON.stringify(range)}|${tz}|${kind === 'boards' && moreOpen}|${rangeOpen}`, () => {
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
    // The toggle: a clock and the range chosen; it folds the group away and shows it again.
    const clock = svg('svg', { viewBox: '0 0 24 24', width: '13', height: '13', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      svg('circle', { cx: 12, cy: 12, r: 9 }), svg('path', { d: 'M12 7v5l3 2' }));
    const toggle = h('button.ld-chip.ld-range-toggle#ld-range-toggle', {
      type: 'button', 'aria-expanded': String(rangeOpen), 'aria-controls': 'ld-range-body',
      title: `${rangeLabel(range.id)} · ${rangeOpen ? 'hide the time ranges' : 'show the time ranges'}`,
      onclick: () => setRangeOpen(!rangeOpen),
    }, clock, h('b', custom ? 'Custom' : range.id), h('span.ld-tz-caret', { 'aria-hidden': 'true' }, rangeOpen ? ' ▴' : ' ▾'));
    // One element, so the cache keeps one node per draw.
    return h('div.ld-tools-range', { dataset: { open: String(rangeOpen) } }, toggle,
      h('div.ld-range-body#ld-range-body', { hidden: !rangeOpen }, wrap,
        custom ? h('label.ld-tool', 'From', from) : null,
        custom ? h('label.ld-tool', 'To', to) : null,
        apply));
  });
}

/** Live: the zone every time is written in (the boards have the time-zone chip instead). */
function zoneNote() {
  const tz = zone();
  const off = offsetText(zoneOffsetMinutes(tz));
  return P.get('zone', `${tz}|${off}`, () => h('span.muted.ld-zone', { title: serverZoneName() ? 'The server’s time zone' : 'The server has not said its time zone: this browser’s is used' },
    `Times in ${tz} (${off})`));
}

/**
 * The tools row under the bar: the time-zone chip (Dashboard, Devices; only when it has a zone to
 * say) or the zone's name (Live). Empty — and so not drawn (CSS :empty) — on Summary and wherever
 * no zone is set or detected. The time range is in the bar, beside Fetch now.
 */
function tools() {
  const tab = ldTab(route.view);
  const row = P.get('tools', '', () => h('div.toolbar.ld-tools'));
  if (tab === 'live') mount(row, zoneNote());
  else if (tab === 'summary') mount(row);
  else mount(row, tzTools());
  return row;
}

function body() {
  const tab = ldTab(route.view);
  if (tab === 'live') {
    const wrap = P.get('live', '', () => h('div.rp-section.ld.ld-live', { dataset: { ld: 'live' } }));
    mount(wrap, watchCard(), liveCard(watchStrip()));
    return wrap;
  }
  boardsSetWindow(ranges.boards, zone());
  return boardsNode(route, { repaint: draw });
}

function draw() {
  if (!host || !host.isConnected || isSnapshotMode()) return;
  P.begin();
  try {
    const off = offNote();
    // One cluster chosen whose log delay is switched off: the note, nothing measured to show.
    mount(host, bar(), tools(), off, off && off.dataset.only === '1' ? null : body());
  } finally { P.end(); }
}

/**
 * Log delay switched off (Edit cluster › Collection, core/collection.js): the cluster chosen, or
 * the ones among all, are never measured — said here, and where to turn it on, rather than shown
 * as clusters with no data. Null when none is.
 */
function offNote() {
  const sel = pickId();
  const list = clusters().filter((c) => (sel ? c.id === sel : true) && isOff(c, 'logDelay'));
  if (!list.length) return null;
  const only = !!sel;
  const text = only ? `${offText('logDelay')}: it is not measured while it is off.`
    : `${offText('logDelay')}: ${list.map((c) => c.name).join(', ')} — not measured while it is off.`;
  return h('div.muted.ld-off', { dataset: { only: only ? '1' : '0' }, style: { fontSize: '12px', margin: '4px 0' } }, text);
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
