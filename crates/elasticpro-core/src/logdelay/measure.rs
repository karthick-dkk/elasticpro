//! One cluster's measurement: the search the run sends and the readings it takes from the
//! answer (docs/LOGDELAY.md "Measurement").
//!
//! The search is a composite aggregation over the cluster's device field, read page by page
//! (`page_body`, `logdelay::collect`), with the arrival, every event-time candidate and the
//! extra columns (`tag1`, `fwd_tag`, `parser_tag`, `Zone`, …) asked for
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

/// Devices one composite page asks for at first, and the least a page halves to when its
/// answer is larger than the memory budget lets one page be (`memory::report_page_bytes`).
pub const PAGE_SIZE: usize = 1000;
pub const PAGE_SIZE_MIN: usize = 100;
/// The most devices one cluster's run reads (`SinkConfig::max_devices`, *Max devices per run*).
/// The pages are read one at a time and each is dropped once its readings are taken, so the
/// run holds the readings (a few hundred bytes a device), never the answers.
pub const MAX_DEVICES_PER_RUN: u64 = 100_000;

fn source_fields(f: &Fields) -> Vec<String> {
    let mut source: Vec<String> = vec![f.arrival.clone()];
    source.extend(f.event_time.iter().cloned());
    source.extend(f.extras.iter().map(|e| e.trim_end_matches(".keyword").to_string()));
    let mut seen = std::collections::HashSet::new();
    source.retain(|s| seen.insert(s.clone()));
    source
}

/// The time window and, for a run scoped to one device, that device: the filter every page
/// of a run shares. The window is absolute (epoch ms, fixed when the run starts), so the
/// pages of one run read the same documents however long the run takes.
fn window_query(f: &Fields, from_ms: i64, to_ms: i64, device: Option<&str>) -> Value {
    let mut filter = vec![json!({ "range": { f.arrival.clone(): { "gte": from_ms, "lte": to_ms, "format": "epoch_millis" } } })];
    if let Some(d) = device {
        filter.push(json!({ "term": { f.device.clone(): d } }));
    }
    json!({ "bool": { "filter": filter } })
}

/// One page of a run: a composite aggregation over the device field (`after` = the previous
/// page's `after_key`), the newest document of each device with the arrival, every event-time
/// candidate and the extra columns. The first page also counts the documents in the window
/// that carry no device name at all (`no_device`): they are in no bucket, so they are said,
/// not dropped silently.
pub fn page_body(f: &Fields, from_ms: i64, to_ms: i64, size: usize, after: Option<&Value>, device: Option<&str>) -> Value {
    let mut comp = json!({ "size": size.clamp(1, PAGE_SIZE), "sources": [ { "d": { "terms": { "field": f.device } } } ] });
    if let Some(a) = after {
        comp["after"] = a.clone();
    }
    let mut aggs = json!({ "devices": {
        "composite": comp,
        "aggs": { "latest": { "top_hits": {
            "size": 1,
            "sort": [{ f.arrival.clone(): { "order": "desc" } }],
            "_source": source_fields(f),
        } } },
    } });
    if after.is_none() {
        aggs["no_device"] = json!({ "missing": { "field": f.device } });
    }
    json!({ "size": 0, "track_total_hits": false, "query": window_query(f, from_ms, to_ms, device), "aggs": aggs })
}

/// One page as read.
#[derive(Debug, Default)]
pub struct Page {
    pub readings: Vec<Reading>,
    pub after: Option<Value>,
    /// The last page: fewer buckets than asked for, or no `after_key`.
    pub done: bool,
    /// Documents in the window without a device name (first page only).
    pub no_device: Option<u64>,
}

/// Why a page could not be read: worth asking again (shards failed, timed out), or an
/// answer that is not a device aggregation at all (asking again gets the same).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PageError {
    Retry(String),
    Shape(String),
}

/// Read one page's answer. Shards that failed or a time-out are an error, not a short page:
/// a short page would be taken for the end, and the devices after it would turn silent.
pub fn read_page(res: &Value, f: &Fields, size: usize) -> Result<Page, PageError> {
    if let Some(p) = crate::volume::collect::partial_answer(res) {
        return Err(PageError::Retry(p.split(':').next().unwrap_or("a partial answer").to_string()));
    }
    let agg = res.pointer("/aggregations/devices").filter(|v| v.is_object())
        .ok_or_else(|| PageError::Shape("the answer has no device aggregation".into()))?;
    let n = agg.get("buckets").and_then(Value::as_array).map(Vec::len)
        .ok_or_else(|| PageError::Shape("the device aggregation has no buckets".into()))?;
    let after = agg.get("after_key").filter(|v| v.is_object()).cloned();
    Ok(Page {
        readings: readings(res, f),
        done: n < size || after.is_none(),
        after,
        no_device: res.pointer("/aggregations/no_device/doc_count").and_then(Value::as_u64),
    })
}

/// The next page's size: halved (down to `PAGE_SIZE_MIN`) when this page's answer was larger
/// than one page may be.
pub fn next_page_size(current: usize, body_bytes: u64, allowance: usize) -> usize {
    if body_bytes > allowance as u64 { (current / 2).max(PAGE_SIZE_MIN) } else { current }
}

/// Every device the answer names, measured where it can be. Reads a composite page (`key`
/// `{d: …}`) and a terms answer (`key` a string) alike.
pub fn readings(res: &Value, f: &Fields) -> Vec<Reading> {
    let Some(buckets) = res.pointer("/aggregations/devices/buckets").and_then(Value::as_array) else { return vec![] };
    let mut out = Vec::with_capacity(buckets.len());
    for b in buckets {
        let Some(device) = bucket_key(b).or_else(|| b.get("key").and_then(|k| k.get("d")).and_then(|k| bucket_key(&json!({ "key": k })))) else { continue };
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
        let b = page_body(&fields(), 1_000, 2_000, 1000, None, None);
        let src: Vec<&str> = b.pointer("/aggs/devices/aggs/latest/top_hits/_source").unwrap().as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(src, ["@timestamp", "event_created", "ingested_time", "tag1", "fwd_tag", "parser_tag", "Zone"]);
        assert_eq!(b.pointer("/query/bool/filter/0/range/@timestamp/gte").unwrap(), 1_000);
        assert_eq!(b.pointer("/query/bool/filter/0/range/@timestamp/format").unwrap(), "epoch_millis");
        assert_eq!(b.pointer("/aggs/devices/composite/sources/0/d/terms/field").unwrap(), "src_hostname.keyword");
        assert_eq!(b.pointer("/aggs/devices/composite/size").unwrap(), 1000);
        assert!(b.pointer("/aggs/no_device/missing").is_some(), "the first page counts documents without a device");
        assert!(b.pointer("/aggs/devices/terms").is_none(), "no terms size cap: composite pages");
    }

    #[test]
    fn pages_follow_the_after_key_and_end_on_a_short_page() {
        let after = json!({ "d": "fw-1000" });
        let b = page_body(&fields(), 1, 2, 500, Some(&after), Some("fw-7"));
        assert_eq!(b.pointer("/aggs/devices/composite/after").unwrap(), &after);
        assert!(b.pointer("/aggs/no_device").is_none(), "counted once, on the first page");
        assert_eq!(b.pointer("/query/bool/filter/1/term/src_hostname.keyword").unwrap(), "fw-7", "a run scoped to one device");
        let full = json!({ "aggregations": { "devices": { "after_key": { "d": "b" }, "buckets": [
            { "key": { "d": "a" }, "doc_count": 3, "latest": { "hits": { "hits": [ { "_source": { "@timestamp": "2026-11-04T12:41:00Z", "ingested_time": "2026-11-04T12:40:00Z" } } ] } } },
            { "key": { "d": "b" }, "doc_count": 1, "latest": { "hits": { "hits": [] } } },
        ] }, "no_device": { "doc_count": 7 } } });
        let p = read_page(&full, &fields(), 2).unwrap();
        assert_eq!((p.readings.len(), p.done, p.no_device), (2, false, Some(7)), "a full page with an after_key: more to come");
        assert_eq!(p.readings[0].device, "a");
        assert_eq!(p.readings[0].delay_minutes, Some(1.0));
        assert_eq!(p.after, Some(json!({ "d": "b" })));
        assert!(read_page(&full, &fields(), 3).unwrap().done, "fewer buckets than asked: the last page");
        let partial = json!({ "_shards": { "total": 3, "failed": 1 }, "aggregations": { "devices": { "buckets": [] } } });
        assert!(matches!(read_page(&partial, &fields(), 10), Err(PageError::Retry(_))), "a failed shard is not the end of the list");
        assert!(matches!(read_page(&json!({ "hits": {} }), &fields(), 10), Err(PageError::Shape(_))));
        assert_eq!(next_page_size(1000, 10, 100), 1000);
        assert_eq!(next_page_size(1000, 101, 100), 500);
        assert_eq!(next_page_size(PAGE_SIZE_MIN, 101, 100), PAGE_SIZE_MIN);
    }

    #[test]
    fn an_epoch_number_and_a_later_candidate_are_both_read() {
        let res = json!({ "aggregations": { "devices": { "buckets": [
            { "key": { "d": "n" }, "doc_count": 1, "latest": { "hits": { "hits": [ { "_source": { "@timestamp": 1_762_250_400_000i64, "ingested_time": 1_762_248_600_000i64 } } ] } } },
        ] } } });
        assert_eq!(readings(&res, &fields())[0].delay_minutes, Some(30.0), "the second candidate when the first is absent; epoch ms read as ms");
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
    fn a_nested_event_field_is_found_either_way() {
        let f = Fields { event_time: vec!["event.created".into()], ..fields() };
        let nested = json!({ "aggregations": { "devices": { "buckets": [ { "key": { "d": "n" }, "doc_count": 1, "latest": { "hits": { "hits": [
            { "_source": { "@timestamp": "2026-09-19T12:30:00Z", "event": { "created": "2026-09-19T12:00:00Z" } } } ] } } } ] } } });
        let flat = json!({ "aggregations": { "devices": { "buckets": [ { "key": { "d": "f" }, "doc_count": 1, "latest": { "hits": { "hits": [
            { "_source": { "@timestamp": "2026-09-19T12:30:00Z", "event.created": "2026-09-19T12:00:00Z" } } ] } } } ] } } });
        assert_eq!(readings(&nested, &f)[0].delay_minutes, Some(30.0));
        assert_eq!(readings(&flat, &f)[0].delay_minutes, Some(30.0));
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
