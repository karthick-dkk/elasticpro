/**
 * Planning arithmetic (docs/REPORTS.md "Planning (board 8) and Plan templates (board 10)"):
 * what servers a daily volume needs under a plan template. Pure: no DOM, no bridge, so
 * tools/unit/plan.test.mjs imports it bare and the page, the CSV and the tests share one
 * definition of every figure.
 *
 * A template is `{name, backup: 'disk'|'s3'|'ulm', roles: [role]}`; a role is
 * `{on, name, rule, cpu, ram, root, notes, ...}` and `rule` is one of
 *   volume   : count = ceil(volume / cap), at least 1           (`cap`: GB per day per server)
 *   fixed    : count                                            (`count`)
 *   tier     : nodes = ceil(volume x tier days x (1 + buffer) x (1 + replicas) / node size);
 *              0 days -> no nodes; one data node in total holds every role   (`tier`, `nodeTB`)
 *   whenData : `count` once hot + warm data nodes >= `from`, else 0
 *   follows  : ceil(count of the role named `of` / `per`)
 *   target   : used only when backups go to it (`target`: 's3' bucket | 'ulm' archive)
 * A value that is null (or 0 where it divides) is "[set]": not given in the template yet. It
 * is never taken as 0: the row says so and the totals leave it out and count what they left out.
 *
 * This is the design board's logic (Planning.dc.html) made faithful and extended with the
 * `follows` rule and the `on` switch.
 */

export const BACKUP_TARGETS = ['disk', 's3', 'ulm'];
export const TARGET_LABEL = { disk: '/backup disk', s3: 'S3', ulm: 'ULM → S3' };
export const DEFAULT_INPUT = { perDay: 500, hotDays: 30, warmDays: 0, bkDays: 30, buffer: 30, replicas: 0, backup: 'disk' };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** A positive number the role divides by; null / 0 / junk is "not set". */
const pos = (v) => (isNum(v) && v > 0 ? v : null);
const num = (v, min) => { const x = Number(v); return Number.isFinite(x) && x >= min ? x : min; };

/** The inputs as numbers inside their bounds (the design's rules: volume >= 1, hot >= 1, replicas whole). */
export function normaliseInput(i = {}) {
  const d = DEFAULT_INPUT;
  const get = (k) => (i[k] === undefined ? d[k] : i[k]);   // a blank field is the board's minimum, not the default
  const hotDays = num(get('hotDays'), 1);
  const warmDays = num(get('warmDays'), 0);
  return {
    perDay: num(get('perDay'), 1), hotDays, warmDays, days: hotDays + warmDays,
    bkDays: num(get('bkDays'), 0), buffer: num(get('buffer'), 0), replicas: Math.floor(num(get('replicas'), 0)),
    backup: BACKUP_TARGETS.includes(i.backup) ? i.backup : d.backup,
  };
}

/**
 * A disk size as it is bought: rounded UP, to a whole TB from 1 TB, to a whole GB below it, so a
 * plan never shows less disk than the arithmetic needs. 2790 -> 3000, 19500 -> 20000, 479.2 -> 480,
 * 999.5 -> 1000. The exact figure is cut to 6 decimals first, so float noise (19500.000000000004)
 * does not buy a whole extra TB.
 */
export function diskGB(gb) {
  const g = Math.round(gb * 1e6) / 1e6;
  const up = Math.ceil(g);
  return up >= 1000 ? Math.ceil(g / 1000) * 1000 : up;
}

/** A size that is already whole: 3000 -> "3 TB", 1440 -> "1.44 TB", 480 -> "480 GB". */
const fmtSize = (gb) => (gb >= 1000 ? `${Math.round(gb / 10) / 100} TB` : `${gb} GB`);

/** A disk size as the plan shows it, rounded up by diskGB: 2790 -> "3 TB", 19500 -> "20 TB", 480 -> "480 GB". */
export function fmtGB(gb) {
  return fmtSize(diskGB(gb));
}

const plus = (n, what) => (n ? `+ ${n} role${n === 1 ? '' : 's'} without ${what}` : 'every role counted');

/**
 * The bill of materials.
 * @returns {{input, rows: Row[], totals: Totals}} Row: `{role, rule, off, kind, count, countText, cpu, ram, root,
 *   liveGB, liveText, bkGB, bkText, cpuT, ramT, unset: {count, cpu, ram, root}}`; numbers are null where "[set]".
 */
export function computePlan(template, rawInput) {
  const input = normaliseInput(rawInput);
  const { perDay, hotDays, warmDays, bkDays, buffer, replicas, backup } = input;
  const bufMul = 1 + buffer / 100;
  const repMul = 1 + replicas;
  // Each tier is sized on its own days. Backups hold the primaries only: no replica multiplier.
  const tierGB = { hot: perDay * hotDays * bufMul * repMul, warm: perDay * warmDays * bufMul * repMul };
  const tierDays = { hot: hotDays, warm: warmDays };
  const bkGB = perDay * bkDays * bufMul;
  const s3GB = perDay * bkDays;
  const roles = ((template && template.roles) || []).filter((r) => r && r.on !== false);

  const tierCount = (r) => {
    const gb = tierGB[r.tier];
    if (!gb) return 0;
    const node = pos(r.nodeTB);
    return node ? Math.max(1, Math.ceil(gb / (node * 1000))) : null;
  };
  const dataNodes = roles.filter((r) => r.rule === 'tier').reduce((a, r) => a + (tierCount(r) || 0), 0);
  // The one hot tier row carries the shared /backup disk.
  const backupRow = roles.find((r) => r.rule === 'tier' && r.tier === 'hot');

  const memo = new Map();
  const countOf = (r, stack = []) => {
    if (memo.has(r)) return memo.get(r);
    let c = null;
    if (r.rule === 'volume') c = pos(r.cap) ? Math.max(1, Math.ceil(perDay / r.cap)) : null;
    else if (r.rule === 'fixed') c = isNum(r.count) ? r.count : null;
    else if (r.rule === 'tier') c = tierCount(r);
    else if (r.rule === 'whenData') c = pos(r.from) == null ? null : (dataNodes >= r.from ? (isNum(r.count) ? r.count : null) : 0);
    else if (r.rule === 'follows') {
      const of = roles.find((x) => String(x.name).toLowerCase() === String(r.of).toLowerCase());
      const per = pos(r.per);
      const base = of && !stack.includes(of) ? countOf(of, [...stack, r]) : null;
      c = per && isNum(base) ? Math.ceil(base / per) : null;
    } else if (r.rule === 'target') {
      if (r.target === 's3') c = null;
      else c = backup === 'ulm' ? (pos(r.cap) ? Math.max(1, Math.ceil(perDay / r.cap)) : null) : 0;
    }
    memo.set(r, c);
    return c;
  };

  // liveGB is what the policy needs; liveBuyGB is what the rows buy (each node's disk rounded up x count),
  // so the /live disk tile is the sum of the rows it sits above.
  let servers = 0, cpuTotal = 0, ramTotal = 0, unsetCpu = 0, unsetRam = 0, unsetCount = 0, liveGB = 0, liveBuyGB = 0;
  const offRow = (r, rule, count = 0) => ({ role: r.name, rule, off: true, kind: r.rule, count, countText: String(count), cpu: null, ram: null, root: null,
    liveGB: null, liveText: '—', bkGB: null, bkText: '—', cpuT: null, ramT: null, unset: { count: false, cpu: false, ram: false, root: false } });

  const rows = roles.map((r) => {
    let rule = '', liveText = '—', bkText = '—', rowLive = null, rowBk = null;
    let count = countOf(r);
    if (r.rule === 'volume') rule = pos(r.cap) ? `one per ${r.cap} GB per day` : 'one per [set] GB per day';
    if (r.rule === 'fixed') rule = 'fixed count';
    if (r.rule === 'tier') {
      if (count === 0) return offRow(r, `no ${r.tier} days in the policy`);
      const node = pos(r.nodeTB);
      rule = `${tierDays[r.tier]} ${r.tier} days ÷ ${node || '[set]'} TB per node${dataNodes === 1 && count === 1 ? ' · single node, all roles' : ''}`;
      rowLive = tierGB[r.tier];
      liveText = count ? fmtGB(rowLive / count) : `${fmtGB(rowLive)} in all`;
      liveGB += rowLive;
      liveBuyGB += count ? count * diskGB(rowLive / count) : diskGB(rowLive);
      if (r === backupRow && backup === 'disk') { rowBk = bkGB; bkText = `${fmtGB(bkGB)} shared`; }
    }
    if (r.rule === 'whenData') {
      if (pos(r.from) == null) rule = `${isNum(r.count) ? r.count : '[set]'} from [set] data nodes`;
      else if (count === 0) return offRow(r, `none yet: the data nodes keep this role (under ${r.from} data nodes)`);
      else rule = `${isNum(r.count) ? r.count : '[set]'} dedicated, from ${r.from} data nodes`;
    }
    if (r.rule === 'follows') {
      rule = pos(r.per) ? `one per ${r.per} ${r.of}` : `one per [set] ${r.of}`;
      if (count === 0) return offRow(r, `none: no ${r.of}`);
    }
    if (r.rule === 'target') {
      if (backup !== r.target) return offRow(r, `not used: backups go to ${TARGET_LABEL[backup]}`, '—');
      if (r.target === 's3') {
        return { role: r.name, rule: `S3 bucket: ${fmtGB(s3GB)} (volume × backup days)`, off: false, kind: 'target', count: null, countText: 'bucket',
          cpu: null, ram: null, root: null, liveGB: null, liveText: '—', bkGB: s3GB, bkText: '—', cpuT: null, ramT: null, bucket: true,
          unset: { count: false, cpu: false, ram: false, root: false } };
      }
      rule = `${pos(r.cap) ? `one per ${r.cap} GB per day` : 'one per [set] GB per day'} · archives ${fmtGB(s3GB)} to S3`;
    }
    if (count == null) unsetCount++; else servers += count;
    const cpu = isNum(r.cpu) ? r.cpu : null, ram = isNum(r.ram) ? r.ram : null, root = isNum(r.root) ? r.root : null;
    const cpuT = count != null && cpu != null ? count * cpu : null;
    const ramT = count != null && ram != null ? count * ram : null;
    if (cpuT == null) unsetCpu++; else cpuTotal += cpuT;
    if (ramT == null) unsetRam++; else ramTotal += ramT;
    return { role: r.name, rule, off: false, kind: r.rule, count, countText: count == null ? '[set]' : String(count),
      cpu, ram, root, liveGB: rowLive, liveText, bkGB: rowBk, bkText, cpuT, ramT,
      unset: { count: count == null, cpu: cpu == null, ram: ram == null, root: root == null } };
  });

  const totals = {
    servers, unsetCount, serversText: servers + (unsetCount ? ` +${unsetCount}` : ''),
    cpu: cpuTotal, unsetCpu, cpuNote: plus(unsetCpu, 'a CPU spec'),
    ram: ramTotal, unsetRam, ramNote: plus(unsetRam, 'a RAM spec'),
    liveGB, liveBuyGB, liveText: fmtSize(liveBuyGB),
    backupLabel: backup === 'disk' ? '/backup disk' : backup === 's3' ? 'S3 backup' : 'ULM archive in S3',
    backupGB: backup === 'disk' ? bkGB : s3GB, backupText: fmtGB(backup === 'disk' ? bkGB : s3GB),
    showBackupCol: backup === 'disk', dataNodes,
  };
  return { input, rows, totals };
}

/* ------------------------------------ CSV ------------------------------------ */

export const PLAN_CSV = ['role', 'sizing_rule', 'count', 'cpu_each', 'ram_gb_each', 'root_disk_gb_each', 'live_disk_each', 'backup_disk', 'cpu_total', 'ram_gb_total'];

/** One header row, one row per role, a Total row. "[set]" stays "[set]": unknown is not zero. */
export function planCsvRows(plan) {
  const { rows, totals } = plan;
  const set = (v) => (v == null ? '[set]' : v);
  const body = rows.map((r) => [
    r.role, r.rule,
    r.off ? r.countText : r.bucket ? 'bucket' : set(r.count),
    r.off || r.bucket ? '' : set(r.cpu), r.off || r.bucket ? '' : set(r.ram), r.off || r.bucket ? '' : set(r.root),
    r.liveText === '—' ? '' : r.liveText, r.bkText === '—' ? '' : r.bkText,
    r.cpuT == null ? '' : r.cpuT, r.ramT == null ? '' : r.ramT,
  ]);
  const total = ['Total', '', totals.serversText, '', '', '', totals.liveText, totals.showBackupCol ? totals.backupText : '', totals.cpu, totals.ram];
  const head = totals.showBackupCol ? PLAN_CSV : PLAN_CSV.filter((c) => c !== 'backup_disk');
  const cut = (row) => (totals.showBackupCol ? row : row.filter((_, i) => PLAN_CSV[i] !== 'backup_disk'));
  return [head, ...body.map(cut), cut(total)];
}

/* ------------------------------ based on a cluster ------------------------------ */

export const GB = 1e9;

/** A cluster's `liveRetention` ("30d", "4w", "90 days", 45) as whole days, or null when unset or unreadable. */
export function retentionDays(v) {
  if (isNum(v)) return v > 0 ? Math.round(v) : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(d|day|days|w|wk|week|weeks|m|mo|month|months|y|yr|year|years)?\s*$/i.exec(String(v == null ? '' : v));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'd').toLowerCase();
  const mult = unit[0] === 'd' ? 1 : unit[0] === 'w' ? 7 : unit === 'm' || unit.startsWith('mo') ? 30 : 365;
  const days = Math.round(n * mult);
  return days > 0 ? days : null;
}

/** The inputs an existing cluster fills: daily volume (GB, 1 decimal, at least 0.1) and hot days. Null where unknown. */
export function inputsFromCluster({ perDayBytes, liveRetention }) {
  const out = {};
  if (typeof perDayBytes === 'number' && perDayBytes > 0) out.perDay = Math.max(1, Math.round((perDayBytes / GB) * 10) / 10);
  const d = retentionDays(liveRetention);
  if (d) out.hotDays = d;
  return out;
}
