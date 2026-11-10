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
/// Jobs one person may have queued or running at once: three rounds of the most that run.
pub const MAX_PENDING_PER_USER: usize = 3 * MAX_CONCURRENCY;
/// Jobs everyone together may have queued or running, so the kept list stays bounded
/// (with `KEEP_FINISHED`, at most 400 entries).
pub const MAX_PENDING: usize = 200;
/// Mailed jobs (`REPORT_RUN` with `mail: true`) one person may ask for in an hour.
pub const MAX_MAILED_PER_HOUR: usize = 10;
pub const HOUR_MS: i64 = 3_600_000;

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

/// Which report (docs/REPORT-TYPES.md): the volume workbook, the indices listing, or
/// volume by host. Messages name it `kind`; a job carries it as `report`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportKind {
    #[default]
    Volume,
    Indices,
    Hosts,
    /// The log delay report (docs/LOGDELAY.md): from the built-in store, no cluster asked.
    #[serde(rename = "log_delay")]
    LogDelay,
}

impl ReportKind {
    pub const ALL: [ReportKind; 4] = [ReportKind::Volume, ReportKind::Indices, ReportKind::Hosts, ReportKind::LogDelay];

    pub fn parse(s: &str) -> Option<ReportKind> {
        match s {
            "volume" => Some(ReportKind::Volume),
            "indices" => Some(ReportKind::Indices),
            "hosts" => Some(ReportKind::Hosts),
            "log_delay" | "logdelay" | "logDelay" => Some(ReportKind::LogDelay),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ReportKind::Volume => "volume",
            ReportKind::Indices => "indices",
            ReportKind::Hosts => "hosts",
            ReportKind::LogDelay => "log_delay",
        }
    }

    /// `kind` of a message: absent is `volume`; anything else unknown is refused.
    pub fn of_message(msg: &serde_json::Value) -> Result<ReportKind, String> {
        match msg.get("kind") {
            None | Some(serde_json::Value::Null) => Ok(ReportKind::Volume),
            Some(v) => v.as_str().and_then(ReportKind::parse).ok_or_else(|| "kind must be volume, indices, hosts or log_delay".to_string()),
        }
    }
}

fn is_volume(k: &ReportKind) -> bool {
    *k == ReportKind::Volume
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    /// Where an indices or hosts job is (docs/REPORT-TYPES.md "Isolation and failure"):
    /// the cluster and day under way, pages and rows of that day so far, page retries,
    /// and what it is doing (`collecting`, `retrying`, `building`, `mailing`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retries: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// The cluster under way's partitions, controller limit, halvings and last reason (the
    /// health tab reads these names; `clusters` has every cluster's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partitions: Option<Count>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub halvings: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_reason: Option<String>,
    /// Per cluster of the job, how its collection goes (docs/REPORT-TYPES.md "Concurrency").
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub clusters: std::collections::BTreeMap<String, ClusterProgress>,
}

/// One cluster's collection, as a job's progress shows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterProgress {
    /// `waiting`, `collecting`, `retrying`, `deferred` (health red), `done`, `failed`, `stopped`.
    pub state: String,
    pub day: Option<String>,
    pub pages: u64,
    pub rows: u64,
    pub retries: u64,
    /// Requests the controller allows in flight now.
    pub concurrency: u32,
    pub partitions: Count,
    pub halvings: u32,
    pub last_reason: Option<String>,
    pub days: Count,
}

/// `{done, total}`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Count {
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
    /// When the mailed report's SMTP session began. A restart after it does not retry the
    /// period: the mail may have gone out (and a send that brings the process down must not
    /// be repeated by every restart).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_started_at: Option<i64>,
    /// Which report this job builds. Absent (every job before 0.3.54) is the volume report.
    #[serde(default, skip_serializing_if = "is_volume")]
    pub report: ReportKind,
    /// A hosts job asked to collect again the days already held (*Collect again*).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub collect_again: bool,
    /// Clusters an indices or hosts job could not read, each with why: the file was built
    /// for the others and names these (docs/REPORT-TYPES.md "Isolation and failure").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_clusters: Vec<FailedCluster>,
    /// A log delay job's options (`logdelay::report::Options`): the devices filter, the group,
    /// the columns, the sections, the attachments. Absent for every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<serde_json::Value>,
    /// Who asked a running job to stop. The worker sees it between days and ends the job
    /// `stopped`. Not persisted: a restart fails the job anyway.
    #[serde(skip)]
    pub stop_asked: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedCluster {
    pub cluster_id: String,
    pub reason: String,
}

impl Job {
    /// The clusters the job covers: `cluster_ids`, or the single `cluster_id` of a job written
    /// before the list existed. `None` when neither names one, or either holds `*`: a report is
    /// always about clusters, so not knowing which is not "none" (see `may_read`).
    pub fn covered(&self) -> Option<Vec<String>> {
        let ids = if !self.cluster_ids.is_empty() {
            self.cluster_ids.clone()
        } else if !self.cluster_id.trim().is_empty() {
            vec![self.cluster_id.clone()]
        } else {
            vec![]
        };
        (!ids.is_empty() && !ids.iter().any(|c| c == ALL_CLUSTERS || c.trim().is_empty())).then_some(ids)
    }

    /// A job as it is queued. `id` and `seq` are set by `Queue::push`. Every argument is
    /// one of the contract's fields; a builder would only rename them.
    #[allow(clippy::too_many_arguments)]
    pub fn new(kind: Kind, cluster_ids: Vec<String>, cluster_name: String, period: Period, format: Format, mail: bool, by: &str, now: i64) -> Job {
        Job {
            id: String::new(), kind, cluster_id: cluster_ids.first().cloned().unwrap_or_default(), cluster_name,
            cluster_ids, period, format, mail, by: by.to_string(), created_at: now, started_at: None, ended_at: None,
            status: Status::Queued, progress: Progress { done: 0, total: 1, ..Progress::default() }, file: None, error: None, mail_error: None,
            stopped_by: None, warning: None, seq: 0, volume: None, sheets: vec![], mail_started_at: None, report: ReportKind::Volume,
            collect_again: false, failed_clusters: vec![], options: None, stop_asked: None,
        }
    }
}

/// What stands for "every cluster" in a list of clusters: never a cluster a limited caller sees.
pub const ALL_CLUSTERS: &str = "*";

/// Whether a caller who sees `visible` (`None`: every cluster) may read something about
/// `cluster_ids`: only when they see every one of them. Something about no cluster is
/// everybody's. Pure set arithmetic; `may_read` is the rule built on it.
pub fn sees_every(visible: Option<&std::collections::HashSet<String>>, cluster_ids: &[String]) -> bool {
    visible.is_none_or(|v| cluster_ids.iter().all(|c| v.contains(c)))
}

/// The one rule for a report job (REPORT_JOBS) and a job run (JOBS_LIST). `covered`: the
/// clusters it is about — `Some(&[])` for something about no cluster (everybody's), `None` when
/// they are not known (a cluster-scoped record with none, or `*`). Not known fails closed: an
/// administrator who sees every cluster reads it, nobody else.
pub fn may_read(visible: Option<&std::collections::HashSet<String>>, admin: bool, covered: Option<&[String]>) -> bool {
    match covered {
        Some(ids) if !ids.iter().any(|c| c == ALL_CLUSTERS) => sees_every(visible, ids),
        _ => admin && visible.is_none(),
    }
}

/// The error of a job that was running when the process ended.
pub const RESTARTED: &str = "the server restarted";

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
    /// When each person last asked for mailed jobs (epoch ms, the last hour only): kept apart
    /// from the jobs so that clearing the list does not reset the hourly limit.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub mailed: std::collections::BTreeMap<String, Vec<i64>>,
}

fn default_concurrency() -> usize {
    DEFAULT_CONCURRENCY
}

impl Default for Queue {
    fn default() -> Queue {
        Queue { version: 1, concurrency: DEFAULT_CONCURRENCY, jobs: vec![], next_seq: 0, mailed: Default::default() }
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

    /// Queued or running jobs, everyone's (`None`) or one person's.
    pub fn pending(&self, by: Option<&str>) -> usize {
        self.jobs.iter().filter(|j| !j.status.finished() && by.is_none_or(|b| j.by == b)).count()
    }

    /// Whether `by` may queue `n` more jobs, `mailed` of them with a mail, at `now`; the
    /// refusal says why. `Err((kind, message))`.
    pub fn room(&mut self, by: &str, n: usize, mailed: usize, now: i64) -> Result<(), (&'static str, String)> {
        let mine = self.pending(Some(by));
        if mine + n > MAX_PENDING_PER_USER {
            return Err(("too_many_jobs", format!(
                "{by} has {mine} report(s) queued or running and at most {MAX_PENDING_PER_USER} may wait at once: \
                 ask for fewer clusters ({} more fit now) or wait for some to finish", MAX_PENDING_PER_USER.saturating_sub(mine))));
        }
        let all = self.pending(None);
        if all + n > MAX_PENDING {
            return Err(("too_many_jobs", format!("{all} reports are queued or running and at most {MAX_PENDING} may wait at once: try again when some have finished")));
        }
        if mailed > 0 {
            let sent = self.mailed_within_hour(by, now);
            if sent + mailed > MAX_MAILED_PER_HOUR {
                return Err(("too_many_mails", format!(
                    "at most {MAX_MAILED_PER_HOUR} mailed reports an hour per person, and {by} asked for {sent} in the last hour: \
                     run it without mail and download the file, or try again later")));
            }
        }
        Ok(())
    }

    /// Mailed jobs `by` asked for in the hour before `now`. Older entries, anyone's, go.
    pub fn mailed_within_hour(&mut self, by: &str, now: i64) -> usize {
        self.mailed.retain(|_, v| {
            v.retain(|t| now - *t < HOUR_MS);
            !v.is_empty()
        });
        self.mailed.get(by).map_or(0, Vec::len)
    }

    /// Count `n` mailed jobs for `by` at `now`.
    pub fn note_mailed(&mut self, by: &str, n: usize, now: i64) {
        if n > 0 {
            self.mailed.entry(by.to_string()).or_default().extend(std::iter::repeat_n(now, n));
        }
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

    /// After a restart: what was running cannot be, any more. Returns the jobs so failed.
    pub fn restarted(&mut self, now: i64) -> Vec<Job> {
        let mut out = vec![];
        for j in self.jobs.iter_mut().filter(|j| j.status == Status::Running) {
            j.status = Status::Failed;
            j.error = Some(RESTARTED.into());
            j.ended_at = Some(now);
            out.push(j.clone());
        }
        out
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
        assert_eq!(back.restarted(9).len(), 3);
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

    #[test]
    fn one_person_may_have_fifteen_waiting_and_ten_mails_an_hour() {
        let mut q = Queue::default();
        assert_eq!(MAX_PENDING_PER_USER, 15);
        for i in 0..14 {
            q.push(job("c", "ann"), format!("a{i}"));
        }
        q.promote(1);
        assert!(q.room("ann", 1, 0, 2).is_ok(), "the fifteenth fits");
        let (kind, msg) = q.room("ann", 2, 0, 2).unwrap_err();
        assert_eq!(kind, "too_many_jobs");
        assert!(msg.contains("1 more fit now"), "{msg}");
        assert!(q.room("bob", 15, 0, 2).is_ok(), "per person");
        // Finished jobs do not count.
        for i in 0..5 {
            q.get_mut(&format!("a{i}")).unwrap().status = Status::Done;
        }
        assert!(q.room("ann", 6, 0, 3).is_ok());
        // Everyone together is bounded too.
        let mut many = Queue::default();
        for i in 0..MAX_PENDING {
            many.push(job("c", &format!("u{}", i % 20)), format!("m{i}"));
        }
        assert_eq!(many.room("newcomer", 1, 0, 1).unwrap_err().0, "too_many_jobs");

        // Mails: ten an hour, counted apart from the list (clearing does not reset them).
        let mut q = Queue::default();
        assert!(q.room("ann", 10, 10, 1_000).is_ok());
        q.note_mailed("ann", 10, 1_000);
        q.jobs.clear();
        let (kind, msg) = q.room("ann", 1, 1, 2_000).unwrap_err();
        assert_eq!(kind, "too_many_mails");
        assert!(msg.contains("10 mailed reports an hour"), "{msg}");
        assert!(q.room("ann", 1, 0, 2_000).is_ok(), "without mail it still runs");
        assert!(q.room("bob", 1, 1, 2_000).is_ok(), "per person");
        assert!(q.room("ann", 1, 1, 1_000 + HOUR_MS).is_ok(), "an hour later");
        assert!(q.mailed.is_empty(), "old entries go");
        let text = serde_json::to_string(&Queue::default()).unwrap();
        assert!(!text.contains("mailed"), "nothing to keep, nothing written: {text}");
    }
}
