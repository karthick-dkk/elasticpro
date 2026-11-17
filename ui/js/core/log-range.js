/**
 * The Log Delay page's time ranges and their clock: the one definition of "Last 30 minutes", of
 * "Last 7 days", of a custom from/to, and of how a time is written in the server's zone with its
 * offset. Pure (Intl only), so tools/unit tests it.
 *
 * Two sets of ranges, each kept on its own (pages/log-delay.js): the boards (Dashboard, Summary,
 * Devices and the cluster and device views — the core's store) offer 30m to 12h and, in a menu,
 * 1d to 60d; Live Watch and Live logs (measured from this browser, heavy over long windows) offer
 * 5m to 12h. An id means the same in both sets: the sets are lists of ids from one table.
 */

/**
 * Every range, by id: `[label, minutes, days]`. A minute range ends now; a day range is that
 * many whole local days ending today (the store keeps whole days: 7d is today and the 6 days
 * before, from that first day's midnight); custom has neither.
 */
const DEFS = Object.freeze({
  '5m': ['Last 5 minutes', 5, null], '10m': ['Last 10 minutes', 10, null], '30m': ['Last 30 minutes', 30, null],
  '1h': ['Last 1 hour', 60, null], '2h': ['Last 2 hours', 120, null], '3h': ['Last 3 hours', 180, null],
  '4h': ['Last 4 hours', 240, null], '8h': ['Last 8 hours', 480, null], '12h': ['Last 12 hours', 720, null],
  '1d': ['Today', null, 1], '3d': ['Last 3 days', null, 3], '7d': ['Last 7 days', null, 7],
  '15d': ['Last 15 days', null, 15], '30d': ['Last 30 days', null, 30], '60d': ['Last 60 days', null, 60],
  custom: ['Custom', null, null],
});

/** The boards' ranges, in the order the selector lists them: six buttons, the day ranges in its More menu, Custom. */
export const BOARD_RANGES = Object.freeze(['30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '7d', '15d', '30d', '60d', 'custom']);
/** Live Watch's and Live logs' ranges, in order. */
export const LIVE_RANGES = Object.freeze(['5m', '10m', '30m', '1h', '3h', '12h', 'custom']);
export const DEFAULT_RANGE = '1h';
/**
 * The longest period a LOGDELAY_* message takes (`from`/`to` at most 1200 days apart, else
 * `bad_request`: crates/elasticpro-core/src/logdelay/mod.rs). The 60-day range is far inside it;
 * a custom range on the boards is checked against it before it is asked.
 */
export const BOARD_MAX_DAYS = 1200;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The label of a range id ("Last 7 days"); '' for an id that is not one. */
export const rangeLabel = (id) => (DEFS[id] ? DEFS[id][0] : '');
/** How many whole local days a day range covers (7 for 7d); null for a minute or custom range. */
export const rangeDays = (id) => (DEFS[id] ? DEFS[id][2] : null);

/** A fixed range's length in minutes, for comparing one with another (a day range as whole days). */
const spanOf = (id) => (DEFS[id][1] !== null ? DEFS[id][1] : DEFS[id][2] !== null ? DEFS[id][2] * 1440 : null);

/**
 * A range as kept: `{id}`, or `{id: 'custom', from, to}` in unix ms. Unknown is the default.
 * With `set` (BOARD_RANGES, LIVE_RANGES), a range from the other set becomes the shortest of this
 * one that covers as much, else its longest — a 5m kept from before is 30m on the boards, a 7d
 * on Live Watch is 12h — said nowhere, the buttons show what is used.
 */
export function normaliseRange(r, set = null) {
  let id = r && Object.prototype.hasOwnProperty.call(DEFS, r.id) ? r.id : DEFAULT_RANGE;
  if (set && !set.includes(id)) {
    const fixed = set.filter((k) => k !== 'custom').sort((a, b) => spanOf(a) - spanOf(b));
    const want = spanOf(id);
    id = fixed.find((k) => spanOf(k) >= want) || fixed[fixed.length - 1];
  }
  if (id !== 'custom') return { id };
  return { id, from: finite(r.from) ? r.from : null, to: finite(r.to) ? r.to : null };
}

/** YYYY-MM-DD of a local day, `back` days before the day `ms` falls on in `tz`. */
function dayBefore(ms, tz, back) {
  const p = partsIn(ms, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day - back)).toISOString().slice(0, 10);
}

/**
 * `{from, to}` in unix ms for a range at `now`, or null for a custom range that is not whole
 * (a field empty, or from after to) — never a guessed window. A day range starts at midnight in
 * `tz` (the page's zone) of its first day.
 */
export function rangeBounds(r, now = Date.now(), tz = undefined) {
  const n = normaliseRange(r);
  if (n.id === 'custom') return finite(n.from) && finite(n.to) && n.from <= n.to ? { from: n.from, to: n.to } : null;
  const days = rangeDays(n.id);
  if (days !== null) return { from: fromZonedInput(`${dayBefore(now, tz, days - 1)}T00:00`, tz), to: now };
  return { from: now - DEFS[n.id][1] * 60000, to: now };
}

/** "the last 30 minutes", "today", or "the range" for a custom one: a range in a sentence. */
export function rangeWords(r) {
  const n = normaliseRange(r);
  if (n.id === 'custom') return 'the range';
  const label = DEFS[n.id][0];
  return /^Last /.test(label) ? `the ${label.toLowerCase()}` : label.toLowerCase();
}

/** How long a range covers, in minutes; null for an incomplete custom range. */
export function rangeMinutes(r, now = Date.now(), tz = undefined) {
  const b = rangeBounds(r, now, tz);
  return b ? (b.to - b.from) / 60000 : null;
}

/* ------------------------------------- the clock ------------------------------------- */

/** The browser's own zone, the stand-in until the server says its own. */
export function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}

/** The wall-clock parts of `ms` in `tz` (numbers); the browser's zone when `tz` is not one Intl knows. */
export function zonedParts(ms, tz) { return partsIn(ms, tz); }
function partsIn(ms, tz) {
  const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  let f;
  try { f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz || undefined }); } catch (_) { f = new Intl.DateTimeFormat('en-GB', opts); }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  if (o.hour === 24) o.hour = 0;
  return o;
}

/** Minutes `tz` is ahead of UTC at `at` (India: 330). */
export function zoneOffsetMinutes(tz, at = Date.now()) {
  const t = Math.floor(at / 1000) * 1000;
  const p = partsIn(t, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t) / 60000);
}

/** "UTC +05:30", "UTC −03:00", "UTC +00:00": what a column head says after the time it holds. */
export function offsetText(minutes) {
  const m = finite(minutes) ? Math.round(minutes) : 0;
  const a = Math.abs(m);
  return `UTC ${m < 0 ? '−' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-13 08:49:07" in `tz`; '—' for a time that is not known. */
export function zonedText(ms, tz, { seconds = true } = {}) {
  if (!finite(ms)) return '—';
  const p = partsIn(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}${seconds ? `:${pad(p.second)}` : ''}`;
}

/** The value a datetime-local input shows for `ms` in `tz` ("2026-11-13T08:49"); '' when unknown. */
export function zonedInputValue(ms, tz) {
  if (!finite(ms)) return '';
  const p = partsIn(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The instant a datetime-local value means when read as wall-clock time in `tz`; null when it
 * is not a whole date and time. The offset is the one in force at that moment (summer time).
 */
export function fromZonedInput(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let at = wall - zoneOffsetMinutes(tz, wall) * 60000;
  // Once more with the offset at the instant found, for a wall time just past a change.
  at = wall - zoneOffsetMinutes(tz, at) * 60000;
  return at;
}

/** A range in words for a card's sub line: "Last 5 minutes", or "2026-11-13 08:00 → 09:30". */
export function rangeText(r, tz) {
  const n = normaliseRange(r);
  if (n.id !== 'custom') return DEFS[n.id][0];
  const b = rangeBounds(n);
  if (!b) return 'Custom range not set';
  const a = zonedText(b.from, tz, { seconds: false }); const z = zonedText(b.to, tz, { seconds: false });
  return `${a} → ${a.slice(0, 10) === z.slice(0, 10) ? z.slice(11) : z}`;
}
