//! What the cache holds for one dataset of one cluster, and what it knows about whether
//! the cluster can be reached at all.
//!
//! Unknown is not zero. An entry that has never been fetched says `never` and carries no
//! data rather than an empty list; one whose last fetch failed says `error` and keeps the
//! last body that was good, with the time *that* body was fetched — never the time of
//! the failure, which would pass an old answer off as a new one.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Error,
    Never,
    /// Read back from the disk cache at start-up, not yet re-fetched by this process.
    Restored,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub status: Status,
    /// When `data` was fetched (ms since the epoch). Not when the last attempt was.
    pub fetched_at: Option<u64>,
    /// When the last attempt finished, whatever its outcome.
    pub attempted_at: Option<u64>,
    pub next_due: Option<u64>,
    pub took_ms: Option<u64>,
    pub stale_after_ms: u64,
    pub seq: u64,
    /// `{kind, message, query, ...}` from the last failed attempt; null once one succeeds.
    pub error: Option<Value>,
    /// `{key: answer}` — the raw Elasticsearch body of each request under `json`, with
    /// its own `ok`/`status`, because one request can fail while the others answer (an
    /// SLM call on a basic licence) and the page shows that per figure.
    pub data: Option<Value>,
    /// Consecutive failed attempts, for the back-off.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub failures: u32,
    /// Size of `data` serialised, for the on-demand LRU. Not part of the wire shape.
    #[serde(skip)]
    pub bytes: usize,
    /// Last time somebody read this entry, for the LRU.
    #[serde(skip)]
    pub last_read: u64,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl Entry {
    pub fn never(stale_after_ms: u64, next_due: Option<u64>) -> Entry {
        Entry {
            status: Status::Never, fetched_at: None, attempted_at: None, next_due, took_ms: None,
            stale_after_ms, seq: 0, error: None, data: None, failures: 0, bytes: 0, last_read: 0,
        }
    }
}

/// What one fetch produced.
pub enum Outcome {
    /// Every request got an HTTP answer — some may be errors, and are recorded as such.
    Answered(Map<String, Value>),
    /// A request never reached Elasticsearch: the error, as `{kind, message, query, ...}`.
    Failed(Value),
}

/// The fields of an ES passthrough answer worth keeping. The URL is dropped: it is the
/// cluster's address, which the page already has and a guest does not need.
pub fn answer(mut v: Value) -> Value {
    // The trust details (`cert`, `pinned`, `hostKey`, `tunnel`) stay: they are what the
    // page's "Trust this certificate" and host-key buttons act on.
    let keep = ["ok", "status", "statusText", "kind", "message", "json", "tookMs", "help", "detail",
                "tunnelKind", "hostKey", "tunnel", "cert", "pinned"];
    if let Some(m) = v.as_object_mut() {
        if m.get("json").is_some_and(Value::is_null) {
            if let Some(Value::String(t)) = m.get("text") {
                // A non-JSON body is kept only as far as it explains itself.
                let short: String = t.chars().take(2000).collect();
                m.insert("text".into(), Value::String(short));
            }
        } else {
            m.remove("text");
        }
        m.retain(|k, _| keep.contains(&k.as_str()) || k == "text" || k == "source");
        if !m.contains_key("status") {
            m.insert("status".into(), json!(0));
        }
    }
    v
}

/// Did this answer come back from Elasticsearch at all? A 401 or a 500 did; a refused
/// connection, a timeout or a tunnel that is down did not.
pub fn reached(a: &Value) -> bool {
    a.get("status").and_then(Value::as_u64).unwrap_or(0) != 0
}

/// The error to show for an attempt, from the answer that failed.
pub fn error_of(key: &str, a: &Value) -> Value {
    let mut e = json!({
        "kind": a.get("kind").and_then(Value::as_str).unwrap_or("unknown"),
        "message": a.get("message").and_then(Value::as_str).unwrap_or(""),
        "query": key,
    });
    // Everything the direct passthrough says about a failure, in its shape, so a page acts
    // on a cached error exactly as on a live one.
    for k in ["help", "detail", "status", "tunnelKind", "tunnel", "hostKey", "cert", "pinned"] {
        if let Some(v) = a.get(k) {
            e[k] = v.clone();
        }
    }
    e
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReachState {
    Reachable,
    Unreachable,
    Unknown,
}

/// Whether a cluster answers, decided by the health dataset alone: the only one sent to
/// every cluster whatever its state, so the only one whose failure means the cluster
/// rather than an endpoint.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reach {
    pub state: ReachState,
    pub since: Option<u64>,
    pub last_error: Option<Value>,
    pub next_probe_at: Option<u64>,
    pub failures: u32,
    pub seq: u64,
}

impl Default for Reach {
    fn default() -> Self {
        Reach { state: ReachState::Unknown, since: None, last_error: None, next_probe_at: None, failures: 0, seq: 0 }
    }
}
