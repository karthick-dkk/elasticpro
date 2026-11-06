//! Which snapshots are running, read out of one cluster's `snapshot_status` entry.
//!
//! The one definition of "a snapshot is in progress" and of "this reading is good enough
//! to show a dot for": `SNAPSHOT_RUNNING` (fleet/mod.rs) calls it per cluster, and the tests
//! here hold it still. Pure — no lock, no clock but the one passed in.

use super::entry::{Entry, Status};
use serde_json::{json, Value};

/// What one cluster's entry says.
#[derive(Debug, Default, PartialEq)]
pub struct Reading {
    /// A fresh, successful reading exists: `running` is the truth, an empty list meaning
    /// nothing runs. `false`: nothing is known, and `why` says so.
    pub known: bool,
    pub why: Option<String>,
    pub fetched_at: Option<u64>,
    pub stale_after_ms: Option<u64>,
    /// `[{repository, snapshot, state, started, elapsedMs}]`, oldest start first.
    pub running: Vec<Value>,
}

/// A snapshot state that is over. Anything else — `INIT`, `STARTED`, `IN_PROGRESS`,
/// `ABORTING` — is still running.
fn finished(state: &str) -> bool {
    matches!(state, "SUCCESS" | "FAILED" | "ABORTED" | "PARTIAL" | "MISSING")
}

/// The running snapshots in a `_snapshot/_status` body (`{snapshots: [...]}`).
pub fn running_in(status_json: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = status_json
        .get("snapshots")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|s| !finished(s.get("state").and_then(Value::as_str).unwrap_or("")))
                .map(|s| {
                    let stats = s.get("stats");
                    json!({
                        "repository": s.get("repository").and_then(Value::as_str).unwrap_or(""),
                        "snapshot": s.get("snapshot").and_then(Value::as_str).unwrap_or(""),
                        "state": s.get("state").and_then(Value::as_str).unwrap_or(""),
                        "started": stats.and_then(|t| t.get("start_time_in_millis")).and_then(Value::as_u64),
                        "elapsedMs": stats.and_then(|t| t.get("time_in_millis")).and_then(Value::as_u64),
                        "shards": s.get("shards_stats").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|r| r["started"].as_u64().unwrap_or(u64::MAX));
    out
}

/// The reading for one cluster's entry at `now`. `None` is a cluster never fetched.
pub fn read(entry: Option<&Entry>, now: u64) -> Reading {
    let Some(e) = entry else {
        return Reading { why: Some("not fetched yet".into()), ..Reading::default() };
    };
    let mut r = Reading { fetched_at: e.fetched_at, stale_after_ms: Some(e.stale_after_ms), ..Reading::default() };
    let body = match (&e.status, &e.data) {
        (Status::Never, _) | (_, None) => {
            r.why = Some(match &e.error {
                Some(err) => format!("the last fetch failed: {}", err.get("message").and_then(Value::as_str).filter(|m| !m.is_empty())
                    .or_else(|| err.get("kind").and_then(Value::as_str)).unwrap_or("unknown")),
                None => "not fetched yet".into(),
            });
            return r;
        }
        (Status::Restored, _) => {
            r.why = Some("read back from disk at start-up, not re-fetched yet".into());
            return r;
        }
        (_, Some(b)) => b,
    };
    // The one request's own answer: `{ok, status, json}`.
    let status = body.field("status").unwrap_or(Value::Null);
    if status.get("ok") != Some(&json!(true)) {
        let m = status.get("message").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("the cluster did not answer _snapshot/_status");
        r.why = Some(format!("the last fetch failed: {m}"));
        return r;
    }
    if let Some(at) = e.fetched_at {
        if now.saturating_sub(at) > e.stale_after_ms {
            let mins = now.saturating_sub(at) / 60_000;
            r.why = Some(format!("the last reading is {mins} min old"));
            return r;
        }
    }
    r.known = true;
    r.running = running_in(status.get("json").unwrap_or(&Value::Null));
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::entry::Body;

    fn entry(status: Status, body: Option<Value>, fetched_at: Option<u64>) -> Entry {
        Entry { status, fetched_at, data: body.map(|b| Body::from_value(&b)), stale_after_ms: 600_000, ..Entry::never(600_000, None) }
    }

    fn answer(snapshots: Value) -> Value {
        json!({ "status": { "ok": true, "status": 200, "json": { "snapshots": snapshots } } })
    }

    #[test]
    fn a_running_snapshot_is_named_and_a_finished_one_is_not() {
        let list = running_in(&json!({ "snapshots": [
            { "snapshot": "s2", "repository": "r", "state": "STARTED", "stats": { "start_time_in_millis": 2000, "time_in_millis": 50 } },
            { "snapshot": "done", "repository": "r", "state": "SUCCESS", "stats": { "start_time_in_millis": 1 } },
            { "snapshot": "s1", "repository": "r2", "state": "INIT", "stats": { "start_time_in_millis": 1000 } },
        ] }));
        assert_eq!(list.len(), 2);
        assert_eq!((list[0]["snapshot"].as_str(), list[0]["repository"].as_str()), (Some("s1"), Some("r2")), "oldest start first");
        assert_eq!(list[1]["started"], json!(2000));
        assert_eq!(list[1]["elapsedMs"], json!(50));
        assert!(running_in(&json!({})).is_empty());
        assert!(running_in(&Value::Null).is_empty());
    }

    #[test]
    fn a_fresh_reading_is_known_even_when_nothing_runs() {
        let e = entry(Status::Ok, Some(answer(json!([]))), Some(1_000_000));
        let r = read(Some(&e), 1_000_000 + 60_000);
        assert!(r.known && r.running.is_empty() && r.why.is_none(), "{r:?}");
    }

    #[test]
    fn unknown_is_said_with_a_reason_never_as_empty() {
        assert_eq!(read(None, 5).why.as_deref(), Some("not fetched yet"));
        let never = Entry::never(600_000, None);
        assert_eq!(read(Some(&never), 5).why.as_deref(), Some("not fetched yet"));
        let stale = entry(Status::Ok, Some(answer(json!([{ "snapshot": "s", "repository": "r", "state": "STARTED" }]))), Some(0));
        let r = read(Some(&stale), 601_000);
        assert!(!r.known && r.running.is_empty(), "a stale reading is not shown as the truth: {r:?}");
        assert_eq!(r.why.as_deref(), Some("the last reading is 10 min old"));
        let mut failed = Entry::never(600_000, None);
        failed.status = Status::Error;
        failed.error = Some(json!({ "kind": "timeout", "message": "took too long" }));
        assert_eq!(read(Some(&failed), 5).why.as_deref(), Some("the last fetch failed: took too long"));
        let refused = entry(Status::Ok, Some(json!({ "status": { "ok": false, "status": 403, "message": "forbidden by the cluster" } })), Some(0));
        assert_eq!(read(Some(&refused), 5).why.as_deref(), Some("the last fetch failed: forbidden by the cluster"));
        let restored = entry(Status::Restored, Some(answer(json!([]))), Some(0));
        assert!(read(Some(&restored), 5).why.as_deref().unwrap().contains("not re-fetched"));
    }
}
