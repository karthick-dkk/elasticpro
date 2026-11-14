//! The one definition of "how late is late" (docs/LOGDELAY.md "Levels").
//!
//! Until 0.3.57 the thresholds lived in `ui/js/core/log-delay.js` (`DEFAULT_THRESHOLDS`,
//! `thresholds(cluster)`, `classify`) and the core stored raw minutes. The page, the mail and
//! the stored delay records could not be made to agree from two copies, so the rule moved
//! here and the UI reads it back through `LOGDELAY_SETTINGS_GET` (`levels`, per cluster).
//!
//! * no delay: under `noDelayUnder` (15 min);
//! * little delay: from there to under `delayFrom` (30 min);
//! * delay: from `delayFrom` to `criticalOver` inclusive (30–60 min);
//! * critical: over `criticalOver` (60 min — exactly 60 is still "delay", the owner's rule);
//! * clock ahead: at or below `-delayFrom` — a device whose clock is ahead of real time,
//!   a different fault with a different fix, tested before the "how big" questions;
//! * other time zone: not a level of the delay at all — a device whose gap sits, steadily, at
//!   a real UTC offset other than its cluster's (`tz.rs`; decided in `state.rs`). Not late.
//!
//! The minutes classified here are the **corrected** delay: the raw gap (arrival − event) with
//! the cluster's log time zone taken out (docs/LOGDELAY.md "Time zones"). A delay period starts
//! at the first measurement at or over `delayFrom` and is solved at the first one back under it
//! (`State::late`). A measurement that could not be taken is `None`, never zero, and classifies
//! as nothing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The three lines that make four levels, in minutes.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Levels {
    pub no_delay_under: f64,
    pub delay_from: f64,
    pub critical_over: f64,
}

impl Default for Levels {
    fn default() -> Levels {
        Levels { no_delay_under: 15.0, delay_from: 30.0, critical_over: 60.0 }
    }
}

impl Levels {
    /// What an admin typed, made sane: each line a finite positive number, in order. A line out
    /// of order is pulled up to the one before it rather than refused, so a half-typed form
    /// cannot leave the product with "critical" below "delay".
    pub fn normalised(mut self) -> Levels {
        let fix = |v: f64, d: f64| if v.is_finite() && v > 0.0 { v } else { d };
        let d = Levels::default();
        self.no_delay_under = fix(self.no_delay_under, d.no_delay_under);
        self.delay_from = fix(self.delay_from, d.delay_from).max(self.no_delay_under);
        self.critical_over = fix(self.critical_over, d.critical_over).max(self.delay_from);
        self
    }

    /// A cluster's own lines over the defaults. `over` is either this module's shape
    /// (`noDelayUnder`, `delayFrom`, `criticalOver`) or the clusters file's `delayThresholds`
    /// as it has always been written (`delayMinutes`, `criticalMinutes`): both are read, the
    /// newer name first, so a cluster that overrode "30/60" before 0.3.57 keeps doing so.
    pub fn with_override(self, over: Option<&Value>) -> Levels {
        let Some(o) = over.and_then(Value::as_object) else { return self };
        let num = |keys: &[&str]| keys.iter().find_map(|k| o.get(*k).and_then(Value::as_f64)).filter(|v| v.is_finite() && *v > 0.0);
        Levels {
            no_delay_under: num(&["noDelayUnder", "no_delay_under"]).unwrap_or(self.no_delay_under),
            delay_from: num(&["delayFrom", "delay_from", "delayMinutes"]).unwrap_or(self.delay_from),
            critical_over: num(&["criticalOver", "critical_over", "criticalMinutes"]).unwrap_or(self.critical_over),
        }
        .normalised()
    }
}

/// What one measurement says about a device. The four delay levels, the clock fault, and the
/// two states that are not measurements at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    NoDelay,
    Little,
    Delay,
    Critical,
    ClockAhead,
    /// Its gap sits at a real UTC offset other than its cluster's, run after run: its logs are
    /// stamped in another zone (the device's clock or the parser's date filter). Not late,
    /// counted apart; shown with its own offset.
    OtherTz,
    /// Seen recently, sending nothing for longer than the silence limit. Not on time, not 0 min.
    Silent,
    /// Its latest document has no readable event time or arrival. "Can't measure", not 0 min.
    Unmeasured,
}

/// Before any measurement, a device is unmeasured — never on time by default.
impl Default for State {
    fn default() -> State {
        State::Unmeasured
    }
}

impl State {
    /// The level of a measured delay. `None` in, nothing out: unreadable is not a level.
    pub fn of(delay_minutes: Option<f64>, l: &Levels) -> Option<State> {
        let m = delay_minutes.filter(|m| m.is_finite())?;
        Some(if m <= -l.delay_from {
            State::ClockAhead
        } else if m > l.critical_over {
            State::Critical
        } else if m >= l.delay_from {
            State::Delay
        } else if m >= l.no_delay_under {
            State::Little
        } else {
            State::NoDelay
        })
    }

    /// A delay period is open while this is true.
    pub fn late(self) -> bool {
        matches!(self, State::Delay | State::Critical)
    }

    /// Counted as "on time" in the totals: measured and under the delay line. Silent,
    /// unmeasured and other-time-zone are neither on time nor late.
    pub fn on_time(self) -> bool {
        matches!(self, State::NoDelay | State::Little | State::ClockAhead)
    }

    /// A delay figure was taken (corrected or, for another zone, by the device's own offset).
    pub fn measured(self) -> bool {
        !matches!(self, State::Silent | State::Unmeasured)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            State::NoDelay => "no_delay",
            State::Little => "little",
            State::Delay => "delay",
            State::Critical => "critical",
            State::ClockAhead => "clock_ahead",
            State::OtherTz => "other_tz",
            State::Silent => "silent",
            State::Unmeasured => "unmeasured",
        }
    }

    /// The words the pages and the mail use.
    pub fn label(self) -> &'static str {
        match self {
            State::NoDelay => "on time",
            State::Little => "little delay",
            State::Delay => "delayed",
            State::Critical => "critical",
            State::ClockAhead => "clock ahead",
            State::OtherTz => "other time zone",
            State::Silent => "silent",
            State::Unmeasured => "can't measure",
        }
    }
}

/// The one tolerance, as the clusters file's `delayThresholds.tzToleranceMinutes` has always
/// named it: a gap within this many minutes of a real offset is that zone (`tz.rs`).
pub const TZ_TOLERANCE_MINUTES: f64 = super::tz::TOLERANCE_MINUTES;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_four_levels_and_their_edges() {
        let l = Levels::default();
        let s = |m: f64| State::of(Some(m), &l).unwrap();
        assert_eq!(s(0.0), State::NoDelay);
        assert_eq!(s(14.99), State::NoDelay);
        assert_eq!(s(15.0), State::Little);
        assert_eq!(s(29.99), State::Little);
        assert_eq!(s(30.0), State::Delay);
        assert_eq!(s(60.0), State::Delay, "exactly 60 is still delay, not critical");
        assert_eq!(s(60.01), State::Critical);
        assert_eq!(s(-5.0), State::NoDelay, "a small negative is clock drift inside the line");
        assert_eq!(s(-30.0), State::ClockAhead);
        assert_eq!(s(-400.0), State::ClockAhead);
    }

    #[test]
    fn unreadable_is_not_a_level() {
        assert_eq!(State::of(None, &Levels::default()), None);
        assert_eq!(State::of(Some(f64::NAN), &Levels::default()), None);
        assert_eq!(State::of(Some(f64::INFINITY), &Levels::default()), None);
    }

    #[test]
    fn late_is_delay_or_critical_and_nothing_else() {
        for s in [State::NoDelay, State::Little, State::ClockAhead, State::OtherTz, State::Silent, State::Unmeasured] {
            assert!(!s.late(), "{s:?}");
        }
        assert!(State::Delay.late() && State::Critical.late());
        assert!(!State::Silent.on_time() && !State::Unmeasured.on_time(), "silent is never on time");
        assert!(!State::OtherTz.on_time() && State::OtherTz.measured(), "another zone is counted apart: measured, not on time, not late");
        assert_eq!(serde_json::to_value(State::OtherTz).unwrap(), json!("other_tz"));
        assert_eq!(State::OtherTz.label(), "other time zone");
        assert_eq!(TZ_TOLERANCE_MINUTES, 3.0);
    }

    #[test]
    fn a_cluster_override_in_either_shape_wins_and_is_kept_in_order() {
        let base = Levels::default();
        let old = base.with_override(Some(&json!({ "delayMinutes": 45, "criticalMinutes": 90, "tzToleranceMinutes": 3 })));
        assert_eq!((old.no_delay_under, old.delay_from, old.critical_over), (15.0, 45.0, 90.0));
        let new = base.with_override(Some(&json!({ "noDelayUnder": 10, "delayFrom": 20, "criticalOver": 40 })));
        assert_eq!((new.no_delay_under, new.delay_from, new.critical_over), (10.0, 20.0, 40.0));
        // Out of order is pulled into order, never refused and never inverted.
        let odd = base.with_override(Some(&json!({ "delayFrom": 100, "criticalOver": 50 })));
        assert_eq!((odd.delay_from, odd.critical_over), (100.0, 100.0));
        assert_eq!(base.with_override(Some(&json!("nonsense"))), base);
        assert_eq!(base.with_override(None), base);
    }

    #[test]
    fn normalising_rejects_nothing_but_nonsense() {
        let l = Levels { no_delay_under: -1.0, delay_from: f64::NAN, critical_over: 0.0 }.normalised();
        assert_eq!(l, Levels::default());
        let l = Levels { no_delay_under: 50.0, delay_from: 30.0, critical_over: 60.0 }.normalised();
        assert_eq!((l.no_delay_under, l.delay_from, l.critical_over), (50.0, 50.0, 60.0));
    }

    #[test]
    fn the_json_names_are_the_contract() {
        let v = serde_json::to_value(Levels::default()).unwrap();
        assert_eq!(v, json!({ "noDelayUnder": 15.0, "delayFrom": 30.0, "criticalOver": 60.0 }));
        assert_eq!(serde_json::to_value(State::ClockAhead).unwrap(), json!("clock_ahead"));
        assert_eq!(serde_json::to_value(State::Unmeasured).unwrap(), json!("unmeasured"));
    }
}
