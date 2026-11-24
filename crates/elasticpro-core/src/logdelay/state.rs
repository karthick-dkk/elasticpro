//! What the core remembers about each device between runs, and how one run changes it
//! (docs/LOGDELAY.md "Delay periods", "Silences", "Daily totals").
//!
//! ```text
//!   previous state ──▶ apply(run, readings, zone) ──▶ new state
//!                        │
//!                        ├── the cluster's log time zone detected from the readings (tz.rs),
//!                        │   each raw gap corrected by it; a device steady at another offset ─▶ other time zone
//!                        ├── a device measured late with no open period      ─▶ period opened
//!                        ├── a device measured under the line with one open  ─▶ period solved
//!                        ├── a device steady in a new zone with one open     ─▶ period ended, not solved
//!                        ├── a device missing for longer than the silence limit ─▶ silent
//!                        ├── each log type of a device the same way, as a series of its own;
//!                        │   the device's state from them (`State::of_types`)
//!                        └── a device back after a silence                   ─▶ silence closed
//! ```
//!
//! A start or solve time is the run's time, so it is as exact as the interval. A silent or
//! unmeasurable device (no readable clock, or a clock ahead) changes nothing about an open
//! period: nothing was measured, and "unknown" solves nothing (CLAUDE.md). An open period counts
//! up to its last measurement once that is older than `stale_after_ms`, never up to now. The pure function is `apply`; nothing here touches
//! a disk or a cluster.

use super::levels::{Levels, State, NO_LOG_TYPE};
use super::measure::{round2, Reading, TypeReading};
use super::points::Points;
use super::tz::{self, Detection, Home, LogTimeZone, Offsets, RunTally};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One measurement of one device, as the tracker keeps the recent ones (31 days) for the
/// device graph, the medians and the daily totals, without reading the day files back.
/// Written as `[t, m, s]`, not an object: a cluster of 2000 devices holds 740 000 of these.
/// An object-form point (`{t, m, s}`) still reads.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(from = "PointRepr", into = "(i64, Option<f64>, State)")]
pub struct Point {
    /// The run's time, epoch ms.
    pub t: i64,
    /// `None`: silent or can't measure.
    pub m: Option<f64>,
    pub s: State,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PointRepr {
    Tuple(i64, Option<f64>, State),
    Object { t: i64, #[serde(default)] m: Option<f64>, s: State },
}

impl From<PointRepr> for Point {
    fn from(r: PointRepr) -> Point {
        match r {
            PointRepr::Tuple(t, m, s) | PointRepr::Object { t, m, s } => Point { t, m, s },
        }
    }
}
impl From<Point> for (i64, Option<f64>, State) {
    fn from(p: Point) -> (i64, Option<f64>, State) {
        (p.t, p.m, p.s)
    }
}

/// One delay period: open while `solved_ms` is `None`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub device: String,
    /// A log type's own period: which one. `no_type`: the documents without one. A device's
    /// period has neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_type: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_type: bool,
    pub started_ms: i64,
    #[serde(default)]
    pub solved_ms: Option<i64>,
    /// Set when this ended without being solved: the device was forgotten (a week unseen), or
    /// its time zone changed. Never "still late" after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_ms: Option<i64>,
    /// Why it ended unsolved (`ENDED_FORGOTTEN`, `ENDED_ZONE`, `ENDED_PART`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_why: Option<String>,
    /// When the device's delay was last measured in this period. `None`: kept before 0.3.89.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_measured_ms: Option<i64>,
    /// An open period nobody has measured lately: where it stops counting (`all_episodes`).
    #[serde(skip)]
    pub measured_until_ms: Option<i64>,
    pub worst_minutes: f64,
    pub worst_state: State,
    /// The last measured delay (the one that solved it, for a solved period).
    pub last_minutes: f64,
    pub last_state: State,
    /// Measurements taken while it was open, the solving one included.
    pub measurements: u32,
    /// Late measurements that sat within the tolerance of a real time-zone offset (60, 120,
    /// 330, 345, …; `tz.rs`), and every one taken in another zone: the "a whole hour off"
    /// pattern is read from this against `measurements`.
    #[serde(default)]
    pub whole_hour: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extras: BTreeMap<String, String>,
}

/// `Episode::ended_why`: the device was not seen for a week.
pub const ENDED_FORGOTTEN: &str = "not seen for a week";
/// `Episode::ended_why`: the device's gap moved to another time zone for good.
pub const ENDED_ZONE: &str = "time zone changed";
/// `Episode::ended_why`: the device is only part delayed from here on.
pub const ENDED_PART: &str = "only some of its log types are late";

/// How long after a measurement an open period may still count as late: one measurement
/// interval, or the silence limit, whichever is smaller, and half of it (30 minutes at least) for
/// the next run to be spread, to read its clusters and to be written — else every late device read
/// "not measured since" during each run. Past it nothing is known, so the period counts up to its
/// last measurement (docs/LOGDELAY.md "Delay periods").
pub fn stale_after_ms(interval_ms: i64, silent_after_ms: i64) -> i64 {
    let due = interval_ms.min(silent_after_ms).max(1);
    due + (due / 2).max(30 * 60_000)
}

impl Episode {
    /// Where an unsolved period stops counting, when that is not now: for one that ended (the
    /// device forgotten or moved) its last measurement — nothing after it was measured — and the
    /// same for an open one nobody has measured lately.
    fn unsolved_until(&self) -> Option<i64> {
        self.ended_ms.map(|e| self.last_measured_ms.map_or(e, |m| m.min(e))).or(self.measured_until_ms)
    }

    /// Where it stops counting: solved, `unsolved_until`, or `now`.
    pub fn end_ms(&self, now: i64) -> i64 {
        self.solved_ms.or_else(|| self.unsolved_until()).unwrap_or(now)
    }

    /// Late at instant `at`: begun before it, not solved before it, not yet ended, and not past
    /// the last measurement of a period nobody measures any more.
    pub fn late_at(&self, at: i64) -> bool {
        self.started_ms < at && self.solved_ms.map(|s| s >= at).unwrap_or_else(|| self.unsolved_until().is_none_or(|m| m >= at))
    }

    /// Still open.
    pub fn open(&self) -> bool {
        self.solved_ms.is_none() && self.ended_ms.is_none()
    }

    /// Open, and not measured since `measured_until_ms`.
    pub fn stale(&self) -> bool {
        self.open() && self.measured_until_ms.is_some()
    }

    /// How long it lasted, or has lasted so far at `now`.
    pub fn lasted_ms(&self, now: i64) -> i64 {
        (self.end_ms(now) - self.started_ms).max(0)
    }

    /// How much of it fell inside `[from, to)`, in ms.
    pub fn overlap_ms(&self, from: i64, to: i64, now: i64) -> i64 {
        let end = self.end_ms(now);
        (end.min(to) - self.started_ms.max(from)).max(0)
    }

    /// What its shape suggests, when it suggests anything: a steady whole-hour offset, or a
    /// clock ahead of real time. Read by the device page's "Looks like" and by the fixes.
    pub fn pattern(&self) -> Option<&'static str> {
        if self.worst_state == State::ClockAhead || self.last_state == State::ClockAhead {
            return Some("clock ahead");
        }
        if self.measurements >= 2 && self.whole_hour * 10 >= self.measurements * 8 {
            return Some("a whole hour off: time zone");
        }
        None
    }
}

/// A stretch with no logs at all from a device that had been sending.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Silence {
    pub device: String,
    /// The last arrival before it went quiet.
    pub from_ms: i64,
    /// The first arrival after, once there is one.
    #[serde(default)]
    pub to_ms: Option<i64>,
    /// What came back first: how many documents in the window, and how late the newest was.
    #[serde(default)]
    pub burst_docs: Option<u64>,
    #[serde(default)]
    pub burst_minutes: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceState {
    pub first_seen_ms: i64,
    pub last_run_ms: i64,
    #[serde(default)]
    pub last_arrival_ms: Option<i64>,
    #[serde(default)]
    pub last_event_ms: Option<i64>,
    /// The field `last_event_ms` was read from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_field: Option<String>,
    /// The corrected delay (the raw gap with the zone taken out; the device's own for another zone).
    #[serde(default)]
    pub last_minutes: Option<f64>,
    /// The raw gap, arrival − event, as measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_raw_minutes: Option<f64>,
    /// The device's zone from its raw gap (tz.rs `Offsets::device_zone`), when it sits at a real
    /// offset, and for how many runs in a row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz_offset: Option<i32>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub tz_streak: u32,
    /// Where its logs sit when on time, once confirmed (tz.rs `Home`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<Home>,
    /// The cluster offset it was last seen on time at, before a home is confirmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_time_at: Option<i32>,
    /// Another offset its gap has sat at since, for how many runs, the last of them when.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_gap: Option<i32>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub moved_runs: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_ms: Option<i64>,
    /// When its delay was last measured (silent, can't measure and clock ahead are not).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_measured_ms: Option<i64>,
    /// The offset taken out of `last_minutes`: the cluster's, or the device's own for another zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_offset: Option<i32>,
    #[serde(default = "unmeasured")]
    pub state: State,
    pub docs: u64,
    /// Documents of each run's window in the last 24 hours, for "logs a day" (`Tracker::docs_counted`).
    #[serde(default)]
    pub day_docs: Vec<(i64, u64)>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extras: BTreeMap<String, String>,
    #[serde(default)]
    pub open: Option<Episode>,
    #[serde(default)]
    pub silence: Option<Silence>,
    #[serde(default)]
    pub recent: Points,
    /// Its log types, each a series like the device's own (docs/LOGDELAY.md "Log types"): its
    /// `last_run_ms` is the last run that had documents of it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub types: Vec<DeviceState>,
    /// The first run that read it by log types, and the last that did or was to (`types_truncated`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types_since_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types_run_ms: Option<i64>,
    /// That run did not read, or could not keep, every log type it has.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub types_truncated: bool,
    /// Its state is its log types' (`State::of_types`), not its newest document's.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub by_types: bool,
    /// In `types`: which log type. `no_type`: the documents without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_type: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_type: bool,
}

fn unmeasured() -> State {
    State::Unmeasured
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// One cluster's memory.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracker {
    #[serde(default)]
    pub devices: BTreeMap<String, DeviceState>,
    /// Solved periods, oldest first, kept `KEEP_MS`.
    #[serde(default)]
    pub episodes: Vec<Episode>,
    /// Ended silences, oldest first, kept `KEEP_MS`.
    #[serde(default)]
    pub silences: Vec<Silence>,
    #[serde(default)]
    pub last_run_ms: Option<i64>,
    /// The measurement interval of the last run (each run reads a window of it) and its silence
    /// limit, for `stale_after`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silent_after_ms: Option<i64>,
    /// The last run that could not read this cluster at all, when that was after `last_run_ms`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_failed: Option<FailedRun>,
    /// How the last run read this cluster's devices (pages, complete, cut at the cap).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_read: Option<super::collect::RunInfo>,
    /// The log time zone detected from the devices (tz.rs): the last runs' tallies, the result.
    #[serde(default)]
    pub tz: Detection,
    /// Ended periods of log types, oldest first, kept `TYPE_EPISODES_MS`, at most
    /// `TYPE_EPISODES_KEPT`: what was cut by that number started before `type_episodes_cut_ms`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub type_episodes: Vec<Episode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_episodes_cut_ms: Option<i64>,
    /// Log types the last run read and had no room to keep (`TYPES_KEPT`, `SERIES_KEPT`).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub types_not_kept: u32,
    /// Devices the last run read without their log types (`measure::TYPES_PER_RUN`).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub types_unread: u32,
}

/// A run that read nothing of the cluster.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedRun {
    pub at: i64,
    pub error: String,
}

/// The interval taken for a tracker written before 0.3.89 (no interval kept): the silence
/// limit's and the schedule's default.
pub const DEFAULT_INTERVAL_MS: i64 = 2 * 3_600_000;

/// How long the built-in store keeps a solved period, a silence, a day file (Storage board:
/// "Kept 90 days").
pub const KEEP_MS: i64 = 90 * 86_400_000;
/// How long a device's recent points are kept in the tracker: a month, so the 30-day pages'
/// medians, maxima and graph are measured over the whole range, not part of it.
pub const RECENT_MS: i64 = 31 * 86_400_000;
/// A device not seen for this long is forgotten: it is no longer "silent", it is gone.
pub const FORGET_MS: i64 = 7 * 86_400_000;
/// How long a log type's points are kept in the tracker. Older ones are in the day files
/// (`store.rs`), read for one device when its page asks for them.
pub const TYPE_RECENT_MS: i64 = 8 * 86_400_000;
/// How long, and how many at most, a cluster keeps ended periods of log types.
pub const TYPE_EPISODES_MS: i64 = RECENT_MS;
pub const TYPE_EPISODES_KEPT: usize = 100_000;
/// Log types kept for one device, and for one cluster. One beyond them still counts in its
/// device's state of the run; it has no history, and the pages say so.
pub const TYPES_KEPT: usize = 40;
pub const SERIES_KEPT: usize = 100_000;

/// What one run did, for the documents it writes and the line it logs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Applied {
    /// Every device's state after the run, with its reading: the measurement documents.
    pub rows: Vec<Row>,
    pub opened: Vec<Episode>,
    pub solved: Vec<Episode>,
    /// Open periods this run measured again (worst/last changed): written again, same id.
    pub continued: Vec<Episode>,
    /// Periods that ended unsolved (the device forgotten, its time zone changed).
    pub ended: Vec<Episode>,
    pub silences_begun: Vec<Silence>,
    pub silences_ended: Vec<Silence>,
    pub forgotten: usize,
    /// The same for the log types' own periods.
    pub type_opened: Vec<Episode>,
    pub type_continued: Vec<Episode>,
    pub type_solved: Vec<Episode>,
    pub type_ended: Vec<Episode>,
}

/// One device's measurement row for this run.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub device: String,
    pub docs: u64,
    pub arrival_ms: Option<i64>,
    pub event_ms: Option<i64>,
    /// The field `event_ms` was read from.
    pub event_field: Option<String>,
    /// The corrected delay: `raw_gap_minutes − tz_offset_minutes`.
    pub delay_minutes: Option<f64>,
    /// Arrival − event, as measured.
    pub raw_gap_minutes: Option<f64>,
    /// The device's zone: its known one (`Home`), else the one its gap apparently puts it in
    /// (tz.rs `Offsets::device_zone`: −330 on a UTC cluster is +05:30).
    pub device_tz_offset: Option<i32>,
    /// What was taken out: the cluster's offset, or the device's own gap figure for another zone
    /// (−330 for a +05:30 device on a UTC cluster). `None`:
    /// the cluster has no zone (nothing corrected).
    pub tz_offset_minutes: Option<i32>,
    pub state: State,
    pub extras: BTreeMap<String, String>,
    /// Its log types as this run read them (`None`: not read by log types), and the place in it
    /// of the one its figures above are from (`None`: its newest document).
    pub types: Option<Vec<RowType>>,
    pub by_type: Option<usize>,
    pub types_truncated: bool,
}

/// One log type of a device's measurement row.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RowType {
    /// `None`: the documents without one.
    pub log_type: Option<String>,
    pub docs: u64,
    pub event_ms: Option<i64>,
    pub event_field: Option<String>,
    pub delay_minutes: Option<f64>,
    pub raw_gap_minutes: Option<f64>,
    pub tz_offset_minutes: Option<i32>,
    pub device_tz_offset: Option<i32>,
    pub state: State,
}

impl RowType {
    pub fn name(&self) -> &str {
        self.log_type.as_deref().unwrap_or(NO_LOG_TYPE)
    }
}

/// A time-zone-shaped delay: within the tolerance of a real UTC offset other than UTC (60,
/// 120, 330, 345, …; tz.rs), among the offsets in use at the run. A real backlog never sits there.
pub fn whole_hour(m: f64, offsets: &Offsets) -> bool {
    offsets.matching(m, tz::TOLERANCE_MINUTES).is_some_and(|o| o != 0)
}

/// What every reading of one run is judged by.
struct RunCx<'a> {
    run_ms: i64,
    levels: &'a Levels,
    offsets: &'a Offsets,
    /// The cluster's zone is set by name (it has daylight saving of its own).
    named: bool,
    /// The cluster's offset for an event of that time.
    cluster_offset: &'a dyn Fn(Option<i64>) -> Option<i32>,
}

/// One reading of a series, its zone taken out: what it is, before anything is kept.
struct Judged {
    raw: Option<f64>,
    minutes: Option<f64>,
    state: State,
    applied: Option<i32>,
    zone: Option<i32>,
    moved: bool,
}

/// What one reading did to one series.
#[derive(Default)]
struct Change {
    /// The corrected delay as kept.
    minutes: Option<f64>,
    /// The series' zone as the pages write it.
    zone: Option<i32>,
    opened: Option<Episode>,
    continued: Option<Episode>,
    solved: Option<Episode>,
    ended: Option<Episode>,
}

/// What the zone step says about one reading.
struct Zoned {
    corrected: Option<f64>,
    applied: Option<i32>,
    /// Its zone is another than the cluster's.
    other: bool,
    zone: Option<i32>,
    /// Its known zone was given up for another at this reading.
    moved: bool,
}

impl DeviceState {
    /// Its zone as the pages write it, the cluster being at `co`: the known one, else the one its
    /// last gap sits at.
    pub fn zone_offset(&self, co: Option<i32>) -> Option<i32> {
        match (self.home, co) {
            (Some(h), Some(co)) => Some(h.zone_now(co)),
            (Some(h), None) if !h.same_as_cluster() => Some(h.zone),
            _ => self.tz_offset,
        }
    }

    /// The zone step: the gap matched against the real offsets in use, and the delay measured
    /// against the zone the series is known to be in — kept once it is confirmed (`Home`), found
    /// again only after `REHOME_RUNS` at another offset. Without a known zone: the cluster's
    /// offset, or, steady from the first sighting on, the series' own (as before 0.3.89).
    /// A series east of the cluster (event ahead) is matched by its own offset too
    /// (`Offsets::device_zone`).
    fn zone_step(&mut self, raw: Option<f64>, co: Option<i32>, cx: &RunCx) -> Zoned {
        let dev = raw.and_then(|m| cx.offsets.device_zone(m, co, tz::TOLERANCE_MINUTES));
        match dev.map(|z| z.zone) {
            Some(o) if self.tz_offset == Some(o) => self.tz_streak = self.tz_streak.saturating_add(1),
            Some(o) => { self.tz_offset = Some(o); self.tz_streak = 1; }
            None => { self.tz_offset = None; self.tz_streak = 0; }
        }
        let seen = dev.map(|z| z.zone);
        let (Some(raw), Some(co)) = (raw, co) else {
            let zone = seen.or_else(|| self.home.and_then(|h| co.map(|co| h.zone_now(co))));
            return Zoned { corrected: raw, applied: None, other: false, zone, moved: false };
        };
        if self.home.is_some_and(|h| h.expected(co, cx.named).is_none()) {
            self.home = None;
            (self.moved_gap, self.moved_runs, self.moved_ms) = (None, 0, None);
        }
        let home = self.home.and_then(|h| h.expected(co, cx.named));
        let elsewhere = dev.filter(|z| z.gap != home.unwrap_or(co));
        match elsewhere {
            Some(z) if self.moved_gap == Some(z.gap) => {
                if self.moved_ms.is_none_or(|t| cx.run_ms - t >= tz::REHOME_RUN_GAP_MS) {
                    self.moved_runs = self.moved_runs.saturating_add(1);
                    self.moved_ms = Some(cx.run_ms);
                }
            }
            Some(z) => (self.moved_gap, self.moved_runs, self.moved_ms) = (Some(z.gap), 1, Some(cx.run_ms)),
            None => (self.moved_gap, self.moved_runs, self.moved_ms) = (None, 0, None),
        }
        // Seen at this offset from the start: never on time in the cluster's zone, and no delay
        // measured at any other gap.
        let first_sighting = home.is_none() && self.on_time_at != Some(co) && self.open.as_ref().is_none_or(|e| e.measurements < self.tz_streak);
        let mut moved = false;
        match (elsewhere, dev) {
            (Some(z), _) if first_sighting && self.tz_streak >= tz::DEVICE_STEADY_RUNS => self.home = Some(Home::found(z, co, cx.run_ms)),
            (Some(z), _) if self.moved_runs >= tz::REHOME_RUNS => {
                self.home = Some(Home::found(z, co, cx.run_ms));
                moved = true;
            }
            (None, Some(z)) if home.is_none() => {
                self.on_time_at = Some(co);
                if self.tz_streak >= tz::DEVICE_STEADY_RUNS {
                    self.home = Some(Home::found(z, co, cx.run_ms));
                }
            }
            _ => {}
        }
        if moved {
            (self.moved_gap, self.moved_runs, self.moved_ms) = (None, 0, None);
        }
        let at = self.home.and_then(|h| h.expected(co, cx.named)).unwrap_or(co);
        let zone = self.home.map(|h| h.zone_now(co)).or(seen);
        Zoned { corrected: Some(raw - at as f64), applied: Some(at), other: at != co, zone, moved }
    }

    /// One reading applied to one series — its zone, its level, its delay period, its points.
    /// Everything a series keeps is in `self`: a device's own series and each of its log types'
    /// take their readings through here.
    fn take_reading(&mut self, key: &str, raw: Option<f64>, co: Option<i32>, cx: &RunCx) -> Change {
        let j = self.judge(raw, co, cx);
        self.settle(key, j, cx)
    }

    /// The zone step and the level of one reading.
    fn judge(&mut self, raw: Option<f64>, co: Option<i32>, cx: &RunCx) -> Judged {
        let z = self.zone_step(raw, co, cx);
        let state = match State::of(z.corrected, cx.levels) {
            None => State::Unmeasured,
            // On time in a zone other than the cluster's. Late there is late.
            Some(State::NoDelay) if z.other => State::OtherTz,
            Some(s) => s,
        };
        let minutes = z.corrected.filter(|_| state != State::Unmeasured).map(round2);
        Judged { raw: raw.map(round2), minutes, state, applied: z.applied, zone: z.zone, moved: z.moved }
    }

    /// What a reading, judged, changes: the delay period, the points.
    fn settle(&mut self, key: &str, z: Judged, cx: &RunCx) -> Change {
        let (state, m) = (z.state, z.minutes);
        self.last_raw_minutes = z.raw;
        self.applied_offset = z.applied;
        let mut out = Change { minutes: m, zone: z.zone, ..Change::default() };
        if state == State::PartDelay {
            // Its period was the whole device's: it ends, unsolved. Its late log types have theirs.
            if let Some(mut e) = self.open.take() {
                e.last_measured_ms = Some(cx.run_ms);
                e.ended_ms = Some(cx.run_ms);
                e.ended_why = Some(ENDED_PART.into());
                out.ended = Some(e);
            }
        }
        if z.moved {
            // Its time zone changed: what was measured against the old one ends, unsolved.
            if let Some(mut e) = self.open.take() {
                e.ended_ms = Some(cx.run_ms);
                e.ended_why = Some(ENDED_ZONE.into());
                out.ended = Some(e);
            }
        }
        if let Some(m) = m {
            self.last_minutes = Some(m);
        }
        // A clock ahead is no measurement of a delay: it opens, continues and solves nothing.
        if let Some(m) = m.filter(|_| !state.cant_measure()) {
            self.last_measured_ms = Some(cx.run_ms);
            match self.open.take() {
                Some(mut ep) => {
                    ep.measurements += 1;
                    ep.last_minutes = m;
                    ep.last_state = state;
                    ep.last_measured_ms = Some(cx.run_ms);
                    if m > ep.worst_minutes {
                        ep.worst_minutes = m;
                        ep.worst_state = state;
                    }
                    if state == State::OtherTz || (state.late() && whole_hour(m, cx.offsets)) {
                        ep.whole_hour += 1;
                    }
                    if !self.extras.is_empty() {
                        ep.extras = self.extras.clone();
                    }
                    if state.late() {
                        out.continued = Some(ep.clone());
                        self.open = Some(ep);
                    } else {
                        ep.solved_ms = Some(cx.run_ms);
                        out.solved = Some(ep);
                    }
                }
                None if state.late() => {
                    let ep = Episode {
                        device: key.to_string(), log_type: self.log_type.clone(), no_type: self.no_type, started_ms: cx.run_ms, last_measured_ms: Some(cx.run_ms),
                        worst_minutes: m, worst_state: state, last_minutes: m, last_state: state, measurements: 1,
                        whole_hour: whole_hour(m, cx.offsets) as u32, extras: self.extras.clone(), ..Episode::default()
                    };
                    out.opened = Some(ep.clone());
                    self.open = Some(ep);
                }
                None => {}
            }
        }
        self.state = state;
        self.recent.push(Point { t: cx.run_ms, m, s: state });
        out
    }

    /// A log type's name as the pages write it.
    pub fn type_name(&self) -> &str {
        self.log_type.as_deref().unwrap_or(NO_LOG_TYPE)
    }

    /// The same among other names: a real value with the text of "none" is quoted.
    pub fn type_label(&self) -> String {
        if self.log_type.as_deref() == Some(NO_LOG_TYPE) { format!("“{NO_LOG_TYPE}”") } else { self.type_name().to_string() }
    }

    /// The state of one of its log types, as of the last run that read them: `None` when that run
    /// did not read this one (it has more than were read), so that no logs is not known either.
    pub fn type_state(&self, s: &DeviceState) -> Option<State> {
        let quiet = s.state == State::Silent && s.recent.iter().next_back().map(|p| p.t) >= self.types_run_ms;
        (quiet || Some(s.last_run_ms) == self.types_run_ms).then_some(s.state)
    }

    /// Its late log types, the worst first.
    pub fn late_types(&self) -> Vec<&DeviceState> {
        let mut v: Vec<&DeviceState> = self.types.iter().filter(|s| self.type_state(s).is_some_and(|x| x.late())).collect();
        v.sort_by(|a, b| b.last_minutes.partial_cmp(&a.last_minutes).unwrap_or(std::cmp::Ordering::Equal).then(a.type_name().cmp(b.type_name())));
        v
    }

    /// One run's log types applied: each its own series, one that had no document in the window
    /// "no logs" (unless not all were read). Returns them as the measurement row has them.
    /// `room`: how many more the cluster may keep.
    fn take_types(&mut self, key: &str, types: Vec<TypeReading>, all_read: bool, room: &mut Room, cx: &RunCx, out: &mut Applied) -> Vec<RowType> {
        self.types_since_ms.get_or_insert(cx.run_ms);
        self.types_run_ms = Some(cx.run_ms);
        self.types_truncated = !all_read;
        let mut rows = vec![];
        for t in types {
            let at = self.types.iter().position(|s| s.log_type == t.log_type);
            let mut spare = DeviceState { first_seen_ms: cx.run_ms, no_type: t.log_type.is_none(), log_type: t.log_type, recent: Points::compact(), ..DeviceState::default() };
            let kept = at.is_some() || (self.types.len() < TYPES_KEPT && room.left > 0);
            let s = match at {
                Some(i) => &mut self.types[i],
                None if kept => {
                    room.left -= 1;
                    self.types.reserve_exact(1);
                    self.types.push(std::mem::take(&mut spare));
                    self.types.last_mut().expect("just pushed")
                }
                None => {
                    room.not_kept += 1;
                    self.types_truncated = true;
                    &mut spare
                }
            };
            // A type never measured is in its device's zone, where that is known.
            if s.home.is_none() && s.last_measured_ms.is_none() {
                s.home = self.home;
            }
            s.last_run_ms = cx.run_ms;
            s.docs = t.docs;
            s.last_arrival_ms = t.arrival_ms.or(s.last_arrival_ms);
            if t.event_ms.is_some() {
                (s.last_event_ms, s.event_field) = (t.event_ms, t.event_field);
            }
            let c = s.take_reading(key, t.delay_minutes.filter(|m| m.is_finite()), (cx.cluster_offset)(t.event_ms), cx);
            rows.push(RowType { log_type: s.log_type.clone(), docs: t.docs, event_ms: s.last_event_ms, event_field: s.event_field.clone(), delay_minutes: c.minutes,
                                raw_gap_minutes: s.last_raw_minutes, tz_offset_minutes: s.applied_offset, device_tz_offset: c.zone, state: s.state });
            if !kept {
                continue;
            }
            out.type_opened.extend(c.opened);
            out.type_continued.extend(c.continued);
            out.type_solved.extend(c.solved);
            out.type_ended.extend(c.ended);
        }
        if all_read {
            self.quiet_types(cx.run_ms);
        }
        rows
    }

    /// Its log types without a document at this run: no logs. Never on time, and no measurement.
    fn quiet_types(&mut self, run_ms: i64) {
        for s in self.types.iter_mut().filter(|s| s.last_run_ms != run_ms) {
            s.state = State::Silent;
            s.docs = 0;
            s.recent.push(Point { t: run_ms, m: None, s: State::Silent });
        }
    }

    /// Log types not seen for a week are dropped, their open periods ended, unsolved.
    fn forget_types(&mut self, run_ms: i64, all: bool, out: &mut Applied) {
        self.types.retain_mut(|s| {
            let keep = !all && run_ms - s.last_run_ms < FORGET_MS;
            if !keep {
                let last = Tracker::last_measured(s);
                if let Some(mut e) = s.open.take() {
                    e.last_measured_ms = e.last_measured_ms.or(last);
                    e.ended_ms = Some(run_ms);
                    e.ended_why = Some(ENDED_FORGOTTEN.into());
                    out.type_ended.push(e);
                }
            }
            keep
        });
    }
}

/// How many more log types a cluster may keep, and how many a run had no room for.
struct Room {
    left: usize,
    not_kept: u32,
}

/// Of one run's log types, the one the device's figures are from, and its state from all of them
/// (`State::of_types`): the worst late one; with none late the newest document's when that is in
/// the same state, else the worst in it. `None`: the newest document decides, as before 0.3.90.
fn device_by_types(rows: &[RowType], newest: State) -> Option<(State, Option<usize>)> {
    let state = State::of_types(&rows.iter().map(|r| r.state).collect::<Vec<_>>())?;
    let late = state.late() || state == State::PartDelay;
    if !late && newest == state {
        return Some((state, None));
    }
    let worst = rows.iter().enumerate().filter(|(_, r)| if late { r.state.late() } else { r.state == state })
        .max_by(|(_, a), (_, b)| a.delay_minutes.partial_cmp(&b.delay_minutes).unwrap_or(std::cmp::Ordering::Equal));
    Some((state, worst.map(|(i, _)| i)))
}

impl Tracker {
    /// Open periods, every device.
    pub fn open_episodes(&self) -> impl Iterator<Item = &Episode> {
        self.devices.values().filter_map(|d| d.open.as_ref())
    }

    /// `stale_after_ms` by the last run's interval and silence limit.
    pub fn stale_after(&self) -> i64 {
        let every = self.interval_ms.unwrap_or(DEFAULT_INTERVAL_MS);
        stale_after_ms(every, self.silent_after_ms.unwrap_or(every))
    }

    /// When the device's delay was last measured.
    pub fn last_measured(d: &DeviceState) -> Option<i64> {
        d.last_measured_ms.or_else(|| d.recent.iter().rev().find(|p| p.m.is_some() && !p.s.cant_measure()).map(|p| p.t))
    }

    /// A device's open period as it counts at `now`: up to its last measurement when that is
    /// older than `stale_after`.
    pub fn open_at(&self, d: &DeviceState, now: i64) -> Option<Episode> {
        let mut e = d.open.clone()?;
        let last = e.last_measured_ms.or_else(|| Self::last_measured(d)).unwrap_or(e.started_ms).max(e.started_ms);
        e.last_measured_ms = Some(last);
        e.measured_until_ms = (now - last > self.stale_after()).then_some(last);
        Some(e)
    }

    /// Solved, ended and open periods together, oldest first, as they count at `now`.
    pub fn all_episodes(&self, now: i64) -> Vec<Episode> {
        let mut v: Vec<Episode> = self.episodes.iter().cloned().chain(self.devices.values().filter_map(|d| self.open_at(d, now))).collect();
        v.sort_by_key(|e| e.started_ms);
        v
    }

    /// The same for the log types' periods.
    pub fn all_type_episodes(&self, now: i64) -> Vec<Episode> {
        let open = self.devices.values().flat_map(|d| d.types.iter()).filter_map(|s| self.open_at(s, now));
        let mut v: Vec<Episode> = self.type_episodes.iter().cloned().chain(open).collect();
        v.sort_by_key(|e| e.started_ms);
        v
    }

    /// The log type field as the last run had it; `None`: no run said (before 0.3.90).
    pub fn log_type_field(&self) -> Option<&super::measure::LogTypeField> {
        self.last_read.as_ref()?.log_type.as_ref()
    }

    /// Its devices are read by log types.
    pub fn has_log_types(&self) -> bool {
        self.log_type_field().is_some_and(|f| f.field.is_some())
    }

    /// The documents counted for a device in the last 24 hours and the hours of windows they
    /// were counted in: each run reads the interval before it, and a window that overlaps one
    /// already counted (*Fetch now* between two runs) is not counted twice.
    pub fn docs_counted(&self, d: &DeviceState) -> Option<(u64, f64)> {
        let every = self.interval_ms.unwrap_or(DEFAULT_INTERVAL_MS).max(1);
        let slack = (every / 20).min(5 * 60_000);
        let (mut docs, mut n, mut before) = (0u64, 0i64, i64::MAX);
        for (t, c) in d.day_docs.iter().rev() {
            if *t <= before.saturating_add(slack) {
                docs += c;
                n += 1;
                before = t - every;
            }
        }
        (n > 0).then(|| (docs, round2((n * every) as f64 / 3_600_000.0)))
    }

    /// Why the devices' states say nothing about the cluster now: it was never measured, or its
    /// last run failed. `None`: measured.
    pub fn not_measured(&self, now: i64) -> Option<String> {
        let Some(last) = self.last_run_ms else { return Some("never measured".into()) };
        let failed = self.last_failed.as_ref().filter(|f| f.at > last).map(|f| f.error.as_str())
            .or_else(|| self.last_read.as_ref().filter(|r| !r.complete && !r.is_partial()).and_then(|r| r.error.as_deref()))?;
        Some(format!("the last run failed ({failed}); last measured {}", super::time::when(last, now)))
    }

    /// Open silences, every device.
    pub fn open_silences(&self) -> impl Iterator<Item = &Silence> {
        self.devices.values().filter_map(|d| d.silence.as_ref())
    }

    /// One run: the readings against the memory, under `levels`, the cluster's log time zone
    /// left to detection (the default). `silent_after_ms` is how long without a document makes
    /// a device silent.
    pub fn apply(&mut self, run_ms: i64, readings: Vec<Reading>, levels: &Levels, silent_after_ms: i64) -> Applied {
        self.apply_run(run_ms, readings, levels, silent_after_ms, true, &LogTimeZone::Detect)
    }

    /// `apply`, saying whether the readings are every device of the window (`complete`) and
    /// the cluster's log time zone setting. A run that read only part of the list — scoped to
    /// one device, stopped at *Max devices per run*, or cut short by a page that failed — says
    /// nothing about the devices it did not read: they are neither silent nor forgotten by it
    /// (unknown is not "no logs"), and it is not a run the zone is detected from.
    ///
    /// The zone step (docs/LOGDELAY.md "Time zones"): each reading's raw gap is matched against
    /// the real offsets in use (`tz::Offsets`); a complete run's matches are tallied into the
    /// detection; the cluster's offset — set, or detected — is taken out of every gap before it
    /// is levelled. A device whose gap sits at another real offset `DEVICE_STEADY_RUNS` runs in
    /// a row from its first sighting is in another time zone: not late, its delay shown against
    /// its own offset. Once a device's zone is confirmed it is kept (`Home`): a late log is
    /// measured against it, and only `REHOME_RUNS` at another offset move it. With
    /// no zone (nothing set, nothing detected) the raw gap is the delay, as before.
    pub fn apply_run(&mut self, run_ms: i64, readings: Vec<Reading>, levels: &Levels, silent_after_ms: i64, complete: bool, zone: &LogTimeZone) -> Applied {
        let mut out = Applied::default();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let offsets = Offsets::at_run(run_ms);
        let raw_of = |r: &Reading| r.delay_minutes.filter(|m| m.is_finite());
        if complete {
            self.tz.record(RunTally::count(run_ms, readings.iter().filter_map(raw_of).map(|m| offsets.matching(m, tz::TOLERANCE_MINUTES))));
        }
        let detected = self.tz.detected.map(|d| d.offset_minutes);
        let cluster_offset = |event_ms: Option<i64>| -> Option<i32> {
            match zone {
                LogTimeZone::Detect => detected,
                set => set.offset_at(event_ms.unwrap_or(run_ms)),
            }
        };
        let cx = RunCx { run_ms, levels, offsets: &offsets, named: matches!(zone, LogTimeZone::Named(_)), cluster_offset: &cluster_offset };
        self.types_unread = 0;
        let mut room = Room { left: SERIES_KEPT.saturating_sub(self.devices.values().map(|d| d.types.len()).sum()), not_kept: 0 };
        for r in readings {
            seen.insert(r.device.clone());
            let d = self.devices.entry(r.device.clone()).or_insert_with(|| DeviceState { first_seen_ms: run_ms, ..DeviceState::default() });
            d.last_run_ms = run_ms;
            d.docs = r.docs;
            d.day_docs.push((run_ms, r.docs));
            d.day_docs.retain(|(t, _)| run_ms - *t < 86_400_000);
            if !r.extras.is_empty() {
                d.extras = r.extras.clone();
            }
            // Back after a silence: it ends at this arrival, and what came back is noted. A
            // reading with no arrival (unreadable) ends nothing: the silence stays open.
            if let Some(a) = r.arrival_ms {
                if let Some(mut s) = d.silence.take() {
                    if a > s.from_ms {
                        s.to_ms = Some(a);
                        s.burst_docs = Some(r.docs);
                        s.burst_minutes = r.delay_minutes.map(round2);
                        out.silences_ended.push(s.clone());
                        self.silences.push(s);
                    } else {
                        d.silence = Some(s);
                    }
                }
            }
            if let Some(a) = r.arrival_ms {
                d.last_arrival_ms = Some(a);
            }
            if let Some(e) = r.event_ms {
                d.last_event_ms = Some(e);
                d.event_field = r.event_field.clone();
            }
            let mut j = d.judge(raw_of(&r), cluster_offset(r.event_ms), &cx);
            let ended = out.type_ended.len();
            if r.types.is_none() && r.types_truncated {
                // The run had read as many as it does: what its log types are now is not known.
                (d.types_truncated, d.types_run_ms, self.types_unread) = (true, Some(run_ms), self.types_unread + 1);
            }
            let types = r.types.map(|t| d.take_types(&r.device, t, !r.types_truncated, &mut room, &cx, &mut out));
            let typed = types.as_deref().and_then(|t| device_by_types(t, j.state));
            d.by_types = typed.is_some();
            if let Some((state, at)) = typed {
                if let Some(t) = at.and_then(|i| types.as_ref()?.get(i)) {
                    j = Judged { raw: t.raw_gap_minutes, minutes: t.delay_minutes, state, applied: t.tz_offset_minutes, zone: t.device_tz_offset, moved: false };
                    (d.last_event_ms, d.event_field) = (t.event_ms, t.event_field.clone());
                }
                // A log type whose time zone changed is not solved, so neither is the device.
                j.moved = out.type_ended[ended..].iter().any(|e| e.ended_why.as_deref() == Some(ENDED_ZONE));
            }
            d.forget_types(run_ms, false, &mut out);
            let c = d.settle(&r.device, j, &cx);
            out.opened.extend(c.opened);
            out.continued.extend(c.continued);
            if let Some(e) = c.solved {
                out.solved.push(e.clone());
                self.episodes.push(e);
            }
            if let Some(e) = c.ended {
                out.ended.push(e.clone());
                self.episodes.push(e);
            }
            out.rows.push(Row { device: r.device, docs: r.docs, arrival_ms: d.last_arrival_ms, event_ms: d.last_event_ms, event_field: d.event_field.clone(),
                                delay_minutes: c.minutes, raw_gap_minutes: d.last_raw_minutes, device_tz_offset: c.zone, tz_offset_minutes: d.applied_offset,
                                state: d.state, extras: d.extras.clone(), types, by_type: typed.and_then(|(_, at)| at), types_truncated: d.types_truncated });
        }
        // Devices the run did not see: silent after the limit, forgotten after a week.
        let mut forget = vec![];
        for (name, d) in self.devices.iter_mut() {
            if !complete || seen.contains(name) {
                continue;
            }
            let quiet_since = d.last_arrival_ms.unwrap_or(d.last_run_ms);
            if run_ms - quiet_since >= FORGET_MS {
                forget.push(name.clone());
                continue;
            }
            if run_ms - quiet_since < silent_after_ms {
                continue;
            }
            d.last_run_ms = run_ms;
            d.state = State::Silent;
            d.docs = 0;
            d.day_docs.retain(|(t, _)| run_ms - *t < 86_400_000);
            if d.silence.is_none() {
                let s = Silence { device: name.clone(), from_ms: quiet_since, to_ms: None, burst_docs: None, burst_minutes: None };
                out.silences_begun.push(s.clone());
                d.silence = Some(s);
            }
            d.recent.push(Point { t: run_ms, m: None, s: State::Silent });
            d.by_types = false;
            d.quiet_types(run_ms);
            d.forget_types(run_ms, false, &mut out);
            out.rows.push(Row { device: name.clone(), docs: 0, arrival_ms: d.last_arrival_ms, event_ms: d.last_event_ms, event_field: d.event_field.clone(),
                                delay_minutes: None, raw_gap_minutes: None, device_tz_offset: d.zone_offset(None), tz_offset_minutes: None,
                                state: State::Silent, extras: d.extras.clone(), types: None, by_type: None, types_truncated: false });
        }
        for name in forget {
            if let Some(mut d) = self.devices.remove(&name) {
                d.forget_types(run_ms, true, &mut out);
                // Its open period ends here, unsolved: nobody measured it back under the line,
                // and nobody counts it as late from now on.
                let last = Self::last_measured(&d);
                if let Some(mut ep) = d.open {
                    ep.last_measured_ms = ep.last_measured_ms.or(last);
                    ep.ended_ms = Some(run_ms);
                    ep.ended_why = Some(ENDED_FORGOTTEN.into());
                    out.ended.push(ep.clone());
                    self.episodes.push(ep);
                }
                if let Some(s) = d.silence {
                    self.silences.push(s);
                }
                out.forgotten += 1;
            }
        }
        self.type_episodes.extend(out.type_solved.iter().chain(&out.type_ended).cloned());
        self.types_not_kept = room.not_kept;
        self.prune(run_ms);
        self.last_run_ms = Some(run_ms);
        self.silent_after_ms = Some(silent_after_ms);
        out
    }

    /// Drop what the built-in store no longer keeps.
    pub fn prune(&mut self, now: i64) {
        for d in self.devices.values_mut() {
            d.recent.keep_after(now - RECENT_MS);
            for s in &mut d.types {
                s.recent.keep_after(now - TYPE_RECENT_MS);
            }
        }
        self.episodes.retain(|e| now - e.solved_ms.or(e.ended_ms).unwrap_or(e.started_ms) < KEEP_MS);
        self.silences.retain(|s| now - s.to_ms.unwrap_or(s.from_ms) < KEEP_MS);
        self.episodes.sort_by_key(|e| e.started_ms);
        self.silences.sort_by_key(|s| s.from_ms);
        self.type_episodes.retain(|e| now - e.solved_ms.or(e.ended_ms).unwrap_or(e.started_ms) < TYPE_EPISODES_MS);
        self.type_episodes.sort_by_key(|e| e.started_ms);
        let over = self.type_episodes.len().saturating_sub(TYPE_EPISODES_KEPT);
        if let Some(last) = self.type_episodes.drain(..over).next_back() {
            self.type_episodes_cut_ms = Some(last.started_ms);
        }
        self.type_episodes_cut_ms = self.type_episodes_cut_ms.filter(|t| now - t < TYPE_EPISODES_MS);
    }
}

/// A cluster's, or a range's, log types: how many, how many of them late, and of those above the
/// second level.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogTypes {
    pub total: u64,
    pub late: u64,
    pub above: u64,
}

impl LogTypes {
    pub fn add(&mut self, s: State) {
        self.total += 1;
        self.late += s.late() as u64;
        self.above += (s == State::Critical) as u64;
    }

    pub fn plus(&mut self, o: LogTypes) {
        self.total += o.total;
        self.late += o.late;
        self.above += o.above;
    }
}

/* ------------------------------------ daily totals ------------------------------------ */

/// One cluster's day, as stored and as reported (docs/LOGDELAY.md "Daily totals").
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Daily {
    pub day: String,
    /// Devices with at least one reading that day (silent ones included).
    pub devices: u64,
    /// Each device counted once, by its last state of the day.
    pub on_time: u64,
    /// Always 0 since 0.3.62 (no little-delay band); kept so stored days and the history
    /// store's mapping still read.
    pub little: u64,
    pub delayed: u64,
    pub critical: u64,
    pub clock_ahead: u64,
    /// Devices whose gap sat at another real offset than the cluster's (not late).
    #[serde(default)]
    pub other_tz: u64,
    pub silent: u64,
    pub unmeasured: u64,
    /// Of the silent ones, how many were late when they went silent (their period not solved).
    #[serde(default)]
    pub late_before_silent: u64,
    /// Periods that started / were solved that day.
    pub started: u64,
    pub solved: u64,
    /// Hours of open period inside the day, over all devices, two decimals.
    pub late_hours: f64,
    /// Median and 95th percentile of the devices' last measured delay of the day; `None` when
    /// nothing was measured.
    pub median_minutes: Option<f64>,
    pub p95_minutes: Option<f64>,
    /// Devices measured that day (a delay figure, not silent or unmeasured).
    pub measured: u64,
    /// Whether the day is over at the time it was written (a day written at 14:00 is not).
    #[serde(default)]
    pub complete: bool,
    /// Devices with some log types late and some on time: in none of the counts above.
    #[serde(default)]
    pub part_delayed: u64,
    /// The log types, each once, by its last state of the day. `None`: not read by log types.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_types: Option<LogTypes>,
}

impl Daily {
    /// Without delay, as it is counted (`State::no_delay`).
    pub fn no_delay(&self) -> u64 {
        self.on_time + self.little + self.silent + self.unmeasured + self.clock_ahead
    }
}

/// The totals of `[from, to)` (one local day) from the tracker's memory. `now` is the run's
/// time; `complete` says whether the day had ended at `now`.
pub fn daily(t: &Tracker, day: &str, from: i64, to: i64, now: i64) -> Daily {
    let mut d = Daily { day: day.to_string(), complete: now >= to, ..Daily::default() };
    let mut lasts: Vec<f64> = vec![];
    for dev in t.devices.values() {
        let in_day: Vec<Point> = dev.recent.iter().filter(|p| p.t >= from && p.t < to).collect();
        for s in dev.types.iter().filter_map(|s| s.recent.iter().rev().find(|p| p.t >= from && p.t < to)) {
            d.log_types.get_or_insert_default().add(s.s);
        }
        let Some(last) = in_day.last() else { continue };
        d.devices += 1;
        match last.s {
            State::NoDelay => d.on_time += 1,
            State::Little => d.little += 1,
            State::Delay => d.delayed += 1,
            State::Critical => d.critical += 1,
            State::ClockAhead => d.clock_ahead += 1,
            State::OtherTz => d.other_tz += 1,
            State::Silent => d.silent += 1,
            State::Unmeasured => d.unmeasured += 1,
            State::PartDelay => d.part_delayed += 1,
        }
        if last.s == State::Silent && dev.open.as_ref().is_some_and(|e| e.started_ms < to) {
            d.late_before_silent += 1;
        }
        if let Some(m) = in_day.iter().rev().filter(|p| !p.s.cant_measure()).find_map(|p| p.m) {
            lasts.push(m);
        }
    }
    d.measured = lasts.len() as u64;
    d.median_minutes = percentile(&mut lasts, 0.5);
    d.p95_minutes = percentile(&mut lasts, 0.95);
    let mut late_ms = 0i64;
    for e in t.all_episodes(now) {
        if e.started_ms >= from && e.started_ms < to {
            d.started += 1;
        }
        if e.solved_ms.is_some_and(|s| s >= from && s < to) {
            d.solved += 1;
        }
        late_ms += e.overlap_ms(from, to, now);
    }
    d.late_hours = round2(late_ms as f64 / 3_600_000.0);
    d
}

/// Nearest-rank percentile of a sample, two decimals; `None` of nothing.
pub fn percentile(v: &mut [f64], p: f64) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((p * v.len() as f64).ceil() as usize).clamp(1, v.len());
    Some(round2(v[rank - 1]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3_600_000;

    fn r(device: &str, m: Option<f64>, run: i64) -> Reading {
        Reading { device: device.into(), docs: 10, arrival_ms: m.map(|_| run), event_ms: m.map(|x| run - (x * 60_000.0) as i64),
                  delay_minutes: m, ..Reading::default() }
    }

    #[test]
    fn a_period_opens_at_the_first_late_measurement_and_solves_at_the_first_under_the_line() {
        let l = Levels::default();
        let mut t = Tracker::default();
        let a = t.apply(0, vec![r("fw", Some(10.0), 0)], &l, 2 * H);
        assert!(a.opened.is_empty() && a.solved.is_empty());
        let a = t.apply(2 * H, vec![r("fw", Some(45.0), 2 * H)], &l, 2 * H);
        assert_eq!(a.opened.len(), 1);
        assert_eq!(a.opened[0].started_ms, 2 * H);
        let a = t.apply(4 * H, vec![r("fw", Some(94.0), 4 * H)], &l, 2 * H);
        assert_eq!(a.continued.len(), 1, "measured again while open");
        assert_eq!(t.devices["fw"].open.as_ref().unwrap().worst_minutes, 94.0);
        assert_eq!(t.devices["fw"].open.as_ref().unwrap().worst_state, State::Critical);
        // 20 min is under the line: solved, with how long and how bad it was.
        let a = t.apply(6 * H, vec![r("fw", Some(20.0), 6 * H)], &l, 2 * H);
        assert_eq!(a.solved.len(), 1);
        let e = &a.solved[0];
        assert_eq!((e.started_ms, e.solved_ms), (2 * H, Some(6 * H)));
        assert_eq!(e.lasted_ms(99 * H), 4 * H);
        assert_eq!(e.measurements, 3);
        assert_eq!(e.worst_minutes, 94.0);
        assert!(t.devices["fw"].open.is_none());
        assert_eq!(t.episodes.len(), 1);
        assert_eq!(t.devices["fw"].recent.len(), 4);
    }

    #[test]
    fn a_partial_run_turns_nobody_it_did_not_read_silent_or_forgotten() {
        let l = Levels::default();
        let mut t = Tracker::default();
        t.apply(0, vec![r("a", Some(1.0), 0), r("b", Some(45.0), 0)], &l, 2 * H);
        // Scoped to "a" (Fetch now for one device), hours later: b is not silent by it.
        let x = t.apply_run(5 * H, vec![r("a", Some(2.0), 5 * H)], &l, 2 * H, false, &LogTimeZone::Detect);
        assert!(x.silences_begun.is_empty() && x.rows.len() == 1, "{:?}", x.rows);
        assert_eq!(t.devices["b"].state, State::Delay);
        assert!(t.devices["b"].open.is_some());
        // A week on, still not forgotten by a partial run; a complete one does it.
        t.apply_run(8 * 24 * H, vec![r("a", Some(2.0), 8 * 24 * H)], &l, 2 * H, false, &LogTimeZone::Detect);
        assert!(t.devices.contains_key("b"));
        let x = t.apply(8 * 24 * H + H, vec![r("a", Some(2.0), 8 * 24 * H + H)], &l, 2 * H);
        assert_eq!(x.forgotten, 1);
    }

    #[test]
    fn silent_and_unmeasured_solve_nothing_and_are_never_on_time() {
        let l = Levels::default();
        let mut t = Tracker::default();
        t.apply(0, vec![r("fw", Some(45.0), 0), r("ok", Some(1.0), 0)], &l, 2 * H);
        // fw says nothing for one run (under the 2 h limit): not silent yet, nothing changes.
        let a = t.apply(H, vec![r("ok", Some(1.0), H)], &l, 2 * H);
        assert!(a.silences_begun.is_empty());
        assert!(a.rows.iter().all(|x| x.device == "ok"), "a device inside the limit is not written as anything");
        // Two hours without a document: silent, period still open.
        let a = t.apply(2 * H, vec![r("ok", Some(1.0), 2 * H)], &l, 2 * H);
        assert_eq!(a.silences_begun.len(), 1);
        let fw = &t.devices["fw"];
        assert_eq!(fw.state, State::Silent);
        assert!(fw.open.is_some(), "silence does not solve a delay");
        assert!(!State::Silent.on_time());
        let row = a.rows.iter().find(|x| x.device == "fw").unwrap();
        assert_eq!((row.state, row.delay_minutes), (State::Silent, None));
        // An unreadable document: can't measure, period still open, a row with no delay.
        let a = t.apply(4 * H, vec![r("fw", None, 4 * H), r("ok", Some(1.0), 4 * H)], &l, 2 * H);
        let fw = &t.devices["fw"];
        assert_eq!(fw.state, State::Unmeasured);
        assert!(fw.open.is_some());
        assert_eq!(fw.open.as_ref().unwrap().measurements, 1, "nothing measured, nothing counted");
        assert!(a.solved.is_empty());
        // Back with logs: the silence ends at that arrival, carrying what came back.
        let a = t.apply(6 * H, vec![r("fw", Some(90.0), 6 * H), r("ok", Some(1.0), 6 * H)], &l, 2 * H);
        assert_eq!(a.silences_ended.len(), 1);
        assert_eq!(a.silences_ended[0].burst_minutes, Some(90.0));
        assert_eq!(a.silences_ended[0].to_ms, Some(6 * H));
    }

    #[test]
    fn points_are_written_compact_and_both_forms_read() {
        let p = Point { t: 1_000, m: Some(94.0), s: State::Critical };
        assert_eq!(serde_json::to_string(&p).unwrap(), "[1000,94.0,\"critical\"]");
        assert_eq!(serde_json::from_str::<Point>("[1000,94.0,\"critical\"]").unwrap(), p);
        assert_eq!(serde_json::from_str::<Point>("{\"t\":1000,\"m\":94.0,\"s\":\"critical\"}").unwrap(), p);
        assert_eq!(serde_json::from_str::<Point>("{\"t\":5,\"s\":\"silent\"}").unwrap(), Point { t: 5, m: None, s: State::Silent });
    }

    #[test]
    fn a_device_gone_a_week_is_forgotten_and_its_open_period_kept_unsolved() {
        let l = Levels::default();
        let mut t = Tracker::default();
        t.apply(0, vec![r("gone", Some(45.0), 0)], &l, 2 * H);
        let a = t.apply(FORGET_MS + H, vec![], &l, 2 * H);
        assert_eq!(a.forgotten, 1);
        assert!(t.devices.is_empty());
        assert_eq!(t.episodes.len(), 1);
        assert_eq!(t.episodes[0].solved_ms, None);
        assert_eq!(t.episodes[0].ended_ms, Some(FORGET_MS + H), "ended when forgotten, so it stops lasting");
        assert_eq!(t.episodes[0].ended_why.as_deref(), Some(ENDED_FORGOTTEN));
        assert_eq!(t.episodes[0].lasted_ms(FORGET_MS + 50 * H), 0, "measured late once: nothing after that was measured (it used to count the whole week)");
        assert!(!t.episodes[0].late_at(FORGET_MS + 2 * H) && !t.episodes[0].late_at(H));
        assert_eq!(a.ended.len(), 1, "its document is written again, no longer open");
    }

    /// 2025-11-14: the runs below are measured in the present, so the offsets in use are today's.
    const NOW: i64 = 1_763_100_000_000;

    #[test]
    fn time_zone_shaped_offsets_are_read_from_the_period() {
        let o = Offsets::at_run(NOW);
        assert!(whole_hour(60.0, &o) && whole_hour(62.5, &o) && whole_hour(119.0, &o) && whole_hour(330.0, &o) && whole_hour(345.0, &o) && whole_hour(-60.0, &o));
        assert!(!whole_hour(45.0, &o) && !whole_hour(75.0, &o) && !whole_hour(5.0, &o) && !whole_hour(100.0, &o) && !whole_hour(1.0, &o));
        // A cluster set to UTC: a device steady at +01:00 is in another time zone from the second
        // run on. The period its first run opened is solved by that, and the shape is read from it.
        let l = Levels::default();
        let mut t = Tracker::default();
        for i in 0..3 {
            let at = NOW + i * 2 * H;
            t.apply_run(at, vec![r("tz", Some(60.0 + (i % 2) as f64), at)], &l, 2 * H, true, &LogTimeZone::Utc);
        }
        let d = &t.devices["tz"];
        assert_eq!(d.state, State::OtherTz);
        assert_eq!((d.last_raw_minutes, d.last_minutes, d.tz_offset, d.tz_streak, d.applied_offset), (Some(60.0), Some(0.0), Some(60), 3, Some(60)));
        assert!(d.open.is_none(), "another time zone is not late");
        assert_eq!(t.episodes.len(), 1);
        assert_eq!(t.episodes[0].pattern(), Some("a whole hour off: time zone"));
        let mut t2 = Tracker::default();
        t2.apply(NOW, vec![r("ahead", Some(-40.0), NOW)], &l, 2 * H);
        assert!(t2.devices["ahead"].open.is_none(), "clock ahead is not late");
    }

    /// An IST cluster: every device's raw gap is 330 min (its logs are on time).
    fn ist(run: i64, late_by: &[(&str, f64)]) -> Vec<Reading> {
        let mut v: Vec<Reading> = (1..=10).map(|i| r(&format!("fw-{i}"), Some(330.0 + (i % 3) as f64 * 0.5), run)).collect();
        for (name, m) in late_by {
            v.push(r(name, Some(330.0 + m), run));
        }
        v
    }

    #[test]
    fn an_ist_cluster_is_detected_after_three_steady_runs_and_its_delays_corrected_from_then_on() {
        let l = Levels::default();
        let mut t = Tracker::default();
        let a1 = t.apply(NOW, ist(NOW, &[]), &l, 2 * H);
        assert!(a1.rows.iter().all(|x| x.state == State::Critical && x.tz_offset_minutes.is_none() && x.raw_gap_minutes.is_some()), "first run: as measured, nothing corrected yet");
        assert_eq!(t.tz.detected, None);
        assert_eq!(t.tz.last().map(|x| (x.offset, x.agree, x.of)), Some((Some(330), 10, 10)));
        t.apply(NOW + 2 * H, ist(NOW + 2 * H, &[]), &l, 2 * H);
        assert_eq!(t.tz.detected, None, "two runs are not steady");
        let a3 = t.apply(NOW + 4 * H, ist(NOW + 4 * H, &[]), &l, 2 * H);
        assert_eq!(t.tz.detected.map(|d| d.offset_minutes), Some(330));
        assert!(a3.rows.iter().all(|x| x.state == State::NoDelay && x.tz_offset_minutes == Some(330) && x.delay_minutes.unwrap() < 1.5), "{:?}", a3.rows);
        assert_eq!(a3.rows[0].raw_gap_minutes, Some(330.5));
        assert_eq!(a3.solved.len(), 10, "the 330-minute 'delays' the first two runs opened are solved");
        assert!(a3.rows.iter().all(|x| x.device_tz_offset == Some(330)));
        // A device genuinely 40 min late on top of the zone: corrected 40, delayed.
        let a4 = t.apply(NOW + 6 * H, ist(NOW + 6 * H, &[("slow", 40.0)]), &l, 2 * H);
        let slow = a4.rows.iter().find(|x| x.device == "slow").unwrap();
        assert_eq!((slow.state, slow.delay_minutes, slow.raw_gap_minutes, slow.tz_offset_minutes), (State::Delay, Some(40.0), Some(370.0), Some(330)));
        assert_eq!(a4.opened.len(), 1);
        // A device in Singapore (+08:00) on an IST cluster: critical once (its gap is 480), then
        // "other time zone" and not late, its delay against its own offset.
        let a5 = t.apply(NOW + 8 * H, ist(NOW + 8 * H, &[("sg", 150.0)]), &l, 2 * H);
        let sg = a5.rows.iter().find(|x| x.device == "sg").unwrap();
        assert_eq!((sg.state, sg.delay_minutes, sg.device_tz_offset), (State::Critical, Some(150.0), Some(480)), "one run at +08:00 could still be a backlog");
        let a6 = t.apply(NOW + 10 * H, ist(NOW + 10 * H, &[("sg", 151.0)]), &l, 2 * H);
        let sg = a6.rows.iter().find(|x| x.device == "sg").unwrap();
        assert_eq!((sg.state, sg.delay_minutes, sg.device_tz_offset, sg.tz_offset_minutes), (State::OtherTz, Some(1.0), Some(480), Some(480)));
        assert!(!sg.state.late());
        assert_eq!(a6.solved.iter().filter(|e| e.device == "sg").count(), 1, "its period is solved by the finding");
        assert_eq!(t.devices["sg"].tz_streak, 2);
        assert_eq!(t.tz.detected.map(|d| d.offset_minutes), Some(330), "one device elsewhere does not move the cluster");
        let day = daily(&t, "d", NOW, NOW + 24 * H, NOW + 11 * H);
        assert_eq!((day.other_tz, day.on_time, day.critical), (1, 10, 0));
    }

    /// A UTC cluster (detected from ten on-time devices) with one more device at `raw`.
    fn utc_with(run: i64, extra: &[(&str, f64)]) -> Vec<Reading> {
        let mut v: Vec<Reading> = (1..=10).map(|i| r(&format!("utc-{i}"), Some(0.5), run)).collect();
        v.extend(extra.iter().map(|(n, m)| r(n, Some(*m), run)));
        v
    }

    #[test]
    fn a_device_east_of_a_utc_cluster_is_in_another_zone_not_a_clock_ahead() {
        let l = Levels::default();
        let mut t = Tracker::default();
        for i in 0..3 {
            t.apply(NOW + i * 2 * H, utc_with(NOW + i * 2 * H, &[]), &l, 2 * H);
        }
        assert_eq!(t.tz.detected.map(|d| d.offset_minutes), Some(0), "UTC detected");
        // India (+05:30) and Nepal (+05:45) devices writing local time as UTC: the event runs
        // ahead by the zone. −400 sits at no zone: a clock ahead, every run.
        let east = [("win-del-03", -327.22), ("ktm", -345.0), ("odd", -400.0)];
        let a1 = t.apply(NOW + 6 * H, utc_with(NOW + 6 * H, &east), &l, 2 * H);
        let row = |a: &Applied, n: &str| a.rows.iter().find(|x| x.device == n).cloned().unwrap();
        for n in ["win-del-03", "ktm", "odd"] {
            assert_eq!(row(&a1, n).state, State::ClockAhead, "{n}: the first run is levelled as measured");
        }
        assert_eq!(row(&a1, "win-del-03").device_tz_offset, Some(330));
        let a2 = t.apply(NOW + 8 * H, utc_with(NOW + 8 * H, &east), &l, 2 * H);
        let ind = row(&a2, "win-del-03");
        assert_eq!((ind.state, ind.device_tz_offset, ind.tz_offset_minutes, ind.delay_minutes), (State::OtherTz, Some(330), Some(-330), Some(2.78)));
        let ktm = row(&a2, "ktm");
        assert_eq!((ktm.state, ktm.device_tz_offset, ktm.tz_offset_minutes, ktm.delay_minutes), (State::OtherTz, Some(345), Some(-345), Some(0.0)));
        let odd = row(&a2, "odd");
        assert_eq!((odd.state, odd.device_tz_offset, odd.tz_offset_minutes), (State::ClockAhead, None, Some(0)));
        assert_eq!(t.tz.detected.map(|d| d.offset_minutes), Some(0), "the cluster stays UTC");
        // Late by whole hours on the same cluster: still late, not another zone.
        let mut u = Tracker::default();
        for i in 0..5 {
            u.apply_run(NOW + i * 2 * H, utc_with(NOW + i * 2 * H, &[("slow1", 60.0), ("slow2", 120.0)]), &l, 2 * H, true, &LogTimeZone::Detect);
        }
        assert_eq!(u.tz.detected.map(|d| d.offset_minutes), Some(0));
        assert_eq!((u.devices["slow1"].tz_offset, u.devices["slow2"].tz_offset), (Some(60), Some(120)), "positive gaps read as they are, as before");
    }

    /// A UTC-set cluster with an India device (gap −330) and a same-zone one, homes confirmed.
    fn homed() -> Tracker {
        let l = Levels::default();
        let mut t = Tracker::default();
        for i in 0..4 {
            let at = NOW + i * 2 * H;
            t.apply_run(at, vec![r("ind", Some(-329.0), at), r("ktm", Some(-345.0), at), r("own", Some(1.0), at)], &l, 2 * H, true, &LogTimeZone::Utc);
        }
        t
    }
    fn run(t: &mut Tracker, i: i64, v: &[(&str, f64)]) -> Applied {
        let at = NOW + i * 2 * H;
        t.apply_run(at, v.iter().map(|(n, m)| r(n, Some(*m), at)).collect(), &Levels::default(), 2 * H, true, &LogTimeZone::Utc)
    }

    #[test]
    fn a_late_device_in_another_zone_is_late_not_on_time_and_not_moved() {
        let mut t = homed();
        assert_eq!(t.devices["ind"].home.map(|h| (h.home_gap, h.zone)), Some((-330, 330)));
        assert_eq!(t.devices["own"].home.map(|h| (h.home_gap, h.zone)), Some((0, 0)));
        assert_eq!(t.devices["ind"].state, State::OtherTz);
        // 45 min late: −285 sits at no zone. It was a clock ahead, counted on time.
        let a = run(&mut t, 4, &[("ind", -285.0), ("ktm", -345.0), ("own", 1.0)]);
        let ind = a.rows.iter().find(|x| x.device == "ind").unwrap();
        assert_eq!((ind.state, ind.delay_minutes, ind.tz_offset_minutes, ind.device_tz_offset), (State::Delay, Some(45.0), Some(-330), Some(330)));
        assert_eq!(a.opened.len(), 1);
        // Exactly 60 and 30 min late: −270 and −300 look like +04:30 and +05:00, run after run.
        for i in 5..9 {
            let a = run(&mut t, i, &[("ind", -270.0), ("ktm", -315.0), ("own", 1.0)]);
            let of = |n: &str| a.rows.iter().find(|x| x.device == n).map(|x| (x.state, x.delay_minutes)).unwrap();
            assert_eq!(of("ind"), (State::Delay, Some(60.0)), "run {i}");
            assert_eq!(of("ktm"), (State::Delay, Some(30.0)), "run {i}: a quarter-hour zone, half an hour late");
            assert!(a.solved.is_empty() && a.ended.is_empty());
        }
        assert_eq!(t.devices["ind"].home.map(|h| h.zone), Some(330), "still in India");
        // Back on time in its own zone: solved, and in another zone again.
        let a = run(&mut t, 9, &[("ind", -330.0), ("ktm", -345.0), ("own", 1.0)]);
        assert_eq!(a.solved.len(), 2);
        assert_eq!(t.devices["ind"].state, State::OtherTz);
    }

    #[test]
    fn a_same_zone_device_an_hour_late_is_late_until_twelve_steady_runs_say_its_zone_changed() {
        let mut t = homed();
        for i in 0..11 {
            let a = run(&mut t, 4 + i, &[("own", 60.0 + (i % 2) as f64)]);
            assert_eq!(a.rows[0].state, if i % 2 == 0 { State::Delay } else { State::Critical }, "run {i}: late, not in +01:00");
            assert!(a.solved.is_empty());
        }
        // Fetch now pressed twice more within minutes is the same run, not two.
        let at = NOW + 14 * 2 * H + 5 * 60_000;
        for k in 0..3 {
            let a = t.apply_run(at + k * 60_000, vec![r("own", Some(60.0), at)], &Levels::default(), 2 * H, false, &LogTimeZone::Utc);
            assert_eq!(a.rows[0].state, State::Delay);
        }
        let a = run(&mut t, 15, &[("own", 60.0)]);
        assert_eq!((a.rows[0].state, a.rows[0].delay_minutes, a.rows[0].tz_offset_minutes), (State::OtherTz, Some(0.0), Some(60)));
        assert!(a.solved.is_empty(), "a changed zone solves no delay");
        assert_eq!(a.ended.len(), 1);
        let e = &t.episodes[0];
        assert_eq!((e.solved_ms, e.ended_ms, e.ended_why.as_deref()), (None, Some(NOW + 30 * H), Some(ENDED_ZONE)));
        assert!(t.devices["own"].open.is_none());
        assert_eq!(t.devices["own"].home.map(|h| h.home_gap), Some(60));
    }

    #[test]
    fn one_run_on_time_then_an_hour_late_is_late() {
        let mut t = Tracker::default();
        run(&mut t, 0, &[("own", 1.0), ("slow", 45.0)]);
        for i in 1..4 {
            let a = run(&mut t, i, &[("own", 60.0), ("slow", 60.0)]);
            assert!(a.rows.iter().all(|x| x.state == State::Delay), "{:?}", a.rows);
        }
    }

    #[test]
    fn a_cluster_set_by_name_keeps_its_devices_homes_over_daylight_saving() {
        let h = Home::found(tz::DeviceZone { zone: 330, gap: 330 - 120 - 330 - 90 }, 120, 0);
        assert_eq!(h.expected(60, true), Some(h.home_gap - 60), "ahead of the cluster: it moves with the cluster");
        assert_eq!(h.expected(60, false), None, "another zone set: found again");
        let own = Home::found(tz::DeviceZone { zone: 480, gap: 480 }, 120, 0);
        assert_eq!(own.expected(60, true), Some(480), "stamped in its own offset");
        assert_eq!(Home::found(tz::DeviceZone { zone: 120, gap: 120 }, 120, 0).expected(60, true), Some(60), "the cluster's own zone");
    }

    #[test]
    fn a_clock_ahead_solves_nothing_and_is_not_on_time() {
        let mut t = homed();
        run(&mut t, 4, &[("own", 45.0)]);
        let a = run(&mut t, 5, &[("own", -100.0)]);
        assert_eq!(a.rows[0].state, State::ClockAhead);
        assert!(a.solved.is_empty() && t.devices["own"].open.is_some(), "how late its logs are is not known");
        assert!(!State::ClockAhead.on_time() && State::ClockAhead.cant_measure());
        assert_eq!(t.devices["own"].last_measured_ms, Some(NOW + 8 * H));
    }

    #[test]
    fn a_state_file_without_homes_loads_and_finds_them_at_its_next_run() {
        let mut t = homed();
        let mut v = serde_json::to_value(&t).unwrap();
        for d in v["devices"].as_object_mut().unwrap().values_mut() {
            let o = d.as_object_mut().unwrap();
            for k in ["home", "onTimeAt", "movedGap", "movedRuns", "movedMs", "lastMeasuredMs"] {
                o.remove(k);
            }
        }
        for k in ["intervalMs", "silentAfterMs"] {
            v.as_object_mut().unwrap().remove(k);
        }
        t = serde_json::from_value(v).unwrap();
        assert!(t.devices.values().all(|d| d.home.is_none()));
        let a = run(&mut t, 4, &[("ind", -330.0), ("ktm", -345.0), ("own", 1.0)]);
        assert!(t.devices.values().all(|d| d.home.is_some()));
        assert_eq!(a.rows.iter().find(|x| x.device == "ind").unwrap().state, State::OtherTz);
    }

    #[test]
    fn an_open_period_counts_up_to_its_last_measurement_not_to_now() {
        let l = Levels::default();
        let mut t = Tracker { interval_ms: Some(2 * H), ..Tracker::default() };
        t.apply(NOW, vec![r("fw", Some(95.0), NOW)], &l, 24 * H);
        t.apply(NOW + 2 * H, vec![r("fw", Some(95.0), NOW + 2 * H)], &l, 24 * H);
        assert_eq!(t.stale_after(), 3 * H, "the interval, smaller than the silence limit, and half of it for the next run to be written");
        let e = &t.all_episodes(NOW + 4 * H)[0];
        assert_eq!((e.stale(), e.lasted_ms(NOW + 4 * H)), (false, 4 * H), "within the interval: still late now");
        let later = NOW + 10 * H;
        let e = &t.all_episodes(later)[0];
        assert_eq!((e.stale(), e.measured_until_ms, e.lasted_ms(later)), (true, Some(NOW + 2 * H), 2 * H));
        assert_eq!(e.overlap_ms(NOW + H, later, later), H);
        assert!(!e.late_at(later) && e.late_at(NOW + 2 * H));
        // Kept before 0.3.89: from the device's last measured point.
        let mut old = t.clone();
        old.interval_ms = None;
        let d = old.devices.get_mut("fw").unwrap();
        d.last_measured_ms = None;
        d.open.as_mut().unwrap().last_measured_ms = None;
        assert_eq!(old.all_episodes(later)[0].measured_until_ms, Some(NOW + 2 * H));
        assert_eq!(stale_after_ms(24 * H, 2 * H), 3 * H, "the silence limit, when it is the smaller");
        assert_eq!(stale_after_ms(H / 2, 2 * H), H, "30 minutes at least: a run spread over 10 minutes and a read of 20");
    }

    #[test]
    fn logs_are_counted_over_windows_that_do_not_overlap() {
        let t = Tracker { interval_ms: Some(2 * H), ..Tracker::default() };
        let d = DeviceState { day_docs: vec![(NOW - 4 * H, 10), (NOW - 2 * H, 10), (NOW - H, 900), (NOW - 60_000, 11), (NOW, 12)], ..DeviceState::default() };
        assert_eq!(t.docs_counted(&d), Some((32, 6.0)), "Fetch now an hour and a minute before are not counted again");
        assert_eq!(t.docs_counted(&DeviceState::default()), None);
    }

    #[test]
    fn a_set_zone_corrects_from_the_first_run_and_wins_over_detection() {
        let l = Levels::default();
        let mut t = Tracker::default();
        let kolkata = LogTimeZone::parse("Asia/Kolkata").unwrap();
        let a = t.apply_run(NOW, ist(NOW, &[("slow", 40.0)]), &l, 2 * H, true, &kolkata);
        assert_eq!(a.rows.iter().filter(|x| x.state == State::NoDelay).count(), 10);
        let slow = a.rows.iter().find(|x| x.device == "slow").unwrap();
        assert_eq!((slow.state, slow.delay_minutes), (State::Delay, Some(40.0)));
        // Set to UTC: nothing is corrected, every IST device is late — and, steady, in another zone.
        let mut u = Tracker::default();
        u.apply_run(NOW, ist(NOW, &[]), &l, 2 * H, true, &LogTimeZone::Utc);
        assert!(u.devices.values().all(|d| d.state == State::Critical));
        u.apply_run(NOW + 2 * H, ist(NOW + 2 * H, &[]), &l, 2 * H, true, &LogTimeZone::Utc);
        assert!(u.devices.values().all(|d| d.state == State::OtherTz && d.applied_offset == Some(330)), "{:?}", u.devices.values().map(|d| d.state).collect::<Vec<_>>());
        // 55 % agreement under detection: nothing detected, nothing corrected.
        let mut m = Tracker::default();
        for i in 0..4 {
            let at = NOW + i * 2 * H;
            let mut v: Vec<Reading> = (0..11).map(|k| r(&format!("ist-{k}"), Some(330.0), at)).collect();
            v.extend((0..9).map(|k| r(&format!("utc-{k}"), Some(0.5), at)));
            m.apply(at, v, &l, 2 * H);
        }
        assert_eq!(m.tz.detected, None);
        assert_eq!(m.tz.last().map(|x| x.pct()), Some(Some(55.0)));
        assert!(m.devices["ist-1"].state == State::Critical && m.devices["ist-1"].applied_offset.is_none(), "unknown is not zero: as measured");
        // A partial run (one device measured again) is not a run the zone is detected from.
        let mut p = Tracker::default();
        for i in 0..3 {
            p.apply_run(NOW + i * H, vec![r("fw-1", Some(330.0), NOW + i * H)], &l, 2 * H, false, &LogTimeZone::Detect);
        }
        assert!(p.tz.runs.is_empty() && p.tz.detected.is_none());
    }

    #[test]
    fn quarter_hour_zones_and_daylight_saving_are_corrected_at_each_events_time() {
        let l = Levels::default();
        // Nepal: +05:45 on every device.
        let mut n = Tracker::default();
        for i in 0..3 {
            let at = NOW + i * 2 * H;
            n.apply(at, (0..5).map(|k| r(&format!("np-{k}"), Some(345.0), at)).collect(), &l, 2 * H);
        }
        assert_eq!(n.tz.detected.map(|d| d.offset_minutes), Some(345));
        assert!(n.devices.values().all(|d| d.state == State::NoDelay && d.last_minutes == Some(0.0)));
        // Berlin, set by name: the run straddles the end of summer time (2026-10-25 01:00Z). An
        // event before it is 120 min off, one after it 60 — both are on time once corrected.
        let berlin = LogTimeZone::parse("Europe/Berlin").unwrap();
        let change = 1_792_890_000_000;
        let mut b = Tracker::default();
        let before = Reading { device: "cest".into(), docs: 1, arrival_ms: Some(change - 30 * 60_000 + 120 * 60_000), event_ms: Some(change - 30 * 60_000),
                               delay_minutes: Some(120.0), ..Reading::default() };
        let after = Reading { device: "cet".into(), docs: 1, arrival_ms: Some(change + 30 * 60_000 + 60 * 60_000), event_ms: Some(change + 30 * 60_000),
                              delay_minutes: Some(60.0), ..Reading::default() };
        let a = b.apply_run(change + H, vec![before, after], &l, 2 * H, true, &berlin);
        let by = |name: &str| a.rows.iter().find(|x| x.device == name).unwrap();
        assert_eq!((by("cest").tz_offset_minutes, by("cest").delay_minutes, by("cest").state), (Some(120), Some(0.0), State::NoDelay));
        assert_eq!((by("cet").tz_offset_minutes, by("cet").delay_minutes, by("cet").state), (Some(60), Some(0.0), State::NoDelay));
    }

    #[test]
    fn daily_totals_count_each_device_once_by_its_last_state() {
        let l = Levels::default();
        let mut t = Tracker::default();
        let day = 86_400_000;
        t.apply(0, vec![r("a", Some(5.0), 0), r("b", Some(45.0), 0), r("c", Some(70.0), 0)], &l, 2 * H);
        t.apply(2 * H, vec![r("a", Some(20.0), 2 * H), r("b", Some(10.0), 2 * H), r("c", Some(90.0), 2 * H)], &l, 2 * H);
        let d = daily(&t, "1970-01-01", 0, day, 3 * H);
        assert_eq!((d.devices, d.on_time, d.little, d.delayed, d.critical), (3, 2, 0, 0, 1), "a at 20 and b at 10 min are on time (no little band), c critical");
        assert_eq!((d.started, d.solved), (2, 1));
        assert_eq!(d.late_hours, 2.0 + 3.0, "b: 2 h; c: 3 h so far (until now: measured an hour ago)");
        assert_eq!(d.median_minutes, Some(20.0));
        assert_eq!(d.p95_minutes, Some(90.0));
        assert!(!d.complete);
        // A later day with nothing measured says so.
        let e = daily(&t, "1970-01-03", 2 * day, 3 * day, 3 * day);
        assert_eq!(e.devices, 0);
        assert_eq!(e.median_minutes, None, "unknown is not zero");
        assert!(e.complete);
    }

    #[test]
    fn a_tracker_round_trips_through_json() {
        let l = Levels::default();
        let mut t = Tracker::default();
        let mut rd = r("fw", Some(45.0), 0);
        rd.extras.insert("fwd_tag".into(), "syslog-1".into());
        t.apply(0, vec![rd], &l, 2 * H);
        let s = serde_json::to_string(&t).unwrap();
        let back: Tracker = serde_json::from_str(&s).unwrap();
        assert_eq!(back, t);
        assert_eq!(back.devices["fw"].open.as_ref().unwrap().extras["fwd_tag"], "syslog-1");
    }

    /// A reading with log types, the newest document the first one's. `""`: without a log type.
    fn rt(device: &str, run: i64, types: &[(&str, Option<f64>)]) -> Reading {
        let one = |(n, m): &(&str, Option<f64>)| TypeReading { log_type: (!n.is_empty()).then(|| n.to_string()), docs: 5, arrival_ms: Some(run),
                                                                event_ms: m.map(|x| run - (x * 60_000.0) as i64), delay_minutes: *m, event_field: None };
        Reading { types: Some(types.iter().map(one).collect()), ..r(device, types.first().and_then(|t| t.1), run) }
    }
    fn at(t: &mut Tracker, i: i64, v: Vec<Reading>) -> Applied {
        t.apply_run(NOW + i * 2 * H, v, &Levels::default(), 2 * H, true, &LogTimeZone::Utc)
    }
    fn fw(t: &mut Tracker, i: i64, types: &[(&str, Option<f64>)]) -> Applied {
        at(t, i, vec![rt("fw", NOW + i * 2 * H, types)])
    }
    fn of<'a>(t: &'a Tracker, name: &str) -> &'a DeviceState {
        t.devices["fw"].types.iter().find(|s| s.type_name() == name).unwrap()
    }

    #[test]
    fn one_late_log_type_part_delays_its_device_whichever_logs_last() {
        let mut t = Tracker::default();
        let a = fw(&mut t, 0, &[("traffic", Some(1.0)), ("threat", Some(46.0)), ("", Some(2.0))]);
        let d = &t.devices["fw"];
        assert_eq!((d.state, d.last_minutes, d.by_types, d.open.is_none()), (State::PartDelay, Some(46.0), true, true), "its delay is the late type's");
        assert_eq!((a.opened.len(), a.type_opened.len(), a.type_opened[0].log_type.as_deref()), (0, 1, Some("threat")));
        assert_eq!((a.rows[0].state, a.rows[0].by_type, a.rows[0].delay_minutes), (State::PartDelay, Some(1), Some(46.0)));
        assert_eq!(d.late_types().iter().map(|s| s.type_name()).collect::<Vec<_>>(), ["threat"]);
        assert!(d.types[2].no_type && d.types[2].type_name() == "(no log type)");
        // The late one logged last: the same.
        let a = fw(&mut t, 1, &[("threat", Some(50.0)), ("traffic", Some(1.0)), ("", Some(2.0))]);
        assert_eq!((t.devices["fw"].state, a.type_continued.len(), of(&t, "threat").open.as_ref().unwrap().worst_minutes), (State::PartDelay, 1, 50.0));
        // None late: on time, the type's period solved.
        let a = fw(&mut t, 2, &[("threat", Some(3.0)), ("traffic", Some(1.0)), ("", Some(2.0))]);
        assert_eq!((t.devices["fw"].state, a.type_solved.len(), a.solved.len()), (State::NoDelay, 1, 0));
        assert_eq!((t.type_episodes.len(), t.episodes.len()), (1, 0), "the device had no period of its own");
        // Never on time, late or silent in a day's totals either.
        fw(&mut t, 3, &[("threat", Some(90.0)), ("traffic", Some(1.0)), ("", Some(2.0))]);
        let day = daily(&t, "d", NOW, NOW + 24 * H, NOW + 7 * H);
        assert_eq!((day.part_delayed, day.on_time, day.delayed + day.critical, day.silent, day.devices, day.no_delay()), (1, 0, 0, 0, 1, 0));
        assert_eq!(day.log_types, Some(LogTypes { total: 3, late: 1, above: 1 }));
        assert_eq!((day.started, day.late_hours), (0, 0.0), "a type's period is not the device's");
    }

    #[test]
    fn a_devices_own_period_is_open_only_while_every_log_type_is_late() {
        let mut t = Tracker::default();
        let a = fw(&mut t, 0, &[("a", Some(45.0)), ("b", Some(95.0))]);
        assert_eq!((t.devices["fw"].state, a.opened.len(), a.type_opened.len(), a.opened[0].worst_minutes), (State::Critical, 1, 2, 95.0));
        assert!(a.opened[0].log_type.is_none() && !a.opened[0].no_type);
        let a = fw(&mut t, 1, &[("a", Some(1.0)), ("b", Some(95.0))]);
        assert_eq!((t.devices["fw"].state, a.solved.len(), a.ended.len()), (State::PartDelay, 0, 1), "not solved: b is still late");
        let e = &t.episodes[0];
        assert_eq!((e.ended_why.as_deref(), e.ended_ms, e.lasted_ms(NOW + 99 * H)), (Some(ENDED_PART), Some(NOW + 2 * H), 2 * H));
        assert_eq!((a.type_solved.len(), a.type_continued.len()), (1, 1));
        // Opened by the newest document before log types were read, solved by its log types.
        let mut u = Tracker::default();
        at(&mut u, 0, vec![r("fw", Some(45.0), NOW)]);
        let a = fw(&mut u, 1, &[("a", Some(1.0)), ("b", Some(2.0))]);
        assert_eq!((a.solved.len(), u.devices["fw"].types_since_ms), (1, Some(NOW + 2 * H)));
    }

    #[test]
    fn one_log_type_or_the_field_off_is_as_before() {
        let (mut a, mut b, mut c) = (Tracker::default(), Tracker::default(), Tracker::default());
        for (i, m) in [45.0, 95.0, 2.0].into_iter().enumerate() {
            let (i, run) = (i as i64, NOW + i as i64 * 2 * H);
            let (x, y, z) = (at(&mut a, i, vec![r("fw", Some(m), run)]), at(&mut b, i, vec![rt("fw", run, &[("only", Some(m))])]),
                             at(&mut c, i, vec![Reading { types: Some(vec![]), ..r("fw", Some(m), run) }]));
            for o in [&y, &z] {
                assert_eq!((o.opened.len(), o.continued.len(), o.solved.len(), o.rows[0].state, o.rows[0].delay_minutes), (x.opened.len(), x.continued.len(), x.solved.len(), x.rows[0].state, x.rows[0].delay_minutes));
                assert_eq!((&o.rows[0].by_type, o.rows[0].types.is_some()), (&None, true));
            }
            assert!(x.rows[0].types.is_none());
        }
        assert_eq!((a.devices["fw"].recent.clone(), &a.episodes), (b.devices["fw"].recent.clone(), &b.episodes));
        assert!(!b.devices["fw"].by_types && b.devices["fw"].types.len() == 1);
        // Two log types, neither measurable: the newest document, as before.
        let mut d = Tracker::default();
        fw(&mut d, 0, &[("x", None), ("y", None)]);
        assert_eq!((d.devices["fw"].state, d.devices["fw"].by_types), (State::Unmeasured, false));
    }

    #[test]
    fn a_log_type_without_a_document_has_no_logs_and_the_others_decide() {
        let mut t = Tracker::default();
        fw(&mut t, 0, &[("a", Some(1.0)), ("b", Some(95.0)), ("c", Some(1.0))]);
        // b sends nothing: no logs, its period not solved, and the device is not part delayed by it.
        let x = fw(&mut t, 1, &[("a", Some(1.0)), ("c", Some(2.0))]);
        let b = of(&t, "b");
        assert_eq!((b.state, b.docs, b.open.is_some(), b.last_arrival_ms), (State::Silent, 0, true, Some(NOW)));
        assert_eq!(b.recent.iter().next_back(), Some(Point { t: NOW + 2 * H, m: None, s: State::Silent }));
        assert_eq!((t.devices["fw"].state, x.type_solved.len(), t.devices["fw"].type_state(b)), (State::NoDelay, 0, Some(State::Silent)));
        // More log types than were read: one that is not among them is unread, not silent.
        let mut more = rt("fw", NOW + 4 * H, &[("a", Some(1.0)), ("b", Some(95.0))]);
        more.types_truncated = true;
        at(&mut t, 2, vec![more]);
        let d = &t.devices["fw"];
        assert_eq!((of(&t, "c").state, d.type_state(of(&t, "c")), of(&t, "c").recent.len(), d.types_truncated), (State::NoDelay, None, 2, true));
        // So is one that had none before: a run that did not read it does not say it has none.
        let mut gone = rt("fw", NOW + 5 * H, &[("a", Some(1.0))]);
        gone.types_truncated = true;
        let mut u = Tracker::default();
        fw(&mut u, 0, &[("a", Some(1.0)), ("b", Some(1.0))]);
        fw(&mut u, 1, &[("a", Some(1.0))]);
        assert_eq!(u.devices["fw"].type_state(of(&u, "b")), Some(State::Silent));
        at(&mut u, 2, vec![gone]);
        assert_eq!(u.devices["fw"].type_state(of(&u, "b")), None);
        // The device silent: every log type of it is.
        at(&mut t, 4, vec![]);
        let d = &t.devices["fw"];
        assert!(d.state == State::Silent && d.types.iter().all(|s| s.state == State::Silent) && d.late_types().is_empty());
        assert!(of(&t, "b").open.is_some(), "silence solves nothing");
        let day = daily(&t, "d", NOW, NOW + 24 * H, NOW + 9 * H);
        assert_eq!((day.log_types, day.silent), (Some(LogTypes { total: 3, late: 0, above: 0 }), 1), "no logs is not late");
    }

    #[test]
    fn a_new_log_type_starts_in_its_devices_known_zone() {
        // India on a UTC cluster, known; a log type first seen 45 min late: −285 sits at no zone.
        let mut t = homed();
        let run = NOW + 8 * H;
        let a = at(&mut t, 4, vec![rt("ind", run, &[("sys", Some(-329.0)), ("audit", Some(-285.0))]), r("ktm", Some(-345.0), run), r("own", Some(1.0), run)]);
        let d = &t.devices["ind"];
        assert_eq!(d.types.iter().map(|s| (s.state, s.last_minutes)).collect::<Vec<_>>(), [(State::OtherTz, Some(1.0)), (State::Delay, Some(45.0))]);
        assert_eq!((d.state, d.last_minutes), (State::PartDelay, Some(45.0)), "on time in its own zone is not late");
        assert_eq!((d.home.map(|h| h.zone), a.type_opened.len()), (Some(330), 1));
        // All on time in that zone: another time zone, as the newest document had it.
        let run = NOW + 10 * H;
        at(&mut t, 5, vec![rt("ind", run, &[("sys", Some(-329.0)), ("audit", Some(-329.0))]), r("ktm", Some(-345.0), run), r("own", Some(1.0), run)]);
        assert_eq!(t.devices["ind"].state, State::OtherTz);
        // A log type measured before keeps what it found itself.
        assert_eq!(t.devices["ind"].types[1].home.map(|h| h.zone), Some(330));
    }

    #[test]
    fn a_log_type_is_dropped_after_a_week_and_its_points_after_eight_days() {
        let mut t = Tracker::default();
        fw(&mut t, 0, &[("a", Some(1.0)), ("gone", Some(45.0))]);
        for i in 1..84 {
            fw(&mut t, i, &[("a", Some(1.0))]);
        }
        assert!(t.devices["fw"].types.len() == 2, "a week is not over");
        let a = fw(&mut t, 84, &[("a", Some(1.0))]);
        assert_eq!((t.devices["fw"].types.len(), a.type_ended.len()), (1, 1));
        let e = &t.type_episodes[0];
        assert_eq!((e.solved_ms, e.ended_why.as_deref(), e.lasted_ms(NOW + 999 * H)), (None, Some(ENDED_FORGOTTEN), 0), "measured late once");
        for i in 85..100 {
            fw(&mut t, i, &[("a", Some(1.0))]);
        }
        assert_eq!((of(&t, "a").recent.len(), t.devices["fw"].recent.len()), (96, 100), "8 days at two hours; the device's a month");
        // The device forgotten: its log types' open periods end with it.
        fw(&mut t, 100, &[("a", Some(45.0)), ("b", Some(1.0))]);
        let a = at(&mut t, 200, vec![]);
        assert_eq!((a.forgotten, a.type_ended.len(), t.devices.len()), (1, 1, 0));
        // Ended periods are kept a month.
        t.prune(NOW + 400 * H + TYPE_EPISODES_MS);
        assert!(t.type_episodes.is_empty());
    }

    #[test]
    fn log_types_beyond_what_is_kept_still_count_and_it_is_said() {
        let names: Vec<String> = (0..TYPES_KEPT + 1).map(|i| format!("t{i:02}")).collect();
        let mut v: Vec<(&str, Option<f64>)> = names.iter().map(|n| (n.as_str(), Some(1.0))).collect();
        v.last_mut().unwrap().1 = Some(95.0);
        let mut t = Tracker::default();
        let a = fw(&mut t, 0, &v);
        let d = &t.devices["fw"];
        assert_eq!((d.types.len(), d.types_truncated, t.types_not_kept, d.state, d.last_minutes), (TYPES_KEPT, true, 1, State::PartDelay, Some(95.0)));
        assert!(a.type_opened.is_empty(), "no period without a series to solve it");
        // Their names, at their longest, in the series, the open and the ended periods of a cluster.
        const { assert!((2 * SERIES_KEPT + TYPE_EPISODES_KEPT) * crate::logdelay::measure::TYPE_NAME_MAX <= 80 << 20) };
        // More ended periods than are kept: the oldest go, and from when is kept.
        t.type_episodes = (0..TYPE_EPISODES_KEPT as i64 + 2).map(|i| Episode { device: "x".into(), started_ms: NOW + i, solved_ms: Some(NOW + i), ..Episode::default() }).collect();
        t.prune(NOW + H);
        assert_eq!((t.type_episodes.len(), t.type_episodes_cut_ms), (TYPE_EPISODES_KEPT, Some(NOW + 1)));
    }

    #[test]
    fn a_device_read_past_the_runs_log_types_has_its_own_state_and_it_is_said() {
        let mut t = Tracker::default();
        fw(&mut t, 0, &[("a", Some(1.0)), ("b", Some(95.0))]);
        assert_eq!(t.devices["fw"].state, State::PartDelay);
        let mut r = rt("fw", NOW + 2 * H, &[("a", Some(1.0))]);
        (r.types, r.types_truncated) = (None, true);
        let x = at(&mut t, 1, vec![r]);
        let d = &t.devices["fw"];
        assert_eq!((d.state, d.by_types, d.types_truncated, t.types_unread), (State::NoDelay, false, true, 1), "its newest document's, as before");
        assert!(d.types.iter().all(|s| d.type_state(s).is_none()) && d.late_types().is_empty(), "not what they were");
        assert!(of(&t, "b").open.is_some() && x.type_solved.is_empty() && x.rows[0].types.is_none() && x.rows[0].types_truncated);
        fw(&mut t, 2, &[("a", Some(1.0)), ("b", Some(1.0))]);
        assert_eq!((t.types_unread, t.devices["fw"].types_truncated), (0, false));
    }

    #[test]
    fn a_log_type_whose_zone_changed_solves_neither_itself_nor_its_device() {
        let mut t = homed();
        let mut ended = 0;
        for i in 4..16 {
            let run = NOW + i * 2 * H;
            let a = at(&mut t, i, vec![rt("own", run, &[("a", Some(if i < 6 { 1.0 } else { 60.0 })), ("b", Some(if i < 6 { 1.0 } else { 60.0 }))])]);
            assert!(a.solved.is_empty() && a.type_solved.is_empty(), "run {i}");
            ended += a.ended.len();
        }
        for i in 16..19 {
            let run = NOW + i * 2 * H;
            let a = at(&mut t, i, vec![rt("own", run, &[("a", Some(60.0)), ("b", Some(60.0))])]);
            assert!(a.solved.is_empty() && a.type_solved.is_empty(), "run {i}");
            ended += a.ended.len();
        }
        assert_eq!(ended, 1);
        assert_eq!(t.episodes.iter().find(|e| e.device == "own").and_then(|e| e.ended_why.clone()).as_deref(), Some(ENDED_ZONE));
        assert!(t.type_episodes.iter().all(|e| e.ended_why.as_deref() == Some(ENDED_ZONE)));
    }

    #[test]
    fn a_state_file_from_before_log_types_loads_and_one_with_them_round_trips() {
        let old = r#"{"devices":{"fw":{"firstSeenMs":1,"lastRunMs":2,"lastMinutes":45.0,"state":"delay","docs":3,"recent":[[2,45.0,"delay"],{"t":3,"m":null,"s":"silent"}],
            "open":{"device":"fw","startedMs":2,"worstMinutes":45.0,"worstState":"delay","lastMinutes":45.0,"lastState":"delay","measurements":1}}},"lastRunMs":2}"#;
        let t: Tracker = serde_json::from_str(old).unwrap();
        let d = &t.devices["fw"];
        assert!(d.types.is_empty() && d.types_since_ms.is_none() && d.recent.len() == 2 && !t.has_log_types() && t.log_type_field().is_none());
        let again = serde_json::to_value(&t).unwrap();
        for k in ["types", "byTypes", "logType", "noType", "typesSinceMs"] {
            assert!(again["devices"]["fw"].get(k).is_none() && again["devices"]["fw"]["open"].get(k).is_none(), "{k}: a cluster without log types is written as before");
        }
        let old_day: Daily = serde_json::from_str(r#"{"day":"2026-11-01","devices":2,"onTime":1,"little":0,"delayed":1,"critical":0,"clockAhead":0,"silent":0,"unmeasured":0,"started":0,"solved":0,"lateHours":0.0,"medianMinutes":null,"p95Minutes":null,"measured":2}"#).unwrap();
        assert_eq!((old_day.part_delayed, old_day.log_types, old_day.no_delay()), (0, None, 1), "not read by log types: not none of them");
        let mut t = Tracker::default();
        fw(&mut t, 0, &[("a", Some(1.0)), ("", Some(95.0))]);
        fw(&mut t, 1, &[("a", Some(1.0)), ("", Some(2.0))]);
        let s = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<Tracker>(&s).unwrap(), t);
        assert!(s.contains("\"recent\":\"1763100000000:1n 7200000:1n\""), "a log type's points are one text: {s}");
    }
}
