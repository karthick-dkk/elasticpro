/**
 * "Reports · 3 running · 1 queued" in the top bar, on every page (0.3.45).
 *
 * Report jobs run in the background so nobody has to wait on Reports for them;
 * this is how somebody who left knows they are still going, and the way back to them.
 * It reads the one poller in core/reports.js: every 5 s while a job runs or waits, every
 * 60 s when idle, never while the tab is hidden, and not at all on a core that does not
 * run reports, where the pill is not shown rather than saying "idle" about nothing.
 *
 * The top bar is rebuilt only when what it shows changes, and job progress is not part of
 * that; so this is one element for the session that changes its own text, and the bar
 * just places it.
 */

import { h } from '../lib/dom.js';
import { reports, onReports, startReportsPoll, openReportJobs } from '../core/reports.js';

let el = null;

/** The report jobs that failed, as the poller lists them (core/reports.js, status 'failed'). */
export function failedJobs(snap) {
  return ((snap && snap.jobs) || []).filter((j) => j && j.status === 'failed');
}

/**
 * The owner (2026-11-14): the bar shows nothing in a normal state. So the pill is drawn only
 * when a report run FAILED — "Reports · 1 failed", red — and is absent while jobs run, wait or
 * sit idle (the Reports page and its tab's dot say those). Unknown until the first answer, and
 * gone for good on an older core or a refusal.
 */
function sync() {
  if (!el) return;
  const failed = failedJobs(reports);
  el.hidden = reports.supported !== true || !failed.length;
  el.textContent = `Reports · ${failed.length} failed`;
  el.title = `${failed.length} report job${failed.length === 1 ? '' : 's'} failed: ${failed.slice(0, 3).map((j) => j.name || j.type || j.id).join(', ')}${failed.length > 3 ? '…' : ''}. Opens Reports › Exports & schedules with the report jobs.`;
  el.classList.toggle('red', failed.length > 0);
  el.classList.toggle('grey', !failed.length);
}

/**
 * The pill, or null where reports cannot apply: a snapshot file (no core to ask), a
 * guest (REPORT_JOBS is a user's message, and the page it opens is not a guest's) and an
 * evidence page (core/evidence.js): job counts are fleet-wide chrome, like the alert count.
 */
export function reportsPill({ snapshot = false, guest = false, evidence = false } = {}) {
  if (snapshot || guest || evidence) return null;
  if (!el) {
    el = h('button#reports-pill.pill.rp-pill.grey', {
      type: 'button', hidden: true,
      title: 'A report job failed. Opens Reports › Exports & schedules with the report jobs.',
      onclick: () => openReportJobs(),
    });
    onReports(sync);
  }
  // Idempotent; after resetReports() (a core upgraded since) the next top bar starts it again.
  startReportsPoll();
  sync();
  return el;
}
