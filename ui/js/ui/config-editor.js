/**
 * Config editor — create and change clusters, jump hosts, credentials and defaults from
 * the UI, and write the result back as JSON (config_cluster.json).
 *
 * Secrets never land in the file as plain text: a password / API key typed here is sealed
 * by the core with AES-256-GCM under a key derived from a MASTER PASSWORD
 * (PBKDF2-HMAC-SHA512). The file holds `enc:v1:pbkdf2-sha512:…`; the master password is
 * asked for on start (or skipped when the credential is remembered in the OS vault).
 */

import { h, mount, $ } from '../lib/dom.js';
import { state, setConfig, refreshAll, clusters, applyUnlockedCredential, reprime } from '../core/state.js';
import * as cfg from '../core/config.js';
import { bridge } from '../core/transport.js';
import { rememberConfigPath, pickFilePath } from '../core/platform.js';
import { filePickerButton, canPickByPath, uploadKey } from './upload.js';
import { bus } from '../core/state.js';
import { modal, confirmDialog, field, text, select, val, checked } from './modal.js';
import { parseRetention, parseSize } from '../core/volume.js';

let masterInMemory = null;      // master password for this session only (needed to seal new secrets)


/* ------------------------------------------------------------------ raw config access */
function raw() {
  if (!state.config) return null;
  if (!state.config.raw) state.config.raw = cfg.newRawConfig();
  const r = state.config.raw;
  r.clusters = r.clusters || [];
  r.jump_hosts = r.jump_hosts || {};
  r.defaults = r.defaults || {};
  return r;
}

function jumpHostList(r) {
  const jh = r.jump_hosts;
  return Array.isArray(jh) ? jh.map((j, i) => [j.id || j.name || `jump${i + 1}`, j]) : Object.entries(jh || {});
}

/** Where the JSON goes: the current file if it is JSON, else config_cluster.json beside it. */
function targetPath() {
  const cur = state.handle || (state.config && state.config.fileMeta && state.config.fileMeta.path) || '';
  if (cur && /\.json$/i.test(cur)) return cur;
  if (cur) return cur.replace(/[^\\/]+$/, 'config_cluster.json');
  return '';
}

export async function saveRaw({ silent = false } = {}) {
  const r = raw();
  if (!r) throw new Error('no config loaded');
  let path = targetPath();
  if (!path) {
    const st = await bridge({ type: 'PING' });
    path = (st && st.defaultConfigPath) || '';
  }
  if (!path) throw new Error('no place to save the config — open or create one first');
  const res = await bridge({ type: 'CONFIG_WRITE', path, text: cfg.serializeConfig(r) });
  if (!res || !res.ok) throw new Error((res && res.message) || 'write failed');
  rememberConfigPath(path);
  const next = await cfg.readPath(path);
  next.raw = r;
  await setConfig(next, path);
  await unlockSealed({ quiet: true });
  bus.emit('config', next);
  if (!silent) refreshAll({ force: true });
  return path;
}

/* ------------------------------------------------------------------ master password */
async function askMaster({ confirmNew = false, reason = '' } = {}) {
  return modal(confirmNew ? 'Set a master password' : 'Master password',
    reason || (confirmNew
      ? 'Secrets are stored in config_cluster.json encrypted (AES-256-GCM, key derived with PBKDF2-SHA512). This password is the only way to open them — it is never written anywhere.'
      : 'Needed to seal the secret you are saving.'),
    [field('Master password', text('ce-m1', '', { type: 'password' })),
     confirmNew ? field('Repeat', text('ce-m2', '', { type: 'password' })) : null],
    (ctx) => [
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
        h('button.btn.primary', { onclick: () => {
          const m = val('ce-m1');
          if (m.length < 8) return ctx.msg('Use at least 8 characters.');
          if (confirmNew && m !== val('ce-m2')) return ctx.msg('The two entries differ.');
          ctx.done(m);
        } }, 'OK'))]);
}

async function seal(plain) {
  if (!masterInMemory) {
    const m = await askMaster({ confirmNew: !(state.config && state.config.sealed) });
    if (!m) return null;
    masterInMemory = m;
  }
  const r = await bridge({ type: 'SEAL', plain, master: masterInMemory });
  if (!r || !r.ok) throw new Error((r && r.message) || 'seal failed');
  return r.value;
}

async function openSealed(value, master) {
  const r = await bridge({ type: 'OPEN', value, master });
  if (!r || !r.ok) return { error: (r && r.kind) || 'error', message: r && r.message };
  return { plain: r.plain };
}

/**
 * Unlock every sealed credential in the loaded config with the master password.
 * Returns true when nothing is left sealed.
 */
export async function unlockSealed({ quiet = false } = {}) {
  if (!state.config || !state.config.sealed) return true;
  const sealedClusters = state.config.clusters.filter((c) => c.sealedCred && c.needsCred);
  if (!sealedClusters.length) return true;

  // Try one master password against every sealed value; returns null on success or an error kind.
  async function tryMaster(master) {
    const cache = new Map();
    const stamped = [];
    for (const c of sealedClusters) {
      const cred = { ...c.sealedCred };
      for (const k of ['password', 'apiKey', 'bearer']) {
        if (!cfg.isSealed(cred[k])) continue;
        if (!cache.has(cred[k])) cache.set(cred[k], await openSealed(cred[k], master));
        const o = cache.get(cred[k]);
        if (o.error) return o.error;
        cred[k] = o.plain;
      }
      stamped.push([c.id, cred]);
    }
    for (const [id, cred] of stamped) applyUnlockedCredential(id, cred);
    masterInMemory = master;
    await reprime();
    bus.emit('config', state.config);
    return null;
  }

  if (masterInMemory && (await tryMaster(masterInMemory)) === null) return true;
  if (quiet) return false;

  const ok = await modal('Unlock credentials',
    `${sealedClusters.length} cluster${sealedClusters.length === 1 ? '' : 's'} use a credential stored encrypted in ${state.config.fileMeta ? state.config.fileMeta.name : 'the config'}. Enter the master password to open it for this session.`,
    [field('Master password', text('ce-unlock', '', { type: 'password' }))],
    (ctx) => {
      const btn = h('button.btn.primary', { onclick: async () => {
        const m = val('ce-unlock');
        if (!m) return ctx.msg('Enter the master password.');
        btn.disabled = true; ctx.msg('Checking… (key derivation takes a moment)', 'banner');
        const err = await tryMaster(m);
        btn.disabled = false;
        if (err === null) return ctx.done(true);
        ctx.msg(err === 'bad_master' ? 'Master password not accepted — try again.' : `Could not open the stored secret: ${err}`);
        $('#ce-unlock').select();
      } }, 'Unlock');
      setTimeout(() => { const inp = $('#ce-unlock'); if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); }); }, 0);
      return [
        h('span.muted', { style: { fontSize: '11.5px' } }, 'Tip: "Remember on this machine" in the sign-in dialog skips this on later starts.'),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
          h('button.btn', { onclick: () => ctx.done(null) }, 'Later'), btn)];
    });
  return !!ok;
}

/* ------------------------------------------------------------------ editors */

/**
 * A per-cluster setting as the config file spells it.
 *
 * normalize() in core/config.js accepts camelCase and snake_case for the same key, so an
 * editor that read only one spelling would show an empty field for a cluster whose value
 * is written the other way — and then save that emptiness as "no change".
 */
function written(c, camel, snake) {
  if (c[camel] !== null && c[camel] !== undefined) return c[camel];
  if (c[snake] !== null && c[snake] !== undefined) return c[snake];
  return '';
}

/**
 * The three volume knobs: field id, both spellings of the key, the label the error
 * message uses, and the range. One list, so the fields, the validation and the removal
 * on an emptied field cannot fall out of step.
 */
const VOLUME_FIELDS = [
  { id: 'ce-volwin',  key: 'volumeWindowDays',      snake: 'volume_window_days',      label: 'Volume window', min: 1, max: 90 },
  { id: 'ce-voltop',  key: 'volumeTopDays',         snake: 'volume_top_days',         label: 'Heaviest days counted', min: 1, max: 90 },
  { id: 'ce-volhead', key: 'volumeHeadroomPercent', snake: 'volume_headroom_percent', label: 'Planning headroom', min: 0, max: 200 },
];

export async function editCluster(existing = null) {
  const r = raw();
  if (!r) return false;
  const jumps = jumpHostList(r).map(([id]) => id);
  const c = existing || {};
  // What this cluster inherits when a field is left empty, so the hints can name the
  // figure actually in force rather than the built-in one.
  const d = { ...cfg.DEFAULTS, ...r.defaults };
  const cred = c.username || c.apiKey || c.bearer ? 'own' : 'shared';
  const body = [
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '10px' } },
      field('Name', text('ce-name', c.name || '', { placeholder: 'acme-prod' })),
      field('URL', text('ce-url', c.url || '', { mono: true, placeholder: 'https://es.example.com:9200' }), 'Scheme, host or IP, port. For a jump-host cluster: the address as the jump host resolves it.')),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
      field('Route', select('ce-via', c.via || c.jump || '', [['', 'direct'], ...jumps.map((j) => [j, `via ${j}`])]),
        jumps.length ? null : 'No jump hosts defined yet — add one on the Config page.'),
      field('Certificates', select('ce-tls', c.tls || '', [['', 'default (from defaults.tls)'], ['auto', 'auto — OS store, else ask & pin'], ['system', 'system — OS store only'], ['insecure', 'insecure — lab only']])),
      field('Enabled', select('ce-enabled', c.enabled === false ? 'no' : 'yes', [['yes', 'yes'], ['no', 'no (kept in file, not polled)']]))),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
      field('Tags', text('ce-tags', (c.tags || []).join(', '), { placeholder: 'prod, onprem' })),
      field('Live retention', text('ce-live', c.liveRetention || '', { placeholder: '30d' }),
        'How long logs stay on the cluster. Used by the volume report. 30d, 3M, 90 days, 1y.'),
      field('Snapshot retention', text('ce-snapret', c.snapshotRetention || '', { placeholder: '6M' }),
        'How long snapshots are kept in the repository. Falls back to the SLM policy.'),
      field('Backup capacity', text('ce-backupcap', c.backupCapacity || '', { placeholder: '2TB' }),
        'Total size of the snapshot repository. Elasticsearch cannot report it, so the volume report ' +
        'says "not set" until you do. 2TB, 500GB, or a bare number of GB.'),
      field('Note', text('ce-note', c.note || ''))),
    // How this cluster's daily-ingest figure is derived, and the headroom every "needed"
    // number on the volume report is sized with. They were in the config schema with no
    // way to set them short of hand-editing the file.
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
      field('Volume window (days)',
        text('ce-volwin', written(c, 'volumeWindowDays', 'volume_window_days'),
          { mono: true, placeholder: String(d.volumeWindowDays) }),
        `How many complete days the daily figure is measured over; today is never counted. 1–90, empty uses ${d.volumeWindowDays}.`),
      field('Heaviest days counted',
        text('ce-voltop', written(c, 'volumeTopDays', 'volume_top_days'),
          { mono: true, placeholder: String(d.volumeTopDays) }),
        `The daily figure is the mean of this many heaviest days in that window: 1 sizes against the peak day, the whole window is a plain mean. Empty uses ${d.volumeTopDays}.`),
      field('Planning headroom (%)',
        text('ce-volhead', written(c, 'volumeHeadroomPercent', 'volume_headroom_percent'),
          { mono: true, placeholder: String(d.volumeHeadroomPercent) }),
        `Added to the daily figure before it is multiplied out into every disk and backup requirement. 0–200, empty uses ${d.volumeHeadroomPercent}%.`)),
    h('details.disc', { open: cred === 'own' },
      h('summary', 'Credential for this cluster only (optional)'),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', padding: '8px 0 2px' } },
        field('Username', text('ce-cu', c.username || ''), 'Leave both empty to use the shared credential.'),
        field('Password', text('ce-cp', '', { type: 'password', placeholder: cfg.isSealed(c.password) ? '(stored encrypted — leave empty to keep)' : c.password ? '(stored in plain text — leave empty to keep)' : '' }), 'Sealed with the master password before it is written.'))),
  ];
  const saved = await modal(existing ? `Edit cluster ${existing.name || ''}` : 'Add cluster',
    'Saved to config_cluster.json; the dashboard reconnects immediately.', body,
    (ctx) => [
      existing ? h('button.btn.danger', { onclick: async () => {
        if (!(await confirmDialog(`Remove cluster ${existing.name || existing.url}?`,
          'It is taken out of the config file. The cluster itself and its data are untouched — ' +
          'the app simply stops watching it.', { yes: 'remove', danger: true }))) return;
        r.clusters = r.clusters.filter((x) => x !== existing);
        try { await saveRaw(); ctx.done(true); } catch (e) { ctx.msg(e.message); }
      } }, 'Remove') : null,
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
        h('button.btn.primary', { onclick: async () => {
          const name = val('ce-name').trim(), url = val('ce-url').trim();
          if (!/^https?:\/\/[^\s/]+/i.test(url)) return ctx.msg('URL must start with http:// or https:// and name a host.');
          if (!name) return ctx.msg('Give the cluster a name.');
          if (r.clusters.some((x) => x !== existing && (x.name === name))) return ctx.msg('Another cluster already has that name.');
          const next = { ...c, name, url: url.replace(/\/+$/, '') };
          const via = val('ce-via'); if (via) next.via = via; else delete next.via; delete next.jump;
          const tls = val('ce-tls'); if (tls) next.tls = tls; else delete next.tls;
          if (val('ce-enabled') === 'no') next.enabled = false; else delete next.enabled;
          const tags = val('ce-tags').split(',').map((t) => t.trim()).filter(Boolean); if (tags.length) next.tags = tags; else delete next.tags;
          const note = val('ce-note').trim(); if (note) next.note = note; else delete next.note;
          for (const [id, key] of [['ce-live', 'liveRetention'], ['ce-snapret', 'snapshotRetention']]) {
            const v = val(id).trim();
            if (!v) { delete next[key]; continue; }
            if (!parseRetention(v)) return ctx.msg(`${key}: use a form like 30d, 90 days, 3M, 6 months or 1y.`);
            next[key] = v;
          }
          const cap = val('ce-backupcap').trim();
          if (!cap) delete next.backupCapacity;
          else if (!parseSize(cap)) return ctx.msg('backupCapacity: use a form like 2TB, 500GB or a bare number of GB.');
          else next.backupCapacity = cap;
          // Empty means "inherit defaults:", so the key is removed rather than written
          // as a number nobody asked for. Both spellings go: normalize() reads either, so
          // a leftover snake_case key would win back the value just cleared.
          for (const f of VOLUME_FIELDS) {
            const v = val(f.id).trim();
            delete next[f.snake];
            if (!v) { delete next[f.key]; continue; }
            const n = Number(v);
            if (!Number.isInteger(n) || n < f.min || n > f.max) {
              return ctx.msg(`${f.label}: a whole number from ${f.min} to ${f.max}.`);
            }
            next[f.key] = n;
          }
          // More heaviest days than the window holds silently means "the whole window"
          // (volumeSettings clamps it), and what gets saved should be what was asked for.
          // The effective figures are compared, not the typed ones: either field may be
          // empty and inheriting a default that makes the pair contradictory.
          const effWin = Number(next.volumeWindowDays ?? d.volumeWindowDays);
          const effTop = Number(next.volumeTopDays ?? d.volumeTopDays);
          if (Number.isFinite(effWin) && Number.isFinite(effTop) && effTop > effWin) {
            return ctx.msg(`Heaviest days counted (${effTop}) cannot be more than the volume window (${effWin} days).`);
          }
          const cu = val('ce-cu').trim(), cp = val('ce-cp');
          if (cu) {
            next.username = cu;
            if (cp) { try { next.password = await seal(cp); } catch (e) { return ctx.msg(e.message); } if (next.password == null) return; }
            else if (!c.password) return ctx.msg('Enter the password for this cluster, or clear the username to use the shared credential.');
          } else { delete next.username; delete next.password; }
          if (existing) r.clusters[r.clusters.indexOf(existing)] = next; else r.clusters.push(next);
          try { await saveRaw(); ctx.done(true); } catch (e) { ctx.msg(`Save failed: ${e.message}`); }
        } }, existing ? 'Save' : 'Add cluster'))]);
  return !!saved;
}

export async function editJumpHost(existingId = null) {
  const r = raw();
  if (!r) return false;
  if (Array.isArray(r.jump_hosts)) r.jump_hosts = Object.fromEntries(jumpHostList(r));
  const j = existingId ? (r.jump_hosts[existingId] || {}) : {};
  // Browse where the core and the browser are the same machine; upload where they are
  // not. On the hosted stack "Browse…" could only offer paths on the server, and the key
  // is on the laptop in front of the operator.
  const keyNote = h('span.muted', { style: { fontSize: '11px' } });
  const keyRow = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    text('ce-key', j.keyFile || j.key_file || '', { mono: true, placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519', style: { flex: '1' } }),
    canPickByPath()
      ? h('button.btn.sm', { type: 'button', onclick: async () => {
          const p = await pickFilePath('Choose the private key file'); if (p) $('#ce-key').value = p; } }, 'Browse…')
      : filePickerButton('Upload key…', {
          accept: '.pem,.key,',
          onText: async (txt, err, name) => {
            if (err) { keyNote.textContent = err; keyNote.style.color = 'var(--critical-ink)'; return; }
            keyNote.style.color = ''; keyNote.textContent = 'Uploading…';
            try {
              const info = await uploadKey(name, txt);
              $('#ce-key').value = info.path;
              keyNote.textContent = `${info.name} uploaded · ${info.digest} · stored 0600, never sent back`;
            } catch (e) {
              keyNote.style.color = 'var(--critical-ink)';
              keyNote.textContent = e.message || String(e);
            }
          },
        }));
  const body = [
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 2fr 90px', gap: '10px' } },
      field('Id', text('ce-jid', existingId || '', { placeholder: 'jumpwin' }), 'Used as via: on clusters'),
      field('Host', text('ce-jhost', j.host || '', { mono: true, placeholder: 'jump-windows.internal' })),
      field('Port', text('ce-jport', j.port || 22, { mono: true }))),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '10px' } },
      field('SSH user', text('ce-juser', j.user || '', { placeholder: 'jump-user' })),
      field('Private key file', h('div', keyRow, keyNote), 'OpenSSH format (id_ed25519 / id_rsa). Passphrase, if any, is asked in the app — never stored. Leave empty to use a session password.')),
    field('Note', text('ce-jnote', j.note || '')),
  ];
  const saved = await modal(existingId ? `Edit jump host ${existingId}` : 'Add jump host',
    'The host key is confirmed on first connection and pinned.', body,
    (ctx) => [
      existingId ? h('button.btn.danger', { onclick: async () => {
        const used = r.clusters.filter((c) => (c.via || c.jump) === existingId).length;
        if (used) return ctx.msg(`${used} cluster(s) route via ${existingId}; change them first.`);
        if (!(await confirmDialog(`Remove jump host ${existingId}?`,
          'Any cluster routed through it with via: will stop being reachable until it is ' +
          'pointed at another jump host.', { yes: 'remove', danger: true }))) return;
        delete r.jump_hosts[existingId];
        try { await saveRaw(); ctx.done(true); } catch (e) { ctx.msg(e.message); }
      } }, 'Remove') : null,
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
        h('button.btn.primary', { onclick: async () => {
          const id = val('ce-jid').trim(), host = val('ce-jhost').trim(), user = val('ce-juser').trim();
          const port = parseInt(val('ce-jport'), 10) || 22;
          if (!/^[A-Za-z0-9_.-]+$/.test(id)) return ctx.msg('Id: letters, digits, . _ - only.');
          if (!host || !user) return ctx.msg('Host and SSH user are required.');
          if (id !== existingId && r.jump_hosts[id]) return ctx.msg('That id already exists.');
          const next = { host, port, user };
          const key = val('ce-key').trim(); if (key) next.keyFile = key;
          const note = val('ce-jnote').trim(); if (note) next.note = note;
          if (existingId && existingId !== id) {
            delete r.jump_hosts[existingId];
            r.clusters.forEach((c) => { if ((c.via || c.jump) === existingId) { c.via = id; delete c.jump; } });
          }
          r.jump_hosts[id] = next;
          try { await saveRaw(); ctx.done(true); } catch (e) { ctx.msg(`Save failed: ${e.message}`); }
        } }, existingId ? 'Save' : 'Add jump host'))]);
  return !!saved;
}

export async function editCredentials() {
  const r = raw();
  if (!r) return false;
  const cur = r.credentials || {};
  const mode0 = cur.apiKey ? 'apikey' : cur.bearer ? 'bearer' : 'basic';
  const body = [
    field('Type', select('ce-ctype', mode0, [['basic', 'Username & password'], ['apikey', 'API key'], ['bearer', 'Bearer token']])),
    field('Username', text('ce-user', cur.username || 'elastic')),
    field('Secret', text('ce-secret', '', { type: 'password', placeholder: cur.password || cur.apiKey || cur.bearer ? '(leave empty to keep the stored one)' : '' }),
      'Encrypted with the master password before it is written (AES-256-GCM, PBKDF2-SHA512). Never stored in plain text by the app.'),
  ];
  const saved = await modal('Shared credential', 'Used by every cluster without its own credential.', body,
    (ctx) => [
      cur.username || cur.password || cur.apiKey || cur.bearer
        ? h('button.btn.danger', { onclick: async () => {
          if (!(await confirmDialog('Remove the shared credential?',
            'It is deleted from the config file. The app will ask for a credential on the next start.',
            { yes: 'remove', danger: true }))) return;
          delete r.credentials; try { await saveRaw(); ctx.done(true); } catch (e) { ctx.msg(e.message); } } }, 'Remove from file') : null,
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
        h('button.btn.primary', { onclick: async () => {
          const type = val('ce-ctype'), user = val('ce-user').trim(), secret = val('ce-secret');
          const next = {};
          try {
            if (type === 'basic') {
              if (!user) return ctx.msg('Username is required.');
              next.username = user;
              if (secret) next.password = await seal(secret); else if (cur.password) next.password = cur.password; else return ctx.msg('Enter the password.');
            } else if (type === 'apikey') {
              if (secret) next.apiKey = await seal(secret); else if (cur.apiKey) next.apiKey = cur.apiKey; else return ctx.msg('Enter the API key.');
            } else {
              if (secret) next.bearer = await seal(secret); else if (cur.bearer) next.bearer = cur.bearer; else return ctx.msg('Enter the token.');
            }
          } catch (e) { return ctx.msg(e.message); }
          if (Object.values(next).some((v) => v == null)) return;   // master password cancelled
          r.credentials = next;
          try { await saveRaw(); ctx.done(true); } catch (e) { ctx.msg(`Save failed: ${e.message}`); }
        } }, 'Save'))]);
  return !!saved;
}

export async function editDefaults() {
  const r = raw();
  if (!r) return false;
  const d = { ...cfg.DEFAULTS, ...r.defaults };
  const body = [
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
      field('Read-only', select('ce-ro', d.readOnly === false ? 'no' : 'yes', [['yes', 'yes — GET/HEAD + search POSTs only'], ['no', 'no — writes allowed']])),
      field('Auto-refresh', select('ce-ar', d.autoRefresh ? 'yes' : 'no', [['no', 'off'], ['yes', 'on']])),
      field('Refresh every (s)', text('ce-ri', d.refreshIntervalSec, { mono: true }))),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
      field('Disk warn %', text('ce-dw', d.diskWarnPercent, { mono: true })),
      field('Disk critical %', text('ce-dc', d.diskCritPercent, { mono: true })),
      field('Snapshot stale (h)', text('ce-ss', d.snapshotStaleHours, { mono: true }))),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
      field('Log index pattern', text('ce-lp', d.logIndexPattern, { mono: true })),
      field('Time field', text('ce-tf', d.timeField, { mono: true })),
      field('Certificates (default)', select('ce-dtls', d.tls || 'auto', [['auto', 'auto'], ['system', 'system'], ['insecure', 'insecure']]))),
    field('Request timeout (ms)', text('ce-to', d.requestTimeoutMs, { mono: true })),
  ];
  const saved = await modal('Defaults', 'Apply to every cluster unless a cluster overrides them.', body,
    (ctx) => [h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
      h('button.btn.primary', { onclick: async () => {
        const n = (id, min, max) => { const v = Number(val(id)); return Number.isFinite(v) && v >= min && v <= max ? v : null; };
        const ri = n('ce-ri', 5, 3600), dw = n('ce-dw', 1, 100), dc = n('ce-dc', 1, 100), ss = n('ce-ss', 1, 24 * 90), to = n('ce-to', 1000, 600000);
        if ([ri, dw, dc, ss, to].some((v) => v == null)) return ctx.msg('Check the numeric fields.');
        r.defaults = { ...r.defaults, readOnly: val('ce-ro') === 'yes', autoRefresh: val('ce-ar') === 'yes', refreshIntervalSec: ri,
          diskWarnPercent: dw, diskCritPercent: dc, snapshotStaleHours: ss, requestTimeoutMs: to,
          logIndexPattern: val('ce-lp').trim() || 'logstash-*', timeField: val('ce-tf').trim() || '@timestamp', tls: val('ce-dtls') };
        try { await saveRaw(); ctx.done(true); } catch (e) { ctx.msg(`Save failed: ${e.message}`); }
      } }, 'Save'))]);
  return !!saved;
}

/** Setup screen: start a brand-new config_cluster.json and add the first cluster. */
export async function createNewConfig() {
  const st = await bridge({ type: 'PING' });
  const path = (st && st.defaultConfigPath) || '';
  if (!path) throw new Error('the core did not report a data directory');
  const rawCfg = cfg.newRawConfig();
  const res = await bridge({ type: 'CONFIG_WRITE', path, text: cfg.serializeConfig(rawCfg) });
  if (!res || !res.ok) throw new Error((res && res.message) || 'write failed');
  rememberConfigPath(path);
  const next = await cfg.readPath(path);
  next.raw = rawCfg;
  await setConfig(next, path);
  return path;
}

export function hasMaster() { return !!masterInMemory; }
export function forgetMaster() { masterInMemory = null; }
