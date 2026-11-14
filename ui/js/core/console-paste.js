/**
 * A request pasted (or typed) into the REST console as one piece of text, recognised and
 * split into method, path and body — pure, no DOM. The page applies what comes back.
 *
 * Three shapes are read, in this order:
 *
 *   1. Kibana Dev Tools / plain:   POST _snapshot/es_9/_restore
 *                                  { "indices": "logs-*" }
 *      A method (GET HEAD POST PUT PATCH DELETE, any case), whitespace, a path, and
 *      optionally a newline and a body. The path may be a whole URL: its scheme and host
 *      are dropped, because the console sends to the cluster chosen in the top bar.
 *   2. curl:                       curl -XPOST 'http://host:9200/_snapshot/x/_restore' -d '{...}'
 *      -X/--request gives the method (POST when only -d/--data* is given, as curl does);
 *      the first token that is a URL or an absolute path is the path; -d/--data,
 *      --data-raw, --data-binary give the body (a @file body is not readable here and is
 *      left out). -H, -u and the other valued flags are skipped with their value.
 *   3. Anything else is not a request: null, and the text is left exactly as typed.
 *
 * A body that parses as JSON is formatted (2 spaces); otherwise it is kept as pasted.
 * `path` always starts with a slash. `body` is '' when none was given.
 */

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const METHOD_SET = new Set(METHODS);

/** Drop a scheme and host; make sure the path starts with a slash. */
export function normalisePath(raw) {
  let p = String(raw || '').trim();
  const m = p.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i);
  if (m) p = m[1] || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/** Formatted when it is JSON; otherwise exactly what was given, trimmed. */
export function tidyBody(raw) {
  const b = String(raw == null ? '' : raw).trim();
  if (!b) return '';
  try { return JSON.stringify(JSON.parse(b), null, 2); } catch (_) { return b; }
}

/** `GET`, `post` … → 'POST'; anything else → null. */
function asMethod(word) {
  const m = String(word || '').toUpperCase();
  return METHOD_SET.has(m) ? m : null;
}

/** Shell-style tokens: single and double quotes group, backslash-newline continues the line. */
function shellTokens(text) {
  const s = text.replace(/\\\r?\n/g, ' ');
  const out = [];
  let cur = '', inTok = false, q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) { q = null; continue; }
      if (q === '"' && ch === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      cur += ch; continue;
    }
    if (ch === '\'' || ch === '"') { q = ch; inTok = true; continue; }
    if (/\s/.test(ch)) { if (inTok) { out.push(cur); cur = ''; inTok = false; } continue; }
    if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; inTok = true; continue; }
    cur += ch; inTok = true;
  }
  if (inTok) out.push(cur);
  return out;
}

const CURL_VALUED = new Set(['-H', '--header', '-u', '--user', '-o', '--output', '-A', '--user-agent', '-b', '--cookie',
  '-e', '--referer', '-m', '--max-time', '--connect-timeout', '--cacert', '--cert', '--key', '-w', '--write-out',
  '--url', '-T', '--upload-file', '--retry', '-x', '--proxy']);
const CURL_DATA = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json']);

function parseCurl(text) {
  const toks = shellTokens(text);
  if (!toks.length || toks[0] !== 'curl') return null;
  let method = null, path = null, body = null;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === '-X' || t === '--request') { method = asMethod(toks[++i]); continue; }
    if (/^-X[A-Za-z]+$/.test(t)) { method = asMethod(t.slice(2)); continue; }
    if (t === '--url') { path = normalisePath(toks[++i]); continue; }
    if (CURL_DATA.has(t)) { const v = toks[++i]; if (v != null && !v.startsWith('@')) body = v; if (!method) method = 'POST'; continue; }
    if (/^-d./.test(t)) { const v = t.slice(2); if (!v.startsWith('@')) body = v; if (!method) method = 'POST'; continue; }
    if (CURL_VALUED.has(t)) { i++; continue; }
    if (t.startsWith('-')) continue;                           // -s, -k, -i, --insecure …
    if (!path && (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith('/') || /^[\w.-]+(:\d+)?\//.test(t))) {
      path = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith('/') ? normalisePath(t) : normalisePath(`http://${t}`);
    }
  }
  if (!path) return null;
  return { method: method || 'GET', path, body: tidyBody(body), form: 'curl' };
}

/**
 * The request in `text`, or null when it is not one.
 * @returns {{method: string, path: string, body: string, form: 'line'|'curl'}|null}
 */
export function parseRequestText(text) {
  const s = String(text == null ? '' : text).replace(/^﻿/, '').replace(/^\s+/, '');
  if (!s) return null;
  if (/^curl(\s|$)/.test(s)) return parseCurl(s);
  const m = s.match(/^([A-Za-z]+)[ \t]+(\S+)[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return null;
  const method = asMethod(m[1]);
  if (!method) return null;
  return { method, path: normalisePath(m[2]), body: tidyBody(m[3]), form: 'line' };
}

/** The one line the page flashes when a request was recognised. */
export function recognisedLabel(r) {
  return `Recognised ${r.method} ${r.path}${r.body ? ' with a body' : ''}`;
}
