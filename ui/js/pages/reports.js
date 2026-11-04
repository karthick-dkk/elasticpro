/**
 * Page — Reports (0.3.53, was Volume report): what each cluster takes in, what it keeps, and
 * whether its storage holds it. docs/REPORTS.md is the contract.
 *
 * Sections, each its own module under ui/js/reports/: Overview, Daily & monthly, Volume by host, Capacity &
 * retention, Measure size, Planning, Exports & schedules. The route is `#/reports/<section>`
 * (reports/route.js); `#/volume…` still opens it. Overview, Capacity, Measure and Exports are
 * fleet-wide — one line per cluster shown; Daily & monthly is one cluster.
 */

import { h, mount } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { activeClusters } from '../core/state.js';
import { intent } from '../core/intent.js';
import { takeFocus, revealFocus } from '../core/focus.js';
import { empty } from './common.js';
import { REPORT_SECTIONS, sectionOfHash, sectionHash } from '../reports/route.js';
import { ensureRecords, resetRecords, stopFollowing, onRecords } from '../reports/record.js';
import { loadReportLayouts, resetReportLayouts, onLayouts } from '../reports/layouts.js';
import { overviewSection } from '../reports/overview.js';
import { capacitySection, capacityReset } from '../reports/capacity.js';
import { measureSection } from '../reports/measure.js';
import { exportsSection, exportsReset } from '../reports/exports.js';
import { hostsSection, hostsReset } from '../reports/hosts.js';
import { planningSection } from '../reports/planning.js';
import { volumeSummary, resetVolumeSummary, setSummaryMode } from '../reports/daily.js';
import { volumeAnalysisCard, setVolumeAnalysisField } from '../ui/index-metrics.js';
import { setReportPanelOpen } from '../ui/report-jobs.js';

let host = null;
let visiting = false;
const ui = { section: 'overview', dailyId: null };
/** The Planning section keeps its own state and draws itself: built once per visit. */
let planningNode = null;
/** A field-volume alert asked for this field (core/focus.js): its analysis sits above Daily. */
let focusField = null;
let focusRevealed = false;

const SUBTITLE = 'What each cluster takes in, what it keeps, and whether its storage holds it.';
const FLEET = new Set(['overview', 'capacity', 'measure', 'exports']);

const alive = () => !!(host && host.isConnected);
onRecords(() => { if (alive()) draw(); });
onLayouts(() => { if (alive()) draw(); });

export function render(el) {
  host = el;
  el.classList.add('dense', 'rp-page');
  if (!visiting) {
    // Each visit reads the record and the shared layouts as they are now.
    visiting = true;
    resetRecords();
    resetReportLayouts();
    loadReportLayouts();
    resetVolumeSummary();
    capacityReset();
    exportsReset();
    hostsReset();
    planningNode = null;
    focusField = null;
  }
  ui.section = sectionOfHash(location.hash);
  // A link that named a section (navigateTo('reports', {section})) wins over the hash.
  const asked = intent.reports;
  intent.reports = null;
  if (asked && asked.section && REPORT_SECTIONS.some((s) => s.id === asked.section)) {
    ui.section = asked.section;
    if (asked.cluster) ui.dailyId = asked.cluster;
    if (asked.mode) setSummaryMode(asked.mode);
  }
  // From a field-volume alert: that field's volume, on Daily & monthly.
  const f = takeFocus('reports');
  if (f && f.field) { focusField = f.field; focusRevealed = false; setVolumeAnalysisField(f.field); ui.section = 'daily'; }
  // From the top-bar Reports pill: the report jobs. From a playbook: the section it names.
  if (f && f.reports) { ui.section = 'exports'; setReportPanelOpen(true); }
  if (f && f.section && REPORT_SECTIONS.some((s) => s.id === f.section)) ui.section = f.section;
  syncHash();
  draw();
}

export function onData() { if (alive()) draw(); }
export function onLeave() { visiting = false; stopFollowing(); }

/** The shell saw the hash change to another section of this page. */
export function onRoute() {
  const s = sectionOfHash(location.hash);
  const moved = s !== ui.section;
  ui.section = s;
  syncHash();                   // #/volume/… reads as #/reports/… from here on
  if (moved) draw();
}

function syncHash() {
  const want = sectionHash(ui.section);
  if (location.hash !== want) {
    try { history.replaceState(null, '', want); } catch (_) { location.hash = want; }
  }
}

function goSection(id) {
  if (!REPORT_SECTIONS.some((s) => s.id === id)) return;
  ui.section = id;
  syncHash();
  draw();
}

function openDaily(id) {
  ui.dailyId = id;
  setSummaryMode('daily');
  goSection('daily');
}

function header() {
  return h('div.rp-head',
    h('div', h('h1', 'Reports'), h('p.sub', SUBTITLE)));
}

function sectionNav() {
  return h('nav.rp-nav', { 'aria-label': 'Report sections' },
    ...REPORT_SECTIONS.map((s) => h('a', {
      href: sectionHash(s.id), dataset: { section: s.id },
      'aria-current': ui.section === s.id ? 'page' : null,
      onclick: (e) => { e.preventDefault(); goSection(s.id); },
    }, s.label)));
}

/** Daily & monthly is one cluster: the one selected, or — on "All clusters" — one picked here. */
function dailyCluster(list) {
  if (list.length === 1) return list[0];
  return list.find((c) => c.id === ui.dailyId) || list[0];
}
function dailyPicker(list, c) {
  if (list.length < 2) return null;
  const s = h('select#rp-daily-cluster', { onchange: (e) => { ui.dailyId = e.target.value; draw(); } },
    ...list.map((x) => h('option', { value: x.id }, x.name)));
  s.value = c.id;
  return h('label.field', 'Cluster', s);
}

function body(list) {
  const ctx = { clusters: list, redraw: draw, openDaily, goSection };
  switch (ui.section) {
    case 'daily': {
      const c = dailyCluster(list);
      return h('div.rp-section',
        focusField ? h('div', { dataset: { focus: 'field-volume' }, style: { marginBottom: '10px' } }, volumeAnalysisCard(c, draw)) : null,
        volumeSummary(c, { redraw: draw, picker: dailyPicker(list, c) }));
    }
    case 'hosts': {
      const c = dailyCluster(list);
      return hostsSection({ cluster: c, picker: dailyPicker(list, c) });
    }
    case 'capacity': return capacitySection(ctx);
    case 'measure': return measureSection(ctx);
    case 'planning': return planningNode || (planningNode = planningSection({ clusters: list }));
    case 'exports': return exportsSection(ctx);
    default: return overviewSection(ctx);
  }
}

/**
 * What the last draw put on screen. The page redraws on every push from the core — about once a
 * second on a busy fleet — and most of the time nothing it shows has changed: the heading, the
 * section links and an unchanged section are then left exactly as they are (lib/keyed.js).
 */
const built = nodeCache();

function draw() {
  if (!alive()) return;
  built.begin();
  try { drawPage(); } finally { built.end(); }
}

function drawPage() {
  const list = activeClusters();
  if (!list.length) { mount(host, ...built.sameAll('rp', [header(), sectionNav(), empty('No cluster selected')])); return; }
  // The fleet sections read every shown cluster's daily record; asked after this draw, and
  // the answers redraw (reports/record.js, at most four at once).
  if (FLEET.has(ui.section)) {
    const ids = list.map((c) => c.id);
    setTimeout(() => ensureRecords(ids), 0);
  }
  // The sections keep their own pieces (Exports, Volume by host, Planning, Capacity): a section's
  // export buttons hold the rows they were drawn with, so a section is not kept from outside.
  mount(host, ...built.sameAll('rp', [header(), sectionNav()]), body(list));
  if (focusField && !focusRevealed && revealFocus(host, '[data-focus="field-volume"]')) focusRevealed = true;
}
