/**
 * "Log Delay – Fetch Now": the scheduled measurement (job `logdelay.measure`, docs/JOBS.md) run
 * now for what is on screen — the cluster, or one device of it, or every cluster on the fleet
 * board. JOB_RUN with that scope; then JOBS_LIST every 2 s for that run until it ends, with its
 * progress, done of total and devices measured; then the boards read the store again.
 *
 * A run already going is followed rather than refused twice (`already_running` names it), and a
 * refusal — read-only, not an administrator, a server without the job — is said in plain words.
 * The words and the message are core/logdelay-report.js (fetchNowMessage, runText,
 * fetchRefusalText); this is the button and its poll.
 *
 * The control is a split button: the main part is Fetch now for the cluster's late devices (30 min
 * or more behind), the caret opens a menu with "Late devices", "Whole cluster" and a note on the
 * automatic run. Nothing sits beside it: while a run goes the button itself reads "3 of 8…" with a
 * thin fill along its bottom edge. The nodes are built once and updated in place on every poll, so
 * an open menu or the focus never moves; a refusal is a toast.
 */

import { h } from '../lib/dom.js';
import { toast } from '../ui/menu.js';
import { LD_JOB, ldFetchNow, ldJobRuns, runOf, runText, fetchRefusalText, fetchNowAllowed, RUN_ENDED, FETCH_POLL_MS } from '../core/logdelay-report.js';

/** Give up following a run after this long: the run carries on, the page stops asking. */
const FOLLOW_MAX_MS = 20 * 60 * 1000;

const F = { phase: 'idle', scope: null, runId: null, run: null, message: '', since: 0, ver: 0 };
let timer = null;
let ctl = null;
let hooks = { repaint: () => {}, done: () => {} };

/** Phase changes repaint the page (its loading line follows fetchNowBusy); polls only touch the nodes. */
const changed = (phase = false) => { F.ver += 1; sync(); if (phase) hooks.repaint(); };

/** What the schedule notes need: the job's own last run and next time, null while unknown. */
/** What the page knows ({everyHours, lastRunAt, nextDueAt, delayFrom}); the job's own state fills gaps. */
let INFO = {};
/** "N min or more behind", N from the configuration; never a number of ours. */
const behind = () => (Number.isFinite(INFO.delayFrom) ? `${INFO.delayFrom} min or more behind` : 'delayed or critical');
const S = { last: null, next: null, note: '', everyHours: null, at: 0, loading: false };
/** The nodes of the control on screen, or null. */
let live = null;

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (ctl) ctl.abort();
  ctl = null;
}

/** The page is left: stop following (the run itself carries on in the core). */
export function fetchNowLeave() {
  stop();
  if (F.phase === 'starting' || F.phase === 'following') { F.phase = 'idle'; F.message = ''; }
}

/** Whether a Fetch Now is being followed (the page's loading line). */
export const fetchNowBusy = () => F.phase === 'starting' || F.phase === 'following';

async function poll() {
  timer = null;
  if (F.phase !== 'following') return;
  const res = await ldJobRuns(ctl ? ctl.signal : undefined);
  if (F.phase !== 'following') return;
  if (res && res.kind === 'aborted') return;
  if (res && res.ok) {
    const run = runOf(res, F.runId);
    if (run) F.run = run;
    if (run && RUN_ENDED.has(run.status)) {
      F.phase = run.status === 'completed' ? 'done' : 'ended';
      F.message = run.status === 'completed' ? '' : `Run ${F.runId} ${run.status}: ${runText(run)}`;
      stop();
      S.at = 0;
      changed(true);
      if (F.phase === 'done') toast(`Measured ${F.scope ? F.scope.label : ''}: ${runText(run)}.`, 'ok', 5000, { key: 'ld-fetch' });
      if (F.phase === 'ended') toast(F.message, 'err', 8000, { key: 'ld-fetch' });
      loadSchedule(true);
      hooks.done(run);
      return;
    }
  } else if (res) {
    F.message = `Could not read the run: ${res.message || res.kind || 'no answer'} — asking again.`;
  }
  if (Date.now() - F.since > FOLLOW_MAX_MS) {
    F.phase = 'ended';
    F.message = 'Stopped following after 20 minutes; the run carries on in the core.';
    stop();
    changed(true);
    toast(F.message, 'warn', 8000, { key: 'ld-fetch' });
    return;
  }
  changed();
  timer = setTimeout(poll, FETCH_POLL_MS);
}

/** Press: run the measurement for `scope` ({clusterIds, device, label}). */
async function press(scope) {
  if (fetchNowBusy()) return;
  stop();
  ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  Object.assign(F, { phase: 'starting', scope, runId: null, run: null, message: '', since: Date.now() });
  changed(true);
  const res = await ldFetchNow(scope, ctl ? ctl.signal : undefined);
  if (F.phase !== 'starting') return;
  if (res && res.kind === 'aborted') return;
  if (res && (res.ok || res.kind === 'already_running') && res.runId) {
    F.phase = 'following';
    F.runId = res.runId;
    F.message = res.ok ? '' : fetchRefusalText(res);
    changed(true);
    timer = setTimeout(poll, 0);
    return;
  }
  F.phase = 'refused';
  F.message = fetchRefusalText(res) || 'Not started.';
  toast(F.message, 'err', 8000, { key: 'ld-fetch' });
  stop();
  changed(true);
}

/** A time of the job's, "14:00" today or "15 Nov 14:00" otherwise; "not known yet" for none. */
function whenText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'not known yet';
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

/** Read the job's own last and next run (JOBS_LIST state): at most once a minute, never invented. */
async function loadSchedule(force) {
  if (S.loading || (!force && Date.now() - S.at < 60000)) return;
  S.loading = true;
  const res = await ldJobRuns();
  S.loading = false;
  S.at = Date.now();
  const job = res && res.ok ? (res.jobs || []).find((j) => j && j.id === LD_JOB) : null;
  const st = (job && job.state) || {};
  const lr = st.lastRun;
  const lastAt = lr ? (lr.endedAt || lr.startedAt) : null;
  S.last = typeof lastAt === 'number' ? lastAt : null;
  S.next = typeof st.nextRunAt === 'number' ? st.nextRunAt : null;
  S.note = !S.next && st.nextRunNote ? String(st.nextRunNote) : '';
  sync();
}

/** The scope's words for the tooltip. */
const scopeWord = (scope) => (scope.device ? 'the named device' : scope.devices === 'all' ? 'Whole cluster' : 'Late devices');

/** idle | running | done | error, for the wrapper's data-phase. */
const phaseName = () => (fetchNowBusy() ? 'running' : F.phase === 'done' ? 'done' : F.phase === 'refused' || F.phase === 'ended' ? 'error' : 'idle');

/** Run Fetch now for `scope` from elsewhere (the device board's "Fetch this device"). */
export function fetchNowPress(scope) {
  if (!fetchNowAllowed(scope)) { toast('Pick a cluster first: Fetch now measures one cluster.', 'warn', 6000); return; }
  press(scope);
}

/** Paint F onto the nodes on screen. */
function sync() {
  if (!live) return;
  const { main, caret, label, fill, note, scope, allowed, status } = live;
  const busy = fetchNowBusy();
  const run = F.run;
  let text = 'Fetch now';
  let pct = 0;
  if (busy) {
    if (F.phase === 'starting') text = 'Starting…';
    else if (run && Number.isFinite(run.done) && Number.isFinite(run.total) && run.total > 0) {
      text = `${run.done.toLocaleString()} of ${run.total.toLocaleString()}…`;
      pct = Math.min(100, Math.round((100 * run.done) / run.total));
    } else text = 'Loading…';   // the one word for a bare wait (tools/unit/wording.test.mjs)
  }
  if (label.textContent !== text) label.textContent = text;
  fill.style.width = `${pct}%`;
  main.classList.toggle('busy', busy);
  main.disabled = busy;
  caret.disabled = busy || !allowed;
  if (busy && !live.menu.hidden) closeMenu(false);
  main.title = !allowed
    ? 'Fetch now measures one cluster at a time: pick a cluster first. The scheduled measurement reads every cluster.'
    : busy ? `${F.scope ? scopeWord(F.scope) : 'Fetch now'} · ${scope.label}`
      : `Re-measure the devices ${behind()} in ${scope.label}; the arrow offers the whole cluster`;
  const msg = F.phase === 'done' ? `Measured ${F.scope ? F.scope.label : ''}: ${runText(F.run)}.` : '';
  if (status.textContent !== msg) status.textContent = msg;
  live.root.dataset.phase = phaseName();
  const every = Number.isFinite(INFO.everyHours) ? `every ${INFO.everyHours} h` : 'interval not known yet';
  const nx = Number.isFinite(INFO.nextDueAt) ? INFO.nextDueAt : S.next;
  const next = nx ? whenText(nx) : (S.note || 'not known yet');
  const nt = `Automatic · ${every}, all devices / last ${whenText(Number.isFinite(INFO.lastRunAt) ? INFO.lastRunAt : S.last)} · next ${next}`;
  if (note.textContent !== nt) note.textContent = nt;
}

function closeMenu(refocus) {
  if (!live || live.menu.hidden) return;
  live.menu.hidden = true;
  live.caret.setAttribute('aria-expanded', 'false');
  if (refocus) live.caret.focus();
}

let wired = false;
function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('click', (e) => { if (live && !live.root.contains(e.target)) closeMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && live && !live.menu.hidden) { e.stopPropagation(); closeMenu(true); } });
}

/**
 * The split button, for `scope`. `h2.repaint` redraws the page; `h2.done(run)` runs once a run
 * ended completed (the boards read the store again then); `info` is {everyHours, lastRunAt,
 * nextDueAt, delayFrom} for the menu's schedule note and the "N min or more behind" wording.
 */
export function fetchNowControl(scope, h2, info) {
  hooks = { ...hooks, ...h2 };
  INFO = info || {};
  wire();
  sync();
  const allowed = fetchNowAllowed(scope);
  return {
    sig: `${scope.label}|${(scope.clusterIds || []).join(',')}|${scope.device || ''}|${scope.devices || ''}|${INFO.delayFrom || ''}`,
    build: () => {
      const label = h('span.ld-fetch-label', 'Fetch now');
      const fill = h('span.ld-fetch-fill', { 'aria-hidden': 'true' });
      const status = h('span.ld-fetch-sr', { role: 'status', 'aria-live': 'polite' });
      const go = (devices) => {
        if (fetchNowBusy()) return;
        if (!allowed) { toast('Pick a cluster first: Fetch now measures one cluster.', 'warn', 6000); return; }
        press(scope.device ? scope : { ...scope, devices });
      };
      const main = h('button.btn.primary.ld-fetch-main#ld-fetch-now', { type: 'button', onclick: () => go('late') }, label, fill);
      const note = h('div.ld-fetch-note', { role: 'note' });
      const item = (key, title, sub) => h('button.ld-fetch-item', { type: 'button', role: 'menuitem', dataset: { scope: key }, onclick: () => { closeMenu(true); go(key); } },
        h('b', title), h('span', sub));
      const menu = h('div.ld-fetch-menu#ld-fetch-menu', {
        role: 'menu', hidden: true, 'aria-label': 'Fetch now scope',
        onkeydown: (e) => {
          const items = [...menu.querySelectorAll('[role=menuitem]')];
          const i = items.indexOf(document.activeElement);
          if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
          else if (e.key === 'Tab') closeMenu(false);
        },
      }, item('late', 'Late devices', `${behind()} · what Fetch now does`),
      item('all', 'Whole cluster', 'every device, incl. silent · slower'), note);
      const caret = h('button.btn.primary.ld-fetch-caret', {
        type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'ld-fetch-menu', 'aria-label': 'More Fetch now options',
        disabled: !allowed,
        onclick: () => {
          if (fetchNowBusy()) return;
          if (!menu.hidden) { closeMenu(true); return; }
          menu.hidden = false;
          caret.setAttribute('aria-expanded', 'true');
          loadSchedule(false);
          menu.querySelector('[role=menuitem]').focus();
        },
      }, '▾');
      const root = h('div.ld-fetch', h('div.ld-fetch-split', main, caret, menu), status);
      live = { root, main, caret, menu, label, fill, note, status, scope, allowed };
      sync();
      loadSchedule(false);
      return root;
    },
  };
}