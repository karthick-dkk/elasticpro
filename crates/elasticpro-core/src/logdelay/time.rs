//! Server-local days and windows. The log delay is read by people in the server's zone (IST
//! on our stacks): "newly late today", "14:00–18:00" and a day's totals follow the local
//! clock, as the Plan board decided ("daily totals … at midnight, server time"). The
//! instants themselves stay epoch ms.

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike};

/// The local date of an instant, `YYYY-MM-DD`.
pub fn local_day_key(ms: i64) -> String {
    local_date(ms).format("%Y-%m-%d").to_string()
}

pub fn local_date(ms: i64) -> NaiveDate {
    Local.timestamp_millis_opt(ms).single().map(|d| d.date_naive())
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(ms).map(|d| d.date_naive()).unwrap_or_default())
}

pub fn local_datetime(ms: i64) -> NaiveDateTime {
    Local.timestamp_millis_opt(ms).single().map(|d| d.naive_local())
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(ms).map(|d| d.naive_utc()).unwrap_or_default())
}

/// The instant a local day starts, and the one it ends (the next day's start).
pub fn day_bounds(day: NaiveDate) -> (i64, i64) {
    let start = |d: NaiveDate| {
        let t = d.and_hms_opt(0, 0, 0).unwrap_or_default();
        Local.from_local_datetime(&t).earliest().map(|x| x.timestamp_millis())
            .unwrap_or_else(|| t.and_utc().timestamp_millis())
    };
    (start(day), start(day.succ_opt().unwrap_or(day)))
}

/// `every` hours from a day's start: `[start, start+every)`, … up to the day's end.
pub fn windows(day: NaiveDate, every_hours: u64) -> Vec<(i64, i64)> {
    let (from, to) = day_bounds(day);
    let step = (every_hours.clamp(1, 24) as i64) * 3_600_000;
    let mut out = vec![];
    let mut t = from;
    while t < to {
        out.push((t, (t + step).min(to)));
        t += step;
    }
    out
}

/// `HH:MM–HH:MM` of a window, local.
pub fn window_label(from: i64, to: i64) -> String {
    let a = local_datetime(from);
    let b = local_datetime(to);
    format!("{:02}:{:02}–{:02}:{:02}", a.hour(), a.minute(), b.hour(), b.minute())
}

/// `HH:MM` local.
pub fn hhmm(ms: i64) -> String {
    let t = local_datetime(ms);
    format!("{:02}:{:02}", t.hour(), t.minute())
}

/// `4 Nov 14:00`, or `today 14:00` / `yesterday 23:45` against `now`.
pub fn when(ms: i64, now: i64) -> String {
    let d = local_date(ms);
    let today = local_date(now);
    let t = hhmm(ms);
    if d == today {
        format!("today {t}")
    } else if today.pred_opt() == Some(d) {
        format!("yesterday {t}")
    } else {
        format!("{} {} {t}", d.day(), month_short(d.month()))
    }
}

pub fn month_short(m: u32) -> &'static str {
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m.clamp(1, 12) - 1) as usize]
}

/// `Tuesday 4 Nov 2026`.
pub fn long_date(d: NaiveDate) -> String {
    format!("{} {} {} {}", d.format("%A"), d.day(), month_short(d.month()), d.year())
}

/// `4 Nov`.
pub fn short_date(d: NaiveDate) -> String {
    format!("{} {}", d.day(), month_short(d.month()))
}

/// A duration in people's words: `2 h 45 min`, `45 min`, `3 d 2 h`.
pub fn duration(ms: i64) -> String {
    let mins = (ms.max(0) + 30_000) / 60_000;
    let (d, h, m) = (mins / 1440, (mins % 1440) / 60, mins % 60);
    if d > 0 {
        format!("{d} d {h} h")
    } else if h > 0 {
        format!("{h} h {m:02} min")
    } else {
        format!("{m} min")
    }
}

/// Minutes as the tables show them: `94 min`, `1.5 min` under ten.
pub fn minutes(m: f64) -> String {
    if m.abs() < 10.0 && m.fract() != 0.0 {
        format!("{m:.1} min")
    } else {
        format!("{} min", m.round() as i64)
    }
}

pub fn parse_day(s: &str) -> Option<NaiveDate> {
    crate::volume::schedule::parse_day(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_cover_the_day_without_a_gap_or_an_overlap() {
        let day = NaiveDate::from_ymd_opt(2026, 11, 4).unwrap();
        let w = windows(day, 2);
        assert_eq!(w.len(), 12);
        let (from, to) = day_bounds(day);
        assert_eq!(w[0].0, from);
        assert_eq!(w[11].1, to);
        for pair in w.windows(2) {
            assert_eq!(pair[0].1, pair[1].0);
        }
        assert_eq!(windows(day, 24).len(), 1);
        assert_eq!(windows(day, 5).len(), 5, "a step that does not divide the day ends at midnight anyway");
    }

    #[test]
    fn words_for_durations_and_minutes() {
        assert_eq!(duration(45 * 60_000), "45 min");
        assert_eq!(duration((2 * 60 + 45) * 60_000), "2 h 45 min");
        assert_eq!(duration(26 * 3_600_000), "1 d 2 h");
        assert_eq!(minutes(94.0), "94 min");
        assert_eq!(minutes(1.5), "1.5 min");
        assert_eq!(minutes(0.0), "0 min");
    }

    #[test]
    fn today_and_yesterday_are_named() {
        let now = chrono::Utc::now().timestamp_millis();
        assert!(when(now, now).starts_with("today "));
        assert!(when(now - 86_400_000, now).starts_with("yesterday "));
        assert!(!when(now - 10 * 86_400_000, now).starts_with("today"));
    }
}
