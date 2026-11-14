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
//!                        ├── a device missing for longer than the silence limit ─▶ silent
//!                        └── a device back after a silence                   ─▶ silence closed
//! ```
//!
//! A start or solve time is the run's time, so it is as exact as the interval. A silent or
//! unmeasurable device changes nothing about an open period: nothing was measured, and
//! "unknown" solves nothing (CLAUDE.md). The pure function is `apply`; nothing here touches
//! a disk or a cluster.

use super::levels::{Levels, State};
use super::measure::{round2, Reading};
use super::tz::{self, Detection, LogTimeZone, Offsets, RunTally};
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
    /// Set when the device was forgotten (a week unseen) while this was open: the period ended
    /// then, unsolved. Such a period lasts until `ended_ms`, and is never "still late" after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_ms: Option<i64>,
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

impl Episode {
    /// When it ended: solved, or ended with the device forgotten, or still open at `now`.
    pub fn end_ms(&self, now: i64) -> i64 {
        self.solved_ms.or(self.ended_ms).unwrap_or(now)
    }

    /// Late at instant `at`: begun before it, not solved before it, and not yet ended by
    /// forgetting (a device nobody has heard from in a week is not "still late", it is gone).
    pub fn late_at(&self, at: i64) -> bool {
        self.started_ms < at && self.solved_ms.is_none_or(|s| s >= at) && self.ended_ms.is_none_or(|e| e > at)
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
    /// The corrected delay (the raw gap with the zone taken out; the device's own for another zone).
    #[serde(default)]
    pub last_minutes: Option<f64>,
    /// The raw gap, arrival − event, as measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_raw_minutes: Option<f64>,
    /// The real UTC offset the raw gap sits at, when it sits at one, and for how many runs in a row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz_offset: Option<i32>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub tz_streak: u32,
    /// The offset taken out of `last_minutes`: the cluster's, or the device's own for another zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_offset: Option<i32>,
    #[serde(default = "unmeasured")]
    pub state: State,
    pub docs: u64,
    /// Documents seen in the last 24 hours of windows, for "logs a day".
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
    /// How the last run read this cluster's devices (pages, complete, cut at the cap).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_read: Option<super::collect::RunInfo>,
    /// The log time zone detected from the devices (tz.rs): the last runs' tallies, the result.
    #[serde(default)]
    pub tz: Detection,
}

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
    /// The corrected delay: `raw_gap_minutes − tz_offset_minutes`.
    pub delay_minutes: Option<f64>,
    /// Arrival − event, as measured.
    pub raw_gap_minutes: Option<f64>,
    /// The real UTC offset the raw gap sits at, if any (the device's apparent zone).
    pub device_tz_offset: Option<i32>,
    /// What was taken out: the cluster's offset, or the device's own for another zone. `None`:
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

impl Tracker {
    /// Open periods, every device.
    pub fn open_episodes(&self) -> impl Iterator<Item = &Episode> {
        self.devices.values().filter_map(|d| d.open.as_ref())
    }

    /// Solved and open periods together, oldest first.
    pub fn all_episodes(&self) -> Vec<Episode> {
        let mut v: Vec<Episode> = self.episodes.iter().cloned().chain(self.open_episodes().cloned()).collect();
        v.sort_by_key(|e| e.started_ms);
        v
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
    /// a row is in another time zone: not late, its delay shown against its own offset. With
    /// no zone (nothing set, nothing detected) the raw gap is the delay, as before.
    pub fn apply_run(&mut self, run_ms: i64, readings: Vec<Reading>, levels: &Levels, silent_after_ms: i64, complete: bool, zone: &LogTimeZone) -> Applied {
        let mut out = Applied::default();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let offsets = Offsets::at_run(run_ms);
        let raw_of = |r: &Reading| r.delay_minutes.filter(|m| m.is_finite());
        let matched: Vec<Option<i32>> = readings.iter().map(|r| raw_of(r).and_then(|m| offsets.matching(m, tz::TOLERANCE_MINUTES))).collect();
        if complete {
            self.tz.record(RunTally::count(run_ms, readings.iter().zip(&matched).filter(|(r, _)| raw_of(r).is_some()).map(|(_, m)| *m)));
        }
        let detected = self.tz.detected.map(|d| d.offset_minutes);
        let cluster_offset = |event_ms: Option<i64>| -> Option<i32> {
            match zone {
                LogTimeZone::Detect => detected,
                set => set.offset_at(event_ms.unwrap_or(run_ms)),
            }
        };
        for (r, dev_off) in readings.into_iter().zip(matched) {
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
            }
            // The zone step: the device's apparent offset and how long it has sat there, the
            // cluster's offset at this event's time, and the corrected delay that is levelled.
            let raw = raw_of(&r);
            match dev_off {
                Some(o) if d.tz_offset == Some(o) => d.tz_streak = d.tz_streak.saturating_add(1),
                Some(o) => { d.tz_offset = Some(o); d.tz_streak = 1; }
                None => { d.tz_offset = None; d.tz_streak = 0; }
            }
            let (corrected, applied, other) = match (raw, cluster_offset(r.event_ms)) {
                (None, _) => (None, None, false),
                (Some(raw), None) => (Some(raw), None, false),
                (Some(raw), Some(co)) => match dev_off.filter(|o| *o != co && d.tz_streak >= tz::DEVICE_STEADY_RUNS) {
                    Some(own) => (Some(raw - own as f64), Some(own), true),
                    None => (Some(raw - co as f64), Some(co), false),
                },
            };
            let state = if other { State::OtherTz } else { State::of(corrected, levels).unwrap_or(State::Unmeasured) };
            let m = corrected.filter(|_| state != State::Unmeasured).map(round2);
            d.last_raw_minutes = raw.map(round2);
            d.applied_offset = applied;
            if let Some(m) = m {
                d.last_minutes = Some(m);
                match d.open.as_mut() {
                    Some(ep) => {
                        ep.measurements += 1;
                        ep.last_minutes = m;
                        ep.last_state = state;
                        if m > ep.worst_minutes {
                            ep.worst_minutes = m;
                            ep.worst_state = state;
                        }
                        if state == State::OtherTz || (state.late() && whole_hour(m, &offsets)) {
                            ep.whole_hour += 1;
                        }
                        if !d.extras.is_empty() {
                            ep.extras = d.extras.clone();
                        }
                        if state.late() {
                            out.continued.push(ep.clone());
                        } else {
                            let mut done = d.open.take().unwrap_or_else(|| unreachable!());
                            done.solved_ms = Some(run_ms);
                            out.solved.push(done.clone());
                            self.episodes.push(done);
                        }
                    }
                    None if state.late() => {
                        let ep = Episode {
                            device: r.device.clone(), started_ms: run_ms, solved_ms: None, ended_ms: None, worst_minutes: m, worst_state: state,
                            last_minutes: m, last_state: state, measurements: 1, whole_hour: whole_hour(m, &offsets) as u32, extras: d.extras.clone(),
                        };
                        out.opened.push(ep.clone());
                        d.open = Some(ep);
                    }
                    None => {}
                }
            }
            d.state = state;
            d.recent.push(Point { t: run_ms, m, s: state });
            out.rows.push(Row { device: r.device, docs: r.docs, arrival_ms: d.last_arrival_ms, event_ms: d.last_event_ms,
                                delay_minutes: m, raw_gap_minutes: d.last_raw_minutes, device_tz_offset: dev_off, tz_offset_minutes: applied,
                                state, extras: d.extras.clone() });
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
            out.rows.push(Row { device: name.clone(), docs: 0, arrival_ms: d.last_arrival_ms, event_ms: d.last_event_ms,
                                delay_minutes: None, raw_gap_minutes: None, device_tz_offset: d.tz_offset, tz_offset_minutes: None,
                                state: State::Silent, extras: d.extras.clone() });
        }
        for name in forget {
            if let Some(d) = self.devices.remove(&name) {
                // Its open period ends here, unsolved: nobody measured it back under the line,
                // and nobody counts it as late from now on.
                if let Some(mut ep) = d.open {
                    ep.ended_ms = Some(run_ms);
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
    pub little: u64,
    pub delayed: u64,
    pub critical: u64,
    pub clock_ahead: u64,
    /// Devices whose gap sat at another real offset than the cluster's (not late).
    #[serde(default)]
    pub other_tz: u64,
    pub silent: u64,
    pub unmeasured: u64,
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
        if let Some(m) = in_day.iter().rev().find_map(|p| p.m) {
            lasts.push(m);
        }
    }
    d.measured = lasts.len() as u64;
    d.median_minutes = percentile(&mut lasts, 0.5);
    d.p95_minutes = percentile(&mut lasts, 0.95);
    let mut late_ms = 0i64;
    for e in t.all_episodes() {
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
                  delay_minutes: m, extras: BTreeMap::new() }
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
        // Little delay is under the line: solved, with how long and how bad it was.
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
        assert_eq!(t.episodes[0].lasted_ms(FORGET_MS + 50 * H), FORGET_MS + H);
        assert!(!t.episodes[0].late_at(FORGET_MS + 2 * H) && t.episodes[0].late_at(H));
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
                               delay_minutes: Some(120.0), extras: BTreeMap::new() };
        let after = Reading { device: "cet".into(), docs: 1, arrival_ms: Some(change + 30 * 60_000 + 60 * 60_000), event_ms: Some(change + 30 * 60_000),
                              delay_minutes: Some(60.0), extras: BTreeMap::new() };
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
        assert_eq!((d.devices, d.on_time, d.little, d.delayed, d.critical), (3, 1, 1, 0, 1), "b at 10 min is on time, a at 20 little, c critical");
        assert_eq!((d.started, d.solved), (2, 1));
        assert_eq!(d.late_hours, 2.0 + 3.0, "b: 2 h; c: 3 h so far (until now)");
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
