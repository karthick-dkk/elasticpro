/**
 * The column sort every table shares, on screen: one sortable header, and one remembered
 * order per table. The comparing is core/sort.js; this is the part that touches the DOM and
 * the browser's storage.
 *
 *   const S = tableSort('reports.exports', { initial: { key: 'when', dir: -1 }, onChange: redraw });
 *   const rows = S.apply(filtered, { when: { type: 'date', value: (r) => r.at }, … });  // after the
 *   //   filter, before paging, so a page and "Show all" keep the order
 *   table([{ label: 'When', sort: 'when' }, …], rows.map(rowOf), { sort: S });
 *
 * A header with `sort: 'key'` becomes a column head that sorts: a click (or Enter/Space when
 * it has focus) sorts by it, a second click reverses, an arrow marks the active column and
 * aria-sort says which way. Its id stays the same across redraws, so mount() (lib/dom.js)
 * puts the keyboard back on it after the table is drawn again.
 *
 * Each table's order is remembered per browser under `elasticpro.sort.<id>`. Every access is
 * in try/catch: a private window, blocked storage or a thumbnail capture just means the
 * table opens in its default order.
 */

import { h } from './dom.js';
import { sortRows, nextSort, ariaSort, sortArrow, validSort } from '../core/sort.js';

const PREFIX = 'elasticpro.sort.';
/** Written when a table was put back in its own order on purpose. */
const NATURAL = 'natural';
const registry = new Map();

function readStored(id) {
  try {
    const raw = window.localStorage.getItem(PREFIX + id);
    if (raw === null || raw === undefined) return undefined;
    if (raw === NATURAL) return null;
    return validSort(JSON.parse(raw)) || undefined;
  } catch (_) { return undefined; }
}

function writeStored(id, sort) {
  try { window.localStorage.setItem(PREFIX + id, sort ? JSON.stringify({ key: sort.key, dir: sort.dir }) : NATURAL); } catch (_) { /* not kept; still sorted for now */ }
}

/**
 * The sort of table `id`, the same object for the same id for as long as the page is
 * loaded — so a header built once (a kept table) still reaches the current order.
 *
 * `initial`: the order the table opens in when nothing is remembered, `{ key, dir }`, or null
 * for the table's own order (then a third click on a column goes back to it). `onChange`
 * redraws; the latest one passed wins.
 */
export function tableSort(id, { initial = null, onChange = null } = {}) {
  let s = registry.get(id);
  if (s) {
    if (onChange) s.onChange = onChange;
    return s;
  }
  let state;            // undefined until read from storage
  let cols = null;      // the columns of the last apply(): types, values, first directions
  const current = () => {
    if (state === undefined) {
      const stored = readStored(id);
      state = stored === undefined ? (initial ? { ...initial } : null) : stored;
    }
    if (state && cols && !cols[state.key]) state = initial && cols[initial.key] ? { ...initial } : null;
    return state;
  };
  s = {
    id,
    initial,
    onChange,
    get sort() { return current(); },
    get key() { const c = current(); return c ? c.key : null; },
    get dir() { const c = current(); return c ? c.dir : 1; },
    /** `rows` in the current order, read through `columns` ({ key: { type, value(row), start? } }). */
    apply(rows, columns) {
      if (columns) cols = columns;
      return sortRows(rows, current(), cols);
    },
    /** A header was pressed. */
    on(key) {
      const col = cols && cols[key];
      state = nextSort(current(), key, { start: (col && col.start) || 1, natural: !initial });
      writeStored(id, state);
      if (s.onChange) s.onChange(state);
    },
    /** Set the order outright (a Sort select, a Clear button). */
    set(sort) {
      state = sort ? validSort(sort) : null;
      writeStored(id, state);
    },
  };
  registry.set(id, s);
  return s;
}

/** Forget the in-memory copies (tests): the next tableSort() reads storage again. */
export function resetTableSorts() { registry.clear(); }

const idOf = (sort, key) => (sort && sort.id ? `sort-${String(sort.id).replace(/[^\w-]/g, '-')}-${String(key).replace(/[^\w-]/g, '-')}` : null);

/** A press inside the head that belongs to something else in it (an info button, a tick box). */
const ownControl = (e, th) => e.target !== th && e.target.closest && !!e.target.closest('button, a, input, select, textarea, label');

/**
 * A column head that sorts. `sort` is a tableSort() (or any `{ key, dir, on(key), id? }`);
 * `label` text or a node. Options: `num` (right-aligned), `cls` (more classes, dot-joined or
 * an array), `attrs` (more attributes: style, colspan, scope, data-*), `after` (nodes after
 * the arrow — a unit, an info button), `title`.
 */
export function sortTh(sort, key, label, { num = false, cls = null, attrs = null, after = null, title = null } = {}) {
  const classes = ['sortable', num ? 'num' : '', ...(Array.isArray(cls) ? cls : String(cls || '').split('.'))].filter(Boolean);
  const text = label instanceof Node ? label.textContent : String(label ?? '');
  const st = sort && sort.key ? { key: sort.key, dir: sort.dir } : null;
  const th = h(`th.${classes.join('.')}`, {
    ...(attrs || {}),
    id: idOf(sort, key),
    tabindex: 0,
    title: title || `Sort by ${text}`,
    'aria-sort': ariaSort(st, key),
    dataset: { sort: key, ...((attrs && attrs.dataset) || {}) },
    onclick: (e) => { if (!ownControl(e, e.currentTarget)) e.currentTarget._sort.on(key); },
    onkeydown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();            // Space would scroll the page
      e.currentTarget._sort.on(key);
    },
  }, label, h('span.sort-arrow', { 'aria-hidden': 'true' }, sortArrow(st, key)), after);
  th._sort = sort;
  return th;
}

/**
 * Bring the sortable heads under `root` up to date with `sort` in place — for a table kept
 * between redraws, whose head is not rebuilt. Writes only what changed.
 */
export function paintSortHeads(root, sort) {
  if (!root) return;
  const st = sort && sort.key ? { key: sort.key, dir: sort.dir } : null;
  for (const th of root.querySelectorAll('th.sortable[data-sort]')) {
    const key = th.dataset.sort;
    th._sort = sort;
    const aria = ariaSort(st, key);
    if (th.getAttribute('aria-sort') !== aria) th.setAttribute('aria-sort', aria);
    const arrow = th.querySelector(':scope > .sort-arrow');
    const a = sortArrow(st, key);
    if (arrow && arrow.textContent !== a) arrow.textContent = a;
  }
}
