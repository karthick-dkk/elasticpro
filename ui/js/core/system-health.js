/**
 * ElasticPro's own health (docs/HEALTH.md) — the pure half of the Request Centre's
 * *ElasticPro health* tab and of the dot on its nav entry. No DOM, no network: the page reads
 * SYSTEM_HEALTH (a core round trip, never a cluster one) and draws what these return.
 *
 * Unknown is not zero: a figure the core could not read arrives as null and is written
 * "not known", never 0 and never green.
 */

/** How often the open tab reads SYSTEM_HEALTH. */
export const HEALTH_POLL_MS = 5000;

/** The Request Centre's tabs, in order. */
export const REQUEST_TABS = Object.freeze([
  { id: 'log', label: 'Requests' },
  { id: 'health', label: 'ElasticPro health' },
]);

const known = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** Which tab a hash opens: `#/requests/health` → 'health', anything else → 'log'. */
export function tabOfHash(hash) {
  const path = String(hash || '').replace(/^#\/?/, '').split('?')[0].split('/');
  return path[0] === 'requests' && path[1] === 'health' ? 'health' : 'log';
}

/** The hash for a tab. */
export const tabHash = (id) => (id === 'health' ? '#/requests/health' : '#/requests');

/** The pill class for a level. */
export function levelTone(level) {
  return level === 'ok' ? 'green' : level === 'warn' ? 'yellow' : level === 'bad' ? 'red' : 'grey';
}

/** A level in words, never "ok" for something that could not report. */
export function levelWord(level) {
  return ({ ok: 'ok', warn: 'amber', bad: 'red', off: 'off', unknown: 'not known' })[level] || 'not known';
}

/**
 * The dot on the Request Centre's nav entry, from PING's `health` (administrators only): null
 * when there is nothing to say (ok, an older core, not an administrator).
 */
export function navDot(ping) {
  const h = ping && ping.health;
  if (h === 'warn') return { tone: 'yellow', title: 'ElasticPro health: something is amber — open Requests › ElasticPro health' };
  if (h === 'bad') return { tone: 'red', title: 'ElasticPro health: something is red — open Requests › ElasticPro health' };
  return null;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
/** Bytes in binary units, one decimal from GB up; null → "not known". */
export function sizeText(n) {
  if (!known(n)) return 'not known';
  let v = Number(n), i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${i >= 3 ? v.toFixed(1) : Math.round(v)} ${UNITS[i]}`;
}

/** Milliseconds as "12 ms" / "1.4 s"; null → "—". */
export function msText(ms) {
  if (!known(ms)) return '—';
  const n = Number(ms);
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} s` : `${Math.round(n)} ms`;
}

/** A percentage, rounded; null → "not known". */
export const pctText = (v) => (known(v) ? `${Math.round(Number(v))}%` : 'not known');

/**
 * Resident memory against its limit, as one line and a bar fraction:
 * "84% · 860 MB of 1.0 GB", "860 MB · no limit", or "not known".
 */
export function memoryLine(m) {
  if (!m || !known(m.rssBytes)) return { text: 'not known', frac: null, pct: null };
  if (!known(m.limitBytes)) return { text: `${sizeText(m.rssBytes)} · no limit`, frac: null, pct: null };
  const pct = known(m.usedPct) ? Number(m.usedPct) : (Number(m.rssBytes) * 100) / Number(m.limitBytes);
  return { text: `${Math.round(pct)}% · ${sizeText(m.rssBytes)} of ${sizeText(m.limitBytes)}`, frac: Math.min(1, pct / 100), pct };
}

/** OOM kills: "none", "2 (1 in 24 h)", or "not known" (no cgroup). */
export function oomText(m) {
  if (!m || !known(m.oomKills)) return 'not known';
  const all = Number(m.oomKills), day = known(m.oomKills24h) ? Number(m.oomKills24h) : null;
  if (!all && !day) return 'none';
  return day === null ? String(all) : `${all} (${day} in 24 h)`;
}

/** CPU over the last minute: "37% of one CPU · 25% of its 1.5" / "not known yet". */
export function cpuLine(c) {
  if (!c || c.readable === false) return 'not known';
  if (!known(c.pct1m)) return 'not known yet';
  const one = `${Math.round(Number(c.pct1m))}% of one CPU`;
  return known(c.limitCpus) ? `${one} · ${pctText(c.pctOfLimit)} of its ${Number(c.limitCpus)}` : `${one} · no CPU limit`;
}

/** Throttling over 5 min: "12% of periods", "no CPU limit", or "not known yet". */
export function throttleLine(c) {
  if (!c || c.readable === false) return 'not known';
  if (known(c.throttledPct5m)) return `${Math.round(Number(c.throttledPct5m))}% of periods`;
  if (!known(c.nrPeriods) && known(c.pct1m)) return 'no CPU limit';
  return 'not known yet';
}

/** "used of budget" for one share of the memory budget; null budget → not known. */
export function shareLine(s) {
  if (!s || !known(s.budgetBytes)) return 'not known';
  return `${sizeText(s.usedBytes)} of ${sizeText(s.budgetBytes)}`;
}

/**
 * One trend column of SYSTEM_HEALTH's `trends` (`fields` names them), as [t, value] pairs with
 * the unknown minutes left out rather than drawn as zero.
 */
export function trendSeries(trends, field) {
  if (!trends || !Array.isArray(trends.points) || !Array.isArray(trends.fields)) return [];
  const i = trends.fields.indexOf(field), t = trends.fields.indexOf('t');
  if (i < 0 || t < 0) return [];
  return trends.points.filter((p) => Array.isArray(p) && known(p[i])).map((p) => [Number(p[t]), Number(p[i])]);
}

/**
 * The polyline of a sparkline `w`×`h` for [t, v] pairs over `spanMs` ending at `now`: a string of
 * "x,y" points, '' with fewer than two.
 */
export function sparkPath(series, { w = 160, h = 28, now = Date.now(), spanMs = 24 * 3600 * 1000 } = {}) {
  if (!series || series.length < 2) return '';
  const max = Math.max(...series.map((p) => p[1]), 1);
  const x0 = now - spanMs;
  return series.map(([t, v]) => {
    const x = Math.max(0, Math.min(w, ((t - x0) / spanMs) * w));
    const y = h - 1 - (v / max) * (h - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

/** Checks that are amber or red, worst first: what the tab lists before anything else. */
export function problems(checks) {
  const rank = { bad: 0, warn: 1 };
  return (checks || []).filter((c) => c.level === 'bad' || c.level === 'warn').sort((a, b) => rank[a.level] - rank[b.level]);
}

/** A job's progress in a few words: "day 2026-11-03 · partitions 3/8 · 12 pages · 4,000 rows". */
export function jobProgress(j) {
  if (!j) return '';
  const bits = [];
  if (j.progress && known(j.progress.total) && Number(j.progress.total) > 0) bits.push(`${j.progress.done}/${j.progress.total}`);
  if (j.day) bits.push(`day ${j.day}`);
  if (j.partitions) bits.push(`partitions ${j.partitions.done}/${j.partitions.total || '?'}`);
  if (known(j.pages)) bits.push(`${Number(j.pages).toLocaleString('en')} pages`);
  if (known(j.rows)) bits.push(`${Number(j.rows).toLocaleString('en')} rows`);
  return bits.join(' · ');
}

/** "3 (halved 1×: 429 from c2)", "not reported" when the job does not carry it. */
export function concurrencyText(j) {
  if (!j || !known(j.concurrency)) return 'not reported';
  const halves = known(j.halvings) && Number(j.halvings) > 0 ? ` (halved ${j.halvings}×${j.lastReason ? `: ${j.lastReason}` : ''})` : '';
  return `${j.concurrency}${halves}`;
}
