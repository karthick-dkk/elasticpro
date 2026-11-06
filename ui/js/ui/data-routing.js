/**
 * Config-Management › Data › Backend: "Where each kind of data goes" and the "ElasticPro
 * built-in" card (the approved board; docs/HISTORY.md "Backend routing", the message contract
 * in docs/HANDBOOK.md). The messages and the arithmetic are core/data-routing.js.
 *
 * Nothing here has a Save button. The three "Kept in" selects and the report-file switch are
 * ordinary tracked fields: the page's one save bar names a change, and its Save runs
 * saveDataRouting (one DATA_ROUTING_SET with only the fields that changed). The core's refusal
 * is shown in the card, in its own words. Unknown is not zero: what the core could not read is
 * said so (core/data-routing.js cells), never drawn as 0.
 *
 * Drawn only on a core whose PING says `dataRouting.supported` (the page asks), for an admin;
 * a limited (scoped) admin reads it with the controls disabled. Every string from the core goes
 * in as a text node.
 */

import { h } from '../lib/dom.js';
import { card, pill, table } from '../pages/common.js';
import { toast } from './menu.js';
import { state } from '../core/state.js';
import { tabHash } from '../core/config-nav.js';
import {
  KINDS, MODES, REPORT_FILES_NOTE, ES_ONLY_NOTE, routingGet, routingSet, routingStatus,
  modeOf, statusCell, keptForCell, sizeCell, builtinLine, esOnlyWarning, routingChanges, letGoKinds,
} from '../core/data-routing.js';

const dr = { get: null, status: null, draft: null, refusal: '', redraw: () => {} };

/** The reply of the last DATA_ROUTING_GET, when the core answered it. */
export const routingLoaded = () => !!(dr.get && dr.get.supported !== false);
/** DATA_ROUTING_STATUS as last read, for the Elasticsearch cluster card's extra lines. */
export const routingStatusNow = () => dr.status;

/** A limited admin reads; changing where the whole fleet's records go is a full admin's. */
const readOnly = () => !!(state.caller && state.caller.scoped);

/**
 * Read the routing and its status. `fresh` runs when the panel shows what the core holds afresh
 * (the save bar then starts again from it); not on the redraws caused by typing.
 */
export async function loadDataRouting(redraw, fresh) {
  dr.redraw = redraw || dr.redraw;
  const [get, status] = await Promise.all([routingGet(), routingStatus()]);
  dr.get = get && get.ok !== false && get.supported !== false ? get : null;
  dr.status = status && status.ok !== false && status.supported !== false ? status : null;
  // A choice made and not saved yet is kept over a re-read (it is the person's); otherwise the
  // screen starts again from what the core holds.
  if (!dr.draft) { dr.refusal = ''; if (fresh) fresh(); }
  dr.redraw();
}

/** What the controls show now: what was chosen and not yet saved, else what the core holds. */
function shown() {
  const r = (dr.get && dr.get.routing) || {};
  const d = dr.draft || {};
  return {
    history: d.history || modeOf(r, 'history'),
    reports: d.reports || modeOf(r, 'reports'),
    alerts: d.alerts || modeOf(r, 'alerts'),
    reportFiles: d.reportFiles !== undefined ? !!d.reportFiles : !!r.reportFiles,
  };
}

/** The controls as they stand on screen. */
function readControls() {
  const out = {};
  for (const [id] of KINDS) {
    const el = document.querySelector(`#dr-mode-${id}`);
    if (el) out[id] = el.value;
  }
  const rf = document.querySelector('#dr-reportFiles');
  if (rf) out.reportFiles = rf.checked;
  return out;
}

/** The bar's Discard, and leaving the page or tab: what was chosen and not saved is forgotten. */
export function discardDataRouting() { dr.draft = null; dr.refusal = ''; }

/** The save bar runs this. True when the core took it; its refusal is shown otherwise. */
export async function saveDataRouting() {
  const draft = readControls();
  const changes = routingChanges(dr.get && dr.get.routing, draft);
  if (!Object.keys(changes).length) return true;
  dr.draft = draft;
  const res = await routingSet(changes);
  if (!res || res.ok === false) {
    dr.refusal = (res && res.message) || 'the core refused the change';
    toast(dr.refusal, 'warn', 6000);
    dr.redraw();
    return false;
  }
  dr.get = { ...(dr.get || {}), ...res, ok: true, supported: true };
  dr.draft = null; dr.refusal = '';
  const status = await routingStatus();
  dr.status = status && status.ok !== false && status.supported !== false ? status : dr.status;
  toast('Where data goes is saved', 'ok');
  dr.redraw();
  return true;
}

const toneClass = { ok: 'green', warn: 'orange', muted: 'grey' };

function modeSelect(id, value, disabled) {
  const modes = (dr.get && Array.isArray(dr.get.modes) && dr.get.modes.length ? dr.get.modes.map((m) => [m.id, m.label]) : MODES);
  const known = modes.some(([v]) => v === value);
  const sel = h('select', {
    id: `dr-mode-${id}`, disabled: !!disabled,
    dataset: { label: `${KINDS.find(([k]) => k === id)[1]} kept in` },
    style: { height: '28px', minWidth: '230px' },
    onchange: () => { dr.draft = readControls(); dr.redraw(); },
  }, ...modes.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = known ? value : 'builtin';
  return sel;
}

/** "Where each kind of data goes". Null when the core has not answered (an older core draws nothing). */
export function dataRoutingCard() {
  if (!routingLoaded()) return null;
  const v = shown();
  const ro = readOnly();
  const kinds = (dr.status && dr.status.kinds) || {};
  const r = dr.get.routing || {};
  const warn = esOnlyWarning(dr.status);
  const letGo = letGoKinds(r, v);
  const reportsOnStore = v.reports !== 'builtin';

  const rows = KINDS.map(([id, label, what]) => {
    const k = kinds[id];
    const st = k ? statusCell(k) : { tone: 'muted', text: 'status unknown' };
    return h('tr', { dataset: { kind: id } },
      h('td', h('b', label), h('span.muted', ` · ${what}`)),
      h('td', modeSelect(id, v[id], ro)),
      h('td', { dataset: { cell: 'kept' } }, k ? keptForCell(k) : 'unknown'),
      h('td', { dataset: { cell: 'size' } }, k ? sizeCell(k) : 'unknown'),
      h('td', { dataset: { cell: 'status' } }, pill(st.text, toneClass[st.tone] || 'grey')));
  });

  return h('div', { dataset: { track: 'routing', trackLabel: 'Where data goes' } },
    card('Where each kind of data goes', 'ElasticPro built-in is the default for everything',
      h('div', { style: { display: 'grid', gap: '8px' } },
        table(['Data', 'Kept in', 'Kept for', 'Size now', 'Status'], rows),
        dr.refusal ? h('div.banner.err#dr-refusal', { style: { margin: 0, fontSize: '12px' } }, dr.refusal) : null,
        warn ? h('div.banner.warn#dr-es-warning', { style: { margin: 0, fontSize: '12px' } }, warn) : null,
        reportsOnStore
          ? h('div', { style: { display: 'grid', gap: '3px' } },
              h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12.5px' } },
                h('input', { id: 'dr-reportFiles', type: 'checkbox', checked: v.reportFiles, disabled: ro, dataset: { label: 'Carry the report file' } }),
                h('b', 'Carry the report file')),
              h('div.muted#dr-reportfiles-note', { style: { fontSize: '11.5px' } }, REPORT_FILES_NOTE))
          : null,
        letGo.length
          ? h('div.muted#dr-letgo', { style: { fontSize: '11.5px' } },
              `${letGo.join(', ')} set back to built-in lets go of what was queued for Elasticsearch (counted as dropped, audited). Nothing already on the cluster is deleted.`)
          : null,
        h('div.muted', { style: { fontSize: '11.5px' } }, ES_ONLY_NOTE),
        r.changedBy
          ? h('div.muted#dr-changed', { style: { fontSize: '11.5px' } }, `Last saved by ${r.changedBy}${r.changedAt ? ` · ${new Date(r.changedAt).toLocaleString()}` : ''}`)
          : h('div.muted#dr-changed', { style: { fontSize: '11.5px' } }, 'Not saved by an admin yet: history follows the Elasticsearch cluster (copy while it is writing).'),
        ro ? h('div.muted#dr-readonly', { style: { fontSize: '11.5px' } }, 'Where the whole fleet’s records go is a full admin’s to change; this is read-only for you.') : null)));
}

const kv = (k, v) => h('tr.kv', h('td.k', k), h('td.v', v));

/** The "ElasticPro built-in" card, from STATUS `builtin`. `backup` is PING's `backup.supported`. */
export function builtinCard({ backup = false } = {}) {
  if (!routingLoaded()) return null;
  const b = (dr.status && dr.status.builtin) || null;
  return card('ElasticPro built-in', 'default · needs nothing set up',
    table([], [
      kv('Where', b && b.dir
        ? h('span', 'On the ElasticPro server, in its data directory ', h('code.inline', b.dir))
        : 'On the ElasticPro server, in its data directory'),
      kv('Size now', b ? builtinLine(dr.status) : 'unknown'),
      backup
        ? kv('Backed up', h('span', 'Yes, in ', h('a#dr-backup-link', { href: tabHash('system', 'backup') }, 'Backup & restore')))
        : null,
      kv('Search it', 'From ElasticPro pages only'),
    ].filter(Boolean)));
}
