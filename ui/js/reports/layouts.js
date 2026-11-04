/**
 * The column layouts of the Reports tables that are not the daily record's (docs/REPORTS.md,
 * "Columns menu"): `capacity` (Storage plan) and `overview` (By cluster).
 *
 * Shared through the same messages as the Daily and Monthly tables (VOLUME_LAYOUT_GET/SET,
 * table `capacity` | `overview`): an operator arranges once for everybody. What a person
 * changes is kept in this browser first and goes to everybody only with *Save for everyone*.
 * A core that does not know these two tables yet refuses the save; the layout then stays in
 * this browser and the menu says so, rather than pretending it was shared.
 */

import { state } from '../core/state.js';
import { volumeLayoutGet, volumeLayoutSet } from '../core/volume-daily.js';
import { sanitizeLayout } from '../lib/columns.js';

/** The two tables this module keeps (their keys: reports/overview.js OVERVIEW_KEYS, reports/capacity.js CAPACITY_KEYS). */
export const REPORT_TABLES = ['capacity', 'overview'];

const shared = { state: 'unknown', capacity: null, overview: null };
/** Tables the server refused to keep a layout for (an older core): per-browser only. */
const refused = new Set();
let listeners = [];
const changed = () => { for (const fn of listeners) { try { fn(); } catch (_) { /* the rest still hear */ } } };
export function onLayouts(fn) { listeners.push(fn); return () => { listeners = listeners.filter((x) => x !== fn); }; }

const KEY = (t) => `elasticpro.reports.columns.${t}`;
function readLocal(t) {
  try { const s = localStorage.getItem(KEY(t)); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
function writeLocal(t, layout) {
  try {
    if (layout) localStorage.setItem(KEY(t), JSON.stringify(layout));
    else localStorage.removeItem(KEY(t));
  } catch (_) { /* this session only */ }
}
const local = new Map(REPORT_TABLES.map((t) => [t, readLocal(t)]));

/** Asked once per visit to Reports. */
export async function loadReportLayouts() {
  if (shared.state === 'loading') return;
  shared.state = 'loading';
  let res;
  try { res = await volumeLayoutGet(); } catch (e) { res = { ok: false, message: e && e.message }; }
  if (res && res.ok) {
    const l = res.layouts || {};
    shared.capacity = l.capacity || null;
    shared.overview = l.overview || null;
    shared.state = 'ok';
  } else {
    shared.state = 'unavailable';
  }
  changed();
}

/** What a caller may share: operator and up, or the portable build (no accounts). */
export function roleMaySave() {
  const role = state.caller && state.caller.role;
  return !role || role === 'operator' || role === 'admin';
}

/** The layout on screen: this browser's arrangement, else the shared one, else the defaults. */
export function layoutOf(table) {
  return local.get(table) || shared[table] || null;
}

/** A tick, a move or a reset: kept in this browser until somebody saves it for everyone. */
export function setLocalLayout(table, defs, next) {
  const clean = sanitizeLayout(next, defs);
  local.set(table, clean);
  writeLocal(table, clean);
  changed();
}

/** What the menu says under the list. */
export function layoutNote(table) {
  if (refused.has(table)) return 'This server does not keep a shared layout for this table yet: the arrangement is kept in this browser only.';
  if (local.get(table)) return 'Arranged in this browser only. Save for everyone to share it.';
  if (shared[table]) return 'The layout everybody sees.';
  if (shared.state === 'unavailable') return 'The shared layout could not be read: changes are kept in this browser.';
  return '';
}

export function canShare(table) {
  return roleMaySave() && !refused.has(table);
}
export function shareWhy(table) {
  if (!roleMaySave()) return 'Only an operator or an admin can change the layout everybody sees.';
  if (refused.has(table)) return 'This server does not keep a shared layout for this table yet.';
  return '';
}

/** Save for everyone. A refusal keeps the layout in this browser and says why. */
export async function shareLayout(table, defs, layout) {
  const clean = sanitizeLayout(layout, defs);
  let res;
  try { res = await volumeLayoutSet(table, clean); } catch (e) { res = { ok: false, message: e && e.message }; }
  if (res && res.ok) {
    shared[table] = (res.layouts && res.layouts[table]) || clean;
    local.set(table, null);
    writeLocal(table, null);
    changed();
    return { ok: true };
  }
  // An older core: "table must be daily or monthly" (bad_request), or an unknown message.
  const msg = String((res && res.message) || '');
  if ((res && (res.kind === 'bad_request' || res.unsupported)) && /table|unknown/i.test(msg)) {
    refused.add(table);
    local.set(table, clean);
    writeLocal(table, clean);
    changed();
    return { ok: false, message: 'This server does not keep a shared layout for this table yet: kept in this browser only.' };
  }
  return { ok: false, message: `Not saved: ${msg || (res && res.kind) || 'no answer'}` };
}

/** Forget what the server said (each visit asks again); this browser's arrangements stay. */
export function resetReportLayouts() {
  Object.assign(shared, { state: 'unknown', capacity: null, overview: null });
  refused.clear();
}
