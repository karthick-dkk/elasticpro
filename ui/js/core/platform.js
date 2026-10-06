/**
 * Desktop platform glue: file dialogs, reading the config file through the core,
 * remembering its path, saving files. Only a PATH is remembered (localStorage); the
 * file's contents — and so the credential — are read into memory on every start.
 */

import { bridge, isTauri } from './transport.js';

const KEY_PATH = 'elasticpro.configPath';

export function savedConfigPath() {
  try { return localStorage.getItem(KEY_PATH) || ''; } catch { return ''; }
}
export function rememberConfigPath(p) {
  try { if (p) localStorage.setItem(KEY_PATH, p); else localStorage.removeItem(KEY_PATH); } catch { /* ignore */ }
}

/** Native open dialog → absolute path, or '' when cancelled. */
export async function pickConfigPath() {
  if (isTauri && globalThis.__TAURI__.dialog) {
    const p = await globalThis.__TAURI__.dialog.open({
      multiple: false, directory: false, title: 'Open clusters.yaml',
      filters: [{ name: 'YAML config', extensions: ['yaml', 'yml'] }, { name: 'All files', extensions: ['*'] }],
    });
    return typeof p === 'string' ? p : (p && p.path) || '';
  }
  // dev bridge: no native dialog — ask for a path the core can read
  const { inputDialog } = await import('../ui/modal.js');
  return inputDialog('Open a config', 'Path of clusters.yaml (read by the core process)', savedConfigPath() || 'clusters.yaml', { mono: true, yes: 'Open' });
}

/** Native open dialog for any file (e.g. an SSH key) → absolute path or ''. */
export async function pickFilePath(title = 'Choose a file') {
  if (isTauri && globalThis.__TAURI__.dialog) {
    const p = await globalThis.__TAURI__.dialog.open({ multiple: false, directory: false, title });
    return typeof p === 'string' ? p : (p && p.path) || '';
  }
  const { inputDialog } = await import('../ui/modal.js');
  return inputDialog(title, 'Path readable by the core', '', { mono: true, yes: 'Use this file' });
}

/** @returns {{ok:boolean, text?:string, size?:number, lastModified?:number, message?:string}} */
export async function readConfigText(path) {
  return bridge({ type: 'CONFIG_READ', path });
}

/** Save text to a location the user picks (falls back to a browser download). */
export async function saveTextAs(suggestedName, text) {
  if (isTauri && globalThis.__TAURI__.dialog) {
    const p = await globalThis.__TAURI__.dialog.save({ defaultPath: suggestedName, title: `Save ${suggestedName}` });
    if (!p) return { ok: false, cancelled: true };
    return bridge({ type: 'FILE_WRITE', path: p, text });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return { ok: true };
}

export async function openExternal(url) {
  if (isTauri && globalThis.__TAURI__.opener) { try { await globalThis.__TAURI__.opener.openUrl(url); return; } catch { /* fall through */ } }
  window.open(url, '_blank', 'noopener');
}

export const desktop = true;
