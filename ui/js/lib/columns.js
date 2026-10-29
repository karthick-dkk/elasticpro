/**
 * Table columns a person can hide, reorder and rename, written once.
 *
 * The Daily and Monthly volume tables (ui/volume-summary.js) both offer the same controls:
 * a "Columns (n/m)" panel, a ⋮ menu on each header and drag-to-reorder. Two copies of
 * that would drift the way every other pair in this codebase has, so the model is here,
 * as pure functions over a layout, and the renderer below is the only one.
 *
 * A layout is what the core stores (VOLUME_LAYOUT_GET / VOLUME_LAYOUT_SET, docs/VOLUME.md):
 *
 *   { order: [keys], hidden: [keys], labels: { key: label } }
 *
 * A def is `{ key, label, num?, locked?, hidden? }`. `locked` is the row's own name (Index
 * day, Month): always first, never hidden, never moved, but it may be renamed. `hidden`
 * is the default for a column nobody has decided about.
 */

import { h } from './dom.js';
import { popover, rowMenu } from '../ui/menu.js';

/** Longest name a column may be given. A header is not a paragraph. */
export const MAX_LABEL = 40;

/** A layout with nothing decided: every column at its default place, visibility and name. */
export const emptyLayout = () => ({ order: [], hidden: [], labels: {} });

/**
 * A layout reduced to keys these defs know, so a stored layout from another version (or
 * a hand-edited one) can never put a column on screen that does not exist.
 * `hidden: null` survives: it means "nobody has decided", and the defaults apply.
 */
export function sanitizeLayout(layout, defs) {
  const known = new Set(defs.map((d) => d.key));
  const l = layout && typeof layout === 'object' ? layout : {};
  const order = Array.isArray(l.order) ? [...new Set(l.order.filter((k) => known.has(k)))] : [];
  const hidden = Array.isArray(l.hidden) ? [...new Set(l.hidden.filter((k) => known.has(k)))] : null;
  const labels = {};
  if (l.labels && typeof l.labels === 'object') {
    for (const [k, v] of Object.entries(l.labels)) {
      const n = typeof v === 'string' ? v.trim().slice(0, MAX_LABEL) : '';
      if (known.has(k) && n) labels[k] = n;
    }
  }
  return { order, hidden, labels };
}

/**
 * The columns as the layout has them: [{ key, label, name, renamed, visible, locked, num }]
 * in display order. A column the stored order has never heard of (a newer version added
 * it) appears at its default place, after the default column before it, with its default
 * visibility — so adding a hidden-by-default column does not show it to everyone.
 */
export function resolveColumns(defs, layout) {
  const l = sanitizeLayout(layout, defs);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  // Every save writes the full order, so an empty order with nothing hidden is a layout
  // nobody has saved yet (the server's answer before anyone arranged the table).
  const decided = l.hidden !== null && (l.order.length > 0 || l.hidden.length > 0);
  const known = new Set(l.order);
  const order = l.order.filter((k) => !byKey.get(k).locked);
  defs.forEach((d, i) => {
    if (d.locked || order.includes(d.key)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(defs[j].key);
      if (k >= 0) { at = k + 1; break; }
    }
    order.splice(at, 0, d.key);
  });
  return [...defs.filter((d) => d.locked).map((d) => d.key), ...order].map((k) => {
    const d = byKey.get(k);
    const own = l.labels[k];
    // Hidden: the person's list when they have one and this column was in their order
    // when they made it; otherwise the column's default.
    const hidden = d.locked ? false
      : decided && (known.has(k) || !l.order.length) ? l.hidden.includes(k) : !!d.hidden;
    return { key: k, label: d.label, name: own || d.label, renamed: !!own, visible: !hidden, locked: !!d.locked, num: !!d.num };
  });
}

/** Only the ones on screen, in order. */
export function visibleColumns(defs, layout) {
  return resolveColumns(defs, layout).filter((c) => c.visible);
}

/** The layout that says exactly what `cols` (resolved) shows, so every write is explicit. */
function fromResolved(cols, labels) {
  return {
    order: cols.map((c) => c.key),
    hidden: cols.filter((c) => !c.visible).map((c) => c.key),
    labels: { ...labels },
  };
}
function edit(defs, layout, fn) {
  const l = sanitizeLayout(layout, defs);
  const cols = resolveColumns(defs, l);
  fn(cols, l.labels);
  return fromResolved(cols, l.labels);
}

/** Show or hide one column. The locked column cannot be hidden. */
export function setShown(defs, layout, key, on) {
  return edit(defs, layout, (cols) => {
    const c = cols.find((x) => x.key === key);
    if (c && !c.locked) c.visible = !!on;
  });
}

/** Every column on screen. Order and names stay as they were. */
export function showAll(defs, layout) {
  return edit(defs, layout, (cols) => { cols.forEach((c) => { c.visible = true; }); });
}

/**
 * Move one column to position `to` among the movable ones (the locked one stays first).
 * Out-of-range positions clamp; an unknown or locked key changes nothing.
 */
export function moveTo(defs, layout, key, to) {
  return edit(defs, layout, (cols) => {
    const lockedN = cols.filter((c) => c.locked).length;
    const from = cols.findIndex((c) => c.key === key);
    if (from < 0 || cols[from].locked) return;
    const [c] = cols.splice(from, 1);
    const at = lockedN + Math.max(0, Math.min(cols.length - lockedN, to));
    cols.splice(at, 0, c);
  });
}

/** Position of `key` among the movable columns, or -1. */
function movableIndex(defs, layout, key) {
  return resolveColumns(defs, layout).filter((c) => !c.locked).findIndex((c) => c.key === key);
}

/**
 * One step left (-1) or right (+1) among the columns on screen, so Move left always moves
 * past the column you can see beside it rather than past a hidden one.
 */
export function moveBy(defs, layout, key, delta) {
  const cols = resolveColumns(defs, layout).filter((c) => !c.locked);
  const shown = cols.filter((c) => c.visible || c.key === key);
  const at = shown.findIndex((c) => c.key === key);
  if (at < 0) return sanitizeFull(defs, layout);
  const target = shown[at + delta];
  if (!target) return sanitizeFull(defs, layout);
  return moveTo(defs, layout, key, cols.findIndex((c) => c.key === target.key));
}

/** Dragged `key` dropped on `onto`: it takes that column's place. */
export function dropOn(defs, layout, key, onto) {
  if (key === onto) return sanitizeFull(defs, layout);
  const to = movableIndex(defs, layout, onto);
  if (to < 0) return sanitizeFull(defs, layout);
  return moveTo(defs, layout, key, to);
}

/** Rename one column. Empty, or the default name typed back, means the default name. */
export function rename(defs, layout, key, name) {
  const d = defs.find((x) => x.key === key);
  return edit(defs, layout, (cols, labels) => {
    if (!d) return;
    const n = String(name ?? '').trim().slice(0, MAX_LABEL);
    if (!n || n === d.label) delete labels[key];
    else labels[key] = n;
  });
}

/** The column's own name again. */
export function resetName(defs, layout, key) {
  return rename(defs, layout, key, '');
}

/** The layout as an explicit one, changed in nothing. */
function sanitizeFull(defs, layout) {
  return edit(defs, layout, () => {});
}

/** "n/m": columns on screen of the columns there are. */
export function countLabel(defs, layout) {
  const cols = resolveColumns(defs, layout);
  return `${cols.filter((c) => c.visible).length}/${cols.length}`;
}

/* --------------------------------- renderer --------------------------------- */

/**
 * The "Columns (n/m) ▾" button and its panel: a tick per column, and Show all.
 *
 * @param o { defs, layout, onChange(layout), id }
 */
export function columnsButton(o) {
  const btn = h('button.btn.sm', {
    type: 'button', id: o.id || null, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    title: 'Choose which columns this table shows',
    onclick: (e) => popover(e.currentTarget, () => {
      const cols = resolveColumns(o.defs, o.layout);
      // The page redraws on every change and this button with it, so the panel is not
      // rebuilt against a trigger that has left the page: the ticks it holds are already
      // what was clicked, and Show all ticks them itself.
      const apply = (next) => { o.layout = next; o.onChange(next); };
      const boxes = [];
      return h('div.colpick',
        ...cols.map((c) => {
          const box = h('input', {
            type: 'checkbox', checked: c.visible, disabled: c.locked,
            onchange: (ev) => apply(setShown(o.defs, o.layout, c.key, ev.target.checked)),
          });
          boxes.push(box);
          return h(`label.colpick-row${c.locked ? '.fixed' : ''}`, box, h('span', c.name));
        }),
        h('div.colpick-foot',
          h('button.btn.sm', { type: 'button', onclick: () => {
            boxes.forEach((b) => { b.checked = true; });
            apply(showAll(o.defs, o.layout));
          } }, 'Show all')));
    }, { title: 'Columns' }),
  }, `Columns (${countLabel(o.defs, o.layout)}) \u25be`);
  return btn;
}

/**
 * A table whose headers carry the column controls.
 *
 * @param o {
 *   defs, layout, rows,            // rows: anything; `cell(key, row)` draws one cell
 *   cell(key, row) -> Node|string,
 *   rowAttrs?(row) -> attrs,        // a class for today's row, say
 *   foot?: [row]                   // drawn after the rows, with the same cells (a totals row)
 *   canEdit: boolean,               // false: no ⋮ menu, no dragging (show/hide stays in the panel)
 *   onChange(layout),
 *   emptyText?: string,
 * }
 */
export function columnTable(o) {
  const cols = visibleColumns(o.defs, o.layout);
  const change = (next) => o.onChange(next);

  const head = cols.map((c, i) => {
    const th = h(`th.colhead${c.num ? '.num' : ''}`, { dataset: { col: c.key }, title: c.renamed ? `${c.name} (${c.label})` : c.name });
    const label = h('span.colhead-name', c.name);
    const fill = () => {
      th.textContent = '';
      th.append(label);
      if (!o.canEdit) return;
      th.append(rowMenu(() => [
        { label: 'Edit name', onClick: () => editName() },
        { label: 'Move left', disabled: c.locked || i <= cols.filter((x) => x.locked).length, onClick: () => change(moveBy(o.defs, o.layout, c.key, -1)) },
        { label: 'Move right', disabled: c.locked || i === cols.length - 1, onClick: () => change(moveBy(o.defs, o.layout, c.key, 1)) },
        { label: 'Hide column', disabled: c.locked, title: c.locked ? 'This column names the row and stays' : '', onClick: () => change(setShown(o.defs, o.layout, c.key, false)) },
        { label: 'Reset name', disabled: !c.renamed, onClick: () => change(resetName(o.defs, o.layout, c.key)) },
      ], { title: `Column: ${c.name}`, menuLabel: `${c.name} column`, trigger: 'button.btn.sm.menu-trigger.colhead-menu' }));
    };
    // Inline, in the header itself: the name is edited where it is read.
    const editName = () => {
      const input = h('input.colhead-input', {
        type: 'text', value: c.renamed ? c.name : '', placeholder: c.label, maxLength: MAX_LABEL,
        'aria-label': `New name for ${c.label} (empty for the default)`,
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fill(); }
        },
      });
      const save = () => change(rename(o.defs, o.layout, c.key, input.value));
      th.textContent = '';
      th.append(h('span.colhead-edit', input,
        h('button.btn.sm.primary', { type: 'button', onclick: save }, 'Save'),
        h('button.btn.sm', { type: 'button', onclick: () => fill() }, 'Cancel')));
      input.focus();
    };
    fill();
    if (o.canEdit && !c.locked) {
      th.draggable = true;
      th.addEventListener('dragstart', (e) => {
        if (e.dataTransfer) { e.dataTransfer.setData('text/plain', c.key); e.dataTransfer.effectAllowed = 'move'; }
        th.classList.add('dragging');
      });
      th.addEventListener('dragend', () => th.classList.remove('dragging'));
    }
    if (o.canEdit) {
      th.addEventListener('dragover', (e) => { if (!c.locked) { e.preventDefault(); th.classList.add('drop'); } });
      th.addEventListener('dragleave', () => th.classList.remove('drop'));
      th.addEventListener('drop', (e) => {
        e.preventDefault();
        th.classList.remove('drop');
        const key = e.dataTransfer && e.dataTransfer.getData('text/plain');
        if (key && key !== c.key && !c.locked) change(dropOn(o.defs, o.layout, key, c.key));
      });
    }
    return th;
  });

  const tr = (row, cls) => h(cls ? `tr.${cls}` : 'tr', o.rowAttrs ? o.rowAttrs(row) : null,
    ...cols.map((c) => {
      const v = o.cell(c.key, row);
      return h(c.num ? 'td.num' : 'td', v === null || v === undefined ? '' : v);
    }));
  const body = h('tbody', ...o.rows.map((r) => tr(r)));
  if (!o.rows.length) body.append(h('tr', h('td', { colspan: cols.length }, h('div.tbl-empty', o.emptyText || 'Nothing to show'))));
  const foot = o.foot && o.foot.length ? h('tfoot', ...o.foot.map((r) => tr(r, 'total'))) : null;
  return h('div.tbl-wrap', h('table.tbl.coltbl', h('thead', h('tr', ...head)), body, foot));
}
