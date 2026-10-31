/**
 * Play's messages to the core (docs/PLAY.md): PLAY_STATE, the shared measurement cache
 * (PLAY_SHARE_GET / PLAY_SHARE_PUT), shared acknowledgements (ACK_LIST) and the display-link
 * exchange (PLAY_EXCHANGE).
 *
 * An older core does not know these. That is reported as `unsupported` — the same test the
 * volume record uses (core/volume-daily.js isUnsupported) — and Play carries on with what
 * exists: no node-left, local acknowledgements, its own measurements. Never a crash.
 *
 * The replies are read leniently where the contract leaves a shape open (a list or a map
 * keyed by cluster), and anything not there stays unknown.
 */

import { bridge } from '../core/transport.js';
import { isUnsupported } from '../core/volume-daily.js';

async function send(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { res = { ok: false, kind: 'worker_error', message: String(e && e.message || e) }; }
  if (isUnsupported(res, msg.type)) return { ok: false, unsupported: true, kind: 'unsupported', message: (res && res.message) || '' };
  return res || { ok: false, kind: 'worker_error', message: 'no answer' };
}

/* --------------------------------- PLAY_STATE --------------------------------- */

/** The watch rules' defaults (docs/PLAY.md "Play settings"), used until the core says otherwise. */
export const WATCH_DEFAULTS = Object.freeze({
  delayYellowFromMin: 30, delayRedAboveMin: 60, nodeExpected: 'seen24h', nodeBlink: 'untilBack', nodeCheckSec: 60,
  spotlight: Object.freeze({ when: Object.freeze(['red', 'nodeLeft', 'slmFailed', 'storage', 'unreachable', 'criticalAlert']),
    perClusterSec: 13, leaveAfterMin: 10, whenEmpty: 'skip' }),
});
/** A display's own settings, defaulted. */
export const DISPLAY_DEFAULTS = Object.freeze({
  slides: Object.freeze(['fleet', 'alerts', 'spotlight', 'delay', 'backups', 'volume']),
  dwellSec: 20, criticalTakesScreen: true, spotlightAll: false, theme: 'dark', sound: false, zoom: null,
});
/** The six slide ids, as Config › Play names them. */
export const SLIDE_IDS = Object.freeze(['fleet', 'alerts', 'spotlight', 'delay', 'backups', 'volume']);

/**
 * A display's slides: `[{id, show, dwellSec}]` (or plain ids), in its order. Hidden ones are
 * left out; `dwellSec` is kept per slide when it is set.
 */
export function readSlides(list, fallbackDwell) {
  const out = [];
  const dwell = {};
  for (const x of Array.isArray(list) ? list : []) {
    const o = typeof x === 'string' ? { id: x } : x && typeof x === 'object' ? x : null;
    if (!o) continue;
    const id = o.id === 'logdelay' ? 'delay' : String(o.id || '');
    if (!SLIDE_IDS.includes(id) || out.includes(id) || o.show === false) continue;
    out.push(id);
    dwell[id] = num(o.dwellSec, fallbackDwell);
  }
  return { slides: out, dwell };
}

const num = (v, d) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : d);

/**
 * A PLAY_STATE reply as Play reads it: `{watch, display, excluded:Set, nodes, openSince, now}`.
 * `settings` may carry the watch rules under `watch` or flat, and this display's under
 * `display` (or `defaultDisplay` for a person).
 */
export function readPlayState(res) {
  const s = (res && res.settings) || {};
  const w = { ...(s.watch || {}) };
  for (const k of ['delayYellowFromMin', 'delayRedAboveMin', 'nodeExpected', 'nodeBlink', 'nodeCheckSec', 'spotlight']) {
    if (w[k] === undefined && s[k] !== undefined) w[k] = s[k];
  }
  const sp = w.spotlight || {};
  const watch = {
    delayYellowFromMin: num(w.delayYellowFromMin, WATCH_DEFAULTS.delayYellowFromMin),
    delayRedAboveMin: num(w.delayRedAboveMin, WATCH_DEFAULTS.delayRedAboveMin),
    nodeExpected: w.nodeExpected || WATCH_DEFAULTS.nodeExpected,
    nodeBlink: ['untilBack', 'untilAck', 'off'].includes(w.nodeBlink) ? w.nodeBlink : WATCH_DEFAULTS.nodeBlink,
    nodeCheckSec: num(w.nodeCheckSec, WATCH_DEFAULTS.nodeCheckSec),
    spotlight: {
      when: Array.isArray(sp.when) ? sp.when.map(String) : [...WATCH_DEFAULTS.spotlight.when],
      perClusterSec: num(sp.perClusterSec, WATCH_DEFAULTS.spotlight.perClusterSec),
      leaveAfterMin: num(sp.leaveAfterMin, WATCH_DEFAULTS.spotlight.leaveAfterMin),
      whenEmpty: ['skip', 'allHealthy', 'everyCluster'].includes(sp.whenEmpty) ? sp.whenEmpty : WATCH_DEFAULTS.spotlight.whenEmpty,
    },
  };
  const d = s.display || s.thisDisplay || s.defaultDisplay || {};
  const dwellSec = num(d.dwellSec, DISPLAY_DEFAULTS.dwellSec);
  const sl = Array.isArray(d.slides) ? readSlides(d.slides, dwellSec) : null;
  const zn = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
  const display = {
    slides: sl && sl.slides.length ? sl.slides : [...DISPLAY_DEFAULTS.slides],
    slideDwell: sl ? sl.dwell : {},
    dwellSec,
    criticalTakesScreen: d.criticalTakesScreen !== false,
    spotlightAll: !!d.spotlightAll,
    theme: d.theme || DISPLAY_DEFAULTS.theme,
    sound: !!d.sound,
    // A zoom Config fixed for this display; null means "the one it was last left at".
    zoom: zn(d.zoom),
    lastZoom: zn(d.lastZoom),
    zoomFixed: zn(d.zoom) !== null,
  };
  const excluded = new Set((res && Array.isArray(res.excluded) ? res.excluded : [])
    .map((x) => (x && typeof x === 'object' ? x.clusterId : x)).filter(Boolean).map(String));
  return {
    watch, display, excluded,
    nodes: (res && res.nodes && typeof res.nodes === 'object') ? res.nodes : {},
    openSince: (res && res.openSince && typeof res.openSince === 'object') ? res.openSince : {},
    now: res && typeof res.now === 'number' ? res.now : (res && res.now ? Date.parse(res.now) || null : null),
    tz: (res && (res.tz || res.timeZone)) || s.tz || null,
  };
}

/** The defaults, as if a core had answered with nothing: what Play runs on against an older core. */
export const defaultPlayState = () => readPlayState({});

export const playState = () => send({ type: 'PLAY_STATE' });

/* ------------------------------ shared measurements ------------------------------ */

/**
 * PLAY_SHARE_GET's newest record per cluster, as a Map clusterId → {measuredAt, data}.
 * Accepts `records`/`items` as a list of `{clusterId, measuredAt, data}`, or a map keyed by
 * cluster under `records`, `byCluster` or `clusters`.
 */
export function readShare(res) {
  const out = new Map();
  if (!res || !res.ok) return out;
  const src = res.records ?? res.items ?? res.byCluster ?? res.clusters ?? res.data ?? null;
  const put = (id, r) => {
    if (!id || !r || typeof r !== 'object') return;
    const at = typeof r.measuredAt === 'number' ? r.measuredAt : Date.parse(r.measuredAt);
    if (!isFinite(at)) return;
    const cur = out.get(String(id));
    if (!cur || cur.measuredAt < at) out.set(String(id), { measuredAt: at, data: r.data ?? null, by: r.by || null });
  };
  if (Array.isArray(src)) for (const r of src) put(r && r.clusterId, r);
  else if (src && typeof src === 'object') for (const [id, r] of Object.entries(src)) put((r && r.clusterId) || id, r);
  return out;
}

export async function shareGet(kind, clusterIds) {
  const res = await send({ type: 'PLAY_SHARE_GET', kind, clusterIds: clusterIds && clusterIds.length ? clusterIds : undefined });
  return res.ok ? { ok: true, byCluster: readShare(res) } : res;
}

export const sharePut = (kind, clusterId, measuredAt, data) =>
  send({ type: 'PLAY_SHARE_PUT', kind, clusterId, measuredAt, data });

/* ----------------------------- shared acknowledgements ----------------------------- */

/** ACK_LIST as a Map key → {by, at, note}: `acks` as a map or a list of `{key, by, at, note}`. */
export function readAcks(res) {
  const out = new Map();
  if (!res || !res.ok) return out;
  const src = res.acks ?? res.items ?? res.records ?? null;
  if (Array.isArray(src)) { for (const a of src) if (a && a.key) out.set(String(a.key), { by: a.by || '', at: a.at || 0, note: a.note || '' }); }
  else if (src && typeof src === 'object') {
    for (const [k, a] of Object.entries(src)) out.set(k, { by: (a && a.by) || '', at: (a && a.at) || 0, note: (a && a.note) || '' });
  }
  return out;
}

export async function ackList() {
  const res = await send({ type: 'ACK_LIST' });
  return res.ok ? { ok: true, acks: readAcks(res) } : res;
}

/* --------------------------------- display links --------------------------------- */

/** The display secret in `#/play?display=<secret>`, or ''. */
export function displaySecretOf(hash) {
  const m = /^#\/play\?(.*)$/.exec(String(hash || ''));
  if (!m) return '';
  try { return new URLSearchParams(m[1]).get('display') || ''; } catch (_) { return ''; }
}

/** The page id a hash names, without any `?query` after it. */
export const pageOfHash = (hash) => String(hash || '').replace(/^#\/?/, '').split('?')[0];

export const playExchange = (secret) => send({ type: 'PLAY_EXCHANGE', secret });

/** A display link remembers its zoom on the server (play_only may send this one write). */
export const zoomSet = (zoom) => send({ type: 'PLAY_ZOOM_SET', zoom });
