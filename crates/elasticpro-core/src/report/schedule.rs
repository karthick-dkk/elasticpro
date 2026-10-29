//! The mailed report: its settings (`<data>/report-schedule.json`) and when it is due.
//!
//! Server local time, like the daily collection (`volume::schedule`): "sent on the 1st at
//! 07:00" is the operator's 1st. A period is due once its send moment has passed and it has
//! not been sent — the key of the last period sent by the schedule is kept on disk, so a
//! restart neither sends it again nor skips one that was missed while the core was down
//! (the first tick after the restart sends it, once).
//!
//! Saving a schedule marks the current period as already handled when its moment has
//! passed: switching a monthly report on on the 20th sends next month's, not last month's
//! three weeks late. `REPORT_SEND_NOW` is for that.

use super::period::{self, Period};
use crate::volume::schedule::parse_hhmm;
use chrono::{Datelike, Duration, NaiveDateTime};
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
            last_period: None, set_by: None, set_at: None,
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

/// The period a cadence covers when asked at `local`, and the moment it may first be sent.
/// `None` for manual.
pub fn current(cadence: Cadence, at: &str, local: NaiveDateTime) -> Option<(Period, NaiveDateTime)> {
    let at = parse_hhmm(at)?;
    let today = local.date();
    match cadence {
        Cadence::Manual => None,
        Cadence::Monthly => {
            let first = today.with_day(1)?;
            Some((period::previous_month(today), first.and_time(at)))
        }
        Cadence::Weekly => {
            let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
            Some((period::previous_week(today), monday.and_time(at)))
        }
        Cadence::Daily => Some((period::yesterday(today), today.and_time(at))),
    }
}

/// The period to send now, if one is due: enabled, past its moment, not sent yet. A daily
/// report also waits for that day's scheduled collection (`collected`), so yesterday's
/// figures are final when they go out.
pub fn due(s: &ReportSchedule, local: NaiveDateTime, collected: bool) -> Option<Period> {
    if !s.enabled || s.to.is_empty() {
        return None;
    }
    let (p, moment) = current(s.schedule, &s.at, local)?;
    if local < moment || s.last_period.as_deref() == Some(period_key(&p).as_str()) {
        return None;
    }
    if s.schedule == Cadence::Daily && !collected {
        return None;
    }
    Some(p)
}

/// When the schedule will next send, local time: now when a period is due (or waiting for
/// the day's collection), else the next period's moment. `None` when it never will.
pub fn next_send(s: &ReportSchedule, local: NaiveDateTime) -> Option<NaiveDateTime> {
    if !s.enabled || s.to.is_empty() {
        return None;
    }
    let (p, moment) = current(s.schedule, &s.at, local)?;
    if s.last_period.as_deref() != Some(period_key(&p).as_str()) {
        return Some(moment.max(local));
    }
    let today = local.date();
    Some(match s.schedule {
        Cadence::Monthly => {
            let (y, m) = if today.month() == 12 { (today.year() + 1, 1) } else { (today.year(), today.month() + 1) };
            chrono::NaiveDate::from_ymd_opt(y, m, 1)?.and_time(moment.time())
        }
        Cadence::Weekly => moment + Duration::days(7),
        _ => moment + Duration::days(1),
    })
}

/// When saving: the period whose moment has already passed counts as handled.
pub fn mark_passed(s: &mut ReportSchedule, local: NaiveDateTime) {
    if let Some((p, moment)) = current(s.schedule, &s.at, local) {
        if local >= moment {
            s.last_period = Some(period_key(&p));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
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
        assert_eq!(next_send(&s, at("2026-10-31 23:00")), Some(at("2026-10-31 23:00")), "September never sent: now");
        mark_passed(&mut s, at("2026-10-20 10:00"));
        assert_eq!(next_send(&s, at("2026-10-20 10:00")), Some(at("2026-11-01 07:00")));
        assert_eq!(next_send(&s, at("2026-12-05 10:00")), Some(at("2026-12-05 10:00")), "November not sent yet: due now");
        let mut d = sched(Cadence::Daily);
        assert_eq!(next_send(&d, at("2026-10-29 05:00")), Some(at("2026-10-29 07:00")));
        mark_passed(&mut d, at("2026-10-29 08:00"));
        assert_eq!(next_send(&d, at("2026-10-29 08:00")), Some(at("2026-10-30 07:00")));
        assert_eq!(next_send(&sched(Cadence::Manual), at("2026-10-29 08:00")), None);
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
