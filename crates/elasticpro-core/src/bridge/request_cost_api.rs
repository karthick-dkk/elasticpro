//! `REQUEST_COST` (docs/JOBS.md "Query cost"): Jobs › Requests › Cost — what ElasticPro's
//! requests cost each cluster, per kind of work, over the last day, and the slowest of them.
//!
//! Gathered from what the core already keeps: its own cost book (fed by every finished request
//! in the request log, `request_cost.rs`), the report worker's finished requests
//! (`worker/requests.jsonl`, the ring the Request Centre merges too), and the run log's deferred
//! runs (a job's cluster held back because it was busy). Read only; nothing is sent to a
//! cluster. A caller limited to some clusters reads only theirs (`sink_view`).

use super::{Caller, Core};
use crate::jobs::{self, Owner, RunStatus};
use crate::request_cost::{kind_of_job, CostBook, Sample, HOUR_MS, KEEP_HOURS};
use crate::worker::Role;
use serde_json::Value;

impl Core {
    pub(crate) fn request_cost(&self, caller: Option<&Caller>) -> Value {
        let view = self.sink_view(caller);
        let now = crate::fleet::now_ms();
        let edge = now.saturating_sub(KEEP_HOURS * HOUR_MS);
        // The worker's requests (role core): its ring, folded into a book of their own.
        let mut worker = CostBook::default();
        if self.role == Role::Core {
            if let Some(d) = self.data_dir.as_deref() {
                let ring = crate::worker::read_requests(d, crate::worker::REQUESTS_KEEP);
                for v in &ring {
                    if let Some(s) = Sample::from_json(v).filter(|s| s.started_at >= edge) {
                        worker.add(&s, now);
                    }
                }
                if let Some(since) = ring_partial_since(&ring, crate::worker::REQUESTS_KEEP, edge) {
                    worker.mark_partial(since);
                }
            }
        }
        // The jobs' deferrals: a deferred run holds one cluster back for the whole wait.
        let mut deferred = CostBook::default();
        let (mut runs, _) = self.jobs.all_runs();
        runs.extend(self.reports.snapshot().jobs.iter().map(|j| (Owner::Worker, jobs::from_report_job(j))));
        for (_, r) in runs.iter().filter(|(_, r)| r.status == RunStatus::Deferred && r.created_at >= edge) {
            let cluster = r.deferred.as_ref().map(|b| b.cluster.as_str()).or_else(|| r.clusters.first().map(String::as_str));
            if let Some(c) = cluster {
                deferred.add_deferral(c, &kind_of_job(&r.job_id), r.created_at, now);
            }
        }
        // The answer is built under the request log's lock rather than the whole book copied out
        // under it: no allocation of the book, and the summing is what the copy would cost anyway.
        let log = self.requests.lock();
        let answer = CostBook::view(&[&log.cost, &worker, &deferred], |c| view.sees(c), now);
        drop(log);
        answer
    }
}

/// When the worker's ring (`limit` records, newest first) was full and its oldest record is
/// inside the window, the window is not covered: the time from which it is. `None` when the ring
/// holds the whole window (not full, or its oldest record is older than the window's start).
fn ring_partial_since(ring: &[Value], limit: usize, edge: u64) -> Option<u64> {
    if ring.len() < limit {
        return None;
    }
    let oldest = ring.iter().filter_map(|v| v.get("startedAt").and_then(Value::as_u64)).min()?;
    (oldest > edge).then_some(oldest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_full_worker_ring_that_does_not_reach_back_a_day_is_partial() {
        let ring: Vec<Value> = (0..5u64).map(|i| json!({ "startedAt": 1_000 + i })).collect();
        assert_eq!(ring_partial_since(&ring, 5, 500), Some(1_000), "full, oldest inside the window: partial since it");
        assert_eq!(ring_partial_since(&ring, 6, 500), None, "not full: the whole window is there");
        assert_eq!(ring_partial_since(&ring, 5, 2_000), None, "full, but the oldest is older than the window");
    }
}
