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

/// What the daily run does in a heavy-job window that leaves its own place out (docs/JOBS.md
/// "Per-cluster switches"): `Shift::of`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shift {
    /// This window session has had its run.
    NotDue,
    /// Due, but the window is closed: it waits for the window.
    Closed,
    /// The window is open, but the newest UTC day closed less than the run's usual margin ago;
    /// a later moment of this window session is far enough past UTC midnight: wait for it.
    Hold,
    /// Run now. `margin_ms` > 0: no moment of this window session is far enough past UTC
    /// midnight, so the run goes now and leaves a day that ended less than `margin_ms` ago not
    /// final — the next run makes it final.
    Run { margin_ms: u64 },
}

const DAY_MS: i64 = 86_400_000;

impl Shift {
    /// The window session `local` falls in, named by the date it ends on: a window across midnight
    /// (22–06) is one session from 22:00 to 06:00, the next day's date — so 22:00 and the 00:00
    /// after it are the same session, and one run covers it.
    pub fn session(local: NaiveDateTime, h: crate::collection::Hours) -> NaiveDate {
        use chrono::Timelike;
        if h.from > h.to && local.hour() >= h.from as u32 { local.date() + Duration::days(1) } else { local.date() }
    }

    /// The rule. The run's margin is how far past UTC midnight its own place (`start`, on this
    /// local date) lies — 06:00 IST is 00:30 UTC, 30 minutes — so a shifted run never makes a day
    /// final sooner after it ended than the run at its own place would. `to_ms` turns a local time
    /// into unix ms (`local_to_ms`; the tests give a fixed offset). `last`: the session last run.
    pub fn of(local: NaiveDateTime, start: NaiveTime, h: crate::collection::Hours, last: Option<NaiveDate>,
              to_ms: &dyn Fn(NaiveDateTime) -> Option<i64>) -> (Shift, NaiveDate) {
        let session = Shift::session(local, h);
        if last.is_some_and(|l| l >= session) {
            return (Shift::NotDue, session);
        }
        if !h.open_at(local) {
            return (Shift::Closed, session);
        }
        let tod = |t: NaiveDateTime| to_ms(t).map(|ms| ms.rem_euclid(DAY_MS));
        let margin = tod(local.date().and_time(start)).unwrap_or(0);
        if tod(local).is_none_or(|x| x >= margin) {
            return (Shift::Run { margin_ms: 0 }, session);
        }
        let mut t = local;
        while t - local < Duration::hours(24) {
            t += Duration::minutes(15);
            if !h.open_at(t) {
                break;
            }
            if tod(t).is_some_and(|x| x >= margin) {
                return (Shift::Hold, session);
            }
        }
        (Shift::Run { margin_ms: margin as u64 }, session)
    }
}

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

/// Every `YYYY-MM` from `from`'s month to `to`'s, oldest first.
pub fn months_between(from: NaiveDate, to: NaiveDate) -> Vec<String> {
    use chrono::Datelike;
    let (mut y, mut m) = (from.year(), from.month());
    let mut out = vec![];
    while (y, m) <= (to.year(), to.month()) {
        out.push(format!("{y:04}-{m:02}"));
        (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    }
    out
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

/// The server's zone, the one every schedule and local day uses (`chrono::Local`, the
/// process's `TZ`): its IANA name when it can be told, and the offset now in minutes. `PING`
/// carries both (`tz`, `tzOffsetMinutes`) so the pages show times in the server's zone.
pub fn server_zone() -> (Option<String>, i32) {
    let link = std::fs::read_link("/etc/localtime").ok();
    let file = std::fs::read_to_string("/etc/timezone").ok();
    let name = zone_name(std::env::var("TZ").ok().as_deref(), file.as_deref(), link.as_deref());
    (name, chrono::Local::now().offset().local_minus_utc() / 60)
}

/// The zone's IANA name from, in order: `TZ` (`Asia/Kolkata`, `:Asia/Kolkata`, `UTC`), the
/// `/etc/timezone` text, the `/etc/localtime` link (`…/zoneinfo/Asia/Kolkata`). `None` when
/// none says one — unknown, never a guess (a `TZ` rule like `IST-5:30` names no zone).
pub fn zone_name(tz: Option<&str>, etc_timezone: Option<&str>, localtime: Option<&std::path::Path>) -> Option<String> {
    let iana = |s: &str| {
        let s = s.trim().trim_start_matches(':');
        let s = s.strip_prefix("/usr/share/zoneinfo/").unwrap_or(s);
        let ok = !s.is_empty() && s.len() <= 64 && (s.contains('/') || matches!(s, "UTC" | "GMT" | "Etc/UTC"))
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
            && !s.starts_with('/') && !s.contains("..");
        ok.then(|| s.to_string())
    };
    if let Some(t) = tz.filter(|t| !t.trim().is_empty()) {
        return iana(t);
    }
    etc_timezone.and_then(iana).or_else(|| {
        let l = localtime?.to_string_lossy().to_string();
        l.split_once("zoneinfo/").and_then(|(_, z)| iana(z))
    })
}

/// A local time as epoch ms. In a DST gap the earlier reading is taken; a time that does
/// not exist at all is `None`, which the status shows as "not known".
pub fn local_to_ms(t: NaiveDateTime) -> Option<i64> {
    use chrono::TimeZone;
    chrono::Local.from_local_datetime(&t).earliest().map(|d| d.timestamp_millis())
}

#[cfg(test)]
mod shift_tests {
    use super::*;
    use crate::collection::Hours;

    /// A fixed offset, as Asia/Kolkata (+05:30) or UTC.
    fn at_offset(minutes: i64) -> impl Fn(NaiveDateTime) -> Option<i64> {
        move |t: NaiveDateTime| Some(t.and_utc().timestamp_millis() - minutes * 60_000)
    }
    fn at(d: u32, h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, d).unwrap().and_hms_opt(h, m, 0).unwrap()
    }
    fn six() -> NaiveTime {
        NaiveTime::from_hms_opt(6, 0, 0).unwrap()
    }

    #[test]
    fn ist_00_06_runs_at_midnight_with_the_utc_day_long_closed() {
        let ist = at_offset(330);
        let w = Hours::new(0, 6).unwrap();
        // 00:00 IST is 18:30 UTC: the newest wanted day (the UTC day before) ended 18.5 h ago,
        // far past the 30 minutes 06:00 IST (00:30 UTC) gives: final as at the usual place.
        assert_eq!(Shift::of(at(21, 0, 0), six(), w, None, &ist), (Shift::Run { margin_ms: 0 }, NaiveDate::from_ymd_opt(2026, 11, 21).unwrap()));
        assert_eq!(Shift::of(at(21, 3, 0), six(), w, NaiveDate::from_ymd_opt(2026, 11, 21), &ist).0, Shift::NotDue, "once a session");
        assert_eq!(Shift::of(at(21, 9, 0), six(), w, NaiveDate::from_ymd_opt(2026, 11, 20), &ist).0, Shift::Closed);
        // 05:45 IST is 00:15 UTC — the UTC day ended 15 minutes ago, and the window shuts at 06:00:
        // run, but leave that day not final (30 min margin).
        assert_eq!(Shift::of(at(21, 5, 45), six(), w, NaiveDate::from_ymd_opt(2026, 11, 20), &ist).0, Shift::Run { margin_ms: 30 * 60_000 });
    }

    #[test]
    fn ist_22_06_runs_once_a_session_at_22_and_never_twice_in_a_night() {
        let ist = at_offset(330);
        let w = Hours::new(22, 6).unwrap();
        let (s, session) = Shift::of(at(20, 22, 0), six(), w, None, &ist);
        assert_eq!(s, Shift::Run { margin_ms: 0 }, "22:00 IST is 16:30 UTC: yesterday's UTC day long closed");
        assert_eq!(session, NaiveDate::from_ymd_opt(2026, 11, 21).unwrap(), "the session ends on the 21st");
        // Marked with its session: the 00:00 that follows is the same session — no second run.
        assert_eq!(Shift::of(at(21, 0, 0), six(), w, Some(session), &ist).0, Shift::NotDue);
        assert_eq!(Shift::of(at(21, 12, 0), six(), w, Some(session), &ist).0, Shift::NotDue);
        assert_eq!(Shift::of(at(21, 22, 0), six(), w, Some(session), &ist).0, Shift::Run { margin_ms: 0 }, "the next night's");
    }

    #[test]
    fn a_window_with_no_moment_far_enough_past_utc_midnight_runs_and_leaves_the_day_not_final() {
        // A UTC server, 00–06, collectAt 06:00: its margin is 6 h, and every moment of the window
        // is less than 6 h past UTC midnight.
        let utc = at_offset(0);
        let w = Hours::new(0, 6).unwrap();
        assert_eq!(Shift::of(at(21, 0, 0), six(), w, None, &utc).0, Shift::Run { margin_ms: 6 * 3_600_000 });
        // A window 02–10 there: at 02:00 too soon, 06:00 is inside — wait for it.
        let w2 = Hours::new(2, 10).unwrap();
        assert_eq!(Shift::of(at(21, 2, 0), six(), w2, None, &utc).0, Shift::Hold);
        assert_eq!(Shift::of(at(21, 6, 0), six(), w2, None, &utc).0, Shift::Run { margin_ms: 0 });
    }
}

#[cfg(test)]
mod zone_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_zone_is_named_from_tz_then_the_system_files_and_unknown_otherwise() {
        assert_eq!(zone_name(Some("Asia/Kolkata"), None, None).as_deref(), Some("Asia/Kolkata"));
        assert_eq!(zone_name(Some(":Asia/Kolkata"), Some("Europe/Berlin"), None).as_deref(), Some("Asia/Kolkata"), "TZ first");
        assert_eq!(zone_name(Some("UTC"), None, None).as_deref(), Some("UTC"));
        assert_eq!(zone_name(Some("IST-5:30"), Some("Asia/Kolkata"), None), None, "a TZ rule names no zone: unknown, not the file's");
        assert_eq!(zone_name(None, Some("Asia/Kolkata\n"), None).as_deref(), Some("Asia/Kolkata"));
        assert_eq!(zone_name(None, None, Some(Path::new("/usr/share/zoneinfo/America/New_York"))).as_deref(), Some("America/New_York"));
        assert_eq!(zone_name(None, None, Some(Path::new("../zoneinfo/Etc/UTC"))).as_deref(), Some("Etc/UTC"));
        assert_eq!(zone_name(None, None, None), None);
        assert_eq!(zone_name(Some("../../etc/passwd"), None, None), None);
        let (_, off) = server_zone();
        assert!((-14 * 60..=14 * 60).contains(&off));
    }
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
