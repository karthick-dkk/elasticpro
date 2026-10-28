/**
 * "Emergency stop" in the top bar, on every page (0.3.43; timed since 0.3.44).
 *
 * The stop holds the core from fetching anything new. The only sign of a pause used to be
 * a pill in the status strip, which the Clusters page and the evidence pages hide, so a
 * fleet paused by somebody who then forgot sat still for three days while every page
 * looked normal. Now a stop always ends by itself (15, 30 or 60 minutes), and the top bar,
 * which is on every page, says until when; an admin can end it sooner from here.
 */

import { h } from '../lib/dom.js';
import { fleetPolicy, fleetMode } from '../core/state.js';
import { policyGet, policySet } from '../core/es.js';
import { pauseFor, pausedLine, setPausedAll } from '../core/policy.js';
import { confirmDialog } from './modal.js';
import { toast } from './menu.js';

/** What the top bar's cache key needs to know about the stop. */
export function pausedKey(selected) {
  const p = fleetMode() ? pauseFor(fleetPolicy(), selected) : null;
  return p ? [p.since, p.until, p.by] : null;
}

const until = (p) => (p.until ? ` until ${new Date(p.until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '');

/**
 * The pill, or null when no stop holds. `selected` is the cluster in the chooser ("all"
 * for the fleet view); `admin` whether this person may end it; `onResumed` redraws the
 * page so it asks again.
 */
export function pausedPill({ selected, admin, onResumed }) {
  if (!fleetMode()) return null;
  const p = pauseFor(fleetPolicy(), selected === 'all' ? null : selected);
  if (!p) return null;
  const line = pausedLine(p);
  if (!admin) {
    return h('span.pill.orange', { title: line }, `⏸ Emergency stop${until(p)}`);
  }
  return h('button.btn.sm.paused-btn', {
    title: `${line} Click to end it now.`,
    onclick: () => resume(line, onResumed),
  }, `⏸ Emergency stop${until(p)} · Resume`);
}

async function resume(line, onResumed) {
  const ok = await confirmDialog('End the emergency stop now?',
    `${line}\n\nEnding it lets the server fetch again, and every page that is waiting gets its data.`,
    { yes: 'resume now' });
  if (!ok) return;
  let r;
  try {
    const cur = await policyGet();
    if (!cur || !cur.ok) throw new Error((cur && cur.message) || 'could not read the request policy');
    const next = setPausedAll(cur.policy, false);
    r = await policySet(next);
  } catch (e) { r = { ok: false, message: e.message || String(e) }; }
  if (r && r.ok) {
    toast('Requests resumed', 'ok', 4000, { key: 'request-pause' });
    if (onResumed) onResumed();
  } else {
    toast(`Not resumed: ${(r && r.message) || 'refused'}`, 'err', 8000, { key: 'request-pause' });
  }
}
