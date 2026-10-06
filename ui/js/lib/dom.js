/** Tiny DOM helpers. No innerHTML for user/ES-supplied strings - everything is
 *  created as text nodes, which also keeps us clear of MV3's CSP. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs, ...kids) {
  const parts = tag.split(/([#.])/);
  const el = document.createElement(parts[0] || 'div');
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === '#') el.id = parts[i + 1];
    else el.classList.add(parts[i + 1]);
  }
  if (attrs && (attrs.nodeType || typeof attrs === 'string' || Array.isArray(attrs))) {
    kids.unshift(attrs);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // only ever used with our own markup
      else if (k in el && k !== 'list' && typeof v !== 'object') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (k) => {
    if (k === null || k === undefined || k === false) return;
    if (Array.isArray(k)) return k.forEach(add);
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
}

export const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  kids.flat().forEach((k) => k && el.append(k.nodeType ? k : document.createTextNode(String(k))));
  return el;
};

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/**
 * Make `el`'s children exactly `nodes`, in order, touching only what differs.
 *
 * With freshly built nodes this is clear-then-append. With nodes kept from the last draw
 * (lib/keyed.js) an element already in its place is not moved, so the browser has nothing
 * to restyle or lay out for it — which on a page of a hundred-odd rows is most of the cost
 * of a redraw.
 */
export function reconcile(el, nodes) {
  const keep = new Set(nodes);
  const gone = [];
  let cur = el.firstChild;
  // Step over what is not staying (removed at the end, after everything new is in, so the
  // container is never empty in between): comparing against it instead would move every
  // kept row after one replaced row, one by one, behind it.
  const skipGone = () => {
    while (cur && !keep.has(cur)) { gone.push(cur); cur = cur.nextSibling; }
  };
  for (const n of nodes) {
    skipGone();
    if (n === cur) { cur = cur.nextSibling; continue; }
    el.insertBefore(n, cur);
  }
  skipGone();
  for (const g of gone) el.removeChild(g);
  return el;
}

/**
 * Make a non-button element answer a keyboard the way a button does.
 *
 * A div, a `th` or a `tr` carrying an onclick is invisible to anyone not holding a mouse:
 * it takes no focus and responds to no key. This returns the attributes that give it a tab
 * stop, a role, and Enter/Space handling — spread into the element's attrs so the call site
 * keeps its own class, style and title.
 *
 * Pass `role: null` for elements whose native role already says what they are — a sortable
 * `th` is a columnheader, and overwriting that with "button" loses more than it gains.
 */
export function activatable(onActivate, opts = {}) {
  return {
    tabindex: 0,
    role: opts.role === undefined ? 'button' : opts.role,
    onclick: onActivate,
    onkeydown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();          // Space scrolls the page; a control that answers it must not
      onActivate(e);
    },
  };
}

/**
 * Replace an element's contents, keeping the keyboard where it was.
 *
 * Pages re-render a region as you type in it — a search box filters a table, and the
 * table's container is rebuilt. If the box itself sits in that container it is destroyed
 * and replaced mid-keystroke, so focus lands on the body and the next character goes
 * nowhere. Restoring focus, the caret and any selection makes that invisible, and does
 * nothing at all when the focused element was not inside the region being replaced.
 *
 * Matching is by id, which is what identifies "the same control" across a rebuild.
 */
export function mount(el, ...kids) {
  const active = document.activeElement;
  let restore = null;
  if (active && active.id && el.contains(active) && active !== el) {
    restore = { id: active.id };
    // Only text-like controls carry a caret; number/date/checkbox throw on the attempt.
    try {
      if (typeof active.selectionStart === 'number') {
        restore.start = active.selectionStart;
        restore.end = active.selectionEnd;
        restore.dir = active.selectionDirection || 'none';
      }
    } catch (_) { /* not a text control; focus alone is enough */ }
  }

  // Where the page was. Emptying the container makes it briefly shorter, and a document
  // shorter than the current scroll offset is clamped to the top — and re-filling it does
  // not put it back. That is why searching or refreshing used to throw you to the top of
  // every page.
  //
  // The container's current height is held as its minimum until the next frame, so neither
  // it nor the page around it can get shorter in between; if the new content really is
  // shorter, the page settles once the hold is released, which is the right place to end
  // up. This used to read every scrollable ancestor's offset before and after instead,
  // and the read after forced the browser to lay the whole new page out there and then,
  // inside the redraw — the single biggest cost of redrawing a large page.
  holdHeight(el);
  reconcile(el, kids.flat().filter(Boolean)
    .map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));

  if (restore) {
    // getElementById rather than a selector: an id is not always a valid selector
    // fragment, CSS.escape is not everywhere (jsdom has no such thing), and a throw here
    // would take the whole redraw with it. Containment keeps the meaning the same.
    const found = document.getElementById(restore.id);
    const next = found && el.contains(found) ? found : null;
    if (next && typeof next.focus === 'function') {
      next.focus({ preventScroll: true });
      if (restore.start !== undefined && typeof next.setSelectionRange === 'function') {
        try { next.setSelectionRange(restore.start, restore.end, restore.dir); }
        catch (_) { /* the replacement is a different kind of control */ }
      }
    }
  }
  return el;
}

const held = new Map();
let releaseArmed = false;
/**
 * The height each mounted container had at the last layout, as the browser reported it.
 * Reading offsetHeight here instead would make the browser lay the page out on the spot,
 * mid-redraw, only to do it again once the redraw is done.
 */
const lastHeight = new WeakMap();
const sizes = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
      for (const e of entries) lastHeight.set(e.target, e.target.offsetHeight || (e.contentRect && e.contentRect.height) || 0);
    })
  : null;
const observed = new WeakSet();
function holdHeight(el) {
  if (sizes && !observed.has(el)) { observed.add(el); sizes.observe(el); }
  if (!held.has(el)) {
    const h0 = lastHeight.get(el) || 0;
    if (!h0) return;
    held.set(el, el.style.minHeight);
    el.style.minHeight = `${h0}px`;
  }
  if (releaseArmed) return;
  releaseArmed = true;
  const release = () => {
    releaseArmed = false;
    for (const [e, prev] of held) e.style.minHeight = prev;
    held.clear();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(release);
  else setTimeout(release, 16);
}

/** Shared singleton tooltip. */
let tipEl = null;
export const tooltip = {
  show(html, x, y) {
    if (!tipEl) { tipEl = h('div.tip'); document.body.append(tipEl); }
    clear(tipEl);
    tipEl.append(html);
    tipEl.style.display = 'block';
    const r = tipEl.getBoundingClientRect();
    const px = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
    const py = Math.min(Math.max(8, y + 14), window.innerHeight - r.height - 8);
    tipEl.style.left = px + 'px';
    tipEl.style.top = py + 'px';
  },
  hide() { if (tipEl) tipEl.style.display = 'none'; },
};
