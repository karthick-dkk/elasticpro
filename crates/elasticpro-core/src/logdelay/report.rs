//! The `log_delay` report: its options, the workbook (one sheet per section, a Fixes sheet),
//! the CSV device list, and the mail — HTML with a plain-text copy (docs/LOGDELAY.md
//! "Report kind log_delay"; the Mail and Storage boards).
//!
//! Every figure is `summary.rs`'s; this file only lays them out. The mail's tables are
//! email-safe: `<table>`, inline styles, no script, no external image. Its four colours
//! are light green, blue, pink and orange — never red with yellow (the owner's rule).

use super::fixes::{Finding, Step};
use super::levels::State;
use super::summary::{self, ClusterInput, DeviceRow, Range};
use super::time;
use crate::report::build::csv_escape;
use crate::report::xlsx::{self, Cell, Sheet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const GREEN: &str = "#DDF3E4";
pub const BLUE: &str = "#DCEBFA";
pub const PINK: &str = "#FBDCE6";
pub const ORANGE: &str = "#FDE4CC";
const INK: &str = "#1b1f24";
const MUTED: &str = "#5b6470";
const LINE: &str = "#e3e6ea";
/// Zone · tag1 pairs the mail lists; the rest are in the Summary sheet.
const ZONE_ROWS: usize = 12;

/// Which devices the device list carries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DevicesFilter {
    /// 30 min or more now (delay and critical).
    #[default]
    Delayed,
    /// 15 min or more now (little delay too).
    Little,
    All,
}

impl DevicesFilter {
    pub fn parse(s: &str) -> Option<DevicesFilter> {
        match s {
            "delayed" => Some(DevicesFilter::Delayed),
            "little" => Some(DevicesFilter::Little),
            "all" => Some(DevicesFilter::All),
            _ => None,
        }
    }
    pub fn keeps(self, s: State) -> bool {
        match self {
            DevicesFilter::Delayed => s.late(),
            DevicesFilter::Little => s.late() || s == State::Little,
            DevicesFilter::All => true,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            DevicesFilter::Delayed => "devices delayed 30 min or more",
            DevicesFilter::Little => "devices delayed 15 min or more",
            DevicesFilter::All => "all devices",
        }
    }
}

pub const SECTIONS: [&str; 6] = ["summary", "lateEvery2h", "windows", "dayByDay", "topDelayed", "fixes"];
pub const BASE_COLUMNS: [&str; 13] = ["device", "cluster", "nowMinutes", "level", "startedSolved", "median", "max", "episodes", "lateTime", "docsPerDay",
                                      "arrival", "eventTime", "lateSince"];

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
            self.devices = d.as_str().and_then(DevicesFilter::parse).ok_or("options.devices must be delayed, little or all")?;
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
/// critical, silent — the most late first. A device whose logs carry no Zone or tag1 is under
/// "—" (not known), never left out.
pub fn by_zone_tag(i: &Inputs<'_>) -> Vec<(String, String, [u64; 4])> {
    let mut m: std::collections::BTreeMap<(String, String), [u64; 4]> = std::collections::BTreeMap::new();
    for c in i.clusters {
        for d in c.tracker.devices.values() {
            let k = (super::extra_ci(&d.extras, "Zone").cloned().unwrap_or_else(|| "—".into()), super::extra_ci(&d.extras, "tag1").cloned().unwrap_or_else(|| "—".into()));
            let e = m.entry(k).or_default();
            e[0] += 1;
            e[1] += d.state.late() as u64;
            e[2] += (d.state == State::Critical) as u64;
            e[3] += (d.state == State::Silent) as u64;
        }
    }
    let mut v: Vec<(String, String, [u64; 4])> = m.into_iter().map(|((z, t), n)| (z, t, n)).collect();
    v.sort_by(|a, b| b.2[1].cmp(&a.2[1]).then(b.2[0].cmp(&a.2[0])).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    v
}

fn column_label(c: &str) -> String {
    match c {
        "device" => "Device", "cluster" => "Cluster", "nowMinutes" => "Delay now (min)", "level" => "Level", "startedSolved" => "Last delay: started → solved",
        "median" => "Median (min)", "max" => "Max (min)", "episodes" => "Delays", "lateTime" => "Time late", "docsPerDay" => "Logs a day",
        "arrival" => "Arrival", "eventTime" => "Event time", "lateSince" => "Late since", other => other,
    }.to_string()
}

fn column_cell(c: &str, r: &DeviceRow, now: i64) -> Cell {
    match c {
        "device" => Cell::text(&r.device),
        "cluster" => Cell::text(&r.cluster_name),
        "nowMinutes" => opt_min(r.now_minutes),
        "level" => Cell::text(r.state.label()),
        "startedSolved" => Cell::text(started_solved(r, now)),
        "median" => opt_min(r.median_minutes),
        "max" => opt_min(r.max_minutes),
        "episodes" => Cell::Int(r.episodes as f64),
        "lateTime" => Cell::text(time::duration(r.late_ms)),
        "docsPerDay" => r.docs_per_day.map(|d| Cell::Int(d as f64)).unwrap_or(Cell::Empty),
        "arrival" => r.last_arrival.map(|t| Cell::text(time::when(t, now))).unwrap_or(Cell::Empty),
        "eventTime" => r.last_event.map(|t| Cell::text(time::when(t, now))).unwrap_or(Cell::Empty),
        "lateSince" => r.late_since.map(|t| Cell::text(time::when(t, now))).unwrap_or(Cell::Empty),
        other => super::extra_ci(&r.extras, other).map(Cell::text).unwrap_or(Cell::Empty),
    }
}

fn cell_text(c: &Cell) -> String {
    match c {
        Cell::Empty => String::new(),
        Cell::Text(s) | Cell::Head(s) => s.clone(),
        Cell::Int(n) => format!("{}", *n as i64),
        Cell::Dec(n) => format!("{n:.2}"),
    }
}

/// `today 11:15 → still late`, `2 Nov 06:00 → 2 Nov 08:30`, `no logs since 12:40`.
pub fn started_solved(r: &DeviceRow, now: i64) -> String {
    if r.state == State::Silent {
        return format!("no logs since {}", r.silent_since.map(|t| time::when(t, now)).unwrap_or_else(|| "—".into()));
    }
    match (r.last_started, r.last_solved, r.late_since) {
        (_, _, Some(s)) => format!("{} → still late", time::when(s, now)),
        (Some(a), Some(b), None) => format!("{} → {}", time::when(a, now), time::when(b, now)),
        (Some(a), None, None) => format!("{} → not seen solved", time::when(a, now)),
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
    let headline = format!("{} devices late, {} critical", n(&t["late"]) as i64, n(&t["critical"]) as i64);

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
    if i.options.has("summary") {
        let mut r = vec![
            vec![Cell::head("ElasticPro log delay report"), Cell::text(range_label(i.range))],
            vec![Cell::text("Clusters"), Cell::Int(i.clusters.len() as f64)],
            vec![Cell::text("Measured every"), Cell::text(format!("{} h", i.every_hours))],
            vec![Cell::text("Devices measured"), int(&t["devices"])],
            vec![Cell::text("On time (under 30 min)"), int(&t["onTime"]), Cell::text(pct(&t["pctOnTime"]))],
            vec![Cell::text("Late now (30 min or more)"), int(&t["late"]), Cell::text(pct(&t["pctLate"]))],
            vec![Cell::text("  30–60 min"), int(&t["delay"])],
            vec![Cell::text("  above 60 min"), int(&t["critical"])],
            vec![Cell::text("Silent"), int(&t["silent"]), Cell::text(pct(&t["pctSilent"]))],
            vec![Cell::text("Can't measure"), int(&t["unmeasured"])],
            vec![Cell::text("Newly late today"), int(&fleet["newlyLateToday"])],
            vec![Cell::text("Solved today"), int(&fleet["solvedToday"])],
            vec![Cell::text("Yesterday: became late"), int(&fleet["yesterday"]["newlyLate"])],
            vec![Cell::text("Yesterday: solved"), int(&fleet["yesterday"]["solved"]),
                 fleet["yesterday"]["averageLastedMs"].as_i64().map(|ms| Cell::text(format!("{} late on average", time::duration(ms)))).unwrap_or(Cell::Empty)],
        ];
        r.push(vec![Cell::Empty]);
        r.push(vec![Cell::head("Delay reduced: devices back under 30 min in the last")]);
        for x in fleet["reduced"].as_array().into_iter().flatten() {
            r.push(vec![Cell::text(format!("{} h", n(&x["hours"]) as i64)), int(&x["n"])]);
        }
        r.push(vec![Cell::Empty]);
        r.push(vec![Cell::head("Cluster"), Cell::head("Devices"), Cell::head("Late now"), Cell::head("Today"), Cell::head("Below 30 min"), Cell::head("30–60 min"),
                    Cell::head("Above 60 min"), Cell::head("Below 30 min, previous period"), Cell::head("Silent"), Cell::head("Worst device"), Cell::head("Worst (min)")]);
        for c in fleet["byCluster"].as_array().into_iter().flatten() {
            r.push(vec![Cell::text(c["name"].as_str().unwrap_or("")), int(&c["devices"]), int(&c["lateNow"]), int(&c["newToday"]),
                        Cell::text(format!("{} ({})", n(&c["below"]) as i64, pct(&c["belowPct"]))), int(&c["delay"]), int(&c["critical"]),
                        Cell::text(pct(&c["belowPctPrevious"])), int(&c["silent"]),
                        Cell::text(c["worst"]["device"].as_str().unwrap_or("—")), c["worst"]["minutes"].as_f64().map(Cell::Dec).unwrap_or(Cell::Empty)]);
        }
        r.push(vec![Cell::Empty]);
        r.push(vec![Cell::head("Zone"), Cell::head("tag1"), Cell::head("Devices"), Cell::head("Late now"), Cell::head("Above 60 min"), Cell::head("Silent")]);
        for (z, t1, n) in by_zone_tag(i) {
            r.push(vec![Cell::text(z), Cell::text(t1), Cell::Int(n[0] as f64), Cell::Int(n[1] as f64), Cell::Int(n[2] as f64), Cell::Int(n[3] as f64)]);
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
            r.push(line);
        }
        r.push(vec![Cell::text(format!("{} rows · {} · grouped by {}", rows.len(), i.options.devices.label(), i.options.group_by))]);
        out.push(Sheet { name: "Devices".into(), rows: r });
    }
    if i.options.has("windows") || i.options.has("lateEvery2h") {
        let mut r = vec![vec![Cell::head("Window"), Cell::head("Newly late"), Cell::head("Solved"), Cell::head("Still late"), Cell::head("Complete")]];
        for w in windows {
            r.push(vec![Cell::text(w["label"].as_str().unwrap_or("")), int(&w["newlyLate"]), int(&w["solved"]), int(&w["stillLate"]),
                        Cell::text(if w["complete"] == true { "yes" } else { "so far" })]);
        }
        r.push(vec![Cell::text("Newly late: devices that reached 30 min of delay in that window. Solved: devices back under 30 min. Still late: devices 30 min or more late when the window ended.")]);
        out.push(Sheet { name: format!("Every {} hours", i.every_hours), rows: r });
    }
    if i.options.has("dayByDay") {
        let mut r = vec![vec![Cell::head("Day"), Cell::head("Devices"), Cell::head("On time"), Cell::head("Little delay"), Cell::head("Delayed"), Cell::head("Critical"),
                              Cell::head("Clock ahead"), Cell::head("Silent"), Cell::head("Can't measure"), Cell::head("Started"), Cell::head("Solved"),
                              Cell::head("Late hours"), Cell::head("Median (min)"), Cell::head("Complete")]];
        for d in fleet["days"].as_array().into_iter().flatten() {
            r.push(vec![Cell::text(d["day"].as_str().unwrap_or("")), int(&d["devices"]), int(&d["onTime"]), int(&d["little"]), int(&d["delayed"]), int(&d["critical"]),
                        int(&d["clockAhead"]), int(&d["silent"]), int(&d["unmeasured"]), int(&d["started"]), int(&d["solved"]),
                        d["lateHours"].as_f64().map(Cell::Dec).unwrap_or(Cell::Empty), d["medianMinutes"].as_f64().map(Cell::Dec).unwrap_or_else(|| Cell::text("not measured")),
                        Cell::text(if d["complete"] == true { "yes" } else { "so far" })]);
        }
        out.push(Sheet { name: "Day by day".into(), rows: r });
    }
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
    out
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
    s.push_str(",step,why,fix\n");
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
        Step::Forwarder => ORANGE,
        Step::Parser => PINK,
        Step::DeviceClock | Step::DeviceLink => GREEN,
        Step::Unknown => LINE,
    }
}

/// The HTML body, matching the Mail board section for section.
pub fn html(i: &Inputs<'_>, fleet: &Value, windows: &[Value], top: &[&DeviceRow], headline: &str) -> String {
    let t = &fleet["totals"];
    let td = format!("padding:6px 8px;border-bottom:1px solid {LINE};font-size:13px;color:{INK};vertical-align:top");
    let th = format!("padding:6px 8px;border-bottom:2px solid {LINE};font-size:12px;color:{MUTED};text-align:left;font-weight:600");
    let tile = |num: String, label: &str, sub: &str, bg: &str| format!(
        "<td style=\"padding:10px 12px;background:{bg};border-radius:6px;width:25%\"><div style=\"font-size:22px;font-weight:700;color:{INK}\">{}</div>\
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
        h.push_str(&tile(format!("{}", n(&t["devices"]) as i64), "devices", "measured", BLUE));
        h.push_str(&tile(pct(&t["pctOnTime"]), "on time", &format!("{} devices", n(&t["onTime"]) as i64), GREEN));
        h.push_str(&tile(pct(&t["pctLate"]), "late now", &format!("{} devices · {} at 30–60 min · {} above 60 min", n(&t["late"]) as i64, n(&t["delay"]) as i64, n(&t["critical"]) as i64), PINK));
        h.push_str(&tile(format!("{}", n(&t["silent"]) as i64), "silent", "no logs for the silence limit", ORANGE));
        h.push_str("</tr></table>");
        let y = &fleet["yesterday"];
        h.push_str(&format!("<div style=\"font-size:13px;margin:8px 0 0\">Yesterday: {} devices became late, {} were solved{}.</div>",
            n(&y["newlyLate"]) as i64, n(&y["solved"]) as i64,
            y["averageLastedMs"].as_i64().map(|ms| format!(" ({} late on average)", time::duration(ms))).unwrap_or_default()));
        if n(&t["unmeasured"]) > 0.0 {
            h.push_str(&format!("<div style=\"font-size:12px;color:{MUTED}\">{} device(s) could not be measured: no readable event time in their latest log.</div>", n(&t["unmeasured"]) as i64));
        }
        let zt = by_zone_tag(i);
        h.push_str("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">By zone and tag1 · now</div>");
        h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Zone</th><th style=\"{th}\">tag1</th><th style=\"{th}\">Devices</th><th style=\"{th}\">Late now</th><th style=\"{th}\">Above 60 min</th><th style=\"{th}\">Silent</th></tr>"));
        for (z, t1, c) in zt.iter().take(ZONE_ROWS) {
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td};background:{}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td></tr>",
                esc(z), esc(t1), c[0], if c[1] > 0 { PINK } else { GREEN }, c[1], c[2], c[3]));
        }
        if zt.len() > ZONE_ROWS {
            h.push_str(&format!("<tr><td colspan=\"6\" style=\"{td};color:{MUTED}\">{} more zone · tag1 pairs in the attachment (Summary sheet)</td></tr>", zt.len() - ZONE_ROWS));
        }
        h.push_str("</table>");
    }
    if i.options.has("lateEvery2h") && !windows.is_empty() {
        let devices = n(&t["devices"]).max(1.0);
        h.push_str(&format!("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Late devices every {} hours · {}</div>", i.every_hours, esc(&time::short_date(i.range.to.min(time::local_date(i.now))))));
        h.push_str("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\">");
        for w in windows {
            let late = n(&w["stillLate"]);
            let p = ((late / devices) * 100.0).clamp(0.0, 100.0).round() as i64;
            h.push_str(&format!("<tr><td style=\"width:110px;font-size:12px;color:{MUTED};padding:2px 8px 2px 0\">{}</td><td style=\"padding:2px 0\">\
                <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr>\
                <td style=\"width:{p}%;background:{PINK};height:12px;font-size:1px\">&nbsp;</td><td style=\"background:{GREEN};height:12px;font-size:1px\">&nbsp;</td></tr></table></td>\
                <td style=\"width:90px;font-size:12px;padding-left:8px\">{} late</td></tr>", esc(w["label"].as_str().unwrap_or("")), late as i64));
        }
        h.push_str(&format!("</table><div style=\"font-size:11px;color:{MUTED}\">pink: 30 min or more at the end of the window · green: under 30 min</div>"));
    }
    if i.options.has("windows") && !windows.is_empty() {
        h.push_str(&format!("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Every {} hours · {}</div>", i.every_hours, esc(&time::short_date(i.range.to.min(time::local_date(i.now))))));
        h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Window</th><th style=\"{th}\">Newly late</th><th style=\"{th}\">Solved</th><th style=\"{th}\">Still late</th></tr>"));
        for w in windows {
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td};background:{ORANGE}\">{}</td><td style=\"{td};background:{GREEN}\">{}</td><td style=\"{td};background:{PINK}\">{}</td></tr>",
                esc(w["label"].as_str().unwrap_or("")), n(&w["newlyLate"]) as i64, n(&w["solved"]) as i64, n(&w["stillLate"]) as i64));
        }
        h.push_str(&format!("</table><div style=\"font-size:11px;color:{MUTED}\">Newly late: devices that reached 30 min of delay in that window. Solved: devices back under 30 min. Still late: devices 30 min or more late when the window ended.</div>"));
    }
    if i.options.has("dayByDay") {
        let days: Vec<&Value> = fleet["days"].as_array().map(|a| a.iter().rev().take(7).collect::<Vec<_>>()).unwrap_or_default().into_iter().rev().collect();
        h.push_str("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Day by day · last 7 days</div>");
        h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Day</th><th style=\"{th}\">Devices</th><th style=\"{th}\">On time</th><th style=\"{th}\">Delayed</th><th style=\"{th}\">Critical</th><th style=\"{th}\">Silent</th><th style=\"{th}\">Started</th><th style=\"{th}\">Solved</th></tr>"));
        for d in &days {
            let dev = n(&d["devices"]).max(1.0);
            let bar = |v: f64, bg: &str| format!("<span style=\"display:inline-block;width:{}px;height:8px;background:{bg}\"></span>", ((v / dev) * 120.0).round() as i64);
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td></tr>",
                esc(d["day"].as_str().unwrap_or("")), n(&d["devices"]) as i64, n(&d["onTimeAll"]) as i64, n(&d["delayed"]) as i64, n(&d["critical"]) as i64,
                n(&d["silent"]) as i64, n(&d["started"]) as i64, n(&d["solved"]) as i64));
            h.push_str(&format!("<tr><td colspan=\"8\" style=\"padding:0 8px 6px;font-size:1px\">{}{}{}{}</td></tr>",
                bar(n(&d["onTimeAll"]), GREEN), bar(n(&d["delayed"]), ORANGE), bar(n(&d["critical"]), PINK), bar(n(&d["silent"]), BLUE)));
        }
        if days.is_empty() {
            h.push_str(&format!("<tr><td colspan=\"8\" style=\"{td}\">No day with totals yet.</td></tr>"));
        }
        h.push_str("</table>");
    }
    if i.options.has("topDelayed") {
        h.push_str("<div style=\"font-size:14px;font-weight:600;margin:18px 0 6px\">Top delayed</div>");
        h.push_str(&format!("<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><th style=\"{th}\">Device</th><th style=\"{th}\">Cluster</th><th style=\"{th}\">Zone</th><th style=\"{th}\">tag1</th><th style=\"{th}\">Delay</th><th style=\"{th}\">Late since</th></tr>"));
        for d in top {
            h.push_str(&format!("<tr><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td};background:{}\">{}</td><td style=\"{td}\">{}</td></tr>",
                esc(&d.device), esc(&d.cluster_name), esc(d.zone.as_deref().unwrap_or("—")), esc(d.tag1.as_deref().unwrap_or("—")), if d.state == State::Critical { PINK } else { ORANGE },
                d.now_minutes.map(time::minutes).unwrap_or_else(|| "can't measure".into()), d.late_since.map(|t| esc(&time::when(t, i.now))).unwrap_or_default()));
        }
        if top.is_empty() {
            h.push_str(&format!("<tr><td colspan=\"6\" style=\"{td}\">No device is late now.</td></tr>"));
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
    let mut s = format!("ElasticPro log delay report · {}\n{} cluster(s) · {} devices · measured every {} hours\n\n", range_label(i.range), i.clusters.len(), n(&t["devices"]) as i64, i.every_hours);
    s.push_str(&format!("Summary: {} · on time {} ({}) · late now {} ({}) · 30–60 min {} · above 60 min {} · silent {} · can't measure {}\n",
        headline, n(&t["onTime"]) as i64, pct(&t["pctOnTime"]), n(&t["late"]) as i64, pct(&t["pctLate"]), n(&t["delay"]) as i64, n(&t["critical"]) as i64,
        n(&t["silent"]) as i64, n(&t["unmeasured"]) as i64));
    let y = &fleet["yesterday"];
    if fleet["devicesInRange"].as_u64() == Some(0) {
        s.push_str(&format!("No measurement in this period (the measurement runs every {} hours): the figures are the devices' states now.\n", i.every_hours));
    }
    s.push_str(&format!("Yesterday: {} became late, {} solved{}\n\n", n(&y["newlyLate"]) as i64, n(&y["solved"]) as i64,
        y["averageLastedMs"].as_i64().map(|ms| format!(" ({} late on average)", time::duration(ms))).unwrap_or_default()));
    if i.options.has("windows") && !windows.is_empty() {
        s.push_str(&format!("Every {} hours · window: newly late / solved / still late\n", i.every_hours));
        for w in windows {
            s.push_str(&format!("  {}  {} / {} / {}\n", w["label"].as_str().unwrap_or(""), n(&w["newlyLate"]) as i64, n(&w["solved"]) as i64, n(&w["stillLate"]) as i64));
        }
        s.push('\n');
    }
    if i.options.has("dayByDay") {
        s.push_str("Day by day · day: devices / on time / delayed / critical / silent / started / solved\n");
        for d in fleet["days"].as_array().into_iter().flatten().rev().take(7).collect::<Vec<_>>().into_iter().rev() {
            s.push_str(&format!("  {}  {} / {} / {} / {} / {} / {} / {}\n", d["day"].as_str().unwrap_or(""), n(&d["devices"]) as i64, n(&d["onTimeAll"]) as i64,
                n(&d["delayed"]) as i64, n(&d["critical"]) as i64, n(&d["silent"]) as i64, n(&d["started"]) as i64, n(&d["solved"]) as i64));
        }
        s.push('\n');
    }
    if i.options.has("topDelayed") {
        s.push_str("Top delayed\n");
        for d in top {
            s.push_str(&format!("  {} · {} · zone {} · tag1 {} · {} · late since {}\n", d.device, d.cluster_name, d.zone.as_deref().unwrap_or("—"), d.tag1.as_deref().unwrap_or("—"),
                d.now_minutes.map(time::minutes).unwrap_or_else(|| "can't measure".into()),
                d.late_since.map(|x| time::when(x, i.now)).unwrap_or_else(|| "—".into())));
        }
        if top.is_empty() {
            s.push_str("  no device is late now\n");
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
            Reading { device: d.into(), docs: 50, arrival_ms: Some(at), event_ms: Some(at - (m * 60_000.0) as i64), delay_minutes: Some(m), extras }
        };
        t.apply(now - 4 * H, vec![rd("fw-1", 45.0, now - 4 * H), rd("fw-2", 2.0, now - 4 * H), rd("fw-3", 20.0, now - 4 * H)], &l, 2 * H);
        t.apply(now - 2 * H, vec![rd("fw-1", 94.0, now - 2 * H), rd("fw-2", 2.0, now - 2 * H), rd("fw-3", 20.0, now - 2 * H)], &l, 2 * H);
        let key = time::local_day_key(now);
        let (f, to) = time::day_bounds(time::local_date(now));
        let mut daily = BTreeMap::new();
        daily.insert(key.clone(), crate::logdelay::state::daily(&t, &key, f, to, now));
        ClusterInput { id: "prod".into(), name: "Production".into(), tracker: std::sync::Arc::new(t), daily, levels: l }
    }

    #[test]
    fn a_hostile_device_name_is_inert_in_the_mail_and_the_csv() {
        let now = chrono::Utc::now().timestamp_millis();
        let mut t = Tracker::default();
        let l = Levels::default();
        let evil = "=HYPERLINK(\"http://x\")<script>alert('1')</script>, \"q\"";
        let rd = Reading { device: evil.into(), docs: 5, arrival_ms: Some(now), event_ms: Some(now - 90 * 60_000), delay_minutes: Some(90.0), extras: BTreeMap::new() };
        t.apply(now, vec![rd], &l, 2 * H);
        let clusters = vec![ClusterInput { id: "prod".into(), name: "<b>Prod</b>".into(), tracker: std::sync::Arc::new(t), daily: BTreeMap::new(), levels: l }];
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
        let rd = Reading { device: plus.into(), docs: 5, arrival_ms: Some(now), event_ms: Some(now - 90 * 60_000), delay_minutes: Some(90.0), extras: BTreeMap::new() };
        t.apply(now, vec![rd], &l, 2 * H);
        let clusters = vec![ClusterInput { id: "prod".into(), name: "Prod".into(), tracker: std::sync::Arc::new(t), daily: BTreeMap::new(), levels: l }];
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
    fn the_build_makes_every_sheet_a_csv_and_a_mail_in_the_four_colours_only() {
        let now = chrono::Utc::now().timestamp_millis();
        let c = input(now);
        let r = Range::last_days(now, 7);
        let extras = vec!["Zone".to_string(), "tag1".to_string(), "fwd_tag".to_string(), "parser_tag".to_string()];
        let findings = crate::logdelay::fixes::findings("prod", &c.tracker, r.from_ms, r.to_ms, now, 2 * H, &Default::default());
        let clusters = vec![c];
        let opts = Options::default();
        let i = Inputs { clusters: &clusters, range: &r, now, every_hours: 2, findings: &findings, options: &opts, extras: &extras, app_url: Some("https://ep.example/reports/logdelay") };
        let b = build(&i).unwrap();
        assert_eq!(b.headline, "1 devices late, 1 critical");
        let parts = crate::report::zip::read(b.xlsx.as_ref().unwrap()).unwrap();
        let wb = std::str::from_utf8(&parts.iter().find(|(n, _)| n == "xl/workbook.xml").unwrap().1).unwrap().to_string();
        for name in ["Summary", "Devices", "Every 2 hours", "Day by day", "Top delayed", "Fixes"] {
            assert!(wb.contains(&format!("name=\"{name}\"")), "{name} sheet missing: {wb}");
        }
        let csv = String::from_utf8(b.csv.unwrap()).unwrap();
        assert!(csv.starts_with("Device,Cluster,Delay now (min),Level"), "{csv}");
        assert_eq!(csv.lines().count(), 2, "only the delayed device: {csv}");
        assert!(csv.contains("fw-1,Production,94.00,critical"), "{csv}");
        assert!(b.html.contains("Log delay report") && b.html.contains("Top delayed") && b.html.contains("fw-1"));
        assert!(b.html.contains("Open the full report in ElasticPro"));
        let lc = b.html.to_ascii_lowercase();
        for banned in ["#ff0000", "#f00;", "yellow", "#ffff00", ":red", ": red", "background:#d9534f"] {
            assert!(!lc.contains(banned), "{banned} in the mail");
        }
        for wanted in [GREEN, BLUE, PINK, ORANGE] {
            assert!(b.html.contains(wanted), "{wanted} missing from the mail");
        }
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
    fn started_solved_reads_as_the_board_shows_it() {
        let now = chrono::Utc::now().timestamp_millis();
        let mut r = DeviceRow { device: "d".into(), cluster: "c".into(), cluster_name: "C".into(), state: State::Critical, now_minutes: Some(94.0), median_minutes: None,
            max_minutes: None, episodes: 1, solved: 0, late_ms: 0, last_started: Some(now - H), last_solved: None, late_since: Some(now - H), docs_per_day: None,
            last_arrival: None, last_event: None, silent_since: None, zone: None, tag1: None, in_last_run: true, extras: BTreeMap::new() };
        assert!(started_solved(&r, now).ends_with("→ still late"));
        r.late_since = None;
        r.last_solved = Some(now);
        assert!(started_solved(&r, now).contains(" → today "));
        r.state = State::Silent;
        r.silent_since = Some(now - 2 * H);
        assert!(started_solved(&r, now).starts_with("no logs since "));
    }
}
