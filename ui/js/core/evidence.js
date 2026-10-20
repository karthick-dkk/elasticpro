/**
 * The evidence layout: what Snapshots, the REST console and Indices look like when they
 * are about to be screenshotted for ONE client.
 *
 * One client is one cluster, and a screenshot of the Indices page must not tell that
 * client how many other clusters we look after, which of them are down, or what the alerts
 * on them say. So on these pages — automatically, there is no switch — the shell drops
 * everything fleet-wide and stamps the bottom of the page with what the picture shows:
 * which cluster, how old the data is, when it was captured, by whom.
 *
 * This file is the one definition. app.js asks `evidenceLayout()` and nothing else decides
 * which pages these are. No DOM here, so tools/unit/evidence.test.mjs can hold it.
 */

import { isStale, STALE_AFTER_MS } from '../lib/freshness.js';

/** The pages that get the layout. The only list of them. */
export const EVIDENCE_PAGES = new Set(['snapshots', 'console', 'indices']);

/**
 * How the shell should look for this page and selection.
 *
 * `needsCluster`: it is an evidence page but no single cluster is selected ("All clusters",
 * or a cluster that is not in the config), so the page asks for one instead of drawing a
 * fleet. `hasCluster` is whether `selected` names a configured cluster.
 */
export function evidenceLayout(pageId, selected, hasCluster = true) {
  const evidence = EVIDENCE_PAGES.has(pageId);
  const single = !!selected && selected !== 'all' && !!hasCluster;
  return { evidence, needsCluster: evidence && !single };
}

/* --------------------------------- the stamp --------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

function zoneName(d) {
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
      .formatToParts(d).find((p) => p.type === 'timeZoneName');
    return part ? part.value : '';
  } catch (_) { return ''; }
}

/** `2026-10-20 13:25:20 IST`, in the viewer's own time zone. `tz` overrides the zone name. */
export function stampTime(ts, tz) {
  const d = new Date(Number(ts));
  const body = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const zone = tz === undefined ? zoneName(d) : tz;
  return zone ? `${body} ${zone}` : body;
}

/** `13:27:02` */
export function clockTime(ts) {
  const d = new Date(Number(ts));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** An age in the words a reader of a screenshot wants: `40 s`, `6 min`, `2 h`, `3 days`. */
export function ageWords(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const hr = Math.round(s / 3600);
  if (hr < 48) return `${hr} h`;
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/**
 * The address to print for a cluster: the one the Clusters page shows, minus anything that
 * could be a secret — user:password in the authority, a query string, a fragment.
 */
export function safeAddress(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch (_) {
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1').replace(/[?#].*$/, '');
  }
}

/**
 * Everything the footer says, decided in one place.
 *
 * @param o.cluster  { name, url }
 * @param o.label    what the data is ("Snapshot data read"); the time follows it
 * @param o.fresh    the page's own freshness for the data on screen — the shape state.js
 *                   datasetFreshness() returns: { ts, status, staleAfterMs, reach, error }.
 *                   null = the page cannot say, which is printed as "data time unknown".
 * @param o.none     what to say when nothing has been read yet, for a page whose data is a
 *                   response rather than a dataset ("no request run yet")
 * @returns { segments: [{ key, text, tone }], text, tone, note }
 *   tone: 'ok' | 'stale' | 'unknown' — the data segment's; 'stale' is drawn amber.
 *   note: a one-line banner for the top of the page when the data is stale or the cluster
 *         cannot be reached, else ''. Staleness is never hidden (unknown is not zero).
 */
export function evidenceStamp(o = {}) {
  const { cluster = {}, label = 'Data read', fresh = null, none = '', now = Date.now(),
          version = '', user = '', tz } = o;
  const f = fresh || null;
  const ts = f && Number(f.ts) > 0 ? Number(f.ts) : 0;
  const age = ts ? Math.max(0, now - ts) : 0;
  const status = f && f.status;
  const down = !!(f && f.reach && f.reach.state === 'unreachable');

  let data, tone, note = '';
  if (!f) {
    data = 'data time unknown'; tone = 'unknown';
  } else if (!ts || status === 'never') {
    data = none || (down ? 'not read — cluster unreachable' : 'not read yet');
    tone = 'unknown';
    if (down) note = `${cluster.name || 'This cluster'} is unreachable and nothing has been read from it yet.`;
  } else {
    const when = `${label} ${stampTime(ts, tz)} (${ageWords(age)} before this capture)`;
    const stale = isStale(ts, now, f.staleAfterMs || STALE_AFTER_MS);
    if (down || status === 'error') {
      const why = down ? 'cluster unreachable' : 'last fetch failed';
      data = `${when} — ${why}, data may be out of date`;
      tone = 'stale';
      note = `${cluster.name || 'This cluster'}: ${why}. Showing data from ${stampTime(ts, tz)} (${ageWords(age)} old).`;
    } else if (stale) {
      data = `${when} — Data is ${ageWords(age)} old. Refresh before capturing.`;
      tone = 'stale';
      note = `Data from ${stampTime(ts, tz)} (${ageWords(age)} old). Refresh before capturing.`;
    } else {
      data = when; tone = 'ok';
    }
  }

  const addr = safeAddress(cluster.url);
  const segments = [
    { key: 'cluster', text: `Cluster: ${cluster.name || '?'}${addr ? ` · ${addr}` : ''}`, tone: 'ok' },
    { key: 'data', text: data, tone },
    { key: 'captured', text: `Captured ${clockTime(now)}`, tone: 'ok' },
    version && version !== '?' ? { key: 'version', text: `ElasticPro ${version}`, tone: 'ok' } : null,
    user ? { key: 'user', text: `Signed in as ${user}`, tone: 'ok' } : null,
  ].filter(Boolean);
  return { segments, text: segments.map((s) => s.text).join(' · '), tone, note };
}

/* ------------------------- notices held for the way out ------------------------- */

/**
 * Toasts about the fleet, kept back while an evidence page is open.
 *
 * An alert toast names another cluster, and it would land in the screenshot. Dropping it
 * would hide an alert, so it waits here and is handed back when the person leaves — to the
 * bell, one entry each, with a single line on screen saying how many were held. A keyed
 * notice replaces an earlier one with the same key, as it would have on screen.
 */
export function createHeldNotices({ max = 500 } = {}) {
  let list = [];
  return {
    hold(message, kind, ms, opts = {}) {
      const item = { message, kind, ms, opts };
      if (opts.key) list = list.filter((x) => x.opts.key !== opts.key);
      list.push(item);
      if (list.length > max) list = list.slice(list.length - max);
    },
    size() { return list.length; },
    /** Hand everything back through `notify` (toast) and say so once. Returns the count. */
    release(notify) {
      const items = list.filter((x) => !x.opts.noHistory);   // those only summarise entries below
      list = [];
      if (!items.length) return 0;
      for (const x of items) notify(x.message, x.kind, 0, { ...x.opts, bellOnly: true });
      const worst = items.some((x) => x.kind === 'err') ? 'err' : 'warn';
      const n = items.length;
      notify(`Held ${n} notice${n === 1 ? '' : 's'} while on an evidence page`, worst, 8000,
        { key: 'evidence-held', detail: ['Each one is in the bell.'] });
      return n;
    },
  };
}
