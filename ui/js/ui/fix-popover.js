/**
 * The "i" button and the one popover every "i" opens — a row's recommended fix, or what a view
 * is about. One definition for every page: the Log Delay rows (logdelay/fix-popover.js adds the
 * core's findings on top of this) and the unassigned shard rows of Nodes & shards.
 *
 * The words are never this file's: a caller hands over items `{title, cause, fix, where, count,
 * actions}` (cause and fix may be text or a node; `actions` are buttons drawn under the item),
 * either as a list, a function, or a function returning a promise — while a promise is pending
 * the popover says "Asking the cluster…", and a rejection is shown as what it said, never as a
 * guess.
 *
 * One popover, fixed-position, shared by every button: it flips to stay inside the window, a click
 * on a button never reaches the row under it (capture phase), and Esc, the × and a click outside
 * close it; Esc and × give the focus back to the button. A repaint that removes the button, or a
 * scroll, closes it.
 */

import { h } from '../lib/dom.js';

export const ASKING = 'Asking the cluster…';

/** Where the popover goes: right edge under the button, flipped above when it would run off, clamped to the window. */
export function place(rect, w, hgt, vw, vh, gap = 6, edge = 8) {
  const left = Math.max(edge, Math.min(rect.right - w, vw - edge - w));
  let top = rect.bottom + gap;
  if (top + hgt > vh - edge) top = Math.max(edge, rect.top - hgt - gap);
  return { left, top };
}

const reg = new WeakMap();   // button -> { head, label, id, items, empty }
let pop = null;              // the one popover element
let owner = null;            // the button it belongs to
let watcher = null;          // MutationObserver: closes it when a repaint takes the button away
let wired = false;
let opening = 0;             // which open() a pending promise belongs to

function fixBox(f) {
  const n = f.count !== null && f.count !== undefined ? ` · ${f.count} device${f.count === 1 ? '' : 's'}` : '';
  return h('div.ld-fixbox',
    f.title ? h('b', `${f.title}${n}`) : null,
    f.cause ? h('div', f.cause) : null,
    f.fix ? h('div', h('b', 'Fix: '), f.fix) : null,
    f.where ? h('div.ld-fixwhere', `Where: ${f.where}`) : null,
    f.actions && f.actions.length ? h('div.ld-fixacts', ...f.actions) : null);
}

export function closeFix(refocus = false) {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  if (watcher) { watcher.disconnect(); watcher = null; }
  const o = owner; owner = null;
  if (o) { o.setAttribute('aria-expanded', 'false'); if (refocus && o.isConnected) o.focus(); }
}

function fill(spec, items, note) {
  pop.replaceChildren(
    h('div.ld-fixpop-h', h('b', spec.id), h('span.muted', spec.head),
      h('button.ld-fixpop-x', { type: 'button', 'aria-label': 'Close', onclick: () => closeFix(true) }, '×')),
    ...(items && items.length ? items.map((f) => fixBox(f)) : [h('div.muted', note === undefined ? spec.empty : note)]));
}

function position(btn) {
  const r = btn.getBoundingClientRect();
  const p = place(r, pop.offsetWidth, pop.offsetHeight, document.documentElement.clientWidth, document.documentElement.clientHeight);
  pop.style.left = `${p.left}px`;
  pop.style.top = `${p.top}px`;
}

function open(btn) {
  const spec = reg.get(btn);
  if (!spec) return;
  closeFix(false);
  const my = ++opening;
  if (!pop) {
    pop = h('div.ld-fixpop', { role: 'dialog', hidden: true });
    document.body.appendChild(pop);
  }
  pop.setAttribute('aria-label', spec.label);
  let got;
  try { got = spec.items(); } catch (e) { got = Promise.reject(e); }
  if (got && typeof got.then === 'function') {
    fill(spec, [], ASKING);
    got.then((items) => { if (my === opening && owner === btn) { fill(spec, items || []); position(btn); } },
             (e) => { if (my === opening && owner === btn) { fill(spec, [], `${spec.failed} ${(e && e.message) || e}`); position(btn); } });
  } else fill(spec, got || []);
  pop.hidden = false;
  owner = btn;
  btn.setAttribute('aria-expanded', 'true');
  position(btn);
  if (typeof MutationObserver !== 'undefined') {
    watcher = new MutationObserver(() => { if (owner && !owner.isConnected) closeFix(false); });
    watcher.observe(document.body, { childList: true, subtree: true });
  }
  const x = pop.querySelector('.ld-fixpop-x');
  if (x) x.focus({ preventScroll: true });
}

function wire() {
  if (wired) return;
  wired = true;
  // Capture phase on the document: a click on an "i" is handled here and goes no further, so the row
  // under it never also opens.
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button.ld-ibtn') : null;
    if (b) {
      e.stopPropagation(); e.preventDefault();
      if (owner === b) closeFix(true); else open(b);
      return;
    }
    if (pop && !pop.hidden && !(e.target.closest && e.target.closest('.ld-fixpop'))) closeFix(false);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop && !pop.hidden) { e.stopPropagation(); closeFix(true); }
  }, true);
  window.addEventListener('scroll', (e) => { if (pop && !pop.hidden && !(e.target && e.target.closest && e.target.closest('.ld-fixpop'))) closeFix(false); }, true);
}

/**
 * The "i". `id` is what it names; `head` the grey words beside it ("device · recommended fix");
 * `label` the button's accessible name; `title` its tooltip; `items` a list, or a function asked
 * when it is pressed (may return a promise); `empty` what to say for no items; `failed` the lead-in
 * before a rejection's message.
 */
export function infoButton({ id, head, label, title, items, empty = '', failed = 'Could not be read:' }) {
  wire();
  const b = h('button.ld-ibtn', {
    type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'aria-label': label || `About ${id}`, title: title || 'Recommended fix',
  }, 'i');
  reg.set(b, { id: String(id), head: head || '', label: label || `About ${id}`, empty, failed,
    items: typeof items === 'function' ? items : () => items || [] });
  return b;
}
