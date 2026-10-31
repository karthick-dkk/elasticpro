/**
 * Credential prompt.
 *
 * Shown when the config file carries no usable secret (or when Elasticsearch rejects the
 * one it does carry). One credential is typed once and applied to every cluster URL with
 * a single click. It lives in memory only — never in the YAML, never in browser storage.
 */

import { h, mount, clear, $ } from '../lib/dom.js';
import {
  state, clusters, client, clustersNeedingCredential, clustersWithAuthError,
  suggestedUsername, setSessionCredential, continueAnonymously, refreshAll, configFileName, reprime,
  reconnectWithServerCredentials,
} from '../core/state.js';
import { workerStatus, vaultGet, vaultSet, vaultDel } from '../core/es.js';
import { toast } from './menu.js';
import { credentialsKeptOnServer, keptCredentials, keptFor, keepCredential, keptLine, DEFAULT_CREDENTIAL } from '../core/server-credentials.js';
import { editCluster, rawClusterOf } from './config-editor.js';

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
  if (!credentialsKeptOnServer()) { openDialog(reason, null); return; }
  // Hosted (0.3.46): what the server keeps decides what this dialog is. With a default, a
  // cluster that merely "needs" a credential is covered by it — re-primed, and told so, with
  // no form; one that rejected it is offered a credential of its own, not a sign-in form.
  keptCredentials().then(async (status) => {
    const st = status && status.ok ? status : null;
    if (st && st.default && reason !== 'auth_error' && !clustersWithAuthError().length) {
      if (clustersNeedingCredential().length) await reprime();
      if (!clustersNeedingCredential().length) {
        open = false;
        toast(`Using the default credential (${keptLine(st.default)}) — nothing to type.`, 'ok', 6000, { key: 'default-credential' });
        refreshAll({ force: true });
        return;
      }
    }
    openDialog(reason, st);
  }, () => openDialog(reason, null));
}

/** The dialog itself; `status` is CREDENTIAL_STATUS on hosted (null elsewhere, or unreadable). */
function openDialog(reason, status) {
  const needing = clustersNeedingCredential();
  const failing = clustersWithAuthError();
  const targets = needing.length ? needing : failing.length ? failing : clusters();
  const someHaveFileCreds = clusters().some((c) => c.credSource === 'shared' || c.credSource === 'cluster');
  const keptDefault = status ? keptFor(status, DEFAULT_CREDENTIAL) : null;
  // Clusters that rejected the default itself (no credential of their own kept): each needs one
  // of its own. Shown as that, with a way to set it — the generic form stays one press away.
  const rejected = keptDefault ? failing.filter((c) => !keptFor(status, c.id)) : [];
  // Hosted, a default kept and not being replaced: what is typed is kept for exactly these —
  // config clusters this dialog is about — and the list says so, not "all N".
  const keptTargets = targets.filter((c) => c.source !== 'zabbix');

  const ui = { mode: 'basic', overrideAll: needing.length === 0, busy: false, results: null, error: null, remember: false, vault: false,
               hosted: credentialsKeptOnServer(), replaceDefault: false, view: rejected.length && !needing.length ? 'rejected' : 'form' };
  // The clusters this dialog acts on, as the list, the button and the probe all count them.
  const listed = () => (ui.hosted ? (keptDefault && !ui.replaceDefault ? keptTargets : targets)
    : ui.overrideAll ? clusters() : targets);
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

    // Hosted: the server keeps it, encrypted — as the default every cluster without its own
    // uses, and as the own credential of a failing cluster that had one — so this is the last
    // time anyone types it, on this page load or any other.
    // An existing default is never replaced silently (0.3.46): only with the box ticked. Left
    // unticked, what is typed becomes the own credential of the clusters this dialog is for.
    // The browser holds nothing typed on hosted: no session credential, so nothing rides a later
    // PRIME as the shared one — the page reconnects with what the server now resolves.
    if (credentialsKeptOnServer()) {
      try {
        const now = await keptCredentials();
        const hasDefault = !!keptFor(now, DEFAULT_CREDENTIAL);
        if (hasDefault && !ui.replaceDefault) {
          for (const c of keptTargets) await keepCredential(c.id, cred);
        } else {
          // Ticked: replace it. Unticked with none at open: set it — unless one appeared since.
          await keepCredential(DEFAULT_CREDENTIAL, cred, { onlyIfAbsent: !ui.replaceDefault });
          for (const c of targets) if (keptFor(now, c.id)) await keepCredential(c.id, cred);
        }
      } catch (e) {
        ui.busy = false;
        ui.error = e.kind === 'exists' ? `A default credential was set meanwhile${e.user ? ` (user ${e.user})` : ''}; it was not replaced. Close and open this dialog again.`
          : `The server did not keep it: ${e.message}`;
        return draw();
      }
      await reconnectWithServerCredentials();
    } else {
      await setSessionCredential(cred, { overrideAll: ui.overrideAll });
      if (ui.vault) {
        if (ui.remember) await vaultSet(vaultScope(), JSON.stringify(cred));
        else await vaultDel(vaultScope());
      }
    }

    const probeList = listed();
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

  function drawRejected() {
    const names = rejected.map((c) => c.name).join(', ');
    mount(dialog,
      h('div.modal-head',
        h('div', h('h2', `The default credential was rejected by ${names}`),
          h('p.sub', `Every other cluster without its own keeps signing in with the default (${keptLine(keptDefault)}). `
            + `Give ${rejected.length === 1 ? 'this cluster' : 'these clusters'} a credential of ${rejected.length === 1 ? 'its' : 'their'} own.`)),
        h('button.btn.ghost.sm', { onclick: () => close(), 'aria-label': 'Close', title: 'Close (Esc)' }, '×')),
      h('div.modal-body',
        h('div.cd-targets', ...rejected.map((c) => h('div.cd-row.cd-rejected',
          h('span.pill.red', h('i.dot'), 'rejected'),
          h('span', { style: { fontWeight: 600 } }, c.name),
          h('span.mono.muted.trunc', c.url),
          h('button.btn.sm', { style: { marginLeft: 'auto' }, onclick: async () => {
            close();
            if (await editCluster(rawClusterOf(c))) refreshAll({ force: true });
          } }, 'Set its own credential…'))))),
      h('div.modal-foot',
        h('button.btn.ghost', { onclick: () => { ui.view = 'form'; draw(); } }, 'Type a credential instead…'),
        h('div', { style: { marginLeft: 'auto' } }, h('button.btn', { onclick: () => close() }, 'Close'))));
  }

  function draw() {
    if (ui.view === 'rejected') return drawRejected();
    const title = reason === 'auth_error' ? 'Elasticsearch rejected the stored credential'
      : needing.length ? 'Credentials needed' : 'Set credentials';

    const sub = reason === 'auth_error'
      ? `${failing.length} cluster${failing.length === 1 ? '' : 's'} returned 401/403. Enter a credential to use for this session.`
      : needing.length
        ? `${configFileName()} does not contain a password for ${needing.length} of ${clusters().length} cluster${clusters().length === 1 ? '' : 's'}. Enter one and it will be used for all of them.`
        : 'Replace the credential from the file for this browser session.';

    mount(dialog,
      h('div.modal-head',
        h('div', h('h2', title), h('p.sub', sub)),
        h('button.btn.ghost.sm', { onclick: () => !ui.busy && close(), 'aria-label': 'Close', title: 'Close (Esc)' }, '×')),

      h('div.modal-body',
        // aria-pressed is what .seg styles; a bare .primary class left the selected label
        // unreadable on the dark theme (accent-coloured text on a transparent background).
        h('div.seg', { role: 'group', 'aria-label': 'Credential type' }, ...MODES.map((m) => h('button.btn.sm', {
          'aria-pressed': ui.mode === m.id ? 'true' : 'false',
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

        someHaveFileCreds && !ui.hosted
          ? h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', marginTop: '2px' } },
              h('input', { type: 'checkbox', checked: ui.overrideAll, style: { marginTop: '2px' },
                onchange: (e) => { ui.overrideAll = e.target.checked; } }),
              h('span', h('b', 'Use it for every cluster'),
                h('div.muted', { style: { fontSize: '11.5px' } },
                  'Also replaces the credentials that clusters.yaml does provide, for this session only.')))
          : null,

        h('div.cd-targets',
          h('div.muted', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '5px' } },
            ui.hosted && keptDefault && !ui.replaceDefault ? `Kept as the own credential of ${listed().length} cluster(s)`
              : !ui.hosted && ui.overrideAll ? `Will connect all ${clusters().length} cluster(s)` : `Will connect ${listed().length} cluster(s)`),
          ...(ui.results
            ? ui.results.map((r) => h('div.cd-row',
                h(`span.pill.${r.ok ? 'green' : 'red'}`, h('i.dot'), r.ok ? 'connected' : 'failed'),
                h('span', { style: { fontWeight: 600 } }, r.c.name),
                h('span.muted.trunc', { style: { fontSize: '11.5px' } }, r.detail),
                r.tls ? h('span.muted', { style: { marginLeft: 'auto', fontSize: '11px' } }, 'see Clusters page') : null))
            : listed().map((c) => h('div.cd-row',
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

        ui.hosted && keptDefault
          ? h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', marginTop: '2px' } },
              h('input#cd-replace-default', { type: 'checkbox', checked: ui.replaceDefault, style: { marginTop: '2px' },
                onchange: (e) => { ui.replaceDefault = e.target.checked; draw(); } }),
              h('span', h('b', 'Replace the default credential'),
                h('div.muted', { style: { fontSize: '11.5px' } },
                  `The server keeps one (${keptLine(keptDefault)}) that every cluster without its own uses. `
                  + 'Left unticked, this is kept as the own credential of the clusters listed above only.')))
          : null,

        ui.summary ? h('div.banner.warn', { style: { margin: 0 } }, ui.summary) : null,

        ui.error ? h('div.banner.err', { style: { margin: 0 } }, ui.error) : null,

        // Hosted keeps what an admin applies, so the people who may not hold a credential
        // can still use the clusters after a restart. Saying "kept in memory" there would
        // be the one sentence on this dialog that is not true.
        ui.hosted
          ? h('div.cd-note',
              h('b', 'Kept encrypted on the server. '),
              keptDefault && !ui.replaceDefault
                ? 'The ElasticPro server keeps it as the own credential of these clusters (AES-256-GCM, its own key); the default stays as it is. '
                : 'The ElasticPro server keeps it as the default credential for every cluster without one of its own (AES-256-GCM, its own key), ',
              'and uses it for everyone allowed to see those clusters — nobody is asked again, not on a page load and not after a restart. ',
              'It is not written to the config file and is never sent back to any browser. Config → Credentials changes or forgets it.')
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
              : `Connect ${listed().length} cluster${listed().length === 1 ? '' : 's'}`))));

    const first = $('#cd-user') || $('#cd-apikey') || $('#cd-bearer');
    if (first && !ui.busy && !ui.results) setTimeout(() => first.focus(), 0);
  }

  draw();
}
