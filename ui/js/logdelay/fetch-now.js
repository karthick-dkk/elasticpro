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
 */

import { h } from '../lib/dom.js';
import { ldFetchNow, ldJobRuns, runOf, runText, fetchRefusalText, fetchNowAllowed, RUN_ENDED, FETCH_POLL_MS } from '../core/logdelay-report.js';

/** Give up following a run after this long: the run carries on, the page stops asking. */
const FOLLOW_MAX_MS = 20 * 60 * 1000;

const F = { phase: 'idle', scope: null, runId: null, run: null, message: '', since: 0, ver: 0 };
let timer = null;
let ctl = null;
let hooks = { repaint: () => {}, done: () => {} };

const changed = () => { F.ver += 1; hooks.repaint(); };

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
      F.message = '';
      stop();
      changed();
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
    changed();
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
  changed();
  const res = await ldFetchNow(scope, ctl ? ctl.signal : undefined);
  if (F.phase !== 'starting') return;
  if (res && res.kind === 'aborted') return;
  if (res && (res.ok || res.kind === 'already_running') && res.runId) {
    F.phase = 'following';
    F.runId = res.runId;
    F.message = res.ok ? '' : fetchRefusalText(res);
    changed();
    timer = setTimeout(poll, 0);
    return;
  }
  F.phase = 'refused';
  F.message = fetchRefusalText(res) || 'Not started.';
  stop();
  changed();
}

/** The status line: what the run is doing, or why it did not start. */
function statusText() {
  if (F.phase === 'starting') return `Asking the server to measure ${F.scope ? F.scope.label : ''}…`;
  if (F.phase === 'following') return `${F.message ? `${F.message} ` : ''}Run ${F.runId}: ${runText(F.run)}`;
  if (F.phase === 'done') return `Measured ${F.scope ? F.scope.label : ''}: ${runText(F.run)}. The boards show it.`;
  if (F.phase === 'ended') return F.message || `Run ${F.runId}: ${runText(F.run)}`;
  if (F.phase === 'refused') return F.message;
  return '';
}

/**
 * The button and its status, for `scope`. `h.repaint` redraws the page; `h.done(run)` runs once
 * a run ended completed (the boards read the store again then).
 */
export function fetchNowControl(scope, h2) {
  hooks = { ...hooks, ...h2 };
  const busy = fetchNowBusy();
  // One cluster at a time (docs/LOGDELAY.md "Fetch now"): the fleet board offers no run — the
  // scheduled measurement reads every cluster; a person re-measures the one on screen.
  const allowed = fetchNowAllowed(scope);
  const tone = F.phase === 'refused' || (F.phase === 'ended' && F.run && F.run.status === 'failed') ? '.ld-fetch-bad' : F.phase === 'done' ? '.ld-fetch-ok' : '';
  return {
    sig: `${F.ver}|${scope.label}|${(scope.clusterIds || []).join(',')}|${scope.device || ''}|${scope.devices || ''}`,
    build: () => h('div.ld-fetch',
      h('button.btn.sm.primary#ld-fetch-now', {
        type: 'button', disabled: busy || !allowed,
        title: allowed
          ? `Run the log delay measurement now for ${scope.label}${scope.device ? ' (its cluster is measured; the device is named so a core that can narrows to it)' : scope.devices === 'all' ? ' (every device of the cluster)' : ' (the devices 15 min or more behind at the start)'}`
          : 'Fetch now measures one cluster at a time: open a cluster (or pick one above). The scheduled measurement reads every cluster every 2 hours.',
        onclick: () => { if (allowed) press(scope); },
      }, busy ? h('span', h('span.spin'), ' Fetching…') : 'Log Delay – Fetch Now'),
      h(`span.ld-fetch-status${tone}`, { role: 'status', 'aria-live': 'polite' }, allowed ? statusText() : 'Pick a cluster to fetch now.')),
  };
}
