/**
 * Config-Management › System › Backup & restore (the approved board "Backup and restore";
 * messages: docs/HANDBOOK.md "Backup and restore — the message contract").
 *
 * Four cards: What a backup holds (tick list, credentials switch + backup password), Scheduled
 * backups (a tracked form: it saves through the page's one save bar), Restore (a preview first,
 * then Merge or Replace behind a confirm) and Backups kept on the server. The page header carries
 * "Restore from a file…" and "Download backup now".
 *
 * Pure parts: core/backup-rules.js and core/backup-flow.js. Secrets: a backup password lives only
 * in its input and in the one message that needs it; the inputs are kept nodes (so a redraw does
 * not lose what was typed) and are emptied the moment the message has gone. Nothing is stored,
 * logged or shown again. Strings that came from a file or from the server (file names, takenBy,
 * notes, item names) are drawn as text nodes only.
 */

import { h } from '../lib/dom.js';
import { dt, download } from '../lib/fmt.js';
import { bridge } from '../core/transport.js';
import { isUnknownType } from '../core/volume-config.js';
import { card, pill, table } from '../pages/common.js';
import { confirmDialog } from './modal.js';
import { toast } from './menu.js';
import {
  SECTIONS, MIN_PASSWORD, kindLabel, holdsLabel, previewRows, modeCaption, credentialsCaption, scheduleLine, bytesLabel,
} from '../core/backup-rules.js';
import {
  DEFAULT_TICKED, createMessage, scheduleMessage, restoreMessage, confirmText, refusalWords, appliedLine,
  itemName, needsPassword, unknownSectionsLine,
} from '../core/backup-flow.js';

/** The core refuses a file over this before reading it (backup::MAX_FILE_BYTES). */
const MAX_FILE = 16 * 1024 * 1024;

const S = {
  status: null,                // last BACKUP_STATUS (or a reply shaped like it)
  ticked: new Set(DEFAULT_TICKED),
  withCreds: true,
  problem: '',                 // why Download cannot go, in words, under the form
  made: null,                  // {name, bytes, credentials, leftOut, notes} of the last download
  rs: null,                    // the restore in view: {source, label, preview, error, mode, working, result}
  busy: false,
  draft: null,                 // the schedule form as typed and not yet saved, so a repaint elsewhere does not undo it
  counts: {},                  // section id → short count text the page knows ({clusters: '32 clusters'})
  redraw: () => {},
};

/* The password boxes are kept nodes: a redraw re-attaches them, so what was typed survives. */
const pwNode = (id, placeholder) => h('input', {
  id, type: 'password', placeholder, spellcheck: false, autocomplete: 'new-password',
  'data-untracked': '', 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-form-type': 'other',
});
const pw = { create: pwNode('bk-pw', `at least ${MIN_PASSWORD} characters`), repeat: pwNode('bk-pw2', ''), restore: pwNode('bk-rs-pw', 'the file holds encrypted credentials') };
const wipe = (...inputs) => inputs.forEach((i) => { i.value = ''; });

/** Leaving the tab (or the page): every typed password is emptied and the restore in view is closed. */
export function leaveBackup() {
  wipe(pw.create, pw.repeat, pw.restore);
  S.rs = null;
}

const working = () => S.busy || !!(S.rs && S.rs.working);

/** Ask the core; never throws. */
async function call(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { return { ok: false, message: (e && e.message) || String(e) }; }
  if (isUnknownType(res)) return { ok: false, kind: 'unsupported', message: 'This server does not do backups' };
  return res || { ok: false, message: 'the server did not answer' };
}

const isStatus = (r) => r && r.ok !== false && Array.isArray(r.kept) && r.schedule;

/** Whether the tab has anything to show: only after a PING that said so (the page checks that). */
export function backupLoaded() { return !!S.status; }

/** The tab's load: ask for the status and repaint. `fresh` starts the page's save bar over. */
export async function loadBackup(redraw, fresh, counts) {
  S.redraw = redraw || S.redraw;
  S.counts = counts || S.counts;
  const res = await call({ type: 'BACKUP_STATUS' });
  S.draft = null;
  if (isStatus(res)) {
    S.status = res;
    const known = new Set((res.sections || []).map((s) => s.id));
    if (known.size) S.ticked = new Set([...S.ticked].filter((id) => known.has(id)));
  } else {
    S.status = null;
    toast(refusalWords(res), 'warn', 6000);
  }
  if (fresh) fresh();
  S.redraw();
}

export function setBackupCounts(counts) { S.counts = counts || {}; }

const keeps = () => !!(S.status && S.status.keeps);
const minPassword = () => (S.status && S.status.minPassword) || MIN_PASSWORD;

/* --------------------------------- header actions --------------------------------- */

export function backupHeaderActions() {
  return [
    h('label.btn', { style: { position: 'relative', overflow: 'hidden', cursor: 'pointer' }, title: 'Choose a .epbak file on this computer' },
      'Restore from a file…',
      h('input', {
        type: 'file', accept: '.epbak,.json,application/json', 'aria-label': 'Restore from a file', disabled: working(),
        style: { position: 'absolute', inset: '0', opacity: '0', cursor: 'pointer' },
        onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) openFile(f); },
      })),
    h('button.btn.primary', { type: 'button', id: 'bk-download', disabled: S.busy, onclick: downloadNow }, 'Download backup now'),
  ];
}

/* ------------------------------------- the page ------------------------------------- */

export function backupBody() {
  if (!S.status) return card('Backup & restore', '', h('div.muted', 'Asking the server…'));
  return h('div.cm-stack', { id: 'bk-root' },
    h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', alignItems: 'start' } },
      holdsCard(),
      h('div.cm-stack', scheduleCard(), restoreCard())),
    keptCard());
}

/* ---- 1. What a backup holds ---- */

function holdsCard() {
  const secs = (S.status.sections && S.status.sections.length ? S.status.sections : SECTIONS);
  const credsOn = S.withCreds;
  return card('What a backup holds', 'tick what to include', h('div', { style: { margin: '-2px -2px' } },
    ...secs.map((s) => h('label.bk-item', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '5px 0', cursor: 'pointer', borderBottom: '1px solid var(--border)' } },
      h('input', {
        type: 'checkbox', 'data-untracked': '', dataset: { section: s.id }, checked: S.ticked.has(s.id),
        onchange: (e) => { if (e.target.checked) S.ticked.add(s.id); else S.ticked.delete(s.id); S.problem = ''; },
      }),
      h('span', s.label),
      S.counts[s.id] ? h('span.muted', { style: { marginLeft: 'auto', fontSize: '11.5px' } }, S.counts[s.id]) : null)),
    h('div', { style: { display: 'grid', gap: '8px', padding: '10px 0 2px' } },
      h('label', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' } },
        h('input.sw', {
          type: 'checkbox', id: 'bk-creds', 'data-untracked': '', checked: credsOn, 'aria-label': 'Include credentials, encrypted with a backup password',
          onchange: (e) => { S.withCreds = e.target.checked; S.problem = ''; if (!S.withCreds) wipe(pw.create, pw.repeat); S.redraw(); },
        }),
        h('span', h('b', { style: { fontWeight: 600 } }, 'Include credentials, encrypted with a backup password'),
          h('div.muted', { style: { fontSize: '12px' } },
            'Cluster passwords and API keys, the SMTP password, jump-host keys. Off: a restore asks for them again.'))),
      credsOn ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px', paddingLeft: '44px' } },
        h('label.field', 'Backup password', pw.create),
        h('label.field', 'Repeat', pw.repeat)) : null,
      h('div.muted', { style: { fontSize: '11.5px', paddingLeft: credsOn ? '44px' : 0 } },
        'Never in a backup: the Zabbix API token (pair again after a restore), TV display links (issue new ones), accounts and sessions. ',
        'The password is used once and is not stored; lose it and the credentials in that file are gone.'),
      S.problem ? h('div.banner.err', { id: 'bk-problem', role: 'alert', style: { margin: 0 } }, S.problem) : null,
      S.made ? madeNote(S.made) : null)));
}

function madeNote(m) {
  const lines = [];
  lines.push(`Downloaded ${m.name} · ${bytesLabel(m.bytes)} · ${m.credentials === 'password' ? 'credentials encrypted with your password' : 'no credentials in it'}`);
  if (m.leftOut) lines.push(`${m.leftOut} credential${m.leftOut === 1 ? '' : 's'} left out (no password was typed).`);
  if (m.kept) lines.push('A copy is kept on this server too.');
  return h('div.banner.ok', { id: 'bk-made', style: { margin: 0 } }, h('div', ...lines.flatMap((l, i) => [i ? h('br') : null, l])),
    ...(m.notes || []).map((n) => h('div', { style: { marginTop: '4px' } }, `Note: ${String(n)}`)));
}

async function downloadNow() {
  if (S.busy) return;
  const built = createMessage({
    ticked: [...S.ticked], withCredentials: S.withCreds, password: pw.create.value, repeat: pw.repeat.value, keep: keeps(),
  }, minPassword());
  if (built.problem) { S.problem = built.problem; S.made = null; S.redraw(); return; }
  S.problem = ''; S.busy = true; S.redraw();
  const res = await call(built.message);
  // The password has gone in the message; it is not needed again, whatever the answer.
  built.message.password = undefined;
  wipe(pw.create, pw.repeat);
  S.busy = false;
  if (!res.ok || typeof res.file !== 'string') {
    S.problem = refusalWords(res); S.made = null; S.redraw(); return;
  }
  download(res.name, res.file, 'application/json');
  S.made = { name: res.name, bytes: res.bytes, credentials: res.credentials, leftOut: res.leftOut || 0, kept: !!res.kept, notes: res.notes || [] };
  toast(`Backup ${res.name} downloaded`, 'ok');
  if (res.kept) await refreshStatus(); else S.redraw();
}

async function refreshStatus() {
  const res = await call({ type: 'BACKUP_STATUS' });
  if (isStatus(res)) S.status = res;
  S.redraw();
}

/* ---- 2. Scheduled backups (tracked: saved by the page's one save bar) ---- */

function scheduleCard() {
  return buildScheduleCard();
}

/** Throw away unsaved schedule edits (the save bar's Discard). */
export function discardBackupSchedule() { S.draft = null; }

function buildScheduleCard() {
  const sc = S.status.schedule;
  const max = sc.keepMax || 90;
  if (!keeps()) {
    return card('Scheduled backups', 'not on this edition',
      h('div.muted', 'This server keeps no backups of its own, so there is nothing to schedule here: use Download backup now.'));
  }
  const d = S.draft || {};
  const keepDraft = () => {
    const g = (id) => document.getElementById(id);
    if (g('bk-sch-every')) S.draft = { enabled: g('bk-sch-enabled').checked, every: g('bk-sch-every').value, at: g('bk-sch-at').value, keep: g('bk-sch-keep').value };
  };
  const on = h('input.sw', { type: 'checkbox', id: 'bk-sch-enabled', checked: d.enabled ?? !!sc.enabled, 'aria-label': 'Back up on a schedule', 'data-label': 'Scheduled backups', onchange: keepDraft });
  const every = h('select', { id: 'bk-sch-every', 'data-label': 'Every', onchange: keepDraft }, h('option', { value: 'day' }, 'Day'), h('option', { value: 'week' }, 'Week'));
  every.value = d.every ?? (sc.every === 'week' ? 'week' : 'day');
  const at = h('input', { id: 'bk-sch-at', type: 'time', value: d.at ?? (sc.at || '02:00'), 'data-label': 'At (server time)', oninput: keepDraft });
  const keep = h('input', { id: 'bk-sch-keep', type: 'number', min: 1, max, step: 1, value: d.keep ?? sc.keep ?? 14, 'data-label': 'Keep the last', oninput: keepDraft });
  return h('section.card', { dataset: { track: 'backup-schedule', trackLabel: 'Scheduled backups' } },
    h('header', h('h2', 'Scheduled backups'),
      h('label', { style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', cursor: 'pointer' } }, on, 'On')),
    h('div.body',
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' } },
        h('label.field', 'Every', every),
        h('label.field', 'At (server time)', at),
        h('label.field', 'Keep the last', keep)),
      h('div.muted', { id: 'bk-sch-line', style: { fontSize: '12px', marginTop: '8px' } },
        'Kept in the server’s data directory, ', h('span.mono', 'backups/'), '. ',
        sc.last ? h('span', pill(sc.last.ok ? 'ok' : 'failed', sc.last.ok ? 'green' : 'red'), ' ') : null,
        scheduleLine(sc))));
}

/** The schedule's save (the page's save bar calls this): true when the core took it. */
export async function saveBackupSchedule() {
  const g = (id) => document.getElementById(id);
  if (!g('bk-sch-every')) return true;
  const built = scheduleMessage({
    enabled: g('bk-sch-enabled').checked, every: g('bk-sch-every').value, at: g('bk-sch-at').value, keep: g('bk-sch-keep').value,
  }, (S.status.schedule && S.status.schedule.keepMax) || 90);
  if (built.problem) { toast(built.problem, 'warn', 6000); return false; }
  const res = await call(built.message);
  if (!isStatus(res)) { toast(refusalWords(res), 'warn', 6000); return false; }
  S.status = res;
  S.draft = null;
  toast('Backup schedule saved', 'ok');
  return true;
}

/* ---- 3. Restore ---- */

async function openFile(file) {
  if (working()) return;
  if (file.size > MAX_FILE) { S.rs = { source: null, label: file.name, error: refusalWords({ kind: 'too_large' }), mode: 'merge' }; S.redraw(); return; }
  let text;
  try { text = await file.text(); } catch (e) { S.rs = { source: null, label: file.name, error: `Could not read ${file.name}: ${(e && e.message) || e}`, mode: 'merge' }; S.redraw(); return; }
  await startRestore({ file: text }, file.name);
}

async function startRestore(source, label) {
  if (working()) return;
  wipe(pw.restore);
  S.rs = { source, label, preview: null, error: '', mode: 'merge', skip: false, working: true, result: null };
  S.redraw();
  await runPreview();
  scrollToRestore();
}

function scrollToRestore() {
  const el = document.getElementById('bk-restore');
  try { if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); } catch (_) { /* jsdom */ }
}

/** Preview with what is typed now. Writes nothing. A wrong or missing password keeps the card open to try again. */
async function runPreview() {
  const rs = S.rs;
  if (!rs || !rs.source) return;
  const built = restoreMessage('BACKUP_PREVIEW', { source: rs.source, password: pw.restore.value, skipCredentials: rs.skip });
  rs.working = true; rs.error = ''; S.redraw();
  const res = await call(built.message);
  rs.working = false;
  if (!res.ok) {
    wipe(pw.restore);
    rs.preview = null; rs.error = refusalWords(res); rs.needPw = needsPassword(res);
  } else {
    // Kept for the restore itself when the file is sealed by a password; wiped at once otherwise.
    const sealed = res.backup && res.backup.credentials && res.backup.credentials.scheme === 'password';
    if (!sealed || rs.skip) wipe(pw.restore);
    rs.preview = res; rs.needPw = false;
  }
  S.redraw();
}

function restoreCard() {
  const rs = S.rs;
  if (!rs) {
    return card('Restore', 'load a file or pick a kept backup',
      h('div.muted', { style: { fontSize: '12.5px' } },
        'Choose Restore from a file…, or Restore… on a backup kept below. You see what would change before anything is touched, and the current state is saved first as a backup, so a restore can be undone.'));
  }
  const p = rs.preview;
  const body = [];
  if (rs.working) body.push(h('div.muted', 'Checking the file…'));
  if (rs.error) body.push(h('div.banner.err', { id: 'bk-rs-error', role: 'alert', style: { margin: 0 } }, rs.error));
  if (p) body.push(...previewBody(rs, p));
  // A password-sealed file needs its password twice: to check it here and again in the restore itself
  // (nothing is kept between the two), so the box stays until the restore is done or the card is closed.
  const sealedByPassword = !!(p && p.backup && p.backup.credentials && p.backup.credentials.scheme === 'password');
  if (!rs.result && !rs.skip && (rs.needPw || sealedByPassword || (p && p.credentials && p.credentials.kind === 'password_needed'))) {
    body.push(h('label.field', 'Backup password', pw.restore),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
        h('button.btn.sm', { type: 'button', id: 'bk-rs-check', onclick: () => runPreview() }, 'Check with this password'),
        skipBox(rs)));
  } else if (!rs.result && p && p.backup && p.backup.credentials) {
    body.push(skipBox(rs));
  }
  if (rs.result) body.push(...resultBody(rs.result));
  body.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
    p && !rs.result ? h('button.btn.danger', { type: 'button', id: 'bk-restore-go', disabled: S.busy || rs.working, onclick: () => confirmRestore() }, 'Restore…') : null,
    h('button.btn.ghost.sm', { type: 'button', id: 'bk-rs-close', disabled: working(), onclick: () => { if (working()) return; wipe(pw.restore); S.rs = null; S.redraw(); } }, rs.result ? 'Done' : 'Cancel'),
    p && !rs.result ? h('span.muted', { style: { fontSize: '11.5px' } }, 'The current state is saved as a backup first, so a restore can be undone.') : null));
  return h('section.card', { id: 'bk-restore' },
    h('header', h('h2', 'Restore'), h('span.sub', rs.label ? `${rs.label}${p ? ' · checked' : ''}` : '')),
    h('div.body', { style: { display: 'grid', gap: '10px' } }, ...body));
}

function skipBox(rs) {
  return h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12.5px', cursor: 'pointer' } },
    h('input', {
      type: 'checkbox', id: 'bk-rs-skip', 'data-untracked': '', checked: !!rs.skip,
      onchange: (e) => { rs.skip = e.target.checked; wipe(pw.restore); runPreview(); },
    }), 'Skip credentials (restore the settings alone)');
}

function previewBody(rs, p) {
  const out = [];
  const b = p.backup || {};
  const says = b.says || { takenBy: b.takenBy, takenAt: b.takenAt, coreVersion: b.coreVersion };
  out.push(h('div.muted', { id: 'bk-says', style: { fontSize: '12px' } },
    'The file says: ',
    says.takenBy ? `taken by ${says.takenBy}` : 'taken by nobody it names',
    says.takenAt ? ` on ${dt(says.takenAt)}` : '',
    says.coreVersion ? ` · ElasticPro ${says.coreVersion}` : '',
    b.kindLabel || b.kind ? ` · ${b.kindLabel || kindLabel(b.kind)}` : '',
    ' (unverified: anyone can write these words into a file)'));
  const unknown = unknownSectionsLine(b);
  if (unknown) out.push(h('div.muted', { style: { fontSize: '12px' } }, unknown));
  const cap = credentialsCaption(p.credentials);
  if (cap) out.push(h('div.muted', { id: 'bk-rs-creds', style: { fontSize: '12px' } }, cap));
  const { rows, missing } = previewRows(p.preview);
  out.push(table(
    [{ label: 'What changes' }, { label: 'Add', num: true }, { label: 'Change', num: true }, { label: 'Only here now', num: true }],
    rows.map((r) => h('tr', { dataset: { section: r.id } },
      h('td', r.label),
      h('td.num', { title: listTitle(r.items.add) }, String(r.add)),
      h('td.num', { title: listTitle(r.items.change) }, String(r.change)),
      h('td.num', { title: listTitle(r.items.onlyHere) }, String(r.onlyHere),
        r.keptAnyway ? h('span.muted', { title: listTitle(r.items.keptAnyway), style: { marginLeft: '6px' } }, `+${r.keptAnyway} kept anyway`) : null))),
    { emptyText: 'The file holds none of the things a restore reads' }));
  if (missing.length) {
    out.push(h('div.muted', { style: { fontSize: '11.5px' } }, `Not in the file, so left as they are: ${missing.map((id) => SECTIONS.find((s) => s.id === id)?.label || id).join('; ')}.`));
  }
  if (!rs.result) {
    out.push(h('div', { role: 'radiogroup', 'aria-label': 'How to restore', style: { display: 'grid', gap: '4px' } },
      radio(rs, 'merge', modeCaption('merge', p.preview)),
      radio(rs, 'replace', modeCaption('replace', p.preview))));
  }
  return out;
}

const listTitle = (items) => (items && items.length ? items.slice(0, 40).map(itemName).join('\n') : null);

function radio(rs, mode, caption) {
  const [head, ...rest] = caption.split(' · ');
  return h('label', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', cursor: 'pointer', fontSize: '12.5px' } },
    h('input', { type: 'radio', name: 'bk-mode', value: mode, 'data-untracked': '', checked: rs.mode === mode, onchange: () => { rs.mode = mode; } }),
    h('span', h('b', { style: { fontWeight: 600 } }, head), rest.length ? h('span.muted', ` · ${rest.join(' · ')}`) : null));
}

async function confirmRestore() {
  const rs = S.rs;
  if (!rs || !rs.preview || S.busy || rs.confirming) return;
  const mode = rs.mode;
  const t = confirmText(mode, rs.preview.preview);
  rs.confirming = true;
  let ok = false;
  try {
  ok = await confirmDialog(t.title,
    h('div', { style: { display: 'grid', gap: '6px', fontSize: '13px' } },
      h('div', mode === 'replace'
        ? `Each section in the file becomes the file’s. ${t.removes} item${t.removes === 1 ? '' : 's'} that exist only here now will be removed:`
        : 'Everything in the file is added or updated here; what exists only here now stays:'),
      ...t.lines.map((l) => h('div', { style: { paddingLeft: '10px' } }, `• ${l}`)),
      h('div', rs.skip ? 'Credentials: skipped on purpose; the clusters will ask for them again.' : (credentialsCaption(rs.preview.credentials) || 'Credentials: none in this file.')),
      h('div.muted', { style: { fontSize: '12px' } }, 'The current state is saved first as a “before a restore” backup, so this can be undone by restoring that.')),
    { yes: t.yes, no: 'Cancel', danger: t.danger });
  } finally { rs.confirming = false; }
  if (!ok) return;
  await doRestore(rs);
}

async function doRestore(rs) {
  if (!rs || rs !== S.rs || rs.result || S.busy) return;
  const built = restoreMessage('BACKUP_RESTORE', { source: rs.source, mode: rs.mode, password: pw.restore.value, skipCredentials: rs.skip });
  if (built.problem) { rs.error = built.problem; S.redraw(); return; }
  S.busy = true; rs.working = true; rs.error = ''; S.redraw();
  const res = await call(built.message);
  built.message.password = undefined;
  wipe(pw.restore);
  S.busy = false; rs.working = false;
  if (!res.ok) {
    rs.error = refusalWords(res) + (res.beforeRestore ? ` The current state was kept first as ${res.beforeRestore}.` : '');
    rs.needPw = needsPassword(res);
  } else {
    rs.result = res;
    toast(`Restored from ${rs.label || 'the backup'}`, 'ok');
    await refreshStatus();
    return;
  }
  S.redraw();
}

function resultBody(r) {
  const applied = r.applied || [];
  return [h('div.banner.ok', { id: 'bk-rs-result', style: { margin: 0, display: 'grid', gap: '3px' } },
    h('div', h('b', `Restored (${r.mode === 'replace' ? 'replace everything' : 'merge'}).`)),
    ...applied.map((a) => h('div', appliedLine(a))),
    ...applied.flatMap((a) => (a.notes || []).map((n) => h('div.muted', `${a.label || a.id}: ${String(n)}`))),
    r.beforeRestore ? h('div', `The state before the restore was kept as ${r.beforeRestore}: restore that to undo this.`) : null,
    r.credentials ? h('div.muted', credentialsResult(r.credentials)) : null)];
}

function credentialsResult(c) {
  if (typeof c === 'string') return `Credentials: ${c}`;
  if (c && typeof c === 'object') {
    const bits = Object.entries(c).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => `${k} ${v}`);
    return bits.length ? `Credentials: ${bits.join(', ')}` : '';
  }
  return '';
}

/* ---- 4. Backups kept on the server ---- */

function keptCard() {
  const st = S.status;
  if (!keeps()) return null;
  const kept = st.kept || [];
  const keepN = st.schedule && st.schedule.keep;
  return card('Backups kept on the server', `${kept.length}${keepN ? ` · oldest goes first beyond ${keepN}` : ''}`,
    table(
      [{ label: 'Taken' }, { label: 'By' }, { label: 'Kind' }, { label: 'Holds' }, { label: 'Size', num: true }, { label: h('span.sr-only', 'Actions'), width: '230px' }],
      kept.map(keptRow),
      { emptyText: 'No backup is kept yet' }));
}

function keptRow(k) {
  const tone = { scheduled: 'grey', manual: 'blue', 'before-restore': 'yellow' }[k.kind] || 'grey';
  return h('tr', { dataset: { backup: k.name } },
    h('td', k.takenAt ? dt(k.takenAt) : '–'),
    h('td.muted', k.takenBy || '–'),
    h('td', k.readable === false ? pill('unreadable', 'red') : pill(k.kindLabel || kindLabel(k.kind), tone)),
    k.readable === false
      ? h('td.muted', { title: k.problem || '' }, k.problem || 'This file cannot be read')
      : h('td', holdsLabel(k.sections, k.credentials)),
    h('td.num.mono', bytesLabel(k.bytes)),
    h('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
      h('button.btn.sm', { type: 'button', dataset: { act: 'download' }, onclick: () => downloadKept(k.name) }, 'Download'), ' ',
      h('button.btn.sm.danger', { type: 'button', dataset: { act: 'restore' }, disabled: k.readable === false || working(), onclick: () => startRestore({ name: k.name }, k.name) }, 'Restore…'), ' ',
      h('button.btn.sm.danger', { type: 'button', dataset: { act: 'delete' }, onclick: () => deleteKept(k.name) }, 'Delete')));
}

async function downloadKept(name) {
  const res = await call({ type: 'BACKUP_DOWNLOAD', name });
  if (!res.ok || typeof res.file !== 'string') { toast(refusalWords(res), 'warn', 6000); return; }
  download(res.name || name, res.file, 'application/json');
}

async function deleteKept(name) {
  const ok = await confirmDialog(`Delete ${name}?`,
    h('div', { style: { fontSize: '13px' } }, 'It is removed from the server and cannot be brought back. Download it first if you may want it.'),
    { yes: 'delete', no: 'Keep it', danger: true });
  if (!ok) return;
  const res = await call({ type: 'BACKUP_DELETE', name });
  if (!isStatus(res)) { toast(refusalWords(res), 'warn', 6000); return; }
  S.status = res;
  if (S.rs && S.rs.source && S.rs.source.name === name) leaveBackup();
  toast(`${name} deleted`, 'ok');
  S.redraw();
}
