//! `SLOW_SEARCHES {minMs}` (docs/JOBS.md "Slow searches"): the searches running long on the
//! clusters the caller sees, for the *Slow searches now* card of Jobs › Jobs.
//!
//! * Read only while somebody has the Jobs page open: the page asks at most every 30 s, and a
//!   cluster's task list is read at most once in `READ_EVERY_MS` however many people ask
//!   (one answer per cluster, kept that long).
//! * One `GET tasks::SEARCH_TASKS_PATH` per cluster, background class, through the gate like
//!   every background read, at most `AT_ONCE` clusters at a time. A cluster the governor's
//!   signals call busy, or the poller cannot reach, is not read and is said so ("not read:
//!   busy …") — unknown is not zero, so it is never counted as "no slow search".
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
const ORIGIN: &str = "core:slow-searches";
/// The searches listed at most (longest first); the count says how many there were.
const LIST_MAX: usize = 200;

/// What one cluster's last read gave: when, and its searches (every one, from 10 s up) or why
/// it was not read.
pub(crate) type SlowRead = (u64, Result<Vec<SlowSearch>, String>);

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
        let mut skipped: Vec<(String, String)> = vec![];
        let mut to_read: Vec<String> = vec![];
        {
            let cache = self.slow_cache.lock();
            for id in &ids {
                if cache.get(id).is_some_and(|(at, _)| now.saturating_sub(*at) < READ_EVERY_MS) {
                    continue;
                }
                if let Some(b) = self.cluster_busy(id) {
                    skipped.push((id.clone(), format!("busy: {}", b.reason)));
                } else if self.volume_unreachable(id) {
                    skipped.push((id.clone(), "unreachable".into()));
                } else {
                    to_read.push(id.clone());
                }
            }
        }
        // Read what is due, a few clusters at a time.
        let sem = Arc::new(tokio::sync::Semaphore::new(AT_ONCE));
        let mut set = tokio::task::JoinSet::new();
        for id in to_read {
            let core = self.clone();
            let sem = sem.clone();
            set.spawn(async move {
                let _permit = sem.acquire_owned().await;
                let res = core.es_req(EsRequest {
                    cluster_id: id.clone(), method: "GET".into(), path: tasks::SEARCH_TASKS_PATH.into(), timeout_ms: Some(TIMEOUT_MS),
                    origin: Some(ORIGIN.into()), class: Class::Background, ..Default::default()
                }).await;
                let out = if res.get("ok") == Some(&json!(true)) {
                    Ok(tasks::slow_searches(res.get("json").unwrap_or(&Value::Null), THRESHOLDS_MS[0]))
                } else {
                    Err(match res.get("kind").and_then(Value::as_str) {
                        Some("no_creds") => "not primed".to_string(),
                        _ => {
                            let (_, status) = super::status_of(&res);
                            let m = res.get("message").and_then(Value::as_str).unwrap_or("");
                            if m.is_empty() { format!("the cluster answered {status}") } else { format!("{status}: {}", crate::jobs::detail::cut(m, 120)) }
                        }
                    })
                };
                (id, out)
            });
        }
        while let Some(done) = set.join_next().await {
            if let Ok((id, out)) = done {
                self.slow_cache.lock().insert(id, (crate::fleet::now_ms(), out));
            }
        }
        // The answer: every cluster the caller sees, read now or within READ_EVERY_MS.
        let cache = self.slow_cache.lock();
        let mut searches: Vec<Value> = vec![];
        let mut not_read: Vec<Value> = skipped.iter().map(|(id, why)| json!({ "cluster": id, "name": self.cluster_name(id), "why": format!("not read: {why}") })).collect();
        let mut read = 0usize;
        let mut oldest: Option<u64> = None;
        for id in &ids {
            if skipped.iter().any(|(s, _)| s == id) {
                continue;
            }
            let Some((at, out)) = cache.get(id) else { continue };
            match out {
                Ok(list) => {
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
                Err(why) => not_read.push(json!({ "cluster": id, "name": self.cluster_name(id), "why": format!("not read: {why}") })),
            }
        }
        drop(cache);
        searches.sort_by(|a, b| b["runningMs"].as_u64().cmp(&a["runningMs"].as_u64()));
        let count = searches.len();
        searches.truncate(LIST_MAX);
        json!({ "ok": true, "minMs": min_ms, "at": now, "readEveryMs": READ_EVERY_MS, "thresholdsMs": THRESHOLDS_MS,
                "count": count, "searches": searches, "clustersRead": read, "clustersSeen": ids.len(), "notRead": not_read, "readAt": oldest })
    }
}
