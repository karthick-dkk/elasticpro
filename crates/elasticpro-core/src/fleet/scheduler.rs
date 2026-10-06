//! Deciding what to fetch next. Pure bookkeeping over times in milliseconds, with no
//! I/O and no clock of its own, so every rule here — priority, limits, the unreachable
//! and idle rules, the boot spread — is tested by handing it a `now`.

use super::catalogue::{self, Class, Dataset, ALL};
use super::entry::{Entry, Outcome, Reach, ReachState, Status};
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

#[derive(Clone, Debug)]
pub struct Config {
    pub health_secs: u64,
    pub global: usize,
    pub per_cluster: usize,
    pub per_jump: usize,
    pub cache_bytes: usize,
}

fn env_num(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

impl Config {
    pub fn from_env() -> Config {
        Config {
            // Never faster than three minutes: a hundred clusters polled every thirty
            // seconds is the load this cache exists to remove.
            health_secs: env_num("ELASTICPRO_POLL_HEALTH_SECS").unwrap_or(180).clamp(180, 300),
            global: env_num("ELASTICPRO_POLL_CONCURRENCY").unwrap_or(16).clamp(1, 256) as usize,
            per_cluster: 2,
            per_jump: 6,
            cache_bytes: (env_num("ELASTICPRO_CACHE_MB").unwrap_or(256).max(1) as usize) * 1024 * 1024,
        }
    }
}

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
}

impl State {
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
    pub fn plan(&mut self, specs: &[SpecLite], now: u64, backing_off: &HashSet<String>) -> Vec<Candidate> {
        let mut new: Vec<&str> = specs.iter().map(|s| s.id.as_str()).filter(|id| !self.first_due.contains_key(*id)).collect();
        new.sort();
        let n = new.len();
        for (i, id) in new.into_iter().enumerate() {
            self.first_due.insert(id.to_string(), now + catalogue::boot_offset_ms(i, n));
        }
        let idle = self.idle(now);
        let mut out = vec![];
        for s in specs {
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
                let entry = self.entries.get(&key);
                let (prio, due) = if unreachable {
                    if ds != Dataset::Health {
                        continue;
                    }
                    (PRIO_BACKGROUND, self.reach.get(&s.id).and_then(|r| r.next_probe_at).unwrap_or(now))
                } else if idle && ds != Dataset::Health {
                    continue;
                } else if ds.class() == Class::OnDemand {
                    let watched = self.watched.get(&key).is_some_and(|t| now.saturating_sub(*t) < catalogue::WATCH_MS);
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
    pub fn take(&mut self, cands: Vec<Candidate>, specs: &[SpecLite], cfg: &Config) -> Vec<Candidate> {
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
        let interval = ds.interval_secs(cfg.health_secs) * 1000;
        let seq = self.next_seq();
        let e = self.entries.entry(key.clone()).or_insert_with(|| Entry::never(ds.stale_after_ms(cfg.health_secs), None));
        e.seq = seq;
        e.attempted_at = Some(now);
        e.took_ms = Some(took_ms);
        e.stale_after_ms = ds.stale_after_ms(cfg.health_secs);
        let (answered, err) = match outcome {
            Outcome::Answered(map) => {
                let data = serde_json::Value::Object(map);
                e.bytes = serde_json::to_vec(&data).map(|b| b.len()).unwrap_or(0);
                e.data = Some(data);
                e.status = Status::Ok;
                e.fetched_at = Some(now);
                e.error = None;
                e.failures = 0;
                e.next_due = Some(now + rand(interval));
                (true, None)
            }
            Outcome::Failed(err) => {
                // The data and its fetchedAt stay what they were: the last good answer,
                // labelled with its own age.
                e.status = Status::Error;
                e.error = Some(err.clone());
                e.failures += 1;
                // Backing off, not hurrying: a cluster that timed out is not helped by
                // being asked again sooner. Up to four intervals.
                let k = 1u64 << (e.failures - 1).min(2);
                e.next_due = Some(now + rand(interval * k));
                (false, Some(err))
            }
        };
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

    /// Drop on-demand bodies, least recently read first, until they fit. Background
    /// datasets are never evicted: they are bounded by the number of clusters, and
    /// evicting one would turn a known value into an unknown one on the overview.
    pub fn evict(&mut self, limit: usize) {
        let mut od: Vec<(u64, Key, usize)> = self
            .entries
            .iter()
            .filter(|(k, e)| k.1.class() == Class::OnDemand && e.data.is_some() && !self.inflight.contains_key(*k))
            .map(|(k, e)| (e.last_read.max(e.fetched_at.unwrap_or(0)), k.clone(), e.bytes))
            .collect();
        let mut total: usize = od.iter().map(|x| x.2).sum();
        if total <= limit {
            return;
        }
        od.sort();
        for (_, k, b) in od {
            if total <= limit {
                break;
            }
            self.entries.remove(&k);
            total = total.saturating_sub(b);
        }
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
        Config { health_secs: 180, global: 16, per_cluster: 2, per_jump: 6, cache_bytes: 1 << 20 }
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
        let first = st.plan(&s, 0, &HashSet::new());
        // At t=0 only the first cluster is due.
        assert!(first.iter().all(|c| c.cluster == "c00"), "{first:?}");
        assert_eq!(first.len(), 6, "every background dataset of it: {first:?}");
        assert_eq!(st.first_due["c01"], 45_000);
        let later = st.plan(&s, 45_000, &HashSet::new());
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
        let plan = st.plan(&s, 1_000_000, &HashSet::new());
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
        let plan = st.plan(&s, 1_000_000, &HashSet::new());
        assert_eq!((plan[0].prio, plan[0].cluster.as_str(), plan[0].dataset), (PRIO_USER, "c39", Dataset::Indices), "{:?}", &plan[..3]);
        let started = st.take(plan, &s, &cfg());
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
        let plan = st.plan(&s, 0, &HashSet::new());
        let started = st.take(plan, &s, &cfg());
        assert_eq!(started.len(), 6, "per jump host 6");
        assert!(st.running_cluster.values().all(|n| *n <= 2));
        // A second pass starts nothing more through that jump host.
        let plan = st.plan(&s, 0, &HashSet::new());
        assert!(st.take(plan, &s, &cfg()).is_empty());

        let mut st = active(0);
        let s = specs(20);
        for x in &s {
            st.first_due.insert(x.id.clone(), 0);
        }
        let plan = st.plan(&s, 0, &HashSet::new());
        let started = st.take(plan, &s, &cfg());
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
        let plan = st.plan(&s, 0, &down);
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
        assert!(st.plan(&s, probe - 1, &HashSet::new()).is_empty());
        let plan = st.plan(&s, probe, &HashSet::new());
        assert_eq!(plan.iter().map(|c| c.dataset).collect::<Vec<_>>(), vec![Dataset::Health]);
        // A person asking for indices does not change that while it is down.
        st.request(("c00".into(), Dataset::Indices), 0);
        assert_eq!(st.plan(&s, probe, &HashSet::new()).len(), 1);

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
        let plan = st.plan(&s, IDLE_MS + 1, &HashSet::new());
        assert_eq!(plan.iter().map(|c| c.dataset).collect::<Vec<_>>(), vec![Dataset::Health]);
        st.last_activity = IDLE_MS;
        assert_eq!(st.plan(&s, IDLE_MS + 1, &HashSet::new()).len(), 6);
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
        assert_eq!(e.data.as_ref().unwrap()["nodes"]["json"], json!([1]));
        assert_eq!(e.next_due, Some(200 + 300_000), "first failure: one interval");
        st.complete(&k, failed(), 3, 300, &cfg(), &mut same);
        assert_eq!(st.entries[&k].next_due, Some(300 + 600_000), "then backing off");
        // Nodes is not health: the cluster's reach is untouched.
        assert!(!st.reach.contains_key("c"));
    }

    #[test]
    fn eviction_drops_the_least_recently_read_on_demand_body() {
        let mut st = active(0);
        for (i, ds) in [Dataset::Indices, Dataset::Shards].into_iter().enumerate() {
            let mut e = Entry::never(1, None);
            e.data = Some(json!({}));
            e.bytes = 600;
            e.last_read = i as u64;
            st.entries.insert(("c".into(), ds), e);
        }
        let mut h = Entry::never(1, None);
        h.data = Some(json!({}));
        h.bytes = 10_000;
        st.entries.insert(("c".into(), Dataset::Health), h);
        st.evict(1000);
        assert!(!st.entries.contains_key(&("c".to_string(), Dataset::Indices)));
        assert!(st.entries.contains_key(&("c".to_string(), Dataset::Shards)));
        assert!(st.entries.contains_key(&("c".to_string(), Dataset::Health)), "background is never evicted");
    }
}
