//! What the core remembers about each device between runs, and how one run changes it
//! (docs/LOGDELAY.md "Delay periods", "Silences", "Daily totals").
//!
//! ```text
//!   previous state ──▶ apply(run, readings) ──▶ new state
//!                        │
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
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One measurement of one device, as the tracker keeps the recent ones (31 days) for the
/// device graph, the medians and the daily totals, without reading the day files back.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    /// The run's time, epoch ms.
    pub t: i64,
    /// `None`: silent or can't measure.
    pub m: Option<f64>,
    pub s: State,
}

/// One delay period: open while `solved_ms` is `None`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub device: String,
    pub started_ms: i64,
    #[serde(default)]
    pub solved_ms: Option<i64>,
    pub worst_minutes: f64,
    pub worst_state: State,
    /// The last measured delay (the one that solved it, for a solved period).
    pub last_minutes: f64,
    pub last_state: State,
    /// Measurements taken while it was open, the solving one included.
    pub measurements: u32,
    /// Late measurements that sat within three minutes of a whole hour (60, 120, …): the
    /// "a whole hour off" pattern is read from this against `measurements`.
    #[serde(default)]
    pub whole_hour: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extras: BTreeMap<String, String>,
}

impl Episode {
    /// How long it lasted, or has lasted so far at `now`.
    pub fn lasted_ms(&self, now: i64) -> i64 {
        (self.solved_ms.unwrap_or(now) - self.started_ms).max(0)
    }

    /// How much of it fell inside `[from, to)`, in ms.
    pub fn overlap_ms(&self, from: i64, to: i64, now: i64) -> i64 {
        let end = self.solved_ms.unwrap_or(now);
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
    #[serde(default)]
    pub last_minutes: Option<f64>,
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
}

/// How long the built-in store keeps a solved period, a silence, a day file (Storage board:
/// "Kept 90 days").
pub const KEEP_MS: i64 = 90 * 86_400_000;
/// How long a device's recent points are kept in the tracker (a month of graph).
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
    pub delay_minutes: Option<f64>,
    pub state: State,
    pub extras: BTreeMap<String, String>,
}

/// A time-zone-shaped offset: within three minutes of a multiple of 30 minutes (60, 120,
/// 330 — a half-hour zone — …), and at least an hour. A real backlog never sits there.
pub fn whole_hour(m: f64) -> bool {
    let a = m.abs();
    a >= 57.0 && (a / 30.0 - (a / 30.0).round()).abs() * 30.0 <= 3.0
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

    /// One run: the readings against the memory, under `levels`. `silent_after_ms` is how
    /// long without a document makes a device silent.
    pub fn apply(&mut self, run_ms: i64, readings: Vec<Reading>, levels: &Levels, silent_after_ms: i64) -> Applied {
        let mut out = Applied::default();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
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
            }
            let state = match State::of(r.delay_minutes, levels) {
                Some(s) => s,
                None => State::Unmeasured,
            };
            let m = r.delay_minutes.filter(|_| state != State::Unmeasured).map(round2);
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
                        if state.late() && whole_hour(m) {
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
                            device: r.device.clone(), started_ms: run_ms, solved_ms: None, worst_minutes: m, worst_state: state,
                            last_minutes: m, last_state: state, measurements: 1, whole_hour: whole_hour(m) as u32, extras: d.extras.clone(),
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
                                delay_minutes: m, state, extras: d.extras.clone() });
        }
        // Devices the run did not see: silent after the limit, forgotten after a week.
        let mut forget = vec![];
        for (name, d) in self.devices.iter_mut() {
            if seen.contains(name) {
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
                                delay_minutes: None, state: State::Silent, extras: d.extras.clone() });
        }
        for name in forget {
            if let Some(d) = self.devices.remove(&name) {
                // Its open period ends unsolved: nobody measured it back under the line.
                if let Some(ep) = d.open {
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
        self.episodes.retain(|e| now - e.solved_ms.unwrap_or(e.started_ms) < KEEP_MS);
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
    fn a_device_gone_a_week_is_forgotten_and_its_open_period_kept_unsolved() {
        let l = Levels::default();
        let mut t = Tracker::default();
        t.apply(0, vec![r("gone", Some(45.0), 0)], &l, 2 * H);
        let a = t.apply(FORGET_MS + H, vec![], &l, 2 * H);
        assert_eq!(a.forgotten, 1);
        assert!(t.devices.is_empty());
        assert_eq!(t.episodes.len(), 1);
        assert_eq!(t.episodes[0].solved_ms, None);
    }

    #[test]
    fn whole_hour_offsets_are_read_from_the_period() {
        assert!(whole_hour(60.0) && whole_hour(62.5) && whole_hour(119.0) && whole_hour(330.0) && whole_hour(-60.0));
        assert!(!whole_hour(45.0) && !whole_hour(75.0) && !whole_hour(5.0) && !whole_hour(100.0));
        let l = Levels::default();
        let mut t = Tracker::default();
        for i in 0..5 {
            t.apply(i * 2 * H, vec![r("tz", Some(60.0 + (i % 2) as f64), i * 2 * H)], &l, 2 * H);
        }
        assert_eq!(t.devices["tz"].open.as_ref().unwrap().pattern(), Some("a whole hour off: time zone"));
        let mut t2 = Tracker::default();
        t2.apply(0, vec![r("ahead", Some(-40.0), 0)], &l, 2 * H);
        assert!(t2.devices["ahead"].open.is_none(), "clock ahead is not late");
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
