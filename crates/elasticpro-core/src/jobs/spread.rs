//! When each cluster's share of a scheduled job starts (docs/JOBS.md "Spread"): the one
//! definition every timer uses.
//!
//! Before 0.3.81 a timer started every cluster at the same minute: the hosts collection all
//! of them at `UI_REPORT_HOSTS_AT`, the daily volume all of them at `collectAt`, and their
//! retries came back together too. Production saw twelve clusters deferred or timed out in the
//! same eight minutes, most of them behind the same jump hosts. Now each cluster has a fixed
//! place in the job's window:
//!
//! 1. **Order.** The clusters are sorted by a stable hash of their id (FNV-1a, the same on every
//!    build and every machine, unlike std's hasher), then rearranged so that two clusters
//!    behind the same jump host (`via`) are never next to each other, wherever the mix allows
//!    it (the cluster with the most company behind its jump host goes first; ties keep the
//!    hash order). A cluster reached directly shares a jump host with nobody.
//! 2. **Place.** The cluster at position `i` of `n` starts `i / n` of the way through the
//!    window (`offset_ms`): the first, and one cluster alone, keep the time they were given;
//!    nobody starts before it. `scheduled_at` is that time, for the tick and for the "next run"
//!    the pages show alike, so the two cannot differ.
//!
//! The same fleet gives the same places every day and after every restart. Adding or removing a
//! cluster moves the others' places a little; nothing is stored.
//!
//! Nothing here sends a cluster anything.

use chrono::{NaiveTime, Timelike};
use std::collections::VecDeque;

/// The daily hosts collection starts its clusters across two hours from `UI_REPORT_HOSTS_AT`
/// (06:00–08:00 by default).
pub const HOSTS_WINDOW_MS: u64 = 2 * 3_600_000;
/// The daily volume run starts each cluster within the half hour from its `collectAt`. Never
/// before it: with `collectAt` just after UTC midnight (06:00 IST is 00:30 UTC) a start before
/// it would read the day before as final with too little time for its late logs.
pub const VOLUME_WINDOW_MS: u64 = 30 * 60_000;
/// The scheduled log delay measurement reads its clusters one after another; on the timer's run
/// their starts are spread over the first quarter of its interval, at most ten minutes, so a
/// run still ends well inside its interval (`measure_spread_ms`).
pub const MEASURE_SPREAD_SHARE: u64 = 4;
pub const MEASURE_SPREAD_MAX_MS: u64 = 10 * 60_000;

/// A cluster as the spread sees it: its id and the jump host it is reached through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub id: String,
    pub via: Option<String>,
}

impl Member {
    /// An empty `via` is no jump host.
    pub fn new(id: &str, via: Option<&str>) -> Member {
        Member { id: id.to_string(), via: via.map(str::trim).filter(|v| !v.is_empty()).map(String::from) }
    }
}

/// FNV-1a, 64 bits: a hash that is the same on every build, so a cluster's place does not move
/// with a compiler upgrade.
pub fn stable_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// One jump host's clusters (`None`: one cluster reached directly), each with its hash rank.
type Group<'a> = (Option<&'a str>, VecDeque<(usize, &'a str)>);

/// The order the clusters start in (see the module header). Each id once.
pub fn order(members: &[Member]) -> Vec<String> {
    let mut ms: Vec<&Member> = members.iter().collect();
    ms.sort_by_cached_key(|m| (stable_hash(&m.id), m.id.clone()));
    ms.dedup_by(|a, b| a.id == b.id);
    // One group per jump host, in hash order; a direct cluster is a group of its own (`None`,
    // which is next to nothing).
    let mut groups: Vec<Group<'_>> = vec![];
    for (rank, m) in ms.iter().enumerate() {
        match m.via.as_deref() {
            Some(v) => match groups.iter_mut().find(|(k, _)| *k == Some(v)) {
                Some((_, q)) => q.push_back((rank, m.id.as_str())),
                None => groups.push((Some(v), VecDeque::from([(rank, m.id.as_str())]))),
            },
            None => groups.push((None, VecDeque::from([(rank, m.id.as_str())]))),
        }
    }
    let mut out = Vec::with_capacity(ms.len());
    let mut last: Option<&str> = None;
    while out.len() < ms.len() {
        // The group with most left that is not the jump host just placed; on a tie, the one whose
        // next cluster comes first in hash order. When only that jump host is left, it follows
        // itself: nothing else can stand between.
        let pick = groups.iter().enumerate()
            .filter(|(_, (k, q))| !q.is_empty() && (k.is_none() || *k != last))
            .max_by(|(_, (_, a)), (_, (_, b))| a.len().cmp(&b.len()).then_with(|| b[0].0.cmp(&a[0].0)))
            .map(|(i, _)| i)
            .or_else(|| groups.iter().position(|(_, q)| !q.is_empty()));
        let Some(i) = pick else { break };
        let (key, q) = &mut groups[i];
        if let Some((_, id)) = q.pop_front() {
            out.push(id.to_string());
        }
        last = *key;
    }
    out
}

/// Where `id` stands in `order`, and of how many. `None` for a cluster not among `members`.
pub fn position(members: &[Member], id: &str) -> Option<(usize, usize)> {
    let o = order(members);
    o.iter().position(|x| x == id).map(|i| (i, o.len()))
}

/// How long after the window opens `id` starts: in `[0, window_ms)`, `0` for the first (and for
/// a cluster not among `members`).
pub fn offset_ms(members: &[Member], id: &str, window_ms: u64) -> u64 {
    match position(members, id) {
        Some((i, n)) => (i as u64).saturating_mul(window_ms) / n as u64,
        None => 0,
    }
}

/// When `id`'s share of a daily job starts: `base` (the job's time) plus its place in a window
/// of `window_ms` (`offset_ms`), within the day. The one answer the tick and the pages' "next
/// run" both use.
pub fn scheduled_at(members: &[Member], id: &str, base: NaiveTime, window_ms: u64) -> NaiveTime {
    start_at(base, offset_ms(members, id, window_ms) as i64)
}

/// The next start of any of `members` after `now` today (`scheduled_at`); the first of
/// tomorrow's when every one of today's has come. `None` without members.
pub fn next_start(members: &[Member], base: NaiveTime, window_ms: u64, now: NaiveTime) -> Option<(NaiveTime, bool)> {
    let times: Vec<NaiveTime> = members.iter().map(|m| scheduled_at(members, &m.id, base, window_ms)).collect();
    match times.iter().filter(|t| **t > now).min() {
        Some(t) => Some((*t, false)),
        None => times.iter().min().map(|t| (*t, true)),
    }
}

/// `base` moved by `offset_ms`, kept within the same day (00:00–23:59:59): a daily run is never
/// moved into the day before or after.
pub fn start_at(base: NaiveTime, offset_ms: i64) -> NaiveTime {
    let s = (base.num_seconds_from_midnight() as i64 + offset_ms / 1000).clamp(0, 86_399);
    NaiveTime::from_num_seconds_from_midnight_opt(s as u32, 0).unwrap_or(base)
}

/// Over how long the timer's log delay measurement spreads its clusters' starts: a quarter of
/// its interval, at most `MEASURE_SPREAD_MAX_MS`.
pub fn measure_spread_ms(interval_ms: u64) -> u64 {
    (interval_ms / MEASURE_SPREAD_SHARE).min(MEASURE_SPREAD_MAX_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fleet(spec: &[(&str, Option<&str>)]) -> Vec<Member> {
        spec.iter().map(|(id, via)| Member::new(id, *via)).collect()
    }

    fn mixed() -> Vec<Member> {
        let mut v = vec![];
        for i in 0..32 {
            let via = match i % 4 { 0 => Some("jh-a"), 1 => Some("jh-b"), 2 => Some("jh-a"), _ => None };
            v.push(Member::new(&format!("cluster-{i:02}"), via));
        }
        v
    }

    #[test]
    fn the_hash_is_fixed() {
        // FNV-1a's published values: the place of a cluster does not move with the build.
        assert_eq!(stable_hash(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(stable_hash("a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(stable_hash("foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn deterministic_whatever_order_the_clusters_come_in() {
        let m = mixed();
        let first = order(&m);
        assert_eq!(first.len(), 32);
        let mut rev = m.clone();
        rev.reverse();
        assert_eq!(order(&rev), first, "the input order does not matter");
        assert_eq!(order(&m), first, "and asking again gives the same");
        let mut dup = m.clone();
        dup.push(m[3].clone());
        assert_eq!(order(&dup), first, "each id once");
        for c in &m {
            assert_eq!(offset_ms(&m, &c.id, HOSTS_WINDOW_MS), offset_ms(&rev, &c.id, HOSTS_WINDOW_MS));
        }
    }

    #[test]
    fn every_start_stays_inside_its_window_and_none_share_a_minute() {
        let m = mixed();
        let mut seen = std::collections::BTreeSet::new();
        for c in &m {
            let o = offset_ms(&m, &c.id, HOSTS_WINDOW_MS);
            assert!(o < HOSTS_WINDOW_MS, "{}: {o}", c.id);
            assert!(seen.insert(o / 60_000), "{}: one cluster a slot", c.id);
            let base = NaiveTime::from_hms_opt(0, 30, 0).unwrap();
            let at = scheduled_at(&m, &c.id, base, VOLUME_WINDOW_MS);
            assert!(at >= base && at < NaiveTime::from_hms_opt(1, 0, 0).unwrap(), "{}: {at} never before collectAt", c.id);
        }
        // 32 clusters over two hours: 3¾ minutes apart, the first at the window's start.
        let first = &order(&m)[0];
        assert_eq!(offset_ms(&m, first, HOSTS_WINDOW_MS), 0);
        // One cluster alone keeps its time; one not in the fleet is not moved.
        let one = fleet(&[("prod", None)]);
        assert_eq!(offset_ms(&one, "prod", HOSTS_WINDOW_MS), 0);
        assert_eq!(offset_ms(&m, "nobody", HOSTS_WINDOW_MS), 0);
        // Two: the start of the window and its middle.
        let two = fleet(&[("a", None), ("b", None)]);
        let mut ks = [offset_ms(&two, "a", 1_000), offset_ms(&two, "b", 1_000)];
        ks.sort();
        assert_eq!(ks, [0, 500]);
    }

    #[test]
    fn the_next_start_is_the_ticks_own() {
        let t = |h, m| NaiveTime::from_hms_opt(h, m, 0).unwrap();
        let four = fleet(&[("a", None), ("b", None), ("c", None), ("d", None)]);
        let starts: Vec<NaiveTime> = order(&four).iter().map(|id| scheduled_at(&four, id, t(6, 0), VOLUME_WINDOW_MS)).collect();
        assert_eq!(starts, vec![t(6, 0), NaiveTime::from_hms_opt(6, 7, 30).unwrap(), t(6, 15), NaiveTime::from_hms_opt(6, 22, 30).unwrap()], "in order, 7½ min apart");
        assert_eq!(next_start(&four, t(6, 0), VOLUME_WINDOW_MS, t(5, 0)), Some((t(6, 0), false)));
        assert_eq!(next_start(&four, t(6, 0), VOLUME_WINDOW_MS, t(6, 10)), Some((t(6, 15), false)), "inside the window: the next cluster's");
        assert_eq!(next_start(&four, t(6, 0), VOLUME_WINDOW_MS, t(7, 0)), Some((t(6, 0), true)), "all begun: tomorrow's first");
        assert_eq!(next_start(&[], t(6, 0), VOLUME_WINDOW_MS, t(5, 0)), None);
    }

    #[test]
    fn clusters_behind_the_same_jump_host_are_never_next_to_each_other() {
        let m = mixed();
        let via = |id: &str| m.iter().find(|c| c.id == id).and_then(|c| c.via.clone());
        let o = order(&m);
        for w in o.windows(2) {
            let (a, b) = (via(&w[0]), via(&w[1]));
            assert!(a.is_none() || a != b, "{} and {} both behind {a:?}: {o:?}", w[0], w[1]);
        }
        // Half the fleet behind one jump host: still interleaved, all the way.
        let half = fleet(&[("a1", Some("j")), ("a2", Some("j")), ("a3", Some("j")), ("b1", None), ("b2", Some("k")), ("b3", None)]);
        let o = order(&half);
        let j = |id: &str| id.starts_with('a');
        assert!(o.windows(2).all(|w| !(j(&w[0]) && j(&w[1]))), "{o:?}");
        // More than half behind one: as few neighbours as can be, all at the end.
        let most = fleet(&[("x1", Some("j")), ("x2", Some("j")), ("x3", Some("j")), ("y", None)]);
        let o = order(&most);
        assert_eq!(o.len(), 4);
        assert_eq!(o.windows(2).filter(|w| w[0].starts_with('x') && w[1].starts_with('x')).count(), 1, "{o:?}");
        // A blank via is no jump host.
        assert_eq!(Member::new("c", Some("  ")).via, None);
    }

    #[test]
    fn a_start_never_leaves_its_day() {
        let t = |h, m| NaiveTime::from_hms_opt(h, m, 0).unwrap();
        assert_eq!(start_at(t(6, 0), 20 * 60_000), t(6, 20));
        assert_eq!(start_at(t(6, 0), -20 * 60_000), t(5, 40));
        assert_eq!(start_at(t(0, 10), -30 * 60_000), t(0, 0), "not into yesterday");
        assert_eq!(start_at(t(23, 50), 30 * 60_000), NaiveTime::from_hms_opt(23, 59, 59).unwrap(), "nor into tomorrow");
    }

    #[test]
    fn the_measurement_spread_fits_inside_its_interval() {
        let h = 3_600_000;
        assert_eq!(measure_spread_ms(h), 10 * 60_000, "an hour: ten minutes, the cap");
        assert_eq!(measure_spread_ms(20 * 60_000), 5 * 60_000, "a quarter of a short interval");
        for hours in 1..=24 {
            assert!(measure_spread_ms(hours * h) <= hours * h / 4);
        }
    }
}
