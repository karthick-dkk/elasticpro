/**
 * One sort order for a table: `{ key, dir }`, with `dir` 1 ascending or -1 descending.
 *
 * A table describes its orders once — `{ key: { label, dirs: { '1': …, '-1': … }, start } }`,
 * `start` being the direction a fresh click lands on — and its column headers, its Sort
 * select and its caption all read that one description. The Snapshots page list and the
 * snapshot evidence table both use it, so a header click and the select can never disagree
 * about what "sorted by taken, newest first" means.
 */

/** A header click: the same key flips direction; another key starts in its natural one. */
export function cycleSort(sort, key, sorts) {
  if (sort && sort.key === key) return { key, dir: -sort.dir };
  return { key, dir: (sorts[key] && sorts[key].start) || 1 };
}

/** "sorted by data date, newest first" — for a caption. */
export function sortCaption(sort, sorts) {
  const s = sorts[sort.key];
  if (!s) return '';
  return `sorted by ${s.label}, ${s.dirs[String(sort.dir)] || (sort.dir === 1 ? 'ascending' : 'descending')}`;
}

/**
 * The select's options, one per key and direction, keys in the order the table lists them
 * and each key's natural direction first. (Object key order would put "1" before "-1"
 * whatever the table wrote, since integer-like keys come first.)
 */
export function sortOptions(sorts) {
  const out = [];
  for (const [key, s] of Object.entries(sorts)) {
    const first = String(s.start || 1);
    for (const d of [first, ...Object.keys(s.dirs).filter((k) => k !== first)]) {
      out.push({ value: `${key}:${d}`, label: `${s.label[0].toUpperCase()}${s.label.slice(1)} · ${s.dirs[d]}` });
    }
  }
  return out;
}

/** The select's value back to `{ key, dir }`; anything unknown falls back to `fallback`. */
export function parseSort(value, sorts, fallback) {
  const [key, d] = String(value || '').split(':');
  const dir = Number(d);
  if (!sorts[key] || (dir !== 1 && dir !== -1)) return { ...fallback };
  return { key, dir };
}

/** `${key}:${dir}` — the select's value for an order. */
export function sortValue(sort) { return `${sort.key}:${sort.dir}`; }

/**
 * Compare two values with `null`/`undefined` always last, whichever way the sort runs:
 * an unknown is not a small value, so it never floats to the top when the order flips.
 */
export function compareNullLast(a, b, dir) {
  const an = a == null, bn = b == null;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return a < b ? -dir : a > b ? dir : 0;
}
