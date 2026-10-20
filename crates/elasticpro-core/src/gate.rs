//! The one outgoing gate: every request to Elasticsearch, whoever sends it, waits here for
//! a slot before a socket is opened.
//!
//! What it replaced was three semaphores, first come first served, with nobody limiting how
//! many waited or for how long: a browser fanning a page out over a hundred clusters, the
//! poller's due work and a person's one click all queued in the same line, and a request
//! that was waiting could be neither seen nor let go of.
//!
//! The rules, all here:
//!
//! * **Class, by call path.** `Interactive` is a person's `ES` message; `Prompted` is a
//!   poller fetch somebody is waiting on; `Background` is everything that runs by itself.
//!   Decided by the code that built the request (`EsRequest::class`, never on the wire) —
//!   a page cannot make itself background by naming its origin `poller:x`.
//! * **Strict priority**, Interactive > Prompted > Background, for whichever slot frees
//!   next; within a class, round-robin across clusters, so one cluster's burst does not
//!   hold up every other cluster's single request.
//! * **Caps**: overall, per cluster, per jump host. `background_reserve` of the overall
//!   slots are for background only, so a page storm can never stop the health poll.
//! * **Ageing**: every `promote_after_ms` a waiter has waited moves it up one class, so a
//!   low class is delayed under load but never starved.
//! * **Bounded waiting, Interactive only.** At most `queue_max` waiting overall and
//!   `queue_per_user` per person; past that the answer is `overloaded` at once, with a
//!   time to try again. A waiter that has not got a slot by its deadline (the shorter of
//!   `queue_wait_ms` and its own timeout) is answered `queue_timeout`. The poller and the
//!   core's own jobs are never refused: their concurrency is bounded where they start.
//!
//! [`GateState`] is the bookkeeping, with no I/O and no clock (every call takes `now`), so
//! each rule above has a test. [`Gate`] wraps it for async callers: a [`Permit`] gives its
//! slot back when dropped, and a waiter that is dropped — its page left, its client gone —
//! leaves the queue on the spot.

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// Who a request is for. See the module comment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Class {
    /// A person asked for it: an `ES` message from a page or the console.
    Interactive,
    /// The poller fetching what somebody is waiting on (a `CLUSTER_DATASET` held open).
    Prompted,
    /// The poller's due work, the delay sink, the core's own housekeeping. The default, so
    /// a code path that forgets to say gets the class that can never crowd anyone out.
    #[default]
    Background,
}

impl Class {
    pub const ALL: [Class; 3] = [Class::Interactive, Class::Prompted, Class::Background];

    pub fn as_str(self) -> &'static str {
        match self {
            Class::Interactive => "interactive",
            Class::Prompted => "prompted",
            Class::Background => "background",
        }
    }

    fn idx(self) -> usize {
        match self {
            Class::Interactive => 0,
            Class::Prompted => 1,
            Class::Background => 2,
        }
    }

    fn up(self) -> Class {
        match self {
            Class::Background => Class::Prompted,
            _ => Class::Interactive,
        }
    }
}

/// Ageing step: a waiter moves up one class for every this long it has waited.
pub const PROMOTE_AFTER_MS: u64 = 30_000;

/// The gate's numbers. Read from config.txt's performance keys (through the environment
/// variables `settings.rs` sets) once, at start.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    /// ES_CONCURRENCY: requests open at once, all clusters and all sources together.
    pub global: usize,
    /// ES_PER_CLUSTER
    pub per_cluster: usize,
    /// ES_PER_JUMP_HOST
    pub per_jump: usize,
    /// ES_BACKGROUND_RESERVE: of `global`, slots only background may use.
    pub background_reserve: usize,
    /// ES_QUEUE_MAX: interactive requests waiting at once, everybody together.
    pub queue_max: usize,
    /// ES_QUEUE_PER_USER
    pub queue_per_user: usize,
    /// ES_QUEUE_WAIT_MS: the longest an interactive request waits for a slot.
    pub queue_wait_ms: u64,
    /// ES_MAX_TIMEOUT_MS: no request is given longer than this by the cluster, whatever it
    /// asked for (nginx gives up on the core at 120 s).
    pub max_timeout_ms: u64,
    pub promote_after_ms: u64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            global: 24,
            per_cluster: 4,
            per_jump: 8,
            background_reserve: 2,
            queue_max: 256,
            queue_per_user: 64,
            queue_wait_ms: 20_000,
            max_timeout_ms: 115_000,
            promote_after_ms: PROMOTE_AFTER_MS,
        }
    }
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

impl Limits {
    pub fn from_env() -> Limits {
        let d = Limits::default();
        let n = |k: &str, v: usize| env_u64(k).map(|x| x as usize).unwrap_or(v);
        Limits {
            global: n("ELASTICPRO_ES_CONCURRENCY", d.global),
            per_cluster: n("ELASTICPRO_ES_PER_CLUSTER", d.per_cluster),
            per_jump: n("ELASTICPRO_ES_PER_JUMP_HOST", d.per_jump),
            background_reserve: n("ELASTICPRO_ES_BACKGROUND_RESERVE", d.background_reserve),
            queue_max: n("ELASTICPRO_ES_QUEUE_MAX", d.queue_max),
            queue_per_user: n("ELASTICPRO_ES_QUEUE_PER_USER", d.queue_per_user),
            queue_wait_ms: env_u64("ELASTICPRO_ES_QUEUE_WAIT_MS").unwrap_or(d.queue_wait_ms),
            max_timeout_ms: env_u64("ELASTICPRO_ES_MAX_TIMEOUT_MS").unwrap_or(d.max_timeout_ms),
            promote_after_ms: d.promote_after_ms,
        }
        .normalised()
    }

    /// Within bounds and consistent with each other: no per-cluster cap above the overall
    /// one, a reserve that leaves at least one slot for everybody else, a per-person bound
    /// no larger than the whole queue.
    pub fn normalised(mut self) -> Limits {
        self.global = self.global.clamp(1, 1024);
        self.per_cluster = self.per_cluster.clamp(1, self.global);
        self.per_jump = self.per_jump.clamp(1, self.global);
        self.background_reserve = self.background_reserve.min(self.global - 1);
        self.queue_max = self.queue_max.min(100_000);
        self.queue_per_user = self.queue_per_user.clamp(1, self.queue_max.max(1));
        self.queue_wait_ms = self.queue_wait_ms.clamp(100, 600_000);
        self.max_timeout_ms = self.max_timeout_ms.clamp(1_000, 600_000);
        self
    }
}

/// What the ES task reaper may cancel. See `tasks.rs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReaperMode {
    Off,
    /// Our own read tasks that nothing in this core is waiting for any more.
    Orphans,
    /// …and our own read tasks running longer than ES_TASK_MAX_SECONDS.
    Overdue,
}

impl ReaperMode {
    pub fn parse(s: &str) -> Option<ReaperMode> {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" => Some(ReaperMode::Off),
            "orphans" => Some(ReaperMode::Orphans),
            "overdue" => Some(ReaperMode::Overdue),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            ReaperMode::Off => "off",
            ReaperMode::Orphans => "orphans",
            ReaperMode::Overdue => "overdue",
        }
    }
}

/// Everything about how the core goes to Elasticsearch, as one value: the gate's limits
/// plus the read cache, the response caps and the task reaper.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestConfig {
    pub limits: Limits,
    /// ES_READ_CACHE_SECONDS; 0 is off.
    pub read_cache_secs: u64,
    /// ES_READ_CACHE_MB, never more than the memory budget's share for it.
    pub read_cache_bytes: u64,
    /// ES_MAX_RESPONSE_MB: the largest answer a page's request may bring back.
    pub max_response_bytes: u64,
    /// ES_MAX_FLEET_RESPONSE_MB: the same for the poller's datasets, which are fleet-wide
    /// listings and legitimately larger.
    pub max_fleet_response_bytes: u64,
    /// Response bytes being read at once, every request together (memory budget).
    pub inflight_bytes: u64,
    pub task_reaper: ReaperMode,
    /// ES_TASK_MAX_SECONDS, for `overdue`.
    pub task_max_secs: u64,
    /// ZABBIX_CONCURRENCY: Zabbix API calls open at once.
    pub zabbix_concurrency: usize,
}

const MB: u64 = 1024 * 1024;
/// The largest single answer the read cache keeps. Bigger ones are read afresh each time:
/// they are rare, and keeping them would crowd out everything else.
pub const READ_CACHE_ENTRY_MAX: u64 = 4 * MB;

impl RequestConfig {
    pub fn from_env() -> RequestConfig {
        let mem = crate::memory::budget();
        let mb = |k: &str, d: u64| env_u64(k).unwrap_or(d).saturating_mul(MB);
        RequestConfig {
            limits: Limits::from_env(),
            read_cache_secs: env_u64("ELASTICPRO_ES_READ_CACHE_SECONDS").unwrap_or(5).min(300),
            read_cache_bytes: mb("ELASTICPRO_ES_READ_CACHE_MB", 64).min(mem.read_cache_bytes as u64),
            max_response_bytes: mb("ELASTICPRO_ES_MAX_RESPONSE_MB", 64).max(MB),
            max_fleet_response_bytes: mb("ELASTICPRO_ES_MAX_FLEET_RESPONSE_MB", 256).max(MB),
            inflight_bytes: (mem.inflight_bytes as u64).max(MB),
            task_reaper: std::env::var("ELASTICPRO_ES_TASK_REAPER").ok().and_then(|v| ReaperMode::parse(&v)).unwrap_or(ReaperMode::Orphans),
            task_max_secs: env_u64("ELASTICPRO_ES_TASK_MAX_SECONDS").unwrap_or(300).clamp(30, 86_400),
            zabbix_concurrency: env_u64("ELASTICPRO_ZABBIX_CONCURRENCY").unwrap_or(4).clamp(1, 64) as usize,
        }
    }
}

/// The process's request configuration, read once.
pub fn config() -> &'static RequestConfig {
    static C: OnceLock<RequestConfig> = OnceLock::new();
    C.get_or_init(RequestConfig::from_env)
}

/// The gate's limits as configured — what the poller's policy is clamped under.
pub fn limits() -> &'static Limits {
    &config().limits
}

/* ------------------------------------ the bookkeeping ------------------------------------ */

/// One request asking for a slot.
#[derive(Clone, Debug)]
pub struct Ticket {
    pub class: Class,
    pub cluster: String,
    pub via: Option<String>,
    pub user: Option<String>,
    /// When to give up waiting. `None` waits as long as it takes (the poller, the core).
    pub deadline_ms: Option<u64>,
}

/// Why a request was not given a slot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Too many already waiting: everybody's (`scope` "queue") or this person's ("user").
    Overloaded { retry_after_ms: u64, scope: &'static str },
    /// Waited until its deadline without a slot.
    QueueTimeout { waited_ms: u64 },
}

impl Refusal {
    pub fn kind(&self) -> &'static str {
        match self {
            Refusal::Overloaded { .. } => "overloaded",
            Refusal::QueueTimeout { .. } => "queue_timeout",
        }
    }

    /// The reply, as an ordinary failed ES answer: `errors::stamp` gives it its code.
    pub fn reply(&self, cluster: &str, l: &Limits) -> Value {
        match self {
            Refusal::Overloaded { retry_after_ms, scope } => json!({
                "ok": false, "status": 0, "kind": "overloaded", "tookMs": 0, "retryAfterMs": retry_after_ms,
                "message": if *scope == "user" {
                    format!("ElasticPro is holding {} of your requests already; try again in {:.1} s", l.queue_per_user, *retry_after_ms as f64 / 1000.0)
                } else {
                    format!("ElasticPro is busy: {} requests are already waiting for a cluster; try again in {:.1} s", l.queue_max, *retry_after_ms as f64 / 1000.0)
                },
                "help": "Nothing was sent to the cluster. The limits are ES_QUEUE_MAX and ES_QUEUE_PER_USER in config.txt.",
                "cluster": cluster,
            }),
            Refusal::QueueTimeout { waited_ms } => json!({
                "ok": false, "status": 0, "kind": "queue_timeout", "tookMs": waited_ms, "queuedMs": waited_ms,
                "message": format!("waited {:.1} s for a free connection to {cluster} and got none; nothing was sent", *waited_ms as f64 / 1000.0),
                "help": "Every connection ElasticPro may open (ES_CONCURRENCY, ES_PER_CLUSTER, ES_PER_JUMP_HOST) was busy. The Request Centre shows what holds them.",
                "cluster": cluster,
            }),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    Granted,
    Queued,
    Refused(Refusal),
}

#[derive(Debug)]
struct Waiting {
    id: u64,
    t: Ticket,
    since: u64,
}

#[derive(Debug)]
struct Running {
    class: Class,
    cluster: String,
    via: Option<String>,
}

/// The gate's state. See the module comment for the rules.
#[derive(Debug)]
pub struct GateState {
    limits: Limits,
    /// In arrival order.
    waiting: Vec<Waiting>,
    running: HashMap<u64, Running>,
    by_cluster: HashMap<String, usize>,
    by_jump: HashMap<String, usize>,
    /// Running requests that are not background — what the reserve is measured against.
    foreground: usize,
    /// Per class, the cluster served last, for the round-robin.
    rr: [Option<String>; 3],
}

impl GateState {
    pub fn new(limits: Limits) -> GateState {
        GateState {
            limits: limits.normalised(),
            waiting: Vec::new(),
            running: HashMap::new(),
            by_cluster: HashMap::new(),
            by_jump: HashMap::new(),
            foreground: 0,
            rr: [None, None, None],
        }
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// New limits apply to the next grant; what is running keeps running.
    pub fn set_limits(&mut self, l: Limits, now: u64) -> Vec<u64> {
        self.limits = l.normalised();
        self.pump(now)
    }

    /// Ask for a slot. Besides the answer, the ids of any other waiters granted on the way
    /// (none, unless limits changed underneath).
    pub fn admit(&mut self, id: u64, t: Ticket, now: u64) -> (Admission, Vec<u64>) {
        let class = t.class;
        let user = t.user.clone();
        let deadline = t.deadline_ms;
        self.waiting.push(Waiting { id, t, since: now });
        let mut granted = self.pump(now);
        if let Some(i) = granted.iter().position(|g| *g == id) {
            granted.remove(i);
            return (Admission::Granted, granted);
        }
        // It would have to wait. Only a person's request is bounded; see the module comment.
        if class == Class::Interactive {
            let queued = self.waiting.iter().filter(|w| w.id != id && w.t.class == Class::Interactive);
            let (all, mine) = queued.fold((0usize, 0usize), |(a, m), w| (a + 1, m + usize::from(w.t.user == user)));
            let refuse = if all >= self.limits.queue_max {
                Some("queue")
            } else if mine >= self.limits.queue_per_user {
                Some("user")
            } else {
                None
            };
            if let Some(scope) = refuse {
                self.remove_waiting(id);
                return (Admission::Refused(Refusal::Overloaded { retry_after_ms: retry_after(all), scope }), granted);
            }
            if deadline.is_some_and(|d| d <= now) {
                self.remove_waiting(id);
                return (Admission::Refused(Refusal::QueueTimeout { waited_ms: 0 }), granted);
            }
        }
        (Admission::Queued, granted)
    }

    /// A running request is done. Returns who was granted the freed slot(s).
    pub fn release(&mut self, id: u64, now: u64) -> Vec<u64> {
        if let Some(r) = self.running.remove(&id) {
            dec(&mut self.by_cluster, &r.cluster);
            if let Some(v) = &r.via {
                dec(&mut self.by_jump, v);
            }
            if r.class != Class::Background {
                self.foreground -= 1;
            }
        }
        self.pump(now)
    }

    /// The asker went away: out of the queue if it was waiting, its slot back if it had one.
    pub fn cancel(&mut self, id: u64, now: u64) -> Vec<u64> {
        if self.remove_waiting(id) {
            return self.pump(now);
        }
        self.release(id, now)
    }

    /// Waiters past their deadline, taken out of the queue. The async side tells each its
    /// answer; this is its backstop, run by the reaper.
    pub fn expire(&mut self, now: u64) -> Vec<u64> {
        let gone: Vec<u64> = self.waiting.iter().filter(|w| w.t.deadline_ms.is_some_and(|d| d <= now)).map(|w| w.id).collect();
        self.waiting.retain(|w| !gone.contains(&w.id));
        gone
    }

    pub fn is_running(&self, id: u64) -> bool {
        self.running.contains_key(&id)
    }

    pub fn is_waiting(&self, id: u64) -> bool {
        self.waiting.iter().any(|w| w.id == id)
    }

    pub fn running_count(&self) -> usize {
        self.running.len()
    }

    pub fn waiting_count(&self) -> usize {
        self.waiting.len()
    }

    fn remove_waiting(&mut self, id: u64) -> bool {
        match self.waiting.iter().position(|w| w.id == id) {
            Some(i) => {
                self.waiting.remove(i);
                true
            }
            None => false,
        }
    }

    fn effective(&self, w: &Waiting, now: u64) -> Class {
        let steps = now.saturating_sub(w.since).checked_div(self.limits.promote_after_ms).unwrap_or(0);
        (0..steps.min(2)).fold(w.t.class, |c, _| c.up())
    }

    fn fits(&self, w: &Waiting) -> bool {
        let l = &self.limits;
        if self.running.len() >= l.global {
            return false;
        }
        if w.t.class != Class::Background && self.foreground >= l.global - l.background_reserve {
            return false;
        }
        if self.by_cluster.get(&w.t.cluster).copied().unwrap_or(0) >= l.per_cluster {
            return false;
        }
        w.t.via.as_ref().is_none_or(|v| self.by_jump.get(v).copied().unwrap_or(0) < l.per_jump)
    }

    /// The next waiter to run, if any fits: the highest effective class with a waiter that
    /// fits; in it, the next cluster after the one served last (by name, wrapping), and that
    /// cluster's oldest waiter.
    fn pick(&self, now: u64) -> Option<usize> {
        for class in Class::ALL {
            let last = self.rr[class.idx()].as_deref();
            let mut after: Option<(usize, &Waiting)> = None;
            let mut wrap: Option<(usize, &Waiting)> = None;
            // Lowest cluster name first, then oldest: "next cluster, its oldest waiter".
            let better = |cur: Option<(usize, &Waiting)>, w: &Waiting| -> bool {
                cur.is_none_or(|(_, b)| (w.t.cluster.as_str(), w.since, w.id) < (b.t.cluster.as_str(), b.since, b.id))
            };
            for (i, w) in self.waiting.iter().enumerate() {
                if self.effective(w, now) != class || !self.fits(w) {
                    continue;
                }
                if last.is_none_or(|l| w.t.cluster.as_str() > l) && better(after, w) {
                    after = Some((i, w));
                }
                if better(wrap, w) {
                    wrap = Some((i, w));
                }
            }
            if let Some((i, _)) = after.or(wrap) {
                return Some(i);
            }
        }
        None
    }

    fn pump(&mut self, now: u64) -> Vec<u64> {
        let mut out = Vec::new();
        while let Some(i) = self.pick(now) {
            let class = self.effective(&self.waiting[i], now);
            let w = self.waiting.remove(i);
            self.rr[class.idx()] = Some(w.t.cluster.clone());
            *self.by_cluster.entry(w.t.cluster.clone()).or_default() += 1;
            if let Some(v) = &w.t.via {
                *self.by_jump.entry(v.clone()).or_default() += 1;
            }
            if w.t.class != Class::Background {
                self.foreground += 1;
            }
            self.running.insert(w.id, Running { class: w.t.class, cluster: w.t.cluster, via: w.t.via });
            out.push(w.id);
        }
        out
    }

    /// What is running and waiting, by class and by cluster, and how long the oldest waiter
    /// has waited. `visible` narrows the per-cluster maps (a scoped admin sees their own).
    pub fn snapshot(&self, now: u64, visible: Option<&std::collections::HashSet<String>>) -> Value {
        let sees = |c: &str| visible.is_none_or(|v| v.contains(c));
        let mut running = [0usize; 3];
        let mut queued = [0usize; 3];
        let mut run_c: Map<String, Value> = Map::new();
        let mut wait_c: Map<String, Value> = Map::new();
        let bump = |m: &mut Map<String, Value>, k: &str| {
            let n = m.get(k).and_then(Value::as_u64).unwrap_or(0) + 1;
            m.insert(k.to_string(), json!(n));
        };
        for r in self.running.values() {
            running[r.class.idx()] += 1;
            if sees(&r.cluster) {
                bump(&mut run_c, &r.cluster);
            }
        }
        for w in &self.waiting {
            queued[w.t.class.idx()] += 1;
            if sees(&w.t.cluster) {
                bump(&mut wait_c, &w.t.cluster);
            }
        }
        let by = |a: [usize; 3]| json!({ "interactive": a[0], "prompted": a[1], "background": a[2], "total": a.iter().sum::<usize>() });
        json!({
            "running": by(running),
            "queued": by(queued),
            "runningByCluster": run_c,
            "queuedByCluster": wait_c,
            "oldestWaitMs": self.waiting.iter().map(|w| now.saturating_sub(w.since)).max().unwrap_or(0),
        })
    }
}

fn dec(m: &mut HashMap<String, usize>, k: &str) {
    if let Some(n) = m.get_mut(k) {
        *n -= 1;
        if *n == 0 {
            m.remove(k);
        }
    }
}

/// How long an overloaded caller should wait before asking again: a second, plus a little
/// for every request ahead of it, never more than ten.
pub fn retry_after(queued: usize) -> u64 {
    (1_000 + 50 * queued as u64).min(10_000)
}

/* ------------------------------------- the async side ------------------------------------- */

/// What the Request Centre reports over the last five minutes.
pub const STATS_WINDOW_MS: u64 = 5 * 60_000;
const STATS_KEEP: usize = 50_000;

#[derive(Default)]
struct Stats {
    /// (when, class, waited ms) for every grant, immediate ones included.
    waits: VecDeque<(u64, Class, u64)>,
    refusals: VecDeque<(u64, &'static str)>,
    shared: VecDeque<u64>,
    /// (when, bytes)
    cached: VecDeque<(u64, u64)>,
}

fn trim<T>(q: &mut VecDeque<T>, now: u64, at: impl Fn(&T) -> u64) {
    while q.front().is_some_and(|x| now.saturating_sub(at(x)) > STATS_WINDOW_MS) || q.len() > STATS_KEEP {
        q.pop_front();
    }
}

fn percentile(sorted: &[u64], p: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    Some(sorted[i.min(sorted.len() - 1)])
}

struct Inner {
    state: GateState,
    next: u64,
    wake: HashMap<u64, oneshot::Sender<()>>,
}

/// The gate as async callers use it.
pub struct Gate {
    inner: Mutex<Inner>,
    stats: Mutex<Stats>,
    epoch: Instant,
}

/// A slot. Given back when dropped.
pub struct Permit {
    gate: Arc<Gate>,
    id: u64,
    pub class: Class,
    /// How long it waited for the slot.
    pub queued_ms: u64,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.gate.leave(self.id);
    }
}

/// A place in the queue. Dropping it — the future it lives in was dropped — leaves the
/// queue, or hands back a slot that was granted in the same instant.
struct Seat<'a> {
    gate: &'a Gate,
    id: u64,
    armed: bool,
}

impl Drop for Seat<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.gate.leave(self.id);
        }
    }
}

impl Gate {
    pub fn new(limits: Limits) -> Arc<Gate> {
        Arc::new(Gate {
            inner: Mutex::new(Inner { state: GateState::new(limits), next: 0, wake: HashMap::new() }),
            stats: Mutex::new(Stats::default()),
            epoch: Instant::now(),
        })
    }

    pub fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    pub fn limits(&self) -> Limits {
        self.inner.lock().state.limits().clone()
    }

    pub fn set_limits(&self, l: Limits) {
        let now = self.now_ms();
        let mut g = self.inner.lock();
        let granted = g.state.set_limits(l, now);
        wake(&mut g, granted);
    }

    /// Wait for a slot, or be told why not. `wait` is how long to wait at most (`None`:
    /// as long as it takes).
    pub async fn admit(self: &Arc<Self>, class: Class, cluster: &str, via: Option<&str>, user: Option<&str>, wait: Option<Duration>) -> Result<Permit, Refusal> {
        let start = self.now_ms();
        let t = Ticket {
            class,
            cluster: cluster.to_string(),
            via: via.map(String::from),
            user: user.map(String::from),
            deadline_ms: wait.map(|w| start + w.as_millis() as u64),
        };
        let (id, adm, rx) = {
            let mut g = self.inner.lock();
            g.next += 1;
            let id = g.next;
            let (adm, others) = g.state.admit(id, t, start);
            wake(&mut g, others);
            let rx = if adm == Admission::Queued {
                let (tx, rx) = oneshot::channel();
                g.wake.insert(id, tx);
                Some(rx)
            } else {
                None
            };
            (id, adm, rx)
        };
        let granted = |queued_ms: u64| {
            self.note_wait(class, queued_ms);
            Ok(Permit { gate: self.clone(), id, class, queued_ms })
        };
        match (adm, rx) {
            (Admission::Granted, _) => granted(0),
            (Admission::Refused(r), _) => {
                self.note_refusal(r.kind());
                Err(r)
            }
            (Admission::Queued, Some(rx)) => {
                let mut seat = Seat { gate: self, id, armed: true };
                let got = match wait {
                    Some(w) => tokio::time::timeout(w, rx).await.ok().and_then(Result::ok),
                    None => rx.await.ok(),
                };
                let waited = self.now_ms().saturating_sub(start);
                seat.armed = false;
                if got.is_some() {
                    return granted(waited);
                }
                // Timed out, or the reaper expired it. A grant may have landed in the same
                // instant: that slot is taken, not lost.
                let mut g = self.inner.lock();
                if g.state.is_running(id) {
                    drop(g);
                    return granted(waited);
                }
                let now = self.now_ms();
                let others = g.state.cancel(id, now);
                g.wake.remove(&id);
                wake(&mut g, others);
                drop(g);
                let r = Refusal::QueueTimeout { waited_ms: waited };
                self.note_refusal(r.kind());
                Err(r)
            }
            (Admission::Queued, None) => unreachable!("a queued admission always has a receiver"),
        }
    }

    /// Out of the queue, or the slot back; whichever applies.
    fn leave(&self, id: u64) {
        let now = self.now_ms();
        let mut g = self.inner.lock();
        g.wake.remove(&id);
        let granted = g.state.cancel(id, now);
        wake(&mut g, granted);
    }

    /// The reaper's backstop: waiters past their deadline are answered `queue_timeout`.
    pub fn expire(&self) -> usize {
        let now = self.now_ms();
        let mut g = self.inner.lock();
        let gone = g.state.expire(now);
        for id in &gone {
            // Dropping the sender wakes the waiter, which answers for itself.
            g.wake.remove(id);
        }
        gone.len()
    }

    pub fn note_wait(&self, class: Class, ms: u64) {
        let now = self.now_ms();
        let mut s = self.stats.lock();
        s.waits.push_back((now, class, ms));
        trim(&mut s.waits, now, |x| x.0);
    }

    pub fn note_refusal(&self, kind: &'static str) {
        let now = self.now_ms();
        let mut s = self.stats.lock();
        s.refusals.push_back((now, kind));
        trim(&mut s.refusals, now, |x| x.0);
    }

    pub fn note_shared(&self) {
        let now = self.now_ms();
        let mut s = self.stats.lock();
        s.shared.push_back(now);
        trim(&mut s.shared, now, |x| *x);
    }

    pub fn note_cached(&self, bytes: u64) {
        let now = self.now_ms();
        let mut s = self.stats.lock();
        s.cached.push_back((now, bytes));
        trim(&mut s.cached, now, |x| x.0);
    }

    /// Running and queued now, plus the last five minutes: waits (p50/p95 per class),
    /// refusals by kind, requests shared and answered from the cache.
    pub fn report(&self, visible: Option<&std::collections::HashSet<String>>) -> Value {
        let now = self.now_ms();
        let mut out = self.inner.lock().state.snapshot(now, visible);
        let mut s = self.stats.lock();
        trim(&mut s.waits, now, |x| x.0);
        trim(&mut s.refusals, now, |x| x.0);
        trim(&mut s.shared, now, |x| *x);
        trim(&mut s.cached, now, |x| x.0);
        let mut waits = Map::new();
        for c in Class::ALL {
            let mut v: Vec<u64> = s.waits.iter().filter(|w| w.1 == c).map(|w| w.2).collect();
            v.sort_unstable();
            waits.insert(c.as_str().into(), json!({ "count": v.len(), "p50Ms": percentile(&v, 0.5), "p95Ms": percentile(&v, 0.95) }));
        }
        let refused = |k: &str| s.refusals.iter().filter(|r| r.1 == k).count();
        let m = out.as_object_mut().expect("the snapshot is an object");
        m.insert("windowMs".into(), json!(STATS_WINDOW_MS));
        m.insert("waits".into(), Value::Object(waits));
        m.insert("refused".into(), json!({ "overloaded": refused("overloaded"), "queueTimeout": refused("queue_timeout"), "total": s.refusals.len() }));
        m.insert("shared".into(), json!(s.shared.len()));
        m.insert("cacheHits".into(), json!(s.cached.len()));
        m.insert("cacheBytes".into(), json!(s.cached.iter().map(|c| c.1).sum::<u64>()));
        out
    }

    /// (running, waiting) right now. For tests and the load check.
    pub fn counts(&self) -> (usize, usize) {
        let g = self.inner.lock();
        (g.state.running_count(), g.state.waiting_count())
    }
}

fn wake(g: &mut Inner, ids: Vec<u64>) {
    for id in ids {
        if let Some(tx) = g.wake.remove(&id) {
            // A receiver that is gone was a waiter whose future was dropped in the same
            // instant; its seat hands the slot back.
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lim() -> Limits {
        Limits { global: 6, per_cluster: 2, per_jump: 3, background_reserve: 1, queue_max: 5, queue_per_user: 3, queue_wait_ms: 1000, max_timeout_ms: 5000, promote_after_ms: 30_000 }
    }

    fn t(class: Class, cluster: &str) -> Ticket {
        Ticket { class, cluster: cluster.into(), via: None, user: Some("ann".into()), deadline_ms: if class == Class::Interactive { Some(1_000_000) } else { None } }
    }

    fn admit(s: &mut GateState, id: u64, tk: Ticket, now: u64) -> Admission {
        s.admit(id, tk, now).0
    }

    #[test]
    fn caps_hold_per_cluster_per_jump_and_overall() {
        let mut s = GateState::new(lim());
        assert_eq!(admit(&mut s, 1, t(Class::Interactive, "a"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 2, t(Class::Interactive, "a"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 3, t(Class::Interactive, "a"), 0), Admission::Queued, "per cluster: 2");
        let via = |c: &str| Ticket { via: Some("j".into()), ..t(Class::Interactive, c) };
        assert_eq!(admit(&mut s, 4, via("b"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 5, via("c"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 6, via("d"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 7, via("e"), 0), Admission::Queued, "per jump host: 3");
        assert_eq!(s.running_count(), 5, "5 of 6 — the last is background's reserve");
        assert_eq!(admit(&mut s, 8, t(Class::Interactive, "f"), 0), Admission::Queued, "foreground stops at global - reserve");
        assert_eq!(admit(&mut s, 9, t(Class::Background, "g"), 0), Admission::Granted, "the reserve is background's");
        assert_eq!(admit(&mut s, 10, t(Class::Background, "h"), 0), Admission::Queued, "global: 6");
    }

    #[test]
    fn priority_goes_interactive_then_prompted_then_background() {
        let mut s = GateState::new(Limits { global: 1, background_reserve: 0, ..lim() });
        assert_eq!(admit(&mut s, 1, t(Class::Background, "x"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 2, t(Class::Background, "a"), 1), Admission::Queued);
        assert_eq!(admit(&mut s, 3, t(Class::Prompted, "b"), 2), Admission::Queued);
        assert_eq!(admit(&mut s, 4, t(Class::Interactive, "c"), 3), Admission::Queued);
        assert_eq!(s.release(1, 10), vec![4], "the person first, though they came last");
        assert_eq!(s.release(4, 11), vec![3]);
        assert_eq!(s.release(3, 12), vec![2]);
    }

    #[test]
    fn the_reserve_keeps_background_moving_under_a_page_storm() {
        let mut s = GateState::new(Limits { global: 3, background_reserve: 1, per_cluster: 3, ..lim() });
        for id in 1..=2 {
            assert_eq!(admit(&mut s, id, t(Class::Interactive, "a"), 0), Admission::Granted);
        }
        assert_eq!(admit(&mut s, 3, t(Class::Interactive, "b"), 0), Admission::Queued);
        assert_eq!(admit(&mut s, 4, t(Class::Background, "b"), 0), Admission::Granted, "interactive is waiting, but this slot is not theirs");
    }

    #[test]
    fn round_robin_across_clusters_within_a_class() {
        let mut s = GateState::new(Limits { global: 1, background_reserve: 0, per_cluster: 1, ..lim() });
        assert_eq!(admit(&mut s, 1, t(Class::Interactive, "z"), 0), Admission::Granted);
        // a burst for "a", then one each for "b" and "c"
        for (id, c) in [(2, "a"), (3, "a"), (4, "a"), (5, "b"), (6, "c")] {
            assert_eq!(admit(&mut s, id, Ticket { user: Some(format!("u{id}")), ..t(Class::Interactive, c) }, id), Admission::Queued);
        }
        let mut order = vec![];
        let mut cur = 1;
        for now in 10..15 {
            let g = s.release(cur, now);
            assert_eq!(g.len(), 1);
            cur = g[0];
            order.push(cur);
        }
        assert_eq!(order, vec![2, 5, 6, 3, 4], "a, b, c, a, a — not a, a, a, b, c");
    }

    #[test]
    fn a_full_queue_refuses_at_once_and_says_when_to_retry() {
        let mut s = GateState::new(Limits { global: 1, background_reserve: 0, queue_max: 2, queue_per_user: 2, ..lim() });
        assert_eq!(admit(&mut s, 1, t(Class::Interactive, "a"), 0), Admission::Granted);
        let u = |id: u64| Ticket { user: Some(format!("u{id}")), ..t(Class::Interactive, "a") };
        assert_eq!(admit(&mut s, 2, u(2), 0), Admission::Queued);
        assert_eq!(admit(&mut s, 3, u(3), 0), Admission::Queued);
        match admit(&mut s, 4, u(4), 0) {
            Admission::Refused(Refusal::Overloaded { retry_after_ms, scope }) => {
                assert_eq!(scope, "queue");
                assert_eq!(retry_after_ms, retry_after(2));
            }
            other => panic!("{other:?}"),
        }
        assert!(!s.is_waiting(4), "a refused request is not left in the queue");
        assert_eq!(admit(&mut s, 5, t(Class::Background, "a"), 0), Admission::Queued, "background never refuses");
        assert_eq!(admit(&mut s, 6, t(Class::Prompted, "a"), 0), Admission::Queued, "nor does the poller's prompted work");
    }

    #[test]
    fn one_person_cannot_take_the_whole_queue() {
        let mut s = GateState::new(Limits { global: 1, background_reserve: 0, queue_max: 10, queue_per_user: 2, ..lim() });
        assert_eq!(admit(&mut s, 1, t(Class::Interactive, "a"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 2, t(Class::Interactive, "a"), 0), Admission::Queued);
        assert_eq!(admit(&mut s, 3, t(Class::Interactive, "a"), 0), Admission::Queued);
        assert!(matches!(admit(&mut s, 4, t(Class::Interactive, "a"), 0), Admission::Refused(Refusal::Overloaded { scope: "user", .. })));
        let bob = Ticket { user: Some("bob".into()), ..t(Class::Interactive, "a") };
        assert_eq!(admit(&mut s, 5, bob, 0), Admission::Queued, "somebody else still gets in");
    }

    #[test]
    fn a_deadline_expires_the_waiter() {
        let mut s = GateState::new(Limits { global: 1, background_reserve: 0, ..lim() });
        assert_eq!(admit(&mut s, 1, t(Class::Interactive, "a"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 2, Ticket { deadline_ms: Some(500), ..t(Class::Interactive, "a") }, 0), Admission::Queued);
        assert_eq!(admit(&mut s, 3, t(Class::Background, "a"), 0), Admission::Queued);
        assert!(s.expire(499).is_empty());
        assert_eq!(s.expire(500), vec![2]);
        assert_eq!(s.release(1, 600), vec![3], "the expired waiter is gone; the next one gets the slot");
        assert!(matches!(admit(&mut s, 4, Ticket { deadline_ms: Some(600), ..t(Class::Interactive, "a") }, 600),
                         Admission::Refused(Refusal::QueueTimeout { .. })), "already past its deadline");
    }

    #[test]
    fn a_cancelled_waiter_leaves_and_the_slot_goes_to_the_right_next_waiter() {
        let mut s = GateState::new(Limits { global: 1, background_reserve: 0, ..lim() });
        assert_eq!(admit(&mut s, 1, t(Class::Interactive, "a"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 2, t(Class::Interactive, "a"), 1), Admission::Queued);
        assert_eq!(admit(&mut s, 3, t(Class::Prompted, "a"), 2), Admission::Queued);
        assert_eq!(admit(&mut s, 4, t(Class::Interactive, "a"), 3), Admission::Queued);
        assert!(s.cancel(2, 4).is_empty(), "cancelling a waiter frees nothing");
        assert!(!s.is_waiting(2));
        assert_eq!(s.release(1, 5), vec![4], "the remaining interactive one, not prompted");
        assert_eq!(s.cancel(4, 6), vec![3], "cancelling a running one hands its slot on");
    }

    #[test]
    fn a_long_wait_promotes_background_so_it_is_never_starved() {
        let mut s = GateState::new(Limits { global: 1, background_reserve: 0, ..lim() });
        assert_eq!(admit(&mut s, 1, t(Class::Interactive, "a"), 0), Admission::Granted);
        assert_eq!(admit(&mut s, 2, t(Class::Background, "b"), 0), Admission::Queued);
        assert_eq!(admit(&mut s, 3, t(Class::Prompted, "c"), 29_000), Admission::Queued);
        // 30 s in, background has aged to prompted: level with "c", and next in the round.
        assert_eq!(s.release(1, 30_000), vec![2]);
        assert_eq!(admit(&mut s, 4, t(Class::Background, "d"), 30_001), Admission::Queued);
        assert_eq!(admit(&mut s, 5, t(Class::Interactive, "e"), 89_000), Admission::Queued);
        // Both older waiters have aged to interactive by now: level with the person, and
        // served in the round with them rather than behind them.
        assert_eq!(s.release(2, 90_002), vec![3]);
        assert_eq!(s.release(3, 90_003), vec![4]);
    }

    #[test]
    fn snapshot_counts_by_class_and_cluster() {
        let mut s = GateState::new(Limits { global: 2, background_reserve: 0, ..lim() });
        admit(&mut s, 1, t(Class::Interactive, "a"), 0);
        admit(&mut s, 2, t(Class::Background, "b"), 0);
        admit(&mut s, 3, t(Class::Interactive, "a"), 100);
        let v = s.snapshot(400, None);
        assert_eq!(v["running"]["total"], json!(2));
        assert_eq!(v["queued"]["interactive"], json!(1));
        assert_eq!(v["queuedByCluster"]["a"], json!(1));
        assert_eq!(v["oldestWaitMs"], json!(300));
        let only_b: std::collections::HashSet<String> = ["b".to_string()].into();
        assert!(s.snapshot(400, Some(&only_b))["queuedByCluster"].get("a").is_none());
    }

    #[test]
    fn limits_are_kept_consistent() {
        let l = Limits { global: 3, per_cluster: 9, per_jump: 0, background_reserve: 7, queue_max: 2, queue_per_user: 50, ..Limits::default() }.normalised();
        assert_eq!((l.per_cluster, l.per_jump, l.background_reserve, l.queue_per_user), (3, 1, 2, 2));
        assert_eq!(Limits::default().normalised(), Limits::default(), "the shipped values are already in bounds");
    }

    #[tokio::test]
    async fn an_async_waiter_gets_the_slot_when_it_is_released_and_leaves_when_dropped() {
        let g = Gate::new(Limits { global: 1, background_reserve: 0, ..lim() });
        let p = g.admit(Class::Interactive, "a", None, Some("ann"), Some(Duration::from_secs(5))).await.expect("free");
        let g2 = g.clone();
        let waiter = tokio::spawn(async move { g2.admit(Class::Interactive, "a", None, Some("bob"), Some(Duration::from_secs(5))).await.map(|p| p.queued_ms) });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(g.counts(), (1, 1));
        drop(p);
        let q = waiter.await.unwrap().expect("granted");
        assert!(q >= 40, "it waited: {q}");
        assert_eq!(g.counts(), (0, 0), "its permit was dropped with the task's result");

        let p = g.admit(Class::Interactive, "a", None, None, None).await.expect("free");
        let g3 = g.clone();
        let dropped = tokio::spawn(async move { let _ = g3.admit(Class::Interactive, "a", None, None, None).await; });
        tokio::time::sleep(Duration::from_millis(50)).await;
        dropped.abort();
        let _ = dropped.await;
        assert_eq!(g.counts(), (1, 0), "an abandoned waiter is out of the queue");
        drop(p);
        let r = g.admit(Class::Interactive, "a", None, None, Some(Duration::from_millis(1))).await;
        assert!(r.is_ok());
    }

    #[tokio::test]
    async fn an_async_waiter_past_its_deadline_is_told_queue_timeout() {
        let g = Gate::new(Limits { global: 1, background_reserve: 0, ..lim() });
        let _p = g.admit(Class::Background, "a", None, None, None).await.expect("free");
        let r = g.admit(Class::Interactive, "a", None, None, Some(Duration::from_millis(80))).await;
        assert!(matches!(r, Err(Refusal::QueueTimeout { waited_ms }) if waited_ms >= 70), "{:?}", r.err());
        assert_eq!(g.counts(), (1, 0));
        assert_eq!(g.report(None)["refused"]["queueTimeout"], json!(1));
    }
}
