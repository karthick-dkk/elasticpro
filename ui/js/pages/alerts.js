/** Page — everything currently wrong across the fleet, in one place. */

import { h, mount, $, tooltip } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { ago, dt, toCsv, download, num } from '../lib/fmt.js';
import { state, bus, alerts, cachedAlerts, clusters, activeClusters, client, fetchOverview, refreshAll, clusterRev } from '../core/state.js';
import { card, collapsible, pill, statTile, table, empty, connectionBanner } from './common.js';
import { hbarList, legend, gauge, STATUS } from '../lib/charts.js';
import { navigateTo } from '../core/intent.js';
import { rowMenu, ICON, popover, toast, closePopover } from '../ui/menu.js';
import { confirmDialog, inputDialog } from '../ui/modal.js';
import {
  loadAcks, loadCurrentUser, currentUser, setCurrentUser, ackFor, isAcked, noteCount,
  acknowledge, unacknowledge, addNote, removeNote, pruneAcks,
} from '../core/acks.js';
import { pageForProblem } from '../core/alert-rules.js';
import { ruleOf } from '../core/zabbix-alerts.js';

let host = null;
const ui = { level: 'all', cluster: 'all', text: '', show: 'open', view: 'table' };

/**
 * What kind of problem this is, taken from the alert key rather than its wording — the
 * title carries live numbers, the key does not.
 */
const KIND_LABEL = {
  unreachable: 'Unreachable',
  health: 'Cluster health',
  disk: 'Disk usage',
  ilm: 'ILM errors',
  'slm-mode': 'SLM stopped',
  'slm-fail': 'SLM run failed',
  'slm-stale': 'Snapshot overdue',
};

function kindOf(a) {
  const rest = String(a.key || '').split(':').slice(1).join(':');
  const base = rest.split(':')[0] || 'other';
  const full = rest.startsWith('slm-fail') ? 'slm-fail' : rest.startsWith('slm-stale') ? 'slm-stale' : base;
  return KIND_LABEL[full] || full;
}

export function render(el) {
  host = el;
  el.classList.add('dense');
  // Acknowledgements live on this machine; load them before the first paint so rows do
  // not flicker from unacknowledged to acknowledged.
  Promise.all([loadAcks(), loadCurrentUser()])
    .then(() => { pruneAcks(alerts().map((a) => a.key)); draw(); })
    .catch(() => {});
  draw();
}
export function onData() { if (host && host.isConnected) draw(); }

const PAGE_LABEL = { snapshots: 'Snapshots & SLM', indices: 'Indices', shards: 'Shards', logs: 'Log delay',
  volume: 'Volume report', automation: 'Automation', overview: 'Clusters' };

/** Which page answers this alert. The mapping is the rule registry's — see pageForProblem. */
function routeFor(a) {
  const page = pageForProblem(ruleOf(a), `${a.title} ${a.detail || ''}`);
  return { page, label: PAGE_LABEL[page] || page };
}

function filtered(all) {
  let rows = all;
  if (ui.level !== 'all') rows = rows.filter((a) => (ui.level === 'critical' ? a.level === 'critical' : a.level !== 'critical'));
  if (ui.cluster !== 'all') rows = rows.filter((a) => a.cluster && a.cluster.id === ui.cluster);
  if (ui.show === 'open') rows = rows.filter((a) => !isAcked(a.key));
  else if (ui.show === 'acked') rows = rows.filter((a) => isAcked(a.key));
  const t = ui.text.trim().toLowerCase();
  if (t) {
    rows = rows.filter((a) => {
      const notes = (ackFor(a.key).notes || []).map((n) => n.text).join(' ');
      return `${a.title} ${a.detail || ''} ${notes}`.toLowerCase().includes(t);
    });
  }
  // critical first, then by cluster name so a fleet reads consistently
  return [...rows].sort((a, b) => {
    if ((a.level === 'critical') !== (b.level === 'critical')) return a.level === 'critical' ? -1 : 1;
    return String(a.cluster && a.cluster.name).localeCompare(String(b.cluster && b.cluster.name));
  });
}

/**
 * Rows and connection banners kept between redraws (lib/keyed.js): the page redraws on
 * every push from the core, and on a large fleet most alerts and every unreachable
 * cluster's banner are the same from one push to the next.
 */
const built = nodeCache();
const minute = () => Math.floor(Date.now() / 60000);

function draw() {
  built.begin();
  const all = cachedAlerts();
  const rows = filtered(all);
  const crit = all.filter((a) => a.level === 'critical');
  const warn = all.filter((a) => a.level !== 'critical');
  const acked = all.filter((a) => isAcked(a.key));
  const open = all.filter((a) => !isAcked(a.key));
  const byCluster = new Map();
  all.forEach((a) => {
    const k = a.cluster ? a.cluster.id : '?';
    byCluster.set(k, (byCluster.get(k) || 0) + 1);
  });
  const list = clusters();

  mount(host,
    h('div.grid.c4', { style: { marginBottom: '10px' } },
      statTile('Open', num(open.length), open.length ? 'not yet acknowledged' : 'all acknowledged'),
      statTile('Critical', num(crit.filter((a) => !isAcked(a.key)).length), `${num(crit.length)} in total`),
      statTile('Acknowledged', num(acked.length), acked.length ? 'seen, still active' : 'none'),
      statTile('Clusters affected', num(byCluster.size), `of ${num(list.length)} configured`)),

    h('div', { style: { marginBottom: '10px' } }, statsCard(all, crit, warn, open, acked, byCluster, list)),

    h('div.toolbar',
      h('label.field', 'Level', (() => {
        const s = h('select', { onchange: (e) => { ui.level = e.target.value; draw(); } },
          h('option', { value: 'all' }, `Any (${all.length})`),
          h('option', { value: 'critical' }, `Critical (${crit.length})`),
          h('option', { value: 'warning' }, `Warning (${warn.length})`));
        s.value = ui.level; return s;
      })()),
      h('label.field', 'Cluster', (() => {
        const s = h('select', { onchange: (e) => { ui.cluster = e.target.value; draw(); } },
          h('option', { value: 'all' }, 'All clusters'),
          ...list.map((c) => h('option', { value: c.id }, `${c.name}${byCluster.get(c.id) ? ` (${byCluster.get(c.id)})` : ''}`)));
        s.value = ui.cluster; return s;
      })()),
      h('label.field', 'Show', (() => {
        const sel = h('select', { onchange: (e) => { ui.show = e.target.value; draw(); } },
          h('option', { value: 'open' }, `Open (${open.length})`),
          h('option', { value: 'acked' }, `Acknowledged (${acked.length})`),
          h('option', { value: 'all' }, `Everything (${all.length})`));
        sel.value = ui.show; return sel;
      })()),
      h('label.field', 'Search', h('input#alerts-search', { type: 'search', placeholder: 'title, detail or note…', value: ui.text,
        style: { minWidth: '220px' }, oninput: (e) => { ui.text = e.target.value; draw(); } })),
      h('label.field', 'View', (() => {
        const sel = h('select', { onchange: (e) => { ui.view = e.target.value; draw(); } },
          h('option', { value: 'table' }, 'Table'),
          h('option', { value: 'graph' }, 'Graph'),
          h('option', { value: 'both' }, 'Graph + table'));
        sel.value = ui.view; return sel;
      })()),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'flex-end' } },
        h('span.muted', { style: { fontSize: '11.5px' } }, `updated ${ago(state.lastRefresh)}`),
        h('button.btn.sm', { onclick: () => { ui.level = 'all'; ui.cluster = 'all'; ui.text = ''; ui.show = 'open'; draw(); } }, 'Clear'),
        h('button.btn.sm', { onclick: () => refreshAll({ force: true, selected: true }) }, '↻ Refresh'))),

    ui.view !== 'table' && all.length
      ? h('div', { style: { marginTop: '10px' } }, graphView(rows, all))
      : null,

    all.length && ui.view !== 'graph'
      ? h('div', { style: { marginTop: '10px' } },
          card(`Alerts (${rows.length}${rows.length !== all.length ? ` of ${all.length}` : ''})`,
            `${crit.length} critical · ${warn.length} warning · ${acked.length} acknowledged`,
            alertTable(rows),
            [h('button.btn.sm', { onclick: () => exportAlerts(all) }, 'Export CSV')]))
      : null,

    h('div', { style: { marginTop: '10px' } },
      all.length ? null
        : card('Alerts', 'nothing to report',
            h('div', { style: { padding: '26px 0', textAlign: 'center' } },
              h('div', { style: { fontSize: '26px', marginBottom: '6px' } }, '✓'),
              h('div', { style: { fontWeight: 640 } }, 'Every cluster is healthy'),
              h('div.muted', { style: { fontSize: '12.5px', marginTop: '3px' } },
                `No health, disk, ILM or snapshot problem across ${num(list.length)} cluster${list.length === 1 ? '' : 's'}.`)))),

    // The clusters that cannot be reached at all get their decision buttons here too.
    h('div', { style: { marginTop: '14px' } },
      ...activeClusters()
        .filter((c) => { const d = state.data.get(c.id); return d && !d.reachable && d.updatedAt; })
        .map((c) => built.get(`banner:${c.id}`, [clusterRev(c.id), objId(client(c.id)), (client(c.id) || {}).state, objId((client(c.id) || {}).lastError)].join('|'),
          () => connectionBanner(c, () => fetchOverview(c.id))))));
  built.end();
}

/* ---------------------------------- graph view -------------------------------- */

/**
 * Alerts as bars, so a fleet is read at a glance instead of scrolled.
 *
 * Two cuts: one bar per cluster — which client is in trouble — and one per kind of
 * problem — whether it is the same fault everywhere. Both respect the filters above,
 * and a bar is clickable: it narrows the page to that cluster.
 */
/**
 * The shape of what is open, rather than four counts of it.
 *
 * The tiles above answer "how many"; this answers "how bad, where, and what kind" — the
 * three questions asked next. The gauge is the fraction of the fleet currently alerting,
 * which has a real ceiling (every cluster) and so is a position worth drawing rather than
 * a number with an invented maximum.
 */
function statsCard(all, crit, warn, open, acked, byCluster, list) {
  const openCrit = crit.filter((a) => !isAcked(a.key)).length;
  const affected = byCluster.size;
  const total = list.length || 1;

  // Kind is the first word of the alert key after the cluster id — the family it came
  // from — which is how "everything is snapshots" becomes visible at a glance.
  const kinds = new Map();
  for (const a of open) {
    const k = String(a.key).split(':')[1] || 'other';
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  const byKind = [...kinds.entries()].sort((a, b) => b[1] - a[1]);

  const worst = [...byCluster.entries()]
    .map(([id, n]) => ({ name: (list.find((c) => c.id === id) || {}).name || id, n }))
    .sort((a, b) => b.n - a.n).slice(0, 6);

  return card('Alert statistics', `${num(open.length)} open · ${num(acked.length)} acknowledged`,
    h('div', { style: { display: 'flex', gap: '22px', flexWrap: 'wrap', alignItems: 'flex-start' } },
      gauge(affected, total, {
        label: 'clusters alerting',
        sub: `of ${num(total)}`,
        format: (v) => String(num(v)),
        color: openCrit ? STATUS.critical : affected ? STATUS.warning : STATUS.good,
      }),
      gauge(openCrit, Math.max(1, open.length), {
        label: 'of open are critical',
        sub: open.length ? `of ${num(open.length)}` : 'none open',
        format: (v) => String(num(v)),
        color: openCrit ? STATUS.critical : STATUS.good,
      }),
      h('div', { style: { flex: '1 1 260px', minWidth: '240px' } },
        h('div.muted', { style: { fontSize: '11px', marginBottom: '4px' } }, 'open alerts by kind'),
        byKind.length
          ? hbarList(byKind.map(([k, n]) => ({
              key: k, label: k.replace(/-/g, ' '), value: n,
              color: k.includes('health') || k.includes('master') ? STATUS.critical : STATUS.warning,
            })), { format: (v) => num(v), topN: 6, labelWidth: 130, showOther: false })
          : h('div.tbl-empty', 'nothing open')),
      h('div', { style: { flex: '1 1 220px', minWidth: '200px' } },
        h('div.muted', { style: { fontSize: '11px', marginBottom: '4px' } }, 'clusters with the most'),
        worst.length
          ? hbarList(worst.map((w) => ({ key: w.name, label: w.name, value: w.n })),
              { format: (v) => num(v), topN: 6, labelWidth: 120, showOther: false })
          : h('div.tbl-empty', 'none affected'))));
}

function graphView(rows, all) {
  const worst = (list) => (list.some((a) => a.level === 'critical') ? 'var(--critical)' : 'var(--warning)');

  const byCluster = new Map();
  for (const a of rows) {
    const name = a.cluster ? a.cluster.name : 'unknown';
    if (!byCluster.has(name)) byCluster.set(name, { id: a.cluster && a.cluster.id, list: [] });
    byCluster.get(name).list.push(a);
  }

  const clusterItems = [...byCluster.entries()].map(([name, v]) => {
    const crit = v.list.filter((a) => a.level === 'critical').length;
    const ackd = v.list.filter((a) => isAcked(a.key)).length;
    return {
      key: v.id || name, label: name, value: v.list.length, color: worst(v.list),
      sub: [crit ? `${crit} critical` : null,
            v.list.length - crit ? `${v.list.length - crit} warning` : null,
            ackd ? `${ackd} acknowledged` : null].filter(Boolean).join(' · '),
    };
  });

  const byKind = new Map();
  for (const a of rows) {
    const k = kindOf(a);
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(a);
  }
  const kindItems = [...byKind.entries()].map(([label, list]) => ({
    key: label, label, value: list.length, color: worst(list),
    sub: [...new Set(list.map((a) => (a.cluster ? a.cluster.name : '?')))].slice(0, 4).join(', '),
  }));

  const scale = legend([
    { label: 'has a critical alert', color: 'var(--critical)' },
    { label: 'warnings only', color: 'var(--warning)' },
  ]);

  return h('div.grid.c2',
    card('Alerts by cluster', `${clusterItems.length} cluster${clusterItems.length === 1 ? '' : 's'} · click a bar to filter`,
      clusterItems.length
        ? h('div', hbarList(clusterItems, {
            format: (v) => String(v), topN: 24, labelWidth: 170, showOther: false,
            onSelect: (r) => { ui.cluster = ui.cluster === r.key ? 'all' : r.key; draw(); },
          }), scale)
        : empty('Nothing matches the filter')),
    card('Alerts by kind', 'the same fault across the fleet, or different ones',
      kindItems.length
        ? hbarList(kindItems, { format: (v) => String(v), topN: 16, labelWidth: 170, showOther: false })
        : empty('Nothing matches the filter')));
}

/** Ask who is acknowledging, once per machine. */
async function ensureUser() {
  if (currentUser()) return currentUser();
  const name = await inputDialog('Who is acknowledging?',
    'Your name or initials — recorded against acknowledgements and notes on this machine', '', { yes: 'Save' });
  if (name && name.trim()) await setCurrentUser(name);
  return currentUser();
}

async function doAck(a) {
  await ensureUser();
  await acknowledge(a.key);
  draw();
}

async function doUnack(a) {
  const ok = await confirmDialog(`Re-open ${a.title}?`,
    'The alert goes back to the open list. Notes written against it are kept.',
    { yes: 're-open' });
  if (!ok) return;
  await unacknowledge(a.key);
  draw();
}

/**
 * Notes on one alert, in a panel anchored to the button that opened it.
 *
 * This used to be a row spliced into the table, which pushed everything below it down
 * the page for the sake of two lines of text. Anchored, it costs no layout at all and
 * dismisses itself on Escape or a click anywhere else.
 */
function openNotes(trigger, a) {
  popover(trigger, (ctx) => {
    const rec = ackFor(a.key);
    const notes = (rec.notes || []).slice().sort((x, y) => x.ts - y.ts);

    const input = h('input#note-input', {
      type: 'text', placeholder: 'What was found, who is on it, ticket number…',
      style: { flex: '1', minWidth: '190px' },
      onkeydown: async (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        await saveNote(a, e.target.value);
        ctx.rebuild();
      },
    });

    return h('div', { style: { display: 'grid', gap: '7px' } },
      rec.acked
        ? h('div.muted', { style: { fontSize: '11px' } },
            `Acknowledged by ${rec.ackedBy || 'operator'} ${ago(rec.ackedAt)}`)
        : null,
      notes.length
        ? h('div', { style: { display: 'grid', gap: '4px' } }, ...notes.map((n) =>
            h('div.note',
              h('b', n.by || 'operator'), h('span.when', { title: dt(n.ts) }, ago(n.ts)),
              h('div', n.text),
              h('button.btn.sm.ghost', {
                style: { padding: '0 5px', fontSize: '11px' },
                title: 'Remove this note',
                onclick: async () => {
                  if (await confirmDialog('Remove this note?', n.text, { yes: 'remove', danger: true })) {
                    await removeNote(a.key, n.ts);
                    ctx.rebuild();
                    draw();
                  }
                },
              }, ICON.delete))))
        : h('div.muted', { style: { fontSize: '11.5px' } }, 'No notes yet.'),
      h('div', { style: { display: 'flex', gap: '6px' } },
        input,
        h('button.btn.sm.primary', {
          onclick: async () => {
            const box = $('#note-input');
            if (!box || !box.value.trim()) return;
            await saveNote(a, box.value);
            ctx.rebuild();
          },
        }, 'Add')));
  }, {
    title: `Notes — ${a.cluster ? a.cluster.name : ''}`,
    sub: a.title,
    width: '340px',
    // The count on the button changes, so the row behind it has to be redrawn.
    onClose: () => draw(),
  });
}

async function saveNote(a, text) {
  await ensureUser();
  await addNote(a.key, text);
  toast('Note added');
}

/** A read-only peek, so notes can be read without opening anything. */
function notePeek(el, a) {
  const notes = (ackFor(a.key).notes || []).slice().sort((x, y) => y.ts - x.ts);
  if (!notes.length) return;
  // Built once and reused: the shared tooltip re-parents whatever it is given, so a
  // fresh node per mousemove would rebuild this on every pixel.
  const tip = h('div', { style: { display: 'grid', gap: '4px', maxWidth: '320px' } },
    ...notes.slice(0, 4).map((n) => h('div',
      h('b', n.by || 'operator'), h('span.muted', { style: { marginLeft: '5px' } }, ago(n.ts)),
      h('div', { style: { fontSize: '11.5px' } }, n.text))),
    notes.length > 4 ? h('div.muted', { style: { fontSize: '11px' } }, `…and ${notes.length - 4} more`) : null,
    h('div.muted', { style: { fontSize: '10.5px', marginTop: '2px' } }, 'click to add or remove'));
  const show = (e) => tooltip.show(tip, e.clientX, e.clientY);
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', show);
  el.addEventListener('mouseleave', () => tooltip.hide());
  // Opening the panel must not leave the peek hanging over it.
  el.addEventListener('click', () => tooltip.hide());
}

function alertTable(rows) {
  const trs = [];
  rows.forEach((a) => {
    const rec = ackFor(a.key);
    const notes = noteCount(a.key);
    const sig = [a.level, a.title, a.detail, a.cluster && a.cluster.id, objId(a.cluster), a.snapshot ? [a.snapshot.id, a.snapshot.repo, a.snapshot.status, a.snapshot.at, a.snapshot.isNew].join('/') : '', a.failingSince || 0,
      JSON.stringify(rec), notes, minute()].join('\u0001');
    trs.push(built.get(`row:${a.key}`, sig, () => alertRow(a, rec, notes)));
  });
  return table(['Level', 'Cluster', 'Alert', 'Detail', 'Snapshot', 'State', 'Notes', ''], trs,
    { emptyText: ui.show === 'open' ? 'Nothing open — every alert here is acknowledged.' : 'No alert matches the filter' });
}

function alertRow(a, rec, notes) {
    const r = routeFor(a);
    const acked = !!rec.acked;
    return h(`tr${acked ? '.ack-row' : ''}`,
      h('td', pill(a.level === 'critical' ? 'critical' : 'warning', a.level === 'critical' ? 'red' : 'yellow')),
      h('td', h('div', { style: { fontWeight: 620 } }, a.cluster ? a.cluster.name : '–'),
        a.cluster ? h('div.mono.muted', { style: { fontSize: '11px' } }, a.cluster.url) : null),
      h('td', h('div', a.title),
        acked ? h('div.muted', { style: { fontSize: '10.5px' } },
          `ack ${rec.ackedBy || 'operator'} · ${ago(rec.ackedAt)}`) : null),
      h('td.muted', { style: { fontSize: '12px', maxWidth: '360px', wordBreak: 'break-word' } }, a.detail || ''),
      h('td', snapshotCell(a)),
      h('td', acked ? pill('acknowledged', 'grey') : pill('open', a.level === 'critical' ? 'red' : 'yellow')),
      h('td', (() => {
        const btn = h('button.btn.sm.ghost', {
          title: notes ? `${notes} note(s) — click to add or remove` : 'Add a note',
          onclick: (e) => { e.stopPropagation(); openNotes(btn, a); },
        }, `💬 ${notes || ''}`.trim());
        notePeek(btn, a);          // hover reads them; click edits them
        return btn;
      })()),
      h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
        acked
          ? h('button.btn.sm', { title: 'Put it back on the open list', onclick: () => doUnack(a) }, 'Re-open')
          : h('button.btn.sm.primary', { title: 'Mark as seen — it stays until the condition clears', onclick: () => doAck(a) }, 'ACK'),
        rowMenu([
          { label: 'Notes & comments…', icon: '💬',
            onClick: (e) => openNotes(e.target.closest('button') || e.target, a) },
          { label: `Go to ${r.label}`, icon: ICON.console,
            onClick: () => navigateTo(r.page, null, { cluster: a.cluster ? a.cluster.id : null }) },
          { sep: true },
          { hint: `key: ${a.key}` },
        ], { title: `Actions for ${a.title}` }))));
}

/**
 * The snapshot an alert is about: which repository, when it ran, and whether that counts
 * as recent.
 *
 * In its own column rather than inside the sentence. "Is the backup current" is the
 * question this page gets asked most, and an answer that has to be read out of prose in a
 * detail cell is one nobody reads. Blank for every alert that is not about a snapshot —
 * most of them.
 */
function snapshotCell(a) {
  const s = a.snapshot;
  if (!s) return h('span.muted', '–');
  return h('div', { style: { display: 'grid', gap: '2px', minWidth: '150px' } },
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
      pill(s.isNew ? 'new' : 'not new', s.isNew ? 'green' : 'yellow'),
      h('span.mono', { style: { fontSize: '11px' } }, s.status || '')),
    h('div.muted', { style: { fontSize: '11px' }, title: `${s.id} in ${s.repo}` },
      `${dt(s.at)} · ${s.repo}`),
    a.failingSince
      ? h('div', { style: { fontSize: '11px', color: 'var(--critical)' } },
          `failing since ${dt(a.failingSince)}`)
      : null);
}

function exportAlerts(all) {
  download(`es-alerts-${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(all.map((a) => {
      const rec = ackFor(a.key);
      return {
        level: a.level,
        cluster: a.cluster ? a.cluster.name : '',
        url: a.cluster ? a.cluster.url : '',
        alert: a.title,
        detail: a.detail || '',
        repository: a.snapshot ? a.snapshot.repo : '',
        snapshot: a.snapshot ? a.snapshot.id : '',
        snapshot_date: a.snapshot ? new Date(a.snapshot.at).toISOString() : '',
        snapshot_status: a.snapshot ? a.snapshot.status : '',
        snapshot_is_new: a.snapshot ? (a.snapshot.isNew ? 'yes' : 'no') : '',
        failing_since: a.failingSince ? new Date(a.failingSince).toISOString() : '',
        state: rec.acked ? 'acknowledged' : 'open',
        acknowledged_by: rec.ackedBy || '',
        acknowledged_at: rec.ackedAt ? new Date(rec.ackedAt).toISOString() : '',
        notes: (rec.notes || []).map((n) => `[${new Date(n.ts).toISOString().slice(0, 16)} ${n.by}] ${n.text}`).join(' | '),
        key: a.key,
        observed_at: new Date(state.lastRefresh || Date.now()).toISOString(),
      };
    })), 'text/csv');
}
