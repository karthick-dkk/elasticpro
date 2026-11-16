/**
 * Answers for VOLUME_DAILY and VOLUME_BREAKDOWN, shaped as docs/VOLUME.md says, for the checks
 * that draw Indices › Summary with a filled record: render-check and behaviour-check (jsdom) and
 * the screenshots. A fresh data directory has no daily record (only a collection fills it, and the
 * mock's 45 days of two sources carry no tag1 spread worth drawing), so the filled page is drawn
 * from this.
 *
 *   volumeAnswer(body, { now, mode }) → a reply object, or null when `body` is not one of ours
 *
 * `mode`: 'full' (default) — 100 days, nine tag1 values, one day missing from the record
 * (41 days ago) so the 60-day tile says "59 of 60 days recorded"; 'empty' — never collected;
 * 'notag' — the days, but the tag field is in no index. Deterministic for the same `now`.
 */

const DAY = 86400000;
export const FIXTURE_TAGS = [['firewall', 0.33], ['vpn', 0.2], ['switch', 0.16], ['proxy', 0.12], ['windows', 0.09],
  ['linux', 0.05], ['dns', 0.025], ['mail', 0.015], ['printer', 0.01]];
/** The day left out of the record, in days before today. */
export const GAP_DAYS_AGO = 41;
const KEPT_DAYS = 100;

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
/** 0.8 .. 1.2, the same every time for the same key. */
function wobble(key) {
  let x = 7;
  for (const ch of String(key)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return 0.8 + (x % 401) / 1000;
}

/** One day row, `n` days before today; null for the day the record does not have. */
function row(n, now) {
  if (n === GAP_DAYS_AGO) return null;
  const day = ymd(now - n * DAY);
  const f = wobble(day) * (n === 0 ? 0.55 : 1);
  const pri = Math.round(3.4e12 * f);
  const docs = Math.round(1.4e9 * f);
  return {
    day, final: n > 0, live: true, totalsAt: now - 20 * 60000, aggregatedAt: now - 20 * 60000, error: null,
    indices: 60 + (n % 4), docs, priBytes: pri, totalBytes: pri * 2, eventBytes: Math.round(pri * 0.4), subBytes: null,
    unmeasuredSizeIndices: 0, basis: pri, avg: null, changeVsAvgPct: null,
    top: { tag: { value: 'firewall', docs: Math.round(docs * 0.33), share: 0.33 }, forwarder: null, sourceHost: null, sourceIp: null, extra: null },
  };
}

/** A day's documents per tag1 value: shares that move a little day to day, summing to the day's documents. */
function tagDocs(r) {
  const raw = FIXTURE_TAGS.map(([v, s]) => [v, s * wobble(`${r.day}|${v}`)]);
  const sum = raw.reduce((a, [, s]) => a + s, 0);
  let left = r.docs;
  return raw.map(([v, s], i) => {
    const n = i === raw.length - 1 ? left : Math.round((r.docs * s) / sum);
    left -= n;
    return [v, n];
  });
}

export function volumeAnswer(body, { now = Date.now(), mode = 'full' } = {}) {
  const t = body && body.type;
  const settings = { sizeBasis: 'primary', tag: ['tag1', 'labels.tag1', 'tags'], eventSize: ['event_logsize'] };
  if (t === 'VOLUME_DAILY') {
    const days = Math.min(Number(body.days) || 30, KEPT_DAYS);
    const status = { lastRunAt: mode === 'empty' ? null : now - 20 * 60000, nextRunAt: null, running: false, progress: null, lastError: null, collectAt: '06:00' };
    const rows = mode === 'empty' ? [] : Array.from({ length: days }, (_, n) => row(n, now)).filter(Boolean);
    return { ok: true, settings, status, cards: {}, days: rows, totals: {}, sources: [], skipped: [], matched: mode === 'empty' ? 0 : 62,
      timeSplit: 0, newestDay: rows.length ? rows[0].day : null, window: { days } };
  }
  if (t === 'VOLUME_BREAKDOWN') {
    const from = body.from, to = body.to;
    const top = Math.max(1, Number(body.top) || 25);
    const inRange = Array.from({ length: KEPT_DAYS }, (_, n) => row(n, now)).filter((r) => r && r.day >= from && r.day <= to);
    if (mode === 'notag' || !inRange.length) {
      return { ok: true, field: body.field, resolved: null, resolvedAll: [], rows: [],
        totals: { docs: 0, priBytes: 0, estPriBytes: 0, days: 0, sizeUnmeasuredDays: 0 },
        error: mode === 'notag' ? 'no field of tag1, labels.tag1, tags in the mapping' : 'no aggregated day in this period' };
    }
    const acc = new Map();
    let docs = 0, pri = 0;
    for (const r of inRange) {
      docs += r.docs; pri += r.priBytes;
      for (const [v, n] of tagDocs(r)) {
        const a = acc.get(v) || { docs: 0, est: 0, days: 0 };
        a.docs += n; a.est += (n / r.docs) * r.priBytes; a.days += n > 0 ? 1 : 0;
        acc.set(v, a);
      }
    }
    const ranked = [...acc.entries()].sort((a, b) => b[1].docs - a[1].docs || (a[0] < b[0] ? -1 : 1));
    const kept = ranked.slice(0, top);
    const other = ranked.slice(top).reduce((o, [, a]) => ({ docs: o.docs + a.docs, est: o.est + a.est, days: Math.max(o.days, a.days) }), { docs: 0, est: 0, days: 0 });
    const est = ranked.reduce((s, [, a]) => s + a.est, 0);
    const out = (value, kind, a) => ({ value, kind, docs: a.docs, eventBytes: null, estPriBytes: Math.round(a.est),
      sharePct: est > 0 ? Math.round((a.est / est) * 10000) / 100 : null, daysSeen: a.days });
    return { ok: true, field: body.field, resolved: 'tag1', resolvedAll: ['tag1'], clusterId: body.clusterId, period: { from, to },
      rows: [...kept.map(([v, a]) => out(v, 'value', a)), out('(not set)', 'missing', { docs: 0, est: 0, days: 0 }), out('all others', 'other', other)],
      totals: { docs, priBytes: pri, estPriBytes: Math.round(est), days: inRange.length, sizeUnmeasuredDays: 0 } };
  }
  if (t === 'VOLUME_RUN') return { ok: true, started: [], already: [], tooSoon: body.clusterIds || [], skipped: [] };
  return null;
}
