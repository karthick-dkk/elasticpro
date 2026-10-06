/** Page 7 — configuration, security posture and diagnostics. */

import { h, mount, $ } from '../lib/dom.js';
import { bytes, dt, ago, download } from '../lib/fmt.js';
import * as cfg from '../core/config.js';
import { state, setConfig, refreshAll, clusters, client, hasSessionCredential,
         sessionCredentialLabel, clearSessionCredential, clustersNeedingCredential, isReadOnly } from '../core/state.js';
import { workerStatus, forgetWorker, tunnels as fetchTunnels, listPins, untrustCert, untrustHostKey, tunnelReconnect,
         delaySinkGet, delaySinkSet, delaySinkRun, trustCert,
         zabbixLinkGet, zabbixLinkSet, zabbixLinkTest, zabbixPairBegin, zabbixUnpair } from '../core/es.js';
import { defaultApiUrl, checkUrl, countdown, secondsLeft, isManaged, linkChanges, formProblems, linkSummary,
         linkView, testMessage, epUrlFrom, eventLine } from '../core/zabbix-link.js';
import { showCredentialDialog, forgetVaultCredential } from '../ui/credential-dialog.js';
import { EXAMPLE_YAML } from '../core/example.js';
import { saveTextAs } from '../core/platform.js';
import { editCluster, editJumpHost, editCredentials, editDefaults, unlockSealed, saveRaw } from '../ui/config-editor.js';
import { card, pill, table, empty } from './common.js';
import { navigateTo } from '../core/intent.js';
import { ALERT_RULES, loadAlertSettings, isEnabled } from '../core/alert-rules.js';
import { toast } from '../ui/menu.js';
import { bridge } from '../core/transport.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { applyLoadedConfig } from '../ui/load-config.js';
import { filePickerButton, canPickByPath, configHistory, readVersion } from '../ui/upload.js';
import { confirmDialog, modal, field, text, checkbox, val, checked } from '../ui/modal.js';
import { rowMenu, ICON } from '../ui/menu.js';

let host = null;

let core = null;      // last PING
let trust = null;     // last PINS + TUNNELS
let sink = null;      // last DELAY_SINK_GET; null until asked, {supported:false} off hosted

/* ------------------------- uploading a config, and its history ------------------- */

let versions = [];
let historyOpen = false;

/**
 * A config the operator chose in their browser.
 *
 * Parsed before it is saved, so a file that is not a config is refused here rather than
 * after it has replaced the working one. Then it goes through applyLoadedConfig, the same
 * path every other way of loading a config uses — a second loader would be a second set
 * of rules about credentials and sealed secrets.
 */
async function uploadConfig(text, err, name) {
  const msg = $('#cfg-msg');
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? 'var(--critical-ink)' : ''; } };
  if (err) return say(err, true);
  try {
    const parsed = cfg.parseConfigText(text, name);
    parsed.fileMeta = { name, size: text.length, lastModified: Date.now(), ephemeral: false };
    // The same two steps every other loader uses: make it the live config, then write it
    // where the core reads it. saveRaw() owns "where does a config get saved", including
    // falling back to the core's default path, so this does not get its own opinion.
    await applyLoadedConfig(parsed, null);
    const path = await saveRaw();
    say(`Loaded ${name} and saved to ${path}. The version it replaced is in the history.`);
    await loadHistory();
  } catch (e) {
    say(`${name} is not a usable config: ${e.message || e}`, true);
  }
}

async function loadHistory() {
  try { versions = await configHistory(); } catch { versions = []; }
  const el = $('#cfg-history');
  if (el) mount(el, historyBody());
}

function historyBlock() {
  // Fetched lazily: it is one more round trip and most visits to this page are not
  // looking for it.
  if (!versions.length && !historyOpen) loadHistory().then(() => { historyOpen = true; });
  return h('div#cfg-history', { style: { marginTop: '10px' } }, historyBody());
}

function historyBody() {
  if (!versions.length) {
    return h('div.muted', { style: { fontSize: '11.5px' } },
      'No earlier versions yet. One is kept each time the config is saved from here.');
  }
  return h('details.disc', { open: false },
    h('summary', `Earlier versions (${versions.length})`),
    h('div', { style: { paddingTop: '6px' } },
      table(['Saved', 'File', { label: 'Size', num: true }, ''],
        versions.map((v) => h('tr',
          h('td', { title: new Date(v.saved_at * 1000).toISOString() }, ago(v.saved_at * 1000)),
          h('td.mono', { style: { fontSize: '11.5px' } }, v.source),
          h('td.num', bytes(v.bytes)),
          h('td', { style: { textAlign: 'right' } },
            h('button.btn.sm', { onclick: () => restore(v) }, 'Load this')))),
        {
          // "None" was the whole message. This is a good empty state — nothing has gone
          // wrong — so it says what would put something here rather than offering a button.
          emptyText: empty('No earlier version saved yet.', {
            detail: 'A copy is kept automatically each time the config is saved from this app.',
          }),
        })),
    h('div.muted', { style: { fontSize: '11px', paddingTop: '6px' } },
      'Loading an older version does not discard the current one — that is saved as a '
      + 'version first, so this goes both ways.'));
}

async function restore(v) {
  const msg = $('#cfg-msg');
  try {
    const text = await readVersion(v.id);
    await uploadConfig(text, null, v.source);
  } catch (e) {
    if (msg) { msg.textContent = e.message || String(e); msg.style.color = 'var(--critical-ink)'; }
  }
}

export function render(el) {
  host = el;
  // draw() asks for whatever the open section needs. loadSink is the exception: its
  // answer decides whether the Scheduled log delay tab exists at all, so it has to be
  // asked before the bar can be drawn correctly — and it redraws when it lands.
  draw();
  loadSink();
}

/** Read the guard back from the core itself rather than trusting the UI's copy. */
async function confirmCoreGuard() {
  const st = await workerStatus();
  core = st;
  const cell = [...document.querySelectorAll('#view td')]
    .find((td) => td.previousElementSibling && td.previousElementSibling.textContent === 'Enforced by the core');
  if (!cell) return;
  const agrees = !!st && st.readOnly === isReadOnly();
  cell.textContent = !st || st.readOnly === undefined ? 'core did not report'
    : `${st.readOnly ? 'yes — writes blocked' : 'no — writes allowed'}${agrees ? '' : ' (MISMATCH with config)'}`;
  const v = document.querySelector('#core-version');
  if (v && st) v.textContent = `v${st.version}`;
}

async function loadTrust() {
  const [t, p] = await Promise.all([fetchTunnels(), listPins()]);
  trust = { tunnels: (t && t.tunnels) || [], pins: (p && p.pins) || { certs: {}, hostkeys: {} } };
  const el = $('#trust-card');
  if (el) mount(el, trustCard());
}

function trustCard() {
  const jh = (state.config && state.config.jumpHosts) || [];
  const tun = (trust && trust.tunnels) || [];
  const certs = (trust && trust.pins && trust.pins.certs) || {};
  const hks = (trust && trust.pins && trust.pins.hostkeys) || {};
  const tRows = jh.map((j) => {
    const t = tun.find((x) => x.id === j.id) || {};
    const st = (t.status && t.status.state) || 'idle';
    return h('tr',
      h('td', h('div', { style: { fontWeight: 620 } }, j.id), h('div.mono.muted', { style: { fontSize: '11px' } }, `${j.user}@${j.host}:${j.port}`)),
      h('td.mono', { style: { fontSize: '11px', wordBreak: 'break-all' } }, j.keyFile || '(password)'),
      h('td', pill(st.replace('_', ' '), st === 'up' ? 'green' : st === 'connecting' ? 'yellow' : st === 'down' ? 'red' : 'grey'),
        t.status && t.status.error ? h('div.muted', { style: { fontSize: '11px', marginTop: '3px' } }, t.status.error) : null),
      h('td.mono', { style: { fontSize: '11px', wordBreak: 'break-all' } }, hks[j.id] ? hks[j.id].sha256 : h('span.muted', 'not pinned yet')),
      h('td', h('div', { style: { display: 'flex', gap: '6px' } },
        h('button.btn.sm', { onclick: async () => { if (await editJumpHost(j.id)) { draw(); loadTrust(); } } }, 'Edit'),
        h('button.btn.sm', { onclick: async () => { await tunnelReconnect(j.id); await refreshAll({ force: true }); loadTrust(); } }, 'Reconnect'),
        hks[j.id] ? h('button.btn.sm.danger', { title: 'Forget the pinned host key; the next connection asks again.',
          onclick: async () => {
            if (await confirmDialog(`Forget the pinned host key of ${j.id}?`,
              'The next connection treats this jump host as unknown and asks you to confirm its ' +
              'fingerprint again. Do this after a deliberate reinstall or rekey.',
              { yes: 'forget it', danger: true })) { await untrustHostKey(j.id); loadTrust(); }
          } }, 'Untrust') : null)));
  });
  const cRows = Object.entries(certs).sort().map(([hostport, pin]) => h('tr',
    h('td.mono', { style: { fontSize: '11.5px' } }, hostport),
    h('td', { style: { fontSize: '11.5px' } }, pin.subject || '–'),
    h('td.mono', { style: { fontSize: '11px', wordBreak: 'break-all' } }, pin.sha256),
    h('td.muted', { style: { fontSize: '11px' } }, pin.since ? dt(Date.parse(pin.since)) : '–'),
    h('td', h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, rowMenu([
      { label: 'Forget this pin…', icon: ICON.delete, danger: true,
        title: 'The certificate is offered for trust again on the next connection',
        onClick: async () => {
          if (await confirmDialog(`Forget the certificate pinned for ${hostport}?`,
            'The next connection treats this certificate as unknown and offers it for trust ' +
            'again. Do this after a deliberate rotation.',
            { yes: 'forget it', danger: true })) {
            await untrustCert(hostport); await refreshAll({ force: true }); loadTrust();
          }
        } },
    ], { title: `Actions for ${hostport}` })))));
  return h('div', { style: { display: 'grid', gap: '14px' } },
    h('div',
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '6px' } },
        h('span', { style: { fontWeight: 620 } }, `Jump hosts (${jh.length})`),
        h('button.btn.sm.primary', { style: { marginLeft: 'auto' }, onclick: async () => { if (await editJumpHost(null)) { draw(); loadTrust(); } } }, '+ Add jump host')),
      jh.length ? table(['Jump host', 'Key file', 'Tunnel', 'Pinned host key', ''], tRows)
        : h('div.muted', { style: { fontSize: '12px' } }, 'None yet. Add one, then set "via" on the clusters that need it.')),
    h('div',
      h('div', { style: { fontWeight: 620, marginBottom: '6px' } }, `Pinned certificates (${cRows.length})`),
      cRows.length ? table(['Address', 'Subject', 'SHA-256', 'Since', ''], cRows)
        : h('div.muted', { style: { fontSize: '12px' } }, 'None yet. A certificate the OS does not trust is shown on the Clusters page with a Trust button; the decision lands here.')),
    // The reassurance is worth saying; the path it is kept at is not. Naming a file on
    // the server tells a reader nothing they can act on from a browser, and tells anyone
    // else where to look. Config paths elsewhere on this page are a different matter —
    // that file is the operator's own, and they are expected to go and edit it.
    h('div.muted', { style: { fontSize: '11.5px' } },
      'Trust decisions record fingerprints only — never a key, a password or a certificate.'));
}
export function onData() { if (host && host.isConnected) draw(); }

/* ------------------------------ alert triggers ------------------------------ */

/**
 * Every alert this app can raise, with a switch and its thresholds.
 *
 * The list is the registry, so a rule cannot exist in the code and be missing here.
 * Switching one off stops it being shown; it does not stop it being computed, and it does
 * not touch anything anybody acknowledged — the identity of an alert is unchanged by
 * being disabled, which is what makes retuning safe.
 *
 * Writing a genuinely new rule is the Automation page's job. There is one rule editor in
 * this product and this is not a second one.
 */
function alertRulesCard() {
  const raw = state.config && state.config.raw;
  const settings = loadAlertSettings(raw);
  const admin = !!raw;
  const off = ALERT_RULES.filter((r) => !isEnabled(settings, r.id)).length;

  const save = async (mutate) => {
    if (!raw) { toast('No config loaded', 'warn'); return; }
    if (!raw.alertRules || typeof raw.alertRules !== 'object') raw.alertRules = {};
    mutate(raw.alertRules);
    try {
      await saveRaw(raw);
      await setConfig(await cfg.normalize(raw, (state.config.fileMeta || {}).name || 'config'), state.handle);
      toast('Alert settings saved');
    } catch (e) {
      toast(`Could not save: ${e.message}`, 'err', 5000);
    }
    draw();
  };

  const trs = ALERT_RULES.map((r) => {
    const on = isEnabled(settings, r.id);
    const s = settings[r.id] || {};
    return h('tr', { style: on ? null : { opacity: '.55' } },
      h('td', h('input', { type: 'checkbox', checked: on, disabled: !admin,
        title: on ? `Stop showing ${r.label}` : `Show ${r.label} again`,
        onchange: (e) => {
          const want = e.target.checked;
          save((a) => { a[r.id] = { ...(a[r.id] || {}), enabled: want }; });
        } })),
      h('td', h('div', { style: { fontWeight: 620 } }, r.label),
        h('div.muted', { style: { fontSize: '11px' } }, r.why)),
      h('td', pill(r.level, r.level === 'critical' ? 'red' : 'yellow')),
      h('td', (r.thresholds || []).length
        ? h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
            ...r.thresholds.map((t) => h('label', {
              style: { display: 'inline-flex', gap: '4px', alignItems: 'center', fontSize: '11.5px' },
            },
              h('span.muted', t.label),
              h('input', {
                type: 'number', min: String(t.min), max: String(t.max), disabled: !admin,
                value: String((s.thresholds && s.thresholds[t.key]) ?? state.defaults[t.key] ?? ''),
                style: { width: '68px' },
                title: `${t.min}–${t.max}${t.unit}`,
                onchange: (e) => {
                  const v = Number(e.target.value);
                  if (!isFinite(v) || v < t.min || v > t.max) {
                    toast(`${t.label} must be between ${t.min} and ${t.max}${t.unit}`, 'warn');
                    draw(); return;
                  }
                  save((a) => {
                    a[r.id] = { ...(a[r.id] || {}) };
                    a[r.id].thresholds = { ...(a[r.id].thresholds || {}), [t.key]: v };
                  });
                },
              }),
              h('span.muted', t.unit))))
        : h('span.muted', { style: { fontSize: '11.5px' } }, '\u2014')),
      h('td.mono.muted', { style: { fontSize: '10.5px' } }, r.id));
  });

  return card('Alert triggers',
    `${ALERT_RULES.length} rule(s)${off ? ` \u00b7 ${off} switched off` : ' \u00b7 all on'}`,
    h('div', { style: { display: 'grid', gap: '8px' } },
      h('div.muted', { style: { fontSize: '12px' } },
        'Switching a rule off stops it appearing on the Alerts page. Anything already '
        + 'acknowledged keeps its history \u2014 disabling a rule does not change what its '
        + 'alerts are called. To write a rule of your own, use ',
        h('button.btn.sm.ghost', { onclick: () => navigateTo('automation') }, 'Automation'),
        '.'),
      !admin ? h('div.muted', { style: { fontSize: '11.5px' } }, 'Read-only \u2014 no config is loaded.') : null,
      table(['', 'Alert', 'Level', 'Thresholds', 'id'], trs)));
}

/* ----------------------- the scheduled log-delay measurement ----------------------- */

/**
 * The one thing in this product that acts without somebody present.
 *
 * It exists only in the hosted edition, so on a desktop build this card is absent rather
 * than disabled — an option you cannot ever use is worse than no option. Everything the
 * card shows about the last run comes from the core, which is the only thing that knows:
 * the page is not running the timer and must not pretend to.
 *
 * Measurements are shipped raw. Whether 41 minutes counts as delayed is decided on the
 * Log delay page, by the same thresholds that apply to a live run, which is why nothing
 * here asks for one.
 */
async function loadSink() {
  try {
    sink = await delaySinkGet();
  } catch (_) {
    // A core too old to know the message, or an edition that does not schedule. Either
    // way there is nothing to offer.
    sink = null;
  }
  if (host && host.isConnected) draw();
}

function sinkField(label, key, opts = {}) {
  const c = (sink && sink.config) || {};
  return h('label', { style: { display: 'grid', gap: '3px', fontSize: '11.5px' } },
    h('span.muted', label),
    h('input', {
      id: `sink-${key}`, type: opts.type || 'text',
      value: String(c[key] ?? ''),
      min: opts.min == null ? null : String(opts.min),
      max: opts.max == null ? null : String(opts.max),
      style: { width: opts.width || '100%' },
      title: opts.title || '',
    }));
}

function delaySinkCard() {
  if (!sink || !sink.supported) return null;
  const c = sink.config || {};
  const st = sink.state || {};
  const list = clusters();
  const picked = new Set((c.clusters || []).length ? c.clusters : list.map((x) => x.id).filter((id) => id !== c.sinkClusterId));

  const read = () => {
    const v = (key) => { const el = $(`#sink-${key}`); return el ? el.value.trim() : ''; };
    const chosen = list.map((x) => x.id).filter((id) => { const el = $(`#sink-pick-${id}`); return el && el.checked; });
    return {
      enabled: !!($('#sink-enabled') || {}).checked,
      sinkClusterId: (($('#sink-target') || {}).value || '').trim(),
      clusters: chosen,
      everyHours: Number(v('everyHours')) || 2,
      indexPrefix: v('indexPrefix'),
      indexPattern: v('indexPattern'),
      deviceField: v('deviceField'),
      arrivalField: v('arrivalField'),
      eventTimeFields: v('eventTimeFields').split(',').map((f) => f.trim()).filter(Boolean),
      maxDevices: Number(v('maxDevices')) || 2000,
    };
  };

  const save = async () => {
    const next = read();
    // Empty means "every cluster" to the core, which is right for a hand-edited file and
    // wrong for a screen where somebody has just unticked the last box.
    if (next.enabled && !next.clusters.length) { toast('Pick at least one cluster to measure', 'warn'); return; }
    if (next.enabled && next.clusters.length === 1 && next.clusters[0] === next.sinkClusterId) {
      toast('The only cluster picked is the one being written to', 'warn'); return;
    }
    try {
      const res = await delaySinkSet(next);
      if (!res || !res.ok) { toast(`Not saved: ${(res && res.message) || 'refused'}`, 'err', 6000); return; }
      sink = { ...res, supported: true };
      toast(next.enabled ? 'Scheduled measurement armed' : 'Scheduled measurement switched off');
      draw();
    } catch (e) {
      toast(`Could not save: ${e.message}`, 'err', 5000);
    }
  };

  const runNow = async () => {
    toast('Measuring…');
    try {
      const res = await delaySinkRun();
      if (res && res.skipped) toast(`Nothing was measured: ${res.skipped}`, 'warn', 8000);
      else if (res && res.ok) toast(`Measured ${res.measured} device(s) across ${res.clusters} cluster(s) into ${res.index}`, 'ok', 8000);
      else toast(`Run failed: ${(res && res.error) || 'unknown'}`, 'err', 8000);
    } catch (e) {
      toast(`Run failed: ${e.message}`, 'err', 6000);
    }
    loadSink();
  };

  const status = st.lastSkipped
    ? pill('skipped', 'yellow')
    : !st.runs ? pill('never run', 'grey')
    : st.lastOk ? pill('ok', 'green') : pill('failed', 'red');

  return card('Scheduled log delay',
    c.enabled ? `every ${c.everyHours}h \u2192 ${c.sinkClusterId || 'nowhere'}` : 'switched off',
    h('div', { style: { display: 'grid', gap: '10px' } },
      h('div.muted', { style: { fontSize: '12px' } },
        'The bridge measures each cluster\u2019s log delay on a timer and writes the raw '
        + 'figures to the cluster you name below. Only the hosted edition does this \u2014 a '
        + 'desktop app is not running when nobody is looking at it. Nothing is classified '
        + 'on the way in: the ',
        h('button.btn.sm.ghost', { onclick: () => navigateTo('logs') }, 'Log delay'),
        ' page applies the thresholds when the data is read back.'),
      sink.blocked
        ? h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } }, 'Cannot run right now: ', sink.blocked)
        : null,
      h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'end' } },
        h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12px' } },
          h('input#sink-enabled', { type: 'checkbox', checked: !!c.enabled }), 'Run on a timer'),
        h('label', { style: { display: 'grid', gap: '3px', fontSize: '11.5px' } },
          h('span.muted', 'Write measurements to'),
          h('select#sink-target', {},
            h('option', { value: '' }, '\u2014 pick a cluster \u2014'),
            ...list.map((x) => h('option', { value: x.id, selected: x.id === c.sinkClusterId }, x.name)))),
        sinkField('Every (hours)', 'everyHours', { type: 'number', min: 1, max: 24, width: '80px' }),
        sinkField('Index prefix', 'indexPrefix', { title: 'Indices are <prefix>-YYYY.MM' }),
        sinkField('Max devices per run', 'maxDevices', { type: 'number', min: 1, max: 10000, width: '110px' })),
      h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'end' } },
        sinkField('Indices to measure', 'indexPattern'),
        sinkField('Device field', 'deviceField'),
        sinkField('Arrival time field', 'arrivalField'),
        sinkField('Event time fields', 'eventTimeFields',
          { title: 'Comma separated, tried in order \u2014 the first one present is used' })),
      h('div', { style: { display: 'grid', gap: '4px' } },
        h('span.muted', { style: { fontSize: '11.5px' } }, 'Clusters to measure'),
        h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
          ...list.map((x) => h('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '11.5px' } },
            h('input', { id: `sink-pick-${x.id}`, type: 'checkbox', checked: picked.has(x.id) }), x.name)))),
      table([], [
        kvRow('Status', status),
        kvRow('Last attempt', st.lastRunAt ? `${dt(st.lastRunAt)} (${ago(st.lastRunAt)})` : 'never'),
        kvRow('Last result', st.lastSkipped ? st.lastSkipped
          : st.runs ? `${st.lastMeasured} device(s) written, ${st.lastFailed} cluster(s) failed` : '\u2014'),
        kvRow('Last error', st.lastError || '\u2014'),
        kvRow('Next run', c.enabled && st.nextDueAt ? `${dt(st.nextDueAt)} (${ago(st.nextDueAt)})` : 'not scheduled'),
        kvRow('Runs since start', String(st.runs || 0)),
      ]),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button.btn.primary', { onclick: save }, 'Save'),
        h('button.btn', { onclick: runNow }, 'Run now'))));
}
/* ---------------------------------- sections ---------------------------------- */

/**
 * The Config page is eight unrelated jobs, and it used to be all eight at once: a single
 * scroll where "which certificate do we trust" sat under "what is the refresh interval"
 * and the thing you came for was somewhere in the middle. Nothing was hard to find
 * because it was hidden; it was hard to find because everything else was in the way.
 *
 * So they are tabs, in the same shape as the tabs at the top of the window. The bar is
 * the page's table of contents: you can see every job this page does without scrolling,
 * and you are only ever looking at one of them.
 *
 * A section may be absent — the schedule only exists on a build that can keep one — and
 * an absent section has no tab. An option you can never use is worse than no option.
 */
const SECTIONS = [
  { id: 'file',     label: 'Config file',  icon: '▤', build: fileCard },
  { id: 'creds',    label: 'Credentials',  icon: '◈', build: credentialsCard },
  { id: 'clusters', label: 'Clusters',     icon: '▦', build: clustersCard },
  { id: 'zabbix',   label: 'Zabbix',       icon: '⇆', build: zabbixSection, load: loadZabbix },
  { id: 'trust',    label: 'Jump hosts & trust', icon: '⇄', build: trustSection, load: loadTrust },
  { id: 'alerts',   label: 'Alert triggers', icon: '⚠', build: alertRulesCard },
  { id: 'schedule', label: 'Scheduled log delay', icon: '⏱', build: delaySinkCard,
    when: () => !!(sink && sink.supported) },
  { id: 'defaults', label: 'Defaults',     icon: '⚙', build: defaultsCard },
  { id: 'diag',     label: 'Diagnostics',  icon: '✚', build: diagnosticsCard, load: confirmCoreGuard },
];

/** Which section is open. Remembered across redraws so a save does not move you. */
let section = 'file';

function visibleSections() {
  return SECTIONS.filter((s) => !s.when || s.when());
}

function activeSection() {
  const shown = visibleSections();
  return shown.find((s) => s.id === section) || shown[0];
}

/**
 * The tab bar. Deliberately the same markup and the same `aria-current` as the window's
 * own tabs, so it reads as navigation rather than as a row of buttons that happen to be
 * next to each other — and so a screen reader calls it what it is.
 */
function sectionNav() {
  const active = activeSection();
  const nav = h('nav.subnav');
  visibleSections().forEach((s) => {
    nav.append(h('button', {
      'aria-current': active && active.id === s.id ? 'page' : null,
      title: s.label,
      onclick: () => { section = s.id; draw(); },
    }, h('span.ico', s.icon), h('span', s.label)));
  });
  return nav;
}

/* ------------------------------ the sections ------------------------------ */

function fileCard() {
  const meta = (state.config && state.config.fileMeta) || {};
  return card('Config file', meta.name || 'not loaded',
    h('div', { style: { display: 'grid', gap: '10px' } },
      table([], [
        kvRow('File', meta.name || '–'),
        kvRow('Size', meta.size ? bytes(meta.size) : '–'),
        kvRow('Last modified on disk', meta.lastModified ? dt(meta.lastModified) : '–'),
        kvRow('Loaded', state.config ? `${dt(state.config.loadedAt)} (${ago(state.config.loadedAt)})` : '–'),
        kvRow('Path', meta.path || (meta.ephemeral ? 'loaded once — not remembered' : '–')),
        kvRow('Format', state.config ? (state.config.format === 'json' ? 'JSON (config_cluster.json)' : 'YAML — edits from the UI are saved as config_cluster.json next to it') : '–'),
        kvRow('Secrets in file', state.config ? (state.config.sealed ? 'encrypted (AES-256-GCM, PBKDF2-SHA512 master password)' : (clusters().some((c) => c.credSource === 'shared' || c.credSource === 'cluster') ? 'PLAIN TEXT — use "Store in config file (encrypted)" to fix' : 'none')) : '–'),
        kvRow('Mode', isSnapshotMode()
          ? `snapshot — collected ${state.snapshot && state.snapshot.generatedAt ? dt(state.snapshot.generatedAt) : '?'}`
            + (state.snapshot && state.snapshot.host ? ` on ${state.snapshot.host}` : '')
          : 'live — the app connects to each cluster (directly or through a jump host)'),
      ]),
      h('div#cfg-msg'),
      historyBlock()),
    // The actions this section is for, in the card's own footer rather than loose in the
    // body — which is where the top of the page keeps its buttons, so they line up.
    [
      h('button.btn.sm.primary', { onclick: reload, disabled: !state.handle || isSnapshotMode() }, 'Reload from disk'),
      // "Pick another file" asks the core for a path, which is the right question on a
      // desktop and the wrong one on a server, where the file is on the operator's own
      // machine.
      canPickByPath()
        ? h('button.btn.sm', { onclick: repick }, 'Pick another file…')
        : filePickerButton('Upload a config…', {
            accept: '.json,.yaml,.yml',
            className: 'btn.sm',
            onText: (txt, err, name) => uploadConfig(txt, err, name),
          }),
      h('button.btn.sm.ghost', { onclick: () => saveTextAs('clusters.yaml', EXAMPLE_YAML) }, 'Save example YAML…'),
      h('button.btn.sm.danger', { onclick: forget }, 'Forget file & credentials'),
    ]);
}

function credentialsCard() {
  const needing = clustersNeedingCredential().length;
  return card('Credentials',
    hasSessionCredential() ? `session credential active — ${sessionCredentialLabel()}` : 'from the config file',
    h('div', { style: { display: 'grid', gap: '11px' } },
      hasSessionCredential()
        ? h('div.banner', { style: { margin: 0 } },
            h('div', h('div.ttl', `Using a credential you typed (${sessionCredentialLabel()})`),
              h('div.sec', { style: { fontSize: '12px' } },
                'Held in memory for this tab only. Reloading the dashboard will ask again.')))
        : null,
      h('div', { style: { fontSize: '12.5px', lineHeight: '1.65', display: 'grid', gap: '8px' } },
        h('div', h('b', 'In memory. '),
          'The password / API key from your YAML is held in the app process and discarded when it closes. Tick "remember on this machine" in the sign-in dialog to keep it in the Windows Credential Manager instead of typing it each start.'),
        h('div', h('b', 'One credential, many clusters. '),
          'The top-level ', h('code.inline', 'credentials:'), ' block authenticates every cluster; add ',
          h('code.inline', 'username:'), '/', h('code.inline', 'apiKey:'), ' under a cluster only when it needs a different one.'),
        h('div', h('b', 'Jump hosts. '),
          'A cluster with ', h('code.inline', 'via: <jump>'), ' is reached through an SSH connection the app opens itself with your key file — no ssh.exe, no PuTTY, no SOCKS to configure. Passphrases are asked for, never read from the file.'),
        h('div', h('b', 'Certificates you decide about. '),
          'A certificate the OS does not trust is shown to you once — subject, issuer, SHA-256 — and pinned when you accept it. A different certificate at the same address is refused until you decide again. No CA import, no policy, no click-through.'),
        h('div', h('b', 'Read-only by default. '),
          'Monitoring uses GET only; the single POST it makes is ', h('code.inline', '_search'),
          ', which cannot modify anything. Writes are refused in the core, so no page, console ',
          'or future code path can reach a cluster with PUT/POST/DELETE while ', h('code.inline', 'readOnly'), ' is true.'),
        h('div', h('b', 'No credential in the file? '),
          'Leave ', h('code.inline', 'credentials:'), ' out entirely (or give only a ', h('code.inline', 'username:'),
          ') and the app prompts once on start, then applies what you type to every cluster URL.'))),
    [
      h('button.btn.sm.primary', { onclick: () => showCredentialDialog('manual') },
        needing ? `Sign in to ${needing} cluster(s)` : 'Set one credential for all clusters'),
      h('button.btn.sm', {
        onclick: async () => { if (await editCredentials()) draw(); },
        title: 'Write it to config_cluster.json, encrypted with a master password',
      }, 'Store in config file (encrypted)…'),
      state.config && state.config.sealed && needing
        ? h('button.btn.sm', { onclick: async () => { if (await unlockSealed()) { await refreshAll({ force: true }); draw(); } } }, 'Unlock with master password…')
        : null,
      hasSessionCredential()
        ? h('button.btn.sm.danger', { onclick: async () => { await clearSessionCredential(); draw(); } }, 'Clear typed credential')
        : null,
    ].filter(Boolean));
}

function trustSection() {
  return card('Jump hosts & trust', 'SSH tunnels, pinned host keys, pinned certificates',
    h('div#trust-card', h('div.muted', 'Loading…')));
}

function clustersCard() {
  const clusterRows = clusters().map((c) => {
    const cl = client(c.id);
    const fromZabbix = c.source === 'zabbix';
    return h('tr',
      h('td', h('div', { style: { fontWeight: 620 } }, c.name),
        c.tags && c.tags.length ? h('div', { style: { display: 'flex', gap: '4px', marginTop: '3px' } }, ...c.tags.map((t) => h('span.pill.grey', t))) : null),
      h('td.mono', { style: { fontSize: '11.5px' } }, c.url),
      h('td', fromZabbix ? pill(c.zabbix && c.zabbix.credential === 'vault' ? 'Zabbix · Vault' : 'Zabbix macro',
                                 c.zabbix && c.zabbix.credentialOk ? 'green' : 'red')
            : c.credSource === 'shared' ? pill('shared (from file)', 'green')
            : c.credSource === 'cluster' ? pill('per-cluster override', 'yellow')
            : c.credSource === 'session' ? pill('typed this session', 'green')
            : c.anonymous ? pill('anonymous', 'grey') : pill('missing', 'red')),
      h('td.mono', { style: { fontSize: '11.5px' } }, c.username || '–'),
      h('td.mono', { style: { fontSize: '11px' } }, c.logIndexPattern),
      h('td', cl ? pill(cl.state.replace('_', ' '), cl.state === 'online' ? 'green' : cl.state === 'auth_error' ? 'yellow' : cl.state === 'unknown' ? 'grey' : 'red') : pill('unknown', 'grey')),
      h('td.muted', { style: { fontSize: '11.5px' } }, cl && cl.lastOkAt ? ago(cl.lastOkAt) : '–'),
      // Zabbix wins: a cluster that is a Zabbix host is edited there, on its macros.
      h('td', fromZabbix
        ? h('button.btn.sm', { disabled: true, title: `Managed in Zabbix — host ${c.zabbix ? c.zabbix.host : ''}` }, 'In Zabbix')
        : h('button.btn.sm', { onclick: async () => { if (await editCluster(rawClusterOf(c))) { draw(); loadTrust(); } } }, 'Edit')));
  });
  // disabled clusters are not in clusters(); list them too so they can be re-enabled
  const disabledRows = ((state.config && state.config.clusters) || []).filter((c) => !c.enabled).map((c) => h('tr',
    h('td', h('div', { style: { fontWeight: 620, color: 'var(--text-muted)' } }, c.name)),
    h('td.mono', { style: { fontSize: '11.5px', color: 'var(--text-muted)' } }, c.url),
    h('td', { colspan: 4 }, pill('disabled', 'grey')),
    h('td', h('button.btn.sm', { onclick: async () => { if (await editCluster(rawClusterOf(c))) { draw(); loadTrust(); } } }, 'Edit'))));

  return card('Clusters', `${clusters().length} enabled · ${disabledRows.length} disabled`,
    table(['Name', 'URL', 'Credential', 'User', 'Log index pattern', 'Connection', 'Last success', ''],
      [...clusterRows, ...disabledRows], { emptyText: 'No clusters yet — add one.' }),
    [h('button.btn.sm.primary', { onclick: async () => { if (await editCluster(null)) { draw(); loadTrust(); } } }, '+ Add cluster')]);
}

/* ---------------------------------- Zabbix ---------------------------------- */

let zbx = null;          // the last ZABBIX_CLUSTERS answer
let zbxBusy = false;

async function loadZabbix() {
  await Promise.all([cfg.loadZabbixClusters().then((z) => { zbx = z; }), loadLink()]);
  if (host && host.isConnected && activeSection() && activeSection().id === 'zabbix') mount(host, sectionNav(), h('div', { style: { marginTop: '12px' } }, zabbixSection()));
}

function zabbixSection() {
  return h('div', { style: { display: 'grid', gap: '12px' } }, zabbixLinkCard(), zabbixCard());
}

/* ------------------------- the Zabbix connection (admins) ------------------------- */

let link = null;          // the last ZABBIX_LINK_GET; { hidden } for a non-admin, { supported:false } off hosted
let linkBusy = false;
let tokenReplace = false; // the token field is open for a new value
// Once something is connected, the card shows a "Current settings" summary, not the form —
// "Edit settings" flips this to show the form (with Cancel) over the summary. linkView()
// decides 'setup' vs 'summary' from the status itself; this only tracks the summary→form flip.
let linkEditing = false;

const isAdminCaller = () => !state.caller || state.caller.role === 'admin';

async function loadLink() {
  if (!isAdminCaller()) { link = { hidden: true }; return; }
  try {
    const res = await zabbixLinkGet();
    link = res && res.ok ? res : { supported: false, kind: res && res.kind, error: res && res.kind !== 'not_supported' ? res.message : null };
  } catch (e) {
    link = { supported: false, error: e.message || String(e) };
  }
}

const LINK_LABEL = { zabbixUrl: 'Zabbix URL', apiUrl: 'API URL', apiToken: 'API token', allowedSources: 'Allowed sources',
                     syncSecs: 'Sync interval', verifyTls: 'Verify TLS' };

/** The form as typed; a field the server owns reads as the server's value. */
function readLinkForm() {
  const s = link || {};
  return {
    zabbixUrl: isManaged(s, 'zabbixUrl') ? s.zabbixUrl : val('zl-zurl'),
    apiUrl: isManaged(s, 'apiUrl') ? s.apiUrl : (val('zl-api') || defaultApiUrl(isManaged(s, 'zabbixUrl') ? s.zabbixUrl : val('zl-zurl'))),
    apiToken: isManaged(s, 'apiToken') ? '' : val('zl-token'),
    verifyTls: isManaged(s, 'verifyTls') ? s.verifyTls : checked('zl-tls'),
    allowHttp: checked('zl-http'),
    allowedSources: isManaged(s, 'allowedSources') ? (s.allowedSources || []).join('\n') : val('zl-src'),
    syncSecs: isManaged(s, 'syncSecs') ? String(s.syncSecs) : val('zl-sync'),
  };
}

async function saveLink() {
  const form = readLinkForm();
  const probs = formProblems(link, form);
  if (Object.keys(probs).length) {
    toast(`Not saved — ${Object.entries(probs).map(([k, v]) => `${LINK_LABEL[k] || k}: ${v}`).join('; ')}`, 'err', 9000, { key: 'zabbix-link' });
    return;
  }
  const changes = linkChanges(link, form);
  if (!Object.keys(changes).length) { toast('Nothing to save — no field changed', 'ok', 3000, { key: 'zabbix-link' }); return; }
  linkBusy = true; draw();
  let res;
  try { res = await zabbixLinkSet(changes); } catch (e) { res = { ok: false, message: e.message || String(e) }; }
  linkBusy = false;
  if (!res.ok) {
    toast(`Zabbix connection not saved: ${res.message}`, 'err', 10000, { key: 'zabbix-link' });
    draw();
    return;
  }
  link = res; tokenReplace = false; linkEditing = false;
  toast(`Zabbix connection saved: ${(res.changed || []).map((k) => LINK_LABEL[k] || k).join(', ') || 'no change'}`, 'ok', 5000, { key: 'zabbix-link' });
  draw();
  // A new address or token changes which clusters exist; show it now rather than at the
  // next timer tick.
  if ((res.changed || []).some((k) => ['zabbixUrl', 'apiUrl', 'apiToken', 'verifyTls'].includes(k)) && res.sync && res.sync.configured) {
    await syncZabbix();
  }
}

/** Test connection: one task card that says it started and then what it found. */
async function testLink() {
  const key = `zabbix-test-${Date.now()}`;
  toast('Testing the Zabbix connection', 'run', 0, { key, detail: [link && link.apiUrl ? link.apiUrl : ''] .filter(Boolean) });
  let res;
  try { res = await zabbixLinkTest(); } catch (e) { res = { ok: false, kind: 'network', message: e.message || String(e) }; }
  toast(res.ok ? 'Zabbix connection works' : 'Zabbix connection failed', res.ok ? 'ok' : 'err', res.ok ? 8000 : 15000,
    { key, detail: [testMessage(res), res.apiUrl ? `API ${res.apiUrl}` : ''].filter(Boolean), meta: res.version ? `Zabbix ${res.version}` : '' });
  if ((res.kind === 'tls_untrusted' || res.kind === 'tls_pin_mismatch') && res.cert) await zabbixCertDialog(res);
}

/**
 * The certificate decision, for Zabbix: the same facts the cluster banner shows and the
 * same TRUST_CERT pin — one trust store for everything the core connects to.
 */
async function zabbixCertDialog(res) {
  const c = res.cert || {};
  const row = (k, v, mono) => h('div', { style: { display: 'grid', gridTemplateColumns: '90px 1fr', gap: '8px', fontSize: '12px' } },
    h('span.muted', k), h(mono ? 'span.mono' : 'span', { style: { wordBreak: 'break-all' } }, v || '–'));
  const changed = res.kind === 'tls_pin_mismatch';
  const ok = await modal(changed ? 'The Zabbix certificate changed' : 'Trust the Zabbix certificate?',
    `${c.host || ''} — ${changed ? 'different from the one pinned' : 'not trusted by the OS store'}`, [
      row('Subject', c.subject), row('Issuer', c.self_signed ? `${c.issuer} (self-signed)` : c.issuer),
      row('Valid', c.not_before && c.not_after ? `${c.not_before} → ${c.not_after}` : '–'),
      c.sans && c.sans.length ? row('SAN', c.sans.join(', ')) : null,
      row('SHA-256', c.sha256, true),
      res.pinned ? row('Pinned', res.pinned, true) : null,
      h('div.muted', { style: { fontSize: '11.5px' } },
        changed ? 'Replace the pin only if the certificate was rotated on purpose. If it was not, something sits between this server and Zabbix.'
          : 'Compare the SHA-256 with the certificate on the Zabbix server. Trusting pins exactly this certificate for this address; a different one is refused later.'),
    ].filter(Boolean), (ctx) => [
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => ctx.done(false) }, 'Not now'),
        h(`button.btn.${changed ? 'danger' : 'primary'}`, { onclick: () => ctx.done(true) }, changed ? 'Replace the pin' : 'Trust this certificate')),
    ], { width: '600px' });
  if (!ok) return;
  if (changed) await untrustCert(c.host);
  const t = await trustCert(c.host, c.sha256);
  if (!t || !t.ok) { toast(`Could not trust the certificate: ${(t && t.message) || 'no answer'}`, 'err', 8000); return; }
  toast(`Trusted the certificate for ${c.host}`, 'ok', 4000);
  await testLink();
}

async function pairLink() {
  const s = link || {};
  const raw = isManaged(s, 'zabbixUrl') ? s.zabbixUrl : (val('zl-zurl') || s.zabbixUrl || '');
  const allowHttp = checked('zl-http') || !!s.allowHttp;
  const c = checkUrl(raw, allowHttp);
  if (!c.ok) { toast(`Enter the Zabbix URL first (${c.error})`, 'err', 6000, { key: 'zabbix-link' }); return; }
  let res;
  try { res = await zabbixPairBegin(c.value, epUrlFrom(location)); } catch (e) { res = { ok: false, message: e.message || String(e) }; }
  if (!res.ok) { toast(`Could not start pairing: ${res.message}`, 'err', 12000, { key: 'zabbix-link' }); return; }
  await pairingDialog(res);
  await loadLink();
  draw();
}

/**
 * The pairing code, shown once. It is in this dialog and nowhere else: not in the page
 * afterwards, not in the notification history, not in the core's log.
 */
async function pairingDialog(res) {
  const started = Math.floor(Date.now() / 1000) - 5;
  const box = h('textarea.mono', { readonly: true, rows: 4, spellcheck: false,
    style: { width: '100%', fontSize: '12px', wordBreak: 'break-all', resize: 'none' },
    onclick: (e) => e.target.select() });
  box.value = res.code;
  const left = h('b', countdown(res.exp));
  const status = h('div.muted', { style: { fontSize: '12px' } }, 'Waiting for Zabbix…');
  let doneBtn = null;
  let finished = false;
  const tick = setInterval(() => {
    if (!box.isConnected) return;
    left.textContent = countdown(res.exp);
    if (!secondsLeft(res.exp) && !finished) { status.textContent = 'This code has expired. Close and press Pair with Zabbix again.'; box.value = ''; }
  }, 1000);
  const poll = setInterval(async () => {
    if (!box.isConnected || finished) return;
    try {
      const g = await zabbixLinkGet();
      if (g && g.ok && g.paired && Number(g.pairedAt) >= started) {
        finished = true; link = g; linkEditing = false; box.value = '';
        status.textContent = `Paired with ${g.zabbixUrl}${g.zabbixVersion ? ` (Zabbix ${g.zabbixVersion})` : ''}. The code is spent.`;
        status.classList.remove('muted');
        if (doneBtn) doneBtn.textContent = 'Done';
        toast(`Paired with Zabbix ${g.zabbixUrl}`, 'ok', 8000, { key: 'zabbix-link' });
      }
    } catch { /* the next poll tries again */ }
  }, 3000);
  const copy = async () => {
    try { await navigator.clipboard.writeText(res.code); toast('Pairing code copied', 'ok', 2500, { key: 'zabbix-copy' }); }
    catch { box.select(); toast('Select-all is done — press Ctrl+C (or ⌘+C) to copy', 'warn', 5000, { key: 'zabbix-copy' }); }
  };
  try {
    await modal('Pair with Zabbix', `for ${res.zabbixUrl}`, [
      h('div', { style: { fontSize: '12.5px', lineHeight: '1.6' } },
        'Paste this code in Zabbix: ', h('b', res.pasteAt || 'Administration → ElasticPro → Pairing code'),
        ', then press ', h('b', 'Pair'), '. Zabbix creates its API user and token and sends the token back here, signed with the secret inside this code.'),
      box,
      h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12px' } },
        h('span', 'Expires in ', left), h('span.muted', 'Works once. Not shown again — close this and it is gone.'),
        h('span.muted', `Zabbix will call back ${res.epUrl}/zabbix/pair`)),
      status,
    ], (ctx) => [
      h('button.btn.sm', { onclick: copy }, 'Copy'),
      h('div', { style: { marginLeft: 'auto' } }, doneBtn = h('button.btn.primary', { onclick: () => ctx.done(true) }, 'Close')),
    ], { width: '620px' });
  } finally {
    clearInterval(tick); clearInterval(poll);
    box.value = '';
  }
}

async function unpairLink() {
  const ok = await confirmDialog('Unpair from Zabbix?',
    'The API token and the sign-in secret stored here are deleted. Signing in from Zabbix stops at once, '
    + 'and the clusters that come from Zabbix disappear from ElasticPro until you pair again.\n\n'
    + 'Settings made in the server’s own configuration are not touched. Unpair in Zabbix too '
    + '(Administration → ElasticPro → Unpair); that deletes the token this pairing created.',
    { yes: 'unpair', danger: true });
  if (!ok) return;
  let res;
  try { res = await zabbixUnpair(); } catch (e) { res = { ok: false, message: e.message || String(e) }; }
  if (!res.ok) { toast(`Unpair failed: ${res.message}`, 'err', 8000, { key: 'zabbix-link' }); return; }
  link = res; linkEditing = false;
  toast('Unpaired from Zabbix', 'ok', 5000, { key: 'zabbix-link' });
  await setConfig(state.config, state.handle);
  await refreshAll({ force: true });
  await loadZabbix();
  draw();
}

/**
 * Not configured yet → the form is shown outright, same as always. Once something is
 * connected — paired, a token pasted by hand, or set up by the server's own config — the
 * card shows "Current settings" instead, and the form only reappears behind "Edit settings"
 * (with a Cancel back to the summary). linkView() draws that line; linkEditing only tracks
 * the summary→form flip the operator asked for.
 */
function zabbixLinkCard() {
  if (!link) return card('Zabbix connection', 'Loading…', h('div.muted', 'Loading…'));
  if (link.hidden || (!link.supported && !link.error)) return null;
  if (!link.supported) return card('Zabbix connection', 'unavailable', h('div.banner.err', { style: { margin: 0 } }, link.error));
  if (linkView(link) === 'summary' && !linkEditing) return zabbixLinkSummaryCard(link);
  return zabbixLinkFormCard(link, linkView(link) === 'summary');
}

/** The "Recent changes" list, collapsed — it is looked up, not glanced at. */
function zabbixEventsPanel(s) {
  const events = (s.events || []).slice(0, 6);
  if (!events.length) return null;
  return h('details', h('summary', { style: { fontSize: '12px', cursor: 'pointer' } }, 'Recent changes'),
    h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px', fontSize: '11.5px' } },
      ...events.map((e) => h('li', { style: { color: e.ok ? '' : 'var(--critical-ink)' } }, `${dt(e.at * 1000)} · ${eventLine(e)}`))));
}

/** "Current settings": read-only, once something is connected. */
function zabbixLinkSummaryCard(s) {
  const sum = linkSummary(s);
  const ro = (f) => isManaged(s, f);
  const managedNote = 'managed by server config';
  const tok = s.apiToken || {};
  const tokenText = ro('apiToken') ? `set · ${managedNote}`
    : tok.set ? `set · added ${tok.at ? dt(tok.at * 1000) : '–'}${tok.by ? ` by ${tok.by}` : ''}` : 'not set';
  const sync = s.sync || {};
  const syncText = sync.error ? `failed — ${sync.error}`
    : sync.lastOk ? `ok — ${ago(sync.lastOk * 1000)}`
      : sync.configured ? 'not synced yet' : 'not syncing yet';
  const serverSecret = s.ssoSecret && s.ssoSecret.source === 'server';
  const canUnpair = s.paired || (tok.set && tok.source === 'ui') || (s.ssoSecret && s.ssoSecret.source === 'ui');
  const row = (label, value, managed) => field(label, h('div', { style: { fontSize: '12.5px' } }, value), managed ? managedNote : null);
  return card('Zabbix connection', sum.title,
    h('div', { style: { display: 'grid', gap: '12px' } },
      h('div', { style: { display: 'grid', gap: '4px', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: '6px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          pill(sum.title, sum.tone), h('span', { style: { fontSize: '12.5px' } }, sum.detail)),
        h('div.muted', { style: { fontSize: '11.5px' } },
          `Sign-in from Zabbix: ${s.signIn ? 'on' : 'off'}${serverSecret ? ' (secret from server config)' : ''}`
          + ` · may frame this app: ${s.frameAncestors}`
          + (s.pairedAt ? ` · paired ${dt(s.pairedAt * 1000)}${s.pairedBy ? ` by ${s.pairedBy}` : ''}` : '')),
        s.allowHttp ? h('div.banner.warn', { style: { margin: '4px 0 0' } }, 'Plain http is allowed: the API token crosses the network unencrypted. Lab only.') : null),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' } },
        row('Zabbix URL', s.zabbixUrl || '–', ro('zabbixUrl')),
        row('API URL', s.apiUrlIsDefault ? `${defaultApiUrl(s.zabbixUrl) || '–'} (default)` : (s.apiUrl || '–'), ro('apiUrl')),
        row('API token', tokenText, ro('apiToken')),
        row('Verify TLS', s.verifyTls !== false ? 'yes' : 'no', ro('verifyTls')),
        row('Allowed sources', (s.allowedSources || []).length ? (s.allowedSources || []).join(', ') : 'any', ro('allowedSources')),
        row('Sync interval', `${s.syncSecs || '–'}s`, ro('syncSecs')),
        s.paired ? row('Paired with', `${s.zabbixUrl}${s.pairedAt ? ` · ${dt(s.pairedAt * 1000)}` : ''}${s.pairedBy ? ` by ${s.pairedBy}` : ''}`) : null,
        s.zabbixVersion ? row('Zabbix version', s.zabbixVersion) : null,
        row('Last sync', syncText),
        row('Clusters synced', sync.lastOk ? String(sync.clusters || 0) + (sync.skipped ? `, ${sync.skipped} skipped` : '') : '–')),
      zabbixEventsPanel(s)),
    [
      h('button.btn.sm', { onclick: testLink, disabled: linkBusy }, 'Test connection'),
      h('button.btn.sm', { onclick: syncZabbix, disabled: linkBusy || zbxBusy }, zbxBusy ? 'Syncing…' : 'Sync now'),
      h('button.btn.sm', { onclick: () => { linkEditing = true; draw(); }, disabled: linkBusy }, 'Edit settings'),
      h('button.btn.sm', { onclick: pairLink, disabled: linkBusy || serverSecret,
        title: serverSecret ? 'The sign-in secret is set in the server configuration; pairing from here is off.' : 'Show a one-time code to paste into Zabbix' },
      'Re-pair…'),
      h('button.btn.sm.danger', { onclick: unpairLink, disabled: linkBusy || !canUnpair }, 'Unpair'),
    ]);
}

/** The setup form (not configured yet), or the same form reached via "Edit settings". */
function zabbixLinkFormCard(s, canCancel) {
  const sum = linkSummary(s);
  const ro = (f) => isManaged(s, f);
  const managedNote = 'managed by server config';
  const disable = (el, f) => { if (ro(f) || linkBusy) el.disabled = true; return el; };
  const hint = (f, text) => (ro(f) ? managedNote : text);
  const zurl = disable(text('zl-zurl', s.zabbixUrl || '', { placeholder: 'https://zabbix.example.com', mono: true }), 'zabbixUrl');
  const api = disable(text('zl-api', s.apiUrlIsDefault ? '' : (s.apiUrl || ''), { placeholder: defaultApiUrl(s.zabbixUrl) || 'https://zabbix.example.com/api_jsonrpc.php', mono: true }), 'apiUrl');
  // The API URL follows the Zabbix URL until somebody types one of their own.
  zurl.addEventListener('input', () => { api.placeholder = defaultApiUrl(zurl.value) || 'https://zabbix.example.com/api_jsonrpc.php'; });
  const tok = s.apiToken || {};
  let tokenField;
  if (ro('apiToken')) tokenField = h('div.muted', { style: { fontSize: '12.5px' } }, `set · ${managedNote}`);
  else if (tok.set && !tokenReplace) {
    tokenField = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12.5px' } },
      pill('set', 'green'), h('span.muted', `added ${tok.at ? dt(tok.at * 1000) : '–'}${tok.by ? ` by ${tok.by}` : ''}`),
      h('button.btn.sm', { disabled: linkBusy, onclick: () => { tokenReplace = true; draw(); } }, 'Replace…'));
  } else {
    tokenField = text('zl-token', '', { type: 'password', mono: true, placeholder: tok.set ? 'new token — replaces the stored one' : 'paste a Zabbix API token, or pair' });
  }
  const tls = checkbox('zl-tls', 'Verify the Zabbix TLS certificate', s.verifyTls !== false,
    ro('verifyTls') ? managedNote : 'Off only for a lab. On: the OS trust store, or a certificate you trust from Test connection.');
  if (ro('verifyTls') || linkBusy) tls.querySelector('input').disabled = true;
  const http = checkbox('zl-http', 'Allow plain http (lab only)', !!s.allowHttp, 'The API token would cross the network unencrypted.');
  const src = h('textarea#zl-src.mono', { rows: 2, spellcheck: false, disabled: ro('allowedSources') || linkBusy,
    placeholder: 'empty = any source (the signature still decides)', style: { width: '100%', fontSize: '12px' } });
  src.value = (s.allowedSources || []).join('\n');
  const sync = disable(text('zl-sync', String(s.syncSecs || ''), { mono: true, style: { width: '110px' } }), 'syncSecs');
  const serverSecret = s.ssoSecret && s.ssoSecret.source === 'server';
  const cancel = () => { linkEditing = false; tokenReplace = false; draw(); };
  return card('Zabbix connection', canCancel ? 'Edit settings' : sum.title,
    h('div', { style: { display: 'grid', gap: '12px' } },
      canCancel ? null : h('div', { style: { display: 'grid', gap: '4px', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: '6px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          pill(sum.title, sum.tone), h('span', { style: { fontSize: '12.5px' } }, sum.detail)),
        h('div.muted', { style: { fontSize: '11.5px' } },
          `Sign-in from Zabbix: ${s.signIn ? 'on' : 'off'}${serverSecret ? ' (secret from server config)' : ''}`
          + ` · may frame this app: ${s.frameAncestors}`),
        s.allowHttp ? h('div.banner.warn', { style: { margin: '4px 0 0' } }, 'Plain http is allowed: the API token crosses the network unencrypted. Lab only.') : null),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' } },
        field('Zabbix URL', zurl, hint('zabbixUrl', 'The Zabbix frontend, as a browser reaches it.')),
        field('API URL', api, hint('apiUrl', 'Empty = the Zabbix URL + /api_jsonrpc.php.')),
        field('API token', tokenField, hint('apiToken', 'Write-only: never shown again once saved. Pairing sets it for you.')),
        field('Sync interval (seconds)', sync, hint('syncSecs', 'How often the Zabbix hosts are read. 30–86400.')),
        field('Allowed sources', src, hint('allowedSources', 'IPs or CIDRs that may call /sso/zabbix and /zabbix/pair. One per line.'))),
      h('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap' } }, tls, http),
      canCancel ? null : zabbixEventsPanel(s)),
    [
      h('button.btn.sm.primary', { onclick: saveLink, disabled: linkBusy }, linkBusy ? 'Saving…' : 'Save'),
      h('button.btn.sm', { onclick: testLink, disabled: linkBusy }, 'Test connection'),
      h('button.btn.sm', { onclick: pairLink, disabled: linkBusy || serverSecret,
        title: serverSecret ? 'The sign-in secret is set in the server configuration; pairing from here is off.' : 'Show a one-time code to paste into Zabbix' },
      s.paired ? 'Pair again…' : 'Pair with Zabbix…'),
      canCancel ? h('button.btn.sm', { onclick: cancel, disabled: linkBusy }, 'Cancel')
        : h('button.btn.sm.danger', { onclick: unpairLink, disabled: linkBusy || !(s.paired || (tok.set && tok.source === 'ui') || (s.ssoSecret && s.ssoSecret.source === 'ui')) }, 'Unpair'),
    ]);
}

/**
 * A Zabbix option, saved to the config file — where the core reads it from at every sync,
 * so the file stays the one place it is decided — then applied with a sync straight away.
 */
async function setZabbixOption(key, on) {
  const r = state.config && state.config.raw;
  if (!r) return;
  r.zabbix = { ...(r.zabbix || {}), [key]: on };
  try {
    await saveRaw({ silent: true });
  } catch (e) {
    toast(`Could not save the config: ${e.message}`, 'err', 8000, { key: 'zabbix-option' });
    return;
  }
  toast(`${key === 'createHosts' ? 'Creating Zabbix hosts' : 'ElasticPro credentials for Zabbix clusters'}: ${on ? 'on' : 'off'}`, 'ok', 4000, { key: 'zabbix-option' });
  await syncZabbix();
}

async function syncZabbix() {
  zbxBusy = true; draw();
  try {
    const res = await bridge({ type: 'ZABBIX_SYNC' });
    if (!res.ok) toast(`Zabbix sync failed: ${res.message}`, 'err', 8000, { key: 'zabbix-sync' });
    else toast(`Zabbix sync: ${res.clusters} cluster host(s)${res.skipped && res.skipped.length ? `, ${res.skipped.length} skipped` : ''}`, 'ok', 5000, { key: 'zabbix-sync' });
    // The new list reaches every page the same way the first one did.
    await setConfig(state.config, state.handle);
    await refreshAll({ force: true });
  } finally {
    zbxBusy = false;
    await loadZabbix();
    draw();
  }
}

/**
 * Where Zabbix clusters come from and whether each can be used.
 *
 * A cluster is a Zabbix host carrying the cluster template; its macros say where it is and
 * how to sign in, and its password is a Vault macro read here and by Zabbix alike. A
 * cluster listed in the config file at the same address is set aside — Zabbix wins — and
 * named below so nobody edits the copy that is no longer used.
 */
function zabbixCard() {
  if (!zbx) return card('Zabbix', 'Loading…', h('div.muted', 'Loading…'));
  if (!zbx.configured) {
    return card('Zabbix clusters', 'not connected',
      h('div.sec', { style: { lineHeight: 1.6 } },
        link && link.supported
          ? 'This server is not connected to a Zabbix API yet. Enter the Zabbix URL above and press Pair with Zabbix — or paste an API token and Save. '
          : 'This server is not connected to a Zabbix API. An administrator connects it in Config → Zabbix, or on the server with ',
        link && link.supported ? null : [h('code.inline', 'ELASTICPRO_ZABBIX_API_URL'), ' and ', h('code.inline', 'ELASTICPRO_ZABBIX_API_TOKEN_FILE'), '. '],
        'Passwords held as Vault macros also need ', h('code.inline', 'ELASTICPRO_VAULT_ADDR'),
        ' with an AppRole. See deploy/zabbix/README.md.'));
  }
  const rows = (zbx.clusters || []).map((z) => {
    const cl = client(z._id);
    return h('tr',
      h('td', h('b', z.name), h('div.muted', { style: { fontSize: '11px' } }, `host ${z.zabbixHost}${z.client ? ` · client ${z.client}` : ''}`)),
      h('td.mono', { style: { fontSize: '11.5px' } }, z.url, z.via ? h('div.muted', `via ${z.via}`) : null),
      h('td', pill(z.credential === 'vault' ? 'Vault' : z.credential === 'elasticpro' ? 'ElasticPro credential' : z.credential === 'plain-macro' ? 'plain macro'
                  : z.credential === 'secret-macro' ? 'Secret macro' : 'none', z.credentialOk ? 'green' : 'red'),
        (z.notes || []).map((n) => h('div.muted', { style: { fontSize: '11px', marginTop: '3px' } }, n))),
      h('td', { style: { fontSize: '11.5px' } }, (z.zabbixGroups || []).join(', ') || h('span.muted', 'no user group can read it')),
      h('td', cl ? pill(cl.state.replace('_', ' '), cl.state === 'online' ? 'green' : cl.state === 'unknown' ? 'grey' : 'red') : pill('unknown', 'grey')));
  });
  const shadowed = (state.config && state.config.shadowed) || [];
  const zopt = (state.config && state.config.raw && state.config.raw.zabbix) || {};
  const toggle = (key, label, help, disabledWhy) => h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' },
      title: disabledWhy || '' },
    h('input', { type: 'checkbox', checked: !!zopt[key], disabled: zbxBusy || !!disabledWhy,
      onchange: (e) => setZabbixOption(key, e.target.checked) }),
    h('span', h('b', label), h('div.muted', { style: { fontSize: '11.5px' } }, disabledWhy || help)));
  const pending = (state.config && state.config.zabbixPending) || [];
  return card('Zabbix', `${(zbx.clusters || []).length} cluster host(s)${zbx.lastSync ? ` · synced ${ago(zbx.lastSync * 1000)}` : ''}`,
    h('div', { style: { display: 'grid', gap: '10px' } },
      h('div', { style: { display: 'grid', gap: '8px', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: '6px' } },
        toggle('useElasticProCredentials', 'Use ElasticPro credentials for Zabbix clusters',
          'Connect with the credential ElasticPro already has for the same address, or the config\u2019s shared one — instead of the password in Vault. Off: Vault.'),
        toggle('createHosts', 'Create Zabbix hosts from this config',
          'Each cluster here that Zabbix does not have yet becomes a Zabbix host with the cluster template; its password goes to Vault. Zabbix wins from then on.',
          zbx.canCreateHosts ? '' : 'Needs the Zabbix write token and Vault writer on the server (see deploy/zabbix/README.md).')),
      (zbx.provisioned || []).length ? h('div', h('b', 'Host creation'),
        h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px' } }, ...zbx.provisioned.map((s) => h('li', s)))) : null,
      zbx.error ? h('div.banner.err', h('div', h('div.ttl', 'Last sync failed'), h('div', zbx.error), h('div.muted', 'Showing the list from the last sync that worked.'))) : null,
      !zbx.vault ? h('div.banner.warn', 'Vault is not configured on this server, so passwords held as Vault macros cannot be read.') : null,
      table(['Cluster host', 'Elasticsearch', 'Password', 'Zabbix user groups that see it', 'Connection'], rows,
        { emptyText: 'No Zabbix host carries the cluster template yet.' }),
      (zbx.skipped || []).length ? h('div', h('b', 'Hosts with the template that are not usable yet'),
        h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px' } }, ...zbx.skipped.map((s) => h('li', s)))) : null,
      pending.length ? h('div.banner.warn', h('div', h('div.ttl', 'Waiting for a working password'),
        h('div', `${pending.map((p) => p.name).join(', ')} ${pending.length === 1 ? 'is' : 'are'} not used yet: the password could not be read. `
          + 'Any config-file cluster at the same address stays in use until it can.'))) : null,
      shadowed.length ? h('div', h('b', 'Config-file clusters set aside — Zabbix has them'),
        h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px' } },
          ...shadowed.map((s) => h('li', `${s.name} (${s.url}) — now the Zabbix host ${s.by}`)))) : null),
    [h('button.btn.sm.primary', { onclick: syncZabbix, disabled: zbxBusy }, zbxBusy ? 'Syncing…' : '↻ Sync now')]);
}

function defaultsCard() {
  const d = state.defaults;
  return card('Effective defaults', 'from the defaults block, with built-in fallbacks',
    table([], Object.entries(d).map(([k, v]) => kvRow(k, String(v)))),
    [h('button.btn.sm', { onclick: async () => { if (await editDefaults()) draw(); } }, 'Edit defaults…')]);
}

function diagnosticsCard() {
  const d = state.defaults;
  return card('Diagnostics & shortcuts', '',
    h('div', { style: { display: 'grid', gap: '10px' } },
      table([], [
        kvRow('Write protection', isReadOnly() ? 'read-only — GET/HEAD + search POSTs only' : 'DISABLED — writes permitted (readOnly: false)'),
        kvRow('Enforced by the core', 'Loading…'),
        kvRow('Routes', `${clusters().filter((c) => c.via).length} via jump host · ${clusters().filter((c) => !c.via).length} direct`),
        kvRow('App version', h('span#core-version', '…')),
        kvRow('Last refresh', state.lastRefresh ? ago(state.lastRefresh) : 'never'),
        kvRow('Auto-refresh', state.autoRefresh ? `every ${d.refreshIntervalSec}s` : 'paused'),
      ]),
      // Advertise what exists. The number keys that used to jump between pages were
      // removed — a stray digit moving the page out from under somebody was worse than
      // the shortcut was worth — and this line kept offering them for eleven pages that
      // never had them.
      h('div', { style: { fontSize: '12px' } },
        h('b', 'Keyboard: '), h('code.inline', 'r'), ' refresh · ',
        h('code.inline', 'Ctrl/⌘+Enter'), ' run the request in the console')),
    [
      h('button.btn.sm', { onclick: () => saveTextAs('clusters.example.yaml', EXAMPLE_YAML) }, 'Save example YAML…'),
      isSnapshotMode() ? null : h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, 'Force refresh all'),
      h('button.btn.sm', { onclick: () => navigateTo('console') }, 'Open REST console'),
    ].filter(Boolean));
}

function draw() {
  const active = activeSection();
  mount(host, sectionNav(), h('div', { style: { marginTop: '12px' } }, active ? active.build() : null));
  // A section that needs a round trip asks for it here rather than on page entry, so
  // opening Config no longer fires every request the page could ever need.
  if (active && active.load) active.load();
}

/** The raw file entry behind a normalised cluster (matched by name, then url). */
function rawClusterOf(c) {
  const raw = state.config && state.config.raw;
  const list = (raw && raw.clusters) || [];
  return list.find((x) => x.name === c.name) || list.find((x) => String(x.url || '').replace(/\/+$/, '') === c.url) || null;
}

function kvRow(k, v) {
  return h('tr.kv', h('td.k', k), h('td.v.mono', v));
}

function msg(text, cls = 'banner') {
  const el = $('#cfg-msg');
  if (el) mount(el, h(`div.${cls}`, { style: { margin: 0 } }, text));
}

async function reload() {
  try {
    if (!state.handle) return msg('This config was loaded once; pick it again to reload.', 'banner warn');
    msg('Reading the file…', 'banner');
    const next = await cfg.readPath(state.handle);
    // applyLoadedConfig also reopens sealed secrets and re-applies a remembered
    // credential — without it a reload leaves every cluster without one.
    await applyLoadedConfig(next, state.handle);
    draw(); loadTrust();
    msg(`Reloaded ${next.fileMeta.name} — ${next.clusters.length} cluster(s).`);
  } catch (e) { msg(`Reload failed: ${e.message}`, 'banner err'); }
}

async function repick() {
  try {
    const path = await cfg.pickConfigFile();
    if (!path) return;
    const next = await cfg.readPath(path);
    await applyLoadedConfig(next, path);
    draw(); loadTrust();
    msg(`Loaded ${next.fileMeta.name}.`);
  } catch (e) {
    msg(`Could not load file: ${e.message}`, 'banner err');
  }
}

async function forget() {
  if (!(await confirmDialog('Forget this configuration?',
    'The remembered file path, the credentials held in memory and any credential kept in the OS ' +
    'vault are dropped, and the app restarts at the setup screen.\n\n' +
    'The config file on disk is not touched.', { yes: 'forget it', danger: true }))) return;
  await forgetVaultCredential();
  await cfg.forgetHandle();
  await forgetWorker();
  location.reload();
}
