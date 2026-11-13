/**
 * Jobs › Create job (docs/JOBS.md "Create a job"): a report once, now — exactly REPORT_RUN, a
 * duplicate of one of yours joins it — or a mailed schedule of its own, a job of its own
 * (`report.schedule.<id>`). JOB_CREATE either way.
 *
 * The choices are the report run's and the schedule editor's (core/reports.js periodPresets,
 * core/report-types.js runPeriods, SCHEDULE_PERIODS, the .rj-* cluster boxes of Reports ›
 * Exports); the checks are core/jobs.js createProblem, tested on their own. Nothing is sent
 * until the form passes them and the write unlock (core/writes.js) says yes.
 */

import { h, mount } from '../lib/dom.js';
import { plural } from '../lib/fmt.js';
import { clusters } from '../core/state.js';
import { jobControl } from '../core/es.js';
import { ensureWrites } from '../core/writes.js';
import { periodPresets } from '../core/reports.js';
import { runPeriods, SCHEDULE_PERIODS } from '../core/report-types.js';
import { CREATE_KINDS, CREATE_CADENCES, HOSTS_MAX, createProblem, createMessage, refusalText } from '../core/jobs.js';
import { modal } from './modal.js';

/** What was typed, kept for the session: a dialog closed by mistake opens as it was left. */
let form = null;

function freshForm() {
  const list = clusters();
  return {
    mode: 'once', report: 'volume', name: '', clusters: list.length ? [list[0].id] : [], allClusters: true,
    runPeriod: 'monthSoFar', format: 'xlsx', mail: false, collectAgain: false,
    schedule: 'daily', at: '07:00', schedPeriod: 'monthSoFar', to: '', cc: '', bcc: '', subject: '',
  };
}

/** The form as core/jobs.js reads it: the period of the mode chosen. */
const asked = (f) => ({ ...f, period: f.mode === 'once' ? f.runPeriod : f.schedPeriod });

/**
 * The dialog. Resolves with JOB_CREATE's answer (plus `mode`), or null when closed.
 */
export function openCreateJob() {
  if (!form) form = freshForm();
  const f = form;
  const body = h('div.jc-body');
  const draw = () => mount(body, ...fields(f, draw));
  draw();
  return modal('Create job', 'a report now, or a mailed schedule of its own', [body], (ctx) => [
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { type: 'button', onclick: () => ctx.done(null) }, 'Cancel'),
      h('button#jc-create.btn.primary', {
        type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;      // read now: it is null once the handler has awaited
          const problem = createProblem(asked(f));
          if (problem) { ctx.msg(problem); return; }
          if (!(await ensureWrites())) return;
          const msg = createMessage(asked(f));
          const res = await ctx.run(btn, () => jobControl(msg.type, msg));
          if (!res) return;
          if (res.ok === false) { ctx.msg(refusalText(res, { what: 'This report' })); return; }
          const mode = f.mode;
          form = null;             // made: the next one starts afresh
          ctx.done({ ...res, mode, name: msg.name || null });
        },
      }, 'Create')),
  ], { width: '640px', cls: 'jc-dialog' });
}

/** The answer of a JOB_CREATE as one line for the page. */
export function createdToast(res) {
  if (!res) return '';
  if (res.mode === 'once') {
    const n = (res.runIds || res.jobs || []).length;
    const joined = res.joined ? ' — the same report of yours was already queued, so it joined that one' : '';
    return `${plural(n, 'report job')} queued${joined}. The file is in Reports › Exports & schedules › Generated reports.`;
  }
  return `Schedule "${res.name || res.jobId}" created: it is a job of its own, listed below.`;
}

function fields(f, redraw) {
  const list = clusters();
  const once = f.mode === 'once';
  const seg = h('div.seg.jc-mode', { role: 'group', 'aria-label': 'What to create' },
    ...[['once', 'Run once now'], ['schedule', 'Recurring schedule']].map(([id, label]) => h('button.btn.sm', {
      type: 'button', id: `jc-mode-${id}`, 'aria-pressed': String(f.mode === id), onclick: () => { f.mode = id; redraw(); },
    }, label)));
  const kind = h('select#jc-report', { onchange: (e) => { f.report = e.target.value; redraw(); } },
    ...CREATE_KINDS.map(([v, l]) => h('option', { value: v }, l)));
  kind.value = f.report;

  // Clusters: the .rj-* boxes of the report run panel. A schedule may name every cluster.
  const capped = once && f.report === 'hosts';
  const full = capped && f.clusters.length >= HOSTS_MAX;
  const box = (c) => {
    const on = f.clusters.includes(c.id);
    const blocked = full && !on;
    return h('label.rj-client', { title: blocked ? `At most ${HOSTS_MAX} clusters at a time` : c.name },
      h('input', {
        type: 'checkbox', value: c.id, checked: on, disabled: blocked || (!once && f.allClusters),
        onchange: (e) => { f.clusters = e.target.checked ? [...f.clusters, c.id] : f.clusters.filter((x) => x !== c.id); redraw(); },
      }), h('span', c.name));
  };
  const clusterPart = h('div.jc-clusters',
    h('div.rj-clients-head', h('b', 'Clusters'),
      h('span.muted', capped ? `${f.clusters.length} of at most ${HOSTS_MAX}` : once || !f.allClusters ? `${f.clusters.length} of ${list.length}` : 'every cluster'),
      !once ? h('label.rj-check', h('input#jc-all', { type: 'checkbox', checked: f.allClusters, onchange: (e) => { f.allClusters = e.target.checked; redraw(); } }), h('span', 'All clusters')) : null),
    list.length ? h('div.rj-clients', ...list.map(box)) : h('div.muted', 'No cluster to report on.'));

  if (once) {
    const presets = runPeriods(periodPresets());
    if (!presets.some((p) => p.value === f.runPeriod)) f.runPeriod = presets[0].value;
    const period = h('select#jc-period', { onchange: (e) => { f.runPeriod = e.target.value; } }, ...presets.map((p) => h('option', { value: p.value }, p.label)));
    period.value = f.runPeriod;
    const fmt = (id, label) => h('button.btn.sm', { type: 'button', id: `jc-fmt-${id}`, 'aria-pressed': String(f.format === id), onclick: () => { f.format = id; redraw(); } }, label);
    return [seg,
      h('div.jc-grid', h('label.field', 'Report', kind), h('label.field', 'Period', period),
        h('div.field', h('span', 'Format'), h('div.seg', { role: 'group', 'aria-label': 'File format' }, fmt('xlsx', '.xlsx'), fmt('csvzip', '.csv (zip)')))),
      clusterPart,
      f.report === 'hosts' ? h('label.rj-check', h('input#jc-again', { type: 'checkbox', checked: f.collectAgain, onchange: (e) => { f.collectAgain = e.target.checked; } }),
        h('span', 'Collect again (re-ask days already held)')) : null,
      h('label.rj-check', h('input#jc-mail', { type: 'checkbox', checked: f.mail, onchange: (e) => { f.mail = e.target.checked; } }),
        h('span', 'Mail it to the report\'s recipients')),
      h('div.muted.jc-note', f.report === 'volume' ? 'One job per cluster, in the background. The same report of yours already queued is joined, not run twice.'
        : 'One job for the picked clusters, in the background. The same report of yours already queued is joined, not run twice.')];
  }
  const text = (id, key, o = {}) => h('input', {
    id, type: o.type || 'text', value: f[key] ?? '', placeholder: o.placeholder || null, autocomplete: 'off', spellcheck: false,
    oninput: (e) => { f[key] = e.target.value; },
  });
  const cadence = h('select#jc-schedule', { onchange: (e) => { f.schedule = e.target.value; } }, ...CREATE_CADENCES.map(([v, l]) => h('option', { value: v }, l)));
  cadence.value = f.schedule;
  const periods = f.report === 'volume' ? SCHEDULE_PERIODS : SCHEDULE_PERIODS.slice(0, 2);
  if (!periods.some(([v]) => v === f.schedPeriod)) f.schedPeriod = periods[0][0];
  const period = h('select#jc-speriod', { onchange: (e) => { f.schedPeriod = e.target.value; } }, ...periods.map(([v, l]) => h('option', { value: v }, l)));
  period.value = f.schedPeriod;
  return [seg,
    h('div.jc-grid',
      h('label.field.jc-wide', 'Name', text('jc-name', 'name', { placeholder: 'Monthly volume for the Frankfurt team' })),
      h('label.field', 'Report', kind), h('label.field', 'When', cadence),
      h('label.field', 'At (server time)', text('jc-at', 'at', { type: 'time' })), h('label.field', 'Period', period),
      h('label.field.jc-wide', 'Send to', text('jc-to', 'to', { placeholder: 'ops@example.com, lead@example.com' })),
      h('label.field', 'Cc', text('jc-cc', 'cc')), h('label.field', 'Bcc', text('jc-bcc', 'bcc')),
      h('label.field.jc-wide', 'Subject (optional)', text('jc-subject', 'subject', { placeholder: 'ElasticPro report · {period}' }))),
    clusterPart,
    h('div.muted.jc-note', 'An .xlsx attachment, sent by the report worker. The built-in schedule of each report (Reports › Exports & schedules) is not changed; '
      + `${f.report === 'log_delay' ? 'a created log delay schedule uses the report\'s default options. ' : ''}A period whose time has already passed today counts as handled.`)];
}
