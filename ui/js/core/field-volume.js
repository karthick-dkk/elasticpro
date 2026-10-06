/**
 * Per-field volume analysis: how much each `tag1` or `src_hostname` contributes per day,
 * and which of them just jumped.
 *
 * A note on what "volume" means here. Elasticsearch reports store size per INDEX, never
 * per field value — there is no way to ask how many bytes a given tag occupies. What it
 * will tell you is document counts, so the byte figure is an ESTIMATE: a term's share of
 * a day's documents, applied to that day's index size. It is labelled as an estimate
 * everywhere it is shown, and the document counts beside it are exact.
 */

import { client, state } from './state.js';

/** The window a spike is judged against, and how far above it counts as one. */
export const SPIKE_WINDOW_DAYS = 7;
export const SPIKE_THRESHOLD = 1.4;        // more than 40% above the window mean

/**
 * Days are UTC throughout, and that has to be consistent.
 *
 * date_histogram buckets in UTC unless told otherwise, and index names carry a UTC date,
 * so bucket keys are read as UTC. Deriving "today" from local parts instead would shift
 * the comparison by a day for anyone east or west of UTC — in +05:30 the partial current
 * bucket is labelled yesterday, and every term looks like it collapsed.
 */
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayYmd = () => new Date().toISOString().slice(0, 10);

/**
 * One search per field: terms, each split by day, plus the day totals so a term's share
 * can be turned into an estimated size.
 */
function body(field, timeField, days, topN) {
  return {
    size: 0,
    query: { range: { [timeField]: { gte: `now-${days}d/d`, lte: 'now/d' } } },
    aggs: {
      terms: {
        terms: { field, size: topN, missing: '(not set)', order: { _count: 'desc' } },
        aggs: {
          per_day: {
            date_histogram: { field: timeField, calendar_interval: '1d', min_doc_count: 0 },
          },
        },
      },
      per_day_total: {
        date_histogram: { field: timeField, calendar_interval: '1d', min_doc_count: 0 },
      },
    },
  };
}

/** Bytes on disk for each day, from the index list the Indices page already holds. */
function bytesByDay(clusterId) {
  const out = new Map();
  for (const r of state.indices.get(clusterId) || []) {
    if (!r.day) continue;
    out.set(r.day, (out.get(r.day) || 0) + (r.size || 0));
  }
  return out;
}

/**
 * @returns {Promise<{field:string, resolvedField:string, days:string[], terms:Array, error:string|null}>}
 */
export async function fetchFieldVolume(cluster, { field, days = 14, topN = 12 } = {}) {
  const cl = client(cluster.id);
  if (!cl) return { field, resolvedField: field, days: [], terms: [], error: 'cluster not connected' };

  const timeField = cluster.timeField || '@timestamp';
  const pattern = cluster.logIndexPattern || '*';
  const qs = 'ignore_unavailable=true&allow_no_indices=true';

  let res = null, resolvedField = field, error = null;
  for (const candidate of [field, `${field}.keyword`]) {
    try {
      res = await cl.search(pattern, body(candidate, timeField, days, topN), { qs, timeoutMs: 45000 });
      resolvedField = candidate;
      error = null;
      break;
    } catch (e) {
      // A text field cannot be aggregated; the usual fix is its .keyword sub-field, so
      // that is tried once before giving up.
      error = e.message || String(e);
      if (!/fielddata|not supported|illegal_argument/i.test(error)) break;
    }
  }
  if (!res) return { field, resolvedField, days: [], terms: [], error: error || 'no response' };

  const aggs = res.aggregations || {};
  const totalBuckets = (aggs.per_day_total && aggs.per_day_total.buckets) || [];
  const totalByDay = new Map(totalBuckets.map((b) => [ymd(b.key), b.doc_count]));
  const dayList = totalBuckets.map((b) => ymd(b.key));
  const sizeByDay = bytesByDay(cluster.id);
  const today = todayYmd();

  const terms = ((aggs.terms && aggs.terms.buckets) || []).map((t) => {
    const series = ((t.per_day && t.per_day.buckets) || []).map((b) => {
      const day = ymd(b.key);
      const total = totalByDay.get(day) || 0;
      const share = total > 0 ? b.doc_count / total : 0;
      return {
        day,
        docs: b.doc_count,
        // Estimate only — see the note at the top of this file.
        bytes: Math.round((sizeByDay.get(day) || 0) * share),
      };
    });
    return { term: String(t.key), docs: t.doc_count, series, ...spike(series, today) };
  });

  return { field, resolvedField, days: dayList, terms, error: null, timeField, pattern };
}

/**
 * Has this term just jumped?
 *
 * The latest COMPLETE day is compared with the mean of the seven days before it. Today is
 * excluded on both sides — it is partial, and would make every term look like it collapsed.
 */
export function spike(series, today = todayYmd()) {
  const complete = series.filter((p) => p.day < today);
  if (complete.length < 2) return { latest: null, baseline: null, changePct: null, spiked: false, latestDay: null };

  const latest = complete[complete.length - 1];
  const window = complete.slice(Math.max(0, complete.length - 1 - SPIKE_WINDOW_DAYS), complete.length - 1);
  if (!window.length) return { latest, baseline: null, changePct: null, spiked: false, latestDay: latest.day };

  const baseline = window.reduce((s, p) => s + p.docs, 0) / window.length;
  const changePct = baseline > 0 ? ((latest.docs - baseline) / baseline) * 100 : null;
  return {
    latest,
    baseline,
    baselineDays: window.length,
    changePct,
    // A term with no history to speak of is not a spike, however large it looks.
    spiked: baseline > 0 && latest.docs > baseline * SPIKE_THRESHOLD,
    latestDay: latest.day,
  };
}

/* --------------------------- results shared with alerts ------------------------- */

/**
 * The last analysis per cluster, so the Alerts page can raise a spike without re-running
 * the search. Cleared when the config changes, like everything else derived from it.
 */
const results = new Map();   // clusterId -> { at, byField: { field -> analysis } }

export function storeFieldVolume(clusterId, field, analysis) {
  const cur = results.get(clusterId) || { at: 0, byField: {} };
  cur.byField[field] = analysis;
  cur.at = Date.now();
  results.set(clusterId, cur);
}

export function fieldVolumeFor(clusterId) { return results.get(clusterId) || null; }
export function clearFieldVolume(clusterId) {
  if (clusterId) results.delete(clusterId); else results.clear();
}

/** Every spiking term across every cluster analysed so far. */
export function fieldVolumeSpikes() {
  const out = [];
  for (const [clusterId, rec] of results) {
    for (const [field, a] of Object.entries(rec.byField || {})) {
      for (const t of a.terms || []) {
        if (t.spiked) out.push({ clusterId, field, ...t });
      }
    }
  }
  return out;
}
