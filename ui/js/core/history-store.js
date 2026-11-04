/**
 * Config › History store: the messages and the pure helpers (docs/HISTORY.md).
 *
 * Every call goes through `bridge` and never throws. A desktop core answers
 * `{ok:false, supported:false}`; a core too old to know the message answers
 * `{ok:false, unknown:true}`. Either way the section is simply absent.
 */

import { bridge } from './transport.js';
import { isUnknownType } from './volume-config.js';

export const DEFAULT_PREFIX = 'elasticpro-history';
export const STREAMS = ['volume', 'capacity', 'delay'];
export const TLS_CHOICES = [
  ['auto', 'Verify (OS trust store or a pinned certificate)'],
  ['system', 'System certificate authorities only'],
  ['insecure', 'Do not verify'],
];
export const AUTH_CHOICES = [['basic', 'User and password'], ['apiKey', 'API key'], ['none', 'None']];
export const PERMIT_HINT = 'set HISTORY_STORE_WRITES=true in config.txt';

async function send(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { return { ok: false, message: e.message || String(e) }; }
  if (isUnknownType(res)) return { ok: false, unknown: true, supported: false, message: 'This server does not have a history store' };
  return res || { ok: false, message: 'the core did not answer' };
}

export const historyGet = () => send({ type: 'HISTORY_STORE_GET' });
export const historySet = (settings) => send({ type: 'HISTORY_STORE_SET', settings });
export const historyTest = () => send({ type: 'HISTORY_STORE_TEST' });
export const historyArm = (on) => send({ type: 'HISTORY_STORE_ARM', on: !!on });
export const historyBackfill = () => send({ type: 'HISTORY_STORE_BACKFILL' });

/** Is the card offered at all? Only a hosted core says `supported: true`. */
export const isSupported = (reply) => !!(reply && reply.supported);

/**
 * Why Write history cannot be turned on, or '' when it can. Turning it off is always
 * allowed, so an armed store is never blocked. A missing permission names the setting
 * that fixes it (the core's `permitHint`, with the known text as the fallback).
 */
export function armReason(reply) {
  if (!reply || reply.armed) return '';
  if (reply.permitted === false) return (reply.permitHint || PERMIT_HINT);
  if (reply.armBlocked) return String(reply.armBlocked);
  return '';
}

const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : 'not checked');

/** The privilege lines of a test, `on <prefix>-*`. null is "not checked", never "no". */
export function privilegeLines(test, prefix) {
  if (!test || !test.privileges) return [];
  const p = test.privileges;
  const on = `${prefix || DEFAULT_PREFIX}-*`;
  const lines = [
    `create_doc on ${on}: ${yesNo(p.create_doc)}`,
    `create_index on ${on}: ${yesNo(p.create_index)}`,
    `read on ${on}: ${yesNo(p.read)}`,
  ];
  // The cluster privilege the index template needs; a core that did not ask leaves it out.
  if ('manage_index_templates' in p) lines.push(`manage_index_templates (cluster): ${yesNo(p.manage_index_templates)}`);
  if (test.securityEnabled === false) lines.push('security is not enabled on the store');
  return lines;
}

/** The headline of a test result: the version and cluster on success, the message on failure. */
export function testHeadline(test) {
  if (!test) return 'not tested yet';
  if (!test.ok) return `failed: ${test.message || 'no reason given'}`;
  const bits = [];
  if (test.version) bits.push(`version ${test.version}`);
  if (test.clusterName) bits.push(`cluster ${test.clusterName}`);
  return bits.length ? `ok, ${bits.join(', ')}` : 'ok';
}

/** Does the last test no longer describe the saved settings? */
export const testIsStale = (test) => !!(test && test.current === false);

/** The password field's placeholder: never the secret, only whether one is held. */
export function secretHint(settings) {
  const s = settings || {};
  if (s.passwordStale) return 'the store’s address changed: type the password again';
  if (s.passwordSet) return 'set — leave empty to keep it';
  return '';
}

/** The index names a prefix produces, for the hint under the field. */
export function indexNames(prefix) {
  const p = (prefix || '').trim() || DEFAULT_PREFIX;
  return STREAMS.map((s) => `${p}-${s}-YYYY.MM`);
}

/** One line for the backfill's progress; '' when it has never run. */
export function backfillLine(b) {
  if (!b) return '';
  if (b.running) return `copying: ${b.done || 0} of ${b.total || '?'} · ${b.docs || 0} documents`;
  if (b.error) return `stopped: ${b.error}`;
  if (b.finishedAt) return `done: ${b.docs || 0} documents`;
  return '';
}

/** The delay card's destination: anything but "history" is the monitored cluster, as before. */
export const destinationOf = (config) => (config && config.destination === 'history' ? 'history' : 'cluster');

/** The one-line warning on the delay card when the history store is not ready, else ''. */
export function destinationWarning(config, historyStore) {
  if (destinationOf(config) !== 'history') return '';
  const hs = historyStore || {};
  if (!hs.configured) return 'The history store is not configured yet: nothing will be written.';
  if (hs.permitted === false) return `The history store does not permit writes: ${PERMIT_HINT}.`;
  if (!hs.armed) return 'Write history is switched off on the history store: nothing will be written.';
  return '';
}

/** A daily or monthly row that came from the store. */
export const fromHistory = (row) => !!(row && row.source === 'history');

/** "Days A to B: in the history store · not reachable", or '' when the store answered or was not asked. */
export function historyUnreachableLine(history) {
  if (!history || history.reachable !== false) return '';
  return `Days ${history.from} to ${history.to}: in the history store · not reachable`;
}
