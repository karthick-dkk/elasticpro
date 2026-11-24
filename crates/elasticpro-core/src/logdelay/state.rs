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
//!                        └── a device back after a silence                   ─▶ silence closed
//! ```
//!
//! A start or solve time is the run's time, so it is as exact as the interval. A silent or
//! unmeasurable device (no readable clock, or a clock ahead) changes nothing about an open
//! period: nothing was measured, and "unknown" solves nothing (CLAUDE.md). An open period counts
//! up to its last measurement once that is older than `stale_after_ms`, never up to now. The pure function is `apply`; nothing here touches
//! a disk or a cluster.

use super::levels::{Levels, State};
use super::measure::{round2, Reading};
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub device: String,
    pub started_ms: i64,
    #[serde(default)]
    pub solved_ms: Option<i64>,
    /// Set when this ended without being solved: the device was forgotten (a week unseen), or
    /// its time zone changed. Never "still late" after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_ms: Option<i64>,
    /// Why it ended unsolved (`ENDED_FORGOTTEN`, `ENDED_ZONE`).
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
    pub recent: Vec<Point>,
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
}

/// One device's measurement row for this run.
#[derive(Clone, Debug, PartialEq)]
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
    /// Everything a series keeps is in `self`, so another kind of series beside the device's
    /// takes its readings through here too.
    fn take_reading(&mut self, key: &str, raw: Option<f64>, co: Option<i32>, cx: &RunCx) -> Change {
        let z = self.zone_step(raw, co, cx);
        let state = match State::of(z.corrected, cx.levels) {
            None => State::Unmeasured,
            // On time in a zone other than the cluster's. Late there is late.
            Some(State::NoDelay) if z.other => State::OtherTz,
            Some(s) => s,
        };
        let m = z.corrected.filter(|_| state != State::Unmeasured).map(round2);
        self.last_raw_minutes = raw.map(round2);
        self.applied_offset = z.applied;
        let mut out = Change { minutes: m, zone: z.zone, ..Change::default() };
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
                        device: key.to_string(), started_ms: cx.run_ms, solved_ms: None, ended_ms: None, ended_why: None, last_measured_ms: Some(cx.run_ms),
                        measured_until_ms: None, worst_minutes: m, worst_state: state, last_minutes: m, last_state: state, measurements: 1,
                        whole_hour: whole_hour(m, cx.offsets) as u32, extras: self.extras.clone(),
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
        let cx = RunCx { run_ms, levels, offsets: &offsets, named: matches!(zone, LogTimeZone::Named(_)) };
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
            let co = cluster_offset(r.event_ms);
            let c = d.take_reading(&r.device, raw_of(&r), co, &cx);
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
                                state: d.state, extras: d.extras.clone() });
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
            out.rows.push(Row { device: name.clone(), docs: 0, arrival_ms: d.last_arrival_ms, event_ms: d.last_event_ms, event_field: d.event_field.clone(),
                                delay_minutes: None, raw_gap_minutes: None, device_tz_offset: d.zone_offset(None), tz_offset_minutes: None,
                                state: State::Silent, extras: d.extras.clone() });
        }
        for name in forget {
            if let Some(d) = self.devices.remove(&name) {
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
        self.prune(run_ms);
        self.last_run_ms = Some(run_ms);
        self.silent_after_ms = Some(silent_after_ms);
        out
    }

    /// Drop what the built-in store no longer keeps.
    pub fn prune(&mut self, now: i64) {
        for d in self.devices.values_mut() {
            d.recent.retain(|p| now - p.t < RECENT_MS);
        }
        self.episodes.retain(|e| now - e.solved_ms.or(e.ended_ms).unwrap_or(e.started_ms) < KEEP_MS);
        self.silences.retain(|s| now - s.to_ms.unwrap_or(s.from_ms) < KEEP_MS);
        self.episodes.sort_by_key(|e| e.started_ms);
        self.silences.sort_by_key(|s| s.from_ms);
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
        let in_day: Vec<&Point> = dev.recent.iter().filter(|p| p.t >= from && p.t < to).collect();
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
                  delay_minutes: m, event_field: None, extras: BTreeMap::new() }
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
                               delay_minutes: Some(120.0), event_field: None, extras: BTreeMap::new() };
        let after = Reading { device: "cet".into(), docs: 1, arrival_ms: Some(change + 30 * 60_000 + 60 * 60_000), event_ms: Some(change + 30 * 60_000),
                              delay_minutes: Some(60.0), event_field: None, extras: BTreeMap::new() };
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
}
