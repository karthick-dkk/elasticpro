//! Time zones: the one definition of a cluster's log time zone, how it is detected from its
//! devices, and how a measured gap is corrected by it (docs/LOGDELAY.md "Time zones").
//!
//! A device whose raw message carries local time, parsed into `event_created` as UTC, while
//! `@timestamp` is stamped in the cluster's local time and stored as if it were UTC, shows a
//! "delay" equal to the zone's offset: 330 min on an IST cluster whose logs are on time. So:
//!
//! * every cluster has a **log time zone**: the one set in its config (`logTimeZone`: `UTC`, an
//!   IANA name), else the one **detected** from its devices, else none (no correction);
//! * **detection**: each device's raw gap (arrival − event) is matched against every real UTC
//!   offset in use (the IANA database, half- and quarter-hours included) within
//!   `TOLERANCE_MINUTES`; the cluster's zone is the offset most measured devices fall in when at
//!   least `MAJORITY_PERCENT` agree and it holds over the last `STEADY_RUNS` complete runs. A
//!   queue drifts from run to run; an offset does not;
//! * **corrected delay** = raw gap − the cluster's offset at the event's own time (DST-aware
//!   when a zone name is known; the fixed detected offset otherwise);
//! * a device whose gap sits at a different real offset, steadily, is in **another time zone**
//!   (`State::OtherTz`): not late, shown with its own offset;
//! * **unknown is not zero**: under the majority, or not yet steady, nothing is corrected and
//!   the pages say "not detected (x % agree)".
//!
//! Only `Tracker::apply_run` (state.rs) applies this; everything here is pure.

use chrono::{Offset, TimeZone};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

/// A gap within this many minutes of a real offset counts as that zone. The same figure the
/// clusters file's `delayThresholds.tzToleranceMinutes` has always named (levels.rs) and the
/// browser's `PATTERN.tzToleranceMinutes` (ui/js/core/log-delay.js; tools/unit holds them equal).
pub const TOLERANCE_MINUTES: f64 = 3.0;
/// At least this share of the measured devices must fall in one offset.
pub const MAJORITY_PERCENT: u64 = 60;
/// And the same offset must win this many complete runs in a row.
pub const STEADY_RUNS: usize = 3;
/// A device's gap must sit at the same other offset this many runs in a row to be "other time zone".
pub const DEVICE_STEADY_RUNS: u32 = 2;

/// A cluster's `logTimeZone` setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogTimeZone {
    /// The default: the zone most of its devices fall in.
    Detect,
    /// Arrival times are UTC: no correction, a device at an offset is in another zone.
    Utc,
    /// A named IANA zone: the offset at each event's own time.
    Named(Tz),
}

impl Default for LogTimeZone {
    fn default() -> LogTimeZone {
        LogTimeZone::Detect
    }
}

impl LogTimeZone {
    /// What a config entry or an overlay says: `""`/`detect` → Detect; `UTC` (any case,
    /// `Etc/UTC`, `Z`) → Utc; an IANA name, matched whatever its case, → Named. Anything else is
    /// refused by name: an unknown zone is never kept as "no correction".
    pub fn parse(s: &str) -> Result<LogTimeZone, String> {
        let t = s.trim();
        if t.is_empty() || t.eq_ignore_ascii_case("detect") || t.eq_ignore_ascii_case("auto") {
            return Ok(LogTimeZone::Detect);
        }
        if t.eq_ignore_ascii_case("utc") || t.eq_ignore_ascii_case("etc/utc") || t == "Z" || t.eq_ignore_ascii_case("gmt") {
            return Ok(LogTimeZone::Utc);
        }
        if t.len() > 64 || !t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+')) {
            return Err(format!("logTimeZone: {t:?} is not a time zone (detect, UTC, or an IANA name such as Asia/Kolkata)"));
        }
        if let Ok(tz) = Tz::from_str(t) {
            return Ok(LogTimeZone::Named(tz));
        }
        match chrono_tz::TZ_VARIANTS.iter().find(|z| z.name().eq_ignore_ascii_case(t)) {
            Some(tz) => Ok(LogTimeZone::Named(*tz)),
            None => Err(format!("logTimeZone: {t:?} is not a time zone the IANA database knows (detect, UTC, or a name such as Asia/Kolkata)")),
        }
    }

    /// From a config value, when it is text; anything else (absent, null) is Detect.
    pub fn from_value(v: Option<&serde_json::Value>) -> Result<LogTimeZone, String> {
        match v {
            None | Some(serde_json::Value::Null) => Ok(LogTimeZone::Detect),
            Some(serde_json::Value::String(s)) => LogTimeZone::parse(s),
            Some(_) => Err("logTimeZone: text (detect, UTC, or an IANA name)".into()),
        }
    }

    /// The setting as it is written back: `detect`, `UTC`, or the canonical IANA name.
    pub fn setting(&self) -> String {
        match self {
            LogTimeZone::Detect => "detect".into(),
            LogTimeZone::Utc => "UTC".into(),
            LogTimeZone::Named(tz) => tz.name().to_string(),
        }
    }

    /// Set by a person (UTC or a name), as against detected.
    pub fn is_set(&self) -> bool {
        !matches!(self, LogTimeZone::Detect)
    }

    /// The set zone's offset at `ms`, in minutes; `None` for Detect.
    pub fn offset_at(&self, ms: i64) -> Option<i32> {
        match self {
            LogTimeZone::Detect => None,
            LogTimeZone::Utc => Some(0),
            LogTimeZone::Named(tz) => Some(zone_offset_at(*tz, ms)),
        }
    }

    /// The zone's name, for a set zone.
    pub fn name(&self) -> Option<String> {
        match self {
            LogTimeZone::Detect => None,
            LogTimeZone::Utc => Some("UTC".into()),
            LogTimeZone::Named(tz) => Some(tz.name().to_string()),
        }
    }
}

/// A zone's UTC offset at an instant, in minutes (DST included).
pub fn zone_offset_at(tz: Tz, ms: i64) -> i32 {
    let secs = ms.div_euclid(1000);
    let utc = chrono::DateTime::from_timestamp(secs, 0).unwrap_or_default();
    tz.offset_from_utc_datetime(&utc.naive_utc()).fix().local_minus_utc() / 60
}

/// `+05:30`, `−03:30`, `+00:00`: an offset as every page, sheet and mail writes it.
pub fn offset_text(minutes: i32) -> String {
    let a = minutes.unsigned_abs();
    format!("{}{:02}:{:02}", if minutes < 0 { "−" } else { "+" }, a / 60, a % 60)
}

/// The IANA zones worth naming: not the `Etc/…` aliases, not the bare abbreviations.
fn is_region(z: &Tz) -> bool {
    let n = z.name();
    n.contains('/') && !n.starts_with("Etc/") && !n.starts_with("SystemV/")
}

/// Every real UTC offset in use at `ms` (minutes), UTC included: what a device's gap is
/// matched against. From the IANA database, so half- and quarter-hour zones are in it.
pub fn offsets_in_use(ms: i64) -> BTreeSet<i32> {
    chrono_tz::TZ_VARIANTS.iter().filter(|z| is_region(z)).map(|z| zone_offset_at(*z, ms)).chain(std::iter::once(0)).collect()
}

/// The offsets a run matches against: those in use at the run's time and a day before it, so a
/// zone that changed its clocks during the window is still matched either way.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offsets(pub BTreeSet<i32>);

impl Offsets {
    pub fn at_run(run_ms: i64) -> Offsets {
        let mut s = offsets_in_use(run_ms);
        s.extend(offsets_in_use(run_ms - 86_400_000));
        Offsets(s)
    }

    /// The offset a raw gap sits at, within `tolerance` minutes; the nearest when two are
    /// within it (never for a gap exactly between them: real offsets are 15 min apart at least,
    /// the tolerance 3). `None`: a plain delay, not a zone.
    pub fn matching(&self, raw_minutes: f64, tolerance: f64) -> Option<i32> {
        if !raw_minutes.is_finite() {
            return None;
        }
        self.0.iter().copied()
            .map(|o| (o, (raw_minutes - o as f64).abs()))
            .filter(|(_, d)| *d <= tolerance)
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(o, _)| o)
    }
}

/// Whether a gap sits at a real UTC offset (other than UTC itself): the "time-zone shaped"
/// test the delay periods and the fixes read (`Episode::whole_hour`), at the run's own time.
pub fn offset_like(raw_minutes: f64, run_ms: i64) -> bool {
    Offsets::at_run(run_ms).matching(raw_minutes, TOLERANCE_MINUTES).is_some_and(|o| o != 0)
}

/// A zone name for an offset, only when one is unambiguous: a hint zone (the server's, a zone
/// set on another cluster) that sits at this offset now. Otherwise `None`: the pages show the
/// offset, and never invent a name.
pub fn name_for_offset(offset: i32, at: i64, hints: &[Tz]) -> Option<String> {
    if offset == 0 {
        return Some("UTC".into());
    }
    hints.iter().find(|z| zone_offset_at(**z, at) == offset).map(|z| z.name().to_string())
}

/// One example of a zone at an offset ("for example Asia/Singapore"), for the fix text; the
/// first region name the database lists at that offset now. An example, never "the" zone.
pub fn example_zone(offset: i32, at: i64) -> Option<String> {
    if offset == 0 {
        return Some("UTC".into());
    }
    chrono_tz::TZ_VARIANTS.iter().filter(|z| is_region(z)).find(|z| zone_offset_at(**z, at) == offset).map(|z| z.name().to_string())
}

/// Every zone with its offset now, for the Edit cluster dialog's list: `(name, offsetMinutes)`,
/// region names only, sorted by offset then name.
pub fn zones_now(at: i64) -> Vec<(String, i32)> {
    let mut v: Vec<(String, i32)> = chrono_tz::TZ_VARIANTS.iter().filter(|z| is_region(z)).map(|z| (z.name().to_string(), zone_offset_at(*z, at))).collect();
    v.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    v
}

/* ------------------------------------------ detection ------------------------------------------ */

/// What one complete run said: the offset most measured devices fell in (whatever its share),
/// how many of them, out of how many measured.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTally {
    pub at: i64,
    #[serde(default)]
    pub offset: Option<i32>,
    pub agree: u64,
    pub of: u64,
}

impl RunTally {
    /// The devices' matched offsets, counted. `of` is every device with a raw gap, matched or not.
    pub fn count(at: i64, matched: impl Iterator<Item = Option<i32>>) -> RunTally {
        let mut by: BTreeMap<i32, u64> = BTreeMap::new();
        let mut of = 0u64;
        for m in matched {
            of += 1;
            if let Some(o) = m {
                *by.entry(o).or_default() += 1;
            }
        }
        // The largest bucket; on a tie, the smaller offset (deterministic, and UTC before any other).
        let best = by.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(o, n)| (*o, *n));
        RunTally { at, offset: best.map(|b| b.0), agree: best.map(|b| b.1).unwrap_or(0), of }
    }

    /// Whether the winning offset has the majority.
    pub fn majority(&self) -> Option<i32> {
        self.offset.filter(|_| self.of > 0 && self.agree * 100 >= self.of * MAJORITY_PERCENT)
    }

    pub fn pct(&self) -> Option<f64> {
        (self.of > 0).then(|| ((self.agree as f64 / self.of as f64) * 1000.0).round() / 10.0)
    }
}

/// The detected zone, kept between runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub offset_minutes: i32,
    /// The first of the runs that agreed on it.
    pub since_ms: i64,
}

/// What a cluster's tracker remembers about its zone: the last `STEADY_RUNS` complete runs'
/// tallies and what they add up to.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Detection {
    pub runs: Vec<RunTally>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected: Option<Detected>,
}

impl Detection {
    /// One more complete run. Detected when the last `STEADY_RUNS` runs all gave the same
    /// majority offset; let go the same way — when none of the last `STEADY_RUNS` runs gave it —
    /// so one odd run neither sets nor unsets the zone. Returns the detected offset after it.
    pub fn record(&mut self, t: RunTally) -> Option<i32> {
        self.runs.push(t);
        let keep = self.runs.len().saturating_sub(STEADY_RUNS);
        self.runs.drain(..keep);
        let majorities: Vec<Option<i32>> = self.runs.iter().map(RunTally::majority).collect();
        if majorities.len() >= STEADY_RUNS {
            if let Some(o) = majorities[0] {
                if majorities.iter().all(|m| *m == Some(o)) {
                    if self.detected.is_none_or(|d| d.offset_minutes != o) {
                        self.detected = Some(Detected { offset_minutes: o, since_ms: self.runs[0].at });
                    }
                    return Some(o);
                }
            }
        }
        if let Some(d) = self.detected {
            if majorities.len() >= STEADY_RUNS && majorities.iter().all(|m| *m != Some(d.offset_minutes)) {
                self.detected = None;
            }
        }
        self.detected.map(|d| d.offset_minutes)
    }

    pub fn last(&self) -> Option<&RunTally> {
        self.runs.last()
    }

    /// How many of the kept runs agree with the last one's majority.
    pub fn steady_runs(&self) -> usize {
        let Some(last) = self.runs.last().and_then(RunTally::majority) else { return 0 };
        self.runs.iter().rev().take_while(|r| r.majority() == Some(last)).count()
    }
}

/* ------------------------------------------ the view ------------------------------------------ */

/// The cluster's zone as every message says it (`timeZone`): mode `set` | `detected` | `none`,
/// the zone's name when one is known, the offset, how many devices agree, since when.
pub fn view(setting: &LogTimeZone, d: &Detection, now: i64, hints: &[Tz]) -> serde_json::Value {
    let last = d.last().copied().unwrap_or_default();
    let (mode, zone, offset, since) = match setting {
        LogTimeZone::Detect => match d.detected {
            Some(det) => ("detected", name_for_offset(det.offset_minutes, now, hints), Some(det.offset_minutes), Some(det.since_ms)),
            None => ("none", None, None, None),
        },
        s => ("set", s.name(), s.offset_at(now), None),
    };
    serde_json::json!({
        "setting": setting.setting(), "mode": mode, "zone": zone,
        "offsetMinutes": offset, "offset": offset.map(offset_text),
        "agree": (last.of > 0).then_some(last.agree), "of": (last.of > 0).then_some(last.of), "pct": last.pct(),
        "pluralityOffset": last.offset, "pluralityOffsetText": last.offset.map(offset_text),
        "since": since, "steadyRuns": d.steady_runs(), "runsNeeded": STEADY_RUNS,
        "majorityPercent": MAJORITY_PERCENT, "toleranceMinutes": TOLERANCE_MINUTES,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOV: i64 = 1_763_100_000_000; // 2025-11-14, standard time in Europe

    #[test]
    fn the_setting_is_parsed_whatever_its_case_and_an_unknown_zone_is_refused() {
        assert_eq!(LogTimeZone::parse("").unwrap(), LogTimeZone::Detect);
        assert_eq!(LogTimeZone::parse("Detect").unwrap(), LogTimeZone::Detect);
        assert_eq!(LogTimeZone::parse("utc").unwrap(), LogTimeZone::Utc);
        assert_eq!(LogTimeZone::parse("Etc/UTC").unwrap(), LogTimeZone::Utc);
        assert_eq!(LogTimeZone::parse("asia/kolkata").unwrap().setting(), "Asia/Kolkata");
        assert_eq!(LogTimeZone::parse("Europe/Berlin").unwrap().offset_at(NOV), Some(60));
        assert!(LogTimeZone::parse("Asia/Nowhere").unwrap_err().contains("Asia/Nowhere"));
        assert!(LogTimeZone::parse("IST").is_err(), "an abbreviation names no zone (IST is India, Israel and Ireland)");
        assert!(LogTimeZone::parse("+05:30").is_err(), "an offset is not a zone");
        assert_eq!(LogTimeZone::from_value(None).unwrap(), LogTimeZone::Detect);
        assert!(LogTimeZone::from_value(Some(&serde_json::json!(330))).is_err());
    }

    #[test]
    fn offsets_include_the_half_and_quarter_hours_and_a_gap_matches_the_nearest() {
        let o = Offsets::at_run(NOV);
        // Chatham is on summer time in November (+13:45), Newfoundland on standard (−03:30).
        for want in [330, 345, -210, 0, 60, 480, 525, 825, -570] {
            assert!(o.0.contains(&want), "{want} missing from {:?}", o.0);
        }
        assert_eq!(o.matching(330.0, TOLERANCE_MINUTES), Some(330));
        assert_eq!(o.matching(332.9, TOLERANCE_MINUTES), Some(330));
        assert_eq!(o.matching(334.0, TOLERANCE_MINUTES), None, "a 4-minute miss is a delay, not a zone");
        assert_eq!(o.matching(345.0, TOLERANCE_MINUTES), Some(345), "Nepal");
        assert_eq!(o.matching(-208.0, TOLERANCE_MINUTES), Some(-210), "Newfoundland, clock reading ahead");
        assert_eq!(o.matching(1.5, TOLERANCE_MINUTES), Some(0), "on time in a UTC-stamped cluster");
        assert_eq!(o.matching(40.0, TOLERANCE_MINUTES), None);
        assert_eq!(o.matching(f64::NAN, TOLERANCE_MINUTES), None);
        assert!(offset_like(330.0, NOV) && offset_like(60.0, NOV) && offset_like(-210.0, NOV));
        assert!(!offset_like(0.5, NOV) && !offset_like(45.0, NOV) && !offset_like(100.0, NOV));
        assert_eq!(offset_text(330), "+05:30");
        assert_eq!(offset_text(-210), "−03:30");
        assert_eq!(offset_text(0), "+00:00");
    }

    #[test]
    fn a_named_zone_follows_daylight_saving_at_each_events_own_time() {
        let berlin = LogTimeZone::parse("Europe/Berlin").unwrap();
        let summer = 1_752_000_000_000; // July 2025
        assert_eq!(berlin.offset_at(summer), Some(120));
        assert_eq!(berlin.offset_at(NOV), Some(60));
        // 2026-10-25 01:00Z: the last hour of CEST (clocks go back at 01:00Z).
        let change = 1_792_890_000_000;
        assert_eq!(berlin.offset_at(change - 60_000), Some(120));
        assert_eq!(berlin.offset_at(change + 60_000), Some(60));
        let kolkata = LogTimeZone::parse("Asia/Kolkata").unwrap();
        assert_eq!(kolkata.offset_at(summer), Some(330), "no DST");
        assert_eq!(LogTimeZone::Utc.offset_at(NOV), Some(0));
        assert_eq!(LogTimeZone::Detect.offset_at(NOV), None);
    }

    #[test]
    fn detection_needs_the_majority_three_runs_running_and_lets_go_the_same_way() {
        let tally = |at: i64, same: u64, other: u64, none: u64| RunTally::count(at,
            std::iter::repeat_n(Some(330), same as usize).chain(std::iter::repeat_n(Some(480), other as usize)).chain(std::iter::repeat_n(None, none as usize)));
        let mut d = Detection::default();
        assert_eq!(d.record(tally(1, 9, 1, 0)), None, "one run is not steady");
        assert_eq!(d.record(tally(2, 9, 1, 0)), None, "two runs are not steady");
        assert_eq!(d.steady_runs(), 2);
        assert_eq!(d.record(tally(3, 9, 1, 0)), Some(330));
        assert_eq!(d.detected, Some(Detected { offset_minutes: 330, since_ms: 1 }));
        assert_eq!(d.runs.len(), 3, "only the last three are kept");
        // One odd run (a burst of genuinely late devices) does not unset it.
        assert_eq!(d.record(tally(4, 4, 1, 5)), Some(330));
        assert_eq!(d.record(tally(5, 9, 1, 0)), Some(330));
        // Three runs without the majority: let go.
        assert_eq!(d.record(tally(6, 5, 1, 4)), Some(330));
        assert_eq!(d.record(tally(7, 5, 1, 4)), Some(330));
        assert_eq!(d.record(tally(8, 5, 1, 4)), None);
        assert_eq!(d.detected, None);
        // 55 %: never detected.
        let mut e = Detection::default();
        for i in 0..5 {
            assert_eq!(e.record(tally(i, 11, 9, 0)), None);
        }
        assert_eq!(e.last().unwrap().pct(), Some(55.0));
        assert_eq!(e.last().unwrap().majority(), None);
        // Exactly 60 % is enough.
        assert_eq!(tally(0, 6, 4, 0).majority(), Some(330));
        // Nothing measured: nothing said.
        assert_eq!(RunTally::count(0, std::iter::empty()).pct(), None);
    }

    #[test]
    fn a_name_is_given_only_from_a_hint_and_the_view_says_which_mode() {
        let hints = [Tz::Asia__Kolkata, Tz::Europe__Berlin];
        assert_eq!(name_for_offset(330, NOV, &hints), Some("Asia/Kolkata".into()));
        assert_eq!(name_for_offset(480, NOV, &hints), None, "no hint at +08:00: the offset is shown, no name invented");
        assert_eq!(name_for_offset(0, NOV, &[]), Some("UTC".into()));
        assert!(example_zone(480, NOV).unwrap().contains('/'));
        assert_eq!(example_zone(0, NOV), Some("UTC".into()));
        let z = zones_now(NOV);
        assert!(z.iter().any(|(n, o)| n == "Asia/Kolkata" && *o == 330));
        assert!(z.iter().all(|(n, _)| !n.starts_with("Etc/")));
        assert!(z.windows(2).all(|w| w[0].1 <= w[1].1), "sorted by offset");
        let mut d = Detection::default();
        let v = view(&LogTimeZone::Detect, &d, NOV, &hints);
        assert_eq!((v["mode"].as_str(), v["offsetMinutes"].is_null(), v["agree"].is_null()), (Some("none"), true, true));
        for i in 0..3 {
            d.record(RunTally::count(i, std::iter::repeat_n(Some(330), 9).chain(std::iter::once(None))));
        }
        let v = view(&LogTimeZone::Detect, &d, NOV, &hints);
        assert_eq!(v["mode"], "detected");
        assert_eq!(v["zone"], "Asia/Kolkata");
        assert_eq!(v["offset"], "+05:30");
        assert_eq!((v["agree"].as_u64(), v["of"].as_u64(), v["pct"].as_f64()), (Some(9), Some(10), Some(90.0)));
        assert_eq!(v["since"], 0);
        let v = view(&LogTimeZone::Named(Tz::Europe__Berlin), &d, NOV, &hints);
        assert_eq!((v["mode"].as_str(), v["zone"].as_str(), v["offsetMinutes"].as_i64()), (Some("set"), Some("Europe/Berlin"), Some(60)));
        assert_eq!(v["setting"], "Europe/Berlin");
        let v = view(&LogTimeZone::Utc, &Detection::default(), NOV, &[]);
        assert_eq!((v["mode"].as_str(), v["offsetMinutes"].as_i64()), (Some("set"), Some(0)));
    }
}
