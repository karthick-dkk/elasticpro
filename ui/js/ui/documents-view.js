/**
 * Documents inside Indices — the view (the design of 2026-11-16: boards Main, Detail, Edit).
 *
 * Drawn by the Indices page in place of its list when the address is `#/indices/docs/<target>`:
 * a query-string box, the time range (when the indices have a date field), a fields panel
 * read from `_mapping` whose aggregatable fields show their top values, a page of hits with
 * server paging, and the document picked in a large dialog (full screen on demand; Escape closes
 * it), with a preview after the pointer rests on a row for two seconds. Read-only: the view never changes a
 * document (Edit and Delete were removed in 0.3.72 at the owner's request); the row's ⋯ menu
 * copies the JSON or opens it in REST. The arithmetic and the request shapes are
 * core/documents.js; nothing here computes a second copy.
 */

import { h, mount } from '../lib/dom.js';
import { num, dt } from '../lib/fmt.js';
import { client } from '../core/state.js';
import { hideAddress } from '../core/evidence.js';
import { jsonView } from '../lib/jsonview.js';
import { empty } from '../pages/common.js';
import { rowMenu, ICON, toast } from './menu.js';
import { navigateTo } from '../core/intent.js';
import { pagerBar } from '../lib/pager.js';
import { modal } from './modal.js';
import * as D from '../core/documents.js';

/**
 * A rows-per-page choice remembered per browser under `key` (localStorage, every access in
 * try/catch: a private window just means the default). The Indices list and the documents
 * table each keep one; the sizes and the default are core/documents.js's.
 */
export function pageSizePref(key, sizes) {
  return {
    get() {
      let raw = null;
      try { raw = window.localStorage.getItem(key); } catch (_) { /* no storage: the default */ }
      return D.clampPageSize(raw === null ? sizes[0] : raw, sizes);
    },
    set(n) {
      const v = D.clampPageSize(n, sizes);
      try { window.localStorage.setItem(key, String(v)); } catch (_) { /* not kept; used for now */ }
      return v;
    },
  };
}

const DOC_SIZE = pageSizePref('elasticpro.docs.perPage', D.DOC_PAGE_SIZES);
// Every opening starts on Custom with no dates: the whole of the indices, newest first (owner,
// 2026-11-26). A daily index from last month opened on "last 24h" showed nothing. A preset picked
// here holds for this view only; it is not carried to the next index.
const DEFAULT_RANGE = 'custom';

/**
 * Why the table is empty, in words that are true: "the indices hold no documents" only when
 * nothing narrowed the search (no query, no time window); otherwise what did.
 */
export function emptyDetail(st, win) {
  if (!st.query && !win) return 'The indices matched hold no documents';
  // No window: the search already covers all time, so there is no range to widen.
  if (!win) return `Query "${st.query}" — clear the query`;
  const when = st.range !== 'custom' ? ` in the last ${st.range}`
    : ` between ${win.from != null ? dt(win.from) : 'the oldest'} and ${win.to != null ? dt(win.to) : 'the newest'}`;
  return `Query "${st.query || '*'}"${when} — widen the time range or clear the query`;
}

/** One instance per (cluster, target): the Indices page keeps it between its redraws. */
export function documentsView(cluster, target, { onBack } = {}) {
  const st = {
    query: '', range: DEFAULT_RANGE, custom: { from: null, to: null },
    page: 0, perPage: DOC_SIZE.get(),
    fields: null, fieldsError: null, timeField: null,
    hits: [], hitsFrom: 0, total: null, loading: false, error: null, searched: false,   // hitsFrom: the `from` the hits on screen were read at
    selected: null,                     // the hit open in the dialog
    values: null,                       // { field, list, other, loading, error } under the clicked field
    gen: 0,                             // the search in flight; an older answer is dropped
  };
  const cl = () => client(cluster.id);

  const el = h('div.docs', { dataset: { target } });
  const top = h('div.docs-top');
  const fieldsBox = h('aside.docs-fields', { 'aria-label': 'Fields' });
  const main = h('section.docs-main');
  const body = h('div.docs-body', fieldsBox, main);
  el.append(top, body);

  /* ------------------------------------ data ------------------------------------ */

  const windowNow = () => D.rangeWindow(st.range, Date.now(), st.custom);

  async function loadMapping() {
    try {
      const m = await cl().json('GET', D.mappingPath(target), null, { timeoutMs: 30000 });
      st.fields = D.fieldsFromMapping(m);
      st.timeField = D.timeFieldOf(st.fields);
      st.fieldsError = null;
    } catch (e) {
      st.fields = []; st.timeField = null;
      st.fieldsError = hideAddress((e && e.message) || String(e), cluster);
    }
  }

  async function search() {
    const gen = ++st.gen;
    st.loading = true; st.error = null; drawTop(); drawMain();
    const from = st.page * st.perPage;
    try {
      // A person's search: asked of the cluster, never served from the core's short read cache
      // (maxAgeMs 0, as a Refresh reads).
      const r = await cl().json('POST', D.documentsPath(target),
        D.searchBody({ query: st.query, timeField: st.timeField, window: windowNow(), from, size: st.perPage }), { timeoutMs: 60000, maxAgeMs: 0 });
      if (gen !== st.gen) return;
      st.hits = (r && r.hits && r.hits.hits) || [];
      st.hitsFrom = from;
      st.total = r && r.hits ? r.hits.total : null;
      st.searched = true;
      // The selected document, re-read: the same _index/_id on this page is the newer copy.
      if (st.selected) {
        const again = st.hits.find((x) => x._index === st.selected._index && x._id === st.selected._id);
        if (again) st.selected = again;
      }
    } catch (e) {
      if (gen !== st.gen) return;
      st.error = hideAddress((e && e.message) || String(e), cluster);
      st.hits = []; st.total = null;
    }
    st.loading = false;
    drawTop(); drawMain();
  }

  async function loadValues(f) {
    st.values = { field: f.name, list: [], other: 0, loading: true, error: null };
    drawFields();
    try {
      const r = await cl().json('POST', D.documentsPath(target),
        D.valuesBody({ query: st.query, timeField: st.timeField, window: windowNow(), field: f.aggField }), { timeoutMs: 60000, maxAgeMs: 0 });
      if (!st.values || st.values.field !== f.name) return;
      const t = D.topValues(r);
      st.values = { field: f.name, list: t.values, other: t.other, loading: false, error: null };
    } catch (e) {
      if (!st.values || st.values.field !== f.name) return;
      st.values = { field: f.name, list: [], other: 0, loading: false, error: hideAddress((e && e.message) || String(e), cluster) };
    }
    drawFields();
  }

  function run() { st.page = 0; st.values = st.values ? { ...st.values, list: [], other: 0 } : null; search(); if (st.values) loadValuesByName(st.values.field); }
  function loadValuesByName(name) {
    const f = (st.fields || []).find((x) => x.name === name);
    if (f && f.aggregatable) loadValues(f);
  }

  /* ------------------------------------ top row ------------------------------------ */

  function drawTop() {
    const search1 = h('input#docs-q', {
      type: 'search', value: st.query, placeholder: 'query string — level:error AND host:web*  (empty = everything)',
      title: 'Elasticsearch query_string; Enter or ↻ runs it',
      oninput: (e) => { st.query = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') { st.query = e.target.value; run(); } },
    });
    const ranges = st.timeField
      ? h('div.seg.docs-ranges', { role: 'group', 'aria-label': 'Time range' },
          ...D.RANGES.map((r) => h('button.btn.sm', {
            type: 'button', 'aria-pressed': st.range === r.id ? 'true' : 'false', dataset: { range: r.id },
            title: r.id === 'custom' ? 'A range of your own' : `The last ${r.label} by ${st.timeField}`,
            // Custom with no dates is "everything": search at once, so a preset's result never stays
            // on screen under it. With dates set, Apply searches, as before.
            onclick: () => { if (st.range !== r.id) { st.range = r.id; if (r.id !== 'custom' || (st.custom.from == null && st.custom.to == null)) run(); else drawTop(); } },
          }, r.label)))
      : null;
    const toLocal = (ms) => (ms == null ? '' : new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16));
    const fromLocal = (v) => (v ? new Date(v).getTime() : null);
    const custom = st.timeField && st.range === 'custom'
      ? h('span.docs-custom', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
          h('input#docs-from', { type: 'datetime-local', value: toLocal(st.custom.from), 'aria-label': 'From', onchange: (e) => { st.custom.from = fromLocal(e.target.value); } }),
          h('span.muted', '–'),
          h('input#docs-to', { type: 'datetime-local', value: toLocal(st.custom.to), 'aria-label': 'To', onchange: (e) => { st.custom.to = fromLocal(e.target.value); } }),
          h('button.btn.sm', { type: 'button', onclick: () => run() }, 'Apply'))
      : null;
    mount(top,
      h('a.docs-back', { href: '#/indices', title: 'Back to the index list (search, filters and page kept)',
        onclick: (e) => { e.preventDefault(); if (onBack) onBack(); } }, '‹ Indices'),
      h('span.docs-target.mono', { title: target }, target),
      search1,
      ranges, custom,
      h('button#docs-refresh.btn.sm', { type: 'button', 'aria-label': st.loading ? 'Searching…' : 'Search again',
        title: st.loading ? 'Searching…' : 'Search again', disabled: st.loading, onclick: () => run() }, ICON.refresh));
  }

  /* ------------------------------------ fields ------------------------------------ */

  function drawFields() {
    const list = st.fields;
    const vals = st.values;
    const items = [h('div.docs-fields-h', list ? `Fields · ${num(list.length)}` : 'Fields')];
    if (!list) items.push(h('div.muted', { style: { padding: '8px 10px', fontSize: '12px' } }, 'Reading the mapping…'));
    else if (st.fieldsError) items.push(h('div', { style: { padding: '8px 10px', fontSize: '12px' } }, h('b', 'Mapping not readable'), h('div.mono.muted', { style: { fontSize: '11px' } }, st.fieldsError),
      h('div.muted', { style: { fontSize: '11.5px', marginTop: '4px' } }, 'The documents still search; the time range and the field values need view_index_metadata on these indices.')));
    else if (!list.length) items.push(h('div.muted', { style: { padding: '8px 10px', fontSize: '12px' } }, 'No fields mapped — the indices matched are empty, or none matched.'));
    for (const f of list || []) {
      const on = vals && vals.field === f.name;
      items.push(h('button.docs-field', {
        type: 'button', disabled: !f.aggregatable, 'aria-pressed': on ? 'true' : 'false', dataset: { field: f.name },
        title: f.aggregatable ? `Top ${D.TOP_VALUES} values of ${f.aggField}${f.conflict ? ' — mapped differently in another index' : ''}`
          : `${f.type}: not aggregatable (a text field without a .keyword sub-field) — search it in the box instead`,
        onclick: () => { if (on) { st.values = null; drawFields(); } else loadValues(f); },
      }, h('span.fname', f.name), h('span.ftype', f.type + (f.conflict ? ' !' : ''))));
      if (on) {
        items.push(h('div.docs-vals',
          vals.loading ? h('span.muted', 'Counting…') : null,
          vals.error ? h('span', { style: { color: 'var(--critical-ink)' } }, vals.error) : null,
          !vals.loading && !vals.error && !vals.list.length ? h('span.muted', windowNow() ? 'No values in this range' : 'No values') : null,
          ...vals.list.map((v) => h('button.docs-val', { type: 'button', title: `Add ${f.aggField}:"${v.value}" to the search`,
            // The field the count came from: a text field's value narrows by its .keyword, exactly.
            onclick: () => { st.query = D.addTerm(st.query, f.aggField, v.value); drawTop(); run(); } },
            h('span.vv', String(v.value)), h('span.vc', num(v.count)))),
          vals.other ? h('span.muted', { style: { fontSize: '11px' } }, `+${num(vals.other)} in other values`) : null));
      }
    }
    mount(fieldsBox, ...items);
  }

  /* ------------------------------------ table ------------------------------------ */

  /** The time column: the value as a local time when it parses, as it is when it does not, a dash when absent. */
  function timeCell(v) {
    if (v === null || v === undefined || v === '') return '–';
    const ms = D.timeMs(v);
    return Number.isFinite(ms) ? dt(ms) : String(v);
  }

  function menuFor(hit) {
    return [
      { label: 'Copy JSON', icon: '⧉', onClick: () => copyText(D.pretty(hit._source)) },
      { label: 'Open in REST', icon: ICON.console, onClick: () => navigateTo('console', { method: 'GET', path: D.docGetPath(hit), body: '' }) },
    ];
  }

  function drawMain() {
    // The rows are rebuilt: a preview or a pending one belongs to a row that is going away.
    peekHide();
    const tl = D.totalLabel(st.total);
    // The position of the hits on screen — while a page is loading, still the one being shown.
    const from = st.hitsFrom;
    const pg = D.docPages(st.total, st.perPage);
    const first = st.hits.length ? from + 1 : 0, last = from + st.hits.length;
    const meta = st.error ? null
      : !st.searched ? 'Searching…'
      : `${num(first)}–${num(last)} of ${tl.text} documents${pg.capped ? ' · the first 10,000 can be paged — narrow the search to see further' : ''}`;
    const tf = st.timeField;
    const rows = st.hits.map((hit) => {
      const sel = st.selected && st.selected._index === hit._index && st.selected._id === hit._id;
      return h('tr', { 'aria-selected': sel ? 'true' : 'false', dataset: { id: hit._id, index: hit._index },
        onclick: () => openDoc(hit),
        onmouseenter: (e) => peekSoon(hit, e.currentTarget), onmouseleave: peekLeave },
        tf ? h('td.mono', { style: { fontSize: '11.5px' } }, timeCell(hit._source ? hit._source[tf] : null)) : null,
        h('td.mono', { title: hit._index }, hit._index),
        h('td.mono', { title: hit._id }, hit._id),
        // No title: resting on the row shows the whole document after two seconds (peekSoon).
        h('td.docs-sum', D.summaryOf(hit._source, { skip: tf ? [tf] : [] })),
        h('td', { onclick: (e) => e.stopPropagation() }, rowMenu(() => menuFor(hit), { title: `Actions for ${hit._id}` })));
    });
    const table = h('div.tbl-wrap', h('table#docs-table.tbl',
      h('thead', h('tr', tf ? h('th', tf) : null, h('th', '_index'), h('th', '_id'), h('th', 'Document'), h('th', ''))),
      h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: tf ? 5 : 4 },
        st.error ? h('div.banner.err', { style: { margin: 0 } }, h('div', h('div.ttl', 'Search failed'), h('div.mono', st.error)))
          : st.loading ? h('div.muted', { style: { padding: '8px' } }, 'Searching…')
          : empty('No documents match', { detail: emptyDetail(st, tf ? windowNow() : null) })))]))));
    const slice = { page: st.loading ? Math.min(Math.floor(from / st.perPage), pg.pages - 1) : st.page, pages: pg.pages, total: tl.value, first, last };
    mount(main,
      h('div#docs-meta.docs-meta', { role: 'status' }, meta || ''),
      table,
      st.searched && !st.error ? pagerBar(slice, (p) => { st.page = Math.max(0, Math.min(p, pg.pages - 1)); search(); }, {
        label: 'documents', numbers: true, totalText: tl.text,
        sizes: D.DOC_PAGE_SIZES, perPage: st.perPage,
        onSize: (n) => { st.perPage = DOC_SIZE.set(n); st.page = 0; search(); },
      }) : null);
  }

  /* ------------------------------------ document ------------------------------------ */

  // The document opens in a large dialog (the owner, 0.3.101; it was a narrow pane on the right):
  // JSON or Fields, Copy (what the view shows), REST, and full screen. Escape closes it (modal.js).
  let view = 'json';
  function openDoc(hit) {
    peekHide();
    st.selected = hit; drawMain();
    const src = hit._source || {};
    const content = h('div.docs-doc-view');
    const seg = h('div.seg.docs-doc-seg', { role: 'group', 'aria-label': 'View' });
    const copyBtn = h('button.btn.sm#docs-doc-copy', { type: 'button', onclick: () => copyText(view === 'json' ? D.pretty(src) : D.fieldsText(src)) });
    let full = false;
    const fullBtn = h('button.btn.sm#docs-doc-full', { type: 'button' });
    // Both set by modal() while it builds the dialog (the actions callback runs before it returns).
    let ctxDone = () => {}, dialog = null;
    function drawView() {
      mount(seg, ...[['json', 'JSON'], ['fields', 'Fields']].map(([id, label]) =>
        h(`button.btn.sm${view === id ? '.primary' : ''}`, { type: 'button', 'aria-pressed': String(view === id), dataset: { view: id },
          onclick: () => { view = id; drawView(); } }, label)));
      copyBtn.textContent = view === 'json' ? 'Copy JSON' : 'Copy fields';
      copyBtn.title = view === 'json' ? 'Copy the document as JSON' : 'Copy every field as name and value, one per line';
      mount(content, view === 'json' ? jsonView(src) : fieldTable(src));
    }
    const p = modal(`${hit._index} / ${hit._id}`, null, [
      h('div.docs-doc-bar', seg, h('span', { style: { flex: '1' } }), copyBtn,
        h('button.btn.sm', { type: 'button', title: `Open GET ${D.docGetPath(hit)} in the REST console`,
          onclick: () => { ctxDone(); navigateTo('console', { method: 'GET', path: D.docGetPath(hit), body: '' }); } }, 'REST'),
        fullBtn),
      content,
    ], (ctx) => { ctxDone = ctx.done; dialog = ctx.dialog; return []; }, { width: '1100px', cls: 'docs-doc' });
    function drawFull() {
      if (dialog) { dialog.classList.toggle('full', full); if (dialog.parentElement) dialog.parentElement.classList.toggle('docs-doc-full', full); }
      fullBtn.textContent = full ? '⤡ Exit full screen' : '⤢ Full screen';
      fullBtn.title = full ? 'Back to the dialog size' : 'Use the whole window';
      fullBtn.setAttribute('aria-pressed', String(full));
    }
    fullBtn.onclick = () => { full = !full; drawFull(); };
    drawView(); drawFull();
    p.then(() => { if (st.selected === hit) { st.selected = null; if (el.isConnected) drawMain(); } });
  }

  /** The Fields view: one row per field (dotted names), each with its own copy button. */
  function fieldTable(src) {
    const rows = D.flatFields(src);
    if (!rows.length) return h('div.muted', { style: { padding: '8px' } }, 'This document has no fields');
    return h('table.tbl.docs-doc-fields', h('tbody', ...rows.map(([k, v]) => {
      const text = D.fieldText(v);
      return h('tr', { dataset: { field: k } },
        h('th.mono', { scope: 'row' }, k),
        h('td.mono', text),
        h('td', h('button.btn.sm.ghost.icon', { type: 'button', title: `Copy the value of ${k}`, 'aria-label': `Copy the value of ${k}`, onclick: () => copyText(text) }, '⧉')));
    })));
  }

  /* ------------------------------------ preview ------------------------------------ */

  // Resting the pointer on a row for two seconds shows the document beside it (the owner,
  // 0.3.101). It stays while the pointer is on the row or on the preview, and goes when the
  // pointer leaves both, on a click, on Escape, on scroll, or when the view is left.
  const PEEK_MS = 2000;
  let peekTimer = 0, leaveTimer = 0, peekEl = null;
  function peekSoon(hit, row) {
    clearTimeout(peekTimer); clearTimeout(leaveTimer);
    if (peekEl && peekEl.dataset.id === `${hit._index}/${hit._id}`) return;
    peekHide();
    peekTimer = setTimeout(() => peekShow(hit, row), PEEK_MS);
  }
  function peekLeave() { clearTimeout(peekTimer); clearTimeout(leaveTimer); leaveTimer = setTimeout(peekHide, 200); }
  function peekShow(hit, row) {
    if (!el.isConnected || !row.isConnected || document.querySelector('.modal-overlay')) return;
    peekEl = h('div.docs-peek', { role: 'tooltip', dataset: { id: `${hit._index}/${hit._id}` },
      onmouseenter: () => clearTimeout(leaveTimer), onmouseleave: peekLeave },
      h('div.docs-peek-h', h('span.mono', `${hit._index} / `, h('b.mono', hit._id)), h('span.muted', 'click the row to open')),
      jsonView(hit._source || {}));
    document.body.append(peekEl);
    const r = row.getBoundingClientRect();
    const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    const w = Math.min(560, vw - 32);
    const left = Math.max(16, Math.min(r.left + Math.min(240, r.width / 3), vw - w - 16));
    const below = vh - r.bottom, above = r.top;
    peekEl.style.width = `${w}px`;
    peekEl.style.left = `${left}px`;
    if (below >= 220 || below >= above) { peekEl.style.top = `${r.bottom + 4}px`; peekEl.style.maxHeight = `${Math.max(120, below - 16)}px`; }
    else { peekEl.style.bottom = `${vh - r.top + 4}px`; peekEl.style.maxHeight = `${Math.max(120, above - 16)}px`; }
    window.addEventListener('keydown', peekKey, true);
    window.addEventListener('scroll', peekHide, true);
    window.addEventListener('hashchange', peekHide);
  }
  function peekKey(e) { if (e.key === 'Escape') peekHide(); }
  function peekHide() {
    clearTimeout(peekTimer); clearTimeout(leaveTimer);
    window.removeEventListener('keydown', peekKey, true);
    window.removeEventListener('scroll', peekHide, true);
    window.removeEventListener('hashchange', peekHide);
    if (peekEl) { peekEl.remove(); peekEl = null; }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied', 'ok', 1600); }
    catch (_) { toast('Could not copy here — select the JSON and copy it', 'warn'); }
  }

  /* ------------------------------------ start ------------------------------------ */

  drawTop(); drawFields(); drawMain();
  (async () => { await loadMapping(); drawTop(); drawFields(); await search(); })();

  el.refresh = run;
  return el;
}
