/**
 * Alert silences, as the page sees them: the team's list, kept on the server (SILENCE_*,
 * crates/elasticpro-core/src/silences.rs), and the predicate that leaves silenced alerts
 * out of every open count. Nothing here is stored in the browser.
 */
import { bridge } from './transport.js';
import { bus, setSilencePredicate } from './state.js';

let list = [];

const clusterIdOf = (a) => (a && a.cluster && a.cluster.id) || String((a && a.key) || '').split(':')[0];

/** The live silence that covers this alert, if any — its own, else its cluster's. */
export function silenceFor(a, now = Date.now()) {
  const live = (s) => !s.until || s.until > now;
  return list.find((s) => live(s) && s.scope === 'alert' && s.target === a.key)
    || list.find((s) => live(s) && s.scope === 'cluster' && s.target === clusterIdOf(a))
    || null;
}
export function silences() { return list.filter((s) => !s.until || s.until > Date.now()); }

function take(res) {
  if (res && res.ok && Array.isArray(res.silences)) {
    list = res.silences;
    setSilencePredicate((a) => !!silenceFor(a));
    bus.emit('alerts-changed');
  }
  return res;
}

export async function loadSilences() {
  try { return take(await bridge({ type: 'SILENCE_LIST' })); } catch (_) { return null; }
}
/** `minutes` null = until removed. */
export async function silence(scope, target, minutes, reason = '') {
  return take(await bridge({ type: 'SILENCE_SET', scope, target, ...(minutes ? { minutes } : {}), reason }));
}
export async function unsilence(id) {
  return take(await bridge({ type: 'SILENCE_CLEAR', id }));
}

/** The durations offered, in minutes (null = until removed). */
export const SILENCE_FOR = [['1 hour', 60], ['8 hours', 480], ['24 hours', 1440], ['7 days', 10080], ['Until removed', null]];
