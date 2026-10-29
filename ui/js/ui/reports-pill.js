/**
 * "Reports · 3 running · 1 queued" in the top bar, on every page (0.3.45).
 *
 * Report jobs run in the background so nobody has to wait on Indices › Summary for them;
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
import { reports, onReports, startReportsPoll, pillText, jobCounts, openReportJobs } from '../core/reports.js';

let el = null;

function sync() {
  if (!el) return;
  const c = jobCounts(reports);
  const busy = c.running + c.queued > 0;
  // Unknown until the first answer, and gone for good on an older core or a refusal.
  el.hidden = reports.supported !== true;
  el.textContent = pillText(reports);
  el.classList.toggle('rp-busy', busy);
  el.classList.toggle('grey', !busy);
}

/**
 * The pill, or null where reports cannot apply: a snapshot file (no core to ask) and a
 * guest (REPORT_JOBS is a user's message, and the page it opens is not a guest's).
 */
export function reportsPill({ snapshot = false, guest = false } = {}) {
  if (snapshot || guest) return null;
  if (!el) {
    el = h('button#reports-pill.pill.rp-pill.grey', {
      type: 'button', hidden: true,
      title: 'Report jobs running in the background. Opens Indices › Summary › Monthly with the report panel.',
      onclick: () => openReportJobs(),
    });
    onReports(sync);
  }
  // Idempotent; after resetReports() (a core upgraded since) the next top bar starts it again.
  startReportsPoll();
  sync();
  return el;
}
