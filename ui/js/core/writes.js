/**
 * The write unlock, shared by every page that can act on a cluster.
 *
 * The core owns the switch (session-only, never on disk). This module is the UI's single
 * copy of it plus the two pieces of interface every acting page needs: a toggle to show,
 * and `ensureWrites()` to call before doing something that writes.
 *
 * Nothing here grants anything by itself — the core refuses a write unless the session is
 * unlocked AND the individual request carries `allowWrites`, which only a page acting on
 * a person's click sets.
 */

import { h } from '../lib/dom.js';
import { confirmDialog } from '../ui/modal.js';
import { writeUnlock, workerStatus } from './es.js';
import { isReadOnly } from './state.js';

let unlocked = false;
const listeners = new Set();

/** Is the session unlocked, or does the config allow writes outright? */
export function writesAllowed() { return !isReadOnly() || unlocked; }
export function writesUnlocked() { return unlocked; }

/** Re-read the switch from the core, which owns it. Call on page render. */
export async function syncWrites() {
  try {
    const st = await workerStatus();
    setLocal(!!(st && st.writesUnlocked));
  } catch (_) { /* leave the last known value */ }
  return unlocked;
}

export function onWritesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setLocal(v) {
  if (v === unlocked) return;
  unlocked = v;
  listeners.forEach((fn) => { try { fn(unlocked); } catch (_) { /* a listener must not break the rest */ } });
}

const UNLOCK_PROMPT =
  'Actions you take by hand — a request typed in the REST console, creating or deleting a ' +
  'snapshot, opening or removing an index — will be sent to the cluster.\n\n' +
  'Background refreshes stay read-only, and this is forgotten when the app closes.';

/**
 * Turn the unlock on or off. Asks first when turning it on.
 * @returns {Promise<boolean>} whether the switch ended up where it was asked to go.
 */
export async function setWritesUnlocked(want, { confirmFirst = true } = {}) {
  if (want && confirmFirst && !(await confirmDialog('Allow writes to this cluster?', UNLOCK_PROMPT, { yes: 'allow writes' }))) return false;
  const res = await writeUnlock(want);
  setLocal(!!(res && res.ok && res.writesUnlocked));
  return unlocked === want;
}

/**
 * Call before a write. Returns true when the request may go ahead — either because the
 * config allows writes, or because the operator unlocks the session right now.
 */
export async function ensureWrites() {
  if (!isReadOnly()) return true;
  if (unlocked) return true;
  return setWritesUnlocked(true);
}

/**
 * The checkbox pages put in their header. `onchange` re-renders the page so the rest of
 * the controls (disabled buttons, hints) follow the new state.
 */
export function writeToggle(onchange) {
  if (!isReadOnly()) {
    return h('span.pill.yellow', { title: 'readOnly: false in the config — every page may write.' },
      h('i.dot'), 'writes enabled (config)');
  }
  return h('label', {
      title: unlocked
        ? 'Actions you take by hand will be sent to the cluster. Background refreshes stay read-only.'
        : 'The core refuses anything but GET/HEAD and search POSTs. Tick to allow the actions you take here.',
      style: { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer',
               fontSize: '11px', fontWeight: 600, color: unlocked ? 'var(--warning)' : 'var(--text-muted)' } },
    h('input', { type: 'checkbox', checked: unlocked, style: { cursor: 'pointer' },
      onchange: async (e) => {
        const ok = await setWritesUnlocked(e.target.checked);
        if (!ok) e.target.checked = unlocked;
        if (onchange) onchange(unlocked);
      } }),
    unlocked ? '✎ writes allowed' : '🔒 read-only');
}
