/**
 * Config-Management › Data › Backend: the history store (0.3.53, docs/HISTORY.md): the dedicated Elasticsearch endpoint
 * that keeps ElasticPro's own volume, capacity and delay history.
 *
 * Messages and pure helpers: core/history-store.js. Hosted only: a desktop core answers
 * `supported: false` and the section has no tab. Compact density, no explainer boxes.
 *
 * Secrets are never shown and never pre-filled. An empty password field on save means
 * "keep the one the core holds"; the core says whether one is held (`passwordSet`).
 */

import { h } from '../lib/dom.js';
import { dt, ago } from '../lib/fmt.js';
import { card, table } from '../pages/common.js';
import { field, text, select, val, checked } from './modal.js';
import { toast } from './menu.js';
import {
  AUTH_CHOICES, TLS_CHOICES, STREAMS, DEFAULT_PREFIX, historyGet, historySet, historyTest, historyArm, historyBackfill,
  isSupported, armReason, privilegeLines, testHeadline, testIsStale, secretHint, indexNames, backfillLine,
} from '../core/history-store.js';

const hs = { reply: null, draft: null, redraw: () => {} };

/** Whether the section has a tab: only after the core said it is supported. */
export const historySupported = () => isSupported(hs.reply);

/** The section's load; `redraw` repaints the page. An older core or a desktop one leaves no tab. */
/**
 * `fresh` is called when the form is about to show what the core holds afresh (this load), and
 * not on the card's other redraws (a test, a change of the kind of credential): the page's save
 * bar starts again from it then, and only then.
 */
export async function loadHistoryStore(redraw, fresh) {
  hs.redraw = redraw || hs.redraw;
  const res = await historyGet();
  hs.reply = isSupported(res) ? res : null;
  hs.draft = null;
  if (fresh) fresh();
  hs.redraw();
}

/** What the form shows now: what was typed and not yet saved, else what the core holds. */
const settings = () => hs.draft || (hs.reply && hs.reply.settings) || {};

/** The form as typed. Secrets are read only here, and sent only when non-empty. */
function readForm() {
  const auth = val('hs-auth') || 'basic';
  const out = {
    url: val('hs-url').trim(),
    auth,
    user: auth === 'basic' ? val('hs-user').trim() : '',
    tls: val('hs-tls') || 'auto',
    via: val('hs-via'),
    prefix: val('hs-prefix').trim() || DEFAULT_PREFIX,
    streams: Object.fromEntries(STREAMS.map((s) => [s, checked(`hs-stream-${s}`)])),
  };
  const pw = val('hs-password');
  if (auth === 'basic' && pw) out.password = pw;
  const key = val('hs-apikey');
  if (auth === 'apiKey' && key) out.apiKey = key;
  return out;
}

/** Everything but the secrets, kept across a redraw so a Test press does not lose edits. */
function capture() {
  if (!document.querySelector('#hs-url')) return;
  const { password, apiKey, ...rest } = readForm();
  hs.draft = rest;
}

/** Take a reply from a call: show it, or say why it was refused. */
function take(res, okText) {
  if (res && res.supported !== false && (res.settings || res.status)) hs.reply = { ...res, supported: true };
  if (res && res.ok === false) toast(res.message || 'refused', 'warn', 6000);
  else if (okText) toast(okText, 'ok');
}

const call = async (fn, okText, { keepDraft = true } = {}) => {
  if (keepDraft) capture();
  const res = await fn();
  take(res, okText);
  if (!keepDraft) hs.draft = null;
  hs.redraw();
  return res;
};

const save = () => call(() => historySet(readForm()), 'History store saved', { keepDraft: false });

/** Config-Management's save bar runs this (it was the card's Save). True when the core took it. */
export async function saveHistoryStore() {
  const res = await save();
  return !!res && res.ok !== false;
}

/** The save bar's Discard: forget what was typed; the next draw shows what the core holds. */
export function discardHistoryStore() { hs.draft = null; }

/** Whether Write history is on (for Config-Management's menu). */
export const historyArmed = () => !!(hs.reply && hs.reply.armed);
const test = () => call(() => historyTest(), null);
const backfill = () => call(() => historyBackfill(), 'Copying existing history');
const arm = (on) => call(() => historyArm(on), on ? 'Write history is on' : 'Write history is off');

/** Changing the method swaps which secret field is shown; what was typed elsewhere stays. */
function authSelect(auth) {
  const el = select('hs-auth', auth, AUTH_CHOICES);
  el.onchange = () => { capture(); hs.redraw(); };
  return el;
}

const when = (t) => (t ? `${dt(t)} (${ago(t)})` : '—');
const kv = (k, v) => h('tr.kv', h('td.k', k), h('td.v', v));

export function historyStoreCard({ extraRows = [] } = {}) {
  const r = hs.reply;
  if (!r || !r.supported) return null;
  const s = settings();
  const st = r.status || {};
  const t = r.test || null;
  const reason = armReason(r);
  const armed = !!r.armed;
  const bf = st.backfill || null;
  const auth = s.auth || 'basic';
  const prefix = s.prefix || DEFAULT_PREFIX;
  const streams = s.streams || {};
  const hint = secretHint(r.settings);

  const row = { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'end' } };
  const lines = privilegeLines(t, r.settings && r.settings.prefix);

  return card('Elasticsearch cluster', `optional \u00b7 a dedicated store, never a monitored cluster \u00b7 ${armed ? 'writing' : 'not writing'}`,
    h('div', { style: { display: 'grid', gap: '8px' } },
      h('div', row,
        field('URL', text('hs-url', s.url, { mono: true, placeholder: 'https://history.example:9200', style: { width: '320px' } }),
          'A dedicated store, never a monitored cluster. A password or API key goes only to an https:// address; it is typed again after the address, TLS or kind of credential changes.'),
        field('Auth', authSelect(auth)),
        auth === 'basic' ? field('User', text('hs-user', s.user, { style: { width: '150px' } })) : null,
        auth === 'basic'
          ? field('Password', text('hs-password', '', { type: 'password', placeholder: hint, style: { width: '210px' } }))
          : null,
        auth === 'apiKey'
          ? field('API key', text('hs-apikey', '', { type: 'password', placeholder: hint || '', style: { width: '260px' } }))
          : null),
      h('div', row,
        field('TLS', select('hs-tls', s.tls || 'auto', TLS_CHOICES),
          'A certificate is pinned from Clusters › Jump hosts & trust, as for clusters. The global insecure TLS default does not apply here.'),
        field('Jump host', select('hs-via', s.via || '', [['', 'Direct'], ...(r.jumpHosts || []).map((id) => [id, id])])),
        field('Index prefix', text('hs-prefix', prefix, { mono: true, style: { width: '190px' } }),
          `Indices: ${indexNames(prefix).join(', ')}`)),
      h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', fontSize: '12.5px' } },
        h('span.muted', 'Streams'),
        ...STREAMS.map((k) => h('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center' } },
          h('input', { id: `hs-stream-${k}`, type: 'checkbox', checked: !!streams[k] }), k))),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button.btn', { id: 'hs-test', onclick: test }, 'Test connection'),
        h('span.muted', { style: { fontSize: '11.5px', alignSelf: 'center' } }, 'A dedicated store, never a monitored cluster. Changes wait for the save bar.')),
      t
        ? h('div', { id: 'hs-test-result', style: { fontSize: '12px', display: 'grid', gap: '2px' } },
            h('div', { style: { fontWeight: '600' } }, `Test ${testHeadline(t)}`, h('span.muted', { style: { fontWeight: '400' } }, t.at ? ` · ${when(t.at)}` : '')),
            ...lines.map((l) => h('div.mono.muted', l)),
            testIsStale(t) ? h('div.muted', 'The settings changed since this test: test again.') : null)
        : null,
      h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', fontSize: '12.5px' } },
        h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
          h('input', {
            id: 'hs-arm', type: 'checkbox', checked: armed, disabled: !!reason, 'data-untracked': '',
            onchange: (e) => arm(!!e.target.checked),
          }), h('b', 'Write history')),
        reason ? h('span.muted', { id: 'hs-arm-reason', style: { fontSize: '12px' } }, reason) : null,
        h('button.btn.sm', {
          id: 'hs-backfill', disabled: !armed || !!(bf && bf.running), onclick: backfill,
          title: armed ? 'Copy what the daily and monthly records already hold into the store' : 'Switch Write history on first',
        }, 'Copy existing history'),
        bf && backfillLine(bf) ? h('span.muted', { id: 'hs-backfill-line', style: { fontSize: '12px' } }, backfillLine(bf)) : null),
      table([], [
        kv('Last success', when(st.lastSuccessAt)),
        kv('Last error', st.lastError ? `${st.lastError}${st.lastErrorAt ? ` · ${when(st.lastErrorAt)}` : ''}` : '—'),
        kv('Documents written', String(st.docsWritten || 0)),
        kv('Queued', String(st.queue || 0)),
        (st.refused || st.rejected || st.dropped)
          ? kv('Not sent', `${st.refused || 0} refused by the guard · ${st.rejected || 0} rejected by the store · ${st.dropped || 0} dropped (queue full)`)
          : null,
        kv('Template created', when(st.templateAt)),
        ...extraRows.map(([k, v]) => kv(k, v)),
      ]),
      h('div.muted', { style: { fontSize: '11.5px' } },
        'Retention of the store’s indices is the store owner’s: ElasticPro creates an index template (mappings only) '
        + 'and writes documents; it never deletes indices or changes ILM on the store.')));
}
