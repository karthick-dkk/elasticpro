/**
 * Backup and restore — the pure part of System › Backup & restore (docs/HANDBOOK.md, "Backup and
 * restore — the message contract"). No DOM, no network: the page (settings.js, on its own branch)
 * renders what these return. The core is the one definition of the sections, their labels, the
 * password rule and the comparison; this file carries the labels so a page can draw the list
 * before BACKUP_STATUS answers, and tools/unit/backup-rules.test.mjs reads them back out of
 * crates/elasticpro-core/src/backup/mod.rs so the two cannot drift.
 */

/** Section ids in the order the board shows them, with the label a person knows each by. */
export const SECTIONS = [
  { id: 'clusters', label: 'Clusters and their settings' },
  { id: 'trust', label: 'Jump hosts, pinned host keys and certificates' },
  { id: 'alerts', label: 'Alert triggers and Automation rules' },
  { id: 'requests', label: 'Request policy and Defaults' },
  { id: 'zabbix', label: 'Zabbix connection, role mapping, roles set by hand' },
  { id: 'reports', label: 'Reports: indices, volume fields, mail, plan templates' },
  { id: 'play', label: 'Play: displays, watch rules, exclusions' },
  { id: 'data', label: 'History store and scheduled log delay settings' },
  { id: 'versions', label: 'Earlier config versions' },
];

/** The core's rule (backup::MIN_PASSWORD); BACKUP_STATUS repeats it as `minPassword`. */
export const MIN_PASSWORD = 12;

/** `kind` → the word in the "Kind" column. */
export const KIND_LABELS = { manual: 'by hand', scheduled: 'scheduled', 'before-restore': 'before a restore' };

export function sectionLabel(id) {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * The "Holds" column of a kept backup: which sections and whether credentials are in it.
 *   everything · credentials encrypted | clusters, play · no credentials
 * `credentials` is the core's word: `password`, `server` or `none`.
 */
export function holdsLabel(sections, credentials) {
  const all = Array.isArray(sections) && SECTIONS.every((s) => sections.includes(s.id));
  const what = all ? 'everything' : (sections || []).map((id) => shortLabel(id)).join(', ') || 'nothing';
  const creds = credentials === 'password' || credentials === 'server' ? 'credentials encrypted' : 'no credentials';
  return `${what} · ${creds}`;
}

/** The first words of a section label, for lists: "Clusters", "Jump hosts", "Alert triggers". */
export function shortLabel(id) {
  const label = sectionLabel(id);
  return label.split(/[:,]| and /)[0].trim();
}

/**
 * Why a typed backup password cannot be used, or null when it can. `repeat` is the second box.
 * Empty means "no password": allowed, the backup then carries no credentials.
 */
export function passwordProblem(password, repeat, min = MIN_PASSWORD) {
  const pw = password ?? '';
  if (!pw) return repeat ? 'Type the password in the first box too' : null;
  if ([...pw].length < min) return `At least ${min} characters`;
  if (repeat !== undefined && repeat !== pw) return 'The two passwords differ';
  return null;
}

/**
 * The "What changes" table from BACKUP_PREVIEW's `preview`: one row per section the backup
 * holds, with the three counts. Sections the file lacks are listed under `missing`.
 */
export function previewRows(preview) {
  const rows = [];
  const missing = [];
  for (const p of preview || []) {
    if (!p.present) { missing.push(p.id); continue; }
    rows.push({
      id: p.id,
      label: sectionLabel(p.id),
      add: (p.add || []).length,
      change: (p.change || []).length,
      same: p.same || 0,
      onlyHere: (p.onlyHere || []).length,
      // Only here now and kept even by a Replace (the request policy, mail, watch rules…).
      keptAnyway: (p.keptAnyway || []).length,
      items: { add: p.add || [], change: p.change || [], onlyHere: p.onlyHere || [], keptAnyway: p.keptAnyway || [] },
    });
  }
  return { rows, missing };
}

/** How many items a Replace would remove, across the sections shown: the core's `onlyHere` is
 *  exactly that list (`keptAnyway` is what a Replace keeps regardless). */
export function onlyHereTotal(preview) {
  return (preview || []).filter((p) => p.present).reduce((n, p) => n + (p.onlyHere || []).length, 0);
}

/**
 * The two radio captions on the restore panel.
 *   merge:   "Merge · add and update; what is only here now stays"
 *   replace: "Replace everything · the 3 items only here now are removed"
 */
export function modeCaption(mode, preview) {
  if (mode === 'merge') return 'Merge · add and update; what is only here now stays';
  const n = onlyHereTotal(preview);
  if (n === 0) return 'Replace everything · nothing is only here now';
  return `Replace everything · the ${n} item${n === 1 ? '' : 's'} only here now ${n === 1 ? 'is' : 'are'} removed`;
}

/**
 * What the credentials panel of a preview says, from BACKUP_PREVIEW's `credentials`:
 *   {state: 'none'} | {state: 'locked', kind} | {state: 'opened', count} | {state: 'skipped'}
 */
export function credentialsCaption(c) {
  switch (c?.state) {
    case 'none': return 'This file holds no credentials: the clusters will ask for them again.';
    case 'opened': return `${c.count ?? 0} credential${c.count === 1 ? '' : 's'} will be restored, re-sealed under this server's key.`;
    case 'skipped': return 'Credentials left out on purpose: the clusters will ask for them again.';
    case 'locked':
      return c.kind === 'server_key'
        ? 'The credentials were sealed by another server: only the settings can be restored here.'
        : 'Type the backup password to restore the credentials too.';
    default: return '';
  }
}

/**
 * The schedule line under "Scheduled backups": "Last: ok today 02:00 · 412 KB · next tomorrow
 * 02:00". `schedule` is BACKUP_STATUS's; `now` is the browser's clock (ms), injectable for tests.
 */
export function scheduleLine(schedule, now = Date.now()) {
  if (!schedule) return '';
  const parts = [];
  if (schedule.last) {
    const l = schedule.last;
    parts.push(`Last: ${l.ok ? 'ok' : 'failed'} ${relativeDay(l.at, now)} ${timeOf(l.at)}${l.ok ? ` · ${bytesLabel(l.bytes)}` : l.message ? ` · ${l.message}` : ''}`);
  } else {
    parts.push('Last: not yet');
  }
  if (!schedule.enabled) parts.push('next: off');
  else if (schedule.next) parts.push(`next ${relativeDay(schedule.next, now)} ${timeOf(schedule.next)}`);
  return parts.join(' · ');
}

export function relativeDay(ms, now = Date.now()) {
  const d = new Date(ms); const n = new Date(now);
  const day = (x) => Math.floor((x.getTime() - x.getTimezoneOffset() * 60000) / 86400000);
  const diff = day(d) - day(n);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function timeOf(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 412 KB, 1.2 MB: the size column. Bytes under a kilobyte are said as bytes. */
export function bytesLabel(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** `elasticpro-backup-20261105-020000-scheduled.epbak`: the download's file name for a backup taken at `ms`. */
export function downloadName(ms, kind = 'manual') {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `elasticpro-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${kind}.epbak`;
}
