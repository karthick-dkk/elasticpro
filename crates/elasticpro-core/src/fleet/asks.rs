//! What the duplicate-request gap saved: every ask over the last hour, per dataset, by how it
//! was answered. Request Centre shows it ("health: asked 42 this hour, sent 12, 30 answered
//! from a reading under a minute old").
//!
//! Rolling, by the minute: sixty buckets at most, the oldest dropped as a new minute starts.
//! Pure bookkeeping over a `now` in milliseconds, so it is tested without a clock.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, VecDeque};

/// How one ask was answered. Each ask is exactly one of these, so they add up to "asked".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answered {
    /// A request went to the cluster.
    Sent,
    /// The same request was answered less than the gap ago: the asker got that reading.
    Recent,
    /// The same request was already on its way: the asker shares its answer.
    Shared,
    /// What was held was fresh enough for the asker anyway (its own max age), or the
    /// cluster does not answer and its health probe answers for it.
    Held,
}

const MINUTE_MS: u64 = 60_000;
/// How far back the counts go.
pub const WINDOW_MINUTES: u64 = 60;

/// `[sent, recent, shared, held]` for one name.
type Row = [u64; 4];

fn slot(a: Answered) -> usize {
    match a {
        Answered::Sent => 0,
        Answered::Recent => 1,
        Answered::Shared => 2,
        Answered::Held => 3,
    }
}

#[derive(Default, Debug)]
pub struct AskCounts {
    /// (minute since the epoch, counts by name), oldest first.
    buckets: VecDeque<(u64, BTreeMap<String, Row>)>,
}

impl AskCounts {
    /// One ask of `name` (a dataset's name, or `direct` for a page's own reads).
    pub fn note(&mut self, name: &str, how: Answered, now: u64) {
        let minute = now / MINUTE_MS;
        self.prune(now);
        if self.buckets.back().is_none_or(|(m, _)| *m != minute) {
            self.buckets.push_back((minute, BTreeMap::new()));
        }
        if let Some((_, b)) = self.buckets.back_mut() {
            b.entry(name.to_string()).or_default()[slot(how)] += 1;
        }
    }

    /// Drop the minutes that have left the window.
    pub fn prune(&mut self, now: u64) {
        let minute = now / MINUTE_MS;
        while self.buckets.front().is_some_and(|(m, _)| minute.saturating_sub(*m) >= WINDOW_MINUTES) {
            self.buckets.pop_front();
        }
    }

    /// The last hour, per name: `[sent, recent, shared, held]`.
    pub fn last_hour(&self, now: u64) -> BTreeMap<String, Row> {
        let minute = now / MINUTE_MS;
        let mut out: BTreeMap<String, Row> = BTreeMap::new();
        for (m, b) in &self.buckets {
            if minute.saturating_sub(*m) >= WINDOW_MINUTES {
                continue;
            }
            for (name, row) in b {
                let o = out.entry(name.clone()).or_default();
                for (sum, n) in o.iter_mut().zip(row) {
                    *sum += n;
                }
            }
        }
        out
    }

    /// As REQUEST_LOG carries it: `{windowMinutes, gapSec, since, byDataset: {name: {asked,
    /// sent, recent, shared, held}}}`. `since` is the oldest minute counted, so a core that
    /// started ten minutes ago does not read as an hour's worth.
    pub fn to_json(&self, now: u64, gap_ms: u64) -> Value {
        let mut by = Map::new();
        for (name, r) in self.last_hour(now) {
            by.insert(name, json!({ "asked": r.iter().sum::<u64>(), "sent": r[0], "recent": r[1], "shared": r[2], "held": r[3] }));
        }
        let since = self.buckets.iter().map(|(m, _)| *m)
            .find(|m| (now / MINUTE_MS).saturating_sub(*m) < WINDOW_MINUTES)
            .map(|m| m * MINUTE_MS);
        json!({ "windowMinutes": WINDOW_MINUTES, "gapSec": gap_ms / 1000, "since": since, "byDataset": by })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_add_up_and_roll_off_after_an_hour() {
        let mut c = AskCounts::default();
        let t0 = 10 * 3_600_000;
        c.note("health", Answered::Sent, t0);
        c.note("health", Answered::Recent, t0 + 1_000);
        c.note("health", Answered::Recent, t0 + 30 * MINUTE_MS);
        c.note("health", Answered::Shared, t0 + 30 * MINUTE_MS);
        c.note("direct", Answered::Held, t0 + 59 * MINUTE_MS);
        let j = c.to_json(t0 + 59 * MINUTE_MS, 60_000);
        assert_eq!(j["byDataset"]["health"], json!({ "asked": 4, "sent": 1, "recent": 2, "shared": 1, "held": 0 }));
        assert_eq!(j["byDataset"]["direct"]["held"], json!(1));
        assert_eq!((j["gapSec"].clone(), j["since"].clone()), (json!(60), json!(t0)));
        // An hour after the first minute, it has gone; the rest stay.
        let later = c.last_hour(t0 + 60 * MINUTE_MS);
        assert_eq!(later["health"], [0, 1, 1, 0]);
        c.prune(t0 + 120 * MINUTE_MS);
        assert!(c.last_hour(t0 + 120 * MINUTE_MS).is_empty());
        assert!(c.buckets.is_empty(), "nothing kept past the window");
    }
}
