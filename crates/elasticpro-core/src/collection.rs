//! Per-cluster collection switches (Config › Clusters › Edit cluster › Collection, docs/JOBS.md
//! "Per-cluster switches"): what ElasticPro may ask one cluster for, and when its heavy jobs
//! may run.
//!
//! Kept with the cluster's own config — the config file's `collection:` on a config-file
//! cluster, the overlay's `collection` field on a cluster from Zabbix — and carried to the core
//! in its `ClusterSpec`, so every reader (the poller, the jobs, the worker reading primed.json)
//! decides from one value:
//!
//! ```json
//! "collection": { "ilm": false, "snapshots": false, "logDelay": false, "hosts": false,
//!                 "heavyHours": { "from": 22, "to": 6 } }
//! ```
//!
//! * A switch absent (or `true`) is on: only what is switched off is written. A switched-off
//!   dataset or job never asks the cluster anything; Jobs says "skipped — switched off for this
//!   cluster (Edit cluster › Collection)", never a failure.
//! * `heavyHours` is a **hard rule**: the heavy jobs (`HEAVY_JOBS`: the daily volume collection
//!   with its backfill, and the hosts collection) send nothing to the cluster outside it, by the
//!   timer or by a person's *Run now*. Whole hours of the server's time zone (the stack's `TZ`);
//!   `from` is the first hour in, `to` the first hour out, so `22–06` runs from 22:00 to 05:59
//!   and a window may cross midnight. The scheduled log delay measurement is not a heavy job: it
//!   keeps its interval.
//!
//! Pure: no clock, no I/O.

use chrono::{Duration, NaiveDateTime, NaiveTime, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Where a person turns a switch back on: every message that names a switched-off thing says so.
pub const WHERE: &str = "Edit cluster › Collection";

/// The jobs `heavyHours` holds (docs/JOBS.md "Per-cluster switches").
pub const HEAVY_JOBS: [&str; 2] = [crate::jobs::VOLUME_DAILY, crate::jobs::HOSTS_COLLECT];

/// What can be switched off for one cluster.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Switch {
    /// The ILM checks: the poller's `ilm_errors` and `ilm_assign`.
    Ilm,
    /// Snapshots: the poller's `snapshots`, `snapshots_full` and `snapshot_status`.
    Snapshots,
    /// The log delay measurement (scheduled and *Fetch now*).
    LogDelay,
    /// The hosts collection (volume by host).
    Hosts,
}

impl Switch {
    pub const ALL: [Switch; 4] = [Switch::Ilm, Switch::Snapshots, Switch::LogDelay, Switch::Hosts];

    /// The key in the config.
    pub fn key(self) -> &'static str {
        match self {
            Switch::Ilm => "ilm",
            Switch::Snapshots => "snapshots",
            Switch::LogDelay => "logDelay",
            Switch::Hosts => "hosts",
        }
    }

    /// What it is called on the form and in messages.
    pub fn label(self) -> &'static str {
        match self {
            Switch::Ilm => "ILM checks",
            Switch::Snapshots => "Snapshots",
            Switch::LogDelay => "Log delay",
            Switch::Hosts => "Hosts collection",
        }
    }

    /// The words inside a sentence: "ILM checks", "snapshots", "log delay", "hosts collection".
    pub fn words(self) -> &'static str {
        match self {
            Switch::Ilm => "ILM checks",
            Switch::Snapshots => "snapshots",
            Switch::LogDelay => "log delay",
            Switch::Hosts => "hosts collection",
        }
    }

    /// The poller datasets the switch holds back.
    pub fn datasets(self) -> &'static [crate::fleet::catalogue::Dataset] {
        use crate::fleet::catalogue::Dataset;
        match self {
            Switch::Ilm => &[Dataset::IlmErrors, Dataset::IlmAssign],
            Switch::Snapshots => &[Dataset::Snapshots, Dataset::SnapshotsFull, Dataset::SnapshotStatus],
            Switch::LogDelay | Switch::Hosts => &[],
        }
    }
}

/// The words every skipped part, refusal and note uses for a switched-off thing — one sentence,
/// so the Jobs page, the run details and the pages say the same. `is_off_text` recognises it.
pub fn off_text(s: Switch) -> String {
    format!("skipped — {} switched off for this cluster ({WHERE})", s.words())
}

/// Whether a message is one of `off_text`'s (the run details give it its own retry and fix).
pub fn is_off_text(text: &str) -> bool {
    text.contains("switched off for this cluster")
}

/// The hours the heavy jobs may run in, server local time. `from == to` is refused (it would
/// mean all day or never; leave the window out for all day).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hours {
    pub from: u8,
    pub to: u8,
}

impl Hours {
    pub fn new(from: u8, to: u8) -> Option<Hours> {
        (from < 24 && to < 24 && from != to).then_some(Hours { from, to })
    }

    /// Whether `hour` (0–23) is inside: `[from, to)`, across midnight when `to < from`.
    pub fn contains(&self, hour: u32) -> bool {
        let (f, t) = (self.from as u32, self.to as u32);
        if f < t { hour >= f && hour < t } else { hour >= f || hour < t }
    }

    /// Whether the local time is inside.
    pub fn open_at(&self, local: NaiveDateTime) -> bool {
        self.contains(local.hour())
    }

    /// The next moment the window opens at or after `local`: `local` itself when it is open now,
    /// else the coming `from:00`.
    pub fn next_open(&self, local: NaiveDateTime) -> NaiveDateTime {
        if self.open_at(local) {
            return local;
        }
        let at = local.date().and_time(NaiveTime::from_hms_opt(self.from as u32, 0, 0).unwrap_or_default());
        if at > local { at } else { at + Duration::days(1) }
    }

    /// "22:00–06:00".
    pub fn text(&self) -> String {
        format!("{:02}:00–{:02}:00", self.from, self.to)
    }
}

/// One cluster's switches. `Default` is everything on, all day.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ilm: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshots: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_delay: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosts: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heavy_hours: Option<Hours>,
}

impl Collection {
    /// Everything on, all day: what a cluster without the key has. `ClusterSpec` leaves it out then.
    pub fn is_default(&self) -> bool {
        Switch::ALL.iter().all(|s| self.on(*s)) && self.heavy_hours.is_none()
    }

    pub fn on(&self, s: Switch) -> bool {
        let v = match s {
            Switch::Ilm => self.ilm,
            Switch::Snapshots => self.snapshots,
            Switch::LogDelay => self.log_delay,
            Switch::Hosts => self.hosts,
        };
        v != Some(false)
    }

    /// The datasets the poller must never fetch for this cluster.
    pub fn off_datasets(&self) -> Vec<crate::fleet::catalogue::Dataset> {
        Switch::ALL.iter().filter(|s| !self.on(**s)).flat_map(|s| s.datasets().iter().copied()).collect()
    }

    /// Whether a heavy job may send the cluster anything at this local time.
    pub fn heavy_open(&self, local: NaiveDateTime) -> bool {
        self.heavy_hours.is_none_or(|h| h.open_at(local))
    }

    /// Why a heavy job waits now — "heavy jobs only 22:00–06:00 for this cluster (Edit cluster ›
    /// Collection)" — or `None` while the window is open (or there is none).
    pub fn heavy_closed_why(&self, local: NaiveDateTime) -> Option<String> {
        let h = self.heavy_hours.filter(|h| !h.open_at(local))?;
        Some(format!("heavy jobs only {} for this cluster ({WHERE})", h.text()))
    }

    /// The cluster's switches from a config entry's `collection` (or the overlay's value). What
    /// cannot be read is everything on — the save refused it already (`check`), so only a file
    /// edited by hand gets here, and the safe reading of a typo is "as before".
    pub fn from_value(v: Option<&Value>) -> Collection {
        v.and_then(|v| check(v).ok()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    }
}

/// A `collection` value as it is kept, or why it is refused: only the keys above, each switch a
/// boolean (a `true` is dropped — on is the default), `heavyHours` `{from, to}` whole hours
/// 0–23 that differ, or null to leave it out. An empty result is `{}`.
pub fn check(v: &Value) -> Result<Value, String> {
    let m = match v {
        Value::Null => return Ok(json!({})),
        Value::Object(m) => m,
        _ => return Err("collection: an object of switches".into()),
    };
    let mut out = serde_json::Map::new();
    for (k, x) in m {
        if let Some(s) = Switch::ALL.iter().find(|s| s.key() == k.as_str()) {
            match x {
                Value::Bool(false) => {
                    out.insert(s.key().into(), json!(false));
                }
                Value::Bool(true) | Value::Null => {}
                _ => return Err(format!("collection.{k}: true or false")),
            }
        } else if k == "heavyHours" {
            if x.is_null() {
                continue;
            }
            let hour = |name: &str| x.get(name).and_then(Value::as_u64).filter(|h| *h < 24).map(|h| h as u8);
            let (Some(from), Some(to)) = (hour("from"), hour("to")) else {
                return Err("collection.heavyHours: {from, to}, whole hours 0–23".into());
            };
            if from == to {
                return Err("collection.heavyHours: from and to must differ (leave the hours out for all day)".into());
            }
            out.insert("heavyHours".into(), json!({ "from": from, "to": to }));
        } else {
            return Err(format!("collection.{k}: not a switch (ilm, snapshots, logDelay, hosts, heavyHours)"));
        }
    }
    Ok(Value::Object(out))
}

/// The quietest hour a heavy job may move to (docs/JOBS.md "Quiet hours"): the hour with the
/// lowest score among `scores` (one per hour of the day, `None` = not known) that the window
/// allows. `None` when no allowed hour is known.
pub fn quietest_allowed(scores: &[Option<f64>; 24], hours: Option<Hours>) -> Option<u32> {
    (0..24u32)
        .filter(|h| hours.is_none_or(|w| w.contains(*h)))
        .filter_map(|h| scores[h as usize].map(|s| (h, s)))
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)))
        .map(|(h, _)| h)
}

/// The next start of `hour` strictly after `local` (today's when it is still to come, else
/// tomorrow's).
pub fn next_hour_start(local: NaiveDateTime, hour: u32) -> NaiveDateTime {
    let at = local.date().and_time(NaiveTime::from_hms_opt(hour.min(23), 0, 0).unwrap_or_default());
    if at > local { at } else { at + Duration::days(1) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 21).unwrap().and_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn a_window_across_midnight_holds_the_night_and_not_the_day() {
        let w = Hours::new(22, 6).unwrap();
        for h in [22, 23, 0, 3, 5] {
            assert!(w.contains(h), "{h} is inside 22–06");
        }
        for h in [6, 7, 12, 21] {
            assert!(!w.contains(h), "{h} is outside 22–06");
        }
        assert_eq!(w.next_open(at(6, 0)), at(22, 0));
        assert_eq!(w.next_open(at(23, 15)), at(23, 15), "open now: now");
        assert_eq!(w.text(), "22:00–06:00");
        let day = Hours::new(1, 4).unwrap();
        assert!(day.contains(1) && day.contains(3) && !day.contains(4) && !day.contains(0));
        assert_eq!(day.next_open(at(5, 0)), at(1, 0) + Duration::days(1), "past today's: tomorrow's");
        assert!(Hours::new(3, 3).is_none() && Hours::new(24, 1).is_none());
    }

    #[test]
    fn only_what_is_switched_off_is_kept_and_a_bad_value_is_refused() {
        let v = check(&json!({ "ilm": false, "snapshots": true, "hosts": null, "heavyHours": { "from": 22, "to": 6 } })).unwrap();
        assert_eq!(v, json!({ "ilm": false, "heavyHours": { "from": 22, "to": 6 } }));
        assert_eq!(check(&Value::Null).unwrap(), json!({}));
        assert!(check(&json!({ "ilm": "no" })).is_err());
        assert!(check(&json!({ "everything": false })).is_err());
        assert!(check(&json!({ "heavyHours": { "from": 5, "to": 5 } })).is_err());
        assert!(check(&json!({ "heavyHours": { "from": 25, "to": 5 } })).is_err());
        let c = Collection::from_value(Some(&v));
        assert!(!c.on(Switch::Ilm) && c.on(Switch::Snapshots) && c.on(Switch::LogDelay) && c.on(Switch::Hosts));
        assert_eq!(c.off_datasets().len(), 2);
        assert!(!c.is_default() && Collection::default().is_default());
        assert_eq!(Collection::from_value(Some(&json!({ "ilm": 3 }))), Collection::default(), "unreadable: as before");
        // It round-trips through ClusterSpec's serde unchanged.
        let back: Value = serde_json::to_value(&c).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn the_heavy_window_is_a_hard_rule_with_its_reason() {
        let c = Collection { heavy_hours: Hours::new(22, 6), ..Default::default() };
        assert!(c.heavy_open(at(2, 0)) && !c.heavy_open(at(9, 0)));
        assert_eq!(c.heavy_closed_why(at(9, 0)).as_deref(), Some("heavy jobs only 22:00–06:00 for this cluster (Edit cluster › Collection)"));
        assert_eq!(c.heavy_closed_why(at(23, 0)), None);
        assert!(Collection::default().heavy_open(at(9, 0)));
        assert!(off_text(Switch::Hosts).contains("hosts collection switched off for this cluster (Edit cluster › Collection)"));
        assert!(is_off_text(&off_text(Switch::LogDelay)));
    }

    #[test]
    fn the_quietest_hour_is_taken_inside_the_window_only() {
        let mut s = [None; 24];
        s[3] = Some(100.0);
        s[14] = Some(50.0);
        s[23] = Some(200.0);
        assert_eq!(quietest_allowed(&s, None), Some(14));
        assert_eq!(quietest_allowed(&s, Hours::new(22, 6)), Some(3), "14:00 is quieter but outside the hours");
        assert_eq!(quietest_allowed(&[None; 24], None), None, "unknown: none");
        assert_eq!(next_hour_start(at(4, 0), 3), at(3, 0) + Duration::days(1));
        assert_eq!(next_hour_start(at(2, 59), 3), at(3, 0));
    }
}
