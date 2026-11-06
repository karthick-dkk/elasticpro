/**
 * Reports › Exports & schedules (docs/REPORTS.md, board 5): the downloads, the mailed report
 * and the generated reports in one place. Every size in a file made here is event_logsize
 * (core/volume-daily.js); the storage plan files are the Capacity section's, the fleet
 * overview the Overview's — the same definitions, so a file and the screen cannot differ.
 *
 * The mailed report is the core's one schedule (REPORT_SCHEDULE_GET, admin only); it is
 * edited in Config › Reports as before. The generated reports are ui/report-jobs.js, as they
 * were under Indices › Summary › Monthly.
 */

import { h, mount } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { ago, toCsv, download, downloadBytes, plural } from '../lib/fmt.js';
import { card, empty } from '../pages/common.js';
import { toast } from '../ui/menu.js';
import { navigateTo } from '../core/intent.js';
import { workbook, XLSX_MIME } from '../lib/xlsx.js';
import { utcDay, volumeMonthlyAll, monthlyAllEventCsvRows, reportDailyCsvRows, REPORT_DAILY_CSV, toMs } from '../core/volume-daily.js';
import { reportScheduleGet, reportSendNow, lastSentText, failText, failLevel, refreshReports } from '../core/reports.js';
import { reportJobsMount, reportPanel, setReportPanelOpen, isAdmin } from '../ui/report-jobs.js';
import { recordOf, RATE_DAYS } from './record.js';
import { exportOverviewCsv, exportOverviewXlsx } from './overview.js';
import { storagePlanCsv, reportsOf, exportWide, exportTall, SHEET_VIEWS } from './capacity.js';
import { amber, tag } from './cells.js';
import { reportKindsCard, kindsReset } from './report-kinds.js';

const sched = { state: 'idle', reply: null, error: '' };
let openedOnce = false;
let redraw = () => {};

export function exportsReset() {
  Object.assign(sched, { state: 'idle', reply: null, error: '' });
  openedOnce = false;
  kindsReset();
}

async function loadSchedule() {
  if (!isAdmin() || sched.state !== 'idle') return;
  sched.state = 'loading';
  const res = await reportScheduleGet();
  if (res.unsupported) sched.state = 'unsupported';
  else if (!res.ok) { sched.state = 'error'; sched.error = res.message || res.kind || 'no answer'; }
  else { sched.state = 'ok'; sched.reply = res; }
  redraw();
}

const sheetFile = (name, headers, rows) => workbook([{ name, rows: [headers, ...rows.map((o) => headers.map((k) => o[k] ?? null))] }]);

function dailyRows(clusters) {
  const out = [];
  for (const c of clusters) {
    const r = recordOf(c.id);
    if (r) out.push(...reportDailyCsvRows(c.name, r, RATE_DAYS));
  }
  return out;
}

async function monthlyRows() {
  const res = await volumeMonthlyAll({ months: 13 });
  if (!res.ok) { toast(res.unsupported ? 'This server does not keep a monthly record yet.' : `The monthly record could not be read: ${res.message || res.kind}`, 'err', 6000); return null; }
  return monthlyAllEventCsvRows(res);
}

/**
 * The buttons read the clusters and the day when pressed (`cur`, utcDay()), not when drawn:
 * the card is kept between redraws while it reads the same, so what a button was built with
 * may be minutes old.
 */
let cur = { clusters: [] };
function downloads() {
  const tile = (title, text, buttons) => h('div.rp-dlc', h('b', title), h('span', text), h('div.rp-fmt', ...buttons));
  const btn = (label, onclick, id) => h('button.btn.sm', { type: 'button', id: id || null, onclick }, label);
  return card('Download now', `the figures on screen, for the clusters chosen above · every size is event_logsize`,
    h('div.rp-downloads',
      tile('Fleet overview', 'One line per cluster: event_logsize yesterday, 7-day average and month so far, data-node disk, runway, retention, backups.', [
        btn('CSV', () => exportOverviewCsv(cur), 'rp-x-overview-csv'),
        btn('XLSX', () => exportOverviewXlsx(cur), 'rp-x-overview-xlsx')]),
      tile('Daily record', 'One row per cluster and day: indices, documents, event_logsize, final or not.', [
        btn('CSV', () => download(`reports-daily-${utcDay()}.csv`, toCsv(dailyRows(cur.clusters), REPORT_DAILY_CSV), 'text/csv'), 'rp-x-daily-csv'),
        btn('XLSX', () => downloadBytes(`reports-daily-${utcDay()}.xlsx`, sheetFile('Daily record', REPORT_DAILY_CSV, dailyRows(cur.clusters)), XLSX_MIME), 'rp-x-daily-xlsx')]),
      tile('Monthly record', 'One row per cluster, a column per month of event_logsize; 13 months.', [
        btn('CSV', async () => { const m = await monthlyRows(); if (m) download(`reports-monthly-by-cluster-${utcDay()}.csv`, toCsv(m.rows, m.headers), 'text/csv'); }, 'rp-x-monthly-csv'),
        btn('XLSX', async () => { const m = await monthlyRows(); if (m) downloadBytes(`reports-monthly-by-cluster-${utcDay()}.xlsx`, sheetFile('Monthly record', m.headers, m.rows), XLSX_MIME); }, 'rp-x-monthly-xlsx')]),
      tile('Storage plan', `The plan as arranged on Capacity, every parameter (${SHEET_VIEWS.sheet.cols().length} columns), the client plan (${SHEET_VIEWS.client.cols().length}), or one row per parameter with a column per cluster.`, [
        btn('Plan CSV', () => { const p = storagePlanCsv(cur.clusters); download(`reports-storage-plan-${utcDay()}.csv`, toCsv(p.rows, p.headers), 'text/csv'); }, 'rp-x-plan-csv'),
        btn('Every parameter', () => exportWide(reportsOf(cur.clusters), SHEET_VIEWS.sheet)),
        btn('Client plan', () => exportWide(reportsOf(cur.clusters), SHEET_VIEWS.client)),
        btn('Report layout', () => exportTall(reportsOf(cur.clusters)))])));
}

const WHEN = { monthly: '1st of the month', weekly: 'Mondays', daily: 'Every day', manual: 'Only when sent by hand' };

function mailed() {
  const head = [h('button.btn.sm', { type: 'button', onclick: () => navigateTo('settings', { page: 'reports', tab: 'mail' }) }, 'Edit in Config-Management')];
  if (!isAdmin()) {
    return card('Mailed reports', 'an .xlsx attachment on a schedule', h('div.tbl-empty', 'Only an admin can see and change the mailed report.'));
  }
  loadSchedule();
  if (sched.state === 'unsupported') return card('Mailed reports', null, empty('This server does not send reports by mail yet.'));
  if (sched.state === 'error') return card('Mailed reports', null, empty('The mailed report could not be read.', { detail: h('span.mono', sched.error) }), head);
  if (sched.state !== 'ok') return card('Mailed reports', null, h('div.tbl-empty', 'Reading the mailed report…'), head);
  const s = sched.reply;
  const last = lastSentText(s.lastSent, (ms) => ago(ms));
  const to = Array.isArray(s.to) ? s.to : [];
  const clusters = s.clusters === 'all' || !s.clusters ? 'All clusters' : plural((s.clusters || []).length, 'cluster');
  const status = !s.enabled ? tag('off', 'grey')
    : last.ok === false ? tag('failed', 'red', last.text)
      : last.ok ? tag('sent', 'green', last.text) : tag('not sent yet', 'grey');
  const send = h('button.linkish', {
    type: 'button',
    onclick: async () => {
      const res = await reportSendNow();
      if (!res.ok) { toast(failText(res, 'Not sent'), failLevel(res), 6000); return; }
      toast('The mailed report is being built and sent in the background.', 'ok', 4000);
      refreshReports();
    },
  }, last.ok === false ? 'Retry' : 'Send now');
  const tr = h('tr',
    h('td', h('b', s.subject ? String(s.subject).replace('{period}', (s.nextPeriod && s.nextPeriod.label) || '…') : 'Volume report')),
    h('td', clusters),
    h('td', `${WHEN[s.schedule] || s.schedule || '—'}${s.schedule && s.schedule !== 'manual' ? `, ${s.at || '07:00'}` : ''}`),
    h('td', to.length ? `${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ''}` : amber('nobody', 'Add an address in Config-Management › Reports › Mail delivery')),
    h('td', s.lastSent && toMs(s.lastSent.at) ? ago(toMs(s.lastSent.at)) : '—'),
    h('td', status),
    h('td', send));
  return card('Mailed reports', `an .xlsx attachment on a schedule · ${s.mailConfigured === false ? 'the mail server is not set (Config-Management › Reports › Mail delivery)' : 'mail server set in Config-Management › Reports'}`,
    h('div.tbl-wrap', h('table.tbl',
      h('thead', h('tr', ...['Report', 'Clusters', 'When', 'To', 'Last sent', 'Status', ''].map((t) => h('th', t)))),
      h('tbody', tr))), head);
}

/**
 * The panel and its button are kept for the session (ui/report-jobs.js) and redraw their own
 * insides; so is the card that holds them. Built into a fresh card on every redraw, they were
 * taken out of the page and put back on each push from the core — the job rows and their Stop
 * buttons with them.
 */
let generatedCard = null;
function generated(ctx) {
  // The panel opens on the first visit: the list of jobs is what this card is for.
  if (!openedOnce) { openedOnce = true; setReportPanelOpen(true); }
  // The cluster shown first is ticked; More clients… lists the rest (ui/report-jobs.js).
  const panel = reportPanel(ctx.clusters[0] || null);
  const button = reportJobsMount();
  if (!generatedCard) generatedCard = card('Generated reports', 'larger reports built on the server; kept 7 days', panel, [button]);
  return generatedCard;
}

/** The section's cards, each the one on screen unless what it shows changed (lib/keyed.js). */
const built = nodeCache();
let sectionEl = null;

/** @param ctx { clusters, redraw } */
export function exportsSection(ctx) {
  redraw = ctx.redraw || redraw;
  cur = ctx;
  if (!sectionEl) sectionEl = h('div.rp-section');
  built.begin();
  mount(sectionEl, ...built.sameAll('rp-x', [downloads(), mailed(), reportKindsCard(ctx)]), generated(ctx));
  built.end();
  return sectionEl;
}
