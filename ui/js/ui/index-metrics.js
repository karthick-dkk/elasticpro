/**
 * Index metrics: how much there is, broken down.
 *
 * These moved off the Indices page. That page manages indices — list, filter, open,
 * close, delete — and the question "how much came in, and from where" is a different
 * one that belongs with the rest of the capacity figures. They sat on the Indices page
 * because that is where the data was already loaded, which is not a reason.
 *
 * All three take the cluster and a `redraw` callback rather than reaching for the host
 * page's own draw(): the volume report renders them per cluster, and a chart that
 * re-rendered the whole Indices page from the Volume page is how a shared component
 * becomes un-shareable.
 */

import { h } from '../lib/dom.js';
import { bytes, num, compact, toCsv, download } from '../lib/fmt.js';
import { state } from '../core/state.js';
import { hbarList, timeHistogram } from '../lib/charts.js';
import { card, table, empty } from '../pages/common.js';
import { fetchFieldVolume, storeFieldVolume, fieldVolumeFor, SPIKE_WINDOW_DAYS, SPIKE_THRESHOLD }
  from '../core/field-volume.js';

/** Volume-analysis UI state: which field, how far back, and whether a run is in flight. */
const va = { field: null, days: 14, topN: 12, running: false, error: null, byTerm: null, selectedTerm: null };
/**
 * How this card asks its host page to re-render.
 *
 * Module-level and not a parameter because the async work (runAnalysis) outlives the
 * render that started it: the operator picks a field, the aggregation takes two seconds,
 * and the callback that must fire then is the one belonging to whichever page is showing
 * the card — which is exactly the host that last rendered it.
 */
let _redraw = () => {};

/**
 * Store size per source, from the index naming pattern.
 * `onSelect` is optional — nothing to filter when this is read on the Volume report.
 */
export function sourceSizeChart(indices, { onSelect = null } = {}) {
  const m = new Map();
  (indices || []).forEach((r) => {
    const k = r.source || '__none';
    const cur = m.get(k) || { key: k, indices: 0, docs: 0, size: 0 };
    cur.indices++; cur.docs += r.docs; cur.size += r.size;
    m.set(k, cur);
  });
  const list = [...m.values()].sort((a, b) => b.size - a.size);
  if (!list.length) return empty('No indices');
  return hbarList(list.map((x) => ({ key: x.key, label: x.key === '__none' ? '(unparsed)' : x.key, value: x.size,
      sub: `${num(x.indices)} indices · ${compact(x.docs)} docs` })),
    { format: bytes, topN: 12, labelWidth: 150, onSelect: onSelect || undefined });
}

export function volumeAnalysisCard(c, redraw = () => {}) {
  _redraw = redraw;
  const fields = c.volumeFields && c.volumeFields.length ? c.volumeFields : [];
  if (!fields.length) {
    return card('Volume analysis', 'not configured',
      empty('Set volumeFields on this cluster — for example tag1, src_hostname — to break daily volume down by field.'));
  }
  if (!va.field || !fields.includes(va.field)) va.field = fields[0];

  const stored = fieldVolumeFor(c.id);
  const analysis = stored && stored.byField[va.field];
  const spikes = analysis ? (analysis.terms || []).filter((t) => t.spiked) : [];

  const controls = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '8px' } },
    h('label.field', 'Field', (() => {
      const sel = h('select', { onchange: (e) => { va.field = e.target.value; va.selectedTerm = null; runAnalysis(c); } },
        ...fields.map((f) => h('option', { value: f }, f)));
      sel.value = va.field; return sel;
    })()),
    h('label.field', 'Window', (() => {
      const sel = h('select', { onchange: (e) => { va.days = Number(e.target.value); runAnalysis(c); } },
        ...[7, 14, 30, 60].map((n) => h('option', { value: String(n) }, `${n} days`)));
      sel.value = String(va.days); return sel;
    })()),
    h('label.field', 'Top', (() => {
      const sel = h('select', { onchange: (e) => { va.topN = Number(e.target.value); runAnalysis(c); } },
        ...[5, 12, 25, 50].map((n) => h('option', { value: String(n) }, String(n))));
      sel.value = String(va.topN); return sel;
    })()),
    h('button.btn.sm.primary', { disabled: va.running, onclick: () => runAnalysis(c) },
      va.running ? 'Analysing…' : analysis ? '↻ Re-run' : 'Analyse'),
    analysis ? h('button.btn.sm', { onclick: () => exportAnalysis(c, analysis) }, 'Export CSV') : null,
    h('span.muted', { style: { fontSize: '11px', marginLeft: 'auto' } },
      analysis ? `${analysis.resolvedField} · ${analysis.terms.length} values` : 'one aggregation per run'));

  const body = h('div', { style: { display: 'grid', gap: '9px' } },
    controls,
    va.error ? h('div.banner.err', { style: { margin: 0 } }, h('div', h('div.ttl', 'Analysis failed'), h('div.mono', va.error))) : null,
    spikes.length ? spikeBanner(c, spikes) : null,
    // A field the indices do not carry aggregates to nothing, which is not an error and
    // is not zero volume either — it used to draw an empty table and look broken. Say
    // which name was actually tried, because the field is resolved to its .keyword
    // sub-field when there is one and that is the name that came back empty.
    analysis && !analysis.terms.length
      ? empty(`No values for "${analysis.resolvedField}" in the last ${va.days} days. `
            + 'Either these indices do not carry that field, or nothing in the window has a value for it.')
      : analysis ? analysisBody(c, analysis) : va.running ? null
        : empty(`Press Analyse to break the last ${va.days} days down by ${va.field}.`));

  return card('Volume analysis', `daily volume by ${va.field}`, body,
    spikes.length ? [pill(`${spikes.length} spiking`, 'red')] : null);
}

function spikeBanner(c, spikes) {
  return h('div.banner.err', { style: { margin: 0 } },
    h('div', { style: { minWidth: 0 } },
      h('div.ttl', `${spikes.length} ${va.field} value${spikes.length === 1 ? '' : 's'} above the ${SPIKE_WINDOW_DAYS}-day average by more than ${Math.round((SPIKE_THRESHOLD - 1) * 100)}%`),
      h('div', { style: { display: 'grid', gap: '2px', marginTop: '3px' } },
        ...spikes.slice(0, 6).map((t) => h('div', { style: { fontSize: '12px' } },
          h('b.mono', t.term), ' — ',
          `${num(t.latest.docs)} docs on ${t.latestDay} against a ${Math.round(t.baseline).toLocaleString()} average`,
          h('span', { style: { color: 'var(--critical)', fontWeight: 640 } }, `  +${Math.round(t.changePct)}%`))),
        spikes.length > 6 ? h('div.muted', { style: { fontSize: '11.5px' } }, `…and ${spikes.length - 6} more`) : null)));
}

function analysisBody(c, a) {
  const term = va.selectedTerm && a.terms.find((t) => t.term === va.selectedTerm);
  const chartFor = term || null;

  // Daily totals for the chosen term, or the whole field when nothing is picked.
  const series = chartFor
    ? chartFor.series
    : a.days.map((day) => ({ day, docs: a.terms.reduce((s, t) => s + ((t.series.find((p) => p.day === day) || {}).docs || 0), 0),
                             bytes: a.terms.reduce((s, t) => s + ((t.series.find((p) => p.day === day) || {}).bytes || 0), 0) }));

  const buckets = series.map((p) => ({ t: new Date(`${p.day}T00:00:00Z`).getTime(), v: p.docs }));

  const trs = a.terms.map((t) => h('tr', {
      style: { cursor: 'pointer', background: va.selectedTerm === t.term ? 'var(--accent-soft)' : '' },
      onclick: () => { va.selectedTerm = va.selectedTerm === t.term ? null : t.term; _redraw(); },
    },
    h('td.mono', { style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: t.term }, t.term),
    h('td.num', compact(t.docs)),
    h('td.num', t.latest ? compact(t.latest.docs) : '–'),
    h('td.num.muted', t.baseline ? compact(Math.round(t.baseline)) : '–'),
    h('td.num', t.changePct === null ? h('span.muted', '–')
      : h('span', { style: { color: t.spiked ? 'var(--critical)' : t.changePct < -25 ? 'var(--warning)' : 'inherit',
                             fontWeight: t.spiked ? 640 : 400 } },
          `${t.changePct >= 0 ? '+' : ''}${Math.round(t.changePct)}%`)),
    h('td.num.muted', { title: 'Estimated from this value’s share of the day’s documents' },
      t.latest ? bytes(t.latest.bytes) : '–'),
    h('td', t.spiked ? pill('spike', 'red') : t.changePct !== null && t.changePct < -50 ? pill('dropped', 'yellow') : pill('steady', 'grey'))));

  return h('div', { style: { display: 'grid', gap: '9px' } },
    h('div',
      h('div', { style: { fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '3px' } },
        chartFor ? `Daily documents for ${chartFor.term} — click the row again to show every value`
                 : `Daily documents across the top ${a.terms.length} ${va.field} values — click a row to isolate one`),
      timeHistogram(buckets, { height: 130, yLabel: 'Docs' })),
    table(['Value', { label: 'Docs in window', num: true }, { label: 'Latest day', num: true },
           { label: `${SPIKE_WINDOW_DAYS}-day avg`, num: true }, { label: 'Change', num: true },
           { label: 'Est. size', num: true }, 'State'],
      trs, { emptyText: 'No values returned — check that the field exists and is aggregatable.' }),
    h('div.muted', { style: { fontSize: '11px' } },
      'Document counts are exact. Size is an estimate: Elasticsearch reports store size per index, ' +
      'never per field value, so a value’s share of the day’s documents is applied to that day’s index size.'));
}

async function runAnalysis(c) {
  va.running = true; va.error = null; _redraw();
  try {
    const a = await fetchFieldVolume(c, { field: va.field, days: va.days, topN: va.topN });
    if (a.error) va.error = a.error;
    storeFieldVolume(c.id, va.field, a);
  } catch (e) {
    va.error = e.message || String(e);
  }
  va.running = false;
  _redraw();
}

function exportAnalysis(c, a) {
  const rows = [];
  for (const t of a.terms) {
    for (const p of t.series) {
      rows.push({
        cluster: c.name, field: a.resolvedField, value: t.term, day: p.day,
        docs: p.docs, estimated_bytes: p.bytes,
        latest_day: t.latestDay || '', latest_docs: t.latest ? t.latest.docs : '',
        baseline_avg_docs: t.baseline === null || t.baseline === undefined ? '' : Math.round(t.baseline),
        change_pct: t.changePct === null ? '' : Math.round(t.changePct),
        spiked: t.spiked ? 'YES' : 'NO',
      });
    }
  }
  download(`volume-by-${a.resolvedField}-${c.id}-${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(rows), 'text/csv');
}

export function perDayChart(rows, { onSelect = null } = {}) {
  const byDay = new Map();
  rows.forEach((r) => { if (!r.day) return; const v = byDay.get(r.day) || { n: 0, size: 0 }; v.n++; v.size += r.size; byDay.set(r.day, v); });
  const days = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 14);
  if (!days.length) return empty('No date-suffixed indices in the current filter');
  return hbarList(days.map(([d, v]) => ({ key: d, label: d, value: v.size, sub: `${v.n} indices` })),
    { format: bytes, topN: 14, labelWidth: 100, showOther: false, sort: false, onSelect: onSelect || undefined });
}
