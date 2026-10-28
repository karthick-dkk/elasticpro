/**
 * The evidence layout: what Snapshots, the REST console and Indices look like when they
 * are about to be screenshotted for ONE client.
 *
 * One client is one cluster, and a screenshot of the Indices page must not tell that
 * client how many other clusters we look after, which of them are down, or what the alerts
 * on them say. So on these pages — automatically, there is no switch — the shell drops
 * everything fleet-wide. (Until 0.3.38 it also stamped the foot of the page with the
 * cluster, the data time, the capture time and the user; the user asked for that to go, so
 * the Refresh button's minutes badge is where the age of the data is read now.)
 *
 * The top bar still offers the cluster chooser here, one cluster at a time (no "All clusters",
 * no find-box): choosing is how a person says which client the screenshot is for. Arriving
 * with "All clusters" selected picks one for them, `evidenceSelection()` below.
 *
 * This file is the one definition. app.js asks `evidenceLayout()` and nothing else decides
 * which pages these are. No DOM here, so tools/unit/evidence.test.mjs can hold it.
 */

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

/**
 * The cluster an evidence page opens on when "All clusters" (or a cluster that is not in the
 * config) is selected: the one last chosen in this browser, else the first. `selected` is kept
 * when it already names a configured cluster. '' when there is no cluster at all.
 * `ids` is the configured cluster ids in display order.
 */
export function evidenceSelection(selected, last, ids = []) {
  if (selected && selected !== 'all' && ids.includes(selected)) return selected;
  if (last && ids.includes(last)) return last;
  return ids[0] || '';
}

/**
 * A text with the cluster's address taken out: its URL, its host and host:port, and any other
 * http(s) address, replaced by the cluster's name. For error texts that quote the address they
 * could not reach ("connect to http://10.1.2.3:9200 failed") on a page that is photographed.
 */
export function hideAddress(text, cluster = {}) {
  let t = String(text == null ? '' : text);
  const name = cluster.name || 'the cluster';
  const raw = String((cluster && cluster.url) || '').trim();
  const bits = [];
  if (raw) {
    bits.push(raw.replace(/\/+$/, ''));
    try { const u = new URL(raw); bits.push(u.host, u.hostname); } catch (_) { /* not a URL */ }
  }
  for (const b of bits.filter(Boolean).sort((x, y) => y.length - x.length)) t = t.split(b).join(name);
  return t.replace(/https?:\/\/[^\s"'<>)\]]+/gi, name);
}

/** A freshness object (state.js datasetFreshness) with the address taken out of its error text. */
export function scrubFresh(f, cluster) {
  if (!f || !f.error || !f.error.message) return f;
  return { ...f, error: { ...f.error, message: hideAddress(f.error.message, cluster) } };
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
