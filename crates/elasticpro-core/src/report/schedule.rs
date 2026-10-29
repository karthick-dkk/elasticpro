//! The mailed report: its settings (`<data>/report-schedule.json`) and when it is due.
//!
//! Two clocks, each for what it is good at. A period is a range of **UTC dates**, like the
//! days in the index names and every other report (`period`): the monthly report is the
//! previous calendar month of the UTC date, the weekly one the previous Monday..Sunday, the
//! daily one the UTC day before. The send **time** `at` is server local, like the daily
//! collection's `collectAt`: a period is sent at the first `at` after its last UTC day has
//! ended — on the 1st at 07:00 wherever 07:00 comes after midnight UTC (UTC itself, the
//! Americas, India), on the 2nd at 07:00 where it does not (east of UTC+7), so a report
//! never goes out before its last day is over.
//!
//! A period is due once its send moment has passed and it has not been sent — the key of
//! the last period sent by the schedule is kept on disk, so a restart neither sends it again
//! nor skips one that was missed while the core was down (the first tick after the restart
//! sends it, once).
//!
//! Saving a schedule marks the current period as already handled when its moment has
//! passed: switching a monthly report on on the 20th sends next month's, not last month's
//! three weeks late. `REPORT_SEND_NOW` is for that. A cadence or time changed in
//! config.txt is the same change made another way: the first tick after the start that
//! brings it in marks the passed period handled too (`reconcile`).

use super::period::{self, Period};
use crate::volume::schedule::parse_hhmm;
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FILE: &str = "report-schedule.json";
pub const DEFAULT_SUBJECT: &str = "ElasticPro volume report · {period}";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cadence {
    Monthly,
    Weekly,
    Daily,
    #[default]
    Manual,
}

impl Cadence {
    pub fn parse(s: &str) -> Option<Cadence> {
        match s.to_ascii_lowercase().as_str() {
            "monthly" => Some(Cadence::Monthly),
            "weekly" => Some(Cadence::Weekly),
            "daily" => Some(Cadence::Daily),
            "manual" => Some(Cadence::Manual),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSent {
    pub at: i64,
    /// How many recipients, never who: the addresses are in the settings for an admin.
    pub to: usize,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSchedule {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub schedule: Cadence,
    #[serde(default = "default_at")]
    pub at: String,
    /// `"all"` or a list of cluster ids.
    #[serde(default = "default_clusters")]
    pub clusters: Value,
    #[serde(default = "default_subject")]
    pub subject: String,
    #[serde(default = "default_sheets")]
    pub sheets: Vec<String>,
    #[serde(default)]
    pub last_sent: Option<LastSent>,
    /// The key of the last period the schedule sent (or tried to). Not shown to anyone as a
    /// setting; it is the memory that keeps a restart from sending twice.
    #[serde(default)]
    pub last_period: Option<String>,
    /// The cadence and time in force when the schedule last decided which period was handled
    /// (a save, or a tick that found config.txt changed). `None`: the file's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_schedule: Option<Cadence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_at: Option<String>,
    /// The period last given another try after a restart cut its job short, and how many:
    /// a job that brings the process down is retried once, not on every restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retried_period: Option<String>,
    #[serde(default)]
    pub retried: u32,
    #[serde(default)]
    pub set_by: Option<String>,
    #[serde(default)]
    pub set_at: Option<i64>,
}

fn default_at() -> String {
    "07:00".into()
}
fn default_clusters() -> Value {
    Value::String("all".into())
}
fn default_subject() -> String {
    DEFAULT_SUBJECT.into()
}
fn default_sheets() -> Vec<String> {
    super::build::SHEETS.iter().map(|s| s.to_string()).collect()
}

impl Default for ReportSchedule {
    fn default() -> ReportSchedule {
        ReportSchedule {
            enabled: false, to: vec![], cc: vec![], bcc: vec![], schedule: Cadence::Manual, at: default_at(),
            clusters: default_clusters(), subject: default_subject(), sheets: default_sheets(), last_sent: None,
            last_period: None, seen_schedule: None, seen_at: None, retried_period: None, retried: 0, set_by: None, set_at: None,
        }
    }
}

/// config.txt key → field.
pub const MANAGED_KEYS: &[(&str, &str)] = &[
    ("UI_REPORT_TO", "to"),
    ("UI_REPORT_SCHEDULE", "schedule"),
    ("UI_REPORT_AT", "at"),
    ("UI_REPORT_SHEETS", "sheets"),
];

/// A comma list, trimmed, empties dropped.
pub fn comma_list(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(String::from).collect()
}

/// `sheets` as kept: known names only, in their order, at least one.
pub fn check_sheets(list: &[String]) -> Result<Vec<String>, String> {
    for s in list {
        if !super::build::SHEETS.contains(&s.as_str()) {
            return Err(format!("sheets: {s:?} is not one of {}", super::build::SHEETS.join(", ")));
        }
    }
    let out: Vec<String> = super::build::SHEETS.iter().filter(|s| list.iter().any(|l| l == *s)).map(|s| s.to_string()).collect();
    if out.is_empty() {
        return Err("sheets: at least one of daily, monthly, breakdown".into());
    }
    Ok(out)
}

impl ReportSchedule {
    /// The schedule in force: the file under config.txt. Returns the managed field names.
    pub fn effective(&self, s: &crate::settings::Settings) -> (ReportSchedule, Vec<&'static str>) {
        let mut e = self.clone();
        let mut managed = vec![];
        for (key, field) in MANAGED_KEYS {
            let Some(v) = s.text(key) else { continue };
            match *field {
                "to" => e.to = comma_list(v),
                "schedule" => e.schedule = Cadence::parse(v).unwrap_or(e.schedule),
                "at" => e.at = v.to_string(),
                _ => e.sheets = check_sheets(&comma_list(v)).unwrap_or_else(|_| e.sheets.clone()),
            }
            managed.push(*field);
        }
        (e, managed)
    }

    /// Every cluster id the setting names, or `None` for all.
    pub fn cluster_ids(&self) -> Option<Vec<String>> {
        self.clusters.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
    }

    pub fn subject_for(&self, p: &Period) -> String {
        let s = if self.subject.trim().is_empty() { DEFAULT_SUBJECT } else { self.subject.as_str() };
        s.replace("{period}", &p.label)
    }

    pub fn recipients(&self) -> usize {
        self.to.len() + self.cc.len() + self.bcc.len()
    }
}

/// The key a sent period is remembered by.
pub fn period_key(p: &Period) -> String {
    format!("{}..{}", p.from, p.to)
}

/// The two readings of now a schedule decision needs: server local time (`at` is in it)
/// and UTC (a period's days are in it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clock {
    pub local: NaiveDateTime,
    pub utc: NaiveDateTime,
}

impl Clock {
    pub fn now() -> Clock {
        let n = chrono::Local::now();
        Clock { local: n.naive_local(), utc: n.naive_utc() }
    }

    /// A server local time, with the server's offset at that time (the tests' way in).
    pub fn at_local(local: NaiveDateTime) -> Clock {
        use chrono::TimeZone;
        let utc = chrono::Local.from_local_datetime(&local).earliest().map(|d| d.naive_utc()).unwrap_or(local);
        Clock { local, utc }
    }

    /// A clock `offset_minutes` east of UTC.
    pub fn with_offset(utc: NaiveDateTime, offset_minutes: i64) -> Clock {
        Clock { local: utc + Duration::minutes(offset_minutes), utc }
    }

    pub fn utc_today(&self) -> NaiveDate {
        self.utc.date()
    }

    /// Local time of the start of a UTC date.
    fn local_start_of(&self, utc_date: NaiveDate) -> NaiveDateTime {
        utc_date.and_time(NaiveTime::MIN) + (self.local - self.utc)
    }

    /// The first local `at` at or after the start of a UTC date: when a period that ended
    /// the day before may go out.
    fn moment_from(&self, utc_date: NaiveDate, at: NaiveTime) -> NaiveDateTime {
        let start = self.local_start_of(utc_date);
        if start.time() <= at { start.date().and_time(at) } else { (start.date() + Duration::days(1)).and_time(at) }
    }
}

/// The UTC date a cadence's current period gave way on (the 1st, Monday, today).
fn boundary(cadence: Cadence, utc_today: NaiveDate) -> Option<NaiveDate> {
    match cadence {
        Cadence::Manual => None,
        Cadence::Monthly => utc_today.with_day(1),
        Cadence::Weekly => Some(utc_today - Duration::days(utc_today.weekday().num_days_from_monday() as i64)),
        Cadence::Daily => Some(utc_today),
    }
}

/// The period a cadence covers now (UTC dates) and the local moment it may first be sent.
/// `None` for manual.
pub fn current(cadence: Cadence, at: &str, clock: Clock) -> Option<(Period, NaiveDateTime)> {
    let at = parse_hhmm(at)?;
    let today = clock.utc_today();
    Some((period_on(cadence, today)?, clock.moment_from(boundary(cadence, today)?, at)))
}

/// The period a cadence covers on a UTC date. `None` for manual.
fn period_on(cadence: Cadence, utc_today: NaiveDate) -> Option<Period> {
    match cadence {
        Cadence::Manual => None,
        Cadence::Monthly => Some(period::previous_month(utc_today)),
        Cadence::Weekly => Some(period::previous_week(utc_today)),
        Cadence::Daily => Some(period::yesterday(utc_today)),
    }
}

/// What a manual schedule sends (`REPORT_SEND_NOW` without a period): the current UTC month
/// so far.
pub fn manual_period(utc_today: NaiveDate) -> Period {
    period::month(utc_today.year(), utc_today.month(), utc_today).unwrap_or_else(|_| period::yesterday(utc_today))
}

/// The period the next scheduled send covers (`REPORT_SCHEDULE_GET` `nextPeriod`, and the
/// page's "Download .xlsx"): the current period while it has not been sent, else the one
/// after it — the next month, week or day, whole, as it will be sent. For manual, what
/// `REPORT_SEND_NOW` sends by default. Whether the schedule is on does not change it.
pub fn next_period(s: &ReportSchedule, clock: Clock) -> Period {
    let today = clock.utc_today();
    let Some(p) = period_on(s.schedule, today) else { return manual_period(today) };
    if s.last_period.as_deref() != Some(period_key(&p).as_str()) {
        return p;
    }
    let next = match s.schedule {
        Cadence::Monthly => {
            let (y, m) = if today.month() == 12 { (today.year() + 1, 1) } else { (today.year(), today.month() + 1) };
            NaiveDate::from_ymd_opt(y, m, 1)
        }
        Cadence::Weekly => boundary(Cadence::Weekly, today).map(|d| d + Duration::days(7)),
        _ => Some(today + Duration::days(1)),
    };
    next.and_then(|d| period_on(s.schedule, d)).unwrap_or(p)
}

/// The period to send now, if one is due: enabled, past its moment, not sent yet. A daily
/// report also waits for that day's scheduled collection (`collected`), so yesterday's
/// figures are final when they go out.
pub fn due(s: &ReportSchedule, clock: Clock, collected: bool) -> Option<Period> {
    if !s.enabled || s.to.is_empty() {
        return None;
    }
    let (p, moment) = current(s.schedule, &s.at, clock)?;
    if clock.local < moment || s.last_period.as_deref() == Some(period_key(&p).as_str()) {
        return None;
    }
    if s.schedule == Cadence::Daily && !collected {
        return None;
    }
    Some(p)
}

/// When the schedule will next send, local time: now when a period is due (or waiting for
/// the day's collection), else the next period's moment. `None` when it never will.
pub fn next_send(s: &ReportSchedule, clock: Clock) -> Option<NaiveDateTime> {
    if !s.enabled || s.to.is_empty() {
        return None;
    }
    let (p, moment) = current(s.schedule, &s.at, clock)?;
    if s.last_period.as_deref() != Some(period_key(&p).as_str()) {
        return Some(moment.max(clock.local));
    }
    let today = clock.utc_today();
    let next = match s.schedule {
        Cadence::Monthly => {
            let (y, m) = if today.month() == 12 { (today.year() + 1, 1) } else { (today.year(), today.month() + 1) };
            NaiveDate::from_ymd_opt(y, m, 1)?
        }
        Cadence::Weekly => boundary(Cadence::Weekly, today)? + Duration::days(7),
        _ => today + Duration::days(1),
    };
    Some(clock.moment_from(next, moment.time()))
}

/// When saving: the period whose moment has already passed counts as handled.
pub fn mark_passed(s: &mut ReportSchedule, clock: Clock) {
    if let Some((p, moment)) = current(s.schedule, &s.at, clock) {
        if clock.local >= moment {
            s.last_period = Some(period_key(&p));
        }
    }
}

/// config.txt changed the cadence or the time since the file last decided (a save, or an
/// earlier start): do what a save would have done — the period whose moment has passed
/// counts as handled — and remember what is now in force. `true` when the file changed.
pub fn reconcile(file: &mut ReportSchedule, s: &crate::settings::Settings, clock: Clock) -> bool {
    let (e, _) = file.effective(s);
    let seen = (file.seen_schedule.unwrap_or(file.schedule), file.seen_at.clone().unwrap_or_else(|| file.at.clone()));
    if seen == (e.schedule, e.at.clone()) {
        return false;
    }
    if e.enabled {
        let mut tmp = e.clone();
        mark_passed(&mut tmp, clock);
        file.last_period = tmp.last_period;
    }
    file.seen_schedule = Some(e.schedule);
    file.seen_at = Some(e.at);
    true
}

/// How a mailed job ended that did not send, for `ended_unsent`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retry {
    /// A person stopped it, or it failed on its own: the period stays handled.
    No,
    /// The emergency stop: try again on the first tick after it is over.
    Stop,
    /// A restart cut it short before its mail: try again, once per period.
    Restart,
}

/// A scheduled job for `key` ended without sending. Gives the period back to the schedule
/// (`last_period` cleared, so the next tick queues it again) when that is what `retry` asks
/// and the schedule still remembers this period as its last. Returns whether it did.
pub fn give_back(file: &mut ReportSchedule, key: &str, retry: Retry) -> bool {
    if retry == Retry::No || file.last_period.as_deref() != Some(key) {
        return false;
    }
    if retry == Retry::Restart {
        let before = if file.retried_period.as_deref() == Some(key) { file.retried } else { 0 };
        if before >= 1 {
            return false;
        }
        file.retried_period = Some(key.to_string());
        file.retried = before + 1;
    }
    file.last_period = None;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }
    /// A server on UTC: local time and UTC agree.
    fn at(s: &str) -> Clock {
        Clock::with_offset(local(s), 0)
    }
    /// A server `minutes` east of UTC, at local time `s`.
    fn east(s: &str, minutes: i64) -> Clock {
        Clock::with_offset(local(s) - Duration::minutes(minutes), minutes)
    }
    fn sched(c: Cadence) -> ReportSchedule {
        ReportSchedule { enabled: true, to: vec!["a@x.org".into()], schedule: c, at: "07:00".into(), ..ReportSchedule::default() }
    }

    #[test]
    fn monthly_on_the_first_after_at_once() {
        let mut s = sched(Cadence::Monthly);
        assert_eq!(due(&s, at("2026-11-01 06:59"), true), None, "before 07:00 on the 1st");
        let p = due(&s, at("2026-11-01 07:00"), true).unwrap();
        assert_eq!((p.from.as_str(), p.to.as_str()), ("2026-10-01", "2026-10-31"));
        s.last_period = Some(period_key(&p));
        assert_eq!(due(&s, at("2026-11-01 07:01"), true), None, "sent: not again, restart or not");
        assert_eq!(due(&s, at("2026-11-20 07:01"), true), None);
        // Down over the 1st: the first tick after it sends the missed month, once.
        let mut late = sched(Cadence::Monthly);
        late.last_period = Some("2026-09-01..2026-09-30".into());
        assert_eq!(due(&late, at("2026-11-03 09:00"), true).map(|p| p.from), Some("2026-10-01".into()));
        // December's report goes out on the 1st of January.
        assert_eq!(due(&sched(Cadence::Monthly), at("2027-01-01 08:00"), true).map(|p| p.to), Some("2026-12-31".into()));
    }

    #[test]
    fn weekly_on_monday_for_the_previous_monday_to_sunday() {
        let s = sched(Cadence::Weekly);
        // 2026-11-02 is a Monday.
        assert_eq!(due(&s, at("2026-11-02 06:00"), true), None);
        let p = due(&s, at("2026-11-02 07:30"), true).unwrap();
        assert_eq!((p.from.as_str(), p.to.as_str()), ("2026-10-26", "2026-11-01"));
        assert_eq!(due(&s, at("2026-11-04 12:00"), true).map(|p| p.from), Some("2026-10-26".into()), "missed Monday: sent Wednesday");
    }

    #[test]
    fn daily_waits_for_the_days_collection() {
        let s = sched(Cadence::Daily);
        assert_eq!(due(&s, at("2026-10-29 07:05"), false), None, "collection not finished");
        assert_eq!(due(&s, at("2026-10-29 07:05"), true).map(|p| p.from), Some("2026-10-28".into()));
        assert_eq!(due(&s, at("2026-10-29 06:59"), true), None);
    }

    #[test]
    fn off_manual_or_nobody_to_send_to_is_never_due() {
        let mut s = sched(Cadence::Monthly);
        s.enabled = false;
        assert_eq!(due(&s, at("2026-11-01 08:00"), true), None);
        assert_eq!(due(&sched(Cadence::Manual), at("2026-11-01 08:00"), true), None);
        let mut s = sched(Cadence::Monthly);
        s.to.clear();
        assert_eq!(due(&s, at("2026-11-01 08:00"), true), None);
    }

    #[test]
    fn saving_late_in_a_period_does_not_send_it_late() {
        let mut s = sched(Cadence::Monthly);
        mark_passed(&mut s, at("2026-10-20 10:00"));
        assert_eq!(due(&s, at("2026-10-20 10:01"), true), None, "September is not sent on the 20th of October");
        assert!(due(&s, at("2026-11-01 07:00"), true).is_some(), "October is, on the 1st");
        let mut d = sched(Cadence::Daily);
        mark_passed(&mut d, at("2026-10-29 06:00"));
        assert!(d.last_period.is_none(), "before today's moment: today's send still happens");
        assert!(due(&d, at("2026-10-29 07:00"), true).is_some());
    }

    #[test]
    fn the_next_send() {
        let mut s = sched(Cadence::Monthly);
        assert_eq!(next_send(&s, at("2026-10-31 23:00")), Some(local("2026-10-31 23:00")), "September never sent: now");
        mark_passed(&mut s, at("2026-10-20 10:00"));
        assert_eq!(next_send(&s, at("2026-10-20 10:00")), Some(local("2026-11-01 07:00")));
        assert_eq!(next_send(&s, at("2026-12-05 10:00")), Some(local("2026-12-05 10:00")), "November not sent yet: due now");
        let mut d = sched(Cadence::Daily);
        assert_eq!(next_send(&d, at("2026-10-29 05:00")), Some(local("2026-10-29 07:00")));
        mark_passed(&mut d, at("2026-10-29 08:00"));
        assert_eq!(next_send(&d, at("2026-10-29 08:00")), Some(local("2026-10-30 07:00")));
        assert_eq!(next_send(&sched(Cadence::Manual), at("2026-10-29 08:00")), None);
        let mut w = sched(Cadence::Weekly);
        mark_passed(&mut w, at("2026-11-04 08:00"));
        assert_eq!(next_send(&w, at("2026-11-04 08:00")), Some(local("2026-11-09 07:00")), "the next Monday");
    }

    #[test]
    fn the_next_period_is_what_the_next_send_covers() {
        let p = |s: &ReportSchedule, c: Clock| { let x = next_period(s, c); (x.from, x.to, x.label) };
        let mut m = sched(Cadence::Monthly);
        assert_eq!(p(&m, at("2026-10-29 10:00")), ("2026-09-01".into(), "2026-09-30".into(), "2026-09".into()), "September not sent yet");
        m.last_period = Some("2026-09-01..2026-09-30".into());
        assert_eq!(p(&m, at("2026-10-29 10:00")), ("2026-10-01".into(), "2026-10-31".into(), "2026-10".into()), "sent: October, whole");
        m.enabled = false;
        assert_eq!(p(&m, at("2026-10-29 10:00")).0, "2026-10-01", "on or off, the same period");
        let mut d = sched(Cadence::Monthly);
        d.last_period = Some("2026-11-01..2026-11-30".into());
        assert_eq!(p(&d, at("2026-12-05 10:00")).0, "2026-12-01", "December after November");
        let mut w = sched(Cadence::Weekly);
        w.last_period = Some("2026-10-19..2026-10-25".into());
        assert_eq!(p(&w, at("2026-10-29 10:00")), ("2026-10-26".into(), "2026-11-01".into(), "2026-10-26 – 2026-11-01".into()));
        let mut y = sched(Cadence::Daily);
        assert_eq!(p(&y, at("2026-10-29 10:00")).0, "2026-10-28");
        y.last_period = Some("2026-10-28..2026-10-28".into());
        assert_eq!(p(&y, at("2026-10-29 10:00")).0, "2026-10-29");
        // UTC dates: 04:00 on the 1st in India is still the 31st in UTC.
        assert_eq!(p(&sched(Cadence::Daily), east("2026-11-01 04:00", 330)).0, "2026-10-30");
        // Manual: what REPORT_SEND_NOW sends by default, the UTC month so far.
        assert_eq!(p(&sched(Cadence::Manual), at("2026-10-29 10:00")), ("2026-10-01".into(), "2026-10-29".into(), "2026-10 (so far)".into()));
    }

    #[test]
    fn periods_are_utc_dates_and_only_the_time_is_local() {
        // India, UTC+5:30: 07:00 on the 1st is 01:30 UTC on the 1st — October is over.
        let p = due(&sched(Cadence::Monthly), east("2026-11-01 07:00", 330), true).unwrap();
        assert_eq!((p.from.as_str(), p.to.as_str()), ("2026-10-01", "2026-10-31"));
        assert_eq!(due(&sched(Cadence::Monthly), east("2026-11-01 06:59", 330), true), None);
        // A daily report at 04:00 India time on the 29th: 22:30 UTC on the 28th. The UTC
        // 28th is not over, so the 27th is the day due — the record's days are UTC days.
        let mut d = sched(Cadence::Daily);
        d.at = "04:00".into();
        let p = due(&d, east("2026-10-29 04:00", 330), true).unwrap();
        assert_eq!(p.from, "2026-10-27", "{p:?}");
        // After 05:30 local (UTC midnight) the 28th has ended; it goes at the next 04:00.
        d.last_period = Some(period_key(&p));
        assert_eq!(due(&d, east("2026-10-29 06:00", 330), true), None, "the 28th waits for 04:00");
        assert_eq!(next_send(&d, east("2026-10-29 06:00", 330)), Some(local("2026-10-30 04:00")));
        assert_eq!(due(&d, east("2026-10-30 04:00", 330), true).map(|p| p.from), Some("2026-10-28".into()));
        // New York, UTC-4: 07:00 on the 1st is 11:00 UTC on the 1st.
        let p = due(&sched(Cadence::Monthly), east("2026-11-01 07:00", -240), true).unwrap();
        assert_eq!(p.to, "2026-10-31");
        // Tokyo, UTC+9: 07:00 on the 1st is 22:00 UTC on the 31st — October is not over, so
        // September is the current period (long sent) and October goes on the 2nd at 07:00.
        let mut m = sched(Cadence::Monthly);
        m.last_period = Some("2026-09-01..2026-09-30".into());
        assert_eq!(due(&m, east("2026-11-01 07:00", 540), true), None, "October's last UTC day is not over");
        assert_eq!(due(&m, east("2026-11-01 10:00", 540), true), None, "over now, but 07:00 has passed for the day");
        assert_eq!(next_send(&m, east("2026-11-01 10:00", 540)), Some(local("2026-11-02 07:00")));
        assert_eq!(due(&m, east("2026-11-02 07:00", 540), true).map(|p| p.to), Some("2026-10-31".into()));
    }

    #[test]
    fn a_cadence_or_time_changed_in_config_txt_is_handled_like_a_save() {
        let mut f = sched(Cadence::Monthly);
        f.seen_schedule = Some(Cadence::Monthly);
        f.seen_at = Some("07:00".into());
        let none = crate::settings::Settings::default();
        assert!(!reconcile(&mut f, &none, at("2026-10-20 10:00")), "nothing changed");
        assert_eq!(due(&f, at("2026-10-20 10:00"), true).map(|p| p.from), Some("2026-09-01".into()),
                   "unchanged, a missed send still goes out");
        // config.txt now says weekly: last week's moment (Monday the 19th) has passed.
        let weekly = crate::settings::Settings::parse("UI_REPORT_SCHEDULE=weekly\n");
        assert!(reconcile(&mut f, &weekly, at("2026-10-20 10:00")));
        let (e, _) = f.effective(&weekly);
        assert_eq!(due(&e, at("2026-10-20 10:00"), true), None, "not sent late");
        assert_eq!((f.seen_schedule, f.seen_at.as_deref()), (Some(Cadence::Weekly), Some("07:00")));
        assert!(!reconcile(&mut f, &weekly, at("2026-10-20 10:05")), "once");
        assert!(due(&f.effective(&weekly).0, at("2026-10-26 07:00"), true).is_some(), "next Monday's goes");
        // A file that never recorded what it saw compares with its own fields.
        let mut old = sched(Cadence::Monthly);
        assert!(!reconcile(&mut old, &none, at("2026-10-20 10:00")));
        assert!(reconcile(&mut old, &crate::settings::Settings::parse("UI_REPORT_AT=06:00\n"), at("2026-10-20 10:00")));
        assert_eq!(old.last_period.as_deref(), Some("2026-09-01..2026-09-30"));
    }

    #[test]
    fn an_unsent_period_is_given_back_for_the_stop_and_once_for_a_restart() {
        let key = "2026-10-01..2026-10-31";
        let mut f = sched(Cadence::Monthly);
        f.last_period = Some(key.into());
        assert!(!give_back(&mut f, key, Retry::No), "stopped by a person: handled");
        assert!(!give_back(&mut f, "2026-09-01..2026-09-30", Retry::Stop), "not the period it remembers");
        assert!(give_back(&mut f, key, Retry::Stop));
        assert_eq!(f.last_period, None);
        f.last_period = Some(key.into());
        assert!(give_back(&mut f, key, Retry::Stop), "the stop as often as it comes");
        f.last_period = Some(key.into());
        assert!(give_back(&mut f, key, Retry::Restart), "a restart: once");
        f.last_period = Some(key.into());
        assert!(!give_back(&mut f, key, Retry::Restart), "not on every restart");
        assert_eq!(f.last_period.as_deref(), Some(key));
    }

    #[test]
    fn config_txt_over_the_file() {
        let s = crate::settings::Settings::parse("UI_REPORT_TO=a@x.org, b@x.org\nUI_REPORT_SCHEDULE=Weekly\nUI_REPORT_SHEETS=monthly,daily\n");
        assert!(s.warnings().is_empty(), "{:?}", s.warnings());
        let (e, managed) = ReportSchedule::default().effective(&s);
        assert_eq!(e.to, vec!["a@x.org", "b@x.org"]);
        assert_eq!(e.schedule, Cadence::Weekly);
        assert_eq!(e.sheets, vec!["daily", "monthly"], "kept in their order");
        assert_eq!(managed, vec!["to", "schedule", "sheets"]);
        assert!(check_sheets(&["weekly".into()]).is_err());
        assert!(check_sheets(&[]).is_err());
        let p = period::yesterday(chrono::NaiveDate::from_ymd_opt(2026, 10, 29).unwrap());
        assert_eq!(ReportSchedule::default().subject_for(&p), "ElasticPro volume report · 2026-10-28");
    }
}
