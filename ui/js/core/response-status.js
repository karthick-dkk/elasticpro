/**
 * What a REST console response is called and what colour it gets — one definition, used by
 * the status pill beside Run and by the history rows, so the two can never disagree.
 *
 *   label  "HTTP 200" when the cluster answered, else the failure's kind ("tunnel_error",
 *          "blocked_readonly"), else "error"; "—" before anything has run.
 *   tone   a pill class: green 2xx · yellow (amber) 3xx/4xx and a refusal by the core's
 *          read-only guard · red 5xx and anything that never got an answer · grey, no run.
 */

export function responseStatus(r) {
  if (!r) return { label: '—', tone: 'grey' };
  const s = Number(r.status) || 0;
  if (!s) return { label: r.kind || 'error', tone: r.kind === 'blocked_readonly' ? 'yellow' : 'red' };
  return { label: `HTTP ${s}`, tone: s < 300 ? 'green' : s < 500 ? 'yellow' : 'red' };
}

/** The answer's size in bytes as the console counts it: the JSON re-serialised, else the text. */
export function responseSize(r) {
  if (!r) return 0;
  if (r.json !== null && r.json !== undefined) return JSON.stringify(r.json).length;
  return String(r.text || '').length;
}
