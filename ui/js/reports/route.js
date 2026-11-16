/**
 * Where on the Reports page a hash points (docs/REPORTS.md, "The page"). Pure, so the shell,
 * the page and tools/unit/reports-page.test.mjs read one definition.
 *
 *   #/reports            → Overview
 *   #/reports/<section>  → that section
 *   #/volume, #/volume/… → the same (the page was "Volume report" until 0.3.53; the Zabbix
 *                          menu entry elasticpro.volume and saved links still open #/volume)
 *
 * Two addresses moved to the Log Delay page (#/log-delay/…, core/logdelay-report.js ldRoute)
 * and still open there: #/reports/log-delay/… (Reports › Log delay until 0.3.60, and the link
 * in the log delay mail) and #/logs (the page was "Logs & Delay", opened on its live tail).
 * The Request Centre (app page `requests`) lives at #/jobs/requests since 0.3.71; #/requests
 * and #/settings/requests/centre still open it.
 */

/** The sections, in the order the section nav shows them. */
export const REPORT_SECTIONS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'daily', label: 'Daily & monthly' },
  { id: 'hosts', label: 'Volume by host' },
  { id: 'capacity', label: 'Capacity & retention' },
  { id: 'measure', label: 'Measure size' },
  { id: 'planning', label: 'Planning' },
  // The log delay report (docs/LOGDELAY.md) moved to the Log Delay page: the entry is a link there.
  { id: 'log-delay', label: 'Log delay', moved: '#/log-delay' },
  { id: 'exports', label: 'Exports & schedules' },
]);
export const DEFAULT_SECTION = 'overview';

/**
 * Old page ids that open a page under its new id — and `clusters`, the Clusters page's path in
 * the address since its Overview section (`#/clusters`, `#/clusters/overview`; the page's id stays
 * `overview`, and `#/overview` still opens it).
 */
export const PAGE_ALIAS = Object.freeze({ volume: 'reports', logs: 'log-delay', clusters: 'overview' });

/**
 * An old address that now belongs to another page, as `[page, rest]`; null for any other.
 * `#/reports/log-delay/<view>` is the Log Delay page's `<view>`; `#/logs` opened the live tail,
 * which is the Log Delay page's Live logs.
 */
export function movedPath(first, more) {
  if (first === 'reports' && more[0] === 'log-delay') return ['log-delay', more.slice(1)];
  // The Request Centre is Jobs › Requests (0.3.71): `#/jobs/requests[/health]` is its own app
  // page, `requests`; Config-Management's old tab address opens it too.
  if (first === 'jobs' && more[0] === 'requests') return ['requests', more.slice(1)];
  if (first === 'settings' && more[0] === 'requests' && more[1] === 'centre') return ['requests', more.slice(2)];
  if (first === 'logs') return ['log-delay', more.length ? more : ['live']];
  return null;
}

/** A page id with its alias resolved. */
export const pageAlias = (id) => (id && Object.prototype.hasOwnProperty.call(PAGE_ALIAS, id) ? PAGE_ALIAS[id] : id);

/**
 * `{page, rest}` from a hash: `#/reports/capacity?x` → `{page: 'reports', rest: 'capacity'}`.
 * The page is the alias-resolved id; `rest` is what follows it, '' when nothing does.
 */
export function parseHash(hash) {
  const path = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  const [first, ...parts] = path.split('/');
  const more = parts.filter(Boolean);
  const moved = movedPath(first, more);
  if (moved) return { page: moved[0], rest: moved[1].join('/') };
  return { page: pageAlias(first || ''), rest: more.join('/') };
}

/** The Reports section a hash names; Overview when it names none or one that does not exist. */
export function sectionOfHash(hash) {
  const { page, rest } = parseHash(hash);
  const id = page === 'reports' ? rest.split('/')[0] : '';
  return REPORT_SECTIONS.some((s) => s.id === id) ? id : DEFAULT_SECTION;
}

/** The hash for a section. */
export const sectionHash = (id) => `#/reports/${REPORT_SECTIONS.some((s) => s.id === id) ? id : DEFAULT_SECTION}`;
