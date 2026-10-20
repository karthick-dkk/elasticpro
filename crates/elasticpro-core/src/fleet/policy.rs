//! The request policy: when the poller goes to the clusters, how hard, and whether at all.
//!
//! `policy.json` in the data dir, read once at start and rewritten by `POLICY_SET`; the
//! scheduler reads the applied form (`scheduler::Config`) on every tick, so a change takes
//! effect without a restart. Missing file: the shipped defaults, seeded from the two
//! environment variables that tuned the poller before this file existed, so an install
//! that never touches the policy behaves exactly as it did.
//!
//! Modes:
//!   auto       — the shipped default: background while the core knows at most
//!                `AUTO_HYBRID_ABOVE` clusters, hybrid above that;
//!   background — the fleet is kept fresh on the core's schedule (how it has always been);
//!   hybrid     — health in the background, so the strip and Alerts stay honest; everything
//!                else only while a page is looking at it;
//!   on-demand  — the poller fetches nothing on its own. A page asking (`CLUSTER_DATASET`,
//!                `REFRESH`) is what sends a request, and only for that cluster.
//! With `concurrency.perCluster: 1` that is one request per cluster at a time.
//!
//! Pause: nothing new starts for a paused cluster (or for anyone, with `all`); what is in
//! flight finishes. A person's ask stays pending and runs when the pause is lifted.

use super::catalogue::{Dataset, ALL};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "policy.json";

/// `auto` runs as `background` up to this many clusters and as `hybrid` above it. Measured
/// with 120 fixture clusters, background mode sent ~400 requests a minute to the clusters
/// (production: ~350 a minute for 32) — every dataset of every cluster kept fresh whether
/// or not anybody looks. A small fleet can afford that; a large one keeps health in the
/// background (the strip and Alerts stay honest) and fetches the rest while watched.
pub const AUTO_HYBRID_ABOVE: usize = 25;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    #[default]
    Auto,
    Background,
    Hybrid,
    OnDemand,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::Background => "background",
            Mode::Hybrid => "hybrid",
            Mode::OnDemand => "on-demand",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Concurrency {
    pub global: usize,
    pub per_cluster: usize,
    pub tunnel: usize,
}

impl Default for Concurrency {
    fn default() -> Self {
        Concurrency { global: env_num("ELASTICPRO_POLL_CONCURRENCY").unwrap_or(16).clamp(1, 256) as usize, per_cluster: 2, tunnel: 6 }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Paused {
    pub all: bool,
    pub clusters: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Policy {
    pub mode: Mode,
    /// Seconds between fetches, by dataset name. A dataset left out keeps its shipped value.
    pub intervals_sec: BTreeMap<String, u64>,
    /// How long an on-demand dataset stays fresh after somebody last looked at it.
    pub watch_minutes: u64,
    pub concurrency: Concurrency,
    /// The poller's per-request timeout.
    pub timeout_ms: u64,
    /// …and for a cluster reached through a jump host, which is slower by nature.
    pub tunnel_timeout_ms: u64,
    /// Soft cap on the poller's requests to one cluster per minute. Beyond it the cluster's
    /// due fetches are deferred (a person's ask still goes); 0 means no cap.
    pub budget_per_cluster_per_min: u64,
    pub paused: Paused,
}

fn env_num(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

impl Default for Policy {
    fn default() -> Policy {
        Policy::shipped()
    }
}

impl Policy {
    /// What an install without a policy file runs: today's poller's intervals, in `auto`
    /// mode so a large fleet is not polled for everything all the time.
    pub fn shipped() -> Policy {
        // Never faster than three minutes from the environment: a hundred clusters polled
        // every thirty seconds is the load the cache exists to remove. The file may go to
        // sixty seconds — an operator who wrote that down meant it.
        let health = env_num("ELASTICPRO_POLL_HEALTH_SECS").unwrap_or(180).clamp(180, 300);
        Policy {
            mode: Mode::Auto,
            intervals_sec: ALL.iter().map(|d| (d.name().to_string(), d.default_interval_secs(health))).collect(),
            watch_minutes: 15,
            concurrency: Concurrency::default(),
            timeout_ms: 30_000,
            tunnel_timeout_ms: 60_000,
            budget_per_cluster_per_min: 30,
            paused: Paused::default(),
        }
    }

    /// Within bounds, with unknown dataset names dropped and the cluster list tidy. The
    /// result is what is saved and what the scheduler runs.
    pub fn normalised(mut self) -> Policy {
        let shipped = Policy::shipped();
        let mut iv = BTreeMap::new();
        for d in ALL {
            let v = self.intervals_sec.get(d.name()).copied().unwrap_or(shipped.intervals_sec[d.name()]);
            let floor = if d == Dataset::Health { 60 } else { 30 };
            iv.insert(d.name().to_string(), v.clamp(floor, 86_400));
        }
        self.intervals_sec = iv;
        self.watch_minutes = self.watch_minutes.clamp(1, 240);
        // The poller's share of the gate, never more than the gate itself allows (gate.rs:
        // ES_CONCURRENCY, ES_PER_CLUSTER, ES_PER_JUMP_HOST).
        let gate = crate::gate::limits();
        self.concurrency.global = self.concurrency.global.clamp(1, 256).min(gate.global);
        self.concurrency.per_cluster = self.concurrency.per_cluster.clamp(1, 8).min(gate.per_cluster);
        self.concurrency.tunnel = self.concurrency.tunnel.clamp(1, 32).min(gate.per_jump);
        self.timeout_ms = self.timeout_ms.clamp(1_000, 600_000);
        self.tunnel_timeout_ms = self.tunnel_timeout_ms.clamp(1_000, 600_000);
        self.budget_per_cluster_per_min = self.budget_per_cluster_per_min.min(10_000);
        let mut seen = std::collections::BTreeSet::new();
        self.paused.clusters.retain(|c| !c.trim().is_empty() && seen.insert(c.clone()));
        self
    }

    pub fn interval_secs(&self, ds: Dataset) -> u64 {
        self.intervals_sec.get(ds.name()).copied().unwrap_or_else(|| ds.default_interval_secs(180))
    }

    pub fn path_in(data_dir: Option<&Path>) -> Option<PathBuf> {
        data_dir.map(|d| d.join(FILE_NAME))
    }

    /// The file, or the shipped policy when there is none. A file that cannot be parsed is
    /// reported and ignored: a typo in it must not stop the poller.
    pub fn load(path: Option<&Path>) -> (Policy, Option<String>) {
        let Some(p) = path else { return (Policy::shipped(), None) };
        match std::fs::read(p) {
            Ok(bytes) => match serde_json::from_slice::<Policy>(&bytes) {
                Ok(pol) => (pol.normalised(), None),
                Err(e) => (Policy::shipped(), Some(format!("{FILE_NAME}: {e} — running the shipped policy"))),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Policy::shipped(), None),
            Err(e) => (Policy::shipped(), Some(format!("{FILE_NAME}: {e} — running the shipped policy"))),
        }
    }

    /// Written whole, to a temporary file first, 0600: a reader never sees half a policy.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let _ = std::fs::remove_file(&tmp);
        {
            use std::io::Write as _;
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            let mut f = o.open(&tmp).map_err(|e| format!("{FILE_NAME}.tmp: {e}"))?;
            f.write_all(&body).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{FILE_NAME}: {e}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_policy_is_todays_poller_in_auto_mode() {
        let p = Policy::shipped();
        assert_eq!(p.mode, Mode::Auto);
        assert_eq!(p.interval_secs(Dataset::Health), 180);
        assert_eq!(p.interval_secs(Dataset::Shards), 300);
        assert_eq!(p.watch_minutes, 15);
        assert_eq!(p.concurrency.per_cluster, 2);
        assert_eq!(p.budget_per_cluster_per_min, 30);
        assert_eq!(p.tunnel_timeout_ms, 60_000);
        assert!(!p.paused.all);
    }

    #[test]
    fn a_partial_file_keeps_shipped_values_and_bounds_hold() {
        let p: Policy = serde_json::from_str(r#"{"mode":"on-demand","intervalsSec":{"health":5,"bogus":9},"concurrency":{"perCluster":0},"paused":{"clusters":["a","a"," "]}}"#).unwrap();
        let p = p.normalised();
        assert_eq!(p.mode, Mode::OnDemand);
        assert_eq!(p.interval_secs(Dataset::Health), 60, "health floor");
        assert_eq!(p.interval_secs(Dataset::Nodes), 300, "left out: shipped");
        assert!(!p.intervals_sec.contains_key("bogus"));
        assert_eq!(p.concurrency.per_cluster, 1);
        assert_eq!(p.concurrency.global, Concurrency::default().global, "left out: shipped");
        assert_eq!(p.paused.clusters, vec!["a".to_string()]);
    }

    #[test]
    fn mode_words_are_kebab_case_on_the_wire() {
        assert_eq!(serde_json::to_string(&Mode::OnDemand).unwrap(), "\"on-demand\"");
        assert_eq!(serde_json::to_string(&Mode::Auto).unwrap(), "\"auto\"");
        let p: Policy = serde_json::from_str(r#"{"mode":"auto"}"#).unwrap();
        assert_eq!(p.mode, Mode::Auto);
        // A file that names a mode keeps it: auto is only the default.
        let p: Policy = serde_json::from_str(r#"{"mode":"background"}"#).unwrap();
        assert_eq!(p.mode, Mode::Background);
        assert!(serde_json::from_str::<Policy>(r#"{"mode":"sometimes"}"#).is_err());
    }

    #[test]
    fn save_then_load_round_trips_and_a_broken_file_is_reported_not_fatal() {
        let dir = std::env::temp_dir().join(format!("ep-policy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(FILE_NAME);
        let mut p = Policy::shipped();
        p.mode = Mode::Hybrid;
        p.paused.clusters.push("c1".into());
        p.save(&path).unwrap();
        let (back, warn) = Policy::load(Some(&path));
        assert_eq!(back, p.normalised());
        assert!(warn.is_none());
        std::fs::write(&path, b"{ not json").unwrap();
        let (fallback, warn) = Policy::load(Some(&path));
        assert_eq!(fallback, Policy::shipped());
        assert!(warn.unwrap().contains("shipped policy"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
