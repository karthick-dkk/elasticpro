//! Jobs (docs/JOBS.md): the one table of what ElasticPro runs by itself or when a person asks,
//! and the record of every run.
//!
//! * `REGISTRY` — every job, once: its id, name, kind, which process runs it, how its next run
//!   is worked out, its default priority and request limits, whether it can be paused. The
//!   health poll and request handling are monitoring, not jobs, and are not in it.
//! * `Jobs` — the run log and the single-flight guard. A run is begun (`begin`, or `join` for
//!   the collections that start one cluster at a time) and ended with an `Outcome`; a job has
//!   at most one run open at a time in a process, and a second `begin` answers with the open
//!   run's id. A run dropped without an end (a panic) ends `failed`.
//! * One writer per file (docs/WORKER.md): `<data>/job-runs/core.json` is written by the process
//!   that runs the core's jobs, `<data>/job-runs/worker.json` by the one that runs the worker's
//!   (role `all` writes both, being both). The core reads the other file for `JOBS_LIST`. Report
//!   jobs are not copied in: `jobs.json` already records them, and `from_report_job` maps them.
//! * Every answer about a run goes through `run_view`, which takes the caller's
//!   `delay_sink::SinkView` — the one per-caller view of the scheduled work.
//!
//! Nothing here sends a cluster anything.

pub mod controls;
pub mod governor;
pub mod load;

use crate::delay_sink::SinkView;
use crate::report::jobs::{Job, Kind as ReportJobKind, ReportKind, Status as ReportStatus};
use crate::worker::Role;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `<data>/job-runs/`: the run logs and the hosts collection's tries. Timer-owned files.
pub const DIR: &str = "job-runs";
/// `<data>/job-runs/hosts-tries.json`: the hosts collection's tries per cluster today.
pub const HOSTS_TRIES_FILE: &str = "hosts-tries.json";
/// Finished runs kept per job; the oldest go first.
pub const KEEP_PER_JOB: usize = 50;
/// Finished runs kept per file, all jobs together.
pub const KEEP_TOTAL: usize = 2000;
/// The error of a run that was open when its process ended.
pub const RESTARTED: &str = "the server restarted while this ran";
/// The error of a run whose code ended without saying how (a panic).
pub const NO_RESULT: &str = "the run ended without a result; see the server log";
/// `JOBS_LIST {limit}`: default and most.
pub const LIST_LIMIT: usize = 50;
pub const LIST_LIMIT_MAX: usize = 200;

/* ------------------------------------------ the registry ------------------------------------------ */

/// Which process runs a job, and so which run file it is recorded in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    Core,
    Worker,
}

impl Owner {
    pub const ALL: [Owner; 2] = [Owner::Core, Owner::Worker];

    pub fn as_str(self) -> &'static str {
        match self {
            Owner::Core => "core",
            Owner::Worker => "worker",
        }
    }

    pub fn file(self) -> &'static str {
        match self {
            Owner::Core => "core.json",
            Owner::Worker => "worker.json",
        }
    }

    /// Whether a process in `role` runs this owner's jobs (and so writes its file).
    pub fn run_by(self, role: Role) -> bool {
        match role {
            Role::All => true,
            Role::Core => self == Owner::Core,
            Role::Worker => self == Owner::Worker,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    /// The product starts it (a timer).
    Automatic,
    /// A person starts it.
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    High,
    Medium,
    Low,
}

impl Priority {
    pub fn parse(s: &str) -> Option<Priority> {
        match s {
            "high" => Some(Priority::High),
            "medium" => Some(Priority::Medium),
            "low" => Some(Priority::Low),
            _ => None,
        }
    }
}

/// How a job's next run is worked out — each is one existing rule, never a second copy of it
/// (docs/JOBS.md "Next run").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NextRun {
    /// Nobody schedules it: it runs when a person asks.
    OnRequest,
    /// The scheduled measurement's own `nextDueAt` (`delay_sink::next_due`, with its back-off).
    DelaySink,
    /// The housekeeping timer's `nextRunAt`.
    Housekeeping,
    /// The backup schedule's next run (`backup::Schedule::next_run`).
    Backup,
    /// The earliest of every cluster's next `collectAt` (`volume::schedule::next_run`).
    VolumeDaily,
    /// The hosts schedule's `at` (`UI_REPORT_HOSTS_AT`), today or tomorrow.
    HostsDaily,
    /// The mailed schedule's next send (`report::schedule::next_send`).
    MailedSchedule,
    /// Every minute while its two switches are on and something is queued: not a time.
    EveryMinute,
    /// The sync interval after the last timer run.
    ZabbixSync,
    /// The push timer's `nextAt`.
    ZabbixPush,
}

/// Requests a job may have in flight at once, per the plan's defaults (PR 4's governor moves
/// them between `min` and `max`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Requests {
    pub min: u32,
    pub max: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: JobKind,
    pub owner: Owner,
    /// The schedule, in words, naming the setting that changes it.
    pub schedule: &'static str,
    pub next_run: NextRun,
    pub priority: Priority,
    /// Whether `JOB_PAUSE` (planned, PR 3) applies. A run a person asked for is stopped with
    /// `JOB_CANCEL` instead.
    pub pausable: bool,
    pub requests: Requests,
    /// The report a mailed schedule sends.
    pub report: Option<ReportKind>,
    /// Its runs are about clusters: a run of it that names none has clusters not known, and
    /// is an administrator's (`report::jobs::may_read`), never everybody's.
    pub cluster_scoped: bool,
    /// Why its runs failed, and their notes, are an administrator's — as the job's own status
    /// message is (HOUSEKEEPING_GET, BACKUP_STATUS, HISTORY_STORE_GET, the Zabbix sync's error).
    /// Anybody else reads the status and the counts.
    pub admin_details: bool,
}

impl Descriptor {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "kind": self.kind, "owner": self.owner, "schedule": self.schedule,
            "nextRun": self.next_run, "priority": self.priority, "pausable": self.pausable, "requests": self.requests,
            "report": self.report.map(ReportKind::as_str),
            "detailsFor": if self.admin_details { "admin" } else { "user" },
            "clusterScoped": self.cluster_scoped,
        })
    }
}

pub const REPORT_RUN: &str = "report.run";
pub const MAILED_VOLUME: &str = "report.mailed.volume";
pub const MAILED_INDICES: &str = "report.mailed.indices";
pub const MAILED_HOSTS: &str = "report.mailed.hosts";
pub const MAILED_LOG_DELAY: &str = "report.mailed.log_delay";
pub const VOLUME_DAILY: &str = "volume.daily";
pub const HOSTS_COLLECT: &str = "hosts.collect";
pub const LOGDELAY_MEASURE: &str = "logdelay.measure";
pub const HOUSEKEEPING: &str = "housekeeping";
pub const HISTORY_MIRROR: &str = "history.mirror";
pub const SETTINGS_BACKUP: &str = "settings.backup";
pub const ZABBIX_SYNC: &str = "zabbix.sync";
pub const ZABBIX_PUSH: &str = "zabbix.push";

/// The mailed schedule's job for a report kind.
pub fn mailed_id(kind: ReportKind) -> &'static str {
    match kind {
        ReportKind::Volume => MAILED_VOLUME,
        ReportKind::Indices => MAILED_INDICES,
        ReportKind::Hosts => MAILED_HOSTS,
        ReportKind::LogDelay => MAILED_LOG_DELAY,
    }
}

const fn req(min: u32, max: u32) -> Requests {
    Requests { min, max }
}

const fn mailed(id: &'static str, name: &'static str, kind: ReportKind) -> Descriptor {
    Descriptor {
        id, name, kind: JobKind::Automatic, owner: Owner::Worker,
        schedule: "the mailed schedule (Reports › Exports, REPORT_SCHEDULE_SET): daily, weekly or monthly at its time, server local time",
        next_run: NextRun::MailedSchedule, priority: Priority::Medium, pausable: true, requests: req(1, 4), report: Some(kind), cluster_scoped: true, admin_details: false,
    }
}

/// Every job, once. The order is the Jobs page's.
pub static REGISTRY: [Descriptor; 13] = [
    Descriptor {
        id: LOGDELAY_MEASURE, name: "Log delay measurement", kind: JobKind::Automatic, owner: Owner::Core,
        schedule: "every everyHours while armed (Config-Management › Data › Scheduled log delay, DELAY_SINK_SET); a failing run backs off",
        next_run: NextRun::DelaySink, priority: Priority::High, pausable: true, requests: req(1, 4), report: None, cluster_scoped: false, admin_details: false,
    },
    Descriptor {
        id: VOLUME_DAILY, name: "Daily volume collection", kind: JobKind::Automatic, owner: Owner::Worker,
        schedule: "once a day at each cluster's collectAt, server local time (volume settings)",
        next_run: NextRun::VolumeDaily, priority: Priority::Medium, pausable: true, requests: req(1, 4), report: None, cluster_scoped: true, admin_details: false,
    },
    Descriptor {
        id: HOSTS_COLLECT, name: "Hosts collection", kind: JobKind::Automatic, owner: Owner::Worker,
        schedule: "daily from UI_REPORT_HOSTS_AT (06:00) for clusters missing days of the month, at most three tries a cluster a day",
        next_run: NextRun::HostsDaily, priority: Priority::Medium, pausable: true, requests: req(1, 2), report: None, cluster_scoped: true, admin_details: false,
    },
    Descriptor {
        id: REPORT_RUN, name: "Report runs", kind: JobKind::Manual, owner: Owner::Worker,
        schedule: "when a person asks (Reports, REPORT_RUN); queued; as many at once as mostAtOnce leaves (default 4, less the collections running, at least one)",
        next_run: NextRun::OnRequest, priority: Priority::Medium, pausable: false, requests: req(1, 4), report: None, cluster_scoped: true, admin_details: false,
    },
    mailed(MAILED_VOLUME, "Mailed volume report", ReportKind::Volume),
    mailed(MAILED_INDICES, "Mailed indices report", ReportKind::Indices),
    mailed(MAILED_HOSTS, "Mailed volume by host report", ReportKind::Hosts),
    mailed(MAILED_LOG_DELAY, "Mailed log delay report", ReportKind::LogDelay),
    Descriptor {
        id: HISTORY_MIRROR, name: "History store mirror", kind: JobKind::Automatic, owner: Owner::Core,
        schedule: "every minute while HISTORY_STORE_WRITES and the admin switch are both on and something is queued",
        next_run: NextRun::EveryMinute, priority: Priority::Low, pausable: true, requests: req(1, 2), report: None, cluster_scoped: false, admin_details: true,
    },
    Descriptor {
        id: HOUSEKEEPING, name: "Housekeeping", kind: JobKind::Automatic, owner: Owner::Core,
        schedule: "every ELASTICPRO_HOUSEKEEPING_MINUTES (0 switches the timer off)",
        next_run: NextRun::Housekeeping, priority: Priority::Low, pausable: true, requests: req(1, 1), report: None, cluster_scoped: false, admin_details: true,
    },
    Descriptor {
        id: SETTINGS_BACKUP, name: "Settings backup", kind: JobKind::Automatic, owner: Owner::Core,
        schedule: "the backup schedule (Config-Management › Backup, BACKUP_SCHEDULE_SET), server local time",
        next_run: NextRun::Backup, priority: Priority::Medium, pausable: true, requests: req(1, 4), report: None, cluster_scoped: false, admin_details: true,
    },
    Descriptor {
        id: ZABBIX_SYNC, name: "Zabbix sync", kind: JobKind::Automatic, owner: Owner::Core,
        schedule: "every sync interval (Config → Zabbix) while the Zabbix API is configured; also at start and after the link changes",
        next_run: NextRun::ZabbixSync, priority: Priority::Low, pausable: true, requests: req(1, 2), report: None, cluster_scoped: false, admin_details: true,
    },
    Descriptor {
        id: ZABBIX_PUSH, name: "Zabbix push", kind: JobKind::Automatic, owner: Owner::Core,
        schedule: "every minute while ZABBIX_METRICS_HOST names a host",
        next_run: NextRun::ZabbixPush, priority: Priority::Low, pausable: true, requests: req(1, 2), report: None, cluster_scoped: false, admin_details: true,
    },
];

pub fn descriptor(id: &str) -> Option<&'static Descriptor> {
    REGISTRY.iter().find(|d| d.id == id)
}

/// A report schedule a person created (`JOB_CREATE`): its job id is `report.schedule.<id>`.
pub const CREATED_PREFIX: &str = "report.schedule.";

/// Whether `id` has the shape of a created schedule's job id (whether one exists is the
/// schedules file's to say).
pub fn is_created_id(id: &str) -> bool {
    id.strip_prefix(CREATED_PREFIX).is_some_and(|rest| !rest.is_empty() && rest.len() <= 32 && rest.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The defaults a created schedule's job has: a mailed schedule's.
pub const fn created_descriptor_defaults() -> Descriptor {
    mailed("report.schedule", "Created report schedule", ReportKind::Volume)
}

/// Whether `JOB_RUN` can start the job now. Not the report runs (a run names its clusters
/// and dates: `JOB_CREATE {once: true, …}` or `REPORT_RUN`), nor the Zabbix push (every
/// minute already; there is nothing more to send at a moment a person picks).
pub fn on_demand(id: &str) -> bool {
    id != REPORT_RUN && id != ZABBIX_PUSH && (descriptor(id).is_some() || is_created_id(id))
}

/* ------------------------------------------ a run ------------------------------------------ */

/// Who started a run: `timer` (the product, on its own — its timer, or the follow-up to a
/// change), `manual:<user>`, or `retry` (planned, PR 3: `JOB_RETRY`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Trigger {
    Timer,
    Manual(String),
    Retry,
}

impl Trigger {
    pub fn manual(who: &str) -> Trigger {
        Trigger::Manual(who.to_string())
    }

    pub fn text(&self) -> String {
        match self {
            Trigger::Timer => "timer".into(),
            Trigger::Manual(who) => format!("manual:{who}"),
            Trigger::Retry => "retry".into(),
        }
    }

    pub fn parse(s: &str) -> Option<Trigger> {
        match s {
            "timer" => Some(Trigger::Timer),
            "retry" => Some(Trigger::Retry),
            _ => s.strip_prefix("manual:").map(Trigger::manual),
        }
    }
}

impl Serialize for Trigger {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.text())
    }
}

impl<'de> Deserialize<'de> for Trigger {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Trigger, D::Error> {
        let s = String::deserialize(d)?;
        Trigger::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("unknown trigger {s:?}")))
    }
}

/// A run's status (docs/JOBS.md "Statuses"). `Pending` and `Paused` are in the contract for
/// PR 3 and are not set yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    /// Asked for, not yet eligible to start (planned: a paused job's or a deferred run's wait).
    Pending,
    /// Waiting for a slot (a report job in the queue).
    Queued,
    Running,
    Completed,
    Failed,
    /// Held by `JOB_PAUSE` (planned).
    Paused,
    /// Stopped by a person (`REPORT_STOP`; `JOB_CANCEL`, planned).
    Cancelled,
    /// Ended early for a reason that passes — the emergency stop, a busy cluster — and tried
    /// again later by the job's own rules.
    Deferred,
    /// Nothing was attempted: something stood in the way (the error says what, and which
    /// setting changes it).
    Skipped,
}

impl RunStatus {
    pub fn finished(self) -> bool {
        matches!(self, RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled | RunStatus::Deferred | RunStatus::Skipped)
    }
}

/// One run of one job, as recorded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub job_id: String,
    pub trigger: Trigger,
    pub status: RunStatus,
    /// Unix ms it was asked for; the same as `started_at` for a run that started at once.
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    /// Parts done of `total` (clusters, days), when the job counts them; `None` when it does not.
    #[serde(default)]
    pub done: Option<u64>,
    #[serde(default)]
    pub total: Option<u64>,
    /// Records processed (days collected, documents written, items removed), when known.
    #[serde(default)]
    pub records: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
    /// The clusters it read from or wrote to.
    #[serde(default)]
    pub clusters: Vec<String>,
    /// Anything else the job says about the run (a backup's file, a report's warning).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// `JOB_CANCEL` asked it to stop, by whom: it stops at its next safe point. Kept in the
    /// run file, so a restart ends it `cancelled`, not `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_asked: Option<String>,
    /// The run this one tries again (`trigger: retry`), and which try it is (1 = the first retry).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub attempt: u32,
    /// A run held back for a busy cluster (`deferred`): which, why, since when.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred: Option<load::Busy>,
    /// What a person narrowed the run to, when they did (`JOB_RUN {jobId: "logdelay.measure",
    /// clusterIds, device}`): kept so `JOB_RETRY` runs the same scope again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Value>,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// What a run tries again, for `begin_with`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunMeta {
    pub retry_of: Option<String>,
    pub attempt: u32,
}

/// Progress in percent, from `done` of `total` when the total is known and above zero. `None`
/// otherwise — never a guess.
pub fn progress_pct(done: Option<u64>, total: Option<u64>) -> Option<u64> {
    match (done, total) {
        (Some(d), Some(t)) if t > 0 => Some(d.min(t) * 100 / t),
        _ => None,
    }
}

/// How a run (or one part of it) ended.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub status: RunStatus,
    pub records: Option<u64>,
    pub error: Option<String>,
    pub note: Option<String>,
}

impl Outcome {
    pub fn completed(records: Option<u64>) -> Outcome {
        Outcome { status: RunStatus::Completed, records, error: None, note: None }
    }
    pub fn failed(error: impl Into<String>, records: Option<u64>) -> Outcome {
        Outcome { status: RunStatus::Failed, records, error: Some(error.into()), note: None }
    }
    pub fn skipped(why: impl Into<String>) -> Outcome {
        Outcome { status: RunStatus::Skipped, records: None, error: Some(why.into()), note: None }
    }
    pub fn deferred(why: impl Into<String>, records: Option<u64>) -> Outcome {
        Outcome { status: RunStatus::Deferred, records, error: Some(why.into()), note: None }
    }
    /// Stopped at a safe point because `JOB_CANCEL` asked.
    pub fn cancelled(by: &str, records: Option<u64>) -> Outcome {
        Outcome { status: RunStatus::Cancelled, records, error: None, note: Some(format!("cancelled by {by}")) }
    }
    pub fn with_note(mut self, note: Option<String>) -> Outcome {
        self.note = note;
        self
    }
}

/* ------------------------------------------ the log ------------------------------------------ */

/// One owner's runs, oldest first. Pure: no clock, no I/O.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RunFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub runs: VecDeque<RunRecord>,
}

impl RunFile {
    pub fn get_mut(&mut self, id: &str) -> Option<&mut RunRecord> {
        self.runs.iter_mut().rev().find(|r| r.id == id)
    }

    pub fn push(&mut self, r: RunRecord) {
        self.runs.push_back(r);
        self.trim();
    }

    /// At most `KEEP_PER_JOB` finished runs of a job and `KEEP_TOTAL` finished runs in all; the
    /// oldest finished go first. An open run is never dropped.
    pub fn trim(&mut self) {
        let mut per_job: HashMap<String, usize> = HashMap::new();
        let mut total = 0usize;
        let mut keep = vec![true; self.runs.len()];
        for (i, r) in self.runs.iter().enumerate().rev() {
            if !r.status.finished() {
                continue;
            }
            let n = per_job.entry(r.job_id.clone()).or_insert(0);
            *n += 1;
            total += 1;
            if *n > KEEP_PER_JOB || total > KEEP_TOTAL {
                keep[i] = false;
                total -= 1;
            }
        }
        let mut i = 0;
        self.runs.retain(|_| {
            let k = keep[i];
            i += 1;
            k
        });
    }

    /// Runs left open by a process that ended end `failed`, now. Returns how many.
    /// A run a person had asked to cancel ends `cancelled`: the ask outlives the process.
    pub fn restarted(&mut self, now: u64) -> usize {
        let mut n = 0;
        for r in self.runs.iter_mut().filter(|r| !r.status.finished()) {
            r.ended_at = Some(now);
            match &r.cancel_asked {
                Some(by) => {
                    r.status = RunStatus::Cancelled;
                    r.note = Some(format!("cancelled by {by}; the server restarted before it reached a safe point"));
                }
                None => {
                    r.status = RunStatus::Failed;
                    r.error.get_or_insert_with(|| RESTARTED.to_string());
                }
            }
            n += 1;
        }
        n
    }
}

/// A job whose run is open in this process.
#[derive(Clone, Debug, Default)]
struct Open {
    run_id: String,
    owner: Option<Owner>,
    /// Parts begun and ended (a collection joins a part per cluster); 1 and 0 for a plain run.
    parts: u64,
    ended: u64,
    /// The run counts its parts as its progress.
    counted: bool,
    tally: BTreeMap<&'static str, u64>,
    records: Option<u64>,
    first_error: Option<String>,
    note: Option<String>,
    /// Begun by `reserve` for a person's `JOB_RUN`: the job's own code adopts it with its
    /// first non-timer `begin`, instead of being refused.
    reserved: bool,
    /// `JOB_CANCEL`: who asked.
    cancel: Option<String>,
}

/// A second run of a job asked for while one is open: the open run's id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Busy {
    pub run_id: String,
}

impl Busy {
    /// The answer to a person who asked for a run while one is open.
    pub fn answer(&self, what: &str) -> Value {
        json!({ "ok": false, "kind": "already_running", "runId": self.run_id,
                "message": format!("{what} is already running (run {}): wait for it to end", self.run_id) })
    }
}

struct Inner {
    /// The runs of each owner this process runs. Another owner's are read from its file.
    logs: HashMap<Owner, RunFile>,
    open: HashMap<String, Open>,
    /// A job's cluster held back as busy: the run that says so, one per wait (not one a tick).
    waiting: HashMap<(String, String), String>,
    /// When a job's timer next starts it, where the timer keeps no other record (Zabbix sync).
    next_at: HashMap<String, u64>,
}

/// `controls.json` as last read, with the file time it was read at.
#[derive(Default)]
struct ControlsCache {
    seen: Option<Option<std::time::SystemTime>>,
    controls: controls::Controls,
}

/// The run log and the single-flight guard of one process. Owned by `Core`, as an `Arc` so a
/// run can be ended from the task it was spawned into.
pub struct Jobs {
    dir: Option<PathBuf>,
    role: Role,
    inner: parking_lot::Mutex<Inner>,
    writers: HashMap<Owner, Arc<crate::report::Writer>>,
    controls: parking_lot::Mutex<ControlsCache>,
}

impl Jobs {
    /// Load the run files this process writes; runs they left open end `failed` (`RESTARTED`).
    pub fn open(data_dir: Option<&Path>, role: Role, now: u64) -> Arc<Jobs> {
        let dir = data_dir.map(|d| d.join(DIR));
        let mut logs = HashMap::new();
        let mut writers = HashMap::new();
        for owner in Owner::ALL.into_iter().filter(|o| o.run_by(role)) {
            let mut f: RunFile = dir.as_ref().and_then(|d| crate::worker::read_json_retry::<RunFile>(&d.join(owner.file())).ok().flatten())
                .unwrap_or_default();
            f.version = 1;
            let n = f.restarted(now);
            if n > 0 {
                tracing::warn!(runs = n, owner = owner.as_str(), "jobs: runs open when the process stopped were marked failed");
            }
            logs.insert(owner, f);
            writers.insert(owner, Arc::new(crate::report::Writer::default()));
        }
        let jobs = Arc::new(Jobs {
            dir, role, writers, controls: parking_lot::Mutex::new(ControlsCache::default()),
            inner: parking_lot::Mutex::new(Inner { logs, open: HashMap::new(), waiting: HashMap::new(), next_at: HashMap::new() }),
        });
        {
            let inner = jobs.inner.lock();
            for owner in inner.logs.keys() {
                if inner.logs.get(owner).is_some_and(|f| !f.runs.is_empty()) {
                    jobs.save(&inner, *owner);
                }
            }
        }
        jobs
    }

    pub fn role(&self) -> Role {
        self.role
    }

    /// Hand an owner's file to its writer (off this thread; the latest body wins).
    fn save(&self, inner: &Inner, owner: Owner) {
        let (Some(dir), Some(f), Some(w)) = (self.dir.as_ref(), inner.logs.get(&owner), self.writers.get(&owner)) else { return };
        match serde_json::to_vec(f) {
            Ok(body) => w.hand(dir.join(owner.file()), body),
            Err(e) => tracing::warn!(error = %e, "jobs: the run log could not be serialised"),
        }
    }

    /// Wait until every change is on disk. Tests, and before a process ends.
    pub fn flush(&self) {
        for w in self.writers.values() {
            w.flush();
        }
    }

    /// The open run of a job in this process, if any.
    pub fn running(&self, job: &str) -> Option<String> {
        self.inner.lock().open.get(job).map(|o| o.run_id.clone())
    }

    /// Begin a run of `job` — or, when one is open, refuse with its id (single flight). The
    /// run is recorded when this process runs the job's owner; elsewhere (the worker's own
    /// Zabbix sync, which only reads) only the guard holds. A run `reserve` began for a
    /// person is adopted by the first `begin` that is not the timer's.
    pub fn begin(self: &Arc<Self>, job: &str, trigger: Trigger, clusters: Vec<String>, now: u64) -> Result<Run, Busy> {
        let mut inner = self.inner.lock();
        if let Some(o) = inner.open.get_mut(job) {
            if o.reserved && trigger != Trigger::Timer {
                o.reserved = false;
                let id = o.run_id.clone();
                drop(inner);
                let run = Run { jobs: self.clone(), job: job.to_string(), id, ended: false };
                run.clusters(&clusters);
                return Ok(run);
            }
            return Err(Busy { run_id: o.run_id.clone() });
        }
        let id = self.start(&mut inner, job, trigger, clusters, now, false, RunMeta::default());
        Ok(Run { jobs: self.clone(), job: job.to_string(), id, ended: false })
    }

    /// Begin a run for a person (`JOB_RUN`, `JOB_RETRY`) before the job's own code starts,
    /// so the answer can name it: that code's first non-timer `begin` adopts it. A run never
    /// adopted is ended by `release` (nothing to do).
    pub fn reserve(self: &Arc<Self>, job: &str, trigger: Trigger, clusters: Vec<String>, meta: RunMeta, now: u64) -> Result<String, Busy> {
        let mut inner = self.inner.lock();
        if let Some(o) = inner.open.get(job) {
            return Err(Busy { run_id: o.run_id.clone() });
        }
        let id = self.start(&mut inner, job, trigger, clusters, now, false, meta);
        if let Some(o) = inner.open.get_mut(job) {
            o.reserved = true;
        }
        Ok(id)
    }

    /// The job's code returned without adopting the run `reserve` began: it found nothing to
    /// do (or refused before starting). The run ends `skipped`, saying `why`.
    pub fn release(&self, job: &str, id: &str, why: &str) {
        let reserved = self.inner.lock().open.get(job).is_some_and(|o| o.run_id == id && o.reserved);
        if reserved {
            self.end_part(job, id, Outcome::skipped(why), crate::fleet::now_ms());
        }
    }

    /// `JOB_CANCEL` of a run open in this process: asked, kept in the run file. `false` when
    /// no open run here has that id.
    pub fn cancel(&self, run_id: &str, by: &str) -> bool {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let Some((job, owner)) = inner.open.iter_mut().find(|(_, o)| o.run_id == run_id).map(|(j, o)| {
            o.cancel = Some(by.to_string());
            (j.clone(), o.owner)
        }) else {
            return false;
        };
        if let Some(owner) = owner {
            if let Some(r) = inner.logs.get_mut(&owner).and_then(|f| f.get_mut(run_id)) {
                r.cancel_asked = Some(by.to_string());
            }
            self.save(inner, owner);
        }
        tracing::info!(target: "audit", job = %job, run = %run_id, user = %by, "job: cancel asked");
        true
    }

    /// Who asked the open run of `job` to stop, if anybody: the job's safe points look here.
    pub fn cancel_asked(&self, job: &str) -> Option<String> {
        self.inner.lock().open.get(job).and_then(|o| o.cancel.clone())
    }

    /// A cluster of `job` held back because it is busy: one `deferred` run says so (cluster,
    /// reason, since) for the whole wait, however many ticks it lasts. `eased` ends the wait.
    pub fn defer(&self, job: &str, trigger: Trigger, b: &load::Busy, now: u64) -> Option<String> {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let key = (job.to_string(), b.cluster.clone());
        if let Some(id) = inner.waiting.get(&key) {
            return Some(id.clone());
        }
        let owner = descriptor(job).map(|d| d.owner).filter(|o| inner.logs.contains_key(o))?;
        let id = crate::auth::random_hex(8);
        let rec = RunRecord {
            id: id.clone(), job_id: job.to_string(), trigger, status: RunStatus::Deferred, created_at: now, started_at: None,
            ended_at: Some(now), done: None, total: None, records: None,
            error: Some(format!("{} is busy: {}; tried again when it eases", b.cluster, b.reason)),
            clusters: vec![b.cluster.clone()], note: None, cancel_asked: None, retry_of: None, attempt: 0, deferred: Some(b.clone()), scope: None,
        };
        if let Some(f) = inner.logs.get_mut(&owner) {
            f.push(rec);
        }
        self.save(inner, owner);
        inner.waiting.insert(key, id.clone());
        tracing::info!(job, cluster = %b.cluster, reason = %b.reason, "job: deferred, the cluster is busy");
        Some(id)
    }

    /// A run (part) of `job` ended `deferred` for its busy cluster: that is the wait's record,
    /// so the ticks that find it still busy add none.
    pub fn mark_waiting(&self, job: &str, cluster: &str, run_id: &str) {
        self.inner.lock().waiting.insert((job.to_string(), cluster.to_string()), run_id.to_string());
    }

    /// The cluster is no longer busy for `job`: the next deferral is a new wait.
    pub fn eased(&self, job: &str, cluster: &str) {
        self.inner.lock().waiting.remove(&(job.to_string(), cluster.to_string()));
    }

    /// When the timer next starts `job`, for a timer that keeps it nowhere else.
    pub fn set_next_at(&self, job: &str, at: u64) {
        self.inner.lock().next_at.insert(job.to_string(), at);
    }

    pub fn next_at(&self, job: &str) -> Option<u64> {
        self.inner.lock().next_at.get(job).copied()
    }

    /* ------------------------------ the settings (controls.json) ------------------------------ */

    fn controls_path(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(controls::FILE))
    }

    /// The settings as last written (read again when the file changed: the worker reads what
    /// the core wrote). A file that cannot be read is the defaults, said in the log.
    pub fn controls(&self) -> controls::Controls {
        let mut c = self.controls.lock();
        if let Some(p) = self.controls_path() {
            let now = crate::worker::mtime(&p);
            if c.seen.as_ref() != Some(&now) {
                match controls::Controls::load(&p) {
                    Ok(v) => c.controls = v,
                    Err(e) => tracing::warn!(error = %e, "jobs: the settings could not be read; the last ones read stand"),
                }
                c.seen = Some(now);
            }
        }
        c.controls.clone()
    }

    /// Why the timer must not start `job` now (paused, or automatic runs off), if so. Every
    /// timer asks before every run.
    pub fn held(&self, job: &str) -> Option<controls::Held> {
        self.controls().held(job)
    }

    /// Change the settings and write them. Only the process that serves people writes them.
    pub fn update_controls<R>(&self, by: &str, f: impl FnOnce(&mut controls::Controls) -> Result<R, String>) -> Result<(R, controls::Controls), String> {
        if !self.role.serves_people() {
            return Err("the jobs' settings are the core's to change".into());
        }
        let mut c = self.controls.lock();
        let path = self.controls_path();
        let mut next = match &path {
            Some(p) => controls::Controls::load(p)?,
            None => c.controls.clone(),
        };
        let out = f(&mut next)?;
        next.version = 1;
        next.set_by = Some(by.to_string());
        next.set_at = Some(crate::fleet::now_ms());
        if let Some(p) = &path {
            next.save(p)?;
            c.seen = Some(crate::worker::mtime(p));
        }
        c.controls = next.clone();
        Ok((out, next))
    }

    /// Join the open run of `job` with one more part (a cluster), or begin one with it. For the
    /// collections, which start clusters one at a time and may start more while some still
    /// run: one run, its progress the clusters ended of those begun.
    pub fn join(self: &Arc<Self>, job: &str, trigger: Trigger, cluster: &str, now: u64) -> Run {
        self.join_with(job, trigger, cluster, now, RunMeta::default())
    }

    /// `join`, saying what a run it begins tries again (`JOB_RETRY` of a collection).
    pub fn join_with(self: &Arc<Self>, job: &str, trigger: Trigger, cluster: &str, now: u64, meta: RunMeta) -> Run {
        let mut inner = self.inner.lock();
        let id = match inner.open.get_mut(job) {
            Some(o) => {
                o.parts += 1;
                o.counted = true;
                let (id, owner) = (o.run_id.clone(), o.owner);
                if let Some(owner) = owner {
                    if let Some(r) = inner.logs.get_mut(&owner).and_then(|f| f.get_mut(&id)) {
                        if !r.clusters.iter().any(|c| c == cluster) {
                            r.clusters.push(cluster.to_string());
                        }
                        r.total = Some(r.total.unwrap_or(0) + 1);
                        r.done.get_or_insert(0);
                    }
                    self.save(&inner, owner);
                }
                id
            }
            None => self.start(&mut inner, job, trigger, vec![cluster.to_string()], now, true, meta),
        };
        Run { jobs: self.clone(), job: job.to_string(), id, ended: false }
    }

    #[allow(clippy::too_many_arguments)]
    fn start(&self, inner: &mut Inner, job: &str, trigger: Trigger, clusters: Vec<String>, now: u64, counted: bool, meta: RunMeta) -> String {
        let id = crate::auth::random_hex(8);
        let owner = descriptor(job).map(|d| d.owner).or_else(|| is_created_id(job).then_some(Owner::Worker))
            .filter(|o| inner.logs.contains_key(o));
        if let Some(owner) = owner {
            let rec = RunRecord {
                id: id.clone(), job_id: job.to_string(), trigger, status: RunStatus::Running, created_at: now, started_at: Some(now),
                ended_at: None, done: counted.then_some(0), total: counted.then_some(1), records: None, error: None, clusters, note: None,
                cancel_asked: None, retry_of: meta.retry_of, attempt: meta.attempt, deferred: None, scope: None,
            };
            if let Some(f) = inner.logs.get_mut(&owner) {
                f.push(rec);
            }
            self.save(inner, owner);
        }
        inner.open.insert(job.to_string(), Open { run_id: id.clone(), owner, parts: 1, counted, ..Open::default() });
        id
    }

    fn update(&self, job: &str, id: &str, f: impl FnOnce(&mut RunRecord)) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let Some(owner) = inner.open.get(job).filter(|o| o.run_id == id).and_then(|o| o.owner) else { return };
        if let Some(r) = inner.logs.get_mut(&owner).and_then(|l| l.get_mut(id)) {
            f(r);
        }
        self.save(inner, owner);
    }

    /// One part ended; the run ends with its last part. The run's status: any part failed is
    /// `failed`, else any deferred `deferred`, else any cancelled `cancelled`, else any
    /// completed `completed`, else `skipped`.
    fn end_part(&self, job: &str, id: &str, out: Outcome, now: u64) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let Some(o) = inner.open.get_mut(job).filter(|o| o.run_id == id) else { return };
        o.ended += 1;
        let key = match out.status {
            RunStatus::Failed => "failed",
            RunStatus::Deferred => "deferred",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Skipped => "skipped",
            _ => "completed",
        };
        *o.tally.entry(key).or_insert(0) += 1;
        if let Some(n) = out.records {
            o.records = Some(o.records.unwrap_or(0) + n);
        }
        if o.first_error.is_none() {
            o.first_error = out.error.clone();
        }
        if out.note.is_some() {
            o.note = out.note.clone();
        }
        let last = o.ended >= o.parts;
        let o = o.clone();
        if last {
            inner.open.remove(job);
        }
        let Some(owner) = o.owner else { return };
        if let Some(r) = inner.logs.get_mut(&owner).and_then(|l| l.get_mut(id)) {
            if o.counted {
                r.done = Some(o.ended);
                r.total = Some(o.parts);
            }
            if last {
                let n = |k: &str| o.tally.get(k).copied().unwrap_or(0);
                r.status = if !o.counted {
                    out.status
                } else if n("failed") > 0 {
                    RunStatus::Failed
                } else if n("deferred") > 0 {
                    RunStatus::Deferred
                } else if n("cancelled") > 0 {
                    RunStatus::Cancelled
                } else if n("completed") > 0 {
                    RunStatus::Completed
                } else {
                    RunStatus::Skipped
                };
                r.ended_at = Some(now);
                r.records = o.records;
                r.error = o.first_error.clone();
                r.note = if o.counted && o.parts > 1 {
                    let parts: Vec<String> = ["completed", "failed", "deferred", "cancelled", "skipped"].iter()
                        .filter(|k| n(k) > 0).map(|k| format!("{} {k}", n(k))).collect();
                    Some(format!("{} clusters: {}", o.parts, parts.join(", ")))
                } else {
                    o.note.clone()
                };
                // Asked to stop, and ended otherwise: it had no safe point left. Said, not hidden.
                if let (Some(by), true) = (&o.cancel, r.status != RunStatus::Cancelled) {
                    let said = format!("cancel asked by {by}; it ended before its next safe point");
                    r.note = Some(match r.note.take() {
                        Some(n) => format!("{n}; {said}"),
                        None => said,
                    });
                }
                if r.status == RunStatus::Completed {
                    r.error = None;
                }
            }
        }
        if last {
            if let Some(f) = inner.logs.get_mut(&owner) {
                f.trim();
            }
        }
        self.save(inner, owner);
    }

    /// The runs this process records, with their owner.
    pub fn own_runs(&self) -> Vec<(Owner, RunRecord)> {
        let inner = self.inner.lock();
        let mut out = vec![];
        for (owner, f) in &inner.logs {
            out.extend(f.runs.iter().cloned().map(|r| (*owner, r)));
        }
        out
    }

    /// Every run: this process's from memory, the other owner's from its file (as that
    /// process last wrote it; a file that cannot be read is said, not taken as empty).
    pub fn all_runs(&self) -> (Vec<(Owner, RunRecord)>, Vec<String>) {
        let mut out = self.own_runs();
        let mut problems = vec![];
        let owned: Vec<Owner> = self.inner.lock().logs.keys().copied().collect();
        if let Some(dir) = &self.dir {
            for owner in Owner::ALL.into_iter().filter(|o| !owned.contains(o)) {
                match crate::worker::read_json_retry::<RunFile>(&dir.join(owner.file())) {
                    Ok(Some(f)) => out.extend(f.runs.into_iter().map(|r| (owner, r))),
                    Ok(None) => {}
                    Err(e) => problems.push(format!("the {} run log could not be read: {e}", owner.as_str())),
                }
            }
        }
        (out, problems)
    }
}

/// A run in progress (or one part of it). End it with `end`; dropped without, it ends `failed`.
pub struct Run {
    jobs: Arc<Jobs>,
    job: String,
    id: String,
    ended: bool,
}

impl Run {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Who asked this run to stop (`JOB_CANCEL`), if anybody: checked at the job's safe points.
    pub fn cancel_asked(&self) -> Option<String> {
        self.jobs.inner.lock().open.get(&self.job).filter(|o| o.run_id == self.id).and_then(|o| o.cancel.clone())
    }

    /// Where a plain run is: `done` of `total`.
    pub fn progress(&self, done: u64, total: u64) {
        self.jobs.update(&self.job, &self.id, |r| {
            r.done = Some(done);
            r.total = Some(total);
        });
    }

    /// What the run has processed so far (devices measured), before it ends: JOBS_LIST shows
    /// it while the run goes.
    pub fn records(&self, n: u64) {
        self.jobs.update(&self.job, &self.id, |r| r.records = Some(n));
    }

    /// What a person narrowed the run to (kept for `JOB_RETRY`).
    pub fn scope(&self, v: Value) {
        self.jobs.update(&self.job, &self.id, |r| r.scope = Some(v));
    }

    /// The clusters the run touches, once it knows them.
    pub fn clusters(&self, ids: &[String]) {
        self.jobs.update(&self.job, &self.id, |r| {
            for id in ids {
                if !r.clusters.contains(id) {
                    r.clusters.push(id.clone());
                }
            }
        });
    }

    pub fn end(mut self, out: Outcome) {
        self.ended = true;
        self.jobs.end_part(&self.job, &self.id, out, crate::fleet::now_ms());
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        if !self.ended {
            self.jobs.end_part(&self.job, &self.id, Outcome::failed(NO_RESULT, None), crate::fleet::now_ms());
        }
    }
}

/* ------------------------------------------ retry ------------------------------------------ */

/// Whether a run that ended at `ended_at` (unix ms), being try `attempt` (0 = the first run),
/// may be tried again now under `policy`: `None` when it may, else the refusal — `retry_limit`
/// when it was tried `retryLimit` times already, `retry_wait` (with `retryAt`) within
/// `retryWaitMinutes` of its end. The one rule for every `JOB_RETRY`.
pub fn retry_refusal(attempt: u32, ended_at: Option<u64>, policy: &controls::Overall, now: u64) -> Option<Value> {
    if attempt >= policy.retry_limit {
        return Some(json!({ "ok": false, "kind": "retry_limit", "attempt": attempt, "retryLimit": policy.retry_limit,
            "message": format!("this run was tried again {attempt} time(s) already and the retry limit is {} (JOB_SETTINGS_SET overall.retryLimit): run the job afresh instead (JOB_RUN)", policy.retry_limit) }));
    }
    let at = ended_at?.saturating_add(policy.retry_wait_minutes.saturating_mul(60_000));
    (now < at).then(|| json!({ "ok": false, "kind": "retry_wait", "retryAt": at,
        "message": format!("tries are {} minute(s) apart (JOB_SETTINGS_SET overall.retryWaitMinutes): this one may be tried again in {} s",
                           policy.retry_wait_minutes, at.saturating_sub(now).div_ceil(1000)) }))
}

/* ------------------------------------------ report jobs ------------------------------------------ */

/// The job a report job of `jobs.json` is a run of: a created schedule's, the mailed schedule's,
/// else `report.run`. One definition, for the run list and the governor's lanes.
pub fn report_job_id(j: &Job) -> String {
    match (&j.schedule_id, j.kind) {
        (Some(sid), _) => format!("{CREATED_PREFIX}{sid}"),
        (None, ReportJobKind::Mailed) => mailed_id(j.report).to_string(),
        _ => REPORT_RUN.to_string(),
    }
}

/// A report job of `jobs.json` as a run: the queue is its record, so it is mapped, not copied.
/// Its id is `report-<job id>`. A queued job's progress is not known yet.
pub fn from_report_job(j: &Job) -> RunRecord {
    let job_id = report_job_id(j);
    let trigger = if j.retry_of.is_some() {
        Trigger::Retry
    } else if j.by == crate::report::SCHEDULE_BY {
        Trigger::Timer
    } else {
        Trigger::manual(&j.by)
    };
    let status = match j.status {
        ReportStatus::Queued => RunStatus::Queued,
        ReportStatus::Running => RunStatus::Running,
        ReportStatus::Done => RunStatus::Completed,
        ReportStatus::Stopped => RunStatus::Cancelled,
        ReportStatus::Failed => RunStatus::Failed,
    };
    let ms = |t: i64| u64::try_from(t).unwrap_or(0);
    let counted = status != RunStatus::Queued && j.progress.total > 0;
    let note = match (&j.warning, &j.stopped_by) {
        (Some(w), _) => Some(w.clone()),
        (None, Some(by)) => Some(format!("stopped by {by}")),
        _ => None,
    };
    RunRecord {
        id: format!("report-{}", j.id), job_id, trigger, status, created_at: ms(j.created_at),
        started_at: j.started_at.map(ms), ended_at: j.ended_at.map(ms),
        done: counted.then_some(j.progress.done), total: counted.then_some(j.progress.total),
        records: j.progress.rows, error: j.error.clone().or_else(|| j.mail_error.clone()),
        // Exactly what REPORT_JOBS decides visibility on (`Job::covered`); not known is `*`.
        clusters: j.covered().unwrap_or_else(|| vec![crate::report::jobs::ALL_CLUSTERS.to_string()]), note,
        cancel_asked: j.stop_asked.clone(), retry_of: j.retry_of.as_ref().map(|r| format!("report-{r}")), attempt: j.attempt,
        deferred: None, scope: None,
    }
}

/* ------------------------------------------ what a caller reads ------------------------------------------ */

/// What a caller who is not an administrator reads in place of an admin-only job's error.
pub const DETAIL_ADMIN: &str = "an administrator can read why";

/// Who is reading: the clusters they see (the one per-caller view, `Core::sink_view`) and
/// whether they are an administrator (`detailsFor: admin` jobs).
#[derive(Clone, Copy, Debug)]
pub struct Reader<'a> {
    pub view: &'a SinkView,
    pub admin: bool,
}

/// A run as `who` may read it, or `None` when they may not: only a caller who sees every
/// cluster the run touched reads it at all (`report::jobs::may_read`, the REPORT_JOBS rule); a
/// run of a job about no cluster is everybody's who may read the list; a run whose clusters are
/// not known (`*`, or none on a cluster-scoped job) is an administrator's who sees every cluster. An admin-only job's error and
/// note go to administrators only. `progress` is percent, or null when the total is not known.
pub fn run_view(owner: Owner, r: &RunRecord, who: Reader<'_>) -> Option<Value> {
    // A cluster-scoped job's run (or an unknown job's) that names no cluster: not known.
    let unknown = r.clusters.is_empty() && descriptor(&r.job_id).is_none_or(|d| d.cluster_scoped);
    let covered = (!unknown).then_some(r.clusters.as_slice());
    if !crate::report::jobs::may_read(who.view.visible.as_ref(), who.admin, covered) {
        return None;
    }
    let hidden = !who.admin && descriptor(&r.job_id).is_some_and(|d| d.admin_details);
    Some(json!({
        "id": r.id, "jobId": r.job_id, "owner": owner, "trigger": r.trigger, "status": r.status,
        "createdAt": r.created_at, "startedAt": r.started_at, "endedAt": r.ended_at,
        "progress": progress_pct(r.done, r.total), "done": r.done, "total": r.total,
        "records": r.records,
        "error": match (&r.error, hidden) {
            (Some(_), true) => json!(DETAIL_ADMIN),
            (e, _) => json!(e),
        },
        "note": if hidden { Value::Null } else { json!(r.note) },
        "clusters": r.clusters,
        "cancelAsked": r.cancel_asked.is_some(), "retryOf": r.retry_of, "attempt": r.attempt,
        "deferred": r.deferred, "scope": r.scope,
    }))
}

/// `JOBS_LIST {before?, limit?, jobId?}`: which runs, newest first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Page {
    /// Runs strictly older than this `(createdAt, id)`: the previous answer's `next`.
    pub before: Option<(u64, String)>,
    pub limit: usize,
    pub job: Option<String>,
}

impl Page {
    pub fn parse(msg: &Value) -> Result<Page, String> {
        let before = match msg.get("before") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => {
                let (at, id) = s.split_once(':').ok_or("before must be a previous answer's next")?;
                Some((at.parse::<u64>().map_err(|_| "before must be a previous answer's next")?, id.to_string()))
            }
            Some(_) => return Err("before must be a previous answer's next".into()),
        };
        let limit = match msg.get("limit") {
            None | Some(Value::Null) => LIST_LIMIT,
            Some(v) => v.as_u64().filter(|n| *n >= 1).ok_or("limit must be a positive number")?.min(LIST_LIMIT_MAX as u64) as usize,
        };
        let job = match msg.get("jobId") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if descriptor(s).is_some() || is_created_id(s) => Some(s.clone()),
            Some(_) => return Err("jobId is not a job (see jobs[].id)".into()),
        };
        Ok(Page { before, limit, job })
    }
}

/// Newest first by `(createdAt, id)`.
fn newest_first(runs: &mut [(Owner, RunRecord)]) {
    runs.sort_by(|a, b| b.1.created_at.cmp(&a.1.created_at).then_with(|| b.1.id.cmp(&a.1.id)));
}

/// The page of runs `who` may read, and the cursor of the next page (`None` at the end).
pub fn page(mut runs: Vec<(Owner, RunRecord)>, p: &Page, who: Reader<'_>) -> (Vec<Value>, Option<String>) {
    newest_first(&mut runs);
    let mut out = vec![];
    let mut more = None;
    for (owner, r) in &runs {
        if p.job.as_deref().is_some_and(|j| j != r.job_id) {
            continue;
        }
        if p.before.as_ref().is_some_and(|(at, id)| (r.created_at, &r.id) >= (*at, id)) {
            continue;
        }
        let Some(v) = run_view(*owner, r, who) else { continue };
        if out.len() == p.limit {
            more = Some(());
            break;
        }
        out.push((v, format!("{}:{}", r.created_at, r.id)));
    }
    let next = more.and_then(|_| out.last().map(|(_, c)| c.clone()));
    (out.into_iter().map(|(v, _)| v).collect(), next)
}

/// Each job's open run (the newest, with how many are open) and last finished run, as `who`
/// may read them.
pub fn job_states(runs: &[(Owner, RunRecord)], who: Reader<'_>) -> HashMap<String, (Option<Value>, usize, Option<Value>)> {
    let mut sorted: Vec<(Owner, RunRecord)> = runs.to_vec();
    newest_first(&mut sorted);
    let mut out: HashMap<String, (Option<Value>, usize, Option<Value>)> = HashMap::new();
    for (owner, r) in &sorted {
        let Some(v) = run_view(*owner, r, who) else { continue };
        let e = out.entry(r.job_id.clone()).or_default();
        if r.status.finished() {
            if e.2.is_none() {
                e.2 = Some(v);
            }
        } else {
            e.1 += 1;
            // Running before queued: what is happening now, then what waits.
            let running = r.status == RunStatus::Running;
            if e.0.as_ref().is_none_or(|cur| running && cur["status"] != json!("running")) {
                e.0 = Some(v);
            }
        }
    }
    out
}

/* ------------------------------------------ the hosts collection's tries ------------------------------------------ */

/// One cluster's tries today: (local day, tries, last try at, ms) — `Reports::hosts_attempts`.
pub type HostsTries = HashMap<String, (String, u32, i64)>;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TryLine {
    day: String,
    tries: u32,
    last_at: i64,
}

/// The tries as the hosts collection's process last wrote them; empty when there is no file.
pub fn load_hosts_tries(data_dir: &Path) -> HostsTries {
    crate::worker::read_json_retry::<BTreeMap<String, TryLine>>(&data_dir.join(DIR).join(HOSTS_TRIES_FILE)).ok().flatten()
        .unwrap_or_default().into_iter().map(|(id, t)| (id, (t.day, t.tries, t.last_at))).collect()
}

/// Write the tries of `today` (earlier days are of no use to anybody), so a restart does not
/// give a cluster three more.
pub fn save_hosts_tries(data_dir: &Path, tries: &HostsTries, today: &str) -> Result<(), String> {
    let lines: BTreeMap<&String, TryLine> = tries.iter().filter(|(_, t)| t.0 == today)
        .map(|(id, t)| (id, TryLine { day: t.0.clone(), tries: t.1, last_at: t.2 })).collect();
    let body = serde_json::to_vec(&lines).map_err(|e| e.to_string())?;
    crate::volume::store::write_atomic(&data_dir.join(DIR).join(HOSTS_TRIES_FILE), &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ep-jobs-{tag}-{}-{}", std::process::id(), crate::auth::random_hex(4)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rec(job: &str, id: &str, at: u64, status: RunStatus, clusters: &[&str]) -> RunRecord {
        RunRecord {
            id: id.into(), job_id: job.into(), trigger: Trigger::Timer, status, created_at: at, started_at: Some(at),
            ended_at: status.finished().then_some(at + 1), done: None, total: None, records: Some(7),
            error: Some("prod-b: search failed".into()), clusters: clusters.iter().map(|s| s.to_string()).collect(), note: Some("n".into()),
            cancel_asked: None, retry_of: None, attempt: 0, deferred: None, scope: None,
        }
    }

    #[test]
    fn the_registry_names_every_job_once_with_the_plans_defaults() {
        let mut ids: Vec<&str> = REGISTRY.iter().map(|d| d.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), REGISTRY.len(), "a job id twice");
        for k in ReportKind::ALL {
            assert!(descriptor(mailed_id(k)).is_some_and(|d| d.report == Some(k)), "{k:?}");
        }
        let d = |id| descriptor(id).unwrap();
        assert_eq!(d(LOGDELAY_MEASURE).priority, Priority::High);
        for id in [HOUSEKEEPING, HISTORY_MIRROR, ZABBIX_SYNC, ZABBIX_PUSH] {
            assert_eq!(d(id).priority, Priority::Low, "{id}");
        }
        for id in [VOLUME_DAILY, HOSTS_COLLECT, REPORT_RUN, SETTINGS_BACKUP, MAILED_VOLUME] {
            assert_eq!(d(id).priority, Priority::Medium, "{id}");
        }
        assert_eq!(d(HOSTS_COLLECT).requests, req(1, 2));
        assert_eq!(d(HOUSEKEEPING).requests, req(1, 1));
        assert_eq!(d(HISTORY_MIRROR).requests, req(1, 2));
        assert_eq!(d(ZABBIX_SYNC).requests, req(1, 2));
        assert_eq!(d(VOLUME_DAILY).requests, req(1, 4));
        assert_eq!(d(REPORT_RUN).kind, JobKind::Manual);
        assert!(!d(REPORT_RUN).pausable);
        assert_eq!(d(VOLUME_DAILY).owner, Owner::Worker);
        assert_eq!(d(ZABBIX_PUSH).owner, Owner::Core);
    }

    #[test]
    fn a_trigger_reads_back_as_written() {
        for t in [Trigger::Timer, Trigger::Retry, Trigger::manual("Admin"), Trigger::manual("a:b")] {
            let s = serde_json::to_string(&t).unwrap();
            assert_eq!(serde_json::from_str::<Trigger>(&s).unwrap(), t, "{s}");
        }
        assert_eq!(Trigger::manual("Admin").text(), "manual:Admin");
        assert!(serde_json::from_str::<Trigger>("\"cron\"").is_err());
    }

    #[test]
    fn progress_is_null_when_the_total_is_not_known() {
        assert_eq!(progress_pct(None, None), None);
        assert_eq!(progress_pct(Some(3), None), None);
        assert_eq!(progress_pct(Some(0), Some(0)), None, "no total is not 0 %");
        assert_eq!(progress_pct(Some(1), Some(4)), Some(25));
        assert_eq!(progress_pct(Some(9), Some(4)), Some(100));
        let jobs = Jobs::open(None, Role::All, 1);
        let run = jobs.begin(HOUSEKEEPING, Trigger::Timer, vec![], 1).unwrap();
        let (runs, _) = jobs.all_runs();
        let all = SinkView::default();
        let admin = Reader { view: &all, admin: true };
        let v = run_view(Owner::Core, &runs[0].1, admin).unwrap();
        assert_eq!(v["progress"], Value::Null, "a plain run counts nothing: {v}");
        run.progress(2, 8);
        let (runs, _) = jobs.all_runs();
        assert_eq!(run_view(Owner::Core, &runs[0].1, admin).unwrap()["progress"], json!(25));
        run.end(Outcome::completed(Some(3)));
    }

    #[test]
    fn one_run_per_job_at_a_time() {
        let jobs = Jobs::open(None, Role::All, 1);
        let first = jobs.begin(LOGDELAY_MEASURE, Trigger::Timer, vec![], 1).unwrap();
        let second = jobs.begin(LOGDELAY_MEASURE, Trigger::manual("Admin"), vec![], 2);
        assert_eq!(second.err(), Some(Busy { run_id: first.id().to_string() }), "the open run's id comes back");
        assert_eq!(Busy { run_id: "x".into() }.answer("it")["kind"], json!("already_running"));
        // Another job is not held up.
        let other = jobs.begin(HOUSEKEEPING, Trigger::Timer, vec![], 2).unwrap();
        let id = first.id().to_string();
        first.end(Outcome::completed(None));
        let third = jobs.begin(LOGDELAY_MEASURE, Trigger::manual("Admin"), vec![], 3).unwrap();
        assert_ne!(third.id(), id, "free once the first ended");
        // A run dropped without an end (a panic) frees the job too, and says so.
        drop(third);
        assert_eq!(jobs.running(LOGDELAY_MEASURE), None);
        let (runs, _) = jobs.all_runs();
        let dropped = runs.iter().find(|(_, r)| r.trigger == Trigger::manual("Admin")).unwrap();
        assert_eq!(dropped.1.status, RunStatus::Failed);
        assert_eq!(dropped.1.error.as_deref(), Some(NO_RESULT));
        other.end(Outcome::completed(None));
    }

    #[test]
    fn a_collection_is_one_run_whose_parts_are_its_clusters() {
        let jobs = Jobs::open(None, Role::Worker, 1);
        let a = jobs.join(VOLUME_DAILY, Trigger::Timer, "a", 1);
        let b = jobs.join(VOLUME_DAILY, Trigger::Timer, "b", 2);
        assert_eq!(a.id(), b.id(), "joined, not a second run");
        assert!(jobs.begin(VOLUME_DAILY, Trigger::Timer, vec![], 3).is_err(), "and still single flight");
        a.end(Outcome::completed(Some(4)));
        let r = || jobs.all_runs().0.into_iter().find(|(_, r)| r.job_id == VOLUME_DAILY).unwrap().1;
        assert_eq!((r().status, r().done, r().total), (RunStatus::Running, Some(1), Some(2)));
        let c = jobs.join(VOLUME_DAILY, Trigger::Timer, "c", 4);
        c.end(Outcome::deferred("the emergency stop came on", Some(1)));
        b.end(Outcome::completed(Some(2)));
        let done = r();
        assert_eq!(done.status, RunStatus::Deferred, "a deferred part defers the run");
        assert_eq!((done.done, done.total, done.records), (Some(3), Some(3), Some(7)));
        assert_eq!(done.clusters, vec!["a", "b", "c"]);
        assert_eq!(done.error.as_deref(), Some("the emergency stop came on"));
        assert_eq!(done.note.as_deref(), Some("3 clusters: 2 completed, 1 deferred"));
    }

    #[test]
    fn the_log_is_capped_per_job_and_in_all_and_keeps_open_runs() {
        let mut f = RunFile::default();
        f.push(rec(HOUSEKEEPING, "open", 0, RunStatus::Running, &[]));
        for i in 0..(KEEP_PER_JOB as u64 + 10) {
            f.push(rec(HOUSEKEEPING, &format!("h{i}"), i + 1, RunStatus::Completed, &[]));
        }
        let kept: Vec<&RunRecord> = f.runs.iter().filter(|r| r.job_id == HOUSEKEEPING && r.status.finished()).collect();
        assert_eq!(kept.len(), KEEP_PER_JOB);
        assert_eq!(kept[0].id, "h10", "the oldest went first");
        assert!(f.runs.iter().any(|r| r.id == "open"), "an open run is never dropped");
        // The total: as many jobs as it takes to pass it.
        let mut g = RunFile::default();
        let jobs_n = KEEP_TOTAL / KEEP_PER_JOB + 2;
        for j in 0..jobs_n {
            for i in 0..KEEP_PER_JOB {
                g.push(rec(&format!("job{j}"), &format!("{j}-{i}"), (j * 1000 + i) as u64, RunStatus::Failed, &[]));
            }
        }
        assert_eq!(g.runs.len(), KEEP_TOTAL);
        assert!(!g.runs.iter().any(|r| r.job_id == "job0"), "the oldest job's runs went first");
    }

    #[test]
    fn the_log_survives_a_restart_and_an_open_run_ends_failed() {
        let d = tmp("restart");
        {
            let jobs = Jobs::open(Some(&d), Role::Core, 1);
            jobs.begin(ZABBIX_PUSH, Trigger::Timer, vec![], 5).unwrap().end(Outcome::completed(Some(1)));
            let open = jobs.begin(HOUSEKEEPING, Trigger::manual("Admin"), vec![], 6).unwrap();
            // A worker job is not this process's to record: the guard holds, nothing is written.
            let w = jobs.begin(VOLUME_DAILY, Trigger::Timer, vec![], 6).unwrap();
            jobs.flush();
            std::mem::forget(open);
            drop(w);
            jobs.flush();
        }
        assert!(!d.join(DIR).join(Owner::Worker.file()).exists(), "the core never writes the worker's file");
        let jobs = Jobs::open(Some(&d), Role::Core, 100);
        jobs.flush();
        let (runs, problems) = jobs.all_runs();
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(runs.len(), 2, "{runs:?}");
        let push = runs.iter().find(|(_, r)| r.job_id == ZABBIX_PUSH).unwrap();
        assert_eq!((push.1.status, push.1.records), (RunStatus::Completed, Some(1)));
        let hk = runs.iter().find(|(_, r)| r.job_id == HOUSEKEEPING).unwrap();
        assert_eq!((hk.1.status, hk.1.ended_at, hk.1.error.as_deref()), (RunStatus::Failed, Some(100), Some(RESTARTED)));
        assert_eq!(jobs.running(HOUSEKEEPING), None, "nothing is open in the new process");
        // The worker reads nothing of the core's into its own file; the core's file is read
        // by whoever does not write it.
        let w = Jobs::open(Some(&d), Role::Worker, 200);
        assert_eq!(w.own_runs().len(), 0);
        assert_eq!(w.all_runs().0.len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_caller_reads_a_run_only_when_they_see_every_cluster_it_touched() {
        let limited_view = SinkView { visible: Some(["prod".to_string(), "dr".to_string()].into()) };
        let all_view = SinkView::default();
        let limited = Reader { view: &limited_view, admin: true };
        let admin = Reader { view: &all_view, admin: true };
        let fleet = rec(HOUSEKEEPING, "f", 1, RunStatus::Completed, &[]);
        let both_seen = rec(VOLUME_DAILY, "m", 2, RunStatus::Failed, &["prod", "dr"]);
        let theirs = rec(VOLUME_DAILY, "t", 3, RunStatus::Failed, &["prod-b"]);
        let one_of_two = rec(VOLUME_DAILY, "x", 4, RunStatus::Running, &["prod", "prod-b"]);
        // Sees every cluster of it: the whole run.
        let m = run_view(Owner::Worker, &both_seen, limited).unwrap();
        assert_eq!((m["error"].clone(), m["records"].clone(), m["clusters"].clone()), (json!("prod-b: search failed"), json!(7), json!(["prod", "dr"])));
        // Sees one of two, or none: not listed at all — no partial view.
        assert!(run_view(Owner::Worker, &one_of_two, limited).is_none(), "one of two clusters is not enough");
        assert!(run_view(Owner::Worker, &theirs, limited).is_none());
        // About no cluster: everybody's who may read the list.
        assert!(run_view(Owner::Core, &fleet, limited).is_some());
        // An administrator who sees every cluster: everything, as is.
        for r in [&fleet, &both_seen, &theirs, &one_of_two] {
            assert!(run_view(Owner::Worker, r, admin).is_some(), "{}", r.id);
        }
        assert_eq!(run_view(Owner::Worker, &one_of_two, admin).unwrap()["clusters"], json!(["prod", "prod-b"]));
        // The same rule as REPORT_JOBS: one function.
        assert!(!crate::report::jobs::may_read(limited_view.visible.as_ref(), true, Some(&["prod".into(), "prod-b".into()])));

        // Clusters not known fail closed: `*`, or none on a cluster-scoped job, is an
        // administrator's who sees every cluster — not a limited admin's, not a user's.
        let user_all = Reader { view: &all_view, admin: false };
        let star = rec(REPORT_RUN, "s", 5, RunStatus::Completed, &["*"]);
        let blank = rec(VOLUME_DAILY, "b", 6, RunStatus::Completed, &[]);
        for r in [&star, &blank] {
            assert!(run_view(Owner::Worker, r, admin).is_some(), "{}", r.id);
            assert!(run_view(Owner::Worker, r, limited).is_none(), "{}: a limited admin", r.id);
            assert!(run_view(Owner::Worker, r, user_all).is_none(), "{}: a user", r.id);
        }
        assert!(run_view(Owner::Core, &rec(HOUSEKEEPING, "h", 7, RunStatus::Completed, &[]), user_all).is_some(),
                "a job about no cluster stays everybody's");

        // The page, the open run and the last run go through the same view.
        let runs = vec![(Owner::Core, fleet), (Owner::Worker, both_seen), (Owner::Worker, theirs), (Owner::Worker, one_of_two)];
        let (seen, _) = page(runs.clone(), &Page { limit: 10, ..Page::default() }, limited);
        let ids: Vec<&str> = seen.iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["m", "f"]);
        let states = job_states(&runs, limited);
        assert_eq!(states[VOLUME_DAILY].0, None, "the open run is about a cluster they do not see");
        assert_eq!(states[VOLUME_DAILY].1, 0);
        assert_eq!(states[VOLUME_DAILY].2.as_ref().unwrap()["id"], json!("m"), "and the last run is the newest they may read");
        let all = job_states(&runs, admin);
        assert_eq!(all[VOLUME_DAILY].0.as_ref().unwrap()["id"], json!("x"));
        assert_eq!(all[VOLUME_DAILY].2.as_ref().unwrap()["id"], json!("t"));

        // An admin-only job's error is an administrator's; everybody reads its status.
        let user = Reader { view: &all_view, admin: false };
        let hk = run_view(Owner::Core, &runs[0].1, user).unwrap();
        assert_eq!((hk["status"].clone(), hk["error"].clone(), hk["note"].clone()), (json!("completed"), json!(DETAIL_ADMIN), Value::Null));
        assert_eq!(run_view(Owner::Core, &runs[0].1, admin).unwrap()["error"], json!("prod-b: search failed"));
        assert_eq!(run_view(Owner::Worker, &runs[1].1, user).unwrap()["error"], json!("prod-b: search failed"), "a user's job's error is theirs");
    }

    #[test]
    fn runs_page_newest_first_by_cursor() {
        let runs: Vec<(Owner, RunRecord)> = (0..5).map(|i| (Owner::Core, rec(ZABBIX_PUSH, &format!("r{i}"), 10 + i, RunStatus::Completed, &[]))).collect();
        let sv = SinkView::default();
        let v = Reader { view: &sv, admin: true };
        let p = Page::parse(&json!({ "limit": 2 })).unwrap();
        let (one, next) = page(runs.clone(), &p, v);
        assert_eq!(one.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(), vec![json!("r4"), json!("r3")]);
        let p2 = Page::parse(&json!({ "limit": 2, "before": next.clone().unwrap() })).unwrap();
        let (two, next2) = page(runs.clone(), &p2, v);
        assert_eq!(two.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(), vec![json!("r2"), json!("r1")]);
        let (three, end) = page(runs.clone(), &Page::parse(&json!({ "limit": 2, "before": next2.unwrap() })).unwrap(), v);
        assert_eq!(three.len(), 1);
        assert_eq!(end, None, "the last page has no next");
        assert!(Page::parse(&json!({ "before": "nope" })).is_err());
        assert!(Page::parse(&json!({ "jobId": "no.such.job" })).is_err());
        assert_eq!(Page::parse(&json!({ "limit": 100000 })).unwrap().limit, LIST_LIMIT_MAX);
        let (only, _) = page(runs, &Page::parse(&json!({ "jobId": HOUSEKEEPING })).unwrap(), v);
        assert!(only.is_empty());
    }

    #[test]
    fn a_report_job_maps_to_a_run_without_a_copy() {
        use crate::report::jobs::{Format, Job, Kind};
        let p = crate::report::period::month_so_far(chrono::NaiveDate::from_ymd_opt(2026, 11, 9).unwrap());
        let mut j = Job::new(Kind::Mailed, vec!["a".into(), "b".into()], "2 clusters".into(), p, Format::Xlsx, true, crate::report::SCHEDULE_BY, 5);
        j.id = "abc".into();
        j.report = ReportKind::Hosts;
        let q = from_report_job(&j);
        assert_eq!((q.id.as_str(), q.job_id.as_str(), q.trigger.clone(), q.status), ("report-abc", MAILED_HOSTS, Trigger::Timer, RunStatus::Queued));
        assert_eq!((q.done, q.total), (None, None), "a queued job's progress is not known");
        j.status = ReportStatus::Running;
        j.progress.done = 1;
        j.progress.total = 4;
        let r = from_report_job(&j);
        assert_eq!(progress_pct(r.done, r.total), Some(25));
        j.kind = Kind::Cluster;
        j.by = "Admin".into();
        j.status = ReportStatus::Stopped;
        j.stopped_by = Some("root".into());
        let s = from_report_job(&j);
        assert_eq!((s.job_id.as_str(), s.trigger.clone(), s.status), (REPORT_RUN, Trigger::manual("Admin"), RunStatus::Cancelled));
        assert_eq!(s.note.as_deref(), Some("stopped by root"));
        assert_eq!(s.clusters, vec!["a", "b"]);

        // A job from before `clusterIds`: its one `clusterId` is what it covers.
        let sv = SinkView { visible: Some(["a".to_string()].into()) };
        let limited = Reader { view: &sv, admin: false };
        j.cluster_ids = vec![];
        j.cluster_id = "a".into();
        assert_eq!(j.covered(), Some(vec!["a".to_string()]));
        let legacy = from_report_job(&j);
        assert_eq!(legacy.clusters, vec!["a"]);
        assert!(run_view(Owner::Worker, &legacy, limited).is_some(), "they see a");
        j.cluster_id = "b".into();
        assert!(run_view(Owner::Worker, &from_report_job(&j), limited).is_none(), "not b's, which they do not see");
        // No cluster named at all, or `*`: not known — an administrator's who sees every cluster.
        let all = SinkView::default();
        let admin = Reader { view: &all, admin: true };
        let user = Reader { view: &all, admin: false };
        for (ids, one) in [(vec![], ""), (vec!["*".to_string()], "a"), (vec![], "*")] {
            j.cluster_ids = ids;
            j.cluster_id = one.into();
            assert_eq!(j.covered(), None, "{:?} / {one:?}", j.cluster_ids);
            let r = from_report_job(&j);
            assert_eq!(r.clusters, vec!["*"]);
            assert!(run_view(Owner::Worker, &r, admin).is_some());
            assert!(run_view(Owner::Worker, &r, user).is_none(), "a user who sees every cluster still does not read it");
            assert!(run_view(Owner::Worker, &r, limited).is_none());
            // REPORT_JOBS's rule is the same function.
            assert!(!crate::report::jobs::may_read(None, false, j.covered().as_deref()));
            assert!(crate::report::jobs::may_read(None, true, j.covered().as_deref()));
        }
    }

    #[test]
    fn a_reserved_run_is_adopted_by_the_jobs_own_code_not_by_the_timer() {
        let jobs = Jobs::open(None, Role::All, 1);
        let id = jobs.reserve(HOUSEKEEPING, Trigger::manual("Admin"), vec![], RunMeta::default(), 1).unwrap();
        assert_eq!(jobs.reserve(HOUSEKEEPING, Trigger::manual("Bob"), vec![], RunMeta::default(), 2).err(), Some(Busy { run_id: id.clone() }),
                   "a second press is the same run");
        assert!(jobs.begin(HOUSEKEEPING, Trigger::Timer, vec![], 2).is_err(), "the timer does not take a person's run");
        let run = jobs.begin(HOUSEKEEPING, Trigger::manual("Admin"), vec![], 2).unwrap();
        assert_eq!(run.id(), id, "adopted");
        jobs.release(HOUSEKEEPING, &id, "nothing");
        assert_eq!(jobs.running(HOUSEKEEPING), Some(id.clone()), "an adopted run is not released");
        run.end(Outcome::completed(None));
        // Never adopted: released, skipped.
        let id2 = jobs.reserve(HOUSEKEEPING, Trigger::Retry, vec![], RunMeta { retry_of: Some(id.clone()), attempt: 1 }, 3).unwrap();
        jobs.release(HOUSEKEEPING, &id2, "nothing to do");
        let r = jobs.own_runs().into_iter().find(|(_, r)| r.id == id2).unwrap().1;
        assert_eq!((r.status, r.trigger, r.retry_of.as_deref(), r.attempt), (RunStatus::Skipped, Trigger::Retry, Some(id.as_str()), 1));
    }

    #[test]
    fn a_cancel_ask_is_kept_and_a_restart_ends_the_run_cancelled() {
        let d = tmp("cancel");
        {
            let jobs = Jobs::open(Some(&d), Role::Core, 1);
            let run = jobs.begin(LOGDELAY_MEASURE, Trigger::Timer, vec![], 1).unwrap();
            assert!(jobs.cancel(run.id(), "Admin"));
            assert_eq!(run.cancel_asked().as_deref(), Some("Admin"));
            assert_eq!(jobs.cancel_asked(LOGDELAY_MEASURE).as_deref(), Some("Admin"));
            assert!(!jobs.cancel("nope", "Admin"));
            jobs.flush();
            std::mem::forget(run);
        }
        let jobs = Jobs::open(Some(&d), Role::Core, 9);
        let r = jobs.own_runs().into_iter().next().unwrap().1;
        assert_eq!((r.status, r.cancel_asked.as_deref()), (RunStatus::Cancelled, Some("Admin")), "{r:?}");
        // A run that had no safe point left ends as it ended, saying the ask came too late.
        let run = jobs.begin(HOUSEKEEPING, Trigger::Timer, vec![], 10).unwrap();
        jobs.cancel(run.id(), "Bob");
        let id = run.id().to_string();
        run.end(Outcome::completed(None));
        let r = jobs.own_runs().into_iter().find(|(_, r)| r.id == id).unwrap().1;
        assert_eq!(r.status, RunStatus::Completed);
        assert!(r.note.unwrap().contains("cancel asked by Bob"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn retry_keeps_to_the_limit_and_the_wait() {
        let p = controls::Overall::default();
        assert!(retry_refusal(0, Some(1_000), &p, 1_000 + 5 * 60_000).is_none(), "five minutes on: may");
        let w = retry_refusal(0, Some(1_000), &p, 2_000).unwrap();
        assert_eq!((w["kind"].clone(), w["retryAt"].clone()), (json!("retry_wait"), json!(1_000 + 5 * 60_000)));
        assert_eq!(retry_refusal(3, Some(0), &p, u64::MAX).unwrap()["kind"], json!("retry_limit"));
        assert!(retry_refusal(2, None, &p, 0).is_none(), "no end time: no wait to keep");
    }

    #[test]
    fn a_busy_wait_is_one_record_however_many_ticks() {
        let jobs = Jobs::open(None, Role::Worker, 1);
        let b = load::Busy { cluster: "a".into(), signal: "429".into(), reason: "the cluster answered 429".into(), since: Some(5) };
        let one = jobs.defer(VOLUME_DAILY, Trigger::Timer, &b, 10).unwrap();
        assert_eq!(jobs.defer(VOLUME_DAILY, Trigger::Timer, &b, 70).unwrap(), one, "the same wait");
        jobs.eased(VOLUME_DAILY, "a");
        assert_ne!(jobs.defer(VOLUME_DAILY, Trigger::Timer, &b, 130).unwrap(), one, "a new wait");
        let runs = jobs.own_runs();
        assert_eq!(runs.len(), 2);
        let r = &runs[0].1;
        assert_eq!((r.status, r.deferred.as_ref().map(|d| d.cluster.as_str()), r.clusters.clone()), (RunStatus::Deferred, Some("a"), vec!["a".to_string()]));
        assert!(jobs.defer(HOUSEKEEPING, Trigger::Timer, &b, 1).is_none(), "not this process's job to record");
    }

    #[test]
    fn the_hosts_tries_survive_a_restart() {
        let d = tmp("tries");
        let mut t: HostsTries = HashMap::new();
        t.insert("a".into(), ("2026-11-10".into(), 3, 99));
        t.insert("old".into(), ("2026-11-09".into(), 3, 1));
        save_hosts_tries(&d, &t, "2026-11-10").unwrap();
        let back = load_hosts_tries(&d);
        assert_eq!(back.get("a"), Some(&("2026-11-10".to_string(), 3, 99)));
        assert!(!back.contains_key("old"), "yesterday's tries are not kept");
        assert!(load_hosts_tries(&d.join("nothing-here")).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
