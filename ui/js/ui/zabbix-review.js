/**
 * Config-Management › Zabbix: the hosts a sync held for review, the review dialog, and
 * "Preview sync".
 *
 * A Zabbix host at the address of a cluster that exists already is held by the core
 * (zbx_conflicts.rs): nothing about that cluster changes until an administrator decides —
 * Skip, Update or Keep both — in the dialog here. Nothing is sent until Confirm, and what is
 * sent names the values the dialog showed (`fingerprint`), so a decision is never applied to
 * values the administrator did not see. The preview asks the core what a sync would do now
 * and applies nothing.
 */

import { h } from '../lib/dom.js';
import { dt } from '../lib/fmt.js';
import { bridge } from '../core/transport.js';
import { table, pill } from '../pages/common.js';
import { modal } from './modal.js';
import { toast } from './menu.js';
import * as R from '../core/zabbix-review.js';

const tone = (e) => (e.state !== 'decided' ? 'orange' : e.decision === 'skip' ? 'grey' : 'green');

/**
 * The card: every conflict the last sync resolved, waiting ones first. `null` when there is
 * none, so a Zabbix tab without conflicts looks as it always did. `onDecided` runs after a
 * decision was kept (the caller re-reads the cluster list).
 */
export function zabbixReviewCard(zbx, { onDecided } = {}) {
  const list = (zbx && Array.isArray(zbx.held)) ? zbx.held : [];
  if (!list.length) return null;
  const waiting = R.needsReview(list);
  const rows = list.map((e) => h('tr', { dataset: { held: e.hostId } },
    h('td', h('b', (e.zabbix && e.zabbix.name) || e.host), h('span.muted', ` · host ${e.host}`)),
    h('td.mono', e.identity),
    h('td', R.existingLabel(e)),
    h('td', pill(R.stateLabel(e), tone(e)),
      e.decidedBy && e.state !== 'pending' ? h('span.muted', { style: { marginLeft: '6px', fontSize: '11px' } }, `${e.decidedBy}${e.decidedAt ? ` · ${dt(e.decidedAt * 1000)}` : ''}`) : null),
    h('td', h('button.btn.sm', { type: 'button', onclick: () => reviewConflict(e, { onDecided }) }, e.state === 'decided' ? 'Change…' : 'Review…'))));
  return h('section.card.cm-card', { id: 'zbx-review' },
    h('header', h('h2', 'Held for review'),
      h('span.sub', `${waiting} waiting · ${list.length - waiting} decided · a Zabbix host at the address of a cluster that exists already changes nothing until an administrator decides`)),
    table(['Zabbix host', 'Address', 'Existing cluster', 'Decision', ''], rows));
}

/**
 * The review dialog: the existing cluster and the Zabbix host side by side, the three
 * answers, and Confirm. Resolves with the core's answer, or null when nothing was decided.
 */
export function reviewConflict(entry, { onDecided } = {}) {
  let choice = entry.state === 'pending' ? '' : (entry.decision || '');
  const lines = R.sideBySide(entry);
  const moved = entry.state === 'changed' ? R.changedSinceDecided(entry) : [];
  const confirm = h('button.btn.primary', { type: 'button', disabled: !choice }, 'Confirm');
  const choiceRow = (d) => h('label', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', cursor: 'pointer', fontSize: '12.5px' } },
    h('input', { type: 'radio', name: 'zr-decision', value: d.id, 'data-untracked': '', checked: choice === d.id,
      onchange: () => { choice = d.id; confirm.disabled = false; } }),
    h('span', h('b', { style: { fontWeight: 600 } }, d.label), h('span.muted', ` · ${d.id === 'update' ? R.updateMeans(entry) : d.help}`)));
  const body = [
    h('div.muted', { style: { fontSize: '12px' } },
      `Zabbix host ${entry.host} is at ${entry.identity}, the address of the ${R.existingLabel(entry)}. `
      + 'Nothing about that cluster has changed, and nothing will until you confirm.'),
    entry.state === 'changed'
      ? h('div.banner.warn', { style: { margin: 0 } },
        `Decided ${R.decisionLabel(entry.decision)} by ${entry.decidedBy || 'someone'}${entry.decidedAt ? ` on ${dt(entry.decidedAt * 1000)}` : ''}; `
        + `Zabbix changed since (${moved.join(', ') || 'its values'}). That decision still applies until you confirm one.`)
      : null,
    table([{ label: 'Field', width: '96px' }, R.existingLabel(entry), `Zabbix host ${entry.host}`],
      lines.map((l) => h(l.differs ? 'tr.zr-differs' : 'tr', { dataset: { field: l.key } },
        h('td', l.label),
        h('td', { style: { overflowWrap: 'anywhere' } }, l.old),
        h('td', { style: { overflowWrap: 'anywhere', fontWeight: l.differs ? 600 : '' } }, l.new)))),
    h('div', { role: 'radiogroup', 'aria-label': 'Decision', style: { display: 'grid', gap: '4px' } }, ...R.DECISIONS.map(choiceRow)),
  ];
  return modal(`Review: ${(entry.zabbix && entry.zabbix.name) || entry.host}`, 'Zabbix sync · same address as a cluster that exists already', body, (ctx) => {
    confirm.onclick = () => ctx.run(confirm, async () => {
      if (!choice) return;
      const res = await bridge({ type: 'ZABBIX_CONFLICT_DECIDE', hostId: entry.hostId, decision: choice, fingerprint: entry.fingerprint });
      if (!res || !res.ok) { ctx.msg((res && res.message) || 'The decision was not kept.'); return; }
      toast(`${entry.host}: ${R.decisionLabel(choice)} — applied`, 'ok', 4000, { key: 'zabbix-review' });
      ctx.done(res);
      if (onDecided) await onDecided(res);
    });
    return [h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { type: 'button', onclick: () => ctx.done(null) }, 'Cancel'), confirm)];
  }, { width: '760px' });
}

/** Ask the core what a sync would do now; show it. Applies nothing. */
export async function previewSync() {
  let res;
  try { res = await bridge({ type: 'ZABBIX_SYNC_PREVIEW' }); } catch (e) { res = { ok: false, message: e.message }; }
  if (!res || !res.ok) {
    toast(`Preview failed: ${(res && res.message) || 'no answer'}`, 'err', 8000, { key: 'zabbix-preview' });
    return null;
  }
  return previewDialog(res);
}

/** The preview's answer as a dialog: what would be added, changed, removed and held. */
export function previewDialog(p) {
  const s = R.previewSummary(p);
  const section = (title, items, line) => (items && items.length
    ? h('details.cm-fold', { open: items.length <= 8 }, h('summary', h('b', title), h('span.muted', ` · ${items.length}`)),
      h('ul', ...items.map((x) => h('li', { style: { overflowWrap: 'anywhere' } }, line(x)))))
    : null);
  const body = [
    h('div.muted', { style: { fontSize: '12px' } },
      `${s.line}. A dry run: Zabbix was read, nothing was applied${p.lastSync ? `; compared with the sync of ${dt(p.lastSync * 1000)}` : ''}.`),
    h('div.cm-folds',
      section('Would be added', p.add, (x) => `${x.name} · ${x.url} · host ${x.host}`),
      section('Would change', p.change, (x) => `${x.name}: ${(x.fields || []).map((f) => `${f.field} ${R.show(f.from)} → ${R.show(f.to)}`).join('; ')}`),
      section('Would be removed (Zabbix no longer has them)', p.remove, (x) => `${x.name} · ${x.url}`),
      section('Held for review', p.hold, (x) => `${x.host} at ${x.identity} — ${R.existingLabel(x)} · ${R.stateLabel(x)}`),
      section('createHosts would make Zabbix hosts for', p.wouldCreate, (x) => `${x.name} · ${x.url}`),
      section('Hosts not counted as clusters', p.skipped, (x) => String(x))),
  ];
  return modal('Preview sync', 'What a Zabbix sync would do now · nothing is applied', body,
    (ctx) => [h('div', { style: { marginLeft: 'auto' } }, h('button.btn', { type: 'button', onclick: () => ctx.done(null) }, 'Close'))],
    { width: '720px' });
}
