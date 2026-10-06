/**
 * Reading a file the operator chose in the browser, and putting it where the core can
 * use it.
 *
 * The desktop app does not need any of this: the file is already on the machine the core
 * runs on, so a native picker hands over a path and nothing moves. Hosted is the case
 * that does — the file is on the operator's laptop and the core is on a server, so
 * "Browse…" there can only ever list paths on the server, which is not where the file is.
 *
 * So: a native picker where one exists, an upload where one does not, decided by the same
 * `isTauri` the transport uses rather than by guessing.
 */

import { h } from '../lib/dom.js';
import { bridge, isTauri } from '../core/transport.js';

/** Refuse a file big enough that reading it would freeze the tab. */
const MAX_BYTES = 512 * 1024;

/**
 * A hidden file input dressed as a button.
 *
 * `<label>` wrapping the input rather than a button calling .click(): it works with the
 * keyboard for free, and a button that programmatically clicks a hidden input is the
 * usual way that stops working.
 */
export function filePickerButton(label, { accept = '', onText, className = 'btn.sm' } = {}) {
  return h(`label.${className}`, {
    style: { position: 'relative', overflow: 'hidden', cursor: 'pointer' },
    title: 'Choose a file on this computer',
  },
  label,
  h('input', {
    type: 'file',
    accept,
    style: { position: 'absolute', inset: '0', opacity: '0', cursor: 'pointer' },
    onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      // Cleared so choosing the same file twice in a row still fires a change.
      e.target.value = '';
      if (!f) return;
      if (f.size > MAX_BYTES) {
        onText(null, `${f.name} is ${Math.round(f.size / 1024)} KB — that is far larger than a `
                   + 'key or a config, so it is probably not the file you meant.');
        return;
      }
      try {
        onText(await f.text(), null, f.name);
      } catch (err) {
        onText(null, `Could not read ${f.name}: ${err.message || err}`);
      }
    },
  }));
}

/** True where the core and the browser are the same machine, so a path is enough. */
export function canPickByPath() { return isTauri; }

/**
 * Put a private key where the core can read it.
 *
 * Returns the path to write into the jump host's keyFile. The key is never read back —
 * see vault_files.rs — so this is the only moment the UI ever holds it, and it is not
 * kept anywhere after this call returns.
 */
export async function uploadKey(name, text) {
  const res = await bridge({ type: 'KEY_UPLOAD', name, text });
  if (!res || !res.ok) throw new Error((res && res.message) || 'Upload failed.');
  return res.key;
}

export async function listKeys() {
  const res = await bridge({ type: 'KEY_LIST' });
  return (res && res.ok && res.keys) || [];
}

export async function deleteKey(name) {
  const res = await bridge({ type: 'KEY_DELETE', name });
  if (!res || !res.ok) throw new Error((res && res.message) || 'Could not remove it.');
  return res.keys || [];
}

/* --------------------------------- config history -------------------------------- */

export async function configHistory() {
  const res = await bridge({ type: 'CONFIG_HISTORY' });
  return (res && res.ok && res.versions) || [];
}

/** The stored text of one version. The caller loads it the same way it loads any config. */
export async function readVersion(id) {
  const res = await bridge({ type: 'CONFIG_RESTORE', id });
  if (!res || !res.ok) throw new Error((res && res.message) || 'Could not read that version.');
  return res.text;
}
