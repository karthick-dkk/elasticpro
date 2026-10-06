/**
 * Running inside Zabbix.
 *
 * The ElasticPro module in Zabbix loads this app in a frame as
 *
 *   https://<host>/?sso_code=<one-time>&embed=1&zbx_theme=dark-theme#/indices
 *
 * and three things follow from that URL:
 *
 * * `sso_code` is traded for a session before anything else happens, then removed from
 *   the address bar. It is spent on first use either way, but a code left in the URL is
 *   one that ends up in history, in a bookmark, or pasted into a ticket.
 * * `embed=1` drops what Zabbix already provides — who you are and signing out. Signing
 *   out of a frame would leave an ElasticPro login screen inside a Zabbix page, asking for
 *   a password that a Zabbix account does not have.
 * * `zbx_theme` follows the Zabbix user's theme, without saving it over the one chosen
 *   in this app when it is opened on its own.
 *
 * Pure apart from `exchangeCode`, which takes its transport as a parameter.
 */

/**
 * A value Zabbix filled in, or '' when it could not.
 *
 * An unresolvable macro does not come through empty: a user macro the host does not
 * define stays as its own text (`{$GRP.CLIENT}`), and an event tag the problem does not
 * carry becomes `*UNKNOWN*`. Either would otherwise be matched against cluster names.
 */
export function macroValue(v) {
  const s = String(v || '').trim();
  if (!s || s === '*UNKNOWN*' || /^\{[^}]*\}$/.test(s)) return '';
  return s.slice(0, 255);
}

/** What the launch URL asks for. */
export function readLaunch(loc) {
  const q = new URLSearchParams((loc && loc.search) || '');
  return {
    code: (q.get('sso_code') || '').trim(),
    embed: q.get('embed') === '1',
    zabbixTheme: (q.get('zbx_theme') || '').trim(),
    // "Troubleshoot in ElasticPro" on a Zabbix problem: which host raised it, the
    // client it belongs to, the ElasticPro rule behind it (when it is one of ours) and
    // what Zabbix called it. See `troubleshootTarget`.
    trouble: {
      host: macroValue(q.get('zbx_host')),
      client: macroValue(q.get('client')),
      rule: macroValue(q.get('rule')),
      problem: macroValue(q.get('problem')),
    },
  };
}

/**
 * Where a Zabbix problem should land: the cluster it is about and the page that answers
 * it. Null when the launch was not a troubleshoot link, or named nothing this person can
 * see — the app then opens where it would have anyway, rather than on a guess.
 *
 * The host decides the cluster. A cluster read from Zabbix knows its host; a config-file
 * cluster pushed to Zabbix was created under its own name. The client is the fallback,
 * for a problem raised on a forwarder or parser host rather than on the cluster itself,
 * and only when it names exactly one cluster.
 *
 * `pageFor(rule, text)` is passed in (alert-rules.js's pageForProblem) so this stays pure.
 */
export function troubleshootTarget(trouble, clusters, pageFor) {
  const t = trouble || {};
  if (!t.host && !t.client && !t.rule && !t.problem) return null;
  const list = clusters || [];
  const low = (s) => String(s || '').toLowerCase();
  let cluster = null;
  if (t.host) {
    cluster = list.find((c) => c.zabbix && low(c.zabbix.host) === low(t.host))
      || list.find((c) => low(c.name) === low(t.host))
      || null;
  }
  if (!cluster && t.client) {
    const mine = list.filter((c) => (c.zabbix && low(c.zabbix.client) === low(t.client))
      || (c.tags || []).some((g) => low(g) === low(t.client)));
    if (mine.length === 1) [cluster] = mine;
  }
  const page = pageFor(t.rule, t.problem);
  if (!cluster && !t.rule && !t.problem) return null;
  return { page, cluster: cluster ? cluster.id : null };
}

/**
 * The same URL without the sign-in code, for `history.replaceState`. Everything else —
 * the embed flag, the theme, the page in the hash — is kept, because a reload inside the
 * frame should come back to the same place in the same shape.
 */
export function withoutCode(href) {
  return without(href, ['sso_code']);
}

/**
 * The same URL without the troubleshoot request, once it has been acted on. Left in, it
 * would pull the person back to that cluster and page every time the app starts again in
 * this frame, long after they had moved on from the problem.
 */
export const TROUBLE_PARAMS = ['zbx_host', 'client', 'rule', 'problem'];
export function withoutTrouble(href) {
  return without(href, TROUBLE_PARAMS);
}

function without(href, names) {
  const u = new URL(href);
  for (const n of names) u.searchParams.delete(n);
  return u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + u.hash;
}

/**
 * This app's theme for a Zabbix one, or null to keep whatever this app would use.
 *
 * `default` in Zabbix means "whatever the Zabbix administrator set as the default", which
 * a frame cannot see; guessing would be wrong half the time, so it is left alone.
 */
export function themeFor(zabbixTheme) {
  switch (zabbixTheme) {
    case 'dark-theme':
    case 'hc-dark':
      return 'dark';
    case 'blue-theme':
    case 'hc-light':
      return 'light';
    default:
      return null;
  }
}

/**
 * Where the tab remembers the theme Zabbix asked for. Frames within one tab share
 * sessionStorage, so every later Zabbix page load can paint in it before any script runs
 * — see the one-line reader in index.html. Mapping stays in `themeFor`; this only stores
 * its answer.
 */
export const EMBED_THEME_KEY = 'elasticpro.embedTheme';

export function rememberEmbedTheme(theme) {
  try {
    if (theme) sessionStorage.setItem(EMBED_THEME_KEY, theme);
    else sessionStorage.removeItem(EMBED_THEME_KEY);
  } catch (_) { /* storage blocked: the first paint is simply the default */ }
}

/** The message the Zabbix page listens for. See the module's elasticpro.embed.php. */
export const REAUTH_MESSAGE = 'elasticpro:reauth';

/**
 * Running inside Zabbix? Read from the class the launch set on the page, so every page
 * asks the same question the same way.
 */
export function inZabbix() {
  return typeof document !== 'undefined' && !!document.documentElement
    && document.documentElement.classList.contains('embedded');
}

/**
 * Inside Zabbix, a session that ended — the core restarted, or it sat idle — is not a
 * reason to show this app's own login: the person already signed in, to Zabbix. The frame
 * asks the Zabbix page around it to load again, which mints a fresh one-time code for the
 * same Zabbix user.
 *
 * Returns false when there is no page around it to ask (the URL opened on its own), so
 * the caller can fall back to the login screen. The message carries nothing secret, which
 * is why it can go to any parent; the Zabbix page decides whether to act on it.
 */
export function askZabbixToSignIn(win) {
  try {
    if (!win || !win.parent || win.parent === win) return false;
    win.parent.postMessage({ type: REAUTH_MESSAGE }, '*');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Trade a code for a session. Resolves with `{ ok, session, caller }` or
 * `{ ok: false, message }`; never throws, because a failed exchange must still leave the
 * app able to show why.
 */
export async function exchangeCode(code, send) {
  if (!code) return { ok: false, message: 'no sign-in code' };
  try {
    const res = await send({ type: 'SSO_EXCHANGE', code });
    return res && res.ok ? res : { ok: false, message: (res && res.message) || 'the sign-in code was refused' };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}
