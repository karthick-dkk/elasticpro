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
//! held a site still for days because nobody remembered it. It is begun and ended with
//! `POLICY_PAUSE {minutes}` and `POLICY_RESUME` — an operator's or an admin's (`may_stop`) —
//! which touch nothing else; `POLICY_SET` sets everything else and ignores `paused`.
//!
//! Duplicate requests (`minGapSec`): a request ElasticPro sends by itself is not sent again
//! while the same one was answered less than this long ago — the asker gets that reading
//! (`scheduler::State::gap_until`, and the read cache in `Core::es_req`). While Play runs
//! (`play`): how often Play keeps each dataset coming for a display (`PlaySchedule`). Both are
//! in this file like the rest, and each can be locked by a config.txt key (`MANAGED`), which
//! then wins and reads "managed by config.txt" on Config › Requests.

use super::catalogue::{Dataset, ALL};
use crate::auth::{Caller, Role};
use crate::settings::Settings;
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

/// The refusal a caller limited to some clusters gets for `POLICY_PAUSE` / `POLICY_RESUME`.
pub const STOP_LIMITED: &str =
    "the emergency stop holds every cluster: an operator limited to some clusters cannot begin or end it — ask an administrator, or an operator who sees every cluster";
/// …and a display link, which the gate refuses first (it is not in `auth::PLAY_READS`).
pub const STOP_DISPLAY: &str = "a display link only shows Play";

/// Whether this caller may begin or end the emergency stop (`POLICY_PAUSE`, `POLICY_RESUME`),
/// past the role the gate already checked (operator: `auth::required_role`). `None` is the
/// portable build, which has no accounts.
///
/// The stop holds every cluster — the per-cluster pause went in 0.3.44 — so an operator
/// limited to some clusters (Zabbix host groups, a display link's list) would hold, or let
/// go, clusters it cannot see. Refused, as Play refuses its fleet-wide messages to a limited
/// caller. An administrator is not refused here even when limited: `POLICY_SET` lets an
/// administrator set the rest of the request policy — the mode, the budgets — which already
/// reaches every cluster, and the stop was an administrator's, limited or not, before it had
/// messages of its own. A display link never gets this far (the gate), and is
/// refused here too.
pub fn may_stop(caller: Option<&Caller>) -> Result<(), &'static str> {
    let Some(c) = caller else { return Ok(()) };
    if c.play_only() {
        return Err(STOP_DISPLAY);
    }
    if c.limited() && c.role < Role::Admin {
        return Err(STOP_LIMITED);
    }
    Ok(())
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
    /// Duplicate requests: the same request (cluster and dataset, or for a page's own read
    /// cluster, method, path and body) answered less than this many seconds ago is not sent
    /// again; the asker gets that reading. `GAP_BOUNDS`; never off.
    pub min_gap_sec: u64,
    /// What Play keeps going on its own while a display is open.
    pub play: PlaySchedule,
}

/// Duplicate requests: the shortest and longest gap Config › Requests may set, and the default.
pub const GAP_BOUNDS: (u64, u64) = (30, 600);
pub const GAP_DEFAULT_SEC: u64 = 60;

/// The kinds of request a person types and sends to the cluster as typed, which are never held
/// by the gap nor answered from another's reading: sent at once. By the `purpose` the page
/// names on its `ES` message (ui/js), never guessed from a path. `(purpose, what Config ›
/// Requests calls it)`. Only what really goes to a cluster as typed belongs here: the Indices
/// and Snapshots page searches match their term in the browser over listings read like any
/// page's (and held and shared like them), so they send nothing a person typed.
pub const GAP_EXEMPT: &[(&str, &str)] = &[
    ("console", "the REST console"),
];

/// Whether a request of this purpose is one of `GAP_EXEMPT`.
pub fn gap_exempt(purpose: &str) -> bool {
    GAP_EXEMPT.iter().any(|(p, _)| *p == purpose)
}

/// While Play runs: seconds between fetches of what a display shows, per group of datasets,
/// and the log-delay measurement's two tiers (ui/js/play/measure.js). A person's page that
/// watches a dataset at the same time keeps its own, faster pace while it is open; the gap
/// still holds for both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaySchedule {
    pub health_sec: u64,
    /// SLM and ILM: `policies`, `ilm_errors`, `ilm_assign`.
    pub lifecycle_sec: u64,
    /// `snapshots` and `snapshots_full`.
    pub snapshots_sec: u64,
    pub indices_sec: u64,
    pub nodes_sec: u64,
    /// A full log-delay check: every device, today's query, up to 500.
    pub delay_full_sec: u64,
    /// The late list (devices at or past the yellow line) re-checked, in one request.
    pub delay_late_sec: u64,
}

impl Default for PlaySchedule {
    fn default() -> Self {
        PlaySchedule {
            health_sec: 300,
            lifecycle_sec: 4 * 3600,
            snapshots_sec: 2 * 3600,
            indices_sec: 3600,
            nodes_sec: 300,
            delay_full_sec: 2 * 3600,
            delay_late_sec: 15 * 60,
        }
    }
}

/// Each `PlaySchedule` field: its name on the wire, its bounds in seconds, and the config.txt
/// key that locks it. The one table: `normalised`, `MANAGED` and settings.rs read it.
pub const PLAY_FIELDS: &[(&str, u64, u64, &str)] = &[
    ("healthSec", 60, 3600, "POLL_PLAY_HEALTH_SECONDS"),
    ("lifecycleSec", 900, 86_400, "POLL_PLAY_LIFECYCLE_SECONDS"),
    ("snapshotsSec", 600, 86_400, "POLL_PLAY_SNAPSHOTS_SECONDS"),
    ("indicesSec", 300, 86_400, "POLL_PLAY_INDICES_SECONDS"),
    ("nodesSec", 60, 3600, "POLL_PLAY_NODES_SECONDS"),
    ("delayFullSec", 1800, 86_400, "POLL_PLAY_DELAY_FULL_SECONDS"),
    ("delayLateSec", 300, 7200, "POLL_PLAY_DELAY_LATE_SECONDS"),
];

/// The config.txt key that locks the gap.
pub const GAP_KEY: &str = "POLL_MIN_GAP_SECONDS";

impl PlaySchedule {
    fn slot(&mut self, field: &str) -> Option<&mut u64> {
        Some(match field {
            "healthSec" => &mut self.health_sec,
            "lifecycleSec" => &mut self.lifecycle_sec,
            "snapshotsSec" => &mut self.snapshots_sec,
            "indicesSec" => &mut self.indices_sec,
            "nodesSec" => &mut self.nodes_sec,
            "delayFullSec" => &mut self.delay_full_sec,
            "delayLateSec" => &mut self.delay_late_sec,
            _ => return None,
        })
    }

    pub fn get(&self, field: &str) -> Option<u64> {
        self.clone().slot(field).map(|v| *v)
    }

    /// Within `PLAY_FIELDS`' bounds, and the late list never re-checked less often than a
    /// full check runs.
    pub fn normalised(mut self) -> PlaySchedule {
        for (f, lo, hi, _) in PLAY_FIELDS {
            if let Some(v) = self.slot(f) {
                *v = (*v).clamp(*lo, *hi);
            }
        }
        self.delay_late_sec = self.delay_late_sec.min(self.delay_full_sec);
        self
    }

    /// Seconds between fetches of `ds` while Play watches it; `None` for what Play never shows.
    pub fn interval_secs(&self, ds: Dataset) -> Option<u64> {
        match ds {
            Dataset::Health => Some(self.health_sec),
            Dataset::Nodes => Some(self.nodes_sec),
            Dataset::Policies | Dataset::IlmErrors | Dataset::IlmAssign => Some(self.lifecycle_sec),
            Dataset::Snapshots | Dataset::SnapshotsFull => Some(self.snapshots_sec),
            Dataset::Indices => Some(self.indices_sec),
            // Play has no snapshot-running dot; the page menu does (SNAPSHOT_RUNNING).
            Dataset::Shards | Dataset::SnapshotStatus => None,
        }
    }
}

/// The policy fields config.txt can lock: `(field as POLICY_GET's managed names it, key)`.
pub fn managed_fields() -> Vec<(String, &'static str)> {
    let mut v = vec![("minGapSec".to_string(), GAP_KEY)];
    v.extend(PLAY_FIELDS.iter().map(|(f, _, _, k)| (format!("play.{f}"), *k)));
    v
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
            min_gap_sec: GAP_DEFAULT_SEC,
            play: PlaySchedule::default(),
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
        self.min_gap_sec = self.min_gap_sec.clamp(GAP_BOUNDS.0, GAP_BOUNDS.1);
        self.play = self.play.normalised();
        self
    }

    /// This policy with what config.txt manages put over it, and the fields it locks
    /// (`managed_fields` names). config.txt wins, as everywhere: the value is the key's.
    pub fn with_managed(mut self, s: &Settings) -> (Policy, Vec<String>) {
        let mut locked = vec![];
        let int = |k: &str| s.text(k).and_then(|v| v.parse::<u64>().ok());
        if let Some(n) = int(GAP_KEY) {
            self.min_gap_sec = n;
            locked.push("minGapSec".to_string());
        }
        for (f, _, _, k) in PLAY_FIELDS {
            if let (Some(n), Some(slot)) = (int(k), self.play.slot(f)) {
                *slot = n;
                locked.push(format!("play.{f}"));
            }
        }
        (self.normalised(), locked)
    }

    /// A `POLICY_SET`'s policy, as sent, checked against what config.txt locks. A locked field
    /// is accepted when the page sends a value it can only have come by honestly: config.txt's
    /// own, the value the page was shown (`current` as it runs — normalised, so a late re-check
    /// clamped to the full check reads as clamped), or what this very policy runs as once
    /// config.txt is put over it. Left out, nothing is asked of it. Any other value is refused,
    /// by name — so a page that sends the whole policy back can always save.
    pub fn check_managed(incoming: &serde_json::Value, current: &Policy, s: &Settings) -> Result<(), String> {
        let (shown, locked) = current.clone().with_managed(s);
        if locked.is_empty() {
            return Ok(());
        }
        let parsed: Option<Policy> = serde_json::from_value(incoming.clone()).ok();
        let runs = parsed.map(|p| p.with_managed(s).0);
        let field = |p: &Policy, f: &str| match f.strip_prefix("play.") {
            Some(pf) => p.play.get(pf),
            None => Some(p.min_gap_sec),
        };
        for f in &locked {
            let ptr = format!("/{}", f.replace('.', "/"));
            let Some(asked) = incoming.pointer(&ptr) else { continue };
            let key = managed_fields().into_iter().find(|(n, _)| n == f).map(|(_, k)| k).unwrap_or("");
            let raw = s.text(key).and_then(|v| v.parse::<u64>().ok());
            let ok = asked.as_u64().is_some_and(|n| Some(n) == raw || Some(n) == field(&shown, f)
                || runs.as_ref().is_some_and(|r| Some(n) == field(r, f)));
            if !ok {
                return Err(format!("{f} is managed by config.txt ({key}) and cannot be changed here"));
            }
        }
        Ok(())
    }

    /// What is saved from a policy whose locked fields came from config.txt: the stored value
    /// for each of those, so taking the key out of config.txt brings back what was saved
    /// rather than what config.txt said.
    pub fn keep_stored(mut self, stored: &Policy, locked: &[String]) -> Policy {
        for f in locked {
            match f.strip_prefix("play.") {
                Some(pf) => {
                    if let (Some(v), Some(slot)) = (stored.play.get(pf), self.play.slot(pf)) {
                        *slot = v;
                    }
                }
                None => self.min_gap_sec = stored.min_gap_sec,
            }
        }
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

    #[test]
    fn the_gap_and_the_play_schedule_ship_their_defaults_and_hold_their_bounds() {
        let p = Policy::shipped();
        assert_eq!(p.min_gap_sec, 60);
        assert_eq!(p.play, PlaySchedule { health_sec: 300, lifecycle_sec: 14_400, snapshots_sec: 7200, indices_sec: 3600,
                                         nodes_sec: 300, delay_full_sec: 7200, delay_late_sec: 900 });
        // A file from before these fields gets them as shipped.
        let f: Policy = serde_json::from_str(r#"{"mode":"on-demand"}"#).unwrap();
        assert_eq!((f.min_gap_sec, f.play.clone()), (60, PlaySchedule::default()));
        // Out of bounds: clamped, and the late re-check never slower than the full check.
        let p: Policy = serde_json::from_str(r#"{"minGapSec":5,"play":{"healthSec":1,"nodesSec":999999,"delayFullSec":1800,"delayLateSec":7200}}"#).unwrap();
        let p = p.normalised();
        assert_eq!(p.min_gap_sec, 30);
        assert_eq!((p.play.health_sec, p.play.nodes_sec), (60, 3600));
        assert_eq!((p.play.delay_full_sec, p.play.delay_late_sec), (1800, 1800));
        let p: Policy = serde_json::from_str(r#"{"minGapSec":100000}"#).unwrap();
        assert_eq!(p.normalised().min_gap_sec, 600);
        // On the wire as the UI names them.
        let v = serde_json::to_value(Policy::shipped()).unwrap();
        assert_eq!(v["minGapSec"], serde_json::json!(60));
        assert_eq!(v["play"]["delayLateSec"], serde_json::json!(900));
        assert!(gap_exempt("console"));
        assert!(!gap_exempt("") && !gap_exempt("page:console") && !gap_exempt("refresh") && !gap_exempt("index-search"));
    }

    #[test]
    fn config_txt_locks_the_gap_and_each_play_interval() {
        let txt = Settings::parse("POLL_MIN_GAP_SECONDS=120\nPOLL_PLAY_HEALTH_SECONDS=600\nPOLL_PLAY_DELAY_LATE_SECONDS=1200\n");
        let (p, locked) = Policy::shipped().with_managed(&txt);
        assert_eq!((p.min_gap_sec, p.play.health_sec, p.play.delay_late_sec), (120, 600, 1200));
        assert_eq!(locked, vec!["minGapSec", "play.healthSec", "play.delayLateSec"]);
        // POLICY_SET: a locked field sent with config.txt's value, or left out, is accepted…
        let cur = Policy::shipped();
        assert!(Policy::check_managed(&serde_json::json!({ "minGapSec": 120, "play": { "healthSec": 600 } }), &cur, &txt).is_ok());
        assert!(Policy::check_managed(&serde_json::json!({ "mode": "hybrid", "play": { "nodesSec": 120 } }), &cur, &txt).is_ok());
        // …with another value it is refused, by name and key.
        let e = Policy::check_managed(&serde_json::json!({ "minGapSec": 90 }), &cur, &txt).unwrap_err();
        assert!(e.contains("minGapSec") && e.contains("managed by config.txt") && e.contains("POLL_MIN_GAP_SECONDS"), "{e}");
        let e = Policy::check_managed(&serde_json::json!({ "play": { "delayLateSec": 900 } }), &cur, &txt).unwrap_err();
        assert!(e.contains("play.delayLateSec") && e.contains("POLL_PLAY_DELAY_LATE_SECONDS"), "{e}");
        // What is saved keeps the stored value of a locked field, so removing the key brings it back.
        let mut stored = Policy::shipped();
        stored.min_gap_sec = 45;
        let incoming = Policy { min_gap_sec: 120, mode: Mode::Hybrid, ..Policy::shipped() };
        let kept = incoming.keep_stored(&stored, &locked);
        assert_eq!((kept.min_gap_sec, kept.mode), (45, Mode::Hybrid));
        // Nothing in config.txt: nothing locked.
        assert!(Policy::shipped().with_managed(&Settings::parse("")).1.is_empty());
        assert_eq!(managed_fields().len(), 1 + PLAY_FIELDS.len());
    }

    #[test]
    fn a_locked_late_recheck_clamped_by_the_full_check_can_always_be_saved() {
        // config.txt locks the late re-check at 3600 s; the stored full check is 1800 s, so the
        // late re-check runs (and the page shows) 1800 s. Sending back what the page shows saves.
        let txt = Settings::parse("POLL_PLAY_DELAY_LATE_SECONDS=3600\n");
        let mut stored = Policy::shipped();
        stored.play.delay_full_sec = 1800;
        let (shown, locked) = stored.clone().with_managed(&txt);
        assert_eq!(locked, vec!["play.delayLateSec"]);
        assert_eq!((shown.play.delay_full_sec, shown.play.delay_late_sec), (1800, 1800), "clamped to the full check");
        let page = serde_json::to_value(&shown).unwrap();
        assert!(Policy::check_managed(&page, &stored, &txt).is_ok(), "what the page was shown");
        // The person raises the full check to 2 h, the late field still showing 1800: saves, and
        // then runs at config.txt's 3600.
        let mut raised = page.clone();
        raised["play"]["delayFullSec"] = serde_json::json!(7200);
        assert!(Policy::check_managed(&raised, &stored, &txt).is_ok());
        let p: Policy = serde_json::from_value(raised).unwrap();
        assert_eq!(p.with_managed(&txt).0.play.delay_late_sec, 3600);
        // …and lowers it again below the lock: the clamp wins, and that saves too.
        let mut lowered = serde_json::to_value(Policy::shipped().with_managed(&txt).0).unwrap();
        lowered["play"]["delayFullSec"] = serde_json::json!(1800);
        lowered["play"]["delayLateSec"] = serde_json::json!(1800);
        assert!(Policy::check_managed(&lowered, &Policy::shipped(), &txt).is_ok(), "what this policy runs as");
        // config.txt's own value is always accepted; something else never is.
        let mut own = page.clone();
        own["play"]["delayLateSec"] = serde_json::json!(3600);
        assert!(Policy::check_managed(&own, &stored, &txt).is_ok());
        let mut other = page;
        other["play"]["delayLateSec"] = serde_json::json!(600);
        assert!(Policy::check_managed(&other, &stored, &txt).unwrap_err().contains("POLL_PLAY_DELAY_LATE_SECONDS"));
        // The other way round: the full check locked below a stored late re-check.
        let txt = Settings::parse("POLL_PLAY_DELAY_FULL_SECONDS=1800\n");
        let mut stored = Policy::shipped();
        stored.play.delay_late_sec = 3600;
        let shown = stored.clone().with_managed(&txt).0;
        assert_eq!((shown.play.delay_full_sec, shown.play.delay_late_sec), (1800, 1800));
        assert!(Policy::check_managed(&serde_json::to_value(&shown).unwrap(), &stored, &txt).is_ok());
    }

    #[test]
    fn config_txt_takes_exactly_the_bounds_the_policy_holds() {
        // One definition: settings.rs SPECS and PLAY_FIELDS / GAP_BOUNDS agree, key by key.
        let mut all: Vec<(&str, u64, u64)> = PLAY_FIELDS.iter().map(|(_, lo, hi, k)| (*k, *lo, *hi)).collect();
        all.push((GAP_KEY, GAP_BOUNDS.0, GAP_BOUNDS.1));
        for (k, lo, hi) in all {
            let at = |n: u64| Settings::parse(&format!("{k}={n}")).manages(k);
            assert!(at(lo) && at(hi), "{k}: {lo} and {hi} are allowed");
            assert!(!at(lo - 1) && !at(hi + 1), "{k}: {} and {} are not", lo - 1, hi + 1);
        }
    }

    #[test]
    fn the_stop_is_an_operators_who_sees_every_cluster() {
        use crate::auth::PlayCaller;
        let who = |role, scope: Option<Vec<String>>| Caller { name: "x".into(), role, must_change: false, scope, play: None };
        let team = || Some(vec!["ES team A".to_string()]);
        assert_eq!(may_stop(None), Ok(()), "the portable build has no accounts");
        assert_eq!(may_stop(Some(&who(Role::Operator, None))), Ok(()));
        assert_eq!(may_stop(Some(&who(Role::Admin, None))), Ok(()));
        // Limited to some clusters: the stop would hold the others too.
        assert_eq!(may_stop(Some(&who(Role::Operator, team()))), Err(STOP_LIMITED));
        // An administrator sets the rest of the policy anyway (POLICY_SET), limited or not.
        assert_eq!(may_stop(Some(&who(Role::Admin, team()))), Ok(()));
        // A display link, even one naming every cluster.
        let mut tv = who(Role::User, None);
        tv.play = Some(PlayCaller { link: "l1".into(), clusters: None, allow_from: vec![] });
        assert_eq!(may_stop(Some(&tv)), Err(STOP_DISPLAY));
        // A display link that names clusters is limited as well; still the display refusal.
        tv.play = Some(PlayCaller { link: "l1".into(), clusters: Some(vec!["c1".into()]), allow_from: vec![] });
        tv.role = Role::Admin;
        assert_eq!(may_stop(Some(&tv)), Err(STOP_DISPLAY));
    }
}
