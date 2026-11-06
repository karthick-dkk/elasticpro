/**
 * Config-Management's one save bar: what changed, in words (the approved board of 2026-11-05).
 *
 * Pure. The page reads each tracked form into snapshots of the shape below (ui/change-tracker.js
 * does the DOM part); this says which fields differ from when the form was drawn from what is
 * saved, and how the bar names them: "2 unsaved changes · Watch window 15 → 20 · Health 60 → 90".
 *
 *   snapshot: Map key → { label, value, shown, secret?, section, sectionLabel? }
 *
 * `value` is what is compared, `shown` what the bar says. A secret (a password field) is never
 * shown: the bar says "new value typed", not the value — the bar is read over a shoulder too.
 */

/** The fields of `current` that differ from `baseline`, in the order of `current`. */
export function diffFields(baseline, current) {
  const out = [];
  if (!baseline || !current) return out;
  for (const [key, now] of current) {
    const was = baseline.get(key);
    if (!was || was.value === now.value) continue;
    out.push({
      key, section: now.section, sectionLabel: now.sectionLabel || '', label: now.label || key,
      from: now.secret ? '' : was.shown, to: now.secret ? 'new value typed' : now.shown, secret: !!now.secret,
    });
  }
  return out;
}

/** What a field's value reads as in the bar. Empty reads as "empty", so "a → " is never shown. */
export function shownValue(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  const s = String(v ?? '').trim();
  if (!s) return 'empty';
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** One change as the bar names it: "Watch window 15 → 20", "API token: new value typed". */
export function changeText(c) {
  if (c.text) return c.text;
  if (c.secret) return `${c.label}: ${c.to}`;
  return `${c.label} ${c.from} → ${c.to}`;
}

/**
 * The bar's words: `{count, head, list, title}`. `head` is "1 unsaved change" / "N unsaved
 * changes"; `list` the first few changes joined with " · " and "+N more" past `max`; `title` all
 * of them, one per line, for the hover.
 */
export function changeSummary(changes, { max = 3 } = {}) {
  const n = changes.length;
  const texts = changes.map((c) => (c.sectionLabel ? `${c.sectionLabel} › ${changeText(c)}` : changeText(c)));
  const shown = changes.slice(0, max).map(changeText);
  if (n > max) shown.push(`+${n - max} more`);
  return {
    count: n,
    head: n === 1 ? '1 unsaved change' : `${n} unsaved changes`,
    list: shown.join(' · '),
    title: texts.join('\n'),
  };
}

/** The sections a set of changes touches, in first-seen order: whose save path Save runs. */
export function sectionsOf(changes) {
  return [...new Set(changes.map((c) => c.section))];
}

/**
 * The baseline after a draw: keys already in it keep what they had (the saved value the form
 * was first drawn with), keys new to it are taken as drawn — an input that appears later (a
 * form behind "Edit connection", a panel that finished loading) starts unchanged.
 */
export function mergeBaseline(baseline, current) {
  const next = new Map(baseline || []);
  for (const [k, v] of current) if (!next.has(k)) next.set(k, v);
  return next;
}
