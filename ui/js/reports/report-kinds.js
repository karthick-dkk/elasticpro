/**
 * Reports › Exports & schedules › "Report types" (0.3.54, docs/REPORT-TYPES.md): Volume
 * report, Indices report and Volume by host, each with its schedule and its Run now. The
 * message shapes are core/report-types.js's; nothing here knows a field name of the core.
 *
 * Typed values live in `K[kind].form`, so switching kind or redrawing for an answer never
 * throws away what was typed. Only an admin may read or change schedules.
 */

import { h } from '../lib/dom.js';
import { ago, dt, plural } from '../lib/fmt.js';
import { toast } from '../ui/menu.js';
import { card } from '../pages/common.js';
import { clusters } from '../core/state.js';
import { MANAGED_NOTE } from '../core/managed.js';
import { toMs } from '../core/volume-daily.js';
import { periodPresets, periodLabel, addressList, lastSentText, failText, refreshReports } from '../core/reports.js';
import {
  KINDS, kindOf, CADENCES, SCHEDULE_PERIODS, HOSTS_MAX_CLUSTERS, runPeriods, scheduleOf, kindScheduleGet, kindScheduleSet,
  kindSendNow, kindRun, runProblem, runFailText, isWorkerRefusal,
} from '../core/report-types.js';
import { isAdmin, forgetMailInfo } from '../ui/report-jobs.js';

const ui = { kind: 'volume' };
/** Per kind: the schedule as read, the form being typed, the Run now choices, the note line. */
const K = {};
const slot = (kind) => K[kind] || (K[kind] = {
  state: 'idle', error: '', sched: null, form: null,
  run: { picked: null, period: 'monthSoFar', format: 'xlsx', mail: false, collectAgain: false },
  note: null,
});
let redraw = () => {};

export function kindsReset() {
  for (const k of Object.keys(K)) delete K[k];
  ui.kind = 'volume';
}

async function load(kind) {
  const s = slot(kind);
  if (!isAdmin() || s.state !== 'idle') return;
  s.state = 'loading';
  const res = await kindScheduleGet(kind);
  if (res.unsupported || (!res.ok && res.kind === 'bad_message')) s.state = 'unsupported';
  else if (!res.ok) { s.state = 'error'; s.error = res.message || res.kind || 'no answer'; }
  else { s.state = 'ok'; s.sched = scheduleOf(kind, res); s.form = null; }
  redraw();
}

/** A labelled input, locked with the usual reason when config.txt manages it. */
function field(s, key, label, input) {
  if (s.managed.has(key)) { input.disabled = true; input.title = MANAGED_NOTE; }
  return h('div', h('label.field', label, input), s.managed.has(key) ? h('div.rm-managed.muted', MANAGED_NOTE) : null);
}

function formOf(kind, s) {
  const sl = slot(kind);
  if (!sl.form) {
    sl.form = {
      enabled: s.enabled, to: s.to.join(', '), cc: s.cc.join(', '), bcc: s.bcc.join(', '),
      schedule: s.schedule, at: s.at, period: s.period,
      clusters: s.clusters === 'all' || s.clusters.length !== 1 ? 'all' : s.clusters[0],
      subject: s.subject,
    };
  }
  return sl.form;
}

function schedulePart(kind) {
  const sl = slot(kind);
  const k = kindOf(kind);
  if (!isAdmin()) return h('div.tbl-empty', 'Only an admin can see and change the schedules.');
  load(kind);
  if (sl.state === 'unsupported') return h('div.banner.warn.rm-banner', 'This server does not send this report yet (needs ElasticPro 0.3.54).');
  if (sl.state === 'error') return h('div.banner.err.rm-banner', `The schedule could not be read: ${sl.error}`);
  if (sl.state !== 'ok') return h('div.tbl-empty', 'Reading the schedule…');
  const s = sl.sched;
  const f = formOf(kind, s);
  const text = (key, o = {}) => h('input', {
    id: `rt-${kind}-${key}`, type: o.type || 'text', value: f[key] ?? '', placeholder: o.placeholder || null,
    oninput: (e) => { f[key] = e.target.value; },
  });
  const sel = (key, options) => {
    const el = h('select', { id: `rt-${kind}-${key}`, onchange: (e) => { f[key] = e.target.value; } },
      ...options.map(([v, l]) => h('option', { value: v }, l)));
    el.value = f[key];
    return el;
  };
  const list = clusters();
  const on = h('input', { id: `rt-${kind}-enabled`, type: 'checkbox', checked: !!f.enabled, onchange: (e) => { f.enabled = e.target.checked; } });
  const last = lastSentText(s.lastSent, (ms) => ago(ms));
  const next = toMs(s.nextSendAt);
  const status = h('div.rm-status', { id: `rt-${kind}-status` },
    h(`span${last.ok === false ? '.rm-bad' : last.ok ? '.rm-ok' : '.muted'}`, last.text),
    next !== null ? h('span.muted', ` · next send ${dt(next)}`) : null,
    s.mailConfigured === false ? h('span.rm-bad', ' · set up the Mail server in Config › Reports first') : null);
  // Role core (docs/WORKER.md): the report worker runs schedules, collections and jobs. When it
  // is not up, say so in amber with its last heartbeat; monitoring is not affected.
  const w = s.worker;
  const worker = w && !w.ok ? h('div.rt-worker.rj-warn', { id: `rt-${kind}-worker` },
    w.text || 'The report worker is not running: reports and collection resume when it is back.',
    w.heartbeatAt !== null ? ` Last heartbeat ${ago(w.heartbeatAt)}.` : ' No heartbeat seen.') : null;
  // Volume by host: the daily collection's settings (config.txt), one line; unknown ones are left out.
  const cfg = kind === 'hosts' && Array.isArray(s.config) ? s.config.filter((r) => r.known && ['collectAt', 'keepMonths', 'maxPages', 'fields'].includes(r.key)) : [];
  const collection = cfg.length ? h('div.muted.rt-collect', { id: 'rt-hosts-collection', style: { fontSize: '11.5px' } },
    'Collection: ', cfg.map((r) => `${r.label.toLowerCase()} ${r.value}${r.locked ? ' (config.txt)' : ''}`).join(' · ')) : null;
  return h('div.rm-body',
    h('label.rm-on', on, h('b', ' On'),
      h('span.muted', ` · off until an admin turns it on with recipients${kind === 'hosts' ? '; the daily collection runs whether or not the mail is on' : ''}`)),
    h('div.rm-grid',
      h('div.rm-wide', field(s, 'to', 'Send to', text('to', { placeholder: 'ops@example.com, lead@example.com' }))),
      field(s, 'cc', 'Cc', text('cc')), field(s, 'bcc', 'Bcc', text('bcc')),
      field(s, 'schedule', 'When', sel('schedule', CADENCES)),
      field(s, 'at', 'At (server time)', text('at', { type: 'time' })),
      field(s, 'period', 'Period', sel('period', kind === 'volume' ? SCHEDULE_PERIODS : SCHEDULE_PERIODS.slice(0, 2))),
      field(s, 'clusters', 'Clusters', sel('clusters', [['all', 'All clusters'], ...list.map((c) => [c.id, c.name])])),
      h('div.rm-wide', field(s, 'subject', 'Subject', text('subject', { placeholder: `ElasticPro ${k.label.toLowerCase()} · {period}` })))),
    h('div.rm-acts',
      h('button.btn.sm.primary', { id: `rt-${kind}-save`, type: 'button', onclick: () => save(kind) }, 'Save'),
      h('button.btn.sm', { id: `rt-${kind}-send`, type: 'button', title: 'Send it now with the saved settings, as a background job', onclick: () => sendNow(kind) },
        last.ok === false ? 'Retry send' : 'Send now'),
      status),
    worker, collection);
}

function readForm(kind) {
  const sl = slot(kind);
  const f = formOf(kind, sl.sched);
  const out = {
    enabled: !!f.enabled, to: addressList(f.to), cc: addressList(f.cc), bcc: addressList(f.bcc),
    schedule: f.schedule, at: f.at || kindOf(kind).defaults.at, period: f.period,
    clusters: f.clusters && f.clusters !== 'all' ? [f.clusters] : 'all',
    subject: f.subject,
  };
  // The Volume report's sheets are chosen in Config › Reports; they go back as they were.
  if (kind === 'volume' && sl.sched.sheets) out.sheets = sl.sched.sheets;
  for (const m of sl.sched.managed) delete out[m];
  return out;
}

function setNote(kind, text, cls = 'banner') {
  slot(kind).note = { text, cls };
  redraw();
}

async function save(kind) {
  const sl = slot(kind);
  const v = readForm(kind);
  const to = v.to ?? sl.sched.to;
  if (v.enabled && !to.length) { setNote(kind, 'Add at least one address to Send to, or turn the report off.', 'banner err'); return; }
  if (v.at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.at)) { setNote(kind, 'At must be a time like 08:00.', 'banner err'); return; }
  const res = await kindScheduleSet(kind, v);
  if (!res.ok) { setNote(kind, `Not saved: ${res.message || res.kind || 'refused'}`, 'banner err'); return; }
  // What is in force now (next send, locked values) is the core's to say.
  const back = await kindScheduleGet(kind);
  if (back.ok) { sl.sched = scheduleOf(kind, back); sl.form = null; }
  forgetMailInfo();
  toast(`${kindOf(kind).label} schedule saved`, 'ok', 4000);
  setNote(kind, 'Saved.');
}

async function sendNow(kind) {
  const res = await kindSendNow(kind);
  if (!res.ok) { setNote(kind, failText(res, 'Not sent'), isWorkerRefusal(res) ? 'banner warn' : 'banner err'); return; }
  refreshReports();
  setNote(kind, `${kindOf(kind).label} is running as a background job, with the saved settings.`);
}

/* ---------------------------------- Run now ---------------------------------- */

function runPart(kind) {
  const sl = slot(kind);
  const r = sl.run;
  const list = clusters();
  if (!r.picked) r.picked = new Set(list.length ? [list[0].id] : []);
  for (const id of [...r.picked]) if (!list.some((c) => c.id === id)) r.picked.delete(id);
  const capped = kind === 'hosts';
  const full = capped && r.picked.size >= HOSTS_MAX_CLUSTERS;
  const presets = runPeriods(periodPresets());
  if (!presets.some((p) => p.value === r.period)) r.period = presets[0].value;
  const box = (c) => {
    const on = r.picked.has(c.id);
    const blocked = full && !on;
    return h('label.rj-client', { title: blocked ? `At most ${HOSTS_MAX_CLUSTERS} clusters at a time; untick one to pick ${c.name}` : c.name },
      h('input', {
        type: 'checkbox', value: c.id, checked: on, disabled: blocked,
        onchange: (e) => { if (e.target.checked) r.picked.add(c.id); else r.picked.delete(c.id); redraw(); },
      }),
      h('span', c.name));
  };
  const period = h('select', { id: `rt-${kind}-run-period`, onchange: (e) => { r.period = e.target.value; } },
    ...presets.map((p) => h('option', { value: p.value }, p.label)));
  period.value = r.period;
  const fmt = (id, label) => h('button.btn.sm', { type: 'button', 'aria-pressed': String(r.format === id), onclick: () => { r.format = id; redraw(); } }, label);
  const problem = runProblem(kind, [...r.picked]);
  return h('div.rj-form.rt-run',
    h('div.rj-clients-head', h('b', 'Run now'),
      h('span.muted', capped ? `${r.picked.size} of at most ${HOSTS_MAX_CLUSTERS}` : `${r.picked.size} of ${list.length}`),
      full ? h('span.rj-why', ` · ${HOSTS_MAX_CLUSTERS} is the most: untick one to pick another`) : null),
    list.length ? h('div.rj-clients', ...list.map(box)) : h('div.muted', 'No cluster to report on.'),
    h('div.rj-row',
      h('label.field', 'Period', period),
      h('div.field', h('span', 'Format'),
        h('div.seg', { role: 'group', 'aria-label': 'File format' }, fmt('xlsx', '.xlsx'), fmt('csvzip', '.csv (zip)')))),
    capped ? h('label.rj-check', { title: 'Ask Elasticsearch again for days already held, instead of reading the kept copy' },
      h('input', { id: 'rt-hosts-again', type: 'checkbox', checked: r.collectAgain, onchange: (e) => { r.collectAgain = e.target.checked; } }),
      h('span', 'Collect again (re-ask days already held)')) : null,
    h('label.rj-check', { title: 'Sent to the recipients saved in the schedule' },
      h('input', { id: `rt-${kind}-run-mail`, type: 'checkbox', checked: r.mail, onchange: (e) => { r.mail = e.target.checked; } }),
      h('span', 'Mail it')),
    h('div.rj-row',
      h('button.btn.sm.primary', { id: `rt-${kind}-run`, type: 'button', disabled: !!problem, title: problem || '', onclick: () => run(kind) },
        `Run now · ${plural(r.picked.size, 'cluster')}`)),
    h('div.muted.rj-note', kind === 'hosts'
      ? 'One job for the picked clusters: days not yet held are collected first, then one file is built. It runs in the background; the file is in Generated reports.'
      : kind === 'indices'
        ? 'One job and one file for the picked clusters. It runs in the background; the file is in Generated reports.'
        : 'One job per cluster. Jobs run in the background; the file is in Generated reports.'));
}

async function run(kind) {
  const r = slot(kind).run;
  const ids = [...r.picked];
  const problem = runProblem(kind, ids);
  if (problem) { toast(problem, 'warn'); return; }
  const res = await kindRun(kind, { clusterIds: ids, period: r.period, format: r.format, mail: r.mail, collectAgain: r.collectAgain });
  if (!res.ok) {
    // too_many_clusters: refused whole, nothing queued; said as the core says it. The worker
    // not running (or a different version) is amber: nothing is wrong with the ask.
    setNote(kind, runFailText(res) || failText(res, 'Not started'), isWorkerRefusal(res) ? 'banner warn' : 'banner err');
    return;
  }
  refreshReports();
  const n = (res.jobs || []).length;
  const refused = (res.refused || []).filter((x) => ids.includes(x.clusterId));
  toast(`${plural(n, 'report job')} queued for ${periodLabel(r.period) || r.period}${refused.length ? `, ${refused.length} refused` : ''}`, refused.length ? 'warn' : 'ok', 5000);
  setNote(kind, `${plural(n, 'job')} queued. The file is in Generated reports.`);
}

/* ---------------------------------- the card ---------------------------------- */

/** @param ctx {redraw} */
export function reportKindsCard(ctx) {
  redraw = ctx.redraw || redraw;
  const kind = ui.kind;
  const k = kindOf(kind);
  const tabs = h('div.seg.rt-tabs', { role: 'group', 'aria-label': 'Report type' },
    ...KINDS.map((x) => h('button.btn.sm', {
      type: 'button', id: `rt-tab-${x.id}`, dataset: { kind: x.id }, 'aria-pressed': String(x.id === kind),
      onclick: () => { ui.kind = x.id; redraw(); },
    }, x.label)));
  const n = slot(kind).note;
  return card('Report types', 'mailed on a schedule, or run by hand',
    h('div.rt', { dataset: { kind } },
      tabs,
      h('div.muted.rt-sizes', { id: 'rt-sizes' }, k.sizes),
      h('div.rt-body', h('div.rt-sched', schedulePart(kind)), runPart(kind)),
      n ? h('div', { id: 'rt-note', class: `${n.cls} rm-banner` }, n.text) : null));
}
