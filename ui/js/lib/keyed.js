/**
 * Built pieces of a page, kept between redraws and rebuilt only when what they show changed.
 *
 * A page of a hundred-odd clusters used to rebuild every row, card and chart on every push
 * from the core — several times a second while a refresh streams in — so the browser spent
 * its time creating, styling and laying out thousands of elements identical to the ones it
 * had just thrown away. Each piece now carries a signature: a short string of whatever it
 * is drawn from. Same signature, same element; mount() (lib/dom.js) then leaves an element
 * that is already in place exactly where it is, so an unchanged row costs nothing at all.
 *
 * `budgetMs` bounds how much building one redraw may do. Past it, `get` hands back the
 * caller's placeholder instead and says so (`incomplete`), and the caller redraws again on
 * the next tick: the page appears at once and fills in, rather than holding the window
 * for the whole fleet before showing anything.
 *
 * Nothing here touches the DOM, so the rules are testable with plain objects.
 */
export function nodeCache({ budgetMs = 0, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) } = {}) {
  const map = new Map();
  let used = new Set();
  let started = 0;
  const api = {
    /** Whether the last draw had to hand out placeholders. */
    incomplete: false,
    /** Start a draw: the budget counts from here, and unused entries are dropped at `end`. */
    begin() { started = now(); used = new Set(); api.incomplete = false; return api; },
    /**
     * The element for `key`: the cached one when `sig` matches, else `build()`'s — or, past
     * the budget, `placeholder()`'s (never cached) when one was given.
     */
    get(key, sig, build, placeholder = null) {
      used.add(key);
      const hit = map.get(key);
      if (hit && hit.sig === sig) return hit.el;
      if (placeholder && budgetMs && now() - started > budgetMs) {
        api.incomplete = true;
        // A stale element is a better placeholder than an empty one: it is what was on
        // screen a moment ago, and it is replaced as soon as there is time.
        return hit ? hit.el : placeholder();
      }
      const el = build();
      map.set(key, { sig, el });
      return el;
    },
    /** Forget what this draw did not ask for (clusters filtered out, removed, …). */
    end() { for (const k of [...map.keys()]) if (!used.has(k)) map.delete(k); return api; },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
  return api;
}

/**
 * A small number standing for an object's identity, for use in a signature: an object
 * replaced by another (a cluster's data rebuilt, a fixture swapped in) changes it even when
 * no event said so. 0 for anything that is not an object.
 */
const ids = new WeakMap();
let nextId = 1;
export function objId(o) {
  if (!o || (typeof o !== 'object' && typeof o !== 'function')) return 0;
  let n = ids.get(o);
  if (!n) { n = nextId++; ids.set(o, n); }
  return n;
}
