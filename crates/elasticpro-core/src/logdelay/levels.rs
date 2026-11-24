//! The one definition of "how late is late" (docs/LOGDELAY.md "Levels").
//!
//! Until 0.3.57 the thresholds lived in `ui/js/core/log-delay.js` (`DEFAULT_THRESHOLDS`,
//! `thresholds(cluster)`, `classify`) and the core stored raw minutes. The page, the mail and
//! the stored delay records could not be made to agree from two copies, so the rule moved
//! here and the UI reads it back through `LOGDELAY_SETTINGS_GET` (`levels`, per cluster).
//!
//! * no delay (below the delay line): under `delayFrom` (30 min);
//! * delay: from `delayFrom` to `criticalOver` inclusive (30–60 min);
//! * critical: over `criticalOver` (60 min — exactly 60 is still "delay", the owner's rule);
//! * clock ahead: at or below `-delayFrom` — a device whose clock is ahead of real time,
//!   a different fault with a different fix, tested before the "how big" questions;
//! * other time zone: not a level of the delay at all — a device whose gap sits, steadily, at
//!   a real UTC offset other than its cluster's (`tz.rs`; decided in `state.rs`). Not late.
//! * part delayed: some of a device's log types are late, some are on time (`State::of_types`).
//!   Not a late device, not an on-time one: its own count (0.3.90).
//!
//! There is no "little delay" band (the owner's rule, 0.3.62): the three configured levels are
//! all anyone sees. `noDelayUnder` stays in the JSON for the settings file and the clients that
//! send it, and is always equal to `delayFrom`; `State::Little` stays so points stored before
//! 0.3.62 still read, and is never produced.
//!
//! The minutes classified here are the **corrected** delay: the raw gap (arrival − event) with
//! the cluster's log time zone taken out (docs/LOGDELAY.md "Time zones"). A delay period starts
//! at the first measurement at or over `delayFrom` and is solved at the first one back under it
//! (`State::late`). A measurement that could not be taken is `None`, never zero, and classifies
//! as nothing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The two lines that make three levels, in minutes. `no_delay_under` is kept for compatibility
/// and always equals `delay_from` once normalised.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Levels {
    pub no_delay_under: f64,
    pub delay_from: f64,
    pub critical_over: f64,
}

impl Default for Levels {
    fn default() -> Levels {
        Levels { no_delay_under: 30.0, delay_from: 30.0, critical_over: 60.0 }
    }
}

impl Levels {
    /// What an admin typed, made sane: each line a finite positive number, in order. A line out
    /// of order is pulled up to the one before it rather than refused, so a half-typed form
    /// cannot leave the product with "critical" below "delay". `no_delay_under`, whatever was
    /// sent, is the delay line: the band under it is the whole "below" band.
    pub fn normalised(mut self) -> Levels {
        let fix = |v: f64, d: f64| if v.is_finite() && v > 0.0 { v } else { d };
        let d = Levels::default();
        self.delay_from = fix(self.delay_from, d.delay_from);
        self.critical_over = fix(self.critical_over, d.critical_over).max(self.delay_from);
        self.no_delay_under = self.delay_from;
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

/// What one measurement says about a device. The three delay levels, the clock fault, and the
/// two states that are not measurements at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    NoDelay,
    /// Not produced since 0.3.62 (no "little delay" band): kept so stored points and daily
    /// totals written before it still read. Counted with `NoDelay` everywhere.
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
    /// Some of its log types are late and some are on time (0.3.90): neither late nor on time,
    /// its own count (docs/LOGDELAY.md "Log types").
    PartDelay,
}

/// The ECS field a device's logs say their type in: the same on every cluster, no setting. The
/// mapping decides `log_type` or `log_type.keyword`.
pub const LOG_TYPE_FIELD: &str = "log_type";
/// How documents without that field are shown: a type of its own, never merged with a real value
/// of the same text.
pub const NO_LOG_TYPE: &str = "(no log type)";

/// Before any measurement, a device is unmeasured — never on time by default.
impl Default for State {
    fn default() -> State {
        State::Unmeasured
    }
}

impl State {
    pub const ALL: [State; 9] = [State::NoDelay, State::Little, State::Delay, State::Critical, State::ClockAhead, State::OtherTz, State::Silent, State::Unmeasured,
                                 State::PartDelay];

    /// Its place in `ALL`, as points are held; an unknown code is "can't measure", never on time.
    pub(super) fn code(self) -> u8 {
        self as u8
    }
    pub(super) fn of_code(c: u8) -> State {
        State::ALL.get(c as usize).copied().unwrap_or(State::Unmeasured)
    }
    /// Its letter in a log type's points as written.
    pub(super) fn letter(self) -> char {
        b"nldcazsup"[self as usize] as char
    }
    pub(super) fn of_letter(c: char) -> Option<State> {
        State::ALL.into_iter().find(|s| s.letter() == c)
    }

    /// A device's state from its log types read in one run — the one rule (docs/LOGDELAY.md "Log
    /// types"). Every measured one late: late, at the worst one's level. Some late: part delayed.
    /// None late: on time, or in another time zone when all of them are. `None` — the device's
    /// newest document decides, as before 0.3.90 — with fewer than two read, or none measured.
    pub fn of_types(read: &[State]) -> Option<State> {
        if read.len() < 2 {
            return None;
        }
        let measured: Vec<State> = read.iter().copied().filter(|s| s.measured() && !s.cant_measure()).collect();
        let late: Vec<State> = measured.iter().copied().filter(|s| s.late()).collect();
        if measured.is_empty() {
            None
        } else if late.len() == measured.len() {
            Some(if late.contains(&State::Critical) { State::Critical } else { State::Delay })
        } else if !late.is_empty() {
            Some(State::PartDelay)
        } else if measured.iter().all(|s| *s == State::OtherTz) {
            Some(State::OtherTz)
        } else {
            Some(State::NoDelay)
        }
    }

    /// The level of a measured delay. `None` in, nothing out: unreadable is not a level.
    pub fn of(delay_minutes: Option<f64>, l: &Levels) -> Option<State> {
        let m = delay_minutes.filter(|m| m.is_finite())?;
        Some(if m <= -l.delay_from {
            State::ClockAhead
        } else if m > l.critical_over {
            State::Critical
        } else if m >= l.delay_from {
            State::Delay
        } else {
            State::NoDelay
        })
    }

    /// A delay period is open while this is true.
    pub fn late(self) -> bool {
        matches!(self, State::Delay | State::Critical)
    }

    /// "On time": measured and under the delay line. Silent, unmeasured, clock-ahead and
    /// other-time-zone are neither on time nor late.
    pub fn on_time(self) -> bool {
        matches!(self, State::NoDelay | State::Little)
    }

    /// No delay can be measured: no readable clock, or a clock ahead (how late its logs are
    /// cannot be told from it).
    pub fn cant_measure(self) -> bool {
        matches!(self, State::Unmeasured | State::ClockAhead)
    }

    /// Without delay, as it is counted and reported (the owner's rule, 2026-11-24): on time,
    /// silent or can't measure — every device not shown to be late. The device itself keeps its
    /// own state; another time zone stays its own class.
    pub fn no_delay(self) -> bool {
        self.on_time() || self.cant_measure() || self == State::Silent
    }

    /// A figure was taken (corrected or, for another zone, by the device's own offset); a clock
    /// ahead has one, which is no delay (`cant_measure`).
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
            State::PartDelay => "part_delay",
        }
    }

    /// The words the pages and the mail use.
    pub fn label(self) -> &'static str {
        match self {
            State::NoDelay => "on time",
            State::Little => "on time",
            State::Delay => "delayed",
            State::Critical => "critical",
            State::ClockAhead => "clock ahead",
            State::OtherTz => "other time zone",
            State::Silent => "silent",
            State::Unmeasured => "can't measure",
            State::PartDelay => "part delayed",
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
    fn the_three_levels_and_their_edges() {
        let l = Levels::default();
        let s = |m: f64| State::of(Some(m), &l).unwrap();
        assert_eq!(s(0.0), State::NoDelay);
        assert_eq!(s(14.99), State::NoDelay);
        assert_eq!(s(15.0), State::NoDelay, "no little-delay band: below the delay line is one band");
        assert_eq!(s(29.99), State::NoDelay);
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
        for s in [State::NoDelay, State::Little, State::ClockAhead, State::OtherTz, State::Silent, State::Unmeasured, State::PartDelay] {
            assert!(!s.late(), "{s:?}");
        }
        assert!(State::Delay.late() && State::Critical.late());
        assert!(!State::Silent.on_time() && !State::Unmeasured.on_time() && !State::ClockAhead.on_time(), "silent and clock ahead are never on time");
        for (s, no_delay) in [(State::NoDelay, true), (State::Silent, true), (State::Unmeasured, true), (State::ClockAhead, true),
                              (State::OtherTz, false), (State::Delay, false), (State::Critical, false)] {
            assert_eq!(s.no_delay(), no_delay, "{s:?}");
        }
        assert!(!State::OtherTz.on_time() && State::OtherTz.measured(), "another zone is counted apart: measured, not on time, not late");
        assert_eq!(serde_json::to_value(State::OtherTz).unwrap(), json!("other_tz"));
        assert_eq!(State::OtherTz.label(), "other time zone");
        assert_eq!(TZ_TOLERANCE_MINUTES, 3.0);
    }

    #[test]
    fn a_device_is_late_only_when_every_measured_log_type_is() {
        use State::*;
        let of = |v: &[State]| State::of_types(v);
        assert_eq!(of(&[Delay, Delay]), Some(Delay));
        assert_eq!(of(&[Delay, Critical]), Some(Critical), "the worst one's level");
        assert_eq!(of(&[Delay, NoDelay, NoDelay]), Some(PartDelay), "one of three late");
        assert_eq!(of(&[Critical, OtherTz]), Some(PartDelay), "on time in another zone is not late");
        assert_eq!(of(&[NoDelay, OtherTz]), Some(NoDelay));
        assert_eq!(of(&[OtherTz, OtherTz]), Some(OtherTz));
        // What could not be measured is neither late nor on time: the measured ones decide.
        assert_eq!(of(&[Critical, Unmeasured]), Some(Critical));
        assert_eq!(of(&[NoDelay, ClockAhead, Silent]), Some(NoDelay));
        assert_eq!(of(&[Unmeasured, ClockAhead]), None, "nothing measured: the newest document, as before");
        assert_eq!((of(&[]), of(&[Delay])), (None, None), "one log type: as before");
        // Part delayed is never on time, late, silent, or in No delay.
        assert!(!PartDelay.on_time() && !PartDelay.late() && !PartDelay.no_delay() && !PartDelay.cant_measure() && PartDelay.measured());
        assert_eq!(serde_json::to_value(PartDelay).unwrap(), json!("part_delay"));
        assert_eq!((PartDelay.as_str(), PartDelay.label()), ("part_delay", "part delayed"));
    }

    #[test]
    fn a_cluster_override_in_either_shape_wins_and_is_kept_in_order() {
        let base = Levels::default();
        let old = base.with_override(Some(&json!({ "delayMinutes": 45, "criticalMinutes": 90, "tzToleranceMinutes": 3 })));
        assert_eq!((old.no_delay_under, old.delay_from, old.critical_over), (45.0, 45.0, 90.0));
        // A `noDelayUnder` from before 0.3.62 is read and ignored: the delay line is the one line.
        let new = base.with_override(Some(&json!({ "noDelayUnder": 10, "delayFrom": 20, "criticalOver": 40 })));
        assert_eq!((new.no_delay_under, new.delay_from, new.critical_over), (20.0, 20.0, 40.0));
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
        assert_eq!((l.no_delay_under, l.delay_from, l.critical_over), (30.0, 30.0, 60.0), "noDelayUnder never moves the delay line");
    }

    #[test]
    fn the_json_names_are_the_contract() {
        let v = serde_json::to_value(Levels::default()).unwrap();
        assert_eq!(v, json!({ "noDelayUnder": 30.0, "delayFrom": 30.0, "criticalOver": 60.0 }), "noDelayUnder stays in the JSON, equal to delayFrom");
        assert_eq!(serde_json::to_value(State::ClockAhead).unwrap(), json!("clock_ahead"));
        assert_eq!(serde_json::to_value(State::Unmeasured).unwrap(), json!("unmeasured"));
    }
}
