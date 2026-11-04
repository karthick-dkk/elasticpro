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

use super::jobs::ReportKind;
use super::period::{self, Period};
use crate::volume::schedule::parse_hhmm;
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FILE: &str = "report-schedule.json";
pub const DEFAULT_SUBJECT: &str = "ElasticPro volume report · {period}";
pub const DEFAULT_SUBJECT_INDICES: &str = "ElasticPro indices report · {period}";
pub const DEFAULT_SUBJECT_HOSTS: &str = "ElasticPro volume by host · {period}";

pub fn default_subject_for(kind: ReportKind) -> &'static str {
    match kind {
        ReportKind::Volume => DEFAULT_SUBJECT,
        ReportKind::Indices => DEFAULT_SUBJECT_INDICES,
        ReportKind::Hosts => DEFAULT_SUBJECT_HOSTS,
    }
}

/// Which days a schedule's send covers (docs/REPORT-TYPES.md "Schedules"): the cadence's own
/// period (previous month, week, day — the volume report's), yesterday, or the month so far
/// (`period::month_so_far`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PeriodChoice {
    #[default]
    Cadence,
    Yesterday,
    MonthSoFar,
}

impl PeriodChoice {
    pub fn parse(s: &str) -> Option<PeriodChoice> {
        match s {
            "cadence" => Some(PeriodChoice::Cadence),
            "yesterday" => Some(PeriodChoice::Yesterday),
            "monthSoFar" => Some(PeriodChoice::MonthSoFar),
            _ => None,
        }
    }
}

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
    /// State, not a setting (docs/WORKER.md): kept in `report-schedule-state.json` by whoever
    /// runs the reports; in this file only before 0.3.54, read once and migrated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sent: Option<LastSent>,
    /// The key of the last period the schedule sent (or tried to). Not shown to anyone as a
    /// setting; it is the memory that keeps a restart from sending twice. State (as above).
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    #[serde(default, skip_serializing_if = "is_zero")]
    pub retried: u32,
    /// A save's decision that the period whose moment had passed counts as handled: the key
    /// the state takes in once (for this `set_at`). Written by the core, which never writes
    /// the state itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark_passed: Option<String>,
    #[serde(default)]
    pub set_by: Option<String>,
    #[serde(default)]
    pub set_at: Option<i64>,
    /// Which days a send covers. The volume report's default is the cadence's own period;
    /// the indices and hosts reports' is the month so far.
    #[serde(default)]
    pub period: PeriodChoice,
    /// Which report this schedule is for: set when the file is read (`ScheduleFile`), never
    /// kept inside the entry — the entry's key says it.
    #[serde(skip)]
    pub kind: ReportKind,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
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
        ReportSchedule::default_for(ReportKind::Volume)
    }
}

impl ReportSchedule {
    /// A kind's schedule before anybody set it (docs/REPORT-TYPES.md "Schedules"): the volume
    /// report manual at 07:00; the indices report daily at 08:00 and the hosts report daily
    /// at 06:00, both over the month so far. All off: a mail is a person's decision.
    pub fn default_for(kind: ReportKind) -> ReportSchedule {
        let (schedule, at, period) = match kind {
            ReportKind::Volume => (Cadence::Manual, default_at(), PeriodChoice::Cadence),
            ReportKind::Indices => (Cadence::Daily, "08:00".to_string(), PeriodChoice::MonthSoFar),
            ReportKind::Hosts => (Cadence::Daily, "06:00".to_string(), PeriodChoice::MonthSoFar),
        };
        ReportSchedule {
            enabled: false, to: vec![], cc: vec![], bcc: vec![], schedule, at,
            clusters: default_clusters(), subject: default_subject_for(kind).into(), sheets: default_sheets(), last_sent: None,
            last_period: None, seen_schedule: None, seen_at: None, retried_period: None, retried: 0, mark_passed: None, set_by: None, set_at: None,
            period, kind,
        }
    }
}

/// config.txt key → field, the volume report's.
pub const MANAGED_KEYS: &[(&str, &str)] = &[
    ("UI_REPORT_TO", "to"),
    ("UI_REPORT_SCHEDULE", "schedule"),
    ("UI_REPORT_AT", "at"),
    ("UI_REPORT_SHEETS", "sheets"),
];
pub const MANAGED_KEYS_INDICES: &[(&str, &str)] = &[
    ("UI_REPORT_INDICES_TO", "to"),
    ("UI_REPORT_INDICES_SCHEDULE", "schedule"),
    ("UI_REPORT_INDICES_AT", "at"),
];
pub const MANAGED_KEYS_HOSTS: &[(&str, &str)] = &[
    ("UI_REPORT_HOSTS_TO", "to"),
    ("UI_REPORT_HOSTS_SCHEDULE", "schedule"),
    ("UI_REPORT_HOSTS_AT", "at"),
];

pub fn managed_keys(kind: ReportKind) -> &'static [(&'static str, &'static str)] {
    match kind {
        ReportKind::Volume => MANAGED_KEYS,
        ReportKind::Indices => MANAGED_KEYS_INDICES,
        ReportKind::Hosts => MANAGED_KEYS_HOSTS,
    }
}

/// `report-schedule.json`: one schedule per kind, `{volume, indices, hosts}`. A file written
/// before 0.3.54 is one schedule object, and reads as `volume`; it is written back per kind
/// on the next change. A kind the file does not have is its default; a field an entry does
/// not have is that kind's default.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleFile {
    pub volume: ReportSchedule,
    pub indices: ReportSchedule,
    pub hosts: ReportSchedule,
}

impl Default for ScheduleFile {
    fn default() -> ScheduleFile {
        ScheduleFile {
            volume: ReportSchedule::default_for(ReportKind::Volume),
            indices: ReportSchedule::default_for(ReportKind::Indices),
            hosts: ReportSchedule::default_for(ReportKind::Hosts),
        }
    }
}

impl ScheduleFile {
    pub fn from_value(v: &Value) -> ScheduleFile {
        let per_kind = v.as_object().is_some_and(|o| ReportKind::ALL.iter().any(|k| o.get(k.as_str()).is_some_and(Value::is_object)));
        let entry = |kind: ReportKind, stored: Option<&Value>| -> ReportSchedule {
            let mut base = serde_json::to_value(ReportSchedule::default_for(kind)).unwrap_or(Value::Null);
            if let (Some(b), Some(s)) = (base.as_object_mut(), stored.and_then(Value::as_object)) {
                for (k, x) in s {
                    b.insert(k.clone(), x.clone());
                }
            }
            let mut out: ReportSchedule = serde_json::from_value(base).unwrap_or_else(|_| ReportSchedule::default_for(kind));
            out.kind = kind;
            out
        };
        if per_kind {
            ScheduleFile {
                volume: entry(ReportKind::Volume, v.get("volume")),
                indices: entry(ReportKind::Indices, v.get("indices")),
                hosts: entry(ReportKind::Hosts, v.get("hosts")),
            }
        } else {
            ScheduleFile { volume: entry(ReportKind::Volume, Some(v)), ..ScheduleFile::default() }
        }
    }

    pub fn get(&self, kind: ReportKind) -> &ReportSchedule {
        match kind {
            ReportKind::Volume => &self.volume,
            ReportKind::Indices => &self.indices,
            ReportKind::Hosts => &self.hosts,
        }
    }

    pub fn get_mut(&mut self, kind: ReportKind) -> &mut ReportSchedule {
        match kind {
            ReportKind::Volume => &mut self.volume,
            ReportKind::Indices => &mut self.indices,
            ReportKind::Hosts => &mut self.hosts,
        }
    }
}

impl Serialize for ScheduleFile {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(3))?;
        m.serialize_entry("volume", &self.volume)?;
        m.serialize_entry("indices", &self.indices)?;
        m.serialize_entry("hosts", &self.hosts)?;
        m.end()
    }
}

impl<'de> Deserialize<'de> for ScheduleFile {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<ScheduleFile, D::Error> {
        Ok(ScheduleFile::from_value(&Value::deserialize(d)?))
    }
}

/* -------------------------------------- settings and state -------------------------------------- */

/// `report-schedule-state.json`: what happened to each schedule — the last send, the last
/// period, the retries, what was in force when it last decided. Written only by the process
/// that runs the reports (the worker, or role all); the core reads it for Exports.
pub const STATE_FILE: &str = "report-schedule-state.json";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleState {
    pub last_sent: Option<LastSent>,
    pub last_period: Option<String>,
    pub retried_period: Option<String>,
    pub retried: u32,
    pub seen_schedule: Option<Cadence>,
    pub seen_at: Option<String>,
    /// The settings' `setAt` this state has taken in: a save's `markPassed` and `seen*` are
    /// taken in once, by the first read after it.
    pub applied_set_at: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StateFile {
    pub volume: ScheduleState,
    pub indices: ScheduleState,
    pub hosts: ScheduleState,
}

impl StateFile {
    pub fn get(&self, kind: ReportKind) -> &ScheduleState {
        match kind {
            ReportKind::Volume => &self.volume,
            ReportKind::Indices => &self.indices,
            ReportKind::Hosts => &self.hosts,
        }
    }

    pub fn get_mut(&mut self, kind: ReportKind) -> &mut ScheduleState {
        match kind {
            ReportKind::Volume => &mut self.volume,
            ReportKind::Indices => &mut self.indices,
            ReportKind::Hosts => &mut self.hosts,
        }
    }
}

impl ScheduleState {
    /// The state a merged entry carries.
    pub fn of(s: &ReportSchedule) -> ScheduleState {
        ScheduleState {
            last_sent: s.last_sent.clone(), last_period: s.last_period.clone(), retried_period: s.retried_period.clone(),
            retried: s.retried, seen_schedule: s.seen_schedule, seen_at: s.seen_at.clone(), applied_set_at: s.set_at,
        }
    }

    /// A settings entry from before 0.3.54 kept its state itself: that is the state until a
    /// state file exists.
    fn legacy(s: &ReportSchedule) -> ScheduleState {
        ScheduleState { applied_set_at: None, ..ScheduleState::of(s) }
    }

    /// Take in a save the state has not seen: what was in force when it was made, and its
    /// decision about the period whose moment had passed.
    fn take_in(mut self, set: &ReportSchedule) -> ScheduleState {
        if set.set_at.is_some() && set.set_at != self.applied_set_at {
            if set.seen_schedule.is_some() {
                self.seen_schedule = set.seen_schedule;
            }
            if set.seen_at.is_some() {
                self.seen_at = set.seen_at.clone();
            }
            if let Some(m) = &set.mark_passed {
                self.last_period = Some(m.clone());
            }
            self.applied_set_at = set.set_at;
        }
        self
    }
}

/// The schedules as every decision reads them: the settings, with the state laid over them.
/// `state` is `None` when no state file exists yet (a stack upgraded from before 0.3.54): the
/// settings' own state fields are the state then — read once, and migrated by the first write.
pub fn merge(settings: &ScheduleFile, state: Option<&StateFile>) -> ScheduleFile {
    let mut out = settings.clone();
    for kind in ReportKind::ALL {
        let set = settings.get(kind);
        let st = match state {
            Some(f) => f.get(kind).clone(),
            None => ScheduleState::legacy(set),
        }
        .take_in(set);
        let e = out.get_mut(kind);
        e.last_sent = st.last_sent;
        e.last_period = st.last_period;
        e.retried_period = st.retried_period;
        e.retried = st.retried;
        e.seen_schedule = st.seen_schedule;
        e.seen_at = st.seen_at;
        e.mark_passed = None;
    }
    out
}

/// The state of merged schedules, as the state file keeps it.
pub fn state_of(merged: &ScheduleFile) -> StateFile {
    StateFile {
        volume: ScheduleState::of(&merged.volume),
        indices: ScheduleState::of(&merged.indices),
        hosts: ScheduleState::of(&merged.hosts),
    }
}

/// The settings as the core writes them, without the state fields. Only once the state file
/// exists: before, they are the state still to be migrated, and are left where they are.
pub fn strip_state(f: &mut ScheduleFile) {
    for kind in ReportKind::ALL {
        let e = f.get_mut(kind);
        e.last_sent = None;
        e.last_period = None;
        e.retried_period = None;
        e.retried = 0;
    }
}

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
        for (key, field) in managed_keys(self.kind) {
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
        let s = if self.subject.trim().is_empty() { default_subject_for(self.kind) } else { self.subject.as_str() };
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

/// The period a schedule covers now (UTC dates) and the local moment it may first be sent.
/// `None` for manual.
pub fn current(s: &ReportSchedule, clock: Clock) -> Option<(Period, NaiveDateTime)> {
    let at = parse_hhmm(&s.at)?;
    let today = clock.utc_today();
    Some((period_on(s.schedule, s.period, today)?, clock.moment_from(boundary(s.schedule, today)?, at)))
}

/// The period a schedule covers on a UTC date: its cadence's own (previous month, week,
/// day), yesterday, or the month so far. `None` for manual.
fn period_on(cadence: Cadence, choice: PeriodChoice, utc_today: NaiveDate) -> Option<Period> {
    if cadence == Cadence::Manual {
        return None;
    }
    Some(match (choice, cadence) {
        (PeriodChoice::Yesterday, _) => period::yesterday(utc_today),
        (PeriodChoice::MonthSoFar, _) => period::month_so_far(utc_today),
        (_, Cadence::Monthly) => period::previous_month(utc_today),
        (_, Cadence::Weekly) => period::previous_week(utc_today),
        _ => period::yesterday(utc_today),
    })
}

/// What a manual schedule sends (`REPORT_SEND_NOW` without a period): the volume report's
/// is the current UTC month so far, today included, as it always was; the others' follow
/// their `period` (the month so far by default — `period::month_so_far`, yesterday's end).
pub fn manual_period_for(s: &ReportSchedule, utc_today: NaiveDate) -> Period {
    match s.period {
        PeriodChoice::Yesterday => period::yesterday(utc_today),
        PeriodChoice::MonthSoFar => period::month_so_far(utc_today),
        PeriodChoice::Cadence => manual_period(utc_today),
    }
}

/// The volume report's manual period: the current UTC month so far.
pub fn manual_period(utc_today: NaiveDate) -> Period {
    period::month(utc_today.year(), utc_today.month(), utc_today).unwrap_or_else(|_| period::yesterday(utc_today))
}

/// What a send now covers without a period: the schedule's current period, or the manual one.
pub fn send_now_period(s: &ReportSchedule, clock: Clock) -> Period {
    match current(s, clock) {
        Some((p, _)) => p,
        None => manual_period_for(s, clock.utc_today()),
    }
}

/// The period the next scheduled send covers (`REPORT_SCHEDULE_GET` `nextPeriod`, and the
/// page's "Download .xlsx"): the current period while it has not been sent, else the one
/// after it — the next month, week or day, whole, as it will be sent. For manual, what
/// `REPORT_SEND_NOW` sends by default. Whether the schedule is on does not change it.
pub fn next_period(s: &ReportSchedule, clock: Clock) -> Period {
    let today = clock.utc_today();
    let Some(p) = period_on(s.schedule, s.period, today) else { return manual_period_for(s, today) };
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
    next.and_then(|d| period_on(s.schedule, s.period, d)).unwrap_or(p)
}

/// The period to send now, if one is due: enabled, past its moment, not sent yet. A daily
/// report also waits for that day's scheduled collection (`collected`), so yesterday's
/// figures are final when they go out.
pub fn due(s: &ReportSchedule, clock: Clock, collected: bool) -> Option<Period> {
    if !s.enabled || s.to.is_empty() {
        return None;
    }
    let (p, moment) = current(s, clock)?;
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
    let (p, moment) = current(s, clock)?;
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
    if let Some((p, moment)) = current(s, clock) {
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

    #[test]
    fn an_old_single_schedule_reads_as_volume_and_the_new_kinds_have_their_defaults() {
        let old = serde_json::json!({ "enabled": true, "to": ["a@x.org"], "schedule": "monthly", "at": "07:30", "lastPeriod": "2026-09-01..2026-09-30" });
        let f: ScheduleFile = serde_json::from_value(old).unwrap();
        assert_eq!((f.volume.enabled, f.volume.schedule, f.volume.at.as_str()), (true, Cadence::Monthly, "07:30"));
        assert_eq!(f.volume.last_period.as_deref(), Some("2026-09-01..2026-09-30"));
        assert_eq!((f.volume.kind, f.volume.period), (ReportKind::Volume, PeriodChoice::Cadence));
        assert_eq!((f.indices.enabled, f.indices.schedule, f.indices.at.as_str(), f.indices.period), (false, Cadence::Daily, "08:00", PeriodChoice::MonthSoFar));
        assert_eq!((f.hosts.enabled, f.hosts.schedule, f.hosts.at.as_str(), f.hosts.period), (false, Cadence::Daily, "06:00", PeriodChoice::MonthSoFar));
        assert_eq!(f.hosts.subject, DEFAULT_SUBJECT_HOSTS);
        // Written back per kind, and read back the same.
        let text = serde_json::to_value(&f).unwrap();
        assert!(text.get("volume").is_some() && text.get("indices").is_some() && text.get("hosts").is_some());
        assert!(text["hosts"].get("kind").is_none(), "the kind is the key, not a field");
        let back: ScheduleFile = serde_json::from_value(text).unwrap();
        assert_eq!(back, f);
        // A per-kind file with only some fields: the rest are that kind's defaults.
        let part: ScheduleFile = serde_json::from_value(serde_json::json!({ "indices": { "enabled": true, "to": ["b@x.org"] } })).unwrap();
        assert_eq!((part.indices.enabled, part.indices.at.as_str(), part.indices.kind), (true, "08:00", ReportKind::Indices));
        assert_eq!(part.volume, ReportSchedule::default());
    }

    #[test]
    fn a_daily_month_so_far_schedule_sends_every_day_and_the_whole_month_on_the_1st() {
        let mut s = ReportSchedule { enabled: true, to: vec!["a@x.org".into()], ..ReportSchedule::default_for(ReportKind::Indices) };
        assert_eq!(due(&s, at("2026-11-04 07:59"), true), None, "before 08:00");
        let p = due(&s, at("2026-11-04 08:00"), true).unwrap();
        assert_eq!((p.from.as_str(), p.to.as_str()), ("2026-11-01", "2026-11-03"));
        s.last_period = Some(period_key(&p));
        assert_eq!(due(&s, at("2026-11-04 09:00"), true), None, "once a day");
        let next = due(&s, at("2026-11-05 08:00"), true).unwrap();
        assert_eq!((next.from.as_str(), next.to.as_str()), ("2026-11-01", "2026-11-04"), "the next day: one day more");
        let first = due(&s, at("2026-12-01 08:00"), true).unwrap();
        assert_eq!((first.from.as_str(), first.to.as_str()), ("2026-11-01", "2026-11-30"), "the 1st: the whole month");
        assert_eq!(next_period(&s, at("2026-11-04 09:00")).to, "2026-11-04", "sent today: tomorrow's covers today");
        // The hosts schedule waits for the day's collection.
        let h = ReportSchedule { enabled: true, to: vec!["a@x.org".into()], ..ReportSchedule::default_for(ReportKind::Hosts) };
        assert_eq!(due(&h, at("2026-11-04 06:05"), false), None);
        assert!(due(&h, at("2026-11-04 06:05"), true).is_some());
        // Manual: send now covers the month so far, not today.
        let m = ReportSchedule { schedule: Cadence::Manual, ..ReportSchedule::default_for(ReportKind::Hosts) };
        assert_eq!(send_now_period(&m, at("2026-11-04 10:00")).to, "2026-11-03");
        assert_eq!(send_now_period(&ReportSchedule::default(), at("2026-11-04 10:00")).to, "2026-11-04", "the volume report's manual period is as before");
    }

    #[test]
    fn each_kind_has_its_own_config_txt_keys() {
        let s = crate::settings::Settings::parse("UI_REPORT_HOSTS_TO=h@x.org\nUI_REPORT_HOSTS_AT=05:30\nUI_REPORT_INDICES_SCHEDULE=weekly\n");
        assert!(s.warnings().is_empty(), "{:?}", s.warnings());
        let f = ScheduleFile::default();
        let (h, hm) = f.hosts.effective(&s);
        assert_eq!((h.to, h.at.as_str(), hm), (vec!["h@x.org".to_string()], "05:30", vec!["to", "at"]));
        let (i, im) = f.indices.effective(&s);
        assert_eq!((i.schedule, im), (Cadence::Weekly, vec!["schedule"]));
        assert!(f.volume.effective(&s).1.is_empty(), "the volume report's keys are its own");
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;

    fn monthly(at: i64) -> ReportSchedule {
        ReportSchedule { enabled: true, to: vec!["a@b.c".into()], schedule: Cadence::Monthly, set_at: Some(at),
                         ..ReportSchedule::default_for(ReportKind::Volume) }
    }

    #[test]
    fn the_old_fields_are_read_once_and_then_the_state_file_wins() {
        // A file from before 0.3.54: one object, its state inside.
        let old = serde_json::json!({ "enabled": true, "to": ["a@b.c"], "schedule": "monthly", "lastPeriod": "2026-09-01..2026-09-30",
                                      "lastSent": { "at": 5, "to": 1, "ok": true, "error": null }, "retried": 1, "retriedPeriod": "x" });
        let settings = ScheduleFile::from_value(&old);
        let view = merge(&settings, None);
        assert_eq!(view.volume.last_period.as_deref(), Some("2026-09-01..2026-09-30"), "read from the settings while no state file exists");
        assert_eq!(view.volume.last_sent.as_ref().map(|l| l.at), Some(5));
        // Migrated: the state is written from the view; the settings lose the fields.
        let mut state = state_of(&view);
        assert_eq!(state.volume.retried, 1);
        let mut stripped = settings.clone();
        strip_state(&mut stripped);
        let text = serde_json::to_string(&stripped).unwrap();
        assert!(!text.contains("lastPeriod") && !text.contains("lastSent") && !text.contains("retried"), "{text}");
        assert_eq!(merge(&stripped, Some(&state)).volume.last_period.as_deref(), Some("2026-09-01..2026-09-30"));
        // A settings file that still has stale state fields: the state file wins.
        state.volume.last_period = Some("2026-10-01..2026-10-31".into());
        assert_eq!(merge(&settings, Some(&state)).volume.last_period.as_deref(), Some("2026-10-01..2026-10-31"));
    }

    #[test]
    fn a_save_is_taken_in_once() {
        let mut set = monthly(100);
        set.mark_passed = Some("2026-10-01..2026-10-31".into());
        set.seen_schedule = Some(Cadence::Monthly);
        set.seen_at = Some("07:00".into());
        let settings = ScheduleFile { volume: set.clone(), ..ScheduleFile::default() };
        let mut state = StateFile::default();
        state.volume.last_period = Some("2026-09-01..2026-09-30".into());
        let view = merge(&settings, Some(&state));
        assert_eq!(view.volume.last_period.as_deref(), Some("2026-10-01..2026-10-31"), "the save's decision");
        assert_eq!(view.volume.seen_schedule, Some(Cadence::Monthly));
        assert!(view.volume.mark_passed.is_none());
        // The worker sends (or gives back) after taking it in: that is not undone by the same save.
        let mut after = state_of(&view);
        assert_eq!(after.volume.applied_set_at, Some(100));
        after.volume.last_period = None;
        assert_eq!(merge(&settings, Some(&after)).volume.last_period, None, "taken in once");
        // A later save without a decision leaves the period alone.
        let later = ScheduleFile { volume: ReportSchedule { mark_passed: None, set_at: Some(200), ..set }, ..ScheduleFile::default() };
        after.volume.last_period = Some("k".into());
        assert_eq!(merge(&later, Some(&after)).volume.last_period.as_deref(), Some("k"));
    }

    #[test]
    fn a_save_made_before_the_worker_ever_ran_is_not_lost() {
        // Role core, no state file yet: the save keeps the old fields and adds its decision.
        let mut set = monthly(100);
        set.last_period = Some("2026-08-01..2026-08-31".into());
        set.mark_passed = Some("2026-10-01..2026-10-31".into());
        let view = merge(&ScheduleFile { volume: set, ..ScheduleFile::default() }, None);
        assert_eq!(view.volume.last_period.as_deref(), Some("2026-10-01..2026-10-31"));
    }
}
