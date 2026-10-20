//! Deciding what to fetch next. Pure bookkeeping over times in milliseconds, with no
//! I/O and no clock of its own, so every rule here — priority, limits, the unreachable
//! and idle rules, the boot spread — is tested by handing it a `now`.

use super::catalogue::{self, Class, Dataset, ALL};
use super::entry::{Body, Entry, Outcome, Reach, ReachState, Status};
use super::policy::{Mode, Policy, AUTO_HYBRID_ABOVE};
use std::collections::{HashMap, HashSet};
use tokio::sync::oneshot;

pub type Key = (String, Dataset);

/// Nothing asked for fleet state for this long: only health is polled.
pub const IDLE_MS: u64 = 10 * 60_000;
/// One person may ask for the same dataset of the same cluster once in this long.
pub const REFRESH_EVERY_MS: u64 = 10_000;
/// A write is followed by a re-read this long after it, so the cluster has applied it.
pub const AFTER_WRITE_MS: u64 = 3_000;

pub const PRIO_USER: u8 = 0;
pub const PRIO_DUE: u8 = 1;
pub const PRIO_BACKGROUND: u8 = 2;

/// The policy as the scheduler runs it: `Policy` resolved to numbers, plus the cache
/// bound, which is a property of this process rather than of the fleet.
#[derive(Clone, Debug)]
pub struct Config {
    pub mode: Mode,
    pub health_secs: u64,
    pub intervals: HashMap<Dataset, u64>,
    pub watch_ms: u64,
    pub timeout_ms: u64,
    pub tunnel_timeout_ms: u64,
    /// 0 = no cap.
    pub budget_per_min: u64,
    pub global: usize,
    pub per_cluster: usize,
    pub per_jump: usize,
    pub paused_all: bool,
    pub paused: HashSet<String>,
    /// Every body the cache holds, together, at most: `memory::budget().cache_bytes`.
    pub cache_bytes: usize,
}

impl Config {
    pub fn from_env() -> Config {
        Config::from_policy(&Policy::shipped())
    }

    pub fn from_policy(p: &Policy) -> Config {
        let p = p.clone().normalised();
        Config {
            mode: p.mode,
            health_secs: p.interval_secs(Dataset::Health),
            intervals: ALL.iter().map(|d| (*d, p.interval_secs(*d))).collect(),
            watch_ms: p.watch_minutes * 60_000,
            timeout_ms: p.timeout_ms,
            tunnel_timeout_ms: p.tunnel_timeout_ms,
            budget_per_min: p.budget_per_cluster_per_min,
            global: p.concurrency.global,
            per_cluster: p.concurrency.per_cluster,
            per_jump: p.concurrency.tunnel,
            paused_all: p.paused.all,
            paused: p.paused.clusters.iter().cloned().collect(),
            cache_bytes: crate::memory::budget().cache_bytes,
        }
    }

    pub fn interval(&self, ds: Dataset) -> u64 {
        self.intervals.get(&ds).copied().unwrap_or_else(|| ds.default_interval_secs(self.health_secs))
    }

    pub fn stale_after_ms(&self, ds: Dataset) -> u64 {
        ds.stale_after_ms(self.interval(ds))
    }

    /// The mode actually running for a core that knows `clusters` clusters: `auto` is
    /// background for a small fleet and hybrid above `AUTO_HYBRID_ABOVE`; any other mode
    /// is itself. Never `Auto`.
    pub fn resolved_mode(&self, clusters: usize) -> Mode {
        match self.mode {
            Mode::Auto if clusters > AUTO_HYBRID_ABOVE => Mode::Hybrid,
            Mode::Auto => Mode::Background,
            m => m,
        }
    }

    /// How the mode treats a dataset: fetched on the schedule, or only while watched.
    pub fn effective_class(&self, ds: Dataset, clusters: usize) -> Class {
        match self.resolved_mode(clusters) {
            Mode::Auto | Mode::Background => ds.class(),
            Mode::Hybrid if ds == Dataset::Health => Class::Background,
            Mode::Hybrid | Mode::OnDemand => Class::OnDemand,
        }
    }

    pub fn cluster_paused(&self, id: &str) -> bool {
        self.paused_all || self.paused.contains(id)
    }
}

/// A cluster the poller is holding back from, and why. `Budget`: it had its minute's worth
/// of requests, so due fetches wait for the window to pass. `Backoff`: it answered 429 or
/// timed out, so it is left alone for a minute, doubling each time, up to ten. A person's
/// ask still goes either way — the cap is on the poller's own appetite.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Throttle {
    pub kind: ThrottleKind,
    pub until: u64,
    pub reason: String,
    pub level: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThrottleKind {
    Budget,
    Backoff,
}

pub const BACKOFF_FIRST_MS: u64 = 60_000;
pub const BACKOFF_MAX_MS: u64 = 10 * 60_000;
pub const BUDGET_WINDOW_MS: u64 = 60_000;

/// What the planner needs to know about a cluster.
#[derive(Clone, Debug)]
pub struct SpecLite {
    pub id: String,
    pub via: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Candidate {
    pub prio: u8,
    pub due: u64,
    pub cluster: String,
    pub dataset: Dataset,
}

#[derive(Default)]
pub struct State {
    pub seq: u64,
    pub entries: HashMap<Key, Entry>,
    pub reach: HashMap<String, Reach>,
    /// Last time somebody asked for an on-demand dataset.
    pub watched: HashMap<Key, u64>,
    /// Asked for by a person (or made stale by a write): run at priority 0, not before.
    pub pending: HashMap<Key, u64>,
    /// Running now, with the jump host each goes through, so finishing can give back
    /// that jump host's slot.
    pub inflight: HashMap<Key, Option<String>>,
    pub waiters: HashMap<Key, Vec<oneshot::Sender<()>>>,
    pub running: usize,
    pub running_cluster: HashMap<String, usize>,
    pub running_jump: HashMap<String, usize>,
    /// When a cluster's datasets first come due, from the boot spread.
    pub first_due: HashMap<String, u64>,
    pub last_activity: u64,
    /// Whether any cluster has been known yet. Until one is, nothing is pruned: the
    /// desktop app starts unprimed, and its restored cache must survive until it is.
    pub seen_clusters: bool,
    pub refresh_rl: HashMap<(String, String, Dataset), u64>,
    /// Clusters the poller is holding back from; see `Throttle`.
    pub throttle: HashMap<String, Throttle>,
    /// When the poller started fetches on each cluster in the budget window, with the
    /// number of requests each fetch costs — the dataset's query count, so a repository
    /// listing counts as one though it fans out per repository; an estimate, said so.
    pub starts: HashMap<String, std::collections::VecDeque<(u64, u64)>>,
}

/// What `State::housekeep` removed (or, on a dry run, would).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct StateSweep {
    pub throttles: usize,
    pub budget_windows: usize,
    pub watched: usize,
    pub refresh_limits: usize,
    pub running_counters: usize,
}

/// Whether a failure is the cluster asking to be left alone: 429, or a timeout.
pub fn backoff_reason(err: &serde_json::Value) -> Option<&'static str> {
    if err.get("status").and_then(serde_json::Value::as_u64) == Some(429) {
        return Some("the cluster answered 429 Too Many Requests");
    }
    let kind = err.get("kind").and_then(serde_json::Value::as_str).unwrap_or("");
    let msg = err.get("message").and_then(serde_json::Value::as_str).unwrap_or("");
    if kind == "timeout" || msg.to_ascii_lowercase().contains("timed out") || msg.to_ascii_lowercase().contains("timeout") {
        return Some("the request timed out");
    }
    None
}

impl State {
    /// Leave a cluster alone for a minute, doubling each time it happens again, up to ten.
    pub fn back_off(&mut self, cluster: &str, now: u64, why: &str) {
        let level = match self.throttle.get(cluster) {
            Some(t) if t.kind == ThrottleKind::Backoff => t.level + 1,
            _ => 1,
        };
        let wait = (BACKOFF_FIRST_MS << (level - 1).min(4)).min(BACKOFF_MAX_MS);
        self.throttle.insert(cluster.to_string(), Throttle {
            kind: ThrottleKind::Backoff, until: now + wait, level,
            reason: format!("{why}; backing off {} s", wait / 1000),
        });
    }

    pub fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    pub fn reach_state(&self, cluster: &str) -> ReachState {
        self.reach.get(cluster).map(|r| r.state).unwrap_or(ReachState::Unknown)
    }

    pub fn idle(&self, now: u64) -> bool {
        now.saturating_sub(self.last_activity) > IDLE_MS
    }

    /// Ask for a dataset at priority 0, no earlier than `at`. An earlier ask wins.
    pub fn request(&mut self, key: Key, at: u64) {
        let e = self.pending.entry(key).or_insert(at);
        *e = (*e).min(at);
    }

    /// Ask for a dataset that somebody is holding a request open for: at priority 0 and
    /// ahead of every other ask. A Refresh on a large fleet queues hundreds of fetches at
    /// priority 0; a page waiting on one answer behind them waited out its whole timeout,
    /// and then showed "still being fetched" for the length of the backlog.
    pub fn request_first(&mut self, key: Key) {
        self.request(key, 0);
    }

    /// Everything due now, best first. Assigns the boot spread to clusters seen for the
    /// first time, which is the only thing it changes.
    pub fn plan(&mut self, specs: &[SpecLite], now: u64, backing_off: &HashSet<String>, cfg: &Config) -> Vec<Candidate> {
        let mut new: Vec<&str> = specs.iter().map(|s| s.id.as_str()).filter(|id| !self.first_due.contains_key(*id)).collect();
        new.sort();
        let n = new.len();
        for (i, id) in new.into_iter().enumerate() {
            self.first_due.insert(id.to_string(), now + catalogue::boot_offset_ms(i, n));
        }
        let idle = self.idle(now);
        let mut out = vec![];
        // Paused: nothing new starts, a person's ask included — it stays pending and runs
        // when the pause is lifted. What is in flight finishes on its own.
        if cfg.paused_all {
            return out;
        }
        self.throttle.retain(|_, t| t.until > now);
        let throttled: HashSet<&str> = self.throttle.keys().map(String::as_str).collect();
        let clusters = specs.len();
        for s in specs {
            if cfg.paused.contains(&s.id) {
                continue;
            }
            let unreachable = self.reach_state(&s.id) == ReachState::Unreachable;
            let via_down = s.via.as_ref().is_some_and(|v| backing_off.contains(v));
            let first = self.first_due.get(&s.id).copied().unwrap_or(now);
            for ds in ALL {
                let key = (s.id.clone(), ds);
                if self.inflight.contains_key(&key) {
                    continue;
                }
                // A person asked. Still only health for a cluster that does not answer:
                // the request stays pending and runs once it does.
                if let Some(at) = self.pending.get(&key) {
                    if *at <= now && (!unreachable || ds == Dataset::Health) {
                        out.push(Candidate { prio: PRIO_USER, due: *at, cluster: s.id.clone(), dataset: ds });
                        continue;
                    }
                }
                // The tunnel says so itself, and every request through it would fail fast.
                if via_down {
                    continue;
                }
                // Held back (budget spent, or backing off after a 429 / timeout): the poller
                // waits; the person's ask above has already gone through.
                if throttled.contains(s.id.as_str()) {
                    continue;
                }
                let entry = self.entries.get(&key);
                let on_demand = cfg.effective_class(ds, clusters) == Class::OnDemand;
                let (prio, due) = if unreachable {
                    // Probing a cluster that is down is the poller going there on its own,
                    // which under on-demand it never does: health comes back when asked.
                    if ds != Dataset::Health || on_demand {
                        continue;
                    }
                    (PRIO_BACKGROUND, self.reach.get(&s.id).and_then(|r| r.next_probe_at).unwrap_or(now))
                } else if idle && ds != Dataset::Health {
                    continue;
                } else if on_demand {
                    let watched = self.watched.get(&key).is_some_and(|t| now.saturating_sub(*t) < cfg.watch_ms);
                    if !watched || entry.is_none() {
                        continue;
                    }
                    (PRIO_DUE, entry.and_then(|e| e.next_due).unwrap_or(now))
                } else {
                    (PRIO_BACKGROUND, entry.and_then(|e| e.next_due).unwrap_or(0).max(first))
                };
                if due <= now {
                    out.push(Candidate { prio, due, cluster: s.id.clone(), dataset: ds });
                }
            }
        }
        out.sort();
        out
    }

    /// The candidates the limits allow to start now, marked as running.
    pub fn take(&mut self, cands: Vec<Candidate>, specs: &[SpecLite], cfg: &Config, now: u64) -> Vec<Candidate> {
        let via: HashMap<&str, Option<&String>> = specs.iter().map(|s| (s.id.as_str(), s.via.as_ref())).collect();
        let mut out = vec![];
        for c in cands {
            if self.running >= cfg.global {
                break;
            }
            let key = (c.cluster.clone(), c.dataset);
            if self.inflight.contains_key(&key) {
                continue;
            }
            // The budget: the poller's own fetches wait once a cluster has had its minute's
            // worth; a person's ask goes anyway, which is why the cap is soft.
            let cost = (c.dataset.queries(None).len() as u64).max(1);
            if cfg.budget_per_min > 0 && c.prio != PRIO_USER {
                let q = self.starts.entry(c.cluster.clone()).or_default();
                while q.front().is_some_and(|(t, _)| now.saturating_sub(*t) >= BUDGET_WINDOW_MS) {
                    q.pop_front();
                }
                let spent: u64 = q.iter().map(|(_, n)| n).sum();
                if spent + cost > cfg.budget_per_min {
                    let until = q.front().map(|(t, _)| t + BUDGET_WINDOW_MS).unwrap_or(now + BUDGET_WINDOW_MS);
                    self.throttle.entry(c.cluster.clone()).or_insert(Throttle {
                        kind: ThrottleKind::Budget, until, level: 0,
                        reason: format!("budget: {spent} requests in the last minute, the policy allows {}", cfg.budget_per_min),
                    });
                    continue;
                }
            }
            if self.running_cluster.get(&c.cluster).copied().unwrap_or(0) >= cfg.per_cluster {
                continue;
            }
            let v = via.get(c.cluster.as_str()).copied().flatten();
            if let Some(v) = v {
                if self.running_jump.get(v).copied().unwrap_or(0) >= cfg.per_jump {
                    continue;
                }
                *self.running_jump.entry(v.clone()).or_default() += 1;
            }
            *self.running_cluster.entry(c.cluster.clone()).or_default() += 1;
            self.running += 1;
            if c.prio == PRIO_USER {
                self.pending.remove(&key);
            }
            if cfg.budget_per_min > 0 {
                self.starts.entry(c.cluster.clone()).or_default().push_back((now, cost));
            }
            self.inflight.insert(key, v.cloned());
            out.push(c);
        }
        out
    }

    /// Record what a fetch produced. Returns the waiters to wake and whether reach
    /// changed, so the caller can announce both after letting go of the lock.
    pub fn complete(
        &mut self,
        key: &Key,
        outcome: Outcome,
        took_ms: u64,
        now: u64,
        cfg: &Config,
        rand: &mut dyn FnMut(u64) -> u64,
    ) -> (Vec<oneshot::Sender<()>>, bool) {
        let via = self.inflight.remove(key).flatten();
        self.running = self.running.saturating_sub(1);
        if let Some(n) = self.running_cluster.get_mut(&key.0) {
            *n = n.saturating_sub(1);
        }
        if let Some(n) = via.and_then(|v| self.running_jump.get_mut(&v)) {
            *n = n.saturating_sub(1);
        }
        let ds = key.1;
        let interval = cfg.interval(ds) * 1000;
        let seq = self.next_seq();
        let e = self.entries.entry(key.clone()).or_insert_with(|| Entry::never(cfg.stale_after_ms(ds), None));
        e.seq = seq;
        e.attempted_at = Some(now);
        e.took_ms = Some(took_ms);
        e.stale_after_ms = cfg.stale_after_ms(ds);
        let mut back_off: Option<&'static str> = None;
        let mut end_backoff = false;
        let (answered, err) = match outcome {
            Outcome::Answered(map) => {
                // Held as text from here on (see `Body`); the parsed map goes with this scope.
                e.data = Some(Body::from_value(&serde_json::Value::Object(map)));
                e.status = Status::Ok;
                e.fetched_at = Some(now);
                e.error = None;
                e.failures = 0;
                e.next_due = Some(now + rand(interval));
                end_backoff = true;
                (true, None)
            }
            Outcome::Failed(err) => {
                // The data and its fetchedAt stay what they were: the last good answer,
                // labelled with its own age.
                e.status = Status::Error;
                e.error = Some(err.clone());
                e.failures += 1;
                back_off = backoff_reason(&err);
                // Backing off, not hurrying: a cluster that timed out is not helped by
                // being asked again sooner. Up to four intervals.
                let k = 1u64 << (e.failures - 1).min(2);
                e.next_due = Some(now + rand(interval * k));
                (false, Some(err))
            }
        };
        // Decided while the entry was borrowed, applied now that it is not.
        if let Some(why) = back_off {
            self.back_off(&key.0, now, why);
        }
        // An answer ends a backoff; a spent budget runs out on its own.
        if end_backoff && self.throttle.get(&key.0).is_some_and(|t| t.kind == ThrottleKind::Backoff) {
            self.throttle.remove(&key.0);
        }
        let mut reach_changed = false;
        if ds == Dataset::Health {
            let r = self.reach.entry(key.0.clone()).or_default();
            if answered {
                let was = r.state;
                if was != ReachState::Reachable || r.failures > 0 {
                    reach_changed = true;
                }
                if was != ReachState::Reachable {
                    r.state = ReachState::Reachable;
                    r.since = Some(now);
                }
                r.failures = 0;
                r.last_error = None;
                r.next_probe_at = None;
                // Back from unreachable: everything it has is out of date, so all of it
                // comes due now rather than one interval after it was last read.
                if was == ReachState::Unreachable {
                    for d in ALL.iter().filter(|d| d.class() == Class::Background && **d != Dataset::Health) {
                        if let Some(x) = self.entries.get_mut(&(key.0.clone(), *d)) {
                            x.next_due = Some(now);
                        }
                    }
                }
            } else {
                reach_changed = true;
                if r.state != ReachState::Unreachable {
                    r.state = ReachState::Unreachable;
                    r.since = Some(now);
                }
                r.failures += 1;
                r.last_error = err;
                let probe = now + rand(catalogue::UNREACHABLE_PROBE_MS);
                r.next_probe_at = Some(probe);
                if let Some(x) = self.entries.get_mut(key) {
                    x.next_due = Some(probe);
                }
            }
            if reach_changed {
                let s = self.next_seq();
                if let Some(r) = self.reach.get_mut(&key.0) {
                    r.seq = s;
                }
            }
        }
        (self.waiters.remove(key).unwrap_or_default(), reach_changed)
    }

    /// What every entry costs together, by `Entry::cost`.
    pub fn total_cost(&self) -> usize {
        self.entries.values().map(Entry::cost).sum()
    }

    /// Bring the cache within `limit` bytes. Everything counts — the budget is what the
    /// process holds, and background bodies are most of it on a large fleet — but not
    /// everything goes first:
    ///   1. on-demand bodies (index and shard lists, verbose snapshots), least recently
    ///      read first, removed outright: nobody is looking, and asking again fetches it;
    ///   2. then background bodies other than health, the least recently read or fetched
    ///      first. The entry stays, with its schedule, as `never` and an `evicted` error
    ///      that says why: removing it would make it due at once and fetched straight back
    ///      into a cache that has no room for it.
    ///   3. Health never: it is a few hundred bytes a cluster, and it is what the overview,
    ///      the strip and Alerts are made of.
    ///
    /// Nothing in flight is touched. Returns how many background bodies went, which the
    /// caller reports: that means the budget is too small for the fleet.
    pub fn evict(&mut self, limit: usize) -> usize {
        let mut total = self.total_cost();
        if total <= limit {
            return 0;
        }
        let mut order: Vec<(u8, u64, Key)> = self
            .entries
            .iter()
            .filter(|(k, e)| k.1 != Dataset::Health && e.data.is_some() && !self.inflight.contains_key(*k))
            .map(|(k, e)| (u8::from(k.1.class() != Class::OnDemand), e.last_read.max(e.fetched_at.unwrap_or(0)), k.clone()))
            .collect();
        order.sort();
        let mut background = 0;
        for (rank, _, k) in order {
            if total <= limit {
                break;
            }
            if rank == 0 {
                if let Some(e) = self.entries.remove(&k) {
                    total = total.saturating_sub(e.cost());
                }
                continue;
            }
            let seq = self.next_seq();
            if let Some(e) = self.entries.get_mut(&k) {
                let freed = e.data.take().map_or(0, |b| b.len());
                total = total.saturating_sub(freed);
                e.status = Status::Never;
                e.fetched_at = None;
                e.seq = seq;
                e.error = Some(serde_json::json!({
                    "kind": "evicted",
                    "message": "dropped from the fleet cache to stay within its memory budget (ELASTICPRO_CACHE_MB, or a quarter of the container's limit); fetched again when due or when asked",
                    "query": k.1.name(),
                }));
                background += 1;
            }
        }
        background
    }

    /// Housekeeping: drop bookkeeping that can no longer matter — marks, limiters and counters
    /// of clusters that are not in `known` (when it is given), and entries whose time has
    /// passed. Nothing that holds a cached body or a pending ask is touched; `prune` and
    /// `evict` own those. With `dry_run` it only counts.
    pub fn housekeep(&mut self, known: Option<&HashSet<String>>, now: u64, watch_ms: u64, dry_run: bool) -> StateSweep {
        let gone = |c: &String| known.is_some_and(|k| !k.contains(c));
        let mut out = StateSweep::default();
        let throttles: Vec<String> = self.throttle.iter().filter(|(c, t)| gone(c) || t.until <= now).map(|(c, _)| c.clone()).collect();
        let windows: Vec<String> = self.starts.iter()
            .filter(|(c, q)| gone(c) || q.back().is_none_or(|(t, _)| now.saturating_sub(*t) >= BUDGET_WINDOW_MS))
            .map(|(c, _)| c.clone()).collect();
        let watched: Vec<Key> = self.watched.iter()
            .filter(|((c, _), t)| gone(c) || now.saturating_sub(**t) >= watch_ms)
            .map(|(k, _)| k.clone()).collect();
        let limits: Vec<(String, String, Dataset)> = self.refresh_rl.iter()
            .filter(|((_, c, _), t)| gone(c) || now.saturating_sub(**t) >= REFRESH_EVERY_MS)
            .map(|(k, _)| k.clone()).collect();
        let idle_counts = self.running_cluster.values().filter(|n| **n == 0).count()
            + self.running_jump.values().filter(|n| **n == 0).count();
        out.throttles = throttles.len();
        out.budget_windows = windows.len();
        out.watched = watched.len();
        out.refresh_limits = limits.len();
        out.running_counters = idle_counts;
        if !dry_run {
            for c in &throttles { self.throttle.remove(c); }
            for c in &windows { self.starts.remove(c); }
            for k in &watched { self.watched.remove(k); }
            for k in &limits { self.refresh_rl.remove(k); }
            self.running_cluster.retain(|_, n| *n > 0);
            self.running_jump.retain(|_, n| *n > 0);
        }
        out
    }

    /// Forget clusters that are no longer configured. Returns their ids.
    pub fn prune(&mut self, keep: &HashSet<String>) -> Vec<String> {
        let mut gone: HashSet<String> = HashSet::new();
        for (c, _) in self.entries.keys() {
            if !keep.contains(c) {
                gone.insert(c.clone());
            }
        }
        for c in self.reach.keys().chain(self.first_due.keys()) {
            if !keep.contains(c) {
                gone.insert(c.clone());
            }
        }
        if gone.is_empty() {
            return vec![];
        }
        self.entries.retain(|(c, _), _| keep.contains(c));
        self.reach.retain(|c, _| keep.contains(c));
        self.first_due.retain(|c, _| keep.contains(c));
        self.watched.retain(|(c, _), _| keep.contains(c));
        self.pending.retain(|(c, _), _| keep.contains(c));
        self.refresh_rl.retain(|(_, c, _), _| keep.contains(c));
        gone.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};

    fn cfg() -> Config {
        Config { cache_bytes: 1 << 20, ..Config::from_policy(&Policy::shipped()) }
    }
    fn with_mode(mode: Mode) -> Config {
        Config { mode, ..cfg() }
    }
    fn specs(n: usize) -> Vec<SpecLite> {
        (0..n).map(|i| SpecLite { id: format!("c{i:02}"), via: None }).collect()
    }
    fn same(x: u64) -> u64 {
        x
    }
    fn answered() -> Outcome {
        Outcome::Answered(Map::new())
    }
    fn failed() -> Outcome {
        Outcome::Failed(json!({ "kind": "connection_refused", "message": "refused" }))
    }
    fn active(now: u64) -> State {
        State { last_activity: now, ..State::default() }
    }

    #[test]
    fn new_clusters_are_spread_over_the_boot_window() {
        let mut st = active(0);
        let s = specs(4);
        let first = st.plan(&s, 0, &HashSet::new(), &cfg());
        // At t=0 only the first cluster is due.
        assert!(first.iter().all(|c| c.cluster == "c00"), "{first:?}");
        assert_eq!(first.len(), 6, "every background dataset of it: {first:?}");
        assert_eq!(st.first_due["c01"], 45_000);
        let later = st.plan(&s, 45_000, &HashSet::new(), &cfg());
        assert!(later.iter().any(|c| c.cluster == "c01"));
        assert!(!later.iter().any(|c| c.cluster == "c02"));
    }

    #[test]
    fn a_person_goes_first_then_due_then_background() {
        let mut st = active(1_000_000);
        let s = specs(1);
        st.first_due.insert("c00".into(), 0);
        // indices watched and due -> priority 1; nodes background -> 2; policies asked -> 0.
        st.entries.insert(("c00".into(), Dataset::Indices), Entry { next_due: Some(0), ..Entry::never(1, None) });
        st.watched.insert(("c00".into(), Dataset::Indices), 1_000_000);
        st.request(("c00".into(), Dataset::Policies), 999_000);
        let plan = st.plan(&s, 1_000_000, &HashSet::new(), &cfg());
        assert_eq!((plan[0].prio, plan[0].dataset), (PRIO_USER, Dataset::Policies));
        assert_eq!((plan[1].prio, plan[1].dataset), (PRIO_DUE, Dataset::Indices));
        assert!(plan[2..].iter().all(|c| c.prio == PRIO_BACKGROUND));
        // An unwatched on-demand dataset is never polled.
        assert!(!plan.iter().any(|c| c.dataset == Dataset::Shards));
    }

    #[test]
    fn somebody_waiting_goes_ahead_of_a_fleet_refresh() {
        let mut st = active(1_000_000);
        let s = specs(40);
        for x in &s {
            st.first_due.insert(x.id.clone(), 0);
            // A Refresh of the whole fleet, asked a while ago.
            for d in [Dataset::Health, Dataset::Nodes, Dataset::Policies] {
                st.request((x.id.clone(), d), 990_000);
            }
        }
        // Then a page opens one cluster's index list and waits for it.
        st.request_first(("c39".into(), Dataset::Indices));
        let plan = st.plan(&s, 1_000_000, &HashSet::new(), &cfg());
        assert_eq!((plan[0].prio, plan[0].cluster.as_str(), plan[0].dataset), (PRIO_USER, "c39", Dataset::Indices), "{:?}", &plan[..3]);
        let started = st.take(plan, &s, &cfg(), 0);
        assert!(started.iter().any(|c| c.cluster == "c39" && c.dataset == Dataset::Indices));
    }

    #[test]
    fn limits_hold_per_cluster_per_jump_and_globally() {
        let mut st = active(0);
        let mut s = specs(10);
        for x in s.iter_mut() {
            x.via = Some("jh".into());
        }
        for x in &s {
            st.first_due.insert(x.id.clone(), 0);
        }
        let plan = st.plan(&s, 0, &HashSet::new(), &cfg());
        let started = st.take(plan, &s, &cfg(), 0);
        assert_eq!(started.len(), 6, "per jump host 6");
        assert!(st.running_cluster.values().all(|n| *n <= 2));
        // A second pass starts nothing more through that jump host.
        let plan = st.plan(&s, 0, &HashSet::new(), &cfg());
        assert!(st.take(plan, &s, &cfg(), 0).is_empty());

        let mut st = active(0);
        let s = specs(20);
        for x in &s {
            st.first_due.insert(x.id.clone(), 0);
        }
        let plan = st.plan(&s, 0, &HashSet::new(), &cfg());
        let started = st.take(plan, &s, &cfg(), 0);
        assert_eq!(started.len(), 16, "global 16");
        assert!(st.running_cluster.values().all(|n| *n <= 2), "per cluster 2");
    }

    #[test]
    fn a_jump_host_backing_off_skips_its_clusters() {
        let mut st = active(0);
        let s = vec![SpecLite { id: "a".into(), via: Some("jh".into()) }, SpecLite { id: "b".into(), via: None }];
        st.first_due.insert("a".into(), 0);
        st.first_due.insert("b".into(), 0);
        let down: HashSet<String> = ["jh".to_string()].into();
        let plan = st.plan(&s, 0, &down, &cfg());
        assert!(plan.iter().all(|c| c.cluster == "b"));
    }

    #[test]
    fn an_unreachable_cluster_gets_only_health_every_two_minutes() {
        let mut st = active(0);
        let s = specs(1);
        st.first_due.insert("c00".into(), 0);
        let k = ("c00".to_string(), Dataset::Health);
        st.inflight.insert(k.clone(), None);
        st.running = 1;
        st.running_cluster.insert("c00".into(), 1);
        let (_, changed) = st.complete(&k, failed(), 5, 1_000, &cfg(), &mut catalogue::jittered_ms);
        assert!(changed);
        let r = &st.reach["c00"];
        assert_eq!(r.state, ReachState::Unreachable);
        let probe = r.next_probe_at.unwrap();
        assert!((1_000 + 108_000..=1_000 + 132_000).contains(&probe), "{probe}");
        // Before the probe: nothing at all. At it: health and nothing else — even though
        // every other background dataset has never been fetched.
        assert!(st.plan(&s, probe - 1, &HashSet::new(), &cfg()).is_empty());
        let plan = st.plan(&s, probe, &HashSet::new(), &cfg());
        assert_eq!(plan.iter().map(|c| c.dataset).collect::<Vec<_>>(), vec![Dataset::Health]);
        // A person asking for indices does not change that while it is down.
        st.request(("c00".into(), Dataset::Indices), 0);
        assert_eq!(st.plan(&s, probe, &HashSet::new(), &cfg()).len(), 1);

        // Answering again brings it back, and everything it holds comes due.
        st.entries.insert(("c00".into(), Dataset::Nodes), Entry { next_due: Some(u64::MAX), ..Entry::never(1, None) });
        st.inflight.insert(k.clone(), None);
        st.running = 1;
        st.complete(&k, answered(), 5, probe, &cfg(), &mut same);
        assert_eq!(st.reach["c00"].state, ReachState::Reachable);
        assert_eq!(st.entries[&("c00".to_string(), Dataset::Nodes)].next_due, Some(probe));
    }

    #[test]
    fn idle_means_health_only() {
        let mut st = State::default();
        let s = specs(1);
        st.first_due.insert("c00".into(), 0);
        let plan = st.plan(&s, IDLE_MS + 1, &HashSet::new(), &cfg());
        assert_eq!(plan.iter().map(|c| c.dataset).collect::<Vec<_>>(), vec![Dataset::Health]);
        st.last_activity = IDLE_MS;
        assert_eq!(st.plan(&s, IDLE_MS + 1, &HashSet::new(), &cfg()).len(), 6);
    }

    #[test]
    fn a_failure_keeps_the_last_good_body_and_its_time() {
        let mut st = active(0);
        let k = ("c".to_string(), Dataset::Nodes);
        let mut m = Map::new();
        m.insert("nodes".into(), json!({ "ok": true, "json": [1] }));
        st.complete(&k, Outcome::Answered(m), 3, 100, &cfg(), &mut same);
        st.complete(&k, failed(), 3, 200, &cfg(), &mut same);
        let e = &st.entries[&k];
        assert_eq!(e.status, Status::Error);
        assert_eq!(e.fetched_at, Some(100));
        assert_eq!(e.attempted_at, Some(200));
        assert_eq!(e.data.as_ref().unwrap().parse()["nodes"]["json"], json!([1]));
        assert_eq!(e.next_due, Some(200 + 300_000), "first failure: one interval");
        st.complete(&k, failed(), 3, 300, &cfg(), &mut same);
        assert_eq!(st.entries[&k].next_due, Some(300 + 600_000), "then backing off");
        // Nodes is not health: the cluster's reach is untouched.
        assert!(!st.reach.contains_key("c"));
    }

    #[test]
    fn on_demand_mode_plans_nothing_on_its_own_and_only_what_was_asked() {
        let cfg = with_mode(Mode::OnDemand);
        let mut st = active(1_000_000);
        let s = specs(3);
        assert!(st.plan(&s, 1_000_000, &HashSet::new(), &cfg).is_empty(), "the poller went to a cluster by itself");
        // Nor later, when every boot offset has passed.
        assert!(st.plan(&s, 2_000_000, &HashSet::new(), &cfg).is_empty());
        st.request(("c01".into(), Dataset::Health), 2_000_000);
        let p = st.plan(&s, 2_000_000, &HashSet::new(), &cfg);
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].cluster.as_str(), p[0].dataset, p[0].prio), ("c01", Dataset::Health, PRIO_USER));
        // A down cluster is not probed either: health comes back when somebody asks.
        st.reach.insert("c02".into(), Reach { state: ReachState::Unreachable, next_probe_at: Some(0), ..Reach::default() });
        assert!(!st.plan(&s, 3_000_000, &HashSet::new(), &cfg).iter().any(|c| c.cluster == "c02"));
    }

    #[test]
    fn hybrid_keeps_health_in_the_background_and_the_rest_only_while_watched() {
        let cfg = with_mode(Mode::Hybrid);
        let mut st = active(0);
        let s = specs(1);
        let p = st.plan(&s, 0, &HashSet::new(), &cfg);
        assert_eq!(p.iter().map(|c| c.dataset).collect::<Vec<_>>(), vec![Dataset::Health], "{p:?}");
        // A page looked at nodes: it comes for the watch window, then stops.
        st.watched.insert(("c00".into(), Dataset::Nodes), 10_000);
        st.entries.insert(("c00".into(), Dataset::Nodes), Entry::never(1, Some(10_000)));
        assert!(st.plan(&s, 10_000, &HashSet::new(), &cfg).iter().any(|c| c.dataset == Dataset::Nodes));
        assert!(!st.plan(&s, 10_000 + cfg.watch_ms + 1, &HashSet::new(), &cfg).iter().any(|c| c.dataset == Dataset::Nodes));
    }

    #[test]
    fn auto_with_25_clusters_plans_the_background_datasets() {
        let cfg = cfg();
        assert_eq!(cfg.mode, Mode::Auto, "auto is the shipped mode");
        assert_eq!(cfg.resolved_mode(AUTO_HYBRID_ABOVE), Mode::Background);
        let mut st = active(1_000_000); // somebody is looking: not idle
        let s = specs(AUTO_HYBRID_ABOVE);
        st.plan(&s, 0, &HashSet::new(), &cfg); // assigns the boot spread
        let p = st.plan(&s, 1_000_000, &HashSet::new(), &cfg);
        let got: HashSet<Dataset> = p.iter().filter(|c| c.cluster == "c00").map(|c| c.dataset).collect();
        let want: HashSet<Dataset> = ALL.iter().copied().filter(|d| d.class() == Class::Background).collect();
        assert_eq!(got, want, "{p:?}");
        assert!(want.len() > 1);
    }

    #[test]
    fn auto_with_26_clusters_plans_only_health_on_its_own() {
        let cfg = cfg();
        assert_eq!(cfg.resolved_mode(AUTO_HYBRID_ABOVE + 1), Mode::Hybrid);
        let mut st = active(1_000_000); // somebody is looking: not idle
        let s = specs(AUTO_HYBRID_ABOVE + 1);
        st.plan(&s, 0, &HashSet::new(), &cfg);
        let p = st.plan(&s, 1_000_000, &HashSet::new(), &cfg);
        assert!(!p.is_empty());
        assert!(p.iter().all(|c| c.dataset == Dataset::Health), "{p:?}");
        // An explicit mode is not resized by the fleet.
        assert_eq!(with_mode(Mode::Background).resolved_mode(500), Mode::Background);
        assert_eq!(with_mode(Mode::OnDemand).resolved_mode(1), Mode::OnDemand);
    }

    #[test]
    fn a_paused_cluster_is_skipped_and_pause_all_holds_even_a_persons_ask() {
        let mut cfg = cfg();
        cfg.paused.insert("c00".into());
        let mut st = active(0);
        let s = specs(2);
        st.plan(&s, 0, &HashSet::new(), &cfg);           // assigns the boot spread
        let p = st.plan(&s, 100_000, &HashSet::new(), &cfg);
        assert!(!p.is_empty() && p.iter().all(|c| c.cluster == "c01"), "{p:?}");
        cfg.paused_all = true;
        st.request(("c01".into(), Dataset::Health), 0);
        assert!(st.plan(&s, 100_000, &HashSet::new(), &cfg).is_empty(), "paused: nothing new starts");
        assert!(st.pending.contains_key(&("c01".to_string(), Dataset::Health)), "the ask waits for the pause to lift");
        cfg.paused_all = false;
        assert!(st.plan(&s, 100_000, &HashSet::new(), &cfg).iter().any(|c| c.cluster == "c01" && c.prio == PRIO_USER));
    }

    #[test]
    fn the_policy_decides_intervals_and_the_per_cluster_limit() {
        let mut pol = Policy::shipped();
        pol.intervals_sec.insert("nodes".into(), 90);
        pol.concurrency.per_cluster = 1;
        let cfg = Config::from_policy(&pol);
        assert_eq!(cfg.interval(Dataset::Nodes), 90);
        assert_eq!(cfg.stale_after_ms(Dataset::Nodes), 180_000);
        let mut st = active(0);
        let s = specs(1);
        let p = st.plan(&s, 0, &HashSet::new(), &cfg);
        let started = st.take(p, &s, &cfg, 0);
        assert_eq!(started.len(), 1, "one request per cluster at a time: {started:?}");
    }

    #[test]
    fn the_budget_defers_the_pollers_fetches_but_not_a_persons_ask() {
        let mut cfg = cfg();
        cfg.budget_per_min = 3;      // health (2 requests) + ilm_errors (1) fit; nodes (2) would not
        let mut st = active(0);
        let s = specs(1);
        let plan = st.plan(&s, 0, &HashSet::new(), &cfg);
        let started = st.take(plan, &s, &cfg, 0);
        assert_eq!(started.iter().map(|c| c.dataset).collect::<Vec<_>>(), vec![Dataset::Health, Dataset::IlmErrors], "{started:?}");
        let t = st.throttle.get("c00").expect("held back");
        assert_eq!(t.kind, ThrottleKind::Budget);
        assert_eq!(t.until, BUDGET_WINDOW_MS);
        // While held back the planner offers nothing of the poller's own …
        for ds in [Dataset::Health, Dataset::IlmErrors] { let _ = st.complete(&("c00".into(), ds), answered(), 5, 1_000, &cfg, &mut same); }
        assert!(st.plan(&s, 2_000, &HashSet::new(), &cfg).is_empty(), "throttled: nothing of its own");
        // … but a person's ask goes through, budget or no budget.
        st.request(("c00".into(), Dataset::Indices), 2_000);
        let p = st.plan(&s, 2_000, &HashSet::new(), &cfg);
        assert_eq!(p.len(), 1);
        assert_eq!(st.take(p, &s, &cfg, 2_000).len(), 1);
        // The window passes and the poller may go again.
        let _ = st.complete(&("c00".into(), Dataset::Indices), answered(), 5, 3_000, &cfg, &mut same);
        assert!(!st.plan(&s, BUDGET_WINDOW_MS + 1, &HashSet::new(), &cfg).is_empty());
    }

    #[test]
    fn a_429_or_a_timeout_backs_off_doubling_to_ten_minutes_and_an_answer_ends_it() {
        let cfg = cfg();
        let mut st = active(0);
        let key = ("c00".to_string(), Dataset::Nodes);
        let too_many = || Outcome::Failed(json!({ "kind": "client_error", "status": 429, "message": "Too Many Requests" }));
        let _ = st.complete(&key, too_many(), 5, 1_000, &cfg, &mut same);
        let t = st.throttle["c00"].clone();
        assert_eq!((t.kind, t.level, t.until), (ThrottleKind::Backoff, 1, 1_000 + BACKOFF_FIRST_MS));
        assert!(t.reason.contains("429"));
        for i in 2..=7 {
            let _ = st.complete(&key, Outcome::Failed(json!({ "kind": "client_error", "message": "operation timed out" })), 5, 1_000, &cfg, &mut same);
            let t = &st.throttle["c00"];
            assert_eq!(t.level, i);
            assert_eq!(t.until - 1_000, (BACKOFF_FIRST_MS << (i - 1).min(4)).min(BACKOFF_MAX_MS), "level {i}");
        }
        assert_eq!(st.throttle["c00"].until - 1_000, BACKOFF_MAX_MS, "capped at ten minutes");
        let s = specs(1);
        st.plan(&s, 0, &HashSet::new(), &cfg);
        assert!(st.plan(&s, 2_000, &HashSet::new(), &cfg).is_empty(), "backing off: left alone");
        let _ = st.complete(&("c00".into(), Dataset::Health), answered(), 5, 3_000, &cfg, &mut same);
        assert!(!st.throttle.contains_key("c00"), "an answer ends the backoff");
        // A plain error (refused connection) is not a reason to back off: reach handles that.
        let _ = st.complete(&key, failed(), 5, 4_000, &cfg, &mut same);
        assert!(!st.throttle.contains_key("c00"));
    }

    /// A body whose JSON is exactly `n` bytes.
    fn body(n: usize) -> Body {
        let b = Body::from_value(&json!("x".repeat(n - 2)));
        assert_eq!(b.len(), n);
        b
    }
    fn held(n: usize, read: u64, fetched: u64) -> Entry {
        let mut e = Entry::never(1, Some(fetched + 300_000));
        e.status = Status::Ok;
        e.data = Some(body(n));
        e.last_read = read;
        e.fetched_at = Some(fetched);
        e
    }
    fn k(c: &str, d: Dataset) -> Key {
        (c.to_string(), d)
    }

    #[test]
    fn an_answer_is_held_as_text_and_costs_its_length() {
        let mut st = active(0);
        let key = k("c", Dataset::Indices);
        let mut m = Map::new();
        m.insert("indices".into(), json!({ "ok": true, "json": [{ "index": "a" }] }));
        let text = serde_json::to_string(&serde_json::Value::Object(m.clone())).unwrap();
        st.complete(&key, Outcome::Answered(m), 1, 10, &cfg(), &mut same);
        let e = &st.entries[&key];
        assert_eq!(e.data.as_ref().unwrap().raw().get(), text, "the body is the JSON it would have been sent as");
        assert_eq!(e.cost(), crate::fleet::entry::ENTRY_OVERHEAD + text.len());
        assert_eq!(st.total_cost(), e.cost());
    }

    #[test]
    fn eviction_drops_the_least_recently_read_on_demand_body_first() {
        let mut st = active(0);
        st.entries.insert(k("c", Dataset::Indices), held(600, 0, 0));
        st.entries.insert(k("c", Dataset::Shards), held(600, 1, 0));
        st.entries.insert(k("c", Dataset::Health), held(10_000, 0, 0));
        st.entries.insert(k("c", Dataset::Nodes), held(5_000, 0, 0));
        let total = st.total_cost();
        // Room for everything but one on-demand body.
        assert_eq!(st.evict(total - 1), 0, "no background body had to go");
        assert!(!st.entries.contains_key(&k("c", Dataset::Indices)), "least recently read goes first");
        assert!(st.entries.contains_key(&k("c", Dataset::Shards)));
        assert!(st.entries[&k("c", Dataset::Nodes)].data.is_some(), "background is only touched once on-demand is gone");
        assert!(st.total_cost() < total);
    }

    #[test]
    fn every_class_counts_and_the_budget_holds_except_for_health() {
        let mut st = active(0);
        for c in ["a", "b"] {
            st.entries.insert(k(c, Dataset::Health), held(1_000, 0, 0));
            st.entries.insert(k(c, Dataset::Indices), held(50_000, 5, 5));
        }
        st.entries.insert(k("a", Dataset::Nodes), held(20_000, 0, 100));   // newest background
        st.entries.insert(k("b", Dataset::Nodes), held(20_000, 0, 10));    // oldest background
        st.entries.insert(k("a", Dataset::Policies), held(20_000, 0, 50));
        // In flight: never touched, whatever it costs.
        st.entries.insert(k("b", Dataset::Shards), held(30_000, 0, 0));
        st.inflight.insert(k("b", Dataset::Shards), None);
        let seq = st.seq;
        // A budget that background alone exceeds: on-demand all goes, then the oldest
        // background bodies, until it fits.
        let limit = 30_000 + 2 * 1_000 + 25_000 + 8 * crate::fleet::entry::ENTRY_OVERHEAD;
        let dropped = st.evict(limit);
        assert!(st.total_cost() <= limit, "{} > {limit}", st.total_cost());
        assert!(!st.entries.contains_key(&k("a", Dataset::Indices)) && !st.entries.contains_key(&k("b", Dataset::Indices)));
        assert_eq!(dropped, 2, "the two oldest background bodies");
        let b = &st.entries[&k("b", Dataset::Nodes)];
        assert!(b.data.is_none());
        assert_eq!(b.status, Status::Never, "unknown, not empty");
        assert_eq!(b.fetched_at, None);
        assert_eq!(b.error.as_ref().unwrap()["kind"], json!("evicted"));
        assert_eq!(b.next_due, Some(10 + 300_000), "its schedule stays: not fetched straight back into a full cache");
        assert!(b.seq > seq, "pages are told");
        assert!(st.entries[&k("a", Dataset::Policies)].data.is_none());
        assert!(st.entries[&k("a", Dataset::Nodes)].data.is_some(), "the newest background body stays");
        assert!(st.entries[&k("b", Dataset::Shards)].data.is_some(), "in flight is not touched");
        // However small the budget, health stays.
        st.evict(0);
        for c in ["a", "b"] {
            assert!(st.entries[&k(c, Dataset::Health)].data.is_some(), "health is never evicted");
        }
        assert!(st.entries[&k("a", Dataset::Nodes)].data.is_none());
    }

    #[test]
    fn housekeep_drops_bookkeeping_of_removed_clusters_and_of_the_past() {
        let now = 10_000_000u64;
        let mut st = active(now);
        let k = |c: &str, d: Dataset| (c.to_string(), d);
        st.throttle.insert("gone".into(), Throttle { kind: ThrottleKind::Backoff, until: now + 60_000, level: 1, reason: "x".into() });
        st.throttle.insert("kept".into(), Throttle { kind: ThrottleKind::Backoff, until: now + 60_000, level: 1, reason: "x".into() });
        st.throttle.insert("kept2".into(), Throttle { kind: ThrottleKind::Budget, until: now - 1, level: 0, reason: "x".into() });
        st.starts.insert("gone".into(), [(now, 1)].into());
        st.starts.insert("kept".into(), [(now - 1000, 1)].into());
        st.starts.insert("kept2".into(), [(now - BUDGET_WINDOW_MS - 1, 1)].into());
        st.watched.insert(k("gone", Dataset::Indices), now);
        st.watched.insert(k("kept", Dataset::Indices), now - 1000);
        st.watched.insert(k("kept", Dataset::Shards), now - 20 * 60_000);
        st.refresh_rl.insert(("u".into(), "gone".into(), Dataset::Indices), now);
        st.refresh_rl.insert(("u".into(), "kept".into(), Dataset::Indices), now - 1);
        st.refresh_rl.insert(("u".into(), "kept".into(), Dataset::Shards), now - REFRESH_EVERY_MS - 1);
        st.running_cluster.insert("idle".into(), 0);
        st.running_cluster.insert("busy".into(), 2);
        st.running_jump.insert("j".into(), 0);
        // Something that must never be dropped: a body and a pending ask.
        st.entries.insert(k("kept", Dataset::Health), Entry::never(1, None));
        st.pending.insert(k("kept", Dataset::Health), now);
        let known: HashSet<String> = ["kept", "kept2", "busy", "idle"].iter().map(|s| s.to_string()).collect();
        let watch_ms = 15 * 60_000;

        let dry = st.housekeep(Some(&known), now, watch_ms, true);
        assert_eq!(dry, StateSweep { throttles: 2, budget_windows: 2, watched: 2, refresh_limits: 2, running_counters: 2 });
        assert_eq!((st.throttle.len(), st.starts.len(), st.watched.len(), st.refresh_rl.len()), (3, 3, 3, 3), "a dry run changes nothing");

        let done = st.housekeep(Some(&known), now, watch_ms, false);
        assert_eq!(done, dry);
        assert_eq!(st.throttle.keys().collect::<Vec<_>>(), vec!["kept"]);
        assert_eq!(st.starts.keys().collect::<Vec<_>>(), vec!["kept"]);
        assert_eq!(st.watched.keys().collect::<Vec<_>>(), vec![&k("kept", Dataset::Indices)]);
        assert_eq!(st.refresh_rl.len(), 1);
        assert_eq!(st.running_cluster.get("busy"), Some(&2));
        assert!(!st.running_cluster.contains_key("idle") && st.running_jump.is_empty());
        assert!(st.entries.contains_key(&k("kept", Dataset::Health)) && st.pending.contains_key(&k("kept", Dataset::Health)));
        assert_eq!(st.housekeep(Some(&known), now, watch_ms, false), StateSweep::default(), "idempotent");
    }

    #[test]
    fn housekeep_without_a_cluster_list_only_expires_by_time() {
        let now = 10_000_000u64;
        let mut st = active(now);
        st.throttle.insert("any".into(), Throttle { kind: ThrottleKind::Backoff, until: now + 60_000, level: 1, reason: "x".into() });
        st.watched.insert(("any".into(), Dataset::Indices), now);
        let out = st.housekeep(None, now, 15 * 60_000, false);
        assert_eq!(out, StateSweep::default(), "an unsettled list must not read as 'every cluster is gone'");
        assert_eq!((st.throttle.len(), st.watched.len()), (1, 1));
    }
}
