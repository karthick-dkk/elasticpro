/**
 * Indices › Summary › Monthly › Generate report, and the list of report jobs (0.3.45).
 *
 * One job per client (a client is a cluster). The core queues them, runs a few at once and
 * keeps the files; this panel picks what to ask for and shows what the core says about each
 * job, from the one poller in core/reports.js that the top-bar pill also reads.
 *
 * The button and the panel are kept as the same two elements for the whole session. The
 * Summary view is rebuilt whenever one of its own choices changes, and the job list moves
 * every few seconds while something runs: rebuilding the panel with either would untick
 * what was being ticked and close a select under the pointer. So the Summary only places
 * these elements, and they redraw their own insides.
 */

import { h, mount } from '../lib/dom.js';
import { downloadBytes } from '../lib/fmt.js';
import { clusters, state } from '../core/state.js';
import { toast } from './menu.js';
import { confirmDialog } from './modal.js';
import {
  reports, onReports, refreshReports, startReportsPoll, failText, reportRun, reportStop, reportClear, reportDownload,
  reportConcurrencySet, reportScheduleGet, periodPresets, periodLabel, jobStatusText, jobPct, jobClient,
  countsText, sortJobs, isActive, isFinished, base64ToBytes,
} from '../core/reports.js';

const CONCURRENCY = [3, 4, 5];

/** Who may stop a job or change how many run at once: an admin, and the portable build (no accounts). */
export const isAdmin = () => !state.caller || state.caller.role === 'admin';
const callerName = () => (state.caller && state.caller.name) || null;

/** What is being asked for. Kept across redraws and visits, for the session. */
const form = { picked: null, period: null, format: 'xlsx', mail: false, more: false };
/** The cluster on screen: Indices is an evidence page, so the panel lists only this one until "More clients…". */
let openId = null;
/** The panel's own status line: what the last run said when it was refused. */
let status = null;
/** For an admin: what REPORT_SCHEDULE_GET says about where a job's mail goes. */
let mailInfo = { asked: false, ok: null, why: '' };

let open = false;
let mountEl = null;
let panelEl = null;
let formEl = null;
let listEl = null;
let headEl = null;
let concEl = null;
let footEl = null;
let clusterSig = '';
let statusEl = null;

/* --------------------------------- the button --------------------------------- */

/**
 * The toolbar's mount point (`#vol-report-jobs`): "Generate report", which opens and closes
 * the panel. Hidden while the core is known not to run reports.
 */
export function reportJobsMount() {
  if (!mountEl) {
    mountEl = h('span#vol-report-jobs.vs-jobs', { dataset: { mount: 'volume-report-jobs' } },
      h('button#rj-open.btn.sm', {
        type: 'button', 'aria-expanded': 'false', 'aria-controls': 'rj-panel',
        title: 'Make a report file for one or more clients, in the background',
        onclick: () => setReportPanelOpen(!open),
      }, 'Generate report'));
    onReports(syncButton);
  }
  startReportsPoll();
  syncButton();
  return mountEl;
}

function syncButton() {
  if (!mountEl) return;
  mountEl.hidden = reports.supported === false;
  const b = mountEl.firstChild;
  b.setAttribute('aria-expanded', String(open));
  b.setAttribute('aria-pressed', String(open));
}

/** Open (or close) the panel: the button, and the top-bar pill on its way here. */
export function setReportPanelOpen(on) {
  open = !!on;
  if (!open) { form.more = false; form.picked = new Set(openId ? [openId] : []); setStatus(null); if (formEl) renderForm(); }
  if (open) { renderForm(); askMailInfo(); refreshReports(); }
  if (panelEl) panelEl.hidden = !open;
  syncButton();
}

/* --------------------------------- the panel --------------------------------- */

/**
 * The panel, for the Monthly view to place under its toolbar. `c` is the cluster on screen,
 * ticked the first time the panel is drawn.
 */
export function reportPanel(c) {
  if (!panelEl) build();
  const id = c ? c.id : null;
  const moved = id !== openId;
  openId = id;
  if (form.picked === null || (moved && !form.more)) form.picked = new Set(id ? [id] : []);
  const sig = `${clusters().map((x) => x.id).join('\u0001')}|${id}`;
  if (sig !== clusterSig || moved) renderForm();
  panelEl.hidden = !open || reports.supported === false;
  return panelEl;
}

function build() {
  formEl = h('div.rj-form');
  concEl = h('select#rj-concurrency', {
    'aria-label': 'Jobs run at once',
    onchange: (e) => setConcurrency(e.target.value),
  }, ...CONCURRENCY.map((n) => h('option', { value: String(n) }, String(n))));
  headEl = h('span.rj-counts.muted');
  listEl = h('div.rj-list', { role: 'list' });
  footEl = h('div.rj-foot.muted');
  statusEl = h('div#rj-status.rj-status', { role: 'status', hidden: true });
  panelEl = h('section#rj-panel.card.rj-panel', { hidden: true },
    h('header', h('h2', 'Generate report'), h('span.sub', 'one job per client'),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
        h('button.btn.sm', { type: 'button', title: 'Close the panel; jobs keep running', onclick: () => setReportPanelOpen(false) }, 'Close'))),
    h('div.body.rj-body',
      formEl,
      statusEl,
      h('div.rj-jobs',
        h('div.rj-jobs-head',
          h('b', 'Report jobs'), headEl,
          h('label.rj-conc', 'Run at once', concEl)),
        listEl,
        h('div.rj-acts',
          h('button#rj-stop-all.btn.sm', { type: 'button', onclick: stopAll }, 'Stop all'),
          h('button#rj-clear.btn.sm', { type: 'button', onclick: clearFinished }, 'Clear finished')),
        footEl)));
  onReports(renderJobs);
  renderJobs();
}

/* ---------------------------------- the form ---------------------------------- */

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function runLabel() {
  return `Run report · ${plural(form.picked ? form.picked.size : 0, 'client')}`;
}

function syncRun() {
  const b = formEl && formEl.querySelector('#rj-run');
  if (b) { b.textContent = runLabel(); b.disabled = !form.picked || !form.picked.size; }
  const n = formEl && formEl.querySelector('#rj-picked');
  if (n) n.textContent = `${form.picked ? form.picked.size : 0} of ${shownClusters().length}`;
}

/**
 * The clusters the panel lists: only the open one, unless "More clients…" was pressed. The
 * Indices page is photographed as one client's evidence, so a panel that is open on it must
 * not list the others by default.
 */
function shownClusters() {
  const all = clusters();
  return form.more ? all : all.filter((x) => x.id === openId);
}

function setStatus(s) {
  status = s;
  if (!statusEl) return;
  statusEl.hidden = !s;
  statusEl.textContent = s ? s.text : '';
  statusEl.className = `rj-status${s && s.cls ? ` ${s.cls}` : ''}`;
}

function renderForm() {
  if (!formEl) return;
  const full = clusters();
  const list = shownClusters();
  clusterSig = `${full.map((x) => x.id).join('\u0001')}|${openId}`;
  if (!form.picked) form.picked = new Set();
  // A cluster no longer offered (config reloaded, visibility changed) is not asked for.
  for (const id of [...form.picked]) if (!list.some((x) => x.id === id)) form.picked.delete(id);
  if (!form.more && openId && list.some((x) => x.id === openId) && !form.picked.size) form.picked.add(openId);
  const presets = periodPresets();
  if (!form.period || !presets.some((p) => p.value === form.period)) form.period = presets[0].value;

  const box = (c) => h('label.rj-client', { title: c.name },
    h('input', {
      type: 'checkbox', checked: form.picked.has(c.id), value: c.id,
      onchange: (e) => { if (e.target.checked) form.picked.add(c.id); else form.picked.delete(c.id); syncRun(); },
    }),
    h('span', c.name));
  const all = (on) => { form.picked = new Set(on ? list.map((x) => x.id) : []); renderForm(); };

  const period = h('select#rj-period', { onchange: (e) => { form.period = e.target.value; } },
    ...presets.map((p) => h('option', { value: p.value }, p.label)));
  period.value = form.period;

  const fmt = (id, label, title) => h('button.btn.sm', {
    type: 'button', 'aria-pressed': String(form.format === id), title,
    onclick: () => { form.format = id; renderForm(); },
  }, label);

  const mailDisabled = mailInfo.ok === false;
  if (mailDisabled) form.mail = false;

  mount(formEl,
    h('div.rj-clients-head',
      h('b', 'Clients'), h('span#rj-picked.muted', `${form.picked.size} of ${list.length}`),
      form.more ? h('button.btn.sm', { type: 'button', onclick: () => all(true) }, 'Select all') : null,
      form.more ? h('button.btn.sm', { type: 'button', onclick: () => all(false) }, 'Clear') : null,
      form.more
        ? h('button#rj-fewer.btn.sm', { type: 'button', onclick: () => { form.more = false; form.picked = new Set(openId ? [openId] : []); renderForm(); } }, 'Fewer clients')
        : (full.length > 1 ? h('button#rj-more.btn.sm', { type: 'button', title: 'List every cluster to pick from', onclick: () => { form.more = true; renderForm(); } }, 'More clients…') : null)),
    list.length ? h('div.rj-clients', ...list.map(box)) : h('div.muted', 'No cluster to report on.'),
    h('div.rj-row',
      h('label.field', 'Period', period),
      h('div.field', h('span', 'Format'),
        h('div.seg', { role: 'group', 'aria-label': 'File format' },
          fmt('xlsx', '.xlsx', 'One workbook: Daily, Monthly and Breakdown sheets'),
          fmt('csvzip', '.csv (zip)', 'A zip of daily.csv, monthly.csv and breakdown.csv')))),
    h('label.rj-check', { title: mailDisabled ? mailInfo.why : 'Sent to the recipients an admin set under Config › Volume fields' },
      h('input#rj-mail', { type: 'checkbox', checked: form.mail, disabled: mailDisabled, onchange: (e) => { form.mail = e.target.checked; } }),
      h('span', 'Mail it to the report recipients (Config › Volume fields)',
        mailDisabled ? h('span.rj-why', ` · ${mailInfo.why}`) : null)),
    h('div.rj-row',
      h('button#rj-run.btn.sm.primary', { type: 'button', disabled: !form.picked.size, onclick: run }, runLabel())),
    h('div.muted.rj-note', 'One job per client. Jobs run in the background, so you can leave this page.'));
}

/**
 * Where "Mail it" sends: the mailed report's recipients, which only an admin sets and only
 * an admin may read. For an admin with nobody to send to, or no mail server, the box is
 * off and says why; anybody else keeps it, and a job that could not mail says so itself.
 */
async function askMailInfo() {
  if (mailInfo.asked || !isAdmin()) return;
  mailInfo.asked = true;
  const res = await reportScheduleGet();
  if (!res || !res.ok) return;
  const to = [...(res.to || []), ...(res.cc || []), ...(res.bcc || [])];
  if (res.mailConfigured === false) mailInfo = { asked: true, ok: false, why: 'set up Config › Volume fields › Mail server first' };
  else if (!to.length) mailInfo = { asked: true, ok: false, why: 'no report recipients are set (Config › Volume fields)' };
  else mailInfo = { asked: true, ok: true, why: '' };
  renderForm();
}

/** The schedule changed on the Config page: ask again next time the panel opens. */
export function forgetMailInfo() { mailInfo = { asked: false, ok: null, why: '' }; }

async function run() {
  const ids = [...(form.picked || [])];
  if (!ids.length) return;
  const b = formEl.querySelector('#rj-run');
  if (b) b.disabled = true;
  const res = await reportRun({ clusterIds: ids, period: form.period, format: form.format, mail: form.mail });
  syncRun();
  if (!res.ok) { setStatus({ text: failText(res, 'The report did not start'), cls: 'rj-bad' }); return; }
  setStatus(null);
  const n = (res.jobs || []).length;
  // Only clusters this person picked are named: the core's answer is not trusted to stay inside the ask.
  const refused = (res.refused || []).filter((r) => ids.includes(r.clusterId));
  if (n) toast(`${plural(n, 'report job')} queued for ${periodLabel(form.period)}`, 'ok', 4000, { key: 'report-run' });
  if (refused.length) {
    const name = (id) => (clusters().find((x) => x.id === id) || {}).name || id;
    toast(`Not queued: ${refused.map((r) => `${name(r.clusterId)} (${r.reason || 'refused'})`).join(', ')}`, 'warn', 9000);
  }
  refreshReports();
}

/* ----------------------------------- the jobs ----------------------------------- */

function renderJobs() {
  if (!listEl) return;
  const admin = isAdmin();
  const jobs = sortJobs(reports.jobs);
  headEl.textContent = countsText(reports);
  // Only an admin changes it; everybody sees it. Not reset while somebody has it open.
  if (document.activeElement !== concEl) concEl.value = String(reports.concurrency || 3);
  concEl.disabled = !admin;
  concEl.title = admin ? 'How many report jobs run at the same time' : 'Only an admin changes this';
  const stopAllBtn = panelEl.querySelector('#rj-stop-all');
  stopAllBtn.hidden = !admin;
  stopAllBtn.disabled = !jobs.some(isActive);
  panelEl.querySelector('#rj-clear').disabled = !jobs.some(isFinished);
  footEl.textContent = `At most ${reports.concurrency || 3} run together; the rest wait in the queue and start as slots free up. Only an admin can stop a job.`;
  if (!jobs.length) { mount(listEl, h('div.muted.rj-empty', 'No report jobs yet.')); return; }
  mount(listEl, ...jobs.map((j) => jobRow(j, jobs, admin)));
}

function jobRow(j, all, admin) {
  const pct = jobPct(j);
  const status = jobStatusText(j, all);
  const cls = j.status === 'failed' ? '.rj-bad' : j.status === 'done' ? '.rj-ok' : '';
  // Why a job failed, or who stopped it, is read in full; a file name may ellipsize (it is on hover).
  const wrap = j.status === 'failed' || j.status === 'stopped' ? '.rj-wrap' : '';
  const mine = admin || !j.by || j.by === callerName();
  let act = null;
  if (isActive(j)) {
    act = admin
      ? h('button.btn.sm.rj-stop', { type: 'button', disabled: !!j.stopping, onclick: () => stopOne(j) }, 'Stop')
      : h('span.muted.rj-adm', { title: 'Only an admin can stop a job' }, 'admin only');
  } else if (j.status === 'done' && j.file) {
    act = h('button.btn.sm.rj-dl', {
      type: 'button', disabled: !mine,
      title: mine ? `Save ${j.file.name}` : 'Only who started it, or an admin, can download it',
      onclick: (e) => download(j, e.currentTarget),
    }, 'Download');
  }
  return h('div.rj-job', { role: 'listitem', dataset: { job: String(j.id), status: String(j.status) } },
    h('span.rj-client-name', { title: jobClient(j) }, jobClient(j)),
    h('span.rj-period.muted', { title: periodLabel(j.period) }, periodLabel(j.period)),
    h(`span.rj-status${wrap}`,
      h(`span.rj-status-t${cls}`, { title: status }, status),
      j.status === 'running' && pct !== null
        ? h('span.rj-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
          h('i', { style: { width: `${pct}%` } }))
        : null),
    h('span.rj-act', act),
    j.warning ? h('div.rj-sub.rj-warn', String(j.warning)) : null,
    j.mailError ? h('div.rj-sub.rj-warn', `Not mailed: ${j.mailError}`) : null);
}

async function stopOne(j) {
  const res = await reportStop({ id: j.id });
  if (!res.ok) toast(`Not stopped: ${res.message || res.kind || 'refused'}`, 'err', 6000);
  refreshReports();
}

async function stopAll() {
  const n = (reports.jobs || []).filter(isActive).length;
  if (!n) return;
  const yes = await confirmDialog('Stop every report job?',
    `${plural(n, 'job')} running or waiting will end as stopped. Files already made are kept.`, { yes: 'stop all', danger: true });
  if (!yes) return;
  const res = await reportStop({ all: true });
  if (!res.ok) toast(`Not stopped: ${res.message || res.kind || 'refused'}`, 'err', 6000);
  refreshReports();
}

async function clearFinished() {
  const res = await reportClear();
  if (!res.ok) toast(`Not cleared: ${res.message || res.kind || 'refused'}`, 'err', 6000);
  refreshReports();
}

async function setConcurrency(n) {
  const res = await reportConcurrencySet(n);
  if (!res.ok) toast(`Not changed: ${res.message || res.kind || 'refused'}`, 'err', 6000);
  refreshReports();
}

/** REPORT_DOWNLOAD hands the file over as base64; saved as it came. */
export async function saveReportFile(id) {
  const res = await reportDownload(id);
  if (!res.ok) return res;
  downloadBytes(res.name || `report-${id}`, base64ToBytes(res.base64), res.mime || 'application/octet-stream');
  return res;
}

async function download(j, btn) {
  if (btn) btn.disabled = true;
  const res = await saveReportFile(j.id);
  if (btn) btn.disabled = false;
  if (!res.ok) toast(`Could not download: ${res.message || res.kind || 'refused'}`, 'err', 6000);
}
