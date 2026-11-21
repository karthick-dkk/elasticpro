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
        // Copied out and the lock let go at once: every request going to a cluster takes it.
        let own = self.requests.lock().cost.clone();
        // The worker's requests (role core): its ring, folded into a book of their own.
        let mut worker = CostBook::default();
        if self.role == Role::Core {
            if let Some(d) = self.data_dir.as_deref() {
                for v in crate::worker::read_requests(d, crate::worker::REQUESTS_KEEP) {
                    if let Some(s) = Sample::from_json(&v).filter(|s| s.started_at >= edge) {
                        worker.add(&s, now);
                    }
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
        CostBook::view(&[&own, &worker, &deferred], |c| view.sees(c), now)
    }
}
