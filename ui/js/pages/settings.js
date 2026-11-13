/**
 * Config-Management (the page `settings`; the approved board of 2026-11-05).
 *
 * One menu of nine pages on the left — each with its tabs underneath and a state on the right —
 * a "Find a setting" search, one page header, one tab row, one save bar and one lock mark. The
 * pages, tabs and who sees which are core/config-nav.js; the save bar is ui/change-tracker.js.
 *
 * Three tabs are whole app pages that left the page menu (Alerts › Automation, Requests ›
 * Request Centre, Accounts). They keep their own app page id and are drawn here through
 * `hostedPage()`, so every link and deep link to them still lands on them.
 */

import { h, mount, $ } from '../lib/dom.js';
import { markupSig } from '../lib/keyed.js';
import { bytes, dt, ago, toCsv, download } from '../lib/fmt.js';
import * as cfg from '../core/config.js';
import { state, setConfig, refreshAll, clusters, client, hasSessionCredential, healthState,
         sessionCredentialLabel, clearSessionCredential, clustersNeedingCredential, isReadOnly, syncFleet, reprime } from '../core/state.js';
import { workerStatus, forgetWorker, tunnels as fetchTunnels, listPins, untrustCert, untrustHostKey, tunnelReconnect,
         delaySinkGet, delaySinkSet, delaySinkRun, trustCert,
         zabbixLinkGet, zabbixLinkSet, zabbixLinkTest, zabbixPairBegin, zabbixUnpair,
         policyGet, policySet } from '../core/es.js';
import { PRESETS, DATASETS, DATASET_LABELS, BOUNDS, intervalBounds, applyPreset, activePreset, normalisePolicy,
         fromForm, describeMode, MODES, FALLBACK_DEFAULTS, boundsUnder, policyEffect, fineTuneSummary,
         effectiveClass, resolvedMode, pausedLine, GAP, PLAY_FIELDS, everyText } from '../core/policy.js';
import { defaultApiUrl, checkUrl, countdown, secondsLeft, isManaged, linkChanges, formProblems, linkSummary,
         linkView, testMessage, epUrlFrom, eventLine } from '../core/zabbix-link.js';
import { showCredentialDialog, forgetVaultCredential } from '../ui/credential-dialog.js';
import { credentialsKeptOnServer, keptCredentials, keptLine, promoteCredential, promotableLabel, rejectedDefault } from '../core/server-credentials.js';
import { EXAMPLE_YAML } from '../core/example.js';
import { saveTextAs } from '../core/platform.js';
import { editCluster, editZabbixCluster, editJumpHost, editCredentials, defaultsFields, saveDefaultsForm, unlockSealed, saveRaw, rawClusterOf, editsFileDirectly } from '../ui/config-editor.js';
import { roleMayManageClusters } from '../core/writes.js';
import { card, pill, table, empty, configErrorBanner } from './common.js';
import { navigateTo, intent } from '../core/intent.js';
import { ALERT_RULES, loadAlertSettings, isEnabled, groupRules, nextRuleSettings } from '../core/alert-rules.js';
import { isManagedDefault, isManagedZabbixOption, managedZabbixOptions, managedDefaults, MANAGED_NOTE } from '../core/managed.js';
import { toast } from '../ui/menu.js';
import { bridge } from '../core/transport.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { applyLoadedConfig } from '../ui/load-config.js';
import { filePickerButton, canPickByPath, configHistoryWithCurrent, readVersion } from '../ui/upload.js';
import { confirmDialog, modal, field, text, select, checkbox, val, checked } from '../ui/modal.js';
import { patternPreview, VOLUME_KEYS, VOLUME_DEFAULTS, FIELD_ROWS, BOUNDS as VOLUME_BOUNDS, fileVolume, desktopVolume, foldManaged, overrideIds, validateVolume, applyDefaults,
  applyOverride, yamlBlock, configTxtLines, displayValue, checkCell, indicesCell, listText, toList, getPath, setPath } from '../core/volume-config.js';
import { volumeSettings, volumeFieldsCheck, volumePatternCheck } from '../core/volume-settings.js';
import { planTemplatesPanel, loadPlanTemplates, planTemplatesChanges, savePlanTemplates, discardPlanTemplates } from '../ui/plan-templates-editor.js';
import { reportMailPanels, mailDeliveryPanels, reportHostsPanel, reportMailHeaderActions, reportMailStrip, loadReportMail, reportMailKeyLines,
  saveReportSchedule, saveMailServer, reportMailState } from '../ui/report-mail.js';
import { rowMenu, ICON } from '../ui/menu.js';
import { playSection, loadPlay, savePlayWatch, playDisplayCount } from '../ui/play-settings.js';
import { historyStoreCard, loadHistoryStore, historySupported, saveHistoryStore, discardHistoryStore, historyArmed } from '../ui/history-store.js';
import { destinationOf, destinationWarning } from '../core/history-store.js';
import { CFG_PAGES, HOSTED_TABS, LEGACY_SECTIONS, visibleConfig, subLine, resolveRoute, routeShown, needsOf, routeOfRest, tabHash, appPageOf,
  findSettings, SETTING_INDEX, ZABBIX_ROLES_INDEX, DATA_ROUTING_INDEX } from '../core/config-nav.js';
import { dataRoutingCard, builtinCard, loadDataRouting, saveDataRouting, discardDataRouting, routingStatusNow } from '../ui/data-routing.js';
import { isSupported as routingSupportedBy, storeStreamRows } from '../core/data-routing.js';
import { createTracker } from '../ui/change-tracker.js';
import { zabbixRolesCards, zabbixRolesSupported as rolesSupported, loadZabbixRoles, saveZabbixRoles, discardZabbixRoles, zabbixRolesChanges } from '../ui/zabbix-roles.js';
import { zabbixReviewCard, previewSync } from '../ui/zabbix-review.js';
import { parseHash } from '../reports/route.js';
import { backupBody, backupHeaderActions, leaveBackup, loadBackup, saveBackupSchedule, discardBackupSchedule } from '../ui/backup-panel.js';
import { logDelayCards, loadLogDelaySettings, saveLevels as saveLdLevels, saveFields as saveLdFields, saveReport as saveLdReport, discardLogDelay } from '../ui/logdelay-settings.js';
import { BACKUP_INDEX } from '../core/backup-flow.js';
import { extLink, REPO, ISSUES, AUTHOR_NAME } from '../ui/about.js';

/** What each credential source the Zabbix sync reports is called (bridge.rs zabbix_sync). */
const CREDENTIAL_LABEL = {
  vault: 'Vault', elasticpro: 'ElasticPro credential', 'plain-macro': 'plain macro', 'secret-macro': 'Secret macro',
  'core-secret': 'own, from Cluster Management', 'core-default': 'default, from Cluster Management', 'password-not-set': 'password not set',
};

let host = null;

let core = null;      // last PING
// The address's route while a tab it names waits on an answer (needsOf, config-nav.js), and
// which answers are still on their way: `backup` is PING's, `sink` and `history` their loaders'.
let wanted = null;
const pending = new Set();
let trust = null;     // last PINS + TUNNELS
let sink = null;      // last DELAY_SINK_GET; null until asked, {supported:false} off hosted
let pol = null;       // last POLICY_GET / POLICY_SET reply; null until asked, {error} if refused
let polDraft = null;  // what the Requests form shows when it differs from pol.policy (a preset, a reset)
let polNote = null;   // {text, cls} from the last save, shown inline under the form

/* ------------------------- uploading a config, and its history ------------------- */

let versions = [];
/** CONFIG_HISTORY's `current`: who last saved the file on disk and what changed; null when not recorded. */
let current = null;
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
  try { ({ versions, current } = await configHistoryWithCurrent()); } catch { versions = []; current = null; }
  const el = $('#cfg-history');
  if (el) mount(el, historyBody());
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

/* ---------------------------------- the frame ---------------------------------- */

/** Which page and tab are open. Kept across redraws so a save does not move you. */
let route = { page: 'clusters', tab: 'clusters' };
/** The app page this frame is drawn for: 'settings', or a hosted one ('automation', 'requests', 'accounts'). */
let currentApp = 'settings';
/** The hosted app page's module and the element it draws into, kept across frame redraws. */
let hostedMod = null;
let hostedBody = null;
/** A field to focus once its tab is drawn ("Find a setting", or a link that named one). */
let pendingField = null;
/** The "Find a setting" box: what is typed. */
let findText = '';
/**
 * The tab whose load() has run since this page was entered. A tab is loaded once per visit;
 * the actions that change what it shows call its loader themselves. (draw() used to call the
 * loader on every redraw, and the page redrew on every fleet event.)
 */
let loadedSection = null;

/** The save bar (ui/change-tracker.js): one for the page, kept across redraws. */
const tracker = createTracker({
  root: () => host,
  // While the save bar runs the sections' saves one after another, their redraws are held and
  // done once at the end: a redraw in the first section's save (Zabbix connection) would put
  // back the saved values over what was typed in the next (the sync options) before it is read.
  beforeSave: () => { drawHeld += 1; },
  afterSave: () => { drawHeld -= 1; if (!drawHeld && drawWanted) { drawWanted = false; draw(); } },
});
/** draw() calls held while the save bar saves (see beforeSave). */
let drawHeld = 0;
let drawWanted = false;
/** Set once leaving this page was already confirmed (openTab), so the shell does not ask twice. */
let leaveConfirmed = false;

const roleNow = () => (state.caller ? state.caller.role : null);

/**
 * What the core says it has, which decides the tabs that exist at all. The Phase 2 panels
 * (Backup & restore, the Backend routing table, Zabbix roles from user groups) read flags no
 * core sends yet, so their tabs and panels stay hidden — never a mock, never a guess.
 */
function supports() {
  return {
    // Accounts exist where somebody is signed in; and when the shell opened #/accounts itself
    // (it gates that page by role), the tab it opened is there.
    accounts: !!state.caller || currentApp === 'accounts',
    history: historySupported(),
    sink: !!(sink && sink.supported),
    backup: backupSupported(),
  };
}
const visible = () => visibleConfig(roleNow(), supports());
const openKey = () => `${route.page}/${route.tab}`;
const isOpen = (key) => !!host && host.isConnected && openKey() === key;

/**
 * PHASE 2 HOOK — System › Backup & restore (board 9). Shown only when PING says the core can
 * take and restore backups (`backup: {supported: true}`); no core does yet.
 */
export function backupSupported() { return !!(core && core.backup && core.backup.supported === true); }
/**
 * PHASE 2 HOOK — Data › Backend "Where each kind of data goes" (board 10): History, Reports and
 * Alerts each kept built-in, built-in + Elasticsearch, or Elasticsearch only. Shown only when
 * PING reports `dataRouting: {supported: true}`; until then Backend is the history store alone.
 */
export function dataRoutingSupported() { return routingSupportedBy(core); }
/**
 * Zabbix › "ElasticPro roles from Zabbix user groups" and "Zabbix users" (board 2). Shown only
 * when the core knows the group map: ZABBIX_ROLEMAP_GET answers with `groupMapSaved` (docs/ROLES.md;
 * ZABBIX_LINK_GET carries no such flag). An older core answers an unknown message and neither card is drawn.
 */
export function zabbixRolesSupported() { return rolesSupported(); }

export function render(el) { arrive(el, 'settings', null); }

/**
 * An app page drawn as a tab of this frame: Alerts › Automation, Requests › Request Centre,
 * Accounts. app.js registers each under its own id with this as its module, so the shell's
 * hooks (onData, onLeave, onRoute, onKey) reach the page inside.
 */
export function hostedPage(id, mod) {
  return {
    render(el) { arrive(el, id, mod); },
    onData() { if (hostedMod && hostedMod.onData) hostedMod.onData(); },
    onLeave() { leaveHosted(); leaveBackup(); host = null; },
    onRoute() { if (hostedMod && hostedMod.onRoute) hostedMod.onRoute(); },
    onKey(e) { return !!(hostedMod && hostedMod.onKey && hostedMod.onKey(e)); },
    unsavedChanges,
    hashNow,
  };
}

function leaveHosted() {
  if (hostedMod && hostedMod.onLeave) { try { hostedMod.onLeave(); } catch (_) { /* leaving must not block */ } }
  hostedMod = null;
  hostedBody = null;
}

export function onLeave() {
  findText = '';
  leaveHosted();
  leaveBackup();
  // #view is every page's: a loader answering after this (Zabbix, the policy, the sink, the
  // history store, a sync) must not paint Config-Management over the page now on screen.
  host = null;
}

/**
 * How many changes the save bar holds: the shell asks before it leaves this page (go(), a
 * reload), with the same question openTab asks.
 */
export function unsavedChanges() {
  if (leaveConfirmed || !host || !host.isConnected) return 0;
  return tracker.changes().length;
}

/** The address of what is open, for the shell to put back when leaving is cancelled. */
export function hashNow() {
  return currentApp === 'settings' ? tabHash(route.page, route.tab) : `#/${currentApp}`;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!unsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function arrive(el, appId, mod) {
  routingAsked = false;      // a visit reads the routing afresh
  if (currentApp !== appId || hostedMod !== mod) leaveHosted();
  host = el;
  currentApp = appId;
  loadedSection = null;
  leaveConfirmed = false;
  tracker.resetAll();
  discardDataRouting();
  if (mod) {
    const [page, tab] = HOSTED_TABS[appId];
    route = { page, tab };
    hostedMod = mod;
    hostedBody = h('div.cm-hosted', { dataset: { hosted: appId } });
  } else {
    // Arriving from another page that named a tab (the Request Centre's mode link, a report's
    // "Edit in Config") opens it; a legacy section id (intent.settings.section) has its new home.
    const it = intent.settings;
    intent.settings = null;
    if (it && it.section && LEGACY_SECTIONS[it.section]) {
      const [page, tab] = LEGACY_SECTIONS[it.section];
      route = { page, tab };
      if (it.field) pendingField = it.section === 'volume' ? `vf-${it.field}` : it.field;
    } else if (it && it.page) {
      route = { page: it.page, tab: it.tab || '' };
      if (it.field) pendingField = it.field;
    } else {
      const r = routeOfRest(parseHash(typeof location !== 'undefined' ? location.hash : '').rest);
      if (r.page) route = r;
      // A tab left open on a hosted page (Request Centre, Automation) is that page's, not this
      // one's: arriving at #/settings itself starts on the first tab instead of going back there.
      else if (appPageOf(route.page, route.tab) !== 'settings') route = { page: 'clusters', tab: '' };
    }
  }
  // draw() asks for whatever the open tab needs. The sink, the history store and PING are
  // asked on arrival: their answers decide which tabs exist (Data, System › Backup) — so a
  // route the address names on one of those is kept aside until they have answered.
  wanted = null;
  pending.clear();
  pending.add('backup');
  if (isAdminCaller()) { pending.add('sink'); pending.add('history'); }
  draw();
  if (mod) mod.render(hostedBody);
  if (isAdminCaller()) {
    loadSink();
    // The baseline starts again only when the store was read, not on every redraw of the card
    // (changing the kind of credential redraws it, and that change must still count).
    loadHistoryStore(() => { if (!answered('history') && host && host.isConnected) draw(); }, () => tracker.reset('history'));
  }
  loadCore();
}

/**
 * Resolve the route among what is visible now, keeping the one asked for when a tab it names
 * is still being asked about (it is not visible until its answer lands).
 */
function settleRoute(vis) {
  if (!routeShown(vis, route) && needsOf(route.page, route.tab).some((n) => pending.has(n))) wanted = { ...route };
  route = resolveRoute(vis, route.page, route.tab);
}

/**
 * An answer landed. Once every answer the route kept aside waits on is in, open it if it is
 * visible now (a page named without a tab then opens on its first tab, not on whichever tab
 * answered first); true when that redrew.
 */
function answered(need) {
  pending.delete(need);
  if (!wanted || needsOf(wanted.page, wanted.tab).some((n) => pending.has(n))) return false;
  const open = routeShown(visible(), wanted);
  if (open) route = wanted;
  wanted = null;
  if (open) draw();
  else syncHash();   // not there after all: the address names what is shown, not what was asked
  return open;
}

/** The address moved within this page (#/settings/alerts/triggers → …/system/file). */
export function onRoute() {
  if (currentApp !== 'settings') return;
  const r = routeOfRest(parseHash(location.hash).rest);
  if (!r.page || (r.page === route.page && (r.tab || '') === (route.tab || ''))) return;
  if (route.page === 'system' && route.tab === 'backup') leaveBackup();
  route = { page: r.page, tab: r.tab };
  wanted = null;   // a choice made while an answer was awaited wins over the one kept aside
  tracker.resetAll();
  discardDataRouting();
  draw();
}

/** PING, once per visit: the version for the About card, the guard for Diagnostics, the Phase 2 flags. */
async function loadCore() {
  try { core = (await workerStatus()) || core; } catch (_) { /* no core: the card says so */ }
  const v = host && host.querySelector('#cm-version');
  if (v) v.textContent = core && core.version ? `v${core.version}` : 'version not reported';
  if (!answered('backup') && backupSupported() && host && host.isConnected) draw();
  // The routing panel asks once PING says the core routes its records (admin only).
  if (dataRoutingSupported() && isAdminCaller() && !routingAsked) {
    routingAsked = true;
    loadDataRouting(() => { if (host && host.isConnected) draw(); }, () => tracker.reset('routing'));
  }
}
let routingAsked = false;

/**
 * Open a page and tab. A hosted tab is its own app page, so going there (or leaving one) is
 * the shell's navigation; any other tab is a redraw here. Unsaved changes are asked about first.
 */
async function openTab(pageId, tabId, { field: f = null } = {}) {
  const r = resolveRoute(visible(), pageId, tabId);
  if (!r) return;
  const same = r.page === route.page && r.tab === route.tab;
  const n = tracker.changes().length;
  if (!same && n && !(await confirmDialog('Leave without saving?',
    `${n === 1 ? 'One change is' : `${n} changes are`} not saved yet. Leaving this tab discards ${n === 1 ? 'it' : 'them'}.`,
    { yes: 'discard and leave', danger: true }))) return;
  if (f) pendingField = f;
  const app = appPageOf(r.page, r.tab);
  if (app !== currentApp) {
    if (n) leaveConfirmed = true;   // asked above; the shell's go() must not ask again
    // navigateTo sets intent.settings from its payload (core/intent.js): it is the one hand-off.
    navigateTo(app, app === 'settings' ? { page: r.page, tab: r.tab, field: f } : undefined);
    return;
  }
  if (same) { if (pendingField) focusField(); return; }
  if (route.page === 'system' && route.tab === 'backup') leaveBackup();
  route = r;
  wanted = null;   // a click while an answer was awaited wins over the tab kept aside
  tracker.resetAll();
  discardDataRouting();
  polDraft = null;
  draw();
}

/** The address says which tab is open, so a reload or a copied link comes back to it. */
function syncHash() {
  if (currentApp !== 'settings' || typeof location === 'undefined') return;
  if (wanted) return;   // the address names what is still being asked about: a reload must keep it
  const want = tabHash(route.page, route.tab);
  if (location.hash !== want) { try { window.history.replaceState(null, '', want); } catch (_) { /* sandboxed frame */ } }
}

/** A tab's builder, its loader and what its page header carries. */
const TABS = {
  'clusters/clusters': { build: () => clustersCard(), actions: () => clustersActions() },
  'clusters/creds': { build: () => credentialsCard() },
  'clusters/trust': { build: () => trustSection(), load: () => loadTrust() },
  'zabbix/zabbix': { build: () => zabbixSection(), load: () => loadZabbix(), pill: () => zabbixPill(), actions: () => zabbixActions() },
  'alerts/triggers': { build: () => alertRulesCard(), pill: () => alertsPill(),
    actions: () => [h('button.btn', { type: 'button', onclick: () => openTab('alerts', 'automation') }, 'Write your own rule in Automation ›')] },
  'alerts/automation': { pill: () => alertsPill() },
  'requests/policy': { build: () => requestsCard(), load: () => loadPolicy(), pill: () => requestsPill(), actions: () => requestsActions() },
  'requests/centre': { pill: () => requestsPill() },
  'reports/fields': { build: () => fieldsTab(), load: () => loadVolumeSection() },
  'reports/mail': { build: () => mailTab(), load: () => loadVolumeSection(), actions: () => reportMailHeaderActions(),
    line: 'The volume report mailed as an .xlsx, and the mail server that sends it. Columns and sheet layout are set on Reports › Daily & monthly.' },
  'reports/templates': { build: () => templatesTab(), load: () => loadVolumeSection() },
  'data/backend': { build: () => backendTab() },
  // The measurement (DELAY_SINK_*), then the log delay report's levels, fields and generator (0.3.57, LOGDELAY_SETTINGS_*).
  'data/schedule': { build: () => [delaySinkCard(), ...logDelayCards(trackedCard, () => draw())],
    load: () => loadLogDelaySettings(() => { for (const k of ['ld-levels', 'ld-fields', 'ld-report']) tracker.reset(k); if (isOpen('data/schedule')) draw(); }) },
  'play/play': { build: () => playSection(), load: () => loadPlay(() => { tracker.reset('play-watch'); draw(); }) },
  'system/defaults': { build: () => defaultsCard() },
  'system/file': { build: () => systemFileTab(), load: () => confirmCoreGuard(), actions: () => fileActions(),
    line: 'Which file is loaded, its earlier versions, and whether the write protection holds.' },
  'system/backup': { build: () => backupTab(), load: () => loadBackup(() => draw(), () => tracker.reset('backup-schedule'), { clusters: `${clusters().length} cluster${clusters().length === 1 ? '' : 's'}` }),
    actions: () => backupHeaderActions(),
    line: 'Everything ElasticPro knows about your clusters in one file: keep it, move it to a new server, or load it back. Your Elasticsearch data is not in it; snapshots cover that.' },
};

/* The save path of every tracked form: what its Save button used to run. True when it saved. */
tracker.register('alerts', { save: () => saveAlertRules(), discard: () => draw() });
tracker.register('policy', { save: () => savePolicy(), discard: () => { polDraft = null; polNote = null; draw(); } });
tracker.register('defaults', { save: () => saveDefaults(), discard: () => draw() });
tracker.register('zabbix-link', { save: () => saveLink(), discard: () => { tokenReplace = false; draw(); } });
tracker.register('zabbix-roles', { save: () => saveZabbixRoles(() => draw()), discard: () => { discardZabbixRoles(); draw(); }, changes: () => zabbixRolesChanges() });
tracker.register('zabbix-opts', { save: () => saveZabbixOptions(), discard: () => draw() });
tracker.register('schedule', { save: () => saveSink(), discard: () => draw() });
tracker.register('ld-levels', { save: () => saveLdLevels(), discard: () => { discardLogDelay(); draw(); } });
tracker.register('ld-fields', { save: () => saveLdFields(), discard: () => { discardLogDelay(); draw(); } });
tracker.register('ld-report', { save: () => saveLdReport(), discard: () => draw() });
tracker.register('routing', { save: () => saveDataRouting(), discard: () => { discardDataRouting(); draw(); } });
tracker.register('backup-schedule', { save: () => saveBackupSchedule(), discard: () => { discardBackupSchedule(); draw(); } });
tracker.register('history', { save: () => saveHistoryStore(), discard: () => { discardHistoryStore(); draw(); } });
tracker.register('volume', { save: () => saveVolume(), discard: () => { vol.note = null; draw(); } });
tracker.register('report-mail', { save: () => saveReportSchedule(), discard: () => draw() });
tracker.register('smtp', { save: () => saveMailServer(), discard: () => draw() });
tracker.register('play-watch', { save: () => savePlayWatch(), discard: () => draw() });
tracker.register('plan-templates', { save: () => savePlanTemplates(() => draw()), discard: () => { discardPlanTemplates(); draw(); }, changes: () => planTemplatesChanges() });

function draw() {
  if (!host) return;
  if (drawHeld) { drawWanted = true; return; }
  const vis = visible();
  if (!vis.length) {
    mount(host, h('div.banner', h('div', h('div.ttl', 'Nothing here for this account'),
      h('div', 'Config-Management is an administrator’s; an operator sees Clusters, Alerts › Automation and Requests › Request Centre.'))));
    return;
  }
  settleRoute(vis);
  const r = route;
  const page = vis.find((p) => p.id === r.page);
  const tab = page.tabs.find((t) => t.id === r.tab);
  const app = appPageOf(r.page, r.tab);
  // The tab asked for is another app page (an operator's first tab is Automation, say): go there.
  if (app !== currentApp) {
    mount(host, h('div.muted', 'Opening…'));
    setTimeout(() => navigateTo(app), 0);
    return;
  }
  const t = TABS[`${r.page}/${r.tab}`] || {};
  const body = tab.appPage ? hostedBody : (t.build ? t.build() : null);
  mount(host, h('div.cm',
    sidebar(vis),
    h('div.cm-main',
      pageHeader(page, tab, t),
      page.tabs.length > 1 ? tabRow(page) : null,
      h('div.cm-body', { oninput: () => tracker.refresh(), onchange: () => tracker.refresh() }, body),
      tracker.bar)));
  syncHash();
  // A tab that needs a round trip asks for it here rather than on page entry, and once per
  // visit, so a redraw never asks again.
  if (t.load && loadedSection !== openKey()) {
    loadedSection = openKey();
    t.load();
  }
  tracker.refresh();
  if (pendingField) focusField();
}

/** Focus the field "Find a setting" (or a link) named, once it is on screen; its tab may still be loading. */
function focusField(tries = 0) {
  const id = pendingField;
  const el = id && host && host.querySelector(`#${id}`);
  if (!el) {
    if (tries < 20 && id) setTimeout(() => { if (pendingField === id) focusField(tries + 1); }, 150);
    else pendingField = null;
    return;
  }
  pendingField = null;
  const fold = el.closest('details');
  if (fold && !fold.open) fold.open = true;
  try { el.scrollIntoView({ block: 'center' }); } catch (_) { /* jsdom */ }
  try { el.focus(); } catch (_) { /* not focusable */ }
  const box = el.closest('label, td, .vf-fld') || el;
  box.classList.remove('focus-flash');
  void box.offsetWidth;
  box.classList.add('focus-flash');
}

/* ------------------------------- sidebar, header, tabs ------------------------------- */

/** The state on the right of a menu item: what is known now, never a guess. `[text, tone]`. */
function pageMeta(id) {
  switch (id) {
    case 'clusters': return [String(clusters().length), 'off'];
    case 'zabbix': {
      if (!zbx || !link || link.hidden) return ['', 'off'];
      if (zbx.error) return ['sync failed', 'bad'];
      return zbx.configured ? ['synced', 'ok'] : ['not connected', 'off'];
    }
    case 'alerts': {
      const settings = loadAlertSettings(state.config && state.config.raw);
      const off = ALERT_RULES.filter((r) => !isEnabled(settings, r.id)).length;
      return off ? [`${off} off`, 'warn'] : ['all on', 'off'];
    }
    case 'requests': {
      if (!pol || pol.error) return ['', 'off'];
      const p = normalisePolicy(pol.policy, polDefaults(), polBounds());
      const preset = PRESETS.find((x) => x.id === activePreset(p, polDefaults(), polBounds()));
      return [preset ? preset.name : p.mode, 'off'];
    }
    case 'reports': { const s = reportMailState(); return [s || '', 'off']; }
    case 'data': return historySupported() ? [historyArmed() ? 'writing' : 'not writing', historyArmed() ? 'ok' : 'off'] : ['', 'off'];
    case 'play': { const n = playDisplayCount(); return n == null ? ['', 'off'] : [`${n} TV${n === 1 ? '' : 's'}`, 'off']; }
    case 'system': return isReadOnly() ? ['read-only', 'ok'] : ['writes on', 'warn'];
    default: return ['', 'off'];
  }
}

/** The search index with what pages add at run time: every alert rule by its name. */
function runtimeIndex() {
  return [...SETTING_INDEX, ...(zabbixRolesSupported() && isAdminCaller() ? ZABBIX_ROLES_INDEX : []),
    ...(dataRoutingSupported() && isAdminCaller() ? DATA_ROUTING_INDEX : []),
    ...(backupSupported() && isAdminCaller() ? BACKUP_INDEX : []),
    ...ALERT_RULES.map((r) => ['alerts', 'triggers', r.label, `al-on-${r.id}`, `alert rule ${r.id} ${r.level}`])];
}

function findBox(vis) {
  const results = h('div#cm-find-results.cm-find-results', { role: 'listbox', 'aria-label': 'Settings found', hidden: true });
  const input = h('input#cm-find', {
    type: 'search', placeholder: 'Find a setting…', autocomplete: 'off', 'aria-label': 'Find a setting', 'aria-controls': 'cm-find-results',
    'data-untracked': '',
  });
  const show = (q) => {
    findText = q;
    const hits = findSettings(q, vis, { index: runtimeIndex() });
    results.hidden = !q.trim();
    results.replaceChildren(...(hits.length ? hits.map((x) => h('button.cm-find-hit', {
      type: 'button', role: 'option',
      onclick: () => { input.value = ''; findText = ''; results.hidden = true; openTab(x.page, x.tab, { field: x.field || null }); },
    }, h('span', x.label), h('span.muted', x.where))) : [h('div.cm-find-none.muted', `Nothing matches “${q.trim()}”`)]));
  };
  input.addEventListener('input', (e) => show(e.target.value));
  input.addEventListener('keydown', (e) => {
    const hits = [...results.querySelectorAll('.cm-find-hit')];
    if (e.key === 'Enter' && hits[0]) { e.preventDefault(); hits[0].click(); }
    else if (e.key === 'ArrowDown' && hits[0]) { e.preventDefault(); hits[0].focus(); }
    else if (e.key === 'Escape') { e.target.value = ''; show(''); }
  });
  results.addEventListener('keydown', (e) => {
    const hits = [...results.querySelectorAll('.cm-find-hit')];
    const i = hits.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && i >= 0 && hits[i + 1]) { e.preventDefault(); hits[i + 1].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? hits[i - 1] : input).focus(); }
    if (e.key === 'Escape') { input.value = ''; show(''); input.focus(); }
  });
  input.value = findText;
  if (findText) show(findText);
  return h('div.cm-find', h('label', input, h('kbd', { 'aria-hidden': 'true' }, '/')), results);
}

function sidebar(vis) {
  const role = roleNow();
  return h('aside.cm-side', { 'aria-label': 'Config-Management' },
    h('div.cm-side-head', h('span.cm-side-t', 'Config-Management'), role ? h('span.muted', role) : null),
    findBox(vis),
    h('nav.cm-nav', { 'aria-label': 'Config sections' },
      ...vis.map((p) => {
        const [meta, tone] = pageMeta(p.id);
        const on = p.id === route.page;
        return h('button.cm-item', {
          type: 'button', title: p.label, dataset: { cmPage: p.id }, 'aria-current': on ? 'page' : null,
          onclick: () => openTab(p.id, on ? route.tab : ''),
        },
        h('span.cm-item-t', h('span.cm-item-l', p.label), h('span.cm-item-s', subLine(p))),
        meta ? h('span.cm-item-m', { class: `t-${tone}` }, meta) : null);
      })),
    h('section.cm-about', { 'aria-label': 'About ElasticPro' },
      h('div.cm-about-h', h('b', 'ElasticPro'), h('span#cm-version.mono', core && core.version ? `v${core.version}` : '…')),
      h('span', 'Author: ', extLink(AUTHOR_NAME, REPO, 'ElasticPro on GitHub')),
      h('span.cm-about-links', extLink('GitHub ↗', REPO, 'Source code and releases'), extLink('Support ↗', ISSUES, 'Report a problem or ask a question'))));
}

function pageHeader(page, tab, t) {
  const pillEl = t.pill ? t.pill() : null;
  const actions = t.actions ? (t.actions() || []).filter(Boolean) : [];
  return h('header.cm-head',
    h('div.cm-head-t',
      h('div.cm-crumb', 'Config-Management'),
      h('h1', page.label, pillEl),
      h('p', t.line || page.line)),
    actions.length ? h('div.cm-actions', ...actions) : null);
}

/**
 * The tab row. The same markup and `aria-current` as the window's own tabs, so it reads as
 * navigation; a hosted tab (Automation, Request Centre) is its own address.
 */
function tabRow(page) {
  return h('nav.subnav.cm-tabs', { 'aria-label': `Sections of ${page.label}` },
    ...page.tabs.map((t) => h('button', {
      type: 'button', title: t.label, dataset: { cmTab: t.id }, 'aria-current': t.id === route.tab ? 'page' : null,
      onclick: () => openTab(page.id, t.id),
    }, h('span', t.label))));
}

/** "/" focuses Find a setting while Config-Management is open (outside a field). */
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const box = host && host.isConnected && host.querySelector('#cm-find');
    if (!box) return;
    e.preventDefault();
    box.focus();
  });
}

/** Read the guard back from the core itself rather than trusting the UI's copy. */
async function confirmCoreGuard() {
  const st = await workerStatus();
  core = st || core;
  const cell = host && host.querySelector('#cm-guard');
  if (!cell) return;
  const agrees = !!st && st.readOnly === isReadOnly();
  cell.replaceChildren(!st || st.readOnly === undefined ? h('span.muted', 'core did not report')
    : h('span', pill(st.readOnly ? 'yes' : 'no', st.readOnly ? 'green' : 'orange'), ' ',
      h('span.muted', `${st.readOnly ? 'writes blocked' : 'writes allowed'}${agrees ? ' · matches the config' : ''}`),
      agrees ? null : h('b', { style: { color: 'var(--critical-ink)' } }, ' (MISMATCH with config)')));
  const v = host.querySelector('#core-version');
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
  // Config → Defaults → Certificates = insecure: what it let through, all in one table.
  const acceptAll = !!(trust && trust.pins && trust.pins.acceptAll);
  const accepted = (trust && trust.pins && trust.pins.accepted) || [];
  const aRows = accepted.map((a) => h('tr',
    h('td', { style: { fontSize: '11.5px' } }, a.kind === 'host_key' ? `SSH key · ${a.target}` : h('span.mono', a.target)),
    h('td', { style: { fontSize: '11.5px' } }, (a.clusters || []).map((c) => c.name).join(', ') || h('span.muted', a.kind === 'host_key' ? 'jump host' : 'Zabbix API or not a cluster')),
    h('td', { style: { fontSize: '11.5px' } }, a.subject || '–'),
    h('td.muted', { style: { fontSize: '11px' } }, a.reason),
    h('td.mono', { style: { fontSize: '11px', wordBreak: 'break-all' } }, a.fingerprint)));
  return h('div', { style: { display: 'grid', gap: '14px' } },
    acceptAll ? h('div',
      h('div', { style: { fontWeight: 620, marginBottom: '6px' } }, pill('insecure', 'orange'), ` Accepted without checking (${aRows.length})`),
      h('div.muted', { style: { fontSize: '12px', marginBottom: '6px' } },
        'Defaults → Certificates is set to insecure: every certificate and jump-host key is accepted. ' +
        'These would have stopped otherwise. Set it back to auto to have them checked again.'),
      aRows.length ? table(['What', 'Clusters', 'Subject / key type', 'Would have failed because', 'Fingerprint'], aRows)
        : h('div.muted', { style: { fontSize: '12px' } }, 'Nothing so far: every connection made since the switch went on would have passed anyway.')) : null,
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
/**
 * The one thing on this page that fleet data changes is a cluster's state pill. Those are
 * updated in place; the page is not rebuilt, so a form being typed into keeps its text and
 * no tab asks the core for anything again.
 */
export function onData() {
  if (!host || !host.isConnected) return;
  for (const td of host.querySelectorAll('td[data-cluster-state]')) {
    // Only when it reads differently: replaced on every push, the pill under the mouse lost its tooltip.
    const pill = clusterStatePill(client(td.dataset.clusterState), td.dataset.kind);
    if (td.childNodes.length !== 1 || markupSig(td.firstChild) !== markupSig(pill)) td.replaceChildren(pill);
  }
}

/** A cluster's state as a pill: the Clusters tab marks an auth error yellow, Zabbix's rows red. */
function clusterStatePill(cl, kind) {
  if (!cl) return pill('unknown', 'grey');
  const colour = cl.state === 'online' ? 'green'
    : cl.state === 'unknown' ? 'grey'
    : cl.state === 'auth_error' && kind === 'clusters' ? 'yellow' : 'red';
  return pill(cl.state.replace('_', ' '), colour);
}

/* ------------------------------ alert triggers ------------------------------ */

/**
 * Every alert this app can raise, with a switch and its thresholds, grouped as the board has
 * them (core/alert-rules.js RULE_GROUPS).
 *
 * The list is the registry, so a rule cannot exist in the code and be missing here.
 * Switching one off stops it being shown; it does not stop it being computed, and it does
 * not touch anything anybody acknowledged — the identity of an alert is unchanged by
 * being disabled, which is what makes retuning safe.
 *
 * Switches and thresholds wait for the save bar (they used to save on the spot), so a change
 * of mind costs nothing and a run of changes is one write.
 *
 * Writing a genuinely new rule is the Automation tab's job. There is one rule editor in
 * this product and this is not a second one.
 */
const alertView = { q: '', show: 'all' };

function alertsPill() {
  const settings = loadAlertSettings(state.config && state.config.raw);
  const off = ALERT_RULES.filter((r) => !isEnabled(settings, r.id)).length;
  return h('span.pill.grey', `${ALERT_RULES.length - off} on · ${off} off`);
}

function alertRulesCard() {
  const raw = state.config && state.config.raw;
  const settings = loadAlertSettings(raw);
  const admin = !!raw;
  const off = ALERT_RULES.filter((r) => !isEnabled(settings, r.id)).length;

  const row = (r) => {
    const on = isEnabled(settings, r.id);
    const s = settings[r.id] || {};
    return h('tr', { dataset: { rule: r.id }, class: on ? '' : 'cm-off' },
      h('td', h('input.sw', { id: `al-on-${r.id}`, type: 'checkbox', role: 'switch', checked: on, disabled: !admin,
        'data-label': r.label, 'aria-label': r.label,
        title: on ? `Stop showing ${r.label}` : `Show ${r.label} again`,
        onchange: (e) => { const tr = e.target.closest('tr'); if (tr) tr.classList.toggle('cm-off', !e.target.checked); } })),
      h('td', h('div', { style: { fontWeight: 620 } }, r.label),
        h('div.muted', { style: { fontSize: '11.5px' } }, r.why)),
      h('td', pill(r.level, { critical: 'red', high: 'high' }[r.level] || 'yellow')),
      h('td', (r.thresholds || []).length
        ? h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } },
            ...r.thresholds.map((t) => {
              const lockedT = isManagedDefault(t.key);
              return h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12px' } },
                h('span.muted', t.label),
                h('input.cm-num', {
                  id: `al-th-${r.id}-${t.key}`, type: 'number', min: String(t.min), max: String(t.max), disabled: !admin || lockedT,
                  'data-label': `${r.label}: ${t.label}`,
                  value: String((lockedT ? undefined : (s.thresholds && s.thresholds[t.key])) ?? state.defaults[t.key] ?? ''),
                  title: lockedT ? MANAGED_NOTE : `${t.min}–${t.max}${t.unit}`,
                }),
                h('span.muted', t.unit),
                lockedT ? lockMark() : null);
            }))
        : h('span.muted', '—')),
      h('td.mono.muted', { style: { fontSize: '11px' } }, r.id));
  };

  // Filter and On/Off hide rows rather than leaving them out, so a hidden rule's unsaved switch
  // still counts and still saves.
  const applyFilter = (tbl) => {
    const q = alertView.q.trim().toLowerCase();
    for (const tr of tbl.querySelectorAll('tr[data-rule]')) {
      const box = tr.querySelector('input[type=checkbox]');
      const hit = !q || tr.textContent.toLowerCase().includes(q);
      const want = alertView.show === 'all' || (alertView.show === 'on') === !!(box && box.checked);
      tr.hidden = !(hit && want);
    }
    for (const g of tbl.querySelectorAll('tr.cm-grp')) {
      let n = g.nextElementSibling; let any = false;
      while (n && !n.classList.contains('cm-grp')) { if (!n.hidden) any = true; n = n.nextElementSibling; }
      g.hidden = !any;
    }
  };
  const groups = groupRules(ALERT_RULES);
  const tbl = h('table.tbl.cm-rules',
    h('thead', h('tr', h('th', { style: { width: '56px' } }, 'On'), h('th', 'Alert'), h('th', { style: { width: '110px' } }, 'Level'),
      h('th', 'Thresholds'), h('th', { style: { width: '140px' } }, 'Id'))),
    h('tbody', ...groups.flatMap((g) => [h('tr.cm-grp', h('td', { colSpan: 5 }, g.name)), ...g.rules.map(row)])));
  const seg = (id, label) => h('button', { type: 'button', 'aria-pressed': String(alertView.show === id),
    onclick: (e) => { alertView.show = id; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); applyFilter(tbl); } }, label);
  applyFilter(tbl);

  return h('section.card.cm-card', { dataset: { track: 'alerts', trackLabel: 'Alert triggers' } },
    h('header', h('h2', 'Alert triggers'), h('span.sub', `${ALERT_RULES.length} rule(s)${off ? ` · ${off} switched off` : ' · all on'}`)),
    h('div.cm-toolbar',
      h('input', { type: 'search', placeholder: 'Filter rules', 'aria-label': 'Filter rules', value: alertView.q, 'data-untracked': '',
        oninput: (e) => { alertView.q = e.target.value; applyFilter(tbl); } }),
      h('div.cm-seg', { role: 'group', 'aria-label': 'Show' }, seg('all', `All ${ALERT_RULES.length}`), seg('on', 'On'), seg('off', 'Off')),
      h('span.cm-toolbar-note', 'Switches and thresholds take effect after Save · ', lockMark(), ' means config.txt sets it')),
    !admin ? h('div.muted', { style: { fontSize: '12px', padding: '8px 12px' } }, 'Read-only — no config is loaded.') : null,
    h('div.tbl-wrap', tbl),
    h('div.cm-foot', 'To write a rule of your own, use ',
      h('button.btn.sm.ghost', { type: 'button', onclick: () => openTab('alerts', 'automation') }, 'Automation'), '.'));
}

/** The save bar's Save for Alert triggers: every switch and threshold on screen, checked, in one write. */
async function saveAlertRules() {
  const raw = state.config && state.config.raw;
  if (!raw) { toast('No config loaded', 'warn'); return false; }
  const next = { ...(raw.alertRules && typeof raw.alertRules === 'object' ? raw.alertRules : {}) };
  for (const r of ALERT_RULES) {
    const box = host && host.querySelector(`#al-on-${r.id}`);
    if (!box) continue;
    const typed = {};
    for (const t of r.thresholds || []) {
      const el = host.querySelector(`#al-th-${r.id}-${t.key}`);
      if (!el || el.disabled) continue;
      const v = Number(el.value);
      if (!isFinite(v) || v < t.min || v > t.max) {
        toast(`${t.label} must be between ${t.min} and ${t.max}${t.unit}`, 'warn');
        try { el.focus(); } catch (_) { /* jsdom */ }
        return false;
      }
      typed[t.key] = v;
    }
    // Only what differs is written: a threshold left at the shared default stays unset.
    const entry = nextRuleSettings(next[r.id], r, { on: !!box.checked, typed }, state.defaults);
    if (entry) next[r.id] = entry; else delete next[r.id];
  }
  const before = raw.alertRules;
  raw.alertRules = next;
  try {
    await saveRaw(raw);
    await setConfig(await cfg.normalize(raw, (state.config.fileMeta || {}).name || 'config'), state.handle);
    toast('Alert settings saved');
  } catch (e) {
    raw.alertRules = before;
    toast(`Could not save: ${e.message}`, 'err', 5000);
    return false;
  }
  draw();
  return true;
}

/** The one lock mark: a value config.txt sets — shown, never editable, never written. */
function lockMark(title = MANAGED_NOTE) {
  return h('span.cm-lock', { title, role: 'img', 'aria-label': title });
}

/** card(), taking part in the save bar as `section` (ui/change-tracker.js). */
function trackedCard(section, trackLabel, title, sub, body, actions) {
  const el = card(title, sub, body, actions);
  el.dataset.track = section;
  el.dataset.trackLabel = trackLabel;
  return el;
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
  if (!answered('sink') && host && host.isConnected) draw();
}

function sinkField(label, key, opts = {}) {
  const c = (sink && sink.config) || {};
  return h('label', { id: opts.id || null, style: { display: opts.hidden ? 'none' : 'grid', gap: '3px', fontSize: '11.5px' } },
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

/** The sink form as typed. */
function readSink() {
  const list = clusters();
  const v = (key) => { const el = $(`#sink-${key}`); return el ? el.value.trim() : ''; };
  const chosen = list.map((x) => x.id).filter((id) => { const el = $(`#sink-pick-${id}`); return el && el.checked; });
  return {
    enabled: !!($('#sink-enabled') || {}).checked,
    destination: ((v0) => (v0 === 'history' || v0 === 'builtin' ? v0 : 'cluster'))((($('#sink-destination') || {}).value)),
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
}

/** The save bar's Save for the scheduled measurement (it was the card's Save). True when saved. */
async function saveSink() {
  const c = (sink && sink.config) || {};
  const next = readSink();
  // Empty means "every cluster" to the core, which is right for a hand-edited file and
  // wrong for a screen where somebody has just unticked the last box.
  const toHistory = next.destination === 'history' || next.destination === 'builtin';
  // A config that never had the field saves without it, exactly as before.
  if (!toHistory && c.destination === undefined) delete next.destination;
  if (toHistory) {
    // The history store has its own destination; the cluster picker and prefix do not apply.
    next.sinkClusterId = c.sinkClusterId || '';
    next.indexPrefix = c.indexPrefix || '';
  }
  if (next.enabled && !next.clusters.length) { toast('Pick at least one cluster to measure', 'warn'); return false; }
  if (next.enabled && !toHistory && next.clusters.length === 1 && next.clusters[0] === next.sinkClusterId) {
    toast('The only cluster picked is the one being written to', 'warn'); return false;
  }
  try {
    const res = await delaySinkSet(next);
    if (!res || !res.ok) { toast(`Not saved: ${(res && res.message) || 'refused'}`, 'err', 6000); return false; }
    sink = { ...res, supported: true };
    toast(next.enabled ? 'Scheduled measurement armed' : 'Scheduled measurement switched off');
    draw();
    return true;
  } catch (e) {
    toast(`Could not save: ${e.message}`, 'err', 5000);
    return false;
  }
}

function delaySinkCard() {
  if (!sink || !sink.supported) return null;
  const c = sink.config || {};
  const st = sink.state || {};
  const list = clusters();
  const picked = new Set((c.clusters || []).length ? c.clusters : list.map((x) => x.id).filter((id) => id !== c.sinkClusterId));

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

  const dest = destinationOf(c);
  const histWarn = destinationWarning(c, sink.historyStore);
  const lock = () => {
    // Choosing the history store hides what only a cluster destination uses.
    const toHistory = ['history', 'builtin'].includes(($('#sink-destination') || {}).value);
    for (const id of ['sink-target-field', 'sink-indexPrefix-field']) { const el = $(`#${id}`); if (el) el.style.display = toHistory ? 'none' : ''; }
    const note = $('#sink-history-note'); if (note) note.style.display = ($('#sink-destination') || {}).value === 'history' ? '' : 'none';
  };

  return trackedCard('schedule', 'Scheduled log delay', 'Scheduled log delay',
    c.enabled ? `every ${c.everyHours}h \u2192 ${dest === 'history' ? 'the history store' : dest === 'builtin' ? 'ElasticPro built-in only' : (c.sinkClusterId || 'nowhere')}` : 'switched off',
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
          h('span.muted', 'Destination'),
          h('select#sink-destination', { onchange: lock },
            h('option', { value: 'cluster', selected: dest === 'cluster' }, 'A monitored cluster (as today)'),
            h('option', { value: 'history', selected: dest === 'history' }, 'The history store'),
            h('option', { value: 'builtin', selected: dest === 'builtin' }, 'ElasticPro built-in only (kept 90 days)'))),
        h('label#sink-target-field', { style: { display: dest !== 'cluster' ? 'none' : 'grid', gap: '3px', fontSize: '11.5px' } },
          h('span.muted', 'Write measurements to'),
          h('select#sink-target', {},
            h('option', { value: '' }, '\u2014 pick a cluster \u2014'),
            ...list.map((x) => h('option', { value: x.id, selected: x.id === c.sinkClusterId }, x.name)))),
        sinkField('Every (hours)', 'everyHours', { type: 'number', min: 1, max: 24, width: '80px' }),
        sinkField('Index prefix', 'indexPrefix', { title: 'Indices are <prefix>-YYYY.MM', id: 'sink-indexPrefix-field', hidden: dest !== 'cluster' }),
        sinkField('Max devices per run', 'maxDevices', { type: 'number', min: 1, max: 10000, width: '110px' })),
      h('div.muted#sink-history-note', { style: { fontSize: '11.5px', display: dest === 'history' ? '' : 'none' } },
        'Measurements go to <history prefix>-delay-YYYY.MM on the history store, under its own two gates '
        + '(HISTORY_STORE_WRITES and Write history) \u2014 see Data \u203a Backend.'),
      histWarn ? h('div.banner.warn', { id: 'sink-history-warn', style: { margin: 0, fontSize: '12px' } }, histWarn) : null,
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
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        h('button.btn', { onclick: runNow }, 'Run now'),
        h('span.muted', { style: { fontSize: '11.5px' } }, 'Changes here wait for the save bar.'))));
}
/* ------------------------------- the request policy ------------------------------- */

/**
 * When the poller goes to the clusters, how hard, and whether at all.
 *
 * Asked once per visit, like every section's load. The form is not touched by fleet
 * events: onData only repaints state pills, so a half-typed interval survives a refresh.
 */
async function loadPolicy() {
  try {
    const res = await policyGet();
    pol = res && res.ok ? res : { error: (res && res.message) || 'the core did not answer' };
  } catch (e) {
    pol = { error: e.message || String(e) };
  }
  polDraft = null;
  if (isOpen('requests/policy') || isOpen('requests/centre')) { tracker.reset('policy'); draw(); }
}

const polDefaults = () => (pol && pol.defaults) || FALLBACK_DEFAULTS;
/** What the form may hold: BOUNDS under the request gate's caps, as this core reported them. */
const polBounds = () => boundsUnder(pol && pol.gate);

/** The form as typed, before any clamping — fromForm decides what survives. */
function readPolicyForm() {
  const v = (id) => { const el = host && host.querySelector(`#${id}`); return el ? el.value.trim() : ''; };
  const intervalsSec = {};
  for (const ds of DATASETS) intervalsSec[ds] = v(`pol-iv-${ds}`);
  return {
    mode: v('pol-mode'),
    intervalsSec,
    watchMinutes: v('pol-watch'),
    global: v('pol-global'),
    perCluster: v('pol-per'),
    tunnel: v('pol-tunnel'),
    timeoutMs: v('pol-timeout'),
    minGapSec: v('pol-gap'),
    play: Object.fromEntries(PLAY_FIELDS.map((f) => [f.key, v(`pol-play-${f.key}`)])),
  };
}

/** The config.txt key that locks a policy field (POLICY_GET's `managed`), or null. */
const policyLock = (field) => (pol && pol.managed && pol.managed[field]) || null;

/**
 * "Duplicate requests": the gap (editable unless config.txt locks it), what it does, and the
 * kinds of request it never holds (the core's GAP_EXEMPT, listed, not editable).
 */
function gapSection(p, admin, defaults) {
  const lock = policyLock('minGapSec');
  const exempt = (pol && Array.isArray(pol.gapExempt) && pol.gapExempt.length ? pol.gapExempt.map((x) => x.label)
    : ['the REST console']);
  const shipped = (defaults && defaults.minGapSec) || GAP.def;
  return h('section#pol-gap-sec.pol-sec', { 'aria-labelledby': 'pol-gap-h' },
    h('h4#pol-gap-h.pol-sec-h', 'Duplicate requests'),
    h('div.muted.pol-sec-note',
      'A request ElasticPro sends by itself — a page loading, Play, Retry or Refresh, the poller — is not sent again while ',
      'the same request was answered less than this long ago: the asker gets that reading, with its age, and the next request ',
      'goes once the gap has passed. Writes are never held back: what a write changed is read again at once.'),
    h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'end' } },
      h('label', { style: { display: 'grid', gap: '3px', fontSize: '11.5px' } },
        h('span.muted', 'Minimum gap (seconds)'),
        h('input#pol-gap', { type: 'number', min: String(GAP.min), max: String(GAP.max), value: String(p.minGapSec),
          disabled: !admin || !!lock, style: { width: '90px' },
          title: lock ? `${MANAGED_NOTE} (${lock})` : `${GAP.min}–${GAP.max} s; shipped ${shipped} s` }),
        h('span.muted', { style: { fontSize: '10.5px' } }, lock ? `${MANAGED_NOTE} (${lock})` : `${GAP.min}–${GAP.max} s · shipped ${shipped} s`))),
    h('ul#pol-gap-facts.pol-sec-list',
      h('li', h('b', 'Askers waiting on the same request share it'), ' — always on.'),
      h('li', 'Never held, sent at once (a person typed them): ', exempt.join(', '), '.')));
}

/**
 * "While Play runs": what Play keeps going on its own for every display, each interval
 * editable within its bounds unless config.txt locks it.
 */
function playScheduleSection(p, admin, defaults) {
  const dp = (defaults && defaults.play) || {};
  const rows = PLAY_FIELDS.map((f) => {
    const lock = policyLock(`play.${f.key}`);
    return h('tr', { 'data-play': f.key },
      h('td', f.label, h('div.muted', { style: { fontSize: '10.5px' } }, f.covers)),
      h('td', h('input', { id: `pol-play-${f.key}`, type: 'number', min: String(f.min), max: String(f.max),
        value: String(p.play[f.key]), disabled: !admin || !!lock, style: { width: '100px' },
        title: lock ? `${MANAGED_NOTE} (${lock})` : `${f.min}–${f.max} seconds` }),
      h('span.muted', { style: { marginLeft: '4px' } }, 's'),
      h('div.muted', { style: { fontSize: '10.5px' } }, everyText(p.play[f.key]))),
      h('td.muted', { style: { fontSize: '11px' } }, `${dp[f.key] ?? f.def} s`),
      h('td.pol-iv-note', lock ? h('span', pill('locked', 'grey'), ` ${MANAGED_NOTE} (${lock})`) : h('span.muted', `${everyText(f.min)}–${everyText(f.max)}`)));
  });
  return h('section#pol-play-sec.pol-sec', { 'aria-labelledby': 'pol-play-h' },
    h('h4#pol-play-h.pol-sec-h', 'While Play runs'),
    h('div.muted.pol-sec-note',
      'What Play keeps going on its own, for every display. If somebody\u2019s page shows the same data at the same time, ',
      'that page\u2019s faster pace applies while it is open — and the gap above still holds for both. The log delay is ',
      'measured in two tiers: a full check of every device, then only the devices at or past the yellow line, in one request.'),
    table(['What', 'Every', 'Shipped', ''], rows));
}

function choosePreset(id) {
  // Start from what is on screen so a value typed but not yet saved is kept.
  const { policy } = fromForm(readPolicyForm(), polDefaults(), polBounds());
  polDraft = applyPreset(policy, id, polDefaults(), polBounds());
  polNote = null;
  draw();
}

function resetPolicyForm() {
  polDraft = normalisePolicy(polDefaults(), FALLBACK_DEFAULTS, polBounds());
  polNote = { text: 'The form shows the shipped policy. Nothing is saved until you press Save.', cls: 'banner' };
  draw();
}

async function savePolicy() {
  const { policy, problems } = fromForm(readPolicyForm(), polDefaults(), polBounds());
  // The emergency stop is not this form's: it has its own messages (Request Centre), and the
  // core ignores `paused` in POLICY_SET — so a form opened before a stop began never lifts it.
  const { paused: _stop, ...rest } = policy;
  let res;
  try { res = await policySet(rest); } catch (e) { res = { ok: false, message: e.message || String(e) }; }
  if (!res || !res.ok) {
    polNote = { text: `Not saved: ${(res && res.message) || 'refused'}`, cls: 'banner err' };
    toast(polNote.text, 'err', 8000, { key: 'request-policy' });
    draw();
    return false;
  }
  pol = res; polDraft = null;
  syncFleet().catch(() => {});   // the top bar says paused (or not) now, not at the next sync
  const lines = [
    res.saved === false ? 'Applied, but not written to disk.' : 'Saved.',
    ...problems,
    res.warning ? `Warning: ${res.warning}` : null,
  ].filter(Boolean);
  polNote = { text: lines.join(' '), cls: problems.length || res.warning ? 'banner warn' : 'banner' };
  toast(problems.length ? 'Request policy saved — some values were adjusted' : 'Request policy saved',
    problems.length || res.warning ? 'warn' : 'ok', 5000, { key: 'request-policy' });
  draw();
  return true;
}

/**
 * Whether the "Fine-tune" fold is open, per person and per browser. A convenience: losing it
 * (a private window) only means it starts folded.
 */
const fineKey = () => `elasticpro.config.requests.fineTune.${String((state.caller && state.caller.name) || 'local').toLowerCase()}`;
function fineOpen() {
  try { return localStorage.getItem(fineKey()) === '1'; } catch (_) { return false; }
}
function rememberFine(open) {
  try { if (open) localStorage.setItem(fineKey(), '1'); else localStorage.removeItem(fineKey()); } catch (_) { /* memory only */ }
}

/** The fleet the effects are worked out for: how many clusters, and how many not answering. */
function fleetCounts() {
  const list = clusters();
  return {
    clusters: list.length,
    unreachable: list.filter((c) => healthState(state.data.get(c.id)) === 'unreachable').length,
  };
}

/**
 * Said beside the concurrency summary when ELASTICPRO_POLL_CONCURRENCY is set on the server
 * (POLICY_GET's pollConcurrencyEnv): whether it is what decides "All clusters" now, or a saved
 * policy names its own. Judged on the policy that is running, not the form.
 */
function envConcurrencyNote() {
  const env = pol && Number.isInteger(pol.pollConcurrencyEnv) ? pol.pollConcurrencyEnv : null;
  if (env === null) return null;
  const running = pol.policy && pol.policy.concurrency ? pol.policy.concurrency.global : null;
  const text = running === env
    ? `ELASTICPRO_POLL_CONCURRENCY=${env} is set on the server, and it decides All clusters (${env}), not this policy. Saving here writes the policy's own value, which then wins.`
    : `ELASTICPRO_POLL_CONCURRENCY=${env} is set on the server, but the saved policy names its own All clusters (${running}), so that is used.`;
  return h('span#pol-env.pol-env', { role: 'note' }, text);
}

/** One preset's effect, or the hand-made policy's: what it costs when nobody looks and when a page is open. */
function effectItem(name, e, { on = false, id = null } = {}) {
  return h(`div.pol-effect${on ? '.on' : ''}`, { 'data-preset': id || 'custom' },
    h('div.pol-effect-h', h('b', name), on ? h('span.pol-effect-on', 'selected') : null),
    e.why ? h('div.muted.pol-effect-why', e.why) : null,
    h('div', h('span.pol-effect-k', 'When nobody is looking: '), e.idle.text),
    h('div', h('span.pol-effect-k', 'When a page is open: '), e.open.text));
}

/** The Requests page header: the mode in force, in a pill. */
function requestsPill() {
  if (!pol || pol.error) return null;
  const p = normalisePolicy(polDraft || pol.policy, polDefaults(), polBounds());
  const stop = pol.policy && pol.policy.paused;
  const stopOn = !!(stop && stop.all && (!stop.until || stop.until > Date.now()));
  return h('span.pill.blue', `mode: ${p.mode}${stopOn ? ' · emergency stop' : ''}`);
}

function requestsActions() {
  if (!pol || pol.error) return [];
  return [h('button.btn', { type: 'button', onclick: resetPolicyForm, disabled: !isAdminCaller(),
    title: 'Fill the form with the policy this build ships with; nothing is saved until Save' }, 'Reset to shipped')];
}

function requestsCard() {
  if (!pol) return card('Requests', 'Loading…', h('div.muted', 'Asking the core for its request policy…'));
  if (pol.error) {
    return card('Requests', 'not available',
      h('div.banner.warn', { style: { margin: 0 } },
        h('div', h('div.ttl', 'This core did not report a request policy'), h('div', pol.error),
          h('div.muted', 'An older core polls on its built-in schedule; there is nothing to set here until it is updated.'))));
  }
  const defaults = polDefaults();
  const bounds = polBounds();
  const p = normalisePolicy(polDraft || pol.policy, defaults, bounds);
  const preset = activePreset(p, defaults, bounds);
  const admin = isAdminCaller();
  const num = (id, value, b, width = '90px', title = '') => h('input.cm-num', {
    id, type: 'number', min: String(b.min), max: String(b.max), value: String(value), disabled: !admin,
    style: { width }, title: title || `${b.min}–${b.max}`,
  });
  // A concurrency field under a gate cap: typed past it, it shows the cap at once, and the
  // hint under it says where the cap comes from.
  const capped = (id, value, b) => {
    const el = num(id, value, b, '100%', b.gate ? `${b.min}–${b.max}: at most what the request gate allows (${b.gate})` : '');
    el.addEventListener('change', () => {
      const n = Number(el.value);
      if (el.value.trim() !== '' && Number.isFinite(n) && n > b.max) el.value = String(b.max);
    });
    return el;
  };
  const capHint = (b, gateKey) => (pol.gate && Number.isInteger(pol.gate[gateKey])
    ? `${b.min}–${b.max} · request gate: ${pol.gate[gateKey]}${b.gate ? ` (${b.gate})` : ''}` : `${b.min}–${b.max}`);
  const labelled = (label, input, hint) => h('label.cm-lbl', h('span', label), input, hint ? h('span.cm-hint', hint) : null);
  const counts = fleetCounts();
  const mode = resolvedMode(p.mode, counts.clusters);
  const stored = pol.warning
    ? h('span', { style: { color: 'var(--warning-ink)' } }, pol.warning)
    : pol.stored ? 'Kept in policy.json in the core’s data directory.'
    : 'Not saved yet — the shipped policy is running.';

  // What each interval does under the mode in the form, for this many clusters
  // (effectiveClass, the core's rule). Under Client basis nothing is on a schedule: an
  // interval only says how often a page's data is fetched again while the page watches it.
  const ivRows = DATASETS.map((ds) => {
    const b = intervalBounds(ds);
    const bg = effectiveClass(ds, p.mode, counts.clusters) === 'background';
    const note = bg ? h('span', pill('on a schedule', 'green'), ' kept fresh for every cluster')
      : mode === 'on-demand' ? h('span.muted', 'not on a schedule: fetched when a page asks, then at this interval while it watches')
      : h('span.muted', 'fetched when a page asks, then at this interval while it watches');
    const input = num(`pol-iv-${ds}`, p.intervalsSec[ds], b, '100px', `${b.min}–${b.max} seconds`);
    input.dataset.label = `${DATASET_LABELS[ds]} every (s)`;
    return h(`tr${mode === 'on-demand' ? '.pol-iv-idle' : ''}`,
      h('td', DATASET_LABELS[ds], h('div.mono.muted', { style: { fontSize: '10.5px' } }, ds)),
      h('td', input, h('span.muted', { style: { marginLeft: '4px' } }, 's')),
      h('td.muted', { style: { fontSize: '11px' } }, `${defaults.intervalsSec ? defaults.intervalsSec[ds] : '—'} s`),
      h('td.pol-iv-note', note));
  });
  const modeName = mode === 'on-demand' ? 'Client basis' : mode === 'hybrid' ? 'Hybrid' : 'Background';

  // The presets are radio cards, each with what it sends to this fleet (lower bounds, from its
  // own intervals: policyEffect). A hand-made policy gets its own card below them.
  const presetCard = (x) => {
    const on = preset === x.id;
    const [, desc] = x.label.split(' — ');
    return h('button.pol-preset', {
      type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-pressed': String(on), disabled: !admin, title: x.label,
      onclick: () => choosePreset(x.id),
    },
    h('span.pol-preset-t', h('span.pol-preset-dot', { 'aria-hidden': 'true' }), x.name,
      x.id === 'client' ? h('span.pill.green.pol-rec', '(recommended)') : null),
    desc ? h('span.pol-preset-d', `${desc[0].toUpperCase()}${desc.slice(1)}.`) : null,
    effectItem(x.name, policyEffect(applyPreset(p, x.id, defaults, bounds), counts), { on, id: x.id }));
  };
  const effects = h('div#pol-effects.pol-effects',
    h('div.pol-presets', { role: 'radiogroup', 'aria-label': 'Request policy presets' }, ...PRESETS.map(presetCard)),
    preset ? null : effectItem('This policy (no preset)', policyEffect(p, counts), { on: true }),
    h('div.muted.pol-effects-note',
      `What each choice sends to your ${counts.clusters} cluster${counts.clusters === 1 ? '' : 's'}${counts.unreachable ? ` (${counts.unreachable} not answering now)` : ''}, `
      + 'worked out from its intervals. Lower bounds: a poll can take more than one request.'));

  // The numbers fold behind "Fine-tune", one line when folded. The line follows what is typed,
  // so a change made inside is still on it after folding.
  const summaryText = h('span#pol-fine-sum.muted', fineTuneSummary(p, counts.clusters));
  const fine = h('details#pol-fine.pol-fine.card', {
    open: fineOpen(),
    ontoggle: (e) => rememberFine(e.target.open),
    oninput: () => { summaryText.textContent = fineTuneSummary(fromForm(readPolicyForm(), defaults, bounds).policy, counts.clusters); },
    onchange: () => { summaryText.textContent = fineTuneSummary(fromForm(readPolicyForm(), defaults, bounds).policy, counts.clusters); },
  },
    h('summary', h('b', 'Fine-tune'), summaryText, envConcurrencyNote()),
    h('div.pol-fine-body',
      h('div.cm-form5',
        labelled('Watch window (minutes)', num('pol-watch', p.watchMinutes, BOUNDS.watchMinutes, '100%'),
          `${BOUNDS.watchMinutes.min}–${BOUNDS.watchMinutes.max} · how long a page keeps an on-demand dataset fresh after it was last looked at`),
        labelled('Concurrency — all clusters', capped('pol-global', p.concurrency.global, bounds.global), capHint(bounds.global, 'global')),
        labelled('Per cluster', capped('pol-per', p.concurrency.perCluster, bounds.perCluster), capHint(bounds.perCluster, 'perCluster')),
        labelled('Per jump host', capped('pol-tunnel', p.concurrency.tunnel, bounds.tunnel), capHint(bounds.tunnel, 'perJump')),
        labelled('Timeout (ms)', num('pol-timeout', p.timeoutMs, BOUNDS.timeoutMs, '100%'), `${BOUNDS.timeoutMs.min}–${BOUNDS.timeoutMs.max}`)),
      table(['Dataset', 'Every', 'Shipped', `Under ${modeName}`], ivRows)));

  const stop = pol.policy && pol.policy.paused;
  const stopOn = !!(stop && stop.all && (!stop.until || stop.until > Date.now()));
  return h('div.cm-stack', { dataset: { track: 'policy', trackLabel: 'Requests' } },
    !admin ? h('div.muted', { style: { fontSize: '12px' } }, 'Read-only — an administrator changes the request policy.') : null,
    effects,
    h('div.pol-mode-row',
      labelled('Mode', h('select#pol-mode', {
        disabled: !admin, style: { maxWidth: '220px' },
        // The mode changes the effects, the summary and what each interval does: redraw
        // from the form as it stands, so nothing typed is lost.
        onchange: () => { polDraft = fromForm(readPolicyForm(), defaults, bounds).policy; draw(); },
      }, ...MODES.map((m) => h('option', { value: m, selected: m === p.mode }, m)))),
      h('div#pol-mode-desc.muted', { style: { fontSize: '11.5px' } }, describeMode(p.mode),
        p.mode === 'auto' && pol.resolvedMode ? h('b', ` Running now: ${pol.resolvedMode}.`) : null)),
    fine,
    h('div.cm-grid2.cm-grid2-r',
      h('div.card.cm-sec', h('div.body', gapSection(p, admin, defaults))),
      h('div.card.cm-sec', h('div.body', playScheduleSection(p, admin, defaults)))),
    h('div.muted#pol-auto', { style: { fontSize: '12px', lineHeight: 1.6 } },
      stopOn ? h('div', h('b', pausedLine(stop))) : null,
      'Slow and busy clusters are handled on their own: a cluster that answers in more than 8 s (or times out, or '
      + 'answers 429) gets one request at a time and longer intervals until it answers quickly again, and while the '
      + 'server is busy the background polling waits so people go first. Nobody waits more than 10 s for a page. '
      + 'To hold everything for a while, use the emergency stop in ',
      h('button.btn.sm.ghost', { onclick: () => openTab('requests', 'centre') }, 'Request Centre'),
      ' — it ends by itself after 15, 30 or 60 minutes. ', stored,
      pol.running === false ? ' The poller is not running on this core.' : ''),
    polNote ? h(`div.${polNote.cls.split(' ').join('.')}#pol-msg`, { style: { margin: 0, fontSize: '12px' } }, polNote.text) : null);
}

/* ------------------------------ the sections ------------------------------ */

function fileCard() {
  const meta = (state.config && state.config.fileMeta) || {};
  const plain = clusters().some((c) => c.credSource === 'shared' || c.credSource === 'cluster');
  return card('Config file', meta.name || 'not loaded',
    h('div', { style: { display: 'grid', gap: '10px' } },
      table([], [
        kvRow('File', meta.name || '–'),
        kvRow('Path', meta.path || (meta.ephemeral ? 'loaded once — not remembered' : '–')),
        kvRow('Format', state.config ? (state.config.format === 'json' ? 'JSON (config_cluster.json)' : 'YAML — edits from the UI are saved as config_cluster.json next to it') : '–'),
        kvRow('Size', meta.size ? bytes(meta.size) : '–'),
        kvRow('Last modified on disk', meta.lastModified ? dt(meta.lastModified) : '–'),
        kvRow('Loaded', state.config ? `${dt(state.config.loadedAt)} (${ago(state.config.loadedAt)})` : '–'),
        kvRow('Secrets in file', !state.config ? '–'
          : state.config.sealed ? h('span', pill('encrypted', 'green'), h('span.muted', ' AES-256-GCM, PBKDF2-SHA512 master password'))
          : plain ? h('span', pill('PLAIN TEXT', 'red'), h('span.muted', ' use "Store in config file (encrypted)" on Clusters › Credentials to fix'))
          : 'none'),
        kvRow('Mode', isSnapshotMode()
          ? `snapshot — collected ${state.snapshot && state.snapshot.generatedAt ? dt(state.snapshot.generatedAt) : '?'}`
            + (state.snapshot && state.snapshot.host ? ` on ${state.snapshot.host}` : '')
          : 'live — the app connects to each cluster (directly or through a jump host)'),
      ]),
      h('div#cfg-msg')));
}

/**
 * Earlier versions of the config file, newest first. "By" and "What changed" are columns only
 * when the core reports them for a version (PHASE 2 HOOK: today it keeps time, file and size).
 */
let versionsAll = false;
function versionsCard() {
  // Fetched lazily: it is one more round trip and most visits to this page are not looking for it.
  if (!versions.length && !current && !historyOpen) loadHistory().then(() => { historyOpen = true; });
  return card('Earlier versions', 'one is kept each time the config is saved from here · loading one first keeps the current as a version',
    h('div#cfg-history', historyBody()));
}

function historyBody() {
  if (!versions.length && !current) {
    return h('div.muted', { style: { fontSize: '12px' } },
      'No earlier versions yet. One is kept each time the config is saved from here.');
  }
  const list = versionsAll ? versions : versions.slice(0, 8);
  // Recorded by the core when the version was saved (CONFIG_HISTORY saved_by / summary,
  // docs/HANDBOOK.md "Config versions"); a version from before the record existed shows "—",
  // not a guess. `current` is the file on disk now, when the core recorded its last save.
  const when = (t) => h('td', { title: new Date(t * 1000).toISOString() }, `${dt(t * 1000)} (${ago(t * 1000)})`);
  const what = (s) => h('td', { style: { fontSize: '11.5px' }, title: s || '' }, s || '—');
  const rows = [
    current ? h('tr.cm-current',
      h('td', { title: new Date(current.saved_at * 1000).toISOString() }, `${dt(current.saved_at * 1000)} (${ago(current.saved_at * 1000)}) `, pill('current', 'blue')),
      h('td', current.saved_by || '—'), what(current.summary),
      h('td.mono', { style: { fontSize: '11.5px' } }, current.source || ''), h('td.num', ''), h('td')) : null,
    ...list.map((v) => h('tr',
      when(v.saved_at),
      h('td', v.saved_by || '—'),
      what(v.summary),
      h('td.mono', { style: { fontSize: '11.5px' } }, v.source),
      h('td.num', bytes(v.bytes)),
      h('td', { style: { textAlign: 'right' } },
        h('button.btn.sm', { onclick: () => restore(v) }, 'Load this')))),
  ].filter(Boolean);
  return h('div', { style: { display: 'grid', gap: '6px' } },
    table(['Saved', 'By', 'What changed', 'File', { label: 'Size', num: true }, ''], rows, {
      // A good empty state — nothing has gone wrong — so it says what would put something here.
      emptyText: empty('No earlier version saved yet.', {
        detail: 'A copy is kept automatically each time the config is saved from this app.',
      }),
    }),
    h('div.muted', { style: { fontSize: '11.5px', display: 'flex', gap: '8px', alignItems: 'center' } },
      'Loading an older version does not discard the current one — that is saved as a version first, so this goes both ways.',
      versions.length > 8 ? h('button.btn.sm.ghost', { style: { marginLeft: 'auto' }, onclick: () => { versionsAll = !versionsAll; const el = $('#cfg-history'); if (el) mount(el, historyBody()); } },
        versionsAll ? 'Show fewer' : `Show all ${versions.length}`) : null));
}
/**
 * Hosted, no default yet, but the server keeps a credential it could become (0.3.46): one a
 * cluster was given, or one Zabbix handed over. Making it the default types nothing — the
 * server copies it — and every cluster without its own, a new one above all, then signs in
 * with it instead of asking for a password.
 */
function promoteChoice(st) {
  const list = (st && !st.default && st.promotable) || [];
  if (!list.length) return '';
  const pick = list.length > 1
    ? h('select#kc-promote-from', { 'aria-label': 'Credential to use as the default' },
        ...list.map((p) => h('option', { value: p.id }, promotableLabel(p))))
    : null;
  const btn = h('button.btn.sm.primary#kc-promote', { onclick: async () => {
    const from = pick ? pick.value : list[0].id;
    btn.disabled = true;
    try {
      const r = await promoteCredential(from);
      await reprime();
      refreshAll({ force: true });
      toast(`Default credential set from ${(list.find((p) => p.id === from) || {}).cluster || from} (user ${r.user || 'API key or token'}). Every cluster without its own signs in with it.`, 'ok', 6000);
      draw();
    } catch (e) { btn.disabled = false; toast(`The default was not set: ${e.message}`, 'err', 8000); }
  } }, list.length > 1 ? 'Use it as the default' : `Use ${promotableLabel(list[0])} as the default for every cluster without its own`);
  return h('div.kc-promote', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
    h('span', h('b', 'No default credential. '), list.length > 1 ? 'The server keeps these; one can be the default without typing it again:' : ''),
    pick, btn);
}

/**
 * Hosted: what the server keeps — the default every cluster without its own uses, and which
 * clusters have their own. Typed once each; nobody is asked on a page load or after a restart.
 */
function keptCredentialsCard() {
  const needing = clustersNeedingCredential().length;
  const box = h('div#kept-cred', { style: { fontSize: '12.5px', lineHeight: '1.65', display: 'grid', gap: '6px' } }, h('div.muted', 'Loading…'));
  keptCredentials().then((st) => {
    const names = new Map(clusters().map((c) => [c.id, c.name]));
    const own = st.clusters.filter((c) => names.has(c.id));
    const rejected = rejectedDefault(clusters(), (id) => { const cl = client(id); return cl && cl.state; }, st);
    box.replaceChildren(
      st.problem ? h('div', { style: { color: 'var(--critical-ink)' } }, h('b', 'The server cannot keep credentials: '), st.problem) : '',
      h('div', h('b', 'Default: '), st.default ? keptLine(st.default) : h('span', { style: { color: 'var(--critical-ink)' } }, 'none set — clusters without their own cannot sign in')),
      promoteChoice(st),
      h('div', h('b', 'Own credential: '), own.length ? own.map((c) => `${names.get(c.id)} (${keptLine(c)})`).join(' · ') : 'no cluster — all use the default'),
      ...rejected.map((c) => h('div.kc-rejected', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { style: { color: 'var(--critical-ink)' } }, `The default credential was rejected by ${c.name}.`),
        c.source === 'zabbix'
          // Its own credential can be set here too (kept on the server, for this address); Zabbix's
          // is used while none is. Or in Zabbix, as before.
          ? [h('button.btn.sm', { onclick: async () => { if (await editZabbixCluster(c)) draw(); } }, 'Set its own credential…'),
             h('span.muted', 'or in Zabbix: Cluster Management → the client’s page → Change password.')]
          : h('button.btn.sm', { onclick: async () => { if (await editCluster(rawClusterOf(c))) draw(); } }, 'Set its own credential…'))),
      needing ? h('div', { style: { color: 'var(--critical-ink)' } }, `${needing} cluster(s) have no credential the server can use.`) : '');
  });
  return card('Credentials', 'kept encrypted on the server',
    h('div', { style: { display: 'grid', gap: '11px' } },
      box,
      h('div', { style: { fontSize: '12px', lineHeight: '1.6', display: 'grid', gap: '6px' } },
        h('div', h('b', 'Typed once. '), 'The default here, a cluster’s own in its Edit dialog — when it is added or its credential changes. Nobody is asked again: not on a page load, not after a restart, not other users.'),
        h('div', h('b', 'Encrypted. '), 'AES-256-GCM under the server’s own key (ELASTICPRO_CLUSTER_SECRET_KEY_FILE), never in the config file, never sent back to a browser.'),
        h('div', h('b', 'From a config file. '), 'A credential still in the file — plain, or sealed with a master password and unlocked once — is moved to the server the first time it is used.'))),
    [
      h('button.btn.sm.primary', { onclick: async () => { if (await editCredentials()) draw(); } }, 'Set default credential…'),
      state.config && state.config.sealed && needing
        ? h('button.btn.sm', { onclick: async () => { if (await unlockSealed()) { await refreshAll({ force: true }); draw(); } }, title: 'Once: the credentials are then kept on the server' }, 'Unlock the file’s credentials once…')
        : null,
    ].filter(Boolean));
}

function credentialsCard() {
  if (credentialsKeptOnServer()) return keptCredentialsCard();
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

/** What the Clusters tab is filtered to; kept across redraws. */
const clView = { q: '', show: 'all', source: 'any' };

/** Where a cluster comes from, in the words of the Source column. */
const sourceOf = (c) => (c.source === 'zabbix' ? 'Zabbix' : 'Config file');

/** The Credential column's pill for a cluster. */
function credentialPill(c) {
  if (c.source === 'zabbix') {
    if (c.zabbix && c.zabbix.ownCredential) return pill('own · set in ElasticPro', 'green');
    return pill(c.zabbix && c.zabbix.credential === 'vault' ? 'Zabbix · Vault' : 'Zabbix macro', c.zabbix && c.zabbix.credentialOk ? 'green' : 'red');
  }
  return c.credSource === 'shared' ? pill('shared (from file)', 'green')
    : c.credSource === 'cluster' ? pill('per-cluster override', 'yellow')
    : c.credSource === 'session' ? pill('typed this session', 'green')
    : c.anonymous ? pill('anonymous', 'grey') : pill('missing', 'red');
}

/** online · sign-in problem · not answering · unknown, from the cluster's live state. */
function connectionKind(cl) {
  if (!cl || cl.state === 'unknown') return 'unknown';
  if (cl.state === 'online') return 'online';
  return cl.state === 'auth_error' ? 'auth' : 'down';
}

function clustersActions() {
  return [
    h('button.btn', { type: 'button', onclick: exportClusters, title: 'The cluster list as a CSV file: name, source, address, route, credential, connection' }, 'Export list'),
    h('button.btn.primary', { type: 'button', onclick: async () => { if (await editCluster(null)) { draw(); loadTrust(); } } }, '+ Add cluster'),
  ];
}

/** The list as it is on screen (every cluster, the filter aside), as CSV. No secret is in it. */
function exportClusters() {
  const all = [...clusters().map((c) => ({ c, on: true })), ...disabledClusters().map((c) => ({ c, on: false }))];
  const rows = all.map(({ c, on }) => {
    const cl = on ? client(c.id) : null;
    return {
      name: c.name, source: sourceOf(c), address: c.url, route: c.via || 'direct', tags: (c.tags || []).join(' '),
      credential: on ? credentialPill(c).textContent : '', user: c.username || '', logIndexPattern: c.logIndexPattern || '',
      connection: on ? (cl ? cl.state : 'unknown') : 'disabled', lastSuccess: cl && cl.lastOkAt ? new Date(cl.lastOkAt).toISOString() : '',
    };
  });
  download(`elasticpro-clusters-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv');
}

const disabledClusters = () => ((state.config && state.config.clusters) || []).filter((c) => !c.enabled);

function clustersCard() {
  const list = clusters();
  const off = disabledClusters();
  const kinds = list.map((c) => connectionKind(client(c.id)));
  const n = (k) => kinds.filter((x) => x === k).length;
  const fromZabbix = list.filter((c) => c.source === 'zabbix').length;
  const problems = n('auth') + n('down');

  // A Zabbix cluster is edited here too: kept in ElasticPro as an overlay, the address always Zabbix's.
  const editBtn = (c) => (c.source === 'zabbix'
    ? h('button.btn.sm', { disabled: !roleMayManageClusters(), dataset: { zbxEdit: c.id },
        title: `From Zabbix (host ${c.zabbix ? c.zabbix.host : ''}): the address stays Zabbix's; the rest is kept in ElasticPro`,
        onclick: async () => { if (await editZabbixCluster(c)) { draw(); loadTrust(); } } }, 'Edit')
    : h('button.btn.sm', { onclick: async () => { if (await editCluster(rawClusterOf(c))) { draw(); loadTrust(); } } }, 'Edit'));
  const editedHere = (c) => (c.source === 'zabbix' && c.zabbix && (c.zabbix.overridden || []).length
    ? h('span.cm-tag', { title: `Set in ElasticPro: ${c.zabbix.overridden.join(', ')}${c.zabbix.overriddenBy ? ` (by ${c.zabbix.overriddenBy})` : ''}` }, 'edited here') : null);
  const clusterRows = list.map((c) => {
    const cl = client(c.id);
    const zabbixOwned = c.source === 'zabbix';
    return h('tr', { dataset: { cl: c.id, source: zabbixOwned ? 'zabbix' : 'file', kind: connectionKind(cl) } },
      h('td', h('b', c.name), ...(c.tags || []).map((t) => h('span.cm-tag', t)), editedHere(c)),
      h('td', pill(sourceOf(c), zabbixOwned ? 'blue' : 'grey')),
      h('td.mono', c.url),
      h('td', c.via ? h('span.mono', c.via) : h('span.muted', 'direct')),
      h('td', credentialPill(c), c.username ? h('span.muted.mono', { style: { marginLeft: '6px', fontSize: '11px' } }, c.username) : null),
      h('td.mono.muted', { style: { fontSize: '11.5px' } }, c.logIndexPattern || '–'),
      h('td', { 'data-cluster-state': c.id, 'data-kind': 'clusters' }, clusterStatePill(cl, 'clusters')),
      h('td.muted', cl && cl.lastOkAt ? ago(cl.lastOkAt) : '–'),
      h('td', editBtn(c)));
  });
  // Disabled clusters are not in clusters(); listed too so they can be enabled again.
  const disabledRows = off.map((c) => h('tr.cm-off', { dataset: { cl: c.id || c.name, source: c.source === 'zabbix' ? 'zabbix' : 'file', kind: 'disabled' } },
    h('td', h('b', c.name), editedHere(c)),
    h('td', pill(sourceOf(c), 'grey')),
    h('td.mono', c.url),
    h('td', c.via ? h('span.mono', c.via) : h('span.muted', 'direct')),
    h('td', { colspan: 4 }, pill('disabled · not polled', 'grey')),
    h('td', editBtn(c))));

  const tbl = table(['Cluster', 'Source', 'Address', 'Route', 'Credential', 'Log indices', 'Connection', 'Last success', ''],
    [...clusterRows, ...disabledRows], { emptyText: 'No clusters yet — add one.' });
  const count = h('span.cm-toolbar-note');
  const apply = () => {
    const q = clView.q.trim().toLowerCase();
    let shown = 0; const rows = tbl.querySelectorAll('tr[data-cl]');
    for (const tr of rows) {
      const k = tr.dataset.kind;
      const want = clView.show === 'all' ? true : clView.show === 'disabled' ? k === 'disabled' : (k === 'auth' || k === 'down');
      const src = clView.source === 'any' || tr.dataset.source === clView.source;
      const hit = !q || tr.textContent.toLowerCase().includes(q);
      tr.hidden = !(want && src && hit);
      if (!tr.hidden) shown++;
    }
    count.textContent = `Showing ${shown} of ${rows.length}`;
  };
  const seg = (id, label) => h('button', { type: 'button', 'aria-pressed': String(clView.show === id),
    onclick: (e) => { clView.show = id; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); apply(); } }, label);
  apply();

  const kpi = (value, text, tone) => h('div.cm-kpi', h('b', { class: tone ? `t-${tone}` : '' }, String(value)), h('span', text));
  return h('div.cm-stack',
    h('div.cm-kpis',
      kpi(list.length, `clusters · ${fromZabbix} from Zabbix, ${list.length - fromZabbix} from the file`),
      kpi(n('online'), 'online', 'ok'),
      kpi(n('auth'), 'sign-in problems', n('auth') ? 'warn' : ''),
      kpi(n('down'), 'not answering', n('down') ? 'bad' : ''),
      kpi(off.length, 'disabled · listed, not polled', 'off')),
    h('section.card.cm-card',
      h('div.cm-toolbar',
        h('input', { type: 'search', placeholder: 'Filter by name, address or tag', 'aria-label': 'Filter clusters', value: clView.q,
          oninput: (e) => { clView.q = e.target.value; apply(); } }),
        h('div.cm-seg', { role: 'group', 'aria-label': 'Show' },
          seg('all', `All ${list.length + off.length}`), seg('problems', `Problems ${problems}`), seg('disabled', `Disabled ${off.length}`)),
        h('label.cm-inline', 'Source ', h('select', { 'aria-label': 'Source', onchange: (e) => { clView.source = e.target.value; apply(); } },
          ...[['any', 'Any'], ['zabbix', 'Zabbix'], ['file', 'Config file']].map(([v, l]) => h('option', { value: v, selected: clView.source === v }, l)))),
        count),
      tbl,
      h('div.cm-foot', 'Clusters from Zabbix: the address is always Zabbix’s; anything else changed here is kept in ElasticPro and wins over Zabbix (Zabbix is not changed). Sync settings are under ',
        h('button.btn.sm.ghost', { type: 'button', onclick: () => openTab('zabbix', 'zabbix') }, 'Zabbix'), '.')));
}
/* ---------------------------------- Zabbix ---------------------------------- */

let zbx = null;          // the last ZABBIX_CLUSTERS answer
let zbxBusy = false;

async function loadZabbix() {
  await Promise.all([cfg.loadZabbixClusters().then((z) => { zbx = z; }), loadLink(),
    isAdminCaller() ? loadZabbixRoles() : null]);
  if (isOpen('zabbix/zabbix')) { tracker.reset('zabbix-link'); tracker.reset('zabbix-opts'); draw(); }
}

/**
 * Zabbix, as the board draws it: the connection and the sync options side by side, then the
 * cluster hosts. "Roles from Zabbix user groups" and "Zabbix users" sit between them, and
 * are drawn only when the core knows the group map (zabbixRolesSupported()).
 */
function zabbixSection() {
  return h('div.cm-stack',
    h('div.cm-grid2', zabbixLinkCard(), zabbixOptionsCard()),
    // Hosts at the address of a cluster that exists already, held until an administrator decides.
    isAdminCaller() ? zabbixReviewCard(zbx, { onDecided: afterZabbixDecision }) : null,
    isAdminCaller() ? zabbixRolesCards(() => draw()) : null,
    zabbixCard());
}

/** The Zabbix page header: connected or not, and when it last synced. */
function zabbixPill() {
  if (!link || link.hidden || !link.supported) {
    if (zbx && zbx.configured) return pill(`Connected${zbx.lastSync ? ` · synced ${ago(zbx.lastSync * 1000)}` : ''}`, zbx.error ? 'red' : 'green');
    return null;
  }
  const sum = linkSummary(link);
  const sync = link.sync || {};
  return pill(`${sum.title}${sync.lastOk ? ` · synced ${ago(sync.lastOk * 1000)}` : ''}`, sum.tone);
}

function zabbixActions() {
  const admin = !!link && !link.hidden && !!link.supported;
  const summary = admin && linkView(link) === 'summary' && !linkEditing;
  return [
    admin ? h('button.btn', { type: 'button', onclick: testLink, disabled: linkBusy }, 'Test connection') : null,
    zbx && zbx.configured && isAdminCaller() ? h('button.btn', { type: 'button', onclick: previewZabbix, disabled: zbxBusy || linkBusy,
      title: 'What a sync would add, change or hold for review — nothing is applied' }, 'Preview sync') : null,
    zbx && zbx.configured ? h('button.btn', { type: 'button', onclick: syncZabbix, disabled: zbxBusy || linkBusy }, zbxBusy ? 'Syncing…' : '↻ Sync now') : null,
    summary ? h('button.btn.primary', { type: 'button', onclick: () => { linkEditing = true; draw(); }, disabled: linkBusy }, 'Edit connection') : null,
  ];
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
    return false;
  }
  const changes = linkChanges(link, form);
  if (!Object.keys(changes).length) { toast('Nothing to save — no field changed', 'ok', 3000, { key: 'zabbix-link' }); return true; }
  linkBusy = true; draw();
  let res;
  try { res = await zabbixLinkSet(changes); } catch (e) { res = { ok: false, message: e.message || String(e) }; }
  linkBusy = false;
  if (!res.ok) {
    toast(`Zabbix connection not saved: ${res.message}`, 'err', 10000, { key: 'zabbix-link' });
    draw();
    return false;
  }
  link = res; tokenReplace = false; linkEditing = false;
  toast(`Zabbix connection saved: ${(res.changed || []).map((k) => LINK_LABEL[k] || k).join(', ') || 'no change'}`, 'ok', 5000, { key: 'zabbix-link' });
  draw();
  // A new address or token changes which clusters exist; show it now rather than at the
  // next timer tick.
  if ((res.changed || []).some((k) => ['zabbixUrl', 'apiUrl', 'apiToken', 'verifyTls'].includes(k)) && res.sync && res.sync.configured) {
    await syncZabbix();
  }
  return true;
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
  const row = (k, v, mono) => h('div', { style: { display: 'grid', gridTemplateColumns: '90px minmax(0, 1fr)', gap: '8px', fontSize: '12px' } },
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
  if (!link) return card('Connection', 'Loading…', h('div.muted', 'Loading…'));
  if (link.hidden || (!link.supported && !link.error)) return null;
  if (!link.supported) return card('Connection', 'unavailable', h('div.banner.err', { style: { margin: 0 } }, link.error));
  if (linkView(link) === 'summary' && !linkEditing) return zabbixLinkSummaryCard(link);
  return zabbixLinkFormCard(link, linkView(link) === 'summary');
}


/**
 * "Connection": read-only, once something is connected. Test, Sync and Edit are in the page
 * header; Re-pair and Unpair stay here, Unpair last and in red.
 */
function zabbixLinkSummaryCard(s) {
  const sum = linkSummary(s);
  const ro = (f) => isManaged(s, f);
  // config.txt says so by name; anything else the server sets (a compose variable) does not.
  const managedNote = (f) => (s.managedBy && s.managedBy[f] === 'config.txt' ? MANAGED_NOTE : 'managed by server config');
  const tok = s.apiToken || {};
  const sync = s.sync || {};
  const syncText = sync.error ? h('span', pill('failed', 'red'), ` ${sync.error}`)
    : sync.lastOk ? h('span', pill('ok', 'green'), h('span.muted', ` ${ago(sync.lastOk * 1000)} · ${sync.clusters || 0} cluster${sync.clusters === 1 ? '' : 's'}${sync.skipped ? `, ${sync.skipped} hosts skipped` : ''}`))
      : h('span.muted', sync.configured ? 'not synced yet' : 'not syncing yet');
  const serverSecret = s.ssoSecret && s.ssoSecret.source === 'server';
  const canUnpair = s.paired || (tok.set && tok.source === 'ui') || (s.ssoSecret && s.ssoSecret.source === 'ui');
  const lockOf = (f) => (f && ro(f) ? h('span.cm-lockline', lockMark(managedNote(f)), managedNote(f)) : null);
  const row = (label, value, f) => [h('dt', label), h('dd', value, lockOf(f))];
  return h('section.card.cm-card',
    h('header', h('h2', 'Connection'),
      h('span.sub', s.pairedAt ? `paired ${dt(s.pairedAt * 1000)}${s.pairedBy ? ` by ${s.pairedBy}` : ''}` : sum.title)),
    h('dl.cm-kv',
      ...row('Zabbix URL', h('span.mono', s.zabbixUrl || '–'), 'zabbixUrl'),
      ...row('API URL', s.apiUrlIsDefault ? h('span', h('span.mono', defaultApiUrl(s.zabbixUrl) || '–'), h('span.muted', ' (default)')) : h('span.mono', s.apiUrl || '–'), 'apiUrl'),
      ...row('API token', ro('apiToken') ? 'set' : tok.set
        ? h('span', pill('set', 'green'), h('span.muted', ` added ${tok.at ? dt(tok.at * 1000) : '–'}${tok.by ? ` by ${tok.by}` : ''} · write-only`))
        : pill('not set', 'grey'), 'apiToken'),
      ...row('Verify TLS', s.verifyTls !== false ? 'yes' : 'no', 'verifyTls'),
      ...row('Allowed sources', (s.allowedSources || []).length ? h('span.mono', (s.allowedSources || []).join(', ')) : 'any', 'allowedSources'),
      ...row('Sync interval', `${s.syncSecs || '–'} s`, 'syncSecs'),
      ...(s.zabbixVersion ? row('Zabbix version', s.zabbixVersion) : []),
      ...row('Sign-in from Zabbix', h('span', s.signIn ? 'on' : 'off', serverSecret ? h('span.muted', ' · secret from server config') : null,
        h('span.muted', ` · may frame this app: ${s.frameAncestors}`))),
      ...row('Last sync', syncText)),
    s.allowHttp ? h('div.banner.warn', { style: { margin: '0 14px 10px' } }, 'Plain http is allowed: the API token crosses the network unencrypted. Lab only.') : null,
    h('div.cm-foot',
      h('button.btn.sm', { onclick: pairLink, disabled: linkBusy || serverSecret,
        title: serverSecret ? 'The sign-in secret is set in the server configuration; pairing from here is off.' : 'Show a one-time code to paste into Zabbix' },
      'Re-pair…'),
      h('button.btn.sm.danger', { onclick: unpairLink, disabled: linkBusy || !canUnpair }, 'Unpair'),
      h('span.cm-foot-note', 'Fields set in config.txt show a lock and cannot be edited here.')));
}

/** The setup form (not configured yet), or the same form reached via "Edit settings". */
function zabbixLinkFormCard(s, canCancel) {
  const sum = linkSummary(s);
  const ro = (f) => isManaged(s, f);
  // config.txt says so by name; anything else the server sets (a compose variable) does not.
  const managedNote = (f) => (s.managedBy && s.managedBy[f] === 'config.txt' ? MANAGED_NOTE : 'managed by server config');
  const disable = (el, f) => { if (ro(f) || linkBusy) el.disabled = true; return el; };
  const hint = (f, text) => (ro(f) ? h('span.cm-lockline', lockMark(managedNote(f)), managedNote(f)) : text);
  const zurl = disable(text('zl-zurl', s.zabbixUrl || '', { placeholder: 'https://zabbix.example.com', mono: true }), 'zabbixUrl');
  const api = disable(text('zl-api', s.apiUrlIsDefault ? '' : (s.apiUrl || ''), { placeholder: defaultApiUrl(s.zabbixUrl) || 'https://zabbix.example.com/api_jsonrpc.php', mono: true }), 'apiUrl');
  // The API URL follows the Zabbix URL until somebody types one of their own.
  zurl.addEventListener('input', () => { api.placeholder = defaultApiUrl(zurl.value) || 'https://zabbix.example.com/api_jsonrpc.php'; });
  const tok = s.apiToken || {};
  let tokenField;
  if (ro('apiToken')) tokenField = h('div.muted', { style: { fontSize: '12.5px' } }, `set · ${managedNote('apiToken')}`);
  else if (tok.set && !tokenReplace) {
    tokenField = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12.5px' } },
      pill('set', 'green'), h('span.muted', `added ${tok.at ? dt(tok.at * 1000) : '–'}${tok.by ? ` by ${tok.by}` : ''}`),
      h('button.btn.sm', { disabled: linkBusy, onclick: () => { tokenReplace = true; draw(); } }, 'Replace…'));
  } else {
    tokenField = text('zl-token', '', { type: 'password', mono: true, placeholder: tok.set ? 'new token — replaces the stored one' : 'paste a Zabbix API token, or pair' });
  }
  const tls = checkbox('zl-tls', 'Verify the Zabbix TLS certificate', s.verifyTls !== false,
    ro('verifyTls') ? managedNote('verifyTls') : 'Off only for a lab. On: the OS trust store, or a certificate you trust from Test connection.');
  if (ro('verifyTls') || linkBusy) tls.querySelector('input').disabled = true;
  const http = checkbox('zl-http', 'Allow plain http (lab only)', !!s.allowHttp, 'The API token would cross the network unencrypted.');
  const src = h('textarea#zl-src.mono', { rows: 2, spellcheck: false, disabled: ro('allowedSources') || linkBusy,
    placeholder: 'empty = any source (the signature still decides)', style: { width: '100%', fontSize: '12px' } });
  src.value = (s.allowedSources || []).join('\n');
  const sync = disable(text('zl-sync', String(s.syncSecs || ''), { mono: true, style: { width: '110px' } }), 'syncSecs');
  const serverSecret = s.ssoSecret && s.ssoSecret.source === 'server';
  const cancel = () => { linkEditing = false; tokenReplace = false; draw(); };
  return trackedCard('zabbix-link', 'Zabbix connection', 'Connection', canCancel ? 'edit settings · changes wait for the save bar' : sum.title,
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
      h('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap' } }, tls, http)),
    [
      linkBusy ? h('span.muted', 'Saving…') : null,
      h('button.btn.sm', { onclick: pairLink, disabled: linkBusy || serverSecret,
        title: serverSecret ? 'The sign-in secret is set in the server configuration; pairing from here is off.' : 'Show a one-time code to paste into Zabbix' },
      s.paired ? 'Pair again…' : 'Pair with Zabbix…'),
      canCancel ? h('button.btn.sm', { onclick: cancel, disabled: linkBusy }, 'Cancel')
        : h('button.btn.sm.danger', { onclick: unpairLink, disabled: linkBusy || !(s.paired || (tok.set && tok.source === 'ui') || (s.ssoSecret && s.ssoSecret.source === 'ui')) }, 'Unpair'),
    ]);
}

/** The two sync options, as config.txt and the file have them (config.txt last: it wins). */
const zabbixOptionsNow = () => ({ ...((state.config && state.config.raw && state.config.raw.zabbix) || {}), ...managedZabbixOptions() });
const ZABBIX_OPTIONS = ['useElasticProCredentials', 'createHosts'];

/**
 * The save bar's Save for the sync options: saved to the config file — where the core reads
 * them at every sync, so the file stays the one place they are decided — then applied with a
 * sync straight away. A switch config.txt manages is drawn locked and never written.
 */
async function saveZabbixOptions() {
  const r = state.config && state.config.raw;
  if (!r) { toast('No config loaded', 'warn'); return false; }
  const now = zabbixOptionsNow();
  const changed = {};
  for (const key of ZABBIX_OPTIONS) {
    const el = host && host.querySelector(`#zo-${key}`);
    if (!el || el.disabled || isManagedZabbixOption(key)) continue;
    if (!!el.checked !== !!now[key]) changed[key] = !!el.checked;
  }
  if (!Object.keys(changed).length) return true;
  const before = r.zabbix;
  r.zabbix = { ...(r.zabbix || {}), ...changed };
  try {
    await saveRaw({ silent: true });
  } catch (e) {
    r.zabbix = before;
    toast(`Could not save the config: ${e.message}`, 'err', 8000, { key: 'zabbix-option' });
    return false;
  }
  toast(Object.entries(changed).map(([k, on]) => `${k === 'createHosts' ? 'Creating Zabbix hosts' : 'ElasticPro credentials for Zabbix clusters'}: ${on ? 'on' : 'off'}`).join(' · '),
    'ok', 4000, { key: 'zabbix-option' });
  await syncZabbix();
  return true;
}
/** "Read: <template> (N hosts), …" — what the last sync searched, from its reply. */
function templatesRead(templates) {
  const t = (templates || []).filter((x) => x && x.name);
  if (!t.length) return '';
  return `Read: ${t.map((x) => `${x.name} (${x.hosts} host${x.hosts === 1 ? '' : 's'})`).join(', ')}`;
}

async function previewZabbix() {
  zbxBusy = true; draw();
  try { await previewSync(); } finally { zbxBusy = false; draw(); }
}

/** A decision on a held host was kept: the cluster list every page uses follows at once. */
async function afterZabbixDecision() {
  await setConfig(state.config, state.handle);
  await refreshAll({ force: true });
  await loadZabbix();
  draw();
}

async function syncZabbix() {
  zbxBusy = true; draw();
  try {
    const res = await bridge({ type: 'ZABBIX_SYNC' });
    if (!res.ok) toast(`Zabbix sync failed: ${res.message}`, 'err', 8000, { key: 'zabbix-sync' });
    else {
      // One line: how many, how many left out, and where the list is. Naming every host
      // here ran to a screen of text nobody read; the Zabbix section below names them.
      const skipped = res.skipped || [];
      toast(`Zabbix sync: ${res.clusters} cluster${res.clusters === 1 ? '' : 's'}${skipped.length ? ` \u00b7 ${skipped.length} left out` : ''}`,
        res.clusters || !skipped.length ? 'ok' : 'warn', skipped.length || !res.clusters ? 8000 : 4000,
        { key: 'zabbix-sync', detail: skipped.length || !res.clusters ? ['Config-Management \u203a Zabbix lists which hosts and why.'] : [] });
    }
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
 * "Sync options": the two switches (they wait for the save bar), then what the last sync
 * decided — recent changes, hosts not counted, config-file clusters set aside — folded.
 */
function zabbixOptionsCard() {
  if (!zbx) return card('Sync options', 'Loading…', h('div.muted', 'Loading…'));
  if (!zbx.configured) return null;
  const zopt = zabbixOptionsNow();
  const opt = (key, label, help, disabledWhy) => {
    const lockedOpt = isManagedZabbixOption(key);
    return h('label.cm-opt', { title: lockedOpt ? MANAGED_NOTE : (disabledWhy || '') },
      h('input.sw', { id: `zo-${key}`, type: 'checkbox', role: 'switch', checked: !!zopt[key], 'data-label': label,
        disabled: zbxBusy || !!disabledWhy || lockedOpt || !(state.config && state.config.raw) }),
      h('span', h('b', label), h('span.cm-opt-help', help),
        lockedOpt ? h('span.cm-lockline', lockMark(), MANAGED_NOTE) : disabledWhy ? h('span.cm-opt-why', disabledWhy) : null));
  };
  const fold = (title, count, items) => (items.length
    ? h('details.cm-fold', h('summary', h('b', title), h('span.muted', ` · ${count}`)),
      h('ul', ...items.map((x) => h('li', x))))
    : null);
  const shadowed = (state.config && state.config.shadowed) || [];
  const events = (link && !link.hidden && link.supported && (link.events || []).slice(0, 6)) || [];
  return trackedCard('zabbix-opts', 'Zabbix sync options', 'Sync options', 'apply on the next sync',
    h('div', { style: { display: 'grid', gap: '10px' } },
      opt('useElasticProCredentials', 'Use ElasticPro credentials for Zabbix clusters',
        'Connect with the credential ElasticPro already has for the same address, or the config’s shared one — instead of the password in Vault. Off: Vault.'),
      opt('createHosts', 'Create Zabbix hosts from this config',
        'Each cluster here that Zabbix does not have yet becomes a Zabbix host with the cluster template; its password goes to Vault. The new host takes that cluster over (recorded as Update under Held for review).',
        zbx.canCreateHosts ? '' : 'Needs the Zabbix write token and Vault writer on the server (see deploy/zabbix/README.md).'),
      h('div.cm-folds',
        events.length ? h('details.cm-fold', h('summary', h('b', 'Recent changes'), h('span.muted', ` · ${events.length}`)),
          h('ul', ...events.map((e) => h('li', { style: { color: e.ok ? '' : 'var(--critical-ink)' } }, `${dt(e.at * 1000)} · ${eventLine(e)}`)))) : null,
        fold('Host creation', (zbx.provisioned || []).length, zbx.provisioned || []),
        fold('Hosts not counted as clusters, and why', (zbx.skipped || []).length, zbx.skipped || []),
        fold('Config-file clusters set aside — an administrator chose Update', shadowed.length,
          shadowed.map((s) => `${s.name} (${s.url}) — now the Zabbix host ${s.by}`)))));
}

/** The Cluster hosts card's filter, kept across redraws. */
let zhFilter = '';

/**
 * Where Zabbix clusters come from and whether each can be used.
 *
 * A cluster is a Zabbix host carrying the cluster template; its macros say where it is and
 * how to sign in, and its password is a Vault macro read here and by Zabbix alike. A host
 * at the address of a cluster that exists already is not listed here: it is held for review
 * (the card above) until an administrator decides; a config-file cluster one took over by
 * Update is named in Sync options so nobody edits the copy that is no longer used.
 */
function zabbixCard() {
  if (!zbx) return card('Cluster hosts', 'Loading…', h('div.muted', 'Loading…'));
  if (!zbx.configured) {
    return card('Zabbix clusters', 'not connected',
      h('div.sec', { style: { lineHeight: 1.6 } },
        link && link.supported
          ? 'This server is not connected to a Zabbix API yet. Enter the Zabbix URL above, then Pair with Zabbix — or paste an API token and save. '
          : 'This server is not connected to a Zabbix API. An administrator connects it in Config-Management › Zabbix, or on the server with ',
        link && link.supported ? null : [h('code.inline', 'ELASTICPRO_ZABBIX_API_URL'), ' and ', h('code.inline', 'ELASTICPRO_ZABBIX_API_TOKEN_FILE'), '. '],
        'Passwords held as Vault macros also need ', h('code.inline', 'ELASTICPRO_VAULT_ADDR'),
        ' with an AppRole. See deploy/zabbix/README.md.'));
  }
  const rows = (zbx.clusters || []).map((z) => {
    const cl = client(z._id);
    return h('tr', { dataset: { zh: z._id || z.name } },
      h('td', h('b', z.name), h('span.muted', ` · host ${z.zabbixHost}${z.client ? ` · client ${z.client}` : ''}`)),
      h('td.mono', z.url, z.via ? h('span.muted', ` via ${z.via}`) : null),
      h('td', pill(CREDENTIAL_LABEL[z.credential] || 'none', z.credentialOk ? 'green' : 'red'),
        (z.notes || []).map((n) => h('div.muted', { style: { fontSize: '11px', marginTop: '3px' } }, n))),
      h('td', (z.zabbixGroups || []).join(', ') || h('span.muted', 'no user group can read it')),
      h('td', { 'data-cluster-state': z._id, 'data-kind': 'zabbix' }, clusterStatePill(cl, 'zabbix')));
  });
  const tbl = table(['Cluster host', 'Elasticsearch', 'Password', 'Zabbix user groups that see it', 'Connection'], rows,
    { emptyText: 'No Zabbix host carries the cluster template yet.' });
  const apply = () => {
    const q = zhFilter.trim().toLowerCase();
    for (const tr of tbl.querySelectorAll('tr[data-zh]')) tr.hidden = !!q && !tr.textContent.toLowerCase().includes(q);
  };
  apply();
  const pending = (state.config && state.config.zabbixPending) || [];
  const n = (zbx.clusters || []).length;
  return h('section.card.cm-card',
    h('header', h('h2', 'Cluster hosts'),
      h('span.sub', `${n} host${n === 1 ? '' : 's'} carry the cluster template${zbx.lastSync ? ` · synced ${ago(zbx.lastSync * 1000)}` : ''}${(zbx.templates || []).length ? ` · ${templatesRead(zbx.templates)}` : ''}`),
      h('div', { style: { marginLeft: 'auto' } },
        h('input', { type: 'search', placeholder: 'Filter hosts', 'aria-label': 'Filter hosts', value: zhFilter, oninput: (e) => { zhFilter = e.target.value; apply(); } }))),
    zbx.error ? h('div.banner.err', { style: { margin: '10px 14px 0' } }, h('div', h('div.ttl', 'Last sync failed'), h('div', zbx.error), h('div.muted', 'Showing the list from the last sync that worked.'))) : null,
    !zbx.vault ? h('div.banner.warn', { style: { margin: '10px 14px 0' } }, 'Vault is not configured on this server, so passwords held as Vault macros cannot be read.') : null,
    pending.length ? h('div.banner.warn', { style: { margin: '10px 14px 0' } }, h('div', h('div.ttl', 'Waiting for a working password'),
      h('div', `${pending.map((p) => p.name).join(', ')} ${pending.length === 1 ? 'is' : 'are'} not used yet: the password could not be read. `
        + 'Any config-file cluster at the same address stays in use until it can.'))) : null,
    tbl);
}
/* ------------------------------- Volume fields ------------------------------- */

/**
 * Config > Volume fields: which index names count towards the daily volume record and which
 * fields each breakdown tries (docs/VOLUME.md). The form reads and writes `defaults.volume`
 * in the clusters file; "Override for one cluster" writes `defaults.volume.overrides[id]`,
 * only the keys that differ. Rows config.txt manages are locked and never written.
 */
let vol = { mode: 'defaults', clusterId: '', reply: null, unknown: false, checked: null, note: null };

const rawDefaultsNow = () => (state.config && state.config.raw && state.config.raw.defaults) || {};
const volOverrideOf = (id) => {
  const o = rawDefaultsNow().volume && rawDefaultsNow().volume.overrides;
  return (o && id && o[id]) || {};
};

/** The desktop `volume` payload: the same one every volume message sends. */
const volPayload = (id) => desktopVolume(state.config && state.config.raw, { cluster: id || null,
  ids: ((state.config && state.config.clusters) || []).map((c) => c.id) }, cfg.slug);

/** The effective defaults and which paths config.txt locks (the core's list adds to PING's). */
function volModel() {
  const folded = foldManaged(fileVolume(rawDefaultsNow()), managedDefaults());
  const locked = new Set(folded.locked);
  const names = new Set(((vol.reply && vol.reply.managed) || []).map(String));
  VOLUME_KEYS.forEach((k) => { if (names.has(k.managed) || names.has(k.env)) locked.add(k.path); });
  return { values: folded.volume, locked };
}

async function loadVolume() {
  const id = vol.mode === 'override' ? vol.clusterId : '';
  const res = await volumeSettings(id, volPayload(id));
  vol.unknown = !!res.unknown;
  const changed = JSON.stringify((vol.reply || {}).managed) !== JSON.stringify(res.ok ? res.managed : undefined)
    || ((vol.reply || {}).configError || '') !== (res.ok ? res.configError || '' : '')
    || ((vol.reply || {}).patternSource || '') !== (res.ok ? res.patternSource || '' : '');
  vol.reply = res.ok ? res : null;
  // Redraw only when the answer changes what is shown, so a half-typed field is not wiped.
  if (changed || vol.unknown) { if (isOpen('reports/fields')) { tracker.reset('volume'); draw(); } }
}

/**
 * Every input of the form as a volume object; a blank one is left out (override: inherit).
 * A locked input (drawn disabled: config.txt manages it) is never read: what it shows is
 * config.txt's value, not anything typed. The managed set can change between the draw and the
 * Save — the app re-reads it from the core's PING every 10 s — and Save used to decide from
 * the set at that moment, so a key config.txt stopped managing meanwhile had its old,
 * locked value written into the clusters file.
 */
function readVolumeForm() {
  const g = (id) => { const el = $(`#${id}`); return el && !el.disabled ? el.value.trim() : ''; };
  const out = {};
  const put = (path, v) => { if (v !== '' && !(Array.isArray(v) && !v.length)) setPath(out, path, v); };
  const n = (id) => (g(id) === '' ? '' : Number(g(id)));
  put('indexFormat', g('vf-index'));
  put('indexPattern', g('vf-pattern'));
  { const r = $('input[name="vf-dayfrom"]:checked'); if (r && !r.disabled) put('dayFrom', r.value); }
  put('timeField', g('vf-time'));
  FIELD_ROWS.forEach((r) => put(r.key, toList(g(`vf-${r.key}`))));
  put('extra.name', g('vf-extra-name'));
  put('extra.fields', toList(g('vf-extra')));
  put('sizeBasis', g('vf-basis'));
  put('topValues', n('vf-top'));
  put('keepMonths', n('vf-keep'));
  put('collectAt', g('vf-at'));
  return out;
}

/** Put values into the form (Reset). Locked inputs stay as config.txt has them. */
function fillVolumeForm(v) {
  const set = (id, x) => { const el = $(`#${id}`); if (el && !el.disabled) el.value = x == null ? '' : String(x); };
  set('vf-index', v.indexFormat);
  set('vf-pattern', v.indexPattern);
  set('vf-time', v.timeField);
  { const r = $(`input[name="vf-dayfrom"][value="${v.dayFrom || 'name'}"]`); if (r && !r.disabled) r.checked = true; }
  previewPattern();
  FIELD_ROWS.forEach((r) => set(`vf-${r.key}`, listText(v[r.key])));
  set('vf-extra-name', v.extra && v.extra.name);
  set('vf-extra', listText(v.extra && v.extra.fields));
  set('vf-basis', v.sizeBasis);
  set('vf-top', v.topValues);
  set('vf-keep', v.keepMonths);
  set('vf-at', v.collectAt);
}

/** Defaults: the built-in values. An override: everything blank, which is "inherit". */
function resetVolume() {
  fillVolumeForm(vol.mode === 'override' ? {} : VOLUME_DEFAULTS);
}

async function saveVolume() {
  if (!editsFileDirectly()) { toast('Only an ElasticPro admin changes these settings', 'warn', 6000); return false; }
  const override = vol.mode === 'override';
  if (override && !vol.clusterId) { toast('Pick the cluster to override first', 'warn'); return false; }
  const m = volModel();
  const values = readVolumeForm();
  const problems = validateVolume(values, { partial: override });
  // A locked row is not the form's to judge: config.txt's value is what is in force.
  const mine = problems.filter((p) => ![...m.locked].some((path) => p.startsWith(LOCKED_LABEL[path] || '\u0000')));
  // Said in place: a redraw would put back the saved values over what was typed.
  if (mine.length) { const n = $('#vf-note'); if (n) { n.textContent = mine.join(' '); n.style.color = 'var(--critical-ink)'; } toast(mine[0], 'err', 6000); return false; }
  const r = state.config && state.config.raw;
  if (!r) { toast('No config is loaded', 'warn'); return false; }
  const before = r.defaults;
  let ok = true;
  r.defaults = override
    ? applyOverride(before, vol.clusterId, values, m.values, m.locked)
    : applyDefaults(before, values, m.locked);
  try {
    await saveRaw({ silent: true });
    vol.note = { text: 'Saved.', cls: 'banner' };
    toast(override ? 'Volume fields saved for this cluster' : 'Volume fields saved', 'ok', 4000);
  } catch (e) {
    ok = false;
    r.defaults = before;
    vol.note = { text: `Not saved: ${e.message}`, cls: 'banner err' };
    toast(`Not saved: ${e.message}`, 'err', 8000);
  }
  draw();
  return ok;
}

/** The label each validation message starts with, so a locked row's complaint can be set aside. */
const LOCKED_LABEL = {
  indexPattern: 'Index pattern', dayFrom: 'Which day', timeField: 'Time field',
  indexFormat: 'Index name', tag: 'Tag', forwarder: 'Forwarder tag', sourceHost: 'Source host', sourceIp: 'Source IP',
  eventSize: 'Event size', subSize: 'Sub size', 'extra.name': 'Extra field', 'extra.fields': 'Extra field',
  sizeBasis: 'Size that counts', topValues: 'Top values', keepMonths: 'Keep the daily', collectAt: 'Collect once',
};

/** Fill one cell of the check column in place, so what was typed is not redrawn away. */
function showCheck(id, cell) {
  const el = $(`#${id}`);
  if (!el) return;
  el.textContent = cell.ok == null ? '' : `${cell.ok ? '✓' : '✗'} ${cell.text}`;
  el.className = `vf-check ${cell.ok == null ? '' : cell.ok ? 'vf-ok' : 'vf-bad'}`;
}

async function checkVolume(btn) {
  const sel = $('#vf-check-cluster');
  const id = sel ? sel.value : '';
  if (!id) { toast('Pick a cluster to check against', 'warn'); return; }
  const say = (t) => { const el = $('#vf-note'); if (el) el.textContent = t; };
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Working…';
  let res;
  try { res = await volumeFieldsCheck(id, volPayload(id)); } finally { btn.disabled = false; btn.textContent = was; }
  if (res.unknown) { vol.unknown = true; say(res.message); return; }
  // config_unreadable: the core's message is the whole answer.
  if (!res.ok) { say(res.kind === 'config_unreadable' ? res.message : `Check failed: ${res.message || 'refused'}`); return; }
  say('');
  const rows = Array.isArray(res.rows) ? res.rows : [];
  const cl = clusters().find((c) => c.id === id);
  const head = $('#vf-check-head');
  if (head) head.textContent = `On ${cl ? cl.name : id}`;
  showCheck('vf-c-index', indicesCell(res.indices));
  [...FIELD_ROWS.map((r) => r.key), 'extra'].forEach((k) => showCheck(`vf-c-${k}`, checkCell(k, rows.find((x) => x.key === k))));
  vol.checked = id;
}

/** What both Reports cards need to draw a settings input: the mode, the starting value, the lock. */
function volCtx() {
  const m = volModel();
  const override = vol.mode === 'override';
  const list = clusters();
  if (override && !vol.clusterId && list.length) vol.clusterId = list[0].id;
  const ov = override ? volOverrideOf(vol.clusterId) : {};
  const canWrite = editsFileDirectly();

  /** The value an input starts with: an override's own (blank = inherit), else the defaults. */
  const start = (path) => {
    if (!override) return getPath(m.values, path);
    const x = getPath(ov, path);
    return x === undefined ? '' : x;
  };
  const shown = (path) => (override ? getPath(m.values, path) : '');
  const lock = (path, input) => {
    if (!m.locked.has(path)) return input;
    input.disabled = true;
    input.title = MANAGED_NOTE;
    return input;
  };
  const note = (path) => (m.locked.has(path) ? h('div.muted', { style: { fontSize: '10.5px' } }, MANAGED_NOTE) : null);
  return { m, override, list, ov, canWrite, start, shown, lock, note };
}

/* ------------------------------ Which indices count ------------------------------ */

let pvTimer = null;
let pvSeq = 0;

/** Ask the core what the pattern in the form matches, a moment after the last keystroke. */
function previewPattern(now) {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(runPreview, now ? 0 : 500);
}

async function runPreview() {
  const box = $('#vf-pv');
  if (!box) return;
  const sel = $('#vf-pv-cluster');
  const id = sel ? sel.value : '';
  if (!id) { mount(box, h('div.muted', { style: { padding: '6px 12px' } }, 'Pick a cluster to see what the pattern matches.')); return; }
  const m = volModel();
  const typed = ($('#vf-pattern') || { value: '' }).value.trim();
  const pat = typed || m.values.indexPattern;
  const bad = validateVolume({ indexPattern: pat }, { partial: true });
  if (bad.length) { mount(box, h('div.vf-bad', { style: { padding: '6px 12px', fontSize: '12.5px' } }, bad[0])); return; }
  const radio = $('input[name="vf-dayfrom"]:checked');
  const dayFrom = radio ? radio.value : m.values.dayFrom;
  const tf = (($('#vf-time') || { value: '' }).value.trim()) || m.values.timeField;
  const mine = ++pvSeq;
  mount(box, h('div.muted', { style: { padding: '6px 12px' } }, 'Loading…'));
  const res = await volumePatternCheck(id, pat, dayFrom, volPayload(id));
  if (mine !== pvSeq || !box.isConnected) return;
  const view = patternPreview(res, tf);
  mount(box, view.banner ? h('div', { class: view.bannerCls, style: { padding: '6px 12px', fontSize: '12.5px', margin: 0 } }, view.banner)
    : view.rows.map(([label, value, cls]) => h('div', h('span', label), h('span', { class: cls || '', style: { fontFamily: 'var(--mono)' } }, value))));
}

/** A text input that refreshes the preview as it is typed in. */
function withPreview(input) { input.addEventListener('input', () => previewPattern()); return input; }

function indicesCard() {
  const { m, override, list, canWrite, start, shown, lock, note } = volCtx();
  const pill = (path, env) => (m.locked.has(path) ? h('span.pill.grey', { title: MANAGED_NOTE }, `config.txt: ${env}`) : null);
  const dayRadio = (value, title, help) => {
    const on = (start('dayFrom') || m.values.dayFrom) === value;
    const input = h('input', { type: 'radio', name: 'vf-dayfrom', value, checked: on, 'aria-describedby': 'vf-day-l', onchange: () => previewPattern() });
    lock('dayFrom', input);
    return h('label.vf-opt', { class: on ? 'on' : '' }, input, h('span', h('b', title), h('br'), h('span.muted', { style: { fontSize: '12px' } }, help)));
  };
  const pick = vol.checked || (override ? vol.clusterId : state.selected) || (list[0] && list[0].id) || '';
  // Which of the two the collector obeys (the core's patternSource): "format" (the older indexFormat), "pattern" or "default".
  const src = (vol.reply && vol.reply.patternSource) || '';
  const legacy = src === 'format';
  const patStart = legacy && !override && !m.locked.has('indexPattern') ? '' : start('indexPattern');
  const inForce = { format: `In force: the older index name format ${m.values.indexFormat}${m.locked.has('indexFormat') ? ' (UI_VOLUME_INDEX_FORMAT in config.txt)' : ''}. Type an index pattern below and Save to switch to it.`,
    pattern: 'In force: the index pattern below.', default: 'In force: the built-in pattern logstash-*.' }[src] || '';
  const lbl = { style: { fontWeight: '600', fontSize: '12.5px' } };
  const body = h('div', { style: { display: 'grid', gap: '12px' } },
    inForce ? h('div#vf-source', { class: legacy ? 'banner warn' : 'muted', 'data-source': src, style: { margin: 0, fontSize: '12px' } }, inForce) : null,
    h('div.vf-fld', h('label', { for: 'vf-pattern', ...lbl }, 'Index pattern'),
      withPreview(lock('indexPattern', text('vf-pattern', patStart, { mono: true, placeholder: shown('indexPattern') || 'logstash-*' }))),
      h('span.muted', { style: { fontSize: '12px' } }, 'The default. One or more patterns, comma-separated. No date part is needed in the pattern.'),
      note('indexPattern')),
    h('div.vf-fld', { role: 'radiogroup', 'aria-labelledby': 'vf-day-l' }, h('span#vf-day-l', lbl, 'Which day a document counts on'),
      dayRadio('name', 'From the index name when it carries a date, otherwise from the time field',
        'logstash-web-2026.11.02 counts on 2 Nov in full. An index with no date in its name (logstash-000014) is split by its documents’ time field.'),
      dayRadio('time', 'Always from the time field', 'Every index is split by its documents’ time field, dated name or not.'),
      note('dayFrom')),
    h('div.vf-grid2',
      h('div.vf-fld', h('label', { for: 'vf-time', ...lbl }, 'Time field'),
        withPreview(lock('timeField', text('vf-time', start('timeField'), { mono: true, placeholder: shown('timeField') || '@timestamp' }))), note('timeField')),
      h('div.vf-fld', h('label', { for: 'vf-tz', ...lbl }, 'Days end at'),
        h('input#vf-tz', { value: '00:00 UTC', disabled: true, 'data-untracked': '', title: 'The collector counts days in UTC' }))),
    h('div.vf-fld',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('span', lbl, 'What this matches on'),
        h('select#vf-pv-cluster', { 'aria-label': 'Cluster to preview against', 'data-untracked': '', onchange: () => previewPattern(true) },
          ...list.map((c) => h('option', { value: c.id, selected: c.id === pick }, c.name))),
        h('button#vf-pv-go.btn.sm', { type: 'button', onclick: () => previewPattern(true), disabled: !list.length }, 'Preview')),
      h('div#vf-pv.vf-prev', { 'aria-live': 'polite' }, h('div.muted', { style: { padding: '6px 12px' } }, list.length ? 'Loading…' : 'No cluster to preview against.')),
      h('span.muted', { style: { fontSize: '12px' } },
        'For an index split by time the day’s documents and shipper bytes are measured; its disk size per day is not (Elasticsearch reports size per index), so those days show disk size as “not measured” rather than a share.')),
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
      pill('indexPattern', 'UI_VOLUME_INDEX_PATTERN'), pill('dayFrom', 'UI_VOLUME_DAY_FROM'), pill('timeField', 'UI_VOLUME_TIME_FIELD')));
  setTimeout(() => previewPattern(true), 0);
  return card('Which indices count', override ? 'override for one cluster: only what differs is saved' : 'changes wait for the save bar', body);
}

function volumeCard() {
  const { m, override, list, ov, canWrite, start, shown, lock, note } = volCtx();
  const listInput = (id, path) => lock(path, text(id, listText(start(path)), { mono: true, placeholder: listText(shown(path)) }));

  const mode = (id, label) => h('button.seg-btn', {
    'aria-pressed': String(vol.mode === id),
    onclick: () => { vol.mode = id; vol.note = null; tracker.reset('volume'); draw(); loadVolume(); },
  }, label);

  const bar = h('div.vf-bar',
    h('div.seg-group', { role: 'group', 'aria-label': 'Which settings' },
      mode('defaults', 'Defaults · all clusters'), mode('override', 'Override for one cluster…')),
    override ? h('select#vf-cluster', {
      'aria-label': 'Cluster to override', 'data-untracked': '',
      onchange: (e) => { vol.clusterId = e.target.value; vol.note = null; tracker.reset('volume'); draw(); loadVolume(); },
    }, ...list.map((c) => h('option', { value: c.id, selected: c.id === vol.clusterId }, c.name))) : null,
    h('span.muted', { style: { fontSize: '12px' } }, `${overrideIds(rawDefaultsNow()).length} of ${list.length} clusters override these fields`),
    h('span.vf-bar-right',
      h('span.muted', { style: { fontSize: '12px' } }, 'Check against'),
      h('select#vf-check-cluster', { 'aria-label': 'Cluster to check against', 'data-untracked': '' },
        ...list.map((c) => h('option', { value: c.id, selected: c.id === (vol.checked || (override ? vol.clusterId : state.selected)) }, c.name))),
      h('button#vf-check.btn.sm', { onclick: (e) => checkVolume(e.currentTarget), disabled: !list.length }, 'Check fields')));

  const row = (settingCell, inputs, ecs, checkId) => h('tr',
    h('td', settingCell), h('td', inputs),
    h('td.muted.mono', { style: { fontSize: '11.5px' } }, ecs),
    h('td', h('span.vf-check', { id: checkId })));
  const label = (name, use) => [h('div', { style: { fontWeight: '600' } }, name), h('div.muted', { style: { fontSize: '11px' } }, use)];

  const rows = [
    row(label('Index name', 'older setting: a pattern with a date'),
      [lock('indexFormat', text('vf-index', start('indexFormat'), { mono: true, placeholder: shown('indexFormat') })), note('indexFormat')],
      '— (index name)', 'vf-c-index'),
    ...FIELD_ROWS.map((r) => row(label(r.label, r.use), [listInput(`vf-${r.key}`, r.key), note(r.key)], r.ecs, `vf-c-${r.key}`)),
    row([h('div', { style: { fontWeight: '600' } }, 'Extra field'),
      lock('extra.name', text('vf-extra-name', start('extra.name'), { placeholder: override ? m.values.extra.name : 'Name', style: { width: '130px' } })),
      note('extra.name')],
    [listInput('vf-extra', 'extra.fields'), note('extra.fields')], 'event.dataset', 'vf-c-extra'),
  ];

  const fieldsTable = h('div.tbl-wrap', h('table.tbl.vf-table',
    h('thead', h('tr', h('th', 'Setting'), h('th', 'Fields tried, in order'), h('th', 'ECS field'), h('th#vf-check-head', 'On cluster'))),
    h('tbody', ...rows)));

  const withInherit = (opts) => (override ? [['', 'Same as defaults'], ...opts] : opts);
  const num = (id, path, lo, hi) => lock(path, h('input.mono', { id, type: 'number', min: lo, max: hi, step: 1, value: String(start(path)), placeholder: String(shown(path)) }));
  const cell = (lab, input, path, hint) => h('div', field(lab, input, hint), path ? note(path) : null);
  const fixed = (id, textOf) => { const s = select(id, 'name', [['name', textOf]]); s.disabled = true; return s; };
  const grid = h('div.vf-grid',
    cell('Day of an index', fixed('vf-day', 'Date in the index name (YYYY.MM.DD)')),
    cell('Size that counts as volume', lock('sizeBasis', select('vf-basis', String(start('sizeBasis')), withInherit([
      ['primary', 'Primary (pri.store.size)'], ['total', 'Total, with replicas (store.size)'], ['eventSize', 'Event size field (sum of event_logsize)']]))), 'sizeBasis'),
    cell('Day boundary', fixed('vf-boundary', 'As written in the index name')),
    cell('Top values kept per field', num('vf-top', 'topValues', VOLUME_BOUNDS.topValues[0], VOLUME_BOUNDS.topValues[1]), 'topValues'),
    cell('Keep the daily record for (months)', num('vf-keep', 'keepMonths', VOLUME_BOUNDS.keepMonths[0], VOLUME_BOUNDS.keepMonths[1]), 'keepMonths'),
    cell('Collect once a day at (server time)', lock('collectAt', h('input.mono', { id: 'vf-at', type: 'time', value: String(start('collectAt')) })), 'collectAt',
      'Every 24 h. "Collect now" on Reports › Daily & monthly runs it at once.'));

  const name = (list.find((c) => c.id === vol.clusterId) || {}).name || 'a cluster';
  return card('Volume fields',
    override ? `override for ${name}: only what differs is saved` : 'used by every cluster that has no override',
    h('div', { style: { display: 'grid', gap: '10px' } },
      configErrorBanner(vol.reply && vol.reply.configError),
      vol.unknown ? h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } }, 'This server does not know Volume fields yet (needs 0.3.45)') : null,
      canWrite ? null : h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } },
        'Only an ElasticPro admin changes these settings, or whoever edits config.txt on the server.'),
      bar,
      h('div.muted', { style: { fontSize: '11.5px' } },
        'Each row tries its fields left to right; the first one in the mapping wins · text fields use .keyword automatically.'),
      h('div#vf-note.muted', { style: { fontSize: '12px' } }),
      fieldsTable, grid,
      vol.note ? h('div', { class: vol.note.cls, style: { margin: 0, fontSize: '12px' } }, vol.note.text) : null),
    [h('button#vf-reset.btn.sm', { onclick: () => { resetVolume(); tracker.refresh(); } }, 'Reset to defaults')]);
}

/** The section's two loads: the fields, and the mailed report with its mail server (ui/report-mail.js). */
function loadVolumeSection() {
  loadVolume();
  const onReports = () => route.page === 'reports' && !!host && host.isConnected;
  loadPlanTemplates(() => { if (onReports()) { tracker.reset('plan-templates'); draw(); } });
  loadReportMail(() => { if (onReports()) { tracker.reset('report-mail'); tracker.reset('smtp'); draw(); } });
}

/* ------------------------------- Reports: the three tabs ------------------------------- */

/** Reports › Indices & volume fields: which indices count, the fields, the config.txt-only keys. */
function fieldsTab() {
  const v = volModel().values;
  return h('div.cm-stack',
    h('div.cm-stack', { dataset: { track: 'volume', trackLabel: 'Volume fields' } }, indicesCard(), volumeCard()),
    reportHostsPanel(),
    h('div.vf-info',
      card('Same settings in the clusters file', 'what Save writes', h('pre.vf-pre', yamlBlock(v))),
      card('Hosted: config.txt keys', 'one line per setting',
        h('div', { style: { display: 'grid', gap: '6px' } }, h('pre.vf-pre', `${configTxtLines(v)}\n${reportMailKeyLines()}`),
          h('div.muted', { style: { fontSize: '11.5px' } },
            `A key set in config.txt locks its row: it shows "${MANAGED_NOTE}" here and is never written to the file.`)))));
}

/** Reports › Mail delivery: the status line, the mailed report and the mail server (ui/report-mail.js). */
function mailTab() {
  return mailDeliveryPanels();
}

/** Reports › Plan templates (ui/plan-templates-editor.js); its edits wait for the save bar like the rest. */
function templatesTab() {
  return h('div', { dataset: { track: 'plan-templates', trackLabel: 'Plan templates' } },
    planTemplatesPanel(() => { if (isOpen('reports/templates')) draw(); }));
}

/* --------------------------------------- Data --------------------------------------- */

/**
 * Data › Backend: the board's "Where each kind of data goes" table (History / Reports / Alerts,
 * each built-in, built-in + ES, or ES only), the ElasticPro built-in card, and the history store
 * as the "Elasticsearch cluster" card. The first two exist only on a core whose PING says
 * dataRouting.supported (dataRoutingSupported()), for an admin; an older core is the cluster card alone.
 */
function backendTab() {
  const routing = dataRoutingSupported() && isAdminCaller();
  return h('div.cm-stack',
    routing ? dataRoutingCard() : null,
    routing ? builtinCard({ backup: backupSupported() }) : null,
    h('div', { dataset: { track: 'history', trackLabel: 'Elasticsearch cluster' } },
      historyStoreCard({ extraRows: routing ? storeStreamRows(routingStatusNow()) : [] })));
}

/* -------------------------------------- System -------------------------------------- */

/** System › Backup & restore (ui/backup-panel.js): the tab exists only when PING says backup.supported. */
function backupTab() {
  return backupBody();
}

/**
 * System › Defaults, edited in place (it was a dialog). The fields and their save are the same
 * ones the dialog used (ui/config-editor.js defaultsFields / saveDefaultsForm); a default
 * config.txt manages is drawn locked with the reason and never written.
 */
function defaultsCard() {
  const d = state.defaults;
  // The fields read the file's defaults (a config with no file behind it yet gets an empty one).
  const fields = defaultsFields();
  const canWrite = editsFileDirectly() && !!state.config;
  if (!canWrite) fields.forEach((row) => row.querySelectorAll('input, select').forEach((el) => { el.disabled = true; }));
  return h('div.cm-stack',
    card('Defaults', 'apply to every cluster unless a cluster overrides them',
      h('div', { dataset: { track: 'defaults', trackLabel: 'Defaults' }, style: { display: 'grid', gap: '10px' } },
        canWrite ? null : h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } }, 'Only an ElasticPro admin changes the defaults, or whoever edits config.txt on the server.'),
        ...fields,
        h('div#cm-defaults-msg.muted', { style: { fontSize: '12px' } }))),
    h('details.disc.cm-effective',
      h('summary', `Every effective default (${Object.keys(d).length}) — from the defaults block, with built-in fallbacks`),
      table([], Object.entries(d).map(([k, v]) => kvRow(k, displayValue(v))))));
}

async function saveDefaults() {
  const res = await saveDefaultsForm();
  const msgEl = host && host.querySelector('#cm-defaults-msg');
  if (!res.ok) {
    if (msgEl) { msgEl.textContent = res.message; msgEl.style.color = 'var(--critical-ink)'; }
    toast(res.message, 'warn', 6000);
    return false;
  }
  toast('Defaults saved', 'ok', 3000);
  draw();
  return true;
}

/** The System › Config file header: replace the file, or read it again. */
function fileActions() {
  return [
    // "Pick another file" asks the core for a path, which is the right question on a desktop
    // and the wrong one on a server, where the file is on the operator's own machine.
    canPickByPath()
      ? h('button.btn', { type: 'button', onclick: repick }, 'Pick another file…')
      : filePickerButton('Upload a config…', { accept: '.json,.yaml,.yml', className: 'btn', onText: (txt, err, name) => uploadConfig(txt, err, name) }),
    h('button.btn.primary', { type: 'button', onclick: reload, disabled: !state.handle || isSnapshotMode() }, 'Reload from disk'),
  ];
}

/** System › Config file: the file, Diagnostics beside it, its earlier versions, and Forget last. */
function systemFileTab() {
  return h('div.cm-stack',
    h('div.cm-grid2', fileCard(), diagnosticsCard()),
    versionsCard(),
    h('section.cm-danger', { 'aria-labelledby': 'cm-forget-h' },
      h('div',
        h('h2#cm-forget-h', 'Forget file & credentials'),
        h('p', 'Clears the remembered file, the credentials held in memory and any credential kept in the OS vault, then reloads. '
          + 'Clusters stop being watched until a config is loaded again. The file on disk is not touched.')),
      h('button.btn.danger', { type: 'button', onclick: forget }, 'Forget…')));
}

function diagnosticsCard() {
  const d = state.defaults;
  const routes = `${clusters().filter((c) => c.via).length} via a jump host · ${clusters().filter((c) => !c.via).length} direct`;
  return card('Diagnostics', '',
    table([], [
      kvRow('Write protection', isReadOnly() ? h('span', pill('read-only', 'green'), h('span.muted', ' GET/HEAD and search POSTs only'))
        : h('span', pill('DISABLED', 'orange'), h('span.muted', ' writes permitted (readOnly: false)'))),
      kvRow('Enforced by the core', h('span#cm-guard', 'Loading…')),
      kvRow('Routes', routes),
      kvRow('App version', h('span#core-version', core && core.version ? `v${core.version}` : '…')),
      kvRow('Last refresh', `${state.lastRefresh ? ago(state.lastRefresh) : 'never'} · auto-refresh ${state.autoRefresh ? `every ${d.refreshIntervalSec}s` : 'paused'}`),
      // Advertise what exists. The number keys that used to jump between pages were removed —
      // a stray digit moving the page out from under somebody was worse than the shortcut.
      kvRow('Keyboard', h('span', h('kbd', 'r'), ' refresh · ', h('kbd', '/'), ' find a setting · ', h('kbd', 'Ctrl/⌘+Enter'), ' run in REST')),
    ]),
    [
      isSnapshotMode() ? null : h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, 'Force refresh all'),
      h('button.btn.sm', { onclick: () => navigateTo('console') }, 'Open REST'),
      h('button.btn.sm', { onclick: () => saveTextAs('clusters.example.yaml', EXAMPLE_YAML) }, 'Save example YAML…'),
    ].filter(Boolean));
}
/** The raw file entry behind a normalised cluster (matched by name, then url). */
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
