/**
 * The log availability button and its dialog (core/log-availability.js): which days of logs a
 * cluster holds live, which only in snapshots, and where there is nothing. On the Clusters
 * page's expanded row, the Overview and Reports › Capacity & retention.
 *
 * The button is icon-only (UI rules 2026-11-14) and amber when the newest live index is older
 * than STALE_GAP_DAYS — the trailing gap the retention count cannot show. It reads only what
 * the app holds; opening the dialog asks for the index list and the snapshot listing with
 * index names when they are missing (reads, never writes).
 */

import { h, mount } from '../lib/dom.js';
import { state, bus, fetchIndices, fetchSnapshots, parseIndexName } from '../core/state.js';
import { clusterKind } from '../core/cluster-kind.js';
import { logAvailability, trailingGap, trailingGapText, MAP_YEARS_BACK } from '../core/log-availability.js';
import { leftOutShort, spanDaysIso } from '../core/volume.js';
import { plural } from '../lib/fmt.js';
import { modal } from './modal.js';

const ICON = '▦';
const BASE_TITLE = 'Log availability: which days have live indices or backups';

/** The small button. `opts.cls` adds classes for where it sits. */
export function logMapButton(c, opts = {}) {
  const g = trailingGap(state.indices.get(c.id));
  const flag = g && g.stale ? trailingGapText(g) : '';
  return h(`button.btn.sm.icon.lm-btn${flag ? '.lm-stale' : ''}${opts.cls ? `.${opts.cls}` : ''}`, {
    type: 'button', 'aria-label': `Log availability map for ${c.name}`,
    title: flag ? `${BASE_TITLE}\n${flag}` : BASE_TITLE,
    dataset: { logmap: c.id },
    onclick: (e) => { e.stopPropagation(); openLogMap(c); },
  }, ICON);
}

function ulmOf(c) {
  try { const k = clusterKind(c); return !!(k.ulm && k.ulm.enabled && !k.slmExpected); } catch (_) { return false; }
}

/** Ask for what the map needs and is missing: the index list, the listing with index names. */
async function ensure(c, note) {
  const d = state.data.get(c.id) || {};
  const jobs = [];
  if (!state.indices.get(c.id)) {
    jobs.push(fetchIndices(c.id, '*').catch((e) => note(`Index list: ${e && e.message ? e.message : 'could not be read'}`)));
  }
  const repos = Array.isArray(d.repos) ? d.repos : [];
  const lacking = repos.some((rp) => {
    const rows = d.snapshots && d.snapshots[rp.name];
    return !Array.isArray(rows) || rows.some((s) => !Array.isArray(s.indexNames));
  });
  if (lacking && !(d.switchedOff && d.switchedOff.snapshots)) {
    jobs.push(fetchSnapshots(c.id, { force: false }).catch((e) => note(`Snapshots: ${e && e.message ? e.message : 'could not be read'}`)));
  }
  await Promise.all(jobs);
}

export function openLogMap(c) {
  const body = h('div.lm');
  const problems = [];
  let av = null;
  const pickLine = h('div.lm-pick', { 'aria-live': 'polite' }, h('span.muted', 'Hover or tap a day for what is there.'));
  // Hover shows one day's detail without computing the map again (a fleet's listing is big).
  const pick = (day, btn) => {
    if (!av) return;
    body.querySelectorAll('.lm-picked').forEach((el) => el.classList.remove('lm-picked'));
    if (btn) btn.classList.add('lm-picked');
    mount(pickLine, h('pre.lm-pick-t', av.describe(day)));
  };
  const draw = () => {
    const reSrc = c.indexNameRegex;
    av = logAvailability({
      indices: state.indices.get(c.id) || null,
      data: state.data.get(c.id) || {},
      dayOf: (n) => parseIndexName(n, reSrc).day,
      ulm: ulmOf(c),
    });
    mount(body, ...view(av, problems, pickLine, pick));
  };
  const offs = [bus.on('indices', (id) => { if (id === c.id) draw(); }), bus.on('data', (id) => { if (id === c.id) draw(); })];
  draw();
  ensure(c, (t) => { problems.push(t); draw(); }).then(draw);
  modal(`Log availability · ${c.name}`, 'One cell per day (UTC). A day with a live index is green, also when a snapshot holds it.',
    [body], (ctx) => [h('button.btn', { type: 'button', onclick: () => ctx.done(null) }, 'Close')],
    { width: '780px', cls: 'lm-modal' })
    .then(() => offs.forEach((off) => { try { off(); } catch (_) { /* gone */ } }));
}

const LEGEND = [
  ['live', 'Live index'],
  ['ok', 'Only in successful snapshots'],
  ['partial', 'Only in partial snapshots'],
  ['none', 'No index (live or backup)'],
  ['unknown', 'Not known: backups not fully read'],
];

function view(av, problems, pickLine, pick) {
  const errs = problems.length ? h('div.banner.warn.lm-msg', problems.join(' · ')) : null;
  if (!av) return [errs, h('p.muted', 'Reading the index list…')];
  if (!av.from) {
    return [errs, h('p.muted', 'No live index and no snapshot carries a date in its name, so there is no day to show.'),
      av.undated ? h('p.muted', `${plural(av.undated, 'index', 'indices')} with no date in the name.`) : null];
  }
  const used = new Set(Object.entries(av.counts).filter(([, n]) => n > 0).map(([k]) => k));
  const legend = h('div.lm-legend', ...LEGEND.filter(([k]) => k !== 'unknown' || used.has('unknown'))
    .map(([k, label]) => h('span.lm-key', h(`i.lm-sw.lm-${k}`, { 'aria-hidden': 'true' }), label,
      h('span.muted', ` ${plural(av.counts[k], 'day')}`))));
  return [errs, summary(av), legend, grid(av, pick), pickLine, notes(av)];
}

function summary(av) {
  const held = av.held;
  const liveLine = !held ? h('span.muted', 'no live index name carries a date')
    : held.source === 'ILM' ? h('span', `${plural(Math.round(held.days), 'day')} (ILM delete age; no index name carries a date)`)
      : h('span', `${plural(held.days, 'day')} from ${held.from} to today`, held.left ? h('span.muted', ` · ${leftOutShort(held.left)}`) : null);
  const g = av.gap;
  const gapText = trailingGapText(g);
  const gapLine = !g || !g.newest ? null
    : g.stale ? h('b.lm-warn', { title: 'More than 7 days with no live index: the logs may have stopped' }, gapText)
      : h('span.muted', gapText || `newest ${g.newest}`);
  const b = av.backup;
  const backLine = b.from
    ? h('span', `${b.from} → ${b.to}`, b.held !== null ? h('span.muted', ` · ${b.held} of ${plural(b.days, 'day')} held`) : null,
      b.left ? h('span.muted', ` · ${leftOutShort(b.left)}`) : null, b.unread ? h('span.muted', ` · ${plural(b.unread, 'snapshot')} not read`) : null)
    : h('span.muted', av.unknown.length ? 'not known' : av.snapshots ? 'no restorable index carries a date' : 'no snapshot');
  return h('div.lm-sum',
    h('div', h('b', 'Live retention '), liveLine, gapLine ? [' · ', gapLine] : null),
    h('div', h('b', 'Backed up '), backLine, av.counts.partial ? h('span.lm-bad', ` · ${plural(av.counts.partial, 'day')} only in partial snapshots`) : null));
}

const STATE_WORD = { live: 'live index', ok: 'only in successful snapshots', partial: 'only in partial snapshots', none: 'no index', unknown: 'not known', future: 'after today' };
const HEAD = Array.from({ length: 31 }, (_, i) => i + 1);

function grid(av, pick) {
  const rows = [h('div.lm-row.lm-head', h('span.lm-ym'), ...HEAD.map((n) => h('span.lm-dn', n === 1 || n % 5 === 0 ? String(n) : '')))];
  for (const r of av.months) {
    if (r.kind === 'gap') {
      const what = r.state === 'none' ? 'no live index and no backup' : r.state === 'future' ? 'after today' : 'no live index; backups not known';
      rows.push(h('div.lm-row.lm-gaprow', h('span.lm-ym', r.from), h(`span.lm-gap.lm-${r.state}`, `${r.from} → ${r.to} · ${what} · ${plural(r.days, 'day')}`)));
      continue;
    }
    rows.push(h('div.lm-row', h('span.lm-ym', r.ym), ...r.cells.map((cell) => cell.state === 'out' ? h('span.lm-c.lm-out')
      : h(`button.lm-c.lm-${cell.state}${cell.day === av.today ? '.lm-today' : ''}`, {
        type: 'button', 'aria-label': `${cell.day}: ${STATE_WORD[cell.state]}`,
        onclick: (e) => pick(cell.day, e.currentTarget), onmouseenter: (e) => pick(cell.day, e.currentTarget),
        onfocus: (e) => pick(cell.day, e.currentTarget),
      }))));
  }
  return h('div.lm-grid', { role: 'group', 'aria-label': `Days from ${av.from} to ${av.to}` }, ...rows);
}

function notes(av) {
  const out = [];
  for (const u of av.unknown) out.push(u);
  if (av.ahead) out.push(`${plural(av.ahead, 'day')} dated after today ${av.today} (an index name with a future date, often a device clock).`);
  if (av.outside.before) out.push(`${plural(av.outside.before, 'day')} dated before ${av.outside.window.from} (the oldest ${av.outside.first}) are not drawn: the map reaches ${MAP_YEARS_BACK} years back.`);
  if (av.outside.after) out.push(`${plural(av.outside.after, 'day')} dated after ${av.outside.window.to} (the latest ${av.outside.last}) are not drawn.`);
  if (av.badDates) out.push(`${plural(av.badDates, 'live index', 'live indices')} carry a date that does not exist and are not on the map.`);
  if (av.undated) out.push(`${plural(av.undated, 'live index', 'live indices')} with no date in the name are not on the map.`);
  out.push(`From ${av.from} to ${av.to}: ${plural(spanDaysIso(av.from, av.to), 'day')}. Days are read from the dates in index names, not from when snapshots ran.`);
  return h('ul.lm-notes.muted', ...out.map((t) => h('li', t)));
}
