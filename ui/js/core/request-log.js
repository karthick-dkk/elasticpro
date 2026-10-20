/**
 * The Request Centre's model: the core's request log, filtered and shaped for a table and
 * a CSV. Pure, so the rules are testable without a page: what a row says about a request
 * is decided here once, and the table and the export agree.
 */

/** Filters the page offers. Empty / 'all' means "no filter". */
export const NO_FILTER = { cluster: 'all', origin: 'all', outcome: 'all', slowerThanMs: 0 };

/** The gate's refusals: nothing was sent to the cluster (errors.rs EP-214, EP-215). */
export const REFUSED = new Set(['overloaded', 'queue_timeout']);

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

/** "200", "timeout", "overloaded" … or, in flight, what it is doing and for how long. */
export function outcomeLabel(r, now = Date.now()) {
  if (r.ms == null) {
    const so = `${Math.max(0, now - (r.startedAt || now))} ms so far`;
    if (r.state === 'queued') return `queued · ${so}`;
    if (r.state === 'shared') return `waiting on #${r.leader} · ${so}`;
    return `in flight · ${so}`;
  }
  return r.status || (r.ok ? 'ok' : 'error');
}

/** Which bucket a record falls in for the outcome filter. */
export function outcomeOf(r) {
  if (r.ms == null) return r.state === 'queued' ? 'queued' : 'inflight';
  if (r.ok) return 'ok';
  if (REFUSED.has(String(r.status || ''))) return 'refused';
  return /^[45]\d\d$/.test(String(r.status || '')) ? 'http-error' : 'failed';
}

/** "shared", "cached 2.1 s old" — how a request was answered without going to the cluster. */
export function answeredBy(r) {
  if (r.cached) return `cached${r.ageMs != null ? ` ${(r.ageMs / 1000).toFixed(1)} s old` : ''}`;
  if (r.shared) return r.leader != null ? `shared #${r.leader}` : 'shared';
  return '';
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
    && (f.outcome === 'all' || outcomeOf(r) === f.outcome || (f.outcome === 'inflight' && outcomeOf(r) === 'queued'))
    && (!f.slowerThanMs || (r.ms == null ? now - (r.startedAt || now) : r.ms) >= f.slowerThanMs);
  return [...inflight, ...recent].filter(keep).map((r) => ({
    ...r, inflight: r.ms == null, elapsedMs: r.ms == null ? Math.max(0, now - (r.startedAt || now)) : r.ms,
    originLabel: originLabel(r.origin), outcome: outcomeLabel(r, now), answeredBy: answeredBy(r),
  }));
}

/** The distinct origins in a log, for the filter — pollers collapsed into one entry. */
export function originChoices(log) {
  const set = new Set();
  for (const r of [...(log.inflight || []), ...(log.recent || [])]) set.add(String(r.origin).startsWith('poller:') ? 'poller' : r.origin);
  return [...set].sort();
}

/** Per-cluster totals over what the log holds: count, in flight, queued, failed, refused, slowest ms. */
export function perCluster(log) {
  const out = {};
  for (const r of [...(log.inflight || []), ...(log.recent || [])]) {
    const c = out[r.cluster] || (out[r.cluster] = { cluster: r.cluster, count: 0, inflight: 0, queued: 0, failed: 0, refused: 0, slowestMs: 0 });
    c.count++;
    if (r.ms == null) { c.inflight++; if (r.state === 'queued') c.queued++; }
    else if (REFUSED.has(String(r.status || ''))) c.refused++;
    else { if (!r.ok) c.failed++; if (r.ms > c.slowestMs) c.slowestMs = r.ms; }
  }
  return Object.values(out).sort((a, b) => b.count - a.count);
}

/**
 * The four gate tiles, from REQUEST_LOG's `gate` block. A core that does not send one (an
 * older core) has not measured these: every figure is null, never 0.
 */
export function gateFigures(log) {
  const g = log && log.gate;
  if (!g) return { known: false, queued: null, waitP95Ms: null, refused: null, sharedOrCached: null, oldestWaitMs: null };
  const w = (g.waits && g.waits.interactive) || {};
  return {
    known: true,
    queued: g.queued ? g.queued.total : null,
    oldestWaitMs: g.oldestWaitMs ?? null,
    waitP95Ms: w.p95Ms ?? null,
    waitCount: w.count ?? 0,
    refused: g.refused ? g.refused.total : null,
    overloaded: g.refused ? g.refused.overloaded : null,
    queueTimeout: g.refused ? g.refused.queueTimeout : null,
    sharedOrCached: (g.shared ?? 0) + (g.cacheHits ?? 0),
    shared: g.shared ?? 0,
    cacheHits: g.cacheHits ?? 0,
    limits: g.limits || null,
  };
}

export const CSV_HEADER = ['started', 'cluster', 'origin', 'class', 'method', 'path', 'queuedMs', 'ms', 'outcome', 'answeredBy', 'via', 'id'];

/** The same rows as the table, keyed by CSV_HEADER for toCsv (started as ISO time). */
export function requestCsvRows(rows) {
  return rows.map((r) => ({
    started: new Date(r.startedAt || 0).toISOString(), cluster: r.cluster, origin: r.origin, class: r.class || '',
    method: r.method, path: r.path, queuedMs: r.queuedMs == null ? '' : String(r.queuedMs),
    ms: r.inflight ? '' : String(r.ms), outcome: r.inflight ? (r.state === 'queued' ? 'queued' : 'in flight') : r.outcome,
    answeredBy: r.answeredBy || '', via: r.via || '', id: String(r.id),
  }));
}
