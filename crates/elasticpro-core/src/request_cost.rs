//! Jobs › Requests › Cost (docs/JOBS.md "Query cost"): what ElasticPro's requests cost each
//! cluster, per kind of work — a poller dataset, a job, a page — read with `REQUEST_COST`.
//!
//! * `CostBook` — kept in memory beside the request log (`bridge::RequestLog`), fed once per
//!   finished request: one bucket per clock hour for the last `KEEP_HOURS`, each holding per
//!   (cluster, kind) the requests sent, their total time, a latency histogram (`STEPS`, for the
//!   p95), the bytes read, the timeouts and the deferrals; and per cluster its `TOP_PER_CLUSTER`
//!   slowest requests of the same window. Bounded: `KEEP_HOURS` buckets, at most `CELLS_MAX`
//!   cells a bucket (past it a cluster's other kinds share one `other` cell), and nothing on disk.
//! * A request answered without going to the cluster (the read cache, sharing another's
//!   request) costs the cluster nothing and is not counted. One the gate held back before it
//!   was sent (`overloaded`, `queue_timeout`) is a *deferral*, and so is a job's cluster held
//!   back because it was busy (the run log's deferred runs, added when the view is built).
//! * `view` — what a caller may read: only the clusters `sees` lets through, so a caller
//!   limited to some clusters never learns another's name.
//!
//! Pure: no clock, no I/O.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

/// One clock hour, in ms.
pub const HOUR_MS: u64 = 3_600_000;
/// The window kept and shown: the last 24 clock hours.
pub const KEEP_HOURS: u64 = 24;
/// Cells (cluster × kind) one hour holds at most; past it a cluster's further kinds go to `OTHER`.
pub const CELLS_MAX: usize = 4_096;
/// The slowest requests kept per cluster, and the most expensive shown in all.
pub const TOP_PER_CLUSTER: usize = 10;
pub const TOP_SHOWN: usize = 10;
/// The kind a cell falls back to past `CELLS_MAX`.
pub const OTHER: &str = "other";
/// A kind's most characters (an origin a page names is the page's to choose).
const KIND_MAX: usize = 48;
/// A path's most characters in the top list.
const PATH_MAX: usize = 160;

/// The latency histogram's upper bounds, in ms: the p95 is the first step at or above the 95th
/// request, never above the slowest request seen.
pub const STEPS: [u64; 22] = [25, 50, 100, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 20_000,
                              30_000, 45_000, 60_000, 120_000, 300_000, u64::MAX];

/// Statuses the gate gives a request it held back before sending it.
const DEFERRED: &[&str] = &["overloaded", "queue_timeout"];
/// Statuses of a request the core stopped waiting for: it gave up (`timeout`) or closed it past
/// its deadline (`reaped`).
const TIMED_OUT: &[&str] = &["timeout", "reaped"];

/// One finished request, as the cost book takes it.
#[derive(Clone, Debug, Default)]
pub struct Sample<'a> {
    pub cluster: &'a str,
    pub origin: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    /// Unix ms.
    pub started_at: u64,
    pub ms: u64,
    pub bytes: Option<u64>,
    pub status: &'a str,
    /// It reached the cluster.
    pub sent: bool,
    /// Answered from the read cache, or by another's request.
    pub cached: bool,
    pub shared: bool,
}

impl<'a> Sample<'a> {
    /// A finished record as the worker's request ring keeps it (`worker/requests.jsonl`). The
    /// ring has no `sent` flag: a record with a time and no cache, share or gate refusal was sent.
    pub fn from_json(v: &'a Value) -> Option<Sample<'a>> {
        let s = |k: &str| v.get(k).and_then(Value::as_str);
        let status = s("status").unwrap_or("");
        let cached = v.get("cached").and_then(Value::as_bool).unwrap_or(false);
        let shared = v.get("shared").and_then(Value::as_bool).unwrap_or(false);
        Some(Sample {
            cluster: s("cluster")?, origin: s("origin").unwrap_or(""), method: s("method").unwrap_or("GET"), path: s("path").unwrap_or(""),
            started_at: v.get("startedAt").and_then(Value::as_u64)?, ms: v.get("ms").and_then(Value::as_u64)?,
            bytes: v.get("bytes").and_then(Value::as_u64), status,
            sent: !cached && !shared && !DEFERRED.contains(&status), cached, shared,
        })
    }
}

/// One cluster × kind in one hour.
#[derive(Clone, Debug, Default, PartialEq)]
struct Cell {
    requests: u64,
    ms_total: u64,
    ms_max: u64,
    /// Bytes read, over the requests whose answer size is known (`bytes_known` of them).
    bytes: u64,
    bytes_known: u64,
    timeouts: u64,
    deferrals: u64,
    hist: [u32; STEPS.len()],
}

impl Cell {
    fn add(&mut self, o: &Cell) {
        self.requests += o.requests;
        self.ms_total += o.ms_total;
        self.ms_max = self.ms_max.max(o.ms_max);
        self.bytes += o.bytes;
        self.bytes_known += o.bytes_known;
        self.timeouts += o.timeouts;
        self.deferrals += o.deferrals;
        for (a, b) in self.hist.iter_mut().zip(o.hist.iter()) {
            *a = a.saturating_add(*b);
        }
    }

    /// The step at or above the 95th percentile request; `None` with no request.
    fn p95(&self) -> Option<u64> {
        if self.requests == 0 {
            return None;
        }
        let want = (self.requests * 95).div_ceil(100);
        let mut seen = 0u64;
        for (i, n) in self.hist.iter().enumerate() {
            seen += *n as u64;
            if seen >= want {
                return Some(STEPS[i].min(self.ms_max));
            }
        }
        Some(self.ms_max)
    }
}

#[derive(Clone, Debug, Default)]
struct Hour {
    start: u64,
    cells: HashMap<(String, String), Cell>,
}

/// One of the slowest requests.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Expensive {
    pub at: u64,
    pub cluster: String,
    pub kind: String,
    pub method: String,
    /// The path without its query string's values (`clean_path`).
    pub path: String,
    pub ms: u64,
    pub bytes: Option<u64>,
    pub status: String,
}

/// The cost of the last `KEEP_HOURS` of requests (module docs).
#[derive(Clone, Debug, Default)]
pub struct CostBook {
    /// The first request this book took: the window shown starts no earlier.
    since: Option<u64>,
    hours: VecDeque<Hour>,
    top: HashMap<String, Vec<Expensive>>,
}

/// The kind a request's origin counts under: the job it is part of (`job:<job id>`), a poller
/// dataset (`poller:<dataset>`), a page (`page:<page>`), or the origin itself, cleaned and cut.
pub fn kind_of(origin: &str) -> String {
    let job = match origin {
        "delay-sink" => Some(crate::jobs::LOGDELAY_MEASURE),
        "volume-daily" => Some(crate::jobs::VOLUME_DAILY),
        o if o == crate::report::hosts::ORIGIN => Some(crate::jobs::HOSTS_COLLECT),
        o if o == "volume-report" || o == crate::report::indices::ORIGIN => Some(crate::jobs::REPORT_RUN),
        o if o == crate::history_store::ORIGIN => Some(crate::jobs::HISTORY_MIRROR),
        _ => None,
    };
    if let Some(j) = job {
        return format!("job:{j}");
    }
    let clean: String = origin.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-')).take(KIND_MAX).collect();
    if clean.is_empty() { "core".into() } else { clean }
}

/// A job's kind (`job:<job id>`), for its deferred runs.
pub fn kind_of_job(job_id: &str) -> String {
    format!("job:{job_id}")
}

/// A kind in words: "Log delay measurement", "Poller · health", "Page · overview", "REST console".
pub fn kind_label(kind: &str) -> String {
    if let Some(j) = kind.strip_prefix("job:") {
        return crate::jobs::descriptor(j).map(|d| d.name.to_string()).unwrap_or_else(|| j.to_string());
    }
    if let Some(d) = kind.strip_prefix("poller:") {
        return format!("Poller · {d}");
    }
    if let Some(p) = kind.strip_prefix("page:") {
        return format!("Page · {p}");
    }
    match kind {
        "console" => "REST console".into(),
        OTHER => "Other kinds".into(),
        k => k.to_string(),
    }
}

/// A path as the top list shows it: the query string's names kept, their values left out (a
/// value can carry a secret or a whole query), redacted and cut.
pub fn clean_path(path: &str) -> String {
    let (p, q) = path.split_once('?').unwrap_or((path, ""));
    let names: Vec<&str> = q.split('&').filter(|kv| !kv.is_empty()).map(|kv| kv.split_once('=').map_or(kv, |(k, _)| k)).collect();
    let s = if names.is_empty() { p.to_string() } else { format!("{p}?{}", names.join("&")) };
    let s = crate::jobs::detail::redact(&s);
    if s.chars().count() > PATH_MAX { format!("{}…", s.chars().take(PATH_MAX).collect::<String>()) } else { s }
}

fn step_of(ms: u64) -> usize {
    STEPS.iter().position(|s| ms <= *s).unwrap_or(STEPS.len() - 1)
}

impl CostBook {
    /// Drop the hours and the top entries older than the window.
    fn prune(&mut self, now: u64) {
        let edge = now.saturating_sub(KEEP_HOURS * HOUR_MS);
        while self.hours.front().is_some_and(|h| h.start + HOUR_MS <= edge) {
            self.hours.pop_front();
        }
        self.top.retain(|_, v| {
            v.retain(|e| e.at >= edge);
            !v.is_empty()
        });
    }

    fn cell(&mut self, cluster: &str, kind: &str, at: u64, now: u64) -> Option<&mut Cell> {
        if at + KEEP_HOURS * HOUR_MS <= now {
            return None;
        }
        self.since = Some(self.since.map_or(at, |s| s.min(at)));
        self.prune(now);
        let start = at - at % HOUR_MS;
        let i = match self.hours.iter().rposition(|h| h.start <= start) {
            Some(i) if self.hours[i].start == start => i,
            Some(i) => {
                self.hours.insert(i + 1, Hour { start, cells: HashMap::new() });
                i + 1
            }
            None => {
                self.hours.push_front(Hour { start, cells: HashMap::new() });
                0
            }
        };
        let h = &mut self.hours[i];
        let mut key = (cluster.to_string(), kind.to_string());
        if !h.cells.contains_key(&key) && h.cells.len() >= CELLS_MAX {
            key.1 = OTHER.to_string();
        }
        Some(h.cells.entry(key).or_default())
    }

    /// Count one finished request (`now`: the clock, for the window).
    pub fn add(&mut self, s: &Sample<'_>, now: u64) {
        if s.cached || s.shared || s.cluster.is_empty() {
            return;
        }
        let kind = kind_of(s.origin);
        let deferred = !s.sent && DEFERRED.contains(&s.status);
        if !s.sent && !deferred {
            return;
        }
        let Some(c) = self.cell(s.cluster, &kind, s.started_at, now) else { return };
        if deferred {
            c.deferrals += 1;
            return;
        }
        c.requests += 1;
        c.ms_total += s.ms;
        c.ms_max = c.ms_max.max(s.ms);
        c.hist[step_of(s.ms)] = c.hist[step_of(s.ms)].saturating_add(1);
        if let Some(b) = s.bytes {
            c.bytes += b;
            c.bytes_known += 1;
        }
        if TIMED_OUT.contains(&s.status) {
            c.timeouts += 1;
        }
        let top = self.top.entry(s.cluster.to_string()).or_default();
        if top.len() < TOP_PER_CLUSTER || top.last().is_some_and(|e| e.ms < s.ms) {
            top.push(Expensive { at: s.started_at, cluster: s.cluster.to_string(), kind, method: s.method.to_string(),
                                 path: clean_path(s.path), ms: s.ms, bytes: s.bytes, status: s.status.to_string() });
            top.sort_by(|a, b| b.ms.cmp(&a.ms).then(b.at.cmp(&a.at)));
            top.truncate(TOP_PER_CLUSTER);
        }
    }

    /// Count one deferral that sent no request: a job's cluster held back because it was busy.
    pub fn add_deferral(&mut self, cluster: &str, kind: &str, at: u64, now: u64) {
        if let Some(c) = self.cell(cluster, kind, at, now) {
            c.deferrals += 1;
        }
    }

    /// How many cells the book holds now (for the bound's test).
    pub fn cells(&self) -> usize {
        self.hours.iter().map(|h| h.cells.len()).sum()
    }

    /// What a caller may read (`sees`: the clusters they may see), from one or more books (the
    /// core's own, the worker's ring, the run log's deferrals): per cluster × kind over the
    /// window, most requests first, and the `TOP_SHOWN` slowest requests.
    pub fn view(books: &[&CostBook], sees: impl Fn(&str) -> bool, now: u64) -> Value {
        let edge = now.saturating_sub(KEEP_HOURS * HOUR_MS);
        let mut sum: HashMap<(String, String), Cell> = HashMap::new();
        for b in books {
            for h in b.hours.iter().filter(|h| h.start + HOUR_MS > edge) {
                for ((cl, k), c) in h.cells.iter().filter(|((cl, _), _)| sees(cl)) {
                    sum.entry((cl.clone(), k.clone())).or_default().add(c);
                }
            }
        }
        let since = books.iter().filter_map(|b| b.since).min().map(|s| s.max(edge));
        // Requests per hour over the hours the book has actually covered, at least one.
        let hours = since.map_or(1.0, |s| (now.saturating_sub(s) as f64 / HOUR_MS as f64).clamp(1.0, KEEP_HOURS as f64));
        let mut rows: Vec<Value> = sum.into_iter().map(|((cluster, kind), c)| json!({
            "cluster": cluster, "label": kind_label(&kind), "kind": kind,
            "requests": c.requests, "perHour": ((c.requests as f64 / hours) * 10.0).round() / 10.0,
            "avgMs": (c.requests > 0).then(|| c.ms_total / c.requests), "p95Ms": c.p95(), "maxMs": (c.requests > 0).then_some(c.ms_max),
            // Bytes over the requests whose size is known; null when none is.
            "bytes": (c.bytes_known > 0).then_some(c.bytes), "bytesKnown": c.bytes_known,
            "timeouts": c.timeouts, "deferrals": c.deferrals,
        })).collect();
        rows.sort_by(|a, b| b["requests"].as_u64().cmp(&a["requests"].as_u64())
            .then_with(|| a["cluster"].as_str().cmp(&b["cluster"].as_str())).then_with(|| a["kind"].as_str().cmp(&b["kind"].as_str())));
        let mut top: Vec<&Expensive> = books.iter().flat_map(|b| b.top.iter()).filter(|(cl, _)| sees(cl)).flat_map(|(_, v)| v.iter())
            .filter(|e| e.at >= edge).collect();
        top.sort_by(|a, b| b.ms.cmp(&a.ms).then(b.at.cmp(&a.at)));
        top.truncate(TOP_SHOWN);
        let top: Vec<Value> = top.into_iter().map(|e| {
            let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
            v["label"] = json!(kind_label(&e.kind));
            v
        }).collect();
        json!({ "ok": true, "keepHours": KEEP_HOURS, "since": since, "hours": (hours * 10.0).round() / 10.0, "now": now, "rows": rows, "top": top })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn req<'a>(cluster: &'a str, origin: &'a str, ms: u64, at: u64) -> Sample<'a> {
        Sample { cluster, origin, method: "GET", path: "/_cat/indices?format=json&h=index", started_at: at, ms, bytes: Some(1000), status: "200", sent: true, ..Default::default() }
    }

    #[test]
    fn requests_are_counted_per_cluster_and_kind_with_average_p95_bytes_and_timeouts() {
        let mut b = CostBook::default();
        for i in 0..19 {
            b.add(&req("a", "poller:health", 100, NOW - 1000 - i), NOW);
        }
        b.add(&Sample { status: "timeout", bytes: None, ..req("a", "poller:health", 30_000, NOW - 500) }, NOW);
        b.add(&req("a", "delay-sink", 8_000, NOW - 400), NOW);
        let v = CostBook::view(&[&b], |_| true, NOW);
        let rows = v["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let h = &rows[0];
        assert_eq!((h["kind"].as_str(), h["label"].as_str()), (Some("poller:health"), Some("Poller · health")));
        assert_eq!(h["requests"], 20);
        assert_eq!(h["avgMs"], (19 * 100 + 30_000) / 20);
        assert_eq!(h["p95Ms"], 100, "19 of 20 at 100 ms: the 95th is in the 100 ms step");
        assert_eq!(h["timeouts"], 1);
        assert_eq!((h["bytes"].clone(), h["bytesKnown"].clone()), (json!(19_000), json!(19)), "a size not known is not counted as 0 bytes");
        assert_eq!(rows[1]["kind"], "job:logdelay.measure");
        assert_eq!(rows[1]["label"], "Log delay measurement");
        assert_eq!(v["top"][0]["ms"], 30_000);
        assert_eq!(v["top"][0]["path"], "/_cat/indices?format&h", "the query's values are left out");
    }

    #[test]
    fn cache_and_shared_answers_cost_nothing_and_a_gate_refusal_is_a_deferral() {
        let mut b = CostBook::default();
        b.add(&Sample { cached: true, sent: false, ..req("a", "poller:nodes", 0, NOW) }, NOW);
        b.add(&Sample { shared: true, sent: false, ..req("a", "poller:nodes", 50, NOW) }, NOW);
        b.add(&Sample { sent: false, status: "overloaded", ..req("a", "poller:nodes", 0, NOW) }, NOW);
        b.add(&Sample { sent: false, status: "aborted", ..req("a", "poller:nodes", 0, NOW) }, NOW);
        b.add_deferral("a", &kind_of_job(crate::jobs::HOSTS_COLLECT), NOW - 10, NOW);
        let v = CostBook::view(&[&b], |_| true, NOW);
        let rows = v["rows"].as_array().unwrap();
        let nodes = rows.iter().find(|r| r["kind"] == "poller:nodes").unwrap();
        assert_eq!((nodes["requests"].clone(), nodes["deferrals"].clone(), nodes["avgMs"].clone(), nodes["p95Ms"].clone()), (json!(0), json!(1), Value::Null, Value::Null));
        assert_eq!(rows.iter().find(|r| r["kind"] == "job:hosts.collect").unwrap()["deferrals"], 1);
        assert!(v["top"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_limited_caller_sees_only_their_clusters_in_rows_and_the_top_list() {
        let mut b = CostBook::default();
        b.add(&req("mine", "poller:health", 10, NOW), NOW);
        b.add(&req("theirs", "poller:health", 99_000, NOW), NOW);
        let v = CostBook::view(&[&b], |c| c == "mine", NOW);
        assert!(!v.to_string().contains("theirs"), "{v}");
        assert_eq!(v["top"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_window_is_the_last_24_hours_and_the_book_stays_bounded() {
        let mut b = CostBook::default();
        b.add(&req("a", "poller:health", 10, NOW - 30 * HOUR_MS), NOW);
        assert_eq!(b.cells(), 0, "older than the window: not kept");
        b.add(&req("a", "poller:health", 10, NOW - 23 * HOUR_MS), NOW - 23 * HOUR_MS);
        b.add(&req("a", "poller:health", 10, NOW), NOW);
        assert_eq!(CostBook::view(&[&b], |_| true, NOW)["rows"][0]["requests"], 2);
        assert_eq!(CostBook::view(&[&b], |_| true, NOW + 2 * HOUR_MS)["rows"][0]["requests"], 1, "the old hour leaves the window");
        // A page that names a new origin every time cannot grow an hour past its bound.
        let names: Vec<String> = (0..CELLS_MAX + 50).map(|i| format!("page:p{i}")).collect();
        let mut b = CostBook::default();
        for n in &names {
            b.add(&req("a", n, 1, NOW), NOW);
        }
        assert_eq!(b.cells(), CELLS_MAX + 1, "past the bound the further kinds share one cell");
        assert_eq!(b.top.get("a").map(Vec::len), Some(TOP_PER_CLUSTER));
        assert_eq!(kind_of(&"x".repeat(500)).len(), KIND_MAX);
        // Requests per hour: over the hours covered, at least one.
        let mut b = CostBook::default();
        for i in 0..12 {
            b.add(&req("a", "poller:health", 10, NOW - i * HOUR_MS / 2), NOW);
        }
        assert_eq!(CostBook::view(&[&b], |_| true, NOW)["rows"][0]["perHour"], 2.2, "12 over 5.5 hours");
    }

    #[test]
    fn a_worker_ring_record_reads_as_a_sample() {
        let v = json!({ "cluster": "a", "origin": "volume-hosts", "method": "POST", "path": "/logstash-*/_search", "startedAt": NOW, "ms": 2500,
                        "bytes": 400, "status": "200", "cached": false, "shared": false, "process": "worker" });
        let s = Sample::from_json(&v).unwrap();
        assert!(s.sent);
        assert_eq!(kind_of(s.origin), "job:hosts.collect");
        let refused = json!({ "cluster": "a", "origin": "volume-hosts", "startedAt": NOW, "ms": 0, "status": "queue_timeout" });
        assert!(!Sample::from_json(&refused).unwrap().sent);
        assert!(Sample::from_json(&json!({ "cluster": "a" })).is_none(), "no time: not a finished record");
        assert_eq!(clean_path("/x/_search?q=password:hunter2"), "/x/_search?q");
        assert_eq!(kind_label("console"), "REST console");
    }
}
