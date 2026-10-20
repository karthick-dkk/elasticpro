/** Cross-page hand-off (e.g. "open this index in the REST console"). */
export const intent = { console: null, snapshots: null };

/**
 * Whether this session may open a page. The shell (app.js) owns the answer — it knows the
 * signed-in role and which tabs it offers — and registers it here, so a page offering a
 * way to another page (the Clusters page's name menu) asks the same question the tab bar
 * does instead of keeping a second copy of who may see what.
 */
let pageGate = () => true;
export function setPageGate(fn) { pageGate = typeof fn === 'function' ? fn : () => true; }
export function canOpenPage(id) { return !!pageGate(id); }

/**
 * Go to a page, and optionally to the cluster that page should be showing.
 *
 * "Open the page that answers this alert" is half an answer on a fleet view: the page
 * opens on all clusters and the operator has to find the one the alert named all over
 * again — on a page like Nodes or Indices, which can only show one, they land on
 * whichever happens to be first. Naming the cluster here selects it on the way in.
 *
 * `payload` is for the page being opened: the request for the REST console, `{ view }`
 * for Snapshots ('summary' is the view with the repositories).
 */
export function navigateTo(page, payload, opts = {}) {
  if (page === 'console') intent.console = payload || null;
  if (page === 'snapshots') intent.snapshots = payload || null;
  window.dispatchEvent(new CustomEvent('ep:navigate', {
    detail: { page, cluster: opts.cluster || null },
  }));
}
