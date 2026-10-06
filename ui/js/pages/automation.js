/** Page — automation: rules that watch continuously and propose work for a human to run. */

import { h, mount } from '../lib/dom.js';
import { bytes, num, ago } from '../lib/fmt.js';
import { state, clusters, activeClusters, fetchIndices } from '../core/state.js';
import { card, collapsible, pill, statTile, empty, table } from './common.js';
import { activeRules, runAutomation, resultsFor, allProposals, allBlocked, isRunning, lastRunAt, canArm } from '../core/automation.js';
import { deleteIndices, closeIndices } from '../ui/index-actions.js';
import { ruleBuilder } from '../ui/rule-builder.js';
import { putRule, removeRule, loadRules } from '../core/user-rules.js';
import { saveRaw } from '../ui/config-editor.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/menu.js';
import { navigateTo } from '../core/intent.js';

let host = null;
const ui = { showBlocked: true };

export function render(el) {
  host = el;
  el.classList.add('dense');
  draw();
  if (!lastRunAt()) check();          // first visit: evaluate without being asked
}
export function onData() { if (host && host.isConnected) draw(); }

/** Rules read the index list; only the Indices page fetches it otherwise. */
async function check() {
  for (const c of activeClusters()) {
    if (!state.indices.get(c.id)) {
      try { await fetchIndices(c.id, '*'); } catch (_) { /* the rule will say it has no list */ }
    }
  }
  draw();
  await runAutomation({ onProgress: draw });
  draw();
}

function draw() {
  if (!host || !host.isConnected) return;
  const list = activeClusters();
  if (!clusters().length) return mount(host, empty('No clusters configured.'));

  const proposals = allProposals();
  const blocked = allBlocked();
  const freed = proposals.reduce((s, p) => s + (p.freed || 0), 0);
  const arm = canArm();

  mount(host,
    h('div.grid.c4', { style: { marginBottom: '10px' } },
      statTile('Proposed', String(proposals.length),
        proposals.length ? 'waiting for you to run them' : 'nothing to do right now'),
      statTile('Held back', String(blocked.length),
        blocked.length ? 'not safe to propose — see why below' : 'nothing was refused'),
      statTile('Would free', freed ? bytes(freed) : '–', 'if every proposal is run'),
      statTile('Last checked', lastRunAt() ? ago(lastRunAt()) : 'never',
        `${list.length} cluster${list.length === 1 ? '' : 's'}`)),

    h('div.toolbar',
      h('button.btn.sm.primary', { disabled: isRunning(), onclick: check },
        isRunning() ? 'Loading…' : '↻ Run checks'),
      h('button.btn.sm', { onclick: () => edit(null) }, '+ New automation'),
      h('label.field', { style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } },
        h('input#auto-blocked', { type: 'checkbox', checked: ui.showBlocked,
          onchange: (e) => { ui.showBlocked = e.target.checked; draw(); } }),
        'show what was held back'),
      h('div', { style: { marginLeft: 'auto' } },
        h('span.muted', { style: { fontSize: '11px' } },
          'rules never write — every action runs through its normal confirmation'))),

    // The arming seam, visible rather than hidden. It is the honest answer to "why doesn't
    // this just do it", and it names what has to land first.
    h('div.banner', { style: { marginTop: '10px' } },
      h('div',
        h('div.ttl', arm.ok ? 'Arming available' : 'These rules propose. They never act on their own.'),
        h('div', arm.reason))),

    ...activeRules().map((rule) => ruleCard(rule, list)));
}

function ruleCard(rule, list) {
  const perCluster = list.map((c) => {
    const r = resultsFor(c.id);
    const item = r && r.results.find((x) => x.rule.id === rule.id);
    return { cluster: c, item };
  }).filter((x) => x.item);

  const active = perCluster.filter((x) => x.item.proposal && x.item.proposal.targets.length);
  const held = perCluster.filter((x) => x.item.proposal && (x.item.proposal.blocked || []).length);
  const notes = perCluster.filter((x) => x.item.skipped || x.item.error);

  const n = active.reduce((s, x) => s + x.item.proposal.targets.length, 0);
  const nHeld = held.reduce((s, x) => s + x.item.proposal.blocked.length, 0);
  // The counts belong in the header; the explanation belongs inside, where there is room
  // for it. Jamming a full sentence into the sub-line makes every header two lines tall.
  const sub = [n ? `${n} proposed` : 'nothing to do',
               nHeld ? `${nHeld} held back` : null].filter(Boolean).join(' · ');

  return h('div', { style: { marginTop: '10px' } },
    collapsible(rule.title, sub,
      () => h('div', { style: { display: 'grid', gap: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
          h('div.muted', { style: { fontSize: '11.5px', lineHeight: '1.55', flex: '1' } }, rule.why),
          rule.user
            ? h('div', { style: { display: 'flex', gap: '6px' } },
                h('button.btn.sm', { onclick: () => edit(rule.user) }, 'Edit'),
                h('button.btn.sm.ghost', { title: 'Remove this automation', onclick: () => destroy(rule.user) }, '×'))
            : h('span.muted', { style: { fontSize: '10.5px' } }, 'built in')),
        ...active.map((x) => proposalBlock(rule, x.cluster, x.item.proposal)),
        ui.showBlocked ? h('div', ...held.map((x) => blockedBlock(x.cluster, x.item.proposal))) : null,
        ...notes.map((x) => h('div.muted', { style: { fontSize: '11.5px' } },
          h('b', x.cluster.name), ' — ', x.item.error ? `rule failed: ${x.item.error}` : x.item.skipped)),
        !active.length && !held.length && !notes.length
          ? empty('Nothing for this rule on any cluster.') : null),
      { key: `auto-${rule.id}`, open: active.length > 0 }));
}

/**
 * Create or edit an automation, then write it to the config.
 *
 * The hosted stack mounts ./config read-only, so this save can genuinely fail there. The
 * error is surfaced rather than swallowed, because a rule the operator believes is saved
 * and is not is worse than one that never saved at all.
 */
async function edit(existing) {
  const rule = await ruleBuilder(existing);
  if (!rule) return;
  try {
    putRule(rule);
    await saveRaw({ silent: true });
  } catch (e) {
    if (existing) putRule(existing); else removeRule(rule.id);
    toast('Could not save the automation', 'err', 12000,
      { detail: [e.message || String(e), 'On the hosted deployment ./config is mounted read-only.'] });
    return;
  }
  await check();
}

async function destroy(u) {
  if (!(await confirmDialog(`Remove the automation "${u.name}"?`,
    'It is taken out of the config file. Nothing it proposed is undone.',
    { yes: 'remove', danger: true }))) return;
  const before = loadRules().find((r) => r.id === u.id);
  removeRule(u.id);
  try { await saveRaw({ silent: true }); }
  catch (e) { if (before) putRule(before); toast('Could not remove the automation', 'err', 12000, { detail: [e.message || String(e)] }); return; }
  await check();
}

function proposalBlock(rule, cluster, p) {
  const rows = p.targets.map((t) => h('tr',
    h('td.mono', { style: { fontSize: '11.5px' } }, t.name),
    h('td.muted', { style: { fontSize: '11px' } }, t.detail || ''),
    h('td.num', t.size ? bytes(t.size) : '')));

  return h('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
      h('b', cluster.name),
      h('span.muted', { style: { fontSize: '11px' } }, p.note || p.evidence || ''),
      h('div', { style: { marginLeft: 'auto' } }, runButton(rule, cluster, p))),
    h('div.tbl-wrap', h('table.tbl', h('tbody', ...rows))),
    p.freed ? h('div.muted', { style: { fontSize: '11px', paddingTop: '6px' } },
      `${bytes(p.freed)} would be freed`) : null);
}

/**
 * Hand the work to the action that already exists.
 *
 * Deleting goes through deleteIndices(), which re-runs the snapshot verification itself
 * before it shows the confirmation. So a proposal that has gone stale — a snapshot deleted
 * since the check ran — cannot turn into a wrong delete: the proposal is advisory, the
 * dialog is authoritative. Everything else opens in the REST console prefilled, the same
 * way the Nodes page hands over its suggested requests.
 */
function runButton(rule, cluster, p) {
  const names = p.targets.map((t) => t.name);
  if (rule.action === 'delete') {
    return h('button.btn.sm.danger', {
      title: 'Opens the normal delete confirmation, which verifies the snapshots again',
      onclick: () => deleteIndices(cluster, names, { onChanged: check }),
    }, `Review & delete ${names.length}`);
  }
  if (rule.action === 'close') {
    return h('button.btn.sm', {
      title: 'Opens the normal close confirmation',
      onclick: () => closeIndices(cluster, names, { onChanged: check }),
    }, `Review & close ${names.length}`);
  }
  if (rule.action === 'ilm-retry') {
    return h('button.btn.sm', {
      title: 'Opens the request in the REST console so you can see it before sending',
      onclick: () => navigateTo('console', { method: 'POST', path: `/${names.join(',')}/_ilm/retry` }),
    }, 'Open retry in console');
  }
  if (rule.action === 'reroute-retry') {
    return h('button.btn.sm', {
      title: 'Opens the request in the REST console so you can see it before sending',
      onclick: () => navigateTo('console', { method: 'POST', path: '/_cluster/reroute?retry_failed=true' }),
    }, 'Open reroute in console');
  }
  return null;
}

/**
 * What the rule refused to propose, and why.
 *
 * This is the point of the feature rather than a footnote: an index that is past retention
 * and has no good snapshot is the one you most need to know about, and it is exactly the
 * one automation must not touch.
 */
function blockedBlock(cluster, p) {
  return h('div', { style: { marginTop: '8px' } },
    card(`Held back on ${cluster.name}`, `${p.blocked.length} not safe to propose`,
      table(['Index', 'Why it was not proposed', { label: 'Size', num: true }],
        p.blocked.map((b) => h('tr',
          h('td.mono', { style: { fontSize: '11.5px' } }, b.name),
          h('td', pill(b.reason, b.cls || 'red')),
          h('td.num', b.size ? bytes(b.size) : ''))),
        { emptyText: 'Nothing held back' })));
}
