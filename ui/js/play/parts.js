/** The pieces every Play slide is built from: a figure tile, a pill, a list that fits. */

import { h } from '../lib/dom.js';

/** A big figure: label over value, an optional line under it. `tone` colours the value. */
export function kpi(label, value, sub, tone = '') {
  return h(`div.pl-kpi${tone ? `.${tone}` : ''}`, h('div.pl-k', label), h('div.pl-v', value), sub ? h('div.pl-s', sub) : null);
}

export const pillEl = (text, tone = 'grey') => h(`span.pl-pill.${tone}`, text);

/** "not measured" / "no data": unknown, said in words and set apart, never a 0. */
export const unknown = (text = 'no data', title = '') => h('span.pl-unk', { title: title || null }, text);

/** Minutes of delay as an operator reads them: "12 min", "1 h 05", "2.3 d". */
export function minutes(m) {
  if (m === null || m === undefined || !isFinite(m)) return '–';
  const a = Math.abs(m);
  const sign = m < 0 ? '−' : '';
  if (a < 60) return `${sign}${Math.round(a)} min`;
  if (a < 48 * 60) return `${sign}${Math.floor(a / 60)} h ${String(Math.round(a % 60)).padStart(2, '0')}`;
  return `${sign}${(a / 1440).toFixed(1)} d`;
}

/** "HH:MM:SS" in a time zone (the server's), or local. */
export function clockText(ms, tz, { seconds = true } = {}) {
  if (!ms) return '–';
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false, ...(seconds ? { second: '2-digit' } : {}) };
  try { return new Intl.DateTimeFormat('en-GB', { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(new Date(ms)); }
  catch (_) { return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms)); }
}

/** The zone's short name: IST for India, else what Intl calls it. */
export function zoneName(tz) {
  if (!tz) return '';
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IST';
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    return (p.find((x) => x.type === 'timeZoneName') || {}).value || tz;
  } catch (_) { return tz; }
}

/** "3 h 12 m" for how long something has been open. */
export function openFor(ms) {
  if (!isFinite(ms) || ms < 0) return '–';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h ${String(m % 60).padStart(2, '0')} m`;
  return `${Math.floor(hrs / 24)} d ${hrs % 24} h`;
}

/**
 * Take rows off the end of `box` until it no longer overflows, and say how many with
 * `more(n)` — a TV never scrolls. Measured after the box is on screen; without layout (no
 * height, as in jsdom) nothing is taken.
 */
export function fitRows(box, rows, more) {
  if (!box || !box.isConnected || !box.clientHeight) return 0;
  const over = () => box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1;
  if (!over()) return 0;
  const list = [...rows];
  let hidden = 0;
  let tail = null;
  while (list.length && over()) {
    list.pop().remove();
    hidden++;
    if (!tail) { tail = more(hidden); if (tail) box.append(tail); }
    else tail.textContent = more(hidden).textContent;
  }
  return hidden;
}
