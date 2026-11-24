//! What every generated file says about itself (docs/REPORT-TYPES.md "About"): what it covers,
//! when it was read from Elasticsearch, when and by what it was built, and everything that makes
//! a figure in it less than the whole. The last sheet of a workbook, `about.csv` in a CSV zip.

use super::build::csv_escape;
use super::period::Period;
use super::xlsx::{Cell, Sheet};
use super::zip::Entry;

pub const SHEET: &str = "About";
pub const CSV: &str = "about.csv";
pub const NOT_READ: &str = "not read";

/// The same for every file: a day is the UTC day, whatever the reader's zone.
pub const DAYS_ARE_UTC: &str = "Days are UTC days (00:00 to 24:00 UTC).";
/// What "final" means in the files (`volume::collect::FINAL_AFTER_MS`).
pub const FINAL_RULE: &str = "A day is final when it was read at least 24 hours after it ended; until then its figures may still grow.";

/// An instant as a file states it: UTC, to the second.
pub fn utc(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|t| t.format("%Y-%m-%d %H:%M:%S UTC").to_string()).unwrap_or_default()
}

/// The same instant on the server's clock, with its offset.
pub fn server(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S %:z").to_string()).unwrap_or_default()
}

/// Both: what "read at" and "built at" show.
pub fn stamp(ms: i64) -> String {
    format!("{} ({} server time)", utc(ms), server(ms))
}

/// From the first to the last of several reads; `NOT_READ` when there is none.
pub fn span(reads: impl Iterator<Item = i64>) -> String {
    let (mut lo, mut hi) = (None::<i64>, None::<i64>);
    for r in reads {
        lo = Some(lo.map_or(r, |x| x.min(r)));
        hi = Some(hi.map_or(r, |x| x.max(r)));
    }
    match (lo, hi) {
        (Some(a), Some(b)) if a == b => stamp(a),
        (Some(a), Some(b)) => format!("{} – {}", stamp(a), stamp(b)),
        _ => NOT_READ.to_string(),
    }
}

#[derive(Clone, Debug, Default)]
pub struct About {
    pub what: String,
    /// Cluster name (and id) → when its figures were read.
    pub clusters: Vec<(String, String)>,
    pub period: String,
    /// What a day is in this file; `DAYS_ARE_UTC` when not said otherwise.
    pub days: Option<&'static str>,
    pub built_at: i64,
    /// What the figures mean, always said.
    pub notes: Vec<String>,
    /// What went wrong or is missing in this file.
    pub warnings: Vec<String>,
    /// One more table under the facts (header first): the hosts file's days.
    pub table: Vec<Vec<String>>,
}

impl About {
    pub fn new(what: impl Into<String>, p: &Period, built_at: i64) -> About {
        About { what: what.into(), period: format!("{} – {} ({})", p.from, p.to, p.label), built_at, ..About::default() }
    }

    fn facts(&self) -> Vec<[String; 2]> {
        let row = |a: &str, b: String| [a.to_string(), b];
        let mut out = vec![row("File", self.what.clone()), row("Period", self.period.clone()), row("Days", self.days.unwrap_or(DAYS_ARE_UTC).into())];
        for (c, read) in &self.clusters {
            out.push(row("Cluster", c.clone()));
            out.push(row("Read from Elasticsearch", read.clone()));
        }
        out.push(row("Built", stamp(self.built_at)));
        out.push(row("Built by", format!("ElasticPro {}", crate::VERSION)));
        out.extend(self.notes.iter().map(|n| row("Note", n.clone())));
        if self.warnings.is_empty() {
            out.push(row("Warnings", "none".into()));
        }
        out.extend(self.warnings.iter().map(|w| row("Warning", w.clone())));
        out
    }

    pub fn rows(&self) -> Vec<Vec<Cell>> {
        let mut rows: Vec<Vec<Cell>> = self.facts().into_iter().map(|[a, b]| vec![Cell::head(a), Cell::text(b)]).collect();
        if !self.table.is_empty() {
            rows.push(vec![]);
        }
        for (i, r) in self.table.iter().enumerate() {
            rows.push(r.iter().map(|c| if i == 0 { Cell::head(c) } else { Cell::text(c) }).collect());
        }
        rows
    }

    pub fn sheet(&self) -> Sheet {
        Sheet { name: SHEET.into(), rows: self.rows() }
    }

    pub fn csv(&self) -> String {
        let line = |cells: &[String]| cells.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(",") + "\n";
        let mut out = line(&["item".into(), "value".into()]);
        for f in self.facts() {
            out.push_str(&line(&f));
        }
        if !self.table.is_empty() {
            out.push('\n');
        }
        for r in &self.table {
            out.push_str(&line(r));
        }
        out
    }

    /// The same for a mail body: when the figures were read, and every warning.
    pub fn mail_lines(&self) -> String {
        let mut out: String = self.clusters.iter().map(|(c, read)| format!("{c}: read from Elasticsearch {read}\n")).collect();
        if !self.warnings.is_empty() {
            out.push_str("\nNot complete:\n");
            self.warnings.iter().for_each(|w| out.push_str(&format!("  {w}\n")));
        }
        out
    }

    pub fn entry(&self) -> Entry {
        Entry::new(CSV, self.csv())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_says_what_it_covers_when_it_was_read_and_by_what_it_was_built() {
        let p: Period = serde_json::from_value(serde_json::json!({ "from": "2026-11-01", "to": "2026-11-23", "label": "2026-11 (so far)" })).unwrap();
        let mut a = About::new("ElasticPro volume report", &p, 1_795_500_000_000);
        a.clusters.push(("Production (prod)".into(), span([1_795_400_000_000, 1_795_410_000_000].into_iter())));
        a.warnings.push("prod: 2 of 4 shards failed".into());
        let csv = a.csv();
        assert!(csv.starts_with("item,value\n"), "{csv}");
        assert!(csv.contains("2026-11-01 – 2026-11-23") && csv.contains(DAYS_ARE_UTC) && csv.contains(&format!("ElasticPro {}", crate::VERSION)));
        assert!(csv.contains("2026-11-23 02:13:20 UTC (") && csv.contains("server time"), "{csv}");
        assert!(csv.contains("Warning,prod: 2 of 4 shards failed"));
        assert_eq!(span(std::iter::empty()), NOT_READ, "never a made-up time");
        assert_eq!(a.sheet().name, "About");
        a.warnings.clear();
        assert!(a.csv().contains("Warnings,none"));
    }
}
