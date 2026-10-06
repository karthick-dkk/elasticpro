/**
 * What is inside one snapshot, written down so it can be handed to an auditor.
 *
 * Pure: the dialog in ui/snapshot-dialogs.js gathers the facts (the listing row, the
 * snapshot detail when it could be read, who is signed in) and this turns them into the
 * three shapes they are shown in — the table on screen, the CSV and the plain-text block —
 * from ONE list of header fields and ONE list of rows, so the three cannot disagree.
 *
 * Nothing here computes a day span. The dates come from `dayOf` (parseIndexName, the one
 * reader of index names) and the covered range from `cover` (coveredDays, the definition
 * the snapshot rows already carry); this only lays them out.
 */

import { toCsv, csvEscape } from '../lib/fmt.js';

export const NO_DATE = 'no date in name';

/**
 * One row per index: its data day, and its shard outcome when the detail reported one.
 *
 * `failures` is the snapshot detail's list, or null when the detail could not be read —
 * then every row's status is unknown, never "ok": a snapshot we did not look inside has
 * not been shown to be clean.
 *
 * Sorted by data day (oldest first), then name; indices with no date in the name last.
 */
export function evidenceRows(names, dayOf, failures) {
  const byIndex = new Map();
  for (const f of failures || []) {
    const k = f && f.index;
    if (!k) continue;
    const cur = byIndex.get(k) || [];
    cur.push(f);
    byIndex.set(k, cur);
  }
  const rows = [...new Set(names || [])].map((index) => {
    const day = dayOf(index) || null;
    const fails = byIndex.get(index) || [];
    let status, detail = '';
    if (failures == null) status = 'unknown';
    else if (fails.length) {
      status = 'failed';
      detail = fails.map((f) => `shard ${f.shard_id ?? '?'}: ${f.reason || f.status || 'failed'}`).join('; ');
    } else status = 'ok';
    return { index, day, failedShards: fails.length, status, detail };
  });
  rows.sort((a, b) => {
    if (a.day !== b.day) {
      if (!a.day) return 1;
      if (!b.day) return -1;
      return a.day < b.day ? -1 : 1;
    }
    return a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
  });
  return rows.map((r, i) => ({ n: i + 1, ...r }));
}

/**
 * "covers 2026-09-23 → 2026-09-29 (7 days, 0 missing days)", or why it cannot say.
 *
 * `cover` is coveredDays' shape; `named` false means the index names themselves are not
 * known, which is not the same as none of them carrying a date.
 */
export function coverLine(cover, { named = true } = {}) {
  if (!named) return 'covers unknown — the index names could not be read';
  if (!cover || !cover.coverFrom) return 'covers no dated days — no index name in this snapshot carries a date';
  const days = cover.coverDays === 1 ? '1 day' : `${cover.coverDays} days`;
  const miss = cover.missingDays === 1 ? '1 missing day' : `${cover.missingDays || 0} missing days`;
  return `covers ${cover.coverFrom} → ${cover.coverTo} (${days}, ${miss})`;
}

/**
 * The header block, as ordered {label, value} pairs. `value` is what is shown and copied;
 * `raw` (when present) is the machine-readable form the CSV carries instead — ISO times.
 */
export function evidenceHeader(f) {
  const user = f.user ? String(f.user) : '';
  const shards = f.shards || {};
  return [
    { key: 'cluster', label: 'Cluster', value: f.cluster || '–' },
    { key: 'url', label: 'Address', value: safeUrl(f.url) || '–' },
    { key: 'repository', label: 'Repository', value: f.repository || '–' },
    { key: 'snapshot', label: 'Snapshot', value: f.snapshot || '–' },
    { key: 'state', label: 'State', value: f.state || 'unknown' },
    { key: 'taken', label: 'Taken', value: f.takenText || '–', raw: iso(f.taken) },
    { key: 'ended', label: 'Ended', value: f.endedText || '–', raw: iso(f.ended) },
    { key: 'duration', label: 'Duration', value: f.durationText || '–' },
    { key: 'shards', label: 'Shards',
      value: shards.total == null ? 'unknown'
        : `${shards.successful ?? 0} ok · ${shards.failed ?? 0} failed · ${shards.total} total` },
    { key: 'indices', label: 'Indices', value: f.indexCount == null ? 'unknown' : String(f.indexCount) },
    { key: 'covers', label: 'Data inside', value: f.cover || '–' },
    { key: 'generated', label: 'Evidence generated',
      value: `${f.generatedText || iso(f.generatedAt)} by ${user || 'user not known'}`,
      raw: `${iso(f.generatedAt)} by ${user || 'user not known'}` },
  ];
}

function iso(ms) {
  const n = Number(ms);
  return ms && isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
}

const statusText = (r) => (r.status === 'failed' ? `${r.failedShards} shard(s) failed` : r.status);

/** CSV: the header fields as leading `field,value` rows, a blank line, then the table. */
export function evidenceCsv(header, rows) {
  const head = header.map((f) => [f.label, f.raw !== undefined && f.raw !== '' ? f.raw : f.value]
    .map(csvEscape).join(',')).join('\n');
  const body = toCsv(rows.map((r) => ({
    '#': r.n, index: r.index, data_date: r.day || NO_DATE, shard_status: statusText(r), shard_detail: r.detail,
  })), ['#', 'index', 'data_date', 'shard_status', 'shard_detail']);
  return `${head}\n\n${body}\n`;
}

/** The plain-text block for pasting into a ticket: aligned header, then one line per index. */
export function evidenceText(header, rows) {
  const w = Math.max(...header.map((f) => f.label.length));
  const lines = ['SNAPSHOT EVIDENCE', ''];
  for (const f of header) lines.push(`${f.label.padEnd(w)}  ${f.value}`);
  lines.push('');
  const nw = String(rows.length).length;
  const iw = Math.max(5, ...rows.map((r) => r.index.length));
  const dw = Math.max(9, ...rows.map((r) => (r.day || NO_DATE).length));
  lines.push(`${'#'.padStart(nw)}  ${'Index'.padEnd(iw)}  ${'Data date'.padEnd(dw)}  Shards`);
  for (const r of rows) {
    lines.push(`${String(r.n).padStart(nw)}  ${r.index.padEnd(iw)}  ${(r.day || NO_DATE).padEnd(dw)}  ${statusText(r)}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  if (!rows.length) lines.push('(no indices)');
  return lines.join('\n') + '\n';
}

/**
 * A cluster address fit for evidence: any user:password@ is removed. A URL can carry a
 * credential, and evidence gets pasted into tickets and audit folders.
 */
export function safeUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(String(u));
    x.username = ''; x.password = '';
    return x.toString().replace(/\/$/, '');
  } catch (_) {
    return String(u).replace(/\/\/[^/@]*@/, '//');
  }
}
