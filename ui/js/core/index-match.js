/**
 * The Indices page's name search — one definition, read by the table filter, the head tick's
 * "every index the filters match" and the Live + Snapshot search alike.
 *
 * - plain text (no `*` or `?`): the name contains it, as it always has;
 * - with `*` (any run of characters) or `?` (one character): a glob over the WHOLE name;
 * - several, comma-separated: a name that matches any of them;
 * - a leading `!`, or the page's "Not matching" toggle: the other way round, the names that
 *   match none of them (both at once is still "not matching", never a double negative).
 *
 * Case never matters. Nothing typed matches every name, inverted or not: there is nothing to
 * leave out. Pure: no DOM, no state.
 */

const ESCAPE = /[.+^${}()|[\]\\]/g;

/** One pattern as a test on a name. */
function patternTest(p) {
  if (!/[*?]/.test(p)) {
    const low = p.toLowerCase();
    return (name) => name.toLowerCase().includes(low);
  }
  const re = new RegExp(`^${p.replace(ESCAPE, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return (name) => re.test(name);
}

/**
 * The search `text` as { active, test(name), label }. `active` is false when
 * nothing is asked (test then passes every name); `label` is what the page says it shows,
 * e.g. "not matching logstash-*".
 */
export function indexQuery(text, { not = false } = {}) {
  let t = String(text ?? '').trim();
  const bang = t.startsWith('!');
  if (bang) t = t.slice(1);
  const patterns = t.split(',').map((x) => x.trim()).filter(Boolean);
  const invert = !!not || bang;
  const active = patterns.length > 0;
  const tests = patterns.map(patternTest);
  const any = (name) => tests.some((f) => f(String(name ?? '')));
  return {
    active,
    test: !active ? () => true : invert ? (name) => !any(name) : any,
    label: active ? `${invert ? 'not matching' : 'matching'} ${patterns.join(', ')}` : '',
  };
}
