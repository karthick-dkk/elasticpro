//! The `log_delay` report: its options, the workbook (one sheet per section, a Fixes sheet),
//! the CSV device list, and the mail — HTML with a plain-text copy (docs/LOGDELAY.md
//! "Report kind log_delay"; the Mail and Storage boards).
//!
//! Every figure is `summary.rs`'s; this file only lays them out. The mail's tables are
//! email-safe: `<table>`, inline styles, no script, no external image. A device's state has one
//! colour everywhere (the owner's rule, 2026-11-24): critical light red, delayed light yellow, on
//! time light green, part delayed white with a yellow edge, another time zone violet, silent and can't
//! measure grey — a light ground under dark ink, the word always written. Blue, orange and pink stay for what is not a state.

use super::fixes::{Finding, Step};
use super::levels::{Levels, State, NO_LOG_TYPE};
use super::state::Episode;
use super::summary::{self, ClusterInput, DeviceRow, Range};
use super::time;
use super::tz;
use crate::report::build::csv_escape;
use crate::report::xlsx::{self, Cell, Sheet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const GREEN: &str = "#DDF3E4";
pub const BLUE: &str = "#DCEBFA";
pub const PINK: &str = "#FBDCE6";
pub const ORANGE: &str = "#FDE4CC";
pub const RED: &str = "#FBD5D5";
pub const YELLOW: &str = "#FFF3C4";
pub const VIOLET: &str = "#E7DDF7";
pub const GREY: &str = "#E8EAED";
/// Part delayed: no ground of its own, a yellow edge.
pub const PART: &str = "#FFFFFF;border:2px solid #E8C547";

/// The ground of a state, in the mail.
pub fn state_colour(s: State) -> &'static str {
    match s {
        State::Critical => RED,
        State::Delay => YELLOW,
        State::NoDelay | State::Little => GREEN,
        State::PartDelay => PART,
        State::OtherTz => VIOLET,
        State::Silent | State::Unmeasured | State::ClockAhead => GREY,
    }
}

/// The same for a number of late devices, some of them critical.
fn late_colour(late: f64, critical: f64) -> &'static str {
    if critical > 0.0 { RED } else if late > 0.0 { YELLOW } else { GREEN }
}

/// A cluster's late devices; "not known" when its last run measured nothing — 0 would read as none late.
fn late_text(c: &Value) -> String {
    if c["notMeasured"].is_string() {
        return "not known".into();
    }
    format!("{} ({} critical){}", n(&c["lateNow"]) as i64, n(&c["critical"]) as i64, part_text(c))
}

/// The two lines in words, as the clusters have them: their minutes when every cluster has the
/// same, else that each has its own.
pub struct Lines {
    pub under: String,
    pub band: String,
    pub over: String,
    pub at: String,
}

impl Lines {
    pub fn of(clusters: &[ClusterInput]) -> Lines {
        let first = clusters.first().map(|c| c.levels).unwrap_or_default();
        if clusters.iter().any(|c| c.levels != first) {
            return Lines { under: "under the delay line".into(), band: "between the lines".into(), over: "above the critical line".into(), at: "the delay line or more".into() };
        }
        let (a, b) = (first.delay_from, first.critical_over);
        Lines { under: format!("under {a} min"), band: format!("{a}–{b} min"), over: format!("above {b} min"), at: format!("{a} min or more") }
    }
}

/// A cluster's lines, for its own row.
fn levels_text(l: &Value) -> String {
    let l: Levels = serde_json::from_value(l.clone()).unwrap_or_default();
    format!("{} / {}", l.delay_from, l.critical_over)
}

/// How a cluster was last read: when, how many devices, and what was cut or failed.
pub fn read_text(c: &Value, now: i64) -> String {
    let Some(last) = c["lastRunAt"].as_i64() else { return "never measured".into() };
    let r = &c["lastRead"];
    let mut s = format!("last run {}", time::when(last, now));
    if let Some(n) = r["devices"].as_u64() {
        s.push_str(&format!(", {n} devices read"));
    }
    if r["truncated"] == true {
        s.push_str(&format!(", list cut at {} (Max devices per run): the rest were not read", r["maxDevices"].as_u64().map(|n| n.to_string()).unwrap_or_else(|| "the cap".into())));
    }
    if let Some(e) = r["error"].as_str() {
        s.push_str(&format!(", not read to the end: {e}"));
    }
    if let Some(n) = r["noDevice"].as_u64().filter(|n| *n > 0) {
        s.push_str(&format!(", {n} documents without a device name"));
    }
    if c["stale"] == true {
        s.push_str(", not measured since");
    }
    match c["notMeasured"].as_str() {
        Some(why) => format!("{why} ({s})"),
        None => s,
    }
}

/// What makes the report's figures less than the whole: one line per cluster that was not read,
/// or not read whole.
fn warnings(fleet: &Value, now: i64) -> Vec<String> {
    fleet["byCluster"].as_array().into_iter().flatten()
        .filter(|c| c["notMeasured"].is_string() || c["lastRead"]["truncated"] == true || c["lastRead"]["error"].is_string() || c["stale"] == true)
        .map(|c| format!("{}: {}", c["name"].as_str().unwrap_or(""), read_text(c, now))).collect()
}

/// The shares' sentence, with how many clusters it speaks for when not all.
fn no_delay_line(t: &Value) -> String {
    let of = &t["pctOf"];
    let part = match (of["clusters"].as_u64(), of["ofClusters"].as_u64()) {
        (Some(a), Some(b)) if a < b => format!(" — {a} of {b} clusters; the others were not measured"),
        _ => String::new(),
    };
    match t["noDelayText"].as_str() {
        Some(s) => format!("{s}{part}"),
        None => "No delay: not measured".into(),
    }
}
const INK: &str = "#1b1f24";
const MUTED: &str = "#5b6470";
const LINE: &str = "#e3e6ea";
/// Zone · tag1 pairs the mail lists; the rest are in the Summary sheet.
const ZONE_ROWS: usize = 12;

/// Which devices the device list carries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DevicesFilter {
    /// At the delay level or more now (delay and critical), the part delayed included.
    #[default]
    Delayed,
    All,
}

impl DevicesFilter {
    /// `little` (a schedule saved before 0.3.62, when there was a little-delay band) reads as
    /// `delayed`: the band is gone, so the two lists are the same list.
    pub fn parse(s: &str) -> Option<DevicesFilter> {
        match s {
            "delayed" | "little" => Some(DevicesFilter::Delayed),
            "all" => Some(DevicesFilter::All),
            _ => None,
        }
    }
    pub fn keeps(self, s: State) -> bool {
        match self {
            DevicesFilter::Delayed => s.late() || s == State::PartDelay,
            DevicesFilter::All => true,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            DevicesFilter::Delayed => "devices at the delay level or more, part delayed included",
            DevicesFilter::All => "all devices",
        }
    }
}

pub const SECTIONS: [&str; 6] = ["summary", "lateEvery2h", "windows", "dayByDay", "topDelayed", "fixes"];
pub const BASE_COLUMNS: [&str; 16] = ["device", "cluster", "nowMinutes", "level", "startedSolved", "median", "max", "episodes", "lateTime", "docsPerDay",
                                      "arrival", "eventTime", "lateSince", "rawGap", "deviceTimeZone", "eventField"];

/// The schedule's (or a run's) options for this kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub devices: DevicesFilter,
    /// `cluster`, or an extra column's name.
    pub group_by: String,
    /// Column keys (`BASE_COLUMNS`) and extra column names.
    pub columns: Vec<String>,
    pub sections: Vec<String>,
    pub xlsx: bool,
    pub csv: bool,
    /// Asked for; not built (no PDF writer in the tree). Kept so the setting round-trips.
    pub pdf: bool,
    /// Rows in the Top delayed section.
    pub top: usize,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            devices: DevicesFilter::Delayed, group_by: "cluster".into(),
            columns: ["device", "cluster", "nowMinutes", "level", "startedSolved", "Zone", "tag1", "fwd_tag", "parser_tag", "arrival", "eventTime"]
                .iter().map(|s| s.to_string()).collect(),
            sections: SECTIONS.iter().map(|s| s.to_string()).collect(), xlsx: true, csv: true, pdf: false, top: 10,
        }
    }
}

impl Options {
    /// The given fields over the current ones; anything unknown refused by name.
    pub fn apply(mut self, v: &Value, extras: &[String]) -> Result<Options, String> {
        let Some(o) = v.as_object() else { return Err("options must be an object".into()) };
        if let Some(d) = o.get("devices") {
            self.devices = d.as_str().and_then(DevicesFilter::parse).ok_or("options.devices must be delayed or all")?;
        }
        if let Some(g) = o.get("groupBy") {
            let g = g.as_str().ok_or("options.groupBy must be text")?.trim().to_string();
            if g != "cluster" && !extras.iter().any(|e| e == &g) {
                return Err(format!("options.groupBy: {g:?} is not cluster or one of the extra columns ({})", extras.join(", ")));
            }
            self.group_by = g;
        }
        if let Some(c) = o.get("columns") {
            let list: Vec<String> = c.as_array().ok_or("options.columns must be a list")?.iter()
                .map(|x| x.as_str().map(|s| s.trim().to_string()).ok_or("options.columns: text only".to_string())).collect::<Result<_, _>>()?;
            if let Some(odd) = list.iter().find(|c| !BASE_COLUMNS.contains(&c.as_str()) && !extras.iter().any(|e| e == *c)) {
                return Err(format!("options.columns: {odd:?} is not a column (one of {}, or an extra column)", BASE_COLUMNS.join(", ")));
            }
            if list.is_empty() {
                return Err("options.columns: at least one column".into());
            }
            self.columns = list;
        }
        if let Some(s) = o.get("sections") {
            let list: Vec<String> = s.as_array().ok_or("options.sections must be a list")?.iter()
                .map(|x| x.as_str().map(|s| s.trim().to_string()).ok_or("options.sections: text only".to_string())).collect::<Result<_, _>>()?;
            if let Some(odd) = list.iter().find(|c| !SECTIONS.contains(&c.as_str())) {
                return Err(format!("options.sections: {odd:?} is not a section (one of {})", SECTIONS.join(", ")));
            }
            self.sections = list;
        }
        for (k, slot) in [("xlsx", &mut self.xlsx), ("csv", &mut self.csv), ("pdf", &mut self.pdf)] {
            if let Some(b) = o.get(k) {
                *slot = b.as_bool().ok_or_else(|| format!("options.{k} must be true or false"))?;
            }
        }
        if let Some(t) = o.get("top") {
            self.top = t.as_u64().ok_or("options.top must be a number")?.clamp(1, 100) as usize;
        }
        Ok(self)
    }

    pub fn has(&self, section: &str) -> bool {
        self.sections.iter().any(|s| s == section)
    }
}

/// What a build hands back.
pub struct Built {
    pub xlsx: Option<Vec<u8>>,
    pub csv: Option<Vec<u8>>,
    pub text: String,
    pub html: String,
    /// `37 devices late, 12 critical`.
    pub headline: String,
    /// The figures the mail was made from, kept with the report record.
    pub figures: Value,
}

/// Everything a build reads.
pub struct Inputs<'a> {
    pub clusters: &'a [ClusterInput],
    pub range: &'a Range,
    pub now: i64,
    pub every_hours: u64,
    pub findings: &'a [Finding],
    pub options: &'a Options,
    pub extras: &'a [String],
    /// Where "Open the full report" points, when the server knows its address.
    pub app_url: Option<&'a str>,
}

fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
fn int(v: &Value) -> Cell {
    v.as_f64().map(Cell::Int).unwrap_or(Cell::Empty)
}
fn opt_min(m: Option<f64>) -> Cell {
    m.map(Cell::Dec).unwrap_or_else(|| Cell::text("can't measure"))
}
fn opt_text(v: &Option<String>) -> Cell {
    v.as_ref().map(Cell::text).unwrap_or_else(|| Cell::text("—"))
}
fn pct(v: &Value) -> String {
    v.as_f64().map(|p| format!("{p:.1} %")).unwrap_or_else(|| "—".into())
}

/// Its log types in words, for a row: `1 of 3 log types late: threat`; not read by log types: that.
fn types_text(r: &DeviceRow) -> String {
    match &r.types {
        None => "not read by log types".into(),
        Some(t) if t.late > 0 => t.text(),
        Some(t) => format!("none of {}{} log types late", t.total, if t.truncated { "+" } else { "" }),
    }
}

/// `M of N`, the late log types; not read by log types: that, never 0.
fn types_late(v: &Value) -> Cell {
    match (v["late"].as_u64(), v["total"].as_u64()) {
        (Some(a), Some(b)) => Cell::text(format!("{a} of {b}")),
        _ => Cell::text("not read"),
    }
}

/// A delay period's start and end in words, as `started_solved` has a device's last one.
fn period_text(e: &Episode, now: i64) -> String {
    let a = time::when(e.started_ms, now);
    match (e.solved_ms, &e.ended_why) {
        (Some(b), _) => format!("{a} → {}", time::when(b, now)),
        (None, Some(why)) => format!("{a} → not solved ({why})"),
        (None, None) if e.stale() => format!("{a} → late when last measured {}, not measured since", e.measured_until_ms.map(|t| time::when(t, now)).unwrap_or_default()),
        (None, None) => format!("{a} → still late"),
    }
}

/// Rows the Log types sheet carries at most; what is left out is counted under it.
const TYPE_ROWS: usize = 200_000;

/// The Log types sheet: one row per delay period of a log type in the range, and — in a report of
/// all devices — one for each log type without any. Late now first, the worst first. `None`: no
/// cluster of the report is read by log types.
fn log_types_sheet(i: &Inputs<'_>) -> Option<Sheet> {
    let clusters: Vec<&ClusterInput> = i.clusters.iter().filter(|c| c.tracker.has_log_types()).collect();
    if clusters.is_empty() {
        return None;
    }
    let mut rows: Vec<(bool, f64, Vec<Cell>)> = vec![];
    for c in clusters {
        let eps = c.tracker.all_type_episodes(i.now);
        let mut by: std::collections::HashMap<(&str, Option<&str>), Vec<&Episode>> = Default::default();
        for e in eps.iter().filter(|e| e.started_ms < i.range.to_ms && e.end_ms(i.now) >= i.range.from_ms) {
            by.entry((e.device.as_str(), e.log_type.as_deref())).or_default().push(e);
        }
        let mut add = |device: &str, name: Option<&str>, now: Option<(&super::state::DeviceState, &super::state::DeviceState)>, mine: &[&Episode]| {
            let state = now.map(|(d, s)| d.type_state(s));
            let late = matches!(state, Some(Some(s)) if s.late());
            let text = match state {
                None => "not seen for a week".to_string(),
                Some(None) => "not read in the last run".into(),
                Some(Some(State::Silent)) => format!("no logs since {}", now.and_then(|(_, s)| s.last_arrival_ms).map(|t| time::when(t, i.now)).unwrap_or_else(|| "—".into())),
                Some(Some(s)) => s.label().into(),
            };
            let delay = now.and_then(|(_, s)| s.last_minutes).filter(|_| matches!(state, Some(Some(s)) if s.measured()));
            let head = || vec![Cell::text(&c.name), Cell::text(device), Cell::text(name.unwrap_or(NO_LOG_TYPE)), Cell::text(&text), delay.map(Cell::Dec).unwrap_or_else(|| Cell::text("not measured"))];
            for e in mine {
                let mut r = head();
                r.extend([Cell::text(period_text(e, i.now)), Cell::text(time::duration(e.lasted_ms(i.now))), Cell::Dec(e.worst_minutes)]);
                rows.push((late, e.worst_minutes, r));
            }
            if mine.is_empty() && i.options.devices == DevicesFilter::All {
                let mut r = head();
                r.extend([Cell::text("—"), Cell::text("—"), Cell::text("—")]);
                rows.push((late, -1.0, r));
            }
        };
        for (device, d) in &c.tracker.devices {
            for s in &d.types {
                let mine = by.remove(&(device.as_str(), s.log_type.as_deref())).unwrap_or_default();
                add(device, s.log_type.as_deref(), Some((d, s)), &mine);
            }
        }
        for ((device, name), mine) in by {
            add(device, name, None, &mine);
        }
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)));
    let all = rows.len();
    let mut r = vec![["Cluster", "Device", "Log type", "State", "Delay now (min)", "Delay: started → solved", "Lasted", "Worst (min)"].map(Cell::head).to_vec()];
    r.extend(rows.into_iter().take(TYPE_ROWS).map(|(_, _, x)| x));
    if all > TYPE_ROWS {
        r.push(vec![Cell::text(format!("{TYPE_ROWS} of {all} rows: the rest are not in this sheet"))]);
    }
    r.push(vec![Cell::text(format!("{} · {LOG_TYPES_NOTE}", if i.options.devices == DevicesFilter::All { "every log type; one row per delay period in the range" } else { "one row per delay period in the range" }))]);
    Some(Sheet { name: "Log types".into(), rows: r })
}

/// What part delayed and the log types' figures mean, said where they are shown.
pub const LOG_TYPES_NOTE: &str = "A device is late when every one of its measured log types is; with some late and some on time it is part delayed — its own count, in neither the late devices nor No delay. A log type with no logs or no readable event time counts as not late. A device's delay is its worst late log type's.";

/// The line every report carries about the zone step (docs/LOGDELAY.md "Time zones").
pub const TZ_NOTE: &str = "Delays are shown after each cluster's log time zone is taken out (raw gap − zone offset). Measurements from before a zone was set or detected stay as they were measured.";

/// A cluster's time zone in words: `Asia/Kolkata +05:30 · detected (90 %)`, `UTC · set`,
/// `not detected (41 % agree)`, `not measured`.
pub fn time_zone_text(z: &Value) -> String {
    let pct = z["pct"].as_f64().map(|p| format!("{p:.0} %"));
    match z["mode"].as_str() {
        Some("set") => format!("{} {} · set", z["zone"].as_str().unwrap_or(""), z["offset"].as_str().unwrap_or("")).trim().to_string(),
        Some("detected") => format!("{}{} · detected{}", z["zone"].as_str().map(|n| format!("{n} ")).unwrap_or_default(), z["offset"].as_str().unwrap_or(""),
                                    pct.map(|p| format!(" ({p} agree)")).unwrap_or_default()),
        Some("none") => match pct { Some(p) => format!("not detected ({p} agree)"), None => "not detected".into() },
        _ => "—".into(),
    }
}

/// The range as the report names it: an hour (`13 Nov 09:00–10:00`), a day, or days.
pub fn range_label(r: &Range) -> String {
    if r.to_ms - r.from_ms <= 3_600_000 {
        let a = time::local_datetime(r.from_ms);
        return format!("{} {}–{}", time::short_date(a.date()), a.format("%H:%M"), time::local_datetime(r.to_ms).format("%H:%M"));
    }
    if r.from == r.to { time::long_date(r.to) } else { r.label() }
}

/// The device rows the options keep, grouped and sorted.
pub fn device_rows(i: &Inputs<'_>) -> Vec<DeviceRow> {
    let mut rows: Vec<DeviceRow> = i.clusters.iter().flat_map(|c| summary::device_rows(c, i.range, i.now)).filter(|r| i.options.devices.keeps(r.state)).collect();
    let key = |r: &DeviceRow| if i.options.group_by == "cluster" { r.cluster_name.clone() } else { r.extras.get(&i.options.group_by).cloned().unwrap_or_else(|| "—".into()) };
    rows.sort_by(|a, b| key(a).cmp(&key(b)).then(b.late_ms.cmp(&a.late_ms)));
    rows
}

/// The Devices sheet's and the CSV's columns: the options' own, with `Zone` and `tag1` added
/// after the cluster when the options leave them out (every log delay table shows them).
pub fn columns(o: &Options) -> Vec<String> {
    let mut cols = o.columns.clone();
    let mut at = cols.iter().position(|c| c == "cluster").or_else(|| cols.iter().position(|c| c == "device")).map(|p| p + 1).unwrap_or(cols.len());
    for must in ["Zone", "tag1"] {
        if !cols.iter().any(|c| c.eq_ignore_ascii_case(must)) {
            cols.insert(at, must.to_string());
            at += 1;
        }
    }
    cols
}

/// Zone and tag1 by device, from every cluster's tracker (the Fixes sheet names a finding's).
fn zone_tag(i: &Inputs<'_>, cluster: &str, device: &str) -> (Option<String>, Option<String>) {
    i.clusters.iter().find(|c| c.id == cluster).and_then(|c| c.tracker.devices.get(device))
        .map(|d| (super::extra_ci(&d.extras, "Zone").cloned(), super::extra_ci(&d.extras, "tag1").cloned()))
        .unwrap_or((None, None))
}

/// Devices now by Zone and tag1, over every cluster: devices, late (delay + critical),
/// critical, silent, part delayed — the most late first. A device whose logs carry no Zone or tag1 is under
/// "—" (not known), never left out.
pub fn by_zone_tag(i: &Inputs<'_>) -> Vec<(String, String, [u64; 5])> {
    let mut m: std::collections::BTreeMap<(String, String), [u64; 5]> = std::collections::BTreeMap::new();
    for c in i.clusters {
        for d in c.tracker.devices.values() {
            let k = (super::extra_ci(&d.extras, "Zone").cloned().unwrap_or_else(|| "—".into()), super::extra_ci(&d.extras, "tag1").cloned().unwrap_or_else(|| "—".into()));
            let e = m.entry(k).or_default();
            e[0] += 1;
            e[1] += d.state.late() as u64;
            e[2] += (d.state == State::Critical) as u64;
            e[3] += (d.state == State::Silent) as u64;
            e[4] += (d.state == State::PartDelay) as u64;
        }
    }
    let mut v: Vec<(String, String, [u64; 5])> = m.into_iter().map(|((z, t), n)| (z, t, n)).collect();
    v.sort_by(|a, b| b.2[1].cmp(&a.2[1]).then(b.2[0].cmp(&a.2[0])).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    v
}

fn column_label(c: &str) -> String {
    match c {
        "device" => "Device", "cluster" => "Cluster", "nowMinutes" => "Delay now (min)", "level" => "Level", "startedSolved" => "Last delay: started → solved",
        "median" => "Median (min)", "max" => "Max (min)", "episodes" => "Delays", "lateTime" => "Time late", "docsPerDay" => "Logs a day",
        "arrival" => "Arrival", "eventTime" => "Event time", "lateSince" => "Late since", "rawGap" => "Raw gap (min)", "eventField" => "Event time field", "deviceTimeZone" => "Device time zone",
        other => other,
    }.to_string()
}

/// "Device time zone" for a row: `same as cluster`, the device's own offset for one in another
/// zone, or `—` when the cluster has no zone (nothing to compare against).
pub fn device_time_zone(r: &DeviceRow) -> String {
    match (r.cluster_tz_offset, r.state) {
        (_, State::OtherTz) => r.own_zone.or(r.device_tz_offset).or(r.tz_offset_minutes).map(tz::offset_text).unwrap_or_else(|| "other".into()),
        (Some(_), s) if s.measured() => r.own_zone.map(tz::offset_text).unwrap_or_else(|| "same as cluster".into()),
        _ => "—".into(),
    }
}

fn column_cell(c: &str, r: &DeviceRow, now: i64) -> Cell {
    match c {
        "device" => Cell::text(&r.device),
        "cluster" => Cell::text(&r.cluster_name),
        "nowMinutes" => opt_min(r.now_minutes),
        "level" => Cell::text(summary::state_text(r, now)),
        "startedSolved" => Cell::text(started_solved(r, now)),
        "median" => opt_min(r.median_minutes),
        "max" => opt_min(r.max_minutes),
        "episodes" => Cell::Int(r.episodes as f64),
        "lateTime" => Cell::text(time::duration(r.late_ms)),
        "docsPerDay" => match (r.docs_per_day, r.docs_counted, r.docs_counted_hours) {
            (Some(d), _, _) => Cell::Int(d as f64),
            (None, Some(d), Some(h)) => Cell::text(format!("{d} in {h} h measured")),
            _ => Cell::Empty,
        },
        "arrival" => r.last_arrival.map(|t| Cell::text(time::when(t, now))).unwrap_or(Cell::Empty),
        "eventTime" => r.last_event.map(|t| Cell::text(time::when(t, now))).unwrap_or(Cell::Empty),
        "eventField" => opt_text(&r.event_field),
        "lateSince" => r.late_since.map(|t| Cell::text(time::when(t, now))).unwrap_or(Cell::Empty),
        "rawGap" => opt_min(r.raw_gap_minutes),
        "deviceTimeZone" => Cell::text(device_time_zone(r)),
        other => super::extra_ci(&r.extras, other).map(Cell::text).unwrap_or(Cell::Empty),
    }
}

fn cell_text(c: &Cell) -> String {
    match c {
        Cell::Empty => String::new(),
        Cell::Text(s) | Cell::Head(s) => s.clone(),
        Cell::Int(n) => format!("{}", *n as i64),
        Cell::Dec(n) => format!("{n:.2}"),
        Cell::Num(n) => n.to_string(),
    }
}

/// `today 11:15 → still late`, `2 Nov 06:00 → 2 Nov 08:30`, `no logs since 12:40`.
pub fn started_solved(r: &DeviceRow, now: i64) -> String {
    if r.state == State::Silent {
        return format!("no logs since {}", r.silent_since.map(|t| time::when(t, now)).unwrap_or_else(|| "—".into()));
    }
    match (r.last_started, r.last_solved, r.late_since) {
        (_, _, Some(s)) => match r.last_measured_ms.filter(|_| r.stale || r.measured_until_ms.is_some()) {
            Some(t) => format!("{} → late when last measured {}, not measured since", time::when(s, now), time::when(t, now)),
            None => format!("{} → still late", time::when(s, now)),
        },
        (Some(a), Some(b), None) => format!("{} → {}", time::when(a, now), time::when(b, now)),
        (Some(a), None, None) => match &r.last_ended_why {
            Some(why) => format!("{} → not solved ({why})", time::when(a, now)),
            None => format!("{} → not seen solved", time::when(a, now)),
        },
        _ => "—".into(),
    }
}

/// Build it all.
pub fn build(i: &Inputs<'_>) -> Result<Built, String> {
    let fleet = summary::fleet(i.clusters, i.range, i.now, i.every_hours, super::MAX_DEVICES);
    let rows = device_rows(i);
    let last_day = i.range.to.min(time::local_date(i.now));
    let trackers: Vec<&super::state::Tracker> = i.clusters.iter().map(|c| c.tracker.as_ref()).collect();
    let windows = summary::windows(&trackers, last_day, i.every_hours, i.now);
    let mut top: Vec<&DeviceRow> = rows.iter().filter(|r| r.state.late()).collect();
    top.sort_by(|a, b| b.now_minutes.partial_cmp(&a.now_minutes).unwrap_or(std::cmp::Ordering::Equal));
    top.truncate(i.options.top);
    let t = &fleet["totals"];
    let part = match n(&t["partDelayed"]) as i64 { 0 => String::new(), p => format!(", {p} part delayed") };
    let headline = format!("{} devices late, {} critical{part}", n(&t["late"]) as i64, n(&t["critical"]) as i64);

    let xlsx = if i.options.xlsx { Some(xlsx::workbook(&sheets(i, &fleet, &rows, &windows, &top))?) } else { None };
    let csv = if i.options.csv { Some(csv(i, &rows).into_bytes()) } else { None };
    let html = html(i, &fleet, &windows, &top, &headline);
    let text = text(i, &fleet, &windows, &top, &headline);
    let figures = json!({ "totals": t, "yesterday": fleet["yesterday"], "windows": windows, "days": fleet["days"], "devices": rows.len(),
                          "findings": i.findings.len(), "period": { "from": fleet["from"], "to": fleet["to"] } });
    Ok(Built { xlsx, csv, text, html, headline, figures })
}

fn sheets(i: &Inputs<'_>, fleet: &Value, rows: &[DeviceRow], windows: &[Value], top: &[&DeviceRow]) -> Vec<Sheet> {
    let mut out = vec![];
    let t = &fleet["totals"];
    let now = i.now;
    let ln = Lines::of(i.clusters);
    if i.options.has("summary") {
        let mut r = vec![
            vec![Cell::head("ElasticPro log delay report"), Cell::text(range_label(i.range))],
            vec![Cell::text("Clusters"), Cell::Int(i.clusters.len() as f64)],
            vec![Cell::text("Measured every"), Cell::text(format!("{} h", i.every_hours))],
            vec![Cell::text("Devices"), int(&t["devices"])],
            vec![Cell::text("Devices measured (not silent, not can't measure)"), int(&t["measured"])],
            vec![Cell::text("No delay (on time, silent or can't measure)"), int(&t["noDelay"]), Cell::text(no_delay_line(t))],
            vec![Cell::text(format!("  on time ({})", ln.under)), int(&t["onTime"]), Cell::text(pct(&t["pctOnTime"]))],
            vec![Cell::text("  silent"), int(&t["silent"]), Cell::text(pct(&t["pctSilent"]))],
            vec![Cell::text("  can't measure"), int(&t["cantMeasure"]), Cell::text(pct(&t["pctCantMeasure"]))],
            vec![Cell::text(format!("Late at the last measurement ({})", ln.at)), int(&t["late"]), Cell::text(pct(&t["pctLate"]))],
            vec![Cell::text(format!("  {}", ln.band)), int(&t["delay"])],
            vec![Cell::text(format!("  {}", ln.over)), int(&t["critical"])],
            vec![Cell::text("Part delayed (some of its log types late)"), int(&t["partDelayed"]), Cell::text(pct(&t["pctPartDelayed"]))],
            vec![Cell::text("Log types late"), types_late(&t["logTypes"]), Cell::text(t["logTypes"]["above"].as_u64().map(|a| format!("{a} {}", ln.over)).unwrap_or_default())],
            vec![Cell::text("Other time zone"), int(&t["otherTz"]), Cell::text(pct(&t["pctOtherTz"]))],
            vec![Cell::text("Newly late today"), int(&fleet["newlyLateToday"])],
            vec![Cell::text("Solved today"), int(&fleet["solvedToday"])],
            vec![Cell::text("Yesterday: became late"), int(&fleet["yesterday"]["newlyLate"])],
            vec![Cell::text("Yesterday: solved"), int(&fleet["yesterday"]["solved"]),
                 fleet["yesterday"]["averageLastedMs"].as_i64().map(|ms| Cell::text(format!("{} late on average", time::duration(ms)))).unwrap_or(Cell::Empty)],
        ];
        r.push(vec![Cell::Empty]);
        r.push(vec![Cell::head(format!("Delay reduced: devices back {} in the last", ln.under))]);
        for x in fleet["reduced"].as_array().into_iter().flatten() {
            r.push(vec![Cell::text(format!("{} h", n(&x["hours"]) as i64)), int(&x["n"])]);
        }
        r.push(vec![Cell::Empty]);
        r.push(vec![Cell::head("Cluster"), Cell::head("Time zone"), Cell::head("Devices"), Cell::head("Late now"), Cell::head("Today"), Cell::head("No delay"), Cell::head("Delayed"),
                    Cell::head("Critical"), Cell::head("Other time zone"), Cell::head("No delay, previous period"), Cell::head("Silent"), Cell::head("Worst device"), Cell::head("Worst (min)"),
                    Cell::head("Can't measure"), Cell::head("Levels (min)"), Cell::head("Last read"), Cell::head("Part delayed"), Cell::head("Log types late")]);
        for c in fleet["byCluster"].as_array().into_iter().flatten() {
            // A cluster whose last run measured nothing has no counts: 0 would read as none.
            let known = |v: &Value| if c["notMeasured"].is_string() { Cell::text("not known") } else { int(v) };
            r.push(vec![Cell::text(c["name"].as_str().unwrap_or("")), Cell::text(time_zone_text(&c["timeZone"])), int(&c["devices"]), known(&c["lateNow"]), known(&c["newToday"]),
                        Cell::text(match c["noDelayText"].as_str() { Some(s) => format!("{} · {s}", n(&c["noDelay"]) as i64), None => format!("no percentage: {}", c["notMeasured"].as_str().unwrap_or("no device")) }), known(&c["delay"]), known(&c["critical"]),
                        if c["timeZone"]["offsetMinutes"].is_null() { Cell::text("—") } else { known(&c["otherTz"]) },
                        Cell::text(pct(&c["belowPctPrevious"])), known(&c["silent"]),
                        Cell::text(c["worst"]["device"].as_str().unwrap_or("—")), c["worst"]["minutes"].as_f64().map(Cell::Dec).unwrap_or(Cell::Empty),
                        known(&c["cantMeasure"]), Cell::text(levels_text(&c["levels"])), Cell::text(read_text(c, now)), known(&c["partDelayed"]),
                        match c["logTypeWhy"].as_str() { Some(why) => Cell::text(why), None if c["notMeasured"].is_string() => Cell::text("not known"), None => types_late(&c["logTypes"]) }]);
        }
        r.push(vec![Cell::Empty]);
        r.push(vec![Cell::text(TZ_NOTE)]);
        r.push(vec![Cell::Empty]);
        r.push(vec![Cell::head("Zone"), Cell::head("tag1"), Cell::head("Devices"), Cell::head("Late now"), Cell::head("Critical"), Cell::head("Silent"), Cell::head("Part delayed")]);
        for (z, t1, n) in by_zone_tag(i) {
            let mut line = vec![Cell::text(z), Cell::text(t1)];
            line.extend(n.map(|x| Cell::Int(x as f64)));
            r.push(line);
        }
        out.push(Sheet { name: "Summary".into(), rows: r });
    }
    // Devices: always, with the chosen columns (the group first when it is not the cluster).
    {
        let mut head = vec![];
        if i.options.group_by != "cluster" {
            head.push(Cell::head(&i.options.group_by));
        }
        let cols = columns(i.options);
        head.extend(cols.iter().map(|c| Cell::head(column_label(c))));
        head.push(Cell::head("Step"));
        head.push(Cell::head("Likely why"));
        head.push(Cell::head("Fix"));
        head.push(Cell::head("Log types"));
        head.push(Cell::head("Delay is of log type"));
        head.push(Cell::head("Time part delayed"));
        let each = super::fixes::per_device(i.findings);
        let mut r = vec![head];
        for row in rows {
            let mut line = vec![];
            if i.options.group_by != "cluster" {
                line.push(Cell::text(row.extras.get(&i.options.group_by).cloned().unwrap_or_else(|| "—".into())));
            }
            line.extend(cols.iter().map(|c| column_cell(c, row, now)));
            match each.get(&(row.cluster.clone(), row.device.clone())) {
                Some(f) => { line.push(Cell::text(f.step.label())); line.push(Cell::text(&f.why)); line.push(Cell::text(&f.fix)); }
                None => { line.push(Cell::Empty); line.push(Cell::Empty); line.push(Cell::Empty); }
            }
            line.extend([Cell::text(types_text(row)), opt_text(&row.delay_log_type), Cell::text(time::duration(row.part_late_ms))]);
            r.push(line);
        }
        r.push(vec![Cell::text(format!("{} rows · {} · grouped by {}", rows.len(), i.options.devices.label(), i.options.group_by))]);
        out.push(Sheet { name: "Devices".into(), rows: r });
    }
    if i.options.has("windows") || i.options.has("lateEvery2h") {
        let mut r = vec![vec![Cell::head("Window"), Cell::head("Newly late"), Cell::head("Solved"), Cell::head("Still late"), Cell::head("Complete"), Cell::head("Part delayed")]];
        for w in windows {
            r.push(vec![Cell::text(w["label"].as_str().unwrap_or("")), int(&w["newlyLate"]), int(&w["solved"]), int(&w["stillLate"]),
                        Cell::text(if w["complete"] == true { "yes" } else { "so far" }), int(&w["partDelayed"])]);
        }
        r.push(vec![Cell::text(windows_note(&ln))]);
        out.push(Sheet { name: format!("Every {} hours", i.every_hours), rows: r });
    }
    if i.options.has("dayByDay") {
        let mut r = vec![vec![Cell::head("Day"), Cell::head("Devices"), Cell::head("On time"), Cell::head("Delayed"), Cell::head("Critical"),
                              Cell::head("Other time zone"), Cell::head("Clock ahead"), Cell::head("Silent"), Cell::head("Can't measure"), Cell::head("Started"), Cell::head("Solved"),
                              Cell::head("Late hours"), Cell::head("Median (min)"), Cell::head("Complete"), Cell::head("No delay"), Cell::head("No delay, split"),
                              Cell::head("Part delayed"), Cell::head("Log types late")]];
        for d in fleet["days"].as_array().into_iter().flatten() {
            // On time = measured under the delay line (`onTimeAll`: any old little-band count included).
            r.push(vec![Cell::text(d["day"].as_str().unwrap_or("")), int(&d["devices"]), int(&d["onTimeAll"]), int(&d["delayed"]), int(&d["critical"]),
                        int(&d["otherTz"]), int(&d["clockAhead"]), int(&d["silent"]), int(&d["unmeasured"]), int(&d["started"]), int(&d["solved"]),
                        d["lateHours"].as_f64().map(Cell::Dec).unwrap_or(Cell::Empty), d["medianMinutes"].as_f64().map(Cell::Dec).unwrap_or_else(|| Cell::text("not measured")),
                        Cell::text(if d["complete"] == true { "yes" } else { "so far" }), int(&d["noDelay"]), Cell::text(d["noDelayText"].as_str().unwrap_or("")),
                        int(&d["partDelayed"]), types_late(&d["logTypes"])]);
        }
        out.push(Sheet { name: "Day by day".into(), rows: r });
    }
    out.extend(log_types_sheet(i));
    if i.options.has("topDelayed") {
        let mut r = vec![vec![Cell::head("Device"), Cell::head("Cluster"), Cell::head("Zone"), Cell::head("tag1"), Cell::head("Delay now (min)"), Cell::head("Level"), Cell::head("Late since")]];
        for d in top {
            r.push(vec![Cell::text(&d.device), Cell::text(&d.cluster_name), opt_text(&d.zone), opt_text(&d.tag1), opt_min(d.now_minutes), Cell::text(d.state.label()),
                        d.late_since.map(|t| Cell::text(time::when(t, now))).unwrap_or(Cell::Empty)]);
        }
        out.push(Sheet { name: "Top delayed".into(), rows: r });
    }
    if i.options.has("fixes") {
        let mut r = vec![vec![Cell::head("Step"), Cell::head("Cluster"), Cell::head("Devices"), Cell::head("Zone"), Cell::head("tag1"), Cell::head("Group"), Cell::head("Likely why"), Cell::head("Fix"),
                              Cell::head("Evidence"), Cell::head("Not read")]];
        for f in i.findings {
            let name = i.clusters.iter().find(|c| c.id == f.cluster).map(|c| c.name.clone()).unwrap_or_else(|| f.cluster.clone());
            let (mut zones, mut tags) = (std::collections::BTreeSet::new(), std::collections::BTreeSet::new());
            for d in &f.devices {
                let (z, t1) = zone_tag(i, &f.cluster, d);
                zones.insert(z.unwrap_or_else(|| "—".into()));
                tags.insert(t1.unwrap_or_else(|| "—".into()));
            }
            r.push(vec![Cell::text(f.step.label()), Cell::text(name), Cell::text(format!("{} · {}", f.devices.len(), f.devices.iter().take(8).cloned().collect::<Vec<_>>().join(", "))),
                        Cell::text(zones.into_iter().collect::<Vec<_>>().join(", ")), Cell::text(tags.into_iter().collect::<Vec<_>>().join(", ")),
                        Cell::text(f.group.as_ref().map(|(k, v)| format!("{k} {v}")).unwrap_or_default()), Cell::text(&f.why), Cell::text(&f.fix),
                        Cell::text(evidence_line(&f.evidence)), Cell::text(f.missing.join("; "))]);
        }
        if i.findings.is_empty() {
            r.push(vec![Cell::text("No delay period in the range: nothing to match.")]);
        }
        out.push(Sheet { name: "Fixes".into(), rows: r });
    }
    out.push(about(i, fleet).sheet());
    out
}

/// What the workbook says about itself (`report::about`): how each cluster was last read, and
/// everything that was not.
fn about(i: &Inputs<'_>, fleet: &Value) -> crate::report::about::About {
    let mut a = crate::report::about::About {
        what: "ElasticPro log delay report".into(), period: range_label(i.range), built_at: i.now,
        days: Some("Days are the server's days (00:00 to 24:00 on its clock)."), ..Default::default()
    };
    a.clusters = fleet["byCluster"].as_array().into_iter().flatten()
        .map(|c| (format!("{} ({})", c["name"].as_str().unwrap_or(""), c["id"].as_str().unwrap_or("")),
                  c["lastRunAt"].as_i64().map(|t| format!("{} — {}", crate::report::about::stamp(t), read_text(c, i.now))).unwrap_or_else(|| "never measured".into()))).collect();
    a.notes = vec![
        NO_DELAY_NOTE.into(), TZ_NOTE.into(),
        "A device's state is the one of its last measurement. A delay period that is still open counts up to its last measurement, not to the time of this report, once more than one measurement interval (or the silence limit) has passed since.".into(),
    ];
    a.notes.extend(fleet["byCluster"].as_array().into_iter().flatten()
        .filter_map(|c| Some(format!("{}: {}", c["name"].as_str().unwrap_or(""), c["timeZone"]["windowNote"].as_str()?))));
    for c in i.clusters {
        match c.log_type_field() {
            (None, Some(why)) => a.notes.push(format!("{}: not read by log types ({why})", c.name)),
            _ if a.notes.iter().any(|x| x == LOG_TYPES_NOTE) => {}
            _ => a.notes.push(LOG_TYPES_NOTE.into()),
        }
        if let Some(t) = c.tracker.type_episodes_cut_ms.filter(|t| *t >= i.range.from_ms) {
            a.notes.push(format!("{}: log type delay periods that started up to {} are not all kept", c.name, time::when(t, i.now)));
        }
        if c.tracker.types_not_kept > 0 {
            a.notes.push(format!("{}: the last run read {} more log types than are kept; they count in their device's state, and have no row of their own", c.name, c.tracker.types_not_kept));
        }
        if c.tracker.types_unread > 0 {
            a.notes.push(format!("{}: {} devices were read without their log types, the last run's limit of {} log types was reached; their state is their newest document's", c.name, c.tracker.types_unread, crate::logdelay::measure::TYPES_PER_RUN));
        }
    }
    a.warnings = warnings(fleet, i.now);
    a
}

/// What "No delay" counts, said wherever it is shown.
pub const NO_DELAY_NOTE: &str = "No delay counts every device not shown to be late: on time, silent and can't measure (no readable event time, or a clock ahead); the split is written beside it. A silent or can't-measure device is never called on time.";

fn windows_note(l: &Lines) -> String {
    format!("Newly late: devices that reached {} of delay in that window. Solved: devices measured back {}. Still late: devices measured late and not yet solved when the window ended.", l.at, l.under)
}

/// The evidence object as one readable line.
pub fn evidence_line(e: &Value) -> String {
    let Some(o) = e.as_object() else { return String::new() };
    o.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| match v {
        Value::Array(a) => format!("{k}: {}", a.len()),
        Value::String(s) => format!("{k}: {s}"),
        other => format!("{k}: {other}"),
    }).collect::<Vec<_>>().join(" · ")
}

fn csv(i: &Inputs<'_>, rows: &[DeviceRow]) -> String {
    let mut s = String::new();
    let mut cols: Vec<String> = vec![];
    if i.options.group_by != "cluster" {
        cols.push(i.options.group_by.clone());
    }
    let chosen = columns(i.options);
    cols.extend(chosen.iter().cloned());
    s.push_str(&cols.iter().map(|c| csv_escape(&column_label(c))).collect::<Vec<_>>().join(","));
    s.push_str(",step,why,fix,last measured,event time field,note,log types,delay is of log type,time part delayed\n");
    let each = super::fixes::per_device(i.findings);
    for r in rows {
        let mut line: Vec<String> = vec![];
        if i.options.group_by != "cluster" {
            line.push(csv_escape(r.extras.get(&i.options.group_by).map(String::as_str).unwrap_or("")));
        }
        line.extend(chosen.iter().map(|c| csv_escape(&cell_text(&column_cell(c, r, i.now)))));
        let f = each.get(&(r.cluster.clone(), r.device.clone()));
        line.push(csv_escape(f.map(|f| f.step.label()).unwrap_or("")));
        line.push(csv_escape(f.map(|f| f.why.as_str()).unwrap_or("")));
        line.push(csv_escape(f.map(|f| f.fix.as_str()).unwrap_or("")));
        line.push(csv_escape(&r.last_measured_ms.map(crate::report::about::utc).unwrap_or_else(|| "never".into())));
        line.push(csv_escape(r.event_field.as_deref().unwrap_or("")));
        let mut note: Vec<String> = vec![];
        if r.stale || r.measured_until_ms.is_some() {
            note.push("not measured since: the delay and level are of then".into());
        }
        if let Some(why) = i.clusters.iter().find(|c| c.id == r.cluster).and_then(|c| c.tracker.not_measured(i.now)) {
            note.push(why);
        }
        line.push(csv_escape(&note.join("; ")));
        line.push(csv_escape(&types_text(r)));
        line.push(csv_escape(r.delay_log_type.as_deref().unwrap_or("")));
        line.push(csv_escape(&time::duration(r.part_late_ms)));
        s.push_str(&line.join(","));
        s.push('\n');
    }
    s
}

fn esc(s: &str) -> String {
    xlsx::xml_text(s)
}

fn step_colour(s: Step) -> &'static str {
    match s {
        Step::Elasticsearch => BLUE,
        Step::Forwarder | Step::LogType => ORANGE,
        Step::Parser => PINK,
        Step::DeviceClock | Step::DeviceLink | Step::DeviceTimeZone => GREEN,
        Step::Cluster => BLUE,
        Step::Unknown => LINE,
    }
}

/// The HTML body, matching the Mail board section for section.
pub fn html(i: &Inputs<'_>, fleet: &Value, windows: &[Value], top: &[&DeviceRow], headline: &str) -> String {
    let t = &fleet["totals"];
    let ln = Lines::of(i.clusters);
    let by_cluster = fleet["byCluster"].as_array().cloned().unwrap_or_default();
    let td = format!("padding:6px 8px;border-bottom:1px solid {LINE};font-size:13px;color:{INK};vertical-align:top");
    let th = format!("padding:6px 8px;border-bottom:2px solid {LINE};font-size:12px;color:{MUTED};text-align:left;font-weight:600");
    let tile = |num: String, label: &str, sub: &str, bg: &str| format!(
        "<td style=\"padding:10px 12px;background:{bg};border-radius:6px\"><div style=\"font-size:22px;font-weight:700;color:{INK}\">{}</div>\
         <div style=\"font-size:12px;color:{MUTED}\">{}</div><div style=\"font-size:12px;color:{INK}\">{}</div></td>", esc(&num), esc(label), esc(sub));
    let mut h = String::new();
    h.push_str(&format!("<!doctype html><html><body style=\"margin:0;padding:16px;background:#f6f7f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:{INK}\">"));
    h.push_str("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:720px;margin:0 auto;background:#fff;border:1px solid ");
    h.push_str(LINE);
    h.push_str(";border-radius:8px\"><tr><td style=\"padding:20px 24px\">");
    h.push_str(&format!("<div style=\"font-size:20px;font-weight:700\">Log delay report</div><div style=\"font-size:13px;color:{MUTED};margin-bottom:16px\">{} · {} cluster{} · {} devices · measured every {} hours</div>",
        esc(&range_label(i.range)), i.clusters.len(), if i.clusters.len() == 1 { "" } else { "s" },
        n(&t["devices"]) as i64, i.every_hours));
    if fleet["devicesInRange"].as_u64() == Some(0) {
        h.push_str(&format!("<div style=\"font-size:13px;padding:8px;background:{ORANGE};margin-bottom:8px\">No measurement in this period: nothing was measured between its start and end (the measurement runs every {} hours). The figures below are the devices' states now.</div>", i.every_hours));
    }
    if i.options.has("summary") {
        h.push_str(&format!("<div style=\"font-size:14px;font-weight:600;margin:12px 0 6px\">Summary · {}</div>", esc(&format!("{} cluster{}", i.clusters.len(), if i.clusters.len() == 1 { "" } else { "s" }))));
        h.push_str("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"6\"><tr>");
        h.push_str(&tile(format!("{}", n(&t["devices"]) as i64), "devices", &format!("{} measured", n(&t["measured"]) as i64), BLUE));
        // No cluster measured: no percentage, and no colour that reads as good.
        let none = !t["pctNoDelay"].is_number();
        h.push_str(&tile(pct(&t["pctNoDelay"]), "no delay", &format!("{} devices", n(&t["noDelay"]) as i64), if none { GREY } else { GREEN }));
        h.push_str(&tile(pct(&t["pctLate"]), "late", &format!("{} devices · {} delayed ({}) · {} critical ({})", n(&t["late"]) as i64, n(&t["delay"]) as i64, ln.band, n(&t["critical"]) as i64, ln.over), if none { GREY } else { late_colour(n(&t["late"]), n(&t["critical"])) }));
        if t["logTypes"].is_object() {
            h.push_str(&tile(format!("{}", n(&t["partDelayed"]) as i64), "part delayed", &format!("{} of {} log types late", n(&t["logTypes"]["late"]) as i64, n(&t["logTypes"]["total"]) as i64), PART));
        }
        h.push_str(&tile(format!("{}", n(&t["silent"]) as i64), "silent", "no logs for the silence limit", GREY));
        h.push_str("</tr></table>");
        h.push_str(&format!("<div style=\"font-size:13px;margin:6px 0 0\">{}</div>", esc(&no_delay_line(t))));
        h.push_str(&format!("<div style=\"font-size:11px;color:{MUTED}\">{}{}</div>", esc(NO_DELAY_NOTE), if t["logTypes"].is_object() { format!(" {}", esc(LOG_TYPES_NOTE)) } else { String::new() }));
        let y = &fleet["yesterday"];
        h.push_str(&format!("<div style=\"font-size:13px;margin:8px 0 0\">Yesterday: {} devices became late, {} were solved{}.</div>",
            n(&y["newlyLate"]) as i64, n(&y["solved"]) as i64,
            y["averageLastedMs"].as_i64().map(|ms| format!(" ({} late on average)", time::duration(ms))).unwrap_or_default()));
        if n(&t["unmeasured"]) > 0.0 {
            h.push_str(&format!("<div style=\"font-size:12px;color:{MUTED}\">{} device(s) could not be measured: no readable event time in their latest log.</div>", n(&t["unmeasured"]) as i64));
        }
        h.push_str(&format!("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">By cluster</div><table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Cluster</th><th style=\"{th}\">No delay</th><th style=\"{th}\">Late</th><th style=\"{th}\">Last read</th></tr>"));
        for c in &by_cluster {
            let unread = c["notMeasured"].is_string() || c["stale"] == true;
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td};background:{}\">{}</td><td style=\"{td}{}\">{}</td></tr>",
                esc(c["name"].as_str().unwrap_or("")), esc(c["noDelayText"].as_str().unwrap_or("no percentage")),
                if unread { GREY } else { late_colour(n(&c["lateNow"]), n(&c["critical"])) }, late_text(c),
                if unread { format!(";background:{GREY}") } else { String::new() }, esc(&read_text(c, i.now))));
        }
        h.push_str("</table>");
        let zones: Vec<String> = by_cluster.iter()
            .map(|c| format!("{}: {}", esc(c["name"].as_str().unwrap_or("")), esc(&time_zone_text(&c["timeZone"])))).collect();
        if !zones.is_empty() {
            h.push_str(&format!("<div style=\"font-size:12px;color:{MUTED};margin:8px 0 0\">Log time zone — {}. {}</div>", zones.join("; "), esc(TZ_NOTE)));
        }
        let zt = by_zone_tag(i);
        h.push_str("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">By zone and tag1 · now</div>");
        h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Zone</th><th style=\"{th}\">tag1</th><th style=\"{th}\">Devices</th><th style=\"{th}\">Late now</th><th style=\"{th}\">Critical</th><th style=\"{th}\">Silent</th></tr>"));
        for (z, t1, c) in zt.iter().take(ZONE_ROWS) {
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td};background:{}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td></tr>",
                esc(z), esc(t1), c[0], if c[1] + c[2] == 0 && c[3] == c[0] { GREY } else { late_colour(c[1] as f64, c[2] as f64) }, c[1], c[2], c[3]));
        }
        if zt.len() > ZONE_ROWS {
            h.push_str(&format!("<tr><td colspan=\"6\" style=\"{td};color:{MUTED}\">{} more zone · tag1 pairs in the attachment (Summary sheet)</td></tr>", zt.len() - ZONE_ROWS));
        }
        h.push_str("</table>");
    }
    if i.options.has("lateEvery2h") && !windows.is_empty() {
        let devices = n(&t["devices"]).max(1.0);
        let any_part = windows.iter().any(|w| n(&w["partDelayed"]) > 0.0);
        h.push_str(&format!("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Late devices every {} hours · {}</div>", i.every_hours, esc(&time::short_date(i.range.to.min(time::local_date(i.now))))));
        h.push_str("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\">");
        for w in windows {
            let late = n(&w["stillLate"]);
            let p = ((late / devices) * 100.0).clamp(0.0, 100.0).round() as i64;
            let part = match n(&w["partDelayed"]) {
                x if x > 0.0 => format!("<td style=\"width:{}%;background:{PART};height:8px;font-size:1px\">&nbsp;</td>", ((x / devices) * 100.0).clamp(1.0, 100.0).round() as i64),
                _ => String::new(),
            };
            h.push_str(&format!("<tr><td style=\"width:110px;font-size:12px;color:{MUTED};padding:2px 8px 2px 0\">{}</td><td style=\"padding:2px 0\">\
                <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr>\
                <td style=\"width:{p}%;background:{YELLOW};height:12px;font-size:1px\">&nbsp;</td>{part}<td style=\"background:{GREEN};height:12px;font-size:1px\">&nbsp;</td></tr></table></td>\
                <td style=\"width:90px;font-size:12px;padding-left:8px\">{} late{}</td></tr>", esc(w["label"].as_str().unwrap_or("")), late as i64, part_text(w)));
        }
        h.push_str(&format!("</table><div style=\"font-size:11px;color:{MUTED}\">yellow: measured late ({}) and not solved at the end of the window{} · green: the rest</div>", esc(&ln.at), if any_part { " · yellow edge: part delayed" } else { "" }));
    }
    if i.options.has("windows") && !windows.is_empty() {
        h.push_str(&format!("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Every {} hours · {}</div>", i.every_hours, esc(&time::short_date(i.range.to.min(time::local_date(i.now))))));
        h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Window</th><th style=\"{th}\">Newly late</th><th style=\"{th}\">Solved</th><th style=\"{th}\">Still late</th></tr>"));
        for w in windows {
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td};background:{YELLOW}\">{}</td><td style=\"{td};background:{GREEN}\">{}</td><td style=\"{td};background:{YELLOW}\">{}</td></tr>",
                esc(w["label"].as_str().unwrap_or("")), n(&w["newlyLate"]) as i64, n(&w["solved"]) as i64, n(&w["stillLate"]) as i64));
        }
        h.push_str(&format!("</table><div style=\"font-size:11px;color:{MUTED}\">{}</div>", esc(&windows_note(&ln))));
    }
    if i.options.has("dayByDay") {
        let days: Vec<&Value> = fleet["days"].as_array().map(|a| a.iter().rev().take(7).collect::<Vec<_>>()).unwrap_or_default().into_iter().rev().collect();
        h.push_str("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Day by day · last 7 days</div>");
        h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Day</th><th style=\"{th}\">Devices</th><th style=\"{th}\">No delay</th><th style=\"{th}\">Delayed</th><th style=\"{th}\">Critical</th><th style=\"{th}\">Part delayed</th><th style=\"{th}\">Silent</th><th style=\"{th}\">Started</th><th style=\"{th}\">Solved</th></tr>"));
        for d in &days {
            let dev = n(&d["devices"]).max(1.0);
            let bar = |v: f64, bg: &str| if v <= 0.0 { String::new() } else { format!("<span style=\"display:inline-block;width:{}px;height:8px;background:{bg}\"></span>", ((v / dev) * 120.0).round() as i64) };
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td></tr>",
                esc(d["day"].as_str().unwrap_or("")), n(&d["devices"]) as i64, n(&d["noDelay"]) as i64, n(&d["delayed"]) as i64, n(&d["critical"]) as i64,
                n(&d["partDelayed"]) as i64, n(&d["silent"]) as i64, n(&d["started"]) as i64, n(&d["solved"]) as i64));
            h.push_str(&format!("<tr><td colspan=\"9\" style=\"padding:0 8px 2px;font-size:1px\">{}{}{}{}{}{}</td></tr>",
                bar(n(&d["onTimeAll"]), GREEN), bar(n(&d["silent"]) + n(&d["cantMeasure"]), GREY), bar(n(&d["otherTz"]), VIOLET), bar(n(&d["partDelayed"]), PART), bar(n(&d["delayed"]), YELLOW), bar(n(&d["critical"]), RED)));
            h.push_str(&format!("<tr><td colspan=\"9\" style=\"padding:0 8px 6px;font-size:11px;color:{MUTED}\">{}</td></tr>", esc(d["noDelayText"].as_str().unwrap_or(""))));
        }
        if days.is_empty() {
            h.push_str(&format!("<tr><td colspan=\"9\" style=\"{td}\">No day with totals yet.</td></tr>"));
        }
        h.push_str("</table>");
    }
    if i.options.has("topDelayed") {
        h.push_str("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Top delayed</div>");
        h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Device</th><th style=\"{th}\">Cluster</th><th style=\"{th}\">Zone</th><th style=\"{th}\">tag1</th><th style=\"{th}\">Delay</th><th style=\"{th}\">Late since</th></tr>"));
        for d in top {
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td};background:{}\">{}</td><td style=\"{td}\">{}</td></tr>",
                esc(&d.device), esc(&d.cluster_name), esc(d.zone.as_deref().unwrap_or("—")), esc(d.tag1.as_deref().unwrap_or("—")), state_colour(d.state),
                esc(&top_delay(d, i.now)), d.late_since.map(|t| esc(&time::when(t, i.now))).unwrap_or_default()));
        }
        if top.is_empty() {
            h.push_str(&format!("<tr><td colspan=\"6\" style=\"{td}\">{}</td></tr>", none_late(&fleet["totals"])));
        }
        h.push_str("</table>");
    }
    if i.options.has("fixes") {
        h.push_str("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Recommended fixes</div>");
        let shown: Vec<&Finding> = i.findings.iter().filter(|f| f.step != Step::Unknown).take(3).collect();
        for f in &shown {
            h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin-bottom:6px\"><tr><td style=\"width:120px;padding:8px;background:{};font-weight:600;font-size:13px;border-radius:4px\">{}</td>\
                <td style=\"padding:8px;font-size:13px\">{} device{}{}. {} {}</td></tr></table>",
                step_colour(f.step), esc(f.step.label()), f.devices.len(), if f.devices.len() == 1 { "" } else { "s" },
                f.group.as_ref().map(|(k, v)| format!(" on {} {}", esc(k), esc(v))).unwrap_or_default(), esc(&cap(&f.why)), esc(&cap(&f.fix))));
        }
        if shown.is_empty() {
            h.push_str(&format!("<div style=\"font-size:13px;color:{MUTED}\">{}</div>", if i.findings.is_empty() { "No delay period in the range: nothing to match." } else { "Late devices, but no pattern matched yet: not enough evidence, nothing guessed." }));
        }
        h.push_str(&format!("<div style=\"font-size:11px;color:{MUTED}\">Each fix is matched from the delay pattern and its evidence; the full list with evidence is in the report and the attachment.</div>"));
    }
    if let Some(url) = i.app_url {
        h.push_str(&format!("<div style=\"margin-top:18px;font-size:13px\"><a href=\"{}\" style=\"color:#1a5fb4\">Open the full report in ElasticPro ›</a></div>", esc(url)));
    }
    h.push_str(&format!("<div style=\"margin-top:14px;font-size:11px;color:{MUTED}\">{} · ElasticPro</div>", esc(headline)));
    h.push_str("</td></tr></table></body></html>");
    h
}

/// A late device's delay and level in words, with when it was measured if not lately.
fn top_delay(d: &DeviceRow, now: i64) -> String {
    let m = d.now_minutes.map(time::minutes).unwrap_or_else(|| "can't measure".into());
    if d.stale || d.measured_until_ms.is_some() { format!("{m} · {}", summary::state_text(d, now)) } else { format!("{m} · {}", d.state.label()) }
}

/// An empty list of late devices: none late, or nothing measured to say so.
fn none_late(t: &Value) -> String {
    match (n(&t["measured"]) > 0.0, n(&t["partDelayed"]) as i64) {
        (false, _) => "No device was measured.".into(),
        (true, 0) => "No device is late.".into(),
        (true, p) => format!("No device is late with all its log types; {p} part delayed."),
    }
}

/// ` · 2 part delayed`, when there are any.
fn part_text(v: &Value) -> String {
    match n(&v["partDelayed"]) as i64 { 0 => String::new(), p => format!(" · {p} part delayed") }
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// The plain-text copy of the mail.
pub fn text(i: &Inputs<'_>, fleet: &Value, windows: &[Value], top: &[&DeviceRow], headline: &str) -> String {
    let t = &fleet["totals"];
    let ln = Lines::of(i.clusters);
    let mut s = format!("ElasticPro log delay report · {}\n{} cluster(s) · {} devices, {} measured · measured every {} hours\n\n", range_label(i.range), i.clusters.len(), n(&t["devices"]) as i64, n(&t["measured"]) as i64, i.every_hours);
    s.push_str(&format!("Summary: {} · no delay {} ({}) · late {} ({}) · delayed, {} {} · critical, {} {} · silent {} · can't measure {}\n{}. {NO_DELAY_NOTE}\n",
        headline, n(&t["noDelay"]) as i64, pct(&t["pctNoDelay"]), n(&t["late"]) as i64, pct(&t["pctLate"]), ln.band, n(&t["delay"]) as i64, ln.over, n(&t["critical"]) as i64,
        n(&t["silent"]) as i64, n(&t["cantMeasure"]) as i64, no_delay_line(t)));
    if let (Some(a), Some(b)) = (t["logTypes"]["late"].as_u64(), t["logTypes"]["total"].as_u64()) {
        s.push_str(&format!("Part delayed {} ({}) · log types late {a} of {b}. {LOG_TYPES_NOTE}\n", n(&t["partDelayed"]) as i64, pct(&t["pctPartDelayed"])));
    }
    s.push_str("By cluster\n");
    for c in fleet["byCluster"].as_array().into_iter().flatten() {
        s.push_str(&format!("  {} · {} · late {} · {}\n", c["name"].as_str().unwrap_or(""), c["noDelayText"].as_str().unwrap_or("no percentage"),
            late_text(c), read_text(c, i.now)));
    }
    let y = &fleet["yesterday"];
    if fleet["devicesInRange"].as_u64() == Some(0) {
        s.push_str(&format!("No measurement in this period (the measurement runs every {} hours): the figures are the devices' states now.\n", i.every_hours));
    }
    s.push_str(&format!("Yesterday: {} became late, {} solved{}\n", n(&y["newlyLate"]) as i64, n(&y["solved"]) as i64,
        y["averageLastedMs"].as_i64().map(|ms| format!(" ({} late on average)", time::duration(ms))).unwrap_or_default()));
    let zones: Vec<String> = fleet["byCluster"].as_array().into_iter().flatten()
        .map(|c| format!("{}: {}", c["name"].as_str().unwrap_or(""), time_zone_text(&c["timeZone"]))).collect();
    if !zones.is_empty() {
        s.push_str(&format!("Log time zone — {}. {TZ_NOTE}\n", zones.join("; ")));
    }
    s.push('\n');
    if i.options.has("windows") && !windows.is_empty() {
        s.push_str(&format!("Every {} hours · window: newly late / solved / still late\n", i.every_hours));
        for w in windows {
            s.push_str(&format!("  {}  {} / {} / {}\n", w["label"].as_str().unwrap_or(""), n(&w["newlyLate"]) as i64, n(&w["solved"]) as i64, n(&w["stillLate"]) as i64));
        }
        s.push('\n');
    }
    if i.options.has("dayByDay") {
        s.push_str("Day by day · day: devices / no delay / delayed / critical / silent / started / solved\n");
        for d in fleet["days"].as_array().into_iter().flatten().rev().take(7).collect::<Vec<_>>().into_iter().rev() {
            s.push_str(&format!("  {}  {} / {} / {} / {} / {} / {} / {}{} · {}\n", d["day"].as_str().unwrap_or(""), n(&d["devices"]) as i64, n(&d["noDelay"]) as i64,
                n(&d["delayed"]) as i64, n(&d["critical"]) as i64, n(&d["silent"]) as i64, n(&d["started"]) as i64, n(&d["solved"]) as i64, part_text(d), d["noDelayText"].as_str().unwrap_or("")));
        }
        s.push('\n');
    }
    if i.options.has("topDelayed") {
        s.push_str("Top delayed\n");
        for d in top {
            s.push_str(&format!("  {} · {} · zone {} · tag1 {} · {} · late since {}\n", d.device, d.cluster_name, d.zone.as_deref().unwrap_or("—"), d.tag1.as_deref().unwrap_or("—"),
                top_delay(d, i.now),
                d.late_since.map(|x| time::when(x, i.now)).unwrap_or_else(|| "—".into())));
        }
        if top.is_empty() {
            s.push_str(&format!("  {}\n", none_late(t)));
        }
        s.push('\n');
    }
    if i.options.has("fixes") {
        s.push_str("Recommended fixes\n");
        for f in i.findings.iter().filter(|f| f.step != Step::Unknown).take(3) {
            s.push_str(&format!("  {} · {} device(s){} · {} · {}\n", f.step.label(), f.devices.len(),
                f.group.as_ref().map(|(k, v)| format!(" on {k} {v}")).unwrap_or_default(), f.why, f.fix));
        }
        if i.findings.iter().all(|f| f.step == Step::Unknown) {
            s.push_str("  nothing matched: not enough evidence, nothing guessed\n");
        }
        s.push('\n');
    }
    if let Some(url) = i.app_url {
        s.push_str(&format!("Open the full report in ElasticPro: {url}\n"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logdelay::levels::Levels;
    use crate::logdelay::measure::Reading;
    use crate::logdelay::state::Tracker;
    use std::collections::BTreeMap;

    const H: i64 = 3_600_000;

    fn input(now: i64) -> ClusterInput {
        let mut t = Tracker::default();
        let l = Levels::default();
        let rd = |d: &str, m: f64, at: i64| {
            let mut extras = BTreeMap::new();
            extras.insert("Zone".to_string(), "dc1".to_string());
            extras.insert("fwd_tag".to_string(), "syslog-1".to_string());
            Reading { device: d.into(), docs: 50, arrival_ms: Some(at), event_ms: Some(at - (m * 60_000.0) as i64), delay_minutes: Some(m), event_field: Some("event_created".into()), extras, ..Reading::default() }
        };
        t.apply(now - 4 * H, vec![rd("fw-1", 45.0, now - 4 * H), rd("fw-2", 2.0, now - 4 * H), rd("fw-3", 20.0, now - 4 * H)], &l, 2 * H);
        t.apply(now - 2 * H, vec![rd("fw-1", 94.0, now - 2 * H), rd("fw-2", 2.0, now - 2 * H), rd("fw-3", 20.0, now - 2 * H)], &l, 2 * H);
        let key = time::local_day_key(now);
        let (f, to) = time::day_bounds(time::local_date(now));
        let mut daily = BTreeMap::new();
        daily.insert(key.clone(), crate::logdelay::state::daily(&t, &key, f, to, now));
        ClusterInput { id: "prod".into(), name: "Production".into(), tracker: std::sync::Arc::new(t), daily, levels: l, zone: crate::logdelay::tz::LogTimeZone::Detect, tz_hints: vec![] }
    }

    #[test]
    fn a_hostile_device_name_is_inert_in_the_mail_and_the_csv() {
        let now = chrono::Utc::now().timestamp_millis();
        let mut t = Tracker::default();
        let l = Levels::default();
        let evil = "=HYPERLINK(\"http://x\")<script>alert('1')</script>, \"q\"";
        let rd = Reading { device: evil.into(), docs: 5, arrival_ms: Some(now), event_ms: Some(now - 90 * 60_000), delay_minutes: Some(90.0), ..Reading::default() };
        t.apply(now, vec![rd], &l, 2 * H);
        let clusters = vec![ClusterInput { id: "prod".into(), name: "<b>Prod</b>".into(), tracker: std::sync::Arc::new(t), daily: BTreeMap::new(), levels: l, zone: crate::logdelay::tz::LogTimeZone::Detect, tz_hints: vec![] }];
        let r = Range::last_days(now, 7);
        let opts = Options::default();
        let i = Inputs { clusters: &clusters, range: &r, now, every_hours: 2, findings: &[], options: &opts, extras: &[], app_url: None };
        let b = build(&i).unwrap();
        assert!(!b.html.contains("<script>") && b.html.contains("&lt;script&gt;"), "{}", b.html);
        assert!(!b.html.contains("<b>Prod</b>") && b.html.contains("&lt;b&gt;Prod"), "{}", b.html);
        let csv = String::from_utf8(b.csv.unwrap()).unwrap();
        let line = csv.lines().nth(1).unwrap();
        assert!(line.starts_with("\"'=HYPERLINK("), "a leading = is neutralised and the cell quoted: {line}");
        assert!(line.contains("\"\"q\"\""), "quotes are doubled: {line}");
        assert_eq!(csv.lines().count(), 2, "no cell starts a new record: {csv}");
    }

    #[test]
    fn a_device_name_starting_with_plus_is_not_a_formula_in_the_csv() {
        let now = chrono::Utc::now().timestamp_millis();
        let mut t = Tracker::default();
        let l = Levels::default();
        let plus = "+cmd|' /C calc'!A0";
        let rd = Reading { device: plus.into(), docs: 5, arrival_ms: Some(now), event_ms: Some(now - 90 * 60_000), delay_minutes: Some(90.0), ..Reading::default() };
        t.apply(now, vec![rd], &l, 2 * H);
        let clusters = vec![ClusterInput { id: "prod".into(), name: "Prod".into(), tracker: std::sync::Arc::new(t), daily: BTreeMap::new(), levels: l, zone: crate::logdelay::tz::LogTimeZone::Detect, tz_hints: vec![] }];
        let r = Range::last_days(now, 7);
        let opts = Options::default();
        let i = Inputs { clusters: &clusters, range: &r, now, every_hours: 2, findings: &[], options: &opts, extras: &[], app_url: None };
        let csv = String::from_utf8(build(&i).unwrap().csv.unwrap()).unwrap();
        let line = csv.lines().nth(1).unwrap();
        assert!(line.starts_with("'+cmd|"), "a leading + is neutralised: {line}");
        assert!(!csv.lines().skip(1).any(|l| l.starts_with('+')), "{csv}");
    }

    #[test]
    fn options_take_the_boards_choices_and_refuse_unknown_columns() {
        let extras = vec!["Zone".to_string(), "tag1".to_string()];
        let o = Options::default().apply(&json!({ "devices": "all", "groupBy": "Zone", "columns": ["device", "Zone", "nowMinutes"], "sections": ["summary", "fixes"], "csv": false }), &extras).unwrap();
        assert_eq!((o.devices, o.group_by.as_str(), o.csv, o.xlsx), (DevicesFilter::All, "Zone", false, true));
        assert!(o.has("fixes") && !o.has("dayByDay"));
        assert!(Options::default().apply(&json!({ "columns": ["device", "nope"] }), &extras).unwrap_err().contains("nope"));
        assert!(Options::default().apply(&json!({ "groupBy": "parser_tag" }), &extras).unwrap_err().contains("parser_tag"));
        assert!(Options::default().apply(&json!({ "devices": "some" }), &extras).is_err());
        let v = serde_json::to_value(Options::default()).unwrap();
        assert_eq!(v["devices"], "delayed");
        assert_eq!(v["groupBy"], "cluster");
    }

    #[test]
    fn the_build_makes_every_sheet_a_csv_and_a_mail_with_one_colour_per_state() {
        let now = chrono::Utc::now().timestamp_millis();
        let c = input(now);
        let r = Range::last_days(now, 7);
        let extras = vec!["Zone".to_string(), "tag1".to_string(), "fwd_tag".to_string(), "parser_tag".to_string()];
        let findings = crate::logdelay::fixes::findings("prod", &c.tracker, r.from_ms, r.to_ms, now, 2 * H, &Default::default(), &crate::logdelay::tz::LogTimeZone::Detect);
        let clusters = vec![c];
        let opts = Options::default();
        let i = Inputs { clusters: &clusters, range: &r, now, every_hours: 2, findings: &findings, options: &opts, extras: &extras, app_url: Some("https://ep.example/reports/logdelay") };
        let b = build(&i).unwrap();
        assert_eq!(b.headline, "1 devices late, 1 critical");
        let parts = crate::report::zip::read(b.xlsx.as_ref().unwrap()).unwrap();
        let wb = std::str::from_utf8(&parts.iter().find(|(n, _)| n == "xl/workbook.xml").unwrap().1).unwrap().to_string();
        for name in ["Summary", "Devices", "Every 2 hours", "Day by day", "Top delayed", "Fixes", "About"] {
            assert!(wb.contains(&format!("name=\"{name}\"")), "{name} sheet missing: {wb}");
        }
        let csv = String::from_utf8(b.csv.unwrap()).unwrap();
        assert!(csv.starts_with("Device,Cluster,Delay now (min),Level"), "{csv}");
        assert_eq!(csv.lines().count(), 2, "only the delayed device: {csv}");
        assert!(csv.contains("fw-1,Production,94.00,critical"), "{csv}");
        assert!(b.html.contains("Log delay report") && b.html.contains("Top delayed") && b.html.contains("fw-1"));
        assert!(b.html.contains("Open the full report in ElasticPro"));
        // The owner's rule of 2026-11-24 (it replaced "never red with yellow"): critical light red,
        // delayed light yellow, on time light green, the word always written beside the colour.
        for strong in ["#ff0000", "#f00;", "#ffff00", ":red", ": red", "background:#d9534f"] {
            assert!(!b.html.to_ascii_lowercase().contains(strong), "{strong}: a light ground, not a strong one");
        }
        for wanted in [GREEN, YELLOW, RED] {
            assert!(b.html.contains(wanted), "{wanted} missing from the mail");
        }
        assert!(b.html.contains(&format!("background:{RED}\">1 h 34 min · critical")) || b.html.contains("· critical</td>"), "{}", b.html);
        assert_eq!([State::Critical, State::Delay, State::NoDelay, State::OtherTz, State::Silent, State::Unmeasured, State::ClockAhead, State::PartDelay].map(state_colour),
                   [RED, YELLOW, GREEN, VIOLET, GREY, GREY, GREY, PART]);
        assert!(b.html.contains("No delay 66.7 % (on time 66.7 % · silent 0 % · can't measure 0 %)") || b.html.contains("No delay 66.7 % (on time 66.7 % · silent 0 % · can&#39;t"), "{}", b.html);
        assert!(b.text.contains("No delay 66.7 % (on time 66.7 % · silent 0 % · can't measure 0 %)") && b.text.contains("Production · No delay"), "{}", b.text);
        assert!(b.text.contains("delayed, 30–60 min 0") && b.text.contains("last run "), "{}", b.text);
        assert!(b.text.contains("1 devices late, 1 critical") && b.text.contains("Top delayed"));
        // All devices, grouped by Zone: three rows, the group column first.
        let all = Options::default().apply(&json!({ "devices": "all", "groupBy": "Zone", "xlsx": false }), &extras).unwrap();
        let i2 = Inputs { options: &all, ..i };
        let b2 = build(&i2).unwrap();
        assert!(b2.xlsx.is_none());
        let csv2 = String::from_utf8(b2.csv.unwrap()).unwrap();
        assert!(csv2.starts_with("Zone,Device,"), "{csv2}");
        assert_eq!(csv2.lines().count(), 4);
        // Columns chosen without Zone and tag1: both are still there, after the cluster.
        let bare = Options::default().apply(&json!({ "devices": "all", "columns": ["device", "cluster", "nowMinutes"] }), &extras).unwrap();
        let i3 = Inputs { options: &bare, ..i };
        let b3 = build(&i3).unwrap();
        let csv3 = String::from_utf8(b3.csv.unwrap()).unwrap();
        assert!(csv3.starts_with("Device,Cluster,Zone,tag1,Delay now (min),"), "{csv3}");
        assert!(csv3.contains("fw-1,Production,dc1,,94.00"), "tag1 not in these logs: empty, not invented: {csv3}");
        assert!(b3.html.contains("By zone and tag1") && b3.html.contains(">dc1<"), "{}", b3.html);
        assert!(b3.text.contains("zone dc1"), "{}", b3.text);
        let parts = crate::report::zip::read(b3.xlsx.as_ref().unwrap()).unwrap();
        let shared: String = parts.iter().filter(|(n, _)| n.starts_with("xl/")).map(|(_, b)| String::from_utf8_lossy(b).to_string()).collect();
        for want in ["Zone", "tag1"] {
            assert!(shared.matches(want).count() >= 4, "{want} in the Summary, Devices, Top delayed and Fixes sheets");
        }
    }

    #[test]
    fn the_time_zone_is_said_in_words_and_as_a_column() {
        use serde_json::json;
        assert_eq!(time_zone_text(&json!({ "mode": "detected", "zone": "Asia/Kolkata", "offset": "+05:30", "pct": 89.7 })), "Asia/Kolkata +05:30 · detected (90 % agree)");
        assert_eq!(time_zone_text(&json!({ "mode": "detected", "zone": null, "offset": "+08:00", "pct": 100.0 })), "+08:00 · detected (100 % agree)", "no name invented");
        assert_eq!(time_zone_text(&json!({ "mode": "set", "zone": "UTC", "offset": "+00:00" })), "UTC +00:00 · set");
        assert_eq!(time_zone_text(&json!({ "mode": "none", "pct": 41.2 })), "not detected (41 % agree)");
        assert_eq!(time_zone_text(&json!({ "mode": "none" })), "not detected");
        assert_eq!(time_zone_text(&Value::Null), "—");
        let now = chrono::Utc::now().timestamp_millis();
        let mut r = DeviceRow { device: "d".into(), cluster: "c".into(), cluster_name: "C".into(), state: State::OtherTz, now_minutes: Some(1.0),
            raw_gap_minutes: Some(481.0), tz_offset_minutes: Some(480), device_tz_offset: Some(480), cluster_tz_offset: Some(330), in_last_run: true, ..DeviceRow::default() };
        assert_eq!(device_time_zone(&r), "+08:00");
        assert_eq!(cell_text(&column_cell("rawGap", &r, now)), "481.00");
        r.state = State::Delay; r.tz_offset_minutes = Some(330); r.now_minutes = Some(40.0); r.raw_gap_minutes = Some(370.0);
        assert_eq!(device_time_zone(&r), "same as cluster");
        r.cluster_tz_offset = None; r.tz_offset_minutes = None;
        assert_eq!(device_time_zone(&r), "—", "no cluster zone: nothing to compare against");
        r.cluster_tz_offset = Some(330); r.state = State::Silent;
        assert_eq!(device_time_zone(&r), "—");
        assert!(BASE_COLUMNS.contains(&"eventField") && BASE_COLUMNS.contains(&"rawGap") && BASE_COLUMNS.contains(&"deviceTimeZone"));
    }

    #[test]
    fn the_levels_in_the_report_are_the_clusters_own_and_each_says_how_it_was_read() {
        let now = chrono::Utc::now().timestamp_millis();
        let mut a = input(now);
        a.levels = Levels { no_delay_under: 45.0, delay_from: 45.0, critical_over: 90.0 };
        let ln = Lines::of(&[a]);
        assert_eq!((ln.under.as_str(), ln.band.as_str(), ln.over.as_str()), ("under 45 min", "45–90 min", "above 90 min"));
        let mut a = input(now);
        a.levels = Levels { no_delay_under: 45.0, delay_from: 45.0, critical_over: 90.0 };
        let mut t = (*a.tracker).clone();
        t.last_read = Some(crate::logdelay::collect::RunInfo { at: now, devices: 5000, truncated: true, max_devices: Some(5000), ..Default::default() });
        a.tracker = std::sync::Arc::new(t);
        let mut never = input(now);
        never.id = "new".into();
        never.name = "New".into();
        never.tracker = std::sync::Arc::new(Tracker::default());
        let clusters = vec![a, never];
        assert_eq!(Lines::of(&clusters).band, "between the lines", "no one figure is true of both");
        let r = Range::last_days(now, 7);
        let opts = Options::default();
        let i = Inputs { clusters: &clusters, range: &r, now, every_hours: 2, findings: &[], options: &opts, extras: &[], app_url: None };
        let b = build(&i).unwrap();
        assert!(b.text.contains("5000 devices read, list cut at 5000") && b.text.contains("New · no percentage · late not known · never measured"), "{}", b.text);
        assert!(b.text.contains("1 of 2 clusters; the others were not measured") && !b.text.contains("30–60 min"), "{}", b.text);
        assert!(b.html.contains("never measured"));
        let parts = crate::report::zip::read(b.xlsx.as_ref().unwrap()).unwrap();
        let all: String = parts.iter().filter(|(n, _)| n.starts_with("xl/")).map(|(_, b)| String::from_utf8_lossy(b).to_string()).collect();
        assert!(all.contains("45 / 90") && all.contains("never measured") && !all.contains("30–60"));
    }

    #[test]
    fn started_solved_reads_as_the_board_shows_it() {
        let now = chrono::Utc::now().timestamp_millis();
        let mut r = DeviceRow { device: "d".into(), cluster: "c".into(), cluster_name: "C".into(), state: State::Critical, now_minutes: Some(94.0),
            raw_gap_minutes: Some(94.0), episodes: 1, last_started: Some(now - H), late_since: Some(now - H), in_last_run: true, ..DeviceRow::default() };
        assert!(started_solved(&r, now).ends_with("→ still late"));
        r.stale = true;
        r.last_measured_ms = Some(now - H);
        let s = started_solved(&r, now);
        assert!(s.contains("late when last measured") && s.ends_with("not measured since") && !s.contains("still late"), "{s}");
        r.late_since = None;
        r.last_ended_why = Some("time zone changed".into());
        assert!(started_solved(&r, now).ends_with("→ not solved (time zone changed)"));
        r.last_solved = Some(now);
        assert!(started_solved(&r, now).contains(" → today "));
        r.state = State::Silent;
        r.silent_since = Some(now - 2 * H);
        assert!(started_solved(&r, now).starts_with("no logs since "));
    }

    #[test]
    fn the_report_lists_the_log_types_and_counts_part_delayed_apart() {
        use crate::logdelay::measure::{LogTypeField, TypeReading};
        let now = chrono::Utc::now().timestamp_millis();
        let l = Levels::default();
        let mut t = Tracker { interval_ms: Some(2 * H), ..Tracker::default() };
        let typed = |d: &str, at: i64, types: &[(&str, f64)]| Reading {
            device: d.into(), docs: 5, arrival_ms: Some(at), event_ms: Some(at), delay_minutes: Some(types[0].1),
            types: Some(types.iter().map(|(n, m)| TypeReading { log_type: Some(n.to_string()), docs: 1, arrival_ms: Some(at), event_ms: Some(at), delay_minutes: Some(*m), event_field: None }).collect()),
            ..Reading::default() };
        for k in [1, 0] {
            let at = now - k * 2 * H;
            t.apply(at, vec![typed("fw-1", at, &[("traffic", 1.0), ("<i>threat</i>", 46.0)]), typed("fw-2", at, &[("traffic", 1.0), ("system", 2.0)])], &l, 2 * H);
        }
        t.last_read = Some(crate::logdelay::collect::RunInfo { at: now, devices: 2, complete: true, log_type: Some(LogTypeField { field: Some("log_type".into()), why: None }), ..Default::default() });
        let key = time::local_day_key(now);
        let (a, b) = time::day_bounds(time::local_date(now));
        let daily = [(key.clone(), crate::logdelay::state::daily(&t, &key, a, b, now))].into();
        let typed_cluster = ClusterInput { id: "prod".into(), name: "Production".into(), tracker: std::sync::Arc::new(t), daily, levels: l, zone: crate::logdelay::tz::LogTimeZone::Utc, tz_hints: vec![] };
        let mut plain = input(now);
        plain.name = "Plain".into();
        let clusters = vec![typed_cluster, plain];
        let r = Range::last_days(now, 7);
        let findings = crate::logdelay::fixes::log_type_findings("prod", &clusters[0].tracker, now);
        let opts = Options::default();
        let i = Inputs { clusters: &clusters, range: &r, now, every_hours: 2, findings: &findings, options: &opts, extras: &[], app_url: None };
        let b = build(&i).unwrap();
        assert_eq!(b.headline, "1 devices late, 1 critical, 1 part delayed");
        let parts = crate::report::zip::read(b.xlsx.as_ref().unwrap()).unwrap();
        let all: String = parts.iter().filter(|(n, _)| n.starts_with("xl/")).map(|(_, b)| String::from_utf8_lossy(b).to_string()).collect();
        for want in ["name=\"Log types\"", "Part delayed (some of its log types late)", "1 of 4", "1 of 2 log types late: &lt;i&gt;threat&lt;/i&gt;", "Log type path", "Plain: not read by log types (mapping not read)", "not read"] {
            assert!(all.contains(want), "{want}: {all}");
        }
        let sheet = log_types_sheet(&i).unwrap();
        assert_eq!(sheet.rows.len(), 3, "the head, the one period, the note: {:?}", sheet.rows);
        let cells: Vec<String> = sheet.rows[1].iter().map(cell_text).collect();
        assert!(cells[..5] == ["Production", "fw-1", "<i>threat</i>", "delayed", "46.00"] && cells[5].ends_with("→ still late") && cells[7] == "46.00", "{cells:?}");
        let everything = Options { devices: DevicesFilter::All, ..Options::default() };
        assert_eq!(log_types_sheet(&Inputs { options: &everything, ..i }).unwrap().rows.len(), 6, "every log type");
        assert!(log_types_sheet(&Inputs { clusters: &clusters[1..], ..i }).is_none(), "no cluster read by them: no sheet of nothing");
        let csv = String::from_utf8(b.csv.unwrap()).unwrap();
        assert!(csv.lines().next().unwrap().ends_with(",note,log types,delay is of log type,time part delayed"), "{csv}");
        let line = csv.lines().find(|l| l.starts_with("fw-1,Production")).unwrap();
        assert!(line.contains("1 of 2 log types late: <i>threat</i>") && line.contains("part delayed"), "{line}");
        assert!(!b.html.contains("<i>threat") && b.html.contains("part delayed") && b.html.contains(PART), "{}", b.html);
        assert!(b.text.contains("Part delayed 1 (20 %)") || b.text.contains("Part delayed 1 (20.0 %)"), "{}", b.text);
        assert!(b.text.contains("log types late 1 of 4"), "{}", b.text);
        assert!(!b.text.contains("late 2 ("), "part delayed is no late device: {}", b.text);
    }
}
