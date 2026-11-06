/**
 * Data › Backend: where ElasticPro keeps what it records — the messages and the pure helpers
 * (docs/HISTORY.md "Backend routing"; the message contract in docs/HANDBOOK.md).
 *
 * Three kinds (history, reports, alerts), each kept in one of three places: ElasticPro's
 * built-in store (the default), built-in plus a copy on the Elasticsearch history store, or
 * the history store only. The Elasticsearch side is always the dedicated history store
 * (core/history-store.js), never a monitored cluster.
 *
 * Every call goes through `bridge` and never throws. A desktop core answers
 * `{ok:false, supported:false}`; a core too old to know the message answers
 * `{ok:false, unknown:true}`. Either way the panel is simply absent — the page asks
 * `isSupported(ping)` first (PING carries `dataRouting.supported`).
 *
 * The core decides what each kind's status is (`state` / `line`: one definition, in
 * data_routing.rs); these helpers only format what it said. Unknown is not zero: a size the
 * core could not read, a document count the store did not answer, is shown as unknown with
 * the core's reason, never as 0.
 */

import { bridge } from './transport.js';
import { isUnknownType } from './volume-config.js';
import { bytes, num } from '../lib/fmt.js';

/** The kinds, in the order the Backend table shows them, with the board's wording. */
export const KINDS = [
  ['history', 'History', 'volume, capacity, log delay records'],
  ['reports', 'Reports', 'generated files and job history'],
  ['alerts', 'Alerts', 'raised, acknowledged, silenced, cleared'],
];
export const MODES = [
  ['builtin', 'ElasticPro built-in'],
  ['copy', 'ElasticPro + Elasticsearch (copy)'],
  ['es', 'Elasticsearch only'],
];
export const DEFAULT_MODE = 'builtin';
/** The one-line rule under the table (the approved board's words). */
/** Beside the *Carry the file* switch: what a reader of the store's report indices then sees. */
export const REPORT_FILES_NOTE = 'With the file carried, anyone who can read <prefix>-reports-* on the Elasticsearch store sees every cluster\'s report content (never a credential). Files up to 2 MB are carried; larger ones are named only.';
export const ES_ONLY_NOTE = '"Elasticsearch only" needs the cluster below to be connected and writing; until it is, ElasticPro keeps writing to its built-in store so nothing is lost.';

async function send(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { return { ok: false, message: e.message || String(e) }; }
  if (isUnknownType(res)) return { ok: false, unknown: true, supported: false, message: 'This server does not route its records' };
  return res || { ok: false, message: 'the core did not answer' };
}

export const routingGet = () => send({ type: 'DATA_ROUTING_GET' });
/** `routing` names only the fields to change: `{history?, reports?, alerts?, reportFiles?}`. */
export const routingSet = (routing) => send({ type: 'DATA_ROUTING_SET', routing });
export const routingStatus = () => send({ type: 'DATA_ROUTING_STATUS' });
/** A page reporting the alerts it saw raised and cleared: `[{event, key, rule?, level?, at?, approx?}]`. */
export const alertEventsPut = (events) => send({ type: 'ALERT_EVENTS_PUT', events });

/** Is the Backend panel offered at all? Only a hosted core says so in PING. */
export const isSupported = (ping) => !!(ping && ping.dataRouting && ping.dataRouting.supported);

export function modeLabel(mode) {
  const m = MODES.find(([id]) => id === mode);
  return m ? m[1] : MODES[0][1];
}

/** A mode string from the core, or the default when it is not one. */
export const modeOf = (routing, kind) => {
  const m = routing && routing[kind];
  return MODES.some(([id]) => id === m) ? m : DEFAULT_MODE;
};

/**
 * The Status cell for one kind of `DATA_ROUTING_STATUS.kinds`: the core's line and a tone for
 * it — `ok` writing or built-in only, `warn` queued or paused (the store cannot be written now).
 */
export function statusCell(kindStatus) {
  const k = kindStatus || {};
  const state = k.state || 'builtin';
  const tone = state === 'writing' || state === 'builtin' ? 'ok' : state === 'queued' || state === 'paused' ? 'warn' : 'muted';
  return { tone, text: k.line || (state === 'builtin' ? 'ElasticPro built-in only' : state) };
}

/** The Kept for cell: the built-in retention, and the store's when the kind goes there. */
export function keptForCell(kindStatus) {
  const k = kindStatus || {};
  const kept = k.keptFor || {};
  const builtin = kept.builtin || 'as today';
  if (k.mode === 'es' || k.mode === 'copy') return `${builtin} · Elasticsearch: ${kept.store || "owner's ILM"}`;
  return builtin;
}

/**
 * The Size now cell: the built-in bytes (a floor when the walk was cut short) and, when the
 * kind goes to the store, its document count — or why it is not known.
 */
export function sizeCell(kindStatus) {
  const k = kindStatus || {};
  const b = (k.builtin && k.builtin.size) || {};
  const local = b.bytes == null ? 'unknown' : `${b.truncated ? 'at least ' : ''}${bytes(b.bytes)}`;
  if (k.mode !== 'es' && k.mode !== 'copy') return local;
  const s = k.store || {};
  const remote = s.docs == null ? `Elasticsearch: ${s.docsNote || 'unknown'}` : `${num(s.docs)} documents in Elasticsearch`;
  return `${local} · ${remote}`;
}

/** The built-in card's size line: the data directory and the free space on its disk. */
export function builtinLine(status) {
  const b = (status && status.builtin) || {};
  const size = b.size || {};
  const used = size.bytes == null ? 'size unknown' : `${size.truncated ? 'at least ' : ''}${bytes(size.bytes)}`;
  const free = b.diskFree == null ? 'free space unknown' : `${bytes(b.diskFree)} free on that disk`;
  return `${used} · ${free}`;
}

/**
 * The amber line when something is routed "Elasticsearch only" and the store is not writing:
 * the core's reason, once, whatever the number of kinds affected. '' when nothing is amiss.
 */
export function esOnlyWarning(status) {
  const kinds = (status && status.kinds) || {};
  const queued = Object.values(kinds).filter((k) => k && k.mode === 'es' && k.state === 'queued');
  if (!queued.length) return '';
  const why = (queued[0].store && queued[0].store.why) || 'the store is not writing';
  const n = queued.reduce((a, k) => a + ((k.store && k.store.queued) || 0), 0);
  return `Not writing to Elasticsearch: ${why}. ElasticPro keeps writing to its built-in store meanwhile · ${num(n)} queued.`;
}
