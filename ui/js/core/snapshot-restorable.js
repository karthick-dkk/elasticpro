/**
 * What a snapshot can give back, and what a repository's listing can and cannot say.
 *
 * One definition for every page, file and feed that turns a snapshot into evidence: the
 * snapshot list, the repositories' data span, the index evidence, the availability strip,
 * the volume report and the "free live indices" dialog. A snapshot names every index it was
 * asked to hold from the moment it starts — also the ones it failed on — so the names alone
 * are not a backup.
 *
 * Pure: rows in, answers out. Unknown is null, never an empty list.
 */

export const snapStatus = (s) => String((s && (s.status || s.state)) || '').toUpperCase();

/** States nothing can be restored from: not finished, or finished without data. */
const NOTHING = new Set(['IN_PROGRESS', 'FAILED', 'INCOMPATIBLE', 'ABORTED']);

/**
 * The indices with a shard failure, from a verbose listing's or a detail's `failures`. Null
 * when that cannot be told: no list, a failure that names no index, or fewer listed than
 * `failedShards` says there are.
 */
export function failedIndexNames(failures, failedShards = null) {
  if (!Array.isArray(failures)) return Number(failedShards) === 0 && failedShards !== null ? [] : null;
  if (failures.some((f) => !f || !f.index)) return null;
  if (failedShards !== null && failedShards !== undefined && Number(failedShards) > failures.length) return null;
  return [...new Set(failures.map((f) => f.index))];
}

/**
 * The indices that can be restored whole from a snapshot row
 * (`{status, indexNames, failedIndices, failed}`, core/state.js snapshotRowsVerbose/Cat).
 *
 *   SUCCESS                              every index it holds
 *   PARTIAL                              the indices with no failed shard, when the failures were read
 *   FAILED, IN_PROGRESS, INCOMPATIBLE    none
 *   anything that cannot be told         null — unknown, not none
 */
export function restorableIndices(s) {
  const st = snapStatus(s);
  if (NOTHING.has(st)) return [];
  const names = s && s.indexNames;
  if (!Array.isArray(names)) return null;
  if (st === 'SUCCESS' && !(Number(s.failed) > 0)) return names;
  if (st !== 'SUCCESS' && st !== 'PARTIAL') return null;
  if (!Array.isArray(s.failedIndices) || (Number(s.failed) > 0 && !s.failedIndices.length)) return null;
  const bad = new Set(s.failedIndices);
  return names.filter((n) => !bad.has(n));
}

/** Why a snapshot's covered days are less than its index list says, or '' when they are not. */
export function restorableNote(s) {
  const st = snapStatus(s);
  if (st === 'IN_PROGRESS') return 'in progress: nothing to restore yet';
  if (st === 'FAILED') return 'failed: nothing to restore';
  if (st === 'INCOMPATIBLE') return 'incompatible: cannot be restored here';
  if (st === 'ABORTED') return 'aborted: nothing to restore';
  const ok = restorableIndices(s);
  if (st === 'PARTIAL' || (st === 'SUCCESS' && Number(s.failed) > 0)) {
    if (!Array.isArray(s.indexNames)) return 'partial: index names not read';
    return ok === null ? `partial: which of the ${s.indexNames.length} indices failed was not read`
      : `partial: ${ok.length} of ${s.indexNames.length} indices`;
  }
  if (!Array.isArray(s && s.indexNames)) return 'index names not read';
  return ok === null ? `state ${st || 'not known'}: not known what can be restored` : '';
}

/** "2026-11-15 → 2026-11-22 · 4 of 8 days": the span, and the days held when some inside it are not. */
export function spanText(from, to, days, missing) {
  if (!from) return '';
  const gap = Number(missing) > 0 ? ` · ${days - missing} of ${days} days` : '';
  return `${from} → ${to}${gap}`;
}

/**
 * What a snapshot's "Data inside covers" says: `{kind, text, note}`.
 * kind: 'span' (dated days), 'undated' (nothing dated to restore), 'none' (nothing to restore), 'unknown'.
 */
export function snapshotCover(s) {
  const note = restorableNote(s);
  const ok = restorableIndices(s);
  if (ok === null) return { kind: 'unknown', text: 'unknown', note };
  if (NOTHING.has(snapStatus(s))) return { kind: 'none', text: note.split(':')[0], note };
  if (s.coverFrom) return { kind: 'span', text: spanText(s.coverFrom, s.coverTo, s.coverDays, s.missingDays), note };
  return { kind: 'undated', text: '–', note };
}

/**
 * One repository's listing as it is known: `{rows, why, total, cut}`.
 *
 * `rows` is null when the listing is not known — `why` then says the reason (the repository
 * could not be read, or has not been yet). `total` is how many snapshots the repository holds
 * when Elasticsearch said (or the listing is whole), null when only "at least the rows" is
 * known; `cut` is true when the rows are the newest of more.
 */
export function repoListing(d, repo) {
  const name = repo && repo.name;
  const rows = d && d.snapshots && Array.isArray(d.snapshots[name]) ? d.snapshots[name] : null;
  if (d && d.switchedOff && d.switchedOff.snapshots) return { rows: null, why: 'switched off', total: null, cut: false };
  if (repo && repo.error) return { rows: null, why: `could not be read: ${repo.error}`, total: null, cut: false };
  if (!rows) return { rows: null, why: 'not read yet', total: null, cut: false };
  const c = listingCut(rows.length, ((d && d.snapshotTotals) || {})[name]);
  return { rows, why: '', ...c };
}

/** How many snapshots one verbose listing asks for (core/state.js, fleet/catalogue.rs). */
export const LISTING_SIZE = 500;

/**
 * Whether a listing of `n` rows is the whole repository. `t` is what was said beside it:
 * `{total, remaining}` of the answer, and `whole` for a listing without a size limit (_cat).
 */
export function listingCut(n, t) {
  if (t && t.whole) return { total: n, cut: false };
  const total = t && Number.isFinite(t.total) ? Number(t.total) : t && Number.isFinite(t.remaining) ? n + Number(t.remaining) : null;
  if (total !== null) return { total: Math.max(total, n), cut: total > n };
  // No total said (before 7.16): a full page may be all of them or not.
  return n >= LISTING_SIZE ? { total: null, cut: true } : { total: n, cut: false };
}

/** "newest 500 of 812", or '' when the listing is whole. */
export function cutText({ rows, total, cut } = {}) {
  if (!cut || !rows) return '';
  return total === null ? `newest ${rows.length}, there may be more` : `newest ${rows.length} of ${total}`;
}

/** Whether this cluster's repository list was read. An empty list nobody read is not "none". */
export function reposRead(d) {
  if (!d) return false;
  return d.reposRead !== undefined ? d.reposRead === true : Array.isArray(d.repos);
}

/** True only when the repository list was read, from a cluster that answers, and is empty. */
export function noRepository(d) {
  return reposRead(d) && d.reachable !== false && Array.isArray(d.repos) && !d.repos.length;
}

/** Which of a cluster's repositories have a listing, and which do not (with why). */
export function listingsKnown(d) {
  const repos = (d && d.repos) || [];
  const unread = [];
  for (const r of repos) { const l = repoListing(d, r); if (!l.rows) unread.push({ name: r.name, why: l.why }); }
  return { total: repos.length, read: repos.length - unread.length, unread };
}

/**
 * The days of the availability strip, oldest first: `{date, state, count, ok, other}` with
 * state 'ok' (a SUCCESS snapshot started that day), 'bad' (snapshots, none successful),
 * 'none', 'notread' (before the oldest snapshot of a cut listing) or 'today' (no success yet,
 * which is not a missed day until the day is over). Days are `tz` days.
 */
export function availability(rows, { days = 60, tz = 'UTC', now = Date.now(), cut = false } = {}) {
  let f;
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  try { f = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz }); }
  catch (_) { f = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' }); }
  const dayOf = (ms) => f.format(new Date(Number(ms)));
  const byDay = new Map();
  let oldest = null;
  for (const s of rows || []) {
    if (!s.start) continue;
    const k = dayOf(s.start);
    if (oldest === null || k < oldest) oldest = k;
    const v = byDay.get(k) || { ok: 0, other: 0 };
    if (snapStatus(s) === 'SUCCESS' && !(Number(s.failed) > 0)) v.ok++; else v.other++;
    byDay.set(k, v);
  }
  const today = dayOf(now);
  const base = Date.parse(`${today}T00:00:00Z`);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(base - i * 86400000).toISOString().slice(0, 10);
    const v = byDay.get(date) || { ok: 0, other: 0 };
    // The day the oldest listed snapshot ran may itself be cut: an earlier run that day is not listed.
    const unread = cut && (oldest === null || date < oldest || (date === oldest && !v.ok));
    const state = v.ok ? 'ok' : unread ? 'notread' : date === today ? 'today' : v.other ? 'bad' : 'none';
    out.push({ date, state, count: v.ok + v.other, ok: v.ok, other: v.other });
  }
  return { days: out, tz,
    missing: out.filter((x) => x.state === 'bad' || x.state === 'none').map((x) => x.date),
    notRead: out.filter((x) => x.state === 'notread').length,
    today: out[out.length - 1] || null };
}
