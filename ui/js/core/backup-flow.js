/**
 * Backup and restore — what the page sends and what it says back (docs/HANDBOOK.md, "Backup and
 * restore — the message contract"). Pure: no DOM, no network. The labels, the password rule and
 * the preview rows are backup-rules.js; this is the form → message half and the words for a
 * refusal or a restore, so tools/unit/backup-flow.test.mjs can press them without a page.
 *
 * The password is only ever a field of the one message that needs it. Nothing here keeps it.
 */

import { SECTIONS, MIN_PASSWORD, passwordProblem, previewRows, onlyHereTotal, sectionLabel } from './backup-rules.js';

/** The starting selection: everything but the earlier config versions (the board leaves them off; they add size). */
export const DEFAULT_TICKED = SECTIONS.filter((s) => s.id !== 'versions').map((s) => s.id);

/** `ids` in the board's order, only ids the page knows (a stale id is dropped). */
export function orderedSections(ids) {
  const set = new Set(ids || []);
  return SECTIONS.filter((s) => set.has(s.id)).map((s) => s.id);
}

/**
 * BACKUP_CREATE from the form. Returns `{message}` or `{problem}` (words for the page).
 * The password is sent only when the credentials switch is on; with it off none is sent and the
 * file carries no credentials. All sections ticked sends no `sections` (absent = all).
 */
export function createMessage({ ticked, withCredentials, password, repeat, keep = false }, min = MIN_PASSWORD) {
  const sections = orderedSections(ticked);
  if (!sections.length) return { problem: 'Tick at least one thing to include' };
  const msg = { type: 'BACKUP_CREATE' };
  if (sections.length < SECTIONS.length) msg.sections = sections;
  if (withCredentials) {
    if (!password) return { problem: `Type a backup password of at least ${min} characters, or switch credentials off` };
    const p = passwordProblem(password, repeat ?? '', min);
    if (p) return { problem: p };
    msg.password = password;
  }
  if (keep) msg.keep = true;
  return { message: msg };
}

/** BACKUP_SCHEDULE_SET: only the four fields the core accepts (`last`/`password` are refused there). */
export function scheduleMessage({ enabled, every, at, keep }, keepMax = 90) {
  if (every !== 'day' && every !== 'week') return { problem: 'Every day or every week' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at || ''))) return { problem: 'Time as HH:MM, for example 02:00' };
  const n = Number(keep);
  if (!Number.isInteger(n) || n < 1 || n > keepMax) return { problem: `Keep between 1 and ${keepMax} backups` };
  return { message: { type: 'BACKUP_SCHEDULE_SET', schedule: { enabled: !!enabled, every, at, keep: n } } };
}

/**
 * BACKUP_PREVIEW and BACKUP_RESTORE (with `mode`). `source` is `{file}` (uploaded text) or
 * `{name}` (a kept backup). `skipCredentials` wins over a typed password, which is then not sent.
 */
export function restoreMessage(type, { source, mode, password, skipCredentials, sections }) {
  let src = null;
  if (source && typeof source.file === 'string') src = { file: source.file };
  else if (source && typeof source.name === 'string') src = { name: source.name };
  if (!src) return { problem: 'Choose a backup first' };
  const msg = { type, ...src };
  if (type === 'BACKUP_RESTORE') {
    if (mode !== 'merge' && mode !== 'replace') return { problem: 'Choose Merge or Replace everything' };
    msg.mode = mode;
  }
  if (sections && sections.length) msg.sections = sections;
  if (skipCredentials) msg.skipCredentials = true;
  else if (password) msg.password = password;
  return { message: msg };
}

/** An item in a preview list is a string or an object with a name; never drawn raw. */
export function itemName(it) {
  if (it == null) return '';
  if (typeof it === 'string' || typeof it === 'number') return String(it);
  return String(it.name ?? it.id ?? it.label ?? '');
}

function nameItems(items, max) {
  const list = items || [];
  const names = list.slice(0, max).map(itemName);
  const more = list.length - names.length;
  return names.join(', ') + (more > 0 ? `, and ${more} more` : '');
}

/**
 * The confirm dialog before a restore. Replace names what it removes (the preview's `onlyHere`,
 * section by section) and what it keeps regardless; Merge says what is added and changed.
 */
export function confirmText(mode, preview, { max = 3 } = {}) {
  const { rows } = previewRows(preview);
  const lines = [];
  if (mode === 'replace') {
    const gone = rows.filter((r) => r.onlyHere);
    if (!gone.length) lines.push('Nothing is only here now: nothing will be removed.');
    for (const r of gone) lines.push(`${r.label}: ${r.onlyHere} removed (${nameItems(r.items.onlyHere, max)})`);
    for (const r of rows.filter((x) => x.keptAnyway)) lines.push(`${r.label}: ${r.keptAnyway} kept anyway (${nameItems(r.items.keptAnyway, max)})`);
  } else {
    const add = rows.reduce((n, r) => n + r.add, 0);
    const change = rows.reduce((n, r) => n + r.change, 0);
    lines.push(`${add} added and ${change} changed; what is only here now stays.`);
  }
  return {
    title: mode === 'replace' ? 'Replace everything?' : 'Merge this backup?',
    yes: mode === 'replace' ? 'replace everything' : 'merge',
    danger: mode === 'replace',
    removes: mode === 'replace' ? onlyHereTotal(preview) : 0,
    lines,
  };
}

const CODES = {
  weak_password: 'EP-308', bad_password: 'EP-309', password_needed: 'EP-310', server_key: 'EP-311',
  no_server_key: 'EP-311', not_a_backup: 'EP-312', newer_format: 'EP-313', corrupt: 'EP-314', tampered: 'EP-314', too_large: 'EP-315',
};

/** A refusal in plain words by the core's `kind`, with its code (docs/ERROR-CODES.md EP-308..315). */
export function refusalWords(res) {
  const words = {
    weak_password: `The backup password needs at least ${MIN_PASSWORD} characters. Leave it empty to make a backup without credentials.`,
    bad_password: 'That is not the password this file was sealed with. Nothing was restored.',
    password_needed: 'This file’s credentials are sealed with a backup password. Type it, or tick “Skip credentials” to restore the settings alone.',
    server_key: 'The credentials were sealed by another server. The settings can be restored here; the credentials cannot.',
    no_server_key: 'This server has no key to seal a kept copy with, so nothing was written or restored.',
    not_a_backup: 'This is not an ElasticPro backup (.epbak).',
    newer_format: 'This backup was made by a newer ElasticPro. Upgrade this server first; a restore never guesses.',
    corrupt: 'The file is damaged or was edited: its checksum does not match. Nothing was restored.',
    tampered: 'The credentials in this file belong to another backup. Nothing was restored.',
    too_large: 'The file is over 16 MB, which no backup is.',
    forbidden: 'Only an administrator who is not limited to some clusters can take or restore a backup.',
    unsupported: 'This server keeps no backups; download one instead.',
    not_found: 'That backup is not on the server any more.',
  };
  const kind = res && res.kind;
  const text = words[kind] || (res && res.message) || 'The server did not accept that.';
  return CODES[kind] ? `${text} (${CODES[kind]})` : text;
}

/** Whether a refusal is the file needing (or not accepting) a password: the dialog then asks for one. */
export const needsPassword = (res) => !!res && (res.kind === 'password_needed' || res.kind === 'bad_password');

/** A section the file has that this server does not know, in words (empty when none). */
export function unknownSectionsLine(backup) {
  const u = (backup && backup.unknownSections) || [];
  if (!u.length) return '';
  return `This server does not know ${u.length === 1 ? 'a section' : 'sections'} in the file (${u.join(', ')}); ${u.length === 1 ? 'it is' : 'they are'} left alone.`;
}

/** One line of a restore's `applied[]`: "Clusters and their settings: 2 added, 1 changed". */
export function appliedLine(a) {
  const parts = [];
  if (a.added) parts.push(`${a.added} added`);
  if (a.changed) parts.push(`${a.changed} changed`);
  if (a.removed) parts.push(`${a.removed} removed`);
  return `${a.label || sectionLabel(a.id)}: ${parts.join(', ') || 'no change'}`;
}

/** "Find a setting" rows for this tab; the page adds them only when the core says it does backups. */
export const BACKUP_INDEX = Object.freeze([
  ['system', 'backup', 'Backup & restore', '', 'backup restore epbak export move server'],
  ['system', 'backup', 'Download backup now', 'bk-download', 'backup file epbak'],
  ['system', 'backup', 'What a backup holds', '', 'backup sections tick include'],
  ['system', 'backup', 'Include credentials in a backup', 'bk-creds', 'backup encrypted password secrets'],
  ['system', 'backup', 'Backup password', 'bk-pw', 'backup encrypt twelve characters'],
  ['system', 'backup', 'Scheduled backups', 'bk-sch-enabled', 'backup timer automatic daily weekly'],
  ['system', 'backup', 'Backup every day or week', 'bk-sch-every', 'schedule backup'],
  ['system', 'backup', 'Backup time (server time)', 'bk-sch-at', 'schedule backup 02:00'],
  ['system', 'backup', 'Keep the last backups', 'bk-sch-keep', 'schedule backup rotate retention'],
  ['system', 'backup', 'Restore from a file', '', 'backup restore upload merge replace preview'],
  ['system', 'backup', 'Backups kept on the server', '', 'backup download delete restore before a restore'],
]);
