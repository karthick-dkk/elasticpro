//! Which days a report covers.
//!
//! A day is a date in the index names (docs/VOLUME.md "What counts"), so a period is a
//! range of those dates and nothing here goes through a time zone. "Today" is given by the
//! caller, and every caller gives today's UTC date — a report somebody asks for, like the
//! cards, and the mailed report too: only its send time is server local (see `schedule`),
//! so "the previous month" is the same days whoever asks and wherever the server is.

use crate::volume::schedule::{day_key, parse_day};
use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The longest period a report may cover: three years of days, the most `keepMonths` keeps.
pub const MAX_DAYS: i64 = 1200;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Period {
    pub from: String,
    pub to: String,
    pub label: String,
}

impl Period {
    fn new(from: NaiveDate, to: NaiveDate, label: String) -> Period {
        Period { from: day_key(from), to: day_key(to), label }
    }
    pub fn from_date(&self) -> NaiveDate {
        parse_day(&self.from).unwrap_or_default()
    }
    pub fn to_date(&self) -> NaiveDate {
        parse_day(&self.to).unwrap_or_default()
    }
    /// Every day of the period, oldest first.
    pub fn days(&self) -> Vec<NaiveDate> {
        let (f, t) = (self.from_date(), self.to_date());
        (0..=(t - f).num_days().max(-1)).map(|i| f + Duration::days(i)).collect()
    }
}

fn first_of(y: i32, m: u32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(y, m, 1)
}

fn last_of(y: i32, m: u32) -> Option<NaiveDate> {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    Some(first_of(ny, nm)? - Duration::days(1))
}

/// A calendar month; the current one runs to `today` and says "so far".
pub fn month(y: i32, m: u32, today: NaiveDate) -> Result<Period, String> {
    let first = first_of(y, m).ok_or_else(|| format!("{y:04}-{m:02} is not a month"))?;
    if first > today {
        return Err(format!("{y:04}-{m:02} has not begun"));
    }
    let last = last_of(y, m).unwrap_or(first);
    if last >= today {
        return Ok(Period::new(first, today, format!("{y:04}-{m:02} (so far)")));
    }
    Ok(Period::new(first, last, format!("{y:04}-{m:02}")))
}

pub fn yesterday(today: NaiveDate) -> Period {
    let d = today - Duration::days(1);
    Period::new(d, d, day_key(d))
}

/// The seven finished days before today.
pub fn last7(today: NaiveDate) -> Period {
    let (f, t) = (today - Duration::days(7), today - Duration::days(1));
    Period::new(f, t, format!("{} – {}", day_key(f), day_key(t)))
}

/// The calendar month before `today`'s: what the monthly mail sends on the 1st.
pub fn previous_month(today: NaiveDate) -> Period {
    let (y, m) = if today.month() == 1 { (today.year() - 1, 12) } else { (today.year(), today.month() - 1) };
    let (f, t) = (first_of(y, m).unwrap_or(today), last_of(y, m).unwrap_or(today));
    Period::new(f, t, format!("{y:04}-{m:02}"))
}

/// Monday to Sunday of the week before `today`'s: what the weekly mail sends on Monday.
pub fn previous_week(today: NaiveDate) -> Period {
    let this_monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let (f, t) = (this_monday - Duration::days(7), this_monday - Duration::days(1));
    debug_assert_eq!(f.weekday(), Weekday::Mon);
    Period::new(f, t, format!("{} – {}", day_key(f), day_key(t)))
}

/// `period` as `REPORT_RUN` takes it: `{from, to}` or a preset (`"month:2026-10"`,
/// `"yesterday"`, `"last7"`).
pub fn parse(v: &Value, today: NaiveDate) -> Result<Period, String> {
    match v {
        Value::String(s) => {
            let s = s.trim();
            if s == "yesterday" {
                return Ok(yesterday(today));
            }
            if s == "last7" {
                return Ok(last7(today));
            }
            if let Some(m) = s.strip_prefix("month:") {
                let b = m.as_bytes();
                let ok = b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit());
                let (y, mo) = (m.get(0..4).and_then(|x| x.parse().ok()), m.get(5..7).and_then(|x| x.parse().ok()));
                return match (ok, y, mo) {
                    (true, Some(y), Some(mo)) => month(y, mo, today),
                    _ => Err(format!("{s:?}: a month is month:YYYY-MM")),
                };
            }
            Err(format!("{s:?} is not a period: use {{from, to}}, \"month:YYYY-MM\", \"yesterday\" or \"last7\""))
        }
        Value::Object(o) => {
            let day = |k: &str| -> Result<NaiveDate, String> {
                let s = o.get(k).and_then(Value::as_str).ok_or_else(|| format!("period.{k} is required (YYYY-MM-DD)"))?;
                parse_day(s).ok_or_else(|| format!("period.{k} {s:?} is not a YYYY-MM-DD day"))
            };
            let (from, to) = (day("from")?, day("to")?);
            if from > to {
                return Err("period.from must be on or before period.to".into());
            }
            if to > today {
                return Err(format!("period.to {} is after today ({})", day_key(to), day_key(today)));
            }
            if (to - from).num_days() >= MAX_DAYS {
                return Err(format!("a period covers at most {MAX_DAYS} days"));
            }
            Ok(Period::new(from, to, format!("{} – {}", day_key(from), day_key(to))))
        }
        _ => Err("period is required: {from, to}, \"month:YYYY-MM\", \"yesterday\" or \"last7\"".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }
    fn span(p: &Period) -> (&str, &str) {
        (p.from.as_str(), p.to.as_str())
    }

    #[test]
    fn presets() {
        let today = d("2026-10-29");
        let p = parse(&json!("month:2026-10"), today).unwrap();
        assert_eq!(span(&p), ("2026-10-01", "2026-10-29"), "the current month is so far");
        assert_eq!(p.label, "2026-10 (so far)");
        let p = parse(&json!("month:2026-02"), today).unwrap();
        assert_eq!((span(&p), p.label.as_str()), (("2026-02-01", "2026-02-28"), "2026-02"));
        assert_eq!(span(&parse(&json!("month:2024-02"), today).unwrap()), ("2024-02-01", "2024-02-29"), "a leap year");
        assert_eq!(span(&parse(&json!("month:2025-12"), today).unwrap()), ("2025-12-01", "2025-12-31"));
        assert!(parse(&json!("month:2026-11"), today).is_err(), "not begun");
        for bad in ["month:2026-13", "month:2026-1", "month:26-10", "week", ""] {
            assert!(parse(&json!(bad), today).is_err(), "{bad}");
        }
        assert_eq!(span(&parse(&json!("yesterday"), today).unwrap()), ("2026-10-28", "2026-10-28"));
        assert_eq!(span(&parse(&json!("last7"), today).unwrap()), ("2026-10-22", "2026-10-28"));
        assert_eq!(parse(&json!("last7"), today).unwrap().days().len(), 7);
        // The 1st of a month: yesterday and last7 reach into the previous one.
        assert_eq!(span(&parse(&json!("yesterday"), d("2026-11-01")).unwrap()), ("2026-10-31", "2026-10-31"));
        assert_eq!(span(&parse(&json!("month:2026-11"), d("2026-11-01")).unwrap()), ("2026-11-01", "2026-11-01"));
    }

    #[test]
    fn explicit_ranges() {
        let today = d("2026-10-29");
        let p = parse(&json!({ "from": "2026-10-01", "to": "2026-10-10" }), today).unwrap();
        assert_eq!(p.days().len(), 10);
        assert_eq!(p.label, "2026-10-01 – 2026-10-10");
        assert!(parse(&json!({ "from": "2026-10-10", "to": "2026-10-01" }), today).is_err());
        assert!(parse(&json!({ "from": "2026-10-10", "to": "2026-10-30" }), today).is_err(), "after today");
        assert!(parse(&json!({ "from": "2020-01-01", "to": "2026-10-01" }), today).is_err(), "too long");
        assert!(parse(&json!({ "from": "2026-10-01" }), today).is_err());
        assert!(parse(&json!(null), today).is_err());
    }

    #[test]
    fn scheduled_periods() {
        // Monthly: the previous calendar month, whatever day it is asked on.
        assert_eq!(span(&previous_month(d("2026-11-01"))), ("2026-10-01", "2026-10-31"));
        assert_eq!(span(&previous_month(d("2026-01-01"))), ("2025-12-01", "2025-12-31"));
        assert_eq!(span(&previous_month(d("2026-03-15"))), ("2026-02-01", "2026-02-28"));
        // Weekly: the previous Monday..Sunday. 2026-11-02 is a Monday.
        assert_eq!(span(&previous_week(d("2026-11-02"))), ("2026-10-26", "2026-11-01"));
        assert_eq!(span(&previous_week(d("2026-11-08"))), ("2026-10-26", "2026-11-01"), "Sunday: still last week's");
        assert_eq!(span(&previous_week(d("2026-11-09"))), ("2026-11-02", "2026-11-08"));
        assert_eq!(span(&yesterday(d("2026-01-01"))), ("2025-12-31", "2025-12-31"));
    }
}
