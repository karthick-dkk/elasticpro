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
 * Nothing here changes the DOM, so the rules are testable with plain objects; `same` and
 * markupSig only read the markup of what they are given.
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
    /**
     * `fresh`, or — when the element kept under `key` is drawn exactly the same (markupSig) —
     * the kept one. For a piece whose inputs are too many to name in a signature: it is built
     * every draw, but the DOM is touched only when what it shows changed, so the row under the
     * mouse, an open <details> or <select> and a field being typed into stay where they are.
     * The kept element is compared as it is now, so a field's own text (typed since) counts.
     * Text nodes and nothing pass through.
     */
    same(key, fresh) {
      if (!fresh || fresh.nodeType !== 1) return fresh;
      used.add(key);
      const hit = map.get(key);
      if (hit && hit.el === fresh) return fresh;           // a piece kept by its own cache
      if (hit && hit.el.nodeType === 1 && markupSig(hit.el) === markupSig(fresh)) return hit.el;
      map.set(key, { sig: null, el: fresh });
      return fresh;
    },
    /** same() for a list (nulls dropped), keyed by `prefix` and position. */
    sameAll(prefix, nodes) {
      return nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false).map((n, i) => api.same(`${prefix}:${i}`, n));
    },
    /** Forget what this draw did not ask for (clusters filtered out, removed, …). */
    end() { for (const k of [...map.keys()]) if (!used.has(k)) map.delete(k); return api; },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
  return api;
}

/**
 * What an element shows, as one string: its markup, plus the state of its form controls,
 * which are properties the markup does not carry (a field's text, a box's tick, which
 * option a select has — h() sets those as properties). Two elements with the same
 * signature look and read the same. The one DOM read in this file; nothing is written.
 */
export function markupSig(el) {
  if (!el || el.nodeType !== 1) return el && el.nodeType === 3 ? `#text:${el.data}` : '';
  let s = el.outerHTML;
  const controls = el.matches('input, select, textarea') ? [el] : [];
  controls.push(...el.querySelectorAll('input, select, textarea'));
  for (const c of controls) {
    s += c.tagName === 'SELECT' ? `|s${c.selectedIndex}` : c.type === 'checkbox' || c.type === 'radio' ? `|c${c.checked ? 1 : 0}` : `|v${c.value}`;
  }
  // an open <details> shows its body; `open` is an attribute, so it is in the markup already
  return s;
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
