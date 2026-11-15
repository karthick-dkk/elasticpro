/** The "?" sheet: a small dialog drawn from core/shortcuts.js. Esc or × closes it (the modal's own). */
import { h } from '../lib/dom.js';
import { modal } from './modal.js';
import { SHORTCUTS } from '../core/shortcuts.js';

let open = false;

export function showShortcuts() {
  if (open || document.querySelector('.modal-overlay')) return;
  open = true;
  const kbd = (keys) => h('span', ...keys.flatMap((k, i) => [i ? ' + ' : '', h('kbd.mono', { style: { padding: '0 5px', border: '1px solid var(--border, #ccc)', borderRadius: '4px', fontSize: '11px' } }, k)]));
  const rows = SHORTCUTS.map((s) => h('tr', { style: { height: '32px' } },
    h('td', { style: { whiteSpace: 'nowrap' } }, kbd(s.keys), s.alt ? [h('span.muted', ' or '), kbd(s.alt)] : null),
    h('td', s.does),
    h('td.muted', { style: { fontSize: '11.5px' } }, s.where)));
  modal('Keyboard shortcuts', null, [h('table', { id: 'shortcut-sheet' }, h('tbody', ...rows))], (ctx) => [h('button.btn', { onclick: () => ctx.done(null) }, 'Close')], { width: '640px' })
    .then(() => { open = false; });
}
