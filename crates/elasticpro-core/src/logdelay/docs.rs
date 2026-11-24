//! The documents the run writes to Elasticsearch — the history store or the sink cluster —
//! and the index template they take (docs/LOGDELAY.md "Index names and fields").
//!
//! Three records, three index families under one prefix:
//!
//! | record | index | `_id` |
//! |---|---|---|
//! | measurement | `<prefix>-YYYY.MM` | `cluster\|device\|hour` (a rerun overwrites) |
//! | period | `<prefix>-episodes-YYYY` | `cluster\|device\|started` (solving overwrites the open one); a log type's: `cluster\|device\|type:<name>\|started`, `cluster\|device\|no-type\|started` |
//! | daily | `<prefix>-daily-YYYY` | `cluster\|day` (every run rewrites today) |
//!
//! On the history store `<prefix>` is `<store prefix>-delay`; on a sink cluster it is the
//! sink's `indexPrefix` (`elasticpro-log-delay`). Every document carries `record`, so a
//! search on `<prefix>-*` can tell them apart.

use super::state::{Daily, Episode, Row, RowType};
use serde_json::{json, Map, Value};

pub fn measurement_index(prefix: &str, year: i64, month: i64) -> String {
    format!("{prefix}-{year:04}.{month:02}")
}
pub fn episodes_index(prefix: &str, year: i64) -> String {
    format!("{prefix}-episodes-{year:04}")
}
pub fn daily_index(prefix: &str, year: i64) -> String {
    format!("{prefix}-daily-{year:04}")
}

fn iso(ms: i64) -> String {
    let (y, m, d) = crate::delay_sink::civil_from_days(ms.div_euclid(86_400_000));
    let rest = ms.rem_euclid(86_400_000);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3_600_000, (rest % 3_600_000) / 60_000, (rest % 60_000) / 1000, rest % 1000)
}

fn extras(m: &std::collections::BTreeMap<String, String>) -> Value {
    Value::Object(m.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect::<Map<_, _>>())
}

/// One device's measurement, as written and as kept in the day file.
pub fn measurement_doc(cluster: &str, r: &Row, bucket: &str, run_ms: i64) -> Value {
    json!({
        "record": "measurement",
        "@timestamp": bucket,
        "measured_at": run_ms,
        "cluster": cluster,
        "device": r.device,
        "docs": r.docs,
        "arrival_time": r.arrival_ms,
        "event_time": r.event_ms,
        "event_field": r.event_field,
        "delay_minutes": r.delay_minutes,
        "raw_gap_minutes": r.raw_gap_minutes,
        "tz_offset_minutes": r.tz_offset_minutes,
        "device_tz_offset": r.device_tz_offset,
        "state": r.state.as_str(),
        "extras": extras(&r.extras),
        // The log type its figures are from; null: its newest document's, whatever its type.
        "log_type": r.by_type.and_then(|i| r.types.as_ref()?.get(i)).map(RowType::name),
        "late_types": r.types.as_ref().map(|v| v.iter().filter(|t| t.state.late()).map(RowType::name).collect::<Vec<_>>()),
        "types": r.types.as_ref().map(|v| v.iter().map(type_doc).collect::<Vec<_>>()),
        "types_truncated": r.types_truncated,
    })
}

/// One log type of a measurement; `no_type` marks the documents without one.
fn type_doc(t: &RowType) -> Value {
    let mut v = json!({ "log_type": t.name(), "state": t.state.as_str(), "delay_minutes": t.delay_minutes, "raw_gap_minutes": t.raw_gap_minutes, "docs": t.docs });
    if t.log_type.is_none() {
        v["no_type"] = json!(true);
    }
    v
}

pub fn measurement_id(cluster: &str, device: &str, bucket: &str) -> String {
    format!("{cluster}|{device}|{bucket}")
}

pub fn episode_doc(cluster: &str, e: &Episode, now: i64) -> Value {
    json!({
        "record": "period",
        "@timestamp": iso(e.started_ms),
        "cluster": cluster,
        "device": e.device,
        "started": e.started_ms,
        "solved": e.solved_ms,
        "lasted_minutes": (e.lasted_ms(now) as f64 / 60_000.0).round(),
        "open": e.open(),
        "ended": e.ended_ms,
        "ended_why": e.ended_why,
        "last_measured": e.last_measured_ms,
        "worst_minutes": e.worst_minutes,
        "worst_state": e.worst_state.as_str(),
        "last_minutes": e.last_minutes,
        "last_state": e.last_state.as_str(),
        "measurements": e.measurements,
        "pattern": e.pattern(),
        "extras": extras(&e.extras),
        // A log type's own period; the device's has neither.
        "log_type": e.log_type,
        "no_type": e.no_type,
    })
}

pub fn episode_id(cluster: &str, e: &Episode) -> String {
    match (&e.log_type, e.no_type) {
        (Some(t), _) => format!("{cluster}|{}|type:{t}|{}", e.device, e.started_ms),
        (None, true) => format!("{cluster}|{}|no-type|{}", e.device, e.started_ms),
        (None, false) => format!("{cluster}|{}|{}", e.device, e.started_ms),
    }
}

pub fn daily_doc(cluster: &str, cluster_name: &str, d: &Daily, written_ms: i64) -> Value {
    let mut v = serde_json::to_value(d).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.insert("record".into(), json!("daily"));
        o.insert("@timestamp".into(), json!(d.day));
        o.insert("cluster".into(), json!(cluster));
        o.insert("clusterName".into(), json!(cluster_name));
        o.insert("writtenAt".into(), json!(written_ms));
        // `started`/`solved` are instants on a period document; on a day they are counts, and
        // one template cannot map one name two ways.
        o.remove("started");
        o.remove("solved");
        o.insert("startedCount".into(), json!(d.started));
        o.insert("solvedCount".into(), json!(d.solved));
        o.insert("noDelay".into(), json!(d.no_delay()));
    }
    v
}

pub fn daily_id(cluster: &str, day: &str) -> String {
    format!("{cluster}|{day}")
}

/// One document of a bulk request, as NDJSON, added to `s`.
pub fn bulk_line(s: &mut String, index: &str, id: &str, doc: &Value) {
    use std::fmt::Write as _;
    let _ = write!(s, "{}\n{doc}\n", json!({ "index": { "_index": index, "_id": id } }));
}

/// The index template for `<prefix>-*` on the history store: every field of the three
/// records mapped, the extras as keywords by a dynamic template, nothing else (`guard.rs`
/// insists on index patterns inside the prefix and mappings only — no settings, no ILM).
/// Priority 210: above the store's general template (200), so delay indices made after an
/// upgrade take these mappings even where the general one was created before them.
pub fn template_body(prefix: &str) -> Value {
    let kw = json!({ "type": "keyword" });
    let long = json!({ "type": "long" });
    let float = json!({ "type": "float" });
    let ms = json!({ "type": "date", "format": "epoch_millis" });
    let fields: &[(&str, &Value)] = &[
        ("record", &kw), ("@timestamp", &json!({ "type": "date" })), ("cluster", &kw), ("clusterName", &kw), ("device", &kw),
        ("docs", &long), ("arrival_time", &ms), ("event_time", &ms), ("event_field", &kw), ("delay_minutes", &float), ("raw_gap_minutes", &float),
        ("tz_offset_minutes", &long), ("device_tz_offset", &long), ("state", &kw), ("measured_at", &ms),
        ("started", &ms), ("solved", &ms), ("ended", &ms), ("ended_why", &kw), ("last_measured", &ms), ("lasted_minutes", &float), ("open", &json!({ "type": "boolean" })),
        ("worst_minutes", &float), ("worst_state", &kw), ("last_minutes", &float), ("last_state", &kw), ("measurements", &long), ("pattern", &kw),
        ("day", &json!({ "type": "date", "format": "yyyy-MM-dd" })), ("devices", &long), ("onTime", &long), ("little", &long), ("delayed", &long),
        ("critical", &long), ("clockAhead", &long), ("otherTz", &long), ("silent", &long), ("unmeasured", &long), ("lateBeforeSilent", &long), ("noDelay", &long), ("startedCount", &long), ("solvedCount", &long),
        ("lateHours", &float), ("medianMinutes", &float), ("p95Minutes", &float), ("measured", &long), ("complete", &json!({ "type": "boolean" })),
        ("writtenAt", &ms), ("partDelayed", &long), ("logTypes", &json!({ "properties": { "total": long, "late": long, "above": long } })),
        ("log_type", &kw), ("no_type", &json!({ "type": "boolean" })), ("late_types", &kw), ("types_truncated", &json!({ "type": "boolean" })),
        ("types", &json!({ "properties": { "log_type": kw, "no_type": { "type": "boolean" }, "state": kw, "delay_minutes": float, "raw_gap_minutes": float, "docs": long } })),
    ];
    let properties: Map<String, Value> = fields.iter().map(|(k, v)| (k.to_string(), (*v).clone())).collect();
    json!({
        "index_patterns": [format!("{prefix}-*")],
        "priority": 210,
        "_meta": { "managedBy": "ElasticPro", "contract": "docs/LOGDELAY.md" },
        "template": { "mappings": {
            "dynamic": false,
            "dynamic_templates": [{ "extras": { "path_match": "extras.*", "mapping": { "type": "keyword", "ignore_above": 256 } } }],
            "properties": properties,
        } },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logdelay::levels::State;
    use std::collections::BTreeMap;

    #[test]
    fn ids_repeat_so_a_rerun_overwrites() {
        let mut extras = BTreeMap::new();
        extras.insert("fwd_tag".to_string(), "syslog-1".to_string());
        let e = Episode { device: "fw".into(), started_ms: 1_000, worst_minutes: 45.0, worst_state: State::Delay, last_minutes: 45.0, last_state: State::Delay, measurements: 1,
                          extras: extras.clone(), ..Episode::default() };
        assert_eq!(episode_id("prod", &e), "prod|fw|1000");
        let mut solved = e.clone();
        solved.solved_ms = Some(7_000);
        assert_eq!(episode_id("prod", &solved), episode_id("prod", &e), "solving writes over the open document");
        let d = episode_doc("prod", &solved, 99_999);
        assert_eq!(d["open"], false);
        assert_eq!(d["extras"]["fwd_tag"], "syslog-1");
        assert_eq!(d["@timestamp"], "1970-01-01T00:00:01.000Z");
        // A log type's period never overwrites its device's, nor another type's.
        let threat = Episode { log_type: Some("threat".into()), ..e.clone() };
        let none = Episode { no_type: true, ..e.clone() };
        let odd = Episode { log_type: Some("(no log type)".into()), ..e.clone() };
        assert_eq!(episode_id("prod", &threat), "prod|fw|type:threat|1000");
        assert_eq!(episode_id("prod", &none), "prod|fw|no-type|1000");
        assert_eq!(episode_id("prod", &odd), "prod|fw|type:(no log type)|1000");
        assert_eq!((episode_doc("prod", &threat, 9)["log_type"].clone(), episode_doc("prod", &none, 9)["no_type"].clone(), episode_doc("prod", &e, 9)["log_type"].clone()),
                   (json!("threat"), json!(true), Value::Null));
        assert_eq!(daily_id("prod", "2026-11-04"), "prod|2026-11-04");
        assert_eq!(measurement_id("prod", "fw", "2026-11-04T14:00:00Z"), "prod|fw|2026-11-04T14:00:00Z");
    }

    #[test]
    fn a_silent_row_carries_no_delay_and_its_state() {
        let r = Row { device: "fw".into(), arrival_ms: Some(5), state: State::Silent, ..Row::default() };
        let d = measurement_doc("prod", &r, "2026-11-04T14:00:00Z", 1);
        assert_eq!(d["delay_minutes"], Value::Null);
        assert_eq!(d["state"], "silent");
        assert_eq!(d["record"], "measurement");
        assert_eq!((d["types"].clone(), d["late_types"].clone(), d["log_type"].clone()), (Value::Null, Value::Null, Value::Null), "not read by log types: not none");
    }

    #[test]
    fn a_rows_log_types_are_written_with_it() {
        let t = |n: Option<&str>, m: f64, s: State| RowType { log_type: n.map(String::from), delay_minutes: Some(m), docs: 3, state: s, ..RowType::default() };
        let r = Row { device: "fw".into(), state: State::PartDelay, delay_minutes: Some(46.0), by_type: Some(1),
                      types: Some(vec![t(Some("traffic"), 1.0, State::NoDelay), t(Some("threat"), 46.0, State::Delay), t(None, 2.0, State::NoDelay)]), ..Row::default() };
        let d = measurement_doc("prod", &r, "2026-11-04T14:00:00Z", 1);
        assert_eq!((d["state"].clone(), d["log_type"].clone(), d["late_types"].clone()), (json!("part_delay"), json!("threat"), json!(["threat"])));
        assert_eq!(d["types"][2], json!({ "log_type": "(no log type)", "no_type": true, "state": "no_delay", "delay_minutes": 2.0, "raw_gap_minutes": null, "docs": 3 }));
        assert!(d["types"][1].get("no_type").is_none());
        let p = &template_body("x")["template"]["mappings"]["properties"];
        for (k, v) in [("log_type", "keyword"), ("late_types", "keyword"), ("no_type", "boolean"), ("partDelayed", "long")] {
            assert_eq!(p[k]["type"], v, "{k}");
        }
        assert_eq!((p["types"]["properties"]["log_type"]["type"].clone(), p["logTypes"]["properties"]["late"]["type"].clone()), (json!("keyword"), json!("long")));
    }

    #[test]
    fn the_template_stays_inside_what_the_guard_allows() {
        let t = template_body("elasticpro-history-delay");
        assert_eq!(t["index_patterns"], json!(["elasticpro-history-delay-*"]));
        assert_eq!(t["template"].as_object().unwrap().keys().collect::<Vec<_>>(), vec!["mappings"]);
        assert_eq!(t["priority"], 210);
        assert!(crate::guard::history_guard(crate::guard::Writes::HistoryWrite, "elasticpro-history",
            "PUT", "/_index_template/elasticpro-history-delay-template?create=true", Some(&t.to_string())).is_none());
        let mut b = String::new();
        bulk_line(&mut b, &measurement_index("elasticpro-history-delay", 2026, 11), "prod|fw|x", &json!({ "a": 1 }));
        assert_eq!(b.lines().count(), 2);
        assert!(crate::guard::history_guard(crate::guard::Writes::HistoryWrite, "elasticpro-history", "POST", "/_bulk", Some(&b)).is_none());
        assert_eq!(episodes_index("p", 2026), "p-episodes-2026");
        assert_eq!(daily_index("p", 2026), "p-daily-2026");
    }
}
