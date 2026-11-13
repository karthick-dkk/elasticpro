//! How hard a report may push one cluster (docs/REPORT-TYPES.md "Concurrency"): the
//! adaptive controller, the pressure an answer or the search thread pool shows, and the
//! split of a day's indices into partitions that can be collected side by side.
//!
//! Pure: no clock (every call takes `now`, ms), no I/O, so each rule is a test, and the
//! code is the same wherever the collection runs (the core today, a worker later).

use serde::Serialize;
use serde_json::Value;

pub const DEFAULT_START: u32 = 2;
pub const DEFAULT_MAX: u32 = 4;
pub const MAX_ALLOWED: u32 = 8;
pub const DEFAULT_TARGET_MS: u64 = 5000;
pub const DEFAULT_CLUSTERS_AT_ONCE: usize = 4;
/// Good pages in a row before one more request is allowed.
pub const GOOD_PAGES_TO_GROW: u32 = 20;
/// Pages whose latencies make the cluster's baseline (their median).
pub const BASELINE_PAGES: usize = 5;
/// No increase this long after a halve.
pub const COOLDOWN_MS: i64 = 60_000;
/// The search thread pool is looked at every this many pages.
pub const POOL_CHECK_EVERY: u64 = 50;

/// The per-cluster limit on requests in flight: additive increase, multiplicative decrease.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controller {
    current: u32,
    max: u32,
    target_ms: u64,
    good: u32,
    first: Vec<u64>,
    baseline_ms: Option<u64>,
    cooldown_until: i64,
    /// `Retry-After`: nothing new is sent before this.
    hold_until: i64,
    /// The job's allocation (`jobs::governor`): the ceiling is the smaller of this and `max`.
    cap: u32,
    pub halvings: u32,
    pub last_reason: Option<String>,
}

impl Controller {
    /// `start` and `max` are clamped to 1..=`MAX_ALLOWED`, `start` to `max`.
    pub fn new(start: u32, max: u32, target_ms: u64) -> Controller {
        let max = max.clamp(1, MAX_ALLOWED);
        Controller {
            current: start.clamp(1, max), max, target_ms, good: 0, first: vec![], baseline_ms: None, cooldown_until: 0,
            hold_until: 0, cap: MAX_ALLOWED, halvings: 0, last_reason: None,
        }
    }

    /// The job's allocation from the governor: the ceiling becomes the smaller of it and the
    /// controller's own. Requests over it are not sent; the controller's own count is kept, so
    /// a larger allocation later gives back what it had earned.
    pub fn set_cap(&mut self, n: u32) {
        self.cap = n.clamp(1, MAX_ALLOWED);
    }

    /// The ceiling in force: the smaller of the controller's own and the job's allocation.
    pub fn ceiling(&self) -> u32 {
        self.max.min(self.cap)
    }

    /// Requests allowed now, under both ceilings.
    pub fn current(&self) -> u32 {
        self.current.min(self.cap)
    }

    pub fn baseline_ms(&self) -> Option<u64> {
        self.baseline_ms
    }

    /// Requests that may be in flight now: 0 while a `Retry-After` holds.
    pub fn limit(&self, now: i64) -> u32 {
        if now < self.hold_until { 0 } else { self.current() }
    }

    /// When the hold of a `Retry-After` ends (0: none).
    pub fn hold_until(&self) -> i64 {
        self.hold_until
    }

    /// A page answered, in `latency_ms`. Slower than 3× the baseline halves; at most 1.5×
    /// the baseline and within the target counts as good, and `GOOD_PAGES_TO_GROW` good
    /// pages in a row (outside the cooldown) allow one more request, up to the ceiling.
    pub fn page_ok(&mut self, latency_ms: u64, now: i64) {
        if self.baseline_ms.is_none() {
            self.first.push(latency_ms);
            if self.first.len() >= BASELINE_PAGES {
                let mut v = self.first.clone();
                v.sort_unstable();
                self.baseline_ms = Some(v[v.len() / 2].max(1));
            }
            return;
        }
        let base = self.baseline_ms.unwrap_or(1);
        if latency_ms > base.saturating_mul(3) {
            self.halve(&format!("a page took {latency_ms} ms, over 3× the cluster's {base} ms"), None, now);
            return;
        }
        if latency_ms * 2 <= base * 3 && latency_ms <= self.target_ms {
            self.good += 1;
            if self.good >= GOOD_PAGES_TO_GROW && now >= self.cooldown_until && self.current < self.ceiling() {
                self.current += 1;
                self.good = 0;
            }
        } else {
            self.good = 0;
        }
    }

    /// The cluster pushed back (`reason`): half as many requests, at least one; nothing more
    /// for `COOLDOWN_MS`, and nothing at all until `retry_after_ms` has passed.
    pub fn halve(&mut self, reason: &str, retry_after_ms: Option<u64>, now: i64) {
        self.current = (self.current() / 2).max(1);
        self.good = 0;
        self.cooldown_until = now + COOLDOWN_MS;
        if let Some(ms) = retry_after_ms {
            self.hold_until = self.hold_until.max(now + ms as i64);
        }
        self.halvings += 1;
        self.last_reason = Some(reason.to_string());
    }
}

/// Whether a failed answer is the cluster pushing back, and why: HTTP 429 or 503, a
/// rejected execution or a circuit breaker, a time-out. `None` for any other failure (it
/// is retried, but the cluster is not taken for overloaded).
pub fn pushback(res: &Value) -> Option<String> {
    let status = res.get("status").and_then(Value::as_u64).filter(|s| *s > 0)
        .or_else(|| res.get("httpStatus").and_then(Value::as_u64)).unwrap_or(0);
    if status == 429 || status == 503 {
        return Some(format!("HTTP {status}"));
    }
    if res.get("kind").and_then(Value::as_str) == Some("timeout") {
        return Some("a request timed out".into());
    }
    let types = [res.pointer("/json/error/type"), res.pointer("/json/error/root_cause/0/type"), res.pointer("/json/error/caused_by/type")];
    for t in types.into_iter().flatten().filter_map(Value::as_str) {
        if t == "es_rejected_execution_exception" || t == "circuit_breaking_exception" {
            return Some(t.to_string());
        }
    }
    None
}

/// `Retry-After` of a failed answer, in ms.
pub fn retry_after_ms(res: &Value) -> Option<u64> {
    res.get("retryAfterS").and_then(Value::as_u64).map(|s| s.min(3600) * 1000)
}

fn num(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// The search thread pool (`_cat/thread_pool/search?format=json&h=node_name,active,queue,
/// queue_size,rejected`): pressure when any node's queue is over half its size, or when
/// `rejected` (all nodes together) has grown since `last_rejected`. Returns the reason, if
/// any, and the rejected count to compare with next time.
pub fn pool_pressure(rows: &Value, last_rejected: Option<u64>) -> (Option<String>, u64) {
    let mut rejected = 0u64;
    let mut why = None;
    for r in rows.as_array().into_iter().flatten() {
        rejected += num(r.get("rejected")).unwrap_or(0);
        let (q, size) = (num(r.get("queue")).unwrap_or(0), num(r.get("queue_size")));
        if let Some(size) = size.filter(|s| *s > 0) {
            if q * 2 > size && why.is_none() {
                let node = r.get("node_name").and_then(Value::as_str).unwrap_or("a node");
                why = Some(format!("{node}'s search queue is {q} of {size}"));
            }
        }
    }
    if why.is_none() {
        if let Some(last) = last_rejected.filter(|l| rejected > *l) {
            why = Some(format!("the search thread pool rejected {} more requests", rejected - last));
        }
    }
    (why, rejected)
}

/// A day's indices in up to `n` partitions balanced by documents, each a run of index names
/// in name order — so a day file written partition after partition is still in index order
/// (the ClientID fill reads rows in day, index order). No partition is empty.
pub fn partitions(indices: &[(String, u64)], n: usize) -> Vec<Vec<String>> {
    let mut sorted: Vec<&(String, u64)> = indices.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted.dedup_by(|a, b| a.0 == b.0);
    let n = n.clamp(1, sorted.len().max(1));
    if sorted.is_empty() {
        return vec![];
    }
    let total: u64 = sorted.iter().map(|(_, d)| (*d).max(1)).sum();
    let mut out: Vec<Vec<String>> = vec![];
    let mut cur: Vec<String> = vec![];
    let mut acc = 0u64;
    for (i, (name, docs)) in sorted.iter().enumerate() {
        cur.push(name.clone());
        acc += (*docs).max(1);
        let left_items = sorted.len() - i - 1;
        let left_groups = n - out.len() - 1;
        // Cut when this group has its share, or when every remaining index must start a
        // group of its own to make `n`.
        let share = total * (out.len() as u64 + 1) / n as u64;
        if left_groups > 0 && left_items > 0 && (acc >= share || left_items == left_groups) {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn warm(c: &mut Controller, ms: u64, now: i64) {
        for _ in 0..BASELINE_PAGES {
            c.page_ok(ms, now);
        }
    }

    #[test]
    fn twenty_good_pages_add_one_up_to_the_ceiling() {
        let mut c = Controller::new(2, 4, 5000);
        warm(&mut c, 100, 0);
        assert_eq!(c.baseline_ms(), Some(100));
        for _ in 0..19 {
            c.page_ok(150, 0);
        }
        assert_eq!(c.current(), 2, "19 is not 20");
        c.page_ok(150, 0);
        assert_eq!(c.current(), 3);
        c.page_ok(151, 0);
        for _ in 0..19 {
            c.page_ok(100, 0);
        }
        assert_eq!(c.current(), 3, "a page over 1.5× the baseline starts the count again");
        for _ in 0..40 {
            c.page_ok(100, 0);
        }
        assert_eq!(c.current(), 4);
        for _ in 0..100 {
            c.page_ok(100, 0);
        }
        assert_eq!(c.current(), 4, "the ceiling");
        assert_eq!(Controller::new(9, 20, 1).current(), MAX_ALLOWED, "clamped to 8");
    }

    #[test]
    fn the_target_caps_what_counts_as_good() {
        let mut c = Controller::new(1, 4, 500);
        warm(&mut c, 400, 0);
        for _ in 0..40 {
            c.page_ok(550, 0);
        }
        assert_eq!(c.current(), 1, "within 1.5× the baseline but over the target");
    }

    #[test]
    fn pushback_and_slowness_halve_to_the_floor_with_a_cooldown() {
        let mut c = Controller::new(4, 8, 5000);
        warm(&mut c, 100, 0);
        c.page_ok(301, 1_000);
        assert_eq!((c.current(), c.halvings), (2, 1), "over 3× the baseline");
        assert!(c.last_reason.as_deref().unwrap().contains("over 3×"));
        c.halve("HTTP 429", None, 2_000);
        c.halve("HTTP 429", None, 2_000);
        assert_eq!(c.current(), 1, "the floor");
        for _ in 0..40 {
            c.page_ok(100, 30_000);
        }
        assert_eq!(c.current(), 1, "no increase within 60 s of a halve");
        for _ in 0..20 {
            c.page_ok(100, 62_001);
        }
        assert_eq!(c.current(), 2, "after the cooldown");
    }

    #[test]
    fn retry_after_holds_every_request() {
        let mut c = Controller::new(2, 4, 5000);
        c.halve("HTTP 429", Some(30_000), 10_000);
        assert_eq!(c.limit(10_001), 0);
        assert_eq!(c.limit(39_999), 0);
        assert_eq!(c.limit(40_000), 1);
        assert_eq!(retry_after_ms(&json!({ "status": 429, "retryAfterS": 30 })), Some(30_000));
    }

    #[test]
    fn the_jobs_allocation_caps_the_ceiling_and_a_halve_stays_this_clusters() {
        let mut c = Controller::new(4, 8, 5000);
        warm(&mut c, 100, 0);
        c.set_cap(2);
        assert_eq!((c.current(), c.limit(0), c.ceiling()), (2, 2, 2), "min(the job's allocation, its own ceiling)");
        for _ in 0..40 {
            c.page_ok(100, 0);
        }
        assert_eq!(c.current(), 2, "no growth over the allocation");
        c.set_cap(6);
        assert_eq!(c.current(), 4, "a larger allocation gives back what it had");
        for _ in 0..40 {
            c.page_ok(100, 0);
        }
        assert_eq!(c.current(), 6, "and grows to the new ceiling");
        // A busy cluster halves its own controller; another cluster's is untouched.
        let mut other = Controller::new(4, 8, 5000);
        other.set_cap(6);
        c.halve("HTTP 429", None, 1_000);
        assert_eq!((c.current(), other.current()), (3, 4));
    }

    #[test]
    fn what_counts_as_the_cluster_pushing_back() {
        assert_eq!(pushback(&json!({ "ok": false, "status": 429 })).as_deref(), Some("HTTP 429"));
        assert_eq!(pushback(&json!({ "ok": false, "status": 503 })).as_deref(), Some("HTTP 503"));
        assert!(pushback(&json!({ "ok": false, "status": 0, "kind": "timeout" })).is_some());
        assert_eq!(pushback(&json!({ "ok": false, "status": 500, "json": { "error": { "root_cause": [{ "type": "es_rejected_execution_exception" }] } } })).as_deref(),
                   Some("es_rejected_execution_exception"));
        assert!(pushback(&json!({ "ok": false, "status": 429, "json": { "error": { "type": "circuit_breaking_exception" } } })).is_some());
        assert_eq!(pushback(&json!({ "ok": false, "status": 401 })), None, "a refusal is not load");
    }

    #[test]
    fn the_thread_pool_shows_a_full_queue_or_new_rejections() {
        let rows = json!([{ "node_name": "n1", "active": "13", "queue": "100", "queue_size": "1000", "rejected": "5" },
                          { "node_name": "n2", "active": "13", "queue": "600", "queue_size": "1000", "rejected": "2" }]);
        let (why, rej) = pool_pressure(&rows, None);
        assert_eq!((why.as_deref(), rej), (Some("n2's search queue is 600 of 1000"), 7));
        let calm = json!([{ "node_name": "n1", "queue": "1", "queue_size": "1000", "rejected": "7" }]);
        assert_eq!(pool_pressure(&calm, Some(7)).0, None);
        assert!(pool_pressure(&calm, Some(6)).0.unwrap().contains("rejected 1 more"));
        assert_eq!(pool_pressure(&json!([{ "queue": "5", "queue_size": "-1" }]), None).0, None, "an unbounded queue");
    }

    #[test]
    fn a_day_splits_into_balanced_runs_of_index_names() {
        let ix = |v: &[(&str, u64)]| v.iter().map(|(n, d)| (n.to_string(), *d)).collect::<Vec<_>>();
        let p = partitions(&ix(&[("d", 10), ("a", 100), ("c", 10), ("b", 100), ("e", 80)]), 3);
        assert_eq!(p, vec![vec!["a".to_string()], vec!["b".into()], vec!["c".into(), "d".into(), "e".into()]]);
        assert_eq!(p.concat(), ["a", "b", "c", "d", "e"], "name order kept across partitions");
        let p = partitions(&ix(&[("a", 1), ("b", 1)]), 4);
        assert_eq!(p.len(), 2, "never more partitions than indices");
        assert_eq!(partitions(&ix(&[("a", 5)]), 4), vec![vec!["a".to_string()]]);
        assert!(partitions(&[], 4).is_empty());
        let many: Vec<(String, u64)> = (0..20).map(|i| (format!("i{i:02}"), 10)).collect();
        let p = partitions(&many, 4);
        assert_eq!(p.len(), 4);
        assert!(p.iter().all(|g| g.len() == 5), "{p:?}");
        let skew = partitions(&ix(&[("a", 1000), ("b", 1), ("c", 1), ("d", 1)]), 4);
        assert_eq!(skew.len(), 4, "every index its own group when n allows: {skew:?}");
    }
}
