//! The log-delay measurement job, run by the core on a timer.
//!
//! This is the first thing in the product that talks to a cluster without a person
//! pressing something, and the first that writes without one. Both are deliberate, both
//! are narrow, and the shape of the exception matters more than the feature does:
//!
//! * **Hosted only.** `Edition::Hosted` is the bridge running as a daemon — the only
//!   edition still there at three in the morning. A timer in the page would tick only
//!   while somebody had a tab open, which on a server is nobody, so "every two hours"
//!   would be a promise the implementation could not keep. Portable and Installed do
//!   not schedule at all; the Log delay page is how they measure.
//! * **Still gated twice.** `guard.rs` says a write leaves this process only when the
//!   config permits writes, or when an operator unlocked the session and asked for that
//!   one request by hand. The session unlock is deliberately never persisted, so a
//!   background task can never hold it. This job therefore takes the other gate: it
//!   refuses to run while the config is read-only, and it refuses to run until an
//!   admin has armed it. Two decisions, both made by a person, neither of them here.
//! * **It measures; it does not judge.** The document carries `delay_minutes` and the
//!   two timestamps it came from. Whether 41 minutes is DELAYED is a threshold, and
//!   thresholds are presentation: they live in `ui/js/core/log-delay.js`, once, and are
//!   applied when the data is read back. Porting `classify()` here would put one rule
//!   in two languages, which is this codebase's named recurring failure.
//! * **It borrows credentials; it does not keep any.** Both the clusters measured and
//!   the cluster written to are ids from the primed set — the same specs the UI primed,
//!   with the same secrets, the same jump hosts and the same pinned certificates. A
//!   sealed config that nobody has opened yet has no credentials to lend, so the run is
//!   skipped and says so. An unmeasured cluster is unknown, not zero.
//!
//! ```text
//!   tick (60s)
//!     └── due? ──no──▶ nothing
//!          │yes
//!          ├── armed? primed? writes allowed? ──no──▶ record why, try again next tick
//!          │
//!          ├── for each target cluster
//!          │     ├── terms(device) + top_hits(1)        one search
//!          │     ├── delay = arrival − event            per device
//!          │     └── either timestamp unreadable ──▶ skip the device
//!          │
//!          └── bulk index into the sink cluster, _id = cluster|device|hour
//! ```
//!
//! The `_id` is deterministic on purpose. A run that repeats — a short interval, a
//! restart, an admin pressing the button twice — overwrites its own rows instead of
//! adding new ones, so the index cannot fill with duplicates of one measurement.

use crate::http::EsRequest;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// How the job is described. Set by an admin through `DELAY_SINK_SET`, stored next to
/// the other core state in the data directory.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkConfig {
    /// False — the default — means the timer looks at this, finds it disarmed, and does
    /// nothing. An upgrade cannot start writing on its own.
    #[serde(default)]
    pub enabled: bool,
    /// Which primed cluster receives the measurements. Naming a cluster rather than a
    /// URL is what keeps this from inventing a second place to store a password.
    #[serde(default)]
    pub sink_cluster_id: String,
    /// Which primed clusters to measure. Empty means every primed cluster except the
    /// sink itself.
    #[serde(default)]
    pub clusters: Vec<String>,
    /// Indices are `<prefix>-YYYY.MM`, matching the tool this is ported from.
    #[serde(default = "default_prefix")]
    pub index_prefix: String,
    #[serde(default = "default_hours")]
    pub every_hours: u64,
    /// The indices to measure, and the fields to measure them by. Same names the UI
    /// resolves in `log-delay.js`; left unset, the same defaults apply.
    #[serde(default = "default_pattern")]
    pub index_pattern: String,
    #[serde(default = "default_device_field")]
    pub device_field: String,
    #[serde(default = "default_event_fields")]
    pub event_time_fields: Vec<String>,
    #[serde(default = "default_arrival_field")]
    pub arrival_field: String,
    /// A bound on devices per cluster per run, so one misconfigured cluster cannot make
    /// an unbounded request.
    #[serde(default = "default_max_devices")]
    pub max_devices: u64,
}

fn default_prefix() -> String { "elasticpro-log-delay".into() }
fn default_hours() -> u64 { 2 }
fn default_pattern() -> String { "logstash-*".into() }
fn default_device_field() -> String { "src_hostname.keyword".into() }
fn default_arrival_field() -> String { "@timestamp".into() }
fn default_event_fields() -> Vec<String> {
    vec!["ingested_time".into(), "event_created".into(), "event.created".into()]
}
fn default_max_devices() -> u64 { 2000 }

impl Default for SinkConfig {
    fn default() -> SinkConfig {
        SinkConfig {
            enabled: false,
            sink_cluster_id: String::new(),
            clusters: Vec::new(),
            index_prefix: default_prefix(),
            every_hours: default_hours(),
            index_pattern: default_pattern(),
            device_field: default_device_field(),
            event_time_fields: default_event_fields(),
            arrival_field: default_arrival_field(),
            max_devices: default_max_devices(),
        }
    }
}

impl SinkConfig {
    /// What an admin sent, with the parts that must be sane made sane. The interval is
    /// clamped rather than rejected: an hour is the floor because this writes, and a day
    /// is the ceiling because beyond that the tail window stops overlapping.
    pub fn normalised(mut self) -> SinkConfig {
        self.every_hours = self.every_hours.clamp(1, 24);
        self.max_devices = self.max_devices.clamp(1, 10_000);
        if self.index_prefix.trim().is_empty() {
            self.index_prefix = default_prefix();
        }
        if self.index_pattern.trim().is_empty() {
            self.index_pattern = default_pattern();
        }
        if self.arrival_field.trim().is_empty() {
            self.arrival_field = default_arrival_field();
        }
        if self.device_field.trim().is_empty() {
            self.device_field = default_device_field();
        }
        self.event_time_fields.retain(|f| !f.trim().is_empty());
        if self.event_time_fields.is_empty() {
            self.event_time_fields = default_event_fields();
        }
        self
    }

    /// Why this configuration cannot run, if it cannot. Checked when an admin arms it,
    /// so the refusal lands on the person who can fix it rather than in a log at 3am.
    pub fn refusal(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        if self.sink_cluster_id.trim().is_empty() {
            return Some("no sink cluster: name the cluster the measurements are written to".into());
        }
        if self.clusters.len() == 1 && self.clusters[0] == self.sink_cluster_id {
            return Some("the only cluster to measure is the sink itself".into());
        }
        None
    }
}

/// What the last run did, so "it is scheduled" is something an admin can see rather than
/// something they have to believe.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkState {
    pub runs: u64,
    pub last_run_at: Option<i64>,
    pub last_ok: bool,
    /// Why the last attempt did nothing — disarmed, not primed, config is read-only.
    /// Distinct from `last_error`, which is a run that tried and failed.
    pub last_skipped: Option<String>,
    pub last_error: Option<String>,
    pub last_measured: usize,
    pub last_failed: usize,
    pub consecutive_failures: u32,
    pub next_due_at: Option<i64>,
}

/// When to try again. A failing run backs off — doubling, capped at a day — so a sink
/// that is down is retried without being hammered, and a sink that comes back is picked
/// up within one normal interval.
pub fn next_due(now_ms: i64, every_hours: u64, consecutive_failures: u32) -> i64 {
    let base = (every_hours.clamp(1, 24) as i64) * 3_600_000;
    let factor = 1i64 << consecutive_failures.min(4); // 1, 2, 4, 8, 16
    now_ms + (base * factor).min(24 * 3_600_000)
}

/// The search body. Mirrors `buildSearchBody` in `ui/js/core/log-delay.js`.
pub fn search_body(cfg: &SinkConfig) -> Value {
    let arrival = cfg.arrival_field.clone();
    let mut source: Vec<String> = vec![arrival.clone()];
    source.extend(cfg.event_time_fields.iter().cloned());
    json!({
        "size": 0,
        "query": { "bool": { "filter": [
            { "range": { arrival.clone(): {
                "gte": format!("now-{}h", cfg.every_hours.clamp(1, 24)),
                "lte": "now",
            } } },
        ] } },
        "aggs": { "devices": {
            "terms": { "field": cfg.device_field, "size": cfg.max_devices, "order": { "_count": "desc" } },
            "aggs": { "latest": { "top_hits": {
                "size": 1,
                "sort": [{ arrival: { "order": "desc" } }],
                "_source": source,
            } } },
        } },
    })
}

/// One device's measurement. No status, no reason, no fix — see the module note.
#[derive(Clone, Debug, PartialEq)]
pub struct Measurement {
    pub device: String,
    pub docs: u64,
    pub arrival_ms: i64,
    pub event_ms: i64,
    pub delay_minutes: f64,
}

/// Turn one aggregation response into measurements.
///
/// A device whose latest document is missing either timestamp is skipped rather than
/// recorded as zero: a zero delay is a measurement, and "the clock could not be read" is
/// not one.
pub fn measurements(res: &Value, cfg: &SinkConfig) -> Vec<Measurement> {
    let buckets = res
        .pointer("/aggregations/devices/buckets")
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for b in buckets {
        let Some(device) = bucket_key(&b) else { continue };
        let Some(src) = b.pointer("/latest/hits/hits/0/_source") else { continue };
        let Some(arrival) = to_ms(dotted(src, &cfg.arrival_field)) else { continue };
        let Some(event) = cfg.event_time_fields.iter().find_map(|f| to_ms(dotted(src, f))) else {
            continue;
        };
        out.push(Measurement {
            device,
            docs: b.get("doc_count").and_then(|d| d.as_u64()).unwrap_or(0),
            arrival_ms: arrival,
            event_ms: event,
            delay_minutes: (arrival - event) as f64 / 60000.0,
        });
    }
    out
}

fn bucket_key(b: &Value) -> Option<String> {
    match b.get("key") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// `a.b.c` against a `_source`, which may nest it or may hold it under the dotted name.
fn dotted<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    if let Some(flat) = v.get(path) {
        return Some(flat);
    }
    let mut cur = v;
    for part in path.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur)
}

/// Elasticsearch renders a date field as RFC3339, unless the mapping asked for epoch
/// millis, in which case it is a number. Anything else is unreadable, and unreadable is
/// `None` all the way up.
fn to_ms(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::String(s) => parse_rfc3339_ms(s),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        _ => None,
    }
}

/// The NDJSON body for one cluster's measurements.
pub fn bulk_body(cluster_id: &str, ms: &[Measurement], index: &str, bucket: &str) -> String {
    let mut s = String::new();
    for m in ms {
        let id = format!("{cluster_id}|{}|{bucket}", m.device);
        s.push_str(&json!({ "index": { "_index": index, "_id": id } }).to_string());
        s.push('\n');
        s.push_str(
            &json!({
                "@timestamp": bucket,
                "cluster": cluster_id,
                "device": m.device,
                "docs": m.docs,
                "arrival_time": m.arrival_ms,
                "event_time": m.event_ms,
                // Two decimals. The source figure is a subtraction of two clocks; more
                // precision than that would be decoration.
                "delay_minutes": (m.delay_minutes * 100.0).round() / 100.0,
            })
            .to_string(),
        );
        s.push('\n');
    }
    s
}

/// The one search this job sends to a measured cluster.
pub fn search_request(cluster_id: &str, cfg: &SinkConfig) -> EsRequest {
    EsRequest {
        cluster_id: cluster_id.to_string(),
        url: None,
        method: "POST".into(),
        path: format!("/{}/_search?ignore_unavailable=true&allow_no_indices=true", cfg.index_pattern),
        body: Some(search_body(cfg).to_string()),
        auth_header: None,
        timeout_ms: Some(60_000),
        allow_writes: false,
    }
}

/// The one write this job sends, to the sink cluster.
pub fn bulk_request(cfg: &SinkConfig, ndjson: String) -> EsRequest {
    EsRequest {
        cluster_id: cfg.sink_cluster_id.clone(),
        url: None,
        method: "POST".into(),
        path: "/_bulk".into(),
        body: Some(ndjson),
        auth_header: None,
        timeout_ms: Some(60_000),
        // The guard still decides. This says only that the request is meant to write;
        // `Writes::decide` refuses it unless the config permits writes at all.
        allow_writes: true,
    }
}

/// `<prefix>-YYYY.MM`.
pub fn index_name(prefix: &str, year: i64, month: i64) -> String {
    format!("{prefix}-{year:04}.{month:02}")
}

/// `ok:false`, or an `errors:true` bulk response, rendered as one line an admin can read.
pub fn bulk_failure(res: &Value) -> Option<String> {
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let kind = res.get("kind").and_then(|v| v.as_str()).unwrap_or("error");
        let msg = res.get("message").and_then(|v| v.as_str()).unwrap_or("no message");
        return Some(format!("{kind}: {msg}"));
    }
    let body = res.get("json")?;
    if body.get("errors").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let items = body.get("items").and_then(|v| v.as_array())?;
    let first = items.iter().find_map(|it| {
        it.get("index")?
            .get("error")?
            .get("reason")
            .and_then(|r| r.as_str())
            .map(|s| s.to_string())
    });
    let failed = items
        .iter()
        .filter(|it| it.pointer("/index/error").is_some())
        .count();
    Some(format!(
        "{failed} of {} documents rejected: {}",
        items.len(),
        first.unwrap_or_else(|| "no reason given".into())
    ))
}

/* ------------------------------- time, locally ------------------------------- */
// The crate has no date dependency and this needs four things from one: now, a parser
// for what Elasticsearch emits, the month for an index name, and the hour for a
// document id. Hinnant's civil-date algorithms are exact for any Gregorian date, which
// is a smaller commitment than another dependency in the tree.

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parse the RFC3339 shapes Elasticsearch emits, in UTC or with an offset. `None` for
/// anything else, which every caller treats as "unreadable" and never as zero.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (h, mi, sec) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut ms = days_from_civil(y, mo, d) * 86_400_000 + (h * 3600 + mi * 60 + sec) * 1000;
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        rest = &rest[1 + digits.len()..];
        if !digits.is_empty() {
            let millis: String = format!("{digits:0<3}").chars().take(3).collect();
            ms += millis.parse::<i64>().unwrap_or(0);
        }
    }
    // A trailing offset moves the instant; Z and an absent offset both mean UTC.
    let off = rest.as_bytes();
    if !off.is_empty() && (off[0] == b'+' || off[0] == b'-') && rest.len() >= 5 {
        let sign = if off[0] == b'+' { 1 } else { -1 };
        let hh = rest.get(1..3)?.parse::<i64>().ok()?;
        let mm = rest.get(4..6).or_else(|| rest.get(3..5))?.parse::<i64>().ok()?;
        ms -= sign * (hh * 3600 + mm * 60) * 1000;
    }
    Some(ms)
}

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The year and month the index is named for, and the hour the document id is keyed on.
pub fn month_and_hour_bucket(ms: i64) -> (i64, i64, String) {
    let (y, m, d) = civil_from_days(ms.div_euclid(86_400_000));
    let hour = ms.rem_euclid(86_400_000) / 3_600_000;
    (y, m, format!("{y:04}-{m:02}-{d:02}T{hour:02}:00:00Z"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SinkConfig {
        SinkConfig { sink_cluster_id: "kibana".into(), ..SinkConfig::default() }
    }

    #[test]
    fn dates_round_trip() {
        for (s, want) in [
            ("1970-01-01T00:00:00Z", 0i64),
            ("2026-09-19T12:30:00Z", 1789821000000),
            ("2026-09-19T12:30:00.500Z", 1789821000500),
            ("2024-02-29T00:00:00Z", 1709164800000), // a leap day
        ] {
            assert_eq!(parse_rfc3339_ms(s), Some(want), "{s}");
        }
    }

    #[test]
    fn an_offset_moves_the_instant() {
        let utc = parse_rfc3339_ms("2026-09-19T12:30:00Z").unwrap();
        assert_eq!(parse_rfc3339_ms("2026-09-19T18:00:00+05:30"), Some(utc));
        assert_eq!(parse_rfc3339_ms("2026-09-19T07:30:00-05:00"), Some(utc));
    }

    #[test]
    fn unreadable_is_none_not_zero() {
        for s in ["", "not a date", "2026-13-01T00:00:00Z", "2026-09-19", "2026-09-19T25:00:00Z"] {
            assert_eq!(parse_rfc3339_ms(s), None, "{s:?} should not parse");
        }
    }

    #[test]
    fn index_and_bucket_come_from_one_instant() {
        let ms = parse_rfc3339_ms("2026-09-19T14:47:11Z").unwrap();
        let (y, m, bucket) = month_and_hour_bucket(ms);
        assert_eq!(index_name("elasticpro-log-delay", y, m), "elasticpro-log-delay-2026.09");
        // The hour, not the minute: every run inside one hour writes the same ids.
        assert_eq!(bucket, "2026-09-19T14:00:00Z");
    }

    #[test]
    fn a_device_missing_a_timestamp_is_skipped_not_zeroed() {
        let res = json!({ "aggregations": { "devices": { "buckets": [
            { "key": "good", "doc_count": 10, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "2026-09-19T12:41:00Z", "ingested_time": "2026-09-19T12:00:00Z" } },
            ] } } },
            { "key": "no-event-time", "doc_count": 7, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "2026-09-19T12:41:00Z" } },
            ] } } },
            { "key": "unparseable", "doc_count": 3, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "yesterday", "ingested_time": "2026-09-19T12:00:00Z" } },
            ] } } },
            { "key": "no-hits", "doc_count": 1, "latest": { "hits": { "hits": [] } } },
        ] } } });
        let ms = measurements(&res, &cfg());
        assert_eq!(ms.len(), 1, "only the measurable device is recorded");
        assert_eq!(ms[0].device, "good");
        assert_eq!(ms[0].delay_minutes, 41.0);
        assert_eq!(ms[0].docs, 10);
    }

    #[test]
    fn a_nested_event_field_is_found_either_way() {
        let nested = json!({ "aggregations": { "devices": { "buckets": [
            { "key": "n", "doc_count": 1, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "2026-09-19T12:30:00Z", "event": { "created": "2026-09-19T12:00:00Z" } } },
            ] } } },
        ] } } });
        let flat = json!({ "aggregations": { "devices": { "buckets": [
            { "key": "f", "doc_count": 1, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "2026-09-19T12:30:00Z", "event.created": "2026-09-19T12:00:00Z" } },
            ] } } },
        ] } } });
        assert_eq!(measurements(&nested, &cfg())[0].delay_minutes, 30.0);
        assert_eq!(measurements(&flat, &cfg())[0].delay_minutes, 30.0);
    }

    #[test]
    fn a_clock_ahead_stays_negative() {
        // The engine classifies this as CLOCK_AHEAD. The measurement must carry the sign
        // through rather than clamping it, or the classifier never sees it.
        let res = json!({ "aggregations": { "devices": { "buckets": [
            { "key": "ahead", "doc_count": 2, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "2026-09-19T12:00:00Z", "ingested_time": "2026-09-19T12:37:00Z" } },
            ] } } },
        ] } } });
        assert_eq!(measurements(&res, &cfg())[0].delay_minutes, -37.0);
    }

    #[test]
    fn ids_repeat_within_an_hour_so_a_rerun_overwrites() {
        let m = vec![Measurement {
            device: "dev-1".into(), docs: 5,
            arrival_ms: 1, event_ms: 0, delay_minutes: 1.0 / 60000.0,
        }];
        let a = bulk_body("prod", &m, "elasticpro-log-delay-2026.09", "2026-09-19T14:00:00Z");
        let b = bulk_body("prod", &m, "elasticpro-log-delay-2026.09", "2026-09-19T14:00:00Z");
        assert_eq!(a, b);
        assert!(a.contains(r#""_id":"prod|dev-1|2026-09-19T14:00:00Z""#), "{a}");
        assert_eq!(a.lines().count(), 2, "one action line, one document line");
    }

    #[test]
    fn the_search_never_asks_to_write() {
        let r = search_request("prod", &cfg());
        assert!(!r.allow_writes);
        assert!(r.path.starts_with("/logstash-*/_search"));
        assert!(bulk_request(&cfg(), String::new()).allow_writes);
    }

    #[test]
    fn backoff_doubles_and_stops() {
        let h = 3_600_000i64;
        assert_eq!(next_due(0, 2, 0), 2 * h);
        assert_eq!(next_due(0, 2, 1), 4 * h);
        assert_eq!(next_due(0, 2, 3), 16 * h);
        assert_eq!(next_due(0, 2, 9), 24 * h, "capped at a day, however long it has failed");
    }

    #[test]
    fn a_configuration_that_cannot_work_is_refused_when_it_is_armed() {
        let mut c = SinkConfig { enabled: true, ..SinkConfig::default() };
        assert!(c.refusal().unwrap().contains("no sink cluster"));
        c.sink_cluster_id = "kibana".into();
        assert_eq!(c.refusal(), None);
        c.clusters = vec!["kibana".into()];
        assert!(c.refusal().unwrap().contains("sink itself"));
        // Disarmed, nothing is refused — an admin may save a half-finished setting.
        c.enabled = false;
        assert_eq!(c.refusal(), None);
    }

    #[test]
    fn the_interval_is_clamped_not_rejected() {
        let c = SinkConfig { every_hours: 0, max_devices: 0, ..SinkConfig::default() }.normalised();
        assert_eq!(c.every_hours, 1);
        assert_eq!(c.max_devices, 1);
        let c = SinkConfig { every_hours: 999, ..SinkConfig::default() }.normalised();
        assert_eq!(c.every_hours, 24);
    }

    #[test]
    fn a_rejected_bulk_is_reported_rather_than_counted_as_success() {
        assert_eq!(bulk_failure(&json!({ "ok": true, "json": { "errors": false } })), None);
        let refused = bulk_failure(&json!({ "ok": false, "kind": "blocked_readonly", "message": "no" }));
        assert!(refused.unwrap().contains("blocked_readonly"));
        let partial = bulk_failure(&json!({ "ok": true, "json": { "errors": true, "items": [
            { "index": { "status": 201 } },
            { "index": { "status": 400, "error": { "reason": "mapper_parsing_exception" } } },
        ] } }));
        let partial = partial.unwrap();
        assert!(partial.contains("1 of 2"), "{partial}");
        assert!(partial.contains("mapper_parsing_exception"), "{partial}");
    }
}
