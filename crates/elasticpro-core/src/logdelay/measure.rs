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

use super::levels::LOG_TYPE_FIELD;
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
    /// The log type field as this run aggregates it (`log_type_field`); `None`: off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_type: Option<String>,
}

/// How a cluster's mapping has the log type field (docs/LOGDELAY.md "Log types").
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTypeField {
    /// `log_type`, or `log_type.keyword`.
    pub field: Option<String>,
    /// Why there is none.
    pub why: Option<String>,
}

/// `LogTypeField::why`: nothing said how the field is mapped.
pub const MAPPING_NOT_READ: &str = "mapping not read";

/// The log type field against a `_field_caps` answer, by the rule every field is resolved by
/// (`volume::collect::resolve_row`). An answer about no index says nothing.
pub fn log_type_field(fc: &Value) -> LogTypeField {
    let read = fc.get("fields").is_some_and(Value::is_object) && fc.get("indices").and_then(Value::as_array).is_none_or(|a| !a.is_empty());
    if !read {
        return LogTypeField { field: None, why: Some(MAPPING_NOT_READ.into()) };
    }
    let row = crate::volume::collect::resolve_row(fc, "logType", &[LOG_TYPE_FIELD.to_string()], false);
    match row.resolved {
        Some(f) => LogTypeField { field: Some(f), why: None },
        None => LogTypeField { field: None, why: Some(row.note.replacen(": not", " is not", 1)) },
    }
}

/// One log type of one device, from its newest document in the window.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TypeReading {
    /// `None`: documents without the field (`levels::NO_LOG_TYPE`).
    pub log_type: Option<String>,
    pub docs: u64,
    pub arrival_ms: Option<i64>,
    pub event_ms: Option<i64>,
    pub delay_minutes: Option<f64>,
    pub event_field: Option<String>,
}

/// What the run reads about one device from its newest document.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Reading {
    pub device: String,
    pub docs: u64,
    pub arrival_ms: Option<i64>,
    pub event_ms: Option<i64>,
    /// `None` when either clock could not be read: can't measure, never 0.
    pub delay_minutes: Option<f64>,
    /// Which of the event-time fields its newest document's event time was read from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_field: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extras: BTreeMap<String, String>,
    /// Its log types, the most documents first. `None`: the field is off for this run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<TypeReading>>,
    /// It has more log types than were read (`TYPES_PER_DEVICE`).
    #[serde(default)]
    pub types_truncated: bool,
}

/// Log types read per device and run, and the devices one page then asks for: with the documents
/// without a type that is 21 buckets a device, 10 500 a page (`search.max_buckets` is 65 535).
pub const TYPES_PER_DEVICE: usize = 20;
const TYPES_SHARD_SIZE: usize = 100;
pub const PAGE_SIZE_TYPES: usize = 500;

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
    source.extend(f.log_type.as_ref().map(|_| LOG_TYPE_FIELD.to_string()));
    let mut seen = std::collections::HashSet::new();
    source.retain(|s| seen.insert(s.clone()));
    source
}

/// Which devices a run reads: every device of the window (the schedule's run, *Fetch now* on
/// the whole cluster), one device, or a named list (*Fetch now* on a cluster's late devices).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum DeviceFilter {
    #[default]
    All,
    One(String),
    Some(Vec<String>),
}

impl DeviceFilter {
    /// Part of the cluster's list: a run with this says nothing about the devices it did not read.
    pub fn is_partial(&self) -> bool {
        !matches!(self, DeviceFilter::All)
    }

    pub fn one(&self) -> Option<&str> {
        match self {
            DeviceFilter::One(d) => Some(d),
            _ => None,
        }
    }
}

/// The time window and, for a narrowed run, its devices (a `term` for one, `terms` for a list):
/// the filter every page of a run shares. The window is absolute (epoch ms, fixed when the run
/// starts), so the pages of one run read the same documents however long the run takes.
fn window_query(f: &Fields, from_ms: i64, to_ms: i64, devices: &DeviceFilter) -> Value {
    let mut filter = vec![json!({ "range": { f.arrival.clone(): { "gte": from_ms, "lte": to_ms, "format": "epoch_millis" } } })];
    match devices {
        DeviceFilter::All => {}
        DeviceFilter::One(d) => filter.push(json!({ "term": { f.device.clone(): d } })),
        DeviceFilter::Some(list) => filter.push(json!({ "terms": { f.device.clone(): list } })),
    }
    json!({ "bool": { "filter": filter } })
}

/// One page of a run: a composite aggregation over the device field (`after` = the previous
/// page's `after_key`), the newest document of each device with the arrival, every event-time
/// candidate and the extra columns — and, where the cluster's mapping has a log type, the newest
/// document of each of its log types. The first page also counts the documents in the window
/// that carry no device name at all (`no_device`): they are in no bucket, so they are said,
/// not dropped silently.
pub fn page_body(f: &Fields, from_ms: i64, to_ms: i64, size: usize, after: Option<&Value>, devices: &DeviceFilter) -> Value {
    let mut comp = json!({ "size": size.clamp(1, PAGE_SIZE), "sources": [ { "d": { "terms": { "field": f.device } } } ] });
    if let Some(a) = after {
        comp["after"] = a.clone();
    }
    let latest = json!({ "latest": { "top_hits": {
        "size": 1,
        "sort": [{ f.arrival.clone(): { "order": "desc" } }],
        "_source": source_fields(f),
    } } });
    let mut each = latest.clone();
    if let Some(t) = &f.log_type {
        // In the same request: no second search per page.
        each["types"] = json!({ "terms": { "field": t, "size": TYPES_PER_DEVICE, "shard_size": TYPES_SHARD_SIZE }, "aggs": latest });
        each["no_type"] = json!({ "missing": { "field": t }, "aggs": latest });
    }
    let mut aggs = json!({ "devices": { "composite": comp, "aggs": each } });
    if after.is_none() {
        aggs["no_device"] = json!({ "missing": { "field": f.device } });
    }
    json!({ "size": 0, "track_total_hits": false, "query": window_query(f, from_ms, to_ms, devices), "aggs": aggs })
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
        let t = type_reading(b, f);
        let mut extras = BTreeMap::new();
        if let Some(s) = src {
            for e in &f.extras {
                let name = e.trim_end_matches(".keyword");
                if let Some(v) = dotted(s, name).and_then(scalar) {
                    extras.insert(name.to_string(), v);
                }
            }
        }
        let (types, types_truncated) = types_of(b, f);
        out.push(Reading { device, docs, arrival_ms: t.arrival_ms, event_ms: t.event_ms, delay_minutes: t.delay_minutes, event_field: t.event_field, extras, types, types_truncated });
    }
    out
}

/// A bucket's newest document read: its two times and the gap between them.
fn type_reading(b: &Value, f: &Fields) -> TypeReading {
    let src = b.pointer("/latest/hits/hits/0/_source");
    let arrival_ms = src.and_then(|s| to_ms(dotted(s, &f.arrival)));
    let from = src.and_then(|s| f.event_time.iter().find_map(|e| to_ms(dotted(s, e)).map(|t| (t, e.clone()))));
    let event_ms = from.as_ref().map(|(t, _)| *t);
    let delay_minutes = match (arrival_ms, event_ms) {
        (Some(a), Some(e)) => Some((a - e) as f64 / 60_000.0),
        _ => None,
    };
    TypeReading { log_type: None, docs: b.get("doc_count").and_then(Value::as_u64).unwrap_or(0), arrival_ms, event_ms, delay_minutes, event_field: from.map(|(_, e)| e) }
}

/// A device bucket's log types, and whether it has more than were read. Documents without the
/// field (or with an empty one) are the type `None`. One of those that does carry a value in its
/// source has it where the aggregated field is not (an index mapped otherwise): it is that type,
/// and the device's list is not whole.
fn types_of(b: &Value, f: &Fields) -> (Option<Vec<TypeReading>>, bool) {
    if f.log_type.is_none() {
        return (None, false);
    }
    let mut out: Vec<TypeReading> = vec![];
    let mut add = |t: TypeReading| match out.iter_mut().find(|x| x.log_type == t.log_type) {
        None => out.push(t),
        Some(x) => {
            let docs = x.docs + t.docs;
            if t.arrival_ms > x.arrival_ms {
                *x = t;
            }
            x.docs = docs;
        }
    };
    let mut truncated = b.pointer("/types/sum_other_doc_count").and_then(Value::as_u64).unwrap_or(0) > 0;
    for tb in b.pointer("/types/buckets").and_then(Value::as_array).into_iter().flatten() {
        add(TypeReading { log_type: bucket_key(tb).filter(|k| !k.trim().is_empty()), ..type_reading(tb, f) });
    }
    if let Some(nb) = b.get("no_type").filter(|n| n.get("doc_count").and_then(Value::as_u64).unwrap_or(0) > 0) {
        let named = nb.pointer("/latest/hits/hits/0/_source").and_then(|s| dotted(s, LOG_TYPE_FIELD)).and_then(scalar);
        truncated |= named.is_some();
        add(TypeReading { log_type: named, ..type_reading(nb, f) });
    }
    (Some(out), truncated)
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
            log_type: None,
        }
    }

    #[test]
    fn the_search_asks_for_the_extras_without_keyword() {
        let b = page_body(&fields(), 1_000, 2_000, 1000, None, &DeviceFilter::All);
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
        let b = page_body(&fields(), 1, 2, 500, Some(&after), &DeviceFilter::One("fw-7".into()));
        assert_eq!(b.pointer("/aggs/devices/composite/after").unwrap(), &after);
        assert!(b.pointer("/aggs/no_device").is_none(), "counted once, on the first page");
        assert_eq!(b.pointer("/query/bool/filter/1/term/src_hostname.keyword").unwrap(), "fw-7", "a run scoped to one device");
        let late = page_body(&fields(), 1, 2, 500, None, &DeviceFilter::Some(vec!["fw-7".into(), "fw-9".into()]));
        assert_eq!(late.pointer("/query/bool/filter/1/terms/src_hostname.keyword").unwrap(), &json!(["fw-7", "fw-9"]), "a run scoped to the late devices");
        assert!(DeviceFilter::Some(vec![]).is_partial() && DeviceFilter::One("x".into()).is_partial() && !DeviceFilter::All.is_partial());
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
        // Nor is a page the cluster cut at the body's `timeout` (0.3.81): asked again, like a failed shard.
        let timed = json!({ "timed_out": true, "_shards": { "total": 3, "failed": 0 }, "aggregations": { "devices": { "buckets": [] } } });
        assert!(matches!(read_page(&timed, &fields(), 10), Err(PageError::Retry(ref w)) if w.contains("timed out")), "a time-out is not the end of the list");
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
        assert_eq!(readings(&res, &fields())[0].event_field.as_deref(), Some("ingested_time"), "the field it was read from, not the first asked for");
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
        assert_eq!((r[0].event_field.as_deref(), r[1].event_field.as_deref()), (Some("event_created"), None));
        assert_eq!(r[1].delay_minutes, None, "no event time: can't measure, not 0");
        assert!(r[1].extras.is_empty(), "a blank extra is not a value");
        assert!(r[1].arrival_ms.is_some());
        assert_eq!(r[2].delay_minutes, None);
        assert_eq!(r[2].docs, 1);
    }

    #[test]
    fn each_log_types_newest_document_is_asked_for_in_the_same_search() {
        let f = Fields { log_type: Some("log_type.keyword".into()), ..fields() };
        let b = page_body(&f, 1, 2, PAGE_SIZE_TYPES, None, &DeviceFilter::All);
        let each = b.pointer("/aggs/devices/aggs").unwrap();
        assert_eq!(each.pointer("/types/terms").unwrap(), &json!({ "field": "log_type.keyword", "size": 20, "shard_size": 100 }));
        assert_eq!(each.pointer("/no_type/missing/field").unwrap(), "log_type.keyword");
        let src = each.pointer("/latest/top_hits/_source").unwrap().as_array().unwrap();
        assert!(src.contains(&json!("log_type")));
        for k in ["types", "no_type"] {
            assert_eq!(each.pointer(&format!("/{k}/aggs/latest")).unwrap(), each.get("latest").unwrap(), "the same document, the same fields");
        }
        const { assert!(PAGE_SIZE_TYPES * (TYPES_PER_DEVICE + 1) <= 20_000) };
        let off = page_body(&fields(), 1, 2, 10, None, &DeviceFilter::All);
        assert!(off.pointer("/aggs/devices/aggs/types").is_none() && off.pointer("/aggs/devices/aggs/no_type").is_none(), "off: the search of 0.3.89");
        assert!(!off.to_string().contains("log_type"));
    }

    #[test]
    fn log_types_are_read_with_the_documents_that_have_none() {
        let f = Fields { log_type: Some("log_type".into()), ..fields() };
        let doc = |m: i64, t: Option<&str>| {
            let mut s = json!({ "@timestamp": "2026-11-24T12:00:00Z", "event_created": 1_795_521_600_000i64 - m * 60_000 });
            if let Some(t) = t { s["log_type"] = json!(t); }
            json!({ "hits": { "hits": [ { "_source": s } ] } })
        };
        let res = json!({ "aggregations": { "devices": { "buckets": [
            { "key": { "d": "fw" }, "doc_count": 60, "latest": doc(1, Some("traffic")),
              "types": { "sum_other_doc_count": 0, "buckets": [
                  { "key": "traffic", "doc_count": 40, "latest": doc(1, Some("traffic")) }, { "key": "threat", "doc_count": 10, "latest": doc(46, Some("threat")) },
                  { "key": "(no log type)", "doc_count": 2, "latest": doc(3, Some("(no log type)")) } ] },
              "no_type": { "doc_count": 8, "latest": doc(5, None) } },
            { "key": { "d": "many" }, "doc_count": 9, "latest": doc(0, None), "types": { "sum_other_doc_count": 3, "buckets": [ { "key": "a", "doc_count": 6, "latest": doc(0, Some("a")) } ] }, "no_type": { "doc_count": 0, "latest": { "hits": { "hits": [] } } } },
            { "key": { "d": "mixed" }, "doc_count": 9, "latest": doc(0, None), "types": { "buckets": [] }, "no_type": { "doc_count": 4, "latest": doc(2, Some("audit")) } },
        ] } } });
        let r = readings(&res, &f);
        let t = r[0].types.as_ref().unwrap();
        assert_eq!(t.iter().map(|x| (x.log_type.as_deref(), x.docs, x.delay_minutes)).collect::<Vec<_>>(),
                   vec![(Some("traffic"), 40, Some(1.0)), (Some("threat"), 10, Some(46.0)), (Some("(no log type)"), 2, Some(3.0)), (None, 8, Some(5.0))],
                   "a real value of that text is not the missing one");
        assert_eq!((r[0].delay_minutes, r[0].types_truncated), (Some(1.0), false), "the device row is its newest document, as before");
        assert!(r[1].types_truncated && r[1].types.as_ref().unwrap().len() == 1, "more than the 20 read");
        assert_eq!(r[2].types.as_ref().unwrap()[0].log_type.as_deref(), Some("audit"), "its value is there, only not where this index is aggregated");
        assert!(r[2].types_truncated);
        assert!(readings(&res, &fields())[0].types.is_none(), "off");
    }

    #[test]
    fn the_mapping_alone_decides_the_field() {
        let kw = json!({ "keyword": { "type": "keyword", "aggregatable": true } });
        let text = json!({ "text": { "type": "text", "aggregatable": false } });
        let of = |fields: Value| log_type_field(&json!({ "indices": ["logstash-1"], "fields": fields }));
        assert_eq!(of(json!({ "log_type": kw })), LogTypeField { field: Some("log_type".into()), why: None });
        assert_eq!(of(json!({ "log_type": text, "log_type.keyword": kw })).field.as_deref(), Some("log_type.keyword"));
        assert_eq!(of(json!({})).why.as_deref(), Some("log_type is not in the mapping"));
        assert_eq!(of(json!({ "log_type": text })).why.as_deref(), Some("log_type: text with no .keyword"));
        for unread in [json!({ "cluster_name": "x" }), json!({ "indices": [], "fields": {} }), Value::Null] {
            assert_eq!(log_type_field(&unread), LogTypeField { field: None, why: Some("mapping not read".into()) }, "{unread}");
        }
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
