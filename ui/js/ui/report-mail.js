/**
 * Config › Volume fields › "Volume report by mail" and "Mail server (SMTP)" (0.3.45).
 *
 * Both are the server's settings, not the clusters file's: the mailed report lives in
 * `<data>/report-schedule.json` and the mail server in `<data>/mail.json`, and only an
 * admin may read or change either (docs/VOLUME.md "Reports and mail"). Anybody else sees
 * a note saying so and nothing is asked.
 *
 * A field config.txt sets (UI_SMTP_*, UI_REPORT_*) is locked here with the usual "managed
 * by config.txt" and left out of what Save sends: the core refuses a changed managed
 * field, and an unchanged one has nothing to say. The password is never sent back by the
 * core and is sent by this form only when somebody typed one; empty keeps what is stored.
 *
 * After the first load nothing here redraws the section: a save, a test or a started job
 * changes its own status or note line in place. A redraw would throw away whatever is
 * typed in the other panel, and in the Volume fields form above both.
 */

import { h, $, mount } from '../lib/dom.js';
import { ago, dt } from '../lib/fmt.js';
import { clusters } from '../core/state.js';
import { card } from '../pages/common.js';
import { field, text, select, checkbox } from './modal.js';
import { toast } from './menu.js';
import { MANAGED_NOTE } from '../core/managed.js';
import { toMs } from '../core/volume-daily.js';
import {
  REPORTS_NEEDS, mailSettingsGet, mailSettingsSet, mailTest, reportScheduleGet, reportScheduleSet, reportSendNow,
  reportRun, refreshReports, openReportJobs, settingsOf, managedFields, mailConfigTxtLines, lastSentText, stepText,
  addressList, schedulePeriod, periodLabel,
} from '../core/reports.js';
import { isAdmin, forgetMailInfo } from './report-jobs.js';

const SCHEDULES = [
  ['monthly', 'Monthly · 1st of the month'], ['weekly', 'Weekly · Monday'],
  ['daily', 'Daily · after collection'], ['manual', 'Only when sent by hand'],
];
const SECURITY = [['starttls', 'STARTTLS (587)'], ['tls', 'SSL/TLS (465)'], ['none', 'None (25, internal relay only)']];
const PORT_FOR = { starttls: 587, tls: 465, none: 25 };
const AUTH = [['password', 'Username and password'], ['none', 'No sign-in']];
const SHEETS = [['daily', 'Daily'], ['monthly', 'Monthly'], ['breakdown', 'Breakdown']];
const SUBJECT = 'ElasticPro volume report · {period}';

/** What the core said. Survives the Config page's redraws. */
const rm = {
  state: 'idle',            // idle | loading | ok | unsupported | error
  error: '',
  mail: null, mailManaged: new Set(),
  sched: null, schedManaged: new Set(),
};

/**
 * Ask both settings (admin only), once per visit to the section. `redraw` draws the section
 * again with the answer; it is the only redraw this module asks for.
 */
export async function loadReportMail(redraw) {
  if (!isAdmin()) return;
  rm.state = 'loading';
  const [m, s] = await Promise.all([mailSettingsGet(), reportScheduleGet()]);
  if (m.unsupported || s.unsupported) {
    rm.state = 'unsupported';
  } else if (!m.ok || !s.ok) {
    rm.state = 'error';
    rm.error = (!m.ok ? m.message : s.message) || 'no answer';
  } else {
    rm.state = 'ok';
    rm.mail = settingsOf(m);
    rm.mailManaged = managedFields(m.managed);
    rm.sched = settingsOf(s);
    rm.schedManaged = managedFields(s.managed);
  }
  if (redraw) redraw();
}

/** The config.txt lines for the "Hosted: config.txt keys" card, with what is set now. */
export function reportMailKeyLines() {
  return mailConfigTxtLines(rm.mail, rm.sched);
}

/** Both panels, stacked, for the Volume fields section. */
export function reportMailPanels() {
  return h('div.rm-panels', scheduleCard(), mailCard());
}

/* ------------------------------- shared pieces ------------------------------- */

const val = (id) => { const el = $(`#${id}`); return el ? el.value.trim() : ''; };
const isChecked = (id) => { const el = $(`#${id}`); return !!(el && el.checked); };

/** A locked field: disabled, says why on hover and underneath. */
function lockIf(managed, key, input) {
  if (!managed.has(key)) return input;
  const el = input.matches('input,select') ? input : input.querySelector('input,select');
  if (el) { el.disabled = true; el.title = MANAGED_NOTE; }
  return input;
}
const lockNote = (managed, key) => (managed.has(key) ? h('div.rm-managed.muted', MANAGED_NOTE) : null);
const cell = (managed, key, label, input, hint, wide) =>
  h(`div${wide ? '.rm-wide' : ''}`, field(label, lockIf(managed, key, input), hint), lockNote(managed, key));

function gate(title, sub, what, body, actions) {
  if (!isAdmin()) return card(title, sub, h('div.muted.rm-ro', `Only an ElasticPro admin ${what}.`));
  if (rm.state === 'unsupported') {
    return card(title, sub, h('div.banner.warn.rm-banner', `This server does not send volume reports yet (needs ElasticPro ${REPORTS_NEEDS}).`));
  }
  if (rm.state === 'error') return card(title, sub, h('div.banner.err.rm-banner', `Could not read the settings: ${rm.error}`));
  if (rm.state !== 'ok') return card(title, sub, h('div.muted.rm-ro', 'Reading the settings…'));
  return card(title, sub, body(), actions);
}

/** A panel's note line; `open` adds the way to the job list. */
function noteLine(n) {
  if (!n) return null;
  return h('div', { class: `${n.cls} rm-banner` }, n.text,
    n.open ? [' ', h('button.btn.sm', { type: 'button', onclick: () => openReportJobs() }, 'Open report jobs')] : null);
}
function setNote(id, n) {
  const el = $(`#${id}`);
  if (el) mount(el, noteLine(n));
  if (n && n.cls.includes('err')) toast(n.text, 'err', 7000);
}

/* --------------------------- Volume report by mail --------------------------- */

function scheduleCard() {
  return gate('Volume report by mail', 'sends an .xlsx attachment', 'sets up mailed reports', scheduleBody,
    [h('button#rm-save.btn.sm.primary', { type: 'button', onclick: saveSchedule }, 'Save')]);
}

function scheduleBody() {
  const s = rm.sched || {};
  const M = rm.schedManaged;
  const list = clusters();
  const pick = Array.isArray(s.clusters) && s.clusters.length === 1 ? s.clusters[0] : 'all';
  const sheets = new Set(Array.isArray(s.sheets) && s.sheets.length ? s.sheets : SHEETS.map((x) => x[0]));
  const lines = (x) => (Array.isArray(x) ? x.join(', ') : String(x || ''));

  return h('div.rm-body',
    h('div.rm-on', checkbox('rm-enabled', 'On', !!s.enabled),
      h('span.muted', 'Mailed at the time below, on the server\'s clock. Off: nothing is sent unless somebody presses Send report now.')),
    h('div.rm-grid',
      cell(M, 'to', 'Send to', text('rm-to', lines(s.to), { placeholder: 'ops@example.com, lead@example.com' }),
        'Comma-separated. Cc and Bcc work the same way.', true),
      cell(M, 'cc', 'Cc', text('rm-cc', lines(s.cc))),
      cell(M, 'bcc', 'Bcc', text('rm-bcc', lines(s.bcc))),
      cell(M, 'schedule', 'When', select('rm-when', s.schedule || 'monthly', SCHEDULES)),
      cell(M, 'at', 'At (server time)', h('input.mono', { id: 'rm-at', type: 'time', value: s.at || '07:00' })),
      cell(M, 'clusters', 'Clusters', select('rm-clusters', pick,
        [['all', 'All clusters · one sheet set each'], ...list.map((c) => [c.id, c.name])])),
      cell(M, 'subject', 'Subject', text('rm-subject', s.subject || SUBJECT, { placeholder: SUBJECT }),
        '{period} becomes the period the report covers.', true)),
    h('div.rm-sheets', { role: 'group', 'aria-label': 'Sheets' },
      h('span.rm-lab', 'Sheets'),
      ...SHEETS.map(([k, label]) => lockIf(M, 'sheets', checkbox(`rm-sheet-${k}`, label, sheets.has(k)))),
      lockNote(M, 'sheets')),
    h('div.muted.rm-note', 'Each sheet uses the columns, names and order set on Indices › Summary. The mail body holds the key figures: yesterday, average per day, month so far.'),
    h('div.rm-acts',
      h('button#rm-send-now.btn.sm', { type: 'button', title: 'Mail the report now with the saved settings, as a background job', onclick: sendNow }, 'Send report now'),
      h('button#rm-download.btn.sm', { type: 'button', title: 'Make the same .xlsx as a report job, to download from the job list', onclick: downloadXlsx }, 'Download .xlsx'),
      scheduleStatus(s)),
    h('div#rm-note'));
}

/** "✓ last sent 2 h ago to 3 addresses · next send …", and what would stop it sending. */
function scheduleStatus(s) {
  const last = lastSentText(s.lastSent, (ms) => ago(ms));
  const next = toMs(s.nextSendAt);
  return h('div#rm-status.rm-status',
    h(`span${last.ok === false ? '.rm-bad' : last.ok ? '.rm-ok' : '.muted'}`, last.text),
    next !== null ? h('span.muted', ` · next send ${dt(next)}`) : null,
    s.mailConfigured === false ? h('span.rm-bad', ' · set up the Mail server below first') : null);
}

function readSchedule() {
  const out = {
    enabled: isChecked('rm-enabled'),
    to: addressList(val('rm-to')), cc: addressList(val('rm-cc')), bcc: addressList(val('rm-bcc')),
    schedule: val('rm-when') || 'monthly',
    at: val('rm-at') || '07:00',
    clusters: val('rm-clusters') && val('rm-clusters') !== 'all' ? [val('rm-clusters')] : 'all',
    subject: val('rm-subject') || SUBJECT,
    sheets: SHEETS.map(([k]) => k).filter((k) => isChecked(`rm-sheet-${k}`)),
  };
  for (const k of rm.schedManaged) delete out[k];
  return out;
}

function scheduleProblems(v) {
  const p = [];
  const to = v.to ?? addressList((rm.sched || {}).to);
  if (v.enabled && !to.length) p.push('Add at least one address to Send to, or turn the report off.');
  if (v.sheets && !v.sheets.length) p.push('Pick at least one sheet.');
  if (v.at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.at)) p.push('At must be a time like 07:00.');
  return p;
}

async function saveSchedule() {
  const v = readSchedule();
  const problems = scheduleProblems(v);
  if (problems.length) { setNote('rm-note', { text: problems.join(' '), cls: 'banner err' }); return; }
  const res = await reportScheduleSet(v);
  if (!res.ok) { setNote('rm-note', { text: `Not saved: ${res.message || res.kind || 'refused'}`, cls: 'banner err' }); return; }
  // What is in force now (next send, managed values) is the core's to say: read it back
  // into the model and change only the status line.
  const back = await reportScheduleGet();
  rm.sched = back.ok ? settingsOf(back) : { ...rm.sched, ...v };
  if (back.ok) rm.schedManaged = managedFields(back.managed);
  const st = $('#rm-status');
  if (st) st.replaceWith(scheduleStatus(rm.sched));
  setNote('rm-note', { text: 'Saved.', cls: 'banner' });
  toast('Volume report by mail saved', 'ok', 4000);
  forgetMailInfo();
}

async function sendNow() {
  const res = await reportSendNow();
  if (!res.ok) { setNote('rm-note', { text: `Not sent: ${res.message || res.kind || 'refused'}`, cls: 'banner err' }); return; }
  refreshReports();
  setNote('rm-note', { text: 'The mailed report is running as a background job, with the saved settings.', cls: 'banner', open: true });
}

async function downloadXlsx() {
  const pick = val('rm-clusters');
  const ids = pick && pick !== 'all' ? [pick] : clusters().map((c) => c.id);
  if (!ids.length) { toast('No cluster to report on', 'warn'); return; }
  const period = schedulePeriod(val('rm-when') || (rm.sched || {}).schedule);
  const res = await reportRun({ clusterIds: ids, period, format: 'xlsx', mail: false });
  if (!res.ok) { setNote('rm-note', { text: `Not started: ${res.message || res.kind || 'refused'}`, cls: 'banner err' }); return; }
  refreshReports();
  const n = (res.jobs || []).length;
  const refused = (res.refused || []).length;
  setNote('rm-note', {
    text: `${n} report job${n === 1 ? '' : 's'} queued for ${periodLabel(period)}${refused ? `, ${refused} refused` : ''}. Each file is downloaded from the job list.`,
    cls: 'banner', open: true,
  });
}

/* ------------------------------ Mail server (SMTP) ------------------------------ */

function mailCard() {
  return gate('Mail server (SMTP)', 'used by volume reports', 'sets up the mail server', mailBody,
    [h('button#ms-save.btn.sm.primary', { type: 'button', onclick: saveMail }, 'Save')]);
}

const pwPlaceholder = (m) => (m.passwordFrom === 'config.txt' ? 'from config.txt' : m.passwordSet ? 'stored' : '');

function mailBody() {
  const m = rm.mail || {};
  const M = rm.mailManaged;
  const security = m.security || 'starttls';
  const auth = security === 'none' ? 'none' : (m.auth || 'password');
  const canStore = m.canStorePassword !== false;
  const pw = text('ms-password', '', { type: 'password', placeholder: pwPlaceholder(m) });
  if (!canStore) pw.title = m.passwordStoreProblem || 'This edition cannot keep a password';

  const sec = select('ms-security', security, SECURITY);
  sec.addEventListener('change', onSecurity);
  const au = select('ms-auth', auth, AUTH);
  au.addEventListener('change', syncAuth);

  const body = h('div.rm-body',
    h('div.rm-grid',
      cell(M, 'host', 'Host', text('ms-host', m.host || '', { placeholder: 'smtp.example.com', mono: true }), null, true),
      cell(M, 'port', 'Port', h('input.mono', { id: 'ms-port', type: 'number', min: 1, max: 65535, step: 1, value: String(m.port || PORT_FOR[security]) })),
      cell(M, 'security', 'Security', sec),
      cell(M, 'auth', 'Sign in', au),
      cell(M, 'user', 'Username', text('ms-user', m.user || '', { mono: true })),
      cell(M, 'password', 'Password', pw,
        canStore ? 'Kept encrypted on the server; never shown again.' : (m.passwordStoreProblem || 'This edition cannot keep a password.')),
      cell(M, 'from', 'From', text('ms-from', m.from || '', { placeholder: 'ElasticPro <elasticpro@example.com>' }), null, true)),
    h('div.rm-acts',
      h('button#ms-test.btn.sm', { type: 'button', 'aria-expanded': 'false', onclick: toggleTest }, 'Send test mail'),
      h('span#ms-test-row.rm-test', { hidden: true },
        text('ms-test-to', '', { type: 'email', placeholder: 'to@example.com' }),
        h('button#ms-test-send.btn.sm.primary', { type: 'button', onclick: sendTest }, 'Send')),
      mailStatus(m)),
    h('div#ms-steps.rm-steps', { hidden: true }),
    h('div#ms-note'));
  // "None" forces "No sign-in", and "No sign-in" needs no username: settled once the
  // elements are on the page (syncAuth finds them by id).
  queueMicrotask(syncAuth);
  return body;
}

function mailStatus(m) {
  return h('div#ms-status.rm-status', m.configured
    ? h('span.rm-ok', '✓ configured')
    : m.problem ? h('span.rm-bad', `✗ ${m.problem}`) : h('span.muted', 'not set up yet'));
}

/** "None" is plain text on the wire: no password goes over it, so no sign-in either. */
function onSecurity() {
  const sec = val('ms-security');
  const port = $('#ms-port');
  // A port that was the old choice's default follows the new choice; one typed by hand stays.
  if (port && !port.disabled && Object.values(PORT_FOR).includes(Number(port.value))) port.value = String(PORT_FOR[sec]);
  syncAuth();
}

function syncAuth() {
  const au = $('#ms-auth');
  if (!au) return;
  const M = rm.mailManaged;
  const none = val('ms-security') === 'none';
  if (none) au.value = 'none';
  au.disabled = none || M.has('auth');
  au.title = none ? 'Security "None" sends in plain text, so it never signs in' : (M.has('auth') ? MANAGED_NOTE : '');
  const noAuth = au.value === 'none';
  const user = $('#ms-user');
  if (user) user.disabled = noAuth || M.has('user');
  const pw = $('#ms-password');
  if (pw) pw.disabled = noAuth || M.has('password') || !!(rm.mail && rm.mail.canStorePassword === false);
}

function readMail() {
  const security = val('ms-security') || 'starttls';
  const out = {
    host: val('ms-host'), port: Number(val('ms-port')) || PORT_FOR[security], security,
    auth: security === 'none' ? 'none' : (val('ms-auth') || 'password'),
    user: val('ms-user'), from: val('ms-from'),
  };
  // Only a typed password goes; an empty box keeps the stored one.
  const pw = $('#ms-password');
  if (pw && !pw.disabled && pw.value) out.password = pw.value;
  for (const k of rm.mailManaged) delete out[k];
  return out;
}

async function saveMail() {
  const v = readMail();
  if (v.port !== undefined && !(v.port >= 1 && v.port <= 65535)) { setNote('ms-note', { text: 'Port must be 1 to 65535.', cls: 'banner err' }); return; }
  const res = await mailSettingsSet(v);
  if (!res.ok) {
    const why = res.kind === 'cannot_store_password' ? ((rm.mail && rm.mail.passwordStoreProblem) || res.message) : res.message;
    setNote('ms-note', { text: `Not saved: ${why || res.kind || 'refused'}`, cls: 'banner err' });
    return;
  }
  toast('Mail server saved', 'ok', 4000);
  forgetMailInfo();
  // Read it back: configured, problem and passwordSet are the core's to say. The typed
  // password leaves the box, which now says "stored".
  const m = await mailSettingsGet();
  if (m.ok) { rm.mail = settingsOf(m); rm.mailManaged = managedFields(m.managed); }
  const pw = $('#ms-password');
  if (pw) { pw.value = ''; pw.placeholder = pwPlaceholder(rm.mail || {}); }
  const st = $('#ms-status');
  if (st) st.replaceWith(mailStatus(rm.mail || {}));
  setNote('ms-note', { text: 'Saved.', cls: 'banner' });
}

function toggleTest() {
  const row = $('#ms-test-row');
  if (!row) return;
  row.hidden = !row.hidden;
  const b = $('#ms-test');
  if (b) b.setAttribute('aria-expanded', String(!row.hidden));
  const i = $('#ms-test-to');
  if (!row.hidden && i) i.focus();
}

function showSteps(steps, msg) {
  const el = $('#ms-steps');
  if (!el) return;
  el.hidden = !(steps && steps.length) && !msg;
  mount(el, ...(steps || []).map((s) => h(`span${s.ok ? '.rm-ok' : '.rm-bad'}`, stepText(s))),
    msg ? h(`span${msg === 'Sending…' ? '.muted' : '.rm-bad'}`, msg) : null);
}

async function sendTest() {
  const to = val('ms-test-to');
  if (!to) { toast('Type the address to send the test to', 'warn'); return; }
  const btn = $('#ms-test-send');
  if (btn) btn.disabled = true;
  showSteps(null, 'Sending…');
  const res = await mailTest(to);
  if (btn) btn.disabled = false;
  // A failed send still names the step it failed at (kind smtp_failed): every step is shown.
  const steps = Array.isArray(res.steps) ? res.steps : null;
  showSteps(steps, res.ok || (steps && steps.length) ? '' : `Not sent: ${res.message || res.kind || 'refused'}`);
  if (res.ok) toast(`Test mail sent to ${to}`, 'ok', 4000);
}
