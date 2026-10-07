import { plural } from '../lib/fmt.js';
/**
 * Capacity arithmetic: how much a cluster ingests per day, and what that means for the
 * disk it has and the retention it promises.
 *
 * The daily figure is the mean of the N heaviest of the last W complete days, where W
 * and N come from config (volumeWindowDays / volumeTopDays, default 7 and 3). A plain
 * mean under-provisions whenever the window catches a quiet weekend or a collector
 * outage; taking the busiest few sizes against days that actually happen. Today is never
 * counted — its index is still being written to.
 *
 * Those two knobs cover the usual preferences without a separate mode setting:
 * topDays 1 sizes against the peak day, topDays = windowDays is a plain mean.
 */

const GB = 1024 ** 3;
export const bytesToGB = (b) => (Number(b) || 0) / GB;

/**
 * Today is still being written to, so its index is short and would drag a mean down.
 *
 * UTC, to match the dates in the index names themselves — deriving it from local parts
 * would exclude the wrong day for anyone not on UTC.
 */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * "30d", "90 days", "3M", "6 months", "1y", or a bare number of days.
 * @returns {{days:number, label:string}|null}
 */
export function parseRetention(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) return { days: v, label: plural(v, 'day') };
  const s = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!isFinite(n) || n < 0) return null;
  const unit = m[2].toLowerCase();
  // A capital M means months; lower-case m alone is ambiguous, and months is the only
  // sense that makes sense for a retention policy.
  const isMonth = m[2] === 'M' || unit.startsWith('mo') || unit === 'm' || unit === 'month' || unit === 'months';
  if (!unit || unit.startsWith('d')) return { days: n, label: plural(n, 'day') };
  if (isMonth) return { days: Math.round(n * 30), label: `${n} month${n === 1 ? '' : 's'}` };
  if (unit.startsWith('w')) return { days: Math.round(n * 7), label: `${n} week${n === 1 ? '' : 's'}` };
  if (unit.startsWith('y')) return { days: Math.round(n * 365), label: `${n} year${n === 1 ? '' : 's'}` };
  if (unit.startsWith('h')) return { days: Math.max(0, n / 24), label: plural(n, 'hour') };
  return null;
}

/**
 * A storage size: "2TB", "500 GB", "1.5TiB", or a bare number meaning GB.
 *
 * Sizes here are binary throughout — 1 TB is 1024 GB — because that is what
 * Elasticsearch reports and what every other figure on the report is measured in.
 * @returns {{gb:number, label:string}|null}
 */
export function parseSize(v) {
  if (v === null || v === undefined || v === '') return null;
  const n0 = typeof v === 'number' ? v : null;
  if (n0 !== null) return isFinite(n0) && n0 > 0 ? { gb: n0, label: sizeLabel(n0) } : null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(String(v).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  // TiB and TB mean the same thing here, so the "i" is simply dropped.
  const unit = m[2].toLowerCase().replace('i', '');
  const mult = { '': 1, g: 1, gb: 1, t: 1024, tb: 1024, p: 1024 * 1024, pb: 1024 * 1024,
                 m: 1 / 1024, mb: 1 / 1024 }[unit];
  if (!mult) return null;
  const gbv = n * mult;
  return { gb: gbv, label: sizeLabel(gbv) };
}

function sizeLabel(gbv) {
  if (gbv >= 1024) { const t = gbv / 1024; return `${t % 1 ? t.toFixed(1) : t} TB`; }
  return `${gbv % 1 ? gbv.toFixed(1) : gbv} GB`;
}

/** Defaults mirrored from config DEFAULTS, so calling dailyVolume() bare still works. */
export const VOLUME_DEFAULTS = { windowDays: 7, topDays: 3, headroomPercent: 30 };

/**
 * Resolve the volume settings for a cluster, clamping them to values the arithmetic
 * can actually use.
 *
 * Exported because the report renders the basis it used, and the settings page
 * previews it — three callers that must agree on what "3 of 7" means. A window of 0
 * or a topDays above the window are the two ways a hand-edited YAML makes this
 * meaningless, so both are corrected here rather than at each call site.
 */
export function volumeSettings(cluster = {}) {
  const int = (v, dflt) => {
    const n = Math.floor(Number(v));
    return isFinite(n) ? n : dflt;
  };
  const windowDays = Math.max(1, int(cluster.volumeWindowDays, VOLUME_DEFAULTS.windowDays));
  // topDays above the window would silently mean "the whole window" — which is a
  // legitimate choice, but it should be the one that was asked for, so it is clamped
  // rather than left to behave that way by accident.
  const topDays = Math.min(windowDays, Math.max(1, int(cluster.volumeTopDays, VOLUME_DEFAULTS.topDays)));
  const headroomPercent = Math.max(0, int(cluster.volumeHeadroomPercent, VOLUME_DEFAULTS.headroomPercent));
  return { windowDays, topDays, headroomPercent };
}

/**
 * Daily ingest, from the date-suffixed indices.
 * @param indices  rows from state.indices (each with `day` and `size`)
 * @param cluster  config entry carrying volumeWindowDays / volumeTopDays
 */
export function dailyVolume(indices, cluster = {}) {
  const cfg = volumeSettings(cluster);
  const t = today();
  const byDay = new Map();
  for (const r of indices || []) {
    if (!r.day || r.day >= t) continue;             // skip undated and today's partial index
    byDay.set(r.day, (byDay.get(r.day) || 0) + (r.size || 0));
  }
  const days = [...byDay.entries()]
    .map(([day, bytes]) => ({ day, bytes }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));      // newest first

  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

  // The window: the most recent complete days that have an index.
  const window7 = days.slice(0, cfg.windowDays);
  // Within that window, the heaviest days are what the cluster must cope with.
  const top3 = [...window7].sort((a, b) => b.bytes - a.bytes).slice(0, cfg.topDays);

  const perDay = mean(top3.map((d) => d.bytes));
  const avg7 = mean(window7.map((d) => d.bytes));   // kept for context, not for sizing

  return {
    days,
    daysCovered: days.length,
    oldestDay: days.length ? days[days.length - 1].day : null,
    newestDay: days.length ? days[0].day : null,
    perDay,
    avg7,
    windowDays: window7.length,
    top3Days: top3.map((d) => d.day),
    sampleDays: window7.length,
    settings: cfg,
    basis: !days.length
      ? 'no dated indices'
      : `mean of the ${top3.length} heaviest of the last ${window7.length} day${window7.length === 1 ? '' : 's'}` +
        (top3.length ? ` (${top3.map((d) => d.day).join(', ')})` : ''),
  };
}

const div = (a, b) => (b > 0 ? a / b : null);

/**
 * The headroom a report row was actually built with — see volumeSettings().
 *
 * Exported because the capacity page needs the same figure for its own labels, and the
 * alternative has already failed twice. First, three headings on that page said "+30%"
 * outright, so a cluster provisioning for 50% was shown a correct buffered figure under a
 * heading that contradicted it. The fix for that then grew a second copy of this accessor
 * in ui/js/pages/volume.js, which is exactly the drift this codebase has suffered three
 * times before: one definition per quantity, so the grid note, the CSV note and the page
 * heading cannot come to disagree about what "the headroom in force" means.
 *
 * Read back off the report rather than recomputed from the cluster config, because
 * volumeSettings() clamps what the YAML says — re-reading volumeHeadroomPercent here would
 * recompute the quantity and could legitimately differ from the number bufferedGB was
 * actually multiplied by. The VOLUME_DEFAULTS fallback is deliberate: the page's deleted
 * copy read r.vol.settings unguarded and threw a TypeError on anything short of a full
 * volumeReport() result, which takes the whole render down rather than labelling one cell
 * with the default it would have been sized against anyway.
 */
export const headroomPct = (r) => (r && r.vol && r.vol.settings ? r.vol.settings.headroomPercent : VOLUME_DEFAULTS.headroomPercent);

/**
 * Everything the volume report shows for one cluster.
 *
 * @param cluster  the config entry (carries liveRetention / snapshotRetention)
 * @param data     state.data entry (disk, repos, snapshots, slm)
 * @param indices  state.indices entry
 * @param repoBytes  measured repository size, when the operator has asked for it
 */
export function volumeReport(cluster, data = {}, indices = [], repoBytes = null) {
  const vol = dailyVolume(indices, cluster);
  const perDayGB = bytesToGB(vol.perDay);
  // Planning headroom from config (volumeHeadroomPercent, default 30). Every "will it
  // fit" figure below is built on this one, so a cluster that provisions differently
  // changes one setting rather than being read against someone else's assumption.
  const headroomPercent = vol.settings.headroomPercent;
  const bufferedGB = perDayGB * (1 + headroomPercent / 100);

  const disk = data.disk || {};
  const liveTotalGB = bytesToGB(disk.total);
  const liveUsedGB = bytesToGB(disk.used);
  const liveFreeGB = bytesToGB(disk.avail);
  const livePct = isFinite(disk.percent) ? disk.percent : null;

  // What the cluster actually enforces, read from ILM and SLM.
  const ilm = data.appliedIlm || null;
  const slmApplied = data.appliedSlm || null;
  const ilmRetention = ilm ? parseRetention(ilm.deleteAfter) : null;
  const slmAppliedRetention = slmApplied ? parseRetention(slmApplied.expireAfter) : null;

  // The config states the intent; ILM/SLM state the reality. Prefer the stated policy
  // for sizing, fall back to what the cluster does, and report both so drift is visible.
  const live = parseRetention(cluster.liveRetention) || ilmRetention;
  const snap = parseRetention(cluster.snapshotRetention) || slmAppliedRetention || slmRetention(data);

  // What retention actually costs, at the planning rate.
  const requiredLiveGB = live ? bufferedGB * live.days : null;
  const required30GB = bufferedGB * 30;
  const required90GB = bufferedGB * 90;
  const required365GB = bufferedGB * 365;

  // Snapshot window actually present in the repositories.
  const snapWindow = snapshotWindow(data);

  const repoGB = repoBytes === null || repoBytes === undefined ? null : bytesToGB(repoBytes);
  const repos = data.repos || [];

  // The repository's total size is a fact only the operator has; the used figure is
  // measured. Keeping them apart means "is there room" can be answered honestly, or
  // not answered at all, rather than answered against a guess.
  const backupCap = parseSize(cluster.backupCapacity);
  const backupCapacityGB = backupCap ? backupCap.gb : null;
  const backupFreeGB = backupCapacityGB === null || repoGB === null ? null : backupCapacityGB - repoGB;
  const requiredSnapshotGB = snap ? bufferedGB * snap.days : null;
  // Sized against the policy when there is one, else against a year.
  const backupNeedGB = requiredSnapshotGB === null ? required365GB : requiredSnapshotGB;

  return {
    cluster, vol,
    perDayGB, bufferedGB,
    liveTotalGB, liveUsedGB, liveFreeGB, livePct,

    // How long the free space lasts at the current rate — a projection of today's
    // behaviour, so it uses the unbuffered figure.
    liveSufficientDays: div(liveFreeGB, perDayGB),

    liveRetention: live,
    liveRetentionSource: parseRetention(cluster.liveRetention) ? 'config' : ilmRetention ? 'ILM' : null,

    // Applied policies — the metric names the operator asked for.
    appliedIlm: ilm,
    appliedIlmLabel: ilm
      ? `${ilm.name}${ilm.deleteAfter ? ` — delete after ${ilm.deleteAfter}` : ' — no delete phase'}`
      : 'none applied',
    appliedIlmRetention: ilmRetention,
    appliedSlm: slmApplied,
    appliedSlmLabel: slmApplied
      ? `${slmApplied.name}${slmApplied.expireAfter ? ` — expire after ${slmApplied.expireAfter}` : ' — no expiry'}` +
        (slmApplied.maxCount != null ? `, max ${slmApplied.maxCount}` : '')
      : 'none configured',
    appliedSlmRetention: slmAppliedRetention,

    // Does the cluster actually do what the config says it should?
    livePolicyMatchesIlm: parseRetention(cluster.liveRetention) && ilmRetention
      ? parseRetention(cluster.liveRetention).days === ilmRetention.days : null,
    snapshotPolicyMatchesSlm: parseRetention(cluster.snapshotRetention) && slmAppliedRetention
      ? parseRetention(cluster.snapshotRetention).days === slmAppliedRetention.days : null,

    requiredLiveGB,
    liveRetentionMet: live && liveTotalGB > 0 ? liveTotalGB >= requiredLiveGB : null,
    required30GB, required90GB, required365GB,

    liveLogsFrom: vol.oldestDay,
    liveLogsTo: vol.newestDay,
    liveLogsDays: vol.daysCovered,

    repoGB,
    repoSummary: repos.length
      ? repos.map((r) => `${r.name} (${r.type}${r.location ? ` @ ${r.location}` : ''})`).join('; ')
      : 'none registered',
    snapshotRetention: snap,
    backupCapacityGB, backupCapacityLabel: backupCap ? backupCap.label : null,
    backupFreeGB, requiredSnapshotGB, backupNeedGB,
    // Room for what the policy requires. Unknown — not "no" — until the capacity is stated.
    backupSpaceMet: backupCapacityGB === null ? null : backupCapacityGB >= backupNeedGB,
    snapshotRetentionMet: snap && repoGB !== null ? repoGB >= bufferedGB * snap.days : null,
    // How many days of data the repository currently holds, at the same daily rate.
    backupSufficientDays: repoGB === null ? null : div(repoGB, perDayGB),
    // When the snapshots ran.
    snapshotsFrom: snapWindow.from,
    snapshotsTo: snapWindow.to,
    snapshotsDays: snapWindow.days,
    snapshotCount: snapWindow.count,
    // Which days of logs they hold. Null when the repository listing did not name the
    // indices, which is not the same as holding nothing.
    snapshotDataFrom: snapWindow.dataFrom,
    snapshotDataTo: snapWindow.dataTo,
    snapshotDataDays: snapWindow.dataDays,
  };
}

/** SLM's own `expire_after` is a retention policy too, when the config does not name one. */
function slmRetention(data) {
  for (const p of data.slm || []) {
    const exp = p.policy && p.policy.retention && p.policy.retention.expire_after;
    const parsed = parseRetention(exp);
    if (parsed) return { ...parsed, label: `${parsed.label} (from SLM)` };
  }
  return null;
}

function snapshotWindow(data) {
  let from = null, to = null, count = 0;
  let dataFrom = null, dataTo = null;
  for (const list of Object.values(data.snapshots || {})) {
    for (const s of list || []) {
      if (!s.start) continue;
      count++;
      if (from === null || s.start < from) from = s.start;
      if (to === null || s.start > to) to = s.start;
      // Two different questions. `start` is when the snapshot ran; coverFrom/coverTo are
      // the days of logs inside it, read from the dates in its index names. A snapshot
      // taken this morning can hold ninety days of data, so the second is the one that
      // says how far back the backup actually reaches.
      if (s.coverFrom && (dataFrom === null || s.coverFrom < dataFrom)) dataFrom = s.coverFrom;
      if (s.coverTo && (dataTo === null || s.coverTo > dataTo)) dataTo = s.coverTo;
    }
  }
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
  return {
    from: day(from), to: day(to), count,
    days: spanDays(from, to),
    dataFrom, dataTo,
    dataDays: spanDaysIso(dataFrom, dataTo),
  };
}

/* --------------------------------- presentation -------------------------------- */

/**
 * How many days a range covers, counting both ends.
 *
 * Snapshots taken on the 10th and the 11th cover two days, not one. Exported because
 * the Snapshots page asks the same question about the same snapshots, and a second
 * implementation of it drifted: the report said 2 days while that page said 1.
 */
export function spanDays(fromMs, toMs) {
  if (!fromMs || !toMs) return 0;
  return Math.max(1, Math.round((toMs - fromMs) / 86400000) + 1);
}

/**
 * The same count for two calendar days written `YYYY-MM-DD` — the days of data an index
 * name says a snapshot holds. One definition for the snapshot row, the Snapshots page, the
 * evidence view and this report, which each had their own copy of the arithmetic.
 */
export function spanDaysIso(fromDay, toDay) {
  if (!fromDay || !toDay) return 0;
  return spanDays(Date.parse(`${fromDay}T00:00:00Z`), Date.parse(`${toDay}T00:00:00Z`));
}

export const gb = (v) => (v === null || v === undefined || !isFinite(v) ? '–' : `${v.toFixed(1)} GB`);
export const days = (v) => (v === null || v === undefined || !isFinite(v) ? '–' : `${Math.floor(v)} days`);
export const yesNo = (v) => (v === null || v === undefined ? 'unknown' : v ? 'YES' : 'NO');

/** The report as ordered label/value pairs — the shape the table and the CSV share. */
/**
 * The same report as label / value / explanation, for the per-cluster card.
 *
 * Derived from SHEET_COLUMNS rather than written out again: the card and the export used
 * to be two lists that had drifted apart, so the screen and the file named the same
 * numbers differently.
 */
export function reportRows(r) {
  return SHEET_COLUMNS.map((c) => [
    c.unit ? `${c.label} (${c.unit})` : c.label,
    sheetCell(c, r),
    c.note ? c.note(r) : null,
  ]);
}

/**
 * The spreadsheet layout: one column per parameter, grouped by what it is about.
 *
 * `get` returns a plain value; `kind` tells the view how to align and colour it, and
 * the CSV uses the same definitions so the screen and the file cannot diverge.
 */
/**
 * The report, defined once.
 *
 * The grid, the CSV and the per-cluster card are all rendered from this list, so a column
 * cannot be renamed in one and not the others. `note` is the explanation shown beside the
 * value on the card and as hover text in the grid; it never travels in the CSV, where a
 * sentence per cell would drown the numbers.
 */
export const SHEET_COLUMNS = [
  { group: 'Cluster', label: 'Cluster name', kind: 'text', get: (r) => r.cluster.name,
    help: 'The cluster this row is about. One cluster is one Elasticsearch URL.' },
  { group: 'Cluster', label: 'Elasticsearch URL', kind: 'text', get: (r) => r.cluster.url,
    help: 'Where the app connects. For a cluster behind a jump host this is the address as the jump host resolves it.' },
  { group: 'Cluster', label: 'Tags', kind: 'text', get: (r) => (r.cluster.tags || []).join(', '),
    help: 'Labels from the config file, for grouping and filtering. Nothing is calculated from them.' },

  { group: 'How much comes in', label: 'Indices size per day', unit: 'GB', kind: 'num',
    get: (r) => round1(r.perDayGB), note: (r) => r.vol.basis,
    help: 'How much the indices grow in a day: the average of the heaviest days in the window, both set in the '
        + 'config (volumeTopDays of volumeWindowDays, 3 of 7 by default). Heaviest-few rather than a plain average '
        + 'so a quiet weekend does not make the estimate too small. Today is left out because it is still being '
        + 'written to.' },
  { group: 'How much comes in', label: 'Per day + buffer', unit: 'GB', kind: 'num',
    get: (r) => round1(r.bufferedGB),
    note: (r) => `the daily figure plus ${headroomPct(r)}% headroom — what sizing is done against`,
    help: 'The daily figure plus the configured headroom (volumeHeadroomPercent, 30% by default). Every "needed" '
        + 'and "required" number on this row is this figure multiplied by a number of days.' },

  { group: 'Disk on the cluster', label: 'Disk total', unit: 'GB', kind: 'num', get: (r) => round1(r.liveTotalGB),
    help: 'Total disk across the data nodes, as Elasticsearch reports it.' },
  { group: 'Disk on the cluster', label: 'Disk used', unit: '%', kind: 'num', get: (r) => (r.livePct === null ? null : round1(r.livePct)),
    help: 'How full that disk is now. The warning and critical thresholds come from the config.' },
  { group: 'Disk on the cluster', label: 'Disk free', unit: 'GB', kind: 'num', get: (r) => round1(r.liveFreeGB),
    help: 'Disk not yet used. Not all of it is usable: Elasticsearch stops allocating shards at the high '
        + 'watermark, 90% full by default, so the cluster is in trouble before this reaches zero.' },
  { group: 'Disk on the cluster', label: 'Current live storage store upto', unit: 'days', kind: 'num',
    get: (r) => floorOrNull(r.liveSufficientDays), note: () => 'at the current daily rate',
    help: 'Disk free ÷ indices size per day. How long until the cluster fills at today\'s rate, assuming nothing is deleted. '
        + 'Uses the unbuffered daily figure, because it is a projection of what is happening rather than a plan.' },

  { group: 'Indices kept on the cluster', label: 'Retention policy', kind: 'text',
    get: (r) => (r.liveRetention ? r.liveRetention.label : 'not set'),
    note: (r) => (r.liveRetentionSource ? `stated by ${r.liveRetentionSource}` : 'set liveRetention on the cluster'),
    help: 'How long indices are meant to stay on the cluster. Taken from liveRetention in the config, or from the '
        + 'ILM delete phase when the config does not say.' },
  { group: 'Indices kept on the cluster', label: 'ILM policy in force', kind: 'text', get: (r) => r.appliedIlmLabel,
    note: (r) => (r.appliedIlm && r.appliedIlm.indices ? `on ${r.appliedIlm.indices} matching index/indices` : null),
    help: 'The ILM policy Elasticsearch is actually applying, and when it deletes.' },
  { group: 'Indices kept on the cluster', label: 'Policy matches ILM?', kind: 'bool', get: (r) => r.livePolicyMatchesIlm,
    note: (r) => (r.livePolicyMatchesIlm === false
      ? `config says ${r.liveRetention ? r.liveRetention.label : '?'}, ILM deletes after ${r.appliedIlm.deleteAfter}` : null),
    help: 'NO means the config and ILM disagree about how long to keep indices — one of the two is wrong, and the '
        + 'cluster is doing whatever ILM says.' },
  { group: 'Indices kept on the cluster', label: 'Disk needed for the policy', unit: 'GB', kind: 'num', get: (r) => round1(r.requiredLiveGB),
    note: (r) => (r.liveRetention ? `(per day + ${headroomPct(r)}%) × ${r.liveRetention.days} days` : 'no retention policy set'),
    help: 'Indices size per day, plus the configured headroom, × the retention policy in days.' },
  { group: 'Indices kept on the cluster', label: 'Enough disk for the policy?', kind: 'bool', get: (r) => r.liveRetentionMet,
    note: (r) => (r.requiredLiveGB ? `needs ${gb(r.requiredLiveGB)}` : 'set liveRetention on the cluster'),
    help: 'Whether disk total covers what the retention policy needs. NO means the policy cannot be kept without more disk.' },
  { group: 'Indices kept on the cluster', label: 'Disk needed for 30 days', unit: 'GB', kind: 'num', get: (r) => round1(r.required30GB),
    note: (r) => `(per day + ${headroomPct(r)}%) × 30 days`, help: 'Indices size per day, plus the configured headroom, × 30.' },
  { group: 'Indices kept on the cluster', label: 'Disk needed for 90 days', unit: 'GB', kind: 'num', get: (r) => round1(r.required90GB),
    note: (r) => `(per day + ${headroomPct(r)}%) × 90 days`, help: 'Indices size per day, plus the configured headroom, × 90.' },
  { group: 'Indices kept on the cluster', label: 'Days of indices held now', unit: 'days', kind: 'num',
    get: (r) => r.vol.daysCovered || null,
    note: (r) => (r.liveLogsFrom ? `${r.liveLogsFrom} → ${r.liveLogsTo}` : 'no dated indices'),
    help: 'How many days of dated indices are on the cluster right now — what it actually holds, which is not always '
        + 'what the policy says it should.' },
  { group: 'Indices kept on the cluster', label: 'Oldest index day', kind: 'text', get: (r) => r.liveLogsFrom,
    help: 'The earliest day found in the index names on the cluster.' },
  { group: 'Indices kept on the cluster', label: 'Newest index day', kind: 'text', get: (r) => r.liveLogsTo,
    help: 'The latest day found in the index names on the cluster.' },

  // Space: what there is, what is in it, what is needed. In that order, because that is
  // the order the question is asked in.
  { group: 'Backups (snapshots)', label: 'Backup space available', unit: 'GB', kind: 'num',
    get: (r) => round1(r.backupCapacityGB),
    note: (r) => (r.backupCapacityGB === null ? 'set backupCapacity on the cluster, e.g. "2TB"' : r.backupCapacityLabel),
    help: 'The total size of the snapshot repository. Elasticsearch has no API for this — a repository is a mount '
        + 'point or a bucket, and only you know how big it is — so it comes from backupCapacity in the cluster '
        + 'config, written as "2TB", "500 GB" or a bare number of GB.' },
  { group: 'Backups (snapshots)', label: 'Backup space used', unit: 'GB', kind: 'num', get: (r) => round1(r.repoGB),
    note: (r) => (r.repoGB === null ? 'press Measure on the cluster card' : 'sum of every snapshot\'s incremental bytes'),
    help: 'What the repository holds now. Elasticsearch will not total this cheaply, so it is read on demand with '
        + 'the Measure button — one call per snapshot. Snapshots are incremental, so this is far less than the '
        + 'sum of the indices in them.' },
  { group: 'Backups (snapshots)', label: 'Backup space free', unit: 'GB', kind: 'num', get: (r) => round1(r.backupFreeGB),
    note: (r) => (r.backupFreeGB === null ? 'needs backupCapacity in the config and a measured size' : 'available − used'),
    help: 'Backup space available − backup space used. Needs both the configured capacity and a measured size.' },
  { group: 'Backups (snapshots)', label: 'Backup space required for the policy', unit: 'GB', kind: 'num',
    get: (r) => round1(r.requiredSnapshotGB),
    note: (r) => (r.snapshotRetention ? `(per day + ${headroomPct(r)}%) × ${r.snapshotRetention.days} days` : 'no backup retention policy set'),
    help: 'Indices size per day, plus the configured headroom, × the backup retention policy in days. An upper bound: snapshots are '
        + 'incremental, so the repository normally needs less.' },
  { group: 'Backups (snapshots)', label: 'Backup space required for 365 days', unit: 'GB', kind: 'num', get: (r) => round1(r.required365GB),
    note: (r) => `(per day + ${headroomPct(r)}%) × 365 days`,
    help: 'Indices size per day, plus the configured headroom, × 365 — a year of backups. An upper bound, for the same reason.' },
  { group: 'Backups (snapshots)', label: 'Enough backup space?', kind: 'bool', get: (r) => r.backupSpaceMet,
    note: (r) => (r.backupCapacityGB === null ? 'set backupCapacity on the cluster'
                                              : `needs ${gb(r.backupNeedGB)} of ${gb(r.backupCapacityGB)}`),
    help: 'Whether the space available covers what is required — the policy figure when a policy is set, otherwise '
        + 'the 365-day figure. Unknown, rather than NO, until backupCapacity is in the config.' },

  { group: 'Backups (snapshots)', label: 'Where backups go', kind: 'text', get: (r) => r.repoSummary,
    help: 'The repository type and location — shared filesystem, S3, and so on.' },
  { group: 'Backups (snapshots)', label: 'Backup retention policy', kind: 'text',
    get: (r) => (r.snapshotRetention ? r.snapshotRetention.label : 'not set'),
    help: 'How long snapshots are meant to be kept. From snapshotRetention in the config, or from SLM\'s expire_after.' },
  { group: 'Backups (snapshots)', label: 'SLM policy in force', kind: 'text', get: (r) => r.appliedSlmLabel,
    note: (r) => (r.appliedSlm && r.appliedSlm.schedule ? `schedule ${r.appliedSlm.schedule}` : null),
    help: 'The SLM policy Elasticsearch is actually running: when it takes snapshots and when it expires them.' },
  { group: 'Backups (snapshots)', label: 'Policy matches SLM?', kind: 'bool', get: (r) => r.snapshotPolicyMatchesSlm,
    note: (r) => (r.snapshotPolicyMatchesSlm === false
      ? `config says ${r.snapshotRetention ? r.snapshotRetention.label : '?'}, SLM expires after ${r.appliedSlm.expireAfter}` : null),
    help: 'NO means the config and SLM disagree about how long to keep snapshots.' },
  { group: 'Backups (snapshots)', label: 'Days the backup size buys', unit: 'days', kind: 'num',
    get: (r) => floorOrNull(r.backupSufficientDays),
    note: (r) => (r.repoGB === null ? 'measure the repository first'
                                    : 'repository size ÷ daily volume — an estimate, not a reading'),
    help: 'Backup space used ÷ indices size per day. A rough sense of how much data the repository holds. It is '
        + 'an estimate from sizes; the two columns that follow are read from the actual dates.' },

  // What is actually inside the snapshots, which is the question "how far back can I
  // restore from" really asks. Read from the dates in the index names, not from when
  // the snapshot ran.
  { group: 'Backups (snapshots)', label: 'Oldest index day backed up', kind: 'text', get: (r) => r.snapshotDataFrom,
    note: (r) => (r.snapshotDataFrom ? 'earliest day of indices held in any snapshot'
                                     : 'the repository listing did not name the indices'),
    help: 'The earliest day of data held inside any snapshot, read from the dates in the index names it contains. '
        + 'This is not the date the snapshot ran.' },
  { group: 'Backups (snapshots)', label: 'Newest index day backed up', kind: 'text', get: (r) => r.snapshotDataTo,
    help: 'The latest day of data held inside any snapshot.' },
  { group: 'Backups (snapshots)', label: 'Days of indices backed up', unit: 'days', kind: 'num',
    get: (r) => r.snapshotDataDays || null,
    note: (r) => (r.snapshotDataFrom ? `${r.snapshotDataFrom} → ${r.snapshotDataTo}, from the index names inside`
                                     : 'unknown — the indices in these snapshots are not named or not dated'),
    help: 'The span between those two days — how far back a restore can actually reach. Blank, not zero, when the '
        + 'repository listing does not name the indices.' },

  // When the snapshots ran. A different thing entirely: a snapshot taken today can hold
  // a year of indices, so these two spans do not have to resemble each other.
  { group: 'Backups (snapshots)', label: 'Days of snapshots kept', unit: 'days', kind: 'num', get: (r) => r.snapshotsDays || null,
    note: (r) => (r.snapshotsFrom ? `${r.snapshotsFrom} → ${r.snapshotsTo} · ${r.snapshotCount} snapshots` : 'no snapshots'),
    help: 'How long the snapshots themselves span, from the first run to the last.' },
  { group: 'Backups (snapshots)', label: 'Oldest snapshot taken', kind: 'text', get: (r) => r.snapshotsFrom,
    note: () => 'when it ran — not what is in it',
    help: 'When the earliest snapshot still in the repository was taken. Not the age of the data inside it.' },
  { group: 'Backups (snapshots)', label: 'Newest snapshot taken', kind: 'text', get: (r) => r.snapshotsTo,
    help: 'When the most recent snapshot was taken. If this is not today, snapshots may have stopped running.' },
];

/**
 * The client storage plan — the same report as a customer-facing sizing sheet.
 *
 * Thirteen of the thirty-six columns above, under the words a storage plan is actually
 * discussed in: "live storage" rather than "disk", "client" rather than "cluster". Each
 * entry points at a SHEET_COLUMNS definition and overrides nothing but the heading, so a
 * figure here and the same figure on the full sheet are the one calculation — rename a
 * column and this view follows it rather than quietly disagreeing.
 *
 * A `from` that no longer resolves throws at load. A sizing sheet that silently ships
 * with a column missing is worse than one that refuses to render, and the render check
 * catches it before it leaves the branch.
 */
const CLIENT_VIEW = [
  // `key` is the column's name in Zabbix (elasticpro.plan[<cluster>,<key>]). It is what item
  // history is stored under, so it never changes when a heading is reworded — change the
  // label freely, never the key.
  { from: 'Cluster name',                       group: 'Client',         label: 'ClientName',                             key: 'name' },
  { from: 'Elasticsearch URL',                  group: 'Client',         label: 'ES Host',                                key: 'es.host' },
  { from: 'Indices size per day',               group: 'Volume',         label: 'Current Per Day Volume',                 key: 'volume.day' },
  { from: 'Per day + buffer',                   group: 'Volume',         label: 'Daily Volume + buffer',                  key: 'volume.day.buffered' },
  { from: 'Disk total',                         group: 'Live storage',   label: 'Current Live Storage',                   key: 'live.total' },
  { from: 'Disk used',                          group: 'Live storage',   label: 'Live Used',                              key: 'live.used.pct' },
  { from: 'Current live storage store upto',    group: 'Live storage',   label: 'Current Live Storage Store Upto',        key: 'live.days' },
  { from: 'Disk needed for 30 days',            group: 'Live storage',   label: 'Required Live Storage for 30days',       key: 'live.required.30d' },
  { from: 'Disk needed for 90 days',            group: 'Live storage',   label: 'Required Live Storage for 90days',       key: 'live.required.90d' },
  { from: 'Oldest index day',                   group: 'Live storage',   label: 'Live Indices From',                      key: 'live.from' },
  { from: 'Newest index day',                   group: 'Live storage',   label: 'Live Indices To',                        key: 'live.to' },
  { from: 'Backup space available',             group: 'Backup storage', label: 'Current Backup Storage',                 key: 'backup.total' },
  { from: 'Where backups go',                   group: 'Backup storage', label: 'Backup Storage Type',                    key: 'backup.type' },
  { from: 'Backup space required for 365 days', group: 'Backup storage', label: 'Required Backup Storage for 365 days',   key: 'backup.required.365d' },
  { from: 'Days the backup size buys',          group: 'Backup storage', label: 'Current Backup storage Store upto',      key: 'backup.days' },
  // Read from the dates inside the index names, not from when the snapshot ran — the
  // question "how far back can I restore to" is about the data, not the schedule.
  { from: 'Oldest index day backed up',         group: 'Backup storage', label: 'Snapshot Indices From',                  key: 'backup.from' },
  { from: 'Newest index day backed up',         group: 'Backup storage', label: 'Snapshot Indices To',                    key: 'backup.to' },
];

export const CLIENT_COLUMNS = CLIENT_VIEW.map(({ from, group, label, key }) => {
  const src = SHEET_COLUMNS.find((c) => c.label === from);
  if (!src) throw new Error(`client storage plan: no report column named "${from}"`);
  return { ...src, group, label, key };
});

/**
 * One client's storage plan as values, in column order — what the Zabbix feed sends.
 *
 * Built from CLIENT_COLUMNS and nothing else, so a figure in Zabbix and the same figure in
 * the Client plan grid are one calculation. `null` stays null: a value Elasticsearch could
 * not give is not sent as zero, it is not sent at all.
 */
export function clientPlanValues(r) {
  return CLIENT_COLUMNS.map((c) => {
    const v = c.get(r);
    return { key: c.key, label: c.label, group: c.group, unit: c.unit || '', kind: c.kind,
             value: v === undefined || v === '' ? null : v };
  });
}

/**
 * What the snapshot repositories of one cluster hold, in bytes.
 *
 * Elasticsearch does not report a repository's size. The closest honest answer is the sum
 * of each snapshot's INCREMENTAL bytes — one _status call per snapshot, capped per
 * repository. `failed` says how many could not be read, so a short total is never passed
 * off as a complete one; when every read failed the total is null, not zero.
 *
 * `cache`, when given, is a Map of `repo/snapshot` → bytes. A snapshot never changes size
 * once taken, so a caller that runs often need only ask about the new ones.
 */
export async function measureRepoBytes(cl, data, { cap = 60, cache = null } = {}) {
  let total = 0, failed = 0, counted = 0;
  for (const repo of (data && data.repos) || []) {
    const snaps = (((data.snapshots || {})[repo.name]) || []).slice(0, cap);
    for (const s of snaps) {
      const id = `${repo.name}/${s.id}`;
      if (cache && cache.has(id)) { total += cache.get(id); counted++; continue; }
      try {
        const st = await cl.snapshotStatus(repo.name, s.id);
        const one = (st.snapshots || [])[0];
        const bytes = (one && one.stats && one.stats.incremental && one.stats.incremental.size_in_bytes) || 0;
        if (cache) cache.set(id, bytes);
        total += bytes;
        counted++;
      } catch (_) { failed++; }
    }
  }
  // Nothing readable is unknown. No snapshots at all is a repository holding nothing.
  return { total: counted || !failed ? total : null, counted, failed };
}


function round1(v) { return v === null || v === undefined || !isFinite(v) ? null : Math.round(v * 10) / 10; }
function floorOrNull(v) { return v === null || v === undefined || !isFinite(v) ? null : Math.floor(v); }

/** How a cell prints — one place, so the grid and the CSV agree. */
export function sheetCell(col, r) {
  const v = col.get(r);
  if (col.kind === 'bool') return v === null || v === undefined ? 'unknown' : v ? 'YES' : 'NO';
  if (v === null || v === undefined || v === '') return '–';
  return String(v);
}
