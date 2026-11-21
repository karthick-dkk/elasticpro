//! Each cluster's quiet hours (docs/JOBS.md "Quiet hours"): a small 24-hour profile per cluster,
//! learned from what the core already sees, that tells a heavy job where to move when it finds
//! its cluster busy.
//!
//! * **What it learns from.** The poller's own answers (`poller:*` origins — health every
//!   interval, the small datasets): light requests sent to every cluster round the clock, so
//!   their answer time is the cluster's load, not the request's weight. A job's own heavy
//!   searches are left out: they are slow because they are heavy, and would teach the profile
//!   that whatever hour the job runs in is busy. And once a minute, whether the cluster is busy
//!   (`load::busy`, the one definition) — which also catches a full search queue that a quick
//!   health answer would not show.
//! * **Per hour of the day** (the server's time zone, the stack's `TZ`): a running mean of the
//!   answer time and of the busy minutes, each weighing at most `CAP` samples so the last few
//!   days count and an old pattern fades.
//! * **Score** = mean answer ms + busy share × `BUSY_WEIGHT_MS`; the quietest hour is the
//!   lowest score among the hours known (`MIN_SAMPLES` each), once `MIN_HOURS` of the 24 are
//!   known — and only among the hours the cluster's heavy-job window allows
//!   (`collection::quietest_allowed`). Unknown is not a guess: until then there is no quiet
//!   hour, and the jobs behave as before.
//! * **Bounded and cheap**: 24 small slots per configured cluster, nothing else. The process
//!   with the poller (role core or all) keeps it in memory and writes it to
//!   `<data>/job-runs/quiet.json` every `SAVE_EVERY_MS` — beside `busy.json`, the place the core
//!   already publishes to the worker — so it survives a restart and the worker (which has no
//!   poller) reads it from there.
//!
//! Pure apart from `local_hour`, which reads the server's time zone.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// `<data>/job-runs/quiet.json`.
pub const FILE: &str = "quiet.json";
/// Samples an hour needs before it counts.
pub const MIN_SAMPLES: u32 = 20;
/// Hours of the 24 that must be known before the profile names a quiet hour.
pub const MIN_HOURS: usize = 20;
/// The most samples the running means weigh (about five days of a 30 s health poll, an hour a day).
pub const CAP: u32 = 600;
/// What a fully busy hour adds to its score, in ms of answer time.
pub const BUSY_WEIGHT_MS: f64 = 10_000.0;
/// How often the core writes the profile.
pub const SAVE_EVERY_MS: u64 = 10 * 60_000;
/// A file older than this says nothing (the core has not written it for a week).
pub const FRESH_MS: u64 = 7 * 24 * 3_600_000;
/// The most clusters kept (far above any fleet; only a bound).
pub const MAX_CLUSTERS: usize = 5_000;

/// One hour of the day.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hour {
    /// Answers counted (at most `CAP`) and their running mean, in ms.
    #[serde(default)]
    pub n: u32,
    #[serde(default)]
    pub ms: f64,
    /// Minutes counted (at most `CAP`) and the running share of them that were busy (0–1).
    #[serde(default)]
    pub minutes: u32,
    #[serde(default)]
    pub busy: f64,
}

fn mean(n: &mut u32, avg: &mut f64, x: f64) {
    let w = (*n).min(CAP - 1) as f64 + 1.0;
    *avg += (x - *avg) / w;
    *n = (*n + 1).min(CAP);
}

/// One cluster's 24 hours.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub hours: [Hour; 24],
}

impl Profile {
    pub fn add_answer(&mut self, hour: u32, ms: u64) {
        let h = &mut self.hours[(hour % 24) as usize];
        mean(&mut h.n, &mut h.ms, ms as f64);
    }

    pub fn add_minute(&mut self, hour: u32, busy: bool) {
        let h = &mut self.hours[(hour % 24) as usize];
        mean(&mut h.minutes, &mut h.busy, if busy { 1.0 } else { 0.0 });
    }

    /// Each hour's score, `None` where it is not known yet — all `None` until `MIN_HOURS` are.
    pub fn scores(&self) -> [Option<f64>; 24] {
        let mut out = [None; 24];
        let known = self.hours.iter().filter(|h| h.n >= MIN_SAMPLES).count();
        if known < MIN_HOURS {
            return out;
        }
        for (i, h) in self.hours.iter().enumerate() {
            if h.n >= MIN_SAMPLES {
                out[i] = Some(h.ms + h.busy * BUSY_WEIGHT_MS);
            }
        }
        out
    }

    /// The quietest hour the window allows, or `None` while not known.
    pub fn quiet_hour(&self, window: Option<crate::collection::Hours>) -> Option<u32> {
        crate::collection::quietest_allowed(&self.scores(), window)
    }
}

/// Every cluster's profile, and when it was last written.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuietBook {
    #[serde(default)]
    pub saved_at: u64,
    #[serde(default)]
    pub clusters: BTreeMap<String, Profile>,
}

impl QuietBook {
    fn profile(&mut self, cluster: &str) -> Option<&mut Profile> {
        if cluster.is_empty() || (!self.clusters.contains_key(cluster) && self.clusters.len() >= MAX_CLUSTERS) {
            return None;
        }
        Some(self.clusters.entry(cluster.to_string()).or_default())
    }

    pub fn add_answer(&mut self, cluster: &str, hour: u32, ms: u64) {
        if let Some(p) = self.profile(cluster) {
            p.add_answer(hour, ms);
        }
    }

    pub fn add_minute(&mut self, cluster: &str, hour: u32, busy: bool) {
        if let Some(p) = self.profile(cluster) {
            p.add_minute(hour, busy);
        }
    }

    /// Only the clusters configured now.
    pub fn retain(&mut self, keep: &HashSet<String>) {
        self.clusters.retain(|c, _| keep.contains(c));
    }

    pub fn quiet_hour(&self, cluster: &str, window: Option<crate::collection::Hours>) -> Option<u32> {
        self.clusters.get(cluster).and_then(|p| p.quiet_hour(window))
    }
}

/// Whether a request's answer teaches the profile: one of the poller's own.
pub fn learns_from(origin: &str) -> bool {
    origin.starts_with("poller:")
}

/// The hour of the day, server local time, of a unix-ms instant.
pub fn local_hour(ms: u64) -> Option<u32> {
    use chrono::{TimeZone, Timelike};
    chrono::Local.timestamp_millis_opt(ms as i64).single().map(|t| t.hour())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn learned(quiet: u32) -> Profile {
        let mut p = Profile::default();
        for h in 0..24 {
            for _ in 0..MIN_SAMPLES {
                p.add_answer(h, if h == quiet { 40 } else { 400 + h as u64 });
                p.add_minute(h, false);
            }
        }
        p
    }

    #[test]
    fn unknown_until_enough_hours_are_known_then_the_quietest_one() {
        let mut p = Profile::default();
        for _ in 0..MIN_SAMPLES {
            p.add_answer(3, 10);
        }
        assert_eq!(p.quiet_hour(None), None, "one hour known is no profile");
        let p = learned(3);
        assert_eq!(p.quiet_hour(None), Some(3));
        assert_eq!(p.quiet_hour(crate::collection::Hours::new(12, 18)), Some(12), "only an hour the window allows");
    }

    #[test]
    fn busy_minutes_weigh_against_a_quick_answer() {
        let mut p = learned(3);
        for _ in 0..CAP {
            p.add_minute(3, true);
        }
        assert_ne!(p.quiet_hour(None), Some(3), "a full search queue at 03:00 is not quiet, however quick health is");
    }

    #[test]
    fn the_means_weigh_at_most_cap_samples_and_the_book_is_bounded() {
        let mut p = Profile::default();
        for _ in 0..(CAP * 3) {
            p.add_answer(5, 1_000);
        }
        assert_eq!(p.hours[5].n, CAP);
        for _ in 0..CAP {
            p.add_answer(5, 100);
        }
        assert!(p.hours[5].ms < 500.0, "the old pattern fades: {}", p.hours[5].ms);
        let mut b = QuietBook::default();
        b.add_answer("a", 1, 10);
        b.add_answer("", 1, 10);
        b.add_minute("b", 1, true);
        b.retain(&["a".to_string()].into_iter().collect());
        assert_eq!(b.clusters.keys().collect::<Vec<_>>(), vec!["a"]);
        let text = serde_json::to_string(&b).unwrap();
        assert_eq!(serde_json::from_str::<QuietBook>(&text).unwrap(), b, "round-trips through quiet.json");
        assert!(learns_from("poller:health") && !learns_from("volume-hosts"));
    }
}
