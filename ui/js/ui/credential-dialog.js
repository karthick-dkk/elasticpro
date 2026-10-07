/**
 * Credential prompt.
 *
 * Shown when clusters.yaml carries no usable secret (or when Elasticsearch rejects the
 * one it does carry). One credential is typed once and applied to every cluster URL with
 * a single click. It lives in memory only — never in the YAML, never in browser storage.
 */

import { h, mount, clear, $ } from '../lib/dom.js';
import {
  state, clusters, client, clustersNeedingCredential, clustersWithAuthError,
  suggestedUsername, setSessionCredential, continueAnonymously, refreshAll,
} from '../core/state.js';
import { workerStatus, vaultGet, vaultSet, vaultDel } from '../core/es.js';
import { toast } from './menu.js';

let open = false;

/**
 * True when this session's cluster list came from the server with the credentials taken
 * out — anyone below admin on the hosted build. They cannot give the server a credential
 * (the core refuses PRIME from them), so a sign-in form would be a form that always fails.
 */
export function serverHoldsCredentials() {
  return !!(state.config && state.config.serverView);
}

/** What to tell them instead: who can fix it. */
export function serverCredentialMessage() {
  const bad = clustersWithAuthError().map((c) => c.name);
  return bad.length
    ? `Elasticsearch rejected the server's credential for ${bad.join(', ')}. An ElasticPro administrator has to sign ${bad.length === 1 ? 'it' : 'them'} in again — you cannot do it from this account.`
    : 'Credentials are held by the server. An ElasticPro administrator manages them.';
}

/** Vault entry name: one per config file, so two YAMLs never share a credential. */
function vaultScope() {
  const meta = state.config && state.config.fileMeta;
  return 'config:' + ((meta && (meta.path || meta.name)) || 'default');
}

/**
 * Sign in silently with a credential the operator chose to remember in the OS vault
 * (Windows Credential Manager). Returns true when it was applied.
 */
export async function tryVaultCredential() {
  try {
    const st = await workerStatus();
    if (!st || !st.vault) return false;
    const r = await vaultGet(vaultScope());
    if (!r || !r.ok || !r.found || !r.value) return false;
    const cred = JSON.parse(r.value);
    if (!cred || typeof cred !== 'object') return false;
    await setSessionCredential(cred, { overrideAll: false });
    return true;
  } catch (_) { return false; }
}

export async function forgetVaultCredential() {
  try { await vaultDel(vaultScope()); } catch (_) { /* ignore */ }
}

const MODES = [
  { id: 'basic', label: 'Username & password' },
  { id: 'apikey', label: 'API key' },
  { id: 'bearer', label: 'Bearer token' },
];

export function credentialDialogOpen() { return open; }

/**
 * @param {'startup'|'auth_error'|'manual'} reason
 */
export function showCredentialDialog(reason = 'manual') {
  if (open) return;
  // Every way in — the top-bar button, the page banners, the automatic prompt after a
  // 401 — comes through here, so this is the one place that has to know.
  if (serverHoldsCredentials()) {
    toast(serverCredentialMessage(), 'warn', 9000, { key: 'server-credential' });
    return;
  }
  open = true;

  const needing = clustersNeedingCredential();
  const failing = clustersWithAuthError();
  const targets = needing.length ? needing : failing.length ? failing : clusters();
  const someHaveFileCreds = clusters().some((c) => c.credSource === 'shared' || c.credSource === 'cluster');

  const ui = { mode: 'basic', overrideAll: needing.length === 0, busy: false, results: null, error: null, remember: false, vault: false };
  workerStatus().then((st) => {
    if (st && st.vault) ui.vault = true;
    if (st && st.edition === 'hosted') ui.hosted = true;
    if (open && st && (st.vault || st.edition === 'hosted')) draw();
  });

  const overlay = h('div.modal-overlay', {
    onclick: (e) => { if (e.target === overlay && !ui.busy) close(); },
  });
  const dialog = h('div.modal.creds', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Elasticsearch credentials' });
  overlay.append(dialog);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);

  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape' && !ui.busy) { e.preventDefault(); close(); }
  }

  function close() {
    open = false;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }

  function readForm() {
    if (ui.mode === 'apikey') {
      const v = ($('#cd-apikey') || {}).value || '';
      return v.trim() ? { apiKey: v.trim() } : null;
    }
    if (ui.mode === 'bearer') {
      const v = ($('#cd-bearer') || {}).value || '';
      return v.trim() ? { bearer: v.trim() } : null;
    }
    const u = (($('#cd-user') || {}).value || '').trim();
    const p = ($('#cd-pass') || {}).value || '';
    return u ? { username: u, password: p } : null;
  }

  async function connect() {
    const cred = readForm();
    if (!cred) { ui.error = ui.mode === 'basic' ? 'Enter a username.' : 'Enter a value.'; return draw(); }
    ui.busy = true; ui.error = null; ui.results = null; draw();

    await setSessionCredential(cred, { overrideAll: ui.overrideAll });
    if (ui.vault) {
      if (ui.remember) await vaultSet(vaultScope(), JSON.stringify(cred));
      else await vaultDel(vaultScope());
    }

    const probeList = ui.overrideAll ? clusters() : targets;
    const results = [];
    await Promise.all(probeList.map(async (c) => {
      const cl = client(c.id);
      try {
        const info = await cl.root();
        results.push({ c, ok: true, detail: `${(info && info.cluster_name) || 'connected'} · ES ${(info && info.version && info.version.number) || '?'}` });
      } catch (e) {
        const res = e.res || {};
        results.push({
          c, ok: false,
          detail: res.status === 401 || res.status === 403 ? 'Credential rejected (HTTP ' + res.status + ')'
            : res.kind === 'tls_untrusted' ? 'Certificate not trusted yet — decide on the Clusters page'
            : res.kind === 'tunnel_error' ? res.message
            : e.message || 'No response',
          tls: /^tls/.test(res.kind || '') || res.kind === 'tunnel_error',
        });
      }
    }));
    results.sort((a, b) => Number(a.ok) - Number(b.ok));
    ui.results = results;
    ui.busy = false;
    // A fleet rarely shares one credential: ten clusters may take it and the eleventh
    // refuse. Without this the dialog just stops, every row has to be read to work out
    // whether anything worked, and the outcome looks like failure when it mostly was not.
    const okCount = results.filter((r) => r.ok).length;
    ui.summary = okCount === results.length ? null
      : okCount === 0 ? 'No cluster accepted this credential.'
      : `${okCount} of ${results.length} clusters accepted it. The rest need a different one — `
        + 'this dialog stays open so you can try another, and what already connected stays connected.';
    draw();

    if (results.every((r) => r.ok)) {
      refreshAll({ force: true });
      setTimeout(() => { if (open) close(); }, 900);
    }
  }

  async function anonymous() {
    ui.busy = true; draw();
    await continueAnonymously();
    close();
    refreshAll({ force: true });
  }

  function draw() {
    const title = reason === 'auth_error' ? 'Elasticsearch rejected the stored credential'
      : needing.length ? 'Credentials needed' : 'Set credentials';

    const sub = reason === 'auth_error'
      ? `${failing.length} cluster${failing.length === 1 ? '' : 's'} returned 401/403. Enter a credential to use for this session.`
      : needing.length
        ? `clusters.yaml does not contain a password for ${needing.length} of ${clusters().length} cluster${clusters().length === 1 ? '' : 's'}. Enter one and it will be used for all of them.`
        : 'Replace the credential from the file for this browser session.';

    mount(dialog,
      h('div.modal-head',
        h('div', h('h2', title), h('p.sub', sub)),
        h('button.btn.ghost.sm', { onclick: () => !ui.busy && close(), 'aria-label': 'Close', title: 'Close (Esc)' }, '×')),

      h('div.modal-body',
        h('div.seg', ...MODES.map((m) => h('button.btn.sm', {
          class: ui.mode === m.id ? 'primary' : '',
          onclick: () => { ui.mode = m.id; ui.error = null; draw(); },
        }, m.label))),

        ui.mode === 'basic'
          ? h('div', { style: { display: 'grid', gap: '9px' } },
              h('label.field', 'Username',
                h('input#cd-user', { type: 'text', autocomplete: 'off', spellcheck: false,
                  value: suggestedUsername() || 'elastic',
                  onkeydown: (e) => { if (e.key === 'Enter') $('#cd-pass').focus(); } })),
              h('label.field', 'Password',
                h('div', { style: { display: 'flex', gap: '6px' } },
                  h('input#cd-pass', { type: 'password', autocomplete: 'off', style: { flex: '1' },
                    onkeydown: (e) => { if (e.key === 'Enter') connect(); } }),
                  h('button.btn.sm', { type: 'button', onclick: () => {
                    const el = $('#cd-pass'); el.type = el.type === 'password' ? 'text' : 'password';
                  } }, 'Show'))))
          : ui.mode === 'apikey'
            ? h('label.field', 'API key',
                h('input#cd-apikey', { type: 'password', autocomplete: 'off', spellcheck: false,
                  placeholder: 'id:api_key  — or the base64 "encoded" value',
                  onkeydown: (e) => { if (e.key === 'Enter') connect(); } }))
            : h('label.field', 'Bearer token',
                h('input#cd-bearer', { type: 'password', autocomplete: 'off', spellcheck: false,
                  placeholder: 'eyJhbGciOi…',
                  onkeydown: (e) => { if (e.key === 'Enter') connect(); } })),

        someHaveFileCreds
          ? h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', marginTop: '2px' } },
              h('input', { type: 'checkbox', checked: ui.overrideAll, style: { marginTop: '2px' },
                onchange: (e) => { ui.overrideAll = e.target.checked; } }),
              h('span', h('b', 'Use it for every cluster'),
                h('div.muted', { style: { fontSize: '11.5px' } },
                  'Also replaces the credentials that clusters.yaml does provide, for this session only.')))
          : null,

        h('div.cd-targets',
          h('div.muted', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '5px' } },
            ui.overrideAll ? `Will connect all ${clusters().length} cluster(s)` : `Will connect ${targets.length} cluster(s)`),
          ...(ui.results
            ? ui.results.map((r) => h('div.cd-row',
                h(`span.pill.${r.ok ? 'green' : 'red'}`, h('i.dot'), r.ok ? 'connected' : 'failed'),
                h('span', { style: { fontWeight: 600 } }, r.c.name),
                h('span.muted.trunc', { style: { fontSize: '11.5px' } }, r.detail),
                r.tls ? h('span.muted', { style: { marginLeft: 'auto', fontSize: '11px' } }, 'see Clusters page') : null))
            : (ui.overrideAll ? clusters() : targets).map((c) => h('div.cd-row',
                h('span.pill.grey', h('i.dot'), 'pending'),
                h('span', { style: { fontWeight: 600 } }, c.name),
                h('span.mono.muted.trunc', c.url))))),

        // `ui.vault && !ui.hosted`: the OS vault belongs to the desktop build. On hosted this
        // rendered "Stores it in the Windows Credential Manager" immediately above the note
        // below saying the credential is kept on the server — two contradictory sentences,
        // one of them false, on a Linux deployment with no Windows anything.
        ui.vault && !ui.hosted
          ? h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', marginTop: '2px' } },
              h('input', { type: 'checkbox', checked: ui.remember, style: { marginTop: '2px' },
                onchange: (e) => { ui.remember = e.target.checked; } }),
              h('span', h('b', 'Remember on this machine'),
                h('div.muted', { style: { fontSize: '11.5px' } },
                  'Stores it in the Windows Credential Manager (your account only), so the next start signs in without asking. Untick to remove a remembered one.')))
          : null,

        ui.summary ? h('div.banner.warn', { style: { margin: 0 } }, ui.summary) : null,

        ui.error ? h('div.banner.err', { style: { margin: 0 } }, ui.error) : null,

        // Hosted keeps what an admin applies, so the people who may not hold a credential
        // can still use the clusters after a restart. Saying "kept in memory" there would
        // be the one sentence on this dialog that is not true.
        ui.hosted
          ? h('div.cd-note',
              h('b', 'Kept on the server. '),
              'This credential is sent to the ElasticPro server, which uses it for everyone allowed to see this cluster, ',
              'and keeps it in its data volume (primed.json, readable by the service only) so a restart does not need an admin to sign in again. ',
              'It is not written to the config file and is never sent to anyone else’s browser.')
          : h('div.cd-note',
              h('b', 'Kept in memory. '),
              'This credential lives in the app process for as long as it is open and is not written to clusters.yaml. ',
              'It leaves memory only if you tick "remember on this machine", and then only into the OS vault.')),

      h('div.modal-foot',
        needing.length
          ? h('button.btn.ghost', { onclick: anonymous, disabled: ui.busy, title: 'For clusters with security disabled' }, 'Continue without credentials')
          : null,
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
          // "Cancel" once results are on screen would be untrue: the credential has already
          // been applied to everything that accepted it, and closing keeps that. The dialog
          // only auto-closes when every cluster succeeded, so a mixed result leaves the
          // person looking for a way out — and the only one offered said it undid their work.
          h('button.btn', { onclick: () => !ui.busy && close(), disabled: ui.busy },
            ui.results ? 'Done' : 'Cancel'),
          h('button.btn.primary', { onclick: connect, disabled: ui.busy },
            ui.busy ? h('span', h('span.spin'), ' Connecting…')
              : `Connect ${ui.overrideAll ? clusters().length : targets.length} cluster${(ui.overrideAll ? clusters().length : targets.length) === 1 ? '' : 's'}`))));

    const first = $('#cd-user') || $('#cd-apikey') || $('#cd-bearer');
    if (first && !ui.busy && !ui.results) setTimeout(() => first.focus(), 0);
  }

  draw();
}
