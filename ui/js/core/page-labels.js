/**
 * The names of the pages, as the tab bar shows them — one definition, read from app.js.
 *
 * `PAGES` in app.js is the only place a page is named. A page that links to another
 * ("Go to Snapshots →") has to say the name the tab says, including after a rename, and
 * importing app.js from a page would be a cycle. So the shell registers its list here once
 * and the pages ask. Before it has registered (a unit test, a page rendered on its own)
 * the id stands in: an honest placeholder rather than a second copy of the names.
 */
let byId = new Map();

/** Called once by app.js with its PAGES list. */
export function registerPages(pages) {
  byId = new Map((pages || []).map((p) => [p.id, p.label]));
}

/** What the tab for `id` says. */
export function pageLabel(id) { return byId.get(id) || String(id || ''); }

/** Whether the shell knows this page. False before it has registered. */
export function knowsPage(id) { return byId.has(id); }
