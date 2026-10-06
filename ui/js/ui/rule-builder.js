/**
 * The automation builder.
 *
 * Five sections in the order you think about them, with a dry run either side of the
 * trigger:
 *
 *   1  Condition Match   which indices this is about
 *   2  Expected output   what matches right now
 *   3  Trigger Rule      when that counts as worth acting on
 *   4  Expected output   what the action would do to those matches
 *   5  Notify            how you get told
 *
 * Both previews run against a real cluster while you type. That is the whole point: a rule
 * you cannot see the effect of is a rule you should not save, and a destructive rule you
 * cannot see the effect of is worse than no rule at all.
 */

import { h, mount } from '../lib/dom.js';
import { bytes } from '../lib/fmt.js';
import { modal, field, text, select } from './modal.js';
import { state, activeClusters } from '../core/state.js';
import { pill, empty } from '../pages/common.js';
import {
  FIELDS, CLUSTER_FIELDS, SCOPES, OP_LABEL, ACTIONS, TRIGGERS, blankRule, validateRule,
  describeRule, matchIndices, evaluateUserRule, webhookSupport, clusterFacts,
  testPreconditions, diskPressurePreset,
} from '../core/user-rules.js';

/** Recompute previews a beat after the last keystroke, not on every one. */
function debounce(fn, ms = 250) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/**
 * @param {object|null} existing  rule to edit, or null for a new one
 * @returns {Promise<object|null>} the rule to save, or null if cancelled
 */
export async function ruleBuilder(existing) {
  // Work on a copy: cancelling must leave the saved rule untouched.
  const rule = existing ? JSON.parse(JSON.stringify(existing)) : blankRule();
  const clusterList = activeClusters();
  let previewCluster = clusterList[0] || null;

  const matchHost = h('div');
  const actionHost = h('div');
  const summaryHost = h('div');
  const condHost = h('div', { style: { display: 'grid', gap: '6px' } });
  const whenHost = h('div', { style: { display: 'grid', gap: '6px' } });
  const stateHost = h('div');

  const refresh = debounce(async () => {
    mount(summaryHost, h('div.muted', { style: { fontSize: '11.5px', lineHeight: '1.55' } },
      describeRule(rule)));
    await runPreviews();
  });

  async function runPreviews() {
    if (!previewCluster) {
      mount(matchHost, empty('No cluster connected — connect one to preview.'));
      mount(actionHost, empty('No cluster connected.'));
      return;
    }
    const indices = state.indices.get(previewCluster.id) || [];
    if (!indices.length) {
      mount(matchHost, empty('No index list loaded for this cluster yet — open the Indices page once.'));
      mount(actionHost, empty('Nothing to preview.'));
      return;
    }
    mount(matchHost, h('div.muted', { style: { fontSize: '11.5px' } }, 'Loading…'));
    try {
      const { matched, total, unreadable } = await matchIndices(rule, previewCluster, indices);
      mount(matchHost, matchTable(matched, total, unreadable));
    } catch (e) {
      mount(matchHost, h('div.banner.err', { style: { margin: 0 } }, `Preview failed: ${e.message || e}`));
    }
    try {
      const data = state.data.get(previewCluster.id) || {};
      const p = await evaluateUserRule({ ...rule, enabled: true }, { cluster: previewCluster, data, indices });
      mount(actionHost, actionPreview(p, rule));
    } catch (e) {
      mount(actionHost, h('div.banner.err', { style: { margin: 0 } }, `Preview failed: ${e.message || e}`));
    }
  }

  /* ---------------------------------- 1. match --------------------------------- */

  function drawConditions() {
    mount(condHost, ...(rule.match.conditions || []).map((c, i) => conditionRow(c, i)),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('button.btn.sm', {
          onclick: () => { rule.match.conditions.push({ field: 'name', op: 'contains', value: '' }); drawConditions(); refresh(); },
        }, '+ condition'),
        rule.match.conditions.length > 1
          ? select('rb-all', String(rule.match.all), [['true', 'match ALL of these'], ['false', 'match ANY of these']])
          : null));
    const allSel = condHost.querySelector('#rb-all');
    if (allSel) allSel.onchange = (e) => { rule.match.all = e.target.value === 'true'; drawConditions(); refresh(); };
  }

  /**
   * "When the cluster..." — the state that has to hold before any index is looked at.
   *
   * Optional, and empty by default: most rules are about indices alone. It exists because
   * "delete the oldest day when the disk is over 80% and ILM has stopped" is a sentence
   * about a cluster with a clause about indices, and the index conditions cannot say it.
   */
  function drawWhen() {
    mount(whenHost,
      ...(rule.when || []).map((c, i) => whenRow(c, i)),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('button.btn.sm', {
          onclick: () => { rule.when.push({ field: 'diskPercent', op: 'greaterThan', value: 80 }); drawWhen(); refresh(); },
        }, '+ cluster condition'),
        (rule.when || []).length
          ? h('span.muted', { style: { fontSize: '11px' } }, 'all of these must hold')
          : h('span.muted', { style: { fontSize: '11px' } }, 'optional — leave empty to run against any cluster state')));
    drawState();
  }

  /** What those conditions are being judged against right now, so a false one is explicable. */
  function drawState() {
    if (!previewCluster || !(rule.when || []).length) return mount(stateHost, null);
    const data = state.data.get(previewCluster.id) || {};
    const indices = state.indices.get(previewCluster.id) || [];
    const f = clusterFacts(previewCluster, data, indices);
    const res = testPreconditions(rule, previewCluster, data, indices);
    mount(stateHost, h('div', { style: { marginTop: '6px', fontSize: '11.5px' } },
      h('span.muted', `${previewCluster.name} right now: `),
      h('span', `disk ${f.diskPercent === null ? '–' : `${f.diskPercent.toFixed(1)}%`}`),
      h('span.muted', ' · '), h('span', `ILM ${f.ilmState || '–'}`),
      h('span.muted', ' · '), h('span', `SLM ${f.slmState || '–'}`),
      h('span.muted', ' · '), h('span', `retention fits: ${f.retentionFits === null ? 'unknown' : f.retentionFits ? 'yes' : 'no'}`),
      h('div', { style: { marginTop: '4px' } },
        res.ok ? pill('the cluster is in this state', 'green')
               : pill(`not in this state — ${res.failed.map((x) => `${x.label} ${x.why}`).join(', ')}`, 'yellow'))));
  }

  function whenRow(c, i) {
    const f = CLUSTER_FIELDS[c.field] || CLUSTER_FIELDS.diskPercent;
    const fieldSel = select(`rb-wf${i}`, c.field, Object.entries(CLUSTER_FIELDS).map(([k, v]) => [k, v.label]));
    fieldSel.onchange = (e) => {
      c.field = e.target.value;
      const nf = CLUSTER_FIELDS[c.field];
      c.op = nf.ops[0];
      c.value = nf.value === 'choice' ? nf.choices[0] : nf.value === 'number' ? 80 : '7d';
      drawWhen(); refresh();
    };
    const opSel = select(`rb-wo${i}`, c.op, f.ops.map((o) => [o, OP_LABEL[o] || o]));
    opSel.onchange = (e) => { c.op = e.target.value; refresh(); drawState(); };
    let valueInput;
    if (f.value === 'choice') {
      valueInput = select(`rb-wv${i}`, c.value, f.choices.map((x) => [x, x]));
      valueInput.onchange = (e) => { c.value = e.target.value; refresh(); drawState(); };
    } else {
      valueInput = text(`rb-wv${i}`, c.value, { placeholder: f.value === 'duration' ? '7d' : '80' });
      valueInput.oninput = (e) => { c.value = e.target.value; refresh(); drawState(); };
    }
    return h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto', gap: '6px', alignItems: 'center' } },
      fieldSel, opSel, valueInput,
      h('button.btn.sm.ghost', {
        title: 'Remove this cluster condition',
        onclick: () => { rule.when.splice(i, 1); drawWhen(); refresh(); },
      }, '×'));
  }

  function conditionRow(c, i) {
    const f = FIELDS[c.field] || FIELDS.name;
    const fieldSel = select(`rb-f${i}`, c.field, Object.entries(FIELDS).map(([k, v]) => [k, v.label]));
    fieldSel.onchange = (e) => {
      c.field = e.target.value;
      const nf = FIELDS[c.field];
      c.op = nf.ops[0];
      c.value = nf.value === 'choice' ? nf.choices[0] : '';
      drawConditions(); refresh();
    };
    const opSel = select(`rb-o${i}`, c.op, f.ops.map((o) => [o, OP_LABEL[o] || o]));
    opSel.onchange = (e) => { c.op = e.target.value; refresh(); };

    let valueInput;
    if (f.value === 'choice') {
      valueInput = select(`rb-v${i}`, c.value, f.choices.map((x) => [x, x]));
      valueInput.onchange = (e) => { c.value = e.target.value; refresh(); };
    } else {
      valueInput = text(`rb-v${i}`, c.value, {
        placeholder: f.value === 'duration' ? '30d' : f.value === 'size' ? '5GB' : f.value === 'number' ? '1000' : 'text',
      });
      valueInput.oninput = (e) => { c.value = e.target.value; refresh(); };
    }

    return h('div', { style: { display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr auto', gap: '6px', alignItems: 'center' } },
      fieldSel, opSel, valueInput,
      h('button.btn.sm.ghost', {
        title: 'Remove this condition',
        disabled: rule.match.conditions.length < 2,
        onclick: () => { rule.match.conditions.splice(i, 1); drawConditions(); refresh(); },
      }, '×'));
  }

  /* --------------------------------- previews ---------------------------------- */

  function matchTable(matched, total, unreadable) {
    const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
      h('b', `${matched.length} of ${total} indices match`),
      unreadable.length
        ? pill('snapshot coverage unknown for some repositories', 'yellow')
        : null);
    if (!matched.length) {
      return h('div', head, empty('Nothing matches on this cluster right now.'));
    }
    const rows = matched.slice(0, 12).map((i) => h('tr',
      h('td.mono', { style: { fontSize: '11.5px' } }, i.index),
      h('td.muted', { style: { fontSize: '11px' } }, i.day || ''),
      h('td.num', i.size ? bytes(i.size) : '')));
    return h('div', head,
      h('div.tbl-wrap', h('table.tbl', h('tbody', ...rows))),
      matched.length > 12
        ? h('div.muted', { style: { fontSize: '11px', paddingTop: '4px' } }, `…and ${matched.length - 12} more`)
        : null);
  }

  function actionPreview(p, r) {
    const spec = ACTIONS[r.action];
    if (!p) return empty('The trigger would not fire — nothing would happen.');
    if (p.skipped) return h('div.banner', { style: { margin: 0 } }, h('div', p.skipped));
    const lines = [
      h('div', h('b', `${p.targets.length}`), ` would be proposed to ${spec.verb}`),
      p.freed ? h('div.muted', { style: { fontSize: '11.5px' } }, `${bytes(p.freed)} would be freed`) : null,
      p.blocked.length
        ? h('div', { style: { marginTop: '6px' } },
            h('div.muted', { style: { fontSize: '11.5px', marginBottom: '4px' } },
              `${p.blocked.length} held back by the safety rails, which a rule cannot switch off:`),
            ...p.blocked.slice(0, 6).map((b) => h('div', { style: { fontSize: '11.5px' } },
              h('span.mono', b.name), ' — ', h('span.muted', b.reason))))
        : null,
    ].filter(Boolean);
    return h('div', ...lines);
  }

  /* ---------------------------------- sections --------------------------------- */

  const step = (n, title, hint, ...body) => h('div', { style: { marginTop: '12px' } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
      h('span', { style: { fontSize: '11px', fontWeight: 700, color: 'var(--accent)' } }, String(n)),
      h('b', { style: { fontSize: '12.5px' } }, title),
      hint ? h('span.muted', { style: { fontSize: '11px' } }, hint) : null),
    h('div', { style: { marginTop: '6px' } }, ...body));

  const clusterSel = select('rb-cluster', previewCluster ? previewCluster.id : '',
    clusterList.map((c) => [c.id, c.name]));
  clusterSel.onchange = (e) => { previewCluster = clusterList.find((c) => c.id === e.target.value); refresh(); };

  const scopeSel = select('rb-scope', rule.clusters.includes('*') ? '*' : rule.clusters[0],
    [['*', 'every cluster'], ...clusterList.map((c) => [c.id, `only ${c.name}`])]);
  scopeSel.onchange = (e) => { rule.clusters = [e.target.value]; refresh(); };

  const nameInput = text('rb-name', rule.name, { placeholder: 'Delete backed-up logs past 30 days' });
  nameInput.oninput = (e) => { rule.name = e.target.value; refresh(); };

  const triggerSel = select('rb-trigger', rule.trigger.when,
    Object.entries(TRIGGERS).map(([k, v]) => [k, v.label]));
  const countInput = text('rb-count', rule.trigger.count, { style: { width: '80px' } });
  countInput.oninput = (e) => { rule.trigger.count = Number(e.target.value) || 0; refresh(); };
  const countWrap = h('span', { style: { marginLeft: '8px' } }, countInput);
  const syncCount = () => { countWrap.hidden = rule.trigger.when !== 'atLeast'; };
  triggerSel.onchange = (e) => { rule.trigger.when = e.target.value; syncCount(); refresh(); };

  const actionSel = select('rb-action', rule.action,
    Object.entries(ACTIONS).map(([k, v]) => [k, v.label]));
  actionSel.onchange = (e) => { rule.action = e.target.value; refresh(); };

  const scopeSelector = select('rb-scopekind', (rule.scope || {}).kind || 'all',
    Object.entries(SCOPES).map(([k, v]) => [k, v.label]));
  const scopeCount = text('rb-scopecount', (rule.scope || {}).count || 2, { style: { width: '70px' } });
  scopeCount.oninput = (e) => { rule.scope.count = Number(e.target.value) || 0; refresh(); };
  const scopeCountWrap = h('span', { style: { marginLeft: '6px' } }, scopeCount);
  const syncScope = () => { scopeCountWrap.hidden = rule.scope.kind !== 'oldestDays'; };
  scopeSelector.onchange = (e) => { rule.scope.kind = e.target.value; syncScope(); refresh(); };

  const alertBox = h('input', { id: 'rb-alert', type: 'checkbox', checked: rule.notify.alert });
  alertBox.onchange = (e) => { rule.notify.alert = e.target.checked; refresh(); };
  const levelSel = select('rb-level', rule.notify.level, [['warning', 'warning'], ['critical', 'critical']]);
  levelSel.onchange = (e) => { rule.notify.level = e.target.value; refresh(); };
  const hookInput = text('rb-hook', rule.notify.webhook, { placeholder: 'https://hooks.example.com/…' });
  hookInput.oninput = (e) => { rule.notify.webhook = e.target.value; refresh(); };
  const hook = webhookSupport();

  const body = [
    existing ? null : h('div', { style: { marginBottom: '8px' } },
      h('button.btn.sm', {
        title: 'Fills in the disk-pressure case: over 80%, ILM stopped, SLM still running, '
             + 'retention no longer fits — delete the oldest day of backed-up logstash indices',
        onclick: () => { Object.assign(rule, { ...diskPressurePreset(), id: rule.id }); redrawAll(); },
      }, 'Start from a template: free space when ILM has stopped')),
    field('Name', nameInput, 'What this automation is for, in your words.'),
    field('Applies to', scopeSel),

    step(1, 'Condition Match', 'the situation, then the indices',
      h('div.muted', { style: { fontSize: '11px', marginBottom: '4px' } }, 'When the cluster…'),
      whenHost, stateHost,
      h('div.muted', { style: { fontSize: '11px', margin: '10px 0 4px' } }, '…and these indices match'),
      condHost),

    step(2, 'Expected output', 'what matches right now',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
        h('span.muted', { style: { fontSize: '11px' } }, 'preview against'), clusterSel),
      matchHost),

    step(3, 'Trigger Rule', 'when that is worth acting on',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        triggerSel, countWrap,
        h('span.muted', { style: { fontSize: '11px' } }, 'then'), actionSel,
        h('span.muted', { style: { fontSize: '11px' } }, 'for'), scopeSelector, scopeCountWrap)),

    step(4, 'Expected output', 'what the action would do', actionHost),

    step(5, 'Notify', 'how you get told',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
        alertBox, h('label', { for: 'rb-alert' }, 'Raise an alert on the Alerts page'), levelSel),
      field('Webhook (optional)', hookInput,
        hook.ok ? 'POSTed when the rule fires.' : null),
      hook.ok ? null : h('div.banner', { style: { margin: '6px 0 0' } },
        h('div', h('div.ttl', 'Webhooks are saved but not yet delivered'), h('div', hook.reason)))),

    h('div', { style: { marginTop: '14px', paddingTop: '10px', borderTop: '1px solid var(--border)' } },
      summaryHost),
  ];

  /** The template rewrites every field, so every control has to be repainted from the rule. */
  function redrawAll() {
    nameInput.value = rule.name;
    actionSel.value = rule.action;
    triggerSel.value = rule.trigger.when;
    scopeSelector.value = rule.scope.kind;
    scopeCount.value = rule.scope.count;
    alertBox.checked = rule.notify.alert;
    levelSel.value = rule.notify.level;
    hookInput.value = rule.notify.webhook;
    drawWhen(); drawConditions(); syncCount(); syncScope(); refresh();
  }

  drawWhen();
  drawConditions();
  syncCount();
  syncScope();
  refresh();

  const saved = await modal(existing ? 'Edit automation' : 'New automation',
    'Saved into the config file, next to the retention settings.', body,
    (ctx) => [
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
        h('button.btn.primary', {
          onclick: () => {
            const errs = validateRule(rule);
            if (errs.length) return ctx.msg(errs[0]);
            ctx.done(rule);
          },
        }, existing ? 'Save changes' : 'Create automation')),
    ], { width: '760px' });

  return saved || null;
}
