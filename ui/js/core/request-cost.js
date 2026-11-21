/**
 * Jobs › Requests › Cost (docs/JOBS.md "Query cost"), the pure half: the REQUEST_COST answer as
 * the tab draws it — per cluster and kind, requests per hour, average and p95 time, bytes,
 * timeouts and deferrals, and the slowest requests. No DOM, no network (tools/unit/
 * request-cost.test.mjs); pages/requests-cost.js draws it.
 *
 * Unknown is not zero: a time with no request is "—", bytes no answer reported are "not
 * reported", never 0 B.
 */

/** The tab reads REQUEST_COST at most this often, and only while it is open. */
export const COST_POLL_MS = 30_000;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** A time: "85 ms", "1.2 s", "1m 05s"; null is "—". */
export function msText(ms) {
  const v = num(ms);
  if (v === null) return '—';
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
  const s = Math.round(v / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Bytes: "812 B", "4.1 KB", "12.3 MB"; null is "not reported". */
export function bytesText(n) {
  const v = num(n);
  if (v === null) return 'not reported';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = v; let i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
  return i === 0 ? `${Math.round(x)} B` : `${x.toFixed(x < 10 ? 1 : 0)} ${u[i]}`;
}

/** Requests per hour: "12", "0.4". */
export const perHourText = (v) => (num(v) === null ? '—' : num(v) >= 10 ? String(Math.round(num(v))) : String(Math.round(num(v) * 10) / 10));

/**
 * The table's rows, from the answer's `rows`, with the cluster's name (`nameOf`): every figure
 * kept as the core sent it (null stays null) and the words beside it.
 */
export function costRows(answer, nameOf = (id) => id) {
  return ((answer && Array.isArray(answer.rows)) ? answer.rows : []).map((r) => ({
    ...r, name: nameOf(r.cluster), label: r.label || r.kind,
    avgMs: num(r.avgMs), p95Ms: num(r.p95Ms), bytes: num(r.bytes), perHour: num(r.perHour),
    requests: num(r.requests) || 0, timeouts: num(r.timeouts) || 0, deferrals: num(r.deferrals) || 0,
  }));
}

/** The figures over the whole answer, for the line above the table: requests, timeouts, deferrals, clusters. */
export function costTotals(rows) {
  const t = { requests: 0, timeouts: 0, deferrals: 0, clusters: new Set() };
  for (const r of rows || []) { t.requests += r.requests || 0; t.timeouts += r.timeouts || 0; t.deferrals += r.deferrals || 0; t.clusters.add(r.cluster); }
  return { requests: t.requests, timeouts: t.timeouts, deferrals: t.deferrals, clusters: t.clusters.size };
}

/** The window in words: "over the last 24 h", or "since 09:14 (2.5 h)" when the server has kept less. */
export function windowText(answer, clock = (ms) => new Date(ms).toTimeString().slice(0, 5)) {
  if (!answer) return '';
  const keep = num(answer.keepHours) || 24;
  const hours = num(answer.hours);
  if (hours === null || hours >= keep - 0.05) return `over the last ${keep} h`;
  const since = num(answer.since);
  return `since ${since === null ? 'the server started' : clock(since)} (${hours} h)`;
}

/** The top list's rows, slowest first as the core sent them, with names. */
export function topRows(answer, nameOf = (id) => id) {
  return ((answer && Array.isArray(answer.top)) ? answer.top : []).map((t) => ({ ...t, name: nameOf(t.cluster), label: t.label || t.kind }));
}
