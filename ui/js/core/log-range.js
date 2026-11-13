/**
 * The Log Delay page's time range and its clock: the one definition of "Last 5 minutes", of a
 * custom from/to, and of how a time is written in the server's zone with its offset. Live Watch
 * and Live logs read the same range, so the two never cover different minutes. Pure (Intl only),
 * so tools/unit tests it.
 */

/** `[id, label, minutes]`, in the order the selector lists them; custom has no minutes. */
export const RANGES = Object.freeze([
  ['1m', 'Last 1 minute', 1], ['5m', 'Last 5 minutes', 5], ['30m', 'Last 30 minutes', 30],
  ['1h', 'Last 1 hour', 60], ['2h', 'Last 2 hours', 120], ['3h', 'Last 3 hours', 180],
  ['6h', 'Last 6 hours', 360], ['8h', 'Last 8 hours', 480], ['12h', 'Last 12 hours', 720],
  ['custom', 'Custom', null],
]);
export const DEFAULT_RANGE = '1h';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** A range as kept: `{id}`, or `{id: 'custom', from, to}` in unix ms. Anything else is the default. */
export function normaliseRange(r) {
  const id = r && RANGES.some(([k]) => k === r.id) ? r.id : DEFAULT_RANGE;
  if (id !== 'custom') return { id };
  return { id, from: finite(r.from) ? r.from : null, to: finite(r.to) ? r.to : null };
}

/**
 * `{from, to}` in unix ms for a range at `now`, or null for a custom range that is not whole
 * (a field empty, or from after to) — never a guessed window.
 */
export function rangeBounds(r, now = Date.now()) {
  const n = normaliseRange(r);
  if (n.id === 'custom') return finite(n.from) && finite(n.to) && n.from <= n.to ? { from: n.from, to: n.to } : null;
  const minutes = RANGES.find(([k]) => k === n.id)[2];
  return { from: now - minutes * 60000, to: now };
}

/** How long a range covers, in minutes; null for an incomplete custom range. */
export function rangeMinutes(r, now = Date.now()) {
  const b = rangeBounds(r, now);
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
  if (n.id !== 'custom') return RANGES.find(([k]) => k === n.id)[1];
  const b = rangeBounds(n);
  if (!b) return 'Custom range not set';
  const a = zonedText(b.from, tz, { seconds: false }); const z = zonedText(b.to, tz, { seconds: false });
  return `${a} → ${a.slice(0, 10) === z.slice(0, 10) ? z.slice(11) : z}`;
}
