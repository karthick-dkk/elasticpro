//! The figures the pages, the mail and the workbook show, from the built-in store, defined
//! once (docs/LOGDELAY.md "Messages"; CLAUDE.md "One definition per quantity").
//!
//! Everything here is a pure function of what the store holds: a tracker and the daily
//! totals per cluster, a range of local days, and the time it is asked. The Core hands the
//! inputs in and sends the answer out; the report builds its sheets from the same values.

use super::fixes::Finding;
use super::levels::{Levels, State, LOG_TYPE_FIELD, NO_LOG_TYPE};
use super::measure::MAPPING_NOT_READ;
use super::state::{late_in, measured_spans, percentile, Daily, DeviceState, Episode, LogTypes, Point, Tracker, TYPE_RECENT_MS};
use super::time;
use super::tz::{self, LogTimeZone};
use chrono::NaiveDate;
use chrono_tz::Tz;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

/// One cluster's inputs. The tracker is the store's cached copy.
pub struct ClusterInput {
    pub id: String,
    pub name: String,
    pub tracker: Arc<Tracker>,
    pub daily: BTreeMap<String, Daily>,
    pub levels: Levels,
    /// The cluster's `logTimeZone` setting (tz.rs); what was detected is in the tracker.
    pub zone: LogTimeZone,
    /// Zones a detected offset may be named after (the server's, those set on other clusters).
    pub tz_hints: Vec<Tz>,
}

impl ClusterInput {
    /// The cluster's time zone as every message says it (`timeZone`).
    pub fn time_zone(&self, now: i64) -> Value {
        tz::view(&self.zone, &self.tracker.tz, now, &self.tz_hints)
    }

    /// The log type field its last run read by, and why there is none (docs/LOGDELAY.md "Log types").
    pub fn log_type_field(&self) -> (Option<&str>, Option<&str>) {
        match self.tracker.log_type_field() {
            Some(f) => (f.field.as_deref(), f.why.as_deref()),
            None => (None, Some(MAPPING_NOT_READ)),
        }
    }

    /// Its log types as they are now; `None`: not read by log types.
    pub fn log_types(&self) -> Option<LogTypes> {
        self.tracker.has_log_types().then(|| {
            let mut n = LogTypes::default();
            self.tracker.devices.values().for_each(|d| d.types.iter().for_each(|s| n.add(d.type_state(s).unwrap_or(State::Unmeasured))));
            n
        })
    }

    /// The offset the cluster's delays are measured against now, when it has one.
    pub fn cluster_offset(&self, now: i64) -> Option<i32> {
        match self.zone {
            LogTimeZone::Detect => self.tracker.tz.detected.map(|d| d.offset_minutes),
            set => set.offset_at(now),
        }
    }
}

/// Local days `from..=to`, and the instants they span.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub from_ms: i64,
    pub to_ms: i64,
}

impl Range {
    pub fn days(from: NaiveDate, to: NaiveDate) -> Range {
        Range { from, to, from_ms: time::day_bounds(from).0, to_ms: time::day_bounds(to).1 }
    }

    /// The last `n` days ending today.
    pub fn last_days(now: i64, n: i64) -> Range {
        let today = time::local_date(now);
        Range::days(today - chrono::Duration::days(n - 1), today)
    }

    /// The same length of days just before this range.
    pub fn previous(&self) -> Range {
        let len = (self.to - self.from).num_days() + 1;
        Range::days(self.from - chrono::Duration::days(len), self.from - chrono::Duration::days(1))
    }

    pub fn day_keys(&self) -> Vec<String> {
        let mut out = vec![];
        let mut d = self.from;
        while d <= self.to {
            out.push(d.format("%Y-%m-%d").to_string());
            d = d.succ_opt().unwrap_or(d);
            if out.len() > 1200 {
                break;
            }
        }
        out
    }

    pub fn label(&self) -> String {
        if self.from == self.to { time::short_date(self.from) } else { format!("{} – {}", time::short_date(self.from), time::short_date(self.to)) }
    }
}

/// The counts of devices by state, now.
///
/// `noDelay` is the owner's figure (2026-11-24): every device not shown to be late — on time,
/// silent, or can't measure (no readable clock, or a clock ahead) — always written with its split
/// (`no_delay_text`). `onTime`, `silent`, `unmeasured` keep their strict meaning.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub devices: u64,
    /// A delay was measured: not silent, not can't measure.
    pub measured: u64,
    pub on_time: u64,
    pub no_delay: u64,
    pub little: u64,
    pub delay: u64,
    pub critical: u64,
    pub clock_ahead: u64,
    /// In another time zone than the cluster: measured, neither late nor on time.
    pub other_tz: u64,
    pub silent: u64,
    /// Of the silent ones, how many were late when they went silent (not solved).
    pub late_before_silent: u64,
    pub unmeasured: u64,
    /// `unmeasured` and `clockAhead` together.
    pub cant_measure: u64,
    /// Some of their log types late, some on time: neither late nor in `noDelay`.
    pub part_delayed: u64,
    /// The log types; `null`: not read by log types.
    pub log_types: Option<LogTypes>,
    /// Of the devices, how many the last run saw and did not read by log types: each in the class
    /// it had when they were read (`DeviceState::types_unread`).
    pub types_unread: u64,
}

/// The sum of two counts of log types, either of which may not be known.
fn plus_types(a: &mut Option<LogTypes>, b: Option<LogTypes>) {
    if let Some(b) = b {
        a.get_or_insert_default().plus(b);
    }
}

impl Totals {
    pub fn add(&mut self, s: State) {
        self.devices += 1;
        self.no_delay += s.no_delay() as u64;
        self.on_time += s.on_time() as u64;
        self.cant_measure += s.cant_measure() as u64;
        self.measured += (s.measured() && !s.cant_measure()) as u64;
        match s {
            State::NoDelay => {}
            State::Little => self.little += 1,
            State::Delay => self.delay += 1,
            State::Critical => self.critical += 1,
            State::ClockAhead => self.clock_ahead += 1,
            State::OtherTz => self.other_tz += 1,
            State::Silent => self.silent += 1,
            State::Unmeasured => self.unmeasured += 1,
            State::PartDelay => self.part_delayed += 1,
        }
    }

    /// A device as it is now.
    pub fn add_device(&mut self, d: &DeviceState) {
        self.add(d.state);
        self.late_before_silent += (d.state == State::Silent && d.open.is_some()) as u64;
    }

    fn sum(&mut self, o: &Totals) {
        for (a, b) in [(&mut self.devices, o.devices), (&mut self.measured, o.measured), (&mut self.on_time, o.on_time), (&mut self.no_delay, o.no_delay),
                       (&mut self.little, o.little), (&mut self.delay, o.delay), (&mut self.critical, o.critical), (&mut self.clock_ahead, o.clock_ahead),
                       (&mut self.other_tz, o.other_tz), (&mut self.silent, o.silent), (&mut self.late_before_silent, o.late_before_silent),
                       (&mut self.unmeasured, o.unmeasured), (&mut self.cant_measure, o.cant_measure), (&mut self.part_delayed, o.part_delayed), (&mut self.types_unread, o.types_unread)] {
            *a += b;
        }
        plus_types(&mut self.log_types, o.log_types);
    }

    pub fn late(&self) -> u64 {
        self.delay + self.critical
    }

    /// A day's counts, from the stored daily totals.
    pub fn of_day(d: &Daily) -> Totals {
        Totals {
            devices: d.devices, measured: d.measured, on_time: d.on_time + d.little, no_delay: d.no_delay(), little: d.little, delay: d.delayed, critical: d.critical,
            clock_ahead: d.clock_ahead, other_tz: d.other_tz, silent: d.silent, late_before_silent: d.late_before_silent, unmeasured: d.unmeasured,
            cant_measure: d.unmeasured + d.clock_ahead, part_delayed: d.part_delayed, log_types: d.log_types, types_unread: 0,
        }
    }

    /// The shares of all devices, as they go into an answer; `null` with no device.
    pub fn shares(&self) -> Value {
        // The eight classes a device can be in: they add up to the devices, and to 100.0 %.
        let parts = [self.on_time, self.silent, self.unmeasured, self.clock_ahead, self.delay, self.critical, self.other_tz, self.part_delayed];
        let Some(p) = tenths(&parts) else {
            return json!({ "pctNoDelay": null, "pctOnTime": null, "pctSilent": null, "pctUnmeasured": null, "pctCantMeasure": null, "pctLate": null, "pctOtherTz": null, "pctPartDelayed": null,
                           "noDelayText": null });
        };
        let pct = |n: u64| n as f64 / 10.0;
        let (no_delay, cant) = (p[0] + p[1] + p[2] + p[3], p[2] + p[3]);
        let was_late = match self.late_before_silent {
            0 => String::new(),
            1 => "; 1 of the silent was late before it went silent".into(),
            n => format!("; {n} of the silent were late before they went silent"),
        };
        json!({ "pctNoDelay": pct(no_delay), "pctOnTime": pct(p[0]), "pctSilent": pct(p[1]), "pctUnmeasured": pct(p[2]), "pctCantMeasure": pct(cant),
                "pctLate": pct(p[4] + p[5]), "pctOtherTz": pct(p[6]), "pctPartDelayed": pct(p[7]),
                "noDelayText": format!("No delay {} (on time {} · silent {} · can't measure {}{was_late})", pct_text(no_delay), pct_text(p[0]), pct_text(p[1]), pct_text(cant)) })
    }

    /// The counts, and the shares of `over` (the devices of clusters that were measured).
    pub fn json_over(&self, over: &Totals) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        v["late"] = json!(self.late());
        if let (Some(o), Some(s)) = (v.as_object_mut(), over.shares().as_object()) {
            o.extend(s.clone());
        }
        v
    }

    /// The counts, and the shares of all devices, one decimal; `null` of none.
    pub fn json(&self) -> Value {
        self.json_over(self)
    }
}

/// `95 %`, `94.7 %` from tenths.
fn pct_text(tenths: u64) -> String {
    if tenths.is_multiple_of(10) { format!("{} %", tenths / 10) } else { format!("{}.{} %", tenths / 10, tenths % 10) }
}

/// Shares in tenths of a percent that add up to exactly 1000 (largest remainder); `None` of none.
/// A part that has any is at least 0.1 %, taken from the largest: one late device of 5,000 is
/// never "0 %", and the rest never "100 %".
pub fn tenths(parts: &[u64]) -> Option<Vec<u64>> {
    let all: u64 = parts.iter().sum();
    if all == 0 {
        return None;
    }
    let mut out: Vec<u64> = parts.iter().map(|n| n * 1000 / all).collect();
    let mut by_rest: Vec<usize> = (0..parts.len()).collect();
    by_rest.sort_by_key(|i| std::cmp::Reverse(parts[*i] * 1000 % all));
    let left = 1000 - out.iter().sum::<u64>() as usize;
    for i in by_rest.into_iter().take(left) {
        out[i] += 1;
    }
    for (i, part) in parts.iter().enumerate() {
        if *part > 0 && out[i] == 0 {
            // The first of the largest; the pages' `shareTenths` takes the same one.
            let from = (0..out.len()).rev().max_by_key(|k| out[*k])?;
            out[from] -= 1;
            out[i] = 1;
        }
    }
    Some(out)
}

/// One device's line in any table.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRow {
    pub device: String,
    pub cluster: String,
    pub cluster_name: String,
    pub state: State,
    /// The corrected delay now (the raw gap with the zone taken out).
    pub now_minutes: Option<f64>,
    /// Arrival − event as measured, and what was taken out of it: the cluster's offset, or the
    /// device's own for one in another time zone. `None` = nothing taken out (no zone).
    pub raw_gap_minutes: Option<f64>,
    pub tz_offset_minutes: Option<i32>,
    /// The device's zone (its known one, else the one its gap sits at: −330 on a UTC cluster is
    /// +05:30).
    pub device_tz_offset: Option<i32>,
    /// The zone its delay is measured in when that is known to be another than the cluster's.
    pub own_zone: Option<i32>,
    /// The cluster's offset now (set or detected); `None` = the cluster has no zone.
    pub cluster_tz_offset: Option<i32>,
    pub median_minutes: Option<f64>,
    pub max_minutes: Option<f64>,
    /// Periods in the range, and how many of them solved.
    pub episodes: u64,
    pub solved: u64,
    /// Time inside open periods within the range, ms.
    pub late_ms: i64,
    pub last_started: Option<i64>,
    pub last_solved: Option<i64>,
    /// Why the last period ended when it was not solved.
    pub last_ended_why: Option<String>,
    /// `None` while no period is open.
    pub late_since: Option<i64>,
    /// When its delay was last measured, and whether that is too long ago to be "now"
    /// (`Tracker::stale_after`): the figures beside it are as of then.
    pub last_measured_ms: Option<i64>,
    pub stale: bool,
    /// Where its open period stops counting, when that is not now.
    pub measured_until_ms: Option<i64>,
    /// `None` when fewer than 24 hours of windows were counted: what was counted is below.
    pub docs_per_day: Option<u64>,
    pub docs_counted: Option<u64>,
    pub docs_counted_hours: Option<f64>,
    pub last_arrival: Option<i64>,
    pub last_event: Option<i64>,
    /// The field the event time was read from in the device's logs (`None`: kept before 0.3.89).
    pub event_field: Option<String>,
    pub silent_since: Option<i64>,
    /// `Zone` and `tag1` of the device (an extra column, read whatever its case): every row of
    /// every log delay table carries them; `None` = the device's logs do not say.
    pub zone: Option<String>,
    pub tag1: Option<String>,
    /// The device sent logs in its cluster's last run (what a live check or *Fetch now* sees);
    /// `false` for one only remembered from earlier in the range (silent, or seen before).
    pub in_last_run: bool,
    pub extras: BTreeMap<String, String>,
    pub state_text: String,
    /// Its log types as its last reading had them; `None`: not read by log types.
    pub types: Option<TypesRow>,
    /// The last run saw it and did not read its log types: the cluster's devices so (`null`: no).
    pub types_unread: Option<u64>,
    /// Time part delayed within the range, ms: not in `lateMs`.
    pub part_late_ms: i64,
    /// The log type its delay is of; `None`: its newest document's.
    pub delay_log_type: Option<String>,
}

/// A device's log types in its row.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesRow {
    pub total: u64,
    /// A delay was measured: not silent, not can't measure, not one the last run did not read.
    pub measured: u64,
    pub late: u64,
    /// The worst first.
    pub late_names: Vec<String>,
    /// It has more log types than were read or kept.
    pub truncated: bool,
}

impl TypesRow {
    fn of(d: &DeviceState) -> TypesRow {
        let late = d.late_types();
        TypesRow {
            total: d.types.len() as u64,
            measured: d.types.iter().filter(|s| d.type_state(s).is_some_and(|x| x.measured() && !x.cant_measure())).count() as u64,
            late: late.len() as u64, late_names: late.iter().map(|s| s.type_label()).collect(), truncated: d.types_truncated || d.types_unread,
        }
    }

    /// `1 of 3 log types late: threat`.
    pub fn text(&self) -> String {
        let of = if self.truncated { format!("{}+", self.total) } else { self.total.to_string() };
        format!("{} of {of} log types late: {}", self.late, self.late_names.join(", "))
    }
}

/// Every device of one cluster measured in the range: a measurement (any state, silent
/// included) inside it, or a delay period overlapping it. A device the tracker remembers only
/// from before the range is not in it — the report for yesterday lists yesterday's devices.
pub fn device_rows(c: &ClusterInput, r: &Range, now: i64) -> Vec<DeviceRow> {
    let eps = c.tracker.all_episodes(now);
    let by_device = episodes_by_device(&eps, r, now);
    let mut out = vec![];
    let unread = c.tracker.types_unread();
    for (name, d) in &c.tracker.devices {
        let mine = by_device.get(name.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        if mine.is_empty() && !measured_in(d, r) {
            continue;
        }
        out.push(row_of(c, name, d, mine, unread, r, now));
    }
    // Sorted by time spent late, the worst first; ties by the delay now.
    out.sort_by(|a, b| b.late_ms.cmp(&a.late_ms).then(b.now_minutes.unwrap_or(0.0).partial_cmp(&a.now_minutes.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal)));
    out
}

/// The periods overlapping the range, by device (one pass, not one per device: 25 000 devices).
fn episodes_by_device<'a>(eps: &'a [Episode], r: &Range, now: i64) -> std::collections::HashMap<&'a str, Vec<&'a Episode>> {
    let mut m: std::collections::HashMap<&str, Vec<&Episode>> = std::collections::HashMap::new();
    for e in eps.iter().filter(|e| e.started_ms < r.to_ms && e.end_ms(now) >= r.from_ms) {
        m.entry(e.device.as_str()).or_default().push(e);
    }
    m
}

fn measured_in(d: &super::state::DeviceState, r: &Range) -> bool {
    // Newest first: in the ranges the pages ask for it is the first one looked at.
    d.recent.iter().rev().any(|p| p.t >= r.from_ms && p.t < r.to_ms)
}

/// One device's row over the range; `mine` are its periods overlapping the range, `unread` the
/// cluster's devices whose log types were not read.
fn row_of(c: &ClusterInput, name: &str, d: &super::state::DeviceState, mine: &[&Episode], unread: u64, r: &Range, now: i64) -> DeviceRow {
    let mut in_range: Vec<f64> = d.recent.iter().filter(|p| p.t >= r.from_ms && p.t < r.to_ms && !p.s.cant_measure()).filter_map(|p| p.m).collect();
    let max = in_range.iter().cloned().fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.max(x))));
    let last = mine.last();
    let docs = c.tracker.docs_counted(d);
    let last_measured = Tracker::last_measured(d);
    let cluster_offset = c.cluster_offset(now);
    let measured = d.state.measured();
    // Late time, part late time and the percentages are of the time it was measured.
    let spans = if mine.is_empty() && d.types_since_ms.is_none() { vec![] } else { measured_spans(d.recent.iter(), c.tracker.stale_after(), r.from_ms, r.to_ms, now) };
    let mut row = DeviceRow {
        device: name.to_string(), cluster: c.id.clone(), cluster_name: c.name.clone(), state: d.state,
        now_minutes: if measured { d.last_minutes } else { None },
        raw_gap_minutes: if measured { d.last_raw_minutes } else { None },
        tz_offset_minutes: if measured { d.applied_offset } else { None },
        device_tz_offset: d.zone_offset(cluster_offset), cluster_tz_offset: cluster_offset,
        own_zone: d.home.filter(|h| !h.same_as_cluster()).map(|h| h.zone),
        median_minutes: percentile(&mut in_range, 0.5), max_minutes: max,
        episodes: mine.len() as u64, solved: mine.iter().filter(|e| e.solved_ms.is_some()).count() as u64,
        late_ms: if mine.is_empty() { 0 } else { mine.iter().map(|e| late_in(e, &spans, now)).sum() },
        last_started: last.map(|e| e.started_ms), last_solved: last.and_then(|e| e.solved_ms),
        late_since: d.open.as_ref().map(|e| e.started_ms),
        last_ended_why: last.and_then(|e| e.ended_why.clone()),
        last_measured_ms: last_measured,
        stale: d.state.measured() && (d.types_unread && d.types_since_ms.is_some() || now - d.last_run_ms > c.tracker.stale_after()),
        measured_until_ms: mine.iter().find(|e| e.stale()).and_then(|e| e.measured_until_ms),
        docs_per_day: docs.filter(|(_, h)| *h >= 24.0).map(|(n, h)| (n as f64 * 24.0 / h).round() as u64),
        docs_counted: docs.map(|(n, _)| n), docs_counted_hours: docs.map(|(_, h)| h),
        last_arrival: d.last_arrival_ms, last_event: d.last_event_ms, event_field: d.event_field.clone(),
        silent_since: d.silence.as_ref().map(|s| s.from_ms),
        zone: super::extra_ci(&d.extras, "Zone").cloned(), tag1: super::extra_ci(&d.extras, "tag1").cloned(),
        in_last_run: in_last_run(d, c.tracker.last_run_ms),
        extras: d.extras.clone(), state_text: String::new(),
        types: (c.tracker.has_log_types() && (d.types_since_ms.is_some() || d.types_unread)).then(|| TypesRow::of(d)),
        types_unread: (c.tracker.has_log_types() && d.types_unread).then_some(unread),
        part_late_ms: part_late_ms(d, &spans),
        delay_log_type: d.late_types().first().filter(|_| d.by_types).map(|s| s.type_label()),
    };
    row.state_text = state_text(&row, now);
    row
}

/// How long the device was part delayed within the range: the stretches measured that began with
/// a part-delayed reading.
fn part_late_ms(d: &DeviceState, spans: &[(i64, i64, State)]) -> i64 {
    if d.types_since_ms.is_none() {
        return 0;
    }
    spans.iter().filter(|(_, _, s)| *s == State::PartDelay).map(|(a, b, _)| b - a).sum()
}

/// Whether a device sent logs in its cluster's last run: read by it (not silent), at its time.
pub fn in_last_run(d: &super::state::DeviceState, last_run: Option<i64>) -> bool {
    last_run == Some(d.last_run_ms) && d.state != State::Silent
}

/// How a cluster's devices are counted, side by side (docs/LOGDELAY.md "Which devices"):
/// `inLastRun` — sent logs in the last run's window (what a live check sees); `now` — every
/// device the tracker holds, silent ones included (the totals); `inRange` — measured at any
/// time in the range (the report's device list).
pub fn device_counts(c: &ClusterInput, r: &Range, now: i64) -> Value {
    let last = c.tracker.last_run_ms;
    let in_last = c.tracker.devices.values().filter(|d| in_last_run(d, last)).count();
    let eps = c.tracker.all_episodes(now);
    let by_device = episodes_by_device(&eps, r, now);
    let in_range = c.tracker.devices.iter().filter(|(n, d)| by_device.contains_key(n.as_str()) || measured_in(d, r)).count();
    json!({ "inLastRun": in_last, "now": c.tracker.devices.len(), "inRange": in_range,
            "lastRead": c.tracker.last_read })
}

/// The devices' states now.
pub fn totals(c: &ClusterInput) -> Totals {
    let mut t = Totals::default();
    for d in c.tracker.devices.values() {
        t.add_device(d);
    }
    t.log_types = c.log_types();
    t.types_unread = if c.tracker.has_log_types() { c.tracker.types_unread() } else { 0 };
    t
}

/// The log types as they are now, over clusters, the worst first; the documents without one are
/// a row of their own. At most `MAX_LOG_TYPES` rows.
pub fn by_log_type<'a>(clusters: impl Iterator<Item = &'a ClusterInput>) -> Vec<Value> {
    let mut m: BTreeMap<Option<&str>, (u64, LogTypes, u64, Option<f64>)> = BTreeMap::new();
    for c in clusters.filter(|c| c.tracker.has_log_types()) {
        for (d, s) in c.tracker.devices.values().flat_map(|d| d.types.iter().map(move |s| (d, s))) {
            let x = m.entry(s.log_type.as_deref()).or_default();
            x.0 += 1;
            let Some(state) = d.type_state(s) else { continue };
            x.1.add(state);
            x.2 += (state == State::Silent) as u64;
            if let Some(n) = s.last_minutes.filter(|_| state.measured() && !state.cant_measure()) {
                x.3 = Some(x.3.map_or(n, |w| w.max(n)));
            }
        }
    }
    let mut v: Vec<_> = m.into_iter().collect();
    v.sort_by(|(_, a), (_, b)| b.1.above.cmp(&a.1.above).then(b.1.late.cmp(&a.1.late)).then(b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal)));
    v.truncate(MAX_LOG_TYPES);
    v.into_iter().map(|(name, (devices, n, silent, worst))| json!({ "logType": name.unwrap_or(NO_LOG_TYPE), "noType": name.is_none(), "devices": devices,
        "late": n.late, "above": n.above, "silent": silent, "worstMinutes": worst })).collect()
}

/// Rows of `by_log_type` an answer carries.
pub const MAX_LOG_TYPES: usize = 500;

/// One day's windows of `every` hours: newly late, solved and still late in each, and — by each
/// device's last stored measurement at the window's end (`State`, the one definition) — how many
/// sat in the delay band (`delay`) and above the critical line (`critical`). The Dashboard's
/// Today draws its three panels from these; `solved` is the devices that came back below the line.
pub fn windows(trackers: &[&Tracker], day: NaiveDate, every_hours: u64, now: i64) -> Vec<Value> {
    let eps: Vec<Episode> = trackers.iter().flat_map(|t| t.all_episodes(now)).collect();
    time::windows(day, every_hours).into_iter().filter(|(from, _)| *from <= now).map(|(from, to)| {
        let newly = eps.iter().filter(|e| e.started_ms >= from && e.started_ms < to).count();
        let solved = eps.iter().filter(|e| e.solved_ms.is_some_and(|s| s >= from && s < to)).count();
        let end = to.min(now);
        let still = eps.iter().filter(|e| e.late_at(end)).count();
        let (mut delay, mut critical, mut part) = (0usize, 0usize, 0usize);
        for t in trackers {
            for d in t.devices.values() {
                // Points are chronological; today's windows sit at the tail, so the reverse scan is short.
                // One too old to speak for the window's end (nothing measured since) is not carried on.
                match d.recent.iter().rev().find(|p| p.t <= end).filter(|p| p.t >= from || end - p.t <= t.stale_after()).map(|p| p.s) {
                    Some(State::Delay) => delay += 1,
                    Some(State::Critical) => critical += 1,
                    Some(State::PartDelay) => part += 1,
                    _ => {}
                }
            }
        }
        let at = measured_late(trackers, from, to);
        json!({ "from": from, "to": to, "label": time::window_label(from, to), "newlyLate": newly, "solved": solved, "stillLate": still,
                "delay": delay, "critical": critical, "complete": now >= to,
                "partDelayed": part, "measured": at.is_some(), "lateAt": at.map(|a| a.late), "criticalAt": at.map(|a| a.critical), "partAt": at.map(|a| a.part) })
    }).collect()
}

/// Late devices at a window's own measurement (Log Delay › Late devices over the day).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AtMeasurement {
    /// In the delay band or above the critical line (`State::Delay` or `State::Critical`).
    pub late: usize,
    /// Above the critical line.
    pub critical: usize,
    /// Part delayed: in neither of the above.
    pub part: usize,
}

/// The devices late at the measurement taken inside `[from, to)`: each device by its last
/// reading inside the window. `None` when no device's delay was measured there — no run, or every
/// device silent — and nothing earlier is carried into it (the old heat map did, so rows repeated).
pub fn measured_late(trackers: &[&Tracker], from: i64, to: i64) -> Option<AtMeasurement> {
    let mut seen = false;
    let mut at = AtMeasurement { late: 0, critical: 0, part: 0 };
    for t in trackers {
        for d in t.devices.values() {
            // Points are chronological: skip the ones after the window, take the first inside it.
            let Some(p) = d.recent.iter().rev().skip_while(|p| p.t >= to).take_while(|p| p.t >= from).next() else { continue };
            seen = seen || d.recent.iter().rev().skip_while(|p| p.t >= to).take_while(|p| p.t >= from).any(|p| p.m.is_some() && !p.s.cant_measure());
            match p.s {
                State::Delay => at.late += 1,
                State::Critical => { at.late += 1; at.critical += 1 }
                State::PartDelay => at.part += 1,
                _ => {}
            }
        }
    }
    seen.then_some(at)
}

/// The same window yesterday as the cluster's last run (the window holding `last_run − 1 day`),
/// measured as `measured_late`: what "vs yesterday" compares the late count with. `None` before
/// a first run.
pub fn same_window_yesterday(t: &Tracker, every_hours: u64) -> Option<Value> {
    let last = t.last_run_ms?;
    let then = last - 86_400_000;
    let (from, to) = time::windows(time::local_date(then), every_hours).into_iter().find(|(f, e)| then >= *f && then < *e)?;
    let at = measured_late(&[t], from, to);
    Some(json!({ "from": from, "to": to, "label": time::window_label(from, to), "measured": at.is_some(),
                 "lateAt": at.map(|a| a.late), "criticalAt": at.map(|a| a.critical), "partAt": at.map(|a| a.part) }))
}

/// The daily totals summed over clusters for the range's days; a day no cluster has is
/// absent (not a row of zeroes).
pub fn days(clusters: &[&ClusterInput], r: &Range) -> Vec<Value> {
    let mut out = vec![];
    for key in r.day_keys() {
        let mut sum = Daily { day: key.clone(), complete: true, ..Daily::default() };
        let mut any = false;
        let mut medians = vec![];
        for c in clusters {
            let Some(d) = c.daily.get(&key) else { continue };
            any = true;
            sum.devices += d.devices;
            sum.on_time += d.on_time;
            sum.little += d.little;
            sum.delayed += d.delayed;
            sum.critical += d.critical;
            sum.clock_ahead += d.clock_ahead;
            sum.other_tz += d.other_tz;
            sum.silent += d.silent;
            sum.late_before_silent += d.late_before_silent;
            sum.unmeasured += d.unmeasured;
            sum.part_delayed += d.part_delayed;
            plus_types(&mut sum.log_types, d.log_types);
            sum.started += d.started;
            sum.solved += d.solved;
            sum.measured += d.measured;
            sum.late_hours += d.late_hours;
            sum.complete &= d.complete;
            if let Some(m) = d.median_minutes {
                medians.push(m);
            }
        }
        if !any {
            continue;
        }
        sum.late_hours = (sum.late_hours * 100.0).round() / 100.0;
        sum.median_minutes = percentile(&mut medians, 0.5);
        sum.p95_minutes = None;
        let mut v = serde_json::to_value(&sum).unwrap_or(Value::Null);
        let t = Totals::of_day(&sum);
        v["onTimeAll"] = json!(t.on_time);
        v["noDelay"] = json!(t.no_delay);
        v["cantMeasure"] = json!(t.cant_measure);
        v["late"] = json!(t.late());
        v["logTypes"] = json!(sum.log_types);
        if let (Some(o), Some(s)) = (v.as_object_mut(), t.shares().as_object()) {
            o.extend(s.clone());
        }
        out.push(v);
    }
    out
}

/// Share of devices without delay (`Totals::no_delay`) over the range's days, from the daily
/// totals: the mean of each day's share. `None` with no day.
pub fn below_share(c: &ClusterInput, r: &Range) -> Option<f64> {
    let shares: Vec<f64> = r.day_keys().iter().filter_map(|k| c.daily.get(k)).filter(|d| d.devices > 0)
        .map(|d| d.no_delay() as f64 / d.devices as f64).collect();
    (!shares.is_empty()).then(|| ((shares.iter().sum::<f64>() / shares.len() as f64) * 1000.0).round() / 10.0)
}

/// Late devices per day of the range, for a sparkline: `null` for a day without totals.
pub fn sparkline(c: &ClusterInput, r: &Range) -> Vec<Value> {
    sparkline_of(&c.daily, r)
}

/// `sparkline` from the daily totals alone.
pub fn sparkline_of(daily: &BTreeMap<String, Daily>, r: &Range) -> Vec<Value> {
    r.day_keys().iter().map(|k| daily.get(k).map(|d| json!(d.delayed + d.critical)).unwrap_or(Value::Null)).collect()
}

/// One cluster's line in the device page's "Delay by cluster" panel, from its daily totals
/// alone (daily.json, not the tracker): late devices per day of the range, the peak, and how
/// many were late on the last day measured — `null`, not 0, when no day is kept.
pub fn cluster_line(id: &str, name: &str, daily: &BTreeMap<String, Daily>, r: &Range) -> Value {
    let spark = sparkline_of(daily, r);
    let days = r.day_keys();
    let peak = spark.iter().enumerate().filter_map(|(i, n)| n.as_u64().map(|n| (n, i))).max();
    let last = daily.iter().next_back();
    json!({ "id": id, "name": name, "lateNow": last.map(|(_, d)| d.delayed + d.critical), "lateAsOf": last.map(|(k, _)| k),
            "sparkline": spark, "peak": peak.map(|(n, _)| n), "peakDay": peak.and_then(|(_, i)| days.get(i).cloned()), "days": days })
}

/// Periods solved in the last `hours`, over clusters.
pub fn reduced(trackers: &[&Tracker], now: i64, hours: &[i64]) -> Vec<Value> {
    let solved: Vec<i64> = trackers.iter().flat_map(|t| t.episodes.iter().filter_map(|e| e.solved_ms)).collect();
    hours.iter().map(|h| json!({ "hours": h, "n": solved.iter().filter(|s| now - **s <= h * 3_600_000 && **s <= now).count() })).collect()
}

/// The fleet summary (Main board).
pub fn fleet(clusters: &[ClusterInput], r: &Range, now: i64, every_hours: u64, max_devices: usize) -> Value {
    let refs: Vec<&ClusterInput> = clusters.iter().collect();
    let trackers: Vec<&Tracker> = clusters.iter().map(|c| c.tracker.as_ref()).collect();
    let mut all = Totals::default();
    // The shares are of the clusters that were measured: one whose last run failed has none.
    let (mut shown, mut shown_clusters) = (Totals::default(), 0u64);
    let mut per_cluster = vec![];
    let mut rows: Vec<DeviceRow> = vec![];
    let today = time::local_date(now);
    let (t0, t1) = time::day_bounds(today);
    let prev = r.previous();
    for c in clusters {
        let t = totals(c);
        let not_measured = c.tracker.not_measured(now);
        all.sum(&t);
        if not_measured.is_none() {
            shown.sum(&t);
            shown_clusters += 1;
        }
        let shares = if not_measured.is_none() { t } else { Totals::default() }.shares();
        let crows = device_rows(c, r, now);
        let worst = crows.iter().filter(|x| x.now_minutes.is_some()).max_by(|a, b| a.now_minutes.partial_cmp(&b.now_minutes).unwrap_or(std::cmp::Ordering::Equal));
        let new_today = c.tracker.all_episodes(now).iter().filter(|e| e.started_ms >= t0 && e.started_ms < t1).count();
        let mut entry = json!({
            "id": c.id, "name": c.name, "devices": t.devices, "measured": t.measured, "lateNow": t.late(), "delay": t.delay, "critical": t.critical,
            "silent": t.silent, "unmeasured": t.unmeasured, "otherTz": t.other_tz, "timeZone": c.time_zone(now),
            "below": t.no_delay, "belowPct": shares["pctNoDelay"], "latePct": shares["pctLate"],
            "belowPctPrevious": below_share(c, &prev), "newToday": new_today,
            "sparkline": sparkline(c, r), "sparklineDays": r.day_keys(),
            "worst": worst.map(|w| json!({ "device": w.device, "minutes": w.now_minutes, "state": w.state, "logType": w.delay_log_type, "at": w.last_measured_ms, "stale": w.stale })),
            "levels": c.levels, "lastRunAt": c.tracker.last_run_ms,
            "counts": device_counts(c, r, now), "lastRead": c.tracker.last_read,
            // Today's windows per cluster: the Dashboard's Late devices over the day.
            "windows": windows(&[c.tracker.as_ref()], today, every_hours, now),
            "yesterdayWindow": same_window_yesterday(&c.tracker, every_hours),
        });
        entry["notMeasured"] = json!(not_measured);
        // Its last run is longer ago than an interval (or the silence limit): its states are of then.
        entry["stale"] = json!(c.tracker.last_run_ms.is_some_and(|t| now - t > c.tracker.stale_after()));
        for (k, n) in [("noDelay", t.no_delay), ("onTime", t.on_time), ("cantMeasure", t.cant_measure), ("clockAhead", t.clock_ahead), ("lateBeforeSilent", t.late_before_silent),
                       ("partDelayed", t.part_delayed)] {
            entry[k] = json!(n);
        }
        let (field, why) = c.log_type_field();
        entry["logTypes"] = json!(t.log_types);
        entry["logTypeField"] = json!(field);
        entry["logTypeWhy"] = json!(why);
        entry["logTypesNotKept"] = json!(c.tracker.types_not_kept);
        entry["typesUnread"] = json!(t.types_unread);
        if let (Some(o), Some(s)) = (entry.as_object_mut(), shares.as_object()) {
            o.extend(s.clone());
        }
        per_cluster.push(entry);
        rows.extend(crows);
    }
    per_cluster.sort_by(|a, b| b["latePct"].as_f64().unwrap_or(0.0).partial_cmp(&a["latePct"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    rows.sort_by_key(|r| std::cmp::Reverse(r.late_ms));
    let in_range = rows.len();
    let truncated = rows.len() > max_devices;
    rows.truncate(max_devices);
    let eps: Vec<Episode> = trackers.iter().flat_map(|t| t.all_episodes(now)).collect();
    let mut totals = all.json_over(&shown);
    // "N of M": how much of the fleet the shares speak for.
    totals["pctOf"] = json!({ "clusters": shown_clusters, "ofClusters": clusters.len(), "devices": shown.devices, "ofDevices": all.devices });
    let yesterday = today.pred_opt().unwrap_or(today);
    let (y0, y1) = time::day_bounds(yesterday);
    let y_solved: Vec<&Episode> = eps.iter().filter(|e| e.solved_ms.is_some_and(|s| s >= y0 && s < y1)).collect();
    let y_avg = (!y_solved.is_empty()).then(|| y_solved.iter().map(|e| e.lasted_ms(now)).sum::<i64>() / y_solved.len() as i64);
    json!({
        "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string(), "label": r.label(), "now": now,
        "everyHours": every_hours, "clusters": clusters.len(), "measuredClusters": clusters.iter().filter(|c| c.tracker.last_run_ms.is_some()).count(),
        "totals": totals,
        "reduced": reduced(&trackers, now, &[2, 4, 6, 12, 24]),
        "newlyLateToday": eps.iter().filter(|e| e.started_ms >= t0 && e.started_ms < t1).count(),
        "solvedToday": eps.iter().filter(|e| e.solved_ms.is_some_and(|s| s >= t0 && s < t1)).count(),
        "yesterday": { "newlyLate": eps.iter().filter(|e| e.started_ms >= y0 && e.started_ms < y1).count(), "solved": y_solved.len(), "averageLastedMs": y_avg },
        "windows": windows(&trackers, today, every_hours, now),
        "days": days(&refs, r),
        "byCluster": per_cluster, "byLogType": by_log_type(clusters.iter()),
        "devices": rows, "devicesTotal": all.devices, "devicesInRange": in_range, "devicesTruncated": truncated,
        "devicesInLastRun": clusters.iter().map(|c| c.tracker.devices.values().filter(|d| in_last_run(d, c.tracker.last_run_ms)).count()).sum::<usize>(),
    })
}

/// One cluster (Cluster board).
pub fn cluster(c: &ClusterInput, r: &Range, now: i64, every_hours: u64, fields: &Value) -> Value {
    let t = totals(c);
    let not_measured = c.tracker.not_measured(now);
    let totals = t.json_over(&if not_measured.is_none() { t } else { Totals::default() });
    let rows = device_rows(c, r, now);
    let eps = c.tracker.all_episodes(now);
    let mut nows: Vec<f64> = c.tracker.devices.values().filter_map(|d| d.last_minutes.filter(|_| d.state != State::Silent && !d.state.cant_measure())).collect();
    let prev = r.previous();
    let mut prev_medians: Vec<f64> = prev.day_keys().iter().filter_map(|k| c.daily.get(k).and_then(|d| d.median_minutes)).collect();
    let today = time::local_date(now);
    let (log_type_field, log_type_why) = c.log_type_field();
    json!({
        "cluster": c.id, "name": c.name, "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string(), "label": r.label(),
        "now": now, "everyHours": every_hours, "levels": c.levels, "fields": fields, "lastRunAt": c.tracker.last_run_ms,
        "timeZone": c.time_zone(now),
        "counts": device_counts(c, r, now), "lastRead": c.tracker.last_read,
        "totals": totals, "notMeasured": not_measured,
        "logTypeField": log_type_field, "logTypeWhy": log_type_why, "byLogType": by_log_type(std::iter::once(c)), "logTypesNotKept": c.tracker.types_not_kept,
        "started": eps.iter().filter(|e| e.started_ms >= r.from_ms && e.started_ms < r.to_ms).count(),
        "solved": eps.iter().filter(|e| e.solved_ms.is_some_and(|s| s >= r.from_ms && s < r.to_ms)).count(),
        "medianNow": percentile(&mut nows, 0.5), "medianPrevious": percentile(&mut prev_medians, 0.5),
        "windows": windows(&[c.tracker.as_ref()], today, every_hours, now),
        "days": days(&[c], r),
        "devices": rows,
    })
}

/// A device's log types' points from the day files (`store.rs`), oldest first: what is older than
/// the tracker keeps (`TYPE_RECENT_MS`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OlderTypes {
    pub points: BTreeMap<Option<String>, Vec<Point>>,
    /// Not everything asked for was read: from here on only.
    pub from_ms: Option<i64>,
}

impl OlderTypes {
    /// Of one device's measurement lines, oldest first. A type the device had before and a whole
    /// reading does not name had no logs then.
    pub fn of(lines: &[Value]) -> OlderTypes {
        let mut out = OlderTypes::default();
        for l in lines {
            let (Some(t), Some(types)) = (l["measured_at"].as_i64(), l["types"].as_array()) else { continue };
            let mut quiet: BTreeSet<Option<String>> = if l["types_truncated"] == true { BTreeSet::new() } else { out.points.keys().cloned().collect() };
            for x in types {
                let name = if x["no_type"] == true { None } else { x["log_type"].as_str().map(String::from) };
                let Ok(s) = serde_json::from_value::<State>(x["state"].clone()) else { continue };
                quiet.remove(&name);
                out.points.entry(name).or_default().push(Point { t, m: x["delay_minutes"].as_f64(), s });
            }
            for name in quiet {
                out.points.entry(name).or_default().push(Point { t, m: None, s: State::Silent });
            }
        }
        out
    }
}

/// One device's log types over the range, the worst first: those it has now, and those with a
/// point or a delay period in the range that were dropped since (a week without a log).
fn series(c: &ClusterInput, name: &str, d: &DeviceState, older: &OlderTypes, r: &Range, now: i64) -> Vec<Value> {
    let in_range = |t: i64| t >= r.from_ms && t < r.to_ms;
    let mut eps: BTreeMap<Option<String>, Vec<Episode>> = BTreeMap::new();
    let open = d.types.iter().filter_map(|s| c.tracker.open_at(s, now));
    for e in c.tracker.type_episodes.iter().filter(|e| e.device == name).cloned().chain(open).filter(|e| e.started_ms < r.to_ms && e.end_ms(now) >= r.from_ms) {
        eps.entry(e.log_type.clone()).or_default().push(e);
    }
    let gone: BTreeSet<Option<String>> = older.points.iter().filter(|(_, v)| v.iter().any(|p| in_range(p.t))).map(|(k, _)| k).chain(eps.keys())
        .filter(|k| !d.types.iter().any(|s| s.log_type == **k)).cloned().collect();
    let gone: Vec<DeviceState> = gone.into_iter().map(|k| DeviceState { no_type: k.is_none(), log_type: k, state: State::Silent, ..DeviceState::default() }).collect();
    let mut out: Vec<(State, f64, Value)> = vec![];
    for s in d.types.iter().chain(&gone) {
        let mine = eps.remove(&s.log_type).unwrap_or_default();
        let kept_from = s.recent.iter().next().map_or(i64::MAX, |p| p.t);
        let points: Vec<Point> = older.points.get(&s.log_type).into_iter().flatten().copied().filter(|p| p.t < kept_from).chain(s.recent.iter()).filter(|p| in_range(p.t)).collect();
        let all: Vec<Point> = older.points.get(&s.log_type).into_iter().flatten().copied().filter(|p| p.t < kept_from).chain(s.recent.iter()).collect();
        let spans = measured_spans(all.iter().copied(), c.tracker.stale_after(), i64::MIN, i64::MAX, now);
        let in_spans: Vec<(i64, i64, State)> = spans.iter().map(|(a, b, x)| ((*a).max(r.from_ms), (*b).min(r.to_ms), *x)).filter(|(a, b, _)| b > a).collect();
        let state = d.type_state(s);
        let delay = s.last_minutes.filter(|_| s.state.measured());
        let last = Tracker::last_measured(s).or_else(|| points.iter().rev().find(|p| p.m.is_some() && !p.s.cant_measure()).map(|p| p.t));
        let quiet_at = s.recent.iter().next_back().map(|p| p.t);
        let stale = match (s.state, state) {
            (State::Silent, x) => (x.is_none() || d.types_unread) && quiet_at.is_some(),
            (x, None) => x.measured(),
            (x, _) if d.types_unread => x.measured(),
            (x, _) => x.measured() && now - s.last_run_ms > c.tracker.stale_after(),
        };
        let arrival = s.last_arrival_ms.or(last);
        let text = match (s.state, arrival, last) {
            (State::Silent, ..) if stale => format!("no logs when last read {}, not read since", time::when(quiet_at.unwrap_or(now), now)),
            (State::Silent, Some(t), _) => format!("no logs since {}", time::when(t, now)),
            (State::Silent, None, _) => "no logs".into(),
            (x, _, Some(t)) if stale => format!("{} when last measured {}, not measured since", if x.late() { "late" } else { x.label() }, time::when(t, now)),
            (x, ..) => x.label().to_string(),
        };
        let rank = if stale { -1.0 } else { 0.0 };
        out.push((s.state, rank + if s.state.late() { delay.unwrap_or(0.0) } else { rank }, json!({
            "logType": s.type_name(), "noType": s.no_type, "state": s.state, "stateText": text,
            "delayMinutes": delay, "rawGap": s.last_raw_minutes.filter(|_| s.state.measured()), "eventField": s.event_field,
            "lastArrival": s.last_arrival_ms, "lastEvent": s.last_event_ms, "docs": s.docs,
            "episodes": mine.iter().map(|e| { let mut v = period_json(e, now); v["measuredMs"] = json!(late_in(e, &spans, now)); v }).collect::<Vec<_>>(),
            "points": points.iter().map(|p| json!({ "t": p.t, "m": p.m, "s": p.s })).collect::<Vec<_>>(),
            "lateMs": mine.iter().map(|e| late_in(e, &in_spans, now)).sum::<i64>(),
            "lastMeasuredMs": last, "stale": stale,
        })));
    }
    // Late ones first, the latest of them first; those with no logs last.
    let class = |s: State| if s.late() { 0 } else if s == State::Silent { 2 } else { 1 };
    out.sort_by(|a, b| class(a.0).cmp(&class(b.0)).then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)).then_with(|| a.2["logType"].as_str().cmp(&b.2["logType"].as_str())));
    out.into_iter().map(|(_, _, v)| v).collect()
}

/// `seriesWhy`: the device was never read by its log types.
pub const BEFORE_LOG_TYPES: &str = "before log types were measured";
/// The same: every run had read `measure::TYPES_PER_RUN` before it came to the device.
pub const PAST_LOG_TYPES: &str = "the cluster has more log types than a run reads";

/// One device (Device board), with its finding when there is one.
pub fn device(c: &ClusterInput, name: &str, r: &Range, now: i64, every_hours: u64, finding: Option<&Finding>, older: &OlderTypes) -> Option<Value> {
    let d = c.tracker.devices.get(name)?;
    let eps: Vec<Episode> = c.tracker.all_episodes(now).into_iter().filter(|e| e.device == name && e.started_ms < r.to_ms && e.end_ms(now) >= r.from_ms).collect();
    let row = row_of(c, name, d, &eps.iter().collect::<Vec<_>>(), c.tracker.types_unread(), r, now);
    let points: Vec<Value> = d.recent.iter().filter(|p| p.t >= r.from_ms && p.t < r.to_ms).map(|p| json!({ "t": p.t, "m": p.m, "s": p.s })).collect();
    let measured: Vec<(i64, f64)> = d.recent.iter().filter(|p| p.t >= r.from_ms && p.t < r.to_ms).filter(|p| !p.s.cant_measure()).filter_map(|p| p.m.map(|m| (p.t, m))).collect();
    let peak = measured.iter().cloned().fold(None, |best: Option<(i64, f64)>, (t, m)| match best { Some((_, b)) if b >= m => best, _ => Some((t, m)) });
    let average = (!measured.is_empty()).then(|| ((measured.iter().map(|(_, m)| m).sum::<f64>() / measured.len() as f64) * 10.0).round() / 10.0);
    let longest = eps.iter().max_by_key(|e| e.lasted_ms(now));
    let solved: Vec<&Episode> = eps.iter().filter(|e| e.solved_ms.is_some()).collect();
    let solve_avg = (!solved.is_empty()).then(|| solved.iter().map(|e| e.lasted_ms(now)).sum::<i64>() / solved.len() as i64);
    // Late most often: the window of the day most starts fall in.
    let mut by_slot: BTreeMap<u32, usize> = BTreeMap::new();
    let step_h = every_hours.clamp(1, 24) as u32;
    for e in &eps {
        use chrono::Timelike;
        let h = time::local_datetime(e.started_ms).hour();
        *by_slot.entry((h / step_h) * step_h).or_default() += 1;
    }
    let most = by_slot.iter().max_by_key(|(_, n)| **n).map(|(h, n)| json!({
        "label": format!("{h:02}:00–{:02}:00", (h + step_h * 2).min(24)), "count": n, "of": eps.len() }));
    let silences: Vec<Value> = c.tracker.silences.iter().chain(c.tracker.open_silences()).filter(|s| s.device == name && s.from_ms < r.to_ms && s.to_ms.unwrap_or(now) >= r.from_ms)
        .map(|s| json!({ "from": s.from_ms, "to": s.to_ms, "burstDocs": s.burst_docs, "burstMinutes": s.burst_minutes })).collect();
    // The percentage is of the time it was measured, and of nothing else.
    let spans = measured_spans(d.recent.iter(), c.tracker.stale_after(), r.from_ms, r.to_ms, now);
    let measured_ms: i64 = spans.iter().map(|(a, b, _)| b - a).sum();
    let late_measured: i64 = eps.iter().map(|e| late_in(e, &spans, now)).sum();
    // A period is as long as from its start to its end; how much of that was measured is said beside it.
    let all_spans = measured_spans(d.recent.iter(), c.tracker.stale_after(), i64::MIN, i64::MAX, now);
    let mut v = json!({
        "device": name, "cluster": c.id, "clusterName": c.name, "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string(),
        "label": r.label(), "now": now, "everyHours": every_hours, "levels": c.levels,
        "state": d.state, "nowMinutes": row.now_minutes, "lateSince": row.late_since, "silentSince": row.silent_since,
        "medianMinutes": row.median_minutes, "worst": peak.map(|(t, m)| json!({ "minutes": m, "at": t })),
        "episodes": eps.len(), "solved": solved.len(), "lateMs": row.late_ms,
        "latePct": (measured_ms > 0).then(|| ((late_measured as f64 / measured_ms as f64) * 1000.0).round() / 10.0),
        "docsPerDay": row.docs_per_day, "lastSilence": silences.last().and_then(|s| s.get("from").cloned()),
        "extras": d.extras, "lastArrival": d.last_arrival_ms, "lastEvent": d.last_event_ms, "firstSeen": d.first_seen_ms,
        "points": points,
        "periods": eps.iter().map(|e| {
            let mut v = period_json(e, now);
            v["beforeLogTypes"] = json!(d.types_since_ms.is_some_and(|t| e.started_ms < t));
            v["measuredMs"] = json!(late_in(e, &all_spans, now));
            v["spans"] = json!(spans.iter().map(|(a, b, _)| ((*a).max(e.started_ms), (*b).min(e.end_ms(now)))).filter(|(a, b)| b > a).map(|(a, b)| json!([a, b])).collect::<Vec<_>>());
            v
        }).collect::<Vec<_>>(),
        "silences": silences,
        "insights": {
            "peak": peak.map(|(t, m)| json!({ "minutes": m, "at": t })),
            "average": average.map(|a| json!({ "minutes": a, "measurements": measured.len() })),
            "longest": longest.map(|e| json!({ "lastedMs": e.lasted_ms(now), "started": e.started_ms, "solved": e.solved_ms, "ended": e.ended_ms, "endedWhy": e.ended_why, "measuredMs": late_in(e, &all_spans, now) })),
            "solvedIn": solve_avg.map(|ms| json!({ "averageMs": ms, "solved": solved.len() })),
            "lateMostOften": most,
        },
        "finding": finding,
    });
    // Beside the rest (one json! of this size is at the macro's recursion limit).
    v["zone"] = json!(row.zone);
    v["tag1"] = json!(row.tag1);
    v["inLastRun"] = json!(row.in_last_run);
    v["lastMeasuredMs"] = json!(row.last_measured_ms);
    v["measuredUntilMs"] = json!(row.measured_until_ms);
    v["stale"] = json!(row.stale);
    v["stateText"] = json!(row.state_text);
    v["staleAfterMs"] = json!(c.tracker.stale_after());
    v["types"] = json!(row.types);
    v["typesUnread"] = json!(row.types_unread);
    v["partLateMs"] = json!(row.part_late_ms);
    v["delayLogType"] = json!(row.delay_log_type);
    let (field, why) = c.log_type_field();
    v["logTypeField"] = json!(field);
    v["logTypeWhy"] = json!(why);
    let series = series(c, name, d, older, r, now);
    v["seriesWhy"] = json!(series.is_empty().then(|| why.unwrap_or(if d.types_unread { PAST_LOG_TYPES } else { BEFORE_LOG_TYPES })));
    v["series"] = json!(series);
    v["typesSinceMs"] = json!(d.types_since_ms);
    // Points older than the tracker keeps were read from here on only (`null`: all of them).
    v["seriesFromMs"] = json!(older.from_ms);
    v["seriesPeriodsFromMs"] = json!(c.tracker.type_episodes_cut_ms);
    v["typeDays"] = json!(TYPE_RECENT_MS / 86_400_000);
    v["measuredMs"] = json!(measured_ms);
    v["lateMeasuredMs"] = json!(late_measured);
    v["docsCounted"] = json!(row.docs_counted);
    v["docsCountedHours"] = json!(row.docs_counted_hours);
    v["eventField"] = json!(row.event_field);
    v["ownZone"] = json!(row.own_zone);
    v["notMeasured"] = json!(c.tracker.not_measured(now));
    v["timeZone"] = c.time_zone(now);
    v["rawGapMinutes"] = json!(row.raw_gap_minutes);
    v["tzOffsetMinutes"] = json!(row.tz_offset_minutes);
    v["deviceTzOffset"] = json!(row.device_tz_offset);
    v["clusterTzOffset"] = json!(row.cluster_tz_offset);
    Some(v)
}

/// One delay period, as the device's page lists it.
fn period_json(e: &Episode, now: i64) -> Value {
    json!({
        "started": e.started_ms, "solved": e.solved_ms, "ended": e.ended_ms, "lastedMs": e.lasted_ms(now), "worstMinutes": e.worst_minutes, "worstState": e.worst_state,
        "lastMinutes": e.last_minutes, "lastState": e.last_state, "measurements": e.measurements, "pattern": e.pattern(), "extras": e.extras,
        "endedWhy": e.ended_why, "lastMeasuredMs": e.last_measured_ms, "measuredUntilMs": e.measured_until_ms, "stale": e.stale(),
    })
}

/// A device's state in words, never "now" for one nobody has measured since.
pub fn state_text(r: &DeviceRow, now: i64) -> String {
    let text = state_as_read(r, now);
    match r.types_unread.filter(|_| r.state != State::Silent) {
        Some(n) => format!("{text}; log types not read in this run ({n} device{} over the limit)", if n == 1 { "" } else { "s" }),
        None => text,
    }
}

fn state_as_read(r: &DeviceRow, now: i64) -> String {
    match r.last_measured_ms.filter(|_| r.stale || r.measured_until_ms.is_some()) {
        Some(t) if r.state != State::Silent => format!("{} when last measured {}, not measured since", if r.state.late() { "late" } else { r.state.label() }, time::when(t, now)),
        Some(t) if r.late_since.is_some() => format!("silent; late when last measured {}", time::when(t, now)),
        _ => match r.types.as_ref().filter(|_| r.state == State::PartDelay) {
            Some(t) => format!("{} — {}", r.state.label(), t.text()),
            None => r.state.label().to_string(),
        },
    }
}

/// `*` and `?` wildcards, case-insensitive, whole value.
pub fn wildcard(pattern: &str) -> Option<regex::Regex> {
    let p = pattern.trim();
    if p.is_empty() || p.len() > 200 {
        return None;
    }
    let mut re = String::from("(?i)^");
    for ch in p.chars() {
        match ch {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

/// The device search: a name (contains), or a column's value (wildcard), across clusters.
pub fn search(clusters: &[ClusterInput], r: &Range, now: i64, name: Option<&str>, field: Option<(&str, &str)>, max: usize) -> Value {
    let name_lc = name.map(|n| n.trim().to_ascii_lowercase()).filter(|n| !n.is_empty());
    let value_re = field.and_then(|(_, v)| wildcard(v));
    let mut rows: Vec<DeviceRow> = vec![];
    let mut clusters_hit: BTreeSet<String> = BTreeSet::new();
    for c in clusters {
        for row in device_rows(c, r, now) {
            let by_name = name_lc.as_ref().is_none_or(|n| row.device.to_ascii_lowercase().contains(n.as_str()));
            let by_field = match (field, &value_re) {
                (Some((f, _)), Some(re)) => {
                    // The device field itself, or an extra column of that name.
                    // `log_type`: any of its log types.
                    (f == "device" || f.starts_with("src_")) && re.is_match(&row.device) || row.extras.get(f).is_some_and(|v| re.is_match(v))
                        || f == LOG_TYPE_FIELD && c.tracker.devices.get(&row.device).is_some_and(|d| d.types.iter().any(|s| re.is_match(s.type_name())))
                }
                (Some(_), None) => false,
                (None, _) => true,
            };
            if by_name && by_field {
                clusters_hit.insert(c.id.clone());
                rows.push(row);
            }
        }
    }
    let total = rows.len();
    rows.truncate(max);
    json!({ "matches": total, "truncated": total > max, "clusters": clusters_hit, "devices": rows,
            "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logdelay::measure::Reading;

    const H: i64 = 3_600_000;

    fn reading(device: &str, m: Option<f64>, run: i64, zone: &str) -> Reading {
        let mut extras = BTreeMap::new();
        extras.insert("Zone".into(), zone.into());
        Reading { device: device.into(), docs: 100, arrival_ms: Some(run), event_ms: m.map(|x| run - (x * 60_000.0) as i64), delay_minutes: m, extras, ..Reading::default() }
    }

    fn cluster_input(now: i64) -> ClusterInput {
        let mut t = Tracker::default();
        let l = Levels::default();
        t.apply(now - 6 * H, vec![reading("fw-1", Some(5.0), now - 6 * H, "dc1"), reading("fw-2", Some(1.0), now - 6 * H, "dc2")], &l, 2 * H);
        t.apply(now - 4 * H, vec![reading("fw-1", Some(45.0), now - 4 * H, "dc1"), reading("fw-2", Some(1.0), now - 4 * H, "dc2")], &l, 2 * H);
        t.apply(now - 2 * H, vec![reading("fw-1", Some(94.0), now - 2 * H, "dc1"), reading("fw-2", Some(2.0), now - 2 * H, "dc2")], &l, 2 * H);
        t.apply(now, vec![reading("fw-1", Some(94.0), now, "dc1"), reading("fw-2", Some(2.0), now, "dc2")], &l, 2 * H);
        let mut daily = BTreeMap::new();
        let today = time::local_day_key(now);
        daily.insert(today.clone(), super::super::state::daily(&t, &today, time::day_bounds(time::local_date(now)).0, time::day_bounds(time::local_date(now)).1, now));
        ClusterInput { id: "prod".into(), name: "Production".into(), tracker: Arc::new(t), daily, levels: l, zone: LogTimeZone::Detect, tz_hints: vec![] }
    }

    #[test]
    fn a_forgotten_device_stops_counting_as_late_in_windows_and_totals() {
        let now = chrono::Utc::now().timestamp_millis();
        let (t0, _) = time::day_bounds(time::local_date(now));
        // Begun at 00:30 today, open, then forgotten at 05:00 today (its last arrival a week before).
        let mut t = Tracker::default();
        let l = Levels::default();
        let a_week_ago = t0 + 30 * 60_000 - crate::logdelay::state::FORGET_MS;
        t.apply(a_week_ago, vec![reading("gone", Some(50.0), a_week_ago, "dc1")], &l, 2 * H);
        t.apply(t0 + 5 * H, vec![reading("ok", Some(1.0), t0 + 5 * H, "dc1")], &l, 2 * H);
        assert!(!t.devices.contains_key("gone") && t.episodes[0].ended_ms == Some(t0 + 5 * H));
        let c = ClusterInput { id: "p".into(), name: "P".into(), tracker: Arc::new(t), daily: BTreeMap::new(), levels: l, zone: LogTimeZone::Detect, tz_hints: vec![] };
        let ws = windows(&[c.tracker.as_ref()], time::local_date(now), 2, (t0 + 7 * H).max(now));
        let late_now = ws.iter().filter(|w| w["from"].as_i64().unwrap() >= t0 + 6 * H).map(|w| w["stillLate"].as_u64().unwrap()).sum::<u64>();
        assert_eq!(late_now, 0, "after it ended, no window counts it as still late");
        // Each window splits the devices by their last stored state at its end: the forgotten device is in none.
        assert!(ws.iter().all(|w| w["delay"].is_u64() && w["critical"].is_u64()), "{ws:?}");
        assert_eq!(ws.iter().filter(|w| w["from"].as_i64().unwrap() >= t0 + 6 * H).map(|w| w["delay"].as_u64().unwrap() + w["critical"].as_u64().unwrap()).sum::<u64>(), 0);
        let d = crate::logdelay::state::daily(&c.tracker, "today", t0, t0 + 86_400_000, t0 + 20 * H);
        assert_eq!(d.late_hours, 0.0, "measured late once, a week ago: nothing was measured today (it used to count until it was forgotten)");
        assert_eq!(device_rows(&c, &Range::last_days(now, 30), now).iter().filter(|r| r.device == "gone").count(), 0);
    }

    #[test]
    fn the_fleet_summary_counts_devices_once_and_percentages_add_up() {
        let now = chrono::Utc::now().timestamp_millis();
        let c = cluster_input(now);
        let r = Range::last_days(now, 30);
        let f = fleet(&[c], &r, now, 2, 100);
        assert_eq!(f["totals"]["devices"], 2);
        assert_eq!(f["totals"]["critical"], 1);
        assert_eq!(f["totals"]["onTime"], 1);
        assert_eq!(f["totals"]["pctLate"], 50.0);
        assert_eq!(f["byCluster"][0]["lateNow"], 1);
        assert_eq!(f["byCluster"][0]["worst"]["device"], "fw-1");
        assert_eq!(f["devices"][0]["device"], "fw-1", "sorted by time late");
        assert_eq!(f["devices"][0]["lateMs"], 4 * H);
        assert_eq!(f["devices"][0]["episodes"], 1);
        assert_eq!(f["reduced"][0]["hours"], 2);
        assert_eq!(f["byCluster"][0]["timeZone"]["mode"], "none", "two devices, one at UTC: 50 % is not a majority");
        assert_eq!(f["byCluster"][0]["otherTz"], 0);
        assert_eq!(f["devices"][0]["rawGapMinutes"], 94.0, "nothing taken out: raw gap = delay");
        assert_eq!(f["devices"][0]["tzOffsetMinutes"], Value::Null);
        assert!(!f["days"].as_array().unwrap().is_empty(), "{}", f["days"]);
        assert_eq!(f["windows"].as_array().unwrap().iter().map(|w| w["stillLate"].as_u64().unwrap()).max(), Some(1));
    }

    #[test]
    fn no_delay_is_on_time_silent_and_cant_measure_and_the_shares_add_up() {
        // 100 devices: 89 on time, 5 delayed, 6 silent.
        let mut t = Totals::default();
        (0..89).for_each(|_| t.add(State::NoDelay));
        (0..3).for_each(|_| t.add(State::Delay));
        (0..2).for_each(|_| t.add(State::Critical));
        (0..6).for_each(|_| t.add(State::Silent));
        let v = t.json();
        assert_eq!((v["noDelay"].clone(), v["onTime"].clone(), v["silent"].clone(), v["late"].clone()), (json!(95), json!(89), json!(6), json!(5)));
        assert_eq!((v["pctNoDelay"].clone(), v["pctLate"].clone()), (json!(95.0), json!(5.0)));
        assert_eq!(v["noDelayText"], "No delay 95 % (on time 89 % · silent 6 % · can't measure 0 %)");
        // A clock ahead can't be measured; a silent device that was late is said.
        let mut u = Totals::default();
        u.add(State::ClockAhead);
        u.add(State::Unmeasured);
        u.add(State::OtherTz);
        let late = DeviceState { state: State::Silent, open: Some(Episode {
            device: "d".into(), worst_minutes: 45.0, worst_state: State::Delay, last_minutes: 45.0, last_state: State::Delay, measurements: 1, ..Episode::default() }), ..DeviceState::default() };
        u.add_device(&late);
        let v = u.json();
        assert_eq!((v["onTime"].clone(), v["noDelay"].clone(), v["cantMeasure"].clone(), v["unmeasured"].clone(), v["otherTz"].clone(), v["measured"].clone()),
                   (json!(0), json!(3), json!(2), json!(1), json!(1), json!(1)));
        assert_eq!(v["noDelayText"], "No delay 75 % (on time 0 % · silent 25 % · can't measure 50 %; 1 of the silent was late before it went silent)");
        // Thirds: 33.4 + 33.3 + 33.3, never 99.9 or 100.1.
        for parts in [vec![1u64, 1, 1], vec![2, 1, 0, 4], vec![7, 11, 13, 17, 19, 23, 1], vec![1, 999_999]] {
            assert_eq!(tenths(&parts).unwrap().iter().sum::<u64>(), 1000, "{parts:?}");
        }
        assert_eq!(tenths(&[0, 0]), None);
        assert_eq!(tenths(&[4_999, 0, 1]).unwrap(), [999, 0, 1], "one late of 5,000: never 100 % and 0 %");
        assert_eq!(tenths(&[5_000, 5_000, 1]).unwrap(), [499, 500, 1], "taken from the first of the largest, as the pages do");
        assert_eq!(Totals::default().json()["pctNoDelay"], Value::Null, "no device: no percentage");
    }

    #[test]
    fn a_cluster_never_measured_or_whose_last_run_failed_has_no_percentage() {
        let now = chrono::Utc::now().timestamp_millis();
        let r = Range::last_days(now, 7);
        let good = cluster_input(now);
        let mut failed = cluster_input(now);
        failed.id = "bad".into();
        let mut t = (*failed.tracker).clone();
        t.last_failed = Some(crate::logdelay::state::FailedRun { at: now + 1, error: "connection refused".into() });
        failed.tracker = Arc::new(t);
        let never = ClusterInput { id: "new".into(), name: "New".into(), tracker: Arc::new(Tracker::default()), daily: BTreeMap::new(), levels: Levels::default(),
                                   zone: LogTimeZone::Detect, tz_hints: vec![] };
        let f = fleet(&[good, failed, never], &r, now, 2, 100);
        let of = |id: &str| f["byCluster"].as_array().unwrap().iter().find(|c| c["id"] == id).cloned().unwrap();
        assert_eq!((of("prod")["pctNoDelay"].clone(), of("prod")["notMeasured"].clone()), (json!(50.0), Value::Null));
        assert_eq!((of("bad")["pctNoDelay"].clone(), of("bad")["belowPct"].clone(), of("bad")["latePct"].clone()), (Value::Null, Value::Null, Value::Null));
        assert!(of("bad")["notMeasured"].as_str().unwrap().contains("connection refused") && of("bad")["notMeasured"].as_str().unwrap().contains("last measured"));
        assert_eq!((of("new")["pctNoDelay"].clone(), of("new")["notMeasured"].clone()), (Value::Null, json!("never measured")));
        assert_eq!(f["totals"]["pctOf"], json!({ "clusters": 1, "ofClusters": 3, "devices": 2, "ofDevices": 4 }));
        assert_eq!(f["totals"]["pctLate"], 50.0);
    }

    #[test]
    fn a_device_not_measured_since_is_late_when_last_measured_never_still_late() {
        let now = chrono::Utc::now().timestamp_millis();
        let l = Levels::default();
        // Measured once, 95 min late, eight hours ago; nothing since (no schedule covers it).
        let at = now - 8 * H;
        let mut t = Tracker { interval_ms: Some(2 * H), ..Tracker::default() };
        t.apply(at, vec![reading("fw-1", Some(95.0), at, "dc1")], &l, 24 * H);
        let c = ClusterInput { id: "prod".into(), name: "P".into(), tracker: Arc::new(t), daily: BTreeMap::new(), levels: l, zone: LogTimeZone::Detect, tz_hints: vec![] };
        let r = Range::last_days(now, 7);
        let d = device(&c, "fw-1", &r, now, 2, None, &OlderTypes::default()).unwrap();
        assert_eq!((d["lateMs"].clone(), d["latePct"].clone(), d["measuredMs"].clone()), (json!(0), Value::Null, json!(0)), "one measurement is no stretch of time");
        assert_eq!((d["stale"].clone(), d["lastMeasuredMs"].clone(), d["measuredUntilMs"].clone()), (json!(true), json!(at), json!(at)));
        assert!(d["stateText"].as_str().unwrap().starts_with("late when last measured ") && d["stateText"].as_str().unwrap().ends_with("not measured since"), "{}", d["stateText"]);
        assert_eq!((d["periods"][0]["stale"].clone(), d["periods"][0]["lastedMs"].clone()), (json!(true), json!(0)));
        assert_eq!((d["docsPerDay"].clone(), d["docsCounted"].clone(), d["docsCountedHours"].clone()), (Value::Null, json!(100), json!(2.0)), "two hours of logs are not a day's");
        // Measured again and again: late 4 of the 6 hours measured.
        let c = cluster_input(now);
        let d = device(&c, "fw-1", &r, now, 2, None, &OlderTypes::default()).unwrap();
        assert_eq!((d["stale"].clone(), d["measuredMs"].clone(), d["lateMeasuredMs"].clone(), d["latePct"].clone()), (json!(false), json!(6 * H), json!(4 * H), json!(66.7)));
    }

    #[test]
    fn a_window_without_a_measurement_is_not_measured_never_a_copy_of_an_earlier_one() {
        let now = chrono::Utc::now().timestamp_millis();
        let (t0, _) = time::day_bounds(time::local_date(now));
        let at = (t0 + 23 * H).max(now);
        let l = Levels::default();
        let mut t = Tracker::default();
        // Measured at 01:00 (one late, one critical) and 05:00 (only the critical one late); nothing at 02:00–04:00.
        t.apply(t0 + H, vec![reading("a", Some(45.0), t0 + H, "z"), reading("b", Some(90.0), t0 + H, "z"), reading("c", Some(1.0), t0 + H, "z")], &l, 2 * H);
        t.apply(t0 + 5 * H, vec![reading("a", Some(2.0), t0 + 5 * H, "z"), reading("b", Some(95.0), t0 + 5 * H, "z"), reading("c", Some(1.0), t0 + 5 * H, "z")], &l, 2 * H);
        let ws = windows(&[&t], time::local_date(at), 2, at);
        assert_eq!((ws[0]["measured"].clone(), ws[0]["lateAt"].clone(), ws[0]["criticalAt"].clone()), (json!(true), json!(2), json!(1)));
        assert_eq!((ws[1]["measured"].clone(), ws[1]["lateAt"].clone()), (json!(false), Value::Null), "02:00–04:00: not measured, not 2 again");
        assert_eq!(ws[1]["stillLate"], 2, "the episode count still carries, as before");
        assert_eq!((ws[2]["measured"].clone(), ws[2]["lateAt"].clone(), ws[2]["criticalAt"].clone()), (json!(true), json!(1), json!(1)));
        assert_eq!(measured_late(&[&t], t0 + 2 * H, t0 + 4 * H), None);
        // A run that found no logs from any device measured no delay: not "0 late".
        let mut quiet = t.clone();
        quiet.apply(t0 + 9 * H, vec![], &l, 2 * H);
        assert!(quiet.devices.values().all(|d| d.state == State::Silent));
        assert_eq!(measured_late(&[&quiet], t0 + 8 * H, t0 + 10 * H), None);
        assert_eq!(same_window_yesterday(&t, 2).map(|y| y["measured"].clone()), Some(json!(false)), "nothing kept from yesterday");
        assert_eq!(same_window_yesterday(&Tracker::default(), 2), None, "never run: unknown");
    }

    #[test]
    fn a_device_view_has_its_periods_and_insights_and_a_missing_device_is_none() {
        let now = chrono::Utc::now().timestamp_millis();
        let c = cluster_input(now);
        let r = Range::last_days(now, 30);
        let d = device(&c, "fw-1", &r, now, 2, None, &OlderTypes::default()).unwrap();
        assert_eq!(d["state"], "critical");
        assert_eq!(d["nowMinutes"], 94.0);
        assert_eq!(d["periods"].as_array().unwrap().len(), 1);
        assert_eq!(d["periods"][0]["worstMinutes"], 94.0);
        assert_eq!(d["insights"]["peak"]["minutes"], 94.0);
        assert_eq!(d["insights"]["solvedIn"], Value::Null, "nothing solved: unknown, not 0");
        assert_eq!(d["insights"]["average"]["measurements"], 4);
        assert_eq!(d["points"].as_array().unwrap().len(), 4);
        assert_eq!(d["lateSince"], now - 4 * H);
        assert!(device(&c, "nope", &r, now, 2, None, &OlderTypes::default()).is_none());
    }

    #[test]
    fn the_search_takes_a_name_or_a_column_with_wildcards() {
        let now = chrono::Utc::now().timestamp_millis();
        let c = cluster_input(now);
        let r = Range::last_days(now, 30);
        assert_eq!(search(&[c], &r, now, Some("FW-"), None, 10)["matches"], 2);
        let c = cluster_input(now);
        let s = search(&[c], &r, now, None, Some(("Zone", "dc?")), 10);
        assert_eq!(s["matches"], 2);
        let c = cluster_input(now);
        assert_eq!(search(&[c], &r, now, None, Some(("src_hostname", "fw-1*")), 10)["matches"], 1);
        let c = cluster_input(now);
        assert_eq!(search(&[c], &r, now, Some("fw-2"), Some(("Zone", "dc1")), 10)["matches"], 0, "both filters apply");
        assert!(wildcard("").is_none());
    }

    #[test]
    fn a_range_knows_the_one_before_it() {
        let r = Range::days(NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(), NaiveDate::from_ymd_opt(2026, 11, 7).unwrap());
        let p = r.previous();
        assert_eq!((p.from, p.to), (NaiveDate::from_ymd_opt(2026, 10, 25).unwrap(), NaiveDate::from_ymd_opt(2026, 10, 31).unwrap()));
        assert_eq!(r.day_keys().len(), 7);
    }

    use crate::logdelay::measure::{LogTypeField, TypeReading};

    fn typed(device: &str, run: i64, types: &[(&str, f64)]) -> Reading {
        let one = |(n, m): &(&str, f64)| TypeReading { log_type: (!n.is_empty()).then(|| n.to_string()), docs: 10, arrival_ms: Some(run), event_ms: Some(run - (*m * 60_000.0) as i64),
                                                       delay_minutes: Some(*m), event_field: Some("event_created".into()) };
        Reading { types: Some(types.iter().map(one).collect()), ..reading(device, Some(types[0].1), run, "dc1") }
    }

    /// Four runs two hours apart, the last at `now`: `one` part delayed at the last two, `all` late
    /// with both its types, `ok` on time, `quiet` without its second type now.
    fn typed_input(now: i64) -> ClusterInput {
        let l = Levels::default();
        let mut t = Tracker { interval_ms: Some(2 * H), ..Tracker::default() };
        for k in (0..4).rev() {
            let at = now - k * 2 * H;
            let late = if k < 2 { 46.0 } else { 1.0 };
            let mut quiet = vec![("a", 1.0)];
            if k == 3 { quiet.push(("b", 1.0)); }
            t.apply(at, vec![typed("one", at, &[("traffic", 2.0), ("threat", late), ("(no log type)", 1.0), ("", 3.0)]), typed("all", at, &[("a", 45.0), ("b", 95.0)]),
                             typed("ok", at, &[("traffic", 1.0), ("system", 1.0)]), typed("quiet", at, &quiet)], &l, 2 * H);
        }
        t.last_read = Some(crate::logdelay::collect::RunInfo { at: now, devices: 4, complete: true, log_type: Some(LogTypeField { field: Some("log_type".into()), why: None }), ..Default::default() });
        let mut daily = BTreeMap::new();
        let key = time::local_day_key(now);
        let (a, b) = time::day_bounds(time::local_date(now));
        daily.insert(key.clone(), super::super::state::daily(&t, &key, a, b, now));
        ClusterInput { id: "prod".into(), name: "Production".into(), tracker: Arc::new(t), daily, levels: l, zone: LogTimeZone::Utc, tz_hints: vec![] }
    }

    #[test]
    fn part_delayed_is_its_own_class_and_the_percentages_still_add_up() {
        let mut t = Totals::default();
        (0..7).for_each(|_| t.add(State::NoDelay));
        (0..3).for_each(|_| t.add(State::PartDelay));
        t.add(State::Delay);
        t.add(State::OtherTz);
        t.add(State::Silent);
        let v = t.json();
        assert_eq!((v["devices"].clone(), v["noDelay"].clone(), v["late"].clone(), v["partDelayed"].clone(), v["onTime"].clone(), v["measured"].clone()),
                   (json!(13), json!(8), json!(1), json!(3), json!(7), json!(12)));
        let tenths: i64 = ["pctNoDelay", "pctPartDelayed", "pctLate", "pctOtherTz"].iter().map(|k| (v[*k].as_f64().unwrap() * 10.0).round() as i64).sum();
        assert_eq!(tenths, 1000, "{v}");
        assert_eq!(v["logTypes"], Value::Null, "not read by log types: not 0 of 0");
        let d = Daily { devices: 13, on_time: 7, part_delayed: 3, delayed: 1, other_tz: 1, silent: 1, ..Daily::default() };
        let t = Totals::of_day(&d);
        assert_eq!((t.no_delay, t.late(), t.part_delayed), (8, 1, 3));
        assert_eq!(Totals::default().shares()["pctPartDelayed"], Value::Null);
    }

    #[test]
    fn devices_whose_log_types_were_not_read_keep_their_class_and_are_counted_and_said() {
        let now = chrono::Utc::now().timestamp_millis();
        let r = Range::last_days(now, 7);
        let (read, at) = (now - 2 * H, now);
        let mut c = typed_input(read);
        let before = totals(&c);
        let past = |n: &str| Reading { types: None, types_truncated: true, ..typed(n, at, &[("traffic", 1.0)]) };
        Arc::make_mut(&mut c.tracker).apply(at, vec![past("one"), past("all"), typed("ok", at, &[("traffic", 1.0), ("system", 1.0)]), past("new")], &c.levels, 24 * H);
        let t = totals(&c);
        assert_eq!((t.types_unread, t.part_delayed, t.late(), t.no_delay, t.devices), (3, before.part_delayed, before.late(), before.no_delay + 1, before.devices + 1));
        assert_eq!((t.log_types.unwrap().late, t.json()["typesUnread"].clone()), (before.log_types.unwrap().late, json!(3)));
        let f = fleet(&[c], &r, at, 2, 100);
        assert_eq!((f["totals"]["typesUnread"].clone(), f["byCluster"][0]["typesUnread"].clone()), (json!(3), json!(3)));
        let row = |n: &str| f["devices"].as_array().unwrap().iter().find(|d| d["device"] == n).cloned().unwrap();
        let one = row("one");
        assert_eq!((one["state"].clone(), one["stale"].clone(), one["typesUnread"].clone(), one["types"]["late"].clone(), one["types"]["truncated"].clone(), one["nowMinutes"].clone()),
                   (json!("part_delay"), json!(true), json!(3), json!(1), json!(true), json!(46.0)));
        let text = one["stateText"].as_str().unwrap();
        assert!(text.starts_with("part delayed when last measured") && text.ends_with("; log types not read in this run (3 devices over the limit)"), "{text}");
        assert_eq!((row("new")["stateText"].clone(), row("new")["stale"].clone()), (json!("on time; log types not read in this run (3 devices over the limit)"), json!(false)));
        assert_eq!((row("ok")["typesUnread"].clone(), row("ok")["stateText"].clone()), (Value::Null, json!("on time")));
        let mut c = typed_input(read);
        Arc::make_mut(&mut c.tracker).apply(at, vec![past("one"), past("new")], &c.levels, 24 * H);
        let d = device(&c, "one", &r, at, 2, None, &OlderTypes::default()).unwrap();
        assert!(d["series"].as_array().unwrap().iter().all(|s| s["stale"] == json!(true) && s["lastMeasuredMs"] == json!(read)), "{}", d["series"]);
        let d = device(&c, "new", &r, at, 2, None, &OlderTypes::default()).unwrap();
        assert_eq!((d["series"].clone(), d["seriesWhy"].clone()), (json!([]), json!(PAST_LOG_TYPES)));
    }

    #[test]
    fn the_answers_carry_the_log_types_of_the_contract() {
        let now = chrono::Utc::now().timestamp_millis();
        let r = Range::last_days(now, 7);
        let f = fleet(&[typed_input(now)], &r, now, 2, 100);
        let t = &f["totals"];
        assert_eq!((t["devices"].clone(), t["partDelayed"].clone(), t["late"].clone(), t["noDelay"].clone()), (json!(4), json!(1), json!(1), json!(2)), "{t}");
        assert_eq!(t["logTypes"], json!({ "total": 10, "late": 3, "above": 1 }));
        let bc = &f["byCluster"][0];
        assert_eq!((bc["logTypeField"].clone(), bc["logTypeWhy"].clone(), bc["partDelayed"].clone(), bc["pctPartDelayed"].clone()), (json!("log_type"), Value::Null, json!(1), json!(25.0)));
        assert_eq!(bc["worst"]["logType"], json!("b"));
        let row = |n: &str| f["devices"].as_array().unwrap().iter().find(|d| d["device"] == n).cloned().unwrap();
        let one = row("one");
        assert_eq!((one["state"].clone(), one["nowMinutes"].clone(), one["delayLogType"].clone()), (json!("part_delay"), json!(46.0), json!("threat")));
        assert_eq!(one["types"], json!({ "total": 4, "measured": 4, "late": 1, "lateNames": ["threat"], "truncated": false }));
        assert_eq!(one["stateText"], "part delayed — 1 of 4 log types late: threat");
        assert_eq!((one["partLateMs"].clone(), one["lateMs"].clone()), (json!(2 * H), json!(0)), "apart from the time late");
        assert_eq!((row("all")["types"]["lateNames"].clone(), row("all")["state"].clone(), row("all")["partLateMs"].clone()), (json!(["b", "a"]), json!("critical"), json!(0)));
        let today = f["days"].as_array().unwrap().last().unwrap();
        assert!(today["partDelayed"].as_u64().unwrap() == 1 && today["logTypes"]["late"] == json!(3) && today["pctPartDelayed"] == json!(25.0), "{today}");
        // Worst first; the documents without a type apart from a real value of that text.
        let by = f["byLogType"].as_array().unwrap();
        assert_eq!(by[0], json!({ "logType": "b", "noType": false, "devices": 2, "late": 1, "above": 1, "silent": 1, "worstMinutes": 95.0 }));
        assert_eq!(by.iter().filter(|x| x["logType"] == "(no log type)").map(|x| x["noType"].clone()).collect::<Vec<_>>().len(), 2);
        assert_eq!(by.iter().map(|x| x["devices"].as_u64().unwrap()).sum::<u64>(), 10);
        let c = cluster(&typed_input(now), &r, now, 2, &Value::Null);
        assert_eq!((c["logTypeField"].clone(), c["byLogType"].clone(), c["totals"]["partDelayed"].clone()), (json!("log_type"), f["byLogType"].clone(), json!(1)));
        let w = windows(&[typed_input(now).tracker.as_ref()], time::local_date(now), 24, now);
        assert_eq!((w[0]["partAt"].clone(), w[0]["lateAt"].clone(), w[0]["partDelayed"].clone()), (json!(1), json!(1), json!(1)));
        let hit = |v: &str| search(&[typed_input(now)], &r, now, None, Some(("log_type", v)), 10)["matches"].clone();
        assert_eq!((hit("thr*"), hit("traffic"), hit("nope")), (json!(1), json!(2), json!(0)));
    }

    #[test]
    fn a_cluster_without_the_field_says_why_and_has_no_types() {
        let now = chrono::Utc::now().timestamp_millis();
        let r = Range::last_days(now, 7);
        let mut c = cluster_input(now);
        let f = fleet(&[cluster_input(now)], &r, now, 2, 100);
        assert_eq!((f["byCluster"][0]["logTypeField"].clone(), f["byCluster"][0]["logTypeWhy"].clone()), (Value::Null, json!("mapping not read")), "no run said");
        let mut t = (*c.tracker).clone();
        t.last_read = Some(crate::logdelay::collect::RunInfo { log_type: Some(LogTypeField { field: None, why: Some("log_type is not in the mapping".into()) }), ..Default::default() });
        c.tracker = Arc::new(t);
        let d = device(&c, "fw-1", &r, now, 2, None, &OlderTypes::default()).unwrap();
        assert_eq!((d["series"].clone(), d["seriesWhy"].clone(), d["types"].clone(), d["logTypeWhy"].clone()),
                   (json!([]), json!("log_type is not in the mapping"), Value::Null, json!("log_type is not in the mapping")));
        let v = cluster(&c, &r, now, 2, &Value::Null);
        assert_eq!((v["totals"]["logTypes"].clone(), v["byLogType"].clone(), v["totals"]["partDelayed"].clone()), (Value::Null, json!([]), json!(0)));
        assert_eq!(v["devices"][0]["types"], Value::Null);
        // The field on, the device not read since.
        let mut t = (*c.tracker).clone();
        t.last_read.as_mut().unwrap().log_type = Some(LogTypeField { field: Some("log_type".into()), why: None });
        c.tracker = Arc::new(t);
        let d = device(&c, "fw-1", &r, now, 2, None, &OlderTypes::default()).unwrap();
        assert_eq!((d["seriesWhy"].clone(), d["types"].clone(), d["periods"][0]["beforeLogTypes"].clone()), (json!("before log types were measured"), Value::Null, json!(false)));
    }

    #[test]
    fn a_device_has_one_series_a_log_type_the_worst_first() {
        let now = chrono::Utc::now().timestamp_millis();
        let r = Range::last_days(now, 30);
        let c = typed_input(now);
        let d = device(&c, "one", &r, now, 2, None, &OlderTypes::default()).unwrap();
        let s = d["series"].as_array().unwrap();
        assert_eq!((s.len(), s[0]["logType"].clone(), s[0]["delayMinutes"].clone(), s[0]["rawGap"].clone(), s[0]["state"].clone()), (4, json!("threat"), json!(46.0), json!(46.0), json!("delay")));
        assert_eq!((s[0]["points"].as_array().unwrap().len(), s[0]["episodes"][0]["solved"].clone(), s[0]["lateMs"].clone(), s[0]["eventField"].clone(), s[0]["stale"].clone()),
                   (4, Value::Null, json!(2 * H), json!("event_created"), json!(false)));
        assert_eq!((d["episodes"].clone(), d["seriesWhy"].clone(), d["partLateMs"].clone()), (json!(0), Value::Null, json!(2 * H)), "the device had no period");
        assert_eq!(s.iter().filter(|x| x["logType"] == "(no log type)").map(|x| x["noType"].as_bool().unwrap()).filter(|x| *x).count(), 1);
        let q = device(&c, "quiet", &r, now, 2, None, &OlderTypes::default()).unwrap();
        let b = q["series"].as_array().unwrap().last().cloned().unwrap();
        assert!(b["logType"] == "b" && b["stateText"].as_str().unwrap().starts_with("no logs since ") && b["delayMinutes"] == Value::Null && b["docs"] == json!(0), "{b}");
        assert_eq!((q["state"].clone(), q["types"]["measured"].clone()), (json!("no_delay"), json!(1)), "one type measured: its newest document decides");
        // Not measured since: as of then.
        let later = now + 10 * H;
        let d = device(&c, "one", &Range::last_days(later, 30), later, 2, None, &OlderTypes::default()).unwrap();
        assert!(d["series"][0]["stale"] == json!(true) && d["series"][0]["stateText"].as_str().unwrap().contains("when last measured"), "{}", d["series"][0]);
        assert!(d["stateText"].as_str().unwrap().starts_with("part delayed when last measured "), "{}", d["stateText"]);
        assert_eq!(d["partLateMs"], json!(2 * H), "counted up to its last measurement");
        // Older points and a type dropped since come from the day files.
        let at = now - 10 * 86_400_000;
        let lines = [json!({ "measured_at": at, "types": [{ "log_type": "threat", "state": "critical", "delay_minutes": 70.0 }, { "log_type": "(no log type)", "no_type": true, "state": "no_delay", "delay_minutes": 1.0 },
                                                           { "log_type": "gone", "state": "no_delay", "delay_minutes": 1.0 }] }),
                     json!({ "measured_at": at + 2 * H, "types": [{ "log_type": "threat", "state": "delay", "delay_minutes": 40.0 }] }),
                     json!({ "measured_at": at + 4 * H, "types_truncated": true, "types": [{ "log_type": "threat", "state": "delay", "delay_minutes": 41.0 }] }),
                     json!({ "measured_at": at + 6 * H, "types": null })];
        let older = OlderTypes::of(&lines);
        assert_eq!(older.points[&Some("gone".to_string())].iter().map(|p| (p.t - at, p.s)).collect::<Vec<_>>(), [(0, State::NoDelay), (2 * H, State::Silent)], "not named by a whole reading: no logs; by a cut one: not known");
        let d = device(&c, "one", &r, now, 2, None, &older).unwrap();
        let of = |n: &str, no: bool| d["series"].as_array().unwrap().iter().find(|x| x["logType"] == n && x["noType"] == no).cloned().unwrap();
        assert_eq!((of("threat", false)["points"].as_array().unwrap().len(), of("threat", false)["points"][0]["m"].clone()), (7, json!(70.0)));
        assert_eq!((of("(no log type)", true)["points"].as_array().unwrap().len(), of("(no log type)", false)["points"].as_array().unwrap().len()), (6, 4));
        assert_eq!((of("gone", false)["state"].clone(), of("gone", false)["points"].as_array().unwrap().len()), (json!("silent"), 2));
    }
}
