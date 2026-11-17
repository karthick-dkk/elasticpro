//! Backfill (docs/VOLUME.md "Backfill"): the past days of the last `backfillDays` that the
//! record does not hold as final and measured, filled a few a run, oldest first, while the
//! cluster is not under query pressure.
//!
//! The daily run's own days are today and yesterday. Every day before yesterday within
//! `backfillDays` (and within `keepMonths`) is the backfill's: a day the record holds as final
//! with a document count is done; one whose indices are still on the cluster (an open index
//! dated on it, or time-split documents on it — `Listing` and `Split`, the collector's own
//! day mapping) is searched by the backfill, `backfillPerRun` a run, oldest first; one whose
//! indices are gone is not asked again and is counted as such, never shown as 0.
//!
//! Pure: which days, and what the status says. The pressure gate and the searches are
//! `run`'s.

use super::collect::DayGroup;
use super::schedule::day_key;
use super::Day;
use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The days the backfill covers on `today`: from `backfill_days` days back to the day before
/// yesterday (yesterday is the daily run's own day), none before `first_kept` (the first day
/// `keepMonths` keeps). `None` when off (`backfill_days` 0) or when that leaves no day.
pub fn window(today: NaiveDate, backfill_days: u32, first_kept: NaiveDate) -> Option<(NaiveDate, NaiveDate)> {
    if backfill_days == 0 {
        return None;
    }
    let from = (today - Duration::days(backfill_days as i64)).max(first_kept);
    let to = today - Duration::days(2);
    (from <= to).then_some((from, to))
}

/// Whether a kept day still wants measuring: not final, or final without a document count
/// (an answer that carried no `hits.total`). A final day with one is done and never asked again.
pub fn wanted(day: &Day) -> bool {
    !day.is_final || day.docs.is_none()
}

/// What one day of the window is, after this run's listing was applied to the record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Final and measured.
    Done,
    /// Not done, and its indices are on the cluster and open: the backfill searches it.
    Fillable,
    /// Not done, and its indices went (`live: false`): kept as last measured, not asked again.
    Gone,
    /// No record: the cluster has no index on it (the listing gives every day that has one a
    /// record), so there is nothing to fill it from.
    NoIndex,
    /// Not done, its indices are there but none is open (or the time split is not known this
    /// run): asked on a later run.
    Waiting,
}

/// One day of the window: its record (if any), what the listing has dated on it, and whether
/// this run's time split has documents on it — the same inputs `collect::needs_search` reads.
pub fn classify(day: Option<&Day>, group: Option<&DayGroup>, in_split: bool) -> Kind {
    match day {
        None => Kind::NoIndex,
        Some(d) if !wanted(d) => Kind::Done,
        Some(d) if !d.live => Kind::Gone,
        Some(_) if in_split || group.is_some_and(|g| g.open > 0) => Kind::Fillable,
        Some(_) => Kind::Waiting,
    }
}

/// What the backfill does this run: the days to search (oldest first, at most `per_run`) and
/// the counts the status carries.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    /// Searched this run, in this order: the oldest fillable days, at most `per_run`.
    pub days: Vec<NaiveDate>,
    pub fillable: u64,
    pub gone: u64,
    pub no_index: u64,
    pub waiting: u64,
}

/// The plan for the window `[from, to]`, every day of it classified (`kinds`; a day missing
/// from it has no record: `NoIndex`).
pub fn plan(from: NaiveDate, to: NaiveDate, kinds: &BTreeMap<NaiveDate, Kind>, per_run: u32) -> Plan {
    let mut p = Plan { from: Some(from), to: Some(to), ..Plan::default() };
    let mut d = from;
    while d <= to {
        match kinds.get(&d).copied().unwrap_or(Kind::NoIndex) {
            Kind::Done => {}
            Kind::Fillable => {
                p.fillable += 1;
                if p.days.len() < per_run as usize {
                    p.days.push(d);
                }
            }
            Kind::Gone => p.gone += 1,
            Kind::NoIndex => p.no_index += 1,
            Kind::Waiting => p.waiting += 1,
        }
        d += Duration::days(1);
    }
    p
}

/// The backfill as the status shows it (`status.backfill` in `VOLUME_DAILY` / `VOLUME_MONTHLY`,
/// kept in `state.json`): what the last daily run found and did. `null` while it is off.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// When the run began (epoch ms).
    pub at: i64,
    /// The window, `YYYY-MM-DD`: `backfillDays` back to the day before yesterday.
    pub from: String,
    pub to: String,
    /// Days of the window the record did not hold as final and measured when the run began:
    /// `fillable + gone + noIndex + waiting`.
    pub missing: u64,
    /// Of those, the ones with indices on the cluster.
    pub fillable: u64,
    /// Searched by the backfill this run, and of those, final and measured afterwards.
    pub searched: u64,
    pub filled: u64,
    /// Fillable days still not final and measured after this run: the next runs' work.
    pub queued: u64,
    /// The record kept them, but their indices went before they were final.
    pub gone: u64,
    /// No record and no index on the cluster: nothing to fill them from.
    pub no_index: u64,
    /// Their indices are there but closed, or the time split was not known this run.
    pub waiting: u64,
    /// Why the backfill stopped before its bound, when the cluster was under query pressure.
    pub paused: Option<String>,
}

impl Status {
    /// The status of a run that searched `searched` of the plan's days, `filled` of them now
    /// final and measured; `paused` when the pressure gate stopped it.
    pub fn of(plan: &Plan, at: i64, searched: u64, filled: u64, paused: Option<String>) -> Status {
        Status {
            at,
            from: plan.from.map(day_key).unwrap_or_default(),
            to: plan.to.map(day_key).unwrap_or_default(),
            missing: plan.fillable + plan.gone + plan.no_index + plan.waiting,
            fillable: plan.fillable,
            searched,
            filled,
            queued: plan.fillable.saturating_sub(filled),
            gone: plan.gone,
            no_index: plan.no_index,
            waiting: plan.waiting,
            paused,
        }
    }

    /// One line for the run log (docs/JOBS.md): what the backfill did on this cluster.
    pub fn note(&self) -> Option<String> {
        let mut parts = vec![];
        if self.searched > 0 {
            parts.push(format!("backfilled {} of {} missing day{}", self.filled, self.fillable, if self.fillable == 1 { "" } else { "s" }));
        }
        if let Some(p) = &self.paused {
            parts.push(format!("backfill paused: {p}"));
        }
        (!parts.is_empty()).then(|| parts.join("; "))
    }
}

/// The words the status uses for the pressure gate, with the signal's own reason.
pub fn paused_why(reason: &str) -> String {
    format!("cluster under query pressure ({reason}); tried again on the next run")
}

/// Query pressure, for the backfill: a fresh reading of the search thread pool that found its
/// queue over half full or rejections since the last reading (`report::control::pool_pressure`),
/// else the one busy definition's (`jobs::load::busy`) `pool` or `429` line — the cluster's own
/// word that it is pressed, as the Nodes page's pressure is rejections and queues. Not `slow`:
/// an answer over 8 s is what a day's aggregation over a big day takes by itself (that is why
/// a day's search has 110 s), so counting it would pause the backfill on its own first search.
pub fn pressure(reading: Option<String>, busy: Option<&crate::jobs::load::Busy>) -> Option<String> {
    reading.or_else(|| busy.filter(|b| matches!(b.signal.as_str(), "pool" | "429")).map(|b| b.reason.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::schedule::parse_day;

    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }

    fn day(s: &str, is_final: bool, live: bool, docs: Option<u64>) -> Day {
        Day { day: s.into(), is_final, live, docs, ..Day::default() }
    }

    fn open(n: u64) -> DayGroup {
        DayGroup { indices: n.max(1), open: n, ..DayGroup::default() }
    }

    /// The window: backfillDays back to the day before yesterday; never today or yesterday,
    /// never before keepMonths' first day; off at 0.
    #[test]
    fn the_window_is_the_days_before_yesterday() {
        let t = d("2026-11-17");
        assert_eq!(window(t, 30, d("2025-11-01")), Some((d("2026-10-18"), d("2026-11-15"))), "30 days back, today and yesterday out");
        assert_eq!(window(t, 0, d("2025-11-01")), None, "0 is off");
        assert_eq!(window(t, 1, d("2025-11-01")), None, "only yesterday: the daily run's own day");
        assert_eq!(window(t, 2, d("2025-11-01")), Some((d("2026-11-15"), d("2026-11-15"))));
        assert_eq!(window(t, 30, d("2026-11-01")), Some((d("2026-11-01"), d("2026-11-15"))), "keepMonths 1 keeps this month only");
        assert_eq!(window(d("2026-11-01"), 30, d("2026-11-01")), None, "on the 1st with keepMonths 1 nothing is left");
    }

    /// Missing, not measured and final: only a day that is not final (or final with no count)
    /// and whose indices are open on the cluster is searched; gone days are skipped and said.
    #[test]
    fn which_days_are_filled() {
        assert_eq!(classify(Some(&day("2026-11-01", true, true, Some(5))), Some(&open(1)), false), Kind::Done, "final and measured");
        assert_eq!(classify(Some(&day("2026-11-01", true, false, Some(5))), None, false), Kind::Done, "gone, but final and measured");
        assert_eq!(classify(Some(&day("2026-11-01", true, true, None)), Some(&open(1)), false), Kind::Fillable, "final but no count");
        assert_eq!(classify(Some(&day("2026-11-01", false, true, Some(5))), Some(&open(2)), false), Kind::Fillable,
                   "N of M shards failed: figures kept, not final");
        assert_eq!(classify(Some(&day("2026-11-01", false, true, None)), Some(&open(1)), false), Kind::Fillable,
                   "the search failed: never aggregated");
        assert_eq!(classify(Some(&day("2026-11-01", false, true, None)), None, true), Kind::Fillable, "time-split documents on it");
        assert_eq!(classify(Some(&day("2026-11-01", false, false, None)), None, false), Kind::Gone, "retention took its indices");
        assert_eq!(classify(None, None, false), Kind::NoIndex, "no record: no index on the cluster");
        assert_eq!(classify(Some(&day("2026-11-01", false, true, None)), Some(&open(0)), false), Kind::Waiting, "every index closed");
        assert_eq!(classify(Some(&day("2026-11-01", false, true, None)), None, false), Kind::Waiting, "time split not known this run");
    }

    /// Oldest first, at most `per_run`; the counts add up to the days missing.
    #[test]
    fn the_plan_is_bounded_and_oldest_first() {
        let (from, to) = (d("2026-10-18"), d("2026-11-15"));
        let mut kinds = BTreeMap::new();
        let mut x = from;
        while x <= to {
            kinds.insert(x, Kind::Done);
            x += Duration::days(1);
        }
        for s in ["2026-11-10", "2026-10-25", "2026-10-20", "2026-11-14", "2026-10-30", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"] {
            kinds.insert(d(s), Kind::Fillable);
        }
        kinds.insert(d("2026-10-18"), Kind::Gone);
        kinds.insert(d("2026-10-19"), Kind::Gone);
        kinds.remove(&d("2026-10-21"));
        kinds.insert(d("2026-11-15"), Kind::Waiting);
        let p = plan(from, to, &kinds, 7);
        assert_eq!(p.days, ["2026-10-20", "2026-10-25", "2026-10-30", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"].map(d).to_vec(),
                   "the seven oldest");
        assert_eq!((p.fillable, p.gone, p.no_index, p.waiting), (9, 2, 1, 1));
        assert_eq!(plan(from, to, &kinds, 1).days, vec![d("2026-10-20")]);
        // A day nothing classified (no month file) has no record.
        let empty = plan(d("2026-11-01"), d("2026-11-03"), &BTreeMap::new(), 7);
        assert_eq!((empty.days.len(), empty.no_index), (0, 3));

        let st = Status::of(&p, 1, 7, 6, None);
        assert_eq!((st.missing, st.fillable, st.queued, st.from.as_str(), st.to.as_str()), (13, 9, 3, "2026-10-18", "2026-11-15"));
        assert_eq!(st.note().as_deref(), Some("backfilled 6 of 9 missing days"));
        let paused = Status::of(&p, 1, 0, 0, Some(paused_why("n1's search queue is 600 of 1000")));
        assert_eq!(paused.queued, 9, "nothing filled: all still queued");
        assert_eq!(paused.note().as_deref(),
                   Some("backfill paused: cluster under query pressure (n1's search queue is 600 of 1000); tried again on the next run"));
        assert_eq!(Status::of(&plan(from, from, &kinds, 7), 1, 0, 0, None).note(), None, "nothing to say");
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!((v["noIndex"].as_u64(), v["paused"].clone()), (Some(1), serde_json::Value::Null), "camelCase, paused null: {v}");
    }

    /// The pressure gate: a pressed thread pool or a 429 stops it; a slow answer does not.
    #[test]
    fn query_pressure_is_the_pool_or_a_429_not_slowness() {
        use crate::jobs::load::Busy;
        let b = |signal: &str| Busy { cluster: "c".into(), signal: signal.into(), reason: format!("{signal} reason"), since: None };
        assert_eq!(pressure(Some("n1's search queue is 600 of 1000".into()), None).as_deref(), Some("n1's search queue is 600 of 1000"));
        assert_eq!(pressure(None, Some(&b("pool"))).as_deref(), Some("pool reason"), "a reading of a few minutes ago still counts");
        assert_eq!(pressure(None, Some(&b("429"))).as_deref(), Some("429 reason"));
        assert_eq!(pressure(None, Some(&b("slow"))), None, "slowness is a big day's own search, not pressure");
        assert_eq!(pressure(None, None), None, "calm");
        assert_eq!(pressure(Some("rejected".into()), Some(&b("slow"))).as_deref(), Some("rejected"));
    }
}
