/** Hand-rolled SVG charts (MV3 forbids remote scripts, so no chart CDN).
 *  Colors are referenced as CSS custom properties so light/dark swap in one place. */

import { h, svg, tooltip, mount } from './dom.js';
import { bytes, num, pct } from './fmt.js';

export const SERIES = ['var(--series-1)','var(--series-2)','var(--series-3)','var(--series-4)',
                       'var(--series-5)','var(--series-6)','var(--series-7)','var(--series-8)'];
export const STATUS = { good: 'var(--good)', warning: 'var(--warning)', serious: 'var(--serious)', critical: 'var(--critical)' };

/** Stable color for an entity name: colour follows the entity, never its rank. */
const colorMemo = new Map();
export function seriesColor(key) {
  if (!colorMemo.has(key)) {
    let n = 0;
    for (let i = 0; i < key.length; i++) n = (n * 31 + key.charCodeAt(i)) >>> 0;
    colorMemo.set(key, SERIES[n % SERIES.length]);
  }
  return colorMemo.get(key);
}
/** Assign slots in a fixed order for a known, ordered set (never cycled past 8). */
export function assignSlots(keys) {
  const map = new Map();
  keys.slice(0, SERIES.length).forEach((k, i) => map.set(k, SERIES[i]));
  return (k) => map.get(k) || 'var(--text-muted)';
}

function tipRow(label, value) {
  return h('div.r', h('span.sec', label), h('b', { style: { display: 'inline', fontSize: '11.5px' } }, value));
}

/* ------------------------------- horizontal bars ------------------------------ */
/**
 * items: [{ key, label, value, sub, color }]
 * Rendered as HTML rows (not SVG) so labels keep their true type size at any width.
 * Every row is direct-labelled - that is the relief for the low-contrast light steps.
 */
export function hbarList(items, opts = {}) {
  const { format = num, topN = 10, showOther = true, tipTitle = (i) => i.label, categorical = false } = opts;
  const sorted = opts.sort === false ? [...items] : [...items].sort((a, b) => b.value - a.value);
  let rows = sorted.slice(0, topN);
  if (showOther && sorted.length > topN) {
    const rest = sorted.slice(topN);
    rows = rows.concat([{ key: '__other', label: `Other (${rest.length})`,
      value: rest.reduce((s, r) => s + r.value, 0), color: 'var(--text-muted)' }]);
  }
  if (!rows.length) return h('div.tbl-empty', 'No data');
  const max = Math.max(1, ...rows.map((r) => r.value));

  const el = h('div.chart', { style: { display: 'grid', gap: '7px' } });
  rows.forEach((r) => {
    // One measure, one colour. Hue only carries meaning when `categorical` is set.
    const color = r.color || (categorical ? seriesColor(r.key || r.label) : 'var(--series-1)');
    const w = Math.max(1.5, (r.value / max) * 100);
    const row = h('div', {
      style: {
        display: 'grid', gridTemplateColumns: `${opts.labelWidth || 150}px 1fr auto`,
        alignItems: 'center', gap: '10px', cursor: opts.onSelect ? 'pointer' : 'default',
      },
      onmousemove: (e) => tooltip.show(h('div', h('b', tipTitle(r)), tipRow('Value', format(r.value)),
        r.sub ? tipRow('', r.sub) : null), e.clientX, e.clientY),
      onmouseleave: () => tooltip.hide(),
      onclick: () => opts.onSelect && r.key !== '__other' && opts.onSelect(r),
    },
      h('span.trunc', { style: { fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'right' }, title: r.label }, r.label),
      h('span', { style: { height: '16px', background: 'var(--surface-3)', borderRadius: '4px', overflow: 'hidden', display: 'block' } },
        h('i', { style: { display: 'block', height: '100%', width: `${w}%`, background: color, borderRadius: '4px' } })),
      h('span', { style: { fontSize: '11.5px', fontVariantNumeric: 'tabular-nums', minWidth: '78px', textAlign: 'right' } }, format(r.value))
    );
    el.append(row);
  });
  return el;
}

/* --------------------------------- usage meter -------------------------------- */
export function usageMeter(used, total, opts = {}) {
  // `used` and `total` are whatever unit the caller works in, so the caller says how to
  // print them. Defaulting to bytes kept the old signature working, but it silently
  // rendered GB figures as bytes — 155.5 GB came out as "156 B".
  const format = opts.format || bytes;
  const p = total > 0 ? (used / total) * 100 : 0;
  const color = p >= (opts.crit ?? 90) ? STATUS.critical : p >= (opts.warn ?? 80) ? STATUS.warning : STATUS.good;
  const el = h('div', { style: { display: 'grid', gap: '4px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11.5px' } },
      h('span.sec', opts.label || 'Disk'),
      h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${format(used)} / ${format(total)} · ${pct(p)}`)),
    h('div.bar-mini', { style: { height: opts.thick ? '10px' : '6px' } },
      h('i', { style: { width: `${Math.min(100, Math.max(1.5, p))}%`, background: color } }))
  );
  return el;
}

/* ------------------------------- time histogram ------------------------------- */
/** buckets: [{ t: epochMs, v: count }] */
export function timeHistogram(buckets, opts = {}) {
  const W = 1000, H = opts.height || 150;
  const padL = 46, padR = 8, padT = 8, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const el = h('div.chart');
  if (!buckets.length) return mount(el, h('div.tbl-empty', 'No documents in this range'));

  const max = Math.max(1, ...buckets.map((b) => b.v));
  const n = buckets.length;
  const slot = iw / n;
  const bw = Math.max(1, slot - 2); // 2px surface gap between adjacent bars

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', height: 'auto' } });

  // y grid, 3 lines, recessive
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  [...new Set(ticks)].forEach((tv) => {
    const y = padT + ih - (tv / max) * ih;
    s.append(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'grid-line' }),
             svg('text', { x: padL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'axis' }, ''));
  });
  const axis = svg('g', { class: 'axis' });
  [...new Set(ticks)].forEach((tv) => {
    const y = padT + ih - (tv / max) * ih;
    axis.append(svg('text', { x: padL - 8, y: y + 3.5, 'text-anchor': 'end' }, opts.formatY ? opts.formatY(tv) : num(tv)));
  });
  s.append(axis);

  const fmtX = opts.formatX || ((t) => new Date(t).toISOString().slice(5, 16).replace('T', ' '));
  const step = Math.max(1, Math.ceil(n / 7));
  const xa = svg('g', { class: 'axis' });
  buckets.forEach((b, i) => {
    if (i % step) return;
    xa.append(svg('text', { x: padL + i * slot + bw / 2, y: H - 6, 'text-anchor': 'middle' }, fmtX(b.t)));
  });
  s.append(xa);

  buckets.forEach((b, i) => {
    const bh = Math.max(b.v > 0 ? 2 : 0, (b.v / max) * ih);
    const x = padL + i * slot + (slot - bw) / 2;
    const rect = svg('rect', {
      x, y: padT + ih - bh, width: bw, height: bh, rx: Math.min(4, bw / 2),
      style: { fill: opts.color || 'var(--series-1)' },
    });
    const hit = svg('rect', {
      x: padL + i * slot, y: padT, width: slot, height: ih, style: { fill: 'transparent', cursor: 'crosshair' },
      onmousemove: (e) => tooltip.show(h('div', h('b', fmtX(b.t)), tipRow(opts.yLabel || 'Docs', num(b.v))), e.clientX, e.clientY),
      onmouseleave: () => tooltip.hide(),
      onclick: () => opts.onSelect && opts.onSelect(b),
    });
    s.append(rect, hit);
  });
  el.append(s);
  return el;
}

/* ------------------------------ coverage strip -------------------------------- */
/** days: [{ date:'YYYY-MM-DD', ok:boolean, count:number, detail?:string }] */
export function coverageStrip(days, opts = {}) {
  const el = h('div.chart');
  if (!days.length) return mount(el, h('div.tbl-empty', 'No snapshot history'));
  const cell = opts.cell || 15, gap = 4, perRow = opts.perRow || 40;
  const rows = Math.ceil(days.length / perRow);
  const W = perRow * (cell + gap), H = rows * (cell + gap);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, style: { height: `${H}px`, maxWidth: `${W}px` } });
  days.forEach((d, i) => {
    const cx = (i % perRow) * (cell + gap);
    const cy = Math.floor(i / perRow) * (cell + gap);
    const fill = d.ok ? (d.partial ? STATUS.warning : STATUS.good) : 'var(--surface-3)';
    s.append(svg('rect', {
      x: cx, y: cy, width: cell, height: cell, rx: 3,
      style: { fill, stroke: d.ok ? 'none' : 'var(--border-strong)', strokeWidth: 1 },
      onmousemove: (e) => tooltip.show(h('div', h('b', d.date),
        tipRow('Snapshots', num(d.count || 0)), d.detail ? tipRow('', d.detail) : null), e.clientX, e.clientY),
      onmouseleave: () => tooltip.hide(),
    }));
  });
  const first = days[0], last = days[days.length - 1];
  el.append(s, h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10.5px',
    color: 'var(--text-muted)', maxWidth: `${W}px`, marginTop: '4px' } },
    h('span', first.date), h('span', last.date)),
    h('div.legend',
    h('span', h('i', { style: { background: STATUS.good } }), 'Covered'),
    h('span', h('i', { style: { background: STATUS.warning } }), 'Partial / failed'),
    h('span', h('i', { style: { background: 'var(--surface-3)', border: '1px solid var(--border-strong)' } }), 'No snapshot')));
  return el;
}

/* ----------------------------------- gauge ------------------------------------ */

/**
 * A single number against the range it lives in, as a 240° arc.
 *
 * For a figure that has a ceiling and a meaning near it: how much of the fleet is
 * alerting, how full the disk is. A bare number tells you the value; an arc tells you
 * where the value sits, which is what somebody glancing actually wants.
 *
 * Not used for a number without a natural maximum — a gauge whose ceiling is invented
 * shows a position that means nothing.
 *
 * @param value   the reading
 * @param max     the top of the arc
 * @param opts    { label, sub, color, format, size }
 */
export function gauge(value, max, opts = {}) {
  const size = opts.size || 132;
  const r = size / 2 - 12;
  const cx = size / 2, cy = size / 2 + 6;
  const START = 150, SWEEP = 240;                       // degrees, opening downward
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const fmt = opts.format || ((v) => String(v));

  const pt = (deg) => {
    const a = (Math.PI / 180) * deg;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const arc = (fromDeg, toDeg) => {
    const [x0, y0] = pt(fromDeg), [x1, y1] = pt(toDeg);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${toDeg - fromDeg > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };

  const s = svg('svg', { viewBox: `0 0 ${size} ${size}`, style: { width: `${size}px`, height: `${size}px` } });
  s.append(svg('path', { d: arc(START, START + SWEEP),
    style: { fill: 'none', stroke: 'var(--surface-3)', strokeWidth: 10, strokeLinecap: 'round' } }));
  if (frac > 0) {
    s.append(svg('path', { d: arc(START, START + SWEEP * frac),
      style: { fill: 'none', stroke: opts.color || STATUS.good, strokeWidth: 10, strokeLinecap: 'round' } }));
  }
  return h('div', { style: { display: 'grid', justifyItems: 'center', gap: '0' } },
    h('div', { style: { position: 'relative', lineHeight: 0 } }, s,
      h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeContent: 'center',
                          textAlign: 'center', lineHeight: 1.15 } },
        h('div', { style: { fontSize: '21px', fontWeight: 680 } }, fmt(value)),
        opts.sub ? h('div.muted', { style: { fontSize: '10.5px' } }, opts.sub) : null)),
    opts.label ? h('div.muted', { style: { fontSize: '11px', marginTop: '-4px' } }, opts.label) : null);
}

/**
 * One arc, split between the parts that make up a whole.
 *
 * `gauge` above answers "how far along one number is". This answers a different
 * question: a total made of parts, where the parts are the point. Shards are the case it
 * was written for — assigned and unassigned are not two readings, they are one
 * population split two ways, and drawing them as two gauges invites the reader to
 * compare two percentages that share a denominator they cannot see.
 *
 * Every segment is labelled with its own count underneath, because an arc gives you the
 * proportion and nothing else: "most of them are fine" is not an answer to "how many are
 * not". A segment with a zero value is still listed — "0 unassigned" is the reassurance
 * somebody came to the page for, and a legend that drops it makes its absence
 * indistinguishable from the chart not knowing.
 *
 * @param segments [{ key, label, value, color }]
 * @param opts { size, total, centreLabel, format }
 */
export function splitGauge(segments, opts = {}) {
  const size = opts.size || 150;
  const r = size / 2 - 13;
  const cx = size / 2, cy = size / 2 + 7;
  const START = 150, SWEEP = 240;
  const parts = (segments || []).map((x) => ({ ...x, value: Math.max(0, Number(x.value) || 0) }));
  const sum = parts.reduce((n, x) => n + x.value, 0);
  const total = opts.total == null ? sum : Math.max(0, Number(opts.total) || 0);
  const fmt = opts.format || ((v) => String(v));

  const pt = (deg) => {
    const a = (Math.PI / 180) * deg;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const arc = (fromDeg, toDeg) => {
    const [x0, y0] = pt(fromDeg), [x1, y1] = pt(toDeg);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${toDeg - fromDeg > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };

  const s = svg('svg', { viewBox: `0 0 ${size} ${size}`, style: { width: `${size}px`, height: `${size}px` } });
  // The track is the total. When the parts do not add up to it — a count the cluster did
  // not break down — the gap stays grey rather than being shared out among the parts.
  s.append(svg('path', { d: arc(START, START + SWEEP),
    style: { fill: 'none', stroke: 'var(--surface-3)', strokeWidth: 11, strokeLinecap: 'round' } }));

  let at = START;
  for (const part of parts) {
    if (!total || part.value <= 0) continue;
    const span = SWEEP * (part.value / total);
    const seg = svg('path', { d: arc(at, Math.min(START + SWEEP, at + span)),
      style: { fill: 'none', stroke: part.color, strokeWidth: 11 } });
    seg.append(svg('title', {}, `${part.label}: ${fmt(part.value)}`));
    s.append(seg);
    at += span;
  }

  // In a narrow column a wrapping legend breaks two-then-one, which reads as a
  // grouping that is not there. `legendColumn` stacks it instead, one per line.
  const legendStyle = opts.legendColumn
    ? { display: 'grid', gap: '3px', justifyItems: 'start' }
    : { display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' };
  return h('div', { style: { display: 'grid', justifyItems: 'center', gap: '2px' } },
    h('div', { style: { position: 'relative', lineHeight: 0 } }, s,
      h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeContent: 'center',
                          textAlign: 'center', lineHeight: 1.15 } },
        h('div', { style: { fontSize: '22px', fontWeight: 680 } }, fmt(total)),
        h('div.muted', { style: { fontSize: '10.5px' } }, opts.centreLabel || 'total'))),
    h('div', { style: legendStyle },
      ...parts.map((part) => h('div', {
        style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '11.5px' },
        title: `${part.label}: ${fmt(part.value)}`,
      },
        h('span', { style: { width: '9px', height: '9px', borderRadius: '2px',
                             background: part.color, flex: 'none' } }),
        h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, fmt(part.value)),
        h('span.muted', part.label)))));
}

/* --------------------------------- honeycomb ---------------------------------- */

/**
 * One cell per thing, coloured by state — a whole population at a glance.
 *
 * For the case a table is worst at: several hundred items where the question is not
 * "what are the values" but "how many are wrong, and are the wrong ones clustered". A
 * cluster with four hundred shards is four hundred rows nobody scrolls; as a grid, one
 * red cell among green is found before you have finished reading the heading.
 *
 * Hexagons rather than squares, offset every other row. A square grid reads as rows and
 * columns and invites you to look for meaning in them — a position in a honeycomb reads
 * as nothing but a slot, which is the truth here: the order is arbitrary.
 *
 * Cells shrink to fit rather than wrapping past the fold, down to a floor where a cell is
 * still a target you can hover. Past that the grid is capped and says how many it did not
 * draw, because a honeycomb of ten thousand is a texture, not a chart.
 *
 * @param items [{ key, label, state, color, detail }]
 * @param opts  { max, cell, width, onSelect, legendFor }
 */
export function honeycomb(items, opts = {}) {
  const el = h('div.chart');
  if (!items.length) return mount(el, h('div.tbl-empty', 'Nothing to show'));

  const cap = opts.max || 1200;
  const shown = items.slice(0, cap);
  // The viewBox is a coordinate space, not a pixel size: the svg below scales it to
  // whatever width the card gives it. A wide space means more cells per row, so the grid
  // ends up short and wide rather than a tall block occupying half the page.
  const width = opts.width || 1600;

  // Hex geometry: pointy-top, so a row advances by 3/4 of the height and every other row
  // is offset by half a width.
  const size = Math.max(opts.min || 7, Math.min(opts.cell || 16, hexFor(shown.length, width)));
  const w = size * 2, hgt = Math.sqrt(3) * size;
  const perRow = Math.max(1, Math.floor((width - w / 2) / (w * 0.75)));
  const rows = Math.ceil(shown.length / perRow);
  const W = perRow * w * 0.75 + w / 2;
  const H = rows * hgt + hgt / 2;

  // width:100% with no max and no fixed height — the viewBox aspect ratio decides the
  // height, so it fills the card on a wide window and scales down on a narrow one. The
  // old fixed pixel height capped it at the viewBox width and left the rest of the row
  // empty, which is what made a 229-cell grid occupy half a page.
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMinYMin meet',
    style: { width: '100%', display: 'block' } });

  shown.forEach((it, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    const cx = w / 2 + col * w * 0.75;
    const cy = hgt / 2 + row * hgt + (col % 2 ? hgt / 2 : 0);
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 180) * (60 * k);
      pts.push(`${(cx + size * Math.cos(a)).toFixed(2)},${(cy + size * Math.sin(a)).toFixed(2)}`);
    }
    s.append(svg('polygon', {
      points: pts.join(' '),
      style: { fill: it.color || 'var(--surface-3)', stroke: 'var(--surface-1)', strokeWidth: 1,
               cursor: opts.onSelect ? 'pointer' : 'default' },
      onmousemove: (e) => tooltip.show(
        h('div', h('b', it.label), it.state ? tipRow('State', it.state) : null,
          it.detail ? tipRow('', it.detail) : null), e.clientX, e.clientY),
      onmouseleave: () => tooltip.hide(),
      onclick: opts.onSelect ? () => opts.onSelect(it) : null,
    }));
  });

  el.append(s);
  if (items.length > shown.length) {
    el.append(h('div.muted', { style: { fontSize: '10.5px', marginTop: '4px' } },
      `showing ${num(shown.length)} of ${num(items.length)} — filter to see the rest`));
  }
  if (opts.legendFor) el.append(countLegend(opts.legendFor, items.length));
  return el;
}

/** The largest cell that still fits `n` of them in one width without going off the page. */
function hexFor(n, width) {
  // Solved by trying: cheap, and the alternative is a quadratic nobody will check.
  for (let size = 16; size > 4; size--) {
    const w = size * 2;
    const perRow = Math.max(1, Math.floor((width - w / 2) / (w * 0.75)));
    const rows = Math.ceil(n / perRow);
    if (rows * Math.sqrt(3) * size <= 300) return size;
  }
  return 5;
}

/**
 * A legend that says how many, not just what the colours mean.
 *
 * "Red means unassigned" is only half the answer when the question is "how many are
 * unassigned". The total goes on the end so the parts can be checked against the whole
 * without counting cells.
 */
function countLegend(entries, total) {
  return h('div.legend', { style: { alignItems: 'center', gap: '14px' } },
    ...entries.map((e) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
      h('i', { style: { background: e.color } }),
      h('span', e.label),
      e.count !== undefined
        ? h('b', { style: { color: e.count ? e.color : 'inherit' } }, num(e.count))
        : null)),
    total !== undefined
      ? h('span', { style: { marginLeft: 'auto', color: 'var(--text-muted)' } },
          h('span', 'total '), h('b', num(total)))
      : null);
}

export function legend(entries) {
  return h('div.legend', ...entries.map((e) => h('span', h('i', { style: { background: e.color } }), e.label)));
}

/* ------------------------------ capacity chart -------------------------------- */

/**
 * "Does it fit?" — requirements drawn against the capacity that has to hold them.
 *
 * A column of numbers makes you do the comparison yourself; bars on a shared scale with
 * the capacity marked make it one glance. A bar that overruns the marker is drawn in the
 * critical colour and says by how much, because that is the whole question.
 *
 * @param capacity  { value, label } — the line everything is measured against
 * @param needs     [{ label, value, sub }] — what has to fit inside it
 * @param opts      { format, labelWidth, capacityUnknown }
 */
export function capacityChart(capacity, needs, opts = {}) {
  const format = opts.format || bytes;
  const cap = Number(capacity && capacity.value) || 0;
  const rows = (needs || []).filter((n) => Number.isFinite(n.value) && n.value !== null);
  if (!rows.length) return h('div.tbl-empty', 'Nothing to compare yet');

  // The scale has to cover the capacity as well as the largest requirement, or a
  // requirement that overruns would be drawn as though it fitted.
  const max = Math.max(1, cap, ...rows.map((r) => r.value));
  const pos = (v) => Math.min(100, (v / max) * 100);

  const el = h('div.chart.cap-chart', { style: { display: 'grid', gap: '7px' } });

  rows.forEach((r) => {
    const fits = opts.capacityUnknown ? null : r.value <= cap;
    const color = fits === null ? 'var(--series-1)' : fits ? 'var(--good)' : 'var(--critical)';
    const over = fits === false ? r.value - cap : 0;

    el.append(h('div.cap-row', {
      style: { display: 'grid', gridTemplateColumns: `${opts.labelWidth || 170}px 1fr auto`,
               alignItems: 'center', gap: '10px' },
      title: r.sub || '',
    },
      h('span.trunc.cap-label', { style: { fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'right' }, title: r.label }, r.label),
      // The track carries the capacity marker, so every bar is read against the same line.
      h('span', { style: { position: 'relative', height: '16px', background: 'var(--surface-3)',
                           borderRadius: '4px', display: 'block' } },
        h('i', { style: { display: 'block', height: '100%', width: `${Math.max(1.5, pos(r.value))}%`,
                          background: color, borderRadius: '4px' } }),
        opts.capacityUnknown ? null : h('i', {
          title: `${capacity.label || 'capacity'}: ${format(cap)}`,
          style: { position: 'absolute', top: '-3px', bottom: '-3px', left: `${pos(cap)}%`,
                   width: '2px', background: 'var(--text-primary)', opacity: '.7', borderRadius: '1px' },
        })),
      h('span', { style: { fontSize: '11.5px', fontVariantNumeric: 'tabular-nums', minWidth: '150px', textAlign: 'right', display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
        h('span', format(r.value)),
        h('span.cap-verdict', over > 0
          ? h('span', { style: { color: 'var(--critical)', fontWeight: 640 } }, `short ${format(over)}`)
          : fits === true ? h('span', { style: { color: 'var(--good)' } }, 'fits') : null))));
  });

  if (!opts.capacityUnknown) {
    el.append(h('div.legend',
      h('span', h('i', { style: { background: 'var(--text-primary)', opacity: '.7', width: '2px' } }),
        `${capacity.label || 'capacity'} — ${format(cap)}`),
      h('span', h('i', { style: { background: 'var(--good)' } }), 'fits'),
      h('span', h('i', { style: { background: 'var(--critical)' } }), 'does not fit')));
  }
  return el;
}
