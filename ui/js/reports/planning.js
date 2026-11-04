/**
 * Reports › Planning (board 8): size a new or existing cluster from a plan template.
 * docs/REPORTS.md "Planning (board 8) and Plan templates (board 10)" is the contract; the
 * arithmetic is core/plan.js (pure, unit-tested), the templates core/plan-templates.js.
 *
 * `planningSection(ctx)` returns the section's node; the Reports page mounts it at
 * `#/reports/planning`. `ctx` is optional: `{clusters?: [{id, name, liveRetention}], toast?}`
 * (the page's own list wins; without it the app's clusters are used).
 */

import { h, mount } from '../lib/dom.js';
import { download, toCsv } from '../lib/fmt.js';
import { card } from '../pages/common.js';
import { clusters as appClusters } from '../core/state.js';
import { navigateTo } from '../core/intent.js';
import * as volumeDailyShared from '../core/volume-daily.js';
import { planTemplatesGet } from '../core/plan-templates.js';
import { computePlan, planCsvRows, inputsFromCluster, TARGET_LABEL, BACKUP_TARGETS, DEFAULT_INPUT } from '../core/plan.js';

const FIELDS = ['perDay', 'hotDays', 'warmDays', 'bkDays', 'buffer', 'replicas'];

export function planningSection(ctx = {}) {
  const st = {
    templates: null, error: '', templateName: '', basedOn: '', basedNote: null,
    input: { ...DEFAULT_INPUT }, raw: {},
  };
  const root = h('div.pn-page');
  const list = () => (ctx.clusters && ctx.clusters.length ? ctx.clusters : appClusters());
  const template = () => (st.templates || []).find((t) => t.name === st.templateName) || (st.templates || [])[0];

  /* the results are redrawn on every keystroke; the inputs are not, so focus stays where it is */
  const results = h('div.pn-results');
  const drawResults = () => {
    const t = template();
    if (!t) { mount(results, h('div.muted', { style: { fontSize: '12px' } }, st.error || 'Loading the plan templates…')); return; }
    const plan = computePlan(t, st.input);
    const { totals: T, rows } = plan;
    const tile = (id, label, value, note) => h('div.pn-tile', h('span.l', label), h('span.v', { id }, value), h('span.d', note));
    const cell = (v, unit = '') => (v == null ? h('span.na', '[set]') : `${v}${unit}`);
    const th = (c, num) => h('th', { class: num ? 'num' : '' }, c);
    const head = [th('Role'), th('Sizing rule'), th('Count', 1), th('CPU each', 1), th('RAM each', 1), th('/ disk each', 1), th('/live disk each', 1),
      T.showBackupCol ? th('/backup disk', 1) : null, th('CPU total', 1), th('RAM total', 1)];
    const body = rows.map((r) => {
      if (r.off) {
        return h('tr.off', h('td', h('b', r.role)), h('td', h('span.rule', r.rule)), h('td.num', r.countText), h('td.num', '—'), h('td.num', '—'), h('td.num', '—'),
          h('td.num', '—'), T.showBackupCol ? h('td.num', '—') : null, h('td.num', '—'), h('td.num', '—'));
      }
      const spec = r.bucket ? ['—', '—', '—'] : [cell(r.cpu), cell(r.ram, ' GB'), cell(r.root, ' GB')];
      return h('tr', h('td', h('b', r.role)), h('td', h('span.rule', r.rule)),
        h('td.num', r.count == null && !r.bucket ? h('span.na', '[set in template]') : r.countText),
        ...spec.map((c) => h('td.num', c)), h('td.num', r.liveText),
        T.showBackupCol ? h('td.num', r.bkText) : null,
        h('td.num', r.cpuT == null ? '—' : String(r.cpuT)), h('td.num', r.ramT == null ? '—' : `${r.ramT} GB`));
    });
    const total = h('tr.tot', h('td', 'Total'), h('td'), h('td.num', T.serversText), h('td'), h('td'), h('td'), h('td.num', T.liveText),
      T.showBackupCol ? h('td.num', T.backupText) : null, h('td.num', String(T.cpu)), h('td.num', `${T.ram} GB`));
    mount(results,
      h('div.pn-tiles',
        tile('pn-servers', 'Servers', T.serversText, t.name),
        tile('pn-cpu', 'CPU', String(T.cpu), T.cpuNote),
        tile('pn-ram', 'RAM', `${T.ram} GB`, T.ramNote),
        tile('pn-live', '/live disk', T.liveText, 'Elasticsearch, all data nodes'),
        tile('pn-bk', T.backupLabel, T.backupText, `${plan.input.bkDays} days of backups`)),
      card('Bill of materials', "from the template's rules",
        h('div.tbl-wrap', h('table#pn-bom.tbl.pn-table', h('thead', h('tr', ...head)), h('tbody', ...body, total))),
        [h('button#pn-csv.btn.sm', { type: 'button', onclick: () => exportCsv(plan, t) }, 'Export CSV')]));
  };

  const exportCsv = (plan, t) => {
    const [head, ...rows] = planCsvRows(plan);
    const objs = rows.map((r) => Object.fromEntries(head.map((c, i) => [c, r[i]])));
    download(`plan-${String(t.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'template'}.csv`, toCsv(objs, head), 'text/csv');
  };

  /* inputs */
  const setInput = () => {
    const r = st.raw;
    for (const k of FIELDS) if (r[k] !== undefined) st.input[k] = r[k];
    drawResults();
  };
  const numField = (id, key, label, hint, { min = 0, style } = {}) => h('div.fld',
    h('label', { for: id }, label),
    h('div.num', h('input', { id, type: 'number', min, step: 'any', value: String(st.input[key]), style,
      oninput: (e) => { st.raw[key] = e.target.value; setInput(); } })),
    hint ? h('span.hint', { id: `${id}-hint` }, hint) : null);

  const basedHint = h('span.hint#pn-based-hint');
  const setBased = () => {
    const n = st.basedNote;
    basedHint.className = `hint${n && n.warn ? ' na' : ''}`;
    basedHint.textContent = n ? n.text : '';
  };

  async function pickCluster(id) {
    st.basedOn = id;
    st.basedNote = null;
    if (!id) { setBased(); return; }
    const c = list().find((x) => x.id === id) || {};
    st.basedNote = { text: 'Reading the 7-day event_logsize…' };
    setBased();
    let res;
    try { res = await volumeDailyShared.volumeDaily(id, { days: 14 }); } catch (e) { res = { ok: false, message: e.message || String(e) }; }
    if (st.basedOn !== id) return;
    // One definition of "per day" (docs/REPORTS.md): core/volume-daily.js perDayEventBytes, 7 finished days.
    const perDayBytes = res && res.ok !== false ? volumeDailyShared.perDayEventBytes(res, 7) : null;
    const fill = inputsFromCluster({ perDayBytes, liveRetention: c.liveRetention });
    const said = [];
    if (fill.perDay != null) { st.input.perDay = fill.perDay; delete st.raw.perDay; said.push(`${fill.perDay} GB a day from the last 7 days`); }
    if (fill.hotDays != null) { st.input.hotDays = fill.hotDays; delete st.raw.hotDays; said.push(`${fill.hotDays} hot days from its live retention policy`); }
    const missing = [];
    if (fill.perDay == null) missing.push('daily volume not measured (no event_logsize in its record: collect the Daily view first)');
    if (fill.hotDays == null) missing.push('live retention policy not set (set liveRetention on the cluster)');
    st.basedNote = { text: [said.length ? `Filled ${said.join(', ')}.` : '', ...missing.map((m) => `${m[0].toUpperCase()}${m.slice(1)}.`)].filter(Boolean).join(' '), warn: !!missing.length };
    setBased();
    drawInputs();
    drawResults();
  }

  const inputsHost = h('section.card.pn-inputs');
  function drawInputs() {
    const names = (st.templates || []).map((t) => t.name);
    const seg = (v, label) => h('button', { type: 'button', id: `pn-bk-${v}`, class: 'seg-btn', 'aria-pressed': String(st.input.backup === v),
      onclick: () => { st.input.backup = v; drawInputs(); drawResults(); } }, label);
    mount(inputsHost,
      h('header', h('h2', 'What to plan for')),
      h('div.body',
        h('div.fld', h('label', { for: 'pn-t' }, 'Template'),
          h('div.num', h('select#pn-t', { onchange: (e) => { st.templateName = e.target.value; drawResults(); } },
            ...names.map((n) => h('option', { value: n, selected: n === (template() || {}).name }, n)))),
          h('span.hint', 'Roles, sizing rules and server specs. ',
            h('button.pn-link', { type: 'button', onclick: () => navigateTo('settings', { section: 'volume' }) }, 'Edit templates'))),
        h('div.fld', h('label', { for: 'pn-cl' }, 'Based on'),
          h('div.num', h('select#pn-cl', { onchange: (e) => pickCluster(e.target.value) },
            h('option', { value: '', selected: !st.basedOn }, 'A new cluster'),
            ...list().map((c) => h('option', { value: c.id, selected: c.id === st.basedOn }, `${c.name || c.id} (existing)`)))),
          basedHint),
        numField('pn-pd', 'perDay', 'Daily volume (GB)', 'event_logsize per day', { min: 1 }),
        h('div.fld', h('span.lbl', 'Live retention policy'),
          h('div.num.pn-days',
            h('input', { id: 'pn-hot', type: 'number', min: 1, value: String(st.input.hotDays), 'aria-label': 'Hot days', style: { width: '90px' },
              oninput: (e) => { st.raw.hotDays = e.target.value; setInput(); daysHint(); } }),
            h('span', 'hot +'),
            h('input', { id: 'pn-warm', type: 'number', min: 0, value: String(st.input.warmDays), 'aria-label': 'Warm days', style: { width: '90px' },
              oninput: (e) => { st.raw.warmDays = e.target.value; setInput(); daysHint(); } }),
            h('span', 'warm')),
          h('span.hint#pn-days', `= ${st.input.hotDays + st.input.warmDays} days live`)),
        h('div.fld', h('span.lbl', 'Backups go to'),
          h('div.seg-group', { role: 'group', 'aria-label': 'Backup target' }, ...BACKUP_TARGETS.map((v) => seg(v, TARGET_LABEL[v])))),
        numField('pn-bk', 'bkDays', 'Backup retention (days)'),
        numField('pn-buf', 'buffer', 'Buffer (%)'),
        numField('pn-rep', 'replicas', 'Replicas')));
    setBased();
  }
  // The days line and the plan read the same normalised input; recompute rather than parse the field.
  const daysHint = () => {
    const el = root.querySelector('#pn-days');
    if (el) el.textContent = `= ${computePlan(template() || { roles: [] }, st.input).input.days} days live`;
  };

  mount(root,
    h('div.pn-layout', inputsHost, results));
  drawInputs();
  drawResults();

  planTemplatesGet().then((res) => {
    if (!res.ok) { st.error = res.unknown ? 'Plan templates need ElasticPro 0.3.53.' : `The plan templates could not be read: ${res.message || 'refused'}`; drawResults(); return; }
    st.templates = res.templates;
    if (!st.templateName && st.templates[0]) st.templateName = st.templates[0].name;
    drawInputs();
    drawResults();
  });
  return root;
}
