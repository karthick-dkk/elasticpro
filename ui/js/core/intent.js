/** Cross-page hand-off (e.g. "open this index in the REST console"). */
export const intent = { console: null };

/**
 * Go to a page, and optionally to the cluster that page should be showing.
 *
 * "Open the page that answers this alert" is half an answer on a fleet view: the page
 * opens on all clusters and the operator has to find the one the alert named all over
 * again — on a page like Nodes or Indices, which can only show one, they land on
 * whichever happens to be first. Naming the cluster here selects it on the way in.
 */
export function navigateTo(page, payload, opts = {}) {
  if (page === 'console') intent.console = payload || null;
  window.dispatchEvent(new CustomEvent('ep:navigate', {
    detail: { page, cluster: opts.cluster || null },
  }));
}
