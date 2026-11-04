/**
 * Where on the Reports page a hash points (docs/REPORTS.md, "The page"). Pure, so the shell,
 * the page and tools/unit/reports-page.test.mjs read one definition.
 *
 *   #/reports            → Overview
 *   #/reports/<section>  → that section
 *   #/volume, #/volume/… → the same (the page was "Volume report" until 0.3.53; the Zabbix
 *                          menu entry elasticpro.volume and saved links still open #/volume)
 */

/** The sections, in the order the section nav shows them. */
export const REPORT_SECTIONS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'daily', label: 'Daily & monthly' },
  { id: 'capacity', label: 'Capacity & retention' },
  { id: 'measure', label: 'Measure size' },
  { id: 'planning', label: 'Planning' },
  { id: 'exports', label: 'Exports & schedules' },
]);
export const DEFAULT_SECTION = 'overview';

/** Old page ids that open a page under its new id. */
export const PAGE_ALIAS = Object.freeze({ volume: 'reports' });

/** A page id with its alias resolved. */
export const pageAlias = (id) => (id && Object.prototype.hasOwnProperty.call(PAGE_ALIAS, id) ? PAGE_ALIAS[id] : id);

/**
 * `{page, rest}` from a hash: `#/reports/capacity?x` → `{page: 'reports', rest: 'capacity'}`.
 * The page is the alias-resolved id; `rest` is what follows it, '' when nothing does.
 */
export function parseHash(hash) {
  const path = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  const [first, ...more] = path.split('/');
  return { page: pageAlias(first || ''), rest: more.filter(Boolean).join('/') };
}

/** The Reports section a hash names; Overview when it names none or one that does not exist. */
export function sectionOfHash(hash) {
  const { page, rest } = parseHash(hash);
  const id = page === 'reports' ? rest.split('/')[0] : '';
  return REPORT_SECTIONS.some((s) => s.id === id) ? id : DEFAULT_SECTION;
}

/** The hash for a section. */
export const sectionHash = (id) => `#/reports/${REPORT_SECTIONS.some((s) => s.id === id) ? id : DEFAULT_SECTION}`;
