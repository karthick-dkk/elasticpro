//! `SLOW_SEARCHES {minMs}` (docs/JOBS.md "Slow searches"): the searches running long on the
//! clusters the caller sees, for the *Slow searches now* card of Jobs › Jobs.
//!
//! * Read only while somebody has the Jobs page open: the page asks at most every 30 s, and a
//!   cluster's task list is read at most once in `READ_EVERY_MS` however many people ask: a
//!   cluster is marked in flight under the lock before its read goes out, so a second caller
//!   meanwhile shares that read instead of sending another.
//! * One `GET tasks::SEARCH_TASKS_PATH` per cluster, background class, through the gate like
//!   every background read, at most `AT_ONCE` clusters at a time. A cluster the governor's
//!   signals call busy, or the poller cannot reach, is not read and is said so ("not read:
//!   busy …") — unknown is not zero, so it is never counted as "no slow search".
//! * The answer comes within `WAIT_MS` from what is read by then; clusters still being read are
//!   listed in `reading` (the page asks again soon), so a large fleet never holds the request.
//! * Read only. ElasticPro's own searches (opaque id `elasticpro/…`) are labelled; nothing is
//!   cancelled from here.

use super::{Caller, Core};
use crate::gate::Class;
use crate::http::EsRequest;
use crate::tasks::{self, SlowSearch};
use serde_json::{json, Value};
use std::sync::Arc;

/// A cluster's task list is read at most once in this long (the page asks every 30 s).
pub const READ_EVERY_MS: u64 = 25_000;
/// The thresholds the card offers; `minMs` must be one of them, the default 30 s.
pub const THRESHOLDS_MS: [u64; 4] = [10_000, 30_000, 60_000, 300_000];
pub const DEFAULT_MIN_MS: u64 = 30_000;
/// Clusters read at once.
const AT_ONCE: usize = 4;
/// One cluster's read, at most.
const TIMEOUT_MS: u64 = 10_000;
/// How long an answer waits for the reads it started; what is still out is `reading`.
pub const WAIT_MS: u64 = 4_000;
/// A read marked in flight longer than this is taken to have been lost (a panic) and is sent again.
const INFLIGHT_STALE_MS: u64 = TIMEOUT_MS * 3;
const ORIGIN: &str = "core:slow-searches";
/// The searches listed at most (longest first); the count says how many there were.
const LIST_MAX: usize = 200;

/// One cluster's state: its last read (when, and its searches — every one from 10 s up — or why
/// it was not read), and since when a read is in flight, if one is.
#[derive(Clone, Debug, Default)]
pub(crate) struct SlowRead {
    pub(crate) read: Option<(u64, Result<Vec<SlowSearch>, String>)>,
    pub(crate) reading_since: Option<u64>,
}

/// What to do with one cluster now: under the lock, so two callers never both send its read.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    /// Read within `READ_EVERY_MS`, or being read by somebody else: answer from what is kept.
    Kept,
    /// Read it now; it is marked in flight.
    Read,
}

/// The one rule: fresh or in flight is kept, otherwise the cluster is marked in flight and read.
pub(crate) fn plan(e: &mut SlowRead, now: u64) -> Plan {
    if e.read.as_ref().is_some_and(|(at, _)| now.saturating_sub(*at) < READ_EVERY_MS) {
        return Plan::Kept;
    }
    if e.reading_since.is_some_and(|t| now.saturating_sub(t) < INFLIGHT_STALE_MS) {
        return Plan::Kept;
    }
    e.reading_since = Some(now);
    Plan::Read
}

impl Core {
    pub(crate) async fn slow_searches(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let min_ms = match msg.get("minMs") {
            None | Some(Value::Null) => DEFAULT_MIN_MS,
            Some(v) => match v.as_u64().filter(|n| THRESHOLDS_MS.contains(n)) {
                Some(n) => n,
                None => return json!({ "ok": false, "kind": "bad_request", "message": "minMs must be one of 10000, 30000, 60000 or 300000" }),
            },
        };
        let now = crate::fleet::now_ms();
        let ids = self.fleet_visible(caller);
        // Busy and unreachable first (they lock other state); then, under the cache's lock, which
        // clusters this call reads — each marked in flight before the lock is let go.
        let mut skipped: Vec<(String, String)> = vec![];
        let mut candidates: Vec<String> = vec![];
        for id in &ids {
            if let Some(b) = self.cluster_busy(id) {
                skipped.push((id.clone(), format!("busy: {}", b.reason)));
            } else if self.volume_unreachable(id) {
                skipped.push((id.clone(), "unreachable".into()));
            } else {
                candidates.push(id.clone());
            }
        }
        let to_read: Vec<String> = {
            let mut cache = self.slow_cache.lock();
            candidates.into_iter().filter(|id| plan(cache.entry(id.clone()).or_default(), now) == Plan::Read).collect()
        };
        if !to_read.is_empty() {
            // The reads go on by themselves; this answer waits for them at most WAIT_MS.
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let core = self.clone();
            tokio::spawn(async move {
                let sem = Arc::new(tokio::sync::Semaphore::new(AT_ONCE));
                let mut set = tokio::task::JoinSet::new();
                for id in to_read {
                    let core = core.clone();
                    let sem = sem.clone();
                    set.spawn(async move {
                        let _permit = sem.acquire_owned().await;
                        let out = core.slow_read(&id).await;
                        let mut cache = core.slow_cache.lock();
                        let e = cache.entry(id).or_default();
                        e.read = Some((crate::fleet::now_ms(), out));
                        e.reading_since = None;
                    });
                }
                while set.join_next().await.is_some() {}
                let _ = tx.send(());
            });
            let _ = tokio::time::timeout(std::time::Duration::from_millis(WAIT_MS), rx).await;
        }
        // The answer: every cluster the caller sees, as read now or within READ_EVERY_MS.
        let cache = self.slow_cache.lock();
        let mut searches: Vec<Value> = vec![];
        let mut not_read: Vec<Value> = skipped.iter().map(|(id, why)| json!({ "cluster": id, "name": self.cluster_name(id), "why": format!("not read: {why}") })).collect();
        let mut reading: Vec<Value> = vec![];
        let mut read = 0usize;
        let mut oldest: Option<u64> = None;
        for id in &ids {
            if skipped.iter().any(|(s, _)| s == id) {
                continue;
            }
            let Some(e) = cache.get(id) else { continue };
            match &e.read {
                None => reading.push(json!({ "cluster": id, "name": self.cluster_name(id) })),
                Some((at, Ok(list))) => {
                    read += 1;
                    oldest = Some(oldest.map_or(*at, |o| o.min(*at)));
                    for s in list.iter().filter(|s| s.running_ms >= min_ms) {
                        searches.push(json!({
                            "cluster": id, "name": self.cluster_name(id), "taskId": s.task_id, "node": s.node, "action": s.action,
                            "runningMs": s.running_ms, "startedAt": s.start_ms, "indices": s.indices, "query": s.query,
                            "description": s.description, "opaqueId": s.opaque_id, "by": if s.ours() { json!("ElasticPro") } else { Value::Null },
                            "readAt": at,
                        }));
                    }
                }
                Some((_, Err(why))) => not_read.push(json!({ "cluster": id, "name": self.cluster_name(id), "why": format!("not read: {why}") })),
            }
        }
        drop(cache);
        searches.sort_by(|a, b| b["runningMs"].as_u64().cmp(&a["runningMs"].as_u64()));
        let count = searches.len();
        searches.truncate(LIST_MAX);
        json!({ "ok": true, "minMs": min_ms, "at": now, "readEveryMs": READ_EVERY_MS, "thresholdsMs": THRESHOLDS_MS,
                "count": count, "searches": searches, "clustersRead": read, "clustersSeen": ids.len(), "notRead": not_read,
                "reading": reading, "readAt": oldest })
    }

    /// One cluster's task list, or why it could not be read.
    async fn slow_read(self: &Arc<Self>, id: &str) -> Result<Vec<SlowSearch>, String> {
        let res = self.es_req(EsRequest {
            cluster_id: id.to_string(), method: "GET".into(), path: tasks::SEARCH_TASKS_PATH.into(), timeout_ms: Some(TIMEOUT_MS),
            origin: Some(ORIGIN.into()), class: Class::Background, ..Default::default()
        }).await;
        if res.get("ok") == Some(&json!(true)) {
            return Ok(tasks::slow_searches(res.get("json").unwrap_or(&Value::Null), THRESHOLDS_MS[0]));
        }
        Err(match res.get("kind").and_then(Value::as_str) {
            Some("no_creds") => "not primed".to_string(),
            _ => {
                let (_, status) = super::status_of(&res);
                let m = res.get("message").and_then(Value::as_str).unwrap_or("");
                if m.is_empty() { format!("the cluster answered {status}") } else { format!("{status}: {}", crate::jobs::detail::cut(m, 120)) }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cluster_is_read_once_however_many_ask_at_once() {
        let mut e = SlowRead::default();
        assert_eq!(plan(&mut e, 1_000), Plan::Read, "nothing kept: read it");
        assert_eq!(plan(&mut e, 1_500), Plan::Kept, "in flight: the second caller shares it");
        e.read = Some((3_000, Ok(vec![])));
        e.reading_since = None;
        assert_eq!(plan(&mut e, 3_000 + READ_EVERY_MS - 1), Plan::Kept, "fresh");
        assert_eq!(plan(&mut e, 3_000 + READ_EVERY_MS), Plan::Read, "due again");
        // A read lost in flight (its task ended without a word) is sent again, later.
        assert_eq!(plan(&mut e, 3_000 + READ_EVERY_MS + INFLIGHT_STALE_MS + 1), Plan::Read);
    }
}
