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
import { state, setConfig, refreshAll, clusters, applyUnlockedCredential, reprime, hasSessionCredential, sessionCredentialLabel } from '../core/state.js';
import * as cfg from '../core/config.js';
import { bridge } from '../core/transport.js';
import { rememberConfigPath, pickFilePath } from '../core/platform.js';
import { filePickerButton, canPickByPath, uploadKey } from './upload.js';
import { bus } from '../core/state.js';
import { modal, confirmDialog, field, text, select, val, checked } from './modal.js';
import { parseRetention, parseSize } from '../core/volume.js';
import { managedDefaults, MANAGED_NOTE } from '../core/managed.js';
import { roleMayWrite } from '../core/writes.js';
import { credentialsKeptOnServer, keptCredentials, keptFor, keepCredential, forgetCredential, rebindCredential, keptLine,
         credentialFields, DEFAULT_CREDENTIAL, promoteCredential, promotableLabel, defaultChoiceLabel,
         initialCredentialChoice } from '../core/server-credentials.js';
import { toast } from './menu.js';

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

/**
 * The entry in the config file a cluster on screen came from, matched by name and then by
 * address — what the Config page's Edit and the Clusters page's name menu both open.
 * Null for a cluster the file does not hold (one that came from Zabbix).
 */
export function rawClusterOf(c) {
  const raw = state.config && state.config.raw;
  const list = (raw && raw.clusters) || [];
  return list.find((x) => x.name === c.name) || list.find((x) => String(x.url || '').replace(/\/+$/, '') === c.url) || null;
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

/**
 * Whether this session edits the file itself (an admin, or the portable build) or goes
 * through the operator's door — `CLUSTER_SAVE` / `AUTOMATIONS_SAVE`, which the core opens
 * to operators and bounds (cluster_save.rs). The same dialogs, two ways of saving.
 */
export const editsFileDirectly = () => roleMayWrite() && !(state.config && state.config.serverView);

/**
 * Read the server's credential-free view again after the core changed the file for us, so
 * the page shows what was saved — what saveRaw() does with the file for an admin.
 */
async function reloadServerView({ silent = false } = {}) {
  const view = await cfg.loadServerView();
  if (view.status !== 'ok') throw new Error(view.error || 'could not read the clusters back');
  await setConfig(view.config, view.path);
  bus.emit('config', view.config);
  if (!silent) refreshAll({ force: true });
}

/** The keys the server's view adds to an entry; they are not the cluster's. */
const VIEW_ONLY = ['_index', '_id'];

/**
 * An operator's save of one cluster: the entry as the dialog built it, to the core, which
 * adds or replaces exactly that entry and refuses anything else. `existing` is the entry
 * the dialog opened on (its name is what the core replaces); null adds.
 * @returns {Promise<string>} how the saved cluster signs in: kept | shared | admin | none
 */
async function saveClusterAsOperator(next, existing) {
  const cluster = { ...next };
  for (const k of VIEW_ONLY) delete cluster[k];
  const res = await bridge({ type: 'CLUSTER_SAVE', cluster, replace: existing ? existing.name : null });
  if (!res || !res.ok) throw new Error((res && res.message) || 'the core refused the save');
  await reloadServerView();
  return res.credential || '';
}

/**
 * Save the automations list, whichever door this session has: the file for an admin,
 * `AUTOMATIONS_SAVE` for an operator. The Automation page's one way to save.
 */
export async function saveAutomations() {
  if (editsFileDirectly()) { await saveRaw({ silent: true }); return; }
  const r = raw();
  if (!r) throw new Error('no config loaded');
  const res = await bridge({ type: 'AUTOMATIONS_SAVE', automations: Array.isArray(r.automations) ? r.automations : [] });
  if (!res || !res.ok) throw new Error((res && res.message) || 'the core refused the save');
  await reloadServerView({ silent: true });
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
  // Hosted (0.3.42): a cluster's own credential is kept encrypted on the server, not in the
  // file, and typed only here — when the cluster is added or its credential changed.
  const onServer = credentialsKeptOnServer();
  const kept = onServer ? await keptCredentials() : null;
  const keptId = existing ? (clusters().find((x) => x.name === existing.name) || {}).id : null;
  const keptOwn = kept && keptId ? keptFor(kept, keptId) : null;
  const keptDefault = kept ? keptFor(kept, DEFAULT_CREDENTIAL) : null;
  // With no default yet, what the server keeps that could become it without being typed again.
  const promotable = (kept && kept.promotable) || [];
  const fileOwn = cred === 'own';
  // An admin edits the file: credentials, removal and all. An operator goes through the
  // core's CLUSTER_SAVE, which takes one entry and refuses a credential or a removal —
  // so neither is offered, and the dialog says whose they are.
  const direct = editsFileDirectly();
  // 0.3.46: which credential the cluster signs in with is one choice, made here. A new
  // cluster starts on the default and asks for nothing; one with its own keeps it.
  const choice0 = initialCredentialChoice({ keptOwn, fileOwn });
  const credentialChoice = () => {
    const fileShared = r.credentials && (r.credentials.username || r.credentials.apiKey || r.credentials.bearer) ? r.credentials : null;
    const defaultLabel = onServer ? defaultChoiceLabel(keptDefault)
      : fileShared ? `Default credential (${fileShared.username ? `user ${fileShared.username}` : 'an API key or token'}, from the config file)`
      : hasSessionCredential() ? `Default credential (${sessionCredentialLabel()}, typed this session)`
      : 'Default credential — none in the config file yet';
    const show = (v) => {
      const dflt = $('#ce-cred-defblock'), own = $('#ce-cred-ownblock');
      if (dflt) dflt.hidden = v !== 'default';
      if (own) own.hidden = v !== 'own';
    };
    const radio = (value, label) => h('label', { style: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12.5px', cursor: 'pointer' } },
      h('input', { type: 'radio', name: 'ce-cred', id: `ce-cred-${value}`, value, checked: choice0 === value, onchange: () => show(value) }),
      h('b', label));
    const pair = (...nodes) => h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } }, ...nodes);
    // Hosted, no default yet: set it here once, or make one the server keeps the default.
    const defSrc = onServer && !keptDefault && promotable.length
      ? select('ce-defsrc', promotable[0].id, [...promotable.map((p) => [p.id, `Use ${promotableLabel(p)}`]), ['', 'Type it here']])
      : null;
    const typeDefault = onServer && !keptDefault
      ? h('div#ce-deftype', { style: { display: 'grid', gap: '4px' } },
          h('div.muted', { style: { fontSize: '11.5px' } }, h('b', 'Set it once here: '), 'used by every cluster without its own.'),
          pair(field('Username', text('ce-du', '', { placeholder: 'elastic' })),
            field('Password', text('ce-dp', '', { type: 'password' }), 'Kept encrypted on the server as the default — never written to the config file, never shown again.')))
      : null;
    if (defSrc && typeDefault) {
      typeDefault.hidden = true;
      defSrc.addEventListener('change', () => { typeDefault.hidden = !!defSrc.value; });
    }
    const defBlock = h('div#ce-cred-defblock', { style: { display: 'grid', gap: '6px', padding: '0 0 2px 22px', fontSize: '11.5px' } },
      onServer
        ? (keptDefault
            ? h('div.muted', 'Signs in with the default the server keeps (', keptLine(keptDefault), '). Nothing to type.')
            : h('div.muted', h('b', 'No default credential is set yet. '),
                promotable.length ? 'Use one the server already keeps, or type it once:' : ''))
        : h('div.muted', fileShared || hasSessionCredential()
            ? 'Signs in with it. Nothing to type here, and no master password is needed.'
            : 'The app asks for it once at start and uses it for every cluster without its own. Nothing to type here.'),
      defSrc ? field('Default from', defSrc) : null,
      typeDefault);
    const ownBlock = h('div#ce-cred-ownblock', { style: { display: 'grid', gap: '6px', padding: '0 0 2px 22px' } },
      onServer
        ? h('div.muted', { style: { fontSize: '11.5px' } },
            keptOwn ? [h('b', 'The server keeps one for this cluster: '), keptLine(keptOwn), '. Type a new one to replace it.']
              : fileOwn ? [h('b', 'Its credential is still in the config file. '), 'Type it here once and it moves to the server; the file then holds none.']
              : 'Kept encrypted on the server (AES-256-GCM); never written to the config file, never shown again.')
        : null,
      onServer
        ? pair(field('Username', text('ce-cu', '', { placeholder: (keptOwn && keptOwn.user) || c.username || '', autocomplete: 'off' })),
            field('Password', text('ce-cp', '', { type: 'password', autocomplete: 'new-password',
              placeholder: keptOwn ? '(kept on the server — leave empty to keep)' : '' })))
        : pair(field('Username', text('ce-cu', c.username || '')),
            field('Password', text('ce-cp', '', { type: 'password', placeholder: cfg.isSealed(c.password) ? '(stored encrypted — leave empty to keep)' : c.password ? '(stored in plain text — leave empty to keep)' : '' }),
              'Sealed with the master password before it is written.')));
    defBlock.hidden = choice0 !== 'default';
    ownBlock.hidden = choice0 !== 'own';
    return h('fieldset.ce-cred', { style: { border: '1px solid var(--border)', borderRadius: '6px', padding: '8px 10px', display: 'grid', gap: '6px', margin: 0 } },
      h('legend', { style: { fontSize: '12px', padding: '0 4px' } }, 'Credential'),
      radio('default', defaultLabel), defBlock,
      radio('own', 'Its own credential'), ownBlock);
  };
  const body = [
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)', gap: '10px' } },
      field('Name', text('ce-name', c.name || '', { placeholder: 'acme-prod' })),
      field('URL', text('ce-url', c.url || '', { mono: true, placeholder: 'https://es.example.com:9200' }), 'Scheme, host or IP, port. For a jump-host cluster: the address as the jump host resolves it.')),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } },
      field('Route', select('ce-via', c.via || c.jump || '', [['', 'direct'], ...jumps.map((j) => [j, `via ${j}`])]),
        jumps.length ? null : 'No jump hosts defined yet — add one on the Config page.'),
      field('Certificates', select('ce-tls', c.tls || '', [['', 'default (from defaults.tls)'], ['auto', 'auto — OS store, else ask & pin'], ['system', 'system — OS store only'], ['insecure', 'insecure — lab only']]),
        String((r.defaults && r.defaults.tls) || '').toLowerCase() === 'insecure'
          ? 'Not in effect: Defaults → Certificates is insecure, which accepts any certificate on every cluster.' : null),
      field('Enabled', select('ce-enabled', c.enabled === false ? 'no' : 'yes', [['yes', 'yes'], ['no', 'no (kept in file, not polled)']]))),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } },
      field('Tags', text('ce-tags', (c.tags || []).join(', '), { placeholder: 'prod, onprem' })),
      field('Live retention', text('ce-live', c.liveRetention || '', { placeholder: '30d' }),
        'How long logs stay on the cluster. Used by the volume report. 30d, 3M, 90 days, 1y.'),
      field('Snapshot retention', text('ce-snapret', c.snapshotRetention || '', { placeholder: '6M' }),
        'How long snapshots are kept in the repository. Falls back to the SLM policy.'),
      field('Backup capacity', text('ce-backupcap', c.backupCapacity || '', { placeholder: '2TB' }),
        'Total size of the snapshot repository. Elasticsearch cannot report it, so the volume report ' +
        'says "not set" until you do. 2TB, 500GB, or a bare number of GB.'),
      field('Note', text('ce-note', c.note || '')),
      field('S3 log bucket', text('ce-bucket', c.logBucket || c.log_bucket || '', { mono: true, placeholder: 'acme-logs' }),
        'The bucket the enriched and raw logs are archived to. Named on the Clusters page; nothing here reads it.')),
    // How this cluster's daily-ingest figure is derived, and the headroom every "needed"
    // number on the volume report is sized with. They were in the config schema with no
    // way to set them short of hand-editing the file.
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } },
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
    direct
      ? credentialChoice()
      : h('div.muted.ce-managed-cred', { style: { fontSize: '11.5px' } },
          h('b', 'Credential: managed by an administrator. '),
          'The cluster signs in with the credential set for it, or with the shared one every cluster uses; neither is shown or changed here. ',
          'Removing a cluster is an administrator’s too.'),
  ];
  const saved = await modal(existing ? `Edit cluster ${existing.name || ''}` : 'Add cluster',
    direct ? 'Saved to config_cluster.json; the dashboard reconnects immediately.'
           : 'Saved to the server’s config; the cluster is read from now on.', body,
    (ctx) => [
      existing && direct ? h('button.btn.danger', { onclick: async () => {
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
          const bucket = val('ce-bucket').trim(); if (bucket) next.logBucket = bucket; else delete next.logBucket; delete next.log_bucket;
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
          if (!direct) {
            // The core adds or replaces exactly this entry; the view it came from is read
            // back afterwards, so the in-memory list is not touched here.
            let how;
            try { how = await saveClusterAsOperator(next, existing); } catch (e) { return ctx.msg(`Save failed: ${e.message}`); }
            // Saved, but nothing to sign in with: say who sets it, rather than leave a cluster
            // that silently fails. Nobody below admin is offered a form for it.
            if (how === 'none') toast('No default credential is set; an admin sets it in Config → Credentials.', 'warn', 9000, { key: 'no-default-credential' });
            ctx.done(true);
            return;
          }
          const ownChosen = checked('ce-cred-own');
          const switching = !ownChosen && existing && (keptOwn || fileOwn);
          // Leaving a credential of its own for the default forgets the own one: asked first.
          if (switching && !(await confirmDialog(`Use the default credential for ${name}?`,
            `Its own credential (${keptOwn ? keptLine(keptOwn) : 'in the config file'}) is forgotten, and ${name} signs in with the default`
            + `${onServer && keptDefault ? ` (${keptLine(keptDefault)})` : ''}.`, { yes: 'use the default' }))) return;
          const clearFileCred = () => { delete next.username; delete next.password; delete next.apiKey; delete next.bearer; };
          if (onServer) {
            const cu = ownChosen ? val('ce-cu').trim() : '', cp = ownChosen ? val('ce-cp') : '';
            const useDefault = !ownChosen && !!keptOwn;
            if ((cu || cp) && !(cu && cp)) return ctx.msg('Enter both the username and the password, or leave both empty.');
            const typed = cu && cp ? { username: cu, password: cp } : null;
            if (ownChosen && !typed && !keptOwn && !fileOwn) return ctx.msg('Type its own username and password, or choose the default credential.');
            // Hosted, no default yet: set it now — from what the server keeps, or typed once — so
            // the cluster signs in the moment it is saved and nothing asks for a password.
            let setDefault = null;
            if (!ownChosen && !keptDefault) {
              const src = promotable.length ? val('ce-defsrc') : '';
              if (src) setDefault = () => promoteCredential(src);
              else {
                const du = val('ce-du').trim(), dp = val('ce-dp');
                if (!du || !dp) return ctx.msg('Set the default credential once — a username and a password — or choose its own credential.');
                setDefault = () => keepCredential(DEFAULT_CREDENTIAL, { username: du, password: dp });
              }
            }
            // A credential typed here, or the default chosen, replaces any the file still has:
            // after this the file carries no secret for the cluster.
            if (typed || !ownChosen) clearFileCred();
            if (setDefault) {
              try { await setDefault(); } catch (e) { return ctx.msg(`The default credential was not set: ${e.message}`); }
            }
            // The server's own credential for this cluster is bound to its address, route and
            // certificate setting. Moved here on purpose, it may go along — asked, not assumed.
            const where = (x) => [String(x.url || '').replace(/\/+$/, '').toLowerCase(), x.via || x.jump || '', (x.tls || 'auto').toLowerCase()].join('|');
            const moved = !!keptOwn && !typed && !useDefault && existing && where(existing) !== where(next);
            const takeAlong = moved && await confirmDialog('Keep this cluster’s own credential?',
              `The server keeps a credential of ${name}’s own (${keptLine(keptOwn)}), given for its old address. `
              + 'Send it to the new one? If not, the cluster signs in with the default credential until you type its own again.',
              { yes: 'keep it' });
            if (existing) r.clusters[r.clusters.indexOf(existing)] = next; else r.clusters.push(next);
            try { await saveRaw({ silent: true }); } catch (e) { return ctx.msg(`Save failed: ${e.message}`); }
            const id = (clusters().find((x) => x.name === name) || {}).id;
            try {
              if (typed && id) await keepCredential(id, typed);
              else if (useDefault && id) await forgetCredential(id);
              else if (takeAlong && id) await rebindCredential(id);
              await reprime();
            } catch (e) { return ctx.msg(`Saved to the config, but the credential was not kept: ${e.message}`); }
            refreshAll({ force: true });
            ctx.done(true);
            return;
          }
          // Desktop: the default is the file's `credentials:` block (or the one typed this
          // session) — chosen, it asks for no password and no master password.
          const cu = ownChosen ? val('ce-cu').trim() : '', cp = ownChosen ? val('ce-cp') : '';
          if (!ownChosen) clearFileCred();
          else if (cu) {
            next.username = cu;
            if (cp) { try { next.password = await seal(cp); } catch (e) { return ctx.msg(e.message); } if (next.password == null) return; }
            else if (!c.password) return ctx.msg('Enter the password for this cluster, or choose the default credential.');
          } else if (c.apiKey || c.bearer) { delete next.username; delete next.password; }
          else return ctx.msg('Type its own username and password, or choose the default credential.');
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
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) 90px', gap: '10px' } },
      field('Id', text('ce-jid', existingId || '', { placeholder: 'jumpwin' }), 'Used as via: on clusters'),
      field('Host', text('ce-jhost', j.host || '', { mono: true, placeholder: 'jump-windows.internal' })),
      field('Port', text('ce-jport', j.port || 22, { mono: true }))),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)', gap: '10px' } },
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
  if (credentialsKeptOnServer()) return editDefaultCredential(r);
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

/**
 * Hosted: the default credential, kept encrypted on the server and used by every cluster that
 * has none of its own — Zabbix clusters whose password is not on their host included. Typed
 * once, by an admin; nobody is asked for it afterwards.
 */
async function editDefaultCredential(r) {
  const status = await keptCredentials();
  const cur = keptFor(status, DEFAULT_CREDENTIAL);
  const inFile = r.credentials || null;
  const body = [
    h('div.muted', { style: { fontSize: '12px' } },
      cur ? [h('b', 'Kept on the server: '), keptLine(cur), '. Type a new one to replace it.']
        : [h('b', 'None is kept yet. '), 'Every cluster without its own credential signs in with this one.']),
    status.problem ? h('div', { style: { color: 'var(--critical-ink)', fontSize: '12px' } }, `The server cannot keep credentials: ${status.problem}`) : null,
    field('Type', select('ce-ctype', cur && cur.kind === 'header' ? 'apikey' : 'basic', [['basic', 'Username & password'], ['apikey', 'API key'], ['bearer', 'Bearer token']])),
    field('Username', text('ce-user', (cur && cur.user) || 'elastic', { autocomplete: 'off' })),
    field('Secret', text('ce-secret', '', { type: 'password', autocomplete: 'new-password' }),
      'Kept encrypted on the server (AES-256-GCM, its own key) — never written to the config file, never shown again.'),
    inFile ? h('div.muted', { style: { fontSize: '11.5px' } },
      'The config file still has a shared credential. Saving here keeps the new one on the server and takes it out of the file.') : null,
  ];
  const saved = await modal('Default credential', 'Used by every cluster that has no credential of its own.', body,
    (ctx) => [
      cur ? h('button.btn.danger', { onclick: async () => {
        if (!(await confirmDialog('Forget the default credential?',
          'Clusters without a credential of their own stop signing in until a new default is set.', { yes: 'forget', danger: true }))) return;
        try { await forgetCredential(DEFAULT_CREDENTIAL); await reprime(); refreshAll({ force: true }); ctx.done(true); } catch (e) { ctx.msg(e.message); }
      } }, 'Forget') : null,
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
        h('button.btn.primary', { onclick: async () => {
          const type = val('ce-ctype'), user = val('ce-user').trim(), secret = val('ce-secret');
          const cred = type === 'apikey' ? { apiKey: secret } : type === 'bearer' ? { bearer: secret } : { username: user, password: secret };
          if (!credentialFields(cred)) return ctx.msg(type === 'basic' ? 'Enter the username and the password.' : 'Enter the secret.');
          try { await keepCredential(DEFAULT_CREDENTIAL, cred); } catch (e) { return ctx.msg(e.message); }
          if (inFile) { delete r.credentials; try { await saveRaw({ silent: true }); } catch (e) { return ctx.msg(`Kept, but the file could not be cleaned: ${e.message}`); } }
          await reprime();
          refreshAll({ force: true });
          ctx.done(true);
        } }, 'Save'))]);
  return !!saved;
}

export async function editDefaults() {
  const r = raw();
  if (!r) return false;
  // What config.txt manages shows as what it is — the value in force, locked, with the
  // reason — and is never written: the file would keep a value nobody can see take effect.
  const managed = managedDefaults();
  const d = { ...cfg.DEFAULTS, ...r.defaults, ...managed };
  const f = (label, key, input, hint) => {
    if (!(key in managed)) return field(label, input, hint);
    input.disabled = true;
    return field(label, input, MANAGED_NOTE);
  };
  const body = [
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } },
      f('Read-only', 'readOnly', select('ce-ro', d.readOnly === false ? 'no' : 'yes', [['yes', 'yes — GET/HEAD + search POSTs only'], ['no', 'no — writes allowed']])),
      f('Auto-refresh', 'autoRefresh', select('ce-ar', d.autoRefresh ? 'yes' : 'no', [['no', 'off'], ['yes', 'on']])),
      f('Refresh every (s)', 'refreshIntervalSec', text('ce-ri', d.refreshIntervalSec, { mono: true }))),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } },
      f('Disk warn %', 'diskWarnPercent', text('ce-dw', d.diskWarnPercent, { mono: true })),
      f('Disk critical %', 'diskCritPercent', text('ce-dc', d.diskCritPercent, { mono: true })),
      f('Snapshot stale (h)', 'snapshotStaleHours', text('ce-ss', d.snapshotStaleHours, { mono: true }))),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } },
      f('Log index pattern', 'logIndexPattern', text('ce-lp', d.logIndexPattern, { mono: true })),
      f('Time field', 'timeField', text('ce-tf', d.timeField, { mono: true })),
      f('Certificates', 'tls', select('ce-dtls', d.tls || 'auto', [['auto', 'auto — OS store, else ask & pin'], ['system', 'system — OS store only'], ['insecure', 'insecure — accept any, on every cluster']]),
        'insecure applies to all at once: every cluster whatever its own setting, every jump-host SSH key and the Zabbix API. What it lets through is listed in one notification.')),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } },
      f('Live redraw', 'liveRedraw', select('ce-lr', d.liveRedraw || 'pending', [
        ['pending', 'pending — draw new data when you pause'],
        ['live', 'live — repaint as data lands'],
        ['manual', 'manual — only Refresh or a new page redraws']])),
      f('Opens on', 'defaultScope', select('ce-ds', d.defaultScope || 'last-selected', [
        ['last-selected', 'the cluster last chosen in this browser'],
        ['all', 'All clusters']])),
      f('Request timeout (ms)', 'requestTimeoutMs', text('ce-to', d.requestTimeoutMs, { mono: true }))),
  ];
  const saved = await modal('Defaults', 'Apply to every cluster unless a cluster overrides them.', body,
    (ctx) => [h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
      h('button.btn.primary', { onclick: async () => {
        const n = (id, min, max) => { const v = Number(val(id)); return Number.isFinite(v) && v >= min && v <= max ? v : null; };
        const ri = n('ce-ri', 5, 3600), dw = n('ce-dw', 1, 100), dc = n('ce-dc', 1, 100), ss = n('ce-ss', 1, 24 * 90), to = n('ce-to', 1000, 600000);
        if ([ri, dw, dc, ss, to].some((v) => v == null)) return ctx.msg('Check the numeric fields.');
        const next = { readOnly: val('ce-ro') === 'yes', autoRefresh: val('ce-ar') === 'yes', refreshIntervalSec: ri,
          diskWarnPercent: dw, diskCritPercent: dc, snapshotStaleHours: ss, requestTimeoutMs: to,
          logIndexPattern: val('ce-lp').trim() || 'logstash-*', timeField: val('ce-tf').trim() || '@timestamp', tls: val('ce-dtls'),
          liveRedraw: val('ce-lr'), defaultScope: val('ce-ds') };
        for (const k of Object.keys(managed)) delete next[k];
        r.defaults = { ...r.defaults, ...next };
        try { await saveRaw(); ctx.done(true); } catch (e) { ctx.msg(`Save failed: ${e.message}`); }
      } }, 'Save'))],
    // Wide enough that the choices read in full; the
    // grid's minmax(0, 1fr) columns still shrink on a narrow window instead of scrolling.
    { width: '900px' });
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
