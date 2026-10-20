/** Page — everything currently wrong across the fleet: unreachable clusters first, then grouped by cluster. */

import { h, mount, $, tooltip } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { ago, dt, dur, toCsv, download, num } from '../lib/fmt.js';
import { state, bus, mergedAlerts, invalidateAlerts, clusters, client, fetchOverview, refreshAll, clusterRev, fleetMode, coverage, askFleetDataset } from '../core/state.js';
import { coverageBar } from '../lib/freshness.js';
import { readAllState, startReadAll } from '../lib/read-all.js';
import { card, table, empty, act, diagnose, diagnosisPanel, connectionProblem } from './common.js';
import { navigateTo } from '../core/intent.js';
import { alertsEmptyState } from '../core/fleet-summary.js';
import { silenceFor, silences, silence, unsilence, loadSilences, SILENCE_FOR } from '../core/silences.js';
import { modal, field, select as selectField, text as textField, val } from '../ui/modal.js';
import { rowMenu, ICON, popover, toast } from '../ui/menu.js';
import { confirmDialog, inputDialog } from '../ui/modal.js';
import {
  loadAcks, loadCurrentUser, currentUser, setCurrentUser, ackFor, isAcked,
  acknowledgeItems, unacknowledge, addNote, removeNote, pruneAcks, ackRecords,
} from '../core/acks.js';
import { errorText } from '../core/error-codes.js';
import {
  ageShort, filterAlerts, groupAlerts, summaryOf, isOpen, isHandled, GROUP_MODES, toObservations,
  splitUnreachable, filterDown, downFor, unreachableReason, heldText,
} from '../core/alert-groups.js';
import { gotoFor, openGoto } from '../core/alert-goto.js';
import { playbookFor } from '../core/alert-playbooks.js';
import { relatedFor, historyFor, WINDOW_MS } from '../core/alert-related.js';
import { alertHistory } from '../core/alert-history.js';
import { watermarks } from '../core/disk-balance.js';
import { setFocus, takeFocus } from '../core/focus.js';

let host = null;
/**
 * What the page is showing. `group` and the collapsed groups are remembered per viewer
 * (localStorage, if it will have them); the filters are not — they are a question asked,
 * and the page opens on the answer to the usual one: everything open, grouped by cluster.
 */
const ui = { level: 'all', text: '', handled: false, group: 'cluster', cluster: null, expanded: new Set() };

const PREF_GROUP = 'elasticpro.alerts.group';
const PREF_COLLAPSED = 'elasticpro.alerts.collapsed';

function readPref(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* private window: not remembered */ } }

/** Group ids the viewer folded, as `<mode>:<id>`. */
let collapsed = (() => {
  try { const v = JSON.parse(readPref(PREF_COLLAPSED) || '[]'); return new Set(Array.isArray(v) ? v.map(String) : []); }
  catch (_) { return new Set(); }
})();
function saveCollapsed() { writePref(PREF_COLLAPSED, JSON.stringify([...collapsed])); }
const groupKey = (g) => `${ui.group}:${g.id}`;

{
  const saved = readPref(PREF_GROUP);
  if (GROUP_MODES.includes(saved)) ui.group = saved;
}

/**
 * The datasets alerts are raised from: health and nodes (status, disk, masters, JVM), ILM
 * errors, snapshots (last backup) and policies (SLM, repositories). What "current" means
 * for a cluster's alerts, and what Read all asks for.
 */
const DATASETS = ['health', 'nodes', 'ilm_errors', 'snapshots', 'policies'];
/** The Read all run, kept across redraws. */
const reading = readAllState();

/**
 * The coverage line. Over every configured cluster rather than the selected one: alerts()
 * is computed for the whole fleet, and so is this page. Only with the fleet cache; never
 * reads by itself. Which clusters' alerts are not current is said by the Unreachable group.
 */
/** How many clusters have been read enough for their alerts to mean something. */
function clustersRead(list) {
  if (fleetMode()) return coverage(list.map((c) => c.id), DATASETS).read;
  return list.filter((c) => { const d = state.data.get(c.id); return d && !d.healthUnknown && d.reachable; }).length;
}

function coverageLines() {
  if (!fleetMode()) return [];
  const ids = clusters().map((c) => c.id);
  const cov = coverage(ids, DATASETS);
  const bar = coverageBar({
    cov, datasets: DATASETS, state: reading,
    onReadAll: () => startReadAll(reading, { clusterIds: ids, datasets: DATASETS, ask: askFleetDataset,
      onChange: () => { if (host && host.isConnected) coverageLines(); } }),
  });
  return [bar];
}

/**
 * Arrow keys step between the controls that open and close things — group toggles and row
 * toggles — so a list of fifty alerts is not fifty tab stops to get through. Everything
 * else stays a plain button or link, reached by Tab as usual.
 */
function navKey(e) {
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (!t || !t.hasAttribute || !t.hasAttribute('data-nav')) return;
  const all = [...host.querySelectorAll('[data-nav]')];
  const next = all[all.indexOf(t) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

export function render(el) {
  host = el;
  el.classList.add('dense');
  el.removeEventListener('keydown', navKey);
  el.addEventListener('keydown', navKey);
  // Opened from a bell entry ("Open <cluster> alerts"): that cluster only, said out loud, and
  // gone again on the next visit. Otherwise the whole fleet — this page does not follow the
  // top bar's cluster, because the app opens on one cluster and the page is about all of them.
  const f = takeFocus('alerts');
  ui.cluster = f && f.cluster ? f.cluster : null;
  // Acknowledgements live on this machine; load them before the first paint so rows do
  // not flicker from unacknowledged to acknowledged.
  Promise.all([loadAcks(), loadCurrentUser(), loadSilences()])
    .then(() => { pruneAcks(mergedAlerts().flatMap((m) => [m.key, ...m.keys])); invalidateAlerts(); draw(); })
    .catch(() => {});
  draw();
}
export function onData() { if (host && host.isConnected) draw(); }

/**
 * Rows and connection banners kept between redraws (lib/keyed.js): the page redraws on
 * every push from the core, and on a large fleet most alerts and every unreachable
 * cluster's banner are the same from one push to the next.
 */
const built = nodeCache();
const minute = () => Math.floor(Date.now() / 60000);
let lastObserved = 0;

/** All notes on a merged alert: those on its own key and on any member's (written before merging). */
function allNotes(m) {
  const keys = [...new Set([m.key, ...m.keys])];
  return keys.flatMap((k) => (ackFor(k).notes || []).map((n) => ({ ...n, key: k })))
    .sort((a, b) => a.ts - b.ts);
}

/** The silence covering the whole of a merged alert, else the first covering any member. */
function silenceOf(m) {
  const per = m.members.map((a) => silenceFor(a));
  return per.every(Boolean) ? per[0] : (per.find(Boolean) || null);
}

function silenceLabel(s) {
  return s.until ? `silenced until ${new Date(s.until).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : 'silenced until removed';
}

function draw() {
  if (!host || !host.isConnected) return;
  built.begin();
  const now = Date.now();
  // What this browser has seen of each alert (core/alert-history.js): recorded here too,
  // because the shell only does it when it announces, and an embedded page does not.
  if (now - lastObserved > 5000) {
    lastObserved = now;
    try { if (alertHistory.observe(toObservations(mergedAlerts()), now)) invalidateAlerts(); } catch (_) { /* a convenience */ }
  }
  const list = clusters();
  const all = mergedAlerts();
  const sum = summaryOf(all, list.length);
  // The alerts the filters work on: everything, or the one cluster a link asked for.
  const mine = ui.cluster ? all.filter((m) => m.clusterId === ui.cluster) : all;
  const only = ui.cluster ? list.find((c) => c.id === ui.cluster) : null;
  const opts = { level: ui.level, text: ui.text, showHandled: ui.handled,
    notesOf: (m) => allNotes(m).map((n) => n.text).join(' ') };
  // A cluster that cannot be reached is one line in one group, first whatever the grouping;
  // its other alerts are held behind that line and are in no group below (alert-groups.js).
  const split = splitUnreachable(mine);
  const down = filterDown(split.down, opts);
  const visible = filterAlerts(split.rest, opts);
  const groups = groupAlerts(visible, ui.group);
  const hiddenHandled = ui.handled ? 0 : mine.filter(isHandled).length;
  // What Collapse all folds: the Unreachable group and every group that has a header.
  const foldKeys = [...(down.length ? [DOWN_KEY] : []), ...groups.filter(hasHeader).map(groupKey)];
  const allCollapsed = foldKeys.length > 0 && foldKeys.every((k) => collapsed.has(k));
  const segBtn = (label, on, onClick, title) => h('button.seg-btn', {
    type: 'button', 'aria-pressed': String(on), title: title || null, onclick: onClick,
  }, label);
  // A count that is also a filter: pressing it shows those alerts, pressing it again shows all.
  const sumBtn = (id, text, cls, pressed, onClick, title) => h(`button.alerts-sumbtn.${cls}`, {
    type: 'button', id, 'aria-pressed': String(pressed), title, onclick: onClick }, text);

  mount(host,
    ...coverageLines(),
    h('div.alerts-sum', { role: 'status', 'aria-label': 'Open alerts' },
      sumBtn('alerts-sum-critical', `${num(sum.critical)} critical`, 'crit', ui.level === 'critical',
        () => { ui.level = ui.level === 'critical' ? 'all' : 'critical'; draw(); },
        ui.level === 'critical' ? 'Showing critical only — press to show all' : 'Show the critical alerts only'),
      h('span.alerts-sum-sep', { 'aria-hidden': 'true' }, '·'),
      sumBtn('alerts-sum-warning', `${num(sum.warning)} warning`, 'warn', ui.level === 'warning',
        () => { ui.level = ui.level === 'warning' ? 'all' : 'warning'; draw(); },
        ui.level === 'warning' ? 'Showing warnings only — press to show all' : 'Show the warnings only'),
      h('span.alerts-sum-sep', { 'aria-hidden': 'true' }, '·'),
      h('span', 'in ', h('b', num(sum.clustersAffected)), ` of ${num(sum.fleet)} cluster${sum.fleet === 1 ? '' : 's'}`),
      h('span.alerts-sum-sep', { 'aria-hidden': 'true' }, '·'),
      sumBtn('alerts-sum-acked', `${num(sum.acknowledged)} acknowledged`, 'ack', ui.handled,
        () => { ui.handled = !ui.handled; draw(); },
        ui.handled ? 'Showing acknowledged alerts too — press to hide them' : 'Show acknowledged alerts too'),
      sum.silenced ? h('span.muted', `(${num(sum.silenced)} silenced)`) : null),

    only
      ? h('div.banner', { style: { marginBottom: '10px' } },
          h('div', h('div.ttl', `Showing ${only.name} only`), h('div.muted', 'Every other cluster’s alerts are hidden.')),
          h('div.acts', h('button.btn.sm', { type: 'button', onclick: () => { ui.cluster = null; draw(); } }, 'Show all clusters')))
      : null,

    h('div.toolbar.alerts-bar',
      h('label.field', 'Search', h('input#alerts-search', { type: 'search', placeholder: 'Search alerts, clusters, nodes', value: ui.text,
        'aria-label': 'Search alerts', style: { minWidth: '240px' }, oninput: (e) => { ui.text = e.target.value; draw(); } })),
      h('div.field', h('span', 'Severity'),
        h('div.seg-group', { role: 'group', 'aria-label': 'Severity' },
          segBtn('All', ui.level === 'all', () => { ui.level = 'all'; draw(); }),
          segBtn('Critical', ui.level === 'critical', () => { ui.level = 'critical'; draw(); }),
          segBtn('Warning', ui.level === 'warning', () => { ui.level = 'warning'; draw(); }))),
      h('div.field', h('span', 'Group by'),
        h('div.seg-group', { role: 'group', 'aria-label': 'Group by' },
          segBtn('Cluster', ui.group === 'cluster', () => setGroup('cluster')),
          segBtn('Alert type', ui.group === 'type', () => setGroup('type')),
          segBtn('None', ui.group === 'none', () => setGroup('none'), 'A flat list, critical first'))),
      h('label.field.check', h('input#alerts-handled', { type: 'checkbox', checked: ui.handled,
        onchange: (e) => { ui.handled = e.target.checked; draw(); } }), 'Show acknowledged'),
      h('div.alerts-bar-end',
        h('span.muted', { style: { fontSize: '11.5px' } }, `updated ${ago(state.lastRefresh)}`),
        foldKeys.length
          ? h('button.btn.sm.ghost#alerts-collapse-all', { type: 'button',
              onclick: () => {
                if (allCollapsed) foldKeys.forEach((k) => collapsed.delete(k));
                else foldKeys.forEach((k) => collapsed.add(k));
                saveCollapsed(); draw();
              } }, allCollapsed ? 'Expand all' : 'Collapse all')
          : null,
        h('button.btn.sm', { type: 'button', onclick: () => exportAlerts(mine) }, 'Export CSV'),
        h('button.btn.sm', { type: 'button', onclick: () => refreshAll({ force: true, selected: true }) }, '↻ Refresh'))),

    silencesCard(),

    mine.length
      ? h('div.agroups',
          down.length ? downSection(down, all) : null,
          ...groupSections(groups, all),
          groups.length || down.length ? null : h('div.card', h('div.body', empty(
            ui.text.trim() || ui.level !== 'all' ? 'No alert matches the filter'
              : 'Nothing open — every alert here is acknowledged or silenced. Tick “Show acknowledged” to see them.'))))
      : (() => {
          // Healthy only for the clusters that were read (fleet-summary.js alertsEmptyState).
          const e = alertsEmptyState({ total: list.length, read: clustersRead(list) });
          return card('Alerts', e.healthy ? 'nothing to report' : 'nothing raised — see why',
            h('div', { style: { padding: '26px 0', textAlign: 'center' } },
              h('div', { style: { fontSize: '26px', marginBottom: '6px' } }, e.healthy ? '✓' : '…'),
              h('div', { style: { fontWeight: 640 } }, e.title),
              h('div.muted', { style: { fontSize: '12.5px', marginTop: '3px' } }, e.detail)));
        })(),

    mine.length
      ? h('div.alerts-foot', footText(sum, hiddenHandled))
      : null);
  built.end();
}

function setGroup(mode) {
  if (ui.group === mode) return;
  ui.group = mode;
  writePref(PREF_GROUP, mode);
  draw();
}

function footText(sum, hiddenHandled) {
  const clear = sum.clustersClear;
  const parts = [`${num(clear)} cluster${clear === 1 ? ' has' : 's have'} no open alerts`];
  if (hiddenHandled) parts.push(`${num(hiddenHandled)} acknowledged${sum.silenced ? ' or silenced' : ''} hidden`);
  // Held alerts are listed under their cluster's Unreachable line and counted nowhere.
  if (sum.held) parts.push(`${num(sum.held)} older alert${sum.held === 1 ? '' : 's'} held on unreachable clusters, not counted`);
  return parts.join(' · ');
}

/* ----------------------------------- groups ----------------------------------- */

const levelPill = (level) => h(`span.apill.${level === 'critical' ? 'crit' : 'warn'}`, level === 'critical' ? 'critical' : 'warning');

/** The collapse key of the Unreachable group: the same in every grouping, because it is in every one. */
const DOWN_KEY = 'unreachable';

/** A group has a header when it is a type, or a cluster with two alerts or more. One alert is one line. */
const hasHeader = (g) => ui.group === 'type' || (ui.group === 'cluster' && g.alerts.length >= 2);

/**
 * The groups, as sections. In Group by Cluster a cluster with a single alert is one line
 * with no header; consecutive ones share a section, so they read as a list and not as a
 * stack of boxes.
 */
function groupSections(groups, all) {
  const out = [];
  let run = null;
  for (const g of groups) {
    if (ui.group === 'cluster' && !hasHeader(g)) {
      if (!run) { run = []; out.push(run); }
      run.push(alertRow(g.alerts[0], all, { single: true }));
    } else {
      run = null;
      out.push(groupSection(g, all));
    }
  }
  return out.map((x) => (Array.isArray(x)
    ? h('section.agroup.singles', { 'aria-label': 'Clusters with one alert' }, ...x)
    : x));
}

function groupSection(g, all) {
  const flat = ui.group === 'none';
  const isCollapsed = !flat && collapsed.has(groupKey(g));
  const bodyId = `agroup-${ui.group}-${String(g.id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const toggle = () => {
    if (isCollapsed) collapsed.delete(groupKey(g)); else collapsed.add(groupKey(g));
    saveCollapsed(); draw();
  };
  const cluster = g.clusterId ? clusters().find((c) => c.id === g.clusterId) : null;
  const open = g.alerts.filter(isOpen);

  const header = flat ? null : h('div.agroup-head',
    h('span.adot', { class: g.critical ? 'crit' : 'warn', 'aria-hidden': 'true' }),
    g.clusterId
      ? h('a.agroup-name', { href: '#/overview', onclick: (e) => { e.preventDefault(); navigateTo('overview', null, { cluster: g.clusterId }); } }, g.name)
      : h('span.agroup-name', g.name),
    g.critical ? h('span.apill.crit', `${g.critical} critical`) : null,
    g.warning ? h('span.apill.warn', `${g.warning} warning`) : null,
    h('span.muted.agroup-oldest', `oldest ${ageShort(Date.now() - g.oldest)}`),
    h('span.agroup-spacer'),
    h('button.btn.sm.ghost', { type: 'button', disabled: !open.length,
      title: open.length ? `Acknowledge the ${open.length} open alert${open.length === 1 ? '' : 's'} in ${g.name}` : 'Nothing open to acknowledge',
      onclick: () => ackGroup(g) }, 'Acknowledge all'),
    cluster ? silenceMenu(cluster) : null,
    h('button.btn.sm.ghost.agroup-toggle', { type: 'button', 'data-nav': '',
      'aria-expanded': String(!isCollapsed), 'aria-controls': bodyId,
      'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'} ${g.name}`,
      title: isCollapsed ? 'Expand' : 'Collapse', onclick: toggle }, isCollapsed ? '▾' : '▴'));

  return h(`section.agroup${g.critical ? '.has-crit' : ''}${flat ? '.flat' : ''}`, header,
    isCollapsed ? null : h('div.agroup-body', { id: bodyId }, ...g.alerts.map((m) => alertRow(m, all))));
}

/** Silence a whole cluster: one quiet button, the durations behind it (1 h first). */
function silenceMenu(cluster) {
  const items = [
    ...SILENCE_FOR.map(([label, minutes]) => ({ label: `Silence ${cluster.name} for ${label}`, icon: '🔕', onClick: () => doSilenceCluster(cluster, minutes) })),
    { sep: true },
    { label: 'With a reason…', icon: '🔕', onClick: () => askSilence('cluster', [cluster.id], cluster.name) },
    { hint: 'Every alert of the cluster leaves the open counts until then.' },
  ];
  return rowMenu(items, { trigger: 'button.btn.sm.ghost.menu-trigger.silence-menu', label: 'Silence ▾',
    title: `Silence every alert of ${cluster.name} (maintenance)` });
}

/* ------------------------------ the Unreachable group ------------------------------ */

/** The last diagnosis each unreachable cluster ran, kept across redraws. */
const diag = new Map();

/**
 * Every cluster that cannot be reached, as one group at the top: one line each, with the
 * full name, the full reason, how long it has been down and what a person can do — Retry,
 * Diagnose, Ack. These clusters are in no group below; their other alerts are held (said on
 * the line, listed dimmed when it opens, counted nowhere).
 */
function downSection(down, all) {
  const isCollapsed = collapsed.has(DOWN_KEY);
  const bodyId = 'agroup-unreachable';
  const open = down.filter((d) => isOpen(d.alert));
  const n = down.length;
  const toggle = () => {
    if (isCollapsed) collapsed.delete(DOWN_KEY); else collapsed.add(DOWN_KEY);
    saveCollapsed(); draw();
  };
  const head = h('div.agroup-head.adown-head',
    h('span.adot.crit', { 'aria-hidden': 'true' }),
    h('h2.agroup-name#agroup-unreachable-h', `Unreachable · ${n} cluster${n === 1 ? '' : 's'}`),
    h('span.muted.adown-note', 'always first · one line per cluster · their other alerts are held until they answer'),
    h('span.agroup-spacer'),
    h('button.btn.sm#alerts-retry-all', { type: 'button', title: 'Ask every unreachable cluster again now',
      onclick: (e) => act(e.currentTarget, () => Promise.all(down.map((d) => fetchOverview(d.clusterId)))) }, 'Retry all'),
    h('button.btn.sm.ghost#alerts-ack-down', { type: 'button', disabled: !open.length,
      title: open.length ? `Acknowledge the ${open.length} open unreachable alert${open.length === 1 ? '' : 's'}` : 'Nothing open to acknowledge',
      onclick: () => ackGroup({ name: 'Unreachable', alerts: down.map((d) => d.alert) }) }, 'Acknowledge all'),
    h('button.btn.sm.ghost.agroup-toggle', { type: 'button', 'data-nav': '',
      'aria-expanded': String(!isCollapsed), 'aria-controls': bodyId,
      'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'} Unreachable`,
      title: isCollapsed ? 'Expand' : 'Collapse', onclick: toggle }, isCollapsed ? '▾' : '▴'));
  return h('section.agroup.has-crit.adown', { 'aria-labelledby': 'agroup-unreachable-h' }, head,
    isCollapsed ? null : h('div.agroup-body', { id: bodyId }, ...down.map((d) => downRow(d, all))));
}

function downRow(dn, all) {
  const m = dn.alert;
  const expanded = ui.expanded.has(m.key);
  const notes = allNotes(m).length;
  const sil = silenceOf(m);
  const cl = client(dn.clusterId) || {};
  const d = state.data.get(dn.clusterId) || {};
  const sig = ['down', m.state, m.level, m.detail, m.ackedBy, m.ackedAt, Math.floor(m.since / 60000), m.approxSince, expanded, notes,
    sil ? sil.id || sil.until : '', clusterRev(dn.clusterId), cl.state, objId(cl.lastError), d.reach && d.reach.since,
    d.reach && d.reach.nextProbeAt, objId(diag.get(dn.clusterId) || null), minute(),
    dn.held.map((x) => `${x.key}@${Math.floor(x.since / 60000)}`).join(','),
    expanded ? all.filter((x) => x.clusterId === m.clusterId).map((x) => `${x.key}@${Math.floor(x.since / 60000)}`).join(',') : '',
    expanded ? ackRecords().length : '', objId(m.cluster)].join('\u0001');
  return built.get(`down:${m.key}`, sig, () => buildDownRow(dn, all, { expanded, notes, sil }));
}

function buildDownRow(dn, all, { expanded, notes, sil }) {
  const m = dn.alert;
  const id = dn.clusterId;
  const c = dn.cluster || { id, name: dn.name, url: '' };
  const cl = client(id) || {};
  const d = state.data.get(id) || {};
  const reason = unreachableReason(cl);
  const err = cl.lastError || {};
  const msg = err.message || m.detail || 'No response from the cluster.';
  const reachSince = d.reach && d.reach.since;
  const downText = `down ${downFor(Date.now() - (reachSince || m.since))}`;
  const handled = isHandled(m);
  const retry = () => fetchOverview(id);
  const result = diag.get(id);
  const panelId = `apanel-${m.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const stateNote = m.state === 'silenced' ? (sil ? silenceLabel(sil) : 'silenced')
    : m.state === 'acked' ? `acknowledged${m.ackedBy ? ` by ${m.ackedBy}` : ''}${m.ackedAt ? ` · ${ago(m.ackedAt)}` : ''}` : null;
  const flip = () => { if (ui.expanded.has(m.key)) ui.expanded.delete(m.key); else ui.expanded.add(m.key); draw(); };

  const toggle = h('button.btn.sm.ghost.arow-toggle', { type: 'button', 'data-nav': '',
    'aria-expanded': String(expanded), 'aria-controls': panelId,
    'aria-label': `${expanded ? 'Hide' : 'Show'} details, how to fix and held alerts for ${dn.name}`,
    title: expanded ? 'Hide the details' : 'Address, how it is reached, how to fix, and the alerts held behind this one',
    onclick: flip }, expanded ? '▴' : '▾');
  const heldLine = dn.held.length
    ? h('button.alink.adown-held', { type: 'button', 'aria-expanded': String(expanded), 'aria-controls': panelId, onclick: flip,
        title: 'Raised from data read before this cluster went down. Not counted until it answers.' }, heldText(dn.held.length))
    : h('span', heldText(0));

  const row = h(`div.arow.adown-row${handled ? '.handled' : ''}${expanded ? '.open' : ''}`, { 'data-cluster': id },
    h('div.arow-main',
      levelPill(m.level),
      h('div.arow-body',
        h('div.arow-title',
          h('b.adown-name', { title: dn.name }, dn.name), ' ',
          h('span.apill.grey', { title: 'Why it cannot be reached' }, reason.label),
          stateNote ? [' ', h('span.apill.grey', stateNote)] : null),
        h('div.adown-reason', { title: msg }, msg),
        h('div.arow-sub.muted.adown-meta', { title: reachSince ? `Since ${dt(reachSince)}` : ageTitle(m) },
          `${downText}${!reachSince && m.approxSince ? '+' : ''} · `, heldLine)),
      h('button.btn.sm.primary.adown-retry', { type: 'button', title: `Ask ${dn.name} again now`,
        onclick: (e) => act(e.currentTarget, retry) }, 'Retry'),
      h('button.btn.sm.adown-diagnose', { type: 'button', title: 'Walk the connection step by step and say where it stops',
        onclick: (e) => act(e.currentTarget, async () => { diag.set(id, await diagnose(c)); draw(); }) }, 'Diagnose'),
      handled
        ? h('button.btn.sm', { type: 'button', title: 'Put it back on the open list', onclick: () => doUnack(m) }, 'Re-open')
        : h('button.btn.sm', { type: 'button', title: 'Mark as seen — it stays until the condition clears', onclick: () => doAck(m) }, 'Ack'),
      moreMenu(m, null, sil),
      toggle),
    result ? h('div.adown-diag', diagnosisPanel(result, (e) => act(e.currentTarget || e.target, retry))) : null,
    expanded ? detailPanel(m, all, panelId, { dn, c, cl, d, retry }) : null);
  return row;
}

/** Where it is, how it is reached, when it last answered, when it is tried next. */
function downDetails({ c, cl, d, retry }) {
  const err = cl.lastError || {};
  const prob = connectionProblem(c, retry);
  const next = (d.reach && d.reach.nextProbeAt) || cl.nextRetryAt || 0;
  const last = cl.lastOkAt;
  const code = err.errorCode || (String(err.message || '').match(/EP-\d{3}/) || [''])[0];
  const row = (k, v, mono) => [h('dt', k), h(mono ? 'dd.mono' : 'dd', v)];
  return h('div.adown-more',
    h('dl.adl',
      ...row('Address', c.url || 'not known', true),
      ...row('Through', c.via ? `${c.via} (SSH jump host)` : 'direct — no jump host'),
      ...row('Last answer', last ? `${dt(last)} · ${ago(last)}` : 'none since the app started'),
      ...row('Problem', prob.title),
      ...row('Error code', code || 'none given'),
      ...row('Next try', !next ? 'not known' : next <= Date.now() ? 'due now'
        : `in ${dur(next - Date.now())}${cl.failures > 1 ? ' (backing off)' : ''}`)),
    prob.body,
    prob.actions.length ? h('div.adown-acts', ...prob.actions) : null);
}

/** The alerts held behind an unreachable line, dimmed and labelled. */
function heldList(dn) {
  if (!dn.held.length) return null;
  return h('div.aheld', { role: 'list', 'aria-label': `Alerts held on ${dn.name}, not current` },
    h('div.aheld-head', h('b', 'Held, not current'),
      h('span.muted', ' — raised from data read before the cluster went down. Not counted, and not known to be true now; they are checked again when it answers.')),
    ...dn.held.map((x) => h('div.aheld-row', { role: 'listitem' },
      h(`span.apill.${x.level === 'critical' ? 'crit' : 'warn'}`, x.level),
      h('span.aheld-what', h('b', x.title), x.count ? ` ${x.count}` : '',
        x.items.length === 1 && x.items[0].label && !`${x.title} ${x.detail || ''}`.includes(x.items[0].label) ? ` (${x.items[0].label})` : '',
        x.detail ? ` · ${x.detail}` : ''),
      h('span.muted.aheld-age', { title: `Since ${dt(x.since)}` }, `${ageShort(Date.now() - x.since)} old`))));
}

async function doSilenceCluster(cluster, minutes) {
  const res = await silence('cluster', cluster.id, minutes, 'From the Alerts page');
  if (res && res.ok) { toast(`Silenced ${cluster.name}${minutes ? ` for ${SILENCE_FOR.find((x) => x[1] === minutes)[0]}` : ' until removed'}`, 'ok', 3500); draw(); }
  else toast(`Could not silence ${cluster.name}: ${errorText(res, 'no answer from the server')}`, 'err', 6000);
}

/* ------------------------------------ rows ------------------------------------ */

/** Plain-words reading of an item list for the cache signature. */
const itemSig = (m) => m.items.map((i) => `${i.id}|${i.value}|${i.level}|${i.handled ? 1 : 0}`).join(';');

function alertRow(m, all, { single = false } = {}) {
  const expanded = ui.expanded.has(m.key);
  const notes = allNotes(m).length;
  const sil = silenceOf(m);
  const siblingSig = expanded ? all.filter((x) => x.clusterId === m.clusterId).map((x) => `${x.key}@${Math.floor(x.since / 60000)}`).join(',') : '';
  const sig = [ui.group, single, m.level, m.title, m.count, m.detail, m.state, m.newSince, m.ackedBy, m.ackedAt, Math.floor(m.since / 60000),
    m.approxSince, itemSig(m), expanded, notes, sil ? sil.id || sil.until : '', siblingSig, expanded ? minute() : '',
    expanded ? ackRecords().length : '', m.problemUrl || '', objId(m.cluster)].join('\u0001');
  return built.get(`row:${m.key}`, sig, () => buildRow(m, all, { expanded, notes, sil, single }));
}

/** The row's ⋮ menu, with a word on it: More. */
function moreMenu(m, g, sil) {
  return rowMenu([
    { label: 'Notes & comments…', icon: '💬', onClick: (e) => openNotes(e.target.closest('button') || e.target, m) },
    g ? { label: `Go to ${g.label}`, icon: ICON.console, onClick: () => openGoto(g), disabled: !g.page } : null,
    { sep: true },
    { label: 'Silence this alert…', icon: '🔕', onClick: () => askSilence('alert', m.keys, m.title) },
    m.cluster ? { label: `Silence ${m.cluster.name} (maintenance)…`, icon: '🔕', onClick: () => askSilence('cluster', [m.clusterId], m.cluster.name) } : null,
    sil ? { label: 'Remove the silence', icon: '🔔', onClick: () => doUnsilence(m) } : null,
    { sep: true },
    { hint: `key: ${m.key}` },
  ].filter(Boolean), { trigger: 'button.btn.sm.ghost.menu-trigger.arow-more', label: 'More', title: `Actions for ${m.title}` });
}

function buildRow(m, all, { expanded, notes, sil, single }) {
  const g = gotoFor(m);
  const handled = isHandled(m);
  const panelId = `apanel-${m.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const where = ui.group === 'cluster' ? null : (m.cluster ? m.cluster.name : m.clusterId);

  const stateNote = m.state === 'silenced' ? (sil ? silenceLabel(sil) : 'silenced')
    : m.state === 'acked' ? `acknowledged${m.ackedBy ? ` by ${m.ackedBy}` : ''}${m.ackedAt ? ` · ${ago(m.ackedAt)}` : ''}`
    : null;

  const toggle = h('button.btn.sm.ghost.arow-toggle', { type: 'button', 'data-nav': '',
    'aria-expanded': String(expanded), 'aria-controls': panelId,
    'aria-label': `${expanded ? 'Hide' : 'Show'} how to fix and related for ${m.title}`,
    title: expanded ? 'Hide how to fix and related' : 'How to fix, and what else started around it',
    onclick: () => { if (ui.expanded.has(m.key)) ui.expanded.delete(m.key); else ui.expanded.add(m.key); draw(); } },
  expanded ? '▴' : '▾');

  // A note is how "seen it, ticket 4412" gets written. A button with its word on it in a
  // group; on a one-line cluster it is in More until there is one to read.
  const notesBtn = (!single || notes) ? (() => {
    const b = h('button.btn.sm.ghost.arow-notes', { type: 'button',
      title: notes ? `${notes} note(s) — click to add or remove` : 'Add a note',
      'aria-label': notes ? `${notes} notes on ${m.title}` : `Add a note to ${m.title}`,
      onclick: (e) => { e.stopPropagation(); openNotes(b, m); } }, notes ? `Note ${notes}` : 'Note');
    notePeek(b, m);
    return b;
  })() : null;

  const clusterName = single && m.cluster
    ? h('a.arow-cluster', { href: '#/overview', onclick: (e) => { e.preventDefault(); navigateTo('overview', null, { cluster: m.clusterId }); } }, m.cluster.name)
    : null;

  return h(`div.arow${handled ? '.handled' : ''}${expanded ? '.open' : ''}${single ? '.single' : ''}`,
    h('div.arow-main',
      levelPill(m.level),
      h('div.arow-body',
        h('div.arow-title', { title: m.detail || null },
          clusterName, clusterName ? h('span.muted', ' · ') : null,
          h('b', m.title),
          m.count ? h('span.muted.arow-count', ` ${m.count}`) : null,
          where ? h('span.muted.arow-where', ` · ${where}`) : null,
          m.detail ? h('span.arow-detail', ` · ${m.detail}`) : null,
          m.newSince ? [' ', h('span.apill.warn', `${m.newSince} new since acknowledged`)] : null,
          stateNote ? [' ', h('span.apill.grey', stateNote)] : null,
          m.stale ? [' ', h('span.apill.grey', { title: 'The reading is older than its dataset allows' }, 'stale reading')] : null),
        m.snapshot ? h('div.arow-sub.muted', `${dt(m.snapshot.at)} · ${m.snapshot.repo || ''}${m.snapshot.status ? ` · ${m.snapshot.status}` : ''}`) : null),
      h('span.arow-age', { title: ageTitle(m) }, ageText(m)),
      goLink(g, m),
      handled
        ? h('button.btn.sm', { type: 'button', title: 'Put it back on the open list', onclick: () => doUnack(m) }, 'Re-open')
        : h('button.btn.sm', { type: 'button', title: 'Mark as seen — it stays until the condition clears', onclick: () => doAck(m) }, 'Ack'),
      notesBtn,
      moreMenu(m, g, sil),
      toggle),
    expanded ? detailPanel(m, all, panelId) : null);
}

function ageText(m) { return `${ageShort(Date.now() - m.since)}${m.approxSince ? '+' : ''}`; }
function ageTitle(m) {
  return `Since ${dt(m.since)}${m.approxSince ? ' — first seen then; it may have started before this browser had ElasticPro open' : ''}`;
}

/** "Go to <page> →" — a text link, not a button: it navigates. A real link, so it can be middle-clicked, tabbed to and read out. */
function goLink(g, m, text = null, extra = {}) {
  if (g.external) {
    return h('a.golink', { href: g.external, target: '_blank', rel: 'noopener noreferrer', ...extra }, text || 'Open in Zabbix →');
  }
  return h('a.golink', { href: `#/${g.page}`, title: `Open ${g.label} for ${m.cluster ? m.cluster.name : m.clusterId}`,
    onclick: (e) => { e.preventDefault(); openGoto(g); }, ...extra }, text || `Go to ${g.label} →`);
}

/* --------------------------------- the panel ---------------------------------- */

function detailPanel(m, all, panelId, down = null) {
  // Held alerts are not current, so they are not offered as what else started around this one.
  const siblings = all.filter((x) => x.clusterId === m.clusterId && !x.held);
  const sib = new Map(siblings.map((s) => [s.family, s]));
  const d = state.data.get(m.clusterId) || {};
  const pb = playbookFor(m, { defaults: state.defaults, watermarks: watermarks(d.clusterSettings), siblings: sib });
  return h('div.apanel', { id: panelId },
    down ? downDetails(down) : null,
    down ? heldList(down.dn) : null,
    m.items.length > 1 ? itemsList(m) : null,
    h('div.apanel-grid',
      h('div.apanel-card', h('b', 'How to fix'),
        h('div.muted.apanel-cause', `Likely cause: ${pb.cause}`),
        h('ol.apanel-steps', ...pb.steps.map((s) => stepItem(s, m)))),
      h('div.apanel-card', h('b', 'Related'), relatedBody(m, siblings))));
}

function itemsList(m) {
  const unit = { disk: 'this node →', ilm: 'this index →', repo: 'this repository →', 'slm-fail': 'this policy →', 'slm-stale': 'this policy →',
    volume: 'this field →' }[m.family] || 'open →';
  const shown = m.items.slice(0, 50);
  return h('div.aitems', { role: 'list', 'aria-label': `What ${m.title} is about` },
    ...shown.map((it) => {
      const g = gotoFor(m, it);
      return h('div.aitem', { role: 'listitem' },
        h('span.aitem-label', it.label),
        h('span.aitem-value', { class: it.level === 'critical' ? 'crit' : 'warn' }, it.value || ''),
        it.handled ? h('span.apill.grey', it.silenced ? 'silenced' : 'acknowledged') : null,
        h('span.muted.aitem-since', `since ${ageShort(Date.now() - it.since)}`),
        g.page ? goLink(g, m, unit, { class: 'aitem-link' }) : null);
    }),
    m.items.length > shown.length ? h('div.muted', { style: { fontSize: '11.5px' } }, `…and ${m.items.length - shown.length} more`) : null);
}

/** A playbook step: its words, then the links that act on it. */
function stepItem(s, m) {
  return h('li',
    s.text,
    ...(s.links || []).map((l) => [' ', h('a', { href: `#/${l.page}`,
      onclick: (e) => { e.preventDefault(); if (l.focus) setFocus(l.page, l.focus); navigateTo(l.page, null, { cluster: m.clusterId }); } }, `${l.label} →`)]).flat(),
    s.request ? [' ', h('a', { href: '#/console', title: `${s.request.method} ${s.request.path}`,
      onclick: (e) => { e.preventDefault(); prepareRequest(s.request, m); } }, `${s.request.label || 'Prepare the request in the REST console'} →`)] : null,
    s.request && s.request.write ? h('span.muted', ' (you review and send; writes still need the unlock)') : null);
}

/** Open the REST console with the request filled in. It is never sent from here. */
function prepareRequest(r, m) {
  navigateTo('console', { method: r.method, path: r.path, body: r.body || '' }, { cluster: m.clusterId });
}

function relatedBody(m, siblings) {
  const rows = relatedFor(m, siblings);
  const hist = historyFor(m, alertHistory.episodes(m.key), ackRecords(),
    { retentionDays: alertHistory.retentionDays, since: alertHistory.since(), clusterName: m.cluster ? m.cluster.name : m.clusterId });
  const line = (r) => {
    if (r.self) return h('span', 'This alert started', m.approxSince ? h('span.muted', ' (first seen then; it may be older)') : null);
    const a = r.alert;
    const what = `${a.title}${a.count ? ` ${a.count}` : ''}`;
    return h('span', what,
      r.relation === 'caused-by-this' ? [': ', h('b.related-flag', 'probably caused by this'), h('span.muted', ` (started ${r.deltaText}; ${r.why})`)]
        : r.relation === 'cause-of-this' ? [': ', h('b.related-flag', 'a known cause of this alert'), h('span.muted', ` (started ${r.deltaText}; ${r.why})`)]
        : h('span.muted', /^first seen/.test(r.deltaText) ? ` (${r.deltaText})` : ` (started ${r.deltaText})`));
  };
  return h('div.related',
    rows.length > 1
      ? h('div.related-rows', ...rows.map((r) => h('div.related-row', { class: r.self ? 'self' : null },
          h('span.related-when', r.when), line(r))))
      : h('div.muted', { style: { fontSize: '12px' } }, 'No other alert on this cluster started within an hour of this one.'),
    h('div.related-hist',
      hist.empty
        ? [h('span', h('b', hist.emptyText)), hist.sinceText ? h('span.muted', hist.sinceText) : null]
        : [h('span', h('b', hist.lines[0])), h('span', hist.lines[1]),
           hist.note ? h('span.muted', `Note from that time (${hist.note.by}): “${hist.note.text}”`) : null],
      h('span.muted.related-foot',
        `From ElasticPro’s own alert log (what this browser has seen), acknowledgements and notes. Nothing here is guessed: with no history, it says so. “Probably caused by this” appears only for a known cause on the same cluster that started later, within ${Math.round(WINDOW_MS / 60000)} minutes.`)));
}

/* ------------------------------ acknowledge / silence ------------------------------ */

/** Ask who is acknowledging, once per machine. */
async function ensureUser() {
  if (currentUser()) return currentUser();
  const name = await inputDialog('Who is acknowledging?',
    'Your name or initials — recorded against acknowledgements and notes on this machine', '', { yes: 'Save' });
  if (name && name.trim()) await setCurrentUser(name);
  return currentUser();
}

/** Acknowledge what the alert lists now. Items that arrive later are not covered. */
async function ackOne(m) { await acknowledgeItems(m.key, m.items.map((i) => i.id)); }

async function doAck(m) {
  await ensureUser();
  await ackOne(m);
  bus.emit('alerts-changed');   // the open counts (nav badge, top bar) drop it now
  draw();
}

async function ackGroup(g) {
  const open = g.alerts.filter(isOpen);
  if (!open.length) return;
  await ensureUser();
  for (const m of open) await ackOne(m);
  bus.emit('alerts-changed');
  toast(`Acknowledged ${open.length} alert${open.length === 1 ? '' : 's'} in ${g.name}`, 'ok', 3000);
  draw();
}

async function doUnack(m) {
  const ok = await confirmDialog(`Re-open ${m.title}?`,
    'The alert goes back to the open list. Notes written against it are kept.',
    { yes: 're-open' });
  if (!ok) return;
  // The merged record, and any a member had on its own key before alerts were merged.
  for (const k of new Set([m.key, ...m.keys])) if (isAcked(k)) await unacknowledge(k);
  bus.emit('alerts-changed');
  draw();
}

function askSilence(scope, targets, name) {
  const body = [
    field('For', selectField('sil-for', '60', SILENCE_FOR.map(([l, mins]) => [mins === null ? 'none' : String(mins), l]))),
    field('Reason', textField('sil-why', '', { placeholder: scope === 'cluster' ? 'e.g. disk replacement, change 4711' : 'e.g. known, ticket 123' }),
      scope === 'cluster'
        ? 'Every alert of this cluster leaves the open counts until then. They stay listed under Silenced.'
        : 'This alert leaves the open counts until then, for everyone. It stays listed under Silenced.'),
  ];
  return modal(scope === 'cluster' ? `Silence ${name}` : 'Silence this alert', scope === 'cluster' ? 'maintenance' : name, body,
    (ctx) => [h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
      h('button.btn.primary', { onclick: async () => {
        const f = val('sil-for');
        let res = null;
        // One silence per member: the silence list is keyed by the raised alert, which is
        // what the rest of the app counts. An item that appears later is not silenced.
        for (const t of targets) {
          res = await silence(scope, t, f === 'none' ? null : Number(f), val('sil-why'));
          if (!res || !res.ok) break;
        }
        if (res && res.ok) ctx.done(true); else ctx.msg((res && res.message) || 'Could not set the silence');
      } }, 'Silence')),
    ], { width: '480px' }).then((ok) => {
      if (ok) { toast(`Silenced ${scope === 'cluster' ? name : 'the alert'}`, 'ok', 3000); draw(); }
    });
}

async function doUnsilence(m) {
  const mine = [...new Set(m.members.map((a) => silenceFor(a)).filter(Boolean))];
  let res = null;
  for (const s of mine) { res = await unsilence(s.id); if (!res || !res.ok) break; }
  if (res && res.ok) { toast('Silence removed', 'ok', 2500); draw(); }
  else toast(`Could not remove the silence: ${errorText(res, 'no answer from the server')}`, 'err', 6000);
}

async function doUnsilenceById(s) {
  const res = await unsilence(s.id);
  if (res && res.ok) { toast('Silence removed', 'ok', 2500); draw(); }
  else toast(`Could not remove the silence: ${errorText(res, 'no answer from the server')}`, 'err', 6000);
}

function silencesCard() {
  const list = silences();
  if (!list.length) return null;
  const names = new Map(clusters().map((c) => [c.id, c.name]));
  return h('div', { style: { marginBottom: '10px' } }, card('Silences in force', `${list.length} · shared with everyone, kept on the server`,
    table(['What', 'Until', 'Why', 'By', ''], list.map((s) => h('tr',
      h('td', s.scope === 'cluster' ? h('span', h('b', names.get(s.target) || s.target), h('span.muted', ' (whole cluster)')) : h('span.mono', { style: { fontSize: '11.5px' } }, s.target)),
      h('td', s.until ? new Date(s.until).toLocaleString() : 'until removed'),
      h('td.muted', s.reason || '—'),
      h('td.muted', `${s.by} · ${ago(s.at)}`),
      h('td', { style: { textAlign: 'right' } }, h('button.btn.sm', { onclick: () => doUnsilenceById(s) }, 'Remove')))), {})));
}

/* ----------------------------------- notes ------------------------------------ */

/**
 * Notes on one alert, in a panel anchored to the button that opened it. Anchored, it costs
 * no layout at all and dismisses itself on Escape or a click anywhere else. Notes are
 * written against the merged alert; any written against a member before merging are shown
 * too and removed from where they are.
 */
function openNotes(trigger, m) {
  popover(trigger, (ctx) => {
    const rec = ackFor(m.key);
    const notes = allNotes(m);

    const input = h('input#note-input', {
      type: 'text', placeholder: 'What was found, who is on it, ticket number…',
      style: { flex: '1', minWidth: '190px' },
      onkeydown: async (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        await saveNote(m, e.target.value);
        ctx.rebuild();
      },
    });

    return h('div', { style: { display: 'grid', gap: '7px' } },
      rec.acked
        ? h('div.muted', { style: { fontSize: '11px' } }, `Acknowledged by ${rec.ackedBy || 'operator'} ${ago(rec.ackedAt)}`)
        : null,
      notes.length
        ? h('div', { style: { display: 'grid', gap: '4px' } }, ...notes.map((n) =>
            h('div.note',
              h('b', n.by || 'operator'), h('span.when', { title: dt(n.ts) }, ago(n.ts)),
              h('div', n.text),
              h('button.btn.sm.ghost', {
                style: { padding: '0 5px', fontSize: '11px' },
                title: 'Remove this note',
                onclick: async () => {
                  if (await confirmDialog('Remove this note?', n.text, { yes: 'remove', danger: true })) {
                    await removeNote(n.key, n.ts);
                    ctx.rebuild();
                    draw();
                  }
                },
              }, ICON.delete))))
        : h('div.muted', { style: { fontSize: '11.5px' } }, 'No notes yet.'),
      h('div', { style: { display: 'flex', gap: '6px' } },
        input,
        h('button.btn.sm.primary', {
          onclick: async () => {
            const box = $('#note-input');
            if (!box || !box.value.trim()) return;
            await saveNote(m, box.value);
            ctx.rebuild();
          },
        }, 'Add')));
  }, {
    title: `Notes — ${m.cluster ? m.cluster.name : ''}`,
    sub: m.title,
    width: '340px',
    // The count on the button changes, so the row behind it has to be redrawn.
    onClose: () => draw(),
  });
}

async function saveNote(m, text) {
  await ensureUser();
  await addNote(m.key, text);
  toast('Note added');
}

/** A read-only peek, so notes can be read without opening anything. */
function notePeek(el, m) {
  const notes = allNotes(m).reverse();
  if (!notes.length) return;
  // Built once and reused: the shared tooltip re-parents whatever it is given, so a
  // fresh node per mousemove would rebuild this on every pixel.
  const tip = h('div', { style: { display: 'grid', gap: '4px', maxWidth: '320px' } },
    ...notes.slice(0, 4).map((n) => h('div',
      h('b', n.by || 'operator'), h('span.muted', { style: { marginLeft: '5px' } }, ago(n.ts)),
      h('div', { style: { fontSize: '11.5px' } }, n.text))),
    notes.length > 4 ? h('div.muted', { style: { fontSize: '11px' } }, `…and ${notes.length - 4} more`) : null,
    h('div.muted', { style: { fontSize: '10.5px', marginTop: '2px' } }, 'click to add or remove'));
  const show = (e) => tooltip.show(tip, e.clientX, e.clientY);
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', show);
  el.addEventListener('mouseleave', () => tooltip.hide());
  // Opening the panel must not leave the peek hanging over it.
  el.addEventListener('click', () => tooltip.hide());
}

/* ----------------------------------- export ------------------------------------ */

function exportAlerts(merged) {
  download(`es-alerts-${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(merged.map((m) => ({
      level: m.level,
      cluster: m.cluster ? m.cluster.name : '',
      url: m.cluster ? m.cluster.url : '',
      alert: m.title,
      items: m.items.map((i) => (i.value ? `${i.label} ${i.value}` : i.label)).join(' | '),
      detail: m.detail || '',
      since: new Date(m.since).toISOString(),
      repository: m.snapshot ? m.snapshot.repo : '',
      snapshot: m.snapshot ? m.snapshot.id : '',
      snapshot_date: m.snapshot ? new Date(m.snapshot.at).toISOString() : '',
      snapshot_status: m.snapshot ? m.snapshot.status : '',
      snapshot_is_new: m.snapshot ? (m.snapshot.isNew ? 'yes' : 'no') : '',
      // Held: raised on a cluster that cannot be reached now. Listed here, never as current.
      state: m.held ? 'held' : m.state === 'acked' ? 'acknowledged' : m.state,
      held_not_current: m.held ? 'yes' : 'no',
      new_since_acknowledged: m.newSince || 0,
      acknowledged_by: m.ackedBy || '',
      acknowledged_at: m.ackedAt ? new Date(m.ackedAt).toISOString() : '',
      notes: allNotes(m).map((n) => `[${new Date(n.ts).toISOString().slice(0, 16)} ${n.by}] ${n.text}`).join(' | '),
      key: m.key,
      observed_at: new Date(state.lastRefresh || Date.now()).toISOString(),
    }))), 'text/csv');
}
