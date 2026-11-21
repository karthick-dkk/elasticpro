/**
 * Per-cluster collection switches (Config › Clusters › Edit cluster › Collection) — the page's
 * half of the core's collection.rs. Pure, no DOM.
 *
 * Kept with the cluster's config (`collection:` on a config-file entry, the overlay's
 * `collection` on a Zabbix cluster): only what is switched off is written, and `heavyHours`
 * `{from, to}` — whole hours of the server's time zone, `from` the first hour in and `to` the
 * first hour out, so 22–06 crosses midnight. A switched-off thing is never asked of the cluster;
 * the pages say so and where, never "unknown" or 0.
 */

/** Where a person turns a switch back on (collection.rs WHERE). */
export const WHERE = 'Edit cluster › Collection';

/** The switches, in the form's order: key, label, what it holds back. */
export const SWITCHES = Object.freeze([
  Object.freeze({ key: 'ilm', label: 'ILM checks', holds: 'ILM errors and ILM assignment' }),
  Object.freeze({ key: 'snapshots', label: 'Snapshots', holds: 'snapshot listings and running snapshots' }),
  Object.freeze({ key: 'logDelay', label: 'Log delay', holds: 'the log delay measurement' }),
  Object.freeze({ key: 'hosts', label: 'Hosts collection', holds: 'volume by host' }),
]);

/** A cluster's switches as kept: `{}` when everything is on, all day. Unreadable is everything on. */
export function collectionOf(c) {
  const v = c && c.collection;
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const s of SWITCHES) if (v[s.key] === false) out[s.key] = false;
  const h = hoursOf(v.heavyHours);
  if (h) out.heavyHours = h;
  return out;
}

/** `{from, to}` whole hours 0–23 that differ, else null. */
export function hoursOf(h) {
  if (!h || typeof h !== 'object') return null;
  const from = Number(h.from), to = Number(h.to);
  const ok = (n) => Number.isInteger(n) && n >= 0 && n < 24;
  return ok(from) && ok(to) && from !== to ? { from, to } : null;
}

/** Whether `key` is switched off for the cluster. */
export const isOff = (c, key) => collectionOf(c)[key] === false;

/** "22:00–06:00". */
export const hoursText = (h) => `${String(h.from).padStart(2, '0')}:00–${String(h.to).padStart(2, '0')}:00`;

/** Whether `hour` (0–23) is inside: [from, to), across midnight when to < from. */
export function hoursContain(h, hour) {
  if (!h) return true;
  return h.from < h.to ? hour >= h.from && hour < h.to : hour >= h.from || hour < h.to;
}

/** The sentence a page shows in place of data that is switched off — the core's off_text, minus "skipped". */
export function offText(key) {
  const s = SWITCHES.find((x) => x.key === key);
  return `${s ? s.label : key} switched off for this cluster (${WHERE})`;
}

/**
 * The form's value → what is saved: `null` when everything is on, all day (no key at all),
 * else only the switches that are off and the hours. Throws a sentence for hours that cannot be.
 * @param {{off: string[], hours: null | {from: number|string, to: number|string}}} f
 */
export function collectionValue(f) {
  const out = {};
  for (const k of f.off || []) if (SWITCHES.some((s) => s.key === k)) out[k] = false;
  if (f.hours) {
    const h = hoursOf(f.hours);
    if (!h) throw new Error('Heavy jobs only between: two different whole hours, 00–23.');
    out.heavyHours = h;
  }
  return Object.keys(out).length ? out : null;
}

/** One line for a list or a tooltip: "off: ILM checks, Snapshots · heavy jobs 22:00–06:00"; '' when all on. */
export function collectionSummary(c) {
  const v = collectionOf(c);
  const off = SWITCHES.filter((s) => v[s.key] === false).map((s) => s.label);
  const parts = [];
  if (off.length) parts.push(`off: ${off.join(', ')}`);
  if (v.heavyHours) parts.push(`heavy jobs ${hoursText(v.heavyHours)}`);
  return parts.join(' · ');
}
