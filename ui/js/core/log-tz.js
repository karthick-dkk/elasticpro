/**
 * Log time zones in the browser — the same rule as the core's logdelay/tz.rs (docs/LOGDELAY.md
 * "Time zones"), for the figures the browser measures itself: Live Watch, Live logs, the Play
 * wall and the Zabbix scraper. Pure (Intl only), so tools/unit tests it.
 *
 *   corrected delay = raw gap (arrival − event) − the cluster's offset at the event's own time
 *
 * The cluster's zone is never decided here. The core says it per cluster (`timeZone` on
 * LOGDELAY_SUMMARY byCluster, LOGDELAY_CLUSTER, LOGDELAY_SETTINGS_GET resolved; kept by
 * core/delay-levels.js `zoneOf`): mode `set` | `detected` | `none`, a zone name when one is known,
 * the offset. A named zone is applied at each event's time through Intl (DST); a detected offset
 * is fixed; `none` corrects nothing — unknown is not zero.
 *
 * A device's raw gap is also matched against every real UTC offset (Intl's zone list), within
 * the tolerance the core uses (3 min, `PATTERN.tzToleranceMinutes`; tools/unit holds the two
 * equal). One live measurement cannot know whether that is steady, so the browser only says
 * "looks like +08:00" — the dashboard says whether it is.
 */

import { zoneOffsetMinutes } from './log-range.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** "+05:30", "−03:30", "+00:00": an offset as the core writes it (tz.rs offset_text). */
export function offsetLabel(minutes) {
  if (!finite(minutes)) return '—';
  const m = Math.round(minutes);
  const a = Math.abs(m);
  return `${m < 0 ? '−' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * ICU lists some zones under the name the IANA database has since renamed (Calcutta for
 * Kolkata, Kiev for Kyiv, …). The modern name is what the core writes and what people look for.
 */
const MODERN = Object.freeze({
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Rangoon': 'Asia/Yangon', 'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Atlantic/Faeroe': 'Atlantic/Faroe', 'Pacific/Ponape': 'Pacific/Pohnpei', 'Pacific/Truk': 'Pacific/Chuuk', 'Pacific/Enderbury': 'Pacific/Kanton',
});

/** Every IANA zone Intl knows, region names only (no Etc/…), under their modern names; [] where Intl cannot list them. */
export function zoneNames() {
  try {
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return [...new Set(all.filter((z) => z.includes('/') && !z.startsWith('Etc/')).map((z) => MODERN[z] || z))];
  } catch (_) { return []; }
}

/** Whether Intl knows a zone by this name (the Edit dialog's check before the core's). */
export function knownZone(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (/^utc$/i.test(n)) return true;
  try { new Intl.DateTimeFormat('en', { timeZone: n }); return true; } catch (_) { return false; }
}

/**
 * Every real UTC offset in use at `at` (minutes), UTC included, from Intl's zone list; cached per
 * hour. The set a raw gap is matched against.
 */
let offsetsCache = { key: null, set: null };
export function offsetsInUse(at = Date.now()) {
  const key = Math.floor(at / 3600000);
  if (offsetsCache.key === key && offsetsCache.set) return offsetsCache.set;
  const set = new Set([0]);
  for (const z of zoneNames()) {
    const o = zoneOffsetMinutes(z, at);
    if (finite(o)) set.add(o);
  }
  // A day earlier too, so a zone that changed its clocks during the window still matches.
  for (const z of zoneNames()) {
    const o = zoneOffsetMinutes(z, at - 86400000);
    if (finite(o)) set.add(o);
  }
  offsetsCache = { key, set };
  return set;
}

/**
 * The real offset a raw gap sits at, within `tolerance` minutes (the nearest), or null: a plain
 * delay, not a zone. `offsets` is a Set of minutes (offsetsInUse).
 */
export function matchOffset(rawMinutes, tolerance, offsets = offsetsInUse()) {
  if (!finite(rawMinutes)) return null;
  let best = null;
  for (const o of offsets) {
    const d = Math.abs(rawMinutes - o);
    if (d <= tolerance && (best === null || d < best.d)) best = { o, d };
  }
  return best ? best.o : null;
}

/**
 * The cluster's offset at an instant, from its `timeZone` as the core said it: a named zone's
 * offset at that time (DST), a detected offset as fixed, null when the cluster has no zone.
 */
export function clusterOffsetAt(tz, atMs) {
  if (!tz || typeof tz !== 'object') return null;
  if (tz.mode !== 'set' && tz.mode !== 'detected') return null;
  if (tz.zone && tz.zone !== 'UTC' && finite(atMs) && knownZone(tz.zone)) {
    const o = zoneOffsetMinutes(tz.zone, atMs);
    if (finite(o)) return o;
  }
  return finite(tz.offsetMinutes) ? tz.offsetMinutes : null;
}

/**
 * One measured gap through the zone step. `{ rawGapMinutes, offsetMinutes, delayMinutes,
 * deviceOffset }`: the corrected delay when the cluster has an offset (`offsetMinutes`), the raw
 * gap unchanged when it has none; `deviceOffset` is the real offset the raw gap sits at, if any.
 */
export function correct(rawMinutes, tz, eventMs, tolerance = 3) {
  if (!finite(rawMinutes)) return { rawGapMinutes: null, offsetMinutes: null, delayMinutes: null, deviceOffset: null };
  const off = clusterOffsetAt(tz, eventMs);
  return {
    rawGapMinutes: rawMinutes,
    offsetMinutes: off,
    delayMinutes: off === null ? rawMinutes : rawMinutes - off,
    deviceOffset: matchOffset(rawMinutes, tolerance),
  };
}

/**
 * The cluster's zone in words, as the chip and the By cluster column say it:
 * "Asia/Kolkata +05:30 · detected · 1 112 of 1 240 devices (90 %)", "UTC +00:00 · set",
 * "not detected (41 % agree)", "not detected" (nothing measured), "—" (no answer).
 */
export function timeZoneText(tz, { devices = true } = {}) {
  if (!tz || typeof tz !== 'object') return '—';
  const pct = finite(tz.pct) ? `${Math.round(tz.pct)} %` : null;
  const name = tz.zone ? `${tz.zone} ` : '';
  const who = devices && finite(tz.agree) && finite(tz.of) ? ` · ${tz.agree.toLocaleString('en')} of ${tz.of.toLocaleString('en')} devices${pct ? ` (${pct})` : ''}`
    : pct ? ` (${pct} agree)` : '';
  if (tz.mode === 'set') return `${name}${tz.offset || offsetLabel(tz.offsetMinutes)} · set${who}`;
  if (tz.mode === 'detected') return `${name}${tz.offset || offsetLabel(tz.offsetMinutes)} · detected${who}`;
  if (tz.mode === 'none') return pct ? `not detected (${pct} agree)` : 'not detected';
  return '—';
}

/** The short form for a table cell: "Asia/Kolkata · detected", "+08:00 · set", "not detected (41 % agree)". */
export function timeZoneShort(tz) {
  if (!tz || typeof tz !== 'object') return '—';
  if (tz.mode === 'set' || tz.mode === 'detected') return `${tz.zone || tz.offset || offsetLabel(tz.offsetMinutes)} · ${tz.mode}`;
  if (tz.mode === 'none') return finite(tz.pct) ? `not detected (${Math.round(tz.pct)} % agree)` : 'not detected';
  return '—';
}

/**
 * "Device time zone" for a row (docs/LOGDELAY.md DeviceRow): the device's own offset when it is
 * in another zone, "same as cluster" when measured against the cluster's zone, "—" when the
 * cluster has none (nothing to compare against) or nothing was measured. A live row (one
 * measurement, no steadiness) says "looks like +08:00" for a gap that sits at another offset.
 */
export function deviceZoneText(row) {
  if (!row) return '—';
  if (row.state === 'other_tz') return offsetLabel(row.tzOffsetMinutes ?? row.deviceTzOffset);
  if (!finite(row.clusterTzOffset)) return '—';
  if (row.state === 'silent' || row.state === 'unmeasured' || !finite(row.nowMinutes)) return '—';
  if (row.live && finite(row.deviceTzOffset) && row.deviceTzOffset !== row.clusterTzOffset) return `looks like ${offsetLabel(row.deviceTzOffset)}`;
  return 'same as cluster';
}

/**
 * The sum behind a delay figure, for the cell's title: "arrival 10:42:05 − event 04:30:11 −
 * time zone 5 h 30 = 42 min". `fmt(ms)` writes a time; without an offset the zone part is left out.
 */
export function delaySumText(row, fmt) {
  if (!row || !finite(row.nowMinutes)) return '';
  const t = (ms) => (finite(ms) && fmt ? fmt(ms) : '?');
  const m = (v) => `${Math.round(v * 10) / 10} min`;
  const off = finite(row.tzOffsetMinutes) ? row.tzOffsetMinutes : null;
  if (off === null) return `arrival ${t(row.lastArrival)} − event ${t(row.lastEvent)} = ${m(row.nowMinutes)}`;
  const h = Math.floor(Math.abs(off) / 60); const mm = Math.abs(off) % 60;
  const zone = `${off < 0 ? '−' : ''}${h} h${mm ? ` ${mm}` : ''}`;
  return `arrival ${t(row.lastArrival)} − event ${t(row.lastEvent)} − time zone ${zone} = ${m(row.nowMinutes)}${finite(row.rawGapMinutes) ? ` (raw gap ${m(row.rawGapMinutes)})` : ''}`;
}

/**
 * The options of the "Log time zone" select: Detect, UTC, then every zone with its offset now
 * (sorted by offset, then name). `detectedText` names what detection says now, when it does.
 */
export function zoneOptions(at = Date.now(), { detectedText = '' } = {}) {
  const zones = zoneNames().map((z) => [z, zoneOffsetMinutes(z, at)]).filter(([, o]) => finite(o))
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [
    ['detect', `Detect from devices${detectedText ? ` (now: ${detectedText})` : ''}`],
    ['UTC', 'UTC (no correction)'],
    ...zones.map(([z, o]) => [z, `${z} (${offsetLabel(o)})`]),
  ];
}

/** The hint under the field, from the design. */
export const ZONE_HINT = 'The zone this cluster’s arrival time is stamped in. “Detect” uses the zone most of its devices fall in '
  + '(at least 60 %, steady over 3 runs). Pick a zone to fix it, for example Asia/Kolkata. UTC means no correction.';
