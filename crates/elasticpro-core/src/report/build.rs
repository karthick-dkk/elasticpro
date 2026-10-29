//! What goes into a report file: the sheets, the CSV files, the mail's summary lines.
//!
//! Every number comes from `volume::derive` — `daily_row`, `month_row`, `breakdown`,
//! `cards` — exactly as the pages get it. This file only lays those answers out. That is
//! the rule this codebase keeps relearning: a figure computed twice drifts.
//!
//! `null` stays visible. A cell whose figure was not measured reads "not measured" in the
//! workbook (an empty cell is what somebody totals as 0), and is empty in the CSV with the
//! `event_bytes_measured` column beside the one figure that is often unmeasured.

use super::period::Period;
use super::xlsx::{Cell, Sheet};
use super::zip::Entry;
use crate::volume::derive::{self, Totals};
use crate::volume::schedule::{day_key, month_key, parse_day};
use crate::volume::store::{ClusterState, Store};
use crate::volume::{column_label, Day, SizeBasis, VolumeSettings, FIELD_KEYS};
use chrono::{Duration, NaiveDate};
use serde_json::Value;

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
    pub state: ClusterState,
}

impl ClusterData {
    pub fn load(store: &Store, id: &str, name: &str, settings: VolumeSettings, period: &Period) -> ClusterData {
        let from = period.from_date() - Duration::days(derive::AVG_DAYS_DEFAULT as i64);
        ClusterData {
            id: id.into(),
            name: name.into(),
            settings,
            days: store.days_between(id, from, period.to_date()),
            state: store.read_state(id),
        }
    }

    fn in_period<'a>(&'a self, p: &'a Period) -> impl Iterator<Item = &'a Day> + 'a {
        let (f, t) = (p.from_date(), p.to_date());
        self.days.iter().filter(move |d| parse_day(&d.day).is_some_and(|x| x >= f && x <= t))
    }

    /// `DailyRow`s of the period (`derive::daily_row`, average over `AVG_DAYS_DEFAULT`).
    pub fn daily_rows(&self, p: &Period) -> Vec<Value> {
        let history = derive::history(&self.days, None);
        self.in_period(p)
            .filter_map(|d| Some(derive::daily_row(d, &Totals::of(d, None)?, &history, derive::AVG_DAYS_DEFAULT, self.settings.size_basis, None)))
            .collect()
    }

    /// Month rows (`derive::month_row`) of every month the period touches that has a record.
    pub fn month_rows(&self, p: &Period, basis: SizeBasis, today: NaiveDate) -> Vec<Value> {
        let (first, last) = (month_key(p.from_date()), month_key(p.to_date()));
        let current = month_key(today);
        self.state.months.values().filter(|m| m.month >= first && m.month <= last)
            .map(|m| derive::month_row(m, basis, &current)).collect()
    }

    /// One `derive::breakdown` per field, over the period.
    pub fn breakdowns(&self, p: &Period) -> Vec<(&'static str, Value)> {
        let days: Vec<&Day> = self.in_period(p).collect();
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

/* ------------------------------------------ cells ------------------------------------------ */

fn int_or_nm(v: &Value) -> Cell {
    match v.as_f64() {
        Some(n) => Cell::Int(n),
        None => Cell::text(NOT_MEASURED),
    }
}

fn gb(v: &Value) -> Cell {
    match v.as_f64() {
        Some(n) => Cell::Dec((n / GB * 100.0).round() / 100.0),
        None => Cell::text(NOT_MEASURED),
    }
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

fn daily_sheet(data: &ClusterData, p: &Period, layouts: &Value) -> Vec<Vec<Cell>> {
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
    let mut rows = vec![head];
    for r in data.daily_rows(p) {
        let mut row = vec![];
        for (k, _) in &cols {
            match k.as_str() {
                "day" => row.push(Cell::text(r["day"].as_str().unwrap_or(""))),
                "indices" | "docs" | "totalBytes" | "eventBytes" | "subBytes" => row.push(int_or_nm(&r[k.as_str()])),
                "priBytes" => {
                    row.push(int_or_nm(&r["priBytes"]));
                    row.push(gb(&r["priBytes"]));
                }
                // No earlier day to compare with is not a measurement that failed.
                "changeVsAvg" => row.push(r["changeVsAvgPct"].as_f64().map(Cell::Dec).unwrap_or_else(|| Cell::text("no earlier day"))),
                "topExtra" => row.push(top_cell(&r["top"]["extra"])),
                "topSourceHost" => row.push(top_cell(&r["top"]["sourceHost"])),
                "topForwarder" => row.push(top_cell(&r["top"]["forwarder"])),
                "topTag" => row.push(top_cell(&r["top"]["tag"])),
                "topSourceIp" => row.push(top_cell(&r["top"]["sourceIp"])),
                _ => row.push(Cell::Empty),
            }
        }
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
    let mut rows = vec![head];
    for r in data.month_rows(p, data.settings.size_basis, today) {
        let mut row = vec![];
        for (k, _) in &cols {
            match k.as_str() {
                "month" => {
                    let m = r["month"].as_str().unwrap_or("");
                    row.push(Cell::text(if r["partial"] == true { format!("{m} (so far)") } else { m.to_string() }));
                }
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
        rows.push(row);
    }
    rows
}

fn breakdown_sheet(data: &ClusterData, p: &Period) -> Vec<Vec<Cell>> {
    let mut rows: Vec<Vec<Cell>> = vec![];
    for (key, b) in data.breakdowns(p) {
        if !rows.is_empty() {
            rows.push(vec![]);
        }
        let resolved = b["resolved"].as_str().map(|f| format!(" · field {f}")).unwrap_or_default();
        rows.push(vec![Cell::head(format!("{}{resolved} · {} – {}", data.field_label(key), p.from, p.to))]);
        if let Some(e) = b.get("error").and_then(Value::as_str) {
            rows.push(vec![Cell::text(format!("{NOT_MEASURED}: {e}"))]);
            continue;
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
            "daily" => ("Daily", daily_sheet(data, p, layouts)),
            "monthly" => ("Monthly", monthly_sheet(data, p, layouts, today)),
            _ => ("Breakdown", breakdown_sheet(data, p)),
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
    if v.contains(['"', ',', '\n']) { format!("\"{}\"", v.replace('"', "\"\"")) } else { v }
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
    "event_bytes_measured", "sub_bytes", "change_vs_avg_pct", "avg_days"];
pub const MONTHLY_CSV: &[&str] = &["cluster", "month", "days_with_data", "primary_bytes", "avg_primary_bytes_per_day",
    "peak_day", "peak_primary_bytes", "docs", "event_bytes", "from_kept_record_days"];
pub const BREAKDOWN_CSV: &[&str] = &["cluster", "field", "field_resolved", "value", "period_from", "period_to", "docs",
    "event_bytes", "primary_bytes_estimated", "share_pct", "days_seen"];

/// `daily.csv`, `monthly.csv`, `breakdown.csv` (docs/VOLUME.md "CSV columns"). The monthly
/// file's columns are named for primary size, so they carry the month row's primary
/// figures (`avgPriPerDay`, `peakPrimary`) whatever `sizeBasis` says.
pub fn csv_files(data: &ClusterData, p: &Period, today: NaiveDate) -> Vec<Entry> {
    let head = |cols: &[&str]| csv_line(&cols.iter().map(|c| c.to_string()).collect::<Vec<_>>());
    let mut daily = vec![head(DAILY_CSV)];
    for r in data.daily_rows(p) {
        daily.push(csv_line(&[
            data.id.clone(), csv_num(&r["day"]), csv_num(&r["indices"]), csv_num(&r["docs"]), csv_num(&r["priBytes"]),
            csv_num(&r["totalBytes"]), csv_num(&r["eventBytes"]), (!r["eventBytes"].is_null()).to_string(),
            csv_num(&r["subBytes"]), csv_num(&r["changeVsAvgPct"]), derive::AVG_DAYS_DEFAULT.to_string(),
        ]));
    }
    let mut monthly = vec![head(MONTHLY_CSV)];
    for r in data.month_rows(p, data.settings.size_basis, today) {
        monthly.push(csv_line(&[
            data.id.clone(), csv_num(&r["month"]), csv_num(&r["daysWithData"]), csv_num(&r["priBytes"]),
            csv_num(&r["avgPriPerDay"]), csv_num(&r["peakPrimary"]["day"]), csv_num(&r["peakPrimary"]["bytes"]), csv_num(&r["docs"]),
            csv_num(&r["eventBytes"]), csv_num(&r["keptDays"]),
        ]));
    }
    let mut breakdown = vec![head(BREAKDOWN_CSV)];
    for (key, b) in data.breakdowns(p) {
        for r in b["rows"].as_array().into_iter().flatten() {
            breakdown.push(csv_line(&[
                data.id.clone(), key.to_string(), csv_num(&b["resolved"]), csv_num(&r["value"]), p.from.clone(), p.to.clone(),
                csv_num(&r["docs"]), csv_num(&r["eventBytes"]), csv_num(&r["estPriBytes"]), csv_num(&r["sharePct"]),
                csv_num(&r["daysSeen"]),
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
    format!(
        "{name} ({basis})\n  Yesterday ({}): {}\n  Average per day · {} days: {} ({} days with data)\n  This month so far ({}): {}\n",
        c["yesterday"]["day"].as_str().unwrap_or(""), b(&c["yesterday"]["value"]),
        c["average"]["days"], b(&c["average"]["value"]), c["average"]["daysWithData"],
        c["monthSoFar"]["month"].as_str().unwrap_or(""), b(&c["monthSoFar"]["value"]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::{FieldAgg, TopValue};

    fn day(k: &str, pri: u64, docs: Option<u64>, ev: Option<u64>) -> Day {
        let mut d = Day { day: k.into(), is_final: true, live: true, indices: 1, pri_bytes: pri, total_bytes: pri * 2, docs, event_bytes: ev, ..Day::default() };
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
        let mut state = ClusterState::default();
        let map: std::collections::BTreeMap<String, Day> = days.iter().map(|d| (d.day.clone(), d.clone())).collect();
        state.months.insert("2026-10".into(), derive::month_summary("2026-10", &map));
        ClusterData { id: "prod/eu".into(), name: "Production EU with a very long name".into(), settings: VolumeSettings::default(), days, state }
    }

    fn period() -> Period {
        serde_json::from_value(serde_json::json!({ "from": "2026-10-19", "to": "2026-10-20", "label": "x" })).unwrap()
    }

    fn layouts() -> Value {
        serde_json::json!({
            "daily": { "order": crate::volume::DAILY_COLUMNS, "hidden": crate::volume::DAILY_HIDDEN, "labels": { "docs": "Events" } },
            "monthly": { "order": crate::volume::MONTHLY_COLUMNS, "hidden": ["from"], "labels": {} },
        })
    }

    fn text(c: &Cell) -> String {
        match c {
            Cell::Text(s) | Cell::Head(s) => s.clone(),
            Cell::Int(v) | Cell::Dec(v) => v.to_string(),
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
        assert_eq!(monthly[1][0], Cell::text("2026-10 (so far)"), "the current month says so");
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
        let files = csv_files(&data(), &period(), parse_day("2026-10-29").unwrap());
        let text = |i: usize| String::from_utf8(files[i].data.clone()).unwrap();
        let daily = text(0);
        let mut lines = daily.lines();
        assert_eq!(lines.next().unwrap(), DAILY_CSV.join(","));
        assert_eq!(lines.next().unwrap(), "prod/eu,2026-10-19,1,20,200,400,,false,,100.0,7", "null is empty, flagged unmeasured");
        assert!(lines.next().unwrap().starts_with("prod/eu,2026-10-20,1,,1073741824,2147483648,,false,,"), "unmeasured docs: empty");
        assert_eq!(text(1).lines().next().unwrap(), MONTHLY_CSV.join(","));
        assert!(text(1).lines().nth(1).unwrap().starts_with("prod/eu,2026-10,3,"), "{}", text(1));
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
        assert_eq!(monthly.lines().nth(1).unwrap(), "prod/eu,2026-10,3,1073742124,357914041,2026-10-20,1073741824,30,5,0",
                   "avg and peak primary, not the event-bytes basis (5 per day, peak the 18th)");
        let sheets = sheets(&d, &period(), &layouts(), today, &["monthly".into()], false);
        let head: Vec<String> = sheets[0].rows[0].iter().map(text).collect();
        assert!(head.contains(&"Average per day · event bytes (bytes)".to_string()), "{head:?}");
        assert!(head.contains(&"Peak day · event bytes (bytes)".to_string()), "{head:?}");
        let avg = head.iter().position(|h| h.starts_with("Average per day")).unwrap();
        assert_eq!(sheets[0].rows[1][avg], Cell::Int(5.0), "the basis figure, under a header that names it");
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
