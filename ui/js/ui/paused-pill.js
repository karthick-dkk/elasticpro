/**
 * "Requests paused" in the top bar, on every page (0.3.43).
 *
 * A pause stops the core fetching anything new. The only sign of one used to be a pill in
 * the status strip, which the Clusters page and the evidence pages hide, so a fleet paused
 * by somebody who then forgot sat still for three days while every page looked normal and
 * Indices said "Fetching…". The top bar is on every page, so it is said there; an admin
 * can resume from it, anybody else is told who can.
 */

import { h } from '../lib/dom.js';
import { fleetPolicy, fleetMode } from '../core/state.js';
import { policyGet, policySet } from '../core/es.js';
import { pauseFor, pausedLine, setPausedAll, togglePaused } from '../core/policy.js';
import { confirmDialog } from './modal.js';
import { toast } from './menu.js';

/** What the top bar's cache key needs to know about the pause. */
export function pausedKey(selected) {
  const p = fleetMode() ? pauseFor(fleetPolicy(), selected) : null;
  return p ? [p.all, p.since, p.by] : null;
}

/**
 * The pill, or null when nothing on screen is paused. `selected` is the cluster in the
 * chooser ("all" for the fleet view); `admin` whether this person may resume;
 * `onResumed` redraws the page so it asks again.
 */
export function pausedPill({ selected, admin, onResumed }) {
  if (!fleetMode()) return null;
  const p = pauseFor(fleetPolicy(), selected === 'all' ? null : selected);
  if (!p) return null;
  const line = pausedLine(p);
  if (!admin) {
    return h('span.pill.orange', { title: `${line} Ask an administrator.` }, '⏸ Requests paused');
  }
  return h('button.btn.sm.paused-btn', {
    title: `${line} Click to resume.`,
    onclick: () => resume(p, selected, line, onResumed),
  }, '⏸ Requests paused · Resume');
}

async function resume(p, selected, line, onResumed) {
  const ok = await confirmDialog(p.all ? 'Resume all requests?' : 'Resume requests to this cluster?',
    `${line}\n\nResuming lets the server fetch again on its schedule, and every page that is waiting gets its data.`,
    { yes: p.all ? 'resume all requests' : 'resume this cluster' });
  if (!ok) return;
  let r;
  try {
    const cur = await policyGet();
    if (!cur || !cur.ok) throw new Error((cur && cur.message) || 'could not read the request policy');
    const next = p.all ? setPausedAll(cur.policy, false) : togglePaused(cur.policy, selected, false);
    r = await policySet(next);
  } catch (e) { r = { ok: false, message: e.message || String(e) }; }
  if (r && r.ok) {
    toast('Requests resumed', 'ok', 4000, { key: 'request-pause' });
    if (onResumed) onResumed();
  } else {
    toast(`Not resumed: ${(r && r.message) || 'refused'}`, 'err', 8000, { key: 'request-pause' });
  }
}
