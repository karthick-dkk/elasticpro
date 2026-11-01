/**
 * An alert's level — the one definition of what the levels are, their order and how many
 * of each are open. Three, worst first:
 *
 *   critical  red health, a disk past its high watermark, a cluster not answering, no master …
 *   high      a log delay over 60 min, JVM heap over 85 %, an SLM policy whose last run failed
 *   warning   everything else
 *
 * (docs/HANDBOOK.md, "Alert levels" says which rule raises which.) Every place that sorts,
 * counts, colours or filters by level reads it from here; before High there were seven
 * copies of `level === 'critical' ? 2 : 1`, and a third level added to six of them would
 * have sorted one list differently from the rest.
 */

/** Worst first. */
export const LEVELS = ['critical', 'high', 'warning'];

/** Higher is worse. A level nobody registered ranks with warning, never above it. */
export const LEVEL_RANK = { critical: 3, high: 2, warning: 1 };

export const levelRank = (level) => LEVEL_RANK[level] || 1;

/** The worse of two levels. */
export const worstLevel = (a, b) => (levelRank(a) >= levelRank(b) ? a : b);

/** For a sort: worst level first. */
export const byLevel = (a, b) => levelRank(b && b.level) - levelRank(a && a.level);

/** A level as a known one: anything unrecognised is a warning (as it always counted). */
export const levelOf = (level) => (LEVEL_RANK[level] ? level : 'warning');

/** The colour word each level takes (pills, Play tones): red · orange · yellow. */
export const LEVEL_TONE = { critical: 'red', high: 'orange', warning: 'yellow' };

/** The short class the Alerts page styles a level by (.apill.crit / .high / .warn). */
export const LEVEL_CLASS = { critical: 'crit', high: 'high', warning: 'warn' };

/** How a level is said on a wall (Play's Alerts slide). */
export const LEVEL_SHORT = { critical: 'CRIT', high: 'HIGH', warning: 'WARN' };

/**
 * The one count of alerts by level: `{ total, critical, high, warning }`. Whatever is not
 * critical or high is a warning, so the three always add up to the total.
 */
export function countLevels(list) {
  const all = list || [];
  const critical = all.filter((a) => a && a.level === 'critical').length;
  const high = all.filter((a) => a && a.level === 'high').length;
  return { total: all.length, critical, high, warning: all.length - critical - high };
}

/** The worst level present in a list, or null when it is empty. */
export function worstOf(list) {
  let w = null;
  for (const a of list || []) if (a) w = w ? worstLevel(w, levelOf(a.level)) : levelOf(a.level);
  return w;
}

/** red / orange / yellow for the worst of a count, '' when nothing is open. */
export function toneOfCounts(c) {
  return c.critical ? 'red' : c.high ? 'orange' : c.warning ? 'yellow' : '';
}
