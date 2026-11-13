//! The core's half of the indices report and volume by host (docs/REPORT-TYPES.md): their
//! `REPORT_RUN`, their jobs, the daily hosts collection and `HOSTS_QUERY`.
//!
//! What it sends, it sends as the daily volume run does — `Class::Background` through the
//! gate (people's requests and the health poll come first), only reads, never while the
//! emergency stop is on — and as hard as the cluster takes it: a cluster-day's composite
//! collection is split into partitions by index, run side by side under the cluster's
//! adaptive controller (`control::Controller`), slowed by its answers and its search thread
//! pool, and at most `UI_REPORT_CLUSTERS_AT_ONCE` clusters collect at once.
//!
//! Nothing heavy runs on the runtime's workers: page rows, day files and the report files
//! are made on the report's blocking slots (`Core::report_cpu`). Nothing is held whole: a
//! page is appended to its partition's file as it arrives, a checkpoint follows every page,
//! and a day file is renamed into place only when its last page is in.

use super::control::{self, Controller};
use super::hosts::{self, Checkpoint, ClusterHosts, DayEnd, DayHeader, HostsConfig, HostsDir, PageError};
use super::indices;
use super::jobs::{ClusterProgress, FailedCluster, FileRef, Format, Job, Kind, ReportKind, Status};
use super::period;
use super::run::{bad, job_view, now_ms, who, JobEnd};
use super::schedule::ReportSchedule;
use super::{xlsx, zip};
use crate::auth::Caller;
use crate::bridge::Core;
use crate::volume::collect::{self, Indices};
use crate::volume::schedule::{self as vsched, day_key};
use crate::volume::VolumeSettings;
use chrono::{NaiveDate, NaiveDateTime};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::Arc;

/// Asked between pages: `Some(reason)` stops the collection there.
pub(crate) type Stop = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// How long the timer waits before it takes a failed day or cluster up again.
const RETRY_WAIT_MS: i64 = 15 * 60_000;
/// Attempts the timer makes per cluster per local day.
const TICK_ATTEMPTS: u32 = 3;
/// Times a red cluster is put back to the end of a job before it is named not collected.
const RED_TRIES: u32 = 3;

/// The controller's settings (docs/REPORT-TYPES.md "Concurrency").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Concurrency {
    pub start: u32,
    pub max: u32,
    pub target_ms: u64,
}

/// From config.txt, the ceiling under the gate's per-cluster cap less one: one slot of each
/// cluster always stays free for the health poll and for people (`ES_PER_CLUSTER`).
#[cfg(test)]
pub(crate) fn concurrency() -> Concurrency {
    concurrency_for(crate::gate::limits().per_cluster, crate::worker::Role::All)
}

/// The same under a given gate cap. In role `worker` the gate is the worker's own (nobody's
/// clicks and no health poll go through it), so the ceiling may use the whole per-cluster cap;
/// in role `all` it stays one under, as above (docs/WORKER.md).
pub(crate) fn concurrency_for(per_cluster: usize, role: crate::worker::Role) -> Concurrency {
    let s = crate::settings::get();
    let int = |k: &str, d: u64| s.text(k).and_then(|v| v.parse::<u64>().ok()).unwrap_or(d);
    let keep_free = if role == crate::worker::Role::Worker { 0 } else { 1 };
    let room = (per_cluster as u32).saturating_sub(keep_free).max(1);
    let max = (int("UI_REPORT_CONCURRENCY_MAX", control::DEFAULT_MAX as u64) as u32).clamp(1, control::MAX_ALLOWED).min(room);
    let start = (int("UI_REPORT_CONCURRENCY_START", control::DEFAULT_START as u64) as u32).clamp(1, max);
    Concurrency { start, max, target_ms: int("UI_REPORT_PAGE_TARGET_MS", control::DEFAULT_TARGET_MS) }
}

pub(crate) struct HostsOpts {
    /// Collect again the days already held (*Collect again*).
    pub again: bool,
    /// The timer's: a day that failed `MAX_FAILED_TICKS` times waits for a person.
    pub from_tick: bool,
    pub stop: Stop,
    /// The job whose progress this collection reports.
    pub job: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct HostsOutcome {
    pub days_collected: u64,
    pub failed_days: Vec<(String, String)>,
    pub interrupted: Option<String>,
    /// The cluster could not be read at all (`_cat/indices`, `_field_caps`), or answered a page
    /// with something that is not a composite answer.
    pub error: Option<String>,
    /// `error` would be the same on another try (a 200 of the wrong shape): the job does not
    /// try the cluster once more at its end.
    pub permanent: bool,
}

/// Why a cluster was not done in a round of `report_rounds`. `permanent`: another try would
/// get the same answer, so the cluster is not tried once more at the end of the job.
#[derive(Debug)]
pub(crate) struct RoundError {
    pub why: String,
    pub permanent: bool,
}

impl From<String> for RoundError {
    fn from(why: String) -> RoundError {
        RoundError { why, permanent: false }
    }
}

/// A cluster held for a hosts collection: its run flag (one collection per cluster, the
/// daily volume run's included) and one of the clusters-at-once permits.
struct Claim {
    core: Arc<Core>,
    id: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl Drop for Claim {
    fn drop(&mut self) {
        if let Some(r) = self.core.volume.runs.lock().get_mut(&self.id) {
            r.running = false;
        }
        self.core.reports.hosts_running.lock().remove(&self.id);
    }
}

/// A day being collected.
struct Work {
    date: NaiveDate,
    cp: Checkpoint,
    /// Finished, failed or cut at the page bound: its queued pages are dropped.
    dead: bool,
    /// Consecutive failures per partition.
    retries: Vec<u32>,
}

async fn sleep_ms(ms: u64) {
    if ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}

impl Core {
    /// Blocking work (day files, page rows, report files) on the report's own blocking
    /// slots (`REPORT_CPU_SLOTS`): never on a worker of the runtime that serves the pages,
    /// never more than one or two threads however many jobs run.
    pub(crate) async fn report_cpu<R: Send + 'static>(&self, f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
        let _slot = self.reports.cpu.clone().acquire_owned().await.map_err(|_| "the report slots are closed".to_string())?;
        tokio::task::spawn_blocking(f).await.map_err(|e| format!("a report thread failed: {e}"))
    }

    pub(crate) fn hosts_config(&self) -> HostsConfig {
        HostsConfig::from_settings(crate::settings::get(), crate::memory::budget().report_page_bytes())
    }

    /// The waits before a failed page is asked again. Hidden: the tests' way to not wait 42 s.
    #[doc(hidden)]
    pub fn set_report_backoff_for_tests(&self, ms: [u64; 3]) {
        *self.reports.backoff_ms.lock() = ms;
    }

    /// The hosts job watchdog in ms. Hidden: the tests cannot wait the five minutes that
    /// `UI_REPORT_HOSTS_MAX_MINUTES` allows at least.
    #[doc(hidden)]
    pub fn set_report_watchdog_for_tests(&self, ms: u64) {
        *self.reports.watchdog_ms.lock() = Some(ms);
    }

    /// The cluster is red by the health the poller last read (no request of its own).
    pub(crate) fn report_cluster_red(&self, id: &str) -> bool {
        let st = self.fleet.state.lock();
        let Some(body) = st.entries.get(&(id.to_string(), crate::fleet::catalogue::Dataset::Health)).and_then(|e| e.data.clone()) else { return false };
        drop(st);
        serde_json::from_str::<Value>(body.raw().get()).ok()
            .and_then(|v| v.pointer("/health/json/status").and_then(Value::as_str).map(|s| s == "red"))
            .unwrap_or(false)
    }

    fn cluster_progress(&self, job: Option<&str>, id: &str, f: impl FnOnce(&mut ClusterProgress)) {
        let Some(job) = job else { return };
        if let Some(j) = self.reports.queue.lock().get_mut(job) {
            let c = j.progress.clusters.entry(id.to_string()).or_default();
            f(c);
            let c = c.clone();
            j.progress.cluster = Some(id.to_string());
            j.progress.day = c.day;
            j.progress.pages = Some(c.pages);
            j.progress.rows = Some(c.rows);
            j.progress.retries = Some(c.retries);
            j.progress.state = Some(c.state);
            j.progress.partitions = Some(c.partitions);
            j.progress.concurrency = Some(c.concurrency);
            j.progress.halvings = Some(c.halvings);
            j.progress.last_reason = c.last_reason;
        }
    }

    pub(super) fn job_state(&self, job: &str, state: &str) {
        if let Some(j) = self.reports.queue.lock().get_mut(job) {
            j.progress.state = Some(state.to_string());
        }
    }

    async fn wait_permit(&self, stop: &Stop) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        loop {
            if let Ok(p) = self.reports.collecting.clone().try_acquire_owned() {
                return Ok(p);
            }
            if let Some(r) = stop() {
                return Err(r);
            }
            sleep_ms(250).await;
        }
    }

    async fn hosts_claim(self: &Arc<Self>, id: &str, stop: &Stop) -> Result<Claim, String> {
        loop {
            {
                let mut running = self.reports.hosts_running.lock();
                if !running.contains(id) {
                    let mut runs = self.volume.runs.lock();
                    let r = runs.entry(id.to_string()).or_default();
                    if !r.running {
                        r.running = true;
                        r.done = 0;
                        r.total = 0;
                        running.insert(id.to_string());
                        break;
                    }
                }
            }
            if let Some(r) = stop() {
                return Err(r);
            }
            sleep_ms(250).await;
        }
        // Held from here: given back by the guard, whatever way this ends.
        let permit = loop {
            if let Ok(p) = self.reports.collecting.clone().try_acquire_owned() {
                break p;
            }
            if let Some(r) = stop() {
                if let Some(r) = self.volume.runs.lock().get_mut(id) {
                    r.running = false;
                }
                self.reports.hosts_running.lock().remove(id);
                return Err(r);
            }
            sleep_ms(250).await;
        };
        Ok(Claim { core: self.clone(), id: id.to_string(), _permit: permit })
    }

    /// The search thread pool: why the cluster is under pressure, if it is, and the rejected
    /// count to compare with next time.
    async fn hosts_pool_check(self: &Arc<Self>, id: &str, timeout_ms: u64, last: Option<u64>) -> (Option<String>, Option<u64>) {
        let res = self.es_req(hosts::pool_request(id, timeout_ms)).await;
        if res.get("ok").and_then(Value::as_bool) != Some(true) {
            return (None, last);
        }
        let (why, rejected) = control::pool_pressure(res.get("json").unwrap_or(&Value::Null), last);
        // The one per-cluster load view (docs/JOBS.md "Busy clusters") takes every reading.
        self.load.note_pool(id, why.clone(), crate::fleet::now_ms());
        (why, Some(rejected))
    }

    /* ---------------------------------------- collection ---------------------------------------- */

    /// Collect `days` of one cluster's hosts (docs/REPORT-TYPES.md "Collection"): the days
    /// already held are skipped (unless `again`), a day with a checkpoint resumes, every
    /// other day is split into partitions by index, and the pages of every partition of
    /// every day run side by side under the cluster's controller.
    pub(crate) async fn hosts_collect(self: &Arc<Self>, id: String, s: VolumeSettings, days: Vec<NaiveDate>, opts: HostsOpts) -> HostsOutcome {
        let mut out = HostsOutcome::default();
        let job = opts.job.as_deref();
        let Some(store) = self.volume.store.as_ref() else {
            out.error = Some("no data directory".into());
            return out;
        };
        if self.volume_stopped() {
            out.interrupted = Some("the emergency stop is on: nothing was sent".into());
            return out;
        }
        self.cluster_progress(job, &id, |c| c.state = "waiting".into());
        let _claim = match self.hosts_claim(&id, &opts.stop).await {
            Ok(c) => c,
            Err(r) => {
                out.interrupted = Some(r);
                return out;
            }
        };
        let cfg = self.hosts_config();
        let conc = concurrency_for(self.gate.limits().per_cluster, self.role);
        let mut ctl = Controller::new(conc.start, conc.max, conc.target_ms);
        // The job's lane (docs/JOBS.md "Governor"): its allocation caps this cluster's
        // controller, and every page is sent in it (spawned pages carry it along).
        let lane = crate::jobs::governor::current();
        let dir = HostsDir::new(store.root(), &id);
        // What a run cut short left beside held days, and checkpoint writes a kill cut off:
        // gone before anything is written (one collection per cluster holds from here).
        let again_days: HashSet<String> = if opts.again { days.iter().map(|d| day_key(*d)).collect() } else { HashSet::new() };
        let d2 = dir.clone();
        if let Ok(n) = self.report_cpu(move || d2.tidy(|day| again_days.contains(day))).await {
            if n > 0 {
                tracing::info!(cluster = %id, files = n, "volume by host: leftover checkpoint files removed");
            }
        }
        let ind = match Indices::from_settings(&s) {
            Ok(i) => i,
            Err(e) => {
                out.error = Some(e.to_string());
                return out;
            }
        };
        let timeout = cfg.request_timeout_ms;
        let ok = |v: &Value| v.get("ok").and_then(Value::as_bool) == Some(true);
        self.cluster_progress(job, &id, |c| {
            c.state = "collecting".into();
            c.concurrency = ctl.current();
        });

        // The search thread pool first: a cluster already queueing starts slower.
        let (why, mut rejected) = self.hosts_pool_check(&id, timeout, None).await;
        if let Some(w) = why {
            ctl.halve(&w, None, now_ms());
        }
        // Which indices count on which day: the Daily record's rule.
        let mut cat_req = collect::cat_request(&id, &ind);
        cat_req.origin = Some(hosts::ORIGIN.into());
        cat_req.timeout_ms = Some(timeout);
        let cat = self.es_req(cat_req).await;
        let Some(cat_json) = collect::cat_rows(&cat) else {
            out.error = Some(format!("_cat/indices: {}", indices::failure_reason(&cat)));
            return out;
        };
        drop(cat);
        let listing = collect::read_cat(&cat_json, &ind);
        let docs_of: HashMap<String, u64> = cat_json.as_array().into_iter().flatten().filter_map(|r| {
            let n = r.get("index")?.as_str()?.to_string();
            let d = match r.get("docs.count") {
                Some(Value::String(x)) => x.parse().unwrap_or(0),
                Some(Value::Number(x)) => x.as_u64().unwrap_or(0),
                _ => 0,
            };
            Some((n, d))
        }).collect();
        drop(cat_json);
        let time = !listing.time_split.is_empty();
        let fc = self.es_req(hosts::field_caps_request(&id, &ind, &s, &cfg.fields, time, timeout)).await;
        if !ok(&fc) {
            out.error = Some(format!("_field_caps: {}", indices::failure_reason(&fc)));
            return out;
        }
        let fcj = fc.get("json").cloned().unwrap_or(Value::Null);
        drop(fc);
        let resolved = hosts::resolve(&fcj, &s, &cfg.fields);
        let mut day_notes: Vec<String> = vec![];
        let split_names: HashSet<String> = if time {
            match collect::resolve_time_field(&fcj, &s.time_field) {
                Ok(_) => listing.split_open().into_iter().collect(),
                Err(e) => {
                    day_notes.push(format!("indices split by time not counted: {e}"));
                    HashSet::new()
                }
            }
        } else {
            HashSet::new()
        };
        if listing.split_closed() > 0 {
            day_notes.push(format!("{} closed index(es) split by time are not counted", listing.split_closed()));
        }
        drop(fcj);

        // The days: held ones skipped, checkpoints resumed, the rest begun. `taken` is the
        // progress's `days.total` — every day this run takes up: begun, resumed, written empty
        // (no index on it) or failed to begin; a held day it skips is not one. `days.done` is
        // `out.days_collected`, those of them now held. One set for both, so done ≤ total.
        let now = now_ms();
        let mut work: Vec<Work> = vec![];
        let mut taken: u64 = 0;
        for d in days {
            // Stopped: the days begun so far keep their checkpoints (marked below).
            if (opts.stop)().is_some() {
                break;
            }
            let k = day_key(d);
            if !opts.again && dir.held(&k) {
                continue;
            }
            let header = DayHeader { v: 1, day: k.clone(), fields: cfg.fields.clone(), resolved: resolved.clone(), started_at: now };
            let existing = if opts.again { None } else { dir.checkpoint(&k) };
            if opts.from_tick && existing.as_ref().is_some_and(|c| !c.resumable(now, RETRY_WAIT_MS)) {
                continue;
            }
            taken += 1;
            let resumed = match existing {
                Some(cp) if cp.header.fields == header.fields && cp.header.resolved == header.resolved => {
                    let (d2, c2) = (dir.clone(), cp.clone());
                    match self.report_cpu(move || d2.resume(&c2)).await {
                        Ok(Ok(())) => Some(cp),
                        _ => None,
                    }
                }
                _ => None,
            };
            let cp = match resumed {
                Some(cp) => cp,
                None => {
                    let dated: Vec<String> = listing.days.get(&d).map(|g| g.index_source.keys().cloned().collect()).unwrap_or_default();
                    let all: Vec<(String, u64)> = dated.iter().chain(split_names.iter())
                        .map(|n| (n.clone(), docs_of.get(n).copied().unwrap_or(0))).collect();
                    let d2 = dir.clone();
                    if all.is_empty() {
                        let mut notes = day_notes.clone();
                        notes.push("no index counts on this day".into());
                        match self.report_cpu(move || d2.write_empty(header, notes, now)).await {
                            Ok(Ok(())) => out.days_collected += 1,
                            Ok(Err(e)) | Err(e) => out.failed_days.push((k, e)),
                        }
                        continue;
                    }
                    let parts = control::partitions(&all, conc.max as usize);
                    match self.report_cpu(move || d2.begin(header, parts, hosts::PAGE_SIZE_MAX, now)).await {
                        Ok(Ok(cp)) => cp,
                        Ok(Err(e)) | Err(e) => {
                            out.failed_days.push((k, e));
                            continue;
                        }
                    }
                }
            };
            let n = cp.parts.len();
            work.push(Work { date: d, cp, dead: false, retries: vec![0; n] });
        }
        let days_collected = out.days_collected;
        self.cluster_progress(job, &id, |c| {
            c.days.total = taken;
            c.days.done = days_collected;
            c.partitions.total = work.iter().map(|w| w.cp.parts.len() as u64).sum();
            c.partitions.done = work.iter().map(|w| w.cp.parts_done() as u64).sum();
        });

        // Every partition of every day, a page at a time, as many in flight as the
        // controller allows. Disk work is done here, one page at a time, on a report slot.
        let mut ready: VecDeque<(usize, usize, u64)> = VecDeque::new();
        for (di, w) in work.iter().enumerate() {
            for (pk, p) in w.cp.parts.iter().enumerate() {
                if !p.done {
                    ready.push_back((di, pk, 0));
                }
            }
            if w.cp.parts.iter().all(|p| p.done) {
                ready.push_back((di, usize::MAX, 0));
            }
        }
        let backoff = *self.reports.backoff_ms.lock();
        let mut set: tokio::task::JoinSet<(usize, usize, Value, u64)> = tokio::task::JoinSet::new();
        let mut stopping: Option<String> = None;
        let mut since_pool = 0u64;
        let mut first_page: HashSet<(usize, usize)> = HashSet::new();
        // The progress's `lastReason`: the controller's last halving, or the last retry's why,
        // whichever came later.
        let (mut last_reason, mut seen_halvings): (Option<String>, u32) = (None, 0);
        loop {
            if stopping.is_none() {
                stopping = (opts.stop)();
            }
            if stopping.is_none() {
                if let Some(l) = &lane {
                    ctl.set_cap(l.limit());
                }
                let limit = ctl.limit(now_ms()) as usize;
                while set.len() < limit {
                    let Some((di, pk, delay)) = ready.pop_front() else { break };
                    let w = &work[di];
                    if w.dead {
                        continue;
                    }
                    if pk == usize::MAX {
                        // A resumed day whose every partition was already in: finish it below.
                        set.spawn(async move { (di, pk, Value::Null, 0) });
                        continue;
                    }
                    let part = &w.cp.parts[pk];
                    let dated: Vec<&str> = part.indices.iter().filter(|n| !split_names.contains(*n)).map(String::as_str).collect();
                    let split: Vec<&str> = part.indices.iter().filter(|n| split_names.contains(*n)).map(String::as_str).collect();
                    let query = collect::day_query(&dated, &split, &s.time_field, w.date);
                    let body = hosts::composite_body(&query, &resolved, part.page_size.max(hosts::PAGE_SIZE_MIN), part.after.as_ref());
                    let req = hosts::page_request(&id, &ind, &body, timeout);
                    let pause = if first_page.insert((di, pk)) { delay } else { delay.max(cfg.page_pause_ms) };
                    let core = self.clone();
                    set.spawn(crate::jobs::governor::within(lane.clone(), async move {
                        sleep_ms(pause).await;
                        let t = std::time::Instant::now();
                        let res = core.es_req(req).await;
                        (di, pk, res, t.elapsed().as_millis() as u64)
                    }));
                }
                if set.is_empty() {
                    if ready.is_empty() {
                        break;
                    }
                    // A Retry-After holds every request: wait it out.
                    let wait = (ctl.hold_until() - now_ms()).clamp(50, 1_000) as u64;
                    sleep_ms(wait).await;
                    continue;
                }
            } else if set.is_empty() {
                break;
            }
            let Some(joined) = set.join_next().await else { break };
            let Ok((di, pk, res, took)) = joined else { continue };
            if work[di].dead {
                continue;
            }
            let now = now_ms();
            let size = if pk == usize::MAX { 0 } else { work[di].cp.parts[pk].page_size.max(hosts::PAGE_SIZE_MIN) };
            let page_ok = pk == usize::MAX || ok(&res);
            let mut failure: Option<String> = None;
            if page_ok && pk != usize::MAX {
                let body_bytes = res.get("bytes").and_then(Value::as_u64).unwrap_or(0);
                let (d2, r2, mut cp) = (dir.clone(), resolved.clone(), std::mem::take(&mut work[di].cp));
                let done = self.report_cpu(move || {
                    let r = hosts::read_page(res.get("json").unwrap_or(&Value::Null), &r2, size).and_then(|p| {
                        let done = p.done;
                        d2.append(&mut cp, pk, &p.rows, p.after, done, now).map(|_| done).map_err(PageError::from)
                    });
                    (cp, r)
                }).await;
                match done {
                    Ok((cp, Ok(_))) => {
                        work[di].cp = cp;
                        work[di].retries[pk] = 0;
                        ctl.page_ok(took, now);
                        let w = &mut work[di];
                        w.cp.parts[pk].page_size = hosts::next_page_size(size, body_bytes, cfg.page_bytes);
                        since_pool += 1;
                    }
                    Ok((cp, Err(PageError::Shape(why)))) => {
                        // A 200 that is not a composite answer: every page of this cluster would
                        // get the same. The cluster fails once, with why; nothing is retried and
                        // the job does not try it again at its end. Checkpoints stay as they were.
                        work[di].cp = cp;
                        set.abort_all();
                        ready.clear();
                        for w in work.iter_mut() {
                            w.dead = true;
                        }
                        out.error = Some(format!("a page answered HTTP 200 but {why}: not asked again"));
                        out.permanent = true;
                        let why = out.error.clone();
                        self.cluster_progress(job, &id, |c| c.last_reason = why);
                        break;
                    }
                    Ok((cp, Err(PageError::Retry(e)))) => {
                        work[di].cp = cp;
                        failure = Some(e);
                    }
                    Err(e) => failure = Some(e),
                }
            } else if !page_ok {
                let w = &mut work[di];
                if res.get("kind").and_then(Value::as_str) == Some("response_too_large") && size > hosts::PAGE_SIZE_MIN {
                    // Too large to read: the same page again, at half the size, not a failure.
                    w.cp.parts[pk].page_size = (size / 2).max(hosts::PAGE_SIZE_MIN);
                    ready.push_front((di, pk, 0));
                    continue;
                }
                if let Some(why) = control::pushback(&res) {
                    ctl.halve(&why, control::retry_after_ms(&res), now);
                    if why == "circuit_breaking_exception" {
                        w.cp.parts[pk].page_size = (size / 2).max(hosts::PAGE_SIZE_MIN);
                    }
                }
                failure = Some(indices::failure_reason(&res));
            }
            if let Some(why) = failure {
                if stopping.is_some() || (opts.stop)().is_some() {
                    continue;
                }
                let w = &mut work[di];
                w.retries[pk] += 1;
                w.cp.retries += 1;
                let n = w.retries[pk];
                if n as usize <= backoff.len() {
                    ready.push_back((di, pk, backoff[n as usize - 1]));
                    // Every retry says why, so a climbing retry count is never without a reason.
                    last_reason = Some(format!("{why} — asked again ({n} of {})", backoff.len()));
                    let reason = last_reason.clone();
                    self.cluster_progress(job, &id, |c| {
                        c.state = "retrying".into();
                        c.retries += 1;
                        c.last_reason = reason;
                    });
                    continue;
                }
                last_reason = Some(why.clone());
                // Still failing after its retries: the day is failed, with why, and kept to
                // be taken up again (the next tick, up to three; or a person's Run now).
                w.dead = true;
                w.cp.failed = Some(why.clone());
                w.cp.failed_at = Some(now);
                w.cp.failed_ticks += 1;
                let (d2, c2) = (dir.clone(), w.cp.clone());
                let _ = self.report_cpu(move || d2.save_checkpoint(&c2)).await;
                out.failed_days.push((day_key(w.date), why));
                continue;
            }
            // Pressure, every so many pages.
            if since_pool >= control::POOL_CHECK_EVERY {
                since_pool = 0;
                let (why, r) = self.hosts_pool_check(&id, timeout, rejected).await;
                rejected = r;
                if let Some(w) = why {
                    ctl.halve(&w, None, now_ms());
                }
            }
            let w = &mut work[di];
            if w.cp.pages() >= cfg.max_pages && !w.cp.finished() {
                w.cp.incomplete = true;
            }
            if w.cp.finished() {
                w.dead = true;
                let mut notes = day_notes.clone();
                if w.cp.incomplete {
                    notes.push(format!("incomplete: the page bound ({} pages, UI_REPORT_HOSTS_MAX_PAGES) was reached at {} rows", cfg.max_pages, w.cp.rows()));
                }
                let end = DayEnd { rows: w.cp.rows(), pages: w.cp.pages(), incomplete: w.cp.incomplete, notes, collected_at: now };
                let (d2, c2) = (dir.clone(), w.cp.clone());
                match self.report_cpu(move || d2.complete(&c2, &end)).await {
                    Ok(Ok(())) => out.days_collected += 1,
                    Ok(Err(e)) | Err(e) => out.failed_days.push((day_key(w.date), e)),
                }
            } else if pk != usize::MAX && !w.cp.parts[pk].done {
                ready.push_back((di, pk, 0));
            }
            let (date, pages, rows) = (day_key(work[di].date), work[di].cp.pages(), work[di].cp.rows());
            if ctl.halvings != seen_halvings {
                // A halving since the last look: the controller's reason is the latest.
                seen_halvings = ctl.halvings;
                last_reason = ctl.last_reason.clone();
            }
            let (cur, halvings, reason) = (ctl.current(), ctl.halvings, last_reason.clone());
            let parts_done: u64 = work.iter().map(|w| w.cp.parts_done() as u64).sum();
            let collected = out.days_collected;
            self.cluster_progress(job, &id, |c| {
                c.state = "collecting".into();
                c.day = Some(date);
                c.pages = pages;
                c.rows = rows;
                c.concurrency = cur;
                c.halvings = halvings;
                if reason.is_some() {
                    // The last reason stays until a newer one: pages going well again do not
                    // erase why the retries count climbed.
                    c.last_reason = reason;
                }
                c.partitions.done = parts_done;
                c.days.done = collected;
            });
        }
        if let Some(why) = stopping {
            // Cut short between pages: every unfinished day keeps its checkpoint, marked so.
            for w in work.iter_mut().filter(|w| !w.dead) {
                w.cp.interrupted = Some(why.clone());
                let (d2, c2) = (dir.clone(), w.cp.clone());
                let _ = self.report_cpu(move || d2.save_checkpoint(&c2)).await;
            }
            out.interrupted = Some(why);
        }
        // Kept `UI_REPORT_HOSTS_KEEP_MONTHS`: older day files go with this cluster's collection.
        let oldest = vsched::oldest_kept_month(vsched::utc_day(now_ms()), cfg.keep_months);
        let d2 = dir.clone();
        let _ = self.report_cpu(move || d2.prune(oldest)).await;
        let state = if out.interrupted.is_some() { "stopped" } else if out.failed_days.is_empty() && out.error.is_none() { "done" } else { "failed" };
        let collected = out.days_collected;
        self.cluster_progress(job, &id, |c| {
            c.state = state.into();
            c.days.done = collected;
        });
        tracing::info!(cluster = %id, days = out.days_collected, failed = out.failed_days.len(), halvings = ctl.halvings,
                       interrupted = out.interrupted.as_deref().unwrap_or(""), "volume by host: collected");
        out
    }

    /// The days a cluster still needs in the month so far, as the timer sees them: not
    /// held, and either never begun or resumable now.
    fn hosts_missing(&self, id: &str, days: &[NaiveDate], now: i64) -> Vec<NaiveDate> {
        let Some(store) = self.volume.store.as_ref() else { return vec![] };
        let dir = HostsDir::new(store.root(), id);
        days.iter().copied().filter(|d| {
            let k = day_key(*d);
            !dir.held(&k) && dir.checkpoint(&k).is_none_or(|c| c.resumable(now, RETRY_WAIT_MS))
        }).collect()
    }

    /// The hosts schedule's clusters have their days (or are unreachable), and none is being
    /// collected: what a daily hosts mail waits for.
    pub(super) fn hosts_collected(&self, s: &ReportSchedule, local: NaiveDateTime) -> bool {
        if vsched::parse_hhmm(&s.at).is_some_and(|at| local.time() < at) {
            return false;
        }
        let today = vsched::utc_day(now_ms());
        let days = period::month_so_far(today).days();
        let now = now_ms();
        self.report_schedule_clusters(s).iter().all(|id| {
            self.volume_unreachable(id)
                || (!self.reports.hosts_running.lock().contains(id) && self.hosts_missing(id, &days, now).is_empty())
        })
    }

    /// When the daily hosts collection starts: the hosts schedule's `at` (`UI_REPORT_HOSTS_AT`),
    /// 06:00 when it says nothing readable.
    fn hosts_at(&self) -> chrono::NaiveTime {
        let (sched, _) = self.report_schedule_effective(ReportKind::Hosts);
        vsched::parse_hhmm(&sched.at).unwrap_or_else(|| chrono::NaiveTime::from_hms_opt(6, 0, 0).unwrap_or_default())
    }

    /// When the daily hosts collection next starts, epoch ms: today's `at` if it has not come
    /// yet, else tomorrow's (after it, a cluster still missing days is tried each minute, at
    /// most three times a day). `None` off hosted.
    pub(crate) fn hosts_next_at(&self) -> Option<i64> {
        if !self.edition().schedules() {
            return None;
        }
        let at = self.hosts_at();
        let local = vsched::local_now();
        let begun_today = (local.time() >= at).then_some(local.date());
        vsched::local_to_ms(vsched::next_run(local, at, begun_today))
    }

    /// One tick of the daily hosts collection at the given server local time: from the hosts
    /// schedule's `at` (`UI_REPORT_HOSTS_AT`, 06:00) on, every cluster that is missing days
    /// of the month so far — never held, interrupted, or failed fewer than three times — is
    /// collected, unless it is unreachable, red, already collecting, or was tried in the
    /// last 15 minutes (three tries a day at most). Whether or not the hosts mail is on.
    /// Returns the clusters started. Public for the tests.
    #[doc(hidden)]
    pub async fn hosts_tick_at(self: &Arc<Self>, local: NaiveDateTime) -> Vec<String> {
        if self.volume.store.is_none() || self.reports.data_dir().is_none() || self.volume_stopped()
            || self.jobs.held(crate::jobs::HOSTS_COLLECT).is_some()
        {
            return vec![];
        }
        // Most jobs at once (docs/JOBS.md "Governor"): no new run while the worker runs as many
        // as `mostAtOnce` allows; the next tick tries again. A run already open takes more in.
        if !self.governor_room(crate::jobs::HOSTS_COLLECT) {
            return vec![];
        }
        let at = self.hosts_at();
        if local.time() < at {
            return vec![];
        }
        let raw = match self.volume_config().await {
            Ok(raw) => raw,
            Err(_) => return vec![],
        };
        let today = vsched::utc_day(now_ms());
        let days = period::month_so_far(today).days();
        let local_day = day_key(local.date());
        let now = now_ms();
        let mut specs = self.all_specs();
        specs.sort_by(|a, b| a.id.cmp(&b.id));
        let mut started = vec![];
        for spec in specs {
            let id = spec.id;
            if self.reports.hosts_running.lock().contains(&id) || self.volume_unreachable(&id) || self.report_cluster_red(&id) {
                continue;
            }
            // Busy (docs/JOBS.md "Busy clusters"): no try is spent; one deferred run says why,
            // and the first tick after it eases collects it. The other clusters carry on.
            if let Some(b) = self.cluster_busy(&id) {
                self.jobs.defer(crate::jobs::HOSTS_COLLECT, crate::jobs::Trigger::Timer, &b, crate::fleet::now_ms());
                continue;
            }
            self.jobs.eased(crate::jobs::HOSTS_COLLECT, &id);
            {
                let attempts = self.reports.hosts_attempts.lock();
                if let Some((day, n, last)) = attempts.get(&id) {
                    if *day == local_day && (*n >= TICK_ATTEMPTS || now - *last < RETRY_WAIT_MS) {
                        continue;
                    }
                }
            }
            let missing = self.hosts_missing(&id, &days, now);
            if missing.is_empty() {
                continue;
            }
            {
                let mut attempts = self.reports.hosts_attempts.lock();
                let e = attempts.entry(id.clone()).or_insert((local_day.clone(), 0, now));
                if e.0 != local_day {
                    *e = (local_day.clone(), 0, now);
                }
                e.1 += 1;
                e.2 = now;
                // On disk too, so a restart does not hand the cluster three more tries today.
                if let Some(d) = self.reports.data_dir() {
                    if let Err(err) = crate::jobs::save_hosts_tries(d, &attempts, &local_day) {
                        tracing::warn!(error = %err, "volume by host: the day's tries could not be written");
                    }
                }
            }
            let s = self.volume_resolve(raw.as_ref(), Some(&id), None).settings;
            self.hosts_start(id.clone(), s, missing, true, crate::jobs::Trigger::Timer, crate::jobs::RunMeta::default());
            started.push(id);
        }
        if !started.is_empty() {
            tracing::info!(clusters = started.len(), "volume by host: the daily collection started");
        }
        started
    }

    /// Collect one cluster's missing days in the background, as a part of the hosts
    /// collection's run (docs/JOBS.md): one run for the clusters started while some still
    /// collect. Stops at its safe points for the emergency stop and for `JOB_CANCEL`.
    fn hosts_start(self: &Arc<Self>, id: String, s: VolumeSettings, missing: Vec<NaiveDate>, from_tick: bool,
                   trigger: crate::jobs::Trigger, meta: crate::jobs::RunMeta) -> String {
        let core = self.clone();
        let stop_core = self.clone();
        let stop: Stop = Arc::new(move || stop_core.volume_stopped().then(|| "the emergency stop came on".to_string())
            .or_else(|| stop_core.jobs.cancel_asked(crate::jobs::HOSTS_COLLECT).map(|by| format!("cancelled by {by}"))));
        let part = self.jobs.join_with(crate::jobs::HOSTS_COLLECT, trigger, &id, crate::fleet::now_ms(), meta);
        let run_id = part.id().to_string();
        tokio::spawn(async move {
            let cid = id.clone();
            // The run's lane: every cluster the run collects shares its allocation.
            let out = core.governed(part.id(), crate::jobs::HOSTS_COLLECT,
                                    core.hosts_collect(cid, s, missing, HostsOpts { again: false, from_tick, stop, job: None })).await;
            use crate::jobs::Outcome;
            let days = Some(out.days_collected);
            let busy = out.error.is_some().then(|| core.cluster_busy(&id)).flatten();
            let outcome = if let (Some(by), Some(_)) = (part.cancel_asked(), &out.interrupted) {
                Outcome::cancelled(&by, days)
            } else if let Some(b) = busy {
                core.jobs.mark_waiting(crate::jobs::HOSTS_COLLECT, &id, part.id());
                Outcome::deferred(format!("{id} is busy: {}; tried again when it eases", b.reason), days)
            } else if let Some(e) = out.error {
                Outcome::failed(e, days)
            } else if let Some(why) = out.interrupted {
                Outcome::deferred(why, days)
            } else if let Some((day, why)) = out.failed_days.first() {
                Outcome::failed(format!("{} day(s) failed, first {day}: {why}", out.failed_days.len()), days)
            } else {
                Outcome::completed(days)
            };
            part.end(outcome);
        });
        run_id
    }

    /// `JOB_RUN hosts.collect {clusterIds?}`: the month's missing days of each cluster asked
    /// for (every cluster the caller sees when none is named), now, without spending the
    /// timer's three tries. One already collecting is left be (`already`).
    pub(crate) async fn hosts_run_now(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>, trigger: crate::jobs::Trigger,
                                      meta: crate::jobs::RunMeta) -> Value {
        if self.volume.store.is_none() || self.reports.data_dir().is_none() {
            return bad("not_configured", "no data directory: nothing can be collected");
        }
        if self.volume_stopped() {
            return bad("bad_request", "the emergency stop is on: nothing is collected until it is over");
        }
        let raw = match self.volume_config().await {
            Ok(raw) => raw,
            Err(e) => return bad("io_error", format!("the config file could not be read: {e}")),
        };
        let visible = self.fleet_visible(caller);
        let ids: Vec<String> = match msg.get("clusterIds").and_then(Value::as_array) {
            Some(a) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
            None => visible.clone(),
        };
        let today = vsched::utc_day(now_ms());
        let days = period::month_so_far(today).days();
        let now = now_ms();
        let (mut started, mut already, mut skipped, mut run_id) = (vec![], vec![], vec![], None);
        for id in ids {
            if !visible.contains(&id) {
                skipped.push(json!({ "clusterId": id, "reason": "unknown" }));
            } else if self.reports.hosts_running.lock().contains(&id) {
                already.push(id);
            } else if self.volume_unreachable(&id) {
                skipped.push(json!({ "clusterId": id, "reason": "unreachable" }));
            } else {
                let missing = self.hosts_missing(&id, &days, now);
                if missing.is_empty() {
                    skipped.push(json!({ "clusterId": id, "reason": "nothing missing this month" }));
                    continue;
                }
                let s = self.volume_resolve(raw.as_ref(), Some(&id), None).settings;
                run_id.get_or_insert(self.hosts_start(id.clone(), s, missing, false, trigger.clone(), meta.clone()));
                started.push(id);
            }
        }
        let run_id = run_id.or_else(|| self.jobs.running(crate::jobs::HOSTS_COLLECT));
        json!({ "ok": true, "started": started, "already": already, "skipped": skipped, "runId": run_id })
    }

    /* ------------------------------------------- jobs ------------------------------------------- */

    /// `REPORT_RUN {kind: "indices"|"hosts", clusterIds, period, format, mail, collectAgain}`:
    /// one job for the clusters (one workbook). Hosts: at most `MAX_RUN_CLUSTERS`, refused
    /// whole (`too_many_clusters`). The queue's per-person and mail limits as for volume.
    pub(super) fn report_run_kind(self: &Arc<Self>, kind: ReportKind, ids: Vec<String>, msg: &Value, caller: Option<&Caller>) -> Value {
        let mut unique: Vec<String> = vec![];
        for id in ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        if kind == ReportKind::Hosts && unique.len() > hosts::MAX_RUN_CLUSTERS {
            return bad("too_many_clusters", format!("volume by host runs for at most {} clusters at a time; {} were asked for", hosts::MAX_RUN_CLUSTERS, unique.len()));
        }
        let today = vsched::utc_day(now_ms());
        // The log delay report also takes "lastHour" (its hourly schedule's period).
        let parse = if kind == ReportKind::LogDelay { period::parse_log_delay } else { period::parse };
        let period = match msg.get("period").filter(|v| !v.is_null()) {
            Some(v) => match parse(v, today) {
                Ok(p) => p,
                Err(e) => return bad("bad_request", e),
            },
            None => period::month_so_far(today),
        };
        let fmt = msg.get("format").and_then(Value::as_str).unwrap_or("xlsx");
        let Some(format) = Format::parse(fmt) else { return bad("bad_request", "format must be xlsx or csvzip") };
        let mail = msg.get("mail").and_then(Value::as_bool).unwrap_or(false);
        let again = msg.get("collectAgain").and_then(Value::as_bool).unwrap_or(false);
        let visible = self.fleet_visible(caller);
        let (mut ok_ids, mut refused) = (vec![], vec![]);
        for id in unique {
            if visible.contains(&id) {
                ok_ids.push(id);
            } else {
                refused.push(json!({ "clusterId": id, "reason": "unknown" }));
            }
        }
        if ok_ids.is_empty() {
            return json!({ "ok": true, "jobs": [], "refused": refused });
        }
        let by = who(caller);
        let name = match ok_ids.as_slice() {
            [one] => self.spec_for(one).and_then(|s| s.name).unwrap_or_else(|| one.clone()),
            many => format!("{} clusters", many.len()),
        };
        let mut job = Job::new(Kind::Cluster, ok_ids, name, period.clone(), format, mail, &by, now_ms());
        job.report = kind;
        job.collect_again = again && kind == ReportKind::Hosts;
        if kind == ReportKind::LogDelay {
            // The run's options over the schedule's: what the page chose for this file.
            let s = self.logdelay_settings();
            let extras = self.logdelay_extras_union(&s);
            let (sched, _) = self.report_schedule_effective(kind);
            let base = crate::logdelay::report::Options::default().apply(&sched.options, &extras).unwrap_or_default();
            let opts = match msg.get("options").filter(|o| o.is_object()) {
                Some(o) => match base.apply(o, &extras) { Ok(x) => x, Err(e) => return bad("bad_request", e) },
                None => base,
            };
            job.options = serde_json::to_value(&opts).ok();
        }
        // The same report already queued or running joins it (docs/JOBS.md "Duplicates").
        let queued = self.reports.with(|q| {
            if let Some(same) = q.same_open(&job) {
                return Ok::<(String, bool), (&'static str, String)>((same.id.clone(), true));
            }
            let mailed = if mail { 1 } else { 0 };
            q.room(&by, 1, mailed, now_ms())?;
            q.note_mailed(&by, mailed, now_ms());
            Ok((q.push(job, crate::auth::random_hex(8)), false))
        });
        let (id, joined) = match queued {
            Ok(x) => x,
            Err((k, m)) => return bad(k, m),
        };
        if joined {
            tracing::info!(user = %by, report = kind.as_str(), job = %id, "volume report: joined the same report already queued");
            let q = self.reports.queue.lock();
            return json!({ "ok": true, "joined": true, "runId": format!("report-{id}"),
                           "jobs": q.get(&id).map(job_view).into_iter().collect::<Vec<_>>(), "refused": refused });
        }
        self.report_pump();
        tracing::info!(user = %by, report = kind.as_str(), period = %period.label, "volume report: queued");
        let q = self.reports.queue.lock();
        json!({ "ok": true, "jobs": q.get(&id).map(job_view).into_iter().collect::<Vec<_>>(), "refused": refused })
    }

    /// Run `work` for every cluster: clusters red by the poller's health go to the end of
    /// the job and are tried up to three times; a cluster that fails is tried once more at
    /// the end, unless its failure is permanent (`RoundError`). Returns what succeeded, and every cluster that did not with why. Stops
    /// between rounds when `stop` says so (the reason is the third value).
    async fn report_rounds<T, E, F, Fut>(self: &Arc<Self>, job: &str, ids: &[String], stop: &Stop, work: F)
        -> (HashMap<String, T>, Vec<(String, String)>, Option<String>)
    where
        T: Send + 'static,
        E: Into<RoundError> + Send + 'static,
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<T, E>> + Send + 'static,
    {
        let (mut done, mut failed) = (HashMap::new(), vec![]);
        let mut todo: Vec<String> = ids.to_vec();
        let (mut red, mut tries): (HashMap<String, u32>, HashMap<String, u32>) = (HashMap::new(), HashMap::new());
        let backoff = *self.reports.backoff_ms.lock();
        let mut round = 0;
        while !todo.is_empty() {
            if let Some(r) = stop() {
                for id in todo {
                    failed.push((id, r.clone()));
                }
                return (done, failed, Some(r));
            }
            if round > 0 {
                sleep_ms(backoff[1]).await;
            }
            round += 1;
            let mut next = vec![];
            let mut set = tokio::task::JoinSet::new();
            for id in todo {
                if self.report_cluster_red(&id) {
                    let n = red.entry(id.clone()).or_insert(0);
                    *n += 1;
                    if *n > RED_TRIES {
                        failed.push((id.clone(), "cluster health is red: not collected, to spare it".to_string()));
                        self.cluster_progress(Some(job), &id, |c| c.state = "failed".into());
                    } else {
                        self.cluster_progress(Some(job), &id, |c| c.state = "deferred".into());
                        next.push(id);
                    }
                    continue;
                }
                let fut = work(id.clone());
                // The job's lane goes with the cluster's work (a spawned task does not inherit it).
                set.spawn(crate::jobs::governor::within(crate::jobs::governor::current(), async move { (id, fut.await) }));
            }
            while let Some(j) = set.join_next().await {
                let Ok((id, r)) = j else { continue };
                match r {
                    Ok(v) => {
                        done.insert(id, v);
                    }
                    Err(e) => {
                        let e: RoundError = e.into();
                        let n = tries.entry(id.clone()).or_insert(0);
                        *n += 1;
                        if *n > 1 || e.permanent || stop().is_some() {
                            failed.push((id, e.why));
                        } else {
                            next.push(id);
                        }
                    }
                }
            }
            todo = next;
        }
        (done, failed, None)
    }

    /// The job's stop: a person's, the emergency stop, and for a hosts job the watchdog.
    fn report_job_stop(self: &Arc<Self>, job: &Job, max_minutes: Option<u64>) -> Stop {
        let (core, id, started) = (self.clone(), job.id.clone(), std::time::Instant::now());
        let limit_ms = max_minutes.map(|m| self.reports.watchdog_ms.lock().unwrap_or(m * 60_000));
        Arc::new(move || {
            core.report_stop_asked(&id).map(|by| format!("stopped by {by}"))
                .or_else(|| core.volume_stopped().then(|| "the emergency stop came on".to_string()))
                .or_else(|| limit_ms.filter(|ms| started.elapsed().as_millis() as u64 >= *ms).map(|_| format!(
                    "ran longer than {} minutes (UI_REPORT_HOSTS_MAX_MINUTES): stopped between pages; what was collected is kept and the next run resumes it",
                    max_minutes.unwrap_or(0))))
        })
    }

    /// How a job that met a stop ends: a person's stop, or the emergency stop (the schedule
    /// tries again after it); `None` for the watchdog, which still builds the file.
    fn report_stop_end(&self, job: &Job) -> Option<JobEnd> {
        if let Some(by) = self.report_stop_asked(&job.id) {
            return Some(JobEnd::stopped(by));
        }
        if self.volume_stopped() {
            return Some(JobEnd::held("the emergency stop came on: run the report again when the stop is over"));
        }
        None
    }

    fn report_note_failed(&self, job: &Job, failed: &[(String, String)]) {
        let list: Vec<FailedCluster> = failed.iter().map(|(c, r)| FailedCluster { cluster_id: c.clone(), reason: r.clone() }).collect();
        self.reports.with(|q| {
            if let Some(j) = q.get_mut(&job.id) {
                j.failed_clusters = list;
            }
        });
    }

    fn report_name(&self, id: &str) -> String {
        self.spec_for(id).and_then(|s| s.name).unwrap_or_else(|| id.to_string())
    }

    fn report_file_name(prefix: &str, job: &Job, ext: &str) -> String {
        let who = match job.cluster_ids.as_slice() {
            [one] => super::build::file_part(one),
            many => format!("{}-clusters", many.len()),
        };
        format!("{prefix}-{who}-{}_{}.{ext}", job.period.from, job.period.to)
    }

    /// Mail a job's file when it is to be mailed: a person's *Mail it*, or a schedule's job.
    async fn report_mail_job(self: &Arc<Self>, job: &Job, mut end: JobEnd, name: &str, body: String) -> JobEnd {
        if !(job.mail || job.kind == Kind::Mailed) {
            return end;
        }
        if let Some(by) = self.report_stop_asked(&job.id) {
            end.status = Status::Stopped;
            end.stopped_by = Some(by);
            return end;
        }
        self.job_state(&job.id, "mailing");
        let (sched, _) = self.report_schedule_effective(job.report);
        if job.kind == Kind::Mailed {
            self.report_mail_started(&job.id).await;
        }
        let subject = sched.subject_for(&job.period);
        let sent = self.report_mail_file(job.report, &job.by, &subject, &body, (&job.id, name, job.format.mime())).await;
        end.recipients = *sent.as_ref().unwrap_or(&sched.recipients());
        end.mail_error = sent.err();
        end
    }

    /// The indices report: one fresh `_cat/indices` per cluster, laid over the period and
    /// the record (`indices::assemble`).
    pub(super) async fn report_indices_job(self: &Arc<Self>, job: &Job) -> JobEnd {
        if self.volume.store.is_none() {
            return JobEnd::failed("no data directory");
        }
        let raw = match self.volume_config().await {
            Ok(raw) => raw,
            Err(e) => return JobEnd::failed(e),
        };
        if self.volume_stopped() {
            return JobEnd::held("the emergency stop is on: nothing was sent to the cluster; run the report again when the stop is over");
        }
        let settings: HashMap<String, VolumeSettings> = job.cluster_ids.iter()
            .map(|id| (id.clone(), self.volume_resolve(raw.as_ref(), Some(id), None).settings)).collect();
        let stop = self.report_job_stop(job, None);
        let timeout = self.hosts_config().request_timeout_ms;
        self.job_state(&job.id, "collecting");
        let total = job.cluster_ids.len() as u64;
        self.report_progress(&job.id, 0, total + 1);
        let core = self.clone();
        let (job_id, st2) = (job.id.clone(), stop.clone());
        let (listed, failed, stopped) = self.report_rounds(&job.id, &job.cluster_ids, &stop, move |id: String| {
            let (core, s, stop, job_id) = (core.clone(), settings.get(&id).cloned().unwrap_or_default(), st2.clone(), job_id.clone());
            async move {
                core.cluster_progress(Some(&job_id), &id, |c| c.state = "waiting".into());
                let _permit = core.wait_permit(&stop).await?;
                let ind = Indices::from_settings(&s).map_err(String::from)?;
                core.cluster_progress(Some(&job_id), &id, |c| {
                    c.state = "collecting".into();
                    c.concurrency = 1;
                });
                let res = core.es_req(indices::cat_request(&id, &ind, timeout)).await;
                let Some(rows) = collect::cat_rows(&res) else {
                    let why = indices::failure_reason(&res);
                    let reason = Some(why.clone());
                    core.cluster_progress(Some(&job_id), &id, |c| {
                        c.state = "retrying".into();
                        c.last_reason = reason;
                    });
                    return Err(why);
                };
                drop(res);
                let out = indices::read_rows(&rows, &ind);
                core.cluster_progress(Some(&job_id), &id, |c| {
                    c.state = "done".into();
                    c.rows = out.len() as u64;
                });
                Ok(out)
            }
        }).await;
        if stopped.is_some() {
            if let Some(end) = self.report_stop_end(job) {
                return end;
            }
        }
        self.report_note_failed(job, &failed);
        self.report_progress(&job.id, total, total + 1);
        self.job_state(&job.id, "building");
        // Assembled and written on a report thread: the record's days for the deleted ones.
        let names: Vec<(String, String)> = job.cluster_ids.iter().map(|id| (id.clone(), self.report_name(id))).collect();
        let (core, period, format, failed2) = (self.clone(), job.period.clone(), job.format, failed.clone());
        let mut listed = listed;
        let built = self.report_cpu(move || {
            let Some(store) = core.volume.store.as_ref() else { return Err("no data directory".to_string()) };
            let mut clusters = vec![];
            for (id, name) in &names {
                let record = store.days_between(id, period.from_date(), period.to_date());
                clusters.push(match listed.remove(id) {
                    Some(rows) => indices::assemble(id, name, rows, &period, &record),
                    None => {
                        let why = failed2.iter().find(|(c, _)| c == id).map(|(_, r)| r.clone()).unwrap_or_else(|| "not read".into());
                        indices::failed(id, name, why, &period, &record)
                    }
                });
            }
            let text = indices::mail_text(&clusters);
            let bytes = match format {
                Format::Xlsx => xlsx::workbook(&indices::sheets(&clusters, &period))?,
                Format::CsvZip => zip::write(&indices::csv_files(&clusters))?,
            };
            Ok((bytes, text))
        }).await.and_then(|r| r);
        let (bytes, text) = match built {
            Ok(x) => x,
            Err(e) => return JobEnd::failed(format!("the file could not be built: {e}")),
        };
        let name = Self::report_file_name("indices", job, if job.format == Format::Xlsx { "xlsx" } else { "zip" });
        let file = match self.report_store_file(&job.id, &name, bytes).await {
            Ok(f) => f,
            Err(e) => return JobEnd::failed(format!("the file could not be kept: {e}")),
        };
        let warning = (!failed.is_empty()).then(|| failed.iter().map(|(c, r)| format!("{c}: {r}")).collect::<Vec<_>>().join("; "));
        let end = JobEnd::done(file, warning);
        let body = format!("ElasticPro indices report · {}\n\nIndex store size (pri.store.size), as listed when the report was built.\n\n{text}", job.period.label);
        self.report_mail_job(job, end, &name, body).await
    }

    /// Volume by host: the period's missing days collected per cluster (`hosts_collect`),
    /// then the file streamed from the day files.
    pub(super) async fn report_hosts_job(self: &Arc<Self>, job: &Job) -> JobEnd {
        if self.volume.store.is_none() {
            return JobEnd::failed("no data directory");
        }
        let raw = match self.volume_config().await {
            Ok(raw) => raw,
            Err(e) => return JobEnd::failed(e),
        };
        let cfg = self.hosts_config();
        let today = vsched::utc_day(now_ms());
        // A day is collected once it is over (UTC): today never is.
        let days: Vec<NaiveDate> = job.period.days().into_iter().filter(|d| *d < today).collect();
        let settings: HashMap<String, VolumeSettings> = job.cluster_ids.iter()
            .map(|id| (id.clone(), self.volume_resolve(raw.as_ref(), Some(id), None).settings)).collect();
        let stop = self.report_job_stop(job, Some(cfg.max_minutes));
        self.job_state(&job.id, "collecting");
        let total = job.cluster_ids.len() as u64;
        self.report_progress(&job.id, 0, total + 1);
        let (core, st2, job_id, again, settings2) = (self.clone(), stop.clone(), job.id.clone(), job.collect_again, settings.clone());
        let (_, failed, stopped) = self.report_rounds(&job.id, &job.cluster_ids, &stop, move |id: String| {
            let (core, s, stop, job_id, days) = (core.clone(), settings2.get(&id).cloned().unwrap_or_default(), st2.clone(), job_id.clone(), days.clone());
            async move {
                let out = core.hosts_collect(id, s, days, HostsOpts { again, from_tick: false, stop, job: Some(job_id) }).await;
                if let Some(why) = out.error {
                    return Err(RoundError { why, permanent: out.permanent });
                }
                if let Some(r) = out.interrupted {
                    return Err(r.into());
                }
                if !out.failed_days.is_empty() {
                    let list: Vec<String> = out.failed_days.iter().map(|(d, r)| format!("{d} ({r})")).collect();
                    return Err(format!("{} day(s) not collected: {}", list.len(), list.join(", ")).into());
                }
                Ok(())
            }
        }).await;
        if stopped.is_some() {
            if let Some(end) = self.report_stop_end(job) {
                return end;
            }
        }
        // Collect again applies to the first try only: a retried cluster resumes.
        self.report_note_failed(job, &failed);
        self.report_progress(&job.id, total, total + 1);
        self.job_state(&job.id, "building");
        let Some(store) = self.volume.store.as_ref() else { return JobEnd::failed("no data directory") };
        let clusters: Vec<ClusterHosts> = job.cluster_ids.iter().map(|id| ClusterHosts {
            id: id.clone(), name: self.report_name(id), dir: HostsDir::new(store.root(), id),
            ind: settings.get(id).and_then(|s| Indices::from_settings(s).ok()),
            failure: failed.iter().find(|(c, _)| c == id).map(|(_, r)| r.clone()),
        }).collect();
        let name = Self::report_file_name("hosts", job, if job.format == Format::Xlsx { "xlsx" } else { "zip" });
        let Some(path) = self.reports.file_path(&job.id, &name) else { return JobEnd::failed("no data directory") };
        // Streamed to a file beside its place and renamed in when whole; on a report thread.
        let (period, format, failed2) = (job.period.clone(), job.format, failed.clone());
        let built = self.report_cpu(move || -> Result<(u64, String), String> {
            let tmp = std::path::PathBuf::from(format!("{}.tmp", path.display()));
            if let Some(d) = tmp.parent() {
                std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
            }
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            let f = o.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
            let w = std::io::BufWriter::new(f);
            let result = (|| -> Result<std::io::BufWriter<std::fs::File>, String> {
                match format {
                    Format::Xlsx => {
                        let mut book = xlsx::StreamBook::new(w);
                        hosts::write_xlsx(&mut book, &clusters, &cfg, &period, &failed2)?;
                        book.finish()
                    }
                    Format::CsvZip => {
                        let mut z = zip::StreamZip::new(w);
                        hosts::write_csvzip(&mut z, &clusters, &cfg, &period, &failed2)?;
                        z.finish()
                    }
                }
            })();
            let w = match result {
                Ok(w) => w,
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(e);
                }
            };
            let f = w.into_inner().map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
            let size = f.metadata().map_err(|e| e.to_string())?.len();
            drop(f);
            std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
            Ok((size, hosts::mail_text(&clusters, &cfg, &period, &failed2)))
        }).await.and_then(|r| r);
        let (size, text) = match built {
            Ok(x) => x,
            Err(e) => return JobEnd::failed(format!("the file could not be built: {e}")),
        };
        self.reports.prune_files(std::time::SystemTime::now());
        let warning = (!failed.is_empty()).then(|| failed.iter().map(|(c, r)| format!("{c}: {r}")).collect::<Vec<_>>().join("; "));
        let end = JobEnd::done(FileRef { name: name.clone(), bytes: size }, warning);
        let body = format!("ElasticPro volume by host · {}\n\nEvent size and forwarded size as the documents report them (GB = 1024³ bytes).\n\n{text}", job.period.label);
        self.report_mail_job(job, end, &name, body).await
    }

    /* ------------------------------------------- the view ------------------------------------------- */

    /// `HOSTS_QUERY {clusterId, period, q, sort, offset, limit≤200}`: the held day files read
    /// a row at a time, ClientID and branch filled as in the workbook. The gate has checked
    /// that the cluster is the caller's.
    pub(super) async fn hosts_query(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(id) = msg.get("clusterId").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return bad("bad_request", "clusterId is required");
        };
        if self.spec_for(id).is_none() || self.visible_ids(caller).is_some_and(|v| !v.contains(id)) {
            return bad("not_found", format!("no cluster {id:?}"));
        }
        let today = vsched::utc_day(now_ms());
        let p = match msg.get("period").filter(|v| !v.is_null()) {
            Some(v) => match period::parse(v, today) {
                Ok(p) => p,
                Err(e) => return bad("bad_request", e),
            },
            None => period::month_so_far(today),
        };
        let q = msg.get("q").and_then(Value::as_str).unwrap_or("").chars().take(200).collect::<String>();
        let cfg = self.hosts_config();
        let sort = match msg.get("sort").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            None => None,
            Some(s) => match hosts::parse_sort(s, &cfg.fields) {
                Some(x) => Some(x),
                None => return bad("bad_request", "sort is one of day, index, source, host, docs, eventBytes, subBytes, clientId, branch or meta.<field>, \
                                                   as \"<col>:asc\" / \"<col>:desc\" (or \"-<col>\" for descending)"),
            },
        };
        let offset = msg.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = msg.get("limit").and_then(Value::as_u64).unwrap_or(hosts::QUERY_LIMIT_MAX as u64) as usize;
        if limit == 0 || limit > hosts::QUERY_LIMIT_MAX {
            return bad("bad_request", format!("limit is 1 to {}", hosts::QUERY_LIMIT_MAX));
        }
        if sort.is_some() && offset + limit > hosts::QUERY_DEPTH_MAX {
            return bad("bad_request", format!("a sorted view pages at most {} rows deep: search to narrow it", hosts::QUERY_DEPTH_MAX));
        }
        let raw = self.volume_config().await.ok().flatten();
        let s = self.volume_resolve(raw.as_ref(), Some(id), None).settings;
        let Some(store) = self.volume.store.as_ref() else { return bad("no_store", "no data directory") };
        let c = ClusterHosts { id: id.to_string(), name: self.report_name(id), dir: HostsDir::new(store.root(), id),
                               ind: Indices::from_settings(&s).ok(), failure: None };
        match self.report_cpu(move || hosts::query(&c, &cfg, &p, &q, sort, offset, limit)).await.and_then(|r| r) {
            Ok(v) => v,
            Err(e) => bad("io_error", e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Edition;
    use crate::fleet::catalogue::Dataset;
    use crate::fleet::entry::{Body, Entry, Status as EntryStatus};
    use std::sync::atomic::{AtomicU32, Ordering};

    fn health(core: &Core, id: &str, status: &str) {
        let mut e = Entry::never(1, None);
        e.status = EntryStatus::Ok;
        e.data = Some(Body::from_value(&json!({ "health": { "json": { "status": status } } })));
        core.fleet.state.lock().entries.insert((id.to_string(), Dataset::Health), e);
    }

    #[tokio::test]
    async fn a_red_cluster_goes_to_the_end_and_a_failed_one_is_tried_once_more() {
        let dir = std::env::temp_dir().join(format!("ep-rounds-{}-{}", std::process::id(), rand::random::<u32>()));
        let core = Core::new_with_rounds(Some(dir.clone()), Edition::Portable, 1);
        core.set_report_backoff_for_tests([0, 1, 1]);
        health(&core, "redc", "red");
        health(&core, "okc", "green");
        assert!(core.report_cluster_red("redc") && !core.report_cluster_red("okc") && !core.report_cluster_red("unknown"));
        let names = ["okc", "redc", "flaky", "bad"];
        let calls: Arc<HashMap<String, AtomicU32>> = Arc::new(names.iter().map(|k| (k.to_string(), AtomicU32::new(0))).collect());
        let stop: Stop = Arc::new(|| None);
        let c2 = calls.clone();
        let ids: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        let (done, failed, stopped) = core.report_rounds("job", &ids, &stop, move |id: String| {
            let n = c2[&id].fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                match id.as_str() {
                    "flaky" if n == 1 => Err("timed out".to_string()),
                    "bad" => Err("HTTP 401".to_string()),
                    _ => Ok(n),
                }
            }
        }).await;
        assert_eq!(stopped, None);
        assert_eq!(done.get("okc"), Some(&1));
        assert_eq!(done.get("flaky"), Some(&2), "a failed cluster is tried once more, at the end");
        assert_eq!(calls["bad"].load(Ordering::SeqCst), 2, "and only once more");
        assert_eq!(calls["redc"].load(Ordering::SeqCst), 0, "a red cluster is not asked");
        let reasons: HashMap<&str, &str> = failed.iter().map(|(c, r)| (c.as_str(), r.as_str())).collect();
        assert_eq!(reasons.get("bad"), Some(&"HTTP 401"));
        assert!(reasons["redc"].contains("red"), "still red after three tries: named, not collected");

        // Red at first, green before its tries run out: collected at the end of the job.
        let flip = core.clone();
        let tries = Arc::new(AtomicU32::new(0));
        let t2 = tries.clone();
        let greens: Stop = Arc::new(move || {
            // Asked between rounds: the cluster turns green after the first.
            if t2.fetch_add(1, Ordering::SeqCst) == 1 {
                health(&flip, "redc", "green");
            }
            None
        });
        let (done, failed, _) = core.report_rounds("job", &["redc".to_string()], &greens, move |_id: String| async { Ok::<(), String>(()) }).await;
        assert!(done.contains_key("redc") && failed.is_empty(), "{failed:?}");

        // A stop between rounds names what is left.
        let stopped: Stop = Arc::new(|| Some("stopped by ann".to_string()));
        let (_, failed, why) = core.report_rounds("job", &["okc".to_string()], &stopped, move |_id: String| async { Ok::<(), String>(()) }).await;
        assert_eq!(why.as_deref(), Some("stopped by ann"));
        assert_eq!(failed[0].0, "okc");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_ceiling_leaves_one_gate_slot_per_cluster() {
        let c = concurrency();
        assert!(c.max >= 1 && c.max < crate::gate::limits().per_cluster.max(2) as u32, "{c:?}");
        assert!(c.start <= c.max);
    }

    #[test]
    fn in_the_worker_the_ceiling_may_use_the_whole_per_cluster_cap() {
        use crate::worker::Role;
        assert_eq!(concurrency_for(4, Role::All).max, 3, "role all keeps one slot for the poller and people");
        assert_eq!(concurrency_for(4, Role::Worker).max, 4, "the worker's gate is its own");
        assert_eq!(concurrency_for(1, Role::All).max, 1, "never below one");
    }
}
