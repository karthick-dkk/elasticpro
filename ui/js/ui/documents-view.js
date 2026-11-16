/**
 * Documents inside Indices — the view (the design of 2026-11-16: boards Main, Detail, Edit).
 *
 * Drawn by the Indices page in place of its list when the address is `#/indices/docs/<target>`:
 * a query-string box, the time range (when the indices have a date field), a fields panel
 * read from `_mapping` whose aggregatable fields show their top values, a page of hits with
 * server paging, and the document picked on the right. Edit and Delete are an admin's, from
 * the row's ⋯ menu, through the same write gate every page uses (core/writes.js): a write
 * names the version it read (`if_seq_no` / `if_primary_term`), so a document changed since is
 * refused by the cluster and said so, never overwritten. The arithmetic and the request shapes
 * are core/documents.js; nothing here computes a second copy.
 */

import { h, mount } from '../lib/dom.js';
import { num, dt } from '../lib/fmt.js';
import { client } from '../core/state.js';
import { hideAddress } from '../core/evidence.js';
import { jsonView } from '../lib/jsonview.js';
import { empty } from '../pages/common.js';
import { rowMenu, ICON, toast } from './menu.js';
import { modal } from './modal.js';
import { navigateTo } from '../core/intent.js';
import { roleMayWrite, ensureWrites } from '../core/writes.js';
import { pagerBar } from '../lib/pager.js';
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
const RANGE_KEY = 'elasticpro.docs.range';
const DEFAULT_RANGE = '24h';

/** One instance per (cluster, target): the Indices page keeps it between its redraws. */
export function documentsView(cluster, target, { onBack } = {}) {
  let remembered = DEFAULT_RANGE;
  try { remembered = window.localStorage.getItem(RANGE_KEY) || DEFAULT_RANGE; } catch (_) { /* default */ }
  const st = {
    query: '', range: D.RANGES.some((r) => r.id === remembered) ? remembered : DEFAULT_RANGE, custom: { from: null, to: null },
    page: 0, perPage: DOC_SIZE.get(),
    fields: null, fieldsError: null, timeField: null,
    hits: [], hitsFrom: 0, total: null, loading: false, error: null, searched: false,   // hitsFrom: the `from` the hits on screen were read at
    selected: null,                     // the hit on the right
    values: null,                       // { field, list, other, loading, error } under the clicked field
    edit: null,                         // { hit, text } while an admin edits the selected document
    gen: 0,                             // the search in flight; an older answer is dropped
  };
  const cl = () => client(cluster.id);

  const el = h('div.docs', { dataset: { target } });
  const top = h('div.docs-top');
  const fieldsBox = h('aside.docs-fields', { 'aria-label': 'Fields' });
  const main = h('section.docs-main');
  const detail = h('aside.docs-detail', { hidden: true, 'aria-label': 'Document' });
  const body = h('div.docs-body', fieldsBox, main, detail);
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
      // A person's search, often right after their own write: asked of the cluster, never served
      // from the core's short read cache (maxAgeMs 0, as a Refresh reads).
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
        if (again && !st.edit) st.selected = again;
      }
    } catch (e) {
      if (gen !== st.gen) return;
      st.error = hideAddress((e && e.message) || String(e), cluster);
      st.hits = []; st.total = null;
    }
    st.loading = false;
    drawTop(); drawMain(); drawDetail();
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
            onclick: () => { if (st.range !== r.id) { st.range = r.id; try { window.localStorage.setItem(RANGE_KEY, r.id); } catch (_) { /* fine */ } if (r.id !== 'custom') run(); else drawTop(); } },
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
          !vals.loading && !vals.error && !vals.list.length ? h('span.muted', 'No values in this range') : null,
          ...vals.list.map((v) => h('button.docs-val', { type: 'button', title: `Add ${f.name}:"${v.value}" to the search`,
            onclick: () => { st.query = D.addTerm(st.query, f.name, v.value); drawTop(); run(); } },
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
    const items = [
      { label: 'Copy JSON', icon: '⧉', onClick: () => copyText(D.pretty(hit._source)) },
      { label: 'Open in REST', icon: ICON.console, onClick: () => navigateTo('console', { method: 'GET', path: D.docGetPath(hit), body: '' }) },
    ];
    // Edit and Delete are an admin's: anyone else never sees them (the core refuses regardless).
    if (roleMayWrite()) {
      items.push({ sep: true },
        { label: 'Edit…', icon: ICON.edit, onClick: () => startEdit(hit) },
        { label: 'Delete…', icon: ICON.delete, danger: true, onClick: () => deleteDoc(hit) });
    }
    return items;
  }

  function drawMain() {
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
        onclick: () => { if (st.edit && st.edit.hit !== hit && !leaveEdit()) return; st.selected = hit; drawMain(); drawDetail(); } },
        tf ? h('td.mono', { style: { fontSize: '11.5px' } }, timeCell(hit._source ? hit._source[tf] : null)) : null,
        h('td.mono', { title: hit._index }, hit._index),
        h('td.mono', { title: hit._id }, hit._id),
        h('td.docs-sum', { title: D.summaryOf(hit._source, { skip: tf ? [tf] : [], max: 600 }) }, D.summaryOf(hit._source, { skip: tf ? [tf] : [] })),
        h('td', { onclick: (e) => e.stopPropagation() }, rowMenu(() => menuFor(hit), { title: `Actions for ${hit._id}` })));
    });
    const table = h('div.tbl-wrap', h('table#docs-table.tbl',
      h('thead', h('tr', tf ? h('th', tf) : null, h('th', '_index'), h('th', '_id'), h('th', 'Document'), h('th', ''))),
      h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: tf ? 5 : 4 },
        st.error ? h('div.banner.err', { style: { margin: 0 } }, h('div', h('div.ttl', 'Search failed'), h('div.mono', st.error)))
          : st.loading ? h('div.muted', { style: { padding: '8px' } }, 'Searching…')
          : empty('No documents match', { detail: st.query || (tf && st.range !== 'custom') ? `Query "${st.query || '*'}"${tf ? ` in the last ${st.range}` : ''} — widen the time range or clear the query` : 'The indices matched hold no documents' })))]))));
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

  /* ------------------------------------ detail / edit ------------------------------------ */

  function drawDetail() {
    const hit = st.selected;
    detail.hidden = !hit;
    body.classList.toggle('with-detail', !!hit);
    if (!hit) { mount(detail); return; }
    const head = h('div.docs-detail-h',
      h('span.docs-id', { title: `${hit._index} / ${hit._id}` }, `${hit._index} / `, h('b', hit._id)),
      h('button.btn.sm', { type: 'button', title: 'Copy the document as JSON', onclick: () => copyText(D.pretty(hit._source)) }, 'Copy'),
      h('button.btn.sm', { type: 'button', title: `Open GET ${D.docGetPath(hit)} in the REST console`,
        onclick: () => navigateTo('console', { method: 'GET', path: D.docGetPath(hit), body: '' }) }, 'REST'),
      h('button.btn.sm.ghost', { type: 'button', title: 'Close', 'aria-label': 'Close the document', onclick: () => { if (st.edit && !leaveEdit()) return; st.selected = null; drawMain(); drawDetail(); } }, '×'));
    if (st.edit && st.edit.hit === hit) { mount(detail, head, editor(hit)); return; }
    mount(detail, head, jsonView(hit._source || {}));
  }

  /** Leaving an edit with changes asks nothing and keeps nothing: the text is the dialog's job. */
  function leaveEdit() { st.edit = null; return true; }

  async function startEdit(hit) {
    if (!(await ensureWrites())) return;
    st.selected = hit;
    st.edit = { hit, text: D.pretty(hit._source || {}) };
    drawMain(); drawDetail();
  }

  function editor(hit) {
    const status = h('div#docs-edit-status.docs-edit-status', { role: 'status' });
    const review = h('button#docs-review.btn.sm.primary', { type: 'button' }, 'Review and save…');
    const paint = () => {
      const s = D.editStatus(st.edit.text, hit._source || {});
      status.className = `docs-edit-status ${s.ok ? 'good' : 'bad'}`;
      status.textContent = s.ok ? `✓ Valid JSON · ${s.changes === 1 ? '1 change' : `${num(s.changes)} changes`}` : `✕ ${s.error}`;
      review.disabled = !s.ok || s.changes === 0;
      review.title = !s.ok ? 'Fix the JSON first' : s.changes === 0 ? 'Nothing changed yet' : 'See the difference, then save';
      return s;
    };
    const ta = h('textarea#docs-editor.docs-editor', { spellcheck: false, 'aria-label': 'Document JSON',
      oninput: (e) => { st.edit.text = e.target.value; paint(); } });
    ta.value = st.edit.text;
    review.addEventListener('click', () => { const s = paint(); if (s.ok && s.changes) reviewAndSave(hit, s.value); });
    paint();
    return h('div.docs-edit',
      ta, status,
      h('div.docs-edit-acts',
        h('button.btn.sm', { type: 'button', onclick: () => { st.edit = null; drawDetail(); } }, 'Cancel'),
        review));
  }

  async function reviewAndSave(hit, value) {
    const diff = D.lineDiff(D.pretty(hit._source || {}), D.pretty(value));
    const path = D.docPath(hit);
    const saved = await modal('Review and save', `${hit._index} / ${hit._id} on ${cluster.name}`, [
      h('pre#docs-diff.docs-diff', ...diff.map((l) => h(`span.diff-${l.kind}`, l.text))),
      h('div', h('div.muted', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.05em' } }, 'Request'),
        h('div#docs-req.docs-req', `PUT ${path}`),
        h('div.muted', { style: { fontSize: '11.5px', marginTop: '2px' } }, 'The version you read is named in the request: a document changed since is refused, not overwritten.')),
    ], (ctx) => [
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { type: 'button', onclick: () => ctx.done(false) }, 'Cancel'),
        h('button#docs-save.btn.primary', { type: 'button', onclick: async (e) => {
          const btn = e.currentTarget; const label = btn.textContent;
          btn.disabled = true; btn.textContent = 'Saving…'; ctx.msg(null);
          try {
            await cl().json('PUT', path, value, { allowWrites: true, timeoutMs: 30000 });
            ctx.done(true);
          } catch (err) {
            // A 409 is the point of if_seq_no: say it, keep the text, let them reload and look.
            ctx.msg(D.writeOutcome(err).message);
            btn.disabled = false; btn.textContent = label;
          }
        } }, 'Save')),
    ], { width: '760px' });
    if (saved !== true) return;
    toast(`Saved ${hit._id}`, 'ok');
    st.edit = null;
    await search();
  }

  async function deleteDoc(hit) {
    if (!(await ensureWrites())) return;
    const path = D.docPath(hit);
    const input = h('input#docs-del-echo', { type: 'text', spellcheck: false, autocomplete: 'off', placeholder: hit._id, style: { fontFamily: 'var(--mono)' } });
    const done = await modal(`Delete ${hit._id}?`, `${hit._index} on ${cluster.name}`, [
      h('div.banner.err', { style: { margin: 0 } }, h('div', h('div.ttl', 'This cannot be undone'), h('div', 'The document is removed from the index. A snapshot taken before now still holds it.'))),
      h('label.field', 'Type the whole document id to confirm', input),
      h('div.docs-req.muted', `DELETE ${path}`),
    ], (ctx) => {
      const del = h('button#docs-delete.btn.danger', { type: 'button', disabled: true, title: 'Type the whole id first', onclick: async (e) => {
        const btn = e.currentTarget; const label = btn.textContent;
        btn.disabled = true; btn.textContent = 'Deleting…'; ctx.msg(null);
        try {
          await cl().json('DELETE', path, null, { allowWrites: true, timeoutMs: 30000 });
          ctx.done(true);
        } catch (err) {
          ctx.msg(D.writeOutcome(err).message);
          btn.disabled = input.value.trim() !== hit._id; btn.textContent = label;
        }
      } }, 'Delete');
      input.addEventListener('input', () => { del.disabled = input.value.trim() !== hit._id; del.title = del.disabled ? 'Type the whole id first' : `Delete ${hit._id}`; });
      return [h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { type: 'button', onclick: () => ctx.done(false) }, 'Cancel'), del)];
    }, { width: '560px' });
    if (done !== true) return;
    toast(`Deleted ${hit._id}`, 'ok');
    if (st.selected && st.selected._id === hit._id && st.selected._index === hit._index) { st.selected = null; st.edit = null; drawDetail(); }
    await search();
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied', 'ok', 1600); }
    catch (_) { toast('Could not copy here — select the JSON and copy it', 'warn'); }
  }

  /* ------------------------------------ start ------------------------------------ */

  drawTop(); drawFields(); drawMain(); drawDetail();
  (async () => { await loadMapping(); drawTop(); drawFields(); await search(); })();

  el.refresh = run;
  return el;
}
