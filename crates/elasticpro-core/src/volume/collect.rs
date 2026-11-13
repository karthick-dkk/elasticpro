//! The requests a run sends, and what their answers do to the record.
//!
//! Pure: requests are built and responses read here, sent elsewhere (`run`). Each rule in
//! docs/VOLUME.md "Collection" is one function, so each is tested on its own.
//!
//! Which indices count and on which day (docs/VOLUME.md "What counts") is `Indices`: the
//! legacy `indexFormat` or the `indexPattern`, and `dayFrom`. An index is either *dated*
//! (its name carries the day: it counts on that day in full, sizes from `_cat/indices`) or
//! *split by time* (its documents are counted per UTC day of the time field; its size per
//! day is not measured).

use super::schedule::{day_key, parse_day};
use super::settings::{DayFrom, PatternSource, VolumeSettings};
use super::{Day, FieldAgg, SourceTotals, TopValue, FIELD_KEYS};
use crate::http::EsRequest;
use chrono::{Duration, NaiveDate};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

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

/// The date an index name carries: the first `YYYY.MM.DD` that is a real date and is not
/// part of a longer run of digits, with the bytes it covers. `logstash-linux-2026.10.20`
/// and `.ds-logs-app-2026.10.20-000001` carry one; `logstash-linux-2026.10`,
/// `app-2026.09.31` and `x-12026.10.20` do not.
pub fn name_date(name: &str) -> Option<(NaiveDate, Range<usize>)> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(\d{4})\.(\d{2})\.(\d{2})").expect("a fixed regex"));
    let digit_at = |i: usize| name.as_bytes().get(i).is_some_and(u8::is_ascii_digit);
    for c in re.captures_iter(name) {
        let m = c.get(0)?;
        if (m.start() > 0 && digit_at(m.start() - 1)) || digit_at(m.end()) {
            continue;
        }
        let num = |i: usize| c.get(i).and_then(|g| g.as_str().parse::<u32>().ok());
        if let Some(d) = NaiveDate::from_ymd_opt(num(1)? as i32, num(2)?, num(3)?) {
            return Some((d, m.range()));
        }
    }
    None
}

/// An `indexPattern`, compiled: one or more comma-separated patterns, as Elasticsearch
/// takes them in a path. No date part: the day comes from each index's name or time field.
#[derive(Clone, Debug)]
pub struct IndexPattern {
    patterns: Vec<String>,
}

impl IndexPattern {
    pub fn new(p: &str) -> Option<IndexPattern> {
        if super::settings::index_pattern_problem(p).is_some() {
            return None;
        }
        Some(IndexPattern { patterns: super::settings::split_patterns(p) })
    }

    /// The patterns as one index expression, for `_cat`, `_field_caps` and the searches.
    pub fn expr(&self) -> String {
        self.patterns.join(",")
    }

    /// An index's source: its name without the date, a data stream's `.ds-` and rollover
    /// generation, and the literal start of the pattern that names it (`logstash-*` →
    /// `logstash-`); `logstash-linux-2026.10.20` is `linux`, as under the legacy format.
    /// What is left of a name the pattern names whole is the name itself.
    pub fn source(&self, name: &str, date: Option<Range<usize>>) -> String {
        let mut s = name.to_string();
        if let Some(r) = date {
            s.replace_range(r, "");
        }
        let mut s: &str = s.strip_prefix(".ds-").unwrap_or(&s);
        let b = s.as_bytes();
        if b.len() >= 7 && b[b.len() - 7] == b'-' && b[b.len() - 6..].iter().all(u8::is_ascii_digit) {
            s = &s[..s.len() - 7];
        }
        let prefix = self.patterns.iter().filter(|p| !p.starts_with('-'))
            .filter_map(|p| p.find('*').map(|i| &p[..i]))
            .filter(|p| !p.is_empty() && s.starts_with(*p))
            .max_by_key(|p| p.len());
        if let Some(p) = prefix {
            s = &s[p.len()..];
        }
        // A date taken out of the middle leaves two separators side by side.
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            let sep = matches!(c, '-' | '_' | '.');
            if !(sep && out.ends_with(['-', '_', '.'])) {
                out.push(c);
            }
        }
        let out = out.trim_matches(['-', '_', '.']);
        if out.is_empty() { name.to_string() } else { out.to_string() }
    }
}

/// How the indices are named: the legacy format, or a pattern.
#[derive(Clone, Debug)]
pub enum Naming {
    Format(IndexFormat),
    Pattern(IndexPattern),
}

/// Where one index counts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Placement {
    /// On the day its name carries, in full.
    Dated(NaiveDate, String),
    /// Split into days by its documents' time field: the source.
    TimeSplit(String),
    /// Not counted (its name does not fit the legacy format).
    Skipped,
}

/// Which indices count and on which day: docs/VOLUME.md "What counts", one definition for
/// the collector, the field check and the pattern preview.
#[derive(Clone, Debug)]
pub struct Indices {
    pub naming: Naming,
    pub day_from: DayFrom,
    pub time_field: String,
}

impl Indices {
    /// From the settings: the legacy `indexFormat` when it is in force
    /// (`pattern_source: Format`), else the `indexPattern`.
    pub fn from_settings(s: &VolumeSettings) -> Result<Indices, &'static str> {
        let naming = match s.pattern_source {
            PatternSource::Format => Naming::Format(IndexFormat::new(&s.index_format).ok_or("indexFormat cannot be used")?),
            PatternSource::Pattern | PatternSource::Default => {
                Naming::Pattern(IndexPattern::new(&s.index_pattern).ok_or("indexPattern cannot be used")?)
            }
        };
        Ok(Indices { naming, day_from: s.day_from, time_field: s.time_field.clone() })
    }

    /// The index expression every request names.
    pub fn expr(&self) -> String {
        match &self.naming {
            Naming::Format(f) => f.glob(),
            Naming::Pattern(p) => p.expr(),
        }
    }

    pub fn place(&self, name: &str) -> Placement {
        match &self.naming {
            Naming::Format(f) => match f.parse(name) {
                None => Placement::Skipped,
                Some((_, src)) if self.day_from == DayFrom::Time => Placement::TimeSplit(src),
                Some((d, src)) => Placement::Dated(d, src),
            },
            Naming::Pattern(p) => match (self.day_from, name_date(name)) {
                (DayFrom::Name, Some((d, r))) => Placement::Dated(d, p.source(name, Some(r))),
                (_, date) => Placement::TimeSplit(p.source(name, date.map(|(_, r)| r))),
            },
        }
    }

    /// The day an index's name carries under the naming rule, and its source — whatever
    /// `dayFrom` says about counting its documents. The indices report lists an index on
    /// that day (docs/REPORT-TYPES.md "Indices report"); `None` for a name with no date
    /// (or, under the legacy format, one that does not fit it).
    pub fn name_day(&self, name: &str) -> Option<(NaiveDate, String)> {
        match &self.naming {
            Naming::Format(f) => f.parse(name),
            Naming::Pattern(p) => name_date(name).map(|(d, r)| (d, p.source(name, Some(r)))),
        }
    }

    /// An index's source (its name less its date), for any index the pattern lists: the
    /// hosts report's `Source` column, one definition with the record's sources.
    pub fn source_of(&self, name: &str) -> String {
        match self.place(name) {
            Placement::Dated(_, s) | Placement::TimeSplit(s) => s,
            Placement::Skipped => name.to_string(),
        }
    }

    /// The legacy format with days from the names: the requests are the ones before
    /// 0.3.53, byte for byte (a day's search names that day's indices by name).
    fn legacy_format(&self) -> Option<&IndexFormat> {
        match &self.naming {
            Naming::Format(f) if self.day_from == DayFrom::Name => Some(f),
            _ => None,
        }
    }
}

/* ------------------------------------ requests ------------------------------------ */

/// How long one aggregation over a day's documents (the per-day search, the time split's
/// histogram) may take. A big day behind a jump host takes a minute and more; at the 60 s the
/// listing has, such a day failed on every run ("asked again on the next run") and Collect now
/// never got past it. Under the gate's ceiling (`ELASTICPRO_ES_MAX_TIMEOUT_MS`, 115 s), which
/// still clamps it.
pub const SEARCH_TIMEOUT_MS: u64 = 110_000;

/// The waits before the second and the third try of a request that timed out or that a
/// proxy turned away (`retryable`). Three tries in all; the stop and a person's cancel are
/// asked before each.
pub const RETRY_WAITS_MS: [u64; 2] = [3_000, 10_000];

/// Whether a failed answer may come out differently if asked again shortly: no answer in
/// time, or a proxy or jump host between us and the cluster turning it away (502, 503, 504).
/// Not a 429 or a full search queue: that is the cluster saying it is busy, and a busy
/// cluster's run is deferred until it eases (docs/JOBS.md "Busy clusters"), not pressed
/// again. Nor anything else — a bad request, a refusal, an unknown index will not pass.
pub fn retryable(res: &Value) -> bool {
    if res.get("ok").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let kind = res.get("kind").and_then(Value::as_str).unwrap_or("");
    let status = res.get("status").and_then(Value::as_u64).unwrap_or(0);
    kind == "timeout" || matches!(status, 502..=504)
}

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

pub fn cat_request(cluster: &str, ind: &Indices) -> EsRequest {
    req(cluster, "GET", format!(
        "/_cat/indices/{}?format=json&bytes=b&h=index,status,docs.count,pri.store.size,store.size", ind.expr()
    ), None)
}

/// The pattern preview's one request: names only.
pub fn cat_names_request(cluster: &str, ind: &Indices) -> EsRequest {
    req(cluster, "GET", format!("/_cat/indices/{}?format=json&h=index", ind.expr()), None)
}

/// A `_cat/indices` answer's rows. Elasticsearch answers a pattern that names an index
/// outright, and finds none, with 404 `index_not_found_exception`: that is an empty
/// listing, not a failure.
pub fn cat_rows(res: &Value) -> Option<Value> {
    if res.get("ok").and_then(Value::as_bool) == Some(true) {
        return Some(res.get("json").cloned().unwrap_or(Value::Null));
    }
    let not_found = res.get("status").and_then(Value::as_u64) == Some(404)
        && res.pointer("/json/error/type").and_then(Value::as_str) == Some("index_not_found_exception");
    not_found.then(|| json!([]))
}

/// Every name any row may resolve to, and each one's `.keyword`; and the time field when
/// some index is split by time.
pub fn field_caps_fields(s: &VolumeSettings, time: bool) -> Vec<String> {
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
    if time && !out.contains(&s.time_field) {
        out.push(s.time_field.clone());
    }
    out
}

pub fn field_caps_request(cluster: &str, ind: &Indices, s: &VolumeSettings, time: bool) -> EsRequest {
    req(cluster, "GET", format!(
        "/{}/_field_caps?fields={}&ignore_unavailable=true", ind.expr(), field_caps_fields(s, time).join(",")
    ), None)
}

pub const SEARCH_QS: &str = "_search?ignore_unavailable=true&allow_no_indices=true";

/// The time field between the start of `from` and the end of `to`, UTC days: exactly the
/// buckets of a `date_histogram` with `calendar_interval: 1d` in UTC. One definition for
/// the histogram that finds the days and the search that counts each one.
pub fn utc_days_range(time_field: &str, from: NaiveDate, to: NaiveDate) -> Value {
    let mut r = Map::new();
    r.insert(time_field.into(), json!({ "gte": day_key(from), "lt": day_key(to + Duration::days(1)),
                                         "format": "yyyy-MM-dd", "time_zone": "UTC" }));
    json!({ "range": r })
}

/// The one search per run that finds which UTC days the time-split indices have documents
/// on, between `from` and `to`.
pub fn histogram_request(cluster: &str, ind: &Indices, split: &[String], from: NaiveDate, to: NaiveDate) -> EsRequest {
    let body = json!({
        "size": 0, "track_total_hits": false,
        "query": { "bool": { "filter": [ { "terms": { "_index": split } }, utc_days_range(&ind.time_field, from, to) ] } },
        "aggs": { "days": { "date_histogram": { "field": ind.time_field, "calendar_interval": "1d", "time_zone": "UTC",
                                                "min_doc_count": 1, "format": "yyyy-MM-dd" } } },
    });
    let mut r = req(cluster, "POST", format!("/{}/{SEARCH_QS}", ind.expr()), Some(body.to_string()));
    r.timeout_ms = Some(SEARCH_TIMEOUT_MS);
    r
}

/// The days a histogram answer has documents on.
pub fn read_histogram(res: &Value) -> BTreeSet<NaiveDate> {
    res.pointer("/aggregations/days/buckets").and_then(Value::as_array).into_iter().flatten()
        .filter(|b| b.get("doc_count").and_then(Value::as_u64).unwrap_or(0) > 0)
        .filter_map(|b| {
            let s = b.get("key_as_string").and_then(Value::as_str)?;
            parse_day(s.get(..10)?)
        })
        .collect()
}

/// What one day's search covers: the indices dated on it (in full) and the time-split
/// indices (their documents on that UTC day).
pub fn day_query(dated: &[&str], split: &[&str], time_field: &str, d: NaiveDate) -> Value {
    let split_part = || json!({ "bool": { "filter": [ { "terms": { "_index": split } }, utc_days_range(time_field, d, d) ] } });
    match (dated.is_empty(), split.is_empty()) {
        (false, true) => json!({ "terms": { "_index": dated } }),
        (true, false) => split_part(),
        (false, false) => json!({ "bool": { "should": [ { "terms": { "_index": dated } }, split_part() ], "minimum_should_match": 1 } }),
        (true, true) => json!({ "match_none": {} }),
    }
}

/// One day's search. Under the legacy format with days from the names it names the day's
/// indices in the path (`logstash-*-2026.10.20`), as it always has; otherwise it names the
/// pattern and says in the query which indices, and for the time-split ones which day.
pub fn search_request(cluster: &str, ind: &Indices, d: NaiveDate, group: &DayGroup, body: &Value) -> EsRequest {
    let mut r = if let (Some(f), true) = (ind.legacy_format(), group.time_split.is_empty()) {
        req(cluster, "POST", format!("/{}/{SEARCH_QS}", f.for_day(d)), Some(body.to_string()))
    } else {
        let dated: Vec<&str> = group.index_source.keys().map(String::as_str).collect();
        let split: Vec<&str> = group.time_split.keys().map(String::as_str).collect();
        let mut b = body.clone();
        b["query"] = day_query(&dated, &split, &ind.time_field, d);
        req(cluster, "POST", format!("/{}/{SEARCH_QS}", ind.expr()), Some(b.to_string()))
    };
    r.timeout_ms = Some(SEARCH_TIMEOUT_MS);
    r
}

/* ------------------------------------ _cat/indices ------------------------------------ */

/// One day's indices dated by name, from `_cat`. For a search, `time_split` and
/// `split_missing` say what of the time-split indices it covers (`Listing::group_for`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DayGroup {
    pub indices: u64,
    pub open: u64,
    pub pri_bytes: u64,
    pub total_bytes: u64,
    pub sources: BTreeMap<String, SourceTotals>,
    /// index name → source, to read `by_index` back into sources.
    pub index_source: BTreeMap<String, String>,
    /// The open time-split indices this day's search counts (name → source).
    pub time_split: BTreeMap<String, String>,
    /// Why the time-split part of this day is not measured this run, when it is not.
    pub split_missing: Option<String>,
}

/// One index split into days by its time field.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SplitIndex {
    pub source: String,
    pub open: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Listing {
    pub days: BTreeMap<NaiveDate, DayGroup>,
    pub matched: u64,
    /// Indices the glob found whose names do not fit the format. Capped: a pattern that
    /// catches a few thousand monthly indices should not make the reply that size.
    pub skipped: Vec<String>,
    pub skipped_count: u64,
    /// Indices split into days by time, by name.
    pub time_split: BTreeMap<String, SplitIndex>,
}

impl Listing {
    /// The open time-split indices: the ones a search can count.
    pub fn split_open(&self) -> Vec<String> {
        self.time_split.iter().filter(|(_, i)| i.open).map(|(n, _)| n.clone()).collect()
    }

    pub fn split_closed(&self) -> usize {
        self.time_split.values().filter(|i| !i.open).count()
    }

    /// Indices dated by name.
    pub fn dated(&self) -> u64 {
        self.days.values().map(|g| g.indices).sum()
    }

    /// What one day's search covers: its dated indices, and every open time-split index
    /// when the split is known (`Split::Known`) — else the reason it is not measured.
    pub fn group_for(&self, d: NaiveDate, split: &Split) -> DayGroup {
        let mut g = self.days.get(&d).cloned().unwrap_or_default();
        match split {
            Split::None => {}
            Split::Known { .. } => {
                g.time_split = self.time_split.iter().filter(|(_, i)| i.open).map(|(n, i)| (n.clone(), i.source.clone())).collect();
            }
            Split::Unknown(why) => g.split_missing = Some(why.clone()),
        }
        g
    }
}

/// What this run knows about the days the time-split indices have documents on.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Split {
    /// No index is split by time.
    #[default]
    None,
    /// From the histogram. `complete`: no time-split index is closed, so a day missing here
    /// has no time-split documents.
    Known { days: BTreeSet<NaiveDate>, complete: bool },
    /// Not worked out this run (the time field is not a date, a request failed): why.
    Unknown(String),
}

impl Split {
    pub fn has(&self, d: NaiveDate) -> bool {
        matches!(self, Split::Known { days, .. } if days.contains(&d))
    }

    /// A day missing from this split may still have time-split documents.
    pub fn uncertain(&self) -> bool {
        matches!(self, Split::Unknown(_) | Split::Known { complete: false, .. })
    }

    pub fn days(&self) -> impl Iterator<Item = &NaiveDate> {
        match self {
            Split::Known { days, .. } => Some(days.iter()),
            _ => None,
        }.into_iter().flatten()
    }
}

/// The kept day had time-split documents (or has nothing dated: it can only have come
/// from the split).
fn has_time_split(day: &Day) -> bool {
    day.unmeasured_size_indices > 0 || day.pri_bytes.is_none()
}

pub const SKIPPED_KEEP: usize = 500;

fn bytes(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

/// Group a `_cat/indices?format=json&bytes=b` answer by the day in each name; an index that
/// is split by time is listed apart. A closed index counts as an index of its day, with no
/// size (`_cat` reports none for it).
pub fn read_cat(rows: &Value, ind: &Indices) -> Listing {
    let mut out = Listing::default();
    for r in rows.as_array().into_iter().flatten() {
        let Some(name) = r.get("index").and_then(Value::as_str) else { continue };
        let open = r.get("status").and_then(Value::as_str).is_none_or(|s| s == "open");
        let (day, source) = match ind.place(name) {
            Placement::Skipped => {
                out.skipped_count += 1;
                if out.skipped.len() < SKIPPED_KEEP {
                    out.skipped.push(name.to_string());
                }
                continue;
            }
            Placement::TimeSplit(source) => {
                out.matched += 1;
                out.time_split.insert(name.to_string(), SplitIndex { source, open });
                continue;
            }
            Placement::Dated(day, source) => (day, source),
        };
        out.matched += 1;
        let (pri, total) = (bytes(r.get("pri.store.size")), bytes(r.get("store.size")));
        let g = out.days.entry(day).or_default();
        g.indices += 1;
        g.open += open as u64;
        g.pri_bytes += pri;
        g.total_bytes += total;
        let s = g.sources.entry(source.clone()).or_default();
        s.indices += 1;
        s.pri_bytes = Some(s.pri_bytes.unwrap_or(0) + pri);
        s.total_bytes = Some(s.total_bytes.unwrap_or(0) + total);
        g.index_source.insert(name.to_string(), source);
    }
    out.skipped.sort();
    out
}

/// Refresh one month's days from a listing and the time split. Every day that still has
/// indices — dated by name, or time-split documents on it — gets its totals, sources and
/// `live: true`; a kept day that has none any more becomes `live: false` and is never
/// changed again (that includes a later reappearance: the record does not guess whether a
/// restored index is the same data). While the split is uncertain (`Split::uncertain`) a
/// day that had time-split documents is not taken for gone.
///
/// The size is the dated indices' (`None` when the day has none); the time-split part keeps
/// what its last search counted (`unmeasured_size_indices`, per source too) until the next.
///
/// Days outside `[oldest, ..)` are left alone; the caller prunes those.
pub fn apply_totals(days: &mut BTreeMap<String, Day>, month: &str, listing: &Listing, split: &Split, now_ms: i64) -> bool {
    let mut changed = false;
    let here: BTreeSet<NaiveDate> = listing.days.keys().chain(split.days()).copied()
        .filter(|d| super::schedule::month_key(*d) == month).collect();
    for d in here {
        let key = day_key(d);
        let day = days.entry(key.clone()).or_insert_with(|| Day { day: key, live: true, ..Day::default() });
        if !day.live && day.totals_at > 0 {
            continue;
        }
        let g = listing.days.get(&d);
        day.live = true;
        day.totals_at = now_ms;
        day.indices = g.map_or(0, |g| g.indices) + day.unmeasured_size_indices;
        day.pri_bytes = g.map(|g| g.pri_bytes);
        day.total_bytes = g.map(|g| g.total_bytes);
        // Sizes come from _cat every run; what the search measured per source stays until
        // the day is aggregated again. A source that is gone from the day goes.
        let mut old = std::mem::take(&mut day.sources);
        for (name, s) in g.map(|g| &g.sources).into_iter().flatten() {
            let prev = old.remove(name);
            let prev = prev.as_ref();
            let split_n = prev.map_or(0, |p| p.unmeasured_size_indices);
            day.sources.insert(name.clone(), SourceTotals {
                indices: s.indices + split_n, pri_bytes: s.pri_bytes, total_bytes: s.total_bytes,
                docs: prev.and_then(|p| p.docs), event_bytes: prev.and_then(|p| p.event_bytes),
                sub_bytes: prev.and_then(|p| p.sub_bytes), unmeasured_size_indices: split_n,
            });
        }
        // A source that only had time-split documents: no size, and its counts as searched.
        for (name, p) in old.into_iter().filter(|(_, p)| p.unmeasured_size_indices > 0) {
            day.sources.insert(name, SourceTotals { indices: p.unmeasured_size_indices, pri_bytes: None, total_bytes: None, ..p });
        }
        changed = true;
    }
    for (key, day) in days.iter_mut() {
        let present = parse_day(key).is_some_and(|d| {
            listing.days.contains_key(&d) || split.has(d) || (split.uncertain() && has_time_split(day))
        });
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

/// Whether a day is to be searched this run: live, with an open index dated on it or
/// time-split documents on it (`in_split`), and not yet aggregated as final. Today is
/// never final, so it is searched every run.
pub fn needs_search(day: &Day, group: Option<&DayGroup>, in_split: bool) -> bool {
    day.live && !day.is_final && (in_split || group.is_some_and(|g| g.open > 0))
}

/// Why a past day that is not final is not searched this run, as its `error` says it —
/// `None` when it is final, or is searched (`needs_search`), or is today. A day whose
/// indices are all closed is asked again on the first run that finds one open; a day whose
/// indices are gone keeps what was last measured (`apply_totals` says so when it goes).
///
/// A day with time-split documents that this run's split does not show: the split could
/// not be worked out (its reason), or some time-split indices are closed.
pub fn not_searched_why(day: &Day, group: Option<&DayGroup>, split: &Split, today: NaiveDate) -> Option<String> {
    let date = parse_day(&day.day).filter(|d| *d < today)?;
    if day.is_final || !day.live || split.has(date) {
        return None;
    }
    match (group, split) {
        (Some(g), _) if g.open == 0 => Some(format!(
            "not aggregated: {} of its indices {} closed; asked again on a later run while they are open",
            g.indices, if g.indices == 1 { "is" } else { "are" })),
        (None, Split::Unknown(why)) if has_time_split(day) => Some(format!("not aggregated: {why}; asked again on the next run")),
        (None, Split::Known { complete: false, .. }) if has_time_split(day) => Some(
            "not aggregated: some of the indices split by time are closed; asked again on a later run while they are open".into()),
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
    FIELD_KEYS.iter().chain(["eventSize", "subSize"].iter())
        .map(|key| resolve_row(fc, key, s.row(key), matches!(*key, "eventSize" | "subSize")))
        .collect()
}

/// One row against a `_field_caps` answer, under `resolve_rows`'s rule. The hosts report's
/// metadata fields resolve through this too (`report::hosts`): one rule for every field.
pub fn resolve_row(fc: &Value, key: &str, tried: &[String], sum: bool) -> RowResolution {
    let mut row = RowResolution { key: key.to_string(), tried: tried.to_vec(), ..Default::default() };
    let mut why: Vec<String> = vec![];
    for name in tried {
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
    row
}

/// The time field against a `_field_caps` answer: its type when it is a date (`date`,
/// `date_nanos`), else why it cannot split anything into days. An unmapped time field
/// would make the histogram find no day at all — every time-split day would look gone —
/// so nothing is split until it is a date.
pub fn resolve_time_field(fc: &Value, field: &str) -> Result<String, String> {
    match caps(fc, field) {
        None => Err(format!("the time field {field} is not in the mapping")),
        Some((types, _)) if types.iter().all(|t| matches!(*t, "date" | "date_nanos")) => Ok(types.join(",")),
        Some((types, _)) => Err(format!("the time field {field} is {}, not a date", types.join(","))),
    }
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
/// UTC date is done, and is never asked again — unless the time-split part of it was not
/// measured (`group.split_missing`).
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
    // Per source: docs, event bytes, sub size, and time-split indices with documents.
    let mut per: BTreeMap<String, (u64, Option<u64>, Option<u64>, u64)> = BTreeMap::new();
    for b in idx.get("buckets").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = bucket_key(b) else { continue };
        let docs = b.get("doc_count").and_then(Value::as_u64).unwrap_or(0);
        let (src, split) = match (group.index_source.get(&name), group.time_split.get(&name)) {
            (Some(s), _) => (s, false),
            (None, Some(s)) => (s, true),
            (None, None) => continue,
        };
        let e = per.entry(src.clone()).or_insert((0, ev_on.then_some(0), sub_on.then_some(0), 0));
        e.0 += docs;
        e.3 += (split && docs > 0) as u64;
        if let (Some(t), Some(v)) = (e.1.as_mut(), sum_of(b, "ev", ev_on)) {
            *t += v;
        }
        if let (Some(t), Some(v)) = (e.2.as_mut(), sum_of(b, "sub", sub_on)) {
            *t += v;
        }
    }
    // The time-split part: how many of its indices count on the day, and their sources. Not
    // counted this run (`split_missing`): what the last count said stands, and the day is
    // not final (below).
    let counted = group.split_missing.is_none();
    if counted {
        day.unmeasured_size_indices = per.values().map(|e| e.3).sum();
        for name in per.iter().filter(|(_, e)| e.3 > 0).map(|(n, _)| n) {
            day.sources.entry(name.clone()).or_default();
        }
        // A source that had only time-split documents, and none on this day, goes.
        day.sources.retain(|name, s| {
            let only_split = s.pri_bytes.is_none() && s.unmeasured_size_indices > 0;
            !only_split || group.sources.contains_key(name) || per.get(name).is_some_and(|e| e.3 > 0) || !complete
        });
    }
    day.indices = group.indices + day.unmeasured_size_indices;
    for (name, s) in day.sources.iter_mut() {
        let dated = group.sources.get(name);
        if counted {
            s.unmeasured_size_indices = per.get(name).map_or(0, |e| e.3);
        }
        // Only what this search covers is rewritten; a dated source it does not know keeps
        // the sizes `_cat` gave it.
        if dated.is_some() || s.unmeasured_size_indices > 0 {
            s.indices = dated.map_or(0, |d| d.indices) + s.unmeasured_size_indices;
            s.pri_bytes = dated.and_then(|d| d.pri_bytes);
            s.total_bytes = dated.and_then(|d| d.total_bytes);
        }
    }
    for (name, s) in day.sources.iter_mut() {
        match per.get(name) {
            Some((d, e, u, _)) => {
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
    // An answer with failed shards or a time-out is not final, however old the day; nor is
    // one that could not count the time-split part.
    let partial = partial_answer(res).or_else(|| group.split_missing.as_ref()
        .map(|why| format!("the indices split by time were not counted: {why}; asked again on the next run")));
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

    /// The legacy format, days from the names: the collector before 0.3.53.
    fn legacy() -> Indices {
        Indices { naming: Naming::Format(IndexFormat::new("logstash-*-YYYY.MM.DD").unwrap()), day_from: DayFrom::Name, time_field: "@timestamp".into() }
    }

    #[test]
    fn cat_groups_by_the_day_in_the_name() {
        let l = read_cat(&cat(), &legacy());
        assert_eq!(l.matched, 3);
        assert_eq!(l.skipped, vec!["logstash-linux-2026.10"]);
        let g = &l.days[&d("2026-10-20")];
        assert_eq!((g.indices, g.open, g.pri_bytes, g.total_bytes), (2, 2, 1500, 3000));
        assert_eq!(g.sources["win-dc"].pri_bytes, Some(500));
        assert!(l.time_split.is_empty(), "the legacy format splits nothing by time");
        let closed = &l.days[&d("2026-10-21")];
        assert_eq!((closed.indices, closed.open, closed.pri_bytes), (1, 0, 0));
    }

    #[test]
    fn totals_refresh_and_vanished_days_go_live_false_for_good() {
        let l = read_cat(&cat(), &legacy());
        let mut days = BTreeMap::new();
        days.insert("2026-10-05".to_string(), Day { day: "2026-10-05".into(), live: true, is_final: true, totals_at: 1,
                                                     pri_bytes: Some(42), docs: Some(9), ..Day::default() });
        assert!(apply_totals(&mut days, "2026-10", &l, &Split::None, 100));
        let gone = &days["2026-10-05"];
        assert!(!gone.live, "no indices any more");
        assert_eq!((gone.pri_bytes, gone.docs), (Some(42), Some(9)), "the record is kept as it was");
        let d20 = &days["2026-10-20"];
        assert!(d20.live && !d20.is_final);
        assert_eq!((d20.indices, d20.pri_bytes, d20.total_bytes, d20.totals_at, d20.docs), (2, Some(1500), Some(3000), 100, None));

        // Reappearing indices do not bring a live:false day back.
        let mut back = l.clone();
        back.days.insert(d("2026-10-05"), DayGroup { indices: 1, open: 1, pri_bytes: 1, ..DayGroup::default() });
        apply_totals(&mut days, "2026-10", &back, &Split::None, 200);
        assert!(!days["2026-10-05"].live);
        assert_eq!(days["2026-10-05"].pri_bytes, Some(42));
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
        assert!(field_caps_fields(&VolumeSettings::default(), false).contains(&"src_hostname.keyword".to_string()));
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
        let l = read_cat(&cat(), &legacy());
        let mut days = BTreeMap::new();
        apply_totals(&mut days, "2026-10", &l, &Split::None, 1);
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
        assert!(needs_search(&today, Some(&DayGroup { open: 1, ..DayGroup::default() }), false));
        assert!(!needs_search(day, Some(&DayGroup { open: 1, ..DayGroup::default() }), false), "final days are not asked again");
        assert!(!needs_search(&today, Some(&DayGroup { open: 0, indices: 1, ..DayGroup::default() }), false), "only closed indices");
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
        assert!(needs_search(&day, Some(&open), false), "asked again on the next run");
        let timed = json!({ "timed_out": true, "hits": { "total": { "value": 7 } } });
        apply_search(&mut day, &timed, &rows, &open, today, 2);
        assert!(!day.is_final && day.error.as_deref().unwrap().contains("timed out"));
        // A whole answer later makes it final and clears the error.
        apply_search(&mut day, &json!({ "_shards": { "total": 4, "failed": 0 }, "hits": { "total": { "value": 9 } } }), &rows, &open, today, 3);
        assert!(day.is_final && day.error.is_none());

        // Closed indices: not searched, and says so; open again, searched again.
        let closed = DayGroup { indices: 1, open: 0, ..DayGroup::default() };
        let waiting = Day { day: "2026-10-21".into(), live: true, ..Day::default() };
        assert!(!needs_search(&waiting, Some(&closed), false));
        assert!(not_searched_why(&waiting, Some(&closed), &Split::None, today).unwrap().contains("1 of its indices is closed"));
        assert!(needs_search(&waiting, Some(&DayGroup { indices: 1, open: 1, ..DayGroup::default() }), false));
        assert_eq!(not_searched_why(&waiting, Some(&closed), &Split::None, d("2026-10-21")), None, "today is not past");
        assert_eq!(not_searched_why(&day, Some(&closed), &Split::None, today), None, "a final day needs no reason");

        // Indices gone before the day was final: live false for good, and the error says so.
        let mut days = BTreeMap::new();
        days.insert("2026-10-22".to_string(), Day { day: "2026-10-22".into(), live: true, totals_at: 1, aggregated_at: Some(1), ..Day::default() });
        days.insert("2026-10-23".to_string(), Day { day: "2026-10-23".into(), live: true, totals_at: 1, ..Day::default() });
        apply_totals(&mut days, "2026-10", &Listing::default(), &Split::None, 5);
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

/// The index pattern and the day rule (docs/VOLUME.md "What counts", 0.3.53).
#[cfg(test)]
mod pattern_tests {
    use super::*;
    use crate::volume::settings::VolumeSettings;

    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }

    fn pattern(p: &str, day_from: DayFrom) -> Indices {
        Indices { naming: Naming::Pattern(IndexPattern::new(p).unwrap()), day_from, time_field: "@timestamp".into() }
    }

    #[test]
    fn a_name_carries_a_day_only_when_it_is_a_real_whole_date() {
        assert_eq!(name_date("logstash-linux-2026.10.20").map(|x| x.0), Some(d("2026-10-20")));
        assert_eq!(name_date(".ds-logs-app-2026.10.20-000001").map(|x| x.0), Some(d("2026-10-20")));
        assert_eq!(name_date("2026.01.02-app").map(|x| x.1), Some(0..10));
        assert_eq!(name_date("logstash-linux-2026.10"), None, "a month is not a day");
        assert_eq!(name_date("app-2026.09.31"), None, "no 31st of September");
        assert_eq!(name_date("x-12026.10.20"), None, "part of a longer run of digits");
        assert_eq!(name_date("x-2026.10.201"), None);
        assert_eq!(name_date("app-2026.13.01-2026.10.05").map(|x| x.0), Some(d("2026-10-05")), "the first real date");
        assert_eq!(name_date("logs-app"), None);
    }

    #[test]
    fn one_or_more_patterns_no_date_part_needed() {
        let one = IndexPattern::new("logstash-*").unwrap();
        assert_eq!(one.expr(), "logstash-*");
        let many = IndexPattern::new(" logstash-* , app-*,-app-test-* ").unwrap();
        assert_eq!(many.expr(), "logstash-*,app-*,-app-test-*", "trimmed, exclusions kept");
        assert!(IndexPattern::new("logstash-*-YYYY.MM.DD").is_some(), "a date part is allowed (it is only text)");
        assert!(IndexPattern::new("myindex").is_some(), "a plain name");
        for bad in ["", " ", "a,,b", "-a", "_all", "a b", "a/b", "remote:logs-*", "+x", "a,"] {
            assert!(IndexPattern::new(bad).is_none(), "{bad:?} should be refused");
        }
        assert!(IndexPattern::new(&vec!["a*"; 21].join(",")).is_none(), "at most 20 patterns");
    }

    #[test]
    fn sources_match_the_legacy_format_and_drop_rollover_and_ds() {
        let p = IndexPattern::new("logstash-*,logs-*,metrics").unwrap();
        let src = |n: &str| p.source(n, name_date(n).map(|x| x.1));
        assert_eq!(src("logstash-linux-2026.10.20"), "linux", "as logstash-*-YYYY.MM.DD names it");
        assert_eq!(src("logstash-win-dc-01-2026.10.20"), "win-dc-01");
        assert_eq!(src("logs-app-2026.10.20-000001"), "app");
        assert_eq!(src(".ds-logs-app-2026.10.20-000001"), "app");
        assert_eq!(src("logs-app-000003"), "app");
        assert_eq!(src("logstash-linux-2026.10"), "linux-2026.10", "no day in the name: the name less the prefix");
        assert_eq!(src("metrics"), "metrics", "a name the pattern names whole");
        assert_eq!(src("logstash-2026.10.20"), "logstash-2026.10.20", "nothing left: the name");
    }

    fn cat() -> Value {
        json!([
            { "index": "logstash-linux-2026.10.20", "status": "open", "pri.store.size": "1000", "store.size": "2000" },
            { "index": "logstash-win-2026.10.20", "status": "open", "pri.store.size": "500", "store.size": "1000" },
            { "index": "logstash-linux-2026.10", "status": "open", "pri.store.size": "7", "store.size": "14" },
            { "index": "logstash-app", "status": "close", "pri.store.size": null, "store.size": null },
        ])
    }

    #[test]
    fn dated_by_name_in_full_undated_split_by_time() {
        let l = read_cat(&cat(), &pattern("logstash-*", DayFrom::Name));
        assert_eq!(l.matched, 4);
        assert!(l.skipped.is_empty(), "a pattern skips nothing it matched");
        assert_eq!(l.dated(), 2);
        let g = &l.days[&d("2026-10-20")];
        assert_eq!((g.indices, g.pri_bytes, g.total_bytes), (2, 1500, 3000));
        assert_eq!(l.time_split.len(), 2);
        assert_eq!(l.time_split["logstash-linux-2026.10"], SplitIndex { source: "linux-2026.10".into(), open: true });
        assert!(!l.time_split["logstash-app"].open);
        assert_eq!((l.split_open(), l.split_closed()), (vec!["logstash-linux-2026.10".to_string()], 1));
    }

    #[test]
    fn day_from_time_splits_every_index_even_dated_ones() {
        let l = read_cat(&cat(), &pattern("logstash-*", DayFrom::Time));
        assert!(l.days.is_empty(), "nothing counts by its name");
        assert_eq!(l.time_split.len(), 4);
        assert_eq!(l.time_split["logstash-linux-2026.10.20"].source, "linux", "the date still leaves the source");
        // The legacy format with dayFrom time: the names that fit are split, the rest skipped.
        let f = Indices { naming: Naming::Format(IndexFormat::new("logstash-*-YYYY.MM.DD").unwrap()), day_from: DayFrom::Time, time_field: "ts".into() };
        let lf = read_cat(&cat(), &f);
        assert_eq!((lf.time_split.len(), lf.skipped_count), (2, 2));
    }

    #[test]
    fn the_settings_say_which_naming_is_in_force() {
        let def = Indices::from_settings(&VolumeSettings::default()).unwrap();
        assert!(matches!(def.naming, Naming::Pattern(_)));
        assert_eq!(def.expr(), "logstash-*");
        let mut s = VolumeSettings::default();
        s.apply(&json!({ "indexFormat": "logs-*-YYYY.MM.DD" }));
        let legacy = Indices::from_settings(&s).unwrap();
        assert_eq!(legacy.expr(), "logs-*-*", "the format's glob, as before");
        assert!(legacy.legacy_format().is_some());
        s.apply(&json!({ "dayFrom": "time" }));
        assert!(Indices::from_settings(&s).unwrap().legacy_format().is_none(), "split by time: the pattern-style requests");
    }

    #[test]
    fn the_legacy_requests_are_unchanged() {
        let f = Indices { naming: Naming::Format(IndexFormat::new("logstash-*-YYYY.MM.DD").unwrap()), day_from: DayFrom::Name, time_field: "@timestamp".into() };
        assert_eq!(cat_request("c", &f).path, "/_cat/indices/logstash-*-*?format=json&bytes=b&h=index,status,docs.count,pri.store.size,store.size");
        let s = VolumeSettings::default();
        assert!(!field_caps_request("c", &f, &s, false).path.contains("@timestamp"));
        let l = read_cat(&cat(), &f);
        let body = json!({ "size": 0 });
        let r = search_request("c", &f, d("2026-10-20"), &l.group_for(d("2026-10-20"), &Split::None), &body);
        assert_eq!(r.path, "/logstash-*-2026.10.20/_search?ignore_unavailable=true&allow_no_indices=true");
        assert_eq!(r.body.as_deref(), Some(r#"{"size":0}"#), "no query added");
        assert_eq!((r.origin.as_deref(), r.class), (Some("volume-daily"), crate::gate::Class::Background));
        // A day's aggregation may take longer than the listing: under the gate's 115 s ceiling.
        assert_eq!(r.timeout_ms, Some(SEARCH_TIMEOUT_MS));
        assert_eq!(cat_request("c", &f).timeout_ms, Some(60_000));
        assert!(SEARCH_TIMEOUT_MS > 60_000 && SEARCH_TIMEOUT_MS < 115_000);
    }

    #[test]
    fn only_a_failure_that_may_pass_is_tried_again() {
        for v in [json!({ "ok": false, "status": 0, "kind": "timeout" }), json!({ "ok": false, "status": 502 }),
                  json!({ "ok": false, "status": 503 }), json!({ "ok": false, "status": 504 })] {
            assert!(retryable(&v), "{v}");
        }
        // A busy cluster is deferred, not pressed again (docs/JOBS.md "Busy clusters").
        for v in [json!({ "ok": false, "status": 429 }), json!({ "ok": false, "kind": "overloaded" }),
                  json!({ "ok": true, "status": 200 }), json!({ "ok": false, "status": 400 }), json!({ "ok": false, "status": 404 }),
                  json!({ "ok": false, "status": 0, "kind": "refused" }), json!({ "ok": false, "kind": "blocked_stopped" }), json!({})] {
            assert!(!retryable(&v), "{v}");
        }
    }

    #[test]
    fn a_pattern_day_search_names_its_indices_and_the_utc_day() {
        let p = pattern("logstash-*", DayFrom::Name);
        let l = read_cat(&cat(), &p);
        let split = Split::Known { days: [d("2026-10-20")].into_iter().collect(), complete: false };
        let g = l.group_for(d("2026-10-20"), &split);
        assert_eq!(g.time_split.keys().collect::<Vec<_>>(), vec!["logstash-linux-2026.10"], "open ones only");
        let r = search_request("c", &p, d("2026-10-20"), &g, &json!({ "size": 0 }));
        assert_eq!(r.path, "/logstash-*/_search?ignore_unavailable=true&allow_no_indices=true");
        let b: Value = serde_json::from_str(r.body.as_deref().unwrap()).unwrap();
        let should = &b["query"]["bool"]["should"];
        assert_eq!(should[0], json!({ "terms": { "_index": ["logstash-linux-2026.10.20", "logstash-win-2026.10.20"] } }));
        assert_eq!(should[1]["bool"]["filter"][0], json!({ "terms": { "_index": ["logstash-linux-2026.10"] } }));
        assert_eq!(should[1]["bool"]["filter"][1], json!({ "range": { "@timestamp": {
            "gte": "2026-10-20", "lt": "2026-10-21", "format": "yyyy-MM-dd", "time_zone": "UTC" } } }));
        assert_eq!(b["query"]["bool"]["minimum_should_match"], 1);
        // Only dated, only split.
        assert_eq!(day_query(&["a"], &[], "t", d("2026-10-20")), json!({ "terms": { "_index": ["a"] } }));
        assert_eq!(day_query(&[], &["b"], "t", d("2026-10-20"))["bool"]["filter"][0], json!({ "terms": { "_index": ["b"] } }));
        // The histogram: the same UTC days, one request over every open time-split index.
        let h = histogram_request("c", &p, &l.split_open(), d("2026-10-01"), d("2026-10-29"));
        let hb: Value = serde_json::from_str(h.body.as_deref().unwrap()).unwrap();
        assert_eq!(hb["aggs"]["days"]["date_histogram"], json!({ "field": "@timestamp", "calendar_interval": "1d",
            "time_zone": "UTC", "min_doc_count": 1, "format": "yyyy-MM-dd" }));
        assert_eq!(hb["query"]["bool"]["filter"][1]["range"]["@timestamp"]["lt"], "2026-10-30");
        assert_eq!(h.class, crate::gate::Class::Background);
    }

    #[test]
    fn histogram_answers_and_time_fields() {
        let res = json!({ "aggregations": { "days": { "buckets": [
            { "key_as_string": "2026-10-19", "key": 1, "doc_count": 5 },
            { "key_as_string": "2026-10-20", "key": 2, "doc_count": 0 },
            { "key_as_string": "2026-10-21", "key": 3, "doc_count": 9 } ] } } });
        assert_eq!(read_histogram(&res), [d("2026-10-19"), d("2026-10-21")].into_iter().collect());
        let fc = json!({ "fields": {
            "@timestamp": { "date": { "type": "date", "aggregatable": true } },
            "ts": { "keyword": { "type": "keyword", "aggregatable": true } } } });
        assert_eq!(resolve_time_field(&fc, "@timestamp"), Ok("date".into()));
        assert!(resolve_time_field(&fc, "ts").unwrap_err().contains("not a date"));
        assert!(resolve_time_field(&fc, "nope").unwrap_err().contains("not in the mapping"));
        assert!(cat_rows(&json!({ "ok": false, "status": 404, "json": { "error": { "type": "index_not_found_exception" } } })).is_some(),
                "an index the pattern names outright and that is not there: an empty listing");
        assert!(cat_rows(&json!({ "ok": false, "status": 500, "json": {} })).is_none());
    }

    fn rows_with_event() -> Vec<RowResolution> {
        let mut rows = resolve_rows(&json!({ "fields": {} }), &VolumeSettings::default());
        rows.iter_mut().find(|r| r.key == "eventSize").unwrap().resolved = Some("event_logsize".into());
        rows
    }

    /// A day with dated indices and a time-split one: documents and event bytes count for
    /// both, the dated size is kept, the day's size is not measured (never 0, never shared out).
    #[test]
    fn a_time_split_day_measures_documents_but_not_size() {
        let p = pattern("logstash-*", DayFrom::Name);
        let l = read_cat(&cat(), &p);
        let split = Split::Known { days: [d("2026-10-20"), d("2026-10-21")].into_iter().collect(), complete: true };
        let mut days = BTreeMap::new();
        apply_totals(&mut days, "2026-10", &l, &split, 1);
        let only = &days["2026-10-21"];
        assert!(only.live);
        assert_eq!((only.indices, only.pri_bytes, only.total_bytes), (0, None, None), "no dated index: size not measured");
        assert!(needs_search(only, l.days.get(&d("2026-10-21")), split.has(d("2026-10-21"))));

        let res = json!({ "_shards": { "total": 2, "failed": 0 }, "hits": { "total": { "value": 130 } }, "aggregations": {
            "ev": { "value": 13000.0 },
            "by_index": { "sum_other_doc_count": 0, "buckets": [
                { "key": "logstash-linux-2026.10.20", "doc_count": 80, "ev": { "value": 8000.0 } },
                { "key": "logstash-win-2026.10.20", "doc_count": 20, "ev": { "value": 2000.0 } },
                { "key": "logstash-linux-2026.10", "doc_count": 30, "ev": { "value": 3000.0 } } ] } } });
        let g = l.group_for(d("2026-10-20"), &split);
        let day = days.get_mut("2026-10-20").unwrap();
        apply_search(day, &res, &rows_with_event(), &g, d("2026-10-29"), 5);
        assert_eq!((day.docs, day.event_bytes), (Some(130), Some(13000)));
        assert_eq!((day.indices, day.unmeasured_size_indices), (3, 1));
        assert_eq!(day.pri_bytes, Some(1500), "the dated part is kept in the record");
        assert_eq!(day.sizes(), (None, None), "but it is not the day's size");
        assert!(day.is_final && day.error.is_none());
        let src = &day.sources["linux-2026.10"];
        assert_eq!((src.docs, src.event_bytes, src.pri_bytes, src.unmeasured_size_indices), (Some(30), Some(3000), None, 1));
        assert_eq!(day.sources["linux"].sizes(), (Some(1000), Some(2000)));

        // The next run's _cat keeps the time-split counts until the day is searched again.
        apply_totals(&mut days, "2026-10", &l, &split, 9);
        let again = &days["2026-10-20"];
        assert_eq!((again.indices, again.unmeasured_size_indices, again.sources["linux-2026.10"].indices), (3, 1, 1));
        assert_eq!(again.sources["linux-2026.10"].pri_bytes, None);
    }

    /// The split not worked out: a time-split-only day is neither searched nor taken for
    /// gone, and says why; a dated day searched without it is not final.
    #[test]
    fn an_unknown_split_keeps_days_and_is_never_final() {
        let p = pattern("logstash-*", DayFrom::Name);
        let l = read_cat(&cat(), &p);
        let mut days = BTreeMap::new();
        apply_totals(&mut days, "2026-10", &l, &Split::Known { days: [d("2026-10-21")].into_iter().collect(), complete: true }, 1);
        let unknown = Split::Unknown("the time field ts is keyword, not a date".into());
        apply_totals(&mut days, "2026-10", &l, &unknown, 2);
        let kept = &days["2026-10-21"];
        assert!(kept.live, "an uncertain split takes no day for gone");
        assert!(!needs_search(kept, None, unknown.has(d("2026-10-21"))));
        assert!(not_searched_why(kept, None, &unknown, d("2026-10-29")).unwrap().contains("not a date"));
        let g = l.group_for(d("2026-10-20"), &unknown);
        assert!(g.time_split.is_empty());
        let day = days.get_mut("2026-10-20").unwrap();
        apply_search(day, &json!({ "hits": { "total": { "value": 100 } }, "aggregations": {} }), &rows_with_event(), &g, d("2026-10-29"), 3);
        assert!(!day.is_final);
        assert!(day.error.as_deref().unwrap().contains("split by time were not counted"), "{:?}", day.error);

        // A complete split that no longer has the day, and no dated index: gone, for good.
        apply_totals(&mut days, "2026-10", &l, &Split::Known { days: Default::default(), complete: true }, 4);
        assert!(!days["2026-10-21"].live);
        // A closed time-split index: a missing day may still be there.
        let mut d2 = BTreeMap::new();
        apply_totals(&mut d2, "2026-10", &l, &Split::Known { days: [d("2026-10-22")].into_iter().collect(), complete: true }, 1);
        apply_totals(&mut d2, "2026-10", &l, &Split::Known { days: Default::default(), complete: false }, 2);
        assert!(d2["2026-10-22"].live);
    }

    /// Records written before 0.3.53 read as they were: sizes as numbers, no time split.
    #[test]
    fn an_old_record_still_reads() {
        let old = json!({ "day": "2026-10-20", "final": true, "live": true, "aggregatedAt": 1, "totalsAt": 1,
                          "indices": 2, "priBytes": 1500, "totalBytes": 3000, "docs": 100, "eventBytes": null, "subBytes": null,
                          "sources": { "linux": { "indices": 1, "priBytes": 1000, "totalBytes": 2000, "docs": 80, "eventBytes": null, "subBytes": null } },
                          "fields": {}, "error": null });
        let day: Day = serde_json::from_value(old).unwrap();
        assert_eq!((day.pri_bytes, day.unmeasured_size_indices, day.sizes()), (Some(1500), 0, (Some(1500), Some(3000))));
        assert_eq!(day.sources["linux"].sizes(), (Some(1000), Some(2000)));
        let back = serde_json::to_value(&day).unwrap();
        assert_eq!((back["priBytes"].clone(), back["unmeasuredSizeIndices"].clone()), (json!(1500), json!(0)));
    }
}
