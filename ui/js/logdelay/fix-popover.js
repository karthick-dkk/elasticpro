/**
 * The "i" button of the Log Delay page: a device's or a cluster's recommended fix, or what a view
 * is about. The popover itself is ui/ui/fix-popover.js (one for every page — the unassigned shard
 * rows of Nodes & shards open the same one); this file adds what the Log Delay rows put in it.
 *
 * The words are the core's (logdelay/fixes.rs): this file never writes a cause or a fix. A finding
 * is {step, stepLabel, why, fix, devices[], ...}; a device row carries its own as `fix` (an object,
 * or null when no rule matched; the device board's is `finding`), a cluster row carries `fixes`
 * (a list). A device with no finding says exactly that, rather than inventing a cause.
 */

import { stateText, STEP_LABEL } from '../core/logdelay-report.js';
import { infoButton, place, closeFix } from '../ui/fix-popover.js';

export { place, closeFix };

export const NO_FINDING = 'No recommendation from the core: not late in the stored delay periods of the last 7 days, or no rule matched yet.';

/** One finding as a popover item: title = stepLabel, cause = why, fix, where = the step in words; count for a cluster's. */
function norm(f, withCount) {
  if (!f || typeof f !== 'object') return null;
  const count = withCount ? (Number.isFinite(f.count) ? f.count : Array.isArray(f.devices) ? f.devices.length : null) : null;
  const where = f.where || (f.step && (STEP_LABEL[f.step] || String(f.step).replace(/_/g, ' '))) || '';
  return { title: String(f.title || f.stepLabel || where || ''), cause: String(f.cause || f.why || ''), fix: String(f.fix || ''), where: String(where), count };
}

/**
 * What to show for a device row (kind 'device') or a cluster row (kind 'cluster'). Never throws and
 * never invents a cause: a device without a finding gets NO_FINDING.
 */
export function fixesFor(row, kind = 'device') {
  if (!row || typeof row !== 'object') return [];
  const keep = (list, c) => list.map((f) => norm(f, c)).filter((x) => x && (x.title || x.cause || x.fix));
  if (kind === 'cluster') {
    const list = Array.isArray(row.fixes) ? row.fixes : Array.isArray(row.findings) ? row.findings : [];
    return keep(list, true);
  }
  const one = row.fix && typeof row.fix === 'object' ? row.fix : row.finding && typeof row.finding === 'object' ? row.finding
    : (typeof row.fix === 'string' && row.fix) || row.why ? row : null;
  if (one) { const l = keep([one], false); if (l.length) return l; }
  return [{ title: stateText(row.state), cause: NO_FINDING, fix: '', where: '', count: null }];
}

const HEAD = { device: 'device · recommended fix', cluster: 'cluster · recommended fix', about: 'about this view' };
const LABEL = { device: (id) => `Recommended fix for ${id}`, cluster: (id) => `Recommended fix for ${id}`, about: (id) => `About ${id}` };

/**
 * The "i". `kind`: 'device' | 'cluster' (a recommended fix) | 'about' (what a view is);
 * `id`: what it names; `items()`: asked when it is pressed — `{title, cause, fix, where, count?}` each,
 * an 'about' item may carry only title and cause.
 */
export function fixButton({ kind, id, items }) {
  const k = HEAD[kind] ? kind : 'device';
  return infoButton({ id, head: HEAD[k], label: LABEL[k](id), title: k === 'about' ? 'About this view' : 'Recommended fix',
    items, empty: k === 'about' ? '' : NO_FINDING });
}
