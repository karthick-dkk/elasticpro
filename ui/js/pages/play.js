/**
 * Play: the NOC wall display (docs/PLAY.md). Route #/play, full screen, no app chrome.
 *
 * The TV runs the same UI code as everyone else: every figure on a slide comes from the
 * function the normal pages already use, and this page only arranges them, turns the slides
 * and keeps the timers. The slides live under ui/js/play/, one module each; the engine
 * (which slide, for how long, what takes the screen) is play/engine.js.
 *
 * What it asks of the core beyond the fleet engine: PLAY_STATE once a minute (settings,
 * excluded clusters, node-left, open-since), ACK_LIST (shared acknowledgements), the shared
 * measurement cache, and the daily volume record. An older core answers none of the Play
 * messages; then Play runs on the defaults, with local acknowledgements and its own
 * measurements, and says what is missing.
 *
 * Every timer is in `timers` and every listener in `listeners`; leaving clears both.
 */

import { h, mount } from '../lib/dom.js';
import { state, clusters, client, mergedAlerts, invalidateAlerts, watchForPlay, fleetMode,
  datasetFreshness, refreshAll } from '../core/state.js';
import { isOpen, isHeld, heldByCluster, toObservations } from '../core/alert-groups.js';
import { alertHistory } from '../core/alert-history.js';
import { isStale } from '../lib/freshness.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { runBounded } from '../core/fleet.js';
import { volumeReport } from '../core/volume.js';
import { volumeDaily } from '../core/volume-daily.js';
import { classify, summarise, DEFAULT_THRESHOLDS } from '../core/log-delay.js';
import { healthState } from '../core/state.js';
import { playState, readPlayState, defaultPlayState, shareGet, zoomSet } from '../play/api.js';
import { loadAcks, isAcked, acksOnServer } from '../core/acks.js';
import { credentialsKeptOnServer } from '../core/server-credentials.js';
import { createEngine, zoomStep, ZOOM_STEPS, dwellMs, takeover, spotlightMembers, burnShift, staleness } from '../play/engine.js';
import { clusterStatus, spotlightReasons } from '../play/status.js';
import { createMeasurer, MEASURE_EVERY_MS } from '../play/measure.js';
import { clockText, zoneName } from '../play/parts.js';
import * as sFleet from '../play/fleet.js';
import * as sAlerts from '../play/alerts.js';
import * as sSpotlight from '../play/spotlight.js';
import * as sLogdelay from '../play/logdelay.js';
import * as sBackups from '../play/backups.js';
import * as sVolume from '../play/volume.js';
import { fullscreen, hintDismissed, dismissHint } from '../core/fullscreen.js';

export const SLIDES = [sFleet, sAlerts, sSpotlight, sLogdelay, sBackups, sVolume];
const SLIDE = new Map(SLIDES.map((s) => [s.id, s]));
/** Everything the slides read, Play-watched (watchForPlay) so the core keeps it coming at Play's pace. */
export const DATASETS = ['health', 'nodes', 'ilm_errors', 'policies', 'ilm_assign', 'snapshots', 'snapshots_full', 'indices'];
const ZOOM_KEY = 'elasticpro.play.zoom';
const CONTROLS_MS = 5000;
const VOLUME_EVERY_MS = 10 * 60 * 1000;
const REPO_EVERY_MS = 10 * 60 * 1000;
const SPOT_EVERY_MS = 5000;

/* ----------------------------------- state ----------------------------------- */

let host = null;
let els = null;
const timers = new Set();
const listeners = [];
let display = false;              // opened through a display link: no exit, the display's own settings
let onExit = null;

let ps = defaultPlayState();
let support = { play: null, acks: null, volume: null };
let skew = 0;
let engine = null;
let take = null;                  // play/engine.js takeover() state
let spot = new Map();
let spotAt = 0;
let zoom = 1;
let zoomFromServer = true;
let lastPhase = '';
let lastSlide = '';
let lastObserved = 0;
let lastAckPoll = 0;
let ctxMemo = { at: 0, ctx: null };
let ctlUntil = 0;
const volume = new Map();
const repoSize = new Map();
const reports = new WeakMap();
let measurer = null;
const delayMemo = new Map();

/** Called by the shell: whether this is a display link, and how a person leaves. */
export function configure(opts = {}) {
  display = !!opts.display;
  onExit = typeof opts.onExit === 'function' ? opts.onExit : null;
  if (typeof opts.warmMs === 'number') warmMs = opts.warmMs;
}
/** How long after opening a critical alert counts as already there rather than new. */
export const WARM_MS = 30000;
let warmMs = WARM_MS;
let openedAt = 0;

const serverNow = () => Date.now() + skew;
const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
const every = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
const listen = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); listeners.push([target, ev, fn, opts]); };

/* ----------------------------------- zoom ----------------------------------- */

function readZoom() {
  if (display) return ps.display.zoom || ps.display.lastZoom || 1;
  try { const v = Number(localStorage.getItem(ZOOM_KEY)); return ZOOM_STEPS.includes(v) ? v : 1; } catch (_) { return 1; }
}
function setZoom(z, { save = true } = {}) {
  zoom = zoomStep(z, 0);
  if (els) els.body.style.setProperty('--pz', String(zoom));
  if (els) els.zoomLabel.textContent = `${Math.round(zoom * 100)} %`;
  if (save && !display) { try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch (_) { /* this browser keeps nothing */ } }
  // A display link keeps its zoom with the display's settings on the server (PLAY_ZOOM_SET);
  // an older core has no such message and the zoom lasts until the page reloads.
  if (save && display) { zoomFromServer = false; zoomSet(zoom).then((r) => { if (r && r.ok) zoomFromServer = true; }).catch(() => {}); }
}
function zoomBy(dir) {
  if (display && ps.display.zoomFixed) return;
  setZoom(zoomStep(zoom, dir));
  draw();
}

/* ------------------------------- what is shown ------------------------------- */

/** The clusters this display shows: every one the shell has, less the ones Config › Play excludes. */
const visible = () => clusters().filter((c) => !ps.excluded.has(c.id));

function delayT() {
  return { ...DEFAULT_THRESHOLDS, delayMinutes: ps.watch.delayYellowFromMin, criticalMinutes: ps.watch.delayRedAboveMin };
}

/** The cluster's measurement with its summary on Play's thresholds, kept while neither changes. */
function delayOf(id, t) {
  const m = measurer && measurer.get(id);
  if (!m) return null;
  const key = `${m.measuredAt}|${t.delayMinutes}|${t.criticalMinutes}|${m.error || ''}`;
  const hit = delayMemo.get(id);
  if (hit && hit.key === key && hit.src === m) return hit.v;
  const v = m.records
    ? { ...m, summary: summarise(m.records.map((r) => ({ ...r, status: classify(r.delayMinutes, t) }))) }
    : { ...m, summary: null, records: null };
  delayMemo.set(id, { key, src: m, v });
  return v;
}

function reportOf(c) {
  const d = state.data.get(c.id) || {};
  const ix = state.indices.get(c.id) || [];
  const hit = reports.get(c);
  if (hit && hit.d === d && hit.ix === ix) return hit.r;
  const r = volumeReport(c, d, ix);
  reports.set(c, { d, ix, r });
  return r;
}

/** Everything the slides read, built at most once a second (and at once after new data). */
function context(force = false) {
  const now = Date.now();
  if (!force && ctxMemo.ctx && now - ctxMemo.at < 1000) {
    ctxMemo.ctx.now = now;
    ctxMemo.ctx.elapsed = engine ? engine.elapsed(now) : 0;
    return ctxMemo.ctx;
  }
  const list = visible();
  const ids = new Set(list.map((c) => c.id));
  const mine = mergedAlerts().filter((m) => ids.has(m.clusterId));
  const merged = mine.filter((m) => !isHeld(m));
  // Held under a down cluster (alert-groups.js holdUnreachable): one dimmed line under its
  // tile and its Alerts row, in no count, never taking the screen (docs/PLAY.md).
  const held = mine.filter(isHeld);
  const heldBy = heldByCluster(held);
  // Acknowledged or not is mergedAlerts()'s answer (acks.js records, ackedItems per merged
  // item): on hosted those records are the server's shared ones, read again by pollAcks.
  const open = merged.filter((m) => isOpen(m));
  const openBy = new Map();
  for (const m of open) (openBy.get(m.clusterId) || openBy.set(m.clusterId, []).get(m.clusterId)).push(m);
  const st = new Map(list.map((c) => [c.id, clusterStatus(c, state.data.get(c.id), {
    open: openBy.get(c.id) || [], nodes: ps.nodes[c.id] || null, client: client(c.id) })]));
  const t = delayT();
  const delay = new Map();
  for (const c of list) { const v = delayOf(c.id, t); if (v) delay.set(c.id, v); }
  const staleMs = (Number(state.defaults.snapshotStaleHours) || 26) * 3600000;

  // The spotlight: who is in it, updated every few seconds (joining and leaving are per display).
  if (force || now - spotAt >= SPOT_EVERY_MS) {
    spotAt = now;
    const reasons = new Map(list.map((c) => [c.id, spotlightReasons(c, state.data.get(c.id), {
      open: openBy.get(c.id) || [], nodes: ps.nodes[c.id] || null, when: ps.watch.spotlight.when, staleMs, now,
      logPattern: c.logIndexPattern || state.defaults.logIndexPattern })]));
    spot = spotlightMembers(spot, reasons, now, ps.watch.spotlight.leaveAfterMin * 60000);
    for (const id of [...spot.keys()]) if (!ids.has(id)) spot.delete(id);
  }
  let order = [...spot.keys()].sort((a, b) => (st.get(b) ? st.get(b).rank : 0) - (st.get(a) ? st.get(a).rank : 0)
    || String(a).localeCompare(String(b)));
  // Every cluster in turn: chosen for this display (spotlightAll), or when nothing is wrong (whenEmpty).
  if (ps.display.spotlightAll || (!order.length && ps.watch.spotlight.whenEmpty === 'everyCluster')) {
    const inSpot = new Set(order);
    order = [...order, ...list.map((c) => c.id).filter((id) => !inSpot.has(id))];
  }

  const ctx = {
    now, tz: ps.tz || null, clusters: list, st, open, merged, openBy, held, heldBy,
    data: (id) => state.data.get(id) || null,
    indices: (id) => state.indices.get(id) || null,
    report: reportOf,
    nodes: (id) => ps.nodes[id] || null,
    nodeHistory: support.play === true,
    watch: ps.watch, display: ps.display,
    delay, delayT: t, delayNote: delayNote(),
    repoSize, volume,
    spot: { members: spot, order },
    acked: (m) => (m.state === 'acked' ? { by: m.ackedBy, at: m.ackedAt } : null),
    sharedAcks: acksOnServer() === true,
    openSince: (m) => Number(ps.openSince[m.key]) || m.since,
    blink: (id) => {
      const s = st.get(id);
      if (!s || !s.left.length || ps.watch.nodeBlink === 'off') return false;
      return ps.watch.nodeBlink !== 'untilAck' || !isAcked(`${id}:node-left`);
    },
    staleMs, logPattern: state.defaults.logIndexPattern,
    takeover: take && take.active,
    elapsed: engine ? engine.elapsed(now) : 0,
    afterMount: () => {},
  };
  ctxMemo = { at: now, ctx };
  return ctx;
}

function delayNote() {
  if (!measurer) return null;
  const busy = measurer.measuring().length;
  if (busy) return `measuring ${busy} cluster${busy === 1 ? '' : 's'}…`;
  const { fullMs, lateMs } = measurer.schedule();
  const every = `full check every ${Math.round(fullMs / 60000)} min, late devices every ${Math.round(lateMs / 60000)} min`;
  if (measurer.shared() === false) return `measured by this screen: ${every}`;
  const p = measurer.putProblem();
  return p ? `measured by this screen; not shared: ${p}` : `measured: ${every}`;
}

/** Whether a slide has anything to show (Alerts always has: "All clear"). */
function isEmptySlide(id) {
  const s = SLIDE.get(id);
  if (!s) return true;
  try { return s.isEmpty(context()); } catch (_) { return true; }
}

function dwellFor(id) {
  const ctx = context();
  return dwellMs(id, { dwellSec: ps.display.dwellSec, slideDwell: ps.display.slideDwell, perClusterSec: ps.watch.spotlight.perClusterSec,
    spotlightCount: ctx.spot.order.length });
}

/** The slide on screen: Alerts while a critical alert holds it, even on a display without Alerts in its rotation. */
const shownId = () => (take && take.active ? 'alerts' : engine.current);

const orderOf = () => {
  const o = ps.display.slides.filter((x) => SLIDE.has(x));
  return o.length ? o : SLIDES.map((s) => s.id);
};

/* ---------------------------------- freshness ---------------------------------- */

/** "last fetched" for a slide: the oldest of its sources, and whether any is stale. */
function freshness(slide, ctx) {
  const refreshMs = (Number(state.defaults.refreshIntervalSec) || 30) * 1000;
  let oldest = 0, stale = false, missing = false;
  for (const c of ctx.clusters) {
    if (healthState(state.data.get(c.id)) === 'unreachable') continue;
    for (const ds of slide.DATASETS || []) {
      const f = datasetFreshness(c.id, ds);
      if (!f || !f.ts) { missing = true; continue; }
      if (!oldest || f.ts < oldest) oldest = f.ts;
      if (f.staleAfterMs ? isStale(f.ts, ctx.now, f.staleAfterMs) : staleness(f.ts, ctx.now, { refreshMs }) === 'stale') stale = true;
    }
    if (slide.id === 'delay') {
      // The full check is the oldest part of a measurement (the late list is re-checked between).
      const d = ctx.delay.get(c.id);
      const at = d && (d.fullAt || d.measuredAt);
      if (!at) { missing = true; continue; }
      if (!oldest || at < oldest) oldest = at;
      const every = measurer ? measurer.schedule().fullMs : MEASURE_EVERY_MS;
      if (staleness(at, ctx.now, { refreshMs: every }) === 'stale') stale = true;
    }
  }
  return { oldest, stale, missing };
}

/* ----------------------------------- drawing ----------------------------------- */

function skeleton() {
  const btn = (label, title, fn, cls = '') => h(`button.pl-cbtn${cls}`, { type: 'button', title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
  const zoomLabel = h('span.pl-zl', '100 %');
  const e = {
    title: h('h1.pl-title'),
    chips: h('span.pl-hchips'),
    dots: h('div.pl-dots'),
    fetched: h('span.pl-fetched'),
    clock: h('span.pl-clock'),
    bar: h('i'),
    stage: h('div.pl-stage'),
    zoomLabel,
  };
  e.head = h('header.pl-head',
    h('div.pl-brand', h('img', { src: 'icons/icon48.png', alt: '' }), h('b', 'ElasticPro'), e.title, e.chips),
    e.dots,
    h('div.pl-right', e.fetched, e.clock));
  e.progress = h('div.pl-progress', e.bar);
  e.body = h('main.pl-body', e.stage);
  e.pauseBtn = btn('⏸', 'Pause (Space)', () => { togglePause(); });
  const fs = fullscreen();
  const fsBtn = fs.supported() ? btn('⛶', 'Full screen', () => { fs.toggle(); }, '.pl-fs') : null;
  e.fsBtn = fsBtn;
  if (fsBtn) fsBtn.setAttribute('aria-pressed', 'false');
  e.ctl = h('div.pl-ctl', { role: 'toolbar', 'aria-label': 'Play controls' },
    btn('◀', 'Previous slide (←)', () => step(-1)),
    e.pauseBtn,
    btn('▶', 'Next slide (→)', () => step(1)),
    h('span.pl-csep'),
    btn('−', 'Smaller (−)', () => zoomBy(-1)), zoomLabel, btn('+', 'Larger (+)', () => zoomBy(1)),
    fsBtn ? h('span.pl-csep') : null, fsBtn,
    display ? null : h('span.pl-csep'),
    display ? null : btn('✕ Exit', 'Leave Play (Esc)', () => exit(), '.pl-exit'));
  // A display link loads without a click, so it cannot start full screen itself: say how, once.
  e.hint = display && fsBtn && !fs.active() && !hintDismissed()
    ? h('div.pl-fshint', { role: 'status' }, 'Press F or click ⛶ for full screen — or run the browser in kiosk mode',
        h('button.pl-fshint-x', { type: 'button', 'aria-label': 'Dismiss', onclick: () => hideHint(true) }, '✕'))
    : null;
  e.root = h('div.pl-root.tv', e.head, e.progress, e.body, e.ctl, e.hint);
  return e;
}

function headerChips(ctx) {
  const out = [];
  if (engine && engine.paused) out.push(h('span.pl-hchip', 'paused'));
  const missing = [];
  if (support.play === false) missing.push('no node-left tracking', 'no Config › Play settings');
  if (support.acks === false) missing.push('acknowledgements are this browser’s');
  if (measurer && measurer.shared() === false) missing.push('measurements not shared');
  if (missing.length) {
    out.push(h('span.pl-hchip.amber', { title: `This server is older than 0.3.47: ${missing.join('; ')}.` },
      `older server · ${missing[0]}${missing.length > 1 ? ` +${missing.length - 1}` : ''}`));
  }
  if (!ctx.clusters.length && clusters().length) out.push(h('span.pl-hchip.amber', 'every cluster is excluded'));
  return out;
}

function paintHead(ctx) {
  if (!els || !engine) return;
  const cur = SLIDE.get(shownId()) || SLIDES[0];
  if (els.title.textContent !== cur.title) els.title.textContent = cur.title;
  mount(els.chips, ...headerChips(ctx));
  els.root.classList.toggle('takeover', !!(take && take.active));
  // dots: one per slide in the order; a skipped one is dim
  const order = engine.order;
  if (els.dots.childElementCount !== order.length) mount(els.dots, ...order.map((id) => h('i', { title: (SLIDE.get(id) || {}).title || id })));
  [...els.dots.children].forEach((d, i) => {
    d.classList.toggle('on', i === engine.index);
    d.classList.toggle('empty', order[i] !== 'alerts' && isEmptySlide(order[i]));
  });
  paintClock(ctx);
}

function paintClock(ctx) {
  if (!els || !engine) return;
  const cur = SLIDE.get(shownId()) || SLIDES[0];
  const f = freshness(cur, ctx);
  const txt = f.oldest ? `last fetched ${clockText(f.oldest, ctx.tz)}` : 'no data';
  if (els.fetched.textContent !== txt) els.fetched.textContent = txt;
  els.fetched.classList.toggle('stale', !!(f.oldest && f.stale));
  els.fetched.classList.toggle('none', !f.oldest);
  els.fetched.title = f.missing && f.oldest ? 'Some clusters have no answer for this slide yet' : '';
  const z = zoneName(ctx.tz || null);
  const clock = `${clockText(serverNow(), ctx.tz, { seconds: false })}${z ? ` ${z}` : ''}`;
  if (els.clock.textContent !== clock) els.clock.textContent = clock;
  const dwell = dwellFor(shownId());
  const p = take && take.active ? 1 : Math.min(1, engine.elapsed(ctx.now) / Math.max(1, dwell));
  els.bar.style.transform = `scaleX(${p.toFixed(3)})`;
  const b = burnShift(ctx.now);
  els.stage.style.transform = b.x || b.y ? `translate(${b.x}px, ${b.y}px)` : '';
  els.root.classList.toggle('ctl', Date.now() < ctlUntil);
}

export function draw() {
  if (!host || !host.isConnected || !els || !engine) return;
  const ctx = context(true);
  const after = [];
  ctx.afterMount = (fn) => after.push(fn);
  const slide = SLIDE.get(shownId()) || SLIDES[0];
  let view;
  try { view = slide.render(ctx); } catch (e) {
    console.error(e);
    view = h('div.pl-slide', h('div.pl-clear', h('div.pl-clear-big', 'This slide could not be drawn'), h('div.pl-clear-sub', String(e && e.message || e))));
  }
  mount(els.stage, view);
  for (const fn of after) { try { fn(); } catch (_) { /* a list that could not be measured still shows */ } }
  lastSlide = shownId();
  lastPhase = slide.phaseKey ? slide.phaseKey(ctx) : '';
  paintHead(ctx);
}

/* ------------------------------------ engine ------------------------------------ */

function step(dir) {
  if (!engine) return;
  if (take && take.active) take = { ...take, active: null };    // a person moving on releases the hold
  if (dir < 0) engine.prev(Date.now()); else engine.next(Date.now());
  draw();
}
function togglePause() {
  if (!engine) return;
  const p = engine.togglePause(Date.now());
  if (els) { els.pauseBtn.textContent = p ? '▶︎' : '⏸'; els.pauseBtn.title = p ? 'Resume (Space)' : 'Pause (Space)'; }
  draw();
}
function exit() {
  if (display) return;
  if (onExit) onExit();
}

/** The one-second beat: takeover, turning the slide, the spotlight's phase, the clock. */
function tick() {
  if (!host || !host.isConnected) { onLeave(); return; }
  const now = Date.now();
  const ctx = context();
  if (now - lastObserved > 5000) {
    lastObserved = now;
    // What this browser has seen of each alert — the shell records it only when it announces.
    try { if (alertHistory.observe(toObservations(mergedAlerts()), now)) invalidateAlerts(); } catch (_) { /* a convenience */ }
  }
  const crit = ctx.open.filter((m) => m.level === 'critical');
  const before = take && take.active ? take.active.key : null;
  // The first WARM_MS only learn what is already wrong: the data and the shared measurements are
  // still arriving, and a TV switched on mid-incident must not be taken over by all of it.
  // Held alerts never take the screen, and one that becomes current when its cluster answers
  // again was there before the outage: not new (engine.js takeover `held`).
  take = now - openedAt < warmMs ? takeover(null, { open: crit, held: ctx.held, now })
    : takeover(take, { open: crit, held: ctx.held, now, enabled: ps.display.criticalTakesScreen });
  const holding = take.active;
  if (holding && now - lastAckPoll > 10000 && support.acks !== false) { lastAckPoll = now; pollAcks(); }
  let moved = false;
  if (holding) {
    if (before !== holding.key) { engine.show('alerts', now); moved = true; }
  } else if (before) {
    engine.next(now); moved = true;
  } else {
    moved = engine.tick(now);
  }
  const slide = SLIDE.get(shownId());
  const phase = slide && slide.phaseKey ? slide.phaseKey(ctx) : '';
  if (moved || shownId() !== lastSlide || phase !== lastPhase) draw();
  else paintClock(ctx);
}

/* ---------------------------------- the core ---------------------------------- */

async function loadPlayState() {
  // The open alerts go with it once the warm-up is over (before that the data is still arriving,
  // and an empty list would wipe the times the server kept across a reload).
  const warm = Date.now() - openedAt >= warmMs;
  // Held keys go too: only so the server keeps "open for" across an outage — an alert raised
  // before its cluster went down and still true when it answers is not one minute old.
  const c = warm && support.play !== false ? context() : null;
  const res = await playState(c ? [...c.open, ...c.held].map((m) => m.key) : undefined);
  if (res && res.ok) {
    support.play = true;
    ps = readPlayState(res);
    if (ps.now) skew = ps.now - Date.now();
    const z = ps.display.zoom || ps.display.lastZoom;
    if (display && (zoomFromServer || ps.display.zoomFixed) && z && z !== zoom) setZoom(z, { save: false });
  } else if (res && res.unsupported) {
    // An older core: the defaults, nothing excluded, no node history — said in the header.
    support.play = false;
    ps = defaultPlayState();
  }
  if (engine) engine.setOrder(orderOf(), Date.now());
}

/** The acknowledgements again (acks.js: the server's on hosted, this browser's on desktop). */
async function pollAcks() {
  // Desktop keeps them in this browser, in the cache acks.js already holds: nothing to fetch.
  if (credentialsKeptOnServer()) await loadAcks();
  // Hosted but kept in this browser: a core too old to share them.
  support.acks = credentialsKeptOnServer() ? acksOnServer() === true : null;
  invalidateAlerts();
}

/**
 * Tell the core what the slides read: Play-watched, so it keeps each coming at the request
 * policy's Play pace (Config › Requests › While Play runs) under every mode that fetches on
 * ask, and fetches at once only what it never has.
 */
async function askData() {
  if (isSnapshotMode()) return;
  const ids = visible().map((c) => c.id);
  if (!ids.length) return;
  await watchForPlay(ids, DATASETS).catch(() => false);
  // The portable build with its own refresh switched off: a wall display still moves.
  if (!fleetMode() && !state.autoRefresh) refreshAll().catch(() => {});
}

async function minute() {
  await loadPlayState().catch(() => {});
  await pollAcks().catch(() => {});
  await askData().catch(() => {});
  draw();
}

async function loadVolume() {
  if (support.volume === false || isSnapshotMode()) return;
  const list = visible();
  await runBounded(list, async (c) => {
    const res = await volumeDaily(c.id, { days: 30, avgDays: 7 });
    if (res && res.unsupported) { support.volume = false; volume.set(c.id, { at: Date.now(), reply: null, unsupported: true }); return; }
    volume.set(c.id, res && res.ok ? { at: Date.now(), reply: res } : { at: Date.now(), reply: null, error: (res && res.message) || 'no answer' });
  }, { limit: 2 });
  draw();
}

async function loadRepoSizes() {
  if (isSnapshotMode()) return;
  const ids = visible().map((c) => c.id);
  if (!ids.length) return;
  const res = await shareGet('repoSize', ids);
  if (!res.ok) return;
  for (const [id, r] of res.byCluster) {
    const d = r.data || {};
    const b = typeof d.bytes === 'number' ? d.bytes : typeof d.total === 'number' ? d.total : null;
    repoSize.set(id, { measuredAt: r.measuredAt, bytes: b });
  }
  draw();
}

/* ---------------------------------- the page ---------------------------------- */

function onKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  const k = e.key;
  if (k === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (k === ' ' || k === 'Spacebar') { e.preventDefault(); togglePause(); }
  else if ((k === 'f' || k === 'F') && !e.shiftKey && fullscreen().supported()) { e.preventDefault(); fullscreen().toggle(); }
  else if (k === '+' || k === '=' || k === 'Add') { e.preventDefault(); zoomBy(1); }
  else if (k === '-' || k === '_' || k === 'Subtract') { e.preventDefault(); zoomBy(-1); }
  else return;
  showControls();
}
let offFs = null;
function paintFs(on) {
  if (!els || !els.fsBtn) return;
  const t = on ? 'Leave full screen' : 'Full screen';
  els.fsBtn.title = t; els.fsBtn.setAttribute('aria-label', t); els.fsBtn.setAttribute('aria-pressed', String(on));
  if (on) hideHint(false);
}
function hideHint(remember) {
  if (remember) dismissHint();
  if (els && els.hint) { els.hint.remove(); els.hint = null; }
}
function showControls() {
  ctlUntil = Date.now() + CONTROLS_MS;
  if (els) els.root.classList.add('ctl');
}

export function render(el) {
  onLeave();
  host = el;
  document.documentElement.classList.add('play');
  els = skeleton();
  mount(el, els.root);
  zoomFromServer = true;
  setZoom(readZoom(), { save: false });
  engine = createEngine({ order: orderOf(), now: Date.now(), isEmpty: isEmptySlide, dwellFor });
  take = null;
  openedAt = Date.now();
  measurer = createMeasurer({
    clusters: visible,
    client: (id) => client(id),
    reachable: (id) => { const s = healthState(state.data.get(id)); return s !== 'unreachable' && s !== 'loading'; },
    now: serverNow,
    onChange: () => { if (host && host.isConnected) draw(); },
    // The late list is decided on the wall's own yellow line (Config › Play).
    thresholds: () => delayT(),
  });
  listen(document, 'keydown', onKeyDown);
  offFs = fullscreen().subscribe(paintFs);
  paintFs(fullscreen().active());
  if (els.hint) later(() => hideHint(false), 10000);
  listen(document, 'mousemove', showControls, { passive: true });
  draw();
  every(tick, 1000);
  if (!isSnapshotMode()) {
    minute();
    every(minute, Math.max(15, Math.min(60, ps.watch.nodeCheckSec)) * 1000);
    later(loadVolume, 1500);
    every(loadVolume, VOLUME_EVERY_MS);
    later(loadRepoSizes, 2500);
    every(loadRepoSizes, REPO_EVERY_MS);
    later(() => measurer && measurer.cycle(), 4000);
    every(() => measurer && measurer.cycle(), 60000);
  }
}

export function onData() {
  if (!host || !host.isConnected) return;
  draw();
}

/** Escape leaves Play for a person (the shell hands Escape to the page first). */
export function onKey(e) {
  if (e.key !== 'Escape' || display) return false;
  exit();
  return true;
}

export function onLeave() {
  if (offFs) { offFs(); offFs = null; }
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers.clear();
  for (const [target, ev, fn, opts] of listeners.splice(0)) target.removeEventListener(ev, fn, opts);
  if (measurer) measurer.stop();
  measurer = null;
  els = null;
  engine = null;
  host = null;
  ctxMemo = { at: 0, ctx: null };
  delayMemo.clear();
  document.documentElement.classList.remove('play');
}

/** For the checks: the core half of the once-a-minute poll (PLAY_STATE, acknowledgements) now. */
export async function _poll() {
  await loadPlayState().catch(() => {});
  await pollAcks().catch(() => {});
  draw();
}

/** For the checks: what the page holds now. */
export function _debug() {
  return { engine, take, spot, zoom, ps, support, timers: timers.size, listeners: listeners.length, display };
}
