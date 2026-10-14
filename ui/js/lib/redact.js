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

export function redactSecrets(body) {
  if (typeof body !== 'string' || !body) return body;
  return body.replace(/("([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (all, head, key) => (SECRET_KEY.test(key) ? `${head}"${REDACTED}"` : all));
}
