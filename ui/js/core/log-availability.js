/**
 * The log availability map (owner, 2026-11-26): one cell per calendar day, from the oldest
 * day any live index or snapshot names to today, coloured by where that day's logs are.
 *
 *   live      a live index carries the day in its name            green
 *   ok        no live index; a successful snapshot holds the day  blue
 *   partial   no live index, no successful snapshot; a partial
 *             snapshot names the day                              red
 *   none      no live index and no snapshot names the day         grey
 *   unknown   no live index, and not every snapshot could be read hatched — never grey
 *   future    after today, nothing dated there                    blank
 *
 * One colour per day, live first: a day that is live and also backed up is green (owner).
 * describe() names both, so the hover never hides the backup.
 *
 * The figures beside the map are the ones the rest of the app shows, not a second copy:
 * Live retention is volume.js liveHeldDays (the Capacity column), the backed-up range is
 * volume.js restorableRange (the Capacity sheet and the Snapshots page). What is new here is
 * the trailing gap: how many days since the newest live index (trailingGap), flagged when it
 * is longer than STALE_GAP_DAYS — the same number that ends a run at the old end.
 *
 * Days are UTC calendar days, as currentRun counts them. Pure: data in, answers out.
 */

import { restorableIndices, snapStatus, repoListing, reposRead, cutText } from './snapshot-restorable.js';
import { liveHeldDays, restorableRange, spanDaysIso, STALE_GAP_DAYS } from './volume.js';
import { plural } from '../lib/fmt.js';

const utcToday = () => new Date().toISOString().slice(0, 10);
const DAY = 86400000;
export const addDay = (iso, n = 1) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * A real calendar day 'YYYY-MM-DD'. An index name can carry anything that looks like a date
 * (2026.13.45, 9999.12.31): only a day that exists is on the map, so a bad name can neither
 * break the walk over the days nor stretch it over millennia.
 */
export function realDay(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** How far the map reaches from today; days beyond are counted apart (`outside`), not drawn. */
export const MAP_YEARS_BACK = 10;
export const MAP_DAYS_AHEAD = 366;

/** States nothing can be restored from (snapshot-restorable.js NOTHING): not on the map. */
const NOTHING = new Set(['IN_PROGRESS', 'FAILED', 'INCOMPATIBLE', 'ABORTED']);

/**
 * Days since the newest live index, up to today: `{newest, days, stale}` — `days` 0 when
 * today has an index, 1 when the newest is yesterday; `stale` when more than STALE_GAP_DAYS.
 * `{newest: null}` when no live index name carries a date up to today; null when the index
 * list is not read. Days dated after today are not the newest: a device with a wrong clock
 * must not hide that the logs stopped.
 */
export function trailingGap(indices, today = utcToday()) {
  if (!Array.isArray(indices)) return null;
  let newest = null;
  for (const r of indices) if (r && realDay(r.day) && r.day <= today && (newest === null || r.day > newest)) newest = r.day;
  if (!newest) return { newest: null, days: null, stale: false };
  const days = spanDaysIso(newest, today) - 1;
  return { newest, days, stale: days > STALE_GAP_DAYS };
}

/** "No live index for 24 days (newest 2026-11-02)", or '' when the newest is today or yesterday. */
export function trailingGapText(g) {
  if (!g || !g.newest || g.days < 1) return '';
  if (g.days === 1) return `No live index for today yet (newest ${g.newest})`;
  return `No live index for ${plural(g.days, 'day')} (newest ${g.newest})`;
}

/**
 * The map for one cluster.
 *
 * @param o {
 *   indices   state.indices rows (`{day}` from parseIndexName); null = the index list is not read
 *   data      state.data for the cluster (repos, snapshots, snapshotTotals, switchedOff)
 *   dayOf     index name → 'YYYY-MM-DD' or null (parseIndexName with the cluster's regex)
 *   ulm       backups go to S3 through ULM (core/cluster-kind.js)
 *   today     'YYYY-MM-DD', UTC
 * }
 * Returns null while the index list is not read: the map draws nothing it cannot back.
 */
export function logAvailability({ indices, data, dayOf, ulm = false, today = utcToday() }) {
  if (!Array.isArray(indices)) return null;
  const lo = addDay(today, -Math.round(MAP_YEARS_BACK * 365.25)), hi = addDay(today, MAP_DAYS_AHEAD);
  const outside = { before: new Set(), after: new Set() };
  // A day the map can draw; one outside the window is remembered apart and named.
  const onMap = (day) => {
    if (!realDay(day)) return false;
    if (day < lo) { outside.before.add(day); return false; }
    if (day > hi) { outside.after.add(day); return false; }
    return true;
  };
  const live = new Map();
  let undated = 0, badDates = 0;
  for (const r of indices) {
    if (!r || !r.day) { undated++; continue; }
    if (!realDay(r.day)) { badDates++; continue; }
    if (onMap(r.day)) live.set(r.day, (live.get(r.day) || 0) + 1);
  }

  // Backups: per day, how many successful snapshots hold it; how many partial ones name it,
  // and in how many of those an index of that day failed (or which failed was not read).
  const ok = new Map(), part = new Map();
  const unknown = [];
  const rows = [];
  let unreadNames = 0, snapshots = 0;
  const d = data || {};
  const repos = Array.isArray(d.repos) ? d.repos : [];
  if (d.switchedOff && d.switchedOff.snapshots) unknown.push('Snapshots are switched off for this cluster (Edit cluster › Collection).');
  else if (!reposRead(d)) unknown.push('The repository list has not been read yet.');
  else if (!repos.length && ulm) unknown.push('Backups go to S3 through ULM, which this map cannot see.');
  else {
    for (const rp of repos) {
      const l = repoListing(d, rp);
      if (!l.rows) { unknown.push(`Repository ${rp.name}: snapshots ${l.why}.`); continue; }
      if (l.cut) unknown.push(`Repository ${rp.name}: only the ${cutText(l)} snapshots were read.`);
      for (const s of l.rows) {
        rows.push(s);
        const st = snapStatus(s);
        if (NOTHING.has(st)) continue;
        if (!Array.isArray(s.indexNames)) { unreadNames++; continue; }
        snapshots++;
        const whole = st === 'SUCCESS' && !(Number(s.failed) > 0);
        if (whole) {
          for (const day of new Set(s.indexNames.map(dayOf).filter(onMap))) ok.set(day, (ok.get(day) || 0) + 1);
          continue;
        }
        if (st !== 'SUCCESS' && st !== 'PARTIAL') continue;
        const good = restorableIndices(s);
        const goodSet = good ? new Set(good) : null;
        const seen = new Map();
        for (const n of s.indexNames) {
          const day = dayOf(n);
          if (!onMap(day)) continue;
          const v = seen.get(day) || 'restorable';
          seen.set(day, !goodSet ? 'unsure' : goodSet.has(n) ? v : 'failed');
        }
        for (const [day, how] of seen) {
          const e = part.get(day) || { snaps: 0, failed: 0, unsure: 0 };
          e.snaps++;
          if (how === 'failed') e.failed++;
          if (how === 'unsure') e.unsure++;
          part.set(day, e);
        }
      }
    }
    if (unreadNames) unknown.push(`${plural(unreadNames, 'snapshot')}: index names not read (the light listing names none). Refresh the Snapshots page to read them.`);
  }

  const stateOf = (day) => {
    if (live.has(day)) return 'live';
    if (ok.has(day)) return 'ok';
    if (part.has(day)) return 'partial';
    if (day > today) return 'future';
    return unknown.length ? 'unknown' : 'none';
  };

  const all = [...live.keys(), ...ok.keys(), ...part.keys()].sort();
  const from = all.length ? all[0] : null;
  const to = all.length ? (all[all.length - 1] > today ? all[all.length - 1] : today) : null;

  // Day counts by colour, up to today (later days are counted apart as `ahead`).
  const counts = { live: 0, ok: 0, partial: 0, none: 0, unknown: 0 };
  let ahead = 0;
  if (from) {
    for (let day = from; day <= to; day = addDay(day)) {
      const s = stateOf(day);
      if (day > today) { if (s !== 'future') ahead++; continue; }
      counts[s]++;
    }
  }

  const describe = (day) => {
    const lines = [day];
    const n = live.get(day);
    lines.push(n ? `Live: ${plural(n, 'index', 'indices')}` : 'Live: no index');
    const o = ok.get(day), p = part.get(day);
    if (o) lines.push(`Backup: in ${plural(o, 'successful snapshot')}`);
    if (p) {
      const how = p.failed ? `an index of this day failed in ${p.failed}`
        : p.unsure ? 'which indices failed was not read' : 'this day’s indices are restorable';
      lines.push(`Backup: in ${plural(p.snaps, 'partial snapshot')} (${how})`);
    }
    if (!o && !p) lines.push(unknown.length ? 'Backup: not in any snapshot read — not every snapshot could be read' : 'Backup: in no snapshot');
    if (day > today) lines.push('Dated after today');
    return lines.join('\n');
  };

  return {
    today, from, to, stateOf, describe,
    months: from ? monthRows(from, to, today, stateOf) : [],
    counts, ahead, undated, badDates, unknown, snapshots,
    outside: { before: outside.before.size, after: outside.after.size, window: { from: lo, to: hi },
      first: outside.before.size ? [...outside.before].sort()[0] : null, last: outside.after.size ? [...outside.after].sort().pop() : null },
    held: liveHeldDays(indices, d, today),
    gap: trailingGap(indices, today),
    backup: restorableRange(rows),
  };
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Month rows, oldest first: `{kind: 'month', ym, cells: [{day, state}]}` with one cell per
 * calendar day (state 'out' before `from`), or `{kind: 'gap', from, to, state, days}` for two
 * or more months running in which every day is 'none' (or every day 'unknown', or 'future') — a stray
 * index two years back does not take two years of grey rows.
 */
export function monthRows(from, to, today, stateOf) {
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const endYm = to.slice(0, 7);
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const cells = [];
    for (let dd = 1; dd <= daysInMonth(y, m); dd++) {
      const day = `${ym}-${String(dd).padStart(2, '0')}`;
      cells.push({ day, state: day < from ? 'out' : day > to ? 'out' : stateOf(day) });
    }
    out.push({ kind: 'month', ym, cells });
    if (ym >= endYm) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  const uniform = (r) => {
    const s = new Set(r.cells.filter((c) => c.state !== 'out').map((c) => c.state));
    return s.size === 1 && (s.has('none') || s.has('unknown') || s.has('future')) ? [...s][0] : null;
  };
  const rows = [];
  for (let i = 0; i < out.length;) {
    const s = uniform(out[i]);
    let j = i;
    while (s && j + 1 < out.length && uniform(out[j + 1]) === s) j++;
    if (s && j > i) {
      const days = out.slice(i, j + 1).reduce((n, r) => n + r.cells.filter((c) => c.state !== 'out').length, 0);
      rows.push({ kind: 'gap', from: out[i].ym, to: out[j].ym, state: s, days });
      i = j + 1;
    } else { rows.push(out[i]); i++; }
  }
  return rows;
}
