/**
 * The Templates view on the Indices page: index, component and legacy templates on the
 * selected cluster, and the same templates compared across the fleet.
 *
 * Reading one cluster's three template lists happens when the view is opened — it is
 * three small GETs, the same order of cost as the index list the page already reads.
 * Reading the fleet is a decision: the Compare button asks which clusters, then reads
 * them one at a time with a Cancel, because at a hundred clusters "on open" would be a
 * hundred requests nobody asked for.
 *
 * Every write — save, delete, apply to other clusters — goes through ensureWrites() and a
 * confirmation that names the cluster and the template, and carries `allowWrites` only on
 * the request the operator pressed for. The core still refuses it unless the session is
 * unlocked.
 *
 * Simulate is a POST that changes nothing; the core's read-only allow-list (guard.rs
 * READONLY_POST) treats it as a read, so it needs no unlock.
 */

import { h } from '../lib/dom.js';
import { state, client, clusters } from '../core/state.js';
import { card, table, pill, empty } from '../pages/common.js';
import { modal, field, text, confirmDialog, inputDialog, nameList } from './modal.js';
import { rowMenu, ICON, toast } from './menu.js';
import { ensureWrites } from '../core/writes.js';
import { runTask } from '../core/tasks.js';
import {
  TEMPLATE_KINDS, normalize, matchingIndices, winningTemplate, overlaps, compareAcross,
  validateTemplateBody, validateTemplateName, putRequest, deleteRequest, simulateRequest,
  skeleton, changedKeys, exampleIndexName,
} from '../core/templates.js';

const KINDS = Object.keys(TEMPLATE_KINDS);

/** View state. Lists are per cluster and kind; a list is `{rows}` or `{error}`. */
const tv = {
  kind: 'index',
  q: '',
  showManaged: false,
  lists: new Map(),        // clusterId -> { index: {rows}|{error}, component: …, legacy: …, loading }
  compare: null,           // { kind, ids, results: {id: rows|{error}}, running, cancelled, done, onlyDiff }
};

const errText = (res) => (res && (res.message || res.kind)) || `HTTP ${res && res.status}`;

/* --------------------------------- reading --------------------------------- */

async function readList(clusterId, kind) {
  const cl = client(clusterId);
  if (!cl) return { error: 'no client for this cluster' };
  try {
    const res = await cl.request('GET', TEMPLATE_KINDS[kind].list);
    // A cluster with no legacy templates answers {} — that is an empty list, not an error.
    if (!res.ok) return { error: errText(res) };
    return { rows: normalize(kind, res.json || {}) };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

async function loadCluster(c, draw) {
  const cur = tv.lists.get(c.id);
  if (cur && cur.loading) return;
  tv.lists.set(c.id, { ...(cur || {}), loading: true });
  draw();
  const out = { loading: false, at: Date.now() };
  // Three small reads; side by side is fine on one cluster.
  await Promise.all(KINDS.map(async (k) => { out[k] = await readList(c.id, k); }));
  tv.lists.set(c.id, out);
  draw();
}

async function reloadKind(c, kind, draw) {
  const cur = tv.lists.get(c.id) || {};
  cur[kind] = await readList(c.id, kind);
  tv.lists.set(c.id, cur);
  draw();
}

/* ---------------------------------- view ----------------------------------- */

export function templatesView(c, { draw }) {
  const lists = tv.lists.get(c.id);
  if (!lists) { loadCluster(c, draw); return h('div', card('Templates', `on ${c.name}`, empty('Loading…'))); }

  const listOf = (k) => lists[k];
  const cur = listOf(tv.kind);
  const allRows = cur && cur.rows ? cur.rows : [];
  const indexNames = state.indices.has(c.id) ? (state.indices.get(c.id) || []).map((r) => r.index) : null;
  const q = tv.q.trim().toLowerCase();
  const hiddenManaged = allRows.filter((r) => r.managed).length;
  const rows = allRows
    .filter((r) => tv.showManaged || !r.managed)
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.patterns.some((p) => p.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const kindSwitch = h('div.seg', { role: 'group', 'aria-label': 'Template kind' },
    ...KINDS.map((k) => {
      const l = listOf(k);
      const n = l && l.rows ? String(l.rows.filter((r) => tv.showManaged || !r.managed).length) : (l && l.error ? '?' : '…');
      return h('button.btn.sm', {
        'data-kind': k,
        'aria-pressed': tv.kind === k ? 'true' : 'false',
        title: l && l.error ? `Could not read: ${l.error}` : TEMPLATE_KINDS[k].label,
        onclick: () => { if (tv.kind !== k) { tv.kind = k; draw(); } },
      }, `${TEMPLATE_KINDS[k].short} (${n})`);
    }));

  const toolbar = h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '9px' } },
    kindSwitch,
    h('input#tpl-search', { type: 'search', value: tv.q, placeholder: 'name or pattern…', style: { minWidth: '200px', flex: '1' },
      oninput: (e) => { tv.q = e.target.value; draw(); } }),
    h('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' },
      title: 'Built-in templates (names starting with "." or marked _meta.managed) are on every cluster and rarely what you are looking for' },
      h('input#tpl-managed', { type: 'checkbox', checked: tv.showManaged, onchange: (e) => { tv.showManaged = e.target.checked; draw(); } }),
      `show built-in${hiddenManaged && !tv.showManaged ? ` (${hiddenManaged} hidden)` : ''}`));

  let body;
  if (lists.loading && !cur) body = empty('Loading…');
  else if (!cur) body = empty('Not read yet.');
  else if (cur.error) {
    body = empty(`${TEMPLATE_KINDS[tv.kind].label} could not be read.`, {
      detail: h('span.mono', cur.error),
      actions: [h('button.btn.sm', { onclick: () => reloadKind(c, tv.kind, draw) }, 'Try again')],
    });
  } else {
    body = h('div', tv.kind === 'index' ? overlapBanner(allRows) : null,
      templateTable(c, rows, allRows, lists, indexNames, draw));
  }

  return h('div',
    card(`${TEMPLATE_KINDS[tv.kind].label} on ${c.name}`,
      cur && cur.rows ? `${rows.length} shown of ${allRows.length}` : null,
      h('div', toolbar, body),
      [
        h('button.btn.sm.primary', { onclick: () => editTemplate(c, tv.kind, null, draw) }, 'New template'),
        h('button.btn.sm', { 'data-act': 'tpl-compare', title: 'Read this kind of template from the clusters you pick and compare them',
          onclick: () => pickCompare(c, draw) }, 'Compare across clusters…'),
        h('button.btn.sm', { disabled: !!lists.loading, onclick: () => loadCluster(c, draw) }, lists.loading ? 'Loading…' : '↻ Reload'),
      ]),
    tv.compare ? comparePanel(c, draw) : null);
}

function overlapBanner(allRows) {
  const ov = overlaps(allRows);
  if (!ov.length) return null;
  return h('div.banner.warn', { style: { marginTop: 0 } }, h('div',
    h('div.ttl', `${ov.length} pair(s) of index templates overlap at the same priority`),
    h('div', { style: { fontSize: '12px' } },
      'Elasticsearch refuses to create such a pair, so these were stored before the rule or by a version without it. A new index matching both gets whichever Elasticsearch picks.'),
    h('div.mono', { style: { fontSize: '11.5px' } },
      ov.slice(0, 6).map((o) => h('div', `${o.a} ↔ ${o.b} (priority ${o.priority}): ${o.patterns.map((p) => p.join(' ∩ ')).join(', ')}`)))));
}

function templateTable(c, rows, allRows, lists, indexNames, draw) {
  const kind = tv.kind;
  const indexRows = (lists.index && lists.index.rows) || [];
  const usedBy = (name) => indexRows.filter((r) => r.composedOf.includes(name)).map((r) => r.name);

  const matchCell = (r) => {
    if (!indexNames) return h('td.muted', { title: 'The index list for this cluster has not been read — reload the Indices view' }, 'indices not read');
    const m = matchingIndices(r, indexNames);
    return h('td.num', { title: m.slice(0, 12).join('\n') + (m.length > 12 ? `\n…and ${m.length - 12} more` : '') }, String(m.length));
  };
  const nameCell = (r) => h('td.mono', { style: { fontSize: '12px' } }, r.name,
    r.managed ? h('span', { style: { marginLeft: '6px' } }, pill('built-in', 'grey')) : null,
    r.dataStream ? h('span', { style: { marginLeft: '6px' } }, pill('data stream', 'grey')) : null);
  const patCell = (r) => h('td.mono', { style: { fontSize: '11.5px', maxWidth: '260px' } }, r.patterns.join(', ') || '–');
  const verCell = (r) => h('td.num.muted', r.version == null ? '–' : String(r.version));

  const actions = (r) => {
    const used = kind === 'component' ? usedBy(r.name) : [];
    const delWhy = r.managed ? 'Built-in templates are owned by Elasticsearch or a product; deleting one breaks what installed it, and it is usually put back on restart.'
      : used.length ? `In use by ${used.join(', ')} — Elasticsearch refuses to delete a component template an index template uses.` : '';
    return h('td', h('div', { style: { display: 'flex', gap: '3px', justifyContent: 'flex-end' } },
      h('button.btn.sm', { 'data-act': 'tpl-view', onclick: () => editTemplate(c, kind, r, draw) }, r.managed ? 'View' : 'View / Edit'),
      kind === 'index' ? h('button.btn.sm', { 'data-act': 'tpl-simulate', title: 'What would a new index of a given name get?',
        onclick: () => simulate(c, r, indexRows, indexNames) }, 'Simulate') : null,
      rowMenu([
        { label: 'Duplicate…', icon: ICON.edit, onClick: () => editTemplate(c, kind, r, draw, { duplicate: true }) },
        { sep: true },
        { label: 'Delete…', icon: ICON.delete, danger: true, disabled: !!delWhy, title: delWhy || `Delete ${r.name}`,
          onClick: () => deleteTemplate(c, kind, r, draw) },
      ], { title: `Actions for ${r.name}` })));
  };

  if (kind === 'index') {
    return table(['Name', 'Patterns', { label: 'Priority', num: true }, 'Composed of', { label: 'Matching indices', num: true }, { label: 'Version', num: true }, ''],
      rows.map((r) => h('tr', { 'data-name': r.name },
        nameCell(r), patCell(r),
        h('td.num', r.priority == null ? h('span.muted', { title: 'Not set — Elasticsearch uses 0' }, '0 (unset)') : String(r.priority)),
        h('td.mono', { style: { fontSize: '11.5px' } }, r.composedOf.join(', ') || '–'),
        matchCell(r), verCell(r), actions(r))),
      { emptyText: allRows.length ? 'No template matches the filter' : 'This cluster has no index templates' });
  }
  if (kind === 'component') {
    return table(['Name', 'Used by', { label: 'Settings', num: true }, { label: 'Mapping fields', num: true }, { label: 'Version', num: true }, ''],
      rows.map((r) => {
        const used = usedBy(r.name);
        return h('tr', { 'data-name': r.name },
          nameCell(r),
          h('td.mono', { style: { fontSize: '11.5px' } }, lists.index && lists.index.rows ? (used.join(', ') || h('span.muted', 'no index template')) : h('span.muted', 'index templates not read')),
          h('td.num', String(r.settingsCount)), h('td.num', String(r.mappingFieldCount)), verCell(r), actions(r));
      }),
      { emptyText: allRows.length ? 'No template matches the filter' : 'This cluster has no component templates' });
  }
  return table(['Name', 'Patterns', { label: 'Order', num: true }, { label: 'Matching indices', num: true }, { label: 'Version', num: true }, ''],
    rows.map((r) => h('tr', { 'data-name': r.name },
      nameCell(r), patCell(r), h('td.num', r.order == null ? '0' : String(r.order)), matchCell(r), verCell(r), actions(r))),
    { emptyText: allRows.length ? 'No template matches the filter' : 'This cluster has no legacy templates' });
}

/* --------------------------------- editing --------------------------------- */

function problemList(problems) {
  if (!problems.length) return h('div', { style: { fontSize: '12px', color: 'var(--good-ink)' } }, '✓ Looks valid.');
  return h('div', { style: { display: 'grid', gap: '4px' } },
    ...problems.map((p) => h(`div.banner.${p.level === 'error' ? 'err' : 'warn'}`, { style: { margin: 0, fontSize: '12px' } }, h('div', p.text))));
}

/** Overlaps a candidate would create with the templates already on the cluster. */
function candidateOverlaps(c, name, body) {
  const l = tv.lists.get(c.id);
  const existing = (l && l.index && l.index.rows) || [];
  const cand = { kind: 'index', name, patterns: [].concat(body.index_patterns || []).map(String),
    priority: Number.isInteger(body.priority) ? body.priority : null };
  return overlaps([...existing.filter((r) => r.name !== name), cand]).filter((o) => o.a === name || o.b === name);
}

/**
 * The editor. Resolves with the operator's intent; the guard and the confirmation happen
 * after it closes, so a second dialog never sits on top of unsaved text (Escape would
 * close both). Declining puts the editor back with the text as it was.
 */
async function editTemplate(c, kind, r, draw, { duplicate = false } = {}) {
  const isNew = !r || duplicate;
  let name = r ? (duplicate ? `${r.name}-copy` : r.name) : '';
  let textBody = JSON.stringify(r ? r.body : skeleton(kind), null, 2);
  const readOnlyView = !!(r && r.managed && !duplicate);

  for (;;) {
    const area = h('textarea#tpl-json.mono', { spellcheck: false, rows: 22, readOnly: readOnlyView,
      style: { width: '100%', fontSize: '12px', fontFamily: 'var(--mono)', boxSizing: 'border-box', resize: 'vertical' } });
    area.value = textBody;
    const nameInput = text('tpl-name', name, { mono: true, placeholder: 'template-name' });
    if (!isNew) nameInput.readOnly = true;
    const out = h('div#tpl-problems');
    const check = () => {
      const v = validateTemplateBody(kind, area.value);
      const nameErr = isNew ? validateTemplateName(nameInput.value) : null;
      const problems = [...(nameErr ? [{ level: 'error', text: nameErr }] : []), ...v.problems];
      if (v.ok && kind === 'index') {
        for (const o of candidateOverlaps(c, nameInput.value.trim(), v.body)) {
          problems.push({ level: 'error', text: `Overlaps "${o.a === nameInput.value.trim() ? o.b : o.a}" at priority ${o.priority} (${o.patterns.map((p) => p.join(' ∩ ')).join(', ')}) — Elasticsearch refuses two index templates with the same priority and overlapping patterns. Change the priority or the patterns.` });
        }
      }
      return { ...v, problems, ok: !problems.some((p) => p.level === 'error') };
    };

    const title = readOnlyView ? `${r.name} (built-in)` : isNew ? `New ${TEMPLATE_KINDS[kind].short.toLowerCase()} template` : `Edit ${r.name}`;
    const res = await modal(title, `${TEMPLATE_KINDS[kind].label} · ${c.name}`, [
      isNew ? field('Name', nameInput) : null,
      readOnlyView ? h('div.muted', { style: { fontSize: '11.5px' } }, 'Built-in: shown read-only. Duplicate it to make an editable copy.') : null,
      field('Body (what is sent with PUT)', area),
      out,
    ].filter(Boolean), (ctx) => [
      h('button.btn', { 'data-act': 'tpl-validate', onclick: () => { const v = check(); out.replaceChildren(problemList(v.problems)); } }, 'Validate'),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => ctx.done(null) }, readOnlyView ? 'Close' : 'Cancel'),
        readOnlyView ? null : h('button.btn.primary', { 'data-act': 'tpl-save', onclick: () => {
          const v = check();
          out.replaceChildren(problemList(v.problems));
          if (!v.ok) return;
          ctx.done({ name: nameInput.value.trim(), text: area.value, body: v.body, problems: v.problems });
        } }, 'Save')),
    ], { width: '760px' });
    if (!res) return;
    name = res.name; textBody = res.text;

    if (!(await ensureWrites())) { toast('Not saved — writes are locked', 'warn', 3500); continue; }
    const req = putRequest(kind, res.name, res.body);
    const changed = isNew ? null : changedKeys(r.body, res.body);
    const exists = isNew && (((tv.lists.get(c.id) || {})[kind] || {}).rows || []).some((x) => x.name === res.name);
    const warns = res.problems.filter((p) => p.level === 'warn').map((p) => `• ${p.text}`);
    const ok = await confirmDialog(`Save ${res.name} on ${c.name}?`,
      `${req.method} ${req.path}\n\n`
      + (isNew ? (exists ? `A template named ${res.name} already exists on ${c.name} — this REPLACES it.` : `Creates a new ${TEMPLATE_KINDS[kind].short.toLowerCase()} template.`)
        : changed.length ? `Replaces the template. Changed: ${changed.join(', ')}.` : 'Nothing differs from what the cluster has — this re-sends it unchanged.')
      + '\n\nApplies to indices created from now on; existing indices keep their settings and mappings.'
      + (warns.length ? `\n\n${warns.join('\n')}` : ''),
      { yes: 'save it', danger: exists || (!isNew && changed.length > 0) });
    if (!ok) continue;

    const out2 = await client(c.id).request(req.method, req.path, req.body, { allowWrites: true });
    if (!out2.ok) { toast(`${res.name} not saved: ${errText(out2)}`, 'err', 7000); continue; }
    toast(`Saved ${res.name} on ${c.name}`);
    await reloadKind(c, kind, draw);
    return;
  }
}

async function deleteTemplate(c, kind, r, draw) {
  if (r.managed) { toast(`${r.name} is built in and is not offered for deletion`, 'warn', 4000); return; }
  if (!(await ensureWrites())) return;
  const req = deleteRequest(kind, r.name);
  const names = state.indices.has(c.id) ? matchingIndices(r, (state.indices.get(c.id) || []).map((x) => x.index)) : null;
  const ok = await confirmDialog(`Delete ${r.name} from ${c.name}?`,
    `${req.method} ${req.path}\n\nExisting indices are not touched. New indices matching ${r.patterns.join(', ') || 'its patterns'} `
    + 'will be created without it — a different template or none at all.'
    + (names ? `\n\n${names.length} existing index(es) currently match.` : ''),
    { yes: 'delete it', danger: true });
  if (!ok) return;
  const res = await client(c.id).request(req.method, req.path, null, { allowWrites: true });
  if (!res.ok) { toast(`${r.name} not deleted: ${errText(res)}`, 'err', 7000); return; }
  toast(`Deleted ${r.name} from ${c.name}`);
  await reloadKind(c, kind, draw);
}

/* -------------------------------- simulating ------------------------------- */

const jsonBlock = (title, v) => h('details', { style: { marginTop: '6px' } },
  h('summary', { style: { cursor: 'pointer', fontSize: '12.5px', fontWeight: 600 } }, title),
  h('pre.mono', { style: { fontSize: '11px', margin: '6px 0 0', padding: '8px', background: 'var(--surface-2)', borderRadius: '4px', overflow: 'auto', maxHeight: '300px' } },
    JSON.stringify(v == null ? {} : v, null, 2)));

async function simulate(c, r, indexRows, indexNames) {
  const name = await inputDialog(`Simulate ${r.name}`, 'Index name', exampleIndexName(r, indexNames || []), {
    mono: true, yes: 'Simulate',
    hint: 'Asks Elasticsearch what this index would get. It creates nothing, and the read-only guard treats it as a read.',
  });
  if (!name) return;
  const req = simulateRequest(name);
  const res = await client(c.id).request(req.method, req.path, null);
  if (!res.ok) { toast(`Simulate failed: ${errText(res)}`, 'err', 7000); return; }
  const j = res.json || {};
  const tpl = j.template || {};
  const win = winningTemplate(name, indexRows);
  const overlapping = Array.isArray(j.overlapping) ? j.overlapping : [];
  await modal(`Simulated: ${name}`, `${c.name} · ${req.method} ${req.path}`, [
    h('div#tpl-sim-result', { style: { display: 'grid', gap: '6px', fontSize: '12.5px' } },
      win
        ? h('div', 'Winning template: ', h('b.mono', { 'data-winner': win.template.name }, win.template.name),
            h('span.muted', ` (priority ${win.priority}${win.template.composedOf.length ? `, composed of ${win.template.composedOf.join(', ')}` : ''})`),
            win.ambiguous ? h('div.banner.warn', { style: { margin: '6px 0 0' } }, h('div', win.note)) : null)
        : h('div.banner.warn', { style: { margin: 0 } }, h('div', 'No composable index template matches this name; a legacy template or the defaults apply.')),
      h('div.muted', { style: { fontSize: '11px' } }, 'The winner is worked out from this cluster’s template list by priority; the settings below are what Elasticsearch itself resolved.'),
      overlapping.length
        ? h('div', h('b', `Also matching, lower priority (${overlapping.length}): `),
            h('span.mono', overlapping.map((o) => `${o.name} [${[].concat(o.index_patterns || []).join(', ')}]`).join('; ')))
        : h('div.muted', 'No other template matches this name.'),
      jsonBlock(`Settings (${Object.keys(tpl.settings || {}).length ? 'resolved' : 'none'})`, tpl.settings),
      jsonBlock('Mappings', tpl.mappings),
      jsonBlock('Aliases', tpl.aliases)),
  ], (ctx) => [h('button.btn.primary', { style: { marginLeft: 'auto' }, onclick: () => ctx.done(true) }, 'Done')], { width: '720px' });
}

/* -------------------------------- comparing -------------------------------- */

function clusterName(id) { const x = clusters().find((k) => k.id === id); return x ? x.name : id; }

async function pickCompare(c, draw) {
  const all = clusters();
  const chosen = new Set(all.map((x) => x.id));
  let kind = tv.kind;
  const kindSel = h('select#tpl-cmp-kind', { onchange: (e) => { kind = e.target.value; } },
    ...KINDS.map((k) => h('option', { value: k }, TEMPLATE_KINDS[k].label)));
  kindSel.value = kind;
  const box = h('div', { style: { display: 'grid', gap: '3px', maxHeight: '220px', overflowY: 'auto' } },
    ...all.map((x) => h('label', { style: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) chosen.add(x.id); else chosen.delete(x.id); } }),
      h('span', x.name), h('span.mono.muted', { style: { fontSize: '10.5px' } }, x.url))));
  const go = await modal('Compare templates across clusters', 'one GET per cluster, one cluster at a time', [
    field('Kind', kindSel),
    field(`Clusters (${all.length})`, box, 'Read in turn, with a Cancel. Nothing is changed.'),
  ], (ctx) => [h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
    h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    h('button.btn.primary', { onclick: () => {
      if (!chosen.size) return ctx.msg('Pick at least one cluster.');
      ctx.done(true);
    } }, 'Read'))], { width: '560px' });
  if (!go) return;
  const ids = all.filter((x) => chosen.has(x.id)).map((x) => x.id);
  tv.compare = { kind, ids, results: {}, running: true, cancelled: false, onlyDiff: false, applied: null };
  draw();
  await readSerial(ids, draw);
}

async function readSerial(ids, draw) {
  const cmp = tv.compare;
  cmp.running = true; cmp.cancelled = false;
  for (const id of ids) {
    if (cmp.cancelled || tv.compare !== cmp) break;
    cmp.current = id;
    draw();
    const r = await readList(id, cmp.kind);
    cmp.results[id] = r.rows ? r.rows : { error: r.error };
  }
  cmp.running = false; cmp.current = null;
  if (tv.compare === cmp) draw();
}

function comparePanel(c, draw) {
  const cmp = tv.compare;
  const readIds = cmp.ids.filter((id) => id in cmp.results);
  const byCluster = {};
  for (const id of readIds) byCluster[id] = cmp.results[id];
  let rows = compareAcross(byCluster).filter((r) => tv.showManaged || !r.managed);
  const diffs = rows.filter((r) => !r.same).length;
  if (cmp.onlyDiff) rows = rows.filter((r) => !r.same);
  const pending = cmp.ids.length - readIds.length;
  const unreadIds = readIds.filter((id) => !Array.isArray(cmp.results[id]));

  const cell = (r, id) => {
    if (!Array.isArray(cmp.results[id])) return h('td', { title: cmp.results[id].error }, pill('could not read', 'red'));
    const fp = r.clusters[id];
    if (fp === null) return h('td', pill('missing', 'grey'));
    return h('td', { title: `fingerprint ${fp}` }, fp === r.reference ? pill('same', 'green') : pill('differs', 'yellow'));
  };

  const progress = cmp.running
    ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', marginBottom: '8px' } },
        h('span', `Reading ${readIds.length + 1} of ${cmp.ids.length}${cmp.current ? ` — ${clusterName(cmp.current)}` : ''}…`),
        h('button.btn.sm', { 'data-act': 'tpl-cmp-cancel', onclick: () => { cmp.cancelled = true; draw(); } }, cmp.cancelled ? 'Stopping…' : 'Cancel'))
    : pending
      ? h('div.banner.warn', { style: { margin: '0 0 8px' } }, h('div', `Stopped: ${pending} cluster(s) not read — they are left out below, not counted as missing.`,
          h('button.btn.sm', { style: { marginLeft: '8px' }, onclick: () => readSerial(cmp.ids.filter((id) => !(id in cmp.results)), draw) }, 'Read the rest')))
      : null;

  return card(`Compare ${TEMPLATE_KINDS[cmp.kind].label.toLowerCase()} across clusters`,
    `${readIds.length - unreadIds.length} read · ${unreadIds.length} could not be read · ${diffs} template(s) differ`,
    h('div', progress,
      unreadIds.length
        ? h('div.banner.err', { style: { margin: '0 0 8px' } }, h('div',
            h('div.ttl', `${unreadIds.length} cluster(s) could not be read — their templates are unknown, not missing`),
            h('div.mono', { style: { fontSize: '11.5px' } }, unreadIds.map((id) => h('div', `${clusterName(id)}: could not read: ${cmp.results[id].error}`)))))
        : null,
      h('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '12px', cursor: 'pointer', marginBottom: '8px' } },
        h('input', { type: 'checkbox', checked: cmp.onlyDiff, onchange: (e) => { cmp.onlyDiff = e.target.checked; draw(); } }), 'only differences'),
      cmp.applied ? appliedReport(cmp) : null,
      table(['Template', ...readIds.map((id) => clusterName(id)), ''],
        rows.map((r) => h('tr', { 'data-name': r.name },
          h('td.mono', { style: { fontSize: '12px', whiteSpace: 'nowrap' } }, r.name),
          ...readIds.map((id) => cell(r, id)),
          h('td', h('button.btn.sm', { disabled: cmp.running, title: 'Copy one cluster’s version of this template to others',
            onclick: () => applyAcross(r, draw) }, 'Apply…')))),
        { emptyText: readIds.length ? (cmp.onlyDiff ? 'Every template is the same on every cluster read' : 'No templates on the clusters read') : 'Nothing read yet' })),
    [h('button.btn.sm.ghost', { disabled: cmp.running, onclick: () => { tv.compare = null; draw(); } }, 'Close')]);
}

function appliedReport(cmp) {
  const a = cmp.applied;
  return h('div', { style: { margin: '0 0 8px', fontSize: '12px', display: 'grid', gap: '2px' } },
    h('b', `Applied ${a.name} from ${clusterName(a.from)}: ${a.out.filter((x) => x.ok).length} of ${a.out.length} took it`),
    ...a.out.map((x) => h('div', h('span', { style: { display: 'inline-block', width: '14px' } }, x.ok ? '✓' : '✗'),
      h('b', { style: { marginRight: '6px' } }, clusterName(x.clusterId)), h('span.muted', x.message))));
}

/** Copy one cluster's version of a template to the clusters the operator ticks. */
async function applyAcross(r, draw) {
  const cmp = tv.compare;
  const sources = Object.keys(r.rows);
  if (!sources.length) return;
  const readOk = cmp.ids.filter((id) => Array.isArray(cmp.results[id]));
  let from = sources.find((id) => r.clusters[id] === r.reference) || sources[0];
  const targets = new Set(readOk.filter((id) => r.clusters[id] !== r.clusters[from]));
  const srcSel = h('select#tpl-apply-from', ...sources.map((id) => h('option', { value: id }, `${clusterName(id)} (${r.clusters[id]})`)));
  srcSel.value = from;
  const box = h('div', { style: { display: 'grid', gap: '3px', maxHeight: '220px', overflowY: 'auto' } },
    ...readOk.map((id) => h('label', { style: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: targets.has(id), onchange: (e) => { if (e.target.checked) targets.add(id); else targets.delete(id); } }),
      h('span', clusterName(id)),
      h('span.muted', { style: { fontSize: '11px' } }, r.clusters[id] === null ? 'missing' : r.clusters[id] === r.reference ? 'same' : 'differs'))));
  srcSel.onchange = () => { from = srcSel.value; };
  const go = await modal(`Apply ${r.name} to other clusters`, `${TEMPLATE_KINDS[cmp.kind].label} · PUT ${TEMPLATE_KINDS[cmp.kind].one(r.name)}`, [
    field('Take the version from', srcSel),
    field('Apply to', box, 'Clusters that could not be read are not offered — what they hold is unknown.'),
  ], (ctx) => [h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
    h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    h('button.btn.primary', { onclick: () => {
      targets.delete(from);
      if (!targets.size) return ctx.msg('Tick at least one cluster other than the source.');
      ctx.done(true);
    } }, 'Next'))], { width: '560px' });
  if (!go) return;
  const ids = readOk.filter((id) => targets.has(id) && id !== from);
  if (!(await ensureWrites())) return;
  const body = r.rows[from].body;
  const req = putRequest(cmp.kind, r.name, body);
  const ok = await confirmDialog(`Apply ${r.name} to ${ids.length} cluster(s)?`, h('div', { style: { fontSize: '13px', lineHeight: '1.55' } },
    h('div.mono', `${req.method} ${req.path}`),
    h('div', `The version on ${clusterName(from)} (fingerprint ${r.clusters[from]}) replaces whatever each of these has:`),
    nameList(ids.map((id) => `${clusterName(id)} — ${r.clusters[id] === null ? 'creates it' : 'replaces it'}`)),
    h('div.muted', { style: { fontSize: '11.5px', marginTop: '6px' } }, 'Each cluster is done in turn; one refusing does not stop the rest. Existing indices are not changed.')),
    { yes: `apply to ${ids.length}`, danger: true });
  if (!ok) return;
  const task = { id: `template-${cmp.kind}`, title: `Apply ${r.name}`, fields: [], build: () => req };
  let out;
  try { out = await runTask(task, {}, ids); }
  catch (e) { toast(e.message || String(e), 'err', 6000); return; }
  cmp.applied = { name: r.name, from, out };
  const okN = out.filter((x) => x.ok).length;
  toast(`${r.name}: ${okN} applied, ${out.length - okN} failed`, okN === out.length ? 'ok' : 'err', 5000);
  // Read the targets again, so the table shows what they hold now rather than what we hoped.
  await readSerial(ids, draw);
}

/** For tests: forget everything read. */
export function resetTemplatesView() { tv.lists.clear(); tv.compare = null; tv.q = ''; tv.kind = 'index'; tv.showManaged = false; }
