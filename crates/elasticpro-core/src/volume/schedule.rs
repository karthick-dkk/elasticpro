//! When the daily run is due, and what "today" means.
//!
//! Two clocks, on purpose. A *day of data* is the date in the index name, finished when
//! it is before today's UTC date — index names are written in UTC by every shipper this
//! product meets, and the server's own time zone has nothing to do with them. The *run*
//! happens at `collectAt` in the server's local time (TZ of the core process), because
//! that is how an operator says "after the night's indices roll over, before we start".
//!
//! Everything here takes the time as an argument; only `local_now` and `local_to_ms` read
//! the clock or the zone database, so every rule is testable without either.

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};

/// `HH:MM`, 00:00 to 23:59. Leading zeros required: this is a setting, not free text.
pub fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let b = s.trim().as_bytes();
    if b.len() != 5 || b[2] != b':' || !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return None;
    }
    let s = s.trim();
    let (h, m) = (s[0..2].parse::<u32>().ok()?, s[3..5].parse::<u32>().ok()?);
    NaiveTime::from_hms_opt(h, m, 0).filter(|_| h < 24 && m < 60)
}

/// The UTC date of an instant.
pub fn utc_day(now_ms: i64) -> NaiveDate {
    chrono::DateTime::from_timestamp_millis(now_ms).map(|d| d.date_naive()).unwrap_or_default()
}

/// `YYYY-MM-DD`.
pub fn day_key(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub fn parse_day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().filter(|_| s.len() == 10)
}

/// `YYYY-MM` of a date.
pub fn month_key(d: NaiveDate) -> String {
    d.format("%Y-%m").to_string()
}

/// The first day of the month `keep_months - 1` months before `today`'s: the oldest month
/// the record keeps. `keep_months` 1 keeps only the current month.
pub fn oldest_kept_month(today: NaiveDate, keep_months: u32) -> NaiveDate {
    use chrono::Datelike;
    let back = keep_months.max(1) as i32 - 1;
    let total = today.year() * 12 + today.month0() as i32 - back;
    NaiveDate::from_ymd_opt(total.div_euclid(12), total.rem_euclid(12) as u32 + 1, 1).unwrap_or(today)
}

/// Whether the scheduled run is due: local time is past `collect_at` and today's run has
/// not happened. `last` is the local date of the last scheduled run, persisted — so a
/// restart after the run does not repeat it, and a restart after a missed one (the core
/// was down at `collect_at`) runs it once, at the first tick.
pub fn is_due(local_now: NaiveDateTime, collect_at: NaiveTime, last: Option<NaiveDate>) -> bool {
    let today = local_now.date();
    local_now.time() >= collect_at && last.is_none_or(|l| l < today)
}

/// When the next scheduled run will happen, local time. Today's `collect_at` if today's
/// has not happened yet; otherwise tomorrow's. A run that is overdue (due now) answers now.
pub fn next_run(local_now: NaiveDateTime, collect_at: NaiveTime, last: Option<NaiveDate>) -> NaiveDateTime {
    let today = local_now.date();
    if last.is_some_and(|l| l >= today) {
        return (today + Duration::days(1)).and_time(collect_at);
    }
    if local_now.time() >= collect_at {
        return local_now;
    }
    today.and_time(collect_at)
}

/// The server's local time now (TZ of the process; UTC when the zone is unknown).
pub fn local_now() -> NaiveDateTime {
    chrono::Local::now().naive_local()
}

/// A local time as epoch ms. In a DST gap the earlier reading is taken; a time that does
/// not exist at all is `None`, which the status shows as "not known".
pub fn local_to_ms(t: NaiveDateTime) -> Option<i64> {
    use chrono::TimeZone;
    chrono::Local.from_local_datetime(&t).earliest().map(|d| d.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }
    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }

    #[test]
    fn hhmm_is_strict() {
        assert_eq!(parse_hhmm("06:00"), NaiveTime::from_hms_opt(6, 0, 0));
        assert_eq!(parse_hhmm("23:59"), NaiveTime::from_hms_opt(23, 59, 0));
        assert_eq!(parse_hhmm("00:00"), NaiveTime::from_hms_opt(0, 0, 0));
        for bad in ["24:00", "6:00", "06:60", "0600", "06-00", "", "aa:bb", "06:00:00", "+6:00"] {
            assert_eq!(parse_hhmm(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn due_once_a_local_day_after_collect_at() {
        let six = parse_hhmm("06:00").unwrap();
        // Before collectAt: not due, even with no run ever.
        assert!(!is_due(at("2026-10-29 05:59"), six, None));
        // At and after: due, once.
        assert!(is_due(at("2026-10-29 06:00"), six, None));
        assert!(is_due(at("2026-10-29 06:00"), six, Some(d("2026-10-28"))));
        // The run happened today: no repeat the same local day, restart or not.
        assert!(!is_due(at("2026-10-29 06:01"), six, Some(d("2026-10-29"))));
        assert!(!is_due(at("2026-10-29 23:59"), six, Some(d("2026-10-29"))));
        // Tomorrow it is due again, not before collectAt.
        assert!(!is_due(at("2026-10-30 05:00"), six, Some(d("2026-10-29"))));
        assert!(is_due(at("2026-10-30 06:00"), six, Some(d("2026-10-29"))));
    }

    #[test]
    fn a_missed_run_after_restart_runs_once() {
        let six = parse_hhmm("06:00").unwrap();
        // Down from 05:00 to 09:30: the first tick after the restart runs it...
        assert!(is_due(at("2026-10-29 09:30"), six, Some(d("2026-10-28"))));
        // ...and records today, so the next tick and the next restart do not.
        assert!(!is_due(at("2026-10-29 09:31"), six, Some(d("2026-10-29"))));
        // Down for days: still one run, not one per missed day.
        assert!(is_due(at("2026-10-29 09:30"), six, Some(d("2026-10-20"))));
        assert!(!is_due(at("2026-10-29 09:31"), six, Some(d("2026-10-29"))));
    }

    #[test]
    fn next_run_is_today_tomorrow_or_now() {
        let six = parse_hhmm("06:00").unwrap();
        assert_eq!(next_run(at("2026-10-29 05:00"), six, Some(d("2026-10-28"))), at("2026-10-29 06:00"));
        assert_eq!(next_run(at("2026-10-29 07:00"), six, Some(d("2026-10-29"))), at("2026-10-30 06:00"));
        assert_eq!(next_run(at("2026-10-29 07:00"), six, None), at("2026-10-29 07:00"), "overdue: now");
        assert_eq!(next_run(at("2026-12-31 07:00"), six, Some(d("2026-12-31"))), at("2027-01-01 06:00"));
    }

    #[test]
    fn utc_day_and_kept_months() {
        // 2026-10-29T23:30:00Z and 00:30 the next day.
        assert_eq!(utc_day(1_793_316_600_000), d("2026-10-29"));
        assert_eq!(utc_day(1_793_320_200_000), d("2026-10-30"));
        assert_eq!(oldest_kept_month(d("2026-10-29"), 13), d("2025-10-01"));
        assert_eq!(oldest_kept_month(d("2026-10-29"), 1), d("2026-10-01"));
        assert_eq!(oldest_kept_month(d("2026-01-15"), 2), d("2025-12-01"));
        assert_eq!(oldest_kept_month(d("2026-03-01"), 36), d("2023-04-01"));
        assert_eq!(parse_day("2026-02-30"), None);
        assert_eq!(parse_day("2026-1-01"), None);
    }
}
