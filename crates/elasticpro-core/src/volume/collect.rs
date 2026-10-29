//! The three requests a run sends, and what their answers do to the record.
//!
//! Pure: requests are built and responses read here, sent elsewhere (`run`). Each rule in
//! docs/VOLUME.md "Collection" is one function, so each is tested on its own.

use super::schedule::{day_key, parse_day};
use super::settings::VolumeSettings;
use super::{Day, FieldAgg, SourceTotals, TopValue, FIELD_KEYS};
use crate::http::EsRequest;
use chrono::NaiveDate;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// The index-name format, compiled. `*` is the source (one or more characters, `-`
/// included); `YYYY.MM.DD` is the day.
#[derive(Clone, Debug)]
pub struct IndexFormat {
    format: String,
    re: regex::Regex,
}

impl IndexFormat {
    pub fn new(format: &str) -> Option<IndexFormat> {
        if super::settings::index_format_problem(format).is_some() {
            return None;
        }
        let mut pat = String::from("^");
        let mut rest = format;
        while !rest.is_empty() {
            if let Some(r) = rest.strip_prefix("YYYY.MM.DD") {
                pat.push_str(r"(?P<y>\d{4})\.(?P<m>\d{2})\.(?P<d>\d{2})");
                rest = r;
            } else if let Some(r) = rest.strip_prefix('*') {
                pat.push_str("(.+)");
                rest = r;
            } else {
                let c = rest.chars().next()?;
                pat.push_str(&regex::escape(&c.to_string()));
                rest = &rest[c.len_utf8()..];
            }
        }
        pat.push('$');
        Some(IndexFormat { format: format.to_string(), re: regex::Regex::new(&pat).ok()? })
    }

    /// Every index the format could name: the day part as `*` too.
    pub fn glob(&self) -> String {
        self.format.replace("YYYY.MM.DD", "*")
    }

    /// One day's indices by name, so a breakdown adds up to exactly that day.
    pub fn for_day(&self, d: NaiveDate) -> String {
        self.format.replace("YYYY.MM.DD", &d.format("%Y.%m.%d").to_string())
    }

    /// The day and the source an index name carries, or `None` when it does not fit (or
    /// names a date that does not exist, like the 31st of September).
    pub fn parse(&self, index: &str) -> Option<(NaiveDate, String)> {
        let c = self.re.captures(index)?;
        let num = |k: &str| c.name(k).and_then(|m| m.as_str().parse::<u32>().ok());
        let day = NaiveDate::from_ymd_opt(num("y")? as i32, num("m")?, num("d")?)?;
        // Unnamed groups are the `*`s; several are joined so the source stays one name.
        let parts: Vec<&str> = c.iter().skip(1).zip(self.re.capture_names().skip(1))
            .filter(|(_, n)| n.is_none()).filter_map(|(m, _)| m.map(|m| m.as_str())).collect();
        Some((day, parts.join("-")))
    }
}

/* ------------------------------------ requests ------------------------------------ */

fn req(cluster: &str, method: &str, path: String, body: Option<String>) -> EsRequest {
    EsRequest {
        cluster_id: cluster.to_string(),
        method: method.into(),
        path,
        body,
        timeout_ms: Some(60_000),
        allow_writes: false,
        origin: Some("volume-daily".into()),
        class: crate::gate::Class::Background,
        ..Default::default()
    }
}

pub fn cat_request(cluster: &str, fmt: &IndexFormat) -> EsRequest {
    req(cluster, "GET", format!(
        "/_cat/indices/{}?format=json&bytes=b&h=index,status,docs.count,pri.store.size,store.size", fmt.glob()
    ), None)
}

/// Every name any row may resolve to, and each one's `.keyword`.
pub fn field_caps_fields(s: &VolumeSettings) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for key in FIELD_KEYS.iter().chain(["eventSize", "subSize"].iter()) {
        for f in s.row(key) {
            for n in [f.clone(), format!("{f}.keyword")] {
                if !out.contains(&n) {
                    out.push(n);
                }
            }
        }
    }
    out
}

pub fn field_caps_request(cluster: &str, fmt: &IndexFormat, s: &VolumeSettings) -> EsRequest {
    req(cluster, "GET", format!(
        "/{}/_field_caps?fields={}&ignore_unavailable=true", fmt.glob(), field_caps_fields(s).join(",")
    ), None)
}

pub fn search_request(cluster: &str, fmt: &IndexFormat, d: NaiveDate, body: &Value) -> EsRequest {
    req(cluster, "POST", format!("/{}/_search?ignore_unavailable=true&allow_no_indices=true", fmt.for_day(d)), Some(body.to_string()))
}

/* ------------------------------------ _cat/indices ------------------------------------ */

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DayGroup {
    pub indices: u64,
    pub open: u64,
    pub pri_bytes: u64,
    pub total_bytes: u64,
    pub sources: BTreeMap<String, SourceTotals>,
    /// index name → source, to read `by_index` back into sources.
    pub index_source: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default)]
pub struct Listing {
    pub days: BTreeMap<NaiveDate, DayGroup>,
    pub matched: u64,
    /// Indices the glob found whose names do not fit the format. Capped: a pattern that
    /// catches a few thousand monthly indices should not make the reply that size.
    pub skipped: Vec<String>,
    pub skipped_count: u64,
}

pub const SKIPPED_KEEP: usize = 500;

fn bytes(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

/// Group a `_cat/indices?format=json&bytes=b` answer by the day in each name. A closed
/// index counts as an index of its day, with no size (`_cat` reports none for it).
pub fn read_cat(rows: &Value, fmt: &IndexFormat) -> Listing {
    let mut out = Listing::default();
    for r in rows.as_array().into_iter().flatten() {
        let Some(name) = r.get("index").and_then(Value::as_str) else { continue };
        let Some((day, source)) = fmt.parse(name) else {
            out.skipped_count += 1;
            if out.skipped.len() < SKIPPED_KEEP {
                out.skipped.push(name.to_string());
            }
            continue;
        };
        out.matched += 1;
        let open = r.get("status").and_then(Value::as_str).is_none_or(|s| s == "open");
        let (pri, total) = (bytes(r.get("pri.store.size")), bytes(r.get("store.size")));
        let g = out.days.entry(day).or_default();
        g.indices += 1;
        g.open += open as u64;
        g.pri_bytes += pri;
        g.total_bytes += total;
        let s = g.sources.entry(source.clone()).or_default();
        s.indices += 1;
        s.pri_bytes += pri;
        s.total_bytes += total;
        g.index_source.insert(name.to_string(), source);
    }
    out.skipped.sort();
    out
}

/// Refresh one month's days from a listing. Every day that still has indices gets its
/// totals, sources and `live: true`; a kept day that has none any more becomes
/// `live: false` and is never changed again (that includes a later reappearance: the
/// record does not guess whether a restored index is the same data).
///
/// Days outside `[oldest, ..)` are left alone; the caller prunes those.
pub fn apply_totals(days: &mut BTreeMap<String, Day>, month: &str, listing: &Listing, now_ms: i64) -> bool {
    let mut changed = false;
    for (d, g) in listing.days.iter().filter(|(d, _)| super::schedule::month_key(**d) == month) {
        let key = day_key(*d);
        let day = days.entry(key.clone()).or_insert_with(|| Day { day: key, live: true, ..Day::default() });
        if !day.live && day.totals_at > 0 {
            continue;
        }
        day.live = true;
        day.totals_at = now_ms;
        day.indices = g.indices;
        day.pri_bytes = g.pri_bytes;
        day.total_bytes = g.total_bytes;
        // Sizes come from _cat every run; what the search measured per source stays until
        // the day is aggregated again. A source that is gone from the day goes.
        let old = std::mem::take(&mut day.sources);
        for (name, s) in &g.sources {
            let prev = old.get(name);
            day.sources.insert(name.clone(), SourceTotals {
                indices: s.indices, pri_bytes: s.pri_bytes, total_bytes: s.total_bytes,
                docs: prev.and_then(|p| p.docs), event_bytes: prev.and_then(|p| p.event_bytes),
                sub_bytes: prev.and_then(|p| p.sub_bytes),
            });
        }
        changed = true;
    }
    for (key, day) in days.iter_mut() {
        let present = parse_day(key).is_some_and(|d| listing.days.contains_key(&d));
        if day.live && !present {
            day.live = false;
            if !day.is_final {
                day.error = Some(match day.aggregated_at {
                    Some(_) => "its indices went before the day was aggregated as final: the figures are the last ones measured".into(),
                    None => "its indices went before the day was aggregated: only the sizes were measured".into(),
                });
            }
            changed = true;
        }
    }
    changed
}

/// Whether a day is to be searched this run: live, with an open index, and not yet
/// aggregated as final. Today is never final, so it is searched every run.
pub fn needs_search(day: &Day, group: Option<&DayGroup>) -> bool {
    day.live && !day.is_final && group.is_some_and(|g| g.open > 0)
}

/// Why a past day that is not final is not searched this run, as its `error` says it —
/// `None` when it is final, or is searched (`needs_search`), or is today. A day whose
/// indices are all closed is asked again on the first run that finds one open; a day whose
/// indices are gone keeps what was last measured (`apply_totals` says so when it goes).
pub fn not_searched_why(day: &Day, group: Option<&DayGroup>, today: NaiveDate) -> Option<String> {
    if day.is_final || !day.live || parse_day(&day.day).is_none_or(|d| d >= today) {
        return None;
    }
    match group {
        Some(g) if g.open == 0 => Some(format!(
            "not aggregated: {} of its indices {} closed; asked again on a later run while they are open",
            g.indices, if g.indices == 1 { "is" } else { "are" })),
        _ => None,
    }
}

/// What a search answer that is not whole says: shards that failed, or a time-out. Its
/// figures are kept but the day is not final, so a later run asks again.
pub fn partial_answer(res: &Value) -> Option<String> {
    let failed = res.pointer("/_shards/failed").and_then(Value::as_u64).unwrap_or(0);
    if failed > 0 {
        let total = res.pointer("/_shards/total").and_then(Value::as_u64).unwrap_or(0);
        let reason = res.pointer("/_shards/failures/0/reason/reason").and_then(Value::as_str)
            .or_else(|| res.pointer("/_shards/failures/0/reason/type").and_then(Value::as_str));
        let reason = reason.map(|r| format!(" ({})", r.chars().take(200).collect::<String>())).unwrap_or_default();
        return Some(format!("{failed} of {total} shards failed{reason}: figures may be short; asked again on the next run"));
    }
    (res.get("timed_out").and_then(Value::as_bool) == Some(true))
        .then(|| "the search timed out: figures may be short; asked again on the next run".to_string())
}

/* ------------------------------------ _field_caps ------------------------------------ */

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct RowResolution {
    pub key: String,
    pub tried: Vec<String>,
    pub resolved: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub note: String,
}

const NUMERIC: &[&str] = &["long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "unsigned_long"];

/// The types `_field_caps` reports for one name, and whether every one is aggregatable.
fn caps<'a>(fc: &'a Value, name: &str) -> Option<(Vec<&'a str>, bool)> {
    let m = fc.get("fields")?.get(name)?.as_object()?;
    let types: Vec<&str> = m.keys().map(String::as_str).filter(|t| *t != "unmapped").collect();
    if types.is_empty() {
        return None;
    }
    let agg = m.iter().filter(|(t, _)| *t != "unmapped").all(|(_, v)| v.get("aggregatable").and_then(Value::as_bool).unwrap_or(false));
    Some((types, agg))
}

/// Resolve each row against a `_field_caps` answer: left to right, the first name the
/// mapping knows wins. A `text` field uses `<name>.keyword` when that is a keyword; a sum
/// row needs a numeric field. A row nothing resolves carries why, in `note`.
pub fn resolve_rows(fc: &Value, s: &VolumeSettings) -> Vec<RowResolution> {
    let mut out = vec![];
    for key in FIELD_KEYS.iter().chain(["eventSize", "subSize"].iter()) {
        let sum = matches!(*key, "eventSize" | "subSize");
        let tried: Vec<String> = s.row(key).to_vec();
        let mut row = RowResolution { key: key.to_string(), tried: tried.clone(), ..Default::default() };
        let mut why: Vec<String> = vec![];
        for name in &tried {
            let Some((types, agg)) = caps(fc, name) else {
                why.push(format!("{name}: not in the mapping"));
                continue;
            };
            if sum {
                if types.iter().all(|t| NUMERIC.contains(t)) && agg {
                    row.resolved = Some(name.clone());
                    row.kind = Some(types.join(","));
                    row.note = "numeric".into();
                    break;
                }
                why.push(format!("{name}: {} is not numeric", types.join(",")));
                continue;
            }
            if agg {
                row.resolved = Some(name.clone());
                row.kind = Some(types.join(","));
                row.note = "aggregatable".into();
                break;
            }
            if types.contains(&"text") {
                let kw = format!("{name}.keyword");
                if let Some((kt, true)) = caps(fc, &kw) {
                    if kt.iter().all(|t| *t == "keyword") {
                        row.resolved = Some(kw);
                        row.kind = Some("keyword".into());
                        row.note = format!("{name} is text: using {name}.keyword");
                        break;
                    }
                }
                why.push(format!("{name}: text with no .keyword"));
                continue;
            }
            why.push(format!("{name}: {} is not aggregatable", types.join(",")));
        }
        if row.resolved.is_none() {
            row.note = if tried.is_empty() { "no field names set".into() } else { why.join("; ") };
        }
        out.push(row);
    }
    out
}

fn resolved<'a>(rows: &'a [RowResolution], key: &str) -> Option<&'a str> {
    rows.iter().find(|r| r.key == key).and_then(|r| r.resolved.as_deref())
}

/* ------------------------------------ the day search ------------------------------------ */

/// `ev`/`sub` sum aggs, for whichever of the two fields resolved.
fn sums(rows: &[RowResolution]) -> Map<String, Value> {
    let mut m = Map::new();
    if let Some(f) = resolved(rows, "eventSize") {
        m.insert("ev".into(), json!({ "sum": { "field": f } }));
    }
    if let Some(f) = resolved(rows, "subSize") {
        m.insert("sub".into(), json!({ "sum": { "field": f } }));
    }
    m
}

/// The one search per day (docs/VOLUME.md, step 3).
pub fn search_body(rows: &[RowResolution], top_values: u32) -> Value {
    let s = sums(rows);
    let with_sums = |mut agg: Map<String, Value>| {
        if !s.is_empty() {
            agg.insert("aggs".into(), Value::Object(s.clone()));
        }
        Value::Object(agg)
    };
    let mut aggs = s.clone();
    let mut by_index = Map::new();
    by_index.insert("terms".into(), json!({ "field": "_index", "size": 1000 }));
    aggs.insert("by_index".into(), with_sums(by_index));
    for key in FIELD_KEYS {
        let Some(f) = resolved(rows, key) else { continue };
        let mut t = Map::new();
        t.insert("terms".into(), json!({ "field": f, "size": top_values }));
        aggs.insert(format!("f_{key}"), with_sums(t));
        let mut m = Map::new();
        m.insert("missing".into(), json!({ "field": f }));
        aggs.insert(format!("m_{key}"), with_sums(m));
    }
    json!({ "size": 0, "track_total_hits": true, "aggs": aggs })
}

/// A sum agg's value as whole bytes. Absent is `None` — the field did not resolve — and
/// never 0.
fn sum_of(v: &Value, name: &str, on: bool) -> Option<u64> {
    if !on {
        return None;
    }
    let x = v.get(name)?.get("value")?;
    Some(x.as_f64().map(|f| f.max(0.0).round() as u64).unwrap_or(0))
}

fn total_hits(res: &Value) -> Option<u64> {
    let t = res.pointer("/hits/total")?;
    t.get("value").and_then(Value::as_u64).or_else(|| t.as_u64())
}

fn bucket_key(b: &Value) -> Option<String> {
    if let Some(s) = b.get("key_as_string").and_then(Value::as_str) {
        return Some(s.to_string());
    }
    match b.get("key")? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(x) => Some(x.to_string()),
        _ => None,
    }
}

/// Write one search answer into its day. `today` decides `final`: a day before today's
/// UTC date is done, and is never asked again.
pub fn apply_search(day: &mut Day, res: &Value, rows: &[RowResolution], group: &DayGroup, today: NaiveDate, now_ms: i64) {
    let (ev_on, sub_on) = (resolved(rows, "eventSize").is_some(), resolved(rows, "subSize").is_some());
    let aggs = res.get("aggregations").cloned().unwrap_or(Value::Null);
    day.docs = total_hits(res);
    day.event_bytes = sum_of(&aggs, "ev", ev_on);
    day.sub_bytes = sum_of(&aggs, "sub", sub_on);

    // Per source, from the per-index buckets. An index with no bucket had no documents —
    // unless the terms agg ran out of room, and then it is not known.
    let idx = aggs.get("by_index").cloned().unwrap_or(Value::Null);
    let complete = idx.get("sum_other_doc_count").and_then(Value::as_u64).unwrap_or(0) == 0;
    let mut per: BTreeMap<String, (u64, Option<u64>, Option<u64>)> = BTreeMap::new();
    for b in idx.get("buckets").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = bucket_key(b) else { continue };
        let Some(src) = group.index_source.get(&name) else { continue };
        let e = per.entry(src.clone()).or_insert((0, ev_on.then_some(0), sub_on.then_some(0)));
        e.0 += b.get("doc_count").and_then(Value::as_u64).unwrap_or(0);
        if let (Some(t), Some(v)) = (e.1.as_mut(), sum_of(b, "ev", ev_on)) {
            *t += v;
        }
        if let (Some(t), Some(v)) = (e.2.as_mut(), sum_of(b, "sub", sub_on)) {
            *t += v;
        }
    }
    for (name, s) in day.sources.iter_mut() {
        match per.get(name) {
            Some((d, e, u)) => {
                s.docs = Some(*d);
                s.event_bytes = *e;
                s.sub_bytes = *u;
            }
            None if complete => {
                s.docs = Some(0);
                s.event_bytes = ev_on.then_some(0);
                s.sub_bytes = sub_on.then_some(0);
            }
            None => {
                s.docs = None;
                s.event_bytes = None;
                s.sub_bytes = None;
            }
        }
    }

    day.fields.clear();
    for key in FIELD_KEYS {
        let row = rows.iter().find(|r| r.key == key);
        let Some(field) = row.and_then(|r| r.resolved.clone()) else {
            day.fields.insert(key.into(), FieldAgg {
                error: Some(row.map(|r| r.note.clone()).unwrap_or_else(|| "not resolved".into())),
                ..FieldAgg::default()
            });
            continue;
        };
        let t = aggs.get(format!("f_{key}")).cloned().unwrap_or(Value::Null);
        let m = aggs.get(format!("m_{key}")).cloned().unwrap_or(Value::Null);
        let top: Vec<TopValue> = t.get("buckets").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|b| Some(TopValue {
                value: bucket_key(b)?,
                docs: b.get("doc_count").and_then(Value::as_u64).unwrap_or(0),
                event_bytes: sum_of(b, "ev", ev_on),
                sub_bytes: sum_of(b, "sub", sub_on),
            }))
            .collect();
        let missing_ev = sum_of(&m, "ev", ev_on);
        let missing_sub = sum_of(&m, "sub", sub_on);
        // "All others" is what the day measured less the top values and the missing ones.
        let rest = |total: Option<u64>, missing: Option<u64>, each: fn(&TopValue) -> Option<u64>| {
            let total = total?;
            let shown: u64 = top.iter().filter_map(each).sum::<u64>() + missing.unwrap_or(0);
            Some(total.saturating_sub(shown))
        };
        day.fields.insert(key.into(), FieldAgg {
            field: Some(field),
            error: None,
            other_docs: t.get("sum_other_doc_count").and_then(Value::as_u64).unwrap_or(0),
            missing_docs: m.get("doc_count").and_then(Value::as_u64).unwrap_or(0),
            other_event_bytes: rest(day.event_bytes, missing_ev, |v| v.event_bytes),
            missing_event_bytes: missing_ev,
            other_sub_bytes: rest(day.sub_bytes, missing_sub, |v| v.sub_bytes),
            missing_sub_bytes: missing_sub,
            top,
        });
    }
    day.aggregated_at = Some(now_ms);
    // An answer with failed shards or a time-out is not final, however old the day.
    let partial = partial_answer(res);
    day.is_final = partial.is_none() && parse_day(&day.day).is_some_and(|d| d < today);
    day.error = partial;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }

    #[test]
    fn index_format_glob_day_and_source() {
        let f = IndexFormat::new("logstash-*-YYYY.MM.DD").unwrap();
        assert_eq!(f.glob(), "logstash-*-*");
        assert_eq!(f.for_day(d("2026-10-20")), "logstash-*-2026.10.20");
        assert_eq!(f.parse("logstash-linux-2026.10.20"), Some((d("2026-10-20"), "linux".into())));
        // The source part may contain '-'.
        assert_eq!(f.parse("logstash-win-dc-01-2026.10.20"), Some((d("2026-10-20"), "win-dc-01".into())));
        // Not a day index, not a real date, no source.
        assert_eq!(f.parse("logstash-linux-2026.10"), None);
        assert_eq!(f.parse("logstash-linux-2026.09.31"), None);
        assert_eq!(f.parse("logstash--2026.10.20"), None);
        assert_eq!(f.parse("xlogstash-linux-2026.10.20"), None);
        // Regex characters in the literal part are literal.
        let g = IndexFormat::new("app.(x)-*-YYYY.MM.DD-000001").unwrap();
        assert_eq!(g.parse("app.(x)-web-2026.01.02-000001"), Some((d("2026-01-02"), "web".into())));
        assert_eq!(g.parse("appX(x)-web-2026.01.02-000001"), None);
        assert!(IndexFormat::new("logstash-YYYY.MM.DD").is_none());
    }

    fn cat() -> Value {
        json!([
            { "index": "logstash-linux-2026.10.20", "status": "open", "docs.count": "10", "pri.store.size": "1000", "store.size": "2000" },
            { "index": "logstash-win-dc-2026.10.20", "status": "open", "pri.store.size": "500", "store.size": "1000" },
            { "index": "logstash-linux-2026.10.21", "status": "close", "pri.store.size": null, "store.size": null },
            { "index": "logstash-linux-2026.10", "status": "open", "pri.store.size": "7", "store.size": "7" },
        ])
    }

    #[test]
    fn cat_groups_by_the_day_in_the_name() {
        let f = IndexFormat::new("logstash-*-YYYY.MM.DD").unwrap();
        let l = read_cat(&cat(), &f);
        assert_eq!(l.matched, 3);
        assert_eq!(l.skipped, vec!["logstash-linux-2026.10"]);
        let g = &l.days[&d("2026-10-20")];
        assert_eq!((g.indices, g.open, g.pri_bytes, g.total_bytes), (2, 2, 1500, 3000));
        assert_eq!(g.sources["win-dc"].pri_bytes, 500);
        let closed = &l.days[&d("2026-10-21")];
        assert_eq!((closed.indices, closed.open, closed.pri_bytes), (1, 0, 0));
    }

    #[test]
    fn totals_refresh_and_vanished_days_go_live_false_for_good() {
        let f = IndexFormat::new("logstash-*-YYYY.MM.DD").unwrap();
        let l = read_cat(&cat(), &f);
        let mut days = BTreeMap::new();
        days.insert("2026-10-05".to_string(), Day { day: "2026-10-05".into(), live: true, is_final: true, totals_at: 1,
                                                     pri_bytes: 42, docs: Some(9), ..Day::default() });
        assert!(apply_totals(&mut days, "2026-10", &l, 100));
        let gone = &days["2026-10-05"];
        assert!(!gone.live, "no indices any more");
        assert_eq!((gone.pri_bytes, gone.docs), (42, Some(9)), "the record is kept as it was");
        let d20 = &days["2026-10-20"];
        assert!(d20.live && !d20.is_final);
        assert_eq!((d20.indices, d20.pri_bytes, d20.total_bytes, d20.totals_at, d20.docs), (2, 1500, 3000, 100, None));

        // Reappearing indices do not bring a live:false day back.
        let mut back = l.clone();
        back.days.insert(d("2026-10-05"), DayGroup { indices: 1, open: 1, pri_bytes: 1, ..DayGroup::default() });
        apply_totals(&mut days, "2026-10", &back, 200);
        assert!(!days["2026-10-05"].live);
        assert_eq!(days["2026-10-05"].pri_bytes, 42);
        // Other months' days in the listing do not land in this month's file.
        assert!(days.keys().all(|k| k.starts_with("2026-10")));
    }

    fn fc() -> Value {
        json!({ "indices": ["logstash-linux-2026.10.20"], "fields": {
            "tag1": { "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } },
            "fwdtag": { "text": { "type": "text", "searchable": true, "aggregatable": false } },
            "fwdtag.keyword": { "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } },
            "src_hostname": { "text": { "type": "text", "searchable": true, "aggregatable": false } },
            "host.ip": { "ip": { "type": "ip", "searchable": true, "aggregatable": true } },
            "event_logsize": { "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } },
            "sub_size": { "long": { "type": "long", "searchable": true, "aggregatable": true } },
        } })
    }

    #[test]
    fn rows_resolve_left_to_right_text_to_keyword_sums_numeric() {
        let rows = resolve_rows(&fc(), &VolumeSettings::default());
        let get = |k: &str| rows.iter().find(|r| r.key == k).unwrap().clone();
        assert_eq!(get("tag").resolved.as_deref(), Some("tag1"));
        let fwd = get("forwarder");
        assert_eq!(fwd.resolved.as_deref(), Some("fwdtag.keyword"), "fwd_tag is unknown, fwdtag is text with a keyword");
        assert!(fwd.note.contains("using fwdtag.keyword"), "{}", fwd.note);
        let host = get("sourceHost");
        assert_eq!(host.resolved, None, "text without .keyword, and host.name is not mapped");
        assert!(host.note.contains("src_hostname: text with no .keyword") && host.note.contains("host.name: not in the mapping"), "{}", host.note);
        assert_eq!(get("sourceIp").resolved.as_deref(), Some("host.ip"));
        assert_eq!(get("sourceIp").kind.as_deref(), Some("ip"));
        let ev = get("eventSize");
        assert_eq!(ev.resolved, None, "a keyword is not a number to sum");
        assert!(ev.note.contains("not numeric"), "{}", ev.note);
        assert_eq!(get("subSize").resolved.as_deref(), Some("sub_size"));
        assert_eq!(get("extra").resolved, None);
        assert!(field_caps_fields(&VolumeSettings::default()).contains(&"src_hostname.keyword".to_string()));
    }

    #[test]
    fn the_search_body_has_the_contract_shape_and_leaves_out_what_did_not_resolve() {
        let rows = resolve_rows(&fc(), &VolumeSettings::default());
        let b = search_body(&rows, 25);
        assert_eq!(b["size"], 0);
        assert_eq!(b["track_total_hits"], true);
        let a = &b["aggs"];
        assert!(a.get("ev").is_none(), "eventSize did not resolve: no ev agg anywhere");
        assert_eq!(a["sub"], json!({ "sum": { "field": "sub_size" } }));
        assert_eq!(a["by_index"]["terms"], json!({ "field": "_index", "size": 1000 }));
        assert_eq!(a["by_index"]["aggs"], json!({ "sub": { "sum": { "field": "sub_size" } } }));
        assert_eq!(a["f_tag"]["terms"], json!({ "field": "tag1", "size": 25 }));
        assert_eq!(a["m_tag"]["missing"], json!({ "field": "tag1" }));
        assert_eq!(a["f_forwarder"]["terms"]["field"], "fwdtag.keyword");
        assert!(a.get("f_sourceHost").is_none() && a.get("m_sourceHost").is_none());
        assert!(a.get("f_extra").is_none());
    }

    #[test]
    fn a_search_answer_lands_in_its_day() {
        let f = IndexFormat::new("logstash-*-YYYY.MM.DD").unwrap();
        let l = read_cat(&cat(), &f);
        let mut days = BTreeMap::new();
        apply_totals(&mut days, "2026-10", &l, 1);
        let mut rows = resolve_rows(&fc(), &VolumeSettings::default());
        // Make eventSize resolve too, to see both sums.
        rows.iter_mut().find(|r| r.key == "eventSize").unwrap().resolved = Some("event_logsize".into());
        let res = json!({ "hits": { "total": { "value": 100, "relation": "eq" } }, "aggregations": {
            "ev": { "value": 5000.0 }, "sub": { "value": 300.0 },
            "by_index": { "sum_other_doc_count": 0, "buckets": [
                { "key": "logstash-linux-2026.10.20", "doc_count": 80, "ev": { "value": 4000.0 }, "sub": { "value": 200.0 } },
                { "key": "logstash-win-dc-2026.10.20", "doc_count": 20, "ev": { "value": 1000.0 }, "sub": { "value": 100.0 } },
            ] },
            "f_tag": { "sum_other_doc_count": 10, "buckets": [
                { "key": "fw", "doc_count": 60, "ev": { "value": 3000.0 }, "sub": { "value": 100.0 } },
                { "key": "proxy", "doc_count": 20, "ev": { "value": 1000.0 }, "sub": { "value": 50.0 } },
            ] },
            "m_tag": { "doc_count": 10, "ev": { "value": 500.0 }, "sub": { "value": 0.0 } },
        } });
        let day = days.get_mut("2026-10-20").unwrap();
        apply_search(day, &res, &rows, &l.days[&d("2026-10-20")], d("2026-10-29"), 50);
        assert_eq!((day.docs, day.event_bytes, day.sub_bytes), (Some(100), Some(5000), Some(300)));
        assert!(day.is_final, "before today: final");
        assert_eq!(day.sources["linux"].docs, Some(80));
        assert_eq!(day.sources["win-dc"].event_bytes, Some(1000));
        let tag = &day.fields["tag"];
        assert_eq!(tag.top[0], TopValue { value: "fw".into(), docs: 60, event_bytes: Some(3000), sub_bytes: Some(100) });
        assert_eq!((tag.other_docs, tag.missing_docs), (10, 10));
        assert_eq!(tag.other_event_bytes, Some(500), "5000 - 3000 - 1000 - 500 missing");
        assert_eq!(tag.missing_event_bytes, Some(500));
        assert!(day.fields["sourceHost"].error.is_some(), "unresolved rows carry an error, never 0");
        assert_eq!(day.fields["sourceHost"].field, None);

        // Today: never final.
        let mut today = Day { day: "2026-10-29".into(), live: true, ..Day::default() };
        apply_search(&mut today, &res, &rows, &DayGroup::default(), d("2026-10-29"), 50);
        assert!(!today.is_final);
        assert!(needs_search(&today, Some(&DayGroup { open: 1, ..DayGroup::default() })));
        assert!(!needs_search(day, Some(&DayGroup { open: 1, ..DayGroup::default() })), "final days are not asked again");
        assert!(!needs_search(&today, Some(&DayGroup { open: 0, indices: 1, ..DayGroup::default() })), "only closed indices");
    }

    /// A past day that stays unfinished is asked again while its indices are live, and its
    /// `error` says why it is not final.
    #[test]
    fn an_unfinished_past_day_is_asked_again_and_says_why() {
        let rows = resolve_rows(&json!({ "fields": {} }), &VolumeSettings::default());
        let today = d("2026-10-29");
        let open = DayGroup { indices: 2, open: 2, ..DayGroup::default() };
        // Shards failed: the figures are kept, the day is not final and is searched again.
        let mut day = Day { day: "2026-10-20".into(), live: true, ..Day::default() };
        let partial = json!({ "_shards": { "total": 4, "successful": 3, "failed": 1,
                                           "failures": [{ "reason": { "type": "x", "reason": "node left" } }] },
                              "hits": { "total": { "value": 7 } }, "aggregations": {} });
        apply_search(&mut day, &partial, &rows, &open, today, 1);
        assert_eq!(day.docs, Some(7));
        assert!(!day.is_final, "a partial answer is not final");
        assert!(day.error.as_deref().unwrap().starts_with("1 of 4 shards failed (node left)"), "{:?}", day.error);
        assert!(needs_search(&day, Some(&open)), "asked again on the next run");
        let timed = json!({ "timed_out": true, "hits": { "total": { "value": 7 } } });
        apply_search(&mut day, &timed, &rows, &open, today, 2);
        assert!(!day.is_final && day.error.as_deref().unwrap().contains("timed out"));
        // A whole answer later makes it final and clears the error.
        apply_search(&mut day, &json!({ "_shards": { "total": 4, "failed": 0 }, "hits": { "total": { "value": 9 } } }), &rows, &open, today, 3);
        assert!(day.is_final && day.error.is_none());

        // Closed indices: not searched, and says so; open again, searched again.
        let closed = DayGroup { indices: 1, open: 0, ..DayGroup::default() };
        let waiting = Day { day: "2026-10-21".into(), live: true, ..Day::default() };
        assert!(!needs_search(&waiting, Some(&closed)));
        assert!(not_searched_why(&waiting, Some(&closed), today).unwrap().contains("1 of its indices is closed"));
        assert!(needs_search(&waiting, Some(&DayGroup { indices: 1, open: 1, ..DayGroup::default() })));
        assert_eq!(not_searched_why(&waiting, Some(&closed), d("2026-10-21")), None, "today is not past");
        assert_eq!(not_searched_why(&day, Some(&closed), today), None, "a final day needs no reason");

        // Indices gone before the day was final: live false for good, and the error says so.
        let mut days = BTreeMap::new();
        days.insert("2026-10-22".to_string(), Day { day: "2026-10-22".into(), live: true, totals_at: 1, aggregated_at: Some(1), ..Day::default() });
        days.insert("2026-10-23".to_string(), Day { day: "2026-10-23".into(), live: true, totals_at: 1, ..Day::default() });
        apply_totals(&mut days, "2026-10", &Listing::default(), 5);
        assert!(days["2026-10-22"].error.as_deref().unwrap().contains("last ones measured"));
        assert!(days["2026-10-23"].error.as_deref().unwrap().contains("only the sizes"));
    }

    #[test]
    fn no_event_field_means_null_not_zero() {
        let rows = resolve_rows(&json!({ "fields": {} }), &VolumeSettings::default());
        let mut day = Day { day: "2026-10-20".into(), live: true, ..Day::default() };
        day.sources.insert("linux".into(), SourceTotals::default());
        let res = json!({ "hits": { "total": { "value": 7 } }, "aggregations": { "by_index": { "buckets": [] } } });
        apply_search(&mut day, &res, &rows, &DayGroup::default(), d("2026-10-29"), 1);
        assert_eq!(day.docs, Some(7));
        assert_eq!(day.event_bytes, None);
        assert_eq!(day.sub_bytes, None);
        assert_eq!(day.sources["linux"].docs, Some(0));
        assert_eq!(day.sources["linux"].event_bytes, None);
    }
}
