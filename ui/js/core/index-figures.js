/**
 * The figures of an index list, when some of them were not reported.
 *
 * `_cat/indices` gives no document count and no size for a closed index, nor for a red one
 * whose primaries are not assigned; a red index with some primaries assigned gives the part
 * that is. And the list itself leaves hidden indices out. Unknown is null here, never 0, and
 * a sum always comes with what it does not hold. Pure.
 */

import { plural } from '../lib/fmt.js';

const known = (v) => typeof v === 'number' && isFinite(v);

/** Why an index row has no figure: shown in the cell and the CSV's `figures` column. '' when it has both. */
export function figureWhy(r) {
  const none = !known(r && r.docs) || !known(r && r.size);
  if (none) return r && r.status === 'close' ? 'closed: not reported' : r && r.health === 'red' ? 'red: not reported' : 'not reported';
  return r && r.health === 'red' ? 'red: assigned shards only' : '';
}

/** Sum of `key` over the rows that report it: { sum (null when none does), counted, missing, red }. */
export function sumKnown(rows, key) {
  let sum = 0, counted = 0, missing = 0, red = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = r && r[key];
    if (!known(v)) { missing++; continue; }
    sum += v; counted++;
    if (r.health === 'red') red++;
  }
  return { sum: counted || !missing ? sum : null, counted, missing, red };
}

/** "2 indices not counted (closed or red)" / "1 red index counted in part", or ''. */
export function notCounted(s) {
  const out = [];
  if (s && s.missing) out.push(`${plural(s.missing, 'index', 'indices')} not counted (closed or red: not reported)`);
  if (s && s.red) out.push(`${plural(s.red, 'red index', 'red indices')} counted in part`);
  return out.join('; ');
}

/** Said beside every index count taken from the list. */
export const HIDDEN_NOTE = 'hidden indices are not listed';
