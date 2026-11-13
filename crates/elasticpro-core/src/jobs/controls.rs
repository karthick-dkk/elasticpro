//! The jobs' settings (docs/JOBS.md "`JOB_SETTINGS_*`"): one file, `<data>/job-runs/controls.json`,
//! written by the process that serves people (role `core` or `all`, where every `JOB_*` message
//! is handled) and read by every timer before it starts a run — the worker's included, which
//! never writes it.
//!
//! Per job: paused (by whom, since when), automatic on/off, the adaptive concurrency switch
//! (`auto`), the request limits and the priority. Overall: most jobs at once, the worker's total
//! requests, the CPU and memory thresholds, the governor's own switch, the retry policy, and the
//! core's gate limits (`ES_CONCURRENCY` and its three siblings) where config.txt does not set
//! them. The governor (`jobs::governor`) reads the limits, priority, `auto` and the thresholds.
//!
//! Pure apart from `load` / `save`. Nothing here sends a cluster anything.

use super::{descriptor, Priority};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

/// `<data>/job-runs/controls.json`.
pub const FILE: &str = "controls.json";

/// Retries of one failed run, at most, by default (`retryLimit`).
pub const RETRY_LIMIT: u32 = 3;
/// Minutes between two tries of the same work, by default (`retryWaitMinutes`).
pub const RETRY_WAIT_MINUTES: u64 = 5;
/// The most requests a job may be given (the worker's whole default total).
pub const REQUESTS_CEILING: u32 = 64;

/// One job's settings. Absent fields are the registry's defaults.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSetting {
    /// `JOB_PAUSE`: no new run starts by the timer; a run already going finishes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub paused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_at: Option<u64>,
    /// Automatic on/off: `false` and the timer never starts it (a person still may).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// The adaptive governor (PR 4) moves the job's requests between min and max.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests_min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests_max: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
}

/// The settings over every job.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Overall {
    /// Most jobs running at once [4].
    pub most_at_once: u32,
    /// The worker's total requests [16].
    pub worker_total: u32,
    /// Hold new runs above this CPU percent [85] …
    pub cpu_pct: u32,
    /// … or this memory percent [85].
    pub memory_pct: u32,
    /// Retries of one failed run [3].
    pub retry_limit: u32,
    /// Minutes between two tries [5].
    pub retry_wait_minutes: u64,
    /// The governor moves the worker's total [on]; off, the total is `worker_total`.
    pub auto: bool,
    /// The core's gate (`gate::Limits`), changed without a restart: `None` keeps what
    /// config.txt or the built-in default says. A field config.txt sets cannot be set here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub es_concurrency: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub es_per_cluster: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub es_per_jump_host: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub es_background_reserve: Option<u32>,
}

impl Default for Overall {
    fn default() -> Overall {
        Overall { most_at_once: 4, worker_total: 16, cpu_pct: 85, memory_pct: 85, retry_limit: RETRY_LIMIT, retry_wait_minutes: RETRY_WAIT_MINUTES,
                  auto: true, es_concurrency: None, es_per_cluster: None, es_per_jump_host: None, es_background_reserve: None }
    }
}

/// The most jobs at once a person may set (`overall.mostAtOnce`).
pub const MOST_AT_ONCE_MAX: u32 = 32;

/// The core's gate fields of `overall`: the message's name, the config.txt key that locks it,
/// and its range — `ES_*` in settings.rs.
pub const GATE_FIELDS: [(&str, &str, u32, u32); 4] = [
    ("esConcurrency", "ES_CONCURRENCY", 1, 1024),
    ("esPerCluster", "ES_PER_CLUSTER", 1, 1024),
    ("esPerJumpHost", "ES_PER_JUMP_HOST", 1, 1024),
    ("esBackgroundReserve", "ES_BACKGROUND_RESERVE", 0, 1023),
];

impl Overall {
    fn gate_field(&mut self, name: &str) -> Option<&mut Option<u32>> {
        match name {
            "esConcurrency" => Some(&mut self.es_concurrency),
            "esPerCluster" => Some(&mut self.es_per_cluster),
            "esPerJumpHost" => Some(&mut self.es_per_jump_host),
            "esBackgroundReserve" => Some(&mut self.es_background_reserve),
            _ => None,
        }
    }

    /// The core's gate limits with these settings over `base` (config.txt's, or the defaults),
    /// each only where `locked` says config.txt does not set it.
    pub fn gate_limits(&self, base: &crate::gate::Limits, locked: impl Fn(&str) -> bool) -> crate::gate::Limits {
        let mut l = base.clone();
        let pick = |v: Option<u32>, key: &str| v.filter(|_| !locked(key)).map(|n| n as usize);
        if let Some(n) = pick(self.es_concurrency, "ES_CONCURRENCY") {
            l.global = n;
        }
        if let Some(n) = pick(self.es_per_cluster, "ES_PER_CLUSTER") {
            l.per_cluster = n;
        }
        if let Some(n) = pick(self.es_per_jump_host, "ES_PER_JUMP_HOST") {
            l.per_jump = n;
        }
        if let Some(n) = pick(self.es_background_reserve, "ES_BACKGROUND_RESERVE") {
            l.background_reserve = n;
        }
        l.normalised()
    }
}

/// `controls.json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Controls {
    pub version: u32,
    pub jobs: BTreeMap<String, JobSetting>,
    pub overall: Overall,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_at: Option<u64>,
}

/// Why the timer does not start a job now, if it does not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Held {
    Paused { by: Option<String>, at: Option<u64> },
    Off,
}

impl Held {
    pub fn text(&self) -> String {
        match self {
            Held::Paused { by: Some(b), .. } => format!("paused by {b} (JOB_RESUME starts the timer again)"),
            Held::Paused { .. } => "paused (JOB_RESUME starts the timer again)".into(),
            Held::Off => "automatic runs are off for this job (JOB_SETTINGS_SET enabled:true)".into(),
        }
    }
}

impl Controls {
    pub fn load(path: &Path) -> Result<Controls, String> {
        Ok(crate::worker::read_json_retry::<Controls>(path)?.unwrap_or_default())
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        crate::volume::store::write_atomic(path, &body)
    }

    pub fn job(&self, id: &str) -> JobSetting {
        self.jobs.get(id).cloned().unwrap_or_default()
    }

    /// Whether the timer may start `id` now: not when it is paused or switched off.
    pub fn held(&self, id: &str) -> Option<Held> {
        let s = self.jobs.get(id)?;
        if s.paused {
            return Some(Held::Paused { by: s.paused_by.clone(), at: s.paused_at });
        }
        (s.enabled == Some(false)).then_some(Held::Off)
    }

    pub fn pause(&mut self, id: &str, by: &str, now: u64) {
        let s = self.jobs.entry(id.to_string()).or_default();
        s.paused = true;
        s.paused_by = Some(by.to_string());
        s.paused_at = Some(now);
    }

    pub fn resume(&mut self, id: &str) {
        if let Some(s) = self.jobs.get_mut(id) {
            s.paused = false;
            s.paused_by = None;
            s.paused_at = None;
        }
        self.jobs.retain(|_, s| *s != JobSetting::default());
    }

    /// A job's settings as `JOB_SETTINGS_GET` answers them: every field, defaults filled in
    /// from the registry (`registry` is `None` for a created schedule: the mailed defaults).
    pub fn job_view(&self, id: &str) -> Value {
        let s = self.job(id);
        let d = descriptor(id).copied().unwrap_or_else(super::created_descriptor_defaults);
        json!({
            "jobId": id,
            "enabled": s.enabled.unwrap_or(true), "paused": s.paused, "pausedBy": s.paused_by, "pausedAt": s.paused_at,
            "auto": s.auto.unwrap_or(true),
            "requests": { "min": s.requests_min.unwrap_or(d.requests.min), "max": s.requests_max.unwrap_or(d.requests.max) },
            "priority": s.priority.unwrap_or(d.priority),
            "defaults": { "requests": d.requests, "priority": d.priority },
        })
    }

    /// `JOB_SETTINGS_SET` with nothing locked by config.txt (the tests of the pure rules).
    pub fn apply(&mut self, msg: &Value, job_known: impl Fn(&str) -> bool) -> Result<(), String> {
        self.apply_with(msg, job_known, |_| false)
    }

    /// `JOB_SETTINGS_SET`: `{jobId, enabled?, auto?, requests?: {min?, max?}, priority?}` for
    /// one job, `{overall: {…}}` for the rest; either or both. Every field is checked before any
    /// is applied: a refusal changes nothing. `locked(key)`: config.txt sets that key, so the
    /// gate field it backs is refused (`null` puts a field back to config.txt's or the default).
    pub fn apply_with(&mut self, msg: &Value, job_known: impl Fn(&str) -> bool, locked: impl Fn(&str) -> bool) -> Result<(), String> {
        let mut next = self.clone();
        if let Some(id) = msg.get("jobId").filter(|v| !v.is_null()) {
            let id = id.as_str().filter(|i| job_known(i)).ok_or("jobId is not a job (see JOBS_LIST jobs[].id)")?;
            let d = descriptor(id).copied().unwrap_or_else(super::created_descriptor_defaults);
            let s = next.jobs.entry(id.to_string()).or_default();
            if let Some(v) = msg.get("enabled") {
                let on = v.as_bool().ok_or("enabled must be true or false")?;
                if d.kind == super::JobKind::Manual && !on {
                    return Err(format!("{id} has no automatic runs to switch off"));
                }
                s.enabled = (!on).then_some(false);
            }
            if let Some(v) = msg.get("auto") {
                s.auto = Some(v.as_bool().ok_or("auto must be true or false")?).filter(|on| !on);
            }
            if let Some(r) = msg.get("requests") {
                let n = |k: &str| -> Result<Option<u32>, String> {
                    match r.get(k) {
                        None | Some(Value::Null) => Ok(None),
                        Some(v) => v.as_u64().filter(|n| (1..=REQUESTS_CEILING as u64).contains(n)).map(|n| Some(n as u32))
                            .ok_or_else(|| format!("requests.{k} must be 1 to {REQUESTS_CEILING}")),
                    }
                };
                let (min, max) = (n("min")?, n("max")?);
                if let Some(m) = min {
                    s.requests_min = (m != d.requests.min).then_some(m);
                }
                if let Some(m) = max {
                    s.requests_max = (m != d.requests.max).then_some(m);
                }
                let (lo, hi) = (s.requests_min.unwrap_or(d.requests.min), s.requests_max.unwrap_or(d.requests.max));
                if lo > hi {
                    return Err(format!("requests.min ({lo}) is above requests.max ({hi})"));
                }
            }
            if let Some(v) = msg.get("priority") {
                let p = v.as_str().and_then(Priority::parse).ok_or("priority must be high, medium or low")?;
                s.priority = (p != d.priority).then_some(p);
            }
        }
        if let Some(o) = msg.get("overall").filter(|v| !v.is_null()) {
            let o = o.as_object().ok_or("overall must be an object")?;
            let pct = |k: &str, cur: u32| -> Result<u32, String> {
                match o.get(k) {
                    None => Ok(cur),
                    Some(v) => v.as_u64().filter(|n| (10..=100).contains(n)).map(|n| n as u32).ok_or_else(|| format!("overall.{k} must be 10 to 100")),
                }
            };
            let count = |k: &str, cur: u32, hi: u32| -> Result<u32, String> {
                match o.get(k) {
                    None => Ok(cur),
                    Some(v) => v.as_u64().filter(|n| (1..=hi as u64).contains(n)).map(|n| n as u32).ok_or_else(|| format!("overall.{k} must be 1 to {hi}")),
                }
            };
            let ov = &mut next.overall;
            ov.most_at_once = count("mostAtOnce", ov.most_at_once, MOST_AT_ONCE_MAX)?;
            ov.worker_total = count("workerTotal", ov.worker_total, 256)?;
            ov.cpu_pct = pct("cpuPct", ov.cpu_pct)?;
            ov.memory_pct = pct("memoryPct", ov.memory_pct)?;
            ov.retry_limit = match o.get("retryLimit") {
                None => ov.retry_limit,
                Some(v) => v.as_u64().filter(|n| *n <= 10).map(|n| n as u32).ok_or("overall.retryLimit must be 0 to 10")?,
            };
            ov.retry_wait_minutes = match o.get("retryWaitMinutes") {
                None => ov.retry_wait_minutes,
                Some(v) => v.as_u64().filter(|n| *n <= 24 * 60).ok_or("overall.retryWaitMinutes must be 0 to 1440")?,
            };
            if let Some(v) = o.get("auto") {
                ov.auto = v.as_bool().ok_or("overall.auto must be true or false")?;
            }
            for (name, key, lo, hi) in GATE_FIELDS {
                let Some(v) = o.get(name) else { continue };
                if locked(key) {
                    return Err(format!("overall.{name} is managed by config.txt ({key}): change it there"));
                }
                let n = match v {
                    Value::Null => None,
                    v => Some(v.as_u64().filter(|n| (lo as u64..=hi as u64).contains(n)).map(|n| n as u32)
                        .ok_or_else(|| format!("overall.{name} must be {lo} to {hi}, or null for config.txt's"))?),
                };
                if let Some(f) = ov.gate_field(name) {
                    *f = n;
                }
            }
            for k in o.keys() {
                let gate = GATE_FIELDS.iter().any(|(n, ..)| n == k);
                if !gate && !["mostAtOnce", "workerTotal", "cpuPct", "memoryPct", "retryLimit", "retryWaitMinutes", "auto"].contains(&k.as_str()) {
                    return Err(format!("overall.{k} is not a setting"));
                }
            }
        }
        next.jobs.retain(|_, s| *s != JobSetting::default());
        *self = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_to_the_registry_and_a_refusal_changes_nothing() {
        let mut c = Controls::default();
        let v = c.job_view(super::super::HOSTS_COLLECT);
        assert_eq!((v["requests"]["min"].clone(), v["requests"]["max"].clone(), v["priority"].clone()), (json!(1), json!(2), json!("medium")));
        assert_eq!((v["enabled"].clone(), v["auto"].clone(), v["paused"].clone()), (json!(true), json!(true), json!(false)));
        let known = |id: &str| descriptor(id).is_some();
        c.apply(&json!({ "jobId": "housekeeping", "requests": { "max": 3 }, "priority": "high", "enabled": false }), known).unwrap();
        assert_eq!(c.held("housekeeping"), Some(Held::Off));
        let v = c.job_view("housekeeping");
        assert_eq!((v["requests"]["max"].clone(), v["priority"].clone()), (json!(3), json!("high")));
        let before = c.clone();
        assert!(c.apply(&json!({ "jobId": "housekeeping", "requests": { "min": 5 } }), known).is_err(), "min above max");
        assert!(c.apply(&json!({ "overall": { "cpuPct": 5 } }), known).is_err());
        assert!(c.apply(&json!({ "jobId": "report.run", "enabled": false }), known).is_err(), "a manual job has no timer");
        assert!(c.apply(&json!({ "jobId": "nope" }), known).is_err());
        assert_eq!(c, before, "nothing of a refused set is kept");
        c.apply(&json!({ "overall": { "mostAtOnce": 2, "retryLimit": 1 } }), known).unwrap();
        assert_eq!((c.overall.most_at_once, c.overall.retry_limit, c.overall.worker_total), (2, 1, 16));
        // Back to the defaults is no entry at all.
        c.apply(&json!({ "jobId": "housekeeping", "requests": { "max": 1 }, "priority": "low", "enabled": true }), known).unwrap();
        assert!(!c.jobs.contains_key("housekeeping"), "{:?}", c.jobs);
    }

    #[test]
    fn the_core_gate_fields_set_what_config_txt_does_not_and_a_locked_one_is_refused() {
        let known = |id: &str| descriptor(id).is_some();
        let locked = |k: &str| k == "ES_PER_CLUSTER";
        let mut c = Controls::default();
        c.apply_with(&json!({ "overall": { "esConcurrency": 40, "esBackgroundReserve": 3, "auto": false } }), known, locked).unwrap();
        assert_eq!((c.overall.es_concurrency, c.overall.es_background_reserve, c.overall.auto), (Some(40), Some(3), false));
        let before = c.clone();
        let e = c.apply_with(&json!({ "overall": { "esConcurrency": 30, "esPerCluster": 6 } }), known, locked).unwrap_err();
        assert!(e.contains("config.txt") && e.contains("ES_PER_CLUSTER"), "{e}");
        assert_eq!(c, before, "a refusal changes nothing, the unlocked field included");
        assert!(c.apply_with(&json!({ "overall": { "esConcurrency": 0 } }), known, locked).is_err());
        assert!(c.apply_with(&json!({ "overall": { "esConcurrency": "many" } }), known, locked).is_err());
        // The limits in force: the setting over config.txt's, a locked one never.
        let base = crate::gate::Limits::default();
        let l = c.overall.gate_limits(&base, locked);
        assert_eq!((l.global, l.per_cluster, l.background_reserve), (40, base.per_cluster, 3));
        c.overall.es_per_cluster = Some(9);
        assert_eq!(c.overall.gate_limits(&base, locked).per_cluster, base.per_cluster, "config.txt wins");
        assert_eq!(c.overall.gate_limits(&base, |_| true).global, base.global, "every field locked: config.txt's limits");
        // null puts it back.
        c.apply_with(&json!({ "overall": { "esConcurrency": null } }), known, locked).unwrap();
        assert_eq!(c.overall.es_concurrency, None);
        assert!(c.apply_with(&json!({ "overall": { "mostAtOnce": 33 } }), known, locked).is_err(), "mostAtOnce is 1 to 32");
    }

    #[test]
    fn pause_and_resume() {
        let mut c = Controls::default();
        c.pause("volume.daily", "Admin", 5);
        assert_eq!(c.held("volume.daily"), Some(Held::Paused { by: Some("Admin".into()), at: Some(5) }));
        assert!(c.held("volume.daily").unwrap().text().contains("Admin"));
        c.resume("volume.daily");
        assert_eq!(c.held("volume.daily"), None);
        assert!(c.jobs.is_empty());
    }
}
