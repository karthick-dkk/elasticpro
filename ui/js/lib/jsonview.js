/** JSON pretty-printer that builds DOM nodes (no innerHTML, CSP-safe). */
import { h } from './dom.js';

export function jsonView(value, opts = {}) {
  const pre = h('pre.json');
  const maxChars = opts.maxChars || 400000;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text == null) return h('pre.json', '(empty response)');
  if (text.length > maxChars) {
    pre.append(document.createTextNode(text.slice(0, maxChars)),
      h('span.j-null', `\n\n… truncated, ${(text.length - maxChars).toLocaleString()} more characters. Use “Download” for the full payload.`));
    return pre;
  }
  // token pass over the already-formatted JSON text
  const re = /("(\\.|[^"\\])*"\s*:)|("(\\.|[^"\\])*")|(\b-?\d+(\.\d+)?([eE][+-]?\d+)?\b)|\b(true|false)\b|\bnull\b/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) pre.append(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    const cls = m[1] ? 'j-key' : m[3] ? 'j-str' : m[5] ? 'j-num' : /^(true|false)$/.test(t) ? 'j-bool' : 'j-null';
    pre.append(h(`span.${cls}`, t));
    last = m.index + t.length;
  }
  if (last < text.length) pre.append(document.createTextNode(text.slice(last)));
  return pre;
}
