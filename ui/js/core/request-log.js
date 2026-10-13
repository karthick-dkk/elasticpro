/**
 * The Request Centre's model: the core's request log, filtered and shaped for a table and
 * a CSV. Pure, so the rules are testable without a page: what a row says about a request
 * is decided here once, and the table and the export agree.
 */

/** Filters the page offers. Empty / 'all' means "no filter". */
export const NO_FILTER = { cluster: 'all', origin: 'all', outcome: 'all', slowerThanMs: 0 };

/** `poller:health` → "poller · health"; `page:indices` → "Indices page"; `console` → "REST console". */
export function originLabel(origin) {
  const o = String(origin || 'core');
  if (o.startsWith('page:')) {
    const id = o.slice(5);
    return `${id.charAt(0).toUpperCase()}${id.slice(1)} page`;
  }
  if (o.startsWith('poller:')) return `poller · ${o.slice(7)}`;
  if (o === 'console') return 'REST console';
  return o;
}

/** "200", "timeout", "unreachable" … or "in flight" with how long so far. */
export function outcomeLabel(r, now = Date.now()) {
  if (r.ms == null) return `in flight · ${Math.max(0, now - (r.startedAt || now))} ms so far`;
  return r.status || (r.ok ? 'ok' : 'error');
}

/** Which bucket a record falls in for the outcome filter. */
export function outcomeOf(r) {
  if (r.ms == null) return 'inflight';
  if (r.ok) return 'ok';
  return /^[45]\d\d$/.test(String(r.status || '')) ? 'http-error' : 'failed';
}

/**
 * Rows for the table: in-flight first (oldest first, so the one stuck longest is on top),
 * then finished newest first, after the filters.
 */
export function requestRows(log, f = NO_FILTER, now = Date.now()) {
  const inflight = [...(log.inflight || [])].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const recent = [...(log.recent || [])];
  const keep = (r) => (f.cluster === 'all' || r.cluster === f.cluster)
    && (f.origin === 'all' || r.origin === f.origin || (f.origin === 'poller' && String(r.origin).startsWith('poller:')))
    && (f.outcome === 'all' || outcomeOf(r) === f.outcome)
    && (!f.slowerThanMs || (r.ms == null ? now - (r.startedAt || now) : r.ms) >= f.slowerThanMs);
  return [...inflight, ...recent].filter(keep).map((r) => ({
    ...r, inflight: r.ms == null, elapsedMs: r.ms == null ? Math.max(0, now - (r.startedAt || now)) : r.ms,
    originLabel: originLabel(r.origin), outcome: outcomeLabel(r, now),
  }));
}

/** The distinct origins in a log, for the filter — pollers collapsed into one entry. */
export function originChoices(log) {
  const set = new Set();
  for (const r of [...(log.inflight || []), ...(log.recent || [])]) set.add(String(r.origin).startsWith('poller:') ? 'poller' : r.origin);
  return [...set].sort();
}

/** Per-cluster totals over what the log holds: count, in flight, failed, slowest ms. */
export function perCluster(log) {
  const out = {};
  for (const r of [...(log.inflight || []), ...(log.recent || [])]) {
    const c = out[r.cluster] || (out[r.cluster] = { cluster: r.cluster, count: 0, inflight: 0, failed: 0, slowestMs: 0 });
    c.count++;
    if (r.ms == null) c.inflight++;
    else { if (!r.ok) c.failed++; if (r.ms > c.slowestMs) c.slowestMs = r.ms; }
  }
  return Object.values(out).sort((a, b) => b.count - a.count);
}

export const CSV_HEADER = ['started', 'cluster', 'origin', 'method', 'path', 'ms', 'outcome', 'via', 'id'];

/** The same rows as the table, as CSV cells (started as ISO time). */
export function requestCsvRows(rows) {
  return rows.map((r) => [new Date(r.startedAt || 0).toISOString(), r.cluster, r.origin, r.method, r.path,
    r.inflight ? '' : String(r.ms), r.inflight ? 'in flight' : r.outcome, r.via || '', String(r.id)]);
}
