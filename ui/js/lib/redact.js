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

export function redactSecrets(body) {
  if (typeof body !== 'string' || !body) return body;
  return body.replace(/("([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (all, head, key) => (SECRET_KEY.test(key) ? `${head}"${REDACTED}"` : all));
}
