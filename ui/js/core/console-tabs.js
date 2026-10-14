/**
 * REST console tabs — the model, pure. Up to MAX_TABS queries open side by side, each with
 * its own method, path and body, remembered across reloads.
 *
 * What is remembered is what a person typed, with secrets taken out first (lib/redact.js):
 * a body's password, token or key field is saved as "[redacted]", so no secret reaches
 * browser storage. A response is never stored — it belongs to this page visit.
 */
import { redactSecrets } from '../lib/redact.js';

export const MAX_TABS = 10;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export function blankTab(from = {}) {
  return {
    id: newId(),
    name: '',                                   // empty: the title follows the request
    method: METHODS.has(from.method) ? from.method : 'GET',
    path: typeof from.path === 'string' ? from.path : '/_cluster/health',
    body: typeof from.body === 'string' ? from.body : '',
  };
}

/** "GET _cat/indices" — or the name the person gave it. */
export function tabTitle(t) {
  if (t.name && t.name.trim()) return t.name.trim().slice(0, 40);
  const p = String(t.path || '/').replace(/^\/+/, '').split('?')[0] || '/';
  return `${t.method} ${p}`.slice(0, 40);
}

/** A fresh state: one tab. */
export function initialState(seed) {
  const t = blankTab(seed);
  return { tabs: [t], active: t.id };
}

/** Add a tab (a copy of `from`, or blank) and make it active. Refused at MAX_TABS. */
export function addTab(st, from) {
  if (st.tabs.length >= MAX_TABS) return { st, added: false };
  const t = blankTab(from);
  return { st: { tabs: [...st.tabs, t], active: t.id }, added: true };
}

/** Close a tab; the last one is never closed (it is emptied instead). */
export function closeTab(st, id) {
  const i = st.tabs.findIndex((t) => t.id === id);
  if (i < 0) return st;
  if (st.tabs.length === 1) return initialState();
  const tabs = st.tabs.filter((t) => t.id !== id);
  const active = st.active === id ? tabs[Math.max(0, i - 1)].id : st.active;
  return { tabs, active };
}

export function updateTab(st, id, patch) {
  return { ...st, tabs: st.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

export function activeTab(st) {
  return st.tabs.find((t) => t.id === st.active) || st.tabs[0];
}

/** What is written to storage: redacted bodies, no responses, at most MAX_TABS. */
export function toStored(st) {
  return {
    v: 1, active: st.active,
    tabs: st.tabs.slice(0, MAX_TABS).map((t) => ({ id: t.id, name: t.name || '', method: t.method, path: t.path, body: redactSecrets(t.body || '') })),
  };
}

/** Read back what toStored wrote — anything malformed becomes a fresh state, never an error. */
export function fromStored(raw) {
  if (!raw || raw.v !== 1 || !Array.isArray(raw.tabs) || !raw.tabs.length) return null;
  const tabs = raw.tabs.slice(0, MAX_TABS).filter((t) => t && typeof t.id === 'string')
    .map((t) => ({ ...blankTab(t), id: t.id, name: typeof t.name === 'string' ? t.name.slice(0, 40) : '' }));
  if (!tabs.length) return null;
  return { tabs, active: tabs.some((t) => t.id === raw.active) ? raw.active : tabs[0].id };
}
