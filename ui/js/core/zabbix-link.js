/**
 * Config → Zabbix, the arithmetic: what the form sends, what the status panel says, how
 * long a pairing code has left. No DOM and no network, so tools/unit covers it.
 *
 * The core is the authority on every rule here (crates/elasticpro-core/src/zbx_link.rs). These
 * checks exist to say "that is not a URL" before a round trip, never to decide anything
 * the core would decide differently — the core validates again and its answer wins.
 */

/** The fields the server's own configuration can own. Wire names. */
export const LINK_FIELDS = ['zabbixUrl', 'apiUrl', 'apiToken', 'ssoSecret', 'verifyTls', 'allowedSources', 'syncSecs'];
export const MIN_SYNC_SECS = 30;
export const MAX_SYNC_SECS = 86400;

/** `https://zbx.example.com/` → `https://zbx.example.com/api_jsonrpc.php`. */
export function defaultApiUrl(zabbixUrl) {
  const u = String(zabbixUrl || '').trim().replace(/\/+$/, '');
  return u ? `${u}/api_jsonrpc.php` : '';
}

/**
 * An address as the core will accept it: absolute http(s), no credentials, no query.
 * Returns `{ ok, value, error }` with `value` normalised (no trailing slash).
 */
export function checkUrl(raw, allowHttp = false) {
  const t = String(raw || '').trim();
  if (!t) return { ok: false, value: '', error: 'required' };
  let u;
  try { u = new URL(t); } catch { return { ok: false, value: t, error: 'not an absolute URL (https://…)' }; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttp)) {
    return { ok: false, value: t, error: u.protocol === 'http:' ? 'plain http — use https, or allow plain http for a lab' : `scheme must be https, not ${u.protocol.replace(':', '')}` };
  }
  if (!u.hostname) return { ok: false, value: t, error: 'no host' };
  if (u.username || u.password) return { ok: false, value: t, error: 'must not carry a user name or password' };
  if (u.search || u.hash) return { ok: false, value: t, error: 'must not carry a query string or fragment' };
  return { ok: true, value: t.replace(/\/+$/, ''), error: '' };
}

/** One IPv4/IPv6 address or CIDR. Loose on purpose; the core parses it properly. */
export function looksLikeSource(s) {
  const t = String(s || '').trim();
  const m = t.match(/^([^/]+)(?:\/(\d{1,3}))?$/);
  if (!m) return false;
  const [, ip, len] = m;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) && (len === undefined || Number(len) <= 32);
  if (/^[0-9a-fA-F:.]+$/.test(ip) && ip.includes(':')) return len === undefined || Number(len) <= 128;
  return false;
}

/** The allowed-sources box → `{ list, bad }`. Commas, spaces or new lines separate. */
export function parseSources(text) {
  const list = String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return { list, bad: list.filter((s) => !looksLikeSource(s)) };
}

/** Seconds left on a pairing code, never negative. `exp` in unix seconds. */
export function secondsLeft(exp, nowMs = Date.now()) {
  return Math.max(0, Math.floor(Number(exp || 0) - nowMs / 1000));
}

/** `14:59`, or `expired`. */
export function countdown(exp, nowMs = Date.now()) {
  const s = secondsLeft(exp, nowMs);
  if (!s) return 'expired';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Whether the server's configuration owns a field. */
export function isManaged(status, field) {
  return !!(status && status.managed && status.managed[field]);
}

/**
 * What ZABBIX_LINK_SET should carry for this form: only fields that changed, never one the
 * server owns, never the token unless a new one was typed. `form` holds the inputs'
 * values: `{ zabbixUrl, apiUrl, apiToken, verifyTls, allowHttp, allowedSources, syncSecs }`
 * (strings, except the two booleans). An API URL equal to the default is sent as empty,
 * so it keeps following the Zabbix URL.
 */
export function linkChanges(status, form) {
  const s = status || {};
  const out = {};
  const put = (k, v) => { if (!isManaged(s, k)) out[k] = v; };
  if (!!form.allowHttp !== !!s.allowHttp) out.allowHttp = !!form.allowHttp;
  const zu = String(form.zabbixUrl || '').trim().replace(/\/+$/, '');
  if (zu !== (s.zabbixUrl || '')) put('zabbixUrl', zu);
  const au = String(form.apiUrl || '').trim().replace(/\/+$/, '');
  const effectiveZ = isManaged(s, 'zabbixUrl') ? (s.zabbixUrl || '') : zu;
  const wantApi = au === defaultApiUrl(effectiveZ) ? '' : au;
  const haveApi = s.apiUrlIsDefault ? '' : (s.apiUrl || '');
  if (wantApi !== haveApi) put('apiUrl', wantApi);
  const tok = String(form.apiToken || '').trim();
  if (tok) put('apiToken', tok);
  if (form.verifyTls !== undefined && !!form.verifyTls !== (s.verifyTls !== false)) put('verifyTls', !!form.verifyTls);
  const src = parseSources(form.allowedSources).list;
  if (src.join(',') !== (s.allowedSources || []).join(',')) put('allowedSources', src);
  const secs = Number(String(form.syncSecs || '').trim());
  if (String(form.syncSecs || '').trim() && secs !== Number(s.syncSecs)) put('syncSecs', secs);
  return out;
}

/** Problems with the form before it is sent, as `{ field: message }`. Empty = fine. */
export function formProblems(status, form) {
  const p = {};
  const allow = !!form.allowHttp;
  if (!isManaged(status, 'zabbixUrl') && String(form.zabbixUrl || '').trim()) {
    const c = checkUrl(form.zabbixUrl, allow);
    if (!c.ok) p.zabbixUrl = c.error;
  }
  if (!isManaged(status, 'apiUrl') && String(form.apiUrl || '').trim()) {
    const c = checkUrl(form.apiUrl, allow);
    if (!c.ok) p.apiUrl = c.error;
  }
  const tok = String(form.apiToken || '').trim();
  if (tok && !/^[A-Za-z0-9\-._~+/=]{16,512}$/.test(tok)) p.apiToken = '16–512 characters of letters, digits and - . _ ~ + / =';
  const { bad } = parseSources(form.allowedSources);
  if (bad.length) p.allowedSources = `not an IP address or CIDR: ${bad.join(', ')}`;
  const raw = String(form.syncSecs || '').trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < MIN_SYNC_SECS || n > MAX_SYNC_SECS) p.syncSecs = `a whole number of seconds, ${MIN_SYNC_SECS}–${MAX_SYNC_SECS}`;
  }
  return p;
}

/**
 * Whether Config → Zabbix shows the setup form or a "Current settings" summary.
 *
 * First-time (nothing configured, or only a pairing in progress) → 'setup': the form is
 * the only way forward, so show it. Once something is connected — paired, or a token/secret
 * set up by hand, or by the server's own configuration — the page shows a summary instead;
 * the form is then reached only through "Edit settings". A card the caller cannot read yet
 * (loading) or that is not available on this edition is neither: callers check those first.
 */
export function linkView(status) {
  const s = status || {};
  if (s.paired) return 'summary';
  const sync = s.sync || {};
  if (sync.configured || (s.ssoSecret && s.ssoSecret.set) || (s.apiToken && s.apiToken.set)) return 'summary';
  return 'setup';
}

/**
 * The status panel's headline: `{ tone, title, detail }` where tone is a pill colour.
 * Unknown is not zero — a link that has never synced says so rather than "0 clusters".
 */
export function linkSummary(status, nowSec = Date.now() / 1000) {
  const s = status || {};
  if (!s.supported) return { tone: 'grey', title: 'not available', detail: 'The Zabbix connection is configured on the hosted edition.' };
  const sync = s.sync || {};
  const syncLine = sync.error ? `last sync failed: ${sync.error}`
    : sync.lastOk ? `last sync OK — ${sync.clusters} cluster host${sync.clusters === 1 ? '' : 's'}${sync.skipped ? `, ${sync.skipped} skipped` : ''}`
      : sync.configured ? 'not synced yet' : 'not syncing — no API address and token yet';
  if (s.pending && Number(s.pending.exp) > nowSec) {
    return { tone: 'yellow', title: 'pairing in progress', detail: `waiting for Zabbix (${s.pending.zabbixUrl}) — code expires in ${countdown(s.pending.exp, nowSec * 1000)}` };
  }
  if (s.paired) {
    return { tone: sync.error ? 'red' : 'green', title: `paired with ${s.zabbixUrl || 'Zabbix'}`,
      detail: [s.zabbixVersion ? `Zabbix ${s.zabbixVersion}` : null, syncLine].filter(Boolean).join(' · ') };
  }
  if (sync.configured || (s.ssoSecret && s.ssoSecret.set)) {
    const src = (s.ssoSecret && s.ssoSecret.source === 'server') || (s.apiToken && s.apiToken.source === 'server') ? 'server configuration' : 'this page';
    return { tone: sync.error ? 'red' : 'green', title: `connected (set up in ${src})`, detail: syncLine };
  }
  return { tone: 'grey', title: 'not connected', detail: 'Enter the Zabbix URL, then Pair with Zabbix.' };
}

/** A line for a ZABBIX_LINK_TEST answer. */
export function testMessage(res) {
  const r = res || {};
  if (r.ok) return r.message || `Zabbix ${r.version || ''} answers and the token works`;
  const why = {
    dns: 'The Zabbix name does not resolve from the ElasticPro server.',
    timeout: 'No answer in time — a firewall, or the wrong address.',
    connection_refused: 'Connection refused — nothing listens at that address.',
    tls_untrusted: 'The Zabbix certificate is not trusted yet — check it and trust it.',
    tls_pin_mismatch: 'The Zabbix certificate CHANGED since it was trusted. The token was not sent.',
    tls_error: 'TLS failed.',
    auth: 'Zabbix answers, but refused the API token.',
    no_token: 'Zabbix answers; no API token is set yet — pair, or paste one.',
    not_zabbix: 'That address does not answer like the Zabbix API (api_jsonrpc.php).',
    http_error: 'The Zabbix API answered with an HTTP error.',
    not_configured: 'Set the Zabbix URL first.',
  }[r.kind];
  return [why, r.message].filter(Boolean).join(' ');
}

/**
 * The address the Zabbix module should call back, as this browser sees the app:
 * `https://ep.example.com/` → `https://ep.example.com`, `https://h/ep/index.html` →
 * `https://h/ep`. The server's ELASTICPRO_PUBLIC_URL, when set, overrides it in the core.
 */
export function epUrlFrom(loc) {
  const origin = String((loc && loc.origin) || '');
  const dir = String((loc && loc.pathname) || '/').replace(/\/[^/]*$/, '');
  return (origin + dir).replace(/\/+$/, '');
}

/** The action log line for an event from the status. */
export function eventLine(e) {
  const what = { set: 'changed settings', pair_begin: 'started pairing', pair: 'pairing', unpair: 'unpaired' }[e.action] || e.action;
  return `${e.ok ? '' : 'FAILED '}${what} — ${e.by}${e.source ? ` from ${e.source}` : ''}${e.detail ? `: ${e.detail}` : ''}`;
}
