//! The log delay report (docs/LOGDELAY.md is the contract; read it first).
//!
//! ```text
//!   delay sink tick (every_hours, hosted, armed)
//!     └── per cluster: one search (measure.rs) ──▶ readings
//!           └── tracker.apply (state.rs): periods open/solve, silences, states
//!                 ├── built-in store (store.rs): tracker, day file, daily totals   always
//!                 └── documents (docs.rs) ──▶ history store | sink cluster          by destination, gated as before
//!     └── fixes.rs over every cluster's stored periods + fleet-cache facts ──▶ findings.json
//!
//!   LOGDELAY_* (this file) ──▶ summary.rs over the built-in store ──▶ the pages
//!   report kind log_delay (report.rs) ──▶ sheets, CSV, HTML + text mail, from summary.rs
//! ```
//!
//! * **One definition.** `levels.rs` decides late; the UI's `DEFAULT_THRESHOLDS`/`classify`
//!   copy in `ui/js/core/log-delay.js` is to go, replaced by `LOGDELAY_SETTINGS_GET`.
//! * **Unknown is not zero.** A silent device, an unreadable clock, a day with no totals and
//!   a cluster fact the poller has not read are each said to be unknown, never 0.
//! * **Writes are gated twice.** Nothing here adds a gate or a destination: the run writes
//!   to Elasticsearch exactly where and when `delay_sink.rs` always did (the config's
//!   `readOnly` for a sink cluster; the history store's permit and arming for the store).
//!   The built-in store is the server's own files.

pub mod docs;
pub mod fixes;
pub mod levels;
pub mod measure;
pub mod report;
pub mod state;
pub mod store;
pub mod summary;
pub mod time;

use crate::auth::{Caller, Role};
use crate::bridge::Core;
use crate::delay_sink::SinkConfig;
use crate::fleet::catalogue::Dataset;
use levels::Levels;
use measure::{Fields, Reading};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use state::{Applied, Daily, Tracker};
use std::collections::BTreeMap;
use std::sync::Arc;
use summary::{ClusterInput, Range};

/// The fields an admin sets as the default for every cluster (`logdelay.json` `fields`), each
/// optional: unset, the cluster's own `delayFields`, the clusters file's `defaults:` and the
/// shipped names apply (`auth::DelayShape`), as they always have.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldDefaults {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arrival: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub event_time: Vec<String>,
    /// The extra columns carried on each measurement. `None`: the shipped list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extras: Option<Vec<String>>,
}

/// The shipped extra columns (the boards' `tag1`, `fwd_tag`, `parser_tag`, `Zone`).
pub const EXTRAS_DEFAULT: &[&str] = &["tag1", "fwd_tag", "parser_tag", "Zone"];

/// One cluster's overrides in `logdelay.json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClusterOverride {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub levels: Option<Levels>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<FieldDefaults>,
}

/// `<data>/logdelay.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub levels: Levels,
    /// A device seen recently that sends nothing for this long is silent.
    pub silent_after_hours: u64,
    pub fields: FieldDefaults,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub clusters: BTreeMap<String, ClusterOverride>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_at: Option<i64>,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings { levels: Levels::default(), silent_after_hours: 2, fields: FieldDefaults::default(), clusters: BTreeMap::new(), set_by: None, set_at: None }
    }
}

impl Settings {
    pub fn normalised(mut self) -> Settings {
        self.levels = self.levels.normalised();
        self.silent_after_hours = self.silent_after_hours.clamp(1, 168);
        let clean = |v: &mut Vec<String>| { v.iter_mut().for_each(|s| *s = s.trim().to_string()); v.retain(|s| !s.is_empty()); };
        let clean_fields = |f: &mut FieldDefaults| {
            f.device = f.device.take().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            f.arrival = f.arrival.take().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            clean(&mut f.event_time);
            if let Some(e) = f.extras.as_mut() {
                clean(e);
                e.dedup();
                e.truncate(12);
            }
        };
        clean_fields(&mut self.fields);
        for c in self.clusters.values_mut() {
            c.levels = c.levels.map(Levels::normalised);
            if let Some(f) = c.fields.as_mut() {
                clean_fields(f);
            }
        }
        self.clusters.retain(|_, c| c.levels.is_some() || c.fields.is_some());
        self
    }

    /// The field names, checked: plain field names only (letters, digits, `.`, `_`, `-`, `@`).
    pub fn refusal(&self) -> Option<String> {
        let ok = |s: &str| !s.is_empty() && s.len() <= 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'));
        let check = |f: &FieldDefaults, who: &str| -> Option<String> {
            let mut names: Vec<&str> = f.device.iter().chain(f.arrival.iter()).chain(f.event_time.iter()).map(String::as_str).collect();
            names.extend(f.extras.iter().flatten().map(String::as_str));
            names.into_iter().find(|n| !ok(n)).map(|n| format!("{who}: {n:?} is not a field name"))
        };
        check(&self.fields, "fields").or_else(|| self.clusters.iter().find_map(|(id, c)| c.fields.as_ref().and_then(|f| check(f, &format!("clusters.{id}.fields")))))
    }

    /// The extras in force for a cluster.
    pub fn extras_for(&self, id: &str) -> Vec<String> {
        self.clusters.get(id).and_then(|c| c.fields.as_ref()).and_then(|f| f.extras.clone())
            .or_else(|| self.fields.extras.clone())
            .unwrap_or_else(|| EXTRAS_DEFAULT.iter().map(|s| s.to_string()).collect())
    }
}

/// The levels for one cluster: its `logdelay.json` entry, else the clusters file's
/// `delayThresholds` (today's override, kept), else the defaults.
pub fn levels_for(s: &Settings, id: &str, from_config: Option<&Value>) -> (Levels, &'static str) {
    if let Some(l) = s.clusters.get(id).and_then(|c| c.levels) {
        return (l, "settings");
    }
    if from_config.is_some_and(|v| v.is_object()) {
        return (s.levels.with_override(from_config), "configFile");
    }
    (s.levels, "default")
}

/// `delayThresholds` per cluster id from the clusters file, where an entry has one.
pub fn thresholds_in_config(raw: &Value) -> BTreeMap<String, Value> {
    crate::cluster_save::config_entries(raw).iter().filter_map(|e| {
        let name = e.get("name").and_then(Value::as_str)?;
        let t = e.get("delayThresholds").or_else(|| e.get("delay_thresholds")).filter(|v| v.is_object())?;
        Some((crate::cluster_save::cluster_id(name), t.clone()))
    }).collect()
}

/// The largest device list one answer carries.
pub const MAX_DEVICES: usize = 5_000;

fn bad(kind: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": kind, "message": message.into() })
}

impl Core {
    pub(crate) fn logdelay_store(&self) -> Option<store::Store> {
        self.data_dir().map(store::Store::new)
    }

    pub(crate) fn logdelay_settings(&self) -> Settings {
        let Some(d) = self.data_dir() else { return Settings::default() };
        match std::fs::read_to_string(d.join(store::SETTINGS_FILE)) {
            Ok(t) => serde_json::from_str::<Settings>(&t).map(Settings::normalised).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "log delay: logdelay.json is unreadable; using the defaults");
                Settings::default()
            }),
            Err(_) => Settings::default(),
        }
    }

    fn logdelay_write_settings(&self, s: &Settings) -> Result<(), String> {
        let d = self.data_dir().ok_or("no data directory")?;
        crate::volume::store::write_atomic(&d.join(store::SETTINGS_FILE), &serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?)
    }

    /// The fields one cluster is measured by: `auth::DelayShape` (the cluster's own, the
    /// clusters file's defaults, config.txt, the shipped names), with `logdelay.json`'s
    /// defaults and the cluster's entry laid over it.
    pub(crate) async fn logdelay_fields(&self, id: &str, s: &Settings) -> Fields {
        let shape = self.delay_shape_for(id).await;
        let own = s.clusters.get(id).and_then(|c| c.fields.clone()).unwrap_or_default();
        let pick = |a: &Option<String>, b: &Option<String>| a.clone().or_else(|| b.clone());
        let device = pick(&own.device, &s.fields.device).map(|d| crate::auth::aggregatable_name(&d)).unwrap_or(shape.device.clone());
        let arrival = pick(&own.arrival, &s.fields.arrival).unwrap_or_else(|| shape.arrivals.first().cloned().unwrap_or_else(|| "@timestamp".into()));
        let mut event_time = if !own.event_time.is_empty() { own.event_time.clone() } else { s.fields.event_time.clone() };
        if event_time.is_empty() {
            // The shape's `source` is arrival + event-time fields + metadata, sorted; the
            // event-time names are the shipped list plus the cluster's own, so take those.
            let spec = self.spec_for(id);
            event_time = spec.as_ref().and_then(|x| x.delay_fields.as_ref()).map(|f| f.event_time.clone()).unwrap_or_default();
            event_time.retain(|e| !e.trim().is_empty());
            for d in crate::auth::DELAY_EVENT_TIME_DEFAULT {
                if !event_time.iter().any(|e| e == d) {
                    event_time.push(d.to_string());
                }
            }
        }
        Fields { pattern: shape.pattern.unwrap_or_else(|| "logstash-*".into()), device, arrival, event_time, extras: s.extras_for(id) }
    }

    /// One cluster's run, after the search: the readings against the memory, the built-in
    /// store written, the documents for the destination handed back.
    pub(crate) fn logdelay_apply(&self, cluster: &str, readings: Vec<Reading>, run_ms: i64, levels: &Levels, s: &Settings)
        -> Result<(Applied, Daily, Tracker), String> {
        let st = self.logdelay_store().ok_or("no data directory")?;
        let mut t = st.read_tracker(cluster);
        let applied = t.apply(run_ms, readings, levels, (s.silent_after_hours as i64) * 3_600_000);
        st.write_tracker(cluster, &t)?;
        let day = time::local_date(run_ms);
        let key = time::local_day_key(run_ms);
        let (from, to) = time::day_bounds(day);
        let daily = state::daily(&t, &key, from, to, run_ms);
        st.put_daily(cluster, &daily, run_ms)?;
        // Yesterday's totals are written once more by the first run of a new day, so the day
        // ends complete (a period solved at 23:50 by a 00:10 run lands on the right day).
        if let Some(y) = day.pred_opt() {
            let ykey = y.format("%Y-%m-%d").to_string();
            if st.read_daily(cluster).get(&ykey).is_some_and(|d| !d.complete) {
                let (yf, yt) = time::day_bounds(y);
                st.put_daily(cluster, &state::daily(&t, &ykey, yf, yt, run_ms), run_ms)?;
            }
        }
        let (_, _, bucket) = crate::delay_sink::month_and_hour_bucket(run_ms);
        let lines: Vec<Value> = applied.rows.iter().map(|r| docs::measurement_doc(cluster, r, &bucket, run_ms)).collect();
        st.append_measurements(cluster, &key, &lines)?;
        st.prune(run_ms);
        Ok((applied, daily, t))
    }

    /// The bulk of one run's documents for a destination under `prefix`.
    pub(crate) fn logdelay_bulk(&self, cluster: &str, applied: &Applied, daily: &Daily, prefix: &str, run_ms: i64) -> String {
        let (y, m, bucket) = crate::delay_sink::month_and_hour_bucket(run_ms);
        let mut items: Vec<(String, String, Value)> = applied.rows.iter()
            .map(|r| (docs::measurement_index(prefix, y, m), docs::measurement_id(cluster, &r.device, &bucket), docs::measurement_doc(cluster, r, &bucket, run_ms)))
            .collect();
        for e in applied.opened.iter().chain(applied.continued.iter()).chain(applied.solved.iter()) {
            let (ey, _, _) = crate::delay_sink::month_and_hour_bucket(e.started_ms);
            items.push((docs::episodes_index(prefix, ey), docs::episode_id(cluster, e), docs::episode_doc(cluster, e, run_ms)));
        }
        items.push((docs::daily_index(prefix, y), docs::daily_id(cluster, &daily.day), docs::daily_doc(cluster, &self.cluster_name(cluster), daily, run_ms)));
        docs::bulk(&items)
    }

    /// What the fleet cache holds about a cluster, for the fixes. Unknown stays unknown.
    pub(crate) fn logdelay_facts(&self, id: &str, from: i64, to: i64) -> fixes::ClusterFacts {
        let st = self.fleet.state.lock();
        let body = |ds: Dataset| st.entries.get(&(id.to_string(), ds)).and_then(|e| e.data.as_ref()).map(|b| b.parse());
        let (shards, policies, nodes) = (body(Dataset::Shards), body(Dataset::Policies), body(Dataset::Nodes));
        drop(st);
        fixes::facts_from_cache(shards.as_ref(), policies.as_ref(), nodes.as_ref(), from, to)
    }

    /// The findings for some clusters over a range, from the store and the cache.
    pub(crate) fn logdelay_findings(&self, ids: &[String], r: &Range, now: i64, every_hours: u64) -> Vec<fixes::Finding> {
        let Some(st) = self.logdelay_store() else { return vec![] };
        let mut out = vec![];
        for id in ids {
            let t = st.read_tracker(id);
            if t.devices.is_empty() && t.episodes.is_empty() {
                continue;
            }
            let facts = self.logdelay_facts(id, r.from_ms, r.to_ms);
            out.extend(fixes::findings(id, &t, r.from_ms, r.to_ms.min(now), now, (every_hours.clamp(1, 24) as i64) * 3_600_000, &facts));
        }
        out
    }

    /// After a run: the last seven days' findings for every measured cluster, kept.
    pub(crate) fn logdelay_refresh_fixes(&self, now: i64, every_hours: u64) {
        let Some(st) = self.logdelay_store() else { return };
        let ids = st.clusters();
        let r = Range::last_days(now, 7);
        let findings = self.logdelay_findings(&ids, &r, now, every_hours);
        let v = json!({ "at": now, "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string(), "findings": findings });
        if let Err(e) = st.write_findings(&v) {
            tracing::warn!(error = %e, "log delay: the findings could not be kept");
        }
    }

    /// Clusters the caller sees, in id order, with their store inputs. `only` narrows them.
    async fn logdelay_inputs(&self, caller: Option<&Caller>, only: Option<&[String]>) -> Vec<ClusterInput> {
        let Some(st) = self.logdelay_store() else { return vec![] };
        let s = self.logdelay_settings();
        let in_file = self.read_config_file().await.map(|raw| thresholds_in_config(&raw)).unwrap_or_default();
        let visible = self.visible_ids(caller);
        let mut specs = self.all_specs();
        specs.sort_by(|a, b| a.id.cmp(&b.id));
        specs.into_iter()
            .filter(|c| visible.as_ref().is_none_or(|v| v.contains(&c.id)))
            .filter(|c| only.is_none_or(|o| o.iter().any(|x| x == &c.id)))
            .map(|c| ClusterInput {
                levels: levels_for(&s, &c.id, in_file.get(&c.id)).0,
                tracker: st.read_tracker(&c.id), daily: st.read_daily(&c.id),
                name: c.name.clone().unwrap_or_else(|| c.id.clone()), id: c.id,
            })
            .collect()
    }

    /// The inputs for named clusters, nobody's view narrowed: a report job's, whose clusters
    /// were checked when it was queued.
    pub(crate) async fn logdelay_inputs_for(&self, ids: &[String]) -> Vec<ClusterInput> {
        self.logdelay_inputs(None, Some(ids)).await
    }

    fn logdelay_range(msg: &Value, now: i64, default_days: i64) -> Result<Range, String> {
        let today = time::local_date(now);
        let day = |k: &str| msg.get(k).and_then(Value::as_str).map(|s| time::parse_day(s).ok_or_else(|| format!("{k} {s:?} is not a YYYY-MM-DD day")));
        let to = match day("to") { None => today, Some(d) => d? };
        let from = match day("from") {
            Some(d) => d?,
            None => {
                let n = msg.get("days").and_then(Value::as_i64).unwrap_or(default_days).clamp(1, 1200);
                to - chrono::Duration::days(n - 1)
            }
        };
        if from > to || (to - from).num_days() > 1200 {
            return Err("from must be on or before to, and the period at most 1200 days".into());
        }
        Ok(Range::days(from, to))
    }

    fn logdelay_ids(msg: &Value) -> Option<Vec<String>> {
        let list = msg.get("clusterIds").and_then(Value::as_array)?;
        let ids: Vec<String> = list.iter().filter_map(Value::as_str).map(String::from).collect();
        (!ids.is_empty()).then_some(ids)
    }

    fn logdelay_every_hours(&self) -> u64 {
        self.delay_sink_config().every_hours.clamp(1, 24)
    }

    /// Every `LOGDELAY_*` message (auth.rs: the reads a user's, on the clusters they see; the
    /// settings an admin's, and changing them not a limited admin's).
    pub(crate) async fn logdelay_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        if self.logdelay_store().is_none() {
            return bad("no_store", "no data directory: the log delay report needs ElasticPro's data directory");
        }
        let now = crate::delay_sink::now_ms();
        let every = self.logdelay_every_hours();
        match t {
            "LOGDELAY_SETTINGS_GET" => self.logdelay_settings_view(caller).await,
            "LOGDELAY_SETTINGS_SET" => {
                if caller.is_some_and(Caller::limited) {
                    return bad("forbidden", "the log delay levels and fields are fleet-wide: an admin limited to some clusters cannot change them");
                }
                if caller.is_some_and(|c| c.role < Role::Admin) {
                    return bad("forbidden", "changing the log delay settings is an administrator's");
                }
                let incoming = msg.get("settings").cloned().unwrap_or(Value::Null);
                let mut base = serde_json::to_value(self.logdelay_settings()).unwrap_or(Value::Null);
                if let (Some(b), Some(o)) = (base.as_object_mut(), incoming.as_object()) {
                    for (k, v) in o {
                        b.insert(k.clone(), v.clone());
                    }
                } else {
                    return bad("bad_request", "settings must be an object");
                }
                let mut s: Settings = match serde_json::from_value(base) {
                    Ok(s) => s,
                    Err(e) => return bad("bad_request", format!("bad log delay settings: {e}")),
                };
                s = s.normalised();
                if let Some(why) = s.refusal() {
                    return bad("bad_request", why);
                }
                for id in s.clusters.keys() {
                    if self.spec_for(id).is_none() {
                        return bad("bad_request", format!("clusters.{id}: no such cluster"));
                    }
                }
                let by = caller.map(|c| c.name.clone()).unwrap_or_else(|| "local".into());
                s.set_by = Some(by.clone());
                s.set_at = Some(now);
                if let Err(e) = self.logdelay_write_settings(&s) {
                    return bad("io_error", e);
                }
                tracing::info!(target: "audit", user = %by, "log delay settings saved");
                self.logdelay_settings_view(caller).await
            }
            "LOGDELAY_SUMMARY" => {
                let r = match Self::logdelay_range(msg, now, 30) { Ok(r) => r, Err(e) => return bad("bad_request", e) };
                let only = Self::logdelay_ids(msg);
                let inputs = self.logdelay_inputs(caller, only.as_deref()).await;
                let max = msg.get("maxDevices").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(MAX_DEVICES).clamp(1, MAX_DEVICES);
                let mut v = summary::fleet(&inputs, &r, now, every, max);
                v["ok"] = json!(true);
                v["schedule"] = self.logdelay_schedule_line();
                v
            }
            "LOGDELAY_CLUSTER" => {
                let Some(id) = msg.get("clusterId").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return bad("bad_request", "clusterId is required") };
                let r = match Self::logdelay_range(msg, now, 30) { Ok(r) => r, Err(e) => return bad("bad_request", e) };
                let inputs = self.logdelay_inputs(caller, Some(&[id.to_string()])).await;
                let Some(c) = inputs.first() else { return bad("not_found", format!("no cluster {id:?}")) };
                let s = self.logdelay_settings();
                let fields = serde_json::to_value(self.logdelay_fields(id, &s).await).unwrap_or(Value::Null);
                let mut v = summary::cluster(c, &r, now, every, &fields);
                v["ok"] = json!(true);
                v
            }
            "LOGDELAY_DEVICE" => {
                let Some(id) = msg.get("clusterId").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return bad("bad_request", "clusterId is required") };
                let Some(dev) = msg.get("device").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return bad("bad_request", "device is required") };
                let r = match Self::logdelay_range(msg, now, 30) { Ok(r) => r, Err(e) => return bad("bad_request", e) };
                let inputs = self.logdelay_inputs(caller, Some(&[id.to_string()])).await;
                let Some(c) = inputs.first() else { return bad("not_found", format!("no cluster {id:?}")) };
                let fr = Range::last_days(now, 7);
                let findings = self.logdelay_findings(&[id.to_string()], &fr, now, every);
                let mine = fixes::per_device(&findings).remove(dev);
                let Some(mut v) = summary::device(c, dev, &r, now, every, mine.as_ref()) else {
                    return bad("not_found", format!("no device {dev:?} measured on {id:?} (the store keeps 90 days; a device not seen for a week is forgotten)"));
                };
                // The "Delay by cluster" panel: every visible cluster's late devices per day.
                let all = self.logdelay_inputs(caller, None).await;
                v["clusters"] = json!(all.iter().map(|x| {
                    let t = summary::totals(x);
                    let spark = summary::sparkline(x, &r);
                    let peak = spark.iter().enumerate().filter_map(|(i, n)| n.as_u64().map(|n| (n, i))).max();
                    json!({ "id": x.id, "name": x.name, "lateNow": t.late(), "sparkline": spark, "days": r.day_keys(),
                            "peak": peak.map(|(n, _)| n), "peakDay": peak.and_then(|(_, i)| r.day_keys().get(i).cloned()) })
                }).collect::<Vec<_>>());
                // Beyond the tracker's month, the day files hold the rest of the range.
                if (now - r.from_ms) > state::RECENT_MS {
                    if let Some(st) = self.logdelay_store() {
                        let (older, truncated) = st.read_measurements(id, Some(dev), &r.from.format("%Y-%m-%d").to_string(), &r.to.format("%Y-%m-%d").to_string(), 20_000);
                        v["olderMeasurements"] = json!(older.into_iter().map(|m| json!({ "t": m["measured_at"], "m": m["delay_minutes"], "s": m["state"] })).collect::<Vec<_>>());
                        v["olderTruncated"] = json!(truncated);
                    }
                }
                v["ok"] = json!(true);
                v
            }
            "LOGDELAY_SEARCH" => {
                let r = match Self::logdelay_range(msg, now, 30) { Ok(r) => r, Err(e) => return bad("bad_request", e) };
                let only = Self::logdelay_ids(msg);
                let name = msg.get("name").and_then(Value::as_str);
                let field = msg.get("field").and_then(Value::as_str).filter(|f| !f.trim().is_empty());
                let value = msg.get("value").and_then(Value::as_str).filter(|v| !v.trim().is_empty());
                if name.is_none_or(|n| n.trim().is_empty()) && (field.is_none() || value.is_none()) {
                    return bad("bad_request", "give a device name, or a field and a value (wildcards * and ?)");
                }
                let inputs = self.logdelay_inputs(caller, only.as_deref()).await;
                let max = msg.get("max").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(500).clamp(1, MAX_DEVICES);
                let mut v = summary::search(&inputs, &r, now, name, field.zip(value), max);
                v["ok"] = json!(true);
                v
            }
            "LOGDELAY_FIXES" => {
                let r = match Self::logdelay_range(msg, now, 7) { Ok(r) => r, Err(e) => return bad("bad_request", e) };
                let only = Self::logdelay_ids(msg);
                let inputs = self.logdelay_inputs(caller, only.as_deref()).await;
                let ids: Vec<String> = inputs.iter().map(|c| c.id.clone()).collect();
                let names: BTreeMap<String, String> = inputs.iter().map(|c| (c.id.clone(), c.name.clone())).collect();
                let findings = self.logdelay_findings(&ids, &r, now, every);
                let each = fixes::per_device(&findings);
                // Each device's line, with its delay now, worst first.
                let mut rows: Vec<Value> = vec![];
                for c in &inputs {
                    for row in summary::device_rows(c, &r, now) {
                        if let Some(f) = each.get(&row.device).filter(|f| f.cluster == c.id) {
                            rows.push(json!({ "device": row.device, "cluster": c.id, "clusterName": c.name, "state": row.state, "nowMinutes": row.now_minutes,
                                              "step": f.step, "stepLabel": f.step.label(), "why": f.why, "fix": f.fix, "group": f.group }));
                        }
                    }
                }
                rows.sort_by(|a, b| b["nowMinutes"].as_f64().unwrap_or(-1.0).partial_cmp(&a["nowMinutes"].as_f64().unwrap_or(-1.0)).unwrap_or(std::cmp::Ordering::Equal));
                json!({ "ok": true, "from": r.from.format("%Y-%m-%d").to_string(), "to": r.to.format("%Y-%m-%d").to_string(), "now": now,
                        "findings": findings.iter().map(|f| { let mut v = serde_json::to_value(f).unwrap_or(Value::Null);
                            v["stepLabel"] = json!(f.step.label()); v["clusterName"] = json!(names.get(&f.cluster)); v }).collect::<Vec<_>>(),
                        "devices": rows,
                        "rules": fixes_rules() })
            }
            _ => bad("bad_message", format!("Unknown message type {t:?}")),
        }
    }

    /// The scheduled measurement as the pages state it beside the figures.
    fn logdelay_schedule_line(&self) -> Value {
        let cfg = self.delay_sink_config();
        json!({ "supported": self.edition().schedules(), "enabled": cfg.enabled, "everyHours": cfg.every_hours, "destination": cfg.destination,
                "lastRunAt": self.delay_sink_state_json().get("lastRunAt").cloned(), "state": self.delay_sink_state_json() })
    }

    async fn logdelay_settings_view(&self, caller: Option<&Caller>) -> Value {
        let s = self.logdelay_settings();
        let in_file = self.read_config_file().await.map(|raw| thresholds_in_config(&raw)).unwrap_or_default();
        let visible = self.visible_ids(caller);
        let mut specs = self.all_specs();
        specs.sort_by(|a, b| a.id.cmp(&b.id));
        let mut resolved = vec![];
        for c in specs.into_iter().filter(|c| visible.as_ref().is_none_or(|v| v.contains(&c.id))) {
            let (levels, from) = levels_for(&s, &c.id, in_file.get(&c.id));
            let fields = self.logdelay_fields(&c.id, &s).await;
            resolved.push(json!({ "id": c.id, "name": c.name.clone().unwrap_or_else(|| c.id.clone()), "levels": levels, "levelsFrom": from, "fields": fields }));
        }
        let store_bytes = self.logdelay_store().map(|st| st.size_bytes());
        let cfg: SinkConfig = self.delay_sink_config();
        json!({
            "ok": true, "supported": self.edition().schedules(),
            "settings": s, "resolved": resolved,
            "schedule": { "enabled": cfg.enabled, "everyHours": cfg.every_hours, "destination": cfg.destination, "clusters": cfg.clusters,
                          "maxDevices": cfg.max_devices, "state": self.delay_sink_state_json(), "blocked": self.delay_sink_blocked_now() },
            "builtinStore": { "keepDays": 90, "bytes": store_bytes, "dir": store::DIR },
            "extrasDefault": EXTRAS_DEFAULT,
            "uiCopy": "ui/js/core/log-delay.js DEFAULT_THRESHOLDS/thresholds()/classify(): to be removed, read `levels` here instead",
        })
    }
}

/// The rules as the Fix board lists them, for the page's "How a pattern is matched".
pub fn fixes_rules() -> Value {
    json!([
        { "pattern": "Many devices late in the same windows, across forwarders", "step": "elasticsearch", "readFrom": "delay periods + the cluster's write rejections, disk watermark, snapshot times", "recommendation": "Move the snapshot or batch job; add indexing capacity; free disk" },
        { "pattern": "Late devices share one fwd_tag or Zone; others there on time", "step": "forwarder", "readFrom": "delay periods grouped by fwd_tag and Zone", "recommendation": "Check that forwarder's queue, buffer and link" },
        { "pattern": "Late devices share one parser_tag", "step": "parser", "readFrom": "delay periods grouped by parser_tag", "recommendation": "Tune that pipeline's filters; give it its own workers" },
        { "pattern": "Delay steady at a whole hour (60, 120, 330 min…) or negative", "step": "device_clock", "readFrom": "the spread of one device's delays", "recommendation": "Fix the device's time zone and NTP" },
        { "pattern": "Silent, then a burst of old logs", "step": "device_link", "readFrom": "silences + delay at the first logs after them", "recommendation": "Check the device's connection" },
        { "pattern": "Nothing above", "step": "unknown", "readFrom": "—", "recommendation": "\"Not enough evidence\", never a guess" },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_normalise_and_refuse_odd_field_names() {
        let s = serde_json::from_value::<Settings>(json!({ "levels": { "delayFrom": 20 }, "silentAfterHours": 0,
            "fields": { "extras": [" tag1 ", "", "Zone"] }, "clusters": { "prod": {} , "b": { "levels": { "criticalOver": 90 } } } })).unwrap().normalised();
        assert_eq!(s.levels.delay_from, 20.0);
        assert_eq!(s.silent_after_hours, 1);
        assert_eq!(s.fields.extras, Some(vec!["tag1".to_string(), "Zone".to_string()]));
        assert!(!s.clusters.contains_key("prod"), "an empty override is dropped");
        assert_eq!(s.clusters["b"].levels.unwrap().critical_over, 90.0);
        assert_eq!(s.refusal(), None);
        let odd: Settings = serde_json::from_value(json!({ "fields": { "device": "src host" } })).unwrap();
        assert!(odd.refusal().unwrap().contains("src host"));
        assert_eq!(Settings::default().extras_for("x"), EXTRAS_DEFAULT.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn a_cluster_takes_its_file_override_unless_the_settings_name_one() {
        let mut s = Settings::default();
        let file = json!({ "delayMinutes": 45, "criticalMinutes": 90 });
        assert_eq!(levels_for(&s, "prod", Some(&file)), (Levels { no_delay_under: 15.0, delay_from: 45.0, critical_over: 90.0 }, "configFile"));
        assert_eq!(levels_for(&s, "prod", None), (Levels::default(), "default"));
        s.clusters.insert("prod".into(), ClusterOverride { levels: Some(Levels { no_delay_under: 5.0, delay_from: 10.0, critical_over: 20.0 }), fields: None });
        assert_eq!(levels_for(&s, "prod", Some(&file)).1, "settings");
        let raw = json!({ "clusters": [ { "name": "Client A prod", "url": "http://x", "delayThresholds": { "delayMinutes": 45 } }, { "name": "B", "url": "http://y" } ] });
        let m = thresholds_in_config(&raw);
        assert_eq!(m.len(), 1);
        assert_eq!(m[&crate::cluster_save::cluster_id("Client A prod")]["delayMinutes"], 45);
    }
}
