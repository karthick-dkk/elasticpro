/**
 * The app's one modal. A promise that resolves with whatever the footer buttons pass to
 * `done()`, or null when the operator dismisses it (Escape, the ×, or the backdrop).
 */

import { h, mount, $ } from '../lib/dom.js';

export function modal(title, sub, bodyNodes, actions, { width = '640px', cls = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = h(/\bdrawer\b/.test(cls) ? 'div.modal-overlay.drawer-overlay' : 'div.modal-overlay',
      { onclick: (e) => { if (e.target === overlay) done(null); } });
    // cls may name several classes ('evidence drawer'); a class token cannot hold a space.
    const dialog = h(cls ? `div.modal.${cls.trim().split(/\s+/).join('.')}` : 'div.modal', { role: 'dialog', 'aria-modal': 'true', style: { maxWidth: width, width: '96vw' } });
    const msg = h('div.modal-msg');
    function done(v) { window.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(v); }
    // On the window and in the capture phase, so Escape reaches the open dialog before any
    // page or menu handler can stop it on the way.
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } }
    window.addEventListener('keydown', onKey, true);
    const ctx = {
      done,
      // Five dialogs called ctx.close() — a name that did not exist, so their Cancel and
      // Done buttons threw and did nothing. Both names work now.
      close: done,
      dialog,
      msg: (text, cls = 'banner err') =>
        mount(msg, text ? h(`div.${cls.replace(/ /g, '.')}`, { style: { margin: 0 } }, text) : null),
      /** Run an async action with the button disabled and any failure shown in the dialog. */
      async run(btn, fn) {
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = 'Working…';
        ctx.msg(null);
        try { return await fn(); }
        catch (e) { ctx.msg(e && e.message ? e.message : String(e)); return undefined; }
        finally { btn.disabled = false; btn.textContent = label; }
      },
    };
    mount(dialog,
      h('div.modal-head', h('div', h('h2', title), sub ? h('p.sub', sub) : null),
        h('button.btn.ghost.sm', { onclick: () => done(null), 'aria-label': 'Close' }, '×')),
      h('div.modal-body', ...bodyNodes, msg),
      h('div.modal-foot', ...actions(ctx)));
    overlay.append(dialog);
    document.body.append(overlay);
    const first = dialog.querySelector('input,select,textarea');
    if (first) setTimeout(() => first.focus(), 0);
  });
}

/* ------------------------------- form helpers -------------------------------- */

export function field(label, input, hint) {
  return h('label.field', label, input, hint ? h('span.muted', { style: { fontSize: '11px' } }, hint) : null);
}

export function text(id, value, opts = {}) {
  return h('input', {
    id, type: opts.type || 'text', value: value == null ? '' : String(value),
    // "new-password" is the one value browsers honour for a password they must not fill;
    // "off" is ignored for fields that look like names. The data attributes keep password
    // managers' own popups away too — a suggestion list swallows the first Escape.
    spellcheck: false, autocomplete: opts.type === 'password' ? 'new-password' : 'off',
    'data-1p-ignore': '', 'data-lpignore': 'true', 'data-form-type': 'other',
    placeholder: opts.placeholder || '',
    style: { fontFamily: opts.mono ? 'var(--mono)' : '', ...(opts.style || {}) },
  });
}

export function select(id, value, options) {
  const s = h('select', { id }, ...options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  return s;
}

export function checkbox(id, label, value, hint) {
  return h('label', { style: { display: 'flex', gap: '7px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '12.5px' } },
    h('input', { id, type: 'checkbox', checked: !!value, style: { marginTop: '2px', cursor: 'pointer' } }),
    h('span', label, hint ? h('div.muted', { style: { fontSize: '11px' } }, hint) : null));
}

export function val(id) { const el = $(`#${id}`); return el ? el.value : ''; }
export function checked(id) { const el = $(`#${id}`); return !!(el && el.checked); }

/* ------------------------------ confirmation -------------------------------- */

/**
 * A yes/no question the operator must answer before something irreversible happens.
 *
 * The browser's own confirm() offers OK/Cancel, which says nothing about what is
 * about to occur — this names the action in the button, so the answer is deliberate.
 * `typeToConfirm` demands the exact text back. It is for naming the one thing being
 * destroyed — a repository, by its name — and not for counting. Asking somebody to type
 * "40" before deleting forty indices sounds careful and is not: the number is on the
 * screen above the box, so copying it is a reflex rather than a decision, and every
 * deletion trained the reflex. Those flows warn about what is actually at stake instead.
 *
 */
export function confirmDialog(title, body, opts = {}) {
  const {
    yes = 'Yes', no = 'No', danger = false, typeToConfirm = null, hint = null, width = '520px',
  } = opts;

  const nodes = [
    typeof body === 'string'
      ? h('div', { style: { fontSize: '13px', lineHeight: '1.55', whiteSpace: 'pre-wrap' } }, body)
      : body,
    hint ? h('div.muted', { style: { fontSize: '11.5px' } }, hint) : null,
    typeToConfirm
      ? field(`Type ${typeToConfirm} to confirm`,
          text('confirm-echo', '', { mono: true, placeholder: typeToConfirm }))
      : null,
  ].filter(Boolean);

  // Callers pass the action in lower case so it reads as a phrase ('delete the ticked
  // ones'); a button is a label, not a sentence, so it starts with a capital.
  const action = yes.charAt(0).toUpperCase() + yes.slice(1);

  return modal(title, null, nodes, (ctx) => [
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done(false) }, no),
      h(`button.btn.${danger ? 'danger' : 'primary'}`, {
        onclick: () => {
          if (typeToConfirm && val('confirm-echo').trim() !== typeToConfirm) {
            return ctx.msg(`Type ${typeToConfirm} exactly to confirm.`);
          }
          ctx.done(true);
        },
      }, action)),
  ], { width }).then((v) => v === true);
}

/** A list of names, for a confirmation that must name what it will affect. */
export function nameList(names, max = 14) {
  return h('div.mono', {
    style: { fontSize: '11.5px', maxHeight: '190px', overflow: 'auto', marginTop: '2px',
             border: '1px solid var(--border)', borderRadius: '6px', padding: '7px' },
  }, names.slice(0, max).map((n) => h('div', n)),
     names.length > max ? h('div.muted', `…and ${names.length - max} more`) : null);
}

/**
 * Ask for one line of text, in the app's own dialog — never the browser's prompt(),
 * which is unstyled, names the server instead of the app, and is blocked in some frames.
 * Resolves to the trimmed text, or '' when cancelled.
 */
export function inputDialog(title, label, initial = '', opts = {}) {
  const id = `input-dialog-${Date.now()}`;
  return modal(title, opts.sub || null, [
    field(label, text(id, initial, { mono: !!opts.mono, placeholder: opts.placeholder || '' }), opts.hint || null),
  ], (ctx) => [
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done('') }, 'Cancel'),
      h('button.btn.primary', { onclick: () => ctx.done((val(id) || '').trim()) }, opts.yes || 'OK')),
  ], { width: opts.width || '520px' }).then((v) => (typeof v === 'string' ? v : ''));
}
