/**
 * Config-Management › Data › Scheduled log delay (0.3.57, Storage board): the delay levels, the
 * fields the measurement reads, and the log delay report generator. docs/LOGDELAY.md is the
 * contract:
 *
 *   LOGDELAY_SETTINGS_GET / _SET {settings}   levels (4 bands), silentAfterHours, fields  (Admin)
 *   REPORT_SCHEDULE_GET|SET {kind:'log_delay', …, options}, REPORT_SEND_NOW, REPORT_RUN
 *
 * Each card takes part in the save bar (ui/change-tracker.js): its inputs carry ids, and the
 * page registers save/discard for 'ld-levels', 'ld-fields' and 'ld-report'. Left out on
 * purpose, because the contract does not offer them: "Check against an index" and a PDF
 * attachment (the core has no PDF writer).
 */

import { h, $ } from '../lib/dom.js';
import { toast } from './menu.js';
import { clusters } from '../core/state.js';
import { addressList, refreshReports } from '../core/reports.js';
import { ldSettingsGet, ldSettingsSet, ldScheduleGet, ldScheduleSet, ldSendNow, ldReportRun } from '../core/logdelay-report.js';
import { rememberLevels } from '../core/delay-levels.js';
import { validLevels, levelsDraft, fieldsDraft, reportDraft, COLUMN_LABEL, SECTION_LABEL, DEVICE_CHOICES, WHEN_CHOICES, PERIOD_CHOICES, runPeriodFor } from '../core/logdelay-settings.js';

const L = { state: 'idle', res: null, error: '', sched: null, schedState: 'idle', schedError: '', extras: null };
let redraw = () => {};

export function resetLogDelaySettings() {
  L.state = 'idle'; L.res = null; L.error = ''; L.sched = null; L.schedState = 'idle'; L.schedError = ''; L.extras = null;
}

/** Read the settings and the report schedule once per visit; `done` redraws with fresh baselines. */
export async function loadLogDelaySettings(done = () => {}) {
  L.state = 'loading'; L.schedState = 'loading';
  const [a, b] = await Promise.all([ldSettingsGet(), ldScheduleGet()]);
  if (a && a.ok) { L.state = 'ok'; L.res = a; L.extras = null; rememberLevels(a); }
  else { L.state = a && a.unsupported ? 'unsupported' : 'error'; L.error = (a && (a.message || a.kind)) || 'no answer'; }
  if (b && b.ok) { L.schedState = 'ok'; L.sched = b; }
  else { L.schedState = b && b.unsupported ? 'unsupported' : 'error'; L.schedError = (b && (b.message || b.kind)) || 'no answer'; }
  done();
}

const num = (id) => { const el = $(`#${id}`); return el ? Number(String(el.value).trim()) : NaN; };
const val = (id) => { const el = $(`#${id}`); return el ? String(el.value).trim() : ''; };
const on = (id) => { const el = $(`#${id}`); return !!(el && el.checked); };

/* ------------------------------------ the levels ------------------------------------ */

function levelsCard(cardFn) {
  const s = (L.res && L.res.settings) || {};
  const l = s.levels || {};
  const inp = (id, v, label) => h(`input#${id}`, { type: 'number', min: '1', step: '1', value: v ?? '', dataset: { label }, oninput: syncCritical });
  const silent = s.silentAfterHours ?? 2;
  const silentSel = h('select#ldc-silent', { dataset: { label: 'Silent after (hours)' } },
    ...[...new Set([1, 2, 3, 4, 6, 12, 24, 48, 168, silent])].sort((a, b) => a - b)
      .map((n) => h('option', { value: String(n) }, n === 1 ? '1 hour without logs' : `${n} hours without logs`)));
  silentSel.value = String(silent);
  const resolved = (L.res && L.res.resolved) || [];
  const fromWords = { settings: 'these settings', configFile: 'the cluster’s own delayThresholds', default: 'shipped default' };
  return cardFn('ld-levels', 'Delay levels', 'Delay levels', 'the default for every cluster, used by the report, the mail and the stored delays',
    h('div', { style: { display: 'grid', gap: '10px' } },
      h('div.ldc-levels#ldc-levels',
        h('div.ldc-level', { style: { background: 'var(--ld-green-bg)' } }, h('b', 'No delay'),
          h('span', 'under ', inp('ldc-noDelayUnder', l.noDelayUnder, 'No delay under (min)'), ' min')),
        h('div.ldc-level', { style: { background: 'var(--ld-orange-bg)' } }, h('b', 'Little delay'),
          h('span', h('span#ldc-little-from', String(l.noDelayUnder ?? '?')), ' to under ', inp('ldc-delayFrom', l.delayFrom, 'Delay from (min)'), ' min')),
        h('div.ldc-level', { style: { background: 'var(--ld-blue-bg)' } }, h('b', 'Delay'),
          h('span', h('span#ldc-delay-from', String(l.delayFrom ?? '?')), ' to ', inp('ldc-criticalOver', l.criticalOver, 'Critical over (min)'), ' min')),
        h('div.ldc-level', { style: { background: 'var(--ld-pink-bg)' } }, h('b', 'Critical'),
          h('span', 'over ', h('span#ldc-critical-over', String(l.criticalOver ?? '?')), ' min'))),
      h('div.ldc-hint', 'A cluster can still override these in its own settings (delayThresholds), as today. A delay starts when a device reaches “Delay” and is solved when it is back under it. Exactly the critical figure is still “Delay”.'),
      h('label.field', { style: { maxWidth: '260px' } }, 'Silent after', silentSel),
      h('div.ldc-hint', 'A device that stops sending is “silent”: never on time, never 0 min.'),
      resolved.length ? h('details.ldc-resolved',
        h('summary', { style: { fontSize: '12px', cursor: 'pointer' } }, `Levels in force on each cluster (${resolved.length})`),
        h('div.tbl-wrap', h('table.tbl',
          h('thead', h('tr', h('th', 'Cluster'), h('th.num', 'No delay under'), h('th.num', 'Delay from'), h('th.num', 'Critical over'), h('th', 'From'))),
          h('tbody', ...resolved.map((r) => h('tr', { dataset: { cluster: r.id } }, h('td', r.name || r.id),
            h('td.num', `${r.levels ? r.levels.noDelayUnder : '?'} min`), h('td.num', `${r.levels ? r.levels.delayFrom : '?'} min`),
            h('td.num', `${r.levels ? r.levels.criticalOver : '?'} min`), h('td', fromWords[r.levelsFrom] || r.levelsFrom || 'not said')))))))
        : null));
}

/** The band texts follow what is typed, so the four boxes always read as one ladder. */
function syncCritical() {
  const put = (id, v) => { const el = $(`#${id}`); if (el) el.textContent = v || '?'; };
  put('ldc-little-from', val('ldc-noDelayUnder'));
  put('ldc-delay-from', val('ldc-delayFrom'));
  put('ldc-critical-over', val('ldc-criticalOver'));
}

export async function saveLevels() {
  const levels = { noDelayUnder: num('ldc-noDelayUnder'), delayFrom: num('ldc-delayFrom'), criticalOver: num('ldc-criticalOver') };
  const why = validLevels(levels);
  if (why) { toast(why, 'warn', 6000); return false; }
  const silentAfterHours = num('ldc-silent');
  return put(levelsDraft(levels, silentAfterHours), 'Delay levels saved');
}

/* ------------------------------------ the fields ------------------------------------ */

function fieldsCard(cardFn) {
  const s = (L.res && L.res.settings) || {};
  const f = s.fields || {};
  const first = ((L.res && L.res.resolved) || [])[0];
  const dflt = (first && first.fields) || {};
  const shipped = (L.res && L.res.extrasDefault) || ['tag1', 'fwd_tag', 'parser_tag', 'Zone'];
  if (!L.extras) L.extras = Array.isArray(f.extras) && f.extras.length ? [...f.extras] : [...shipped];
  const hidden = h('input#ldc-f-extras', { type: 'text', value: L.extras.join(', '), dataset: { label: 'Extra columns' }, style: { display: 'none' }, readOnly: true });
  const changed = () => { hidden.value = L.extras.join(', '); hidden.dispatchEvent(new Event('input', { bubbles: true })); redrawChips(); };
  const chips = h('span.ldc-chips#ldc-f-chips');
  const redrawChips = () => {
    while (chips.firstChild) chips.removeChild(chips.firstChild);
    for (const x of L.extras) {
      chips.append(h('span.ldc-chip', { dataset: { extra: x } }, x,
        h('button', { type: 'button', 'aria-label': `Remove ${x}`, title: `Remove ${x}`, onclick: () => { L.extras = L.extras.filter((y) => y !== x); changed(); } }, '×')));
    }
    chips.append(add);
  };
  const add = h('input#ldc-f-add', { type: 'text', placeholder: L.extras.length >= 12 ? 'at most 12' : 'add a field…', style: { width: '160px', height: '26px' },
    dataset: { untracked: '' }, 'aria-label': 'Add an extra column',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const name = String(e.target.value || '').trim();
      if (!name) return;
      if (!/^[A-Za-z0-9_@.\-]+$/.test(name)) { toast(`${name} is not a field name`, 'warn'); return; }
      if (L.extras.includes(name)) { e.target.value = ''; return; }
      if (L.extras.length >= 12) { toast('At most 12 extra columns', 'warn'); return; }
      L.extras = [...L.extras, name]; e.target.value = ''; changed();
    } });
  redrawChips();
  const text = (id, v, ph, label) => h(`input#${id}.mono`, { type: 'text', value: v || '', placeholder: ph || '', dataset: { label } });
  return cardFn('ld-fields', 'Log delay fields', 'Fields', 'the fields the measurement reads · default for every cluster; a cluster can override in its own settings',
    h('div.ldc-form',
      h('label.field', 'Device', text('ldc-f-device', f.device, String(dflt.device || 'src_hostname').replace(/\.keyword$/, ''), 'Device field'),
        h('span.ldc-hint', 'or src_device · the field that names each device')),
      h('label.field', 'Arrival time', text('ldc-f-arrival', f.arrival, dflt.arrival || '@timestamp', 'Arrival time field'),
        h('span.ldc-hint', 'when the log reached Elasticsearch')),
      h('label.field', 'Event time', text('ldc-f-event', Array.isArray(f.eventTime) ? f.eventTime.join(', ') : '', (dflt.eventTime || ['event_created']).join(', '), 'Event time fields'),
        h('span.ldc-hint', 'when the device made the log · delay = arrival − event · tried in order')),
      h('div.field.ldc-span', h('span.muted', { style: { fontSize: '11px' } }, 'Extra columns'), chips, hidden,
        h('span.ldc-hint', 'Shown as columns in the device tables and in the report; kept with each measurement (at most 12).')),
      h('div.ldc-hint.ldc-span', 'An empty box keeps the value in force (shown greyed): each cluster’s own fields, then config.txt, then the shipped names.')));
}

export async function saveFields() {
  const fields = fieldsDraft({ device: val('ldc-f-device'), arrival: val('ldc-f-arrival'), eventTime: val('ldc-f-event'), extras: L.extras || [] });
  return put({ fields }, 'Log delay fields saved');
}

async function put(settings, ok) {
  const res = await ldSettingsSet(settings);
  if (!res || !res.ok) { toast(`Not saved: ${(res && (res.message || res.kind)) || 'refused'}`, 'err', 7000); return false; }
  toast(ok, 'ok');
  if (res.settings && L.res) L.res = { ...L.res, settings: { ...L.res.settings, ...res.settings } };
  if (res.resolved && L.res) L.res.resolved = res.resolved;
  if (L.res) rememberLevels(L.res);
  L.extras = null;
  redraw();
  return true;
}

export function discardLogDelay() { L.extras = null; }

/* ----------------------------------- the generator ----------------------------------- */

function reportCard(cardFn, fieldNames) {
  if (L.schedState === 'unsupported') return h('div.banner.warn', 'This server does not build the log delay report yet (needs ElasticPro 0.3.57).');
  if (L.schedState === 'error') return h('div.banner.err', `The log delay report schedule could not be read: ${L.schedError}`);
  if (L.schedState !== 'ok') return h('div.tbl-empty', 'Reading the log delay report schedule…');
  const s = L.sched;
  const o = s.options || {};
  const ch = s.optionsChoices || {};
  const managed = new Set((s.managed || []).map((m) => String(m)));
  const locked = (k, env) => managed.has(k) || managed.has(env);
  const sel = (id, value, opts, label, lockKey) => {
    const el = h(`select#${id}`, { dataset: { label }, disabled: lockKey ? locked(...lockKey) : false }, ...opts.map(([v, t]) => h('option', { value: v }, t)));
    el.value = value;
    return el;
  };
  const checks = (prefix, chosen, all, labelOf) => h('span.ldc-checks', ...all.map((x) => h('label', h(`input#${prefix}-${x.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    { type: 'checkbox', checked: chosen.includes(x), dataset: { label: `${labelOf(x)}`, opt: x } }), labelOf(x))));
  const colLabel = (c) => (c === 'arrival' ? fieldNames.arrival : c === 'eventTime' ? fieldNames.event : COLUMN_LABEL[c] || c);
  const secLabel = (x) => (SECTION_LABEL[x] || x).replace('N hours', `${fieldNames.every} hours`);
  const all = clusters();
  const pickCl = s.clusters === 'all' || !Array.isArray(s.clusters) || s.clusters.length !== 1 ? 'all' : s.clusters[0];
  const when = WHEN_CHOICES.some(([v]) => v === s.schedule) ? s.schedule : 'daily';
  const runNow = async (btn) => {
    btn.disabled = true;
    const d = reportDraft(readReport());
    const r = await ldReportRun({ clusterIds: d.clusters === 'all' ? all.map((c) => c.id) : d.clusters, period: runPeriodFor(d.scheduleKind, d.period), options: d.options });
    btn.disabled = false;
    if (r && r.ok) { toast('The log delay report is building with these options: Reports › Exports & schedules has it.', 'ok', 6000); refreshReports(); }
    else toast(`Not started: ${(r && (r.message || r.kind)) || 'no answer'}`, 'err', 7000);
  };
  const sendNow = async (btn) => {
    btn.disabled = true;
    const r = await ldSendNow();
    btn.disabled = false;
    if (r && r.ok) { toast('Sending the log delay report now, with the saved settings.', 'ok', 6000); refreshReports(); }
    else toast(`Not sent: ${(r && (r.message || r.kind)) || 'no answer'}`, 'err', 7000);
  };
  return cardFn('ld-report', 'Log delay report', 'Log delay report generator', 'build a report, keep it as a schedule, mail it with its attachments',
    h('div.ldc-form#ldc-report',
      h('label.field', 'Send to', h('input#ldc-r-to', { type: 'text', value: (s.to || []).join(', '), placeholder: 'noc@example.com, ops-leads@example.com', dataset: { label: 'Send to' }, disabled: locked('to', 'UI_REPORT_LOGDELAY_TO') })),
      h('label.field', 'When', sel('ldc-r-when', when, WHEN_CHOICES, 'When', ['schedule', 'UI_REPORT_LOGDELAY_SCHEDULE'])),
      h('label.field', 'At (server time)', h('input#ldc-r-at', { type: 'time', value: s.at || '07:00', dataset: { label: 'At' }, disabled: locked('at', 'UI_REPORT_LOGDELAY_AT') })),
      h('label.field', 'Clusters', sel('ldc-r-clusters', pickCl, [['all', 'All clusters'], ...all.map((c) => [c.id, c.name])], 'Clusters')),
      h('label.field', 'Period', sel('ldc-r-period', PERIOD_CHOICES.some(([v]) => v === s.period) ? s.period : 'yesterday', PERIOD_CHOICES, 'Period')),
      h('span.ldc-checks', { style: { alignSelf: 'end' } }, h('label',
        h('input#ldc-r-enabled', { type: 'checkbox', checked: !!s.enabled, dataset: { label: 'Send on the schedule' } }), 'Send on the schedule')),
      h('div.field.ldc-span', h('span.muted', { style: { fontSize: '11px' } }, 'Sections'),
        checks('ldc-r-sec', o.sections || [], ch.sections || Object.keys(SECTION_LABEL), secLabel)),
      h('label.field', 'Devices', sel('ldc-r-devices', o.devices || 'delayed', (ch.devices || DEVICE_CHOICES.map(([v]) => v)).map((v) => [v, (DEVICE_CHOICES.find(([x]) => x === v) || [v, v])[1]]), 'Devices')),
      h('label.field', 'Group by', sel('ldc-r-group', o.groupBy || 'cluster', (ch.groupBy || ['cluster']).map((v) => [v, v === 'cluster' ? 'Cluster' : v]), 'Group by')),
      h('label.field', 'Top delayed rows', h('input#ldc-r-top', { type: 'number', min: '1', max: '100', value: String(o.top ?? 10), dataset: { label: 'Top delayed rows' } })),
      h('div.field.ldc-span', h('span.muted', { style: { fontSize: '11px' } }, 'Columns'),
        checks('ldc-r-col', o.columns || [], ch.columns || Object.keys(COLUMN_LABEL), colLabel),
        h('span.ldc-hint', 'Any field from the Fields card can be a column.')),
      h('div.field.ldc-span', h('span.muted', { style: { fontSize: '11px' } }, 'Attachments'),
        h('span.ldc-checks',
          h('label', h('input#ldc-r-xlsx', { type: 'checkbox', checked: o.xlsx !== false, dataset: { label: 'Excel (.xlsx)' } }), 'Excel (.xlsx) · one sheet per section'),
          h('label', h('input#ldc-r-csv', { type: 'checkbox', checked: o.csv !== false, dataset: { label: 'CSV of the device list' } }), 'CSV of the device list')),
        h('span.ldc-hint', 'Attached to the HTML mail. A PDF of the mail is not offered: this server has no PDF writer.')),
      h('div.ldc-span', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        h('button.btn#ldc-r-download', { type: 'button', onclick: (e) => runNow(e.currentTarget) }, 'Download now'),
        h('button.btn#ldc-r-send', { type: 'button', disabled: !s.mailConfigured || !(s.to || []).length,
          title: !s.mailConfigured ? 'The mail server is not set (Config-Management › Reports › Mail)' : !(s.to || []).length ? 'Save some recipients first' : 'Send it now with the saved settings',
          onclick: (e) => sendNow(e.currentTarget) }, 'Send now'),
        h('span.ldc-hint', 'Save keeps it as the schedule (the save bar). Download now builds it with what is on screen; Send now mails the saved one.'))));
}

/** The generator as typed. */
function readReport() {
  const ticked = (prefix) => [...document.querySelectorAll(`#ldc-report input[id^="${prefix}-"]`)].filter((x) => x.checked).map((x) => x.dataset.opt);
  return {
    enabled: on('ldc-r-enabled'), to: addressList(val('ldc-r-to')), schedule: val('ldc-r-when'), at: val('ldc-r-at'), period: val('ldc-r-period'),
    clusters: val('ldc-r-clusters') || 'all', sections: ticked('ldc-r-sec'), columns: ticked('ldc-r-col'),
    devices: val('ldc-r-devices'), groupBy: val('ldc-r-group'), top: num('ldc-r-top'), xlsx: on('ldc-r-xlsx'), csv: on('ldc-r-csv'),
    managed: (L.sched && L.sched.managed) || [], pdf: !!(L.sched && L.sched.options && L.sched.options.pdf),
  };
}

export async function saveReport() {
  if (!L.sched) return false;
  const d = reportDraft(readReport());
  if (d.problem) { toast(d.problem, 'warn', 6000); return false; }
  const res = await ldScheduleSet(d.schedule);
  if (!res || !res.ok) { toast(`Not saved: ${(res && (res.message || res.kind)) || 'refused'}`, 'err', 7000); return false; }
  L.sched = { ...L.sched, ...res, options: res.options || d.schedule.options, optionsChoices: res.optionsChoices || L.sched.optionsChoices };
  toast('Log delay report schedule saved', 'ok');
  redraw();
  return true;
}

/* ------------------------------------ the cards ------------------------------------ */

/**
 * The three cards. `cardFn(section, trackLabel, title, sub, body)` is the page's trackedCard.
 * Absent until the settings were read; an older core says so once.
 */
export function logDelayCards(cardFn, draw) {
  redraw = draw || redraw;
  if (L.state === 'unsupported') return [h('div.banner.warn', 'This server has no log delay settings yet (needs ElasticPro 0.3.57).')];
  if (L.state === 'error') return [h('div.banner.err', `The log delay settings could not be read: ${L.error}`)];
  if (L.state !== 'ok') return [h('div.tbl-empty', 'Reading the log delay settings…')];
  const first = ((L.res && L.res.resolved) || [])[0];
  const f = (L.res.settings && L.res.settings.fields) || {};
  const names = {
    arrival: f.arrival || (first && first.fields && first.fields.arrival) || '@timestamp',
    event: (Array.isArray(f.eventTime) && f.eventTime[0]) || (first && first.fields && first.fields.eventTime && first.fields.eventTime[0]) || 'event time',
    every: (L.res.schedule && L.res.schedule.everyHours) || 2,
  };
  return [levelsCard(cardFn), fieldsCard(cardFn), reportCard(cardFn, names)];
}
