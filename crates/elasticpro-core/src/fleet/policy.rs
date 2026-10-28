//! The request policy: when the poller goes to the clusters, how hard, and whether at all.
//!
//! `policy.json` in the data dir, read once at start and rewritten by `POLICY_SET`; the
//! scheduler reads the applied form (`scheduler::Config`) on every tick, so a change takes
//! effect without a restart. Missing file: the shipped policy — "Client basis" (on-demand,
//! one request per cluster at a time) — with the two environment variables that tuned the
//! poller before this file existed still winning where they name a value. A policy
//! somebody saved is never rewritten, and a saved file that leaves a field out gets the
//! classic value for it (`Policy::classic`), not the shipped one.
//!
//! Modes:
//!   auto       — background while the core knows at most `AUTO_HYBRID_ABOVE` clusters,
//!                hybrid above that (what shipped before Client basis did);
//!   background — the fleet is kept fresh on the core's schedule (how it has always been);
//!   hybrid     — health in the background, so the strip and Alerts stay honest; everything
//!                else only while a page is looking at it;
//!   on-demand  — the poller fetches nothing on its own. A page asking (`CLUSTER_DATASET`,
//!                `REFRESH`) is what sends a request, and only for that cluster.
//! With `concurrency.perCluster: 1` that is one request per cluster at a time.
//!
//! Emergency stop (`paused.all`): nothing new starts for anyone; what is in flight
//! finishes, and a person's ask stays pending. It always has an end — 15, 30 or 60
//! minutes — and lifts itself then. A stop with no end (what a pause was before 0.3.44,
//! including the per-cluster one, which is gone) is dropped when the file is read: one
//! held a site still for days because nobody remembered it.

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

/// "Client basis", the shipped policy: the poller sends nothing until a page asks, and then
/// one request per cluster at a time, four in all. The UI's preset of the same name is the
/// same numbers (`tools/unit/policy.test.mjs` reads them from here).
pub const CLIENT_BASIS_PER_CLUSTER: usize = 1;
pub const CLIENT_BASIS_GLOBAL: usize = 4;
/// What the Automatic, Background and Hybrid presets run with, and what a saved file that
/// leaves a field out has always got.
pub const CLASSIC_PER_CLUSTER: usize = 2;
pub const CLASSIC_GLOBAL: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// What a saved file that names no mode has always meant — not the shipped mode.
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

/// The classic values: what a field left out of a saved file takes, so a policy written
/// before the shipped default changed keeps meaning what it meant.
impl Default for Concurrency {
    fn default() -> Self {
        Concurrency::with_global(CLASSIC_GLOBAL, CLASSIC_PER_CLUSTER)
    }
}

/// `ELASTICPRO_POLL_CONCURRENCY` (POLL_CONCURRENCY in config.txt) as the core reads it, or
/// `None` when it is not set. It replaces the shipped `global`, and the `global` of a saved
/// file that leaves it out; POLICY_GET reports it so Config → Requests can say so.
pub fn poll_concurrency_env() -> Option<usize> {
    env_num("ELASTICPRO_POLL_CONCURRENCY").map(|n| n.clamp(1, 256) as usize)
}

impl Concurrency {
    /// `ELASTICPRO_POLL_CONCURRENCY` (POLL_CONCURRENCY in config.txt) wins over `global`.
    fn with_global(global: usize, per_cluster: usize) -> Concurrency {
        Concurrency {
            global: poll_concurrency_env().unwrap_or(global.clamp(1, 256)),
            per_cluster,
            tunnel: 6,
        }
    }
}

/// How long an emergency stop may last, in minutes: Request Centre offers these three.
pub const STOP_MINUTES: [u64; 3] = [15, 30, 60];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Paused {
    pub all: bool,
    /// How long the stop was asked for (one of `STOP_MINUTES`); what a page sends.
    #[serde(skip_serializing_if = "is_zero")]
    pub minutes: u64,
    /// When the stop in force began (ms since the epoch), 0 when nothing is stopped. The
    /// server stamps it. A page sends back the one it was shown (or 0 to begin a stop), so
    /// a form saved after that stop ended does not begin it again. A page whose data
    /// stopped coming says since when, and who to ask.
    #[serde(skip_serializing_if = "is_zero")]
    pub since: u64,
    /// When it lifts itself (ms since the epoch). Stamped by the server like `since`.
    #[serde(skip_serializing_if = "is_zero")]
    pub until: u64,
    /// Who began it; "" when nothing is stopped.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
}

fn is_zero(n: &u64) -> bool { *n == 0 }

impl Paused {
    /// Whether the stop holds at `now`: asked for, and its end not reached.
    pub fn active(&self, now: u64) -> bool {
        self.all && now < self.until
    }

    /// This stop with its stamp carried over from the one before: kept while the stop goes
    /// on, cleared when nothing is stopped — or when the page carried a stop (`since` set)
    /// that has ended meanwhile. Only an ask with no `since` begins one. The length is one
    /// of `STOP_MINUTES`, the shortest when the page named none or another.
    pub fn stamped(mut self, before: &Paused, by: &str, now: u64) -> Paused {
        if !self.all {
            return Paused::default();
        }
        if before.active(now) {
            self.minutes = before.minutes;
            self.since = before.since;
            self.until = before.until;
            self.by = before.by.clone();
        } else if self.since != 0 {
            return Paused::default();
        } else {
            self.minutes = if STOP_MINUTES.contains(&self.minutes) { self.minutes } else { STOP_MINUTES[0] };
            self.since = now;
            self.until = now + self.minutes * 60_000;
            self.by = by.to_string();
        }
        self
    }
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

/// What a saved file that leaves a field out gets: the classic policy, as before.
impl Default for Policy {
    fn default() -> Policy {
        Policy::classic()
    }
}

impl Policy {
    /// What an install without a policy file runs: Client basis. Nothing is fetched until a
    /// page asks, one request per cluster at a time. The intervals, watch window and
    /// timeouts are the classic ones; the environment still wins where it names a value.
    pub fn shipped() -> Policy {
        Policy {
            mode: Mode::OnDemand,
            concurrency: Concurrency::with_global(CLIENT_BASIS_GLOBAL, CLIENT_BASIS_PER_CLUSTER),
            ..Policy::classic()
        }
    }

    /// What shipped before Client basis did: the poller's intervals, in `auto` mode so a
    /// large fleet is not polled for everything all the time. The defaults of a saved file
    /// that leaves a field out, and the Automatic, Background and Hybrid presets' base.
    pub fn classic() -> Policy {
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
                Ok(mut pol) => {
                    // A stop with no end is from before stops ended by themselves: dropped.
                    if pol.paused.all && pol.paused.until == 0 {
                        tracing::warn!(since = pol.paused.since, by = %pol.paused.by,
                            "{FILE_NAME}: a pause with no end was in force; lifted — an emergency stop now lasts 15, 30 or 60 minutes");
                        pol.paused = Paused::default();
                    }
                    (pol.normalised(), None)
                }
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
    fn the_shipped_policy_is_client_basis() {
        let p = Policy::shipped();
        assert_eq!(p.mode, Mode::OnDemand);
        assert_eq!(p.concurrency.per_cluster, 1);
        assert_eq!(p.concurrency.global, 4);
        assert_eq!(p.concurrency.tunnel, 6);
        assert_eq!(p.interval_secs(Dataset::Health), 180);
        assert_eq!(p.interval_secs(Dataset::Shards), 300);
        assert_eq!(p.watch_minutes, 15);
        assert_eq!(p.timeout_ms, 30_000);
        assert_eq!(p.budget_per_cluster_per_min, 30);
        assert_eq!(p.tunnel_timeout_ms, 60_000);
        assert!(!p.paused.all);
        assert_eq!(p, p.clone().normalised(), "the shipped policy is already within bounds");
    }

    #[test]
    fn the_classic_policy_is_what_shipped_before_and_what_a_saved_file_falls_back_to() {
        let p = Policy::classic();
        assert_eq!(p.mode, Mode::Auto);
        assert_eq!((p.concurrency.global, p.concurrency.per_cluster), (16, 2));
        assert_eq!(p.intervals_sec, Policy::shipped().intervals_sec);
        // A file written by hand that names only a mode keeps meaning what it meant.
        let f: Policy = serde_json::from_str(r#"{"mode":"background"}"#).unwrap();
        assert_eq!((f.concurrency.global, f.concurrency.per_cluster), (16, 2));
        let f: Policy = serde_json::from_str("{}").unwrap();
        assert_eq!(f.mode, Mode::Auto, "a file that names no mode is not the shipped mode");
    }

    #[test]
    fn a_partial_file_keeps_shipped_values_and_bounds_hold() {
        let p: Policy = serde_json::from_str(r#"{"mode":"on-demand","intervalsSec":{"health":5,"bogus":9},"concurrency":{"perCluster":0}}"#).unwrap();
        let p = p.normalised();
        assert_eq!(p.mode, Mode::OnDemand);
        assert_eq!(p.interval_secs(Dataset::Health), 60, "health floor");
        assert_eq!(p.interval_secs(Dataset::Nodes), 300, "left out: shipped");
        assert!(!p.intervals_sec.contains_key("bogus"));
        assert_eq!(p.concurrency.per_cluster, 1);
        assert_eq!(p.concurrency.global, Concurrency::default().global, "left out: shipped");
    }

    #[test]
    fn mode_words_are_kebab_case_on_the_wire() {
        assert_eq!(serde_json::to_string(&Mode::OnDemand).unwrap(), "\"on-demand\"");
        assert_eq!(serde_json::to_string(&Mode::Auto).unwrap(), "\"auto\"");
        let p: Policy = serde_json::from_str(r#"{"mode":"auto"}"#).unwrap();
        assert_eq!(p.mode, Mode::Auto);
        // A file that names a mode keeps it, whatever the shipped one is.
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
        p.paused = Paused { all: true, minutes: 30, since: 1, until: u64::MAX, by: "a".into() };
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

    #[test]
    fn a_stop_ends_by_itself_and_a_stop_with_no_end_is_dropped_on_load() {
        let ask = |m| Paused { all: true, minutes: m, ..Paused::default() };
        let p = ask(30).stamped(&Paused::default(), "ann", 1_000);
        assert_eq!((p.since, p.until, p.by.as_str()), (1_000, 1_000 + 30 * 60_000, "ann"));
        assert!(p.active(1_000) && p.active(1_000 + 30 * 60_000 - 1) && !p.active(1_000 + 30 * 60_000));
        // Asked again while it holds: the first stamp stays, so nobody extends it by saving.
        let again = ask(60).stamped(&p, "bob", 5_000);
        assert_eq!((again.since, again.until, again.by.as_str()), (1_000, p.until, "ann"));
        // After it ended, asking again begins a new one. A length not offered is the shortest.
        let later = ask(7).stamped(&p, "bob", p.until);
        assert_eq!((later.minutes, later.since, later.by.as_str()), (15, p.until, "bob"));
        assert_eq!(Paused::default().stamped(&p, "bob", 2_000), Paused::default());
        // A form saved after the stop ended sends back the stop it showed: not begun again.
        let stale = Paused { all: true, minutes: 30, since: p.since, until: p.until, by: "ann".into() };
        assert_eq!(stale.stamped(&p, "bob", p.until + 1), Paused::default());

        let dir = std::env::temp_dir().join(format!("ep-policy-stop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        // What 0.3.43 wrote: paused for everyone, no end, and a per-cluster list.
        std::fs::write(&path, br#"{"mode":"on-demand","paused":{"all":true,"clusters":["c1"],"since":5,"by":"Admin"}}"#).unwrap();
        let (back, warn) = Policy::load(Some(&path));
        assert!(warn.is_none());
        assert_eq!(back.paused, Paused::default());
        assert_eq!(back.mode, Mode::OnDemand, "the rest of the file is kept");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
