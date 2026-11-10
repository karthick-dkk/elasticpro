//! Busy clusters (docs/JOBS.md "Busy clusters"): ONE definition of when a cluster is too
//! loaded for background work, built from the signals the product already has.
//!
//! A cluster is busy when any of these holds:
//!
//! * **pool** — its search thread pool queue is over half full, or it rejected more searches
//!   since the last reading (`report::control::pool_pressure`, which reads
//!   `_cat/thread_pool/search`); a reading older than `POOL_FRESH_MS` says nothing any more,
//!   and a calm one ends it;
//! * **slow** — its answers take longer than `fleet::scheduler::SLOW_MS` (8 s): the poller's
//!   `Slowed`, or a background answer of this process's own; three quick answers end it;
//! * **429** — it answered 429 Too Many Requests: the poller's `Throttle` (a backoff), or a
//!   background answer of this process's own, held for its `Retry-After` or `HOLD_429_MS`.
//!
//! `busy` is the predicate; `LoadView` holds what this process saw itself. The poller's state
//! lives in the core: the core publishes its busy clusters to `<data>/job-runs/busy.json`
//! (`PUBLISHED`), which the worker reads, and the worker's own come back in its heartbeat — so
//! each process judges by every signal. Only background work consults this: a person's own
//! request is never held back by it.

use crate::fleet::scheduler::{Slowed, Throttle, ThrottleKind, QUICK_TO_RECOVER, SLOW_MS};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// A pool reading older than this says nothing.
pub const POOL_FRESH_MS: u64 = 5 * 60_000;
/// A 429 without `Retry-After` holds the cluster busy this long.
pub const HOLD_429_MS: u64 = 60_000;
/// `<data>/job-runs/busy.json`: the core's view, for the worker. Older than this, ignored.
pub const PUBLISHED: &str = "busy.json";
pub const PUBLISHED_FRESH_MS: u64 = 3 * 60_000;

/// One busy cluster, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Busy {
    pub cluster: String,
    /// `pool`, `slow` or `429`.
    pub signal: String,
    pub reason: String,
    /// Unix ms the signal began, when known; null when it is not (a poller backoff).
    pub since: Option<u64>,
}

#[derive(Clone, Debug, Default)]
struct Pool {
    reason: Option<String>,
    since: Option<u64>,
    at: u64,
}

#[derive(Clone, Debug, Default)]
struct Own {
    slow: Option<(u64, String)>,
    quick: u32,
    held_429: Option<(u64, u64, String)>,
}

/// What this process saw itself: pool readings and its own background answers.
#[derive(Default)]
pub struct LoadView {
    pool: parking_lot::Mutex<HashMap<String, Pool>>,
    own: parking_lot::Mutex<HashMap<String, Own>>,
}

impl LoadView {
    /// A pool reading: `reason` from `pool_pressure`, `None` for a calm one.
    pub fn note_pool(&self, cluster: &str, reason: Option<String>, now: u64) {
        let mut m = self.pool.lock();
        let p = m.entry(cluster.to_string()).or_default();
        p.since = match (&reason, p.reason.is_some()) {
            (Some(_), true) => p.since,
            (Some(_), false) => Some(now),
            (None, _) => None,
        };
        p.reason = reason;
        p.at = now;
    }

    /// One answer from the cluster: its HTTP status (0 when none), how long it took, and its
    /// `Retry-After` in ms.
    pub fn note_answer(&self, cluster: &str, status: u64, took_ms: u64, retry_after_ms: Option<u64>, now: u64) {
        if cluster.is_empty() {
            return;
        }
        let mut m = self.own.lock();
        let o = m.entry(cluster.to_string()).or_default();
        if status == 429 {
            let until = now + retry_after_ms.unwrap_or(HOLD_429_MS);
            let since = o.held_429.as_ref().filter(|(_, u, _)| *u > now).map(|(s, _, _)| *s).unwrap_or(now);
            o.held_429 = Some((since, until, "the cluster answered 429 Too Many Requests".into()));
        }
        if took_ms > SLOW_MS {
            let since = o.slow.as_ref().map(|(s, _)| *s).unwrap_or(now);
            o.slow = Some((since, format!("an answer took {:.1} s (over {} s)", took_ms as f64 / 1000.0, SLOW_MS / 1000)));
            o.quick = 0;
        } else if status != 0 && status != 429 && o.slow.is_some() {
            o.quick += 1;
            if o.quick >= QUICK_TO_RECOVER {
                o.slow = None;
                o.quick = 0;
            }
        }
    }

    /// Forget a cluster's own signals (it eased, or for the tests).
    pub fn clear(&self, cluster: &str) {
        self.own.lock().remove(cluster);
        self.pool.lock().remove(cluster);
    }

    /// This process's own signals, as `Busy` lines.
    pub fn own_busy(&self, now: u64) -> Vec<Busy> {
        let mut out = vec![];
        for (c, p) in self.pool.lock().iter() {
            if let Some(r) = p.reason.as_ref().filter(|_| now.saturating_sub(p.at) <= POOL_FRESH_MS) {
                out.push(Busy { cluster: c.clone(), signal: "pool".into(), reason: r.clone(), since: p.since });
            }
        }
        for (c, o) in self.own.lock().iter() {
            if let Some((since, until, r)) = &o.held_429 {
                if *until > now {
                    out.push(Busy { cluster: c.clone(), signal: "429".into(), reason: r.clone(), since: Some(*since) });
                }
            }
            if let Some((since, r)) = &o.slow {
                out.push(Busy { cluster: c.clone(), signal: "slow".into(), reason: r.clone(), since: Some(*since) });
            }
        }
        out
    }
}

/// The one definition: every busy cluster, from the poller's `Slowed` and `Throttle` (a
/// backoff only: a spent budget is the poller's own appetite, not the cluster's load), and
/// from `others` (this process's own lines, the other process's published ones). One line
/// per cluster: the first signal in the order pool, 429, slow; the earliest `since` known.
pub fn busy(slowed: &HashMap<String, Slowed>, throttle: &HashMap<String, Throttle>, others: &[Busy], now: u64) -> BTreeMap<String, Busy> {
    let mut all: Vec<Busy> = others.to_vec();
    for (c, t) in throttle {
        if t.kind == ThrottleKind::Backoff && t.until > now && t.reason.contains("429") {
            all.push(Busy { cluster: c.clone(), signal: "429".into(), reason: t.reason.clone(), since: None });
        }
    }
    for (c, s) in slowed {
        all.push(Busy { cluster: c.clone(), signal: "slow".into(), reason: s.reason.clone(), since: Some(s.since) });
    }
    let rank = |s: &str| match s {
        "pool" => 0,
        "429" => 1,
        _ => 2,
    };
    all.sort_by(|a, b| (a.cluster.as_str(), rank(&a.signal)).cmp(&(b.cluster.as_str(), rank(&b.signal))));
    let mut out: BTreeMap<String, Busy> = BTreeMap::new();
    for b in all {
        match out.get_mut(&b.cluster) {
            None => {
                out.insert(b.cluster.clone(), b);
            }
            Some(first) => {
                if let Some(s) = b.since {
                    first.since = Some(first.since.map_or(s, |f| f.min(s)));
                }
            }
        }
    }
    out
}

/// What the core publishes for the worker.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub at: u64,
    pub busy: Vec<Busy>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_definition_of_busy() {
        let v = LoadView::default();
        let now = 1_000_000;
        v.note_answer("a", 429, 50, Some(1_000), now);
        v.note_answer("b", 200, 9_000, None, now);
        v.note_pool("c", Some("n1's search queue is 600 of 1000".into()), now);
        v.note_pool("d", None, now);
        let own = v.own_busy(now);
        let mut slowed = HashMap::new();
        slowed.insert("e".to_string(), Slowed { since: 5, reason: "a request took 9.2 s".into(), level: 1, quick: 0 });
        let mut throttle = HashMap::new();
        throttle.insert("f".to_string(), Throttle { kind: ThrottleKind::Backoff, until: now + 5, level: 1, reason: "the cluster answered 429 Too Many Requests; backing off 60 s".into() });
        throttle.insert("g".to_string(), Throttle { kind: ThrottleKind::Budget, until: now + 5, level: 0, reason: "budget".into() });
        let b = busy(&slowed, &throttle, &own, now);
        let names: Vec<&str> = b.keys().map(String::as_str).collect();
        assert_eq!(names, vec!["a", "b", "c", "e", "f"], "a spent budget is not the cluster's load; a calm pool is not busy");
        assert_eq!((b["a"].signal.as_str(), b["a"].since), ("429", Some(now)));
        assert_eq!(b["c"].signal, "pool");
        assert_eq!(b["f"].since, None, "not known, not a guess");
        // The 429 passes with its Retry-After; the slow one after three quick answers.
        assert!(busy(&HashMap::new(), &HashMap::new(), &v.own_busy(now + 1_001), now + 1_001).get("a").is_none());
        for _ in 0..3 {
            v.note_answer("b", 200, 10, None, now);
        }
        assert!(v.own_busy(now).iter().all(|x| x.cluster != "b"));
        // A pool reading too old says nothing.
        assert!(v.own_busy(now + POOL_FRESH_MS + 1).iter().all(|x| x.cluster != "c"));
    }
}
