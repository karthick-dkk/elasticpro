//! What goes into a report file: the sheets, the CSV files, the mail's summary lines.
//!
//! Every number comes from `volume::derive` — `daily_row`, `month_row`, `breakdown`,
//! `cards` — exactly as the pages get it. This file only lays those answers out. That is
//! the rule this codebase keeps relearning: a figure computed twice drifts.
//!
//! `null` stays visible. A cell whose figure was not measured reads "not measured" in the
//! workbook (an empty cell is what somebody totals as 0), and is empty in the CSV with the
//! `event_bytes_measured` column beside the one figure that is often unmeasured. Every day of
//! the period has a row, every row says when it was read and what is missing from it, and the
//! About sheet says it for the file.

use super::about::{self, About};
use super::period::Period;
use super::xlsx::{Cell, Sheet};
use super::zip::Entry;
use crate::volume::derive::{self, Totals};
use crate::volume::schedule::{day_key, month_key, months_between, parse_day};
use crate::volume::store::Store;
use crate::volume::{column_label, Day, SizeBasis, VolumeSettings, FIELD_KEYS};
use chrono::{Datelike, Duration, NaiveDate};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// What the UI's `fmt.bytes` calls a GB: 1024³ bytes. The GB column and the mail's sizes
/// use the same unit the pages show.
pub const GB: f64 = 1024.0 * 1024.0 * 1024.0;

pub const NOT_MEASURED: &str = "not measured";

/// The sheets a report can hold, in their order.
pub const SHEETS: [&str; 3] = ["daily", "monthly", "breakdown"];

/// One cluster's record for one period, read once.
pub struct ClusterData {
    pub id: String,
    pub name: String,
    pub settings: VolumeSettings,
    /// From `AVG_DAYS_DEFAULT` days before the period (the first day's average needs them)
    /// to its last day.
    pub days: Vec<Day>,
    /// What went wrong collecting this cluster for this file: said on the rows it concerns, on
    /// the About sheet and in the mail.
    pub warnings: Vec<String>,
}

impl ClusterData {
    pub fn load(store: &Store, id: &str, name: &str, settings: VolumeSettings, period: &Period) -> ClusterData {
        let from = period.from_date() - Duration::days(derive::AVG_DAYS_DEFAULT as i64);
        ClusterData {
            id: id.into(),
            name: name.into(),
            settings,
            days: store.days_between(id, from, period.to_date()),
            warnings: vec![],
        }
    }

    /// `load`, with what went wrong collecting it.
    pub fn with_warnings(mut self, w: &[String]) -> ClusterData {
        self.warnings = w.to_vec();
        self
    }

    fn in_period<'a>(&'a self, p: &'a Period) -> impl Iterator<Item = &'a Day> + 'a {
        let (f, t) = (p.from_date(), p.to_date());
        self.days.iter().filter(move |d| parse_day(&d.day).is_some_and(|x| x >= f && x <= t))
    }

    /// The period's days that have begun.
    fn period_days(p: &Period, today: NaiveDate) -> Vec<NaiveDate> {
        p.days().into_iter().filter(|d| *d <= today).collect()
    }

    /// One row per day of the period (`derive::daily_row`, average over `AVG_DAYS_DEFAULT`). A day
    /// the record does not hold is a row too, with no figure and a note: a gap in a list of days
    /// reads as a day on which nothing arrived.
    pub fn daily_rows(&self, p: &Period, today: NaiveDate) -> Vec<Value> {
        let history = derive::history(&self.days, None);
        let by_day: BTreeMap<&str, &Day> = self.days.iter().map(|d| (d.day.as_str(), d)).collect();
        Self::period_days(p, today).into_iter().map(|date| {
            let key = day_key(date);
            let row = by_day.get(key.as_str())
                .and_then(|d| Some(derive::daily_row(d, &Totals::of(d, None)?, &history, derive::AVG_DAYS_DEFAULT, self.settings.size_basis, None)));
            let mut row = row.unwrap_or_else(|| json!({ "day": key, "missing": true, "final": false, "notes": [NO_RECORD] }));
            if row["final"] != true {
                row["notes"].as_array_mut().into_iter().for_each(|n| n.extend(self.warnings.iter().map(|w| json!(w))));
            }
            row
        }).collect()
    }

    /// One row per month the period touches (`derive::month_row`), over the period's own
    /// **finished** days: not the rest of the month, never today. `label` says the dates
    /// (`2026-11 (1–23)`), `days` how many there are, `daysMeasured` how many of them each figure
    /// was measured on and `notFinal` how many of those may still grow — the rule of the page, the
    /// mail and the hosts file (docs/VOLUME.md "Month so far").
    pub fn month_rows(&self, p: &Period, basis: SizeBasis, today: NaiveDate) -> Vec<Value> {
        let (first, last) = (p.from_date(), p.to_date().min(today - Duration::days(1)));
        let current = month_key(today);
        months_between(first, last).into_iter().filter_map(|m| {
            let start = NaiveDate::parse_from_str(&format!("{m}-01"), "%Y-%m-%d").ok()?;
            let end = start + Duration::days(derive::days_in_month(&m)? - 1);
            let (from, to) = (start.max(first), end.min(last));
            if from > to {
                return None;
            }
            let days: BTreeMap<String, Day> = self.days.iter()
                .filter(|d| parse_day(&d.day).is_some_and(|x| x >= from && x <= to))
                .map(|d| (d.day.clone(), d.clone())).collect();
            let mut row = derive::month_row(&derive::month_summary(&m, &days), basis, &current);
            row["label"] = json!(if (from, to) == (start, end) { m.clone() }
                                 else if from == to { format!("{m} ({})", from.day()) }
                                 else { format!("{m} ({}–{})", from.day(), to.day()) });
            row["from"] = json!(day_key(from));
            row["to"] = json!(day_key(to));
            row["days"] = json!((to - from).num_days() + 1);
            row["notFinal"] = json!(days.values().filter(|d| !d.is_final && read_figure(d)).count());
            Some(row)
        }).collect()
    }

    /// What this cluster's part of a file says about itself (the About sheet): when its figures
    /// were read, and every day that is missing, not final or short.
    pub fn describe(&self, p: &Period, today: NaiveDate, a: &mut About) {
        let who = if self.name == self.id { self.id.clone() } else { format!("{} ({})", self.name, self.id) };
        a.clusters.push((who, about::span(self.in_period(p).filter_map(derive::read_at))));
        let mut warn = |w: String| a.warnings.push(format!("{}: {w}", self.name));
        self.warnings.iter().cloned().for_each(&mut warn);
        let have: BTreeSet<&str> = self.days.iter().map(|d| d.day.as_str()).collect();
        let all = Self::period_days(p, today);
        let missing: Vec<String> = all.iter().map(|d| day_key(*d)).filter(|k| !have.contains(k.as_str())).collect();
        if !missing.is_empty() {
            warn(format!("{} of {} days not measured ({NO_RECORD}): {}", missing.len(), all.len(), days_list(&missing)));
        }
        let open: Vec<String> = self.in_period(p).filter(|d| !d.is_final).map(|d| d.day.clone()).collect();
        if !open.is_empty() {
            warn(format!("{} of {} days not final: {}", open.len(), all.len(), days_list(&open)));
        }
        for d in self.in_period(p) {
            if let Some(e) = &d.error {
                warn(format!("{}: {e}", d.day));
            }
        }
    }

    /// The period's finished days: today is still running.
    fn finished_days(p: &Period, today: NaiveDate) -> usize {
        Self::period_days(p, today).into_iter().filter(|d| *d < today).count()
    }

    /// One `derive::breakdown` per field, over the period's finished days.
    pub fn breakdowns(&self, p: &Period, today: NaiveDate) -> Vec<(&'static str, Value)> {
        let days: Vec<&Day> = self.in_period(p).filter(|d| parse_day(&d.day).is_some_and(|x| x < today)).collect();
        FIELD_KEYS.iter().map(|k| (*k, derive::breakdown(&days, k, derive::BREAKDOWN_TOP_DEFAULT))).collect()
    }

    fn field_label(&self, key: &str) -> String {
        match key {
            "tag" => "Tag".into(),
            "forwarder" => "Forwarder".into(),
            "sourceHost" => "Source host".into(),
            "sourceIp" => "Source IP".into(),
            _ => self.settings.extra.name.clone(),
        }
    }
}

/// The day carries something a search counted.
fn read_figure(d: &Day) -> bool {
    d.docs.is_some() || d.event_bytes.is_some()
}

/// Why a day of the period has no figure.
pub const NO_RECORD: &str = "the record holds nothing for this day";

/// Up to 31 days by name, then how many more.
fn days_list(days: &[String]) -> String {
    let more = days.len().saturating_sub(31);
    let shown = days[..days.len() - more].join(", ");
    if more > 0 { format!("{shown} and {more} more") } else { shown }
}

/// What every volume file says about its figures.
pub const VOLUME_NOTES: [&str; 4] = [
    about::FINAL_RULE,
    "Monthly rows and breakdowns count the period's finished days, never today; Days measured says how many of them each figure was measured on, and how many are not final.",
    "Primary size est. shares out each day's measured primary size by documents: an estimate.",
    "GB is 1024 x 1024 x 1024 bytes.",
];

/// The file's About, before its clusters describe themselves (`ClusterData::describe`).
pub fn volume_about(p: &Period, built_at: i64) -> About {
    let mut a = About::new("ElasticPro volume report", p, built_at);
    a.notes = VOLUME_NOTES.iter().map(|n| n.to_string()).collect();
    a
}

/// A row's notes, as one cell.
fn notes_text(r: &Value) -> String {
    r["notes"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")
}

fn read_text(r: &Value) -> String {
    r["readAt"].as_i64().map(about::utc).unwrap_or_else(|| about::NOT_READ.into())
}

/// The change against the average, or why there is none: no earlier day to compare with is not
/// a measurement that failed, and one that was not measured is not "no earlier day".
fn change_cell(r: &Value) -> Cell {
    if let Some(pct) = r["changeVsAvgPct"].as_f64() {
        return Cell::Dec(pct);
    }
    let n = |k: &str| r[k].as_u64().unwrap_or(0);
    Cell::text(if r["missing"] == true || (r["basis"].is_null() && n("earlierDays") > 0) {
        NOT_MEASURED
    } else if n("earlierDays") == 0 {
        "no earlier day"
    } else if n("avgDays") == 0 {
        NOT_MEASURED
    } else {
        "average is 0"
    })
}

/// Which days a month row's figures rest on.
fn days_measured_text(r: &Value) -> String {
    let m = &r["daysMeasured"];
    let of = r["days"].as_i64().unwrap_or(0);
    let n = |k: &str| m[k].as_u64().unwrap_or(0);
    let (docs, ev, size) = (n("docs"), n("eventBytes"), n("size"));
    let open = match r["notFinal"].as_u64().unwrap_or(0) {
        0 => String::new(),
        n => format!("; {n} not final"),
    };
    if docs == ev && ev == size {
        return format!("{docs} of {of} days{open}");
    }
    format!("documents {docs}, event bytes {ev}, size {size} of {of} days{open}")
}

/* ------------------------------------------ cells ------------------------------------------ */

fn int_or_nm(v: &Value) -> Cell {
    match v.as_f64() {
        Some(n) => Cell::Int(n),
        None => Cell::text(NOT_MEASURED),
    }
}

/// Bytes as GB (1024³), not rounded: rounded to two decimals, 2 MB reads as 0. The one
/// definition every report's GB column uses.
pub fn gb_cell(v: Option<u64>) -> Cell {
    match v.map(|b| b as f64 / GB) {
        Some(g) if g > 0.0 && g < 0.01 => Cell::Num(g),
        Some(g) => Cell::Dec(g),
        None => Cell::text(NOT_MEASURED),
    }
}

fn gb(v: &Value) -> Cell {
    gb_cell(v.as_u64())
}

/// A top value as one cell: "value (60%)", or "not measured" when the field never resolved
/// or nothing was counted.
fn top_cell(t: &Value) -> Cell {
    let Some(v) = t.get("value").and_then(Value::as_str) else { return Cell::text(NOT_MEASURED) };
    match t.get("share").and_then(Value::as_f64) {
        Some(s) => Cell::text(format!("{v} ({:.1}%)", s * 100.0)),
        None => Cell::text(v),
    }
}

/// The columns a table shows, in the shared layout's order, without the hidden ones, each
/// with its header (the layout's label, else `column_label`).
fn columns(layouts: &Value, table: &str, extra: &str) -> Vec<(String, String)> {
    let l = layouts.get(table).cloned().unwrap_or(Value::Null);
    let hidden: Vec<&str> = l.get("hidden").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let order: Vec<String> = l.get("order").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
    let defaults: &[&str] = if table == "daily" { crate::volume::DAILY_COLUMNS } else { crate::volume::MONTHLY_COLUMNS };
    let order = if order.is_empty() { defaults.iter().map(|s| s.to_string()).collect() } else { order };
    order.into_iter().filter(|k| !hidden.contains(&k.as_str())).map(|k| {
        let label = l.pointer(&format!("/labels/{k}")).and_then(Value::as_str).map(String::from)
            .unwrap_or_else(|| column_label(table, &k, extra));
        (k, label)
    }).collect()
}

fn daily_sheet(data: &ClusterData, p: &Period, layouts: &Value, today: NaiveDate) -> Vec<Vec<Cell>> {
    let cols = columns(layouts, "daily", &data.settings.extra.name);
    let mut head = vec![];
    for (k, label) in &cols {
        match k.as_str() {
            "priBytes" => {
                head.push(Cell::head(format!("{label} (bytes)")));
                head.push(Cell::head(format!("{label} GB")));
            }
            "totalBytes" | "eventBytes" | "subBytes" => head.push(Cell::head(format!("{label} (bytes)"))),
            _ => head.push(Cell::head(label.clone())),
        }
    }
    head.push(Cell::head("Read at (UTC)"));
    head.push(Cell::head("Note"));
    let mut rows = vec![head];
    for r in data.daily_rows(p, today) {
        let mut row = vec![];
        for (k, _) in &cols {
            match k.as_str() {
                "day" => row.push(Cell::text(r["day"].as_str().unwrap_or(""))),
                "indices" | "docs" | "totalBytes" | "eventBytes" | "subBytes" => row.push(int_or_nm(&r[k.as_str()])),
                "priBytes" => {
                    row.push(int_or_nm(&r["priBytes"]));
                    row.push(gb(&r["priBytes"]));
                }
                "changeVsAvg" => row.push(change_cell(&r)),
                "topExtra" => row.push(top_cell(&r["top"]["extra"])),
                "topSourceHost" => row.push(top_cell(&r["top"]["sourceHost"])),
                "topForwarder" => row.push(top_cell(&r["top"]["forwarder"])),
                "topTag" => row.push(top_cell(&r["top"]["tag"])),
                "topSourceIp" => row.push(top_cell(&r["top"]["sourceIp"])),
                _ => row.push(Cell::Empty),
            }
        }
        row.push(Cell::text(read_text(&r)));
        row.push(Cell::text(notes_text(&r)));
        rows.push(row);
    }
    rows
}

fn monthly_sheet(data: &ClusterData, p: &Period, layouts: &Value, today: NaiveDate) -> Vec<Vec<Cell>> {
    let cols = columns(layouts, "monthly", &data.settings.extra.name);
    // Average and peak follow the basis, as on the page; off primary size the header says
    // which figure they are, so they are not read as primary size beside its column.
    let on = match data.settings.size_basis {
        SizeBasis::Primary => String::new(),
        b => format!(" · {}", basis_name(b)),
    };
    let mut head = vec![];
    for (k, label) in &cols {
        match k.as_str() {
            "priBytes" => {
                head.push(Cell::head(format!("{label} (bytes)")));
                head.push(Cell::head(format!("{label} GB")));
            }
            "peakDay" => {
                head.push(Cell::head(format!("{label}{on}")));
                head.push(Cell::head(format!("{label}{on} (bytes)")));
            }
            "avgPerDay" => head.push(Cell::head(format!("{label}{on} (bytes)"))),
            "eventBytes" | "subBytes" => head.push(Cell::head(format!("{label} (bytes)"))),
            _ => head.push(Cell::head(label.clone())),
        }
    }
    head.push(Cell::head("Days measured"));
    let mut rows = vec![head];
    for r in data.month_rows(p, data.settings.size_basis, today) {
        let mut row = vec![];
        for (k, _) in &cols {
            match k.as_str() {
                "month" => row.push(Cell::text(r["label"].as_str().unwrap_or(""))),
                "daysWithData" | "docs" | "eventBytes" | "subBytes" | "avgPerDay" => row.push(int_or_nm(&r[k.as_str()])),
                "priBytes" => {
                    row.push(int_or_nm(&r["priBytes"]));
                    row.push(gb(&r["priBytes"]));
                }
                "peakDay" => match r["peakDay"].get("day").and_then(Value::as_str) {
                    Some(d) => {
                        row.push(Cell::text(d));
                        row.push(int_or_nm(&r["peakDay"]["bytes"]));
                    }
                    None => {
                        row.push(Cell::text(NOT_MEASURED));
                        row.push(Cell::text(NOT_MEASURED));
                    }
                },
                "from" => row.push(int_or_nm(&r["keptDays"])),
                "topExtra" => row.push(top_cell(&r["top"]["extra"])),
                "topSourceHost" => row.push(top_cell(&r["top"]["sourceHost"])),
                "topForwarder" => row.push(top_cell(&r["top"]["forwarder"])),
                "topTag" => row.push(top_cell(&r["top"]["tag"])),
                "topSourceIp" => row.push(top_cell(&r["top"]["sourceIp"])),
                _ => row.push(Cell::Empty),
            }
        }
        row.push(Cell::text(days_measured_text(&r)));
        rows.push(row);
    }
    rows
}

fn breakdown_sheet(data: &ClusterData, p: &Period, today: NaiveDate) -> Vec<Vec<Cell>> {
    let days = ClusterData::finished_days(p, today);
    let mut rows: Vec<Vec<Cell>> = vec![];
    for (key, b) in data.breakdowns(p, today) {
        if !rows.is_empty() {
            rows.push(vec![]);
        }
        let resolved = b["resolved"].as_str().map(|f| format!(" · field {f}")).unwrap_or_default();
        rows.push(vec![Cell::head(format!("{}{resolved} · {} – {}", data.field_label(key), p.from, p.to))]);
        if let Some(e) = b.get("error").and_then(Value::as_str) {
            rows.push(vec![Cell::text(format!("{NOT_MEASURED}: {e}"))]);
            continue;
        }
        for note in derive::breakdown_notes(&b, days) {
            rows.push(vec![Cell::text(note)]);
        }
        rows.push(["Value", "Documents", "Event bytes", "Primary size est. (bytes)", "Primary size est. GB", "Share % (est.)", "Days seen"]
            .into_iter().map(Cell::head).collect());
        for r in b["rows"].as_array().into_iter().flatten() {
            rows.push(vec![
                Cell::text(r["value"].as_str().unwrap_or("")),
                int_or_nm(&r["docs"]),
                int_or_nm(&r["eventBytes"]),
                int_or_nm(&r["estPriBytes"]),
                gb(&r["estPriBytes"]),
                r["sharePct"].as_f64().map(Cell::Dec).unwrap_or_else(|| Cell::text(NOT_MEASURED)),
                int_or_nm(&r["daysSeen"]),
            ]);
        }
    }
    rows
}

/// The sheets of one cluster. `prefix` is the cluster's name in a workbook of several
/// (the mailed report); the name is cut so the sheet name stays within Excel's 31.
pub fn sheets(data: &ClusterData, p: &Period, layouts: &Value, today: NaiveDate, which: &[String], prefix: bool) -> Vec<Sheet> {
    let name = |s: &str| -> String {
        if !prefix {
            return s.to_string();
        }
        let room = 31 - s.chars().count() - 1;
        let short: String = data.name.chars().take(room).collect();
        format!("{} {s}", short.trim_end())
    };
    let mut out = vec![];
    for s in SHEETS {
        if !which.iter().any(|w| w == s) {
            continue;
        }
        let (title, rows) = match s {
            "daily" => ("Daily", daily_sheet(data, p, layouts, today)),
            "monthly" => ("Monthly", monthly_sheet(data, p, layouts, today)),
            _ => ("Breakdown", breakdown_sheet(data, p, today)),
        };
        out.push(Sheet { name: name(title), rows });
    }
    out
}

/* ------------------------------------------- CSV ------------------------------------------- */

/// `csvEscape` of `ui/js/lib/fmt.js`: a cell that starts like a formula (`= + - @`, tab,
/// return) gets a leading apostrophe unless it is a plain number; quotes when needed.
pub fn csv_escape(s: &str) -> String {
    let plain_number = {
        let t = s.strip_prefix('-').unwrap_or(s);
        let mut parts = t.splitn(2, '.');
        let int_ok = parts.next().is_some_and(|i| !i.is_empty() && i.bytes().all(|b| b.is_ascii_digit()));
        let frac_ok = parts.next().is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()));
        int_ok && frac_ok
    };
    let mut v = s.to_string();
    if s.starts_with(['=', '+', '-', '@', '\t', '\r']) && !plain_number {
        v = format!("'{v}");
    }
    // A lone carriage return ends a record for many readers, as a line feed does.
    if v.contains(['"', ',', '\n', '\r']) { format!("\"{}\"", v.replace('"', "\"\"")) } else { v }
}

fn csv_line(cells: &[String]) -> String {
    cells.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(",")
}

/// A JSON figure as CSV text: `null` is an empty cell.
fn csv_num(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub const DAILY_CSV: &[&str] = &["cluster", "day", "indices", "docs", "primary_bytes", "total_bytes", "event_bytes",
    "event_bytes_measured", "sub_bytes", "change_vs_avg_pct", "avg_days", "final", "read_at_utc", "note"];
pub const MONTHLY_CSV: &[&str] = &["cluster", "month", "days_with_data", "primary_bytes", "avg_primary_bytes_per_day",
    "peak_day", "peak_primary_bytes", "docs", "event_bytes", "from_kept_record_days", "period_from", "period_to", "days_in_period",
    "docs_days_measured", "event_bytes_days_measured", "primary_bytes_days_measured", "days_not_final"];
pub const BREAKDOWN_CSV: &[&str] = &["cluster", "field", "field_resolved", "value", "period_from", "period_to", "docs",
    "event_bytes", "primary_bytes_estimated", "share_pct", "days_seen", "note"];

/// `daily.csv`, `monthly.csv`, `breakdown.csv` (docs/VOLUME.md "CSV columns"). The monthly
/// file's columns are named for primary size, so they carry the month row's primary
/// figures (`avgPriPerDay`, `peakPrimary`) whatever `sizeBasis` says. `avg_days` is the days the
/// average was taken over. A field that resolved nowhere is one breakdown row, with the reason.
pub fn csv_files(data: &ClusterData, p: &Period, today: NaiveDate) -> Vec<Entry> {
    let head = |cols: &[&str]| csv_line(&cols.iter().map(|c| c.to_string()).collect::<Vec<_>>());
    let mut daily = vec![head(DAILY_CSV)];
    for r in data.daily_rows(p, today) {
        daily.push(csv_line(&[
            data.id.clone(), csv_num(&r["day"]), csv_num(&r["indices"]), csv_num(&r["docs"]), csv_num(&r["priBytes"]),
            csv_num(&r["totalBytes"]), csv_num(&r["eventBytes"]), (!r["eventBytes"].is_null()).to_string(),
            csv_num(&r["subBytes"]), csv_num(&r["changeVsAvgPct"]), csv_num(&r["avgDays"]),
            csv_num(&r["final"]), read_text(&r), notes_text(&r),
        ]));
    }
    let mut monthly = vec![head(MONTHLY_CSV)];
    for r in data.month_rows(p, data.settings.size_basis, today) {
        monthly.push(csv_line(&[
            data.id.clone(), csv_num(&r["month"]), csv_num(&r["daysWithData"]), csv_num(&r["priBytes"]),
            csv_num(&r["avgPriPerDay"]), csv_num(&r["peakPrimary"]["day"]), csv_num(&r["peakPrimary"]["bytes"]), csv_num(&r["docs"]),
            csv_num(&r["eventBytes"]), csv_num(&r["keptDays"]), csv_num(&r["from"]), csv_num(&r["to"]), csv_num(&r["days"]),
            csv_num(&r["daysMeasured"]["docs"]), csv_num(&r["daysMeasured"]["eventBytes"]), csv_num(&r["daysMeasured"]["size"]),
            csv_num(&r["notFinal"]),
        ]));
    }
    let mut breakdown = vec![head(BREAKDOWN_CSV)];
    let in_period = ClusterData::finished_days(p, today);
    for (key, b) in data.breakdowns(p, today) {
        let error = b["error"].as_str().map(|e| format!("{NOT_MEASURED}: {e}"));
        let note = derive::breakdown_notes(&b, in_period).join("; ");
        if let Some(e) = error {
            let mut row = vec![String::new(); BREAKDOWN_CSV.len()];
            (row[0], row[1], row[4], row[5]) = (data.id.clone(), key.to_string(), p.from.clone(), p.to.clone());
            row[BREAKDOWN_CSV.len() - 1] = e;
            breakdown.push(csv_line(&row));
            continue;
        }
        for r in b["rows"].as_array().into_iter().flatten() {
            breakdown.push(csv_line(&[
                data.id.clone(), key.to_string(), csv_num(&b["resolved"]), csv_num(&r["value"]), p.from.clone(), p.to.clone(),
                csv_num(&r["docs"]), csv_num(&r["eventBytes"]), csv_num(&r["estPriBytes"]), csv_num(&r["sharePct"]),
                csv_num(&r["daysSeen"]), note.clone(),
            ]));
        }
    }
    let file = |lines: Vec<String>| lines.join("\n") + "\n";
    vec![
        Entry::new("daily.csv", file(daily)),
        Entry::new("monthly.csv", file(monthly)),
        Entry::new("breakdown.csv", file(breakdown)),
    ]
}

/* ---------------------------------------- names, mail ---------------------------------------- */

/// A cluster id as part of a file name: letters, digits, `.`, `_`, `-`; anything else `_`.
pub fn file_part(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).take(80).collect();
    if out.is_empty() || out.starts_with('.') { format!("_{out}") } else { out }
}

/// `volume-<cluster>-<from>_<to>.xlsx` (or `.zip` for the CSV bundle).
pub fn file_name(cluster: &str, p: &Period, ext: &str) -> String {
    format!("volume-{}-{}_{}.{ext}", file_part(cluster), p.from, p.to)
}

/// `fmt.bytes` of the UI: 1024-based, two significant decimals below 10.
pub fn human_bytes(n: Option<u64>) -> String {
    const UNITS: [&str; 7] = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
    let Some(n) = n else { return NOT_MEASURED.into() };
    if n == 0 {
        return "0 B".into();
    }
    let i = ((n as f64).ln() / 1024f64.ln()).floor().min(6.0) as usize;
    let v = n as f64 / 1024f64.powi(i as i32);
    let d = if i == 0 || v >= 100.0 { 0 } else if v >= 10.0 { 1 } else { 2 };
    format!("{v:.d$} {}", UNITS[i])
}

/// A basis as the file and the mail name it.
fn basis_name(b: SizeBasis) -> &'static str {
    match b {
        SizeBasis::Primary => "primary size",
        SizeBasis::Total => "total size",
        SizeBasis::EventSize => "event bytes",
    }
}

/// The mail body's lines for one cluster: yesterday, average per day (7), month so far —
/// `derive::cards`, as the Daily page shows them. `today` is today's UTC date.
pub fn mail_summary(store: &Store, id: &str, name: &str, s: &VolumeSettings, today: NaiveDate) -> String {
    let days = store.days_between(id, derive::cards_from(today, derive::AVG_DAYS_DEFAULT), today);
    let history = derive::history(&days, None);
    let today_at = days.iter().find(|d| d.day == day_key(today)).map(|d| d.totals_at);
    let c = derive::cards(&history, today, derive::AVG_DAYS_DEFAULT, s.size_basis, today_at);
    let basis = basis_name(s.size_basis);
    let b = |v: &Value| human_bytes(v.as_u64());
    let y = days.iter().find(|d| d.day == c["yesterday"]["day"].as_str().unwrap_or(""));
    let not_final = match y.filter(|d| !d.is_final).and_then(derive::read_at) {
        Some(at) => format!(" (not final: read {})", about::utc(at)),
        None => String::new(),
    };
    format!(
        "{name} ({basis})\n  Yesterday ({}): {}{not_final}\n  Average per day · {} days: {} ({} of {} days measured)\n  This month so far ({}): {}\n",
        c["yesterday"]["day"].as_str().unwrap_or(""), b(&c["yesterday"]["value"]),
        c["average"]["days"], b(&c["average"]["value"]), c["average"]["daysWithData"], c["average"]["days"],
        c["monthSoFar"]["month"].as_str().unwrap_or(""), month_so_far_text(&c["monthSoFar"]),
    )
}

/// The month so far in words: its figure and what it rests on. With none of its finished days
/// measured it is not the month's figure, whatever today already holds.
fn month_so_far_text(m: &Value) -> String {
    let (days, measured) = (m["days"].as_i64().unwrap_or(0), m["daysMeasured"].as_i64().unwrap_or(0));
    let today = m["todayValue"].as_u64().map(|v| (human_bytes(Some(v)), m["asOf"].as_i64().map(about::utc).unwrap_or_else(|| about::NOT_READ.into())));
    let so_far = today.map(|(v, at)| format!("; today so far {v}, read {at}, is not in it")).unwrap_or_default();
    let open = match m["notFinal"].as_u64().unwrap_or(0) {
        0 => String::new(),
        n => format!(", {n} not final"),
    };
    let value = if measured == 0 { NOT_MEASURED.into() } else { human_bytes(m["value"].as_u64()) };
    format!("{value} ({measured} of {days} finished days measured{open}{so_far})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::{FieldAgg, TopValue};

    fn day(k: &str, pri: u64, docs: Option<u64>, ev: Option<u64>) -> Day {
        let mut d = Day { day: k.into(), is_final: true, live: true, indices: 1, pri_bytes: Some(pri), total_bytes: Some(pri * 2), docs, event_bytes: ev, ..Day::default() };
        d.fields.insert("tag".into(), FieldAgg {
            field: Some("tag1".into()),
            top: vec![TopValue { value: "=cmd|' /C calc'!A0".into(), docs: docs.unwrap_or(0) / 2, event_bytes: None, sub_bytes: None }],
            other_docs: docs.unwrap_or(0) - docs.unwrap_or(0) / 2,
            ..FieldAgg::default()
        });
        d.fields.insert("sourceHost".into(), FieldAgg { error: Some("src_hostname: not in the mapping".into()), ..FieldAgg::default() });
        d
    }

    fn data() -> ClusterData {
        let days = vec![
            day("2026-10-18", 100, Some(10), Some(5)),
            day("2026-10-19", 200, Some(20), None),
            day("2026-10-20", 1_073_741_824, None, None),
        ];
        ClusterData { id: "prod/eu".into(), name: "Production EU with a very long name".into(), settings: VolumeSettings::default(), days, warnings: vec![] }
    }

    /// 1 to 23 November, 14 of them recorded, today (the 24th) still open: an auditor's month.
    #[test]
    fn a_month_row_counts_the_periods_finished_days_and_says_how_many() {
        let mut d = data();
        d.days = (1..=14).map(|n| day(&format!("2026-11-{n:02}"), 100, Some(10), (n <= 9).then_some(5))).collect();
        d.days.push(Day { is_final: false, ..day("2026-11-24", 9_000_000, Some(9_000_000), Some(9_000_000)) });
        let p: Period = serde_json::from_value(json!({ "from": "2026-11-01", "to": "2026-11-24", "label": "2026-11 (so far)" })).unwrap();
        let today = parse_day("2026-11-24").unwrap();
        let rows = d.month_rows(&p, SizeBasis::EventSize, today);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!((r["label"].as_str(), r["days"].as_i64(), r["docs"].as_u64(), r["eventBytes"].as_u64()), (Some("2026-11 (1–23)"), Some(23), Some(140), Some(45)),
                   "never today");
        assert_eq!(days_measured_text(r), "documents 14, event bytes 9, size 14 of 23 days");
        assert_eq!(r["peakDay"]["day"], "2026-11-01");
        // Yesterday read before it was 24 h over: counted, and said.
        d.days[13].is_final = false;
        let r2 = &d.month_rows(&p, SizeBasis::EventSize, today)[0];
        assert_eq!((r2["docs"].as_u64(), days_measured_text(r2).as_str()), (Some(140), "documents 14, event bytes 9, size 14 of 23 days; 1 not final"));
        let b = &d.breakdowns(&p, today)[0].1;
        assert_eq!((b["totals"]["docs"].as_u64(), b["notFinalDays"].as_u64()), (Some(140), Some(1)), "a breakdown never counts today");
        assert!(derive::breakdown_notes(b, ClusterData::finished_days(&p, today)).contains(&"1 of the days not final".to_string()));
        d.days[13].is_final = true;
        // A period inside the month is that period, not the month.
        let p: Period = serde_json::from_value(json!({ "from": "2026-11-10", "to": "2026-11-12", "label": "x" })).unwrap();
        let r = &d.month_rows(&p, SizeBasis::EventSize, today)[0];
        assert_eq!((r["label"].as_str(), r["docs"].as_u64(), r["eventBytes"].clone(), r["peakDay"].clone(), r["avgPerDay"].clone()),
                   (Some("2026-11 (10–12)"), Some(30), Value::Null, Value::Null, Value::Null), "no final day measured: no peak, no average");
        // No record at all: the month is there, and says 0 of N.
        d.days.clear();
        let r = &d.month_rows(&p, SizeBasis::EventSize, today)[0];
        assert_eq!((days_measured_text(r).as_str(), r["docs"].clone()), ("0 of 3 days", Value::Null));
        // Only today: no finished day, no row.
        let p: Period = serde_json::from_value(json!({ "from": "2026-11-24", "to": "2026-11-24", "label": "x" })).unwrap();
        assert!(d.month_rows(&p, SizeBasis::EventSize, today).is_empty());
    }

    #[test]
    fn a_missing_day_is_a_row_and_every_row_says_when_it_was_read_and_what_is_missing() {
        let mut d = data();
        d.days.remove(1); // the 19th
        d.days[1].is_final = false;
        d.days[1].aggregated_at = Some(1_792_500_000_000);
        d.days[1].event_missing_docs = Some(0);
        let d = d.with_warnings(&["prod/eu is unreachable".to_string()]);
        let today = parse_day("2026-10-29").unwrap();
        let rows = d.daily_rows(&period(), today);
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0]["day"].as_str(), rows[0]["missing"].clone(), rows[0]["docs"].clone()), (Some("2026-10-19"), json!(true), Value::Null));
        assert_eq!(notes_text(&rows[0]), format!("{NO_RECORD}; prod/eu is unreachable"));
        assert!(notes_text(&rows[1]).starts_with("not final: read 2026-10-20") && notes_text(&rows[1]).ends_with("; prod/eu is unreachable"), "{}", notes_text(&rows[1]));
        let csv = String::from_utf8(csv_files(&d, &period(), today)[0].data.clone()).unwrap();
        assert!(csv.lines().nth(1).unwrap().starts_with("prod/eu,2026-10-19,,,,,,false,,,,false,not read,the record holds nothing"), "{csv}");
        let mut a = volume_about(&period(), 1);
        d.describe(&period(), today, &mut a);
        assert!(a.warnings.iter().any(|w| w.contains("1 of 2 days not measured") && w.contains("2026-10-19")), "{:?}", a.warnings);
        assert!(a.warnings.iter().any(|w| w.contains("1 of 2 days not final: 2026-10-20")), "{:?}", a.warnings);
        assert!(a.warnings.iter().any(|w| w.contains("unreachable")));
        assert!(a.clusters[0].0.contains("prod/eu") && a.clusters[0].1.starts_with("2026-10-20"), "{:?}", a.clusters);
    }

    #[test]
    fn no_earlier_day_is_said_only_when_there_is_none() {
        let row = |j: Value| change_cell(&j);
        assert_eq!(row(json!({ "basis": 5, "earlierDays": 0, "avgDays": 0 })), Cell::text("no earlier day"));
        assert_eq!(row(json!({ "basis": 5, "earlierDays": 6, "avgDays": 0 })), Cell::text(NOT_MEASURED), "six earlier days, none measured");
        assert_eq!(row(json!({ "basis": null, "earlierDays": 6, "avgDays": 6 })), Cell::text(NOT_MEASURED));
        assert_eq!(row(json!({ "basis": 5, "earlierDays": 6, "avgDays": 6 })), Cell::text("average is 0"));
        assert_eq!(row(json!({ "missing": true })), Cell::text(NOT_MEASURED));
    }

    #[test]
    fn the_mail_says_how_much_of_the_month_was_measured() {
        let m = |v: Value| month_so_far_text(&v);
        assert_eq!(m(json!({ "value": 1024, "days": 23, "daysMeasured": 9, "todayValue": null })), "1.00 KB (9 of 23 finished days measured)");
        assert_eq!(m(json!({ "value": null, "days": 23, "daysMeasured": 0, "todayValue": null })), "not measured (0 of 23 finished days measured)");
        assert!(m(json!({ "value": 1024, "days": 23, "daysMeasured": 9, "notFinal": 1, "todayValue": 7, "asOf": 1 })).starts_with("1.00 KB (9 of 23 finished days measured, 1 not final; today so far 7 B, read 1970"));
        assert!(m(json!({ "value": null, "days": 23, "daysMeasured": 0, "todayValue": 1024, "asOf": 1 })).starts_with("not measured (0 of 23 finished days measured; today 1.00 KB, read 1970"));
        assert!(m(json!({ "value": null, "days": 0, "daysMeasured": 0, "todayValue": 1024, "asOf": 1 })).starts_with("not measured (0 of 0 finished days measured; today so far 1.00 KB, read 1970"));
    }

    fn period() -> Period {
        serde_json::from_value(serde_json::json!({ "from": "2026-10-19", "to": "2026-10-20", "label": "x" })).unwrap()
    }

    /// A layout somebody saved: every column the sheets can carry, primary size shown.
    fn layouts() -> Value {
        serde_json::json!({
            "daily": { "order": ["day", "indices", "docs", "priBytes", "topExtra", "eventBytes", "subBytes", "changeVsAvg",
                "topSourceHost", "topForwarder", "totalBytes", "topTag", "topSourceIp"],
                "hidden": ["totalBytes", "topTag", "topSourceIp"], "labels": { "docs": "Events" } },
            "monthly": { "order": ["month", "daysWithData", "priBytes", "topExtra", "avgPerDay", "peakDay", "docs", "eventBytes",
                "subBytes", "topSourceHost", "topForwarder", "from"], "hidden": ["from"], "labels": {} },
        })
    }

    #[test]
    fn the_default_layout_puts_event_bytes_first_and_hides_index_size() {
        // What VOLUME_LAYOUT_GET answers while nobody has saved a layout (docs/VOLUME.md):
        // the Reports pages' own default, so the file and the page start out alike.
        let d = data();
        let all: Vec<String> = SHEETS.iter().map(|s| s.to_string()).collect();
        let def = serde_json::json!({
            "daily": { "order": crate::volume::DAILY_COLUMNS, "hidden": crate::volume::DAILY_HIDDEN, "labels": {} },
            "monthly": { "order": crate::volume::MONTHLY_COLUMNS, "hidden": crate::volume::MONTHLY_HIDDEN, "labels": {} },
        });
        let s = sheets(&d, &period(), &def, parse_day("2026-10-29").unwrap(), &all, false);
        let head: Vec<String> = s[0].rows[0].iter().map(text).collect();
        assert_eq!(head, ["Day", "Indices", "Documents", "Event bytes (bytes)", "Change vs average %", "Read at (UTC)", "Note"], "{head:?}");
        let mh: Vec<String> = s[1].rows[0].iter().map(text).collect();
        assert_eq!(&mh[..4], &["Month", "Days with data", "Documents", "Event bytes (bytes)"], "{mh:?}");
        assert!(!mh.iter().chain(head.iter()).any(|h| h.starts_with("Primary size") || h.starts_with("Total size")), "index size is hidden: {mh:?}");
    }

    fn text(c: &Cell) -> String {
        match c {
            Cell::Text(s) | Cell::Head(s) => s.clone(),
            Cell::Int(v) | Cell::Dec(v) | Cell::Num(v) => v.to_string(),
            Cell::Empty => String::new(),
        }
    }

    #[test]
    fn the_daily_sheet_follows_the_layout_and_says_not_measured() {
        let d = data();
        let today = parse_day("2026-10-29").unwrap();
        let all: Vec<String> = SHEETS.iter().map(|s| s.to_string()).collect();
        let sheets = sheets(&d, &period(), &layouts(), today, &all, false);
        assert_eq!(sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Daily", "Monthly", "Breakdown"]);
        let daily = &sheets[0].rows;
        let head: Vec<String> = daily[0].iter().map(text).collect();
        assert_eq!(&head[..6], &["Day", "Indices", "Events", "Primary size (bytes)", "Primary size GB", "Top Dataset"], "{head:?}");
        assert!(!head.iter().any(|h| h.starts_with("Total size") || h == "Top tag"), "hidden columns are left out: {head:?}");
        assert_eq!(daily.len(), 3, "the period's two days");
        let docs = head.iter().position(|h| h == "Events").unwrap();
        assert_eq!(daily[2][docs], Cell::text(NOT_MEASURED), "null docs is 'not measured', never 0 or empty");
        assert_eq!(daily[2][4], Cell::Dec(1.0), "GB beside primary: 1024³ bytes");
        let ev = head.iter().position(|h| h == "Event bytes (bytes)").unwrap();
        assert_eq!(daily[1][ev], Cell::text(NOT_MEASURED));
        let ch = head.iter().position(|h| h == "Change vs average %").unwrap();
        assert_eq!(daily[1][ch], Cell::Dec(100.0), "200 against the 18th's 100: derive's figure");
        // Monthly: the month's summary, from derive.
        let monthly = &sheets[1].rows;
        let mh: Vec<String> = monthly[0].iter().map(text).collect();
        assert!(mh.contains(&"Peak day".to_string()) && mh.contains(&"Peak day (bytes)".to_string()), "{mh:?}");
        assert!(!mh.contains(&"Kept record days".to_string()), "hidden by the layout");
        assert_eq!(monthly[1][0], Cell::text("2026-10 (19–20)"), "the dates it covers, not a whole month");
        // Breakdown: a block per field; an unresolved field says so.
        let b: Vec<String> = sheets[2].rows.iter().flat_map(|r| r.iter().map(text)).collect();
        assert!(b.iter().any(|t| t.starts_with("Tag · field tag1")), "{b:?}");
        assert!(b.iter().any(|t| t == "Primary size est. (bytes)"), "the estimate says est.");
        assert!(b.iter().any(|t| t.starts_with("not measured: src_hostname")), "{b:?}");
    }

    #[test]
    fn several_clusters_get_prefixed_sheet_names_within_31() {
        let d = data();
        let all: Vec<String> = SHEETS.iter().map(|s| s.to_string()).collect();
        let s = sheets(&d, &period(), &layouts(), parse_day("2026-10-29").unwrap(), &all, true);
        for sh in &s {
            assert!(sh.name.chars().count() <= 31, "{}", sh.name);
            assert!(sh.name.starts_with("Production EU"), "{}", sh.name);
        }
        assert!(s[2].name.ends_with(" Breakdown"));
        let only = sheets(&d, &period(), &layouts(), parse_day("2026-10-29").unwrap(), &["monthly".into()], false);
        assert_eq!(only.len(), 1);
    }

    #[test]
    fn csv_columns_and_formula_escaping() {
        assert_eq!(csv_escape("=1+1"), "'=1+1");
        assert_eq!(csv_escape("-12.5"), "-12.5", "numbers keep their sign");
        assert_eq!(csv_escape("-x"), "'-x");
        assert_eq!(csv_escape("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_escape("a\rb"), "\"a\rb\"", "a lone carriage return is quoted");
        assert_eq!(csv_escape("\rx"), "\"'\rx\"", "defused and quoted");
        let files = csv_files(&data(), &period(), parse_day("2026-10-29").unwrap());
        let text = |i: usize| String::from_utf8(files[i].data.clone()).unwrap();
        let daily = text(0);
        let mut lines = daily.lines();
        assert_eq!(lines.next().unwrap(), DAILY_CSV.join(","));
        assert_eq!(lines.next().unwrap(), "prod/eu,2026-10-19,1,20,200,400,,false,,100.0,1,true,not read,", "null is empty, flagged unmeasured; one day averaged, not 7");
        assert!(lines.next().unwrap().starts_with("prod/eu,2026-10-20,1,,1073741824,2147483648,,false,,"), "unmeasured docs: empty");
        assert_eq!(text(1).lines().next().unwrap(), MONTHLY_CSV.join(","));
        assert!(text(1).lines().nth(1).unwrap().starts_with("prod/eu,2026-10,2,"), "the period's two days, not the month's three: {}", text(1));
        let b = text(2);
        assert_eq!(b.lines().next().unwrap(), BREAKDOWN_CSV.join(","));
        assert!(b.contains("'=cmd|' /C calc'!A0"), "a value that looks like a formula is defused: {b}");
    }

    /// Off primary size, the columns named for primary size still carry primary figures,
    /// and the basis-following ones say which figure they are.
    #[test]
    fn primary_columns_carry_primary_under_another_basis() {
        let mut d = data();
        d.settings.size_basis = SizeBasis::EventSize;
        let today = parse_day("2026-10-29").unwrap();
        let files = csv_files(&d, &period(), today);
        let monthly = String::from_utf8(files[1].data.clone()).unwrap();
        assert_eq!(monthly.lines().nth(1).unwrap(), "prod/eu,2026-10,2,1073742024,536871012,2026-10-20,1073741824,20,,0,2026-10-19,2026-10-20,2,1,0,2",
                   "avg and peak primary, not the event-bytes basis");
        let sheets = sheets(&d, &period(), &layouts(), today, &["monthly".into()], false);
        let head: Vec<String> = sheets[0].rows[0].iter().map(text).collect();
        assert!(head.contains(&"Average per day · event bytes (bytes)".to_string()), "{head:?}");
        assert!(head.contains(&"Peak day · event bytes (bytes)".to_string()), "{head:?}");
        let avg = head.iter().position(|h| h.starts_with("Average per day")).unwrap();
        assert_eq!(sheets[0].rows[1][avg], Cell::text(NOT_MEASURED), "the basis figure, under a header that names it: event bytes are measured on neither day");
    }

    #[test]
    fn names_and_sizes() {
        let p = period();
        assert_eq!(file_name("prod/eu", &p, "xlsx"), "volume-prod_eu-2026-10-19_2026-10-20.xlsx");
        assert_eq!(file_part("../x"), "_.._x");
        assert_eq!(human_bytes(Some(0)), "0 B");
        assert_eq!(human_bytes(Some(1536)), "1.50 KB");
        assert_eq!(human_bytes(Some(150 * 1024 * 1024)), "150 MB");
        assert_eq!(human_bytes(None), NOT_MEASURED);
    }
}
