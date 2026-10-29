//! The report queue: what is waiting, what is running, what ended and how.
//!
//! Pure bookkeeping, no I/O and no clock (every function takes `now`), so each rule of
//! docs/VOLUME.md "Report jobs" is a test here: at most `concurrency` running, the rest
//! promoted in the order they were asked for, a queued job stopped at once and a running
//! one at its next day, clear removes only the caller's own unless they are an admin.
//!
//! The queue is persisted by `Reports` (`<data>/reports/jobs.json`) after every change;
//! a job that was running when the process ended is marked failed on the next start
//! (`restarted`) — its file was never finished, and a run that cannot have happened must
//! not look as if it is still going.

use super::period::Period;
use serde::{Deserialize, Serialize};

pub const MIN_CONCURRENCY: usize = 3;
pub const MAX_CONCURRENCY: usize = 5;
pub const DEFAULT_CONCURRENCY: usize = 3;
/// Finished jobs kept in the list; the oldest finished go first. A job's file outlives its
/// entry only until the 7-day prune.
pub const KEEP_FINISHED: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Done,
    Stopped,
    Failed,
}

impl Status {
    pub fn finished(self) -> bool {
        matches!(self, Status::Done | Status::Stopped | Status::Failed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Format {
    #[serde(rename = "xlsx")]
    Xlsx,
    #[serde(rename = "csvzip")]
    CsvZip,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "xlsx" => Some(Format::Xlsx),
            "csvzip" => Some(Format::CsvZip),
            _ => None,
        }
    }
    pub fn mime(self) -> &'static str {
        match self {
            Format::Xlsx => super::xlsx::MIME,
            Format::CsvZip => "application/zip",
        }
    }
}

/// `cluster`: one cluster's report, from `REPORT_RUN`. `mailed`: the mailed report, one
/// workbook for several clusters (`clusterIds`), from the schedule or `REPORT_SEND_NOW`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Cluster,
    Mailed,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileRef {
    pub name: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    #[serde(default)]
    pub kind: Kind,
    pub cluster_id: String,
    pub cluster_name: String,
    /// Every cluster the job covers: `[cluster_id]` for a cluster's report, the schedule's
    /// clusters for the mailed one. Visibility is decided on this list.
    #[serde(default)]
    pub cluster_ids: Vec<String>,
    pub period: Period,
    pub format: Format,
    pub mail: bool,
    pub by: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub status: Status,
    pub progress: Progress,
    pub file: Option<FileRef>,
    pub error: Option<String>,
    pub mail_error: Option<String>,
    pub stopped_by: Option<String>,
    /// Something the file should be read with: the cluster was unreachable, so only what
    /// the record already held is in it.
    #[serde(default)]
    pub warning: Option<String>,
    /// The order jobs were asked for; FIFO promotion follows it, not the clock.
    #[serde(default)]
    pub seq: u64,
    /// Desktop only: the volume settings the UI sent with `REPORT_RUN` (there is no config
    /// file to read them from). Hosted ignores it, like every `VOLUME_*` message's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<serde_json::Value>,
    /// The sheets of a mailed report (a cluster's report has all three).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sheets: Vec<String>,
    /// Who asked a running job to stop. The worker sees it between days and ends the job
    /// `stopped`. Not persisted: a restart fails the job anyway.
    #[serde(skip)]
    pub stop_asked: Option<String>,
}

impl Job {
    /// A job as it is queued. `id` and `seq` are set by `Queue::push`. Every argument is
    /// one of the contract's fields; a builder would only rename them.
    #[allow(clippy::too_many_arguments)]
    pub fn new(kind: Kind, cluster_ids: Vec<String>, cluster_name: String, period: Period, format: Format, mail: bool, by: &str, now: i64) -> Job {
        Job {
            id: String::new(), kind, cluster_id: cluster_ids.first().cloned().unwrap_or_default(), cluster_name,
            cluster_ids, period, format, mail, by: by.to_string(), created_at: now, started_at: None, ended_at: None,
            status: Status::Queued, progress: Progress { done: 0, total: 1 }, file: None, error: None, mail_error: None,
            stopped_by: None, warning: None, seq: 0, volume: None, sheets: vec![], stop_asked: None,
        }
    }
}

/// What `REPORT_STOP` names.
pub enum Which<'a> {
    One(&'a str),
    All,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default)]
    pub jobs: Vec<Job>,
    #[serde(default)]
    pub next_seq: u64,
}

fn default_concurrency() -> usize {
    DEFAULT_CONCURRENCY
}

impl Default for Queue {
    fn default() -> Queue {
        Queue { version: 1, concurrency: DEFAULT_CONCURRENCY, jobs: vec![], next_seq: 0 }
    }
}

impl Queue {
    pub fn running(&self) -> usize {
        self.jobs.iter().filter(|j| j.status == Status::Running).count()
    }

    pub fn queued(&self) -> usize {
        self.jobs.iter().filter(|j| j.status == Status::Queued).count()
    }

    pub fn get(&self, id: &str) -> Option<&Job> {
        self.jobs.iter().find(|j| j.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Job> {
        self.jobs.iter_mut().find(|j| j.id == id)
    }

    /// Queue a job; returns its id.
    pub fn push(&mut self, mut job: Job, id: String) -> String {
        self.next_seq += 1;
        job.seq = self.next_seq;
        job.id = id.clone();
        self.jobs.push(job);
        self.trim();
        id
    }

    /// Start queued jobs, oldest first, while fewer than `concurrency` run. Returns the
    /// ids that are now running and need a worker.
    pub fn promote(&mut self, now: i64) -> Vec<String> {
        let cap = self.concurrency.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY);
        let mut free = cap.saturating_sub(self.running());
        let mut waiting: Vec<(u64, String)> = self.jobs.iter().filter(|j| j.status == Status::Queued).map(|j| (j.seq, j.id.clone())).collect();
        waiting.sort();
        let mut started = vec![];
        for (_, id) in waiting {
            if free == 0 {
                break;
            }
            if let Some(j) = self.get_mut(&id) {
                j.status = Status::Running;
                j.started_at = Some(now);
                started.push(id);
                free -= 1;
            }
        }
        started
    }

    /// Stop jobs. A queued one ends `stopped` at once; a running one is asked, and ends at
    /// its worker's next check. Returns `(ended now, asked)`.
    pub fn stop(&mut self, which: Which<'_>, by: &str, now: i64) -> (Vec<String>, Vec<String>) {
        let (mut ended, mut asked) = (vec![], vec![]);
        for j in self.jobs.iter_mut() {
            let named = match which {
                Which::One(id) => j.id == id,
                Which::All => true,
            };
            if !named {
                continue;
            }
            match j.status {
                Status::Queued => {
                    j.status = Status::Stopped;
                    j.ended_at = Some(now);
                    j.stopped_by = Some(by.to_string());
                    ended.push(j.id.clone());
                }
                Status::Running => {
                    j.stop_asked = Some(by.to_string());
                    asked.push(j.id.clone());
                }
                _ => {}
            }
        }
        (ended, asked)
    }

    /// Remove finished jobs: the caller's own, or everyone's for an admin (`by` = `None`).
    /// Returns the removed jobs, so their files can go too.
    pub fn clear(&mut self, by: Option<&str>) -> Vec<Job> {
        let (gone, keep): (Vec<Job>, Vec<Job>) = std::mem::take(&mut self.jobs).into_iter()
            .partition(|j| j.status.finished() && by.is_none_or(|b| j.by == b));
        self.jobs = keep;
        gone
    }

    /// After a restart: what was running cannot be, any more.
    pub fn restarted(&mut self, now: i64) -> usize {
        let mut n = 0;
        for j in self.jobs.iter_mut().filter(|j| j.status == Status::Running) {
            j.status = Status::Failed;
            j.error = Some("the server restarted".into());
            j.ended_at = Some(now);
            n += 1;
        }
        n
    }

    /// Keep at most `KEEP_FINISHED` finished jobs, dropping the oldest finished.
    pub fn trim(&mut self) {
        let finished = self.jobs.iter().filter(|j| j.status.finished()).count();
        let mut excess = finished.saturating_sub(KEEP_FINISHED);
        if excess == 0 {
            return;
        }
        self.jobs.sort_by_key(|j| j.seq);
        self.jobs.retain(|j| {
            if excess > 0 && j.status.finished() {
                excess -= 1;
                false
            } else {
                true
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> Period {
        serde_json::from_value(serde_json::json!({ "from": "2026-10-01", "to": "2026-10-02", "label": "x" })).unwrap()
    }
    fn job(cluster: &str, by: &str) -> Job {
        Job::new(Kind::Cluster, vec![cluster.into()], cluster.into(), p(), Format::Xlsx, false, by, 1)
    }
    fn status(q: &Queue, id: &str) -> Status {
        q.get(id).unwrap().status
    }

    #[test]
    fn at_most_concurrency_run_and_the_rest_start_in_order() {
        let mut q = Queue::default();
        let ids: Vec<String> = (0..6).map(|i| q.push(job(&format!("c{i}"), "ann"), format!("j{i}"))).collect();
        assert_eq!(q.promote(10), vec!["j0", "j1", "j2"], "default 3, oldest first");
        assert_eq!((q.running(), q.queued()), (3, 3));
        assert!(q.promote(11).is_empty(), "no free slot");
        // j1 finishes: exactly one more starts, the oldest waiting.
        q.get_mut("j1").unwrap().status = Status::Done;
        assert_eq!(q.promote(12), vec!["j3"]);
        assert_eq!(q.get("j3").unwrap().started_at, Some(12));
        // Raising the cap starts more, still in order; a cap out of range is held to 3..5.
        q.concurrency = 5;
        assert_eq!(q.promote(13), vec!["j4", "j5"]);
        q.concurrency = 99;
        q.push(job("c9", "ann"), "j9".into());
        assert!(q.promote(14).is_empty(), "5 running is the most, whatever the setting says: {}", q.running());
        assert_eq!(status(&q, &ids[0]), Status::Running);
    }

    #[test]
    fn fifo_is_by_the_order_asked_not_by_position() {
        let mut q = Queue { concurrency: 3, ..Queue::default() };
        for i in 0..5 {
            q.push(job("c", "ann"), format!("j{i}"));
        }
        // Reordered on disk (or by trim's sort): seq decides.
        q.jobs.reverse();
        assert_eq!(q.promote(1), vec!["j0", "j1", "j2"]);
    }

    #[test]
    fn stop_ends_a_queued_job_at_once_and_asks_a_running_one() {
        let mut q = Queue::default();
        for i in 0..4 {
            q.push(job("c", "ann"), format!("j{i}"));
        }
        q.promote(1);
        let (ended, asked) = q.stop(Which::One("j3"), "root", 5);
        assert_eq!((ended, asked), (vec!["j3".to_string()], vec![]));
        assert_eq!(status(&q, "j3"), Status::Stopped);
        assert_eq!(q.get("j3").unwrap().stopped_by.as_deref(), Some("root"));
        let (ended, asked) = q.stop(Which::One("j0"), "root", 6);
        assert!(ended.is_empty());
        assert_eq!(asked, vec!["j0"]);
        assert_eq!(status(&q, "j0"), Status::Running, "running until its worker sees it");
        assert_eq!(q.get("j0").unwrap().stop_asked.as_deref(), Some("root"));
        q.push(job("c", "bob"), "j5".into());
        let (ended, asked) = q.stop(Which::All, "root", 7);
        assert_eq!(ended, vec!["j5"]);
        assert_eq!(asked.len(), 3, "every running one asked: {asked:?}");
        let (e, a) = q.stop(Which::One("j3"), "root", 8);
        assert!(e.is_empty() && a.is_empty(), "a finished job is not stopped again");
    }

    #[test]
    fn clear_removes_only_the_callers_finished_jobs_unless_admin() {
        let mut q = Queue::default();
        q.push(job("c", "ann"), "a1".into());
        q.push(job("c", "ann"), "a2".into());
        q.push(job("c", "bob"), "b1".into());
        q.push(job("c", "bob"), "b2".into());
        for id in ["a1", "b1", "b2"] {
            q.get_mut(id).unwrap().status = Status::Done;
        }
        let gone: Vec<String> = q.clear(Some("ann")).into_iter().map(|j| j.id).collect();
        assert_eq!(gone, vec!["a1"], "ann's finished job only; her queued one stays");
        assert!(q.get("a2").is_some() && q.get("b1").is_some());
        let gone: Vec<String> = q.clear(None).into_iter().map(|j| j.id).collect();
        assert_eq!(gone, vec!["b1", "b2"], "an admin clears everyone's finished jobs");
        assert_eq!(q.jobs.len(), 1);
    }

    #[test]
    fn a_restart_fails_what_was_running_and_keeps_what_waited() {
        let mut q = Queue::default();
        for i in 0..4 {
            q.push(job("c", "ann"), format!("j{i}"));
        }
        q.promote(1);
        let text = serde_json::to_string(&q).unwrap();
        let mut back: Queue = serde_json::from_str(&text).unwrap();
        assert_eq!(back.restarted(9), 3);
        assert_eq!(back.get("j0").unwrap().error.as_deref(), Some("the server restarted"));
        assert_eq!(back.get("j0").unwrap().status, Status::Failed);
        assert_eq!(back.get("j3").unwrap().status, Status::Queued);
        assert_eq!(back.promote(10), vec!["j3"], "the waiting job starts after the restart");
    }

    #[test]
    fn the_list_keeps_a_bounded_number_of_finished_jobs() {
        let mut q = Queue::default();
        for i in 0..(KEEP_FINISHED + 5) {
            q.push(job("c", "ann"), format!("j{i}"));
            q.get_mut(&format!("j{i}")).unwrap().status = Status::Done;
        }
        q.push(job("c", "ann"), "live".into());
        q.trim();
        assert_eq!(q.jobs.iter().filter(|j| j.status.finished()).count(), KEEP_FINISHED);
        assert!(q.get("j0").is_none() && q.get("live").is_some());
    }
}
