/**
 * The log delay levels — read from the core, never kept here (docs/LOGDELAY.md "Levels").
 *
 * The core resolves each cluster's levels (logdelay.json per cluster → the clusters file's
 * delayThresholds → logdelay.json → shipped) and says them in LOGDELAY_SETTINGS_GET
 * (`resolved[].levels`, Admin) and in LOGDELAY_SUMMARY (`byCluster[].levels`, any user). This
 * module asks once, keeps the answer, and classifies a delay with the contract's table. It has
 * no figure of its own: a cluster whose levels the core has not said is "levels unknown",
 * which is neither on time nor late.
 *
 *   state        rule (m = arrival − event, minutes)
 *   clock_ahead  m ≤ −delayFrom            (tested first)
 *   critical     m > criticalOver
 *   delay        delayFrom ≤ m ≤ criticalOver
 *   little       noDelayUnder ≤ m < delayFrom
 *   no_delay     m < noDelayUnder
 *   unmeasured   m unreadable              (never 0 min)
 *   silent       no document for silentAfterHours (only the core knows; never on time)
 *   other_tz     the gap sits steadily at another real UTC offset than the cluster's (only the
 *                core knows the steadiness; not late, counted apart)
 *
 * `m` is the corrected delay: the raw gap with the cluster's log time zone taken out
 * (core/log-tz.js, the core's tz.rs). The zone comes from the core too (`zoneOf`).
 */

import { bridge } from './transport.js';

/** The states, worst first where it matters for sorting. */
export const LEVEL_STATES = Object.freeze(['critical', 'delay', 'little', 'no_delay', 'clock_ahead', 'other_tz', 'silent', 'unmeasured']);

/** A level state in words, as the pages and the mail say it. */
export const STATE_LABEL = Object.freeze({
  no_delay: 'on time', little: 'little delay', delay: 'delayed', critical: 'critical',
  clock_ahead: 'clock ahead', other_tz: 'other time zone', silent: 'silent', unmeasured: "can't measure",
});

/** The Logs page's STATUS names for the core's states (docs/LOGDELAY.md "UI copy to remove"). */
export const STATUS_OF_STATE = Object.freeze({
  no_delay: 'OK', little: 'OK', delay: 'DELAYED', critical: 'CRITICAL',
  clock_ahead: 'CLOCK_AHEAD', other_tz: 'OTHER_TZ', silent: 'NO_DATA', unmeasured: 'ERROR',
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Levels as the core sends them, or null when they are not a usable set. */
export function levelsFrom(l) {
  if (!l || typeof l !== 'object') return null;
  const { noDelayUnder, delayFrom, criticalOver } = l;
  if (![noDelayUnder, delayFrom, criticalOver].every(finite)) return null;
  return { noDelayUnder, delayFrom, criticalOver };
}

/**
 * The core's state for a delay in minutes on `levels`; null when the levels are unknown.
 * A delay that cannot be read is `unmeasured`, never `no_delay`.
 */
export function levelState(minutes, levels) {
  const l = levelsFrom(levels);
  if (!l) return null;
  if (minutes === null || minutes === undefined || !finite(minutes)) return 'unmeasured';
  if (minutes <= -l.delayFrom) return 'clock_ahead';
  if (minutes > l.criticalOver) return 'critical';
  if (minutes >= l.delayFrom) return 'delay';
  if (minutes >= l.noDelayUnder) return 'little';
  return 'no_delay';
}

/** The Logs page's status (log-delay.js STATUS) for a delay; UNKNOWN when the levels are. */
export function statusFor(minutes, levels) {
  const s = levelState(minutes, levels);
  return s ? STATUS_OF_STATE[s] : 'UNKNOWN';
}

/** Late = delayed or critical (the contract's one definition). */
export const isLate = (state) => state === 'delay' || state === 'critical';
/** On time in totals = no_delay, little, clock_ahead. Silent and unmeasured are neither. */
export const isOnTime = (state) => state === 'no_delay' || state === 'little' || state === 'clock_ahead';

/* ------------------------------- what the core said ------------------------------- */

const known = { byCluster: new Map(), zones: new Map(), fleet: null, at: 0, from: '' };
let asking = null;

/** A cluster's `timeZone` as the core says it (docs/LOGDELAY.md "Time zones"), or null. */
export function zoneFrom(z) {
  if (!z || typeof z !== 'object' || !['set', 'detected', 'none'].includes(z.mode)) return null;
  return z;
}

/**
 * Keep what a reply said: SETTINGS_GET's `resolved` (levels, timeZone) and `settings.levels`, or
 * SUMMARY's `byCluster` (levels, timeZone), or one cluster's / device's answer (`cluster`, `timeZone`).
 */
export function rememberLevels(res) {
  if (!res || res.ok === false) return false;
  let any = false;
  for (const r of [...(Array.isArray(res.resolved) ? res.resolved : []), ...(Array.isArray(res.byCluster) ? res.byCluster : [])]) {
    const l = levelsFrom(r && r.levels);
    if (l && r.id) { known.byCluster.set(String(r.id), l); any = true; }
    const z = zoneFrom(r && r.timeZone);
    if (z && r.id) { known.zones.set(String(r.id), z); any = true; }
  }
  if (typeof res.cluster === 'string' && res.cluster) {
    const l = levelsFrom(res.levels);
    if (l) { known.byCluster.set(res.cluster, l); any = true; }
    const z = zoneFrom(res.timeZone);
    if (z) { known.zones.set(res.cluster, z); any = true; }
  }
  const fleet = levelsFrom(res.settings && res.settings.levels);
  if (fleet) { known.fleet = fleet; any = true; }
  if (any) known.at = Date.now();
  return any;
}

/** A cluster's levels as the core said them; null when it has not (no guess). */
export function levelsOf(clusterId) {
  return known.byCluster.get(String(clusterId)) || null;
}

/**
 * A cluster's log time zone as the core said it (`timeZone`: mode set | detected | none, zone,
 * offsetMinutes, …); null when it has not said — nothing is corrected then (core/log-tz.js).
 */
export function zoneOf(clusterId) {
  return known.zones.get(String(clusterId)) || null;
}

/** The fleet's default levels (logdelay.json `levels`), when an admin's read said them. */
export const fleetLevels = () => known.fleet;

/** Forget what was read (a test, a sign-out). */
export function forgetLevels() { known.byCluster.clear(); known.zones.clear(); known.fleet = null; known.at = 0; asking = null; }

/**
 * Ask the core for every visible cluster's levels: LOGDELAY_SETTINGS_GET where the caller is an
 * admin, else LOGDELAY_SUMMARY over one day (any user, the clusters they see). Kept for
 * `maxAgeMs`; never throws. Resolves to true when the core said something.
 */
export async function loadLevels({ send = bridge, maxAgeMs = 5 * 60000, force = false } = {}) {
  if (!force && known.at && Date.now() - known.at < maxAgeMs) return true;
  if (asking) return asking;
  asking = (async () => {
    try {
      const a = await send({ type: 'LOGDELAY_SETTINGS_GET' });
      if (rememberLevels(a)) return true;
      const b = await send({ type: 'LOGDELAY_SUMMARY', days: 1, maxDevices: 1 });
      return rememberLevels(b);
    } catch (_) {
      return false;
    } finally {
      asking = null;
    }
  })();
  return asking;
}
