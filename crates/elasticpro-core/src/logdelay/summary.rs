//! The figures the pages, the mail and the workbook show, from the built-in store, defined
//! once (docs/LOGDELAY.md "Messages"; CLAUDE.md "One definition per quantity").
//!
//! Everything here is a pure function of what the store holds: a tracker and the daily
//! totals per cluster, a range of local days, and the time it is asked. The Core hands the
//! inputs in and sends the answer out; the report builds its sheets from the same values.

use super::fixes::Finding;
use super::levels::{Levels, State};
use super::state::{percentile, Daily, Episode, Tracker};
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub devices: u64,
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
    pub unmeasured: u64,
}

impl Totals {
    pub fn add(&mut self, s: State) {
        self.devices += 1;
        match s {
            State::NoDelay => { self.no_delay += 1; self.on_time += 1; self.measured += 1 }
            State::Little => { self.little += 1; self.on_time += 1; self.measured += 1 }
            State::Delay => { self.delay += 1; self.measured += 1 }
            State::Critical => { self.critical += 1; self.measured += 1 }
            State::ClockAhead => { self.clock_ahead += 1; self.on_time += 1; self.measured += 1 }
            State::OtherTz => { self.other_tz += 1; self.measured += 1 }
            State::Silent => self.silent += 1,
            State::Unmeasured => self.unmeasured += 1,
        }
    }

    pub fn late(&self) -> u64 {
        self.delay + self.critical
    }

    /// Percentages of all devices, one decimal; `None` of none.
    pub fn json(&self) -> Value {
        let pct = |n: u64| (self.devices > 0).then(|| ((n as f64 / self.devices as f64) * 1000.0).round() / 10.0);
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        v["late"] = json!(self.late());
        v["pctOnTime"] = json!(pct(self.on_time));
        v["pctLate"] = json!(pct(self.late()));
        v["pctSilent"] = json!(pct(self.silent));
        v["pctUnmeasured"] = json!(pct(self.unmeasured));
        v
    }
}

/// One device's line in any table.
#[derive(Clone, Debug, PartialEq, Serialize)]
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
    /// The real UTC offset the device's gap sits at, if it sits at one.
    pub device_tz_offset: Option<i32>,
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
    /// `None` while no period is open.
    pub late_since: Option<i64>,
    pub docs_per_day: Option<u64>,
    pub last_arrival: Option<i64>,
    pub last_event: Option<i64>,
    pub silent_since: Option<i64>,
    /// `Zone` and `tag1` of the device (an extra column, read whatever its case): every row of
    /// every log delay table carries them; `None` = the device's logs do not say.
    pub zone: Option<String>,
    pub tag1: Option<String>,
    /// The device sent logs in its cluster's last run (what a live check or *Fetch now* sees);
    /// `false` for one only remembered from earlier in the range (silent, or seen before).
    pub in_last_run: bool,
    pub extras: BTreeMap<String, String>,
}

/// Every device of one cluster measured in the range: a measurement (any state, silent
/// included) inside it, or a delay period overlapping it. A device the tracker remembers only
/// from before the range is not in it — the report for yesterday lists yesterday's devices.
pub fn device_rows(c: &ClusterInput, r: &Range, now: i64) -> Vec<DeviceRow> {
    let eps = c.tracker.all_episodes();
    let by_device = episodes_by_device(&eps, r, now);
    let mut out = vec![];
    for (name, d) in &c.tracker.devices {
        let mine = by_device.get(name.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        if mine.is_empty() && !measured_in(d, r) {
            continue;
        }
        out.push(row_of(c, name, d, mine, r, now));
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
    d.recent.iter().any(|p| p.t >= r.from_ms && p.t < r.to_ms)
}

/// One device's row over the range; `mine` are its periods overlapping the range.
fn row_of(c: &ClusterInput, name: &str, d: &super::state::DeviceState, mine: &[&Episode], r: &Range, now: i64) -> DeviceRow {
    let mut in_range: Vec<f64> = d.recent.iter().filter(|p| p.t >= r.from_ms && p.t < r.to_ms).filter_map(|p| p.m).collect();
    let max = in_range.iter().cloned().fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.max(x))));
    let last = mine.last();
    let docs: u64 = d.day_docs.iter().map(|(_, n)| n).sum();
    let measured = d.state.measured();
    DeviceRow {
        device: name.to_string(), cluster: c.id.clone(), cluster_name: c.name.clone(), state: d.state,
        now_minutes: if measured { d.last_minutes } else { None },
        raw_gap_minutes: if measured { d.last_raw_minutes } else { None },
        tz_offset_minutes: if measured { d.applied_offset } else { None },
        device_tz_offset: d.tz_offset, cluster_tz_offset: c.cluster_offset(now),
        median_minutes: percentile(&mut in_range, 0.5), max_minutes: max,
        episodes: mine.len() as u64, solved: mine.iter().filter(|e| e.solved_ms.is_some()).count() as u64,
        late_ms: mine.iter().map(|e| e.overlap_ms(r.from_ms, r.to_ms, now)).sum(),
        last_started: last.map(|e| e.started_ms), last_solved: last.and_then(|e| e.solved_ms),
        late_since: d.open.as_ref().map(|e| e.started_ms),
        docs_per_day: (!d.day_docs.is_empty()).then_some(docs),
        last_arrival: d.last_arrival_ms, last_event: d.last_event_ms,
        silent_since: d.silence.as_ref().map(|s| s.from_ms),
        zone: super::extra_ci(&d.extras, "Zone").cloned(), tag1: super::extra_ci(&d.extras, "tag1").cloned(),
        in_last_run: in_last_run(d, c.tracker.last_run_ms),
        extras: d.extras.clone(),
    }
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
    let eps = c.tracker.all_episodes();
    let by_device = episodes_by_device(&eps, r, now);
    let in_range = c.tracker.devices.iter().filter(|(n, d)| by_device.contains_key(n.as_str()) || measured_in(d, r)).count();
    json!({ "inLastRun": in_last, "now": c.tracker.devices.len(), "inRange": in_range,
            "lastRead": c.tracker.last_read })
}

/// The devices' states now.
pub fn totals(c: &ClusterInput) -> Totals {
    let mut t = Totals::default();
    for d in c.tracker.devices.values() {
        t.add(d.state);
    }
    t
}

/// One day's windows of `every` hours: newly late, solved and still late in each, and — by each
/// device's last stored measurement at the window's end (`State`, the one definition) — how many
/// sat in the delay band (`delay`) and above the critical line (`critical`). The Dashboard's
/// Today draws its three panels from these; `solved` is the devices that came back below the line.
pub fn windows(trackers: &[&Tracker], day: NaiveDate, every_hours: u64, now: i64) -> Vec<Value> {
    let eps: Vec<Episode> = trackers.iter().flat_map(|t| t.all_episodes()).collect();
    time::windows(day, every_hours).into_iter().filter(|(from, _)| *from <= now).map(|(from, to)| {
        let newly = eps.iter().filter(|e| e.started_ms >= from && e.started_ms < to).count();
        let solved = eps.iter().filter(|e| e.solved_ms.is_some_and(|s| s >= from && s < to)).count();
        let end = to.min(now);
        let still = eps.iter().filter(|e| e.late_at(end)).count();
        let (mut delay, mut critical) = (0usize, 0usize);
        for t in trackers {
            for d in t.devices.values() {
                // Points are chronological; today's windows sit at the tail, so the reverse scan is short.
                match d.recent.iter().rev().find(|p| p.t <= end).map(|p| p.s) {
                    Some(State::Delay) => delay += 1,
                    Some(State::Critical) => critical += 1,
                    _ => {}
                }
            }
        }
        json!({ "from": from, "to": to, "label": time::window_label(from, to), "newlyLate": newly, "solved": solved, "stillLate": still,
                "delay": delay, "critical": critical, "complete": now >= to })
    }).collect()
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
            sum.unmeasured += d.unmeasured;
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
        v["onTimeAll"] = json!(sum.on_time + sum.little + sum.clock_ahead);
        v["late"] = json!(sum.delayed + sum.critical);
        out.push(v);
    }
    out
}

/// Share of devices under the delay line over the range's days, from the daily totals:
/// the mean of each day's share. `None` with no day.
pub fn below_share(c: &ClusterInput, r: &Range) -> Option<f64> {
    let shares: Vec<f64> = r.day_keys().iter().filter_map(|k| c.daily.get(k)).filter(|d| d.devices > 0)
        .map(|d| (d.on_time + d.little + d.clock_ahead) as f64 / d.devices as f64).collect();
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
    let mut per_cluster = vec![];
    let mut rows: Vec<DeviceRow> = vec![];
    let today = time::local_date(now);
    let (t0, t1) = time::day_bounds(today);
    let prev = r.previous();
    for c in clusters {
        let t = totals(c);
        for d in c.tracker.devices.values() {
            all.add(d.state);
        }
        let crows = device_rows(c, r, now);
        let worst = crows.iter().filter(|x| x.now_minutes.is_some()).max_by(|a, b| a.now_minutes.partial_cmp(&b.now_minutes).unwrap_or(std::cmp::Ordering::Equal));
        let new_today = c.tracker.all_episodes().iter().filter(|e| e.started_ms >= t0 && e.started_ms < t1).count();
        per_cluster.push(json!({
            "id": c.id, "name": c.name, "devices": t.devices, "measured": t.measured, "lateNow": t.late(), "delay": t.delay, "critical": t.critical,
            "silent": t.silent, "unmeasured": t.unmeasured, "otherTz": t.other_tz, "timeZone": c.time_zone(now),
            "below": t.on_time, "belowPct": (t.devices > 0).then(|| ((t.on_time as f64 / t.devices as f64) * 1000.0).round() / 10.0),
            "latePct": (t.devices > 0).then(|| ((t.late() as f64 / t.devices as f64) * 1000.0).round() / 10.0),
            "belowPctPrevious": below_share(c, &prev), "newToday": new_today,
            "sparkline": sparkline(c, r), "sparklineDays": r.day_keys(),
            "worst": worst.map(|w| json!({ "device": w.device, "minutes": w.now_minutes, "state": w.state })),
            "levels": c.levels, "lastRunAt": c.tracker.last_run_ms,
            "counts": device_counts(c, r, now), "lastRead": c.tracker.last_read,
            // Today's windows per cluster: the Dashboard's cluster × time heat map for "Today".
            "windows": windows(&[c.tracker.as_ref()], today, every_hours, now),
        }));
        rows.extend(crows);
    }
    per_cluster.sort_by(|a, b| b["latePct"].as_f64().unwrap_or(0.0).partial_cmp(&a["latePct"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    rows.sort_by_key(|r| std::cmp::Reverse(r.late_ms));
    let in_range = rows.len();
    let truncated = rows.len() > max_devices;
    rows.truncate(max_devices);
    let eps: Vec<Episode> = trackers.iter().flat_map(|t| t.all_episodes()).collect();
    let yesterday = today.pred_opt().unwrap_or(today);
    let (y0, y1) = time::day_bounds(yesterday);
    let y_solved: Vec<&Episode> = eps.iter().filter(|e| e.solved_ms.is_some_and(|s| s >= y0 && s < y1)).collect();
    let y_avg = (!y_solved.is_empty()).then(|| y_solved.iter().map(|e| e.lasted_ms(now)).sum::<i64>() / y_solved.len() as i64);
    json!({
        "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string(), "label": r.label(), "now": now,
        "everyHours": every_hours, "clusters": clusters.len(), "measuredClusters": clusters.iter().filter(|c| c.tracker.last_run_ms.is_some()).count(),
        "totals": all.json(),
        "reduced": reduced(&trackers, now, &[2, 4, 6, 12, 24]),
        "newlyLateToday": eps.iter().filter(|e| e.started_ms >= t0 && e.started_ms < t1).count(),
        "solvedToday": eps.iter().filter(|e| e.solved_ms.is_some_and(|s| s >= t0 && s < t1)).count(),
        "yesterday": { "newlyLate": eps.iter().filter(|e| e.started_ms >= y0 && e.started_ms < y1).count(), "solved": y_solved.len(), "averageLastedMs": y_avg },
        "windows": windows(&trackers, today, every_hours, now),
        "days": days(&refs, r),
        "byCluster": per_cluster,
        "devices": rows, "devicesTotal": all.devices, "devicesInRange": in_range, "devicesTruncated": truncated,
        "devicesInLastRun": clusters.iter().map(|c| c.tracker.devices.values().filter(|d| in_last_run(d, c.tracker.last_run_ms)).count()).sum::<usize>(),
    })
}

/// One cluster (Cluster board).
pub fn cluster(c: &ClusterInput, r: &Range, now: i64, every_hours: u64, fields: &Value) -> Value {
    let t = totals(c);
    let rows = device_rows(c, r, now);
    let eps = c.tracker.all_episodes();
    let mut nows: Vec<f64> = c.tracker.devices.values().filter_map(|d| d.last_minutes.filter(|_| d.state != State::Silent && d.state != State::Unmeasured)).collect();
    let prev = r.previous();
    let mut prev_medians: Vec<f64> = prev.day_keys().iter().filter_map(|k| c.daily.get(k).and_then(|d| d.median_minutes)).collect();
    let today = time::local_date(now);
    json!({
        "cluster": c.id, "name": c.name, "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string(), "label": r.label(),
        "now": now, "everyHours": every_hours, "levels": c.levels, "fields": fields, "lastRunAt": c.tracker.last_run_ms,
        "timeZone": c.time_zone(now),
        "counts": device_counts(c, r, now), "lastRead": c.tracker.last_read,
        "totals": t.json(),
        "started": eps.iter().filter(|e| e.started_ms >= r.from_ms && e.started_ms < r.to_ms).count(),
        "solved": eps.iter().filter(|e| e.solved_ms.is_some_and(|s| s >= r.from_ms && s < r.to_ms)).count(),
        "medianNow": percentile(&mut nows, 0.5), "medianPrevious": percentile(&mut prev_medians, 0.5),
        "windows": windows(&[c.tracker.as_ref()], today, every_hours, now),
        "days": days(&[c], r),
        "devices": rows,
    })
}

/// One device (Device board), with its finding when there is one.
pub fn device(c: &ClusterInput, name: &str, r: &Range, now: i64, every_hours: u64, finding: Option<&Finding>) -> Option<Value> {
    let d = c.tracker.devices.get(name)?;
    let eps: Vec<Episode> = c.tracker.all_episodes().into_iter().filter(|e| e.device == name && e.started_ms < r.to_ms && e.end_ms(now) >= r.from_ms).collect();
    let row = row_of(c, name, d, &eps.iter().collect::<Vec<_>>(), r, now);
    let points: Vec<Value> = d.recent.iter().filter(|p| p.t >= r.from_ms && p.t < r.to_ms).map(|p| json!({ "t": p.t, "m": p.m, "s": p.s })).collect();
    let measured: Vec<(i64, f64)> = d.recent.iter().filter(|p| p.t >= r.from_ms && p.t < r.to_ms).filter_map(|p| p.m.map(|m| (p.t, m))).collect();
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
    let range_ms = (r.to_ms.min(now) - r.from_ms).max(1);
    let mut v = json!({
        "device": name, "cluster": c.id, "clusterName": c.name, "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string(),
        "label": r.label(), "now": now, "everyHours": every_hours, "levels": c.levels,
        "state": d.state, "nowMinutes": row.now_minutes, "lateSince": row.late_since, "silentSince": row.silent_since,
        "medianMinutes": row.median_minutes, "worst": peak.map(|(t, m)| json!({ "minutes": m, "at": t })),
        "episodes": eps.len(), "solved": solved.len(), "lateMs": row.late_ms,
        "latePct": ((row.late_ms as f64 / range_ms as f64) * 1000.0).round() / 10.0,
        "docsPerDay": row.docs_per_day, "lastSilence": silences.last().and_then(|s| s.get("from").cloned()),
        "extras": d.extras, "lastArrival": d.last_arrival_ms, "lastEvent": d.last_event_ms, "firstSeen": d.first_seen_ms,
        "points": points,
        "periods": eps.iter().map(|e| json!({
            "started": e.started_ms, "solved": e.solved_ms, "ended": e.ended_ms, "lastedMs": e.lasted_ms(now), "worstMinutes": e.worst_minutes, "worstState": e.worst_state,
            "lastMinutes": e.last_minutes, "lastState": e.last_state, "measurements": e.measurements, "pattern": e.pattern(), "extras": e.extras,
        })).collect::<Vec<_>>(),
        "silences": silences,
        "insights": {
            "peak": peak.map(|(t, m)| json!({ "minutes": m, "at": t })),
            "average": average.map(|a| json!({ "minutes": a, "measurements": measured.len() })),
            "longest": longest.map(|e| json!({ "lastedMs": e.lasted_ms(now), "started": e.started_ms, "solved": e.solved_ms })),
            "solvedIn": solve_avg.map(|ms| json!({ "averageMs": ms, "solved": solved.len() })),
            "lateMostOften": most,
        },
        "finding": finding,
    });
    // Beside the rest (one json! of this size is at the macro's recursion limit).
    v["zone"] = json!(row.zone);
    v["tag1"] = json!(row.tag1);
    v["inLastRun"] = json!(row.in_last_run);
    v["timeZone"] = c.time_zone(now);
    v["rawGapMinutes"] = json!(row.raw_gap_minutes);
    v["tzOffsetMinutes"] = json!(row.tz_offset_minutes);
    v["deviceTzOffset"] = json!(row.device_tz_offset);
    v["clusterTzOffset"] = json!(row.cluster_tz_offset);
    Some(v)
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
                    (f == "device" || f.starts_with("src_")) && re.is_match(&row.device) || row.extras.get(f).is_some_and(|v| re.is_match(v))
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
        Reading { device: device.into(), docs: 100, arrival_ms: Some(run), event_ms: m.map(|x| run - (x * 60_000.0) as i64), delay_minutes: m, extras }
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
        assert_eq!(d.late_hours, 5.0, "it was late from midnight until it was forgotten at 05:00, not until now");
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
    fn a_device_view_has_its_periods_and_insights_and_a_missing_device_is_none() {
        let now = chrono::Utc::now().timestamp_millis();
        let c = cluster_input(now);
        let r = Range::last_days(now, 30);
        let d = device(&c, "fw-1", &r, now, 2, None).unwrap();
        assert_eq!(d["state"], "critical");
        assert_eq!(d["nowMinutes"], 94.0);
        assert_eq!(d["periods"].as_array().unwrap().len(), 1);
        assert_eq!(d["periods"][0]["worstMinutes"], 94.0);
        assert_eq!(d["insights"]["peak"]["minutes"], 94.0);
        assert_eq!(d["insights"]["solvedIn"], Value::Null, "nothing solved: unknown, not 0");
        assert_eq!(d["insights"]["average"]["measurements"], 4);
        assert_eq!(d["points"].as_array().unwrap().len(), 4);
        assert_eq!(d["lateSince"], now - 4 * H);
        assert!(device(&c, "nope", &r, now, 2, None).is_none());
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
}
