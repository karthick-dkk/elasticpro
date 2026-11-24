//! The indices report (docs/REPORT-TYPES.md "Indices report"): one row per index per day,
//! from a fresh `_cat/indices` per cluster at build time, dated by the cluster's naming rule.
//!
//! The one export whose size is **index store size** (`pri.store.size`), not event_logsize
//! (the user's decision). A day whose indices retention has deleted is one row from the
//! daily record (`Day::sizes`, the one definition of a day's primary size), and so is a day that
//! lost some of them: what is left of a day is not the day. A day the record does not hold
//! either says *not measured*. A closed index says *closed* and has no figures — not 0. A cluster whose listing failed
//! says so in its sheet's first row; the error body never lands in the file.

use super::about::{self, About};
use super::build::{csv_escape, file_part, gb_cell, human_bytes, NOT_MEASURED};
use super::period::Period;
use super::xlsx::{Cell, Sheet};
use super::zip::Entry;
use crate::http::EsRequest;
use crate::volume::collect::Indices;
use crate::volume::schedule::{day_key, months_between};
use crate::volume::Day;
use chrono::NaiveDate;
use serde_json::Value;
use std::collections::BTreeMap;

pub const ORIGIN: &str = "volume-indices";
pub const DELETED: &str = "indices deleted — from the daily record";
pub const NO_DATE_TITLE: &str = "No date in the name";
pub const NO_DATE_WHY: &str = "These indices carry no day in their name, so they are listed by creation date (UTC) and are not in the day totals.";

/// Why an index is listed and not counted: on its row, and counted in the total's note.
pub const NO_DATE_NOTE: &str = "no date in the name: not in the totals";

/// The month a name with no day in it is named for (`logstash-linux-2026.10` → `2026-10`).
pub fn month_in_name(name: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?:^|\D)(20\d{2})[.\-_](0[1-9]|1[0-2])(?:\D|$)").ok()?;
    re.captures(name).map(|c| format!("{}-{}", &c[1], &c[2]))
}

/// An undated index's note in a file over `p`.
fn undated_note(name: &str, p: &Period) -> String {
    match month_in_name(name).filter(|m| !months_between(p.from_date(), p.to_date()).contains(m)) {
        Some(m) => format!("{NO_DATE_NOTE}; named for {m}"),
        None => NO_DATE_NOTE.to_string(),
    }
}

/// The one request per cluster.
pub fn cat_request(cluster: &str, ind: &Indices, timeout_ms: u64) -> EsRequest {
    EsRequest {
        cluster_id: cluster.to_string(),
        method: "GET".into(),
        path: format!("/_cat/indices/{}?format=json&bytes=b&h=index,status,health,docs.count,pri.store.size,creation.date", ind.expr()),
        timeout_ms: Some(timeout_ms),
        allow_writes: false,
        origin: Some(ORIGIN.into()),
        class: crate::gate::Class::Background,
        ..Default::default()
    }
}

/// Why a request failed, for a sheet and a mail: what kind of failure and its HTTP status,
/// never the body Elasticsearch sent with it.
pub fn failure_reason(res: &Value) -> String {
    let status = res.get("status").and_then(Value::as_u64).filter(|s| *s > 0).or_else(|| res.get("httpStatus").and_then(Value::as_u64));
    match (res.get("kind").and_then(Value::as_str), status) {
        (_, Some(401)) => "HTTP 401: the cluster refused the credential (Cluster Management)".into(),
        (_, Some(403)) => "HTTP 403: the credential may not list indices".into(),
        (Some("timeout"), _) => "the request timed out".into(),
        (_, Some(s)) => format!("HTTP {s}"),
        (Some(k), None) => format!("the request failed ({k})"),
        (None, None) => "the request failed".into(),
    }
}

/// One index as listed.
#[derive(Clone, Debug, PartialEq)]
pub struct IndexRow {
    pub name: String,
    pub day: Option<NaiveDate>,
    pub open: bool,
    pub status: String,
    pub docs: Option<u64>,
    pub pri: Option<u64>,
    /// `creation.date`, ms since the epoch.
    pub created: Option<i64>,
}

fn num(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::String(s) => s.trim().parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

/// The rows of a `_cat/indices?format=json&bytes=b` answer. A closed index has no figures.
pub fn read_rows(rows: &Value, ind: &Indices) -> Vec<IndexRow> {
    let mut out = vec![];
    for r in rows.as_array().into_iter().flatten() {
        let Some(name) = r.get("index").and_then(Value::as_str) else { continue };
        let status = r.get("status").and_then(Value::as_str).unwrap_or("open").to_string();
        let open = status == "open";
        out.push(IndexRow {
            name: name.to_string(),
            day: ind.name_day(name).map(|(d, _)| d),
            open,
            docs: if open { num(r.get("docs.count")) } else { None },
            pri: if open { num(r.get("pri.store.size")) } else { None },
            created: num(r.get("creation.date")).map(|v| v as i64),
            status,
        });
    }
    out
}

/// What one day of the period is.
#[derive(Clone, Debug, PartialEq)]
pub enum DayLine {
    /// Live indices: how many, how many without figures (closed, red), and the others' sums
    /// (`None` when there is no other).
    Live { indices: u64, closed: u64, docs: Option<u64>, pri: Option<u64> },
    /// Some of the day's indices went (or closed) since the record read them all: the record's
    /// figures, for `gone` of `indices`.
    Partly { indices: u64, gone: u64, docs: Option<u64>, pri: Option<u64> },
    /// No live index, and the record holds the day: its documents and primary size (either
    /// `None` when the record could not measure it).
    Deleted { docs: Option<u64>, pri: Option<u64> },
    /// Neither listed nor recorded.
    NotMeasured,
}

/// One cluster's part of the report.
#[derive(Clone, Debug)]
pub struct ClusterIndices {
    pub id: String,
    pub name: String,
    /// The listing failed: why (the sheet's first row, the mail names the cluster).
    pub failure: Option<String>,
    /// Dated indices of the period, by day then name.
    pub rows: Vec<IndexRow>,
    /// Indices with no date in their name, by name.
    pub undated: Vec<IndexRow>,
    pub days: Vec<(NaiveDate, DayLine)>,
    /// When the listing was read, epoch ms. `None`: it was not.
    pub read_at: Option<i64>,
}

/// Lay one cluster's listing over the period, the record filling the days with no live index.
pub fn assemble(id: &str, name: &str, listed: Vec<IndexRow>, p: &Period, record: &[Day], read_at: Option<i64>) -> ClusterIndices {
    let (f, t) = (p.from_date(), p.to_date());
    let mut rows: Vec<IndexRow> = vec![];
    let mut undated: Vec<IndexRow> = vec![];
    for r in listed {
        match r.day {
            Some(d) if d >= f && d <= t => rows.push(r),
            Some(_) => {}
            None => undated.push(r),
        }
    }
    rows.sort_by(|a, b| a.day.cmp(&b.day).then_with(|| a.name.cmp(&b.name)));
    undated.sort_by(|a, b| a.name.cmp(&b.name));
    let mut by_day: BTreeMap<NaiveDate, (u64, u64, Option<u64>, Option<u64>)> = BTreeMap::new();
    for r in &rows {
        let e = by_day.entry(r.day.unwrap_or(f)).or_default();
        e.0 += 1;
        // Closed, or red: no figure is not 0.
        match r.docs.zip(r.pri) {
            Some((docs, pri)) => {
                e.2 = Some(e.2.unwrap_or(0) + docs);
                e.3 = Some(e.3.unwrap_or(0) + pri);
            }
            None => e.1 += 1,
        }
    }
    let recorded: BTreeMap<String, &Day> = record.iter().map(|d| (d.day.clone(), d)).collect();
    let days = p.days().into_iter().map(|d| {
        // What the record counted on the day with every index there, dated by name.
        let whole = recorded.get(&day_key(d)).filter(|r| r.sizes().0.is_some()).map(|r| (r.indices - r.unmeasured_size_indices.min(r.indices), *r));
        let line = match by_day.get(&d) {
            Some((n, closed, docs, pri)) => match whole.filter(|(had, _)| n - closed < *had) {
                Some((had, r)) => DayLine::Partly { indices: had, gone: had - (n - closed), docs: r.docs, pri: r.sizes().0 },
                None => DayLine::Live { indices: *n, closed: *closed, docs: *docs, pri: *pri },
            },
            None => match recorded.get(&day_key(d)) {
                Some(rec) => DayLine::Deleted { docs: rec.docs, pri: rec.sizes().0 },
                None => DayLine::NotMeasured,
            },
        };
        (d, line)
    }).collect();
    ClusterIndices { id: id.into(), name: name.into(), failure: None, rows, undated, days, read_at }
}

/// A cluster whose listing failed: its days come from the record alone.
pub fn failed(id: &str, name: &str, why: String, p: &Period, record: &[Day]) -> ClusterIndices {
    let mut c = assemble(id, name, vec![], p, record, None);
    c.failure = Some(why);
    c
}

fn int(v: Option<u64>) -> Cell {
    v.map(|n| Cell::Int(n as f64)).unwrap_or_else(|| Cell::text(NOT_MEASURED))
}

fn utc(ms: Option<i64>) -> String {
    ms.and_then(chrono::DateTime::from_timestamp_millis).map(|t| t.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

/// A day's totals as cells: Indices, Documents, bytes, GB, note. `None` sums: not measured.
fn day_cells(line: &DayLine) -> (Cell, Option<u64>, Option<u64>, String) {
    match line {
        DayLine::Live { indices, closed, docs, pri } => {
            let note = if *closed > 0 { format!("{closed} of {indices} indices closed or unreadable: not in the figures") } else { String::new() };
            (Cell::Int(*indices as f64), *docs, *pri, note)
        }
        DayLine::Partly { indices, gone, docs, pri } => {
            (Cell::Int(*indices as f64), *docs, *pri, format!("{gone} of {indices} indices deleted or closed since: figures from the daily record"))
        }
        DayLine::Deleted { docs, pri } => (Cell::Empty, *docs, *pri, DELETED.into()),
        DayLine::NotMeasured => (Cell::Empty, None, None, NOT_MEASURED.into()),
    }
}

/// The total over a cluster's days of the period. What it leaves out is in its note: days not
/// measured, indices without figures, indices listed with no date in their name.
fn period_total(c: &ClusterIndices, period: &Period) -> (u64, Option<u64>, Option<u64>, String) {
    let (mut n, mut docs, mut pri, mut missing, mut unread) = (0u64, 0u64, 0u64, 0usize, 0u64);
    let (mut docs_known, mut pri_known) = (true, true);
    for (_, l) in &c.days {
        if let DayLine::Live { closed, docs, .. } = l {
            unread += closed;
            if docs.is_none() {
                missing += 1;
                continue;
            }
        }
        let (cell, d, p, _) = day_cells(l);
        if let Cell::Int(x) = cell {
            n += x as u64;
        }
        if matches!(l, DayLine::NotMeasured) {
            missing += 1;
            continue;
        }
        match d {
            Some(x) => docs += x,
            None => docs_known = false,
        }
        match p {
            Some(x) => pri += x,
            None => pri_known = false,
        }
    }
    let mut notes = vec![];
    if missing > 0 {
        notes.push(format!("{missing} of {} day(s) not measured are not in the total", c.days.len()));
    }
    if unread > 0 {
        notes.push(format!("{unread} closed or unreadable indices are not in the total"));
    }
    if !c.undated.is_empty() {
        let sum = |f: &dyn Fn(&IndexRow) -> Option<u64>| c.undated.iter().filter_map(f).sum::<u64>();
        let no_figure = c.undated.iter().filter(|r| r.docs.is_none() || r.pri.is_none()).count();
        let other = c.undated.iter().filter(|r| undated_note(&r.name, period).len() > NO_DATE_NOTE.len()).count();
        notes.push(format!("{} indices with no date in the name ({} documents, {}) are listed but not in the total{}{}", c.undated.len(),
                           sum(&|r| r.docs), human_bytes(Some(sum(&|r| r.pri))),
                           if no_figure > 0 { format!("; {no_figure} of them without figures") } else { String::new() },
                           if other > 0 { format!("; {other} of them named for another month") } else { String::new() }));
    }
    (n, docs_known.then_some(docs), pri_known.then_some(pri), notes.join("; "))
}

/// The total row's name: the days it covers, not a month.
fn total_label(p: &Period) -> String {
    format!("Total {} – {}", p.from, p.to)
}

/// What the file says about itself (`about`): when each cluster was listed, and what is missing.
pub fn about_of(clusters: &[ClusterIndices], p: &Period, built_at: i64) -> About {
    let mut a = About::new("ElasticPro indices report", p, built_at);
    a.notes = ["Sizes are index store sizes (pri.store.size) as listed when read; a deleted day's are the daily record's.",
               "GB is 1024 x 1024 x 1024 bytes."].map(String::from).to_vec();
    for c in clusters {
        a.clusters.push((if c.name == c.id { c.id.clone() } else { format!("{} ({})", c.name, c.id) }, about::span(c.read_at.into_iter())));
        if let Some(f) = &c.failure {
            a.warnings.push(format!("{}: _cat/indices did not answer: {f}; its days come from the daily record", c.name));
        }
        let note = period_total(c, p).3;
        if !note.is_empty() {
            a.warnings.push(format!("{}: {note}", c.name));
        }
    }
    a
}

/// The workbook: *Totals* first (one block per cluster and its total row), then one sheet
/// per cluster, then *About*.
pub fn sheets(clusters: &[ClusterIndices], p: &Period, built_at: i64) -> Vec<Sheet> {
    let mut totals: Vec<Vec<Cell>> = vec![
        ["Day", "Indices", "Documents", "Primary size (bytes)", "Primary size (GB)", "Note"].into_iter().map(Cell::head).collect(),
    ];
    for c in clusters {
        if totals.len() > 1 {
            totals.push(vec![]);
        }
        totals.push(vec![Cell::head(format!("{} · {} – {}", c.name, p.from, p.to))]);
        if let Some(f) = &c.failure {
            totals.push(vec![Cell::text(format!("_cat/indices did not answer: {f} — the days below come from the daily record"))]);
        }
        for (d, l) in &c.days {
            let (n, docs, pri, note) = day_cells(l);
            totals.push(vec![Cell::text(day_key(*d)), n, int(docs), int(pri), gb_cell(pri), Cell::text(note)]);
        }
        let (n, docs, pri, note) = period_total(c, p);
        totals.push(vec![Cell::head(total_label(p)), Cell::Int(n as f64), int(docs), int(pri), gb_cell(pri), Cell::text(note)]);
    }
    let mut out = vec![Sheet { name: "Totals".into(), rows: totals }];
    for c in clusters {
        let mut rows: Vec<Vec<Cell>> = vec![
            ["Index", "Day", "Status", "Documents", "Primary size (bytes)", "Primary size (GB)"].into_iter().map(Cell::head).collect(),
        ];
        if let Some(f) = &c.failure {
            rows.push(vec![Cell::text(format!("_cat/indices did not answer: {f}"))]);
        }
        let mut listed = c.rows.iter().peekable();
        for (d, l) in &c.days {
            while let Some(r) = listed.next_if(|r| r.day == Some(*d)) {
                if r.open {
                    rows.push(vec![Cell::text(&r.name), Cell::text(day_key(*d)), Cell::text(&r.status), int(r.docs), int(r.pri), gb_cell(r.pri)]);
                } else {
                    rows.push(vec![Cell::text(&r.name), Cell::text(day_key(*d)), Cell::text("closed")]);
                }
            }
            match l {
                DayLine::Deleted { docs, pri } => rows.push(vec![Cell::text(DELETED), Cell::text(day_key(*d)), Cell::text("deleted"), int(*docs), int(*pri), gb_cell(*pri)]),
                DayLine::Partly { indices, gone, docs, pri } => rows.push(vec![
                    Cell::text(format!("{gone} of {indices} indices deleted or closed since: the whole day, from the daily record")),
                    Cell::text(day_key(*d)), Cell::text("record"), int(*docs), int(*pri), gb_cell(*pri)]),
                DayLine::NotMeasured => rows.push(vec![Cell::text("no index listed or recorded"), Cell::text(day_key(*d)), Cell::text(NOT_MEASURED)]),
                DayLine::Live { .. } => {}
            }
        }
        if !c.undated.is_empty() {
            rows.push(vec![]);
            rows.push(vec![Cell::head(NO_DATE_TITLE)]);
            rows.push(vec![Cell::text(NO_DATE_WHY)]);
            rows.push(["Index", "Created (UTC)", "Status", "Documents", "Primary size (bytes)", "Primary size (GB)", "Note"].into_iter().map(Cell::head).collect());
            for r in &c.undated {
                let status = if r.open { r.status.clone() } else { "closed".into() };
                rows.push(vec![Cell::text(&r.name), Cell::text(utc(r.created)), Cell::text(status), int(r.docs), int(r.pri), gb_cell(r.pri),
                               Cell::text(undated_note(&r.name, p))]);
            }
        }
        out.push(Sheet { name: c.name.clone(), rows });
    }
    out.push(about_of(clusters, p, built_at).sheet());
    out
}

fn csv(cells: &[String]) -> String {
    cells.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(",")
}

fn opt(v: Option<u64>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

/// `totals.csv` + one CSV per cluster + `about.csv`. An empty size is not measured.
pub fn csv_files(clusters: &[ClusterIndices], p: &Period, built_at: i64) -> Vec<Entry> {
    let mut totals = vec![csv(&["cluster", "day", "indices", "docs", "primary_bytes", "note"].map(String::from))];
    let mut files = vec![];
    let mut used = std::collections::HashSet::new();
    for c in clusters {
        if let Some(f) = &c.failure {
            totals.push(csv(&[c.id.clone(), String::new(), String::new(), String::new(), String::new(), format!("_cat/indices did not answer: {f}")]));
        }
        for (d, l) in &c.days {
            let (n, docs, pri, note) = day_cells(l);
            let n = if let Cell::Int(x) = n { (x as u64).to_string() } else { String::new() };
            totals.push(csv(&[c.id.clone(), day_key(*d), n, opt(docs), opt(pri), note]));
        }
        let (n, docs, pri, note) = period_total(c, p);
        totals.push(csv(&[c.id.clone(), total_label(p), n.to_string(), opt(docs), opt(pri), note]));
        let mut lines = vec![csv(&["index", "day", "status", "docs", "primary_bytes", "created_utc", "note"].map(String::from))];
        for r in &c.rows {
            lines.push(csv(&[r.name.clone(), r.day.map(day_key).unwrap_or_default(), if r.open { r.status.clone() } else { "closed".into() },
                             opt(r.docs), opt(r.pri), utc(r.created), if r.docs.is_none() || r.pri.is_none() { "no figures: not in the totals".into() } else { String::new() }]));
        }
        for (d, l) in &c.days {
            let mut line = |status: &str, docs: &Option<u64>, pri: &Option<u64>, note: &str| {
                lines.push(csv(&[DELETED.into(), day_key(*d), status.into(), opt(*docs), opt(*pri), String::new(), note.into()]))
            };
            match l {
                DayLine::Deleted { docs, pri } => line("deleted", docs, pri, ""),
                DayLine::Partly { docs, pri, .. } => line("record", docs, pri, &day_cells(l).3),
                DayLine::NotMeasured => line(NOT_MEASURED, &None, &None, "no index listed or recorded"),
                DayLine::Live { .. } => {}
            }
        }
        for r in &c.undated {
            lines.push(csv(&[r.name.clone(), String::new(), if r.open { r.status.clone() } else { "closed".into() }, opt(r.docs), opt(r.pri), utc(r.created),
                             undated_note(&r.name, p)]));
        }
        let mut name = format!("{}.csv", file_part(&c.id));
        let mut k = 2;
        while !used.insert(name.clone()) || name == "totals.csv" {
            name = format!("{}-{k}.csv", file_part(&c.id));
            k += 1;
        }
        files.push(Entry::new(name, lines.join("\n") + "\n"));
    }
    let mut out = vec![Entry::new("totals.csv", totals.join("\n") + "\n")];
    out.extend(files);
    out.push(about_of(clusters, p, built_at).entry());
    out
}

/// The mail's text: per cluster its total over the period, and every cluster whose listing failed.
pub fn mail_text(clusters: &[ClusterIndices], p: &Period) -> String {
    let mut out = String::new();
    for c in clusters {
        let (n, docs, pri, note) = period_total(c, p);
        let size = human_bytes(pri);
        let read = about::span(c.read_at.into_iter());
        out.push_str(&format!("{}\n  {}\n  Indices: {n}\n  Documents: {}\n  Primary size: {size}\n  Read: {read}\n", c.name, total_label(p),
                              docs.map(|d| d.to_string()).unwrap_or_else(|| NOT_MEASURED.into())));
        if !note.is_empty() {
            out.push_str(&format!("  Note: {note}\n"));
        }
        if let Some(f) = &c.failure {
            out.push_str(&format!("  _cat/indices did not answer: {f}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::VolumeSettings;
    use serde_json::json;

    fn period() -> Period {
        serde_json::from_value(json!({ "from": "2026-11-01", "to": "2026-11-04", "label": "2026-11 (so far)" })).unwrap()
    }

    #[test]
    fn dated_undated_closed_deleted_and_not_measured() {
        let ind = Indices::from_settings(&VolumeSettings::default()).unwrap();
        let cat = json!([
            { "index": "logstash-win-2026.11.02", "status": "open", "health": "green", "docs.count": "10", "pri.store.size": "1073741824", "creation.date": "1793577600000" },
            { "index": "logstash-linux-2026.11.02", "status": "open", "docs.count": "5", "pri.store.size": "100" },
            { "index": "logstash-old-2026.11.03", "status": "close" },
            { "index": "logstash-app", "status": "open", "docs.count": "7", "pri.store.size": "70", "creation.date": "1793577600000" },
            { "index": "logstash-linux-2026.10.20", "status": "open", "docs.count": "1", "pri.store.size": "1" },
        ]);
        let rows = read_rows(&cat, &ind);
        assert_eq!(rows[2].docs, None, "a closed index has no figures, not 0");
        let record = vec![Day { day: "2026-11-01".into(), docs: Some(40), pri_bytes: Some(4000), live: false, ..Day::default() }];
        let c = assemble("prod", "Production", rows, &period(), &record, Some(1_793_700_000_000));
        assert_eq!(c.rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
                   ["logstash-linux-2026.11.02", "logstash-win-2026.11.02", "logstash-old-2026.11.03"], "by day then name, the period only");
        assert_eq!(c.undated.len(), 1);
        assert_eq!(c.days[0].1, DayLine::Deleted { docs: Some(40), pri: Some(4000) });
        assert_eq!(c.days[1].1, DayLine::Live { indices: 2, closed: 0, docs: Some(15), pri: Some(1_073_741_924) });
        assert_eq!(c.days[2].1, DayLine::Live { indices: 1, closed: 1, docs: None, pri: None }, "only a closed index: not measured, not 0");
        assert_eq!(c.days[3].1, DayLine::NotMeasured);
        let (n, docs, pri, note) = period_total(&c, &period());
        assert_eq!((n, docs, pri), (2, Some(55), Some(1_073_745_924)));
        assert!(note.contains("2 of 4 day(s) not measured") && note.contains("1 closed or unreadable indices are not in the total"), "{note}");
        assert!(note.contains("1 indices with no date in the name (7 documents, 70 B) are listed but not in the total"), "{note}");

        let sheets = sheets(std::slice::from_ref(&c), &period(), 1_793_700_100_000);
        assert_eq!(sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Totals", "Production", "About"]);
        let flat = |s: &Sheet| s.rows.iter().flatten().filter_map(|c| match c { Cell::Text(t) | Cell::Head(t) => Some(t.clone()), _ => None }).collect::<Vec<_>>().join("|");
        let totals = flat(&sheets[0]);
        assert!(totals.contains("Total 2026-11-01 – 2026-11-04") && !totals.contains("Month total"), "{totals}");
        assert!(totals.contains(DELETED) && totals.contains("1 of 1 indices closed or unreadable: not in the figures"), "{totals}");
        let about = flat(&sheets[2]);
        assert!(about.contains("Production (prod)") && about.contains("2026-11-03 10:00:00 UTC") && about.contains("2 of 4 day(s) not measured"), "{about}");
        let sheet = flat(&sheets[1]);
        assert!(sheet.contains("closed") && sheet.contains(NO_DATE_TITLE) && sheet.contains("logstash-app"), "{sheet}");
        assert!(sheet.contains("2026-11-02 00:00") || sheet.contains("2026-11-0"), "creation date in UTC: {sheet}");
        let files = csv_files(&[c], &period(), 1);
        assert_eq!(files.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["totals.csv", "prod.csv", "about.csv"]);
        assert!(String::from_utf8(files[0].data.clone()).unwrap().contains("prod,Total 2026-11-01 – 2026-11-04,2,55,1073745924,"));
        let own = String::from_utf8(files[1].data.clone()).unwrap();
        assert!(own.starts_with("index,day,status,docs,primary_bytes,created_utc,note\n"), "{own}");
        assert!(own.lines().any(|l| l.starts_with("logstash-app,") && l.ends_with(NO_DATE_NOTE)), "{own}");
    }

    /// 2 MB is not 0 GB, and an undated index named for another month says so.
    #[test]
    fn small_sizes_are_not_rounded_to_nothing_and_undated_names_say_their_month() {
        let ind = Indices::from_settings(&VolumeSettings::default()).unwrap();
        let rows = read_rows(&json!([
            { "index": "logstash-linux-2026.11.02", "status": "open", "docs.count": "5", "pri.store.size": "2097152" },
            { "index": "logstash-linux-2026.10", "status": "open", "docs.count": "9", "pri.store.size": "9" }]), &ind);
        let c = assemble("prod", "Production", rows, &period(), &[], Some(1));
        let s = sheets(std::slice::from_ref(&c), &period(), 1);
        assert_eq!(s[0].rows[3][4], Cell::Num(2097152.0 / super::super::build::GB), "not 0.00");
        assert!(mail_text(std::slice::from_ref(&c), &period()).contains("Primary size: 2.00 MB"));
        assert_eq!(undated_note("logstash-linux-2026.10", &period()), format!("{NO_DATE_NOTE}; named for 2026-10"));
        assert_eq!(undated_note("logstash-linux-2026.11", &period()), NO_DATE_NOTE);
        assert_eq!(undated_note("logstash-app", &period()), NO_DATE_NOTE);
        assert!(period_total(&c, &period()).3.contains("1 of them named for another month"));
    }

    /// A day that lost one of its two indices: the record's day, not what is left of it.
    #[test]
    fn a_day_partly_deleted_is_the_record_and_says_how_many_went() {
        let ind = Indices::from_settings(&VolumeSettings::default()).unwrap();
        let rows = read_rows(&json!([{ "index": "logstash-linux-2026.11.02", "status": "open", "docs.count": "5", "pri.store.size": "100" }]), &ind);
        let record = vec![Day { day: "2026-11-02".into(), indices: 2, docs: Some(15), pri_bytes: Some(1100), is_final: true, live: true, ..Day::default() }];
        let c = assemble("prod", "Production", rows, &period(), &record, Some(1));
        assert_eq!(c.days[1].1, DayLine::Partly { indices: 2, gone: 1, docs: Some(15), pri: Some(1100) });
        assert_eq!(period_total(&c, &period()).2, Some(1100));
        assert!(day_cells(&c.days[1].1).3.starts_with("1 of 2 indices deleted or closed since"));
    }

    #[test]
    fn a_failed_listing_is_named_and_its_body_never_lands_in_the_file() {
        let res = json!({ "ok": false, "status": 401, "kind": "http_error", "message": "HTTP 401 Unauthorized",
                          "json": { "error": { "reason": "secret-token-abc is not valid" } } });
        let why = failure_reason(&res);
        assert!(why.starts_with("HTTP 401") && !why.contains("secret"), "{why}");
        assert_eq!(failure_reason(&json!({ "ok": false, "status": 0, "kind": "timeout" })), "the request timed out");
        let c = failed("prod", "Production", why, &period(), &[]);
        let s = sheets(std::slice::from_ref(&c), &period(), 1);
        let first = &s[1].rows[1];
        assert!(matches!(&first[0], Cell::Text(t) if t.contains("did not answer: HTTP 401")));
        assert!(mail_text(std::slice::from_ref(&c), &period()).contains("did not answer"));
        assert!(mail_text(&[c], &period()).contains("Read: not read"));
    }
}
