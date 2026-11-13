//! The governor (docs/JOBS.md "Governor"): how many requests the worker's jobs send to
//! Elasticsearch at once, sized every `TICK_SECS` from what the process measures, never above
//! the limits an administrator set, and always behind people's own requests.
//!
//! In this product "threads" are requests a job has in flight at once, and "processes" are jobs
//! running at once. Three parts, the first two pure:
//!
//! * **The rule** (`step`): additive increase, multiplicative decrease of one total. One more
//!   request when everything is calm (CPU under `CALM_CPU_PCT`, memory under `CALM_MEMORY_PCT`,
//!   nobody waiting at the core's gate, no fleet-wide pushback); half as many when any signal
//!   crosses its threshold (people waiting, CPU throttled, CPU over the admin's `cpuPct`, memory
//!   over `memoryPct`, most of the clusters in work rejecting); never below the running jobs'
//!   minimums, never above `workerTotal`. A signal that cannot be read moves the rule neither
//!   way (and is shown null — never a guessed zero) — except people waiting: not known holds the
//!   total where it is, since people come first.
//! * **The sharing** (`share`): every running job keeps its minimum (slowed, never starved); a
//!   job whose `auto` is off gets its maximum, within `workerTotal`; what is left of the total
//!   goes by priority, High before Medium before Low, one request at a time round the jobs of a
//!   tier, oldest first; no job above its maximum.
//! * **Lanes** (`Lane`): one per running job, the limit the sharing gave it, enforced where a
//!   request takes its gate slot (`Core::run_upstream`): a job's request waits in its lane
//!   first, so a job never has more in flight than its allocation. A lane is found through a
//!   task-local (`within`, `current`), set where the job's work starts.
//!
//! A busy cluster shrinks only its own work, through the per-cluster controller
//! (`report::control::Controller`), whose ceiling is the smaller of its own and the job's lane.
//! The core's jobs (log delay, history store, Zabbix) run in lanes of a fixed size, their
//! maximum: no AIMD in the core, where people's requests already come first at the gate.
//!
//! Nothing here sends a cluster anything.

use super::controls::{Controls, Overall};
use super::{descriptor, Owner, Priority};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

/// Seconds between two decisions.
pub const TICK_SECS: u64 = 10;
/// Calm enough to grow: CPU under this share of what the process may use …
pub const CALM_CPU_PCT: f64 = 60.0;
/// … and memory under this share of its limit.
pub const CALM_MEMORY_PCT: f64 = 70.0;
/// Throttled: at least this share of the tick's CPU periods were throttled (the health tab's
/// amber line, `health::THROTTLE_AMBER_PCT`).
pub const THROTTLED_PCT: f64 = crate::health::THROTTLE_AMBER_PCT;
/// A person's request granted after waiting this long at the core's gate counts as waiting.
pub const PEOPLE_WAIT_MS: u64 = 250;
/// The window over which the core counts people's waits for the worker.
pub const PEOPLE_WINDOW_MS: u64 = 10_000;
/// `<data>/job-runs/core-load.json`: the core's gate as people meet it, for the worker. Written by
/// the core only (role core), every `CORE_LOAD_EVERY_SECS`; older than `CORE_LOAD_FRESH_MS` it
/// says nothing (people waiting: not known).
pub const CORE_LOAD_FILE: &str = "core-load.json";
pub const CORE_LOAD_EVERY_SECS: u64 = 5;
pub const CORE_LOAD_FRESH_MS: u64 = 30_000;

/// Why the total last changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Calm,
    Cpu,
    CpuThrottled,
    Memory,
    PeopleWaiting,
    ClusterRejecting,
    /// Put back inside the bounds: an administrator changed them, the running jobs' minimums
    /// moved, or the governor was switched off (`overall.auto`).
    Limit,
}

/// What the rule reads. The first five are what `JOBS_LIST` shows; null is not known.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signals {
    /// Percent of the CPU the process may use (its cgroup limit, else every CPU of the host),
    /// over the last tick.
    pub cpu_pct: Option<f64>,
    /// Memory in use against the cgroup limit; null without a limit.
    pub memory_pct: Option<f64>,
    /// People at the core's gate: waiting now, or granted after `PEOPLE_WAIT_MS` within
    /// `PEOPLE_WINDOW_MS`. Null when the core's figure is missing or stale.
    pub people_waiting: Option<u64>,
    /// Report jobs waiting in the queue.
    pub queue: Option<u64>,
    /// The jobs' requests over the last tick, average milliseconds; null when none answered.
    pub avg_page_ms: Option<u64>,
    /// Share of the tick's CPU periods throttled.
    #[serde(default, skip_serializing)]
    pub throttled_pct: Option<f64>,
    /// More than half of the clusters the jobs sent to this tick are rejecting (`pool`, `429`).
    #[serde(default, skip_serializing)]
    pub rejecting: bool,
}

/// The first signal over its threshold, in the order people, throttling, CPU, memory, clusters.
pub fn pressure(s: &Signals, o: &Overall) -> Option<Reason> {
    if s.people_waiting.is_some_and(|n| n > 0) {
        Some(Reason::PeopleWaiting)
    } else if s.throttled_pct.is_some_and(|p| p >= THROTTLED_PCT) {
        Some(Reason::CpuThrottled)
    } else if s.cpu_pct.is_some_and(|p| p > o.cpu_pct as f64) {
        Some(Reason::Cpu)
    } else if s.memory_pct.is_some_and(|p| p > o.memory_pct as f64) {
        Some(Reason::Memory)
    } else if s.rejecting {
        Some(Reason::ClusterRejecting)
    } else {
        None
    }
}

/// Calm enough to grow. People must be known not to wait (a worker that cannot see the core's
/// gate does not push harder on a guess); CPU, memory and throttling not known (no cgroup, no
/// limit) do not stop it — they are shown null.
pub fn calm(s: &Signals) -> bool {
    s.cpu_pct.is_none_or(|p| p < CALM_CPU_PCT)
        && s.memory_pct.is_none_or(|p| p < CALM_MEMORY_PCT)
        && s.people_waiting == Some(0)
        && s.throttled_pct.is_none_or(|p| p < THROTTLED_PCT)
        && !s.rejecting
}

/// The total's bounds: the running jobs' minimums (`floor`) and `workerTotal`; the
/// administrator's ceiling wins when the minimums add up to more.
pub fn bounds(o: &Overall, floor: u32) -> (u32, u32) {
    let hi = o.worker_total.max(1);
    (floor.clamp(1, hi), hi)
}

/// Where the total starts: half of `workerTotal`, within the bounds.
pub fn start(o: &Overall, floor: u32) -> u32 {
    let (lo, hi) = bounds(o, floor);
    (hi / 2).clamp(lo, hi)
}

/// One decision: the next total, and why it changed (`None`: it did not).
pub fn step(cur: u32, s: &Signals, o: &Overall, floor: u32) -> (u32, Option<Reason>) {
    let (lo, hi) = bounds(o, floor);
    let moved = |to: u32, r: Reason| (to, (to != cur).then_some(r));
    if !o.auto {
        return moved(hi, Reason::Limit);
    }
    if let Some(r) = pressure(s, o) {
        return moved((cur / 2).clamp(lo, hi), r);
    }
    if cur < lo || cur > hi {
        return moved(cur.clamp(lo, hi), Reason::Limit);
    }
    if calm(s) && cur < hi {
        return (cur + 1, Some(Reason::Calm));
    }
    (cur, None)
}

/// One running job as the sharing sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Unit {
    pub priority: Priority,
    pub min: u32,
    pub max: u32,
    pub auto: bool,
    /// When it started (oldest first within a tier).
    pub since: u64,
}

/// What a running job is given. `reason`: `share` (its part of the total, by priority), `min`
/// (held at its minimum), `max` (at its maximum), `auto_off` (its maximum: its own `auto` is off),
/// `limit` (less than its maximum with `auto` off: `workerTotal` is spent), `fixed` (a job of the
/// core: its maximum, always).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub requests: u32,
    pub min: u32,
    pub max: u32,
    pub auto: bool,
    pub reason: String,
}

/// Share `total` among `units` (answered in their order). See the module comment.
pub fn share(total: u32, worker_total: u32, units: &[Unit]) -> Vec<Allocation> {
    let n = units.len();
    let lim: Vec<(u32, u32)> = units.iter().map(|u| (u.min.max(1), u.max.max(u.min.max(1)))).collect();
    let mut give: Vec<u32> = lim.iter().map(|l| l.0).collect();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|i| (units[*i].priority, units[*i].since, *i));
    let mut used: u32 = give.iter().sum();
    // Auto off: its maximum, by priority, within the administrator's total.
    for &i in order.iter().filter(|i| !units[**i].auto) {
        let add = (lim[i].1 - give[i]).min(worker_total.saturating_sub(used));
        give[i] += add;
        used += add;
    }
    // The rest of the total, a tier at a time, one request at a time round the tier.
    let mut pool = total.saturating_sub(used);
    for tier in [Priority::High, Priority::Medium, Priority::Low] {
        let members: Vec<usize> = order.iter().copied().filter(|i| units[*i].auto && units[*i].priority == tier).collect();
        while pool > 0 {
            let mut gave = false;
            for &i in &members {
                if pool > 0 && give[i] < lim[i].1 {
                    give[i] += 1;
                    pool -= 1;
                    gave = true;
                }
            }
            if !gave {
                break;
            }
        }
    }
    (0..n).map(|i| {
        let (min, max) = lim[i];
        let reason = match (units[i].auto, give[i]) {
            (false, g) if g == max => "auto_off",
            (false, _) => "limit",
            (true, g) if g == max => "max",
            (true, g) if g == min => "min",
            _ => "share",
        };
        Allocation { requests: give[i], min, max, auto: units[i].auto, reason: reason.into() }
    }).collect()
}

/// More than half of the clusters in work are rejecting (signal `pool` or `429`): the fleet, not
/// one cluster, is pushing back. One cluster alone is left to its own controller.
pub fn rejecting(in_work: &HashSet<String>, busy: &BTreeMap<String, super::load::Busy>) -> bool {
    let n = in_work.iter().filter(|c| busy.get(*c).is_some_and(|b| b.signal == "pool" || b.signal == "429")).count();
    n > 0 && n * 2 > in_work.len()
}

/// The change the view shows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub at: u64,
    pub from: u32,
    pub to: u32,
    pub reason: Reason,
}

/// The governor as `JOBS_LIST` shows it (and the worker's heartbeat carries it to the core).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub auto: bool,
    /// Requests the jobs have in flight now.
    pub in_use: u32,
    pub total: u32,
    pub most_at_once: u32,
    pub jobs_running: u32,
    pub last_change: Option<Change>,
    pub signals: Signals,
    /// Per job id, its running runs together: `requests` is their sum, `min` and `max` each run's.
    #[serde(default)]
    pub allocations: BTreeMap<String, Allocation>,
}

impl View {
    /// The shape of `JOBS_LIST.governor`: everything but the allocations, which go to each job.
    pub fn top(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).unwrap_or(serde_json::Value::Null);
        if let Some(o) = v.as_object_mut() {
            o.remove("allocations");
        }
        v
    }
}

/// The core's gate as people meet it, for the worker (`CORE_LOAD_FILE`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoreLoad {
    pub at: u64,
    /// People's requests waiting now (interactive and prompted).
    pub waiting: u64,
    /// People's requests granted within `PEOPLE_WINDOW_MS` after waiting `PEOPLE_WAIT_MS` or more.
    pub waited: u64,
}

impl CoreLoad {
    /// People waiting, or `None` when the figure is older than `CORE_LOAD_FRESH_MS`.
    pub fn people(&self, now: u64) -> Option<u64> {
        (now.saturating_sub(self.at) <= CORE_LOAD_FRESH_MS).then_some(self.waiting + self.waited)
    }
}

/* ------------------------------------------- lanes ------------------------------------------- */

/// One running job's requests: at most `limit` in flight. Shared by every part of the job (the
/// clusters of a collection run, the partitions of a day).
pub struct Lane {
    pub key: String,
    pub job_id: String,
    pub since: u64,
    /// A job of the core: its maximum, never moved by the rule.
    pub fixed: bool,
    limit: AtomicU32,
    in_flight: parking_lot::Mutex<u32>,
    notify: tokio::sync::Notify,
    users: AtomicUsize,
    /// (ms summed, answers) since the last tick, and the clusters sent to.
    took: parking_lot::Mutex<(u64, u64, HashSet<String>)>,
}

impl Lane {
    pub fn new(key: &str, job_id: &str, since: u64, fixed: bool, limit: u32) -> Lane {
        Lane {
            key: key.to_string(), job_id: job_id.to_string(), since, fixed, limit: AtomicU32::new(limit.max(1)),
            in_flight: parking_lot::Mutex::new(0), notify: tokio::sync::Notify::new(), users: AtomicUsize::new(0),
            took: parking_lot::Mutex::new((0, 0, HashSet::new())),
        }
    }

    pub fn limit(&self) -> u32 {
        self.limit.load(Ordering::SeqCst)
    }

    /// A new limit applies to the next request; what is in flight finishes.
    pub fn set_limit(&self, n: u32) {
        self.limit.store(n.max(1), Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn in_flight(&self) -> u32 {
        *self.in_flight.lock()
    }

    /// Wait for room in the lane. The permit gives it back when dropped, with the time it was held.
    pub async fn acquire(self: &Arc<Self>, cluster: &str) -> LanePermit {
        loop {
            let notified = self.notify.notified();
            {
                let mut n = self.in_flight.lock();
                if *n < self.limit() {
                    *n += 1;
                    self.took.lock().2.insert(cluster.to_string());
                    return LanePermit { lane: self.clone(), started: std::time::Instant::now() };
                }
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(200), notified).await;
        }
    }

    /// The tick's figures, reset: (ms summed, answers, clusters sent to).
    pub fn take(&self) -> (u64, u64, HashSet<String>) {
        std::mem::take(&mut *self.took.lock())
    }
}

/// A request's place in its lane.
pub struct LanePermit {
    lane: Arc<Lane>,
    started: std::time::Instant,
}

impl Drop for LanePermit {
    fn drop(&mut self) {
        {
            let mut n = self.lane.in_flight.lock();
            *n = n.saturating_sub(1);
        }
        {
            let mut t = self.lane.took.lock();
            t.0 += self.started.elapsed().as_millis() as u64;
            t.1 += 1;
        }
        self.lane.notify.notify_waiters();
    }
}

tokio::task_local! {
    static LANE: Arc<Lane>;
}

/// The lane of the job this task works for, if any.
pub fn current() -> Option<Arc<Lane>> {
    LANE.try_with(Arc::clone).ok()
}

/// Run `f` as part of `lane`'s job (a spawned task does not inherit it: pass `current()` along).
pub async fn within<F: Future>(lane: Option<Arc<Lane>>, f: F) -> F::Output {
    match lane {
        Some(l) => LANE.scope(l, f).await,
        None => f.await,
    }
}

/* ------------------------------------------- the registry ------------------------------------------- */

/// What the governor decided last, and what it compares with next.
#[derive(Default)]
pub struct State {
    /// The total; 0 until the first tick.
    pub total: u32,
    pub last_change: Option<Change>,
    pub signals: Signals,
    /// The last CPU reading: (unix ms, usage µs, periods, throttled).
    pub prev_cpu: Option<(u64, u64, Option<u64>, Option<u64>)>,
    pub view: Option<View>,
}

/// The lanes of this process's running jobs, and the state of the rule.
#[derive(Default)]
pub struct Governor {
    lanes: parking_lot::Mutex<BTreeMap<String, Arc<Lane>>>,
    pub state: parking_lot::Mutex<State>,
}

/// A job's hold on its lane: the lane goes when the last part of the job lets go.
pub struct LaneGuard {
    gov: Arc<Governor>,
    lane: Arc<Lane>,
}

impl LaneGuard {
    pub fn lane(&self) -> Arc<Lane> {
        self.lane.clone()
    }
}

impl Drop for LaneGuard {
    fn drop(&mut self) {
        let mut m = self.gov.lanes.lock();
        if self.lane.users.fetch_sub(1, Ordering::SeqCst) == 1 {
            m.remove(&self.lane.key);
        }
    }
}

/// A job's settings as the sharing reads them: (min, max, auto, priority).
pub fn settings_of(c: &Controls, job_id: &str) -> (u32, u32, bool, Priority) {
    let s = c.job(job_id);
    let d = descriptor(job_id).copied().unwrap_or_else(super::created_descriptor_defaults);
    let min = s.requests_min.unwrap_or(d.requests.min).max(1);
    let max = s.requests_max.unwrap_or(d.requests.max).max(min);
    (min, max, s.auto.unwrap_or(true), s.priority.unwrap_or(d.priority))
}

/// Whether the core runs this job (its lane is fixed at the job's maximum).
pub fn core_job(job_id: &str) -> bool {
    descriptor(job_id).is_some_and(|d| d.owner == Owner::Core)
}

impl Governor {
    /// The lane of `key` (a run), made for `job_id` when it is not there yet.
    pub fn lane(self: &Arc<Self>, key: &str, job_id: &str, c: &Controls, now: u64) -> LaneGuard {
        let mut m = self.lanes.lock();
        let lane = m.entry(key.to_string()).or_insert_with(|| {
            let fixed = core_job(job_id);
            let (min, max, ..) = settings_of(c, job_id);
            Arc::new(Lane::new(key, job_id, now, fixed, if fixed { max } else { min }))
        }).clone();
        lane.users.fetch_add(1, Ordering::SeqCst);
        LaneGuard { gov: self.clone(), lane }
    }

    pub fn lanes(&self) -> Vec<Arc<Lane>> {
        self.lanes.lock().values().cloned().collect()
    }

    /// Share `total` among the lanes the rule moves, and set each one's limit; a fixed lane gets
    /// its maximum. Returns each lane with what it was given.
    pub fn apply(&self, total: u32, c: &Controls) -> Vec<(Arc<Lane>, Allocation)> {
        let lanes = self.lanes();
        let (fixed, moved): (Vec<Arc<Lane>>, Vec<Arc<Lane>>) = lanes.into_iter().partition(|l| l.fixed);
        let units: Vec<Unit> = moved.iter().map(|l| {
            let (min, max, auto, priority) = settings_of(c, &l.job_id);
            Unit { priority, min, max, auto, since: l.since }
        }).collect();
        let mut out = vec![];
        for (l, a) in moved.into_iter().zip(share(total, c.overall.worker_total.max(1), &units)) {
            l.set_limit(a.requests);
            out.push((l, a));
        }
        for l in fixed {
            let (min, max, _, _) = settings_of(c, &l.job_id);
            l.set_limit(max);
            out.push((l, Allocation { requests: max, min, max, auto: false, reason: "fixed".into() }));
        }
        out
    }

    /// The minimums of the lanes the rule moves: the total's floor.
    pub fn floor(&self, c: &Controls) -> u32 {
        self.lanes().iter().filter(|l| !l.fixed).map(|l| settings_of(c, &l.job_id).0).sum()
    }
}

/// Per job id: its lanes' allocations together.
pub fn by_job(given: &[(Arc<Lane>, Allocation)]) -> BTreeMap<String, Allocation> {
    let mut out: BTreeMap<String, Allocation> = BTreeMap::new();
    for (l, a) in given {
        match out.get_mut(&l.job_id) {
            Some(x) => x.requests += a.requests,
            None => {
                out.insert(l.job_id.clone(), a.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o() -> Overall {
        Overall::default()
    }

    fn calm_signals() -> Signals {
        Signals { cpu_pct: Some(20.0), memory_pct: Some(30.0), people_waiting: Some(0), ..Signals::default() }
    }

    fn u(p: Priority, min: u32, max: u32, auto: bool, since: u64) -> Unit {
        Unit { priority: p, min, max, auto, since }
    }

    #[test]
    fn it_grows_by_one_when_calm_up_to_the_worker_total() {
        let s = calm_signals();
        assert_eq!(step(8, &s, &o(), 2), (9, Some(Reason::Calm)));
        assert_eq!(step(16, &s, &o(), 2), (16, None), "workerTotal is the ceiling");
        // Between calm and the thresholds: held.
        let warm = Signals { cpu_pct: Some(70.0), ..calm_signals() };
        assert_eq!(step(8, &warm, &o(), 2), (8, None));
        // Not known: no pressure, so nothing halves; people not known holds the total.
        assert_eq!(step(8, &Signals::default(), &o(), 2), (8, None), "people not known: held");
        let no_cgroup = Signals { people_waiting: Some(0), ..Signals::default() };
        assert_eq!(step(8, &no_cgroup, &o(), 2), (9, Some(Reason::Calm)), "CPU and memory not known do not stop it");
    }

    #[test]
    fn it_halves_on_each_signal() {
        let o = o();
        let cases = [
            (Signals { people_waiting: Some(1), ..calm_signals() }, Reason::PeopleWaiting),
            (Signals { throttled_pct: Some(12.0), ..calm_signals() }, Reason::CpuThrottled),
            (Signals { cpu_pct: Some(86.0), ..calm_signals() }, Reason::Cpu),
            (Signals { memory_pct: Some(90.0), ..calm_signals() }, Reason::Memory),
            (Signals { rejecting: true, ..calm_signals() }, Reason::ClusterRejecting),
        ];
        for (s, r) in cases {
            assert_eq!(step(16, &s, &o, 2), (8, Some(r)), "{r:?}");
        }
        // People come first, whatever else is over.
        let all = Signals { people_waiting: Some(3), cpu_pct: Some(99.0), memory_pct: Some(99.0), ..Signals::default() };
        assert_eq!(step(16, &all, &o, 2).1, Some(Reason::PeopleWaiting));
        // The administrator's thresholds, not fixed ones.
        let lower = Overall { cpu_pct: 50, ..Overall::default() };
        assert_eq!(step(16, &Signals { cpu_pct: Some(55.0), ..calm_signals() }, &lower, 2), (8, Some(Reason::Cpu)));
    }

    #[test]
    fn the_bounds_are_the_minimums_and_the_worker_total() {
        let p = Signals { people_waiting: Some(1), ..Signals::default() };
        assert_eq!(step(6, &p, &o(), 5), (5, Some(Reason::PeopleWaiting)), "never below the running jobs' minimums");
        assert_eq!(step(5, &p, &o(), 5), (5, None), "already at the floor: no change");
        assert_eq!(step(1, &calm_signals(), &o(), 4), (4, Some(Reason::Limit)), "a job started: up to its minimum at once");
        let lowered = Overall { worker_total: 6, ..Overall::default() };
        assert_eq!(step(12, &calm_signals(), &lowered, 2), (6, Some(Reason::Limit)), "an administrator lowered workerTotal");
        assert_eq!(bounds(&lowered, 40), (6, 6), "minimums over workerTotal: the administrator's ceiling wins");
        let off = Overall { auto: false, ..Overall::default() };
        assert_eq!(step(5, &p, &off, 2), (16, Some(Reason::Limit)), "governor off: workerTotal");
        assert_eq!(start(&o(), 2), 8);
    }

    #[test]
    fn sharing_goes_by_priority_and_keeps_every_minimum() {
        let units = [u(Priority::Low, 1, 4, true, 1), u(Priority::High, 1, 4, true, 3), u(Priority::Medium, 1, 4, true, 2)];
        let a = share(8, 16, &units);
        let got: Vec<u32> = a.iter().map(|x| x.requests).collect();
        assert_eq!(got, vec![1, 4, 3], "High to its max, then Medium; Low keeps its minimum");
        assert_eq!((a[0].reason.as_str(), a[1].reason.as_str(), a[2].reason.as_str()), ("min", "max", "share"));
        // Under pressure: the total at the floor, every job still has its minimum.
        let a = share(3, 16, &units);
        assert!(a.iter().all(|x| x.requests == 1), "{a:?}");
        // A total below the minimums: each keeps its minimum anyway (slowed, never starved).
        let a = share(1, 16, &units);
        assert!(a.iter().all(|x| x.requests >= 1));
        // Never above a job's maximum.
        let a = share(16, 16, &units);
        assert!(a.iter().all(|x| x.requests <= x.max), "{a:?}");
        assert_eq!(a.iter().map(|x| x.requests).sum::<u32>(), 12, "what no job may take stays unused");
    }

    #[test]
    fn a_tier_is_shared_round_the_jobs_oldest_first() {
        let units = [u(Priority::Medium, 1, 8, true, 20), u(Priority::Medium, 1, 8, true, 10)];
        let a = share(5, 16, &units);
        assert_eq!((a[0].requests, a[1].requests), (2, 3), "one at a time round the tier, the older job first");
    }

    #[test]
    fn auto_off_gets_its_maximum_within_the_worker_total() {
        let units = [u(Priority::Low, 1, 6, false, 1), u(Priority::High, 2, 4, true, 2)];
        let a = share(2, 16, &units);
        assert_eq!((a[0].requests, a[0].reason.as_str()), (6, "auto_off"), "its maximum whatever the total");
        assert_eq!((a[1].requests, a[1].reason.as_str()), (2, "min"), "the total is spent: the High job keeps its minimum");
        let a = share(2, 5, &units);
        assert_eq!((a[0].requests, a[0].reason.as_str()), (3, "limit"), "workerTotal 5: 2 for the other's minimum, 3 left");
    }

    #[test]
    fn rejecting_is_most_of_the_clusters_in_work_not_one() {
        use super::super::load::Busy;
        let busy = |c: &str, s: &str| (c.to_string(), Busy { cluster: c.into(), signal: s.into(), reason: "r".into(), since: None });
        let work: HashSet<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        let one: BTreeMap<String, Busy> = [busy("a", "429")].into_iter().collect();
        assert!(!rejecting(&work, &one), "one of two: that cluster's own controller");
        let two: BTreeMap<String, Busy> = [busy("a", "429"), busy("b", "pool")].into_iter().collect();
        assert!(rejecting(&work, &two));
        let slow: BTreeMap<String, Busy> = [busy("a", "slow"), busy("b", "slow")].into_iter().collect();
        assert!(!rejecting(&work, &slow), "slow is not rejecting");
        assert!(!rejecting(&HashSet::new(), &two), "nothing in work");
    }

    #[tokio::test]
    async fn a_lane_holds_its_job_to_its_limit() {
        let gov = Arc::new(Governor::default());
        let c = Controls::default();
        let g = gov.lane("run-1", super::super::VOLUME_DAILY, &c, 1);
        let again = gov.lane("run-1", super::super::VOLUME_DAILY, &c, 2);
        assert_eq!(gov.lanes().len(), 1, "one lane per run");
        let lane = g.lane();
        lane.set_limit(2);
        let p1 = lane.acquire("a").await;
        let _p2 = lane.acquire("b").await;
        let l2 = lane.clone();
        let third = tokio::spawn(async move { l2.acquire("a").await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!third.is_finished(), "a third waits");
        drop(p1);
        let _p3 = tokio::time::timeout(std::time::Duration::from_secs(2), third).await.unwrap().unwrap();
        assert_eq!(lane.in_flight(), 2);
        drop(g);
        assert_eq!(gov.lanes().len(), 1, "the other part of the job still holds it");
        drop(again);
        assert!(gov.lanes().is_empty());
        // A core job's lane is its maximum, fixed.
        let core = gov.lane("d1", super::super::LOGDELAY_MEASURE, &c, 3);
        assert_eq!((core.lane().fixed, core.lane().limit()), (true, 4));
        let given = gov.apply(1, &c);
        assert_eq!(given[0].1.reason, "fixed");
        assert_eq!(core.lane().limit(), 4);
        assert_eq!(within(Some(core.lane()), async { current().map(|l| l.key.clone()) }).await.as_deref(), Some("d1"));
        assert!(current().is_none());
    }
}
