/**
 * Config-Management › Reports › Plan templates (board 10): the list (New, Duplicate, Delete; Save is the page's save bar), the
 * backup target, one row per server role with amber `[set]` inputs for what is not given yet,
 * "+ Add server role", and the rules legend. docs/REPORTS.md is the contract; the arithmetic
 * these rules feed is core/plan.js, the storage core/plan-templates.js.
 *
 * Edits live in `st.list` (a working copy) until Save; the whole list is what is sent.
 */

import { h, mount } from '../lib/dom.js';
import { card } from '../pages/common.js';
import { confirmDialog } from './modal.js';
import { toast } from './menu.js';
import { editsFileDirectly } from './config-editor.js';
import { RULE_OPTIONS, ruleValue, withRule, newRole, newTemplate, duplicateOf, templateSummary, listProblems, numberOrNull,
  planTemplatesGet, planTemplatesSet } from '../core/plan-templates.js';

const st = { list: null, saved: '', sel: 0, where: '', error: '', unknown: false, busy: false, note: null };
const clone = (v) => JSON.parse(JSON.stringify(v));
const dirty = () => !!st.list && JSON.stringify(st.list) !== st.saved;

/** Load once (and again after a save elsewhere); `redraw` repaints the settings page. */
export async function loadPlanTemplates(redraw) {
  if (st.list && dirty()) return;
  const res = await planTemplatesGet();
  st.unknown = !!res.unknown;
  if (!res.ok) { st.error = res.message || 'the templates could not be read'; if (redraw) redraw(); return; }
  st.error = '';
  st.where = res.where || '';
  st.list = clone(res.templates);
  st.saved = JSON.stringify(st.list);
  if (st.sel >= st.list.length) st.sel = 0;
  if (redraw) redraw();
}

/** Forget what was loaded (tests). */
export function forgetPlanTemplates() { st.list = null; st.saved = ''; st.sel = 0; st.error = ''; st.note = null; }

const cur = () => (st.list || [])[st.sel];

/**
 * What differs from what is saved, for Config-Management's save bar: one line per template
 * added, removed or edited. The editor changes its working copy as it is typed into; nothing
 * is sent until Save.
 */
export function planTemplatesChanges() {
  if (!dirty()) return [];
  let saved = [];
  try { saved = JSON.parse(st.saved || '[]'); } catch (_) { saved = []; }
  const byName = (list) => new Map(list.map((t) => [String(t.name || '').toLowerCase(), t]));
  const was = byName(saved); const now = byName(st.list || []);
  const out = [];
  for (const [k, t] of now) {
    if (!was.has(k)) out.push({ key: `pt:${k}`, label: t.name, text: `Plan template "${t.name || '(unnamed)'}" added` });
    else if (JSON.stringify(was.get(k)) !== JSON.stringify(t)) out.push({ key: `pt:${k}`, label: t.name, text: `Plan template "${t.name}" edited` });
  }
  for (const [k, t] of was) if (!now.has(k)) out.push({ key: `pt:${k}`, label: t.name, text: `Plan template "${t.name}" removed or renamed` });
  return out.length ? out : [{ key: 'pt', label: 'Plan templates', text: 'Plan templates: order changed' }];
}

/** The save bar's Discard: back to what is saved. */
export function discardPlanTemplates() {
  if (!st.saved) return;
  try { st.list = JSON.parse(st.saved); } catch (_) { return; }
  if (st.sel >= st.list.length) st.sel = 0;
  st.note = null;
}

/** The save bar's Save (it was the card's "Save template"). True when the core took the list. */
export async function savePlanTemplates(redraw) {
  await save(redraw || (() => {}));
  return !dirty() && !(st.note && /err/.test(st.note.cls));
}

async function save(redraw) {
  const problems = listProblems(st.list);
  if (problems.length) { st.note = { text: problems[0], cls: 'banner err' }; toast(problems[0], 'err', 6000); redraw(); return; }
  st.busy = true; redraw();
  const res = await planTemplatesSet(st.list);
  st.busy = false;
  if (!res.ok) {
    st.note = { text: `Not saved: ${res.message || 'refused'}`, cls: 'banner err' };
    toast(st.note.text, 'err', 8000);
  } else {
    const name = cur() && cur().name;
    st.list = clone(res.templates);
    st.saved = JSON.stringify(st.list);
    st.sel = Math.max(0, st.list.findIndex((t) => t.name === name));
    st.note = { text: res.where === 'browser' ? 'Saved in this browser.' : 'Saved for everyone.', cls: 'banner' };
    toast('Plan templates saved', 'ok', 3000);
  }
  redraw();
}

function numInput(r, key, label, opts = {}) {
  const el = h('input.in.n', {
    type: 'number', min: 0, step: opts.step || 'any', 'aria-label': label, placeholder: '[set]',
    value: r[key] == null ? '' : String(r[key]), style: opts.style,
    oninput: (e) => { r[key] = numberOrNull(e.target.value); el.classList.toggle('unset', r[key] == null); },
  });
  el.classList.toggle('unset', r[key] == null);
  return el;
}

const calc = (t) => h('td.calc', t);

function roleRow(t, r, redraw, canEdit) {
  const set = (k) => (e) => { r[k] = e.target.value; };
  const isTarget = r.rule === 'target';
  const per = (() => {
    if (r.rule === 'volume') return [numInput(r, 'cap', 'GB per day per server'), ' GB/day'];
    if (r.rule === 'fixed') return [numInput(r, 'count', 'Count', { step: 1 }), r.rule === 'fixed' ? ' server(s)' : ''];
    if (r.rule === 'tier') return [numInput(r, 'nodeTB', `${r.tier === 'warm' ? 'Warm' : 'Hot'} node size, TB`), ' TB/node'];
    if (r.rule === 'whenData') return [numInput(r, 'count', 'Count', { step: 1 }), ' from ', numInput(r, 'from', 'From this many data nodes', { step: 1, style: { width: '48px' } })];
    if (r.rule === 'follows') {
      const others = t.roles.filter((x) => x !== r);
      return ['one per ', numInput(r, 'per', 'One per this many', { step: 1, style: { width: '48px' } }), ' of ',
        h('select.in', { 'aria-label': 'Follows role', onchange: set('of') },
          h('option', { value: '', selected: !r.of }, '— pick a role —'),
          ...others.map((x) => h('option', { value: x.name, selected: String(x.name).toLowerCase() === String(r.of || '').toLowerCase() }, x.name)))];
    }
    if (r.target === 'ulm') return [numInput(r, 'cap', 'GB per day per server'), ' GB/day'];
    return [h('span.calc', 'a bucket')];
  })();
  const noSpec = isTarget && r.target === 's3';
  const firstHot = r.rule === 'tier' && r.tier === 'hot' && t.roles.find((x) => x.rule === 'tier' && x.tier === 'hot') === r;
  const liveText = r.rule === 'tier' ? `volume × ${r.tier} days × buffer × copies` : '—';
  const bkText = firstHot ? 'volume × backup days × buffer (shared)' : isTarget ? 'S3: volume × backup days' : '—';
  const dim = isTarget ? 'tr.dim' : 'tr';
  return h(dim,
    h('td', h('input', { type: 'checkbox', checked: r.on !== false, 'aria-label': `${r.name} in plan`, onchange: (e) => { r.on = e.target.checked; } })),
    h('td', h('input.in', { value: r.name, 'aria-label': 'Role name', style: { width: '150px' }, oninput: (e) => { r.name = e.target.value; } })),
    h('td', h('select.in', { 'aria-label': 'Sizing rule', onchange: (e) => { Object.assign(r, withRule(r, e.target.value)); redraw(); } },
      ...RULE_OPTIONS.map((o) => h('option', { value: o.value, selected: o.value === ruleValue(r) }, o.label)))),
    h('td', ...per),
    ...(noSpec ? [calc('—'), calc('—'), calc('—')] : [
      h('td', numInput(r, 'cpu', 'CPU')), h('td', numInput(r, 'ram', 'RAM')), h('td', numInput(r, 'root', '/ disk'))]),
    calc(liveText), calc(bkText),
    h('td', h('input.in', { value: r.notes || '', 'aria-label': 'Notes', style: { width: '170px' }, placeholder: isTarget ? '' : 'notes', oninput: (e) => { r.notes = e.target.value; } })),
    canEdit ? h('td', h('button.btn.ghost.sm', { 'aria-label': `Remove ${r.name}`, title: 'Remove this role',
      onclick: () => { t.roles.splice(t.roles.indexOf(r), 1); redraw(); } }, '×')) : h('td'));
}

const RULES_LEGEND = [
  ['Scales with daily volume', 'count = daily volume ÷ GB per day per server, rounded up (at least 1)'],
  ['Fixed count', 'count = the number set here, whatever the volume'],
  ['Live retention policy (hot / warm)', "nodes in a tier = daily volume × that tier's days × (1 + buffer) × (1 + replicas) ÷ that tier's node size, rounded up"],
  ['Added when data nodes reach N', 'count = C once the Elasticsearch data nodes number N or more, else 0 (the data nodes keep that role)'],
  ['Follows another role', "count = that role's count ÷ N, rounded up (e.g. one per 3 parsers)"],
  ['Backup target', 'used only when backups go to it: S3 bucket or ULM = daily volume × backup days; otherwise /backup disk = daily volume × backup days × (1 + buffer)'],
];

/** The two cards: the editor and the rules legend. `redraw` repaints the page; null before it loads. */
export function planTemplatesPanel(redraw) {
  const canEdit = editsFileDirectly();
  if (!st.list) {
    return card('Plan templates', 'roles, sizing rules and server specs for Planning',
      st.error ? h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } }, st.unknown ? `Plan templates ${'needs ElasticPro 0.3.53'}` : st.error)
        : h('div.muted', { style: { fontSize: '12px' } }, 'Loading…'));
  }
  const t = cur();
  const sub = st.where === 'browser' ? 'kept in this browser · everyone who plans here uses them'
    : 'admins edit, everyone plans with them';
  const list = h('div#pt-list.pt-list', { role: 'listbox', 'aria-label': 'Templates' },
    ...st.list.map((x, i) => h('div.pt-item', { role: 'option', tabindex: 0, 'aria-selected': String(i === st.sel), class: i === st.sel ? 'on' : '',
      onclick: () => { st.sel = i; st.note = null; redraw(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = i; st.note = null; redraw(); } } },
    h('b', x.name || '(unnamed)'), h('span.muted', templateSummary(x)))));

  const target = (v, label) => h('label', h('input', { type: 'radio', name: 'pt-bt', value: v, checked: t.backup === v, disabled: !canEdit,
    onchange: () => { t.backup = v; } }), ` ${label}`);

  const body = [
    h('div.pt-grid',
      h('div.pt-side',
        h('div.pt-side-head', h('b', 'Templates'),
          h('button#pt-new.btn.sm', { disabled: !canEdit, onclick: () => {
            const n = newTemplate(); let name = n.name; for (let i = 2; st.list.some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `${n.name} ${i}`;
            st.list.push({ ...n, name }); st.sel = st.list.length - 1; st.note = null; redraw(); } }, '+ New')),
        list),
      h('div.pt-main',
        h('div.pt-title',
          h('label.pt-name', h('span.muted', 'Name '), h('input#pt-name.in', { value: t.name, 'aria-label': 'Template name', disabled: !canEdit, style: { width: '220px' },
            oninput: (e) => { t.name = e.target.value; } })),
          h('span.muted', { style: { fontSize: '12px' } }, 'one row per server role · amber = not set yet'),
          h('span', { style: { marginLeft: 'auto' } }),
          h('button#pt-add.btn.sm', { disabled: !canEdit, onclick: () => {
            let name = 'New role'; for (let i = 2; t.roles.some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `New role ${i}`;
            t.roles.push(newRole(name)); redraw(); } }, '+ Add server role')),
        h('div.pt-target', { role: 'radiogroup', 'aria-label': 'Backups go to' },
          h('b', 'Backups go to'),
          target('disk', '/backup disk on Elasticsearch'), target('s3', 'S3 (the S3 backup role)'), target('ulm', 'ULM → S3 (the ULM role)'),
          h('span.calc', { style: { marginLeft: 'auto' } }, 'S3 or ULM hides the /backup disk; /backup disk sets the S3 and ULM roles aside')),
        h('div.tbl-wrap', h('table.tbl.pt-table',
          h('thead', h('tr', ...['On', 'Role', 'Sizing rule', 'Per server / count', 'CPU', 'RAM (GB)', '/ disk (GB)', '/live disk', '/backup disk', 'Notes', ''].map((c) => h('th', c)))),
          h('tbody', ...(t.roles.length ? t.roles.map((r) => roleRow(t, r, redraw, canEdit))
            : [h('tr', h('td', { colspan: 11 }, h('span.muted', 'No roles yet. Add the servers this plan is made of.')))]))))),
    ),
    st.note ? h('div', { class: st.note.cls, style: { margin: 0, fontSize: '12px' } }, st.note.text) : null,
    canEdit ? null : h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } }, 'Only an ElasticPro admin edits plan templates; everyone plans with them.'),
  ];
  const actions = [
    h('button#pt-dup.btn.sm', { disabled: !canEdit, onclick: () => {
      st.list.push(duplicateOf(t, st.list.map((x) => x.name))); st.sel = st.list.length - 1; st.note = null; redraw(); } }, 'Duplicate'),
    h('button#pt-del.btn.sm', { disabled: !canEdit || st.list.length < 2, title: st.list.length < 2 ? 'Keep at least one template' : '', onclick: async () => {
      if (!(await confirmDialog('Delete this template?', `"${t.name}" is removed for everyone who plans with it.`, { yes: 'Delete', danger: true }))) return;
      st.list.splice(st.sel, 1); st.sel = Math.max(0, st.sel - 1); await save(redraw); } }, 'Delete'),
  ];
  return h('div', { style: { display: 'grid', gap: '12px' } },
    card('Plan templates', sub, h('div', { style: { display: 'grid', gap: '10px' } }, ...body), actions),
    card('Sizing rules a role can use', '',
      h('div.pt-rules',
        ...RULES_LEGEND.map(([b, s]) => h('div.pt-rule', h('b', b), h('span', s))),
        h('p.muted', { style: { margin: '6px 0 0', fontSize: '12px' } },
          'Every server has a / disk; Elasticsearch data nodes add /live, and /backup when backups stay on disk. A value left empty stays “[set]” on every plan; it is never taken as 0.'))));
}

/** Mount the panel into a host and keep it current (for a page that is not Config). */
export function mountPlanTemplates(host) {
  const redraw = () => mount(host, planTemplatesPanel(redraw));
  redraw();
  loadPlanTemplates(redraw);
}
