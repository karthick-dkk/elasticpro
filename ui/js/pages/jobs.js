/**
 * Jobs (docs/JOBS.md "Jobs page"): everything ElasticPro runs by itself or when a person asks —
 * what runs now, what runs next, every job, every run, and the settings the controls keep.
 *
 * Three tabs, each its own address: Jobs (#/jobs), History (#/jobs/history) and Settings
 * (#/jobs/settings). A strip above them says how busy the server is. A user reads it all;
 * only an administrator presses anything, and every press goes through the write unlock the
 * other admin pages use (core/writes.js ensureWrites) and says a refusal as a sentence.
 *
 * It reads JOBS_LIST every 2 s while a run is open and every 15 s otherwise, not at all while
 * the tab is hidden, and stops when the page is left. Nothing is sent to a cluster. Each row and
 * cell is the one already on screen unless what it shows changed (lib/keyed.js): the row under
 * the pointer, an open menu and a field being typed into stay where they are while runs move.
 */

import { h, mount, reconcile } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { tableSort } from '../lib/table-sort.js';
import { dt, num as fmtNum } from '../lib/fmt.js';
import { state, clusters, requestLoad, refreshRequestLoad } from '../core/state.js';
import { jobsList, jobControl } from '../core/es.js';
import { ensureWrites, writeToggle } from '../core/writes.js';
import { MANAGED_NOTE } from '../core/managed.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, rowMenu } from '../ui/menu.js';
import { openCreateJob, createdToast } from '../ui/job-create.js';
import { keptCard, keptTable } from './common.js';
import * as J from '../core/jobs.js';

/** The tabs, in order. */
export const JOB_TABS = Object.freeze([
  { id: 'jobs', label: 'Jobs' }, { id: 'history', label: 'History' }, { id: 'settings', label: 'Settings' },
]);
const tabHash = (id) => (id === 'jobs' ? '#/jobs' : `#/jobs/${id}`);
const hashNow = () => (typeof location !== 'undefined' ? location.hash : '');
/** The tab an address names; Jobs for anything else. */
export function tabOfHash(hash) {
  const rest = String(hash || '').replace(/^#\/?/, '').split('?')[0].split('/');
  return rest[0] === 'jobs' && JOB_TABS.some((t) => t.id === rest[1]) ? rest[1] : 'jobs';
}

/** Changes, and reads the settings: an administrator (the portable build is its own). */
const isAdmin = () => !state.caller || state.caller.role === 'admin';

let host = null;
let pageEl = null;
let tab = 'jobs';
/** JOBS_LIST's last answer (first page of runs), why the last read failed, whether the core has none. */
let list = null;
let listError = null;
let unsupported = false;
/** One loop of reads per visit: a read in flight from a visit that has ended schedules nothing. */
let gen = 0;
let timer = null;
let loadAt = 0;
let visHooked = false;
/** The last refusal or result, said under the tabs until the next press. */
let notice = null;
/** All jobs: the rows whose details are open. */
const expanded = new Set();
/** A job to show in Settings (a row's "Settings"): marked, and scrolled to once. */
let focusJob = null;
let focusScrolled = false;

/** History: the filter, the page (`before`), the pages walked through, and the answer. */
const hist = { jobId: '', result: '', before: null, stack: [], answer: null, error: null, loading: false };
/** Settings: JOB_SETTINGS_GET's answer, what is typed, and the read's state. */
const sett = { res: null, error: null, loading: false, draft: null, saving: false };

const built = nodeCache();
const SORTS = {
  all: tableSort('jobs.all', { onChange: () => draw() }),
  history: tableSort('jobs.history', { onChange: () => draw() }),
};

/* ------------------------------------ the page ------------------------------------ */

export function render(el) {
  host = el;
  tab = tabOfHash(hashNow());
  if (!visHooked && typeof document !== 'undefined') { document.addEventListener('visibilitychange', onVisibility); visHooked = true; }
  gen++;
  clearTimeout(timer); timer = null;
  draw();
  if (tab === 'settings') loadSettings({ again: !unsavedChanges() });
  if (tab === 'history') loadHistory();
  tick(gen);
}

/** Another tab of this page (#/jobs ↔ #/jobs/history ↔ #/jobs/settings). */
export function onRoute() {
  if (!host) return;
  const want = tabOfHash(hashNow());
  if (want === tab) return;
  tab = want;
  notice = null;
  if (tab === 'settings') loadSettings({ again: true });
  if (tab === 'history') loadHistory();
  draw();
}

export function onData() { if (host) draw(); }

/** Leaving the page stops the reads; a read still in flight lands on nothing. */
export function onLeave() {
  gen++;
  clearTimeout(timer); timer = null;
  host = null;
  if (visHooked && typeof document !== 'undefined') { document.removeEventListener('visibilitychange', onVisibility); visHooked = false; }
}

/** Unsaved settings: the shell asks before leaving (app.js go()). */
export function unsavedChanges() {
  return sett.res && sett.draft ? J.settingsChanges(sett.res, sett.draft).length : 0;
}
export { hashNow };

function onVisibility() {
  if (!host) return;
  if (document.hidden) { clearTimeout(timer); timer = null; return; }
  if (!timer) tick(gen);
}

/** Read now, then again after the delay the answer calls for — unless the visit ended or the tab is hidden. */
async function tick(g) {
  clearTimeout(timer); timer = null;
  await load();
  if (g !== gen || !host) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  // A press reads again at once (kick) while the loop's own read may be in flight: whichever
  // ends last sets the one timer, so there is never a second loop.
  clearTimeout(timer);
  timer = setTimeout(() => tick(g), J.pollDelay(list));
}

/** Read again now (after a press), keeping the same loop. */
function kick() { if (host) tick(gen); }

async function load() {
  const res = await jobsList({ limit: 50 });
  if (res && res.ok) { list = res; listError = null; unsupported = false; }
  else if (res && (res.kind === 'bad_message' || res.kind === 'unknown_message')) unsupported = true;
  else listError = J.refusalText(res) || 'the core did not answer';
  // Requests per second to the clusters: REQUEST_STATS, as the Clusters page reads it — not every tick.
  if (Date.now() - loadAt > 10_000) { loadAt = Date.now(); await refreshRequestLoad(); }
  if (host && tab === 'history' && !hist.before) await loadHistory({ quiet: true });
  if (host) draw();
}

function openTab(id, { job = null } = {}) {
  focusJob = job; focusScrolled = false;
  if (typeof location !== 'undefined' && location.hash !== tabHash(id)) location.hash = tabHash(id);   // the shell calls onRoute
  else { tab = id; if (id === 'settings') loadSettings({ again: true }); if (id === 'history') loadHistory(); draw(); }
}

function draw() {
  if (!host) return;
  if (!pageEl) pageEl = h('div.jb-page');
  if (host.firstChild !== pageEl || host.childNodes.length !== 1) mount(host, pageEl);
  built.begin();
  try { mount(pageEl, ...pageKids()); } finally { built.end(); }
  if (tab === 'settings' && focusJob && !focusScrolled) {
    const row = [...pageEl.querySelectorAll('tr[data-job]')].find((r) => r.dataset.job === focusJob);
    if (row && row.scrollIntoView) { row.scrollIntoView({ block: 'center' }); focusScrolled = true; }
  }
}

function pageKids() {
  const now = Date.now();
  return [
    head(),
    notice ? built.same('notice', h(`div.banner.${notice.level === 'warn' ? 'warn' : notice.level === 'ok' ? 'ok' : 'err'}.jb-notice`, { role: 'status' },
      h('span', notice.text), h('button.btn.ghost.sm', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { notice = null; draw(); } }, '×'))) : null,
    unsupported ? built.same('unsup', h('div.banner.warn', 'This server does not list its jobs yet: JOBS_LIST needs a newer ElasticPro.')) : null,
    listError ? built.same('err', h('div.banner.err', `The jobs could not be read: ${listError}`)) : null,
    list && Array.isArray(list.problems) && list.problems.length
      ? built.same('problems', h('div.banner.warn', `Some runs are missing from this list — a run log could not be read: ${list.problems.join('; ')}`)) : null,
    strip(now),
    ...(tab === 'history' ? historyKids(now) : tab === 'settings' ? settingsKids() : jobsKids(now)),
  ].filter(Boolean);
}

function head() {
  const admin = isAdmin();
  const tabs = h('nav.subnav.jb-tabs', { 'aria-label': 'Jobs' },
    ...JOB_TABS.map((t) => h('button', {
      type: 'button', dataset: { tab: t.id }, 'aria-current': tab === t.id ? 'page' : null, onclick: () => openTab(t.id),
    }, t.label)));
  const right = h('div.jb-head-acts',
    admin ? writeToggle(() => draw()) : h('span.muted.jb-ro', { title: 'Only an administrator runs, pauses or changes jobs' }, 'read-only · an administrator runs and changes jobs'),
    admin ? h('button#jb-create.btn.sm.primary', { type: 'button', onclick: createJob }, 'Create job') : null);
  return built.same('head', h('div.jb-head', tabs, right));
}

/* ------------------------------------ the strip ------------------------------------ */

const nameOfCluster = (id) => (clusters().find((c) => c.id === id) || {}).name || id;

function chip(key, label, value, { sub = '', title = '', tone = '' } = {}) {
  return built.same(`chip:${key}`, h(`div.jb-chip${tone ? `.${tone}` : ''}`, { dataset: { chip: key }, title: title || null },
    h('span.k', label), h('b.v', value), sub ? h('span.d', sub) : null));
}

function strip(now) {
  const p = J.processFigures(list && list.process);
  const c = J.runCounts(list);
  const busy = (list && Array.isArray(list.busy)) ? list.busy : null;
  const gov = J.governorText(list && list.governor);
  const seen = new Set(clusters().map((x) => x.id));
  const rps = requestLoad.at ? Object.entries(requestLoad.clusters || {}).filter(([id]) => !seen.size || seen.has(id))
    .reduce((s, [, v]) => s + (Number(v && v.perSecond) || 0), 0) : null;
  const busyLines = busy ? busy.map((b) => J.busyText(b, nameOfCluster, now)) : [];
  const kids = [
    chip('worker-cpu', 'Worker CPU', p.inCore ? 'in core' : J.pctText(p.workerCpu), { title: p.workerText || 'the report worker\'s CPU, last minute', tone: p.workerText && !p.inCore ? 'warn' : '' }),
    chip('core-cpu', 'Core CPU', J.pctText(p.coreCpu), { title: 'the core\'s CPU, last minute' }),
    chip('memory', 'Memory', `${J.pctText(p.coreMem)}${p.inCore ? '' : ` · ${J.pctText(p.workerMem)}`}`, { sub: p.inCore ? 'core' : 'core · worker', title: 'resident memory of the limit' }),
    chip('rps', 'Requests/s', rps === null ? '—' : rps < 10 ? rps.toFixed(1) : String(Math.round(rps)), { title: `to the clusters, over the last ${Math.round((requestLoad.windowSec || 300) / 60)} minutes (REQUEST_STATS)` }),
    chip('runs', 'Jobs', list ? `${c.running} running · ${c.queued} queued` : '—', { tone: c.running ? 'run' : '' }),
    chip('busy', 'Busy clusters', busy === null ? '—' : busy.length ? String(busy.length) : 'none',
      { sub: busyLines.length ? J.truncate(busyLines[0], 46) + (busyLines.length > 1 ? ` +${busyLines.length - 1}` : '') : '', title: busyLines.join('\n') || 'no cluster is holding background work back', tone: busy && busy.length ? 'warn' : '' }),
    gov ? chip('governor', 'Governor', gov.text, { sub: gov.auto,
      title: ['the adaptive concurrency governor: requests the worker\'s jobs have at Elasticsearch', gov.jobs, gov.change, gov.signals].filter(Boolean).join('\n') }) : null,
  ];
  const el = built.get('strip', 'div', () => h('div.jb-strip', { role: 'group', 'aria-label': 'Server load' }));
  reconcile(el, kids.filter(Boolean));
  return el;
}

/* -------------------------------- kept rows and cells -------------------------------- */

/**
 * A cell kept under `key`: the same <td> for as long as the page shows it, its title and its
 * contents put back only where they changed. Text is written into the text node already there.
 */
function td(key, kids, { cls = '', title = null, num = false, colspan = null } = {}) {
  const tag = `td${num ? '.num' : ''}${cls ? `.${cls}` : ''}`;
  const el = built.get(key, `${tag}|${colspan || ''}`, () => h(tag, colspan ? { colspan } : null));
  const t = title ? String(title) : '';
  if ((el.getAttribute('title') || '') !== t) { if (t) el.setAttribute('title', t); else el.removeAttribute('title'); }
  if (typeof kids === 'string' || typeof kids === 'number') {
    const s = String(kids);
    if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) { if (el.firstChild.data !== s) el.firstChild.data = s; }
    else mount(el, s);
    return el;
  }
  // Text among the pieces is compared as text: the same words keep the text node on screen.
  const nodes = built.sameAll(key, [kids]).map((k, i) => {
    if (k && k.nodeType) return k;
    const s = String(k);
    const was = el.childNodes[i];
    return was && was.nodeType === 3 && was.data === s ? was : document.createTextNode(s);
  });
  reconcile(el, nodes);
  return el;
}

/** A row kept under `key`, its cells put in order. */
function tr(key, cells, { cls = '', data = {} } = {}) {
  const el = built.get(key, `tr${cls}`, () => h(`tr${cls ? `.${cls}` : ''}`));
  for (const [k, v] of Object.entries(data)) if (el.dataset[k] !== String(v)) el.dataset[k] = String(v);
  reconcile(el, cells);
  return el;
}

/** A progress bar kept under `key`: its width set in place, never rebuilt while a run moves. */
function bar(key, pct, tone) {
  const el = built.get(key, tone, () => h(`span.jb-bar.${tone}`, { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i')));
  const w = `${pct}%`;
  if (el.firstChild.style.width !== w) el.firstChild.style.width = w;
  if (el.getAttribute('aria-valuenow') !== String(pct)) el.setAttribute('aria-valuenow', String(pct));
  return el;
}

const pill = (text, tone, title = null) => h(`span.pill.${tone}`, { title }, h('i.dot'), text);
const dash = () => h('span.muted', '—');

/* ------------------------------------- Jobs tab ------------------------------------- */

const jobById = (id) => ((list && list.jobs) || []).find((j) => j.id === id) || null;
const jobName = (id) => { const j = jobById(id); return j ? j.name : id; };
const tz = () => (list && (list.tz || list.serverTz)) || null;

function jobsKids(now) {
  if (!list) return [built.same('loading', h('div.tbl-empty', unsupported ? '' : 'Reading the jobs…'))];
  return [runningCard(now), upNextCard(now), allJobsCard(now), createdCard(now)].filter(Boolean);
}

function clustersText(r) {
  const ids = Array.isArray(r.clusters) ? r.clusters : [];
  if (!ids.length) return { text: '—', title: '' };
  const names = ids.map(nameOfCluster);
  return { text: names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '), title: names.join(', ') };
}

/**
 * The progress cell: a bar and the percent when the core gives one, "counting…" when it does
 * not (no bar at 0 %). The kept bar goes straight into the kept cell — wrapped in a fresh
 * element it would be pulled out of the page on every read.
 */
function progressCell(key, r) {
  const p = J.progressOf(r);
  const kids = p.pct !== null
    ? [bar(`${key}:bar`, p.pct, J.barTone(r.status)), h('span.jb-pct', p.text), p.detail ? h('span.muted.jb-of', p.detail) : null]
    : [h('span.muted', p.text), p.detail ? h('span.muted.jb-of', p.detail) : null];
  return td(key, kids.filter(Boolean), { cls: 'jb-prog', title: p.detail ? `${p.detail} done` : null });
}

function runningCard(now) {
  const runs = J.openRuns(list);
  const admin = isAdmin();
  const c = J.runCounts(list);
  const rows = runs.map((r) => {
    const k = `run:${r.id}`;
    const job = jobById(r.jobId);
    const on = clustersText(r);
    const day = r.day ? ` · ${r.day}` : '';
    const req = job ? J.requestsText(job) : { text: '—', title: '' };
    const stop = admin
      ? h('button.btn.sm.jb-stop', { type: 'button', disabled: !J.canCancel(r), title: r.cancelAsked ? 'asked to stop: it stops at its next safe point' : 'Stop this run at its next safe point', onclick: () => cancelRun(r.id) },
        r.cancelAsked ? 'Stopping…' : 'Stop')
      : null;
    return tr(k, [
      td(`${k}:job`, h('span.jb-name', h('b', job ? job.name : r.jobId), h('span.muted.jb-by', ` ${J.triggerText(r.trigger)}`),
        r.stale ? pill('stale', 'yellow', 'the worker\'s heartbeat is late: this run may have ended with the worker. It is not ended here.') : null,
        r.status === 'queued' ? pill('queued', 'grey') : null)),
      td(`${k}:on`, `${on.text}${day}`, { title: on.title }),
      progressCell(`${k}:prog`, r),
      td(`${k}:rec`, r.records === null || r.records === undefined ? '—' : fmtNum(r.records), { num: true }),
      td(`${k}:start`, r.startedAt ? J.absoluteText(r.startedAt, { tz: tz(), now }).text : '—', { title: r.startedAt ? dt(r.startedAt) : 'not started yet' }),
      td(`${k}:dur`, J.durationText(J.durationMs(r, now)), { num: true }),
      td(`${k}:req`, req.text, { title: req.title }),
      admin ? td(`${k}:act`, stop, { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { cls: r.stale ? 'jb-stale' : '', data: { run: r.id, status: r.status } });
  });
  const headers = ['Job', 'On', 'Progress', { label: 'Records', num: true }, 'Started', { label: 'Duration', num: true }, 'Requests', ...(admin ? [''] : [])];
  const body = runs.length ? keptTable(built, 'run', headers, rows) : built.same('run:none', h('div.jb-none.muted', 'Nothing running or queued.'));
  return keptCard(built, 'run', 'Running now', `${c.running} running · ${c.queued} queued · read every ${runs.length ? '2' : '15'} s`, body);
}

function upNextCard(now) {
  const admin = isAdmin();
  const rows = J.upNext(list, { now, tz: tz() }).map(({ job, next }) => {
    const k = `next:${job.id}`;
    const st = job.state || {};
    const acts = admin ? [
      J.canRunNow(job) ? h('button.btn.sm', { type: 'button', onclick: () => runNow(job.id) }, 'Run now') : null,
      J.canPause(job) ? h('button.btn.sm', { type: 'button', onclick: () => pauseJob(job.id, !st.paused) }, st.paused ? 'Resume' : 'Pause') : null,
    ].filter(Boolean) : [];
    return tr(k, [
      td(`${k}:job`, h('span.jb-name', h('b', job.name), J.isCreated(job) ? h('span.muted', ' · created') : null)),
      td(`${k}:at`, next.at !== null ? next.text : (st.paused ? 'paused' : 'off'), { title: next.at !== null ? `${dt(next.at)} · ${next.zone}` : next.note }),
      td(`${k}:in`, next.at !== null ? next.rel : J.truncate(next.note, 48), { cls: next.at !== null ? '' : 'muted', title: next.note || null }),
      td(`${k}:sched`, J.truncate(job.schedule || '—', 56), { cls: 'muted', title: job.schedule || null }),
      admin ? td(`${k}:act`, h('span.jb-btns', ...acts), { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { data: { job: job.id } });
  });
  const zone = tz() ? `server time (${tz()})` : 'your time';
  const headers = ['Job', 'Next run', 'In', 'Schedule', ...(admin ? [''] : [])];
  const body = rows.length ? keptTable(built, 'next', headers, rows) : built.same('next:none', h('div.jb-none.muted', 'No scheduled job has a next run.'));
  return keptCard(built, 'next', 'Up next', `times in ${zone}`, body);
}

/** One row of All jobs: the job, its open run, its last run, and what the columns read. */
function jobRow(job, now) {
  const st = job.state || {};
  const cur = J.isOpen(st.current) ? st.current : null;
  const last = st.lastRun || null;
  return { job, cur, last, run: cur || last, status: J.jobStatus(job), next: J.nextRunOf(job, { now, tz: tz() }) };
}

function allColumns(now) {
  return {
    name: { type: 'text', value: (r) => r.job.name },
    type: { type: 'text', value: (r) => J.jobTypeText(r.job) },
    status: { type: 'text', value: (r) => J.statusWord(r.status) },
    progress: { type: 'percent', value: (r) => (r.cur ? J.progressOf(r.cur).pct : null), start: -1 },
    started: { type: 'date', value: (r) => (r.run ? r.run.startedAt : null), start: -1 },
    duration: { type: 'duration', value: (r) => J.durationMs(r.run, now), start: -1 },
    next: { type: 'date', value: (r) => r.next.at },
    last: { type: 'date', value: (r) => (r.last ? r.last.endedAt : null), start: -1 },
    result: { type: 'text', value: (r) => (r.last ? J.statusWord(r.last.status) : null) },
    records: { type: 'number', value: (r) => (r.run ? r.run.records : null), start: -1 },
    error: { type: 'text', value: (r) => (r.last && r.last.error) || null },
    priority: { type: 'number', value: (r) => J.priorityRank(r.job.priority) },
    requests: { type: 'number', value: (r) => J.requestsText(r.job).now ?? ((r.job.requests || {}).max ?? null), start: -1 },
    paused: { type: 'text', value: (r) => (!J.canPause(r.job) ? null : r.job.state && r.job.state.paused ? 'paused' : 'no') },
  };
}

const ALL_HEADERS = [
  { label: 'Name', sort: 'name' }, { label: 'Type', sort: 'type' }, { label: 'Status', sort: 'status' },
  { label: 'Progress', sort: 'progress', num: true }, { label: 'Started', sort: 'started' }, { label: 'Duration', sort: 'duration', num: true },
  { label: 'Next run', sort: 'next' }, { label: 'Last run', sort: 'last' }, { label: 'Last result', sort: 'result' },
  { label: 'Records', sort: 'records', num: true }, { label: 'Error', sort: 'error' }, { label: 'Priority', sort: 'priority' },
  { label: 'Requests', sort: 'requests' }, { label: 'Paused', sort: 'paused' },
];

function allJobsCard(now) {
  const admin = isAdmin();
  const rows = SORTS.all.apply((list.jobs || []).map((j) => jobRow(j, now)), allColumns(now));
  const n = ALL_HEADERS.length + (admin ? 1 : 0);
  const trs = [];
  for (const r of rows) {
    const { job, cur, last, run } = r;
    const k = `all:${job.id}`;
    const open = expanded.has(job.id);
    const p = cur ? J.progressOf(cur) : null;
    const req = J.requestsText(job);
    const err = last && last.error ? String(last.error) : '';
    const toggle = h('button.jb-x', {
      type: 'button', 'aria-expanded': String(open), title: open ? 'Hide the details' : 'Show the details',
      onclick: () => { if (expanded.has(job.id)) expanded.delete(job.id); else expanded.add(job.id); draw(); },
    }, open ? '▾' : '▸');
    trs.push(tr(k, [
      td(`${k}:name`, h('span.jb-name', toggle, h('b', job.name), J.isCreated(job) ? h('span.muted', ' · created') : null), { title: job.id }),
      td(`${k}:type`, J.jobTypeText(job)),
      td(`${k}:status`, pill(J.statusWord(r.status), J.statusTone(r.status), r.status === 'paused' && job.state.pausedBy ? `paused by ${job.state.pausedBy}` : null)),
      td(`${k}:prog`, p ? p.text : '—', { num: true, cls: p && p.pct === null ? 'muted' : '' }),
      td(`${k}:start`, run && run.startedAt ? J.relativeText(run.startedAt, now) : '—', { title: run && run.startedAt ? dt(run.startedAt) : null }),
      td(`${k}:dur`, J.durationText(J.durationMs(run, now)), { num: true }),
      td(`${k}:next`, r.next.at !== null ? r.next.rel : '—', { title: r.next.at !== null ? `${r.next.text} · ${r.next.zone}` : r.next.note }),
      td(`${k}:last`, last && last.endedAt ? J.relativeText(last.endedAt, now) : '—', { title: last && last.endedAt ? dt(last.endedAt) : null }),
      td(`${k}:result`, last ? pill(J.statusWord(last.status), J.statusTone(last.status)) : dash()),
      td(`${k}:rec`, run && run.records !== null && run.records !== undefined ? fmtNum(run.records) : '—', { num: true }),
      td(`${k}:err`, err ? J.truncate(err, 36) : '—', { cls: err ? 'jb-err' : 'muted', title: err || null }),
      td(`${k}:prio`, J.priorityText(job.priority)),
      td(`${k}:req`, req.text, { title: req.title }),
      td(`${k}:paused`, !J.canPause(job) ? '—' : job.state && job.state.paused ? 'paused' : 'no', { title: job.state && job.state.pausedBy ? `by ${job.state.pausedBy}` : null }),
      admin ? td(`${k}:act`, rowMenu(() => jobMenu(job.id), { title: `Actions for ${job.name}`, menuLabel: job.name }), { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { data: { job: job.id, status: r.status } }));
    if (open) trs.push(tr(`${k}:more`, [td(`${k}:more:td`, detailsOf(job, cur, last, now), { colspan: n, cls: 'jb-more' })], { cls: 'jb-detail', data: { detail: job.id } }));
  }
  const headers = [...ALL_HEADERS, ...(admin ? [''] : [])];
  return keptCard(built, 'all', 'All jobs', `${(list.jobs || []).length} jobs · a column sorts; unknown values go last`,
    keptTable(built, 'all', headers, trs, { sort: SORTS.all }));
}

function detailsOf(job, cur, last, now) {
  const st = job.state || {};
  const line = (k, v) => (v === null || v === undefined || v === '' ? null : h('div.jb-kv', h('span.k', k), h('span.v', String(v))));
  const runLine = (label, r) => r && h('div.jb-kv', h('span.k', label),
    h('span.v', `${J.statusWord(r.status)} · ${J.triggerText(r.trigger)} · ${r.startedAt ? dt(r.startedAt) : 'not started'}${r.endedAt ? ` → ${dt(r.endedAt)}` : ''} · run ${r.id}${r.retryOf ? ` · retry ${r.attempt || ''} of ${r.retryOf}` : ''}`));
  return h('div.jb-details',
    line('Schedule', job.schedule),
    line('Next run', st.nextRunAt ? `${dt(st.nextRunAt)} (${J.relativeText(st.nextRunAt, now)})` : st.nextRunNote),
    st.paused ? line('Paused', `by ${st.pausedBy || 'an administrator'}${st.pausedAt ? ` · ${dt(st.pausedAt)}` : ''}`) : null,
    runLine('Open run', cur), runLine('Last run', last),
    last && last.error ? line('Error', last.error) : null,
    last && last.note ? line('Note', last.note) : null,
    last && last.deferred ? line('Waited for', J.busyText(last.deferred, nameOfCluster, now)) : null,
    (cur || last) && (cur || last).clusters && (cur || last).clusters.length ? line('Clusters', (cur || last).clusters.map(nameOfCluster).join(', ')) : null,
    line('Runs in', job.owner), line('Job id', job.id));
}

function jobMenu(id) {
  const job = jobById(id);
  if (!job) return [{ hint: 'This job is no longer listed.' }];
  const st = job.state || {};
  const cur = J.isOpen(st.current) ? st.current : null;
  const last = st.lastRun || null;
  return [
    { label: 'Run now', icon: '▶', disabled: !J.canRunNow(job), title: J.canRunNow(job) ? '' : (job.id === 'report.run' ? 'A report run names its clusters and dates: Create job › Run once' : 'It runs every minute by itself'), onClick: () => runNow(id) },
    J.canPause(job) ? { label: st.paused ? 'Resume' : 'Pause', icon: st.paused ? '⏵' : '⏸', onClick: () => pauseJob(id, !st.paused) } : null,
    { label: 'Stop the open run', icon: '■', disabled: !J.canCancel(cur), title: cur ? '' : 'Nothing of this job is running', onClick: () => cur && cancelRun(cur.id) },
    { label: 'Retry the last run', icon: '↻', disabled: !J.canRetry(last), title: J.canRetry(last) ? '' : 'Only a failed, deferred or cancelled run is tried again', onClick: () => last && retryRun(last.id) },
    { label: 'Settings', icon: '⚙', onClick: () => openTab('settings', { job: id }) },
    J.isCreated(job) ? { sep: true } : null,
    J.isCreated(job) ? { label: 'Delete this schedule', icon: '✕', danger: true, onClick: () => deleteJob(id) } : null,
  ];
}

function createdCard(now) {
  const created = (list.jobs || []).filter(J.isCreated);
  if (!created.length) return null;
  const admin = isAdmin();
  const rows = created.map((job) => {
    const k = `cr:${job.id}`;
    const c = job.created || {};
    const next = J.nextRunOf(job, { now, tz: tz() });
    const cl = c.clusters === 'all' || !c.clusters ? 'All clusters' : clustersText({ clusters: c.clusters }).text;
    const to = Array.isArray(c.to) ? c.to : null;
    return tr(k, [
      td(`${k}:name`, h('b', job.name)),
      td(`${k}:rep`, job.report || '—'),
      td(`${k}:cl`, cl),
      td(`${k}:when`, `${c.cadence || '—'}${c.at ? `, ${c.at}` : ''}`),
      td(`${k}:to`, to ? (to.length ? `${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ''}` : 'nobody') : '—', { title: to ? to.join(', ') : 'recipients are an administrator\'s to read' }),
      td(`${k}:next`, next.at !== null ? next.rel : J.truncate(next.note, 36), { title: next.at !== null ? `${next.text} · ${next.zone}` : next.note }),
      admin ? td(`${k}:act`, h('button.btn.sm.danger', { type: 'button', onclick: () => deleteJob(job.id) }, 'Delete'), { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { data: { job: job.id } });
  });
  return keptCard(built, 'cr', 'Created schedules', 'made with Create job; each is a job of its own',
    keptTable(built, 'cr', ['Name', 'Report', 'Clusters', 'When', 'To', 'Next send', ...(admin ? [''] : [])], rows));
}

/* ------------------------------------- History tab ------------------------------------- */

async function loadHistory({ quiet = false } = {}) {
  if (hist.loading) return;
  hist.loading = true;
  if (!quiet && host) draw();
  const res = await jobsList({ limit: 50, ...(hist.before ? { before: hist.before } : {}), ...(hist.jobId ? { jobId: hist.jobId } : {}) });
  hist.loading = false;
  if (res && res.ok) { hist.answer = res; hist.error = null; }
  else hist.error = J.refusalText(res) || 'the core did not answer';
  if (!quiet && host) draw();
}

function historyKids(now) {
  const admin = isAdmin();
  const jobs = (list && list.jobs) || [];
  const jobSel = h('select#jb-h-job', {
    'aria-label': 'Job',
    onchange: (e) => { hist.jobId = e.target.value; hist.before = null; hist.stack = []; loadHistory(); },
  }, h('option', { value: '' }, 'Every job'), ...jobs.map((j) => h('option', { value: j.id }, j.name)));
  jobSel.value = hist.jobId;
  const resSel = h('select#jb-h-result', { 'aria-label': 'Result', onchange: (e) => { hist.result = e.target.value; draw(); } },
    h('option', { value: '' }, 'Every result'), ...J.RESULTS.map((s) => h('option', { value: s }, J.statusWord(s))));
  resSel.value = hist.result;
  const a = hist.answer;
  const pageNo = hist.stack.length + 1;
  const bar = h('div.toolbar.jb-hbar',
    h('label.field', 'Job', jobSel), h('label.field', 'Result', resSel),
    h('div.jb-pager',
      h('button#jb-h-newer.btn.sm', { type: 'button', disabled: !hist.stack.length || hist.loading, onclick: () => { hist.before = hist.stack.pop() || null; loadHistory(); } }, '‹ Newer'),
      h('span.muted', `page ${pageNo}`),
      h('button#jb-h-older.btn.sm', { type: 'button', disabled: !(a && a.next) || hist.loading, onclick: () => { hist.stack.push(hist.before); hist.before = a.next; loadHistory(); } }, 'Older ›')),
    h('span.muted.jb-hnote', hist.result ? 'the result filter is applied to this page of 50' : 'every run, newest first, 50 a page'));
  const out = [built.same('hbar', bar)];
  if (hist.error) out.push(built.same('herr', h('div.banner.err', `The runs could not be read: ${hist.error}`)));
  if (!a) { out.push(built.same('hload', h('div.tbl-empty', 'Reading the runs…'))); return out; }
  const runs = J.filterRuns(a.runs, hist.result);
  const cols = {
    job: { type: 'text', value: (r) => jobName(r.jobId) },
    result: { type: 'text', value: (r) => J.statusWord(r.status) },
    by: { type: 'text', value: (r) => J.triggerText(r.trigger) },
    started: { type: 'date', value: (r) => r.startedAt ?? null, start: -1 },
    ended: { type: 'date', value: (r) => r.endedAt ?? null, start: -1 },
    duration: { type: 'duration', value: (r) => J.durationMs(r, now), start: -1 },
    progress: { type: 'percent', value: (r) => J.progressOf(r).pct, start: -1 },
    records: { type: 'number', value: (r) => r.records ?? null, start: -1 },
    clusters: { type: 'text', value: (r) => clustersText(r).title || null },
    error: { type: 'text', value: (r) => r.error || r.note || null },
  };
  const rows = SORTS.history.apply(runs, cols).map((r) => {
    const k = `h:${r.id}`;
    const cl = clustersText(r);
    const why = r.error || r.note || '';
    const p = J.progressOf(r);
    return tr(k, [
      td(`${k}:job`, h('b', jobName(r.jobId)), { title: r.id }),
      td(`${k}:res`, h('span', pill(J.statusWord(r.status), J.statusTone(r.status)), r.stale ? pill('stale', 'yellow', 'the worker\'s heartbeat is late') : null)),
      td(`${k}:by`, J.triggerText(r.trigger), { title: r.retryOf ? `retry ${r.attempt || ''} of ${r.retryOf}` : null }),
      td(`${k}:start`, r.startedAt ? dt(r.startedAt) : '—'),
      td(`${k}:end`, r.endedAt ? dt(r.endedAt) : '—'),
      td(`${k}:dur`, J.durationText(J.durationMs(r, now)), { num: true }),
      td(`${k}:prog`, p.text, { num: true, cls: p.pct === null ? 'muted' : '', title: p.detail || null }),
      td(`${k}:rec`, r.records === null || r.records === undefined ? '—' : fmtNum(r.records), { num: true }),
      td(`${k}:cl`, cl.text, { title: cl.title || null }),
      td(`${k}:why`, why ? J.truncate(why, 48) : '—', { cls: r.error ? 'jb-err' : 'muted', title: why || null }),
      admin ? td(`${k}:act`, J.canRetry(r) ? h('button.btn.sm', { type: 'button', onclick: () => retryRun(r.id) }, 'Retry') : null, { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { data: { run: r.id, status: r.status } });
  });
  const headers = [{ label: 'Job', sort: 'job' }, { label: 'Result', sort: 'result' }, { label: 'By', sort: 'by' }, { label: 'Started', sort: 'started' },
    { label: 'Ended', sort: 'ended' }, { label: 'Duration', sort: 'duration', num: true }, { label: 'Progress', sort: 'progress', num: true },
    { label: 'Records', sort: 'records', num: true }, { label: 'Clusters', sort: 'clusters' }, { label: 'Error or note', sort: 'error' }, ...(admin ? [''] : [])];
  out.push(keptCard(built, 'hist', 'History', `${runs.length} of ${(a.runs || []).length} runs on this page${hist.jobId ? ` · ${jobName(hist.jobId)}` : ''}`,
    keptTable(built, 'hist', headers, rows, { sort: SORTS.history, emptyText: hist.result ? 'No run on this page has that result.' : 'No runs yet.' })));
  return out;
}

/* ------------------------------------- Settings tab ------------------------------------- */

async function loadSettings({ again = false } = {}) {
  if (!isAdmin() || sett.loading || (sett.res && !again)) return;
  sett.loading = true;
  const res = await jobControl('JOB_SETTINGS_GET');
  sett.loading = false;
  if (res && res.ok) { sett.res = res; sett.error = null; sett.draft = draftOf(res); }
  else sett.error = J.refusalText(res) || 'the core did not answer';
  if (host) draw();
}

function draftOf(res) {
  const overall = { ...(res.overall || {}) };
  const jobs = {};
  for (const j of res.jobs || []) jobs[j.jobId] = { enabled: !!j.enabled, auto: !!j.auto, min: (j.requests || {}).min, max: (j.requests || {}).max, priority: j.priority };
  return { overall, jobs };
}

function settingsKids() {
  if (!isAdmin()) return readOnlySettings();
  if (sett.error) return [built.same('serr', h('div.banner.err', `The settings could not be read: ${sett.error}`))];
  if (!sett.res || !sett.draft) return [built.same('sload', h('div.tbl-empty', 'Reading the settings…'))];
  const locked = J.lockedSettings(sett.res);
  const d = sett.draft;
  const lockNote = (key) => (locked.has(key) ? h('span.rm-managed.muted', MANAGED_NOTE) : null);
  const numIn = (id, value, lo, hi, oninput, key) => h('input.jb-num', {
    id, type: 'number', min: String(lo), max: String(hi), step: '1', value: value === undefined || value === null ? '' : String(value),
    disabled: locked.has(key), title: locked.has(key) ? MANAGED_NOTE : null, oninput,
  });
  const overallFields = J.OVERALL_FIELDS.map(([key, label, lo, hi, unit]) => h('label.field.jb-ofield', label,
    h('span.jb-in', numIn(`jb-s-${key}`, d.overall[key], lo, hi, (e) => { d.overall[key] = e.target.value; syncSave(); }, key), unit ? h('span.muted', unit) : null),
    lockNote(key)));
  const gov = list && list.governor;
  const autoField = typeof (sett.res.overall || {}).auto === 'boolean'
    ? h('label.jb-check', h('input#jb-s-auto', { type: 'checkbox', checked: !!d.overall.auto, disabled: locked.has('auto'), onchange: (e) => { d.overall.auto = e.target.checked; syncSave(); } }),
      h('span', 'Automatic optimisation (the adaptive governor moves each job\'s requests)'), lockNote('auto'))
    : h('div.muted.jb-auto-note', 'Automatic optimisation is switched per job below (the Auto column)',
      gov && typeof gov.auto === 'boolean' ? ` · the governor is ${gov.auto ? 'on' : 'off'} now` : '', '.');
  const overall = h('div.jb-overall', autoField, h('div.jb-ofields', ...overallFields));
  const changes = J.settingsChanges(sett.res, d).length;
  const acts = h('div.jb-save',
    h('button#jb-s-save.btn.sm.primary', { type: 'button', disabled: !changes || sett.saving, onclick: saveSettings }, sett.saving ? 'Saving…' : 'Save'),
    h('button#jb-s-discard.btn.sm', { type: 'button', disabled: !changes || sett.saving, onclick: () => { sett.draft = draftOf(sett.res); draw(); } }, 'Discard'),
    h('span#jb-s-count.muted', changes ? `${changes} change${changes === 1 ? '' : 's'} not saved` : 'no changes'),
    sett.res.setBy ? h('span.muted', ` · last saved by ${sett.res.setBy}${sett.res.setAt ? ` ${dt(sett.res.setAt)}` : ''}`) : null);
  const rows = (sett.res.jobs || []).map((j) => {
    const k = `s:${j.jobId}`;
    const dj = d.jobs[j.jobId] || {};
    const job = jobById(j.jobId);
    const manual = job ? job.kind === 'manual' : false;
    const lk = (f) => locked.has(`${j.jobId}.${f}`);
    const prio = h('select', { id: `jb-s-${j.jobId}-priority`, 'aria-label': `Priority of ${job ? job.name : j.jobId}`, disabled: lk('priority'), onchange: (e) => { dj.priority = e.target.value; syncSave(); } },
      ...['high', 'medium', 'low'].map((p) => h('option', { value: p }, J.priorityText(p))));
    prio.value = dj.priority;
    const box = (f, label, dis) => h('input', { type: 'checkbox', id: `jb-s-${j.jobId}-${f}`, 'aria-label': label, checked: !!dj[f], disabled: dis || lk(f), onchange: (e) => { dj[f] = e.target.checked; syncSave(); } });
    return tr(k, [
      td(`${k}:name`, h('b', job ? job.name : j.jobId), { title: j.jobId }),
      td(`${k}:en`, box('enabled', 'Automatic runs', manual), { title: manual ? 'a manual job has no automatic runs' : 'automatic runs on or off' }),
      td(`${k}:auto`, box('auto', 'Auto')),
      td(`${k}:min`, numIn(`jb-s-${j.jobId}-min`, dj.min, 1, J.REQUESTS_CEILING, (e) => { dj.min = e.target.value; syncSave(); }, `${j.jobId}.requests`)),
      td(`${k}:max`, numIn(`jb-s-${j.jobId}-max`, dj.max, 1, J.REQUESTS_CEILING, (e) => { dj.max = e.target.value; syncSave(); }, `${j.jobId}.requests`)),
      td(`${k}:prio`, prio),
      td(`${k}:def`, `${(j.defaults && j.defaults.requests) ? `${j.defaults.requests.min}–${j.defaults.requests.max}` : '—'} · ${J.priorityText(j.defaults && j.defaults.priority)}`, { cls: 'muted' }),
      td(`${k}:paused`, j.paused ? `paused by ${j.pausedBy || 'an administrator'}` : '—', { cls: j.paused ? '' : 'muted' }),
    ], { cls: focusJob === j.jobId ? 'jb-focus' : '', data: { job: j.jobId } });
  });
  return [
    keptCard(built, 'sov', 'Overall', 'for every job · pause, automatic runs and the retry policy act now; the rest is for the adaptive governor', overall),
    keptCard(built, 'sjobs', 'Per job', 'requests a job may use at once, and its priority', keptTable(built, 'sjobs',
      ['Job', 'Automatic runs', 'Auto', 'Requests at least', 'at most', 'Priority', 'Default', 'Paused'], rows)),
    built.same('ssave', acts),
  ];
}

/** The Save line follows what is typed without redrawing the fields being typed into. */
function syncSave() {
  if (!pageEl || !sett.res) return;
  const n = J.settingsChanges(sett.res, sett.draft).length;
  const save = pageEl.querySelector('#jb-s-save'), discard = pageEl.querySelector('#jb-s-discard'), count = pageEl.querySelector('#jb-s-count');
  if (save) save.disabled = !n || sett.saving;
  if (discard) discard.disabled = !n || sett.saving;
  if (count) count.textContent = n ? `${n} change${n === 1 ? '' : 's'} not saved` : 'no changes';
}

/** Everybody but an administrator: what JOBS_LIST says, nothing to change. */
function readOnlySettings() {
  const jobs = (list && list.jobs) || [];
  const gov = J.governorText(list && list.governor);
  const rows = jobs.map((job) => {
    const k = `ro:${job.id}`;
    const st = job.state || {};
    const alloc = st.allocation && typeof st.allocation === 'object' ? st.allocation : null;
    const req = J.requestsText(job);
    return tr(k, [
      td(`${k}:name`, h('b', job.name)),
      td(`${k}:en`, job.kind === 'manual' ? '—' : st.enabled === false ? 'off' : 'on'),
      td(`${k}:auto`, alloc && typeof alloc.auto === 'boolean' ? (alloc.auto ? 'on' : 'off') : '—', { title: alloc ? null : 'the adaptive governor is not reporting it' }),
      td(`${k}:req`, req.text, { title: req.title }),
      td(`${k}:prio`, J.priorityText(job.priority)),
      td(`${k}:paused`, st.paused ? `paused${st.pausedBy ? ` by ${st.pausedBy}` : ''}` : '—'),
    ], { data: { job: job.id } });
  });
  return [
    built.same('sro', h('div.banner.jb-ro-note', 'These settings are an administrator\'s. The overall limits (most jobs at once, CPU and memory thresholds, the retry policy) are read by administrators only.',
      gov ? ` The adaptive governor: ${gov.text}${gov.auto ? `, ${gov.auto}` : ''}.` : '')),
    keptCard(built, 'sro-jobs', 'Per job', 'as JOBS_LIST reports them', keptTable(built, 'sro-jobs', ['Job', 'Automatic runs', 'Auto', 'Requests', 'Priority', 'Paused'], rows,
      { emptyText: list ? 'No jobs listed.' : 'Reading the jobs…' })),
  ];
}

async function saveSettings() {
  const d = sett.draft;
  const problem = J.overallProblem(d.overall)
    || (sett.res.jobs || []).map((j) => J.jobSettingProblem(d.jobs[j.jobId], jobName(j.jobId))).find(Boolean) || '';
  if (problem) { say(problem, 'err'); return; }
  const msgs = J.settingsChanges(sett.res, d);
  if (!msgs.length) return;
  if (!(await ensureWrites())) return;
  sett.saving = true; draw();
  let failed = null;
  for (const m of msgs) {
    const res = await jobControl(m.type, m);
    if (!res || res.ok === false) { failed = { res, m }; break; }
  }
  sett.saving = false;
  // What is in force now is the core's to say; what was not saved stays typed.
  const keep = sett.draft;
  await loadSettings({ again: true });
  if (failed) { sett.draft = keep; say(`Not saved${failed.m.jobId ? ` (${jobName(failed.m.jobId)})` : ''}: ${J.refusalText(failed.res)}`, J.refusalLevel(failed.res)); draw(); return; }
  say('The job settings were saved.', 'ok');
  toast('Job settings saved', 'ok', 3000);
  kick();
}

/* --------------------------------------- controls --------------------------------------- */

function say(text, level = 'err') { notice = text ? { text, level } : null; draw(); }

/**
 * One control: the write unlock first (as every admin page), then the message, then the
 * answer said — a refusal as a sentence — and the list read again.
 */
async function control(type, params, { what = 'It', done }) {
  if (!(await ensureWrites())) return null;
  const res = await jobControl(type, params);
  if (!res || res.ok === false) { say(J.refusalText(res, { what }), J.refusalLevel(res)); kick(); return res; }
  say(done(res), 'ok');
  kick();
  return res;
}

function runNow(id) {
  const name = jobName(id);
  return control('JOB_RUN', { jobId: id }, { what: name, done: (r) => `${name}: started${r.runId ? ` (run ${r.runId})` : ''}.` });
}

function pauseJob(id, pause) {
  const name = jobName(id);
  return control(pause ? 'JOB_PAUSE' : 'JOB_RESUME', { jobId: id }, {
    what: name, done: () => (pause ? `${name} is paused: its timer starts nothing until it is resumed. A run already going finishes.` : `${name} is resumed: it runs by its own schedule again.`),
  });
}

async function cancelRun(runId) {
  const r = J.openRuns(list).find((x) => x.id === runId);
  const name = r ? jobName(r.jobId) : 'this run';
  const yes = await confirmDialog('Stop this run?', `${name} (run ${runId}) stops at its next safe point — between days, pages or clusters. A queued run ends at once. Nothing it already finished is undone.`, { yes: 'stop the run', danger: true });
  if (!yes) return null;
  return control('JOB_CANCEL', { runId }, {
    what: name, done: (res) => (res.status === 'cancelled' ? `${name}: it was queued, and is cancelled.` : `${name}: asked to stop; it stops at its next safe point.`),
  });
}

function retryRun(runId) {
  const run = [...((list && list.runs) || []), ...((hist.answer && hist.answer.runs) || []), ...((list && list.jobs) || []).map((j) => j.state && j.state.lastRun)]
    .find((x) => x && x.id === runId);
  const name = run ? jobName(run.jobId) : 'The run';
  return control('JOB_RETRY', { runId }, { what: name, done: (res) => `${name}: tried again${res.runId ? ` as run ${res.runId}` : ''}.` });
}

async function deleteJob(id) {
  const name = jobName(id);
  const yes = await confirmDialog('Delete this schedule?', `"${name}" stops sending and is removed with its settings. Its past runs stay in History.`, { yes: 'delete the schedule', danger: true });
  if (!yes) return null;
  return control('JOB_DELETE', { jobId: id }, { what: name, done: () => `"${name}" is deleted.` });
}

async function createJob() {
  const res = await openCreateJob();
  if (!res) return;
  say(createdToast(res), res.joined ? 'warn' : 'ok');
  kick();
}
