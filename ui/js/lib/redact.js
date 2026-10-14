/**
 * Take secrets out of a request body before it is kept anywhere in the browser.
 *
 * The REST console keeps its history in IndexedDB, and a request such as
 * `PUT _security/user/x {"password": "…"}` or one creating an API key carries a secret in
 * its body. A secret belongs on the server, never in browser storage, so the value of any
 * string field whose name looks like one is replaced before the entry is stored. The
 * request itself was already sent as typed; only the remembered copy is redacted.
 *
 * Works on the text, so a body that is not strict JSON (the console accepts what people
 * type) is still covered.
 */
export const REDACTED = '[redacted]';
const SECRET_KEY = /pass(?:word|wd|phrase)?|secret|api[_-]?key|token|private[_-]?key|credential|authorization/i;

/**
 * The same for a request path: a query parameter whose name looks like a secret
 * (`?password=…`, `&api_key=…`, `token=…`) and credentials written into a URL
 * (`https://user:pass@host`) are replaced. The rest of the path is kept as typed.
 */
export function redactPath(p) {
  if (typeof p !== 'string' || !p) return p;
  return p
    .replace(/(\/\/)[^/@\s]+:[^/@\s]*@/g, `$1${REDACTED}@`)
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (all, sep, k, v) => (SECRET_KEY.test(decodeURIComponentSafe(k)) && v ? `${sep}${k}=${REDACTED}` : all));
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

/** A JSON value with every secret-named field (at any depth, any type) replaced. */
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? REDACTED : scrub(x);
    return out;
  }
  return v;
}
const hasSecretKey = (v) => (Array.isArray(v) ? v.some(hasSecretKey)
  : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => SECRET_KEY.test(k) || hasSecretKey(x)) : false);

/** A key as a JSON parser would read it: \uXXXX and other escapes decoded. */
function decodedKey(raw) {
  try { return JSON.parse(`"${raw}"`); } catch (_) { return raw; }
}

/**
 * Redact one JSON document by what a parser reads — the decoded key, at any depth, whatever
 * the value's type — so a key written as "pass\u0077ord" or a numeric secret is caught.
 * Text that is not JSON falls back to a match on the decoded key name, string values only.
 */
function redactDoc(text) {
  try {
    const v = JSON.parse(text);
    return hasSecretKey(v) ? JSON.stringify(scrub(v)) : text;
  } catch (_) {
    return text.replace(/("([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null|\{[^{}]*\}|\[[^\[\]]*\])/g,
      (all, head, key) => (SECRET_KEY.test(decodedKey(key)) ? `${head}"${REDACTED}"` : all));
  }
}

export function redactSecrets(body) {
  if (typeof body !== 'string' || !body) return body;
  // One document, or newline-delimited ones (_bulk, _msearch): each line judged on its own.
  try { JSON.parse(body); return redactDoc(body); } catch (_) { /* not a single document */ }
  return body.split('\n').map((line) => (line.trim() ? redactDoc(line) : line)).join('\n');
}
