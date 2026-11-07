//! One cluster's measurement: the search the run sends and the readings it takes from the
//! answer (docs/LOGDELAY.md "Measurement").
//!
//! The search is `delay_sink::search_body` with the cluster's own fields — device, arrival,
//! event time — and the extra columns (`tag1`, `fwd_tag`, `parser_tag`, `Zone`, …) asked for
//! in the newest document's `_source`, so every measurement carries them. A device whose
//! newest document has no readable arrival or event time is still a reading, with no delay:
//! "can't measure" is a fact about the device, and dropping it would make it vanish from the
//! tables as if it were fine.

use crate::delay_sink::{bucket_key, dotted, to_ms};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// The fields one cluster is measured by, resolved (`Core::logdelay_fields`): the device
/// field as aggregated (`.keyword` where it needs it), the arrival field, the event-time
/// fields in the order they are tried, the extra columns as named by people.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fields {
    pub pattern: String,
    pub device: String,
    pub arrival: String,
    pub event_time: Vec<String>,
    pub extras: Vec<String>,
}

/// What the run reads about one device from its newest document.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reading {
    pub device: String,
    pub docs: u64,
    pub arrival_ms: Option<i64>,
    pub event_ms: Option<i64>,
    /// `None` when either clock could not be read: can't measure, never 0.
    pub delay_minutes: Option<f64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extras: BTreeMap<String, String>,
}

/// The search body: `size 0`, the last `window_hours`, one terms aggregation on the device
/// field with the newest document of each.
pub fn search_body(f: &Fields, window_hours: u64, max_devices: u64) -> Value {
    let mut source: Vec<String> = vec![f.arrival.clone()];
    source.extend(f.event_time.iter().cloned());
    source.extend(f.extras.iter().map(|e| e.trim_end_matches(".keyword").to_string()));
    source.dedup();
    json!({
        "size": 0,
        "query": { "bool": { "filter": [
            { "range": { f.arrival.clone(): { "gte": format!("now-{}h", window_hours.clamp(1, 24)), "lte": "now" } } },
        ] } },
        "aggs": { "devices": {
            "terms": { "field": f.device, "size": max_devices.clamp(1, 10_000), "order": { "_count": "desc" } },
            "aggs": { "latest": { "top_hits": {
                "size": 1,
                "sort": [{ f.arrival.clone(): { "order": "desc" } }],
                "_source": source,
            } } },
        } },
    })
}

/// Every device the answer names, measured where it can be.
pub fn readings(res: &Value, f: &Fields) -> Vec<Reading> {
    let buckets = res.pointer("/aggregations/devices/buckets").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(buckets.len());
    for b in buckets {
        let Some(device) = bucket_key(&b) else { continue };
        let docs = b.get("doc_count").and_then(Value::as_u64).unwrap_or(0);
        let src = b.pointer("/latest/hits/hits/0/_source");
        let arrival = src.and_then(|s| to_ms(dotted(s, &f.arrival)));
        let event = src.and_then(|s| f.event_time.iter().find_map(|e| to_ms(dotted(s, e))));
        let delay = match (arrival, event) {
            (Some(a), Some(e)) => Some((a - e) as f64 / 60_000.0),
            _ => None,
        };
        let mut extras = BTreeMap::new();
        if let Some(s) = src {
            for e in &f.extras {
                let name = e.trim_end_matches(".keyword");
                if let Some(v) = dotted(s, name).and_then(scalar) {
                    extras.insert(name.to_string(), v);
                }
            }
        }
        out.push(Reading { device, docs, arrival_ms: arrival, event_ms: event, delay_minutes: delay, extras });
    }
    out
}

/// An extra column's value as text: a string, a number, a bool, or the first of an array of
/// those. An object is not a column.
fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Array(a) => a.iter().find_map(scalar),
        _ => None,
    }
}

/// Two decimals: the figure is a subtraction of two clocks; more would be decoration.
pub fn round2(m: f64) -> f64 {
    (m * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Fields {
        Fields {
            pattern: "logstash-*".into(), device: "src_hostname.keyword".into(), arrival: "@timestamp".into(),
            event_time: vec!["event_created".into(), "ingested_time".into()],
            extras: vec!["tag1".into(), "fwd_tag.keyword".into(), "parser_tag".into(), "Zone".into()],
        }
    }

    #[test]
    fn the_search_asks_for_the_extras_without_keyword() {
        let b = search_body(&fields(), 2, 2000);
        let src: Vec<&str> = b.pointer("/aggs/devices/aggs/latest/top_hits/_source").unwrap().as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(src, ["@timestamp", "event_created", "ingested_time", "tag1", "fwd_tag", "parser_tag", "Zone"]);
        assert_eq!(b.pointer("/query/bool/filter/0/range/@timestamp/gte").unwrap(), "now-2h");
        assert_eq!(b.pointer("/aggs/devices/terms/field").unwrap(), "src_hostname.keyword");
    }

    #[test]
    fn a_device_that_cannot_be_measured_is_a_reading_without_a_delay() {
        let res = json!({ "aggregations": { "devices": { "buckets": [
            { "key": "fw-1", "doc_count": 10, "latest": { "hits": { "hits": [ { "_source": {
                "@timestamp": "2026-11-04T12:41:00Z", "event_created": "2026-11-04T12:00:00Z",
                "tag1": "firewall", "fwd_tag": ["syslog-dc1-02"], "parser_tag": "fortigate-grok", "Zone": "dc1" } } ] } } },
            { "key": "fw-2", "doc_count": 4, "latest": { "hits": { "hits": [ { "_source": { "@timestamp": "2026-11-04T12:41:00Z", "tag1": "" } } ] } } },
            { "key": "fw-3", "doc_count": 1, "latest": { "hits": { "hits": [] } } },
        ] } } });
        let r = readings(&res, &fields());
        assert_eq!(r.len(), 3, "nobody vanishes");
        assert_eq!(r[0].delay_minutes, Some(41.0));
        assert_eq!(r[0].extras.get("fwd_tag").map(String::as_str), Some("syslog-dc1-02"), "an array's first value");
        assert_eq!(r[0].extras.get("Zone").map(String::as_str), Some("dc1"));
        assert_eq!(r[1].delay_minutes, None, "no event time: can't measure, not 0");
        assert!(r[1].extras.is_empty(), "a blank extra is not a value");
        assert!(r[1].arrival_ms.is_some());
        assert_eq!(r[2].delay_minutes, None);
        assert_eq!(r[2].docs, 1);
    }

    #[test]
    fn a_clock_ahead_stays_negative() {
        let res = json!({ "aggregations": { "devices": { "buckets": [
            { "key": "ahead", "doc_count": 2, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "2026-11-04T12:00:00Z", "ingested_time": "2026-11-04T12:37:00Z" } } ] } } },
        ] } } });
        assert_eq!(readings(&res, &fields())[0].delay_minutes, Some(-37.0));
    }
}
