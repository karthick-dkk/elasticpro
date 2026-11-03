/** Small pieces the Reports sections share: amber "unknown" text, pills, the disk bar. */

import { h } from '../lib/dom.js';
import { bytes } from '../lib/fmt.js';

/** Unknown is not zero: amber words, with what would fix it on hover. */
export const amber = (text, title = null) => h('span.rp-na', { title }, text);
export const muted = (text, title = null) => h('span.muted', { title }, text);
export const tag = (text, cls = 'grey', title = null) => h(`span.pill.${cls}.rp-pill`, { title }, text);
export const loading = () => h('span.muted', { title: 'The daily record is on its way' }, '…');

/** A size, or the amber word for why there is none. */
export const sizeOr = (v, why = 'not measured', title = null) => (typeof v === 'number' && Number.isFinite(v) ? bytes(v) : amber(why, title));

/** "▲ 6.2 %" / "▼ 6.5 %": up in the serious ink, down in the good one (more data is the thing to watch). */
export function change(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return muted('—');
  return h(`span.${pct >= 0 ? 'vs-up' : 'vs-dn'}`, `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)} %`);
}
export const changeText = (pct) => (typeof pct === 'number' && Number.isFinite(pct) ? Math.round(pct * 10) / 10 : null);

/** Days as the runway reads: "11 days", "> 1 year". */
export const daysText = (d) => (d === null || d === undefined || !Number.isFinite(d) ? null : d >= 365 ? '> 1 year' : `${Math.floor(d)} day${Math.floor(d) === 1 ? '' : 's'}`);
/** Red under 2 weeks, amber under 6, green past it. */
export const runwayLevel = (d) => (d === null || !Number.isFinite(d) ? 'na' : d < 14 ? 'red' : d < 42 ? 'yellow' : 'green');

/**
 * A used / total bar with the bold percentage beside it and "4.75 TB of 5.20 TB, 0.45 TB
 * avail" after it (docs/REPORTS.md, Live disk): red over 90 %, amber over 80 %, blue below.
 */
export function diskBar(used, total, { what = 'disk' } = {}) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const level = pct > 90 ? 'crit' : pct > 80 ? 'warn' : 'ok';
  const free = Math.max(0, total - used);
  const label = `${bytes(used)} of ${bytes(total)}, ${bytes(free)} avail`;
  return h('div.rp-disk', { role: 'img', 'aria-label': `${what}: ${pct.toFixed(0)} percent used, ${label}` },
    h('span.rp-dt', h(`i.rp-df.${level}`, { style: { width: `${Math.min(100, Math.max(1, pct))}%` } })),
    h('b.rp-dp', `${pct.toFixed(0)} %`),
    h('span.rp-dl', h('b', bytes(used)), ` of ${bytes(total)}, ${bytes(free)} avail`));
}

/** Bytes as GB with one decimal for a CSV cell (binary, as every size here); null stays empty. */
export const gbCell = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round((v / 1024 ** 3) * 10) / 10 : null);
