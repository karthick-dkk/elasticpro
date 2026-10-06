/**
 * Page-at-a-time table rendering.
 *
 * A cluster with a few thousand indices renders a few thousand <tr> on every draw. That
 * is slow, but the real problem is that it is unreadable: the operator scrolls looking
 * for one index and has no idea how far through the list they are. So the slice and the
 * control that moves it live here, once, and both tables use them — the Indices and
 * Shards pages had no shared notion of "a page" before, and two hand-rolled ones would
 * disagree about the last page the first time a filter changed the row count.
 *
 * `perPage` comes from config (tableRowsPerPage).
 */

import { h } from './dom.js';
import { num } from './fmt.js';

/**
 * Clamp a page number to one that exists for this many rows.
 *
 * Filtering is why this is not just `Math.max(0, page)`: someone on page 7 who then
 * types a search that matches four rows must land on the only page there is, not on an
 * empty page 7 that looks like "no results".
 */
export function clampPage(page, total, perPage) {
  const per = Math.max(1, Math.floor(perPage) || 1);
  const last = Math.max(0, Math.ceil(total / per) - 1);
  const p = Math.floor(Number(page)) || 0;
  return Math.min(Math.max(0, p), last);
}

export function pageCount(total, perPage) {
  const per = Math.max(1, Math.floor(perPage) || 1);
  return Math.max(1, Math.ceil(total / per));
}

/** The rows on `page`, and the 1-based range they occupy, for the "x–y of z" label. */
export function pageSlice(rows, page, perPage) {
  const all = rows || [];
  const per = Math.max(1, Math.floor(perPage) || 1);
  const p = clampPage(page, all.length, per);
  const start = p * per;
  const slice = all.slice(start, start + per);
  return {
    rows: slice,
    page: p,
    pages: pageCount(all.length, per),
    total: all.length,
    // 1-based and inclusive, and zero rows reports 0–0 rather than 1–0.
    first: slice.length ? start + 1 : 0,
    last: slice.length ? start + slice.length : 0,
  };
}

/**
 * Which page numbers to offer: the first, the last, and `span` either side of the current
 * one, with '…' standing in for each run left out. 0-based in, 0-based out.
 *
 * Every page as a button stops being a control somewhere past a dozen pages; only
 * Previous/Next makes page 9 of 12 nine clicks away. This is the middle.
 */
export function pageWindow(page, pages, span = 1) {
  const n = Math.max(1, Math.floor(pages) || 1);
  const p = Math.min(Math.max(0, Math.floor(page) || 0), n - 1);
  const want = new Set([0, n - 1]);
  for (let i = p - span; i <= p + span; i++) if (i >= 0 && i < n) want.add(i);
  const sorted = [...want].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((i, k) => {
    if (k > 0) {
      const gap = i - sorted[k - 1];
      // A gap of exactly one page is shown as that page: '…' in place of one number
      // saves nothing and hides where you are.
      if (gap === 2) out.push(i - 1);
      else if (gap > 2) out.push('…');
    }
    out.push(i);
  });
  return out;
}

/**
 * Previous / Next with a position label.
 *
 * Both buttons are always present and disable at the ends rather than disappearing:
 * a control that vanishes moves everything next to it, and on a table you are paging
 * through, that means the button you are aiming at jumps out from under the cursor.
 *
 * `numbers: true` adds numbered page buttons between them (pageWindow). `sizes` with
 * `perPage` and `onSize` adds a rows-per-page picker.
 */
export function pagerBar(slice, onPage, opts = {}) {
  const { label = 'rows', dense = false, numbers = false, sizes = null, perPage = null, onSize = null } = opts;
  const atStart = slice.page <= 0;
  const atEnd = slice.page >= slice.pages - 1;
  const sizePicker = sizes && onSize
    ? h('label.pager-size.muted', 'Rows per page ', (() => {
        const s = h('select', { 'aria-label': 'Rows per page', onchange: (e) => onSize(Number(e.target.value)) },
          ...sizes.map((n) => h('option', { value: String(n) }, String(n))));
        s.value = String(perPage);
        return s;
      })())
    : null;
  return h('div.pager', { class: dense ? 'pager sm' : 'pager' },
    h('span.pager-pos.muted',
      slice.total
        ? `${num(slice.first)}–${num(slice.last)} of ${num(slice.total)} ${label}`
        : `no ${label}`),
    sizePicker,
    h('span.pager-controls',
      h('button.btn.sm', {
        disabled: atStart,
        title: atStart ? 'Already on the first page' : 'Previous page',
        onclick: () => onPage(slice.page - 1),
      }, '‹ Previous'),
      numbers
        ? h('span.pager-nums', ...pageWindow(slice.page, slice.pages).map((p) => (p === '…'
            ? h('span.pager-gap.muted', '…')
            : h('button.btn.sm.pager-num', {
                'aria-current': p === slice.page ? 'page' : null,
                'aria-label': `Page ${p + 1}`,
                onclick: () => { if (p !== slice.page) onPage(p); },
              }, String(p + 1)))))
        : h('span.pager-page.muted', `Page ${num(slice.page + 1)} of ${num(slice.pages)}`),
      h('button.btn.sm', {
        disabled: atEnd,
        title: atEnd ? 'Already on the last page' : 'Next page',
        onclick: () => onPage(slice.page + 1),
      }, 'Next ›')));
}
