/**
 * Error codes for failures the browser itself finds — the server never answered, or it
 * answered and there is still nothing to show. The core's own refusals arrive with their
 * code already in the message (crates/elasticpro-core/src/errors.rs); this is the same idea
 * for what never reached it.
 *
 * 6xx is the browser's range. The core uses 1xx–5xx, the Zabbix module 7xx; see
 * docs/ERROR-CODES.md for all of them. A code, once given out, keeps its meaning.
 */

export const UI_CODES = {
  worker_error: 'EP-601',   // the request did not reach the ElasticPro server, or no JSON came back
  no_answer: 'EP-602',      // the server answered with nothing usable
  no_clusters: 'EP-603',    // signed in, and no cluster this account may see
  sso_failed: 'EP-604',     // a Zabbix sign-in code could not be traded for a session
  parse_error: 'EP-605',    // the cluster list arrived but does not parse
};

export const UNKNOWN_CODE = 'EP-999';

/** "message (EP-xxx)", once: a message that already ends with its code keeps just the one. */
export function withCode(message, code) {
  const m = String(message || '').trim() || 'failed';
  return m.endsWith(`(${code})`) ? m : `${m} (${code})`;
}

/**
 * A failed reply, made sure to carry a code: the core's when it sent one, the browser's for
 * the kinds above, EP-999 otherwise. A reply that succeeded is returned as it is.
 */
export function stampReply(res) {
  if (!res || res.ok !== false) return res;
  const code = res.code || UI_CODES[res.kind] || UNKNOWN_CODE;
  return { ...res, code, message: withCode(res.message, code) };
}

/** The text to show for a failed reply, with its code, or `fallback` with the browser's code. */
export function errorText(res, fallback, kind = 'no_answer') {
  if (res && res.message) return stampReply({ ok: false, ...res }).message;
  return withCode(fallback, UI_CODES[kind] || UNKNOWN_CODE);
}
