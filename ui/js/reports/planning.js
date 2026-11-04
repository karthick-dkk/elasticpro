/**
 * Reports › Planning (docs/REPORTS.md, board 8). A stand-in: the Planning branch replaces
 * this file with the section itself. `planningSection(ctx)` returns the section's node; the
 * Reports page mounts it at `#/reports/planning`.
 */

import { h } from '../lib/dom.js';
import { empty } from '../pages/common.js';

export function planningSection() {
  return h('div.rp-section', empty('Planning arrives with plan templates.'));
}
