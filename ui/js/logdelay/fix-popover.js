/**
 * The "i" button of the Log Delay page and the one popover every "i" opens: a device's or a
 * cluster's recommended fix, or what a view is about.
 *
 * The words are the core's (logdelay/fixes.rs): this file never writes a cause or a fix. A finding
 * is {step, stepLabel, why, fix, devices[], ...}; a device row carries its own as `fix` (an object,
 * or null when no rule matched; the device board's is `finding`), a cluster row carries `fixes`
 * (a list). A device with no finding says exactly that, rather than inventing a cause.
 *
 * One popover, fixed-position, shared by every button: it flips to stay inside the window, a click
 * on a button never reaches the row under it (capture phase), and Esc, the × and a click outside
 * close it; Esc and × give the focus back to the button. A repaint that removes the button, or a
 * scroll, closes it.
 */

import { h } from '../lib/dom.js';
import { stateText, STEP_LABEL } from '../core/logdelay-report.js';

export const NO_FINDING = 'No recommendation from the core: not late in the stored delay periods of the last 7 days, or no rule matched yet.';

/** One finding as a popover item: title = stepLabel, cause = why, fix, where = the step in words; count for a cluster's. */
function norm(f, withCount) {
  if (!f || typeof f !== 'object') return null;
  const count = withCount ? (Number.isFinite(f.count) ? f.count : Array.isArray(f.devices) ? f.devices.length : null) : null;
  const where = f.where || (f.step && (STEP_LABEL[f.step] || String(f.step).replace(/_/g, ' '))) || '';
  return { title: String(f.title || f.stepLabel || where || ''), cause: String(f.cause || f.why || ''), fix: String(f.fix || ''), where: String(where), count };
}

/**
 * What to show for a device row (kind 'device') or a cluster row (kind 'cluster'). Never throws and
 * never invents a cause: a device without a finding gets NO_FINDING.
 */
export function fixesFor(row, kind = 'device') {
  if (!row || typeof row !== 'object') return [];
  const keep = (list, c) => list.map((f) => norm(f, c)).filter((x) => x && (x.title || x.cause || x.fix));
  if (kind === 'cluster') {
    const list = Array.isArray(row.fixes) ? row.fixes : Array.isArray(row.findings) ? row.findings : [];
    return keep(list, true);
  }
  const one = row.fix && typeof row.fix === 'object' ? row.fix : row.finding && typeof row.finding === 'object' ? row.finding
    : (typeof row.fix === 'string' && row.fix) || row.why ? row : null;
  if (one) { const l = keep([one], false); if (l.length) return l; }
  return [{ title: stateText(row.state), cause: NO_FINDING, fix: '', where: '', count: null }];
}


/** Where the popover goes: right edge under the button, flipped above when it would run off, clamped to the window. */
export function place(rect, w, hgt, vw, vh, gap = 6, edge = 8) {
  const left = Math.max(edge, Math.min(rect.right - w, vw - edge - w));
  let top = rect.bottom + gap;
  if (top + hgt > vh - edge) top = Math.max(edge, rect.top - hgt - gap);
  return { left, top };
}

const HEAD = { device: 'device · recommended fix', cluster: 'cluster · recommended fix', about: 'about this view' };
const LABEL = { device: (id) => `Recommended fix for ${id}`, cluster: (id) => `Recommended fix for ${id}`, about: (id) => `About ${id}` };

const reg = new WeakMap();   // button -> { kind, id, items }
let pop = null;              // the one popover element
let owner = null;            // the button it belongs to
let watcher = null;          // MutationObserver: closes it when a repaint takes the button away
let wired = false;

function fixBox(f, kind) {
  const n = f.count !== null && f.count !== undefined ? ` · ${f.count} device${f.count === 1 ? '' : 's'}` : '';
  return h('div.ld-fixbox',
    h('b', `${f.title}${n}`),
    f.cause ? h('div', f.cause) : null,
    f.fix ? h('div', h('b', 'Fix: '), f.fix) : null,
    f.where ? h('div.ld-fixwhere', `Where: ${f.where}`) : null,
    null);
}

export function closeFix(refocus = false) {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  if (watcher) { watcher.disconnect(); watcher = null; }
  const o = owner; owner = null;
  if (o) { o.setAttribute('aria-expanded', 'false'); if (refocus && o.isConnected) o.focus(); }
}

function open(btn) {
  const spec = reg.get(btn);
  if (!spec) return;
  closeFix(false);
  let items = [];
  try { items = spec.items() || []; } catch (_) { items = []; }
  if (!pop) {
    pop = h('div.ld-fixpop', { role: 'dialog', hidden: true });
    document.body.appendChild(pop);
  }
  pop.setAttribute('aria-label', LABEL[spec.kind](spec.id));
  pop.replaceChildren(
    h('div.ld-fixpop-h', h('b', spec.id), h('span.muted', HEAD[spec.kind]),
      h('button.ld-fixpop-x', { type: 'button', 'aria-label': 'Close', onclick: () => closeFix(true) }, '×')),
    ...(items.length ? items.map((f) => fixBox(f, spec.kind)) : [h('div.muted', spec.kind === 'about' ? '' : NO_FINDING)]));
  pop.hidden = false;
  owner = btn;
  btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect();
  const p = place(r, pop.offsetWidth, pop.offsetHeight, document.documentElement.clientWidth, document.documentElement.clientHeight);
  pop.style.left = `${p.left}px`;
  pop.style.top = `${p.top}px`;
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
 * The "i". `kind`: 'device' | 'cluster' (a recommended fix) | 'about' (what a view is);
 * `id`: what it names; `items()`: asked when it is pressed — `{title, cause, fix, where, count?}` each,
 * an 'about' item may carry only title and cause.
 */
export function fixButton({ kind, id, items }) {
  wire();
  const k = HEAD[kind] ? kind : 'device';
  const b = h('button.ld-ibtn', {
    type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'aria-label': LABEL[k](id), title: k === 'about' ? 'About this view' : 'Recommended fix',
  }, 'i');
  reg.set(b, { kind: k, id: String(id), items: typeof items === 'function' ? items : () => items || [] });
  return b;
}
