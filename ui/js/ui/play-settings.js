/**
 * Config › Play (0.3.47): display links, the watch rules every display shares, and the
 * clusters left out of Play. Messages and pure helpers: core/play-config.js.
 *
 * Kept out of pages/settings.js, which only lists the section. Compact density: 32 px
 * rows, no explainer boxes.
 */

import { h, mount } from '../lib/dom.js';
import { dt, ago } from '../lib/fmt.js';
import { state, clusters } from '../core/state.js';
import { card, table } from '../pages/common.js';
import { modal, field, text, select, checkbox, val, checked, confirmDialog } from './modal.js';
import { toast } from './menu.js';
import { MANAGED_NOTE } from '../core/managed.js';
import {
  NO_PLAY, SLIDES, DWELL, ZOOMS, EXPIRES, SPOTLIGHT_WHEN, playConfigGet, playConfigSet, playLinkList, playLinkCreate, playLinkRevoke,
  playLinkSet, lockedFields, linkPayload, scopeText, slidesText, displaySettings, moveSlide, settingsPayload, watchRules, watchProblems,
  watchPayload, excludeAdd, replacePayload,
} from '../core/play-config.js';

const pl = { cfg: null, links: null, unknown: false, problem: '', note: null, redraw: () => {} };

const isAdmin = () => !state.caller || state.caller.role === 'admin';

/** The server may send seconds or milliseconds; the formatters want milliseconds. */
const ms = (t) => (t && Number(t) < 1e12 ? Number(t) * 1000 : t);
const nameOf = (id) => { const c = clusters().find((x) => x.id === id); return c ? c.name : id; };

/** The section's load: the settings and (admin) the links. `redraw` repaints the page. */
export async function loadPlay(redraw) {
  pl.redraw = redraw || pl.redraw;
  const [cfg, links] = await Promise.all([playConfigGet(), isAdmin() ? playLinkList() : Promise.resolve(null)]);
  pl.unknown = !!(cfg.unknown || (links && links.unknown));
  pl.problem = !pl.unknown && !cfg.ok ? cfg.message || 'refused' : '';
  pl.cfg = cfg.ok ? cfg : null;
  pl.links = links && links.ok ? links.links || [] : null;
  pl.redraw();
}

async function copyText(t) {
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('this window has no clipboard access');
    await navigator.clipboard.writeText(t);
    toast('Link copied', 'ok', 2500, { key: 'play-copy' });
  } catch (e) { toast(`Not copied: ${e.message}`, 'warn', 5000); }
}

const note = (t, cls = 'banner warn') => h(`div.${cls.replace(/ /g, '.')}`, { style: { margin: 0, fontSize: '12px' } }, t);
const sel = (id, value, opts) => select(id, String(value), opts.map(([v, l]) => [String(v), l]));
const reload = () => loadPlay();

/* ------------------------------- displays table ------------------------------ */

function displaysCard() {
  const admin = isAdmin();
  const links = pl.links || [];
  const rows = links.map((l) => {
    const seen = l.lastSeen && l.lastSeen.at ? [ago(ms(l.lastSeen.at)), l.lastSeen.from ? h('span.mono.muted', ` · ${l.lastSeen.from}`) : null] : 'never';
    return h('tr',
      h('td', { style: { fontWeight: 620 } }, l.name),
      h('td', scopeText(l.clusters, nameOf)),
      h('td', slidesText(l.settings)),
      h('td', { title: l.lastSeen && l.lastSeen.at ? dt(ms(l.lastSeen.at)) : '' }, seen),
      h('td.pl-actions',
        h('button.btn.sm.pl-replace', { onclick: () => replaceLink(l) }, 'Replace link…'),
        h('button.btn.sm.pl-edit', { onclick: () => editDisplay(l) }, 'Edit'),
        h('button.btn.sm.danger.pl-revoke', { onclick: () => revoke(l) }, 'Revoke')));
  });
  return card('Displays', 'one link per TV', h('div', { style: { display: 'grid', gap: '8px' } },
    pl.unknown ? note(NO_PLAY) : null,
    pl.problem ? note(`Play settings not read: ${pl.problem}`, 'banner err') : null,
    admin ? null : note('Only an ElasticPro admin makes display links and changes Play settings. You can read them here.'),
    admin && !pl.unknown
      ? h('div.tbl-wrap', table(['Display', 'Clusters', 'Slides', 'Last seen', ''], rows.length ? rows
        : [h('tr', h('td.muted', { colSpan: 5 }, pl.links ? 'No display links yet' : 'Loading…'))])) : null),
  admin && !pl.unknown ? [h('button#pl-new.btn.sm.primary', { onclick: newLink }, 'New display link…')] : null);
}

/** The new link's address, shown once, in a dialog of its own or the one that made it. */
function showUrl(body, name, url) {
  mount(body,
    h('div', { style: { fontWeight: 620 } }, `Link for ${name}`),
    h('input#pl-url.mono', { readOnly: true, value: url, style: { width: '100%', boxSizing: 'border-box' },
      onfocus: (ev) => ev.target.select() }),
    note('This link will not be shown again. Copy it now and open it on the TV.', 'banner warn'));
}

/**
 * A link's secret is shown once, when it is made, and the server keeps only its hash, so an
 * old link cannot be copied again. Replacing it revokes the old one (the TV on it stops at
 * once) and makes a new one with the same name, clusters, addresses, expiry and settings.
 */
async function replaceLink(l) {
  const yes = await confirmDialog(`Replace the link for "${l.name}"?`,
    'The old link stops working at once: the TV on it shows that it was refused until it is given the new one. '
    + 'The new link keeps this display\'s clusters, addresses, expiry and slides.', { yes: 'replace the link', danger: true });
  if (!yes) return;
  const gone = await playLinkRevoke(l.id);
  if (!gone.ok) { toast(`Not replaced: ${gone.message || 'refused'}`, 'err', 7000); return; }
  const r = await playLinkCreate(replacePayload(l));
  reload();
  if (!r.ok) { toast(`The old link is revoked, but a new one was not made: ${r.message || 'refused'}. Make it with New display link.`, 'err', 9000); return; }
  const url = (r.link && r.link.url) || '';
  const body = h('div.pl-form');
  showUrl(body, l.name, url);
  modal('New link', `for ${l.name}`, [body], (ctx) => [
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done(null) }, 'Close'),
      h('button#pl-copy-url.btn.primary', { onclick: () => copyText(url) }, 'Copy link')),
  ], { width: '520px' });
}

async function revoke(l) {
  const yes = await confirmDialog(`Revoke "${l.name}"?`,
    `The TV using this link stops showing Play at once. Its settings are deleted.`, { yes: 'revoke the link', danger: true });
  if (!yes) return;
  const r = await playLinkRevoke(l.id);
  if (!r.ok) { toast(`Not revoked: ${r.message || 'refused'}`, 'err', 7000); return; }
  toast(`Revoked ${l.name}`, 'ok', 3500);
  reload();
}

/* ------------------------------ new display link ------------------------------ */

function newLink() {
  const list = clusters();
  const groups = (pl.cfg && pl.cfg.groups) || [];
  const scope = sel('pl-scope', 'all', [['all', 'All clusters'], ['group', 'A Zabbix host group'], ['chosen', 'Chosen clusters']]);
  const group = groups.length ? sel('pl-group', groups[0], groups.map((g) => [g, g])) : text('pl-group', '', { placeholder: 'Zabbix host group name' });
  const chosen = h('div.pl-chosen', ...list.map((c) => h('label.pl-check', h('input', { type: 'checkbox', value: c.id, class: 'pl-pick' }), c.name)));
  const body = h('div.pl-form');
  const show = () => {
    chosen.hidden = scope.value !== 'chosen';
    group.hidden = scope.value !== 'group';
  };
  scope.addEventListener('change', show);
  mount(body,
    field('Display name', text('pl-name', '', { placeholder: 'e.g. NOC wall, floor 2' })),
    field('Clusters', scope), group, chosen,
    field('Works only from (optional)', text('pl-from', '', { mono: true, placeholder: '10.1.0.0/16, 10.2.3.4' }), 'Addresses or networks, comma separated. Blank: from anywhere.'),
    field('Link expires', sel('pl-expires', 'permanent', EXPIRES)));
  show();
  return modal('New display link', 'for one TV', [body], (ctx) => [
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
      h('button#pl-create.btn.primary', { onclick: (e) => { const btn = e.currentTarget; return ctx.run(btn, async () => {
        const f = linkPayload({
          name: val('pl-name'), scope: val('pl-scope'), group: val('pl-group'), allowFrom: val('pl-from'), expires: val('pl-expires'),
          chosen: [...body.querySelectorAll('.pl-pick:checked')].map((x) => x.value),
        });
        if (f.problem) return ctx.msg(f.problem);
        const r = await playLinkCreate(f.payload);
        if (!r.ok) return ctx.msg(r.message || 'The server refused the link');
        const url = (r.link && r.link.url) || '';
        showUrl(body, f.payload.name, url);
        btn.replaceWith(h('button#pl-copy-url.btn.primary', { onclick: () => copyText(url) }, 'Copy link'));
        reload();
        return null;
      }); } }, 'Create link')),
  ], { width: '520px' });
}

/* ----------------------------- edit one display ------------------------------- */

function editDisplay(l) {
  let slides = displaySettings(l.settings).slides;
  const d = displaySettings(l.settings);
  const list = h('div.pl-slides');
  const draw = () => {
    mount(list, ...slides.map((s, i) => h('div.pl-cfg-slide',
      h('label.pl-check', h('input', { type: 'checkbox', id: `pl-show-${s.id}`, checked: s.show,
        onchange: (e) => { s.show = e.target.checked; } }), SLIDES.find((x) => x.id === s.id).label),
      h('span.muted', 'stays'),
      Object.assign(sel(`pl-dwell-${s.id}`, s.dwellSec, [...new Set([...DWELL, s.dwellSec])].map((n) => [n, `${n} s`])),
        { onchange: (e) => { s.dwellSec = Number(e.target.value); } }),
      h('button.btn.sm.ghost.pl-up', { 'aria-label': 'Move up', disabled: i === 0, onclick: () => { slides = moveSlide(slides, i, -1); draw(); } }, '▲'),
      h('button.btn.sm.ghost.pl-down', { 'aria-label': 'Move down', disabled: i === slides.length - 1, onclick: () => { slides = moveSlide(slides, i, 1); draw(); } }, '▼'))));
  };
  draw();
  const body = h('div.pl-form',
    h('div', { style: { fontWeight: 620, fontSize: '12.5px' } }, 'Slides, in order'), list,
    h('div.pl-grid',
      field('A critical alert', sel('pl-critical', d.criticalTakesScreen ? 'takes' : 'bar', [['takes', 'Takes the screen, held 5 min'], ['bar', 'Red bar only']])),
      field('Cluster spotlight', sel('pl-spot', d.spotlightAll ? 'every' : 'critical', [['critical', 'Clusters with a critical problem (automatic)'], ['every', 'Every cluster, by name']])),
      field('Theme', sel('pl-theme', d.theme, [['dark', 'Dark'], ['light', 'Light']])),
      field('Sound on a new critical alert', sel('pl-sound', d.sound, [['off', 'Off'], ['chime', 'Short chime']])),
      field('Zoom', sel('pl-zoom', d.zoom === null ? 'keep' : d.zoom, ZOOMS.map(([z, t]) => [z === null ? 'keep' : z, t])))));
  return modal(`Edit ${l.name}`, 'applies on the TV within a minute', [body], (ctx) => [
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
      h('button#pl-save-display.btn.primary', { onclick: (e) => ctx.run(e.currentTarget, async () => {
        const zoom = val('pl-zoom');
        const next = settingsPayload({
          slides: slides.map((s) => ({ ...s, dwellSec: Number(val(`pl-dwell-${s.id}`)) || s.dwellSec, show: checked(`pl-show-${s.id}`) })),
          criticalTakesScreen: val('pl-critical') === 'takes', spotlightAll: val('pl-spot') === 'every',
          theme: val('pl-theme'), sound: val('pl-sound'), zoom: zoom === 'keep' ? null : Number(zoom),
        });
        const r = await playLinkSet(l.id, next);
        if (!r.ok) return ctx.msg(r.message || 'The server refused the settings');
        toast(`Saved ${l.name}`, 'ok', 3000);
        ctx.done(true);
        reload();
        return null;
      }) }, 'Save')),
  ], { width: '600px' });
}

/* ------------------------------- watch rules ---------------------------------- */

const locked = () => lockedFields(pl.cfg);

function watchCard() {
  const admin = isAdmin();
  const w = watchRules(pl.cfg && pl.cfg.watch);
  const lk = locked();
  const lockIt = (path, el) => {
    if (!admin) el.disabled = true;
    if (lk.has(path)) { el.disabled = true; el.title = MANAGED_NOTE; }
    return el;
  };
  const num = (id, path, v, lo) => lockIt(path, h('input.mono', { id, type: 'number', min: lo, step: 1, value: String(v), style: { width: '80px' } }));
  const mark = (path) => ([].concat(path).some((p) => lk.has(p)) ? h('span.muted.pl-managed', MANAGED_NOTE) : null);
  const row = (label, path, ...inputs) => h('div.pl-row', h('span.pl-label', label), ...inputs, mark(path));
  const tick = (path, on) => (id) => {
    const c = checkbox(`pl-when-${id}`, SPOTLIGHT_WHEN.find((x) => x.id === id).label, on.includes(id));
    c.querySelector('input').disabled = !admin || lk.has(path);
    if (lk.has(path)) c.title = MANAGED_NOTE;
    return c;
  };
  const whenOf = tick('spotlight.when', w.spotlight.when);
  const body = h('div.pl-watch',
    row('Delay colours', ['delayYellowFromMin', 'delayRedAboveMin'],
      h('span', 'green below'), num('pl-yellow', 'delayYellowFromMin', w.delayYellowFromMin, 1),
      h('span', 'min, yellow up to'), num('pl-red', 'delayRedAboveMin', w.delayRedAboveMin, 2), h('span', 'min, red over')),
    h('div.pl-sub', 'A node leaves a cluster'),
    row('Nodes it should have', 'nodeExpected', lockIt('nodeExpected', sel('pl-expected', w.nodeExpected, [['seen24h', 'Seen in the last 24 h'], ['pinned', 'Pinned (a list I keep)']]))),
    row('Its tile', 'nodeBlink', lockIt('nodeBlink', sel('pl-blink', w.nodeBlink, [['untilBack', 'Blinks every 3 s until the node is back'], ['untilAck', 'Blinks until acknowledged'], ['off', 'Red, no blinking']]))),
    row('Checked every', 'nodeCheckSec', lockIt('nodeCheckSec', sel('pl-check', w.nodeCheckSec, [...new Set([60, 30, 180, w.nodeCheckSec])].map((n) => [n, `${n} s`])))),
    h('div.pl-sub', 'Cluster spotlight: who is in it'),
    h('div.pl-whens', ...SPOTLIGHT_WHEN.map((x) => whenOf(x.id)), mark('spotlight.when')),
    row('Each cluster shows for', 'spotlight.perClusterSec', lockIt('spotlight.perClusterSec', sel('pl-persec', w.spotlight.perClusterSec,
      [...new Set([13, 10, 20, 30, w.spotlight.perClusterSec])].map((n) => [n, `${n} s${n === 13 ? ' (default)' : ''}`])))),
    row('Leaves the spotlight', 'spotlight.leaveAfterMin', lockIt('spotlight.leaveAfterMin', sel('pl-leave', w.spotlight.leaveAfterMin,
      [...new Set([10, 1, 30, w.spotlight.leaveAfterMin])].map((n) => [n, n === 10 ? '10 min after its last critical problem clears' : `${n} min after`])))),
    row('Nobody in it', 'whenEmpty', lockIt('whenEmpty', sel('pl-empty', w.spotlight.whenEmpty,
      [['skip', 'Skip the slide'], ['allHealthy', 'Show "All clusters healthy"'], ['everyCluster', 'Every cluster in turn']]))),
    pl.note ? note(pl.note.text, pl.note.cls) : null);
  return card('Watch rules (server side, every display)', 'one set for all', body,
    admin && !pl.unknown ? [h('button#pl-watch-save.btn.sm.primary', { onclick: saveWatch }, 'Save')] : null);
}

function readWatch() {
  const n = (id) => Number(val(id));
  return {
    delayYellowFromMin: n('pl-yellow'), delayRedAboveMin: n('pl-red'), nodeExpected: val('pl-expected'), nodeBlink: val('pl-blink'),
    nodeCheckSec: n('pl-check'),
    spotlight: {
      when: SPOTLIGHT_WHEN.filter((x) => checked(`pl-when-${x.id}`)).map((x) => x.id),
      perClusterSec: n('pl-persec'), leaveAfterMin: n('pl-leave'), whenEmpty: val('pl-empty'),
    },
  };
}

async function saveWatch() {
  const w = readWatch();
  const problems = watchProblems(w);
  if (problems.length) { pl.note = { text: problems.join(' '), cls: 'banner err' }; toast(problems[0], 'err', 6000); pl.redraw(); return; }
  const r = await playConfigSet({ watch: watchPayload(w, locked()) });
  if (!r.ok) { pl.note = { text: `Not saved: ${r.message || 'refused'}`, cls: 'banner err' }; toast(`Not saved: ${r.message || 'refused'}`, 'err', 7000); pl.redraw(); return; }
  pl.note = { text: 'Saved.', cls: 'banner' };
  toast('Watch rules saved', 'ok', 3000);
  reload();
}

/* ------------------------------- exclusions ----------------------------------- */

function excludedCard() {
  const admin = isAdmin();
  const list = (pl.cfg && pl.cfg.exclude) || [];
  const left = new Set(list.map((x) => x.clusterId));
  const rows = list.map((x) => {
    const fixed = x.managed === true || x.reason === 'set in config.txt';
    return h('tr',
      h('td', { style: { fontWeight: 620 } }, nameOf(x.clusterId)),
      h('td', x.reason || ''),
      h('td.muted', x.by ? `excluded by ${x.by}${x.at ? ` on ${dt(ms(x.at))}` : ''}` : ''),
      h('td', fixed ? h('span.muted', MANAGED_NOTE)
        : admin ? h('button.btn.sm.pl-include', { onclick: () => include(x) }, 'Include again') : null));
  });
  const pick = sel('pl-ex-cluster', '', [['', 'Choose a cluster…'], ...clusters().filter((c) => !left.has(c.id)).map((c) => [c.id, c.name])]);
  return card('Excluded clusters', 'left out of every slide, count and total on every display', h('div', { style: { display: 'grid', gap: '8px' } },
    admin && !pl.unknown ? h('div.pl-exclude', pick,
      h('input#pl-ex-reason', { type: 'text', placeholder: 'Reason (required)', 'aria-label': 'Reason', style: { flex: '1 1 220px' } }),
      h('button#pl-exclude.btn.sm.danger', { onclick: exclude }, 'Exclude from Play')) : null,
    pl.exNote ? note(pl.exNote, 'banner err') : null,
    h('div.tbl-wrap', table(['Cluster', 'Reason', 'Who and when', ''], rows.length ? rows
      : [h('tr', h('td.muted', { colSpan: 4 }, 'No cluster is excluded'))]))));
}

async function exclude() {
  const r = excludeAdd(val('pl-ex-cluster'), val('pl-ex-reason'));
  if (r.problem) { pl.exNote = r.problem; toast(r.problem, 'warn', 5000); pl.redraw(); return; }
  const res = await playConfigSet({ exclude: r.exclude });
  if (!res.ok) { pl.exNote = `Not excluded: ${res.message || 'refused'}`; pl.redraw(); return; }
  pl.exNote = '';
  toast(`${nameOf(r.exclude.add.clusterId)} left out of Play`, 'ok', 3500);
  reload();
}

async function include(x) {
  const res = await playConfigSet({ exclude: { remove: x.clusterId } });
  if (!res.ok) { pl.exNote = `Not included: ${res.message || 'refused'}`; pl.redraw(); return; }
  pl.exNote = '';
  toast(`${nameOf(x.clusterId)} is back in Play`, 'ok', 3500);
  reload();
}

/* --------------------------------- the section -------------------------------- */

export function playSection() {
  return h('div', { style: { display: 'grid', gap: '12px' } }, displaysCard(),
    pl.unknown ? null : watchCard(), pl.unknown ? null : excludedCard());
}
