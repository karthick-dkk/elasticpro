/**
 * The DOM half of Config-Management's save bar (core/save-bar.js is the arithmetic).
 *
 * A form takes part by sitting inside an element with `data-track="<section id>"`; every
 * input, select and textarea in it with an id (or a name, for a radio group) is a field. The
 * values it was first drawn with are the baseline; whatever differs from that now is a change,
 * named in the bar. Save runs the section's own save path — the one its Save button used to
 * run — and a section whose save says it worked starts again from what is on screen.
 *
 * Nothing here knows what a field means: labels are read off the page (a `data-label` wins,
 * then aria-label, the <label> around it, the first cell of its row). A field marked
 * `data-untracked` (a preview picker, a filter) or drawn disabled (config.txt manages it) is
 * not a setting anybody can change, so it never counts.
 */

import { h } from '../lib/dom.js';
import { diffFields, mergeBaseline, changeSummary, sectionsOf, shownValue } from '../core/save-bar.js';

const SKIP_TYPES = new Set(['button', 'submit', 'reset', 'file', 'search', 'hidden', 'image']);

/** The first piece of text inside `node`, not counting `skip` or the options of a select. */
function firstText(node, skip) {
  const walk = node.ownerDocument.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (skip && skip.contains(t)) continue;
    if (t.parentElement && t.parentElement.closest('select, option, textarea')) continue;
    const s = t.textContent.replace(/\s+/g, ' ').trim();
    if (s) return s.replace(/[:—-]\s*$/, '').trim();
  }
  return '';
}

/** What a field is called on the page. */
export function labelOf(el) {
  if (el.dataset && el.dataset.label) return el.dataset.label;
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  if (el.id) {
    const lab = el.ownerDocument.querySelector(`label[for="${el.id}"]`);
    if (lab) { const t = firstText(lab); if (t) return t; }
  }
  const lab = el.closest('label');
  if (lab) { const t = firstText(lab, el); if (t) return t; }
  const tr = el.closest('tr');
  if (tr && tr.cells && tr.cells[0] && !tr.cells[0].contains(el)) { const t = firstText(tr.cells[0]); if (t) return t; }
  return el.id || el.name || 'a field';
}

/** One field as the bar compares and names it, or null when it is not a setting. */
function readField(el, section, sectionLabel) {
  const type = String(el.type || '').toLowerCase();
  if (SKIP_TYPES.has(type) || el.disabled || el.closest('[data-untracked]')) return null;
  const base = { section, sectionLabel };
  if (type === 'radio') {
    if (!el.checked || !el.name) return null;
    const group = el.closest('[role="radiogroup"]');
    const text = firstText(el.closest('label') || el.parentElement, el) || el.value;
    return [`${section}:${el.name}`, { ...base, label: (group && (group.getAttribute('aria-label') || firstText(group, el.closest('label')))) || el.name,
      value: el.value, shown: shownValue(text) }];
  }
  const key = el.id || el.name || (el.dataset && el.dataset.key);
  if (!key) return null;
  const label = labelOf(el);
  if (type === 'checkbox') return [`${section}:${key}`, { ...base, label, value: el.checked, shown: shownValue(el.checked) }];
  if (el.tagName === 'SELECT') {
    const opt = el.options[el.selectedIndex];
    return [`${section}:${key}`, { ...base, label, value: el.value, shown: shownValue(opt ? opt.textContent : el.value) }];
  }
  if (type === 'password') return [`${section}:${key}`, { ...base, label, value: el.value, shown: '', secret: true }];
  return [`${section}:${key}`, { ...base, label, value: el.value, shown: shownValue(el.value) }];
}

/** Every tracked field under `root`, in page order. */
export function readTracked(root) {
  const out = new Map();
  if (!root) return out;
  for (const box of root.querySelectorAll('[data-track]')) {
    const section = box.dataset.track;
    const sectionLabel = box.dataset.trackLabel || '';
    for (const el of box.querySelectorAll('input, select, textarea')) {
      // A field belongs to its nearest tracked box only (boxes may nest).
      if (el.closest('[data-track]') !== box) continue;
      const f = readField(el, section, sectionLabel);
      if (f) out.set(f[0], f[1]);
    }
  }
  return out;
}

/**
 * The tracker for one page. `root()` is the element the forms are drawn in; `bar` is the
 * element the bar is drawn into (kept by the page across redraws).
 *
 *   register(id, {save, discard, changes?})  save: async () => boolean (true: it was saved);
 *                                  changes: () => [{label, text}] for a section that tracks its own model
 *   refresh()                      after a draw and on every input: re-read, redraw the bar
 *   reset(id) / resetAll()         take what is on screen as saved (after a load, a tab switch)
 *   changes()                      the current changes
 *
 * `beforeSave` / `afterSave` bracket the saves: the page holds its redraws in between, so a
 * redraw in one section's save cannot put back the saved values over another section's typed
 * ones before that section's save reads them, and redraws once at the end.
 */
export function createTracker({ root, beforeSave = () => {}, afterSave = () => {} }) {
  const sections = new Map();
  let baselines = new Map();      // section → Map(key → field)
  let current = [];
  let busy = false;
  const bar = h('div#cm-savebar.cm-savebar', { role: 'region', 'aria-label': 'Unsaved changes', hidden: true });

  function read() {
    const all = readTracked(root());
    const bySection = new Map();
    for (const [k, v] of all) {
      if (!bySection.has(v.section)) bySection.set(v.section, new Map());
      bySection.get(v.section).set(k, v);
    }
    const changes = [];
    for (const [sec, fields] of bySection) {
      // A section that keeps its own model of what changed (plan templates: roles added and
      // removed are not fields) says so itself, below.
      if (sections.get(sec) && sections.get(sec).changes) continue;
      const base = mergeBaseline(baselines.get(sec), fields);
      baselines.set(sec, base);
      changes.push(...diffFields(base, fields));
    }
    const r = root();
    for (const [id, sec] of sections) {
      if (!sec.changes || !r || !r.querySelector(`[data-track="${id}"]`)) continue;
      changes.push(...(sec.changes() || []).map((c) => ({ ...c, section: id })));
    }
    return changes;
  }

  function drawBar() {
    const s = changeSummary(current);
    bar.hidden = !s.count;
    bar.replaceChildren();
    if (!s.count) return;
    bar.append(
      h('span.cm-savebar-dot', { 'aria-hidden': 'true' }),
      h('span.cm-savebar-text', { title: s.title },
        h('b', s.head), s.list ? h('span', ` · ${s.list}`) : null),
      h('span.cm-savebar-acts',
        h('button.btn.ghost', { type: 'button', dataset: { act: 'discard' }, disabled: busy, onclick: discard }, 'Discard'),
        h('button.btn.primary', { type: 'button', dataset: { act: 'save' }, disabled: busy, onclick: save }, busy ? 'Saving…' : 'Save changes')));
  }

  function refresh() {
    current = read();
    drawBar();
    return current;
  }

  async function save() {
    if (busy) return false;
    const touched = sectionsOf(refresh());
    if (!touched.length) return true;
    busy = true; drawBar();
    let all = true;
    beforeSave();
    try {
      for (const id of touched) {
        const s = sections.get(id);
        if (!s || !s.save) continue;
        let ok = false;
        try { ok = (await s.save()) === true; } catch (e) { ok = false; console.error(e); }
        if (ok) baselines.delete(id);
        else all = false;
      }
    } finally {
      busy = false;
      try { afterSave(); } finally { refresh(); }
    }
    return all;
  }

  function discard() {
    const touched = sectionsOf(current);
    for (const id of touched) baselines.delete(id);
    for (const id of touched) { const s = sections.get(id); if (s && s.discard) s.discard(); }
    refresh();
  }

  return {
    bar,
    register(id, opts) { sections.set(id, opts || {}); },
    refresh,
    save,
    discard,
    reset(id) { baselines.delete(id); },
    resetAll() { baselines = new Map(); },
    changes: () => current,
    isBusy: () => busy,
  };
}
