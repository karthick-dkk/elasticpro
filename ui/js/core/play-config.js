/**
 * Config › Play: the wrappers and the pure helpers (docs/PLAY.md "Display links",
 * "Play settings").
 *
 * A module of its own: es.js is not touched. Every call goes through `bridge` and never
 * throws; an older core that does not know the message answers `{ok:false, unknown:true}`
 * and the page says "this server does not have Play yet (needs 0.3.47)".
 */

import { bridge } from './transport.js';
import { isUnknownType } from './volume-config.js';

export const NO_PLAY = 'This server does not have Play yet (needs 0.3.47)';

async function send(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { return { ok: false, message: e.message || String(e) }; }
  if (isUnknownType(res)) return { ok: false, unknown: true, message: NO_PLAY };
  return res || { ok: false, message: 'the core did not answer' };
}

/**
 * `{watch, exclude:[{clusterId, reason, by, at, managed?}], defaultDisplay, managed:[UI_PLAY_*],
 * managedFields:{"watch.x": UI_PLAY_*}, linksEnabled, options}`; an admin also gets
 * `displays`, `links` and `groups`.
 */
export const playConfigGet = () => send({ type: 'PLAY_CONFIG_GET' });
/**
 * One change, wrapped as the core takes it (`{settings: …}`): `{watch}` (managed fields already
 * left out), `{exclude: {add:{clusterId, reason}} | {remove: clusterId}}`, `{defaultDisplay}` or
 * `{displays: {<linkId>: …}}`. Answers as PLAY_CONFIG_GET.
 */
export const playConfigSet = (part) => send({ type: 'PLAY_CONFIG_SET', settings: part });
/**
 * `{enabled, links:[{id, name, clusters, allowFrom, expires: "permanent"|{at}, expiresAt, expired,
 * createdAt, createdBy, lastSeen:{at, from}|null, sessions, settings}]}`: never a secret or a URL.
 */
export const playLinkList = () => send({ type: 'PLAY_LINK_LIST' });
/** `{link:{id, name, url, …}, secret}`: the secret is shown once. */
export const playLinkCreate = (payload) => send({ type: 'PLAY_LINK_CREATE', ...payload });
export const playLinkRevoke = (id) => send({ type: 'PLAY_LINK_REVOKE', id });
export const playLinkSet = (id, settings) => send({ type: 'PLAY_LINK_SET', id, settings });

/* -------------------------------- vocabulary --------------------------------- */

export const SLIDES = [
  { id: 'fleet', label: 'Fleet wall' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'spotlight', label: 'Cluster spotlight' },
  { id: 'delay', label: 'Log delay' },
  { id: 'backups', label: 'Backups' },
  { id: 'volume', label: 'Volume and capacity' },
];
/**
 * What the fleet wall can be ordered by (docs/PLAY.md "Fleet wall order"), the words the
 * Config › Play selects use. The core's FLEET_KEYS is the same list.
 */
export const FLEET_KEYS = [
  ['critical', 'Critical problems'], ['logDelay', 'Log delay'], ['volume', 'Volume used yesterday'],
  ['disk', 'Disk used'], ['alerts', 'Open alerts'], ['name', 'Name'],
];
export const FLEET_ORDER_DEFAULT = ['critical', 'logDelay', 'volume'];

/** A display's fleetOrder: known, distinct keys, at most three; the default when nothing usable is there. */
export function readFleetOrder(raw) {
  const out = [];
  for (const k of Array.isArray(raw) ? raw : []) {
    if (FLEET_KEYS.some(([id]) => id === k) && !out.includes(k) && out.length < 3) out.push(k);
  }
  return out.length ? out : [...FLEET_ORDER_DEFAULT];
}

export const DWELL = [20, 10, 30, 60];
export const ZOOMS = [[null, '100 % · the TV keeps what was last set on it'], [0.8, '80 %'], [0.9, '90 %'], [1.1, '110 %'], [1.25, '125 %'], [1.5, '150 %']];
export const EXPIRES = [['permanent', 'Permanent (until revoked)'], ['90', 'After 90 days'], ['30', 'After 30 days'], ['365', 'After 1 year']];

export const SPOTLIGHT_WHEN = [
  { id: 'red', label: 'Red health', on: true },
  { id: 'nodeLeft', label: 'A node left the cluster', on: true },
  { id: 'slmFailed', label: 'SLM failed or no good snapshot in 26 h', on: true },
  { id: 'storage', label: 'Storage past the high watermark (90 %)', on: true },
  { id: 'unreachable', label: 'Cluster not answering', on: true },
  { id: 'criticalAlert', label: 'Any open critical alert', on: true },
  { id: 'ilmError', label: 'ILM step in error on a log index', on: false },
  { id: 'yellow', label: 'Yellow health', on: false },
];

export const WATCH_DEFAULTS = {
  delayYellowFromMin: 30, delayRedAboveMin: 60, nodeExpected: 'seen24h', nodeBlink: 'untilBack', nodeCheckSec: 60,
  spotlight: { when: SPOTLIGHT_WHEN.filter((w) => w.on).map((w) => w.id), perClusterSec: 13, leaveAfterMin: 10, whenEmpty: 'skip' },
};

/**
 * The set of watch-field paths config.txt manages ("delayRedAboveMin", "spotlight.when", …),
 * from PLAY_CONFIG_GET's `managedFields` — `{"watch.delayRedAboveMin": "UI_PLAY_DELAY_RED_MIN"}`,
 * the core's own map of field to key, so the page never keeps a second copy of it.
 */
export function lockedFields(reply) {
  const f = reply && reply.managedFields && typeof reply.managedFields === 'object' ? reply.managedFields : {};
  return new Set(Object.keys(f).filter((p) => p.startsWith('watch.')).map((p) => p.slice('watch.'.length)));
}

/* ------------------------------ display links ------------------------------- */

/** A CIDR or a bare address: "10.1.0.0/16", "10.1.2.3", "fd00::/8". */
export function isCidr(s) {
  const m = /^(.+?)(?:\/(\d{1,3}))?$/.exec(String(s).trim());
  if (!m) return false;
  const [, addr, bits] = m;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) && (bits === undefined || Number(bits) <= 32);
  if (/^[0-9a-fA-F:]+$/.test(addr) && addr.includes(':') && addr.split(':').length <= 8) return bits === undefined || Number(bits) <= 128;
  return false;
}

/** `{list, bad}` from comma / space / newline separated text. */
export function parseCidrs(textIn) {
  const parts = String(textIn || '').split(/[\s,;]+/).filter(Boolean);
  return { list: parts.filter(isCidr), bad: parts.filter((p) => !isCidr(p)) };
}

/**
 * The PLAY_LINK_CREATE fields for the dialog's form, or `{problem}`.
 * `scope`: 'all' | 'group' | 'chosen'.
 */
export function linkPayload({ name, scope = 'all', group = '', chosen = [], allowFrom = '', expires = 'permanent' }) {
  const n = String(name || '').trim();
  if (!n) return { problem: 'Give the display a name' };
  let clusters = 'all';
  if (scope === 'group') {
    if (!String(group).trim()) return { problem: 'Name the Zabbix host group' };
    clusters = { group: String(group).trim() };
  } else if (scope === 'chosen') {
    if (!chosen.length) return { problem: 'Choose at least one cluster' };
    clusters = [...chosen];
  }
  const cidr = parseCidrs(allowFrom);
  if (cidr.bad.length) return { problem: `Not an address or network: ${cidr.bad.join(', ')}` };
  const out = { name: n, clusters, expires: expires === 'permanent' ? 'permanent' : Number(expires) };
  if (cidr.list.length) out.allowFrom = cidr.list;
  return { payload: out };
}

/** The clusters column, in words. */
export function scopeText(clusters, names = (x) => x) {
  if (!clusters || clusters === 'all') return 'All';
  if (Array.isArray(clusters)) return clusters.length === 1 ? names(clusters[0]) : `${clusters.length} chosen`;
  if (clusters.group) return `Host group ${clusters.group}`;
  return 'All';
}

/** Slides shown, for the table: "5 of 6". */
export function slidesText(settings) {
  const s = displaySettings(settings).slides;
  return `${s.filter((x) => x.show).length} of ${s.length}`;
}

/* ------------------------------ one display ---------------------------------- */

/** A display's settings with every default filled in; slides in saved order, any missing one appended. */
export function displaySettings(raw) {
  const r = raw || {};
  const have = Array.isArray(r.slides) ? r.slides : [];
  const slides = [];
  have.forEach((x) => {
    const id = typeof x === 'string' ? x : x && x.id;
    if (!SLIDES.some((s) => s.id === id) || slides.some((s) => s.id === id)) return;
    slides.push({ id, show: typeof x === 'string' || x.show !== false, dwellSec: Number(x && x.dwellSec) || Number(r.dwellSec) || 20 });
  });
  SLIDES.forEach((s) => { if (!slides.some((x) => x.id === s.id)) slides.push({ id: s.id, show: true, dwellSec: Number(r.dwellSec) || 20 }); });
  return {
    slides,
    criticalTakesScreen: r.criticalTakesScreen !== false,
    spotlightAll: r.spotlightAll === true,
    theme: r.theme === 'light' ? 'light' : 'dark',
    sound: r.sound === 'chime' ? 'chime' : 'off',
    zoom: ZOOMS.some(([z]) => z === r.zoom) ? r.zoom : null,
    fleetOrder: readFleetOrder(r.fleetOrder),
  };
}

/**
 * PLAY_LINK_CREATE for a link made again with a new secret (PLAY_LINK_LIST never hands one
 * back): the same name, clusters, addresses, display settings, and the expiry it has left —
 * permanent stays permanent, a dated one keeps its date to the day (at least one day).
 */
export function replacePayload(link, now = Date.now()) {
  const l = link || {};
  const at = l.expiresAt || (l.expires && typeof l.expires === 'object' ? l.expires.at : null);
  const out = {
    name: l.name, clusters: l.clusters || 'all',
    expires: at ? Math.min(3650, Math.max(1, Math.ceil((Number(at) - now) / 86400000))) : 'permanent',
    settings: settingsPayload(l.settings),
  };
  if (Array.isArray(l.allowFrom) && l.allowFrom.length) out.allowFrom = [...l.allowFrom];
  return out;
}

/** Move slide `i` by `dir` (-1 up, +1 down); a copy, unchanged at the ends. */
export function moveSlide(slides, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= slides.length) return slides.slice();
  const out = slides.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** What PLAY_LINK_SET carries: the slides in order and every other choice. */
export function settingsPayload(s) {
  const d = displaySettings(s);
  return { slides: d.slides.map((x) => ({ id: x.id, show: x.show, dwellSec: x.dwellSec })), criticalTakesScreen: d.criticalTakesScreen,
    spotlightAll: d.spotlightAll, theme: d.theme, sound: d.sound, zoom: d.zoom, fleetOrder: d.fleetOrder };
}

/* ------------------------------- watch rules --------------------------------- */

/** The reply's watch block with defaults under it. */
export function watchRules(raw) {
  const w = raw || {};
  const sp = w.spotlight || {};
  const d = WATCH_DEFAULTS;
  const pick = (v, def) => (v === undefined || v === null || v === '' ? def : v);
  return {
    delayYellowFromMin: Number(pick(w.delayYellowFromMin, d.delayYellowFromMin)),
    delayRedAboveMin: Number(pick(w.delayRedAboveMin, d.delayRedAboveMin)),
    nodeExpected: pick(w.nodeExpected, d.nodeExpected),
    nodeBlink: pick(w.nodeBlink, d.nodeBlink),
    nodeCheckSec: Number(pick(w.nodeCheckSec, d.nodeCheckSec)),
    spotlight: {
      when: Array.isArray(sp.when) ? sp.when.slice() : d.spotlight.when.slice(),
      perClusterSec: Number(pick(sp.perClusterSec, d.spotlight.perClusterSec)),
      leaveAfterMin: Number(pick(sp.leaveAfterMin, d.spotlight.leaveAfterMin)),
      whenEmpty: pick(sp.whenEmpty, d.spotlight.whenEmpty),
    },
  };
}

/** Problems with the watch form, as sentences. */
export function watchProblems(w) {
  const out = [];
  if (!(w.delayYellowFromMin >= 1)) out.push('Yellow delay starts at 1 minute or more.');
  else if (!(w.delayRedAboveMin > w.delayYellowFromMin)) out.push('Red delay must be above the yellow one.');
  if (!(w.nodeCheckSec >= 10)) out.push('Check nodes at least every 10 seconds.');
  if (!(w.spotlight.perClusterSec >= 3)) out.push('A cluster shows for at least 3 seconds.');
  return out;
}

/**
 * The `watch` the save sends: the form's values with every locked field left out, so a
 * value config.txt manages is never written back. `locked` is lockedFields().
 */
export function watchPayload(w, locked = new Set()) {
  const out = {};
  ['delayYellowFromMin', 'delayRedAboveMin', 'nodeExpected', 'nodeBlink', 'nodeCheckSec'].forEach((k) => { if (!locked.has(k)) out[k] = w[k]; });
  const sp = {};
  ['when', 'perClusterSec', 'leaveAfterMin'].forEach((k) => { if (!locked.has(`spotlight.${k}`)) sp[k] = w.spotlight[k]; });
  sp.whenEmpty = w.spotlight.whenEmpty;
  out.spotlight = sp;
  return out;
}

/* -------------------------------- exclusion ---------------------------------- */

/** `{exclude:{add:{clusterId, reason}}}` or `{problem}`; the reason is required. */
export function excludeAdd(clusterId, reason) {
  if (!clusterId) return { problem: 'Pick the cluster to exclude' };
  const r = String(reason || '').trim();
  if (!r) return { problem: 'Say why: a reason is required to exclude a cluster' };
  return { exclude: { add: { clusterId, reason: r } } };
}
