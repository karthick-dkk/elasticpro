/**
 * "Measure again": the ↻ button wherever Log Delay says not measured (a state tile, a cluster
 * row, an unmeasured device row). One builder, so the three read and run the same. It is Fetch
 * now (JOB_RUN `logdelay.measure`) with the scope of what it sits on: the cluster, or one device;
 * the run, its progress, its refusal toast and the board reload are fetch-now.js's own.
 */
import { h } from '../lib/dom.js';
import { zonedText } from '../core/log-range.js';
import { fetchNowPress, fetchNowBusy, fetchNowEvery } from './fetch-now.js';

/** "Measure now · last 2 h (14:00–16:00)": the window the run reads is the measurement's own (`everyHours`) ending now. */
export function measureAgainTitle({ everyHours, now = Date.now(), zone } = {}) {
  if (!Number.isFinite(everyHours) || everyHours <= 0) return 'Measure now · period not known yet';
  const t = (ms) => zonedText(ms, zone, { seconds: false }).slice(11);
  return `Measure now · last ${everyHours} h (${t(now - everyHours * 3600000)}–${t(now)})`;
}

/**
 * The button for `scope` ({clusterIds:[id], device?, devices?, label}). Icon only, compact.
 * `opts`: `zone`, `everyHours` (default: the schedule Fetch now was given).
 */
export function measureAgainButton(scope, opts = {}) {
  const busy = fetchNowBusy();
  const title = () => {
    const t = measureAgainTitle({ everyHours: Number.isFinite(opts.everyHours) ? opts.everyHours : fetchNowEvery(), zone: opts.zone });
    return fetchNowBusy() ? `A measurement is running · ${t}` : t;
  };
  return h('button.btn.sm.ld-measure', {
    type: 'button', disabled: busy, title: title(),
    'aria-label': `Measure ${scope.label || 'now'} again`, dataset: { measure: scope.device ? 'device' : 'cluster' },
    // The period is the one a press would read now, not when the page was drawn.
    onmouseenter: (e) => { e.currentTarget.title = title(); },
    onclick: (e) => { e.stopPropagation(); fetchNowPress(scope); },
  }, '↻');
}
