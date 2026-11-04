/**
 * Plan templates, from the page's side (docs/REPORTS.md "Planning (board 8) and Plan templates
 * (board 10)"): reading and replacing the shared list (PLAN_TEMPLATES_GET / _SET, hosted), the
 * browser's own copy on the desktop build, and the pure helpers the editor draws from.
 *
 * Hosted, the templates are the server's: everybody plans with them, admins replace them.
 * Desktop has no shared store and no accounts, so the list is kept in this browser
 * (localStorage, `elasticpro.planTemplates`), seeded from what the core answers.
 */

import { bridge } from './transport.js';
import { isHosted } from './volume-daily.js';
import { isUnknownType } from './volume-config.js';

export const NEEDS = 'needs ElasticPro 0.3.53';
const KEY = 'elasticpro.planTemplates';

/** The sizing rules an editor row can pick: `{value, label, rule, tier?, target?}`, in the board's words. */
export const RULE_OPTIONS = [
  { value: 'volume',   label: 'Scales with daily volume',        rule: 'volume' },
  { value: 'fixed',    label: 'Fixed count',                     rule: 'fixed' },
  { value: 'tier:hot', label: 'Live retention policy · hot days', rule: 'tier', tier: 'hot' },
  { value: 'tier:warm', label: 'Live retention policy · warm days', rule: 'tier', tier: 'warm' },
  { value: 'whenData', label: 'Added when data nodes reach N',   rule: 'whenData' },
  { value: 'follows',  label: 'Follows another role',            rule: 'follows' },
  { value: 'target:s3', label: 'Backup target · object storage', rule: 'target', target: 's3' },
  { value: 'target:ulm', label: 'Backup target · scales with volume', rule: 'target', target: 'ulm' },
];

/** The option value a role is showing. */
export function ruleValue(r) {
  if (r.rule === 'tier') return `tier:${r.tier === 'warm' ? 'warm' : 'hot'}`;
  if (r.rule === 'target') return `target:${r.target === 'ulm' ? 'ulm' : 's3'}`;
  return r.rule;
}

/** A role with the rule changed: what belongs to the old rule is dropped, the shared fields stay. */
export function withRule(r, value) {
  const o = RULE_OPTIONS.find((x) => x.value === value) || RULE_OPTIONS[0];
  const out = { on: r.on !== false, name: r.name, rule: o.rule, cpu: r.cpu ?? null, ram: r.ram ?? null, root: r.root ?? null, notes: r.notes || '' };
  if (o.rule === 'volume') out.cap = null;
  if (o.rule === 'fixed') out.count = null;
  if (o.rule === 'tier') { out.tier = o.tier; out.nodeTB = null; }
  if (o.rule === 'whenData') { out.count = null; out.from = null; }
  if (o.rule === 'follows') { out.of = ''; out.per = null; }
  if (o.rule === 'target') { out.target = o.target; if (o.target === 'ulm') out.cap = null; }
  return out;
}

export const newRole = (name = 'New role') => withRule({ on: true, name }, 'fixed');
export const newTemplate = (name = 'New template') => ({ name, backup: 'disk', roles: [newRole('Server')] });
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A copy under a name no other template has: "X copy", "X copy 2". */
export function duplicateOf(t, taken) {
  const names = new Set(taken.map((n) => String(n).toLowerCase()));
  let name = `${t.name} copy`;
  for (let i = 2; names.has(name.toLowerCase()); i++) name = `${t.name} copy ${i}`;
  return { ...clone(t), name };
}

/** How many roles have a value still to set, and a short line for the template list. */
export function templateSummary(t) {
  const roles = (t.roles || []).filter((r) => r.on !== false);
  const unset = roles.filter((r) => [r.cpu, r.ram, r.root].some((v) => v == null)
    || (r.rule === 'volume' && r.cap == null) || (r.rule === 'tier' && r.nodeTB == null) || (r.rule === 'whenData' && r.from == null)
    || (r.rule === 'fixed' && r.count == null)).length;
  return `${roles.length} role${roles.length === 1 ? '' : 's'}${unset ? ' · values to set in amber' : ''}`;
}

/** What is wrong with the list before it is sent (the core checks again and is the judge). */
export function listProblems(list) {
  const bad = [];
  const seen = new Set();
  for (const t of list) {
    const n = String(t.name || '').trim();
    if (!n) bad.push('A template needs a name.');
    else if (seen.has(n.toLowerCase())) bad.push(`Two templates are called "${n}".`);
    seen.add(n.toLowerCase());
    const roles = new Set();
    for (const r of t.roles || []) {
      const rn = String(r.name || '').trim();
      if (!rn) bad.push(`${n || 'A template'}: a role needs a name.`);
      else if (roles.has(rn.toLowerCase())) bad.push(`${n}: two roles are called "${rn}".`);
      roles.add(rn.toLowerCase());
      if (r.rule === 'follows' && !(t.roles || []).some((x) => x !== r && String(x.name).trim().toLowerCase() === String(r.of || '').trim().toLowerCase())) {
        bad.push(`${n}: "${rn}" follows a role that is not in this template.`);
      }
    }
  }
  return bad;
}

/** A number input's text as a template value: empty is null ("[set]"), junk is null too. */
export function numberOrNull(s) {
  const t = String(s == null ? '' : s).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const readLocal = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return Array.isArray(v) && v.length ? v : null; } catch { return null; } };
const writeLocal = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch { return false; } };

async function ask(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { return { ok: false, message: e.message || String(e) }; }
  if (isUnknownType(res)) return { ok: false, unknown: true, message: `Plan templates ${NEEDS}` };
  return res || { ok: false, message: 'the core did not answer' };
}

/**
 * `{ok, templates, where: 'server'|'browser'}` or `{ok:false, message, unknown?}`. Hosted, the
 * server's list; desktop, this browser's copy over the core's seeds.
 */
export async function planTemplatesGet() {
  const res = await ask({ type: 'PLAN_TEMPLATES_GET' });
  if (!res.ok) return res;
  if (await isHosted()) return { ...res, where: 'server' };
  return { ...res, templates: readLocal() || res.templates, where: 'browser' };
}

/** Replace the whole list. Hosted: PLAN_TEMPLATES_SET (admin). Desktop: the browser's copy. */
export async function planTemplatesSet(templates) {
  if (!(await isHosted())) {
    // The core's rules still decide what is valid; its answer is not kept (it holds nothing here).
    const res = await ask({ type: 'PLAN_TEMPLATES_SET', templates });
    if (!res.ok) return res;
    return writeLocal(res.templates) ? { ...res, where: 'browser' } : { ok: false, message: 'this browser would not keep the templates (storage is blocked)' };
  }
  const res = await ask({ type: 'PLAN_TEMPLATES_SET', templates });
  return res.ok ? { ...res, where: 'server' } : res;
}
