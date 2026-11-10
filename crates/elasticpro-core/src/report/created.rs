//! Report schedules a person created (`JOB_CREATE`, docs/JOBS.md "Create a job"): several per
//! report kind, each with its own name, clusters, cadence, time and recipients, and its own
//! job in the registry (`report.schedule.<id>`). The built-in schedule of each kind
//! (`report-schedule.json`, `UI_REPORT_*` in config.txt) is untouched by them: a key set in
//! config.txt still locks the built-in one, and only it.
//!
//! Two files, one writer each, as the built-in schedules (docs/WORKER.md): the settings,
//! `report-schedules-created.json`, written by the core; the state (the last period, the last
//! send), `report-schedules-created-state.json`, by the process that runs the reports.
//!
//! Pure apart from the file names. Nothing here sends a cluster anything.

use super::jobs::ReportKind;
use super::schedule::{self as rsched, Cadence, PeriodChoice, ReportSchedule, ScheduleState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const FILE: &str = "report-schedules-created.json";
pub const STATE_FILE: &str = "report-schedules-created-state.json";
/// Created schedules kept at most (all kinds together).
pub const MAX: usize = 50;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    /// 12 hex; the job id is `report.schedule.<id>`.
    pub id: String,
    pub name: String,
    pub report: ReportKind,
    pub created_by: String,
    pub created_at: i64,
    /// Its settings, as a built-in schedule's (the state fields are in the state file).
    pub schedule: ReportSchedule,
}

impl Created {
    pub fn job_id(&self) -> String {
        format!("{}{}", crate::jobs::CREATED_PREFIX, self.id)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CreatedFile {
    pub version: u32,
    pub schedules: Vec<Created>,
}

impl CreatedFile {
    /// Each entry's `schedule.kind` is its report (not kept inside the entry).
    pub fn normalised(mut self) -> CreatedFile {
        for c in &mut self.schedules {
            c.schedule.kind = c.report;
        }
        self
    }

    pub fn get(&self, id: &str) -> Option<&Created> {
        let id = id.strip_prefix(crate::jobs::CREATED_PREFIX).unwrap_or(id);
        self.schedules.iter().find(|c| c.id == id)
    }
}

/// The state of every created schedule, by its id.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CreatedState {
    pub states: BTreeMap<String, ScheduleState>,
}

/// A created schedule as decisions read it: its settings with its state over them.
pub fn merged(c: &Created, state: Option<&CreatedState>) -> ReportSchedule {
    rsched::overlay(&c.schedule, state.and_then(|s| s.states.get(&c.id)))
}

/// `JOB_CREATE {name, report, clusters, schedule, at, to, cc?, bcc?, period?, subject?,
/// sheets?, enabled?}`: the schedule, checked. `known` says whether a cluster id exists.
/// The log delay report's options are not taken here: a created log delay schedule uses the
/// defaults (`JOB_CREATE` refuses `options`).
pub fn parse(msg: &Value, known: impl Fn(&str) -> bool) -> Result<(String, ReportKind, ReportSchedule), String> {
    let name = msg.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("name: 1 to 80 characters of text".into());
    }
    let kind = msg.get("report").and_then(Value::as_str).and_then(ReportKind::parse)
        .ok_or("report must be volume, indices, hosts or log_delay")?;
    let mut s = ReportSchedule::default_for(kind);
    s.enabled = msg.get("enabled").map(|v| v.as_bool().ok_or("enabled must be true or false")).transpose()?.unwrap_or(true);
    s.schedule = match msg.get("schedule").and_then(Value::as_str).and_then(Cadence::parse) {
        Some(Cadence::Manual) | None => return Err("schedule must be daily, weekly or monthly".into()),
        Some(c) => c,
    };
    s.at = msg.get("at").and_then(Value::as_str).filter(|a| crate::volume::schedule::parse_hhmm(a).is_some())
        .ok_or("at must be HH:MM, 00:00 to 23:59")?.to_string();
    if let Some(p) = msg.get("period").filter(|v| !v.is_null()) {
        s.period = p.as_str().and_then(PeriodChoice::parse).ok_or("period must be cadence, yesterday or monthSoFar")?;
    }
    s.clusters = match msg.get("clusters") {
        None => return Err("clusters: \"all\" or a list of cluster ids".into()),
        Some(Value::String(a)) if a == "all" => json!("all"),
        Some(Value::Array(a)) => {
            let mut ids: Vec<String> = vec![];
            for x in a {
                let id = x.as_str().ok_or("clusters must be \"all\" or a list of cluster ids")?;
                if !known(id) {
                    return Err(format!("no cluster {id:?}"));
                }
                if !ids.iter().any(|i| i == id) {
                    ids.push(id.to_string());
                }
            }
            if ids.is_empty() {
                return Err("clusters: name at least one, or \"all\"".into());
            }
            json!(ids)
        }
        Some(_) => return Err("clusters must be \"all\" or a list of cluster ids".into()),
    };
    let list = |k: &str| -> Result<Vec<String>, String> {
        match msg.get(k) {
            None | Some(Value::Null) => Ok(vec![]),
            Some(Value::String(t)) => Ok(rsched::comma_list(t)),
            Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(|s| s.trim().to_string()).ok_or_else(|| format!("{k} must be a list of text")))
                .collect::<Result<Vec<String>, String>>().map(|v| v.into_iter().filter(|x| !x.is_empty()).collect()),
            _ => Err(format!("{k} must be a list")),
        }
    };
    s.to = list("to")?;
    s.cc = list("cc")?;
    s.bcc = list("bcc")?;
    if s.to.is_empty() {
        return Err("to: at least one recipient".into());
    }
    for (k, v) in [("to", &s.to), ("cc", &s.cc), ("bcc", &s.bcc)] {
        super::mail::check_addresses(v, k)?;
    }
    if let Some(v) = msg.get("subject").filter(|v| !v.is_null()) {
        let sub = v.as_str().filter(|x| x.chars().count() <= 200 && !x.chars().any(char::is_control)).ok_or("subject: text, at most 200 characters")?;
        if !sub.trim().is_empty() {
            s.subject = sub.trim().to_string();
        }
    }
    if msg.get("sheets").is_some_and(|v| !v.is_null()) {
        if kind != ReportKind::Volume {
            return Err("sheets: only the volume report has a choice of sheets".into());
        }
        s.sheets = rsched::check_sheets(&list("sheets")?)?;
    }
    if msg.get("options").is_some_and(|v| !v.is_null()) {
        return Err("options: a created schedule uses the log delay report's default options; set them on the built-in schedule".into());
    }
    Ok((name.to_string(), kind, s))
}

/// The schedule in words, for the registry's `schedule` field.
pub fn describe(s: &ReportSchedule) -> String {
    let c = match s.schedule {
        Cadence::Monthly => "monthly",
        Cadence::Weekly => "weekly",
        Cadence::Daily => "daily",
        Cadence::Manual => "manual",
    };
    format!("{c} at {}, server local time (created with JOB_CREATE)", s.at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_created_schedule_is_checked_whole() {
        let known = |id: &str| id == "prod" || id == "dr";
        let ok = json!({ "name": "Ops weekly", "report": "indices", "clusters": ["prod", "dr", "prod"], "schedule": "weekly",
                         "at": "06:30", "to": ["ops@example.com"] });
        let (name, kind, s) = parse(&ok, known).unwrap();
        assert_eq!((name.as_str(), kind, s.schedule, s.at.as_str(), s.clusters.clone()), ("Ops weekly", ReportKind::Indices, Cadence::Weekly, "06:30", json!(["prod", "dr"])));
        assert!(s.enabled);
        for (k, v) in [("name", json!("")), ("report", json!("x")), ("schedule", json!("manual")), ("at", json!("25:00")),
                       ("clusters", json!(["nope"])), ("to", json!([])), ("to", json!(["not an address"])), ("sheets", json!(["daily"]))] {
            let mut m = ok.clone();
            m[k] = v.clone();
            assert!(parse(&m, known).is_err(), "{k}: {v}");
        }
    }
}
