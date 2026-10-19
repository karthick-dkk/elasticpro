//! Housekeeping: one scheduler that cleans what ElasticPro itself leaves behind.
//!
//! The core writes cache files, Redis keys, sessions, API tokens and rotated logs, and holds
//! maps that grow with every cluster, person and minute. Until now most of it was kept
//! forever: on-demand cache files were all reloaded at every start, a Zabbix frame made a
//! session per page load that nothing ever ended, an expired API token stayed in its file.
//! This module is the one place that tidies all of it, on one timer, with one status.
//!
//! What it will touch, and nothing else:
//!
//! * files **this core writes** under its data dir, matched by **exact name pattern** — the
//!   fleet cache's `cache/<escaped cluster>/<dataset>.json[.gz]` and its `*.tmp`, the
//!   activity log's `<log>.<n>` rotations. Symlinks are never followed or deleted;
//! * Redis keys of the shape `elasticpro:ds:<cluster>:<dataset>` — the prefix is checked, and
//!   so is the dataset name;
//! * sessions, API tokens, notifications and silences by their own stores' rules;
//! * in-memory maps.
//!
//! What it only **reports**, never deletes: config history, uploaded keys, saved queries,
//! users and the config files. They are the operators' and the users' own.
//!
//! Every deletion is logged (target `audit`, so it survives `LOG_LEVEL=error`), and a dry
//! run — `ELASTICPRO_HOUSEKEEPING_DRY_RUN`, or `HOUSEKEEPING_RUN {dryRun:true}` — lists
//! what would go and removes nothing. A job that fails reports its error and the others
//! still run. Like the delay sink and the poller it is started explicitly
//! (`Core::start_housekeeping`), never by `Core::new`, so tests and embedders do not get a
//! timer they did not ask for.

use crate::activity::ActivityEvent;
use crate::auth::{Caller, Role, SessionPolicy};
use crate::bridge::Core;
use crate::fleet::catalogue::{Class, Dataset};
use crate::fleet::store::{escape, unescape};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The first run, after the start: the poller and the Zabbix sync have settled by then, so
/// "which clusters exist" is an answer rather than a guess.
pub const FIRST_RUN_DELAY_MS: u64 = 5 * 60_000;
/// How often the timer looks at the clock.
pub const TICK: Duration = Duration::from_secs(30);
const DAY_MS: u64 = 86_400_000;

pub const DEFAULT_MINUTES: u64 = 60;
pub const DEFAULT_CACHE_DAYS: u64 = 2;
/// Background datasets are refreshed all the time; one untouched for this long belongs to a
/// cluster that has been unreachable for a week.
pub const BACKGROUND_CACHE_DAYS: u64 = 7;
/// A `*.tmp` the cache writer was part-way through: no write takes an hour.
pub const TMP_MAX_AGE_MS: u64 = 3_600_000;
/// A Zabbix-frame session unused this long is ended.
pub const FRAME_IDLE_SECS: u64 = 24 * 3600;
/// Sessions one account may hold.
pub const SESSION_CAP: usize = 50;
/// A session used within this long is somebody at the keyboard.
pub const SESSION_ACTIVE_SECS: u64 = 600;
/// An API token is deleted this long after it expired. (It is refused from the moment it
/// expires; this is only so the list does not grow.)
pub const TOKEN_GRACE_SECS: u64 = 30 * 86_400;
/// The notification and silence prunes run once a day, however often the timer fires.
pub const DAILY_EVERY_MS: u64 = DAY_MS - 5 * 60_000;

/* ----------------------------------- settings ----------------------------------- */

/// What the operator set. Read from the environment once, at start (`config.txt` has put its
/// managed values there by then — see `settings.rs`).
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Minutes between runs; 0 turns the timer off (Run now still works).
    pub minutes: u64,
    /// Days an on-demand cache file may sit untouched.
    pub cache_days: u64,
    /// Report what would go and delete nothing.
    pub dry_run: bool,
    /// Days a session may sit unused before it ends; 0 = never (Zabbix-frame sessions are
    /// the exception: they end after a day regardless).
    pub session_idle_days: u64,
    /// Days a rotated activity log is kept; 0 = by size rotation only.
    pub activity_keep_days: u64,
}

impl Default for Config {
    fn default() -> Config {
        Config { minutes: DEFAULT_MINUTES, cache_days: DEFAULT_CACHE_DAYS, dry_run: false, session_idle_days: 0, activity_keep_days: 0 }
    }
}

impl Config {
    pub fn from_env() -> Config {
        Config::from_lookup(|k| std::env::var(k).ok())
    }

    /// `from_env` over any source of variables, so the parsing is testable without touching
    /// the process's environment.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Config {
        let d = Config::default();
        let num = |k: &str, default: u64, lo: u64, hi: u64| -> u64 {
            get(k).and_then(|v| v.trim().parse::<u64>().ok()).filter(|n| (lo..=hi).contains(n)).unwrap_or(default)
        };
        Config {
            minutes: num("ELASTICPRO_HOUSEKEEPING_MINUTES", d.minutes, 0, 10_080),
            cache_days: num("ELASTICPRO_HOUSEKEEPING_CACHE_DAYS", d.cache_days, 1, 3650),
            dry_run: get("ELASTICPRO_HOUSEKEEPING_DRY_RUN")
                .is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")),
            session_idle_days: num("ELASTICPRO_SESSION_IDLE_DAYS", d.session_idle_days, 0, 3650),
            activity_keep_days: num("ELASTICPRO_ACTIVITY_LOG_KEEP_DAYS", d.activity_keep_days, 0, 3650),
        }
    }
}

/* ---------------------------------- the schedule ---------------------------------- */

/// When the next run is due, `minutes` after `now`; none when the timer is off.
pub fn next_after(now: u64, minutes: u64) -> Option<u64> {
    (minutes > 0).then(|| now + minutes * 60_000)
}

/// Whether the daily jobs (notification and silence retention) are due: never run, or last
/// run a day ago (five minutes of slack, so an hourly timer does not drift a day to 25 h).
pub fn daily_due(now: u64, last: Option<u64>) -> bool {
    last.is_none_or(|l| now.saturating_sub(l) >= DAILY_EVERY_MS)
}

fn system_time(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    Schedule,
    Manual,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Schedule => "schedule",
            Trigger::Manual => "manual",
        }
    }
}

/* ----------------------------------- the report ----------------------------------- */

/// What one job did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobReport {
    pub id: &'static str,
    pub label: &'static str,
    /// False when the job failed; it says why in `error`.
    pub ok: bool,
    /// Why the job did not run at all (nothing to do, or not safe to).
    pub skipped: Option<String>,
    /// Things removed — or, on a dry run, that would be.
    pub items: u64,
    pub bytes: u64,
    pub error: Option<String>,
    pub notes: Vec<String>,
}

impl JobReport {
    fn new(id: &'static str, label: &'static str) -> JobReport {
        JobReport { id, label, ok: true, skipped: None, items: 0, bytes: 0, error: None, notes: vec![] }
    }
    fn skip(id: &'static str, label: &'static str, why: impl Into<String>) -> JobReport {
        JobReport { skipped: Some(why.into()), ..JobReport::new(id, label) }
    }
    fn fail(id: &'static str, label: &'static str, why: impl Into<String>) -> JobReport {
        JobReport { ok: false, error: Some(why.into()), ..JobReport::new(id, label) }
    }
}

/// Something that is looked at and never deleted.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportOnly {
    pub id: &'static str,
    pub label: &'static str,
    pub files: u64,
    pub bytes: u64,
    pub oldest_age_days: Option<u64>,
    pub note: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub started_at: u64,
    pub finished_at: u64,
    pub trigger: &'static str,
    /// Who pressed Run now; none for the timer.
    pub by: Option<String>,
    pub dry_run: bool,
    pub items: u64,
    pub bytes: u64,
    pub errors: u64,
    pub jobs: Vec<JobReport>,
    pub report_only: Vec<ReportOnly>,
}

impl RunReport {
    fn summary(&self) -> Value {
        json!({ "startedAt": self.started_at, "trigger": self.trigger, "dryRun": self.dry_run,
                "items": self.items, "bytes": self.bytes, "errors": self.errors })
    }
}

/// What asks for a run.
#[derive(Clone, Debug)]
pub struct RunRequest {
    pub trigger: Trigger,
    /// Dry run for this run only; the configured switch can force one on, never off.
    pub dry_run: bool,
    /// The administrator who pressed Run now.
    pub by: Option<Caller>,
    /// Their session token: the one session a run never ends.
    pub protect_session: Option<String>,
    /// Unix milliseconds.
    pub now: u64,
}

impl RunRequest {
    pub fn schedule(now: u64) -> RunRequest {
        RunRequest { trigger: Trigger::Schedule, dry_run: false, by: None, protect_session: None, now }
    }
}

/* ---------------------------------- the scheduler ---------------------------------- */

struct State {
    next_run_at: Option<u64>,
    last: Option<RunReport>,
    recent: VecDeque<Value>,
    last_daily_at: Option<u64>,
}

/// The settings, the clock and the last result. Owned by `Core`.
pub struct Housekeeping {
    cfg: RwLock<Config>,
    st: Mutex<State>,
    running: AtomicBool,
    started: AtomicBool,
}

const RECENT_KEPT: usize = 10;

impl Housekeeping {
    pub fn new(cfg: Config) -> Housekeeping {
        Housekeeping {
            cfg: RwLock::new(cfg),
            st: Mutex::new(State { next_run_at: None, last: None, recent: VecDeque::new(), last_daily_at: None }),
            running: AtomicBool::new(false),
            started: AtomicBool::new(false),
        }
    }

    pub fn from_env() -> Housekeeping {
        Housekeeping::new(Config::from_env())
    }

    pub fn config(&self) -> Config {
        self.cfg.read().clone()
    }

    pub fn set_config(&self, cfg: Config) {
        *self.cfg.write() = cfg;
    }

    /// Schedule the first run, `FIRST_RUN_DELAY_MS` after `now`; none when the timer is off.
    /// Returns whether it is armed.
    pub fn arm(&self, now: u64) -> bool {
        let at = (self.cfg.read().minutes > 0).then(|| now + FIRST_RUN_DELAY_MS);
        self.st.lock().next_run_at = at;
        at.is_some()
    }

    pub fn next_run_at(&self) -> Option<u64> {
        self.st.lock().next_run_at
    }

    /// Whether the timer says run now. Pure over the clock it is given.
    pub fn due(&self, now: u64) -> bool {
        self.cfg.read().minutes > 0
            && !self.running.load(Ordering::SeqCst)
            && self.st.lock().next_run_at.is_some_and(|t| now >= t)
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn last_run(&self) -> Option<RunReport> {
        self.st.lock().last.clone()
    }

    /// The status the Request Centre shows.
    pub fn status(&self, now: u64) -> Value {
        let cfg = self.config();
        let st = self.st.lock();
        json!({
            "ok": true,
            "now": now,
            "enabled": cfg.minutes > 0,
            "minutes": cfg.minutes,
            "dryRun": cfg.dry_run,
            "cacheDays": cfg.cache_days,
            "backgroundCacheDays": BACKGROUND_CACHE_DAYS,
            "sessionIdleDays": cfg.session_idle_days,
            "activityKeepDays": cfg.activity_keep_days,
            "running": self.running.load(Ordering::SeqCst),
            "nextRunAt": if cfg.minutes > 0 { st.next_run_at } else { None },
            "lastRun": st.last,
            "recent": st.recent,
        })
    }

    fn begin(&self) -> Option<RunGuard<'_>> {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| RunGuard(self))
    }
}

/// Clears `running` however the run ends, a panic included.
struct RunGuard<'a>(&'a Housekeeping);

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}

/// What the stores housekeeping tidies are, borrowed from `Core` (whose fields are private
/// to `bridge.rs`).
pub(crate) struct Stores<'a> {
    pub tokens: &'a crate::auth::TokenStore,
    pub notify: &'a crate::notify::NotifyStore,
    pub silences: &'a crate::silences::Silences,
    pub activity: &'a crate::activity::ActivityLog,
}

/* ------------------------------- the deletion log ------------------------------- */

/// One line per thing removed (or that would be). Target `audit`: that target stays on
/// whatever `LOG_LEVEL` says, and "what did it delete" is exactly what it is for. The field
/// is `what`, not `user`: these lines are not somebody's action.
fn log_removed(job: &str, what: &str, detail: &str, bytes: u64, dry_run: bool) {
    if dry_run {
        tracing::info!(target: "audit", job, what, detail, bytes, dry_run, "housekeeping: would remove");
    } else {
        tracing::info!(target: "audit", job, what, detail, bytes, dry_run, "housekeeping: removed");
    }
}

/* ---------------------------------- fleet cache ---------------------------------- */

/// How old a cache file may be before it goes.
#[derive(Clone, Debug)]
pub struct CachePolicy {
    pub on_demand_max: Duration,
    pub background_max: Duration,
    pub tmp_max: Duration,
}

impl CachePolicy {
    pub fn new(cache_days: u64) -> CachePolicy {
        CachePolicy {
            on_demand_max: Duration::from_secs(cache_days * 86_400),
            background_max: Duration::from_secs(BACKGROUND_CACHE_DAYS * 86_400),
            tmp_max: Duration::from_millis(TMP_MAX_AGE_MS),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Removed {
    pub path: PathBuf,
    pub bytes: u64,
    pub why: String,
}

#[derive(Debug, Default)]
pub struct CacheSweep {
    /// Files removed (or that would be).
    pub removed: Vec<Removed>,
    /// Empty cluster folders removed (or that would be).
    pub folders: Vec<PathBuf>,
    /// Entries left alone because they are not something the cache writer makes.
    pub foreign: usize,
    pub errors: Vec<String>,
}

enum Kind {
    Cache(Dataset),
    Tmp,
}

/// Whether `name` is exactly a name the cache writer makes: `<dataset>.json`,
/// `<dataset>.json.gz`, or the temp file it renames from (`<dataset>.tmp` /
/// `<dataset>.json.tmp`, from `with_extension("tmp")`). A dataset is one of the nine this
/// build knows; anything else — a stray `notes.json`, a `health.json.bak` — is not ours.
fn classify(name: &str) -> Option<Kind> {
    if let Some(stem) = name.strip_suffix(".json.gz").or_else(|| name.strip_suffix(".json")) {
        return Dataset::parse(stem).map(Kind::Cache);
    }
    if let Some(stem) = name.strip_suffix(".json.tmp").or_else(|| name.strip_suffix(".tmp")) {
        return Dataset::parse(stem).map(|_| Kind::Tmp);
    }
    None
}

/// Sweep the fleet cache folder `root` (`data_dir/cache`).
///
/// * A folder whose name is the canonical escape of a cluster id that is not in `known` is
///   emptied of cache files and, if nothing else is in it, removed. Skipped altogether when
///   `known` is `None` (the cluster list is not settled), and for any folder whose name is
///   not what `DiskStore` would have made.
/// * In a known cluster's folder: an on-demand dataset file untouched for `on_demand_max`, a
///   background one untouched for `background_max`, a `*.tmp` older than `tmp_max`.
/// * Symlinks — folder or file — are never followed, read or deleted.
/// * Everything else is left, and counted in `foreign`.
///
/// Age is the file's modification time against `now`. With `dry_run` nothing is changed.
pub fn sweep_cache_dir(root: &Path, known: Option<&HashSet<String>>, policy: &CachePolicy, now: SystemTime, dry_run: bool) -> CacheSweep {
    let mut out = CacheSweep::default();
    let rd = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out,
        Err(e) => {
            out.errors.push(format!("{}: {e}", root.display()));
            return out;
        }
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for c in entries {
        let name = c.file_name();
        let Some(name) = name.to_str() else { out.foreign += 1; continue };
        let dir = c.path();
        // A real directory only: a symlink (to anywhere) or a stray file is not ours.
        if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_dir()) {
            out.foreign += 1;
            continue;
        }
        // And only a name `DiskStore::file` could have produced.
        let Some(id) = unescape(name).filter(|id| escape(id) == name) else { out.foreign += 1; continue };
        let removed_cluster = known.is_some_and(|k| !k.contains(&id));
        let mut left = 0usize;
        let files = match std::fs::read_dir(&dir) {
            Ok(f) => f,
            Err(e) => {
                out.errors.push(format!("{}: {e}", dir.display()));
                continue;
            }
        };
        let mut files: Vec<_> = files.flatten().collect();
        files.sort_by_key(|e| e.file_name());
        for f in files {
            let fname = f.file_name();
            let path = f.path();
            let (Some(fname), Ok(md)) = (fname.to_str(), std::fs::symlink_metadata(&path)) else { left += 1; out.foreign += 1; continue };
            let Some(kind) = classify(fname).filter(|_| md.file_type().is_file()) else {
                left += 1;
                out.foreign += 1;
                continue;
            };
            let age = md.modified().ok().map(|m| now.duration_since(m).unwrap_or_default());
            let why = if removed_cluster {
                Some("cluster is no longer configured".to_string())
            } else {
                match (&kind, age) {
                    (Kind::Tmp, Some(a)) if a > policy.tmp_max => Some(format!("leftover temp file, {} min old", a.as_secs() / 60)),
                    (Kind::Cache(ds), Some(a)) => {
                        let max = if ds.class() == Class::OnDemand { policy.on_demand_max } else { policy.background_max };
                        (a > max).then(|| format!("{} dataset untouched for {} days (limit {})",
                            if ds.class() == Class::OnDemand { "on-demand" } else { "background" }, a.as_secs() / 86_400, max.as_secs() / 86_400))
                    }
                    _ => None,
                }
            };
            match why {
                Some(why) => {
                    if !dry_run {
                        if let Err(e) = std::fs::remove_file(&path) {
                            out.errors.push(format!("{}: {e}", path.display()));
                            left += 1;
                            continue;
                        }
                    }
                    out.removed.push(Removed { path, bytes: md.len(), why });
                }
                None => left += 1,
            }
        }
        // A removed cluster's folder goes once it holds nothing. `remove_dir` refuses a
        // folder with anything left in it, which is the point: it is never recursive.
        if removed_cluster && left == 0 && (dry_run || std::fs::remove_dir(&dir).is_ok()) {
            out.folders.push(dir);
        }
    }
    out
}

/* ------------------------------- report-only things ------------------------------- */

/// Count the plain files in a folder (not recursive; symlinks are not counted).
fn folder_stats(dir: &Path, now: SystemTime) -> (u64, u64, Option<u64>) {
    let (mut files, mut bytes, mut oldest) = (0u64, 0u64, None::<u64>);
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(md) = std::fs::symlink_metadata(e.path()) else { continue };
        if !md.file_type().is_file() {
            continue;
        }
        files += 1;
        bytes += md.len();
        if let Some(age) = md.modified().ok().and_then(|m| now.duration_since(m).ok()) {
            oldest = Some(oldest.map_or(age.as_secs() / 86_400, |o| o.max(age.as_secs() / 86_400)));
        }
    }
    (files, bytes, oldest)
}

/// What is in the data dir that people made or that configures the core. Looked at, sized,
/// and left alone: nothing in here is ever a candidate for deletion.
pub fn report_only(data_dir: Option<&Path>, now: SystemTime) -> Vec<ReportOnly> {
    let Some(d) = data_dir else { return vec![] };
    let mut out = vec![];
    for (id, label, sub, note) in [
        ("config-history", "Config history", "config-history", "every saved version of the config; trimmed by its own count, never by housekeeping"),
        ("keys", "Uploaded keys", "keys", "private keys people uploaded; only the Config page deletes one"),
    ] {
        let (files, bytes, oldest_age_days) = folder_stats(&d.join(sub), now);
        out.push(ReportOnly { id, label, files, bytes, oldest_age_days, note });
    }
    for (id, label, names, note) in [
        ("saved-queries", "Saved queries", &["saved-queries.json"][..], "people's saved console queries"),
        ("users", "Users", &["users.json"][..], "the accounts"),
        ("config-files", "Config files", &["config_cluster.json", "primed.json", "pins.json", "policy.json", "zabbix-link.json", "delay-sink.json"][..], "what configures the core"),
    ] {
        let (mut files, mut bytes, mut oldest) = (0u64, 0u64, None::<u64>);
        for n in names {
            let Ok(md) = std::fs::symlink_metadata(d.join(n)) else { continue };
            if md.file_type().is_file() {
                files += 1;
                bytes += md.len();
                if let Some(age) = md.modified().ok().and_then(|m| now.duration_since(m).ok()) {
                    oldest = Some(oldest.map_or(age.as_secs() / 86_400, |o| o.max(age.as_secs() / 86_400)));
                }
            }
        }
        out.push(ReportOnly { id, label, files, bytes, oldest_age_days: oldest, note });
    }
    out
}

/* ------------------------------------- jobs ------------------------------------- */

/// Run one job so that a panic in it is a failed job, not a dead run.
fn guarded(id: &'static str, label: &'static str, f: impl FnOnce() -> JobReport) -> JobReport {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| JobReport::fail(id, label, "the job panicked; see the core log"))
}

fn kb(bytes: u64) -> String {
    if bytes >= 1 << 20 { format!("{:.1} MB", bytes as f64 / 1048576.0) } else { format!("{:.1} KB", bytes as f64 / 1024.0) }
}

impl Core {
    /// Start the timer. Called once, inside the runtime, by the bridge binary and by the
    /// desktop shell — never by `Core::new`.
    ///
    /// It looks at the clock every thirty seconds and does nothing unless a run is due, so
    /// there is no task to cancel. Held weakly: it ends with the core.
    pub fn start_housekeeping(self: &Arc<Self>) {
        let cfg = self.housekeeping.config();
        if cfg.minutes == 0 {
            tracing::info!("housekeeping: off (ELASTICPRO_HOUSEKEEPING_MINUTES=0); Run now still works");
            return;
        }
        if self.housekeeping.started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.housekeeping.arm(crate::fleet::now_ms());
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(TICK);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(core) = weak.upgrade() else { break };
                core.housekeeping_tick(crate::fleet::now_ms()).await;
            }
        });
        tracing::info!(target: "audit", every_minutes = cfg.minutes, cache_days = cfg.cache_days, dry_run = cfg.dry_run,
                       session_idle_days = cfg.session_idle_days, activity_keep_days = cfg.activity_keep_days,
                       "housekeeping: timer started; first run in 5 minutes");
    }

    /// Change the settings this core runs housekeeping on. Tests only: in a running core they
    /// come from the environment, once.
    #[doc(hidden)]
    pub fn set_housekeeping_config(&self, cfg: Config) {
        self.housekeeping.set_config(cfg);
    }

    /// Arm the timer as `start_housekeeping` would at `now`, without spawning it. Tests only.
    #[doc(hidden)]
    pub fn housekeeping_arm(&self, now: u64) -> bool {
        self.housekeeping.arm(now)
    }

    /// When the timer will next fire. Tests only.
    #[doc(hidden)]
    pub fn housekeeping_next_run_at(&self) -> Option<u64> {
        self.housekeeping.next_run_at()
    }

    /// One look at the clock: run if the timer says so. Returns the report when it ran.
    #[doc(hidden)]
    pub async fn housekeeping_tick(self: &Arc<Self>, now: u64) -> Option<RunReport> {
        if !self.housekeeping.due(now) {
            return None;
        }
        self.housekeeping_run(RunRequest::schedule(now)).await
    }

    /// Run every job once. `None` when a run is already going.
    pub async fn housekeeping_run(self: &Arc<Self>, req: RunRequest) -> Option<RunReport> {
        let _running = self.housekeeping.begin()?;
        let cfg = self.housekeeping.config();
        let dry = cfg.dry_run || req.dry_run;
        let started_at = req.now;
        let known = self.housekeeping_known_clusters();
        let daily = req.trigger == Trigger::Manual || daily_due(req.now, self.housekeeping.st.lock().last_daily_at);

        // Files and in-process state: blocking work, off the async threads.
        let (disk, rest) = {
            let (a, b) = (self.clone(), self.clone());
            let (k1, k2) = (known.clone(), known.clone());
            let (c1, c2, r2) = (cfg.clone(), cfg.clone(), req.clone());
            let disk = tokio::task::spawn_blocking(move || a.hk_job_fleet_cache(&k1, &c1, req.now, dry));
            let rest = tokio::task::spawn_blocking(move || b.hk_jobs_in_process(&k2, &c2, &r2, dry, daily));
            (disk, rest)
        };
        let disk = disk.await.unwrap_or_else(|_| JobReport::fail("fleet-cache", "Fleet disk cache", "the job did not finish"));
        let redis = self.hk_job_redis(&known, dry).await;
        let mut jobs = vec![disk, redis];
        match rest.await {
            Ok(mut j) => jobs.append(&mut j),
            Err(_) => jobs.push(JobReport::fail("in-process", "Sessions, tokens and memory", "the jobs did not finish")),
        }

        let report_only = {
            let dir = self.data_dir().map(Path::to_path_buf);
            let at = system_time(req.now);
            tokio::task::spawn_blocking(move || report_only(dir.as_deref(), at)).await.unwrap_or_default()
        };
        let finished_at = crate::fleet::now_ms().max(started_at);
        let report = RunReport {
            started_at,
            finished_at,
            trigger: req.trigger.as_str(),
            by: req.by.as_ref().map(|c| c.name.clone()),
            dry_run: dry,
            items: jobs.iter().map(|j| j.items).sum(),
            bytes: jobs.iter().map(|j| j.bytes).sum(),
            errors: jobs.iter().filter(|j| !j.ok).count() as u64,
            jobs,
            report_only,
        };
        {
            let mut st = self.housekeeping.st.lock();
            if daily && !dry {
                st.last_daily_at = Some(req.now);
            }
            if req.trigger == Trigger::Schedule {
                st.next_run_at = next_after(finished_at, cfg.minutes);
            }
            st.recent.push_front(report.summary());
            st.recent.truncate(RECENT_KEPT);
            st.last = Some(report.clone());
        }
        tracing::info!(target: "audit", trigger = report.trigger, dry_run = dry, items = report.items, bytes = report.bytes,
                       errors = report.errors, "housekeeping: run finished");
        self.hk_record_activity(&report, req.by.as_ref());
        Some(report)
    }

    /// The run's one entry in the activity log: a system event, with the counts. The
    /// exchange that asked for a manual run is not recorded a second time (see `POLLS`).
    fn hk_record_activity(&self, r: &RunReport, by: Option<&Caller>) {
        let mut per_job = serde_json::Map::new();
        for j in &r.jobs {
            per_job.insert(j.id.to_string(), json!({ "items": j.items, "bytes": j.bytes, "ok": j.ok }));
        }
        let ev = ActivityEvent {
            action: "housekeeping_run".into(),
            ok: r.errors == 0,
            reason: (r.errors > 0).then(|| format!("{} job(s) failed", r.errors)),
            user: Some(by.map(|c| c.name.clone()).unwrap_or_else(|| "system".into())),
            role: Some(by.map(|c| c.role.as_str().to_string()).unwrap_or_else(|| "system".into())),
            via: r.trigger.to_string(),
            edition: serde_json::to_value(self.edition()).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
            detail: Some(json!({ "dryRun": r.dry_run, "items": r.items, "bytes": r.bytes, "errors": r.errors, "jobs": per_job })),
            ..Default::default()
        };
        self.housekeeping_stores().activity.record(ev);
    }

    fn hk_job_fleet_cache(&self, known: &Result<HashSet<String>, String>, cfg: &Config, now: u64, dry: bool) -> JobReport {
        const ID: &str = "fleet-cache";
        const LABEL: &str = "Fleet disk cache";
        guarded(ID, LABEL, || {
            let Some(root) = self.fleet.disk_store().root() else { return JobReport::skip(ID, LABEL, "this core keeps no data directory") };
            if !root.is_dir() {
                return JobReport::skip(ID, LABEL, "nothing has been cached to disk yet");
            }
            let sweep = sweep_cache_dir(root, known.as_ref().ok(), &CachePolicy::new(cfg.cache_days), system_time(now), dry);
            let mut r = JobReport::new(ID, LABEL);
            for f in &sweep.removed {
                log_removed(ID, "cache file", &format!("{} ({})", f.path.display(), f.why), f.bytes, dry);
                r.bytes += f.bytes;
            }
            for d in &sweep.folders {
                log_removed(ID, "cache folder", &format!("{} (cluster is no longer configured)", d.display()), 0, dry);
            }
            r.items = (sweep.removed.len() + sweep.folders.len()) as u64;
            if let Err(why) = known {
                r.notes.push(format!("cluster folders were not checked: {why}"));
            }
            if sweep.foreign > 0 {
                r.notes.push(format!("left {} entr{} that the cache does not make alone", sweep.foreign, if sweep.foreign == 1 { "y" } else { "ies" }));
            }
            if !sweep.errors.is_empty() {
                r.ok = false;
                r.error = Some(sweep.errors.join("; "));
            }
            r
        })
    }

    #[cfg(feature = "bridge")]
    async fn hk_job_redis(&self, known: &Result<HashSet<String>, String>, dry: bool) -> JobReport {
        const ID: &str = "redis";
        const LABEL: &str = "Redis cache keys";
        let redis = self.fleet.redis_store().clone();
        if !redis.configured() {
            return JobReport::skip(ID, LABEL, "Redis is not configured");
        }
        let keep = match known {
            Ok(k) => k,
            Err(why) => return JobReport::skip(ID, LABEL, format!("not checked: {why}")),
        };
        match tokio::time::timeout(Duration::from_secs(120), redis.sweep_unknown(keep, dry)).await {
            Ok(Ok(sw)) => {
                let mut r = JobReport::new(ID, LABEL);
                for (k, bytes) in &sw.removed {
                    log_removed(ID, "redis key", &format!("{k} (cluster is no longer configured)"), *bytes, dry);
                    r.bytes += bytes;
                }
                r.items = sw.removed.len() as u64;
                r.notes.push(format!("looked at {} elasticpro:ds:* key(s)", sw.scanned));
                r
            }
            Ok(Err(e)) => JobReport::fail(ID, LABEL, e),
            Err(_) => JobReport::fail(ID, LABEL, "redis did not answer in two minutes"),
        }
    }

    #[cfg(not(feature = "bridge"))]
    async fn hk_job_redis(&self, _known: &Result<HashSet<String>, String>, _dry: bool) -> JobReport {
        JobReport::skip("redis", "Redis cache keys", "this build has no Redis client")
    }

    /// Everything that lives in this process or in the data dir's small files.
    fn hk_jobs_in_process(&self, known: &Result<HashSet<String>, String>, cfg: &Config, req: &RunRequest, dry: bool, daily: bool) -> Vec<JobReport> {
        let mut jobs = vec![];
        let now_secs = req.now / 1000;
        let stores = self.housekeeping_stores();

        // Sessions.
        jobs.push(guarded("sessions", "Sessions", || {
            const ID: &str = "sessions";
            const LABEL: &str = "Sessions";
            if !self.edition().uses_accounts() {
                return JobReport::skip(ID, LABEL, "this edition has no accounts and so no sessions");
            }
            let p = SessionPolicy {
                frame_idle_secs: FRAME_IDLE_SECS,
                idle_secs: (cfg.session_idle_days > 0).then(|| cfg.session_idle_days * 86_400),
                max_per_user: SESSION_CAP,
                active_secs: SESSION_ACTIVE_SECS,
            };
            let reaped = self.sessions.reap(now_secs, &p, req.protect_session.as_deref(), dry);
            self.sessions.flush();
            let mut r = JobReport::new(ID, LABEL);
            for s in &reaped {
                log_removed(ID, "session", &format!("{} ({}): {}, unused for {} h", s.user, s.role.as_str(), s.reason, s.idle_secs / 3600), 0, dry);
            }
            r.items = reaped.len() as u64;
            let st = self.sessions.stats();
            r.notes.push(format!("{} session(s) {}, {} of them from the Zabbix frame",
                st.total, if dry { "now" } else { "remain" }, st.frame));
            if cfg.session_idle_days == 0 {
                r.notes.push("ordinary sessions never expire on their own (SESSION_IDLE_DAYS=0)".into());
            }
            r
        }));

        // API tokens.
        jobs.push(guarded("api-tokens", "API tokens", || {
            const ID: &str = "api-tokens";
            const LABEL: &str = "Expired API tokens";
            if !self.edition().uses_api_tokens() {
                return JobReport::skip(ID, LABEL, "this edition has no API tokens");
            }
            match stores.tokens.sweep_expired(now_secs, TOKEN_GRACE_SECS, dry) {
                Ok(gone) => {
                    for t in &gone {
                        log_removed(ID, "api token", &format!("{} (id {}, {}): expired {} days ago",
                            t.name, t.id, t.role.as_str(), now_secs.saturating_sub(t.expires_at.unwrap_or(0)) / 86_400), 0, dry);
                    }
                    JobReport { items: gone.len() as u64, ..JobReport::new(ID, LABEL) }
                }
                Err(e) => JobReport::fail(ID, LABEL, e.to_string()),
            }
        }));

        // In-memory maps.
        jobs.push(guarded("memory", "In-memory bookkeeping", || {
            const ID: &str = "memory";
            const LABEL: &str = "In-memory bookkeeping";
            let mut r = JobReport::new(ID, LABEL);
            for (what, n) in self.housekeep_memory(known.as_ref().ok(), dry) {
                if n > 0 {
                    r.notes.push(format!("{n} {what}"));
                    log_removed(ID, "memory", &format!("{n} {what}"), 0, dry);
                }
                r.items += n as u64;
            }
            if let Err(why) = known {
                r.notes.push(format!("entries of removed clusters were not looked for: {why}"));
            }
            r
        }));

        // The daily ones.
        jobs.push(guarded("notifications", "Notification history", || {
            const ID: &str = "notifications";
            const LABEL: &str = "Notification history";
            if !daily {
                return JobReport::skip(ID, LABEL, "runs once a day");
            }
            let n = stores.notify.prune_now(dry);
            if n > 0 {
                log_removed(ID, "notifications", &format!("{n} record(s) past {} days or over {} a person", stores.notify.days(), crate::notify::MAX_PER_USER), 0, dry);
            }
            JobReport { items: n as u64, ..JobReport::new(ID, LABEL) }
        }));
        jobs.push(guarded("silences", "Ended silences", || {
            const ID: &str = "silences";
            const LABEL: &str = "Ended silences";
            if !daily {
                return JobReport::skip(ID, LABEL, "runs once a day");
            }
            match stores.silences.prune_expired(dry) {
                Ok(n) => {
                    if n > 0 {
                        log_removed(ID, "silences", &format!("{n} silence(s) that had ended"), 0, dry);
                    }
                    JobReport { items: n as u64, ..JobReport::new(ID, LABEL) }
                }
                Err(e) => JobReport::fail(ID, LABEL, e),
            }
        }));

        // The activity log's rotated files.
        jobs.push(guarded("activity-log", "Rotated activity logs", || {
            const ID: &str = "activity-log";
            const LABEL: &str = "Rotated activity logs";
            let Some(path) = stores.activity.path() else { return JobReport::skip(ID, LABEL, "no activity log file") };
            if cfg.activity_keep_days == 0 {
                return JobReport::skip(ID, LABEL, "keeping rotated logs by size only (ACTIVITY_LOG_KEEP_DAYS=0)");
            }
            match crate::activity::prune_rotated(path, cfg.activity_keep_days, system_time(req.now), dry) {
                Ok(gone) => {
                    let mut r = JobReport::new(ID, LABEL);
                    for f in &gone {
                        log_removed(ID, "rotated activity log", &format!("{} (last written {} days ago)", f.path.display(), f.age_days), f.bytes, dry);
                        r.bytes += f.bytes;
                    }
                    r.items = gone.len() as u64;
                    r
                }
                Err(e) => JobReport::fail(ID, LABEL, e.to_string()),
            }
        }));
        jobs
    }

    /// `HOUSEKEEPING_GET` and `HOUSEKEEPING_RUN {dryRun}`. Admin only: the gate says so for
    /// every edition that has roles, and this checks again, because a path to a delete that
    /// relies on one check is one refactor from none.
    pub(crate) async fn housekeeping_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        if self.edition().uses_accounts() && caller.is_none_or(|c| c.role < Role::Admin) {
            return json!({ "ok": false, "kind": "forbidden", "message": "housekeeping is for administrators" });
        }
        let now = crate::fleet::now_ms();
        if t == "HOUSEKEEPING_GET" {
            return self.housekeeping.status(now);
        }
        let req = RunRequest {
            trigger: Trigger::Manual,
            dry_run: msg.get("dryRun").and_then(Value::as_bool).unwrap_or(false),
            by: Some(caller.cloned().unwrap_or(Caller { name: "local".into(), role: Role::Admin, must_change: false, scope: None })),
            protect_session: msg.get("session").and_then(Value::as_str).map(String::from),
            now,
        };
        match self.housekeeping_run(req).await {
            Some(report) => {
                let mut out = self.housekeeping.status(crate::fleet::now_ms());
                out["run"] = serde_json::to_value(&report).unwrap_or(Value::Null);
                out["message"] = json!(format!("{} {} item(s), {}{}", if report.dry_run { "would remove" } else { "removed" },
                    report.items, kb(report.bytes), if report.errors > 0 { format!("; {} job(s) failed", report.errors) } else { String::new() }));
                out
            }
            None => json!({ "ok": false, "kind": "busy", "message": "housekeeping is already running; try again in a moment" }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::catalogue::Dataset;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ep-hk-{tag}-{}-{}", std::process::id(), crate::auth::random_hex(4)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn file(path: &Path, bytes: usize, age: Duration) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![b'x'; bytes]).unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
    }

    const H: Duration = Duration::from_secs(3600);
    const D: Duration = Duration::from_secs(86_400);

    fn keep(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn config_reads_the_five_settings_and_falls_back_on_nonsense() {
        let c = Config::from_lookup(|_| None);
        assert_eq!(c, Config::default());
        assert_eq!((c.minutes, c.cache_days, c.dry_run, c.session_idle_days, c.activity_keep_days), (60, 2, false, 0, 0));
        let env = |k: &str| match k {
            "ELASTICPRO_HOUSEKEEPING_MINUTES" => Some(" 15 ".to_string()),
            "ELASTICPRO_HOUSEKEEPING_CACHE_DAYS" => Some("5".into()),
            "ELASTICPRO_HOUSEKEEPING_DRY_RUN" => Some("TRUE".into()),
            "ELASTICPRO_SESSION_IDLE_DAYS" => Some("30".into()),
            "ELASTICPRO_ACTIVITY_LOG_KEEP_DAYS" => Some("90".into()),
            _ => None,
        };
        let c = Config::from_lookup(env);
        assert_eq!((c.minutes, c.cache_days, c.dry_run, c.session_idle_days, c.activity_keep_days), (15, 5, true, 30, 90));
        // 0 minutes turns the timer off; 0 cache days or words are not a setting.
        let off = Config::from_lookup(|k| (k == "ELASTICPRO_HOUSEKEEPING_MINUTES").then(|| "0".to_string()));
        assert_eq!(off.minutes, 0);
        let bad = Config::from_lookup(|k| match k {
            "ELASTICPRO_HOUSEKEEPING_CACHE_DAYS" => Some("0".into()),
            "ELASTICPRO_HOUSEKEEPING_MINUTES" => Some("soon".into()),
            "ELASTICPRO_HOUSEKEEPING_DRY_RUN" => Some("maybe".into()),
            _ => None,
        });
        assert_eq!(bad, Config::default());
    }

    #[test]
    fn the_schedule_is_arithmetic_on_a_clock_it_is_given() {
        assert_eq!(next_after(1_000, 0), None);
        assert_eq!(next_after(1_000, 60), Some(1_000 + 3_600_000));
        let h = Housekeeping::new(Config::default());
        assert!(!h.due(0), "not armed: not due");
        assert!(h.arm(10_000));
        assert_eq!(h.next_run_at(), Some(10_000 + FIRST_RUN_DELAY_MS), "first run five minutes after start");
        assert!(!h.due(10_000 + FIRST_RUN_DELAY_MS - 1));
        assert!(h.due(10_000 + FIRST_RUN_DELAY_MS));
        // Off: never armed, never due.
        let off = Housekeeping::new(Config { minutes: 0, ..Config::default() });
        assert!(!off.arm(0) && !off.due(u64::MAX));
        // Daily: first time, then not for a day (less five minutes of slack).
        assert!(daily_due(5, None));
        assert!(!daily_due(1_000 + 3_600_000, Some(1_000)));
        assert!(daily_due(1_000 + DAILY_EVERY_MS, Some(1_000)));
    }

    #[test]
    fn only_one_run_at_a_time_and_the_flag_clears_when_it_ends() {
        let h = Housekeeping::new(Config::default());
        let first = h.begin().expect("free");
        assert!(h.running() && h.begin().is_none(), "a second run is refused while one is going");
        assert!(!h.due(u64::MAX), "and the timer waits for it");
        drop(first);
        assert!(!h.running());
        // Even if the run panics: the guard is dropped on unwind.
        let h = Arc::new(h);
        let h2 = h.clone();
        let _ = std::panic::catch_unwind(AssertUnwindSafe(move || {
            let _g = h2.begin().unwrap();
            panic!("a job blew up");
        }));
        assert!(h.begin().is_some(), "a panic does not leave housekeeping stuck on 'running'");
    }

    #[test]
    fn a_panicking_job_is_a_failed_job_not_a_dead_run() {
        let r = guarded("x", "X", || panic!("boom"));
        assert!(!r.ok && r.error.as_deref().is_some_and(|e| e.contains("panicked")));
        assert!(guarded("x", "X", || JobReport::new("x", "X")).ok);
    }

    #[test]
    fn classify_matches_only_the_names_the_cache_writer_makes() {
        for ok in ["health.json", "indices.json.gz", "snapshots_full.json", "shards.json.gz"] {
            assert!(matches!(classify(ok), Some(Kind::Cache(_))), "{ok}");
        }
        for ok in ["health.tmp", "indices.json.tmp"] {
            assert!(matches!(classify(ok), Some(Kind::Tmp)), "{ok}");
        }
        for foreign in ["notes.json", "health.json.bak", "health.txt", "HEALTH.json", ".json", "indices.gz", "health.json.gz.tmp",
                        "health.tmpx", "my-health.json", "health.json~", "tmp", ""] {
            assert!(classify(foreign).is_none(), "{foreign:?} is not a cache file");
        }
    }

    #[test]
    fn unconfigured_cluster_folders_go_and_configured_ones_stay() {
        let root = tmp("folders").join("cache");
        file(&root.join("gone/health.json"), 10, H);
        file(&root.join("gone/indices.json.gz"), 20, H);
        file(&root.join("kept/health.json"), 30, H);
        let sw = sweep_cache_dir(&root, Some(&keep(&["kept"])), &CachePolicy::new(2), SystemTime::now(), false);
        assert_eq!(sw.removed.len(), 2);
        assert_eq!(sw.removed.iter().map(|r| r.bytes).sum::<u64>(), 30);
        assert_eq!(sw.folders.len(), 1);
        assert!(!root.join("gone").exists(), "the empty folder goes with its files");
        assert!(root.join("kept/health.json").exists());
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn nothing_is_pruned_by_cluster_when_the_cluster_list_is_not_known() {
        let root = tmp("unknown").join("cache");
        file(&root.join("c1/health.json"), 10, H);
        let sw = sweep_cache_dir(&root, None, &CachePolicy::new(2), SystemTime::now(), false);
        assert!(sw.removed.is_empty() && sw.folders.is_empty());
        assert!(root.join("c1/health.json").exists(), "an empty list must not read as 'every cluster was removed'");
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn on_demand_files_expire_after_the_configured_days_and_background_after_seven() {
        let root = tmp("age").join("cache");
        let c = root.join("c1");
        file(&c.join("indices.json.gz"), 5, 3 * D); // on-demand, 3 d: over 2
        file(&c.join("shards.json"), 5, D); // on-demand, 1 d: kept
        file(&c.join("snapshots_full.json"), 5, 2 * D + H); // on-demand, just over 2 d
        file(&c.join("nodes.json"), 5, 3 * D); // background, 3 d: kept
        file(&c.join("health.json"), 5, 8 * D); // background, 8 d: over 7
        let sw = sweep_cache_dir(&root, Some(&keep(&["c1"])), &CachePolicy::new(2), SystemTime::now(), false);
        let gone: HashSet<String> = sw.removed.iter().map(|r| r.path.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(gone, ["indices.json.gz", "snapshots_full.json", "health.json"].iter().map(|s| s.to_string()).collect());
        assert!(c.join("shards.json").exists() && c.join("nodes.json").exists());
        assert!(sw.removed.iter().all(|r| !r.why.is_empty()), "each removal says why");
        // The configured days apply: five days keeps what two did not.
        let root2 = tmp("age5").join("cache");
        file(&root2.join("c1/indices.json"), 5, 3 * D);
        let sw = sweep_cache_dir(&root2, Some(&keep(&["c1"])), &CachePolicy::new(5), SystemTime::now(), false);
        assert!(sw.removed.is_empty());
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
        std::fs::remove_dir_all(root2.parent().unwrap()).ok();
    }

    #[test]
    fn stray_tmp_files_go_after_an_hour_not_before() {
        let root = tmp("tmp").join("cache");
        let c = root.join("c1");
        file(&c.join("health.tmp"), 5, 2 * H);
        file(&c.join("indices.json.tmp"), 5, 2 * H);
        file(&c.join("nodes.tmp"), 5, Duration::from_secs(600)); // a write in progress
        file(&c.join("health.json"), 5, Duration::from_secs(60));
        let sw = sweep_cache_dir(&root, Some(&keep(&["c1"])), &CachePolicy::new(2), SystemTime::now(), false);
        assert_eq!(sw.removed.len(), 2);
        assert!(c.join("nodes.tmp").exists() && c.join("health.json").exists());
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn a_dry_run_lists_and_changes_nothing() {
        let root = tmp("dry").join("cache");
        file(&root.join("gone/health.json"), 10, H);
        file(&root.join("c1/indices.json"), 20, 9 * D);
        file(&root.join("c1/health.tmp"), 5, 3 * H);
        let sw = sweep_cache_dir(&root, Some(&keep(&["c1"])), &CachePolicy::new(2), SystemTime::now(), true);
        assert_eq!(sw.removed.len(), 3);
        assert_eq!(sw.folders.len(), 1, "the folder that would go is listed");
        assert!(root.join("gone/health.json").exists() && root.join("c1/indices.json").exists() && root.join("c1/health.tmp").exists());
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn foreign_files_and_folders_are_never_touched() {
        let root = tmp("foreign").join("cache");
        // Inside a removed cluster's folder: its cache file goes, the stranger stays, and so
        // does the folder that still holds it.
        file(&root.join("gone/health.json"), 10, H);
        file(&root.join("gone/README.txt"), 10, 99 * D);
        file(&root.join("gone/health.json.bak"), 10, 99 * D);
        // A folder name DiskStore never writes (not the canonical escape): not ours, even if
        // it holds files that look like cache files.
        file(&root.join("Not Escaped/health.json"), 10, 99 * D);
        file(&root.join("a%2fb/health.json"), 10, 99 * D); // lower-case hex: not what escape() prints
        // A stray file in the cache root.
        file(&root.join("stray.json"), 10, 99 * D);
        // Old, in a known cluster, but not a name the writer makes.
        file(&root.join("c1/notes.json"), 10, 99 * D);
        file(&root.join("c1/snapshots.json.gz.old"), 10, 99 * D);
        let sw = sweep_cache_dir(&root, Some(&keep(&["c1"])), &CachePolicy::new(2), SystemTime::now(), false);
        assert_eq!(sw.removed.len(), 1, "{:?}", sw.removed);
        assert!(!root.join("gone/health.json").exists());
        for kept in ["gone/README.txt", "gone/health.json.bak", "Not Escaped/health.json", "a%2fb/health.json", "stray.json", "c1/notes.json", "c1/snapshots.json.gz.old"] {
            assert!(root.join(kept).exists(), "{kept} must survive");
        }
        assert!(root.join("gone").exists() && sw.folders.is_empty(), "a folder with a stranger in it stays");
        assert!(sw.foreign >= 6);
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed_and_not_deleted() {
        use std::os::unix::fs::symlink;
        let base = tmp("symlink");
        let root = base.join("cache");
        let outside = base.join("outside");
        file(&outside.join("victim.json"), 10, 99 * D);
        file(&outside.join("health.json"), 10, 99 * D);
        std::fs::create_dir_all(root.join("c1")).unwrap();
        // A file symlink with a cache name, old by its target, in a known cluster.
        symlink(outside.join("victim.json"), root.join("c1/indices.json")).unwrap();
        // A symlinked cluster folder for a cluster nobody configured.
        symlink(&outside, root.join("gone")).unwrap();
        // And a symlink to a file inside a removed cluster's real folder.
        file(&root.join("gone2/health.json"), 1, H);
        symlink(outside.join("victim.json"), root.join("gone2/nodes.json")).unwrap();
        let sw = sweep_cache_dir(&root, Some(&keep(&["c1"])), &CachePolicy::new(2), SystemTime::now(), false);
        assert!(outside.join("victim.json").exists() && outside.join("health.json").exists(), "the target of a link is never touched");
        assert!(root.join("c1/indices.json").symlink_metadata().is_ok(), "the link itself stays too");
        assert!(root.join("gone").symlink_metadata().is_ok(), "a symlinked folder is not removed");
        assert!(root.join("gone2").exists(), "a folder that still holds a link stays");
        assert!(!root.join("gone2/health.json").exists(), "its real file went");
        assert_eq!(sw.removed.len(), 1);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_missing_cache_folder_is_nothing_to_do() {
        let root = tmp("missing").join("cache");
        let sw = sweep_cache_dir(&root, Some(&keep(&["c1"])), &CachePolicy::new(2), SystemTime::now(), false);
        assert!(sw.removed.is_empty() && sw.errors.is_empty());
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn every_dataset_the_cache_writes_is_recognised() {
        for ds in crate::fleet::catalogue::ALL {
            for name in [format!("{}.json", ds.name()), format!("{}.json.gz", ds.name()), format!("{}.tmp", ds.name()), format!("{}.json.tmp", ds.name())] {
                assert!(classify(&name).is_some(), "{name}");
            }
        }
        assert!(Dataset::parse("health").is_some());
    }

    #[test]
    fn report_only_counts_and_never_deletes() {
        let d = tmp("report");
        file(&d.join("config-history/100-a.json"), 10, 40 * D);
        file(&d.join("config-history/200-b.json"), 20, D);
        file(&d.join("keys/id_ed25519"), 5, 400 * D);
        file(&d.join("saved-queries.json"), 7, D);
        file(&d.join("users.json"), 9, D);
        file(&d.join("pins.json"), 3, D);
        let r = report_only(Some(&d), SystemTime::now());
        let by = |id: &str| r.iter().find(|x| x.id == id).unwrap().clone();
        assert_eq!((by("config-history").files, by("config-history").bytes, by("config-history").oldest_age_days), (2, 30, Some(40)));
        assert_eq!((by("keys").files, by("keys").oldest_age_days), (1, Some(400)));
        assert_eq!(by("users").files, 1);
        assert_eq!(by("config-files").files, 1);
        assert!(d.join("config-history/100-a.json").exists() && d.join("keys/id_ed25519").exists());
        assert!(report_only(None, SystemTime::now()).is_empty());
        std::fs::remove_dir_all(&d).ok();
    }
}
