/**
 * The one order clusters are listed in: by name, A–Z, ignoring capitals and accents, with
 * the numbers inside a name read as numbers — es-node-2 before es-node-10.
 *
 * Every list of clusters uses this: the top-bar picker and its "Find among…" box (through
 * state.js clusters()), the Clusters page summary, and every
 * page that draws one block per cluster. Before, each list was in whatever order the
 * config file happened to give, and the summary sorted with a plain localeCompare that put
 * es-node-10 before es-node-2.
 *
 * A fixed locale ('en') rather than the browser's: a cluster name is an identifier, and two
 * operators comparing screens, or reading a runbook that says "the third cluster down",
 * must see the same order whatever their system language is.
 */
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Compare two names. Names the collator calls equal ("Prod" and "prod", "café" and "cafe")
 * fall back to a plain code-point comparison, so the order is total and the same on every
 * redraw — never "whichever came first this time".
 */
export function compareNames(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  return COLLATOR.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0);
}

/** A copy of `list` in name order; `nameOf` picks the name (default: `.name`). */
export function sortByName(list, nameOf = (c) => c.name) {
  return [...list].sort((a, b) => compareNames(nameOf(a), nameOf(b)));
}
